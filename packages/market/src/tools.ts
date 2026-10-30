// The market's contract (plan.md §4.1), exposed at /api/mcp. Identity comes
// from the connection and is passed in as `actor`; no tool takes "who am I"
// as an argument.
import { z } from "zod";

import {
  MAX_CITES,
  MAX_FLOOR_PCT,
  MAX_MATCHES,
  MAX_WALK_AWAY_PCT,
  MIN_FLOOR_PCT,
  MIN_WALK_AWAY_PCT,
  WAIT_MAX_SECONDS,
} from "./constants";
import type { Actor, MarketContext } from "./context";
import { MarketError, invalidInput } from "./errors";
import {
  history,
  myMarket,
  searchListings,
  searchSuppliers,
  whoami,
} from "./read";
import {
  accept,
  postDemand,
  postOffer,
  propose,
  walkAway,
  withdraw,
} from "./trade";
import { setCompany, setLimits } from "./traders";
import { wait } from "./wait";

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 1500;
const MAX_NOTE_LENGTH = 1000;
const MAX_REASON_LENGTH = 1000;
const MAX_LEAD_TIME_DAYS = 3650;
const MAX_TITLE_LENGTH = 300;
const MAX_COMPANY_NAME_LENGTH = 200;
const MAX_REGISTRY_LENGTH = 40;
const OWN_LISTING_FIELDS = [
  "title",
  "cpv",
  "estimated_value_eur",
  "deadline",
] as const;

const matchId = z
  .string()
  .min(1)
  .describe("Thread id (match_id) from my_market or wait.");
const country = z
  .string()
  .length(3)
  .optional()
  .describe("ISO 3166-1 alpha-3 country code, e.g. 'SVK'.");
const cpvPrefix = z
  .string()
  .regex(/^\d{1,8}$/u)
  .optional()
  .describe("CPV code or prefix, e.g. '358' (body armour) or '35' (defence).");
const priceEur = z.number().positive().describe("Total price in EUR.");
const leadTimeDays = z
  .number()
  .int()
  .positive()
  .max(MAX_LEAD_TIME_DAYS)
  .describe("Delivery time in days from agreement.");

// `trader` tools exist only for signed-in users and are not listed to personas.
export type ToolAccess = "any" | "buyer" | "supplier" | "party" | "trader";

export interface MarketTool<Input extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  access: ToolAccess;
  readOnly: boolean;
  description: string;
  input: Input;
  handler: (
    ctx: MarketContext,
    actor: Actor,
    input: z.infer<Input>
  ) => Promise<unknown>;
}

const defineTool = <Input extends z.ZodObject>(tool: MarketTool<Input>) =>
  tool as unknown as MarketTool;

export const marketTools: readonly MarketTool[] = [
  defineTool({
    name: "whoami",
    title: "Who am I",
    access: "any",
    readOnly: true,
    description:
      "Your own record: profile, public stats and award history (with TED URLs), the CPV classes you can offer in (suppliers) or your listings (buyers), your open postings and threads, and the threads where it is your turn.",
    input: z.object({}),
    handler: (ctx, actor) => whoami(ctx, actor),
  }),
  defineTool({
    name: "search_listings",
    title: "Search listings",
    access: "any",
    readOnly: true,
    description:
      "Open public tender listings (TED) with their published value in EUR, deadline and CPV. Filter by CPV prefix, buyer country or words in the title or need.",
    input: z.object({
      cpv_prefix: cpvPrefix,
      country: country.describe("Buyer country (ISO alpha-3)."),
      text: z.string().min(2).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT),
    }),
    handler: (ctx, _actor, input) =>
      searchListings(ctx, {
        cpvPrefix: input.cpv_prefix,
        country: input.country,
        text: input.text,
        limit: input.limit,
      }),
  }),
  defineTool({
    name: "search_suppliers",
    title: "Search suppliers",
    access: "any",
    readOnly: true,
    description:
      "Real suppliers that won EU defence and security contracts, with public stats and what they won per CPV class (wins, median award). Filter by CPV prefix and country.",
    input: z.object({
      cpv_prefix: cpvPrefix,
      country: country.describe("Supplier country (ISO alpha-3)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT),
    }),
    handler: (ctx, _actor, input) =>
      searchSuppliers(ctx, {
        cpvPrefix: input.cpv_prefix,
        country: input.country,
        limit: input.limit,
      }),
  }),
  defineTool({
    name: "history",
    title: "Award history",
    access: "any",
    readOnly: true,
    description:
      "Public award records of a buyer or a supplier: who bought what from whom, for how much, against how many bidders, with the TED notice URL. Cite these URLs in your messages.",
    input: z.object({
      entity_id: z
        .string()
        .min(1)
        .describe(
          "Buyer id (e.g. 'ted-buyer:00212008') or supplier id (e.g. 'ESP:28030062')."
        ),
    }),
    handler: (ctx, _actor, input) => history(ctx, input.entity_id),
  }),
  defineTool({
    name: "my_market",
    title: "My market",
    access: "any",
    readOnly: true,
    description:
      "Your demands or offers and every thread you are a party to: the counterparty, all proposals with messages and citations, whose turn it is and how many proposals each side has left.",
    input: z.object({}),
    handler: (ctx, actor) => myMarket(ctx, actor),
  }),
  defineTool({
    name: "wait",
    title: "Wait for news",
    access: "any",
    readOnly: true,
    description: `Your clock. Blocks up to ${WAIT_MAX_SECONDS} s until something addressed to you happens (a match opens, the other side proposes, accepts or walks away, a thread is superseded), then returns those events and a new cursor. Pass the cursor back as \`since\` next time.`,
    input: z.object({
      since: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Cursor: the last event id you have seen."),
      timeout_s: z
        .number()
        .int()
        .min(1)
        .max(WAIT_MAX_SECONDS)
        .default(WAIT_MAX_SECONDS),
    }),
    handler: (ctx, actor, input) =>
      wait(ctx, actor, { since: input.since, timeoutSeconds: input.timeout_s }),
  }),
  defineTool({
    name: "post_demand",
    title: "Post demand",
    access: "buyer",
    readOnly: false,
    description: `Buyer: put one of your open listings on the market (listing_id), or, with no published listing, a demand of your own (title, cpv, estimated_value_eur and deadline). The market matches it against open offers right away and opens up to ${MAX_MATCHES} private threads, each starting with that supplier's public ask; you are on turn in each. A listing is bought once.`,
    input: z.object({
      listing_id: z
        .string()
        .min(1)
        .optional()
        .describe("One of your listings (see whoami)."),
      need: z
        .string()
        .min(1)
        .max(MAX_NOTE_LENGTH)
        .optional()
        .describe(
          "What you are buying, in English. Defaults to the listing's need, or the title."
        ),
      title: z
        .string()
        .min(3)
        .max(MAX_TITLE_LENGTH)
        .optional()
        .describe("Own demand: a short title, in English."),
      cpv: z
        .string()
        .regex(/^\d{8}$/u)
        .optional()
        .describe("Own demand: the 8-digit CPV code, e.g. '35815100'."),
      estimated_value_eur: z
        .number()
        .positive()
        .optional()
        .describe(
          "Own demand: what you expect to pay in EUR. Suppliers see it; your walk-away is a percentage of it (see set_limits)."
        ),
      deadline: z.iso
        .date()
        .optional()
        .describe("Own demand: last day to agree a deal, YYYY-MM-DD."),
    }),
    handler: (ctx, actor, input) => {
      const given = OWN_LISTING_FIELDS.filter(
        (field) => input[field] !== undefined
      );
      if (input.listing_id && given.length > 0) {
        throw invalidInput(
          `Give either listing_id or ${OWN_LISTING_FIELDS.join(", ")}, not both.`
        );
      }
      if (input.listing_id) {
        return postDemand(ctx, actor, {
          listingId: input.listing_id,
          need: input.need,
        });
      }
      const { title, cpv, estimated_value_eur: value, deadline } = input;
      if (!(title && cpv && value && deadline)) {
        const missing = OWN_LISTING_FIELDS.filter(
          (field) => input[field] === undefined
        );
        throw invalidInput(
          `Give listing_id, or for a demand of your own: ${missing.join(", ")}.`
        );
      }
      return postDemand(ctx, actor, {
        need: input.need,
        own: { title, cpv, estimatedValueEur: value, deadline },
      });
    },
  }),
  defineTool({
    name: "post_offer",
    title: "Post offer",
    access: "supplier",
    readOnly: false,
    description: `Supplier: offer what you supply in one CPV class, with your public ask, lead time and a note buyers will read. Agent personas offer only in classes they have won in (see whoami); signed-in users in any class, with their floor a percentage of the ask (see set_limits). The market matches it against open demands right away and opens up to ${MAX_MATCHES} private threads. One open offer per class.`,
    input: z.object({
      cpv_class: z
        .string()
        .regex(/^\d{3}$/u)
        .describe("3-digit CPV class, e.g. '358'."),
      ask_eur: priceEur.describe(
        "Your public asking price in EUR for a typical contract."
      ),
      lead_time_days: leadTimeDays,
      note: z
        .string()
        .min(1)
        .max(MAX_NOTE_LENGTH)
        .describe("Why buy from you, in one or two sentences."),
    }),
    handler: (ctx, actor, input) =>
      postOffer(ctx, actor, {
        cpvClass: input.cpv_class,
        askEur: input.ask_eur,
        leadTimeDays: input.lead_time_days,
        note: input.note,
      }),
  }),
  defineTool({
    name: "propose",
    title: "Propose",
    access: "party",
    readOnly: false,
    description:
      "Make a new standing proposal in a thread where it is your turn. You can only concede against your own last proposal (buyers up, suppliers down), at most 3 proposals per side. A price beyond your sealed limit is refused as 'outside your limit'. Cite public award URLs that support your price.",
    input: z.object({
      match_id: matchId,
      price_eur: priceEur,
      lead_time_days: leadTimeDays,
      message: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_LENGTH)
        .describe("Your argument, to the other side."),
      cites: z
        .array(z.url())
        .max(MAX_CITES)
        .default([])
        .describe(
          "TED notice URLs backing your argument (from whoami or history)."
        ),
    }),
    handler: (ctx, actor, input) =>
      propose(ctx, actor, {
        matchId: input.match_id,
        priceEur: input.price_eur,
        leadTimeDays: input.lead_time_days,
        message: input.message,
        cites: input.cites,
      }),
  }),
  defineTool({
    name: "accept",
    title: "Accept",
    access: "party",
    readOnly: false,
    description:
      "Sign the other side's standing proposal as it is. That is the contract: the thread is agreed, the demand and the offer are filled, and every other open thread on them is superseded.",
    input: z.object({ match_id: matchId }),
    handler: (ctx, actor, input) =>
      accept(ctx, actor, { matchId: input.match_id }),
  }),
  defineTool({
    name: "walk_away",
    title: "Walk away",
    access: "party",
    readOnly: false,
    description:
      "End a thread, with a reason the other side reads (capacity, impossible lead time, price, silence).",
    input: z.object({
      match_id: matchId,
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    }),
    handler: (ctx, actor, input) =>
      walkAway(ctx, actor, { matchId: input.match_id, reason: input.reason }),
  }),
  defineTool({
    name: "withdraw",
    title: "Withdraw",
    access: "party",
    readOnly: false,
    description:
      "Take one of your open demands or offers off the market. Its open threads end, and each counterparty reads your reason.",
    input: z.object({
      posting_id: z
        .string()
        .min(1)
        .describe("A demand_id or offer_id of yours (see my_market)."),
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    }),
    handler: (ctx, actor, input) =>
      withdraw(ctx, actor, {
        postingId: input.posting_id,
        reason: input.reason,
      }),
  }),
  defineTool({
    name: "set_company",
    title: "Set company",
    access: "trader",
    readOnly: false,
    description:
      "Choose the company you trade as; you buy and sell as that one company. Give your VAT or company number to trade as its public record (its public awards become your history), or your company's name to trade under it without one. Switching company needs your open demands and offers withdrawn first.",
    input: z.object({
      country: z
        .string()
        .regex(/^[A-Za-z]{3}$/u)
        .transform((value) => value.toUpperCase())
        .describe("Your company's country, ISO 3166-1 alpha-3, e.g. 'CZE'."),
      registry_number: z
        .string()
        .min(4)
        .max(MAX_REGISTRY_LENGTH)
        .optional()
        .describe(
          "VAT or national company number, e.g. 'CZ26181134' or 'DE 298856333'."
        ),
      name: z
        .string()
        .min(2)
        .max(MAX_COMPANY_NAME_LENGTH)
        .optional()
        .describe(
          "Your company's name; needed when the number finds no public record."
        ),
    }),
    handler: (ctx, actor, input) =>
      setCompany(ctx, actor, {
        country: input.country,
        name: input.name,
        registryNumber: input.registry_number,
      }),
  }),
  defineTool({
    name: "set_limits",
    title: "Set limits",
    access: "trader",
    readOnly: false,
    description:
      "Set your sealed limits, which no counterparty ever sees and the market enforces on every price you propose or accept. walk_away_pct: as a buyer, the most you will pay, as a percentage of your demand's estimated value (default 110). floor_pct: as a seller, the least you will take, as a percentage of your offer's ask (default 80). They apply to demands and offers you post afterwards.",
    input: z.object({
      walk_away_pct: z
        .number()
        .min(MIN_WALK_AWAY_PCT)
        .max(MAX_WALK_AWAY_PCT)
        .optional(),
      floor_pct: z.number().min(MIN_FLOOR_PCT).max(MAX_FLOOR_PCT).optional(),
    }),
    handler: (ctx, actor, input) => {
      if (input.walk_away_pct === undefined && input.floor_pct === undefined) {
        throw invalidInput("Give walk_away_pct, floor_pct or both.");
      }
      return setLimits(ctx, actor, {
        walkAwayPct: input.walk_away_pct,
        floorPct: input.floor_pct,
      });
    },
  }),
];

export const toolsByName = new Map(
  marketTools.map((tool) => [tool.name, tool])
);

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

// Validate and run one tool as `actor`. Refusals come back as data so the
// agent can read the reason and adjust.
export const runTool = async (
  ctx: MarketContext,
  actor: Actor,
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
    return { ok: true, result: await tool.handler(ctx, actor, parsed.data) };
  } catch (error) {
    if (error instanceof MarketError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};
