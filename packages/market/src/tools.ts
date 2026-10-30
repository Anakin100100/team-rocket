// The market's contract (plan.md §4): fourteen tools, one module, two
// transports — called in-process by the agents and exposed over MCP at
// /api/mcp. Inputs are validated here; guards and visibility live in rfq.ts.
import { z } from "zod";

import { MAX_CANDIDATES } from "./constants";
import type { MarketContext } from "./context";
import { viewerFromAs } from "./context";
import { MarketError } from "./errors";
import { readEvents } from "./events";
import {
  matchDemandForSupplier,
  matchSupplyForCpv,
  matchSupplyForListing,
  searchListings,
} from "./match";
import { getListing, getSupplier } from "./read";
import {
  acceptAward,
  awardQuote,
  counterOffer,
  createRfq,
  declineAward,
  declineRfq,
  getRfqView,
  needSchema,
  scoreRfq,
  submitQuote,
} from "./rfq";

const MAX_SEARCH_LIMIT = 50;
const MAX_SUPPLY_LIMIT = 25;
const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 100;
const DEFAULT_DEMAND_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_REASON_LENGTH = 1000;

const id = (what: string) => z.string().min(1).describe(what);
const rfqId = id("RFQ id (from create_rfq or the event feed).");
const supplierId = id(
  "Supplier id, e.g. 'POL:6630002096' (from search_supply)."
);
const countries = z
  .array(z.string().length(3))
  .optional()
  .describe("ISO 3166-1 alpha-3 country codes, e.g. ['POL', 'FIN'].");
const cpvPrefix = z
  .string()
  .regex(/^\d{1,8}$/u)
  .describe("CPV code or prefix, e.g. '35613' (drones) or '35' (defence).");
const asParty = z
  .string()
  .min(1)
  .describe(
    "Who is asking: 'buyer', or a supplier id to see only that supplier's view."
  );
const eur = z.number().positive().describe("Amount in EUR.");
const days = z.number().int().positive().max(3650).describe("Days.");
const isoDate = z.iso
  .datetime({ offset: true })
  .describe("ISO 8601 timestamp, e.g. 2026-10-30T12:00:00Z.");

export type ToolKind = "read" | "buyer" | "supplier";

export interface MarketTool<Input extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  kind: ToolKind;
  description: string;
  input: Input;
  handler: (ctx: MarketContext, input: z.infer<Input>) => Promise<unknown>;
}

const defineTool = <Input extends z.ZodObject>(tool: MarketTool<Input>) =>
  tool as unknown as MarketTool;

export const marketTools: readonly MarketTool[] = [
  defineTool({
    name: "search_demand",
    title: "Search demand",
    kind: "read",
    description:
      "Find public tender listings (TED). With supplier_id: listings that supplier could bid on, tiered by how close they are to what it has already won. Otherwise filter by CPV prefix, buyer country and text. Budgets are in EUR.",
    input: z.object({
      supplier_id: supplierId.optional(),
      cpv_prefix: cpvPrefix.optional(),
      countries: countries.describe("Buyer countries (ISO alpha-3)."),
      text: z
        .string()
        .min(2)
        .optional()
        .describe("Words in the title or description (any language)."),
      open_only: z
        .boolean()
        .default(true)
        .describe("Only listings whose deadline has not passed."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_DEMAND_LIMIT),
    }),
    handler: (ctx, input) =>
      input.supplier_id
        ? matchDemandForSupplier(ctx.db, {
            supplierId: input.supplier_id,
            countries: input.countries,
            openOnly: input.open_only,
            limit: input.limit,
          })
        : searchListings(ctx.db, {
            cpvPrefix: input.cpv_prefix,
            countries: input.countries,
            text: input.text,
            openOnly: input.open_only,
            limit: input.limit,
          }),
  }),
  defineTool({
    name: "search_supply",
    title: "Search supply",
    kind: "read",
    description:
      "Find real suppliers that have won EU defence/security contracts. With listing_id: tiered candidates for that notice (1 = same CPV class, 2 = same division, 3 = any defence award), filtered by eligibility and budget fit. With cpv_prefix: suppliers that won under that CPV. Includes wins and median award value in the matched CPV.",
    input: z
      .object({
        listing_id: id("Listing id, e.g. 'ted:664115-2026'.").optional(),
        cpv_prefix: cpvPrefix.optional(),
        countries: countries.describe("Supplier countries (ISO alpha-3)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SUPPLY_LIMIT)
          .default(MAX_CANDIDATES),
      })
      .refine((input) => input.listing_id || input.cpv_prefix, {
        message: "Pass listing_id or cpv_prefix.",
      }),
    handler: (ctx, input) =>
      input.listing_id
        ? matchSupplyForListing(ctx.db, {
            listingId: input.listing_id,
            countries: input.countries,
            limit: input.limit,
          })
        : matchSupplyForCpv(ctx.db, {
            cpvPrefix: input.cpv_prefix ?? "",
            countries: input.countries,
            limit: input.limit,
          }),
  }),
  defineTool({
    name: "get_listing",
    title: "Get listing",
    kind: "read",
    description:
      "A tender notice with its buyer and derived fields (open, days to deadline, CPV class, eligibility rule). Title and description are in the original language.",
    input: z.object({ listing_id: id("Listing id, e.g. 'ted:664115-2026'.") }),
    handler: (ctx, input) => getListing(ctx, input.listing_id),
  }),
  defineTool({
    name: "get_supplier",
    title: "Get supplier",
    kind: "read",
    description:
      "A supplier's profile: country, size, award statistics, buyer countries and its most recent public contract awards.",
    input: z.object({ supplier_id: supplierId }),
    handler: (ctx, input) => getSupplier(ctx, input.supplier_id),
  }),
  defineTool({
    name: "get_rfq",
    title: "Get RFQ",
    kind: "read",
    description:
      "An RFQ's state, need and deadlines. As 'buyer': every candidate, quote, score and rank (never a supplier's floor). As a supplier id: only that supplier's own price band, status, quotes, rank, counter and the number of bidders.",
    input: z.object({ rfq_id: rfqId, as: asParty }),
    handler: (ctx, input) =>
      getRfqView(ctx, { rfqId: input.rfq_id, viewer: viewerFromAs(input.as) }),
  }),
  defineTool({
    name: "get_events",
    title: "Get events",
    kind: "read",
    description:
      "The market's append-only event log after cursor `since`, filtered by the same visibility as get_rfq. Returns the events and the new cursor to pass next time.",
    input: z.object({
      rfq_id: rfqId.optional(),
      since: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Cursor: the last event id you have seen."),
      as: asParty,
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_EVENTS_LIMIT)
        .default(DEFAULT_EVENTS_LIMIT),
    }),
    handler: (ctx, input) =>
      readEvents(ctx.db, {
        rfqId: input.rfq_id,
        since: input.since,
        viewer: viewerFromAs(input.as),
        limit: input.limit,
      }),
  }),
  defineTool({
    name: "create_rfq",
    title: "Create RFQ",
    kind: "buyer",
    description:
      "Buyer: turn an open listing into a request for quotes. The market invites up to six tiered candidates and gives each its own price band and floor (private to that supplier). State QUOTING, or FAILED when no supplier matches.",
    input: z.object({
      listing_id: id("Listing id, e.g. 'ted:664115-2026'."),
      need: needSchema,
      quoting_deadline: isoDate
        .optional()
        .describe("When quoting closes; default 45 seconds from now."),
    }),
    handler: (ctx, input) =>
      createRfq(ctx, {
        listingId: input.listing_id,
        need: input.need,
        quotingDeadline: input.quoting_deadline
          ? new Date(input.quoting_deadline)
          : undefined,
      }),
  }),
  defineTool({
    name: "score_quotes",
    title: "Score quotes",
    kind: "buyer",
    description:
      "Buyer: rank the current quotes (price 60, lead time 25, track record 15) and move to EVALUATING. Allowed in QUOTING once every candidate answered or the quoting deadline passed, and in NEGOTIATING once every countered supplier answered or the negotiation deadline passed. FAILED if there are no quotes, or nothing fits the budget tolerance after negotiation.",
    input: z.object({ rfq_id: rfqId }),
    handler: (ctx, input) => scoreRfq(ctx, input.rfq_id),
  }),
  defineTool({
    name: "counter",
    title: "Counter a quote",
    kind: "buyer",
    description:
      "Buyer: send one supplier a private counter (price and/or lead time, with a one-line message). Price must be 85–100 % of that supplier's own quote. Once per supplier, only in the single negotiation round: the first counter moves EVALUATING to NEGOTIATING (needs ≥ 2 quotes) and sets the negotiation deadline (default 30 s).",
    input: z.object({
      rfq_id: rfqId,
      supplier_id: supplierId,
      price_eur: eur,
      lead_time_days: days,
      message: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_LENGTH)
        .describe("One line to the supplier."),
      negotiation_deadline: isoDate.optional(),
    }),
    handler: (ctx, input) =>
      counterOffer(ctx, {
        rfqId: input.rfq_id,
        supplierId: input.supplier_id,
        priceEur: input.price_eur,
        leadTimeDays: input.lead_time_days,
        message: input.message,
        negotiationDeadline: input.negotiation_deadline
          ? new Date(input.negotiation_deadline)
          : undefined,
      }),
  }),
  defineTool({
    name: "award",
    title: "Award",
    kind: "buyer",
    description:
      "Buyer: award a scored quote (state AWARDED). Needs EVALUATING. Price must be within budget, or within the tolerance (+10 %) with a justification. Awarding anything but rank 1 also needs a justification.",
    input: z.object({
      rfq_id: rfqId,
      quote_id: id("Quote id from get_rfq or score_quotes."),
      justification: z.string().max(MAX_REASON_LENGTH).optional(),
    }),
    handler: (ctx, input) =>
      awardQuote(ctx, {
        rfqId: input.rfq_id,
        quoteId: input.quote_id,
        justification: input.justification,
      }),
  }),
  defineTool({
    name: "submit_quote",
    title: "Submit quote",
    kind: "supplier",
    description:
      "Supplier: quote on an RFQ you are invited to. final=false in QUOTING (before the quoting deadline); final=true answers a counter in NEGOTIATING (accept it, improve, or resubmit your first quote to hold). Never below your floor; a final quote cannot exceed your first.",
    input: z.object({
      rfq_id: rfqId,
      supplier_id: supplierId,
      price_eur: eur,
      lead_time_days: days,
      note: z
        .string()
        .max(MAX_REASON_LENGTH)
        .optional()
        .describe("Your reasoning, visible to the buyer."),
      final: z.boolean().default(false),
    }),
    handler: (ctx, input) =>
      submitQuote(ctx, {
        rfqId: input.rfq_id,
        supplierId: input.supplier_id,
        priceEur: input.price_eur,
        leadTimeDays: input.lead_time_days,
        note: input.note,
        final: input.final,
      }),
  }),
  defineTool({
    name: "decline",
    title: "Decline RFQ",
    kind: "supplier",
    description:
      "Supplier: decline an invitation in QUOTING, with a reason the buyer sees (e.g. capacity, out of scope, price).",
    input: z.object({
      rfq_id: rfqId,
      supplier_id: supplierId,
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    }),
    handler: (ctx, input) =>
      declineRfq(ctx, {
        rfqId: input.rfq_id,
        supplierId: input.supplier_id,
        reason: input.reason,
      }),
  }),
  defineTool({
    name: "accept_award",
    title: "Accept award",
    kind: "supplier",
    description:
      "Awarded supplier: accept the award. Writes the deal with a contract summary and closes the RFQ (CLOSED).",
    input: z.object({
      rfq_id: rfqId,
      supplier_id: supplierId,
      contract_summary: z.string().max(MAX_REASON_LENGTH).optional(),
    }),
    handler: (ctx, input) =>
      acceptAward(ctx, {
        rfqId: input.rfq_id,
        supplierId: input.supplier_id,
        contractSummary: input.contract_summary,
      }),
  }),
  defineTool({
    name: "decline_award",
    title: "Decline award",
    kind: "supplier",
    description:
      "Awarded supplier: decline the award, with a reason. The RFQ fails (FAILED).",
    input: z.object({
      rfq_id: rfqId,
      supplier_id: supplierId,
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    }),
    handler: (ctx, input) =>
      declineAward(ctx, {
        rfqId: input.rfq_id,
        supplierId: input.supplier_id,
        reason: input.reason,
      }),
  }),
];

export const toolsByName = new Map(
  marketTools.map((tool) => [tool.name, tool])
);

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

// Validate and run one tool. Market refusals and bad input come back as data
// so an agent (or MCP client) can read them and correct course.
export const runTool = async (
  ctx: MarketContext,
  name: string,
  rawInput: unknown
): Promise<ToolOutcome> => {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: `Unknown tool ${name}.` },
    };
  }
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: z.prettifyError(parsed.error) },
    };
  }
  try {
    return { ok: true, result: await tool.handler(ctx, parsed.data) };
  } catch (error) {
    if (error instanceof MarketError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};
