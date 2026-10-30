// Buyer-side score, 0–100, fixed weights (plan.md §6.4). Pure code.
import { SCORE_WEIGHTS, TRACK_RECORD_CAP_WINS } from "./constants";

export interface QuoteToScore {
  quoteId: string;
  supplierId: string;
  priceEur: number;
  leadTimeDays: number;
  winsInCpv: number;
}

export interface ScoredQuote extends QuoteToScore {
  score: number;
  rank: number;
  parts: { price: number; leadTime: number; trackRecord: number };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export const scoreQuotes = (
  quotes: readonly QuoteToScore[],
  requiredDeliveryDays: number
): ScoredQuote[] => {
  if (quotes.length === 0) {
    return [];
  }
  const lowest = Math.min(...quotes.map((q) => q.priceEur));
  const scored = quotes.map((quote) => {
    // Lowest price = 100; others proportionally less (half the price of
    // another quote earns twice its price points).
    const price = (100 * lowest) / quote.priceEur;
    // 100 within the required delivery time, falling linearly to 0 at 2×.
    const overrun = quote.leadTimeDays / requiredDeliveryDays - 1;
    const leadTime = 100 * Math.min(1, Math.max(0, 1 - overrun));
    const trackRecord =
      100 *
      Math.min(
        1,
        Math.log1p(quote.winsInCpv) / Math.log1p(TRACK_RECORD_CAP_WINS)
      );
    const score =
      (SCORE_WEIGHTS.price * price +
        SCORE_WEIGHTS.leadTime * leadTime +
        SCORE_WEIGHTS.trackRecord * trackRecord) /
      100;
    return {
      ...quote,
      score: round1(score),
      parts: {
        price: round1(price),
        leadTime: round1(leadTime),
        trackRecord: round1(trackRecord),
      },
    };
  });
  return scored
    .toSorted((a, b) => b.score - a.score || a.priceEur - b.priceEur)
    .map((quote, index) => ({ ...quote, rank: index + 1 }));
};
