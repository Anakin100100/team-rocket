// The runner (plan.md §3.1): the thing that presses go. It knows nothing about
// procurement — it wakes the buyer, answers each supplier the market is
// waiting on, and streams the events. The database is the only state, so a
// run that dies can simply be started again.
//
// The loops below poll on purpose (one step at a time, in order), so awaiting
// inside them is the design, not an oversight.
/* oxlint-disable no-await-in-loop */
import { setTimeout as delay } from "node:timers/promises";

import { candidates, rfqs } from "@rocket/db/schema/market";
import { and, eq, lt, or, sql } from "drizzle-orm";

import { runSupplierAgent, wakeBuyer } from "./agents";
import type { AgentConfig, SupplierPhase } from "./agents";
import { TERMINAL_STATES } from "./constants";
import type { RfqState } from "./constants";
import type { MarketContext } from "./context";
import { guardFailed, notFound } from "./errors";
import { appendEvent, latestEventId, readEvents } from "./events";

const BUYER_WAKE_INTERVAL_MS = 2000;
// Without news the buyer is still woken now and then (deadlines move it on).
const BUYER_IDLE_WAKE_MS = 10_000;
const SUPPLIER_POLL_MS = 1000;
const EVENT_POLL_MS = 500;
const STALE_RUN_MINUTES = 10;
const EVENT_BATCH = 200;
const SHUTDOWN_GRACE_MS = 20_000;

export interface RoundOptions {
  budgetMs: number;
  since?: number;
  signal?: AbortSignal;
}

// Resolves early (without throwing) when the round is stopped.
const sleep = async (ms: number, signal?: AbortSignal) => {
  try {
    await delay(ms, null, { signal });
  } catch {
    // Aborted: the round is stopping.
  }
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const acquireRun = async ({ db }: MarketContext, rfqId: string) => {
  const [row] = await db
    .update(rfqs)
    .set({ running: true, runningSince: new Date() })
    .where(
      and(
        eq(rfqs.id, rfqId),
        or(
          eq(rfqs.running, false),
          lt(
            rfqs.runningSince,
            sql`now() - make_interval(mins => ${STALE_RUN_MINUTES})`
          )
        )
      )
    )
    .returning({ state: rfqs.state });
  if (!row) {
    const [existing] = await db
      .select({ id: rfqs.id })
      .from(rfqs)
      .where(eq(rfqs.id, rfqId));
    throw existing
      ? guardFailed(`A round is already running for RFQ ${rfqId}.`)
      : notFound(`RFQ ${rfqId} does not exist.`);
  }
  return row.state as RfqState;
};

const releaseRun = ({ db }: MarketContext, rfqId: string) =>
  db
    .update(rfqs)
    .set({ running: false, runningSince: null })
    .where(eq(rfqs.id, rfqId));

const loadState = async ({ db }: MarketContext, rfqId: string) => {
  const [row] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
  return row;
};

const isTerminal = (state: string | undefined) =>
  state === undefined || TERMINAL_STATES.has(state as RfqState);

// Which suppliers the market is waiting on right now, and for what.
const pendingSupplierWork = async (ctx: MarketContext, rfqId: string) => {
  const rfq = await loadState(ctx, rfqId);
  if (!rfq) {
    return [];
  }
  const now = Date.now();
  const phaseFor: Partial<
    Record<RfqState, { status: string; phase: SupplierPhase; open: boolean }>
  > = {
    QUOTING: {
      status: "invited",
      phase: "invited",
      open: now < rfq.quotingDeadline.getTime(),
    },
    NEGOTIATING: {
      status: "countered",
      phase: "countered",
      open: !rfq.negotiationDeadline || now < rfq.negotiationDeadline.getTime(),
    },
    AWARDED: { status: "awarded", phase: "awarded", open: true },
  };
  const wanted = phaseFor[rfq.state as RfqState];
  if (!wanted?.open) {
    return [];
  }
  const rows = await ctx.db
    .select({ supplierId: candidates.supplierId })
    .from(candidates)
    .where(
      and(eq(candidates.rfqId, rfqId), eq(candidates.status, wanted.status))
    );
  return rows.map((row) => ({
    supplierId: row.supplierId,
    phase: wanted.phase,
  }));
};

const buyerShouldWake = (
  rfq: Awaited<ReturnType<typeof loadState>>,
  now: number
) => {
  if (!rfq) {
    return { turn: false, deadlinePassed: false };
  }
  const turn = ["QUOTING", "EVALUATING", "NEGOTIATING"].includes(rfq.state);
  const deadlinePassed =
    (rfq.state === "QUOTING" && now >= rfq.quotingDeadline.getTime()) ||
    (rfq.state === "NEGOTIATING" &&
      rfq.negotiationDeadline !== null &&
      now >= rfq.negotiationDeadline.getTime());
  return { turn, deadlinePassed };
};

// An async generator has no arrow form.
// oxlint-disable-next-line func-style
export async function* runRound(
  config: AgentConfig,
  ctx: MarketContext,
  rfqId: string,
  { budgetMs, since = 0, signal }: RoundOptions
) {
  // A finished RFQ is replayed from the event log: read only, no lock, no
  // new events (the stage fallback in plan.md §7).
  const current = await loadState(ctx, rfqId);
  if (current && isTerminal(current.state)) {
    let cursor = since;
    for (;;) {
      const batch = await readEvents(ctx.db, {
        rfqId,
        since: cursor,
        viewer: { role: "observer" },
        limit: EVENT_BATCH,
      });
      for (const event of batch.events) {
        yield event;
      }
      if (batch.events.length < EVENT_BATCH) {
        return;
      }
      ({ cursor } = batch);
    }
  }
  await acquireRun(ctx, rfqId);
  const stop = new AbortController();
  const stopRun = () => stop.abort();
  signal?.addEventListener("abort", stopRun);
  const deadline = Date.now() + budgetMs;
  const inFlight = new Map<string, Promise<void>>();
  const attempted = new Set<string>();

  const recordError = async (actor: string, error: unknown) => {
    try {
      await appendEvent(ctx.db, {
        rfqId,
        actor,
        action: "agent_error",
        audience: "buyer",
        payload: { message: errorMessage(error) },
      });
    } catch {
      // Logging must never take the round down.
    }
  };

  const runSupplier = async (
    key: string,
    supplierId: string,
    phase: SupplierPhase
  ) => {
    try {
      await runSupplierAgent(config, ctx, { rfqId, supplierId, phase });
    } catch (error) {
      await recordError(`supplier:${supplierId}`, error);
    } finally {
      inFlight.delete(key);
    }
  };

  // One call per supplier per phase, in parallel; a failed call is not
  // retried this round.
  const supplierLoop = async () => {
    while (!stop.signal.aborted) {
      const work = await pendingSupplierWork(ctx, rfqId);
      for (const { supplierId, phase } of work) {
        const key = `${phase}:${supplierId}`;
        if (!attempted.has(key)) {
          attempted.add(key);
          inFlight.set(key, runSupplier(key, supplierId, phase));
        }
      }
      await sleep(SUPPLIER_POLL_MS, stop.signal);
    }
  };

  const wakeBuyerOnce = async () => {
    try {
      const result = await wakeBuyer(config, ctx, rfqId);
      if (result.note) {
        await appendEvent(ctx.db, {
          rfqId,
          actor: "buyer",
          action: "buyer_note",
          audience: "buyer",
          payload: { text: result.note },
        });
      }
    } catch (error) {
      await recordError("buyer", error);
    }
  };

  const buyerLoop = async () => {
    let lastSeen = -1;
    let lastWake = 0;
    while (!stop.signal.aborted) {
      const latest = await latestEventId(ctx.db, rfqId);
      const now = Date.now();
      const { turn, deadlinePassed } = buyerShouldWake(
        await loadState(ctx, rfqId),
        now
      );
      const news = latest !== lastSeen || now - lastWake >= BUYER_IDLE_WAKE_MS;
      if (turn && (news || deadlinePassed)) {
        // Its own actions count as news: the state moved, so it looks again
        // on the next tick.
        lastSeen = latest;
        lastWake = now;
        await wakeBuyerOnce();
      }
      await sleep(BUYER_WAKE_INTERVAL_MS, stop.signal);
    }
  };

  const guarded = async (loop: () => Promise<void>) => {
    try {
      await loop();
    } catch (error) {
      await recordError("runner", error);
    }
  };
  const loops = [guarded(supplierLoop), guarded(buyerLoop)];

  let cursor = since;
  try {
    await appendEvent(ctx.db, {
      rfqId,
      actor: "runner",
      action: "round_started",
      audience: "buyer",
      payload: {
        budget_ms: budgetMs,
        model: config.model,
        effort: config.effort,
        mock_buyer: config.mockBuyer,
        mock_suppliers: config.mockSuppliers,
      },
    });
    while (!stop.signal.aborted) {
      const batch = await readEvents(ctx.db, {
        rfqId,
        since: cursor,
        viewer: { role: "observer" },
        limit: EVENT_BATCH,
      });
      ({ cursor } = batch);
      for (const event of batch.events) {
        yield event;
      }
      const rfq = await loadState(ctx, rfqId);
      const finished = isTerminal(rfq?.state) && inFlight.size === 0;
      if (finished || Date.now() >= deadline) {
        break;
      }
      await sleep(EVENT_POLL_MS, stop.signal);
    }
  } finally {
    stop.abort();
    signal?.removeEventListener("abort", stopRun);
    // Don't outlive the function: an unfinished supplier call is redone on the
    // next run.
    await Promise.race([
      Promise.allSettled([...loops, ...inFlight.values()]),
      sleep(SHUTDOWN_GRACE_MS),
    ]);
    try {
      const rfq = await loadState(ctx, rfqId);
      await appendEvent(ctx.db, {
        rfqId,
        actor: "runner",
        action: "round_ended",
        audience: "buyer",
        payload: {
          state: rfq?.state,
          reason: isTerminal(rfq?.state)
            ? "finished"
            : "time budget spent; run again to resume",
        },
      });
      await releaseRun(ctx, rfqId);
      // Drain the last events, round_ended included.
      const tail = await readEvents(ctx.db, {
        rfqId,
        since: cursor,
        viewer: { role: "observer" },
        limit: EVENT_BATCH,
      });
      for (const event of tail.events) {
        yield event;
      }
    } catch (error) {
      await recordError("runner", error);
      await releaseRun(ctx, rfqId);
    }
  }
}
