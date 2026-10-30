// Rehearse one full round from the terminal (plan.md §8 step 10): extract the
// need, open the RFQ, run the agents and print the feed. Uses the same
// settings as the server (ANTHROPIC_API_KEY, MARKET_MODEL, MOCK_* flags).
//
// Usage: bun run market:round -- <listing_id> [--rfq <rfq_id>]
//   --rfq resumes (or replays) an existing RFQ instead of opening a new one.
import { parseArgs } from "node:util";

import { createRfq, extractNeed, runRound } from "@rocket/market";

import { ENV } from "../src/env.server";
import { agents, market } from "../src/services";

const DEFAULT_LISTING = "ted:664115-2026";
const NOTE_WIDTH = 90;
const HIDDEN_ACTIONS = new Set(["price_band", "ranked"]);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rfq: { type: "string" } },
});

const describe = (payload: Record<string, unknown>) => {
  const text =
    payload.note ??
    payload.message ??
    payload.justification ??
    payload.reason ??
    payload.text ??
    payload.contract_summary ??
    "";
  const price = payload.price_eur ? ` ${payload.price_eur} EUR` : "";
  const lead = payload.lead_time_days ? `/${payload.lead_time_days}d` : "";
  return `${price}${lead} ${String(text)}`.trim().slice(0, NOTE_WIDTH);
};

let rfqId = values.rfq;
if (!rfqId) {
  const listingId = positionals[0] ?? DEFAULT_LISTING;
  const need = await extractNeed(agents, market, listingId);
  console.log(`Need (${listingId}):`, need.summary_en);
  const created = await createRfq(market, { listingId, need });
  console.log(
    `RFQ ${created.rfq_id}: ${created.state}, ${created.candidates} candidates`
  );
  rfqId = created.rfq_id;
}

const started = Date.now();
for await (const event of runRound(agents, market, rfqId, {
  budgetMs: ENV.ROUND_BUDGET_MS,
})) {
  if (!HIDDEN_ACTIONS.has(event.action)) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
    const state = event.stateAfter ? `→ ${event.stateAfter}` : "";
    console.log(
      `${seconds}s ${event.actor.padEnd(26)} ${event.action.padEnd(14)} ${state.padEnd(14)} ${describe(event.payload as Record<string, unknown>)}`
    );
  }
}
process.exit(0);
