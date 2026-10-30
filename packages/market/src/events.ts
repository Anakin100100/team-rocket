import { events } from "@rocket/db/schema/market";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { RfqState } from "./constants";
import type { Executor, Viewer } from "./context";

export type EventAudience = "public" | "buyer" | "private";

export interface NewEvent {
  rfqId: string | null;
  actor: string;
  action: string;
  audience: EventAudience;
  supplierId?: string | null;
  payload?: Record<string, unknown>;
  stateBefore?: RfqState | null;
  stateAfter?: RfqState | null;
}

export const appendEvent = async (executor: Executor, event: NewEvent) => {
  const [row] = await executor
    .insert(events)
    .values({
      rfqId: event.rfqId,
      actor: event.actor,
      action: event.action,
      audience: event.audience,
      supplierId: event.supplierId ?? null,
      payload: event.payload ?? {},
      stateBefore: event.stateBefore ?? null,
      stateAfter: event.stateAfter ?? null,
    })
    .returning({ id: events.id });
  return row?.id;
};

const visibleTo = (viewer: Viewer): SQL | undefined => {
  if (viewer.role === "observer") {
    return undefined;
  }
  if (viewer.role === "buyer") {
    return or(eq(events.audience, "public"), eq(events.audience, "buyer"));
  }
  return or(
    eq(events.audience, "public"),
    eq(events.supplierId, viewer.supplierId)
  );
};

export const readEvents = async (
  executor: Executor,
  {
    rfqId,
    since,
    viewer,
    limit,
  }: { rfqId?: string; since: number; viewer: Viewer; limit: number }
) => {
  const rows = await executor
    .select()
    .from(events)
    .where(
      and(
        gt(events.id, since),
        rfqId ? eq(events.rfqId, rfqId) : undefined,
        visibleTo(viewer)
      )
    )
    .orderBy(asc(events.id))
    .limit(limit);
  const cursor = rows.at(-1)?.id ?? since;
  return { events: rows, cursor };
};

export const latestEventId = async (executor: Executor, rfqId: string) => {
  const [row] = await executor
    .select({ id: sql<number>`coalesce(max(${events.id}), 0)::bigint` })
    .from(events)
    .where(eq(events.rfqId, rfqId));
  return Number(row?.id ?? 0);
};
