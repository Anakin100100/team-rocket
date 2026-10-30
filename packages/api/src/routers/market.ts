// The admin UI's data (plan.md §6): read only, observer view (sealed limits
// included), public like the rest of the demo path. Agents never use this;
// they trade through /api/mcp.
import { marketAgents } from "@rocket/db/schema/market";
import { eventsFor, myMarket } from "@rocket/market";
import type { Actor } from "@rocket/market";
import { asc } from "drizzle-orm";
import { z } from "zod";

import { publicProcedure } from "../index";

const MAX_EVENTS = 500;
// An agent is online if it called `wait` this recently.
const ONLINE_WINDOW_MS = 30_000;
const OBSERVER: Actor = { kind: "observer", entityId: null, name: "admin-ui" };

export const marketRouter = {
  events: publicProcedure
    .input(
      z.object({
        since: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(MAX_EVENTS).default(MAX_EVENTS),
      })
    )
    .handler(({ context, input }) => eventsFor(context.db, OBSERVER, input)),
  snapshot: publicProcedure.handler(({ context }) =>
    myMarket(context, OBSERVER)
  ),
  agents: publicProcedure.handler(async ({ context }) => {
    const rows = await context.db
      .select({
        kind: marketAgents.kind,
        entity_id: marketAgents.entityId,
        name: marketAgents.name,
        last_seen_at: marketAgents.lastSeenAt,
      })
      .from(marketAgents)
      .orderBy(asc(marketAgents.kind), asc(marketAgents.name));
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      online:
        row.last_seen_at !== null &&
        now - row.last_seen_at.getTime() < ONLINE_WINDOW_MS,
    }));
  }),
};
