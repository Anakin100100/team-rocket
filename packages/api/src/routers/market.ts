// The marketplace for the web app (plan.md §3): public on purpose — the demo
// path never touches the auth scaffold. Reads use the observer view (the feed
// shows every side's reasoning); writes go through the same market functions
// as the agents and MCP clients.
import { ORPCError } from "@orpc/server";
import { listings, rfqs } from "@rocket/db/schema/market";
import {
  MarketError,
  createRfq,
  extractNeed,
  getRfqView,
  readEvents,
} from "@rocket/market";
import { MAX_CANDIDATES } from "@rocket/market/constants";
import {
  matchDemandForSupplier,
  matchSupplyForListing,
  searchListings,
} from "@rocket/market/match";
import { getListing, getSupplier } from "@rocket/market/read";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { publicProcedure } from "../index";

const MAX_LIST = 50;
const DEFAULT_LIST = 20;
const MAX_EVENTS = 500;

const ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  GUARD_FAILED: "CONFLICT",
  INVALID_INPUT: "BAD_REQUEST",
  FORBIDDEN: "FORBIDDEN",
} as const;

// Market refusals are expected outcomes; surface them as HTTP errors with the
// market's own message.
const marketProcedure = publicProcedure.use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof MarketError) {
      throw new ORPCError(ERROR_CODES[error.code], { message: error.message });
    }
    throw error;
  }
});

const countries = z.array(z.string().length(3)).optional();

export const marketRouter = {
  listings: marketProcedure
    .input(
      z.object({
        cpv_prefix: z
          .string()
          .regex(/^\d{1,8}$/u)
          .optional(),
        countries,
        text: z.string().min(2).optional(),
        open_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(MAX_LIST).default(DEFAULT_LIST),
      })
    )
    .handler(({ context, input }) =>
      searchListings(context.db, {
        cpvPrefix: input.cpv_prefix,
        countries: input.countries,
        text: input.text,
        openOnly: input.open_only,
        limit: input.limit,
      })
    ),
  listing: marketProcedure
    .input(z.object({ listing_id: z.string().min(1) }))
    .handler(({ context, input }) => getListing(context, input.listing_id)),
  listingMatches: marketProcedure
    .input(
      z.object({
        listing_id: z.string().min(1),
        countries,
        limit: z.number().int().min(1).max(25).default(MAX_CANDIDATES),
      })
    )
    .handler(({ context, input }) =>
      matchSupplyForListing(context.db, {
        listingId: input.listing_id,
        countries: input.countries,
        limit: input.limit,
      })
    ),
  supplier: marketProcedure
    .input(z.object({ supplier_id: z.string().min(1) }))
    .handler(({ context, input }) => getSupplier(context, input.supplier_id)),
  supplierMatches: marketProcedure
    .input(
      z.object({
        supplier_id: z.string().min(1),
        countries,
        open_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(MAX_LIST).default(DEFAULT_LIST),
      })
    )
    .handler(({ context, input }) =>
      matchDemandForSupplier(context.db, {
        supplierId: input.supplier_id,
        countries: input.countries,
        openOnly: input.open_only,
        limit: input.limit,
      })
    ),
  // The buyer agent reads the notice (any language) into an English need,
  // then the market invites tiered candidates with their price bands.
  createRfq: marketProcedure
    .input(z.object({ listing_id: z.string().min(1) }))
    .handler(async ({ context, input }) => {
      const need = await extractNeed(context.agents, context, input.listing_id);
      return createRfq(context, { listingId: input.listing_id, need });
    }),
  rfq: marketProcedure
    .input(z.object({ rfq_id: z.string().min(1) }))
    .handler(({ context, input }) =>
      getRfqView(context, { rfqId: input.rfq_id, viewer: { role: "observer" } })
    ),
  rfqs: marketProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(MAX_LIST).default(DEFAULT_LIST),
      })
    )
    .handler(({ context, input }) =>
      context.db
        .select({
          rfq_id: rfqs.id,
          state: rfqs.state,
          listing_id: rfqs.listingId,
          listing_title: listings.title,
          running: rfqs.running,
          created_at: rfqs.createdAt,
          updated_at: rfqs.updatedAt,
        })
        .from(rfqs)
        .innerJoin(listings, eq(listings.id, rfqs.listingId))
        .orderBy(desc(rfqs.createdAt))
        .limit(input.limit)
    ),
  events: marketProcedure
    .input(
      z.object({
        rfq_id: z.string().min(1).optional(),
        since: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(MAX_EVENTS).default(MAX_EVENTS),
      })
    )
    .handler(({ context, input }) =>
      readEvents(context.db, {
        rfqId: input.rfq_id,
        since: input.since,
        viewer: { role: "observer" },
        limit: input.limit,
      })
    ),
};
