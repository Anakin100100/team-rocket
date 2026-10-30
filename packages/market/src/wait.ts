import { setTimeout as delay } from "node:timers/promises";

// The agents' clock (plan.md §5.1): a long poll for events addressed to the
// caller. It also marks a persona as online for the admin UI.
import { marketAgents } from "@rocket/db/schema/market";
import { eq } from "drizzle-orm";

import { WAIT_MAX_SECONDS, WAIT_POLL_MS } from "./constants";
import type { Actor, MarketContext } from "./context";
import { eventsFor } from "./events";

const WAIT_EVENT_LIMIT = 100;

export const wait = async (
  { db }: MarketContext,
  actor: Actor,
  { since, timeoutSeconds }: { since: number; timeoutSeconds: number }
) => {
  if (actor.tokenHash) {
    await db
      .update(marketAgents)
      .set({ lastSeenAt: new Date() })
      .where(eq(marketAgents.tokenHash, actor.tokenHash));
  }
  const deadline =
    Date.now() + Math.min(timeoutSeconds, WAIT_MAX_SECONDS) * 1000;
  // Polling is the point: check, sleep, check again until news or timeout.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const batch = await eventsFor(db, actor, {
      since,
      limit: WAIT_EVENT_LIMIT,
    });
    if (batch.events.length > 0 || Date.now() >= deadline) {
      return { ...batch, timed_out: batch.events.length === 0 };
    }
    // oxlint-disable-next-line no-await-in-loop
    await delay(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
};
