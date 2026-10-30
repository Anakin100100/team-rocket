// The append-only event log: the only integration point (plan.md §3, §6).
// An event names the buyer and/or supplier it concerns; a party sees only the
// events that name it, observers see all of them and their sealed values.
import { marketEvents } from "@rocket/db/schema/market";
import { and, asc, eq, gt, ne, or } from "drizzle-orm";

import type { Actor, Executor } from "./context";
import { actorLabel } from "./context";

export interface NewEvent {
  actor: string;
  action: string;
  matchId?: string | null;
  demandId?: string | null;
  offerId?: string | null;
  buyerId?: string | null;
  supplierId?: string | null;
  payload: Record<string, unknown>;
  sealed?: Record<string, unknown> | null;
}

export const appendEvent = async (executor: Executor, event: NewEvent) => {
  const [row] = await executor
    .insert(marketEvents)
    .values({
      actor: event.actor,
      action: event.action,
      matchId: event.matchId ?? null,
      demandId: event.demandId ?? null,
      offerId: event.offerId ?? null,
      buyerId: event.buyerId ?? null,
      supplierId: event.supplierId ?? null,
      payload: event.payload,
      sealed: event.sealed ?? null,
    })
    .returning({ id: marketEvents.id });
  return row?.id;
};

type EventRow = typeof marketEvents.$inferSelect;

const present = (row: EventRow, withSealed: boolean) => ({
  id: row.id,
  ts: row.ts.toISOString(),
  actor: row.actor,
  action: row.action,
  match_id: row.matchId,
  demand_id: row.demandId,
  offer_id: row.offerId,
  buyer_id: row.buyerId,
  supplier_id: row.supplierId,
  payload: row.payload,
  ...(withSealed ? { sealed: row.sealed } : {}),
});

// Events addressed to a party since the cursor, excluding its own actions.
export const eventsFor = async (
  executor: Executor,
  actor: Actor,
  { since, limit }: { since: number; limit: number }
) => {
  const observer = actor.kind === "observer";
  const entityId = actor.entityId ?? "";
  let addressed;
  if (actor.kind === "buyer") {
    addressed = eq(marketEvents.buyerId, entityId);
  } else if (actor.kind === "supplier") {
    addressed = eq(marketEvents.supplierId, entityId);
  } else if (actor.kind === "trader") {
    addressed = or(
      eq(marketEvents.buyerId, entityId),
      eq(marketEvents.supplierId, entityId)
    );
  }
  const rows = await executor
    .select()
    .from(marketEvents)
    .where(
      and(
        gt(marketEvents.id, since),
        addressed,
        observer ? undefined : ne(marketEvents.actor, actorLabel(actor))
      )
    )
    .orderBy(asc(marketEvents.id))
    .limit(limit);
  return {
    events: rows.map((row) => present(row, observer)),
    cursor: rows.at(-1)?.id ?? since,
  };
};
