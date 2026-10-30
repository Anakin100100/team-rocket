// Race test for the market: fires tool calls at the same moment and checks
// that the outcome is one the calls could also have produced one after the
// other. Two buyers and two suppliers in CPV class 358, so every thread has a
// cross-matched twin. Local databases only: it wipes the market-side tables
// before every scenario.
//
// Usage (from apps/server): bun run market:races
import { setTimeout as delay } from "node:timers/promises";

import {
  demands,
  marketEvents,
  matches,
  offers,
  proposals,
} from "@rocket/db/schema/market";
import { eventsFor, runTool } from "@rocket/market";
import type { Actor, ToolOutcome } from "@rocket/market";
import { max, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { ENV } from "../src/env.server";
import { db, market } from "../src/services";

const ROUNDS = 8;
const CPV_CLASS = "358";
const LEAD_TIME = 60;
// Under both buyers' walk-away, so a buyer can accept the opening ask.
const ASK_EUR = 700_000;
const POLL_MS = 2;
const POLL_LIMIT = 500;

const LISTING_A = "ted:549292-2026";
const LISTING_B = "ted:741774-2026";
const buyerA: Actor = {
  kind: "buyer",
  entityId: "ted-buyer:00212008",
  name: "buyer A",
};
const buyerB: Actor = {
  kind: "buyer",
  entityId: "ted-buyer:13002345000013",
  name: "buyer B",
};
const supplierA: Actor = {
  kind: "supplier",
  entityId: "ESP:28030062",
  name: "supplier A",
};
const supplierB: Actor = {
  kind: "supplier",
  entityId: "CZE:26181134",
  name: "supplier B",
};
const observer: Actor = { kind: "observer", entityId: null, name: "races" };

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    failures += 1;
    console.log(`  FAIL ${label}`, detail === undefined ? "" : detail);
  }
};

// A call that died with an exception (a deadlock, say) comes back as data too,
// so one bad round does not end the run.
const call = async (
  actor: Actor,
  tool: string,
  input: unknown = {}
): Promise<ToolOutcome> => {
  try {
    return await runTool(market, actor, tool, input);
  } catch (error) {
    return { ok: false, error: { code: "THROWN", message: String(error) } };
  }
};
const postOffer = (actor: Actor) =>
  call(actor, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: ASK_EUR,
    lead_time_days: LEAD_TIME,
    note: "race",
  });
const postDemand = (actor: Actor, listingId: string) =>
  call(actor, "post_demand", { listing_id: listingId });
const accept = (actor: Actor, matchId: string) =>
  call(actor, "accept", { match_id: matchId });
const succeeded = (outcomes: ToolOutcome[]) =>
  outcomes.filter((outcome) => outcome.ok).length;
const thrown = (outcomes: ToolOutcome[]) =>
  outcomes.filter((outcome) => !outcome.ok && outcome.error.code === "THROWN");

const wipe = async () => {
  await db.delete(marketEvents);
  await db.delete(proposals);
  await db.delete(matches);
  await db.delete(offers);
  await db.delete(demands);
};

const rows = async <T>(query: SQL) => {
  const result = await db.execute(query);
  const batch = Array.isArray(result) ? result.at(-1) : result;
  return (batch?.rows ?? []) as T[];
};

const threadBetween = async (buyer: Actor, supplier: Actor) => {
  const [row] = await rows<{ id: string }>(sql`
    select m.id from matches m
    join demands d on d.id = m.demand_id
    join offers o on o.id = m.offer_id
    where d.buyer_id = ${buyer.entityId} and o.supplier_id = ${supplier.entityId}`);
  if (!row) {
    throw new Error(`No thread between ${buyer.name} and ${supplier.name}.`);
  }
  return row.id;
};

// What must hold after any mix of calls, concurrent or not.
const checkInvariants = async (scenario: string) => {
  const doubleDemands = await rows(sql`
    select listing_id from demands where state = 'open'
    group by listing_id having count(*) > 1`);
  check(`${scenario}: one open demand per listing`, doubleDemands.length === 0);
  const doubleOffers = await rows(sql`
    select supplier_id, cpv_class from offers where state = 'open'
    group by supplier_id, cpv_class having count(*) > 1`);
  check(
    `${scenario}: one open offer per supplier and class`,
    doubleOffers.length === 0
  );
  const zombies = await rows(sql`
    select m.id from matches m
    join demands d on d.id = m.demand_id
    join offers o on o.id = m.offer_id
    where m.state = 'open' and (d.state <> 'open' or o.state <> 'open')`);
  check(
    `${scenario}: no open thread on a filled demand or offer`,
    zombies.length === 0,
    zombies
  );
  const repeated = await rows(sql`
    select match_id, action, count(*)::int as n from market_events
    where action in ('superseded', 'agreed')
    group by match_id, action having count(*) > 1`);
  check(
    `${scenario}: a thread is agreed or superseded once`,
    repeated.length === 0,
    repeated
  );
};

// Runs `race` while a reader follows the event log by cursor, the way `wait`
// and the admin UI do, and checks that the reader saw every event.
const followed = async <T>(scenario: string, race: () => Promise<T>) => {
  const [start] = await db
    .select({ id: max(marketEvents.id) })
    .from(marketEvents);
  let cursor = start?.id ?? 0;
  const seen = new Set<number>();
  const done = new AbortController();
  const reader = (async () => {
    while (!done.signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await eventsFor(db, observer, {
        since: cursor,
        limit: POLL_LIMIT,
      });
      for (const event of batch.events) {
        seen.add(event.id);
      }
      ({ cursor } = batch);
      // oxlint-disable-next-line no-await-in-loop
      await delay(POLL_MS);
    }
  })();
  const result = await race();
  done.abort();
  await reader;
  const last = await eventsFor(db, observer, {
    since: cursor,
    limit: POLL_LIMIT,
  });
  for (const event of last.events) {
    seen.add(event.id);
  }
  const all = await rows<{ id: number }>(
    sql`select id from market_events where id > ${start?.id ?? 0}`
  );
  const missed = all.map((row) => Number(row.id)).filter((id) => !seen.has(id));
  check(
    `${scenario}: a cursor reader sees every event`,
    missed.length === 0,
    missed
  );
  return result;
};

const scenarios: Record<string, () => Promise<void>> = {
  "same offer twice": async () => {
    const outcomes = await followed("same offer twice", () =>
      Promise.all([postOffer(supplierA), postOffer(supplierA)])
    );
    check("same offer twice: exactly one posted", succeeded(outcomes) === 1);
  },
  "same demand twice": async () => {
    const outcomes = await followed("same demand twice", () =>
      Promise.all([
        postDemand(buyerA, LISTING_A),
        postDemand(buyerA, LISTING_A),
      ])
    );
    check("same demand twice: exactly one posted", succeeded(outcomes) === 1);
  },
  "offer and demand together": async () => {
    const outcomes = await followed("offer and demand together", () =>
      Promise.all([postOffer(supplierA), postDemand(buyerA, LISTING_A)])
    );
    check("offer and demand together: both posted", succeeded(outcomes) === 2);
    const [thread] = await rows(sql`select id from matches`);
    check("offer and demand together: they were matched", Boolean(thread));
  },
  "accept while an offer arrives": async () => {
    await postOffer(supplierA);
    await postDemand(buyerA, LISTING_A);
    const thread = await threadBetween(buyerA, supplierA);
    const outcomes = await followed("accept while an offer arrives", () =>
      Promise.all([accept(buyerA, thread), postOffer(supplierB)])
    );
    check(
      "accept while an offer arrives: both succeed",
      succeeded(outcomes) === 2,
      outcomes
    );
  },
  "accept while a demand arrives": async () => {
    await postOffer(supplierA);
    await postDemand(buyerA, LISTING_A);
    const thread = await threadBetween(buyerA, supplierA);
    const outcomes = await followed("accept while a demand arrives", () =>
      Promise.all([accept(buyerA, thread), postDemand(buyerB, LISTING_B)])
    );
    check(
      "accept while a demand arrives: both succeed",
      succeeded(outcomes) === 2,
      outcomes
    );
  },
  "crossed accepts": async () => {
    await postOffer(supplierA);
    await postOffer(supplierB);
    await postDemand(buyerA, LISTING_A);
    await postDemand(buyerB, LISTING_B);
    const aa = await threadBetween(buyerA, supplierA);
    const bb = await threadBetween(buyerB, supplierB);
    const outcomes = await followed("crossed accepts", () =>
      Promise.all([accept(buyerA, aa), accept(buyerB, bb)])
    );
    check("crossed accepts: no call crashed", thrown(outcomes).length === 0, [
      ...thrown(outcomes),
    ]);
    check("crossed accepts: both agreed", succeeded(outcomes) === 2, outcomes);
  },
  "two buyers, one offer": async () => {
    await postOffer(supplierA);
    await postDemand(buyerA, LISTING_A);
    await postDemand(buyerB, LISTING_B);
    const aa = await threadBetween(buyerA, supplierA);
    const ba = await threadBetween(buyerB, supplierA);
    const outcomes = await followed("two buyers, one offer", () =>
      Promise.all([accept(buyerA, aa), accept(buyerB, ba)])
    );
    check(
      "two buyers, one offer: exactly one agreed",
      succeeded(outcomes) === 1
    );
  },
};

if (!/localhost|127\.0\.0\.1/u.test(ENV.DATABASE_URL)) {
  console.error("Refusing to wipe a non-local database.");
  process.exit(1);
}

for (let round = 1; round <= ROUNDS; round += 1) {
  console.log(`round ${round}`);
  for (const [name, scenario] of Object.entries(scenarios)) {
    // oxlint-disable-next-line no-await-in-loop
    await wipe();
    // oxlint-disable-next-line no-await-in-loop
    await scenario();
    // oxlint-disable-next-line no-await-in-loop
    await checkInvariants(name);
  }
}
await wipe();

console.log(
  `\n${failures === 0 ? "ALL OK" : `${failures} FAILED`}: ${ROUNDS} rounds × ${Object.keys(scenarios).length} scenarios`
);
process.exit(failures === 0 ? 0 : 1);
