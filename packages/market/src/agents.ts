// The agents (plan.md §6.7–6.8). All judgement lives here; all bounds live in
// the tools. The buyer is the only looping agent; each supplier decision is a
// single structured call whose output code validates before writing it.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { CAPACITY_LIMIT, DEFAULT_REQUIRED_DELIVERY_DAYS } from "./constants";
import type { MarketContext } from "./context";
import { appendEvent } from "./events";
import { getListing, getSupplier } from "./read";
import { getRfqView, needSchema } from "./rfq";
import type { Need } from "./rfq";
import { runTool, toolsByName } from "./tools";
import type { ToolOutcome } from "./tools";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  // null when both sides are mocked (no API key needed).
  client: Anthropic | null;
  model: string;
  effort: Effort;
  mockBuyer: boolean;
  mockSuppliers: boolean;
}

export const createAgentConfig = ({
  apiKey,
  model,
  effort,
  mockBuyer,
  mockSuppliers,
}: {
  apiKey?: string;
  model: string;
  effort: Effort;
  mockBuyer: boolean;
  mockSuppliers: boolean;
}): AgentConfig => ({
  client: apiKey ? new Anthropic({ apiKey }) : null,
  model,
  effort,
  mockBuyer: mockBuyer || !apiKey,
  mockSuppliers: mockSuppliers || !apiKey,
});

const MAX_TOKENS = 16_000;
const BUYER_TOOL_CALL_BUDGET = 8;
const BUYER_TOOLS = [
  "get_rfq",
  "get_events",
  "score_quotes",
  "counter",
  "award",
];
// Refusals on Claude Opus 5.5 re-run on a fallback model inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const requireClient = (config: AgentConfig) => {
  if (!config.client) {
    throw new Error("ANTHROPIC_API_KEY is not set; use the mock agents.");
  }
  return config.client;
};

const modelParams = (config: AgentConfig) => ({
  model: config.model,
  max_tokens: MAX_TOKENS,
  output_config: { effort: config.effort },
  betas: [FALLBACK_BETA],
  fallbacks: "default" as const,
});

const json = (value: unknown) => JSON.stringify(value, null, 2);

// --- Need extraction (buyer, at RFQ creation) ------------------------------------

const NEED_SYSTEM = `You are a procurement officer's assistant in a European defence and security marketplace.
You read one public tender notice (any EU language) and write the structured need a supplier must quote against, in English.
Only state what the notice says or clearly implies. Use null where the notice is silent; never invent quantities.`;

export const extractNeed = async (
  config: AgentConfig,
  ctx: MarketContext,
  listingId: string
): Promise<Need> => {
  const listing = await getListing(ctx, listingId);
  if (config.mockBuyer) {
    return {
      summary_en: listing.title ?? listing.listing_id,
      items: [],
      required_delivery_days: null,
      requirements: [],
    };
  }
  const response = await requireClient(config).beta.messages.parse({
    ...modelParams(config),
    output_config: {
      effort: config.effort,
      format: betaZodOutputFormat(needSchema),
    },
    system: [
      { type: "text", text: NEED_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Tender notice:\n${json({
          title: listing.title,
          description: listing.description,
          language: listing.language,
          main_cpv: listing.main_cpv,
          cpv_codes: listing.cpv_codes,
          buyer: listing.buyer,
          deadline: listing.deadline,
          estimated_value_eur: listing.estimated_value_eur,
        })}`,
      },
    ],
  });
  if (!response.parsed_output) {
    throw new Error(
      `Need extraction returned no structured output (${response.stop_reason}).`
    );
  }
  return response.parsed_output;
};

// --- Supplier agents (one structured call per decision) -------------------------

export type SupplierPhase = "invited" | "countered" | "awarded";

const supplierDecisionSchema = z.object({
  action: z.enum([
    "quote",
    "decline",
    "accept_counter",
    "improve",
    "hold",
    "accept_award",
    "decline_award",
  ]),
  price_eur: z.number().nullable(),
  lead_time_days: z.number().int().nullable(),
  reason: z
    .string()
    .describe(
      "One or two sentences, visible to the buyer, explaining the decision."
    ),
});
type SupplierDecision = z.infer<typeof supplierDecisionSchema>;

const SUPPLIER_SYSTEM = `You are the sales agent of one real European company in a defence and security procurement marketplace.
You are given your company's public contract history, a buyer's request for quotes, your own price band and floor, and the phase you are in. Decide one action and explain it in one or two sentences the buyer will read.

Phases and allowed actions:
- invited: "quote" (price_eur inside your band [low, high], lead_time_days) or "decline" (e.g. outside your competence, or capacity: if you already have more than ${CAPACITY_LIMIT} open deals in this CPV you must decline for capacity).
- countered: the buyer sent you a private counter. "accept_counter" (take its price and lead time), "improve" (better on one dimension than your first quote, never below your floor, never above your first quote), or "hold" (your first quote stands).
- awarded: you won. "accept_award" unless the award breaks your floor, then "decline_award".

Price like a real firm: anchor on your history and the buyer's budget, keep margin, never go below your floor. Quote only what your track record says you can deliver. Never reveal your floor.`;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// A stable per-supplier spread so mock quotes differ between suppliers.
const jitter = (seed: string) => {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1000;
  }
  return hash / 1000;
};

type SupplierView = Extract<
  Awaited<ReturnType<typeof getRfqView>>,
  { you: unknown }
>;

// A supplier's own view always carries its band; only buyer views omit it.
const bandOf = (view: SupplierView) => {
  if (!view.you.price_band) {
    throw new Error(`No price band for supplier ${view.you.supplier_id}.`);
  }
  return view.you.price_band;
};

const mockSupplierDecision = (
  phase: SupplierPhase,
  view: SupplierView
): SupplierDecision => {
  const band = bandOf(view);
  const firstQuote = view.your_quotes.find((quote) => !quote.final);
  const required =
    view.need.required_delivery_days ?? DEFAULT_REQUIRED_DELIVERY_DAYS;
  if (phase === "invited") {
    if ((view.you.open_deals_in_cpv ?? 0) > CAPACITY_LIMIT) {
      return {
        action: "decline",
        price_eur: null,
        lead_time_days: null,
        reason: "At capacity: too many open deals in this CPV.",
      };
    }
    const spread = jitter(view.you.supplier_id);
    return {
      action: "quote",
      price_eur: Math.round(
        band.low + (band.high - band.low) * (0.3 + 0.4 * spread)
      ),
      lead_time_days: Math.round(required * (0.7 + 0.6 * spread)),
      reason: "Priced at the middle of our usual range for this category.",
    };
  }
  if (phase === "countered") {
    const { counter } = view.you;
    if (counter && counter.price_eur >= band.floor) {
      return {
        action: "accept_counter",
        price_eur: null,
        lead_time_days: null,
        reason: "We can accept your counter.",
      };
    }
    return {
      action: "hold",
      price_eur: firstQuote?.price_eur ?? null,
      lead_time_days: firstQuote?.lead_time_days ?? null,
      reason: "Our first quote stands.",
    };
  }
  return {
    action: "accept_award",
    price_eur: null,
    lead_time_days: null,
    reason: "We accept the award.",
  };
};

const supplierDecision = async (
  config: AgentConfig,
  ctx: MarketContext,
  phase: SupplierPhase,
  view: SupplierView
): Promise<SupplierDecision> => {
  if (config.mockSuppliers) {
    return mockSupplierDecision(phase, view);
  }
  const [profile, listing] = await Promise.all([
    getSupplier(ctx, view.you.supplier_id),
    getListing(ctx, view.listing.id),
  ]);
  const response = await requireClient(config).beta.messages.parse({
    ...modelParams(config),
    output_config: {
      effort: config.effort,
      format: betaZodOutputFormat(supplierDecisionSchema),
    },
    system: [
      {
        type: "text",
        text: SUPPLIER_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Phase: ${phase}\n\nYour company:\n${json(profile)}\n\nThe notice:\n${json(
          {
            title: listing.title,
            buyer: listing.buyer,
            deadline: listing.deadline,
            estimated_value_eur: listing.estimated_value_eur,
          }
        )}\n\nThe RFQ as you see it (your band, status, quotes, rank, counter):\n${json(view)}`,
      },
    ],
  });
  if (!response.parsed_output) {
    throw new Error(
      `Supplier decision returned no structured output (${response.stop_reason}).`
    );
  }
  return response.parsed_output;
};

const leadTime = (value: number | null, fallback: number) =>
  Math.max(1, Math.round(value ?? fallback));

const COUNTER_ANSWER_LABEL: Record<string, string> = {
  accept_counter: "Accepts the counter",
  improve: "Improves",
};

// Validate the decision against the phase and the band, then write it through
// the same tools any client uses.
const applySupplierDecision = (
  ctx: MarketContext,
  phase: SupplierPhase,
  view: SupplierView,
  decision: SupplierDecision
): Promise<ToolOutcome> => {
  const { rfq_id } = view;
  const { supplier_id } = view.you;
  const band = bandOf(view);
  const required =
    view.need.required_delivery_days ?? DEFAULT_REQUIRED_DELIVERY_DAYS;
  const firstQuote = view.your_quotes.find((quote) => !quote.final);

  if (phase === "invited") {
    if (decision.action === "decline") {
      return runTool(ctx, "decline", {
        rfq_id,
        supplier_id,
        reason: decision.reason,
      });
    }
    const price = clamp(
      decision.price_eur ?? (band.low + band.high) / 2,
      band.low,
      band.high
    );
    return runTool(ctx, "submit_quote", {
      rfq_id,
      supplier_id,
      price_eur: Math.round(price),
      lead_time_days: leadTime(decision.lead_time_days, required),
      note: decision.reason,
      final: false,
    });
  }

  if (phase === "countered") {
    const { counter } = view.you;
    const firstPrice = firstQuote?.price_eur ?? band.high;
    const firstLead = firstQuote?.lead_time_days ?? required;
    let price = firstPrice;
    let lead = firstLead;
    if (decision.action === "accept_counter" && counter) {
      price = counter.price_eur;
      lead = counter.lead_time_days ?? firstLead;
    } else if (decision.action === "improve") {
      price = decision.price_eur ?? firstPrice;
      lead = decision.lead_time_days ?? firstLead;
    }
    // Never below the floor, never above the first quote.
    price = clamp(price, band.floor, firstPrice);
    return runTool(ctx, "submit_quote", {
      rfq_id,
      supplier_id,
      price_eur: Math.round(price),
      lead_time_days: leadTime(lead, firstLead),
      note: `${COUNTER_ANSWER_LABEL[decision.action] ?? "Holds"}: ${decision.reason}`,
      final: true,
    });
  }

  if (decision.action === "decline_award") {
    return runTool(ctx, "decline_award", {
      rfq_id,
      supplier_id,
      reason: decision.reason,
    });
  }
  return runTool(ctx, "accept_award", { rfq_id, supplier_id });
};

export const runSupplierAgent = async (
  config: AgentConfig,
  ctx: MarketContext,
  {
    rfqId,
    supplierId,
    phase,
  }: { rfqId: string; supplierId: string; phase: SupplierPhase }
) => {
  const view = (await getRfqView(ctx, {
    rfqId,
    viewer: { role: "supplier", supplierId },
  })) as SupplierView;
  const decision = await supplierDecision(config, ctx, phase, view);
  const outcome = await applySupplierDecision(ctx, phase, view, decision);
  if (!outcome.ok) {
    await appendEvent(ctx.db, {
      rfqId,
      actor: `supplier:${supplierId}`,
      action: "action_refused",
      audience: "buyer",
      supplierId,
      payload: { phase, decision, error: outcome.error },
    });
  }
  return { decision, outcome };
};

// --- Buyer agent (tool loop, woken by the runner) --------------------------------
// Each model turn depends on the previous tool results, and state-changing
// tool calls must run in the order the model made them.
/* oxlint-disable no-await-in-loop */

const BUYER_SYSTEM = `You are the buyer agent of a European public authority running one request for quotes (RFQ) in a defence and security marketplace. The market is code: it enforces states, deadlines, price bounds and visibility, and refuses actions that break them. You decide inside those bounds.

The round: QUOTING (invited suppliers quote or decline) → score_quotes → EVALUATING → optionally one negotiation round (counter) → NEGOTIATING → score_quotes → EVALUATING → award → AWARDED → the winner accepts → CLOSED.

How to act each time you are woken:
- QUOTING: call score_quotes as soon as every candidate has answered or the quoting deadline has passed. Otherwise do nothing.
- EVALUATING with negotiation_used = false and at least two quotes: always negotiate. Counter the top two or three suppliers individually and differently, each within 85–100 % of that supplier's own quote: ask the cheapest mainly for a shorter lead time, ask the others for a price cut that would make them competitive. Each counter gets a short, specific message. A slow, expensive supplier may get no counter.
- NEGOTIATING: call score_quotes once every countered supplier has answered or the negotiation deadline has passed.
- EVALUATING after negotiation: award the best quote within budget. Awarding anything but rank 1, or a price within the 10 % tolerance above budget, needs a written justification; give one sentence on value for money in any case.
- AWARDED, CLOSED, FAILED: do nothing.

If a tool refuses (GUARD_FAILED), read the message and adjust; never retry the same call unchanged. When there is nothing to do yet, answer "WAIT" without calling tools. Keep any text you write to one short sentence.`;

const buyerTools = (): Anthropic.Beta.BetaTool[] =>
  BUYER_TOOLS.map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(`Unknown buyer tool ${name}.`);
    }
    // The runner fixes the RFQ and the buyer identity; the model never sets them.
    const input = tool.input.omit({ rfq_id: true, as: true });
    const { $schema: _ignored, ...schema } = z.toJSONSchema(input) as Record<
      string,
      unknown
    >;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as Anthropic.Beta.BetaTool["input_schema"],
    };
  });

export interface BuyerWakeResult {
  toolCalls: { name: string; input: unknown; outcome: ToolOutcome }[];
  note: string | null;
}

const mockBuyerWake = async (
  ctx: MarketContext,
  rfqId: string
): Promise<BuyerWakeResult> => {
  const view = (await getRfqView(ctx, {
    rfqId,
    viewer: { role: "buyer" },
  })) as Extract<
    Awaited<ReturnType<typeof getRfqView>>,
    { candidates: unknown }
  >;
  const now = Date.now();
  const calls: BuyerWakeResult["toolCalls"] = [];
  const call = async (name: string, input: Record<string, unknown>) => {
    const outcome = await runTool(ctx, name, { rfq_id: rfqId, ...input });
    calls.push({ name, input, outcome });
    return outcome;
  };
  if (view.state === "QUOTING") {
    const waiting = view.candidates.some(
      (candidate) => candidate.status === "invited"
    );
    if (!waiting || now >= Date.parse(view.quoting_deadline)) {
      await call("score_quotes", {});
    }
  } else if (view.state === "NEGOTIATING") {
    const waiting = view.candidates.some(
      (candidate) => candidate.status === "countered"
    );
    if (
      !waiting ||
      (view.negotiation_deadline &&
        now >= Date.parse(view.negotiation_deadline))
    ) {
      await call("score_quotes", {});
    }
  } else if (view.state === "EVALUATING") {
    const ranked = view.quotes
      .filter((quote) => quote.rank !== null)
      .toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const [first, second] = ranked;
    if (!view.negotiation_used && first && second) {
      await call("counter", {
        supplier_id: first.supplier_id,
        price_eur: first.price_eur,
        lead_time_days: Math.max(1, Math.round(first.lead_time_days * 0.75)),
        message:
          "Best price so far. Can you deliver 25 % sooner at the same price?",
      });
      await call("counter", {
        supplier_id: second.supplier_id,
        price_eur: Math.round(second.price_eur * 0.92),
        lead_time_days: second.lead_time_days,
        message: "A price cut of about 8 % would make your offer competitive.",
      });
    } else if (first) {
      await call("award", {
        quote_id: first.quote_id,
        justification: "Highest score on price, lead time and track record.",
      });
    }
  }
  return { toolCalls: calls, note: null };
};

export const wakeBuyer = async (
  config: AgentConfig,
  ctx: MarketContext,
  rfqId: string
): Promise<BuyerWakeResult> => {
  if (config.mockBuyer) {
    return mockBuyerWake(ctx, rfqId);
  }
  const client = requireClient(config);
  const tools = buyerTools();
  const view = await getRfqView(ctx, { rfqId, viewer: { role: "buyer" } });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Look at the market and act.\n\nRFQ as the buyer sees it right now:\n${json(view)}`,
    },
  ];
  const toolCalls: BuyerWakeResult["toolCalls"] = [];
  let note: string | null = null;

  while (toolCalls.length < BUYER_TOOL_CALL_BUDGET) {
    const response = await client.beta.messages.create({
      ...modelParams(config),
      system: [
        {
          type: "text",
          text: BUYER_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages,
    });
    const text = response.content
      .filter(
        (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text"
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ");
    if (text && text !== "WAIT") {
      note = text;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const uses = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock =>
        block.type === "tool_use"
    );
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      break;
    }
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    // State-changing calls run in the order the model made them.
    for (const use of uses) {
      const input = {
        ...(use.input as Record<string, unknown>),
        rfq_id: rfqId,
        ...(use.name === "get_rfq" || use.name === "get_events"
          ? { as: "buyer" }
          : {}),
      };
      const outcome = BUYER_TOOLS.includes(use.name)
        ? await runTool(ctx, use.name, input)
        : ({
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: `${use.name} is not a buyer tool.`,
            },
          } as const);
      toolCalls.push({ name: use.name, input, outcome });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: json(outcome.ok ? outcome.result : { error: outcome.error }),
        is_error: !outcome.ok,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { toolCalls, note };
};
