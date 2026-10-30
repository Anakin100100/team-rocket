// The market's state machine (plan.md §5). Nothing runs here on its own: each
// function is one action, and its guards are the transitions. Every action
// locks the RFQ row first, so concurrent agents are serialised per RFQ.
//
// Writes inside one transaction share one connection and must stay ordered
// (events in particular), so they are awaited one by one.
/* oxlint-disable no-await-in-loop */
import {
  buyers,
  candidates,
  deals,
  listings,
  quotes,
  rfqs,
  suppliers,
} from "@rocket/db/schema/market";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  COUNTER_PRICE_BOUNDS,
  DEFAULT_BUDGET_TOLERANCE,
  DEFAULT_NEGOTIATION_WINDOW_SECONDS,
  DEFAULT_QUOTING_WINDOW_SECONDS,
  DEFAULT_REQUIRED_DELIVERY_DAYS,
  MAX_CANDIDATES,
  MIN_QUOTES_TO_NEGOTIATE,
} from "./constants";
import type { CandidateStatus, RfqState } from "./constants";
import type { Executor, MarketContext, Viewer } from "./context";
import { guardFailed, MarketError, notFound } from "./errors";
import { appendEvent } from "./events";
import { matchSupplyForListing } from "./match";
import { priceBand } from "./pricing";
import { scoreQuotes } from "./scoring";

// What the buyer actually needs, in English, extracted from the notice.
export const needSchema = z.object({
  summary_en: z
    .string()
    .min(1)
    .describe("One or two sentences in English: what is being bought."),
  items: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
      })
    )
    .describe("Line items; quantity/unit null when the notice does not say."),
  required_delivery_days: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Days from award to delivery the buyer needs; null if unknown."),
  requirements: z
    .array(z.string())
    .describe("Key technical, legal or security requirements, in English."),
});
export type Need = z.infer<typeof needSchema>;

const BUYER = "buyer";
const MARKET = "market";
const supplierActor = (supplierId: string) => `supplier:${supplierId}`;
const secondsFromNow = (seconds: number) =>
  new Date(Date.now() + seconds * 1000);

type Tx = Parameters<Parameters<MarketContext["db"]["transaction"]>[0]>[0];
type RfqRow = typeof rfqs.$inferSelect;
type CandidateRow = typeof candidates.$inferSelect;

const lockRfq = async (tx: Tx, rfqId: string): Promise<RfqRow> => {
  const [rfq] = await tx
    .select()
    .from(rfqs)
    .where(eq(rfqs.id, rfqId))
    .for("update");
  if (!rfq) {
    throw notFound(`RFQ ${rfqId} does not exist.`);
  }
  return rfq;
};

const expectState = (rfq: RfqRow, ...allowed: RfqState[]) => {
  if (!allowed.includes(rfq.state as RfqState)) {
    throw guardFailed(
      `RFQ is ${rfq.state}; this action needs ${allowed.join(" or ")}.`
    );
  }
};

const setState = async (
  tx: Tx,
  rfq: RfqRow,
  next: RfqState,
  extra: Partial<typeof rfqs.$inferInsert> = {}
) => {
  const updated = await tx
    .update(rfqs)
    .set({ ...extra, state: next, updatedAt: new Date() })
    .where(and(eq(rfqs.id, rfq.id), eq(rfqs.state, rfq.state)))
    .returning({ id: rfqs.id });
  if (updated.length === 0) {
    throw guardFailed(`RFQ ${rfq.id} changed state concurrently.`);
  }
};

const getCandidate = async (
  tx: Tx,
  rfqId: string,
  supplierId: string
): Promise<CandidateRow> => {
  const [candidate] = await tx
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.rfqId, rfqId), eq(candidates.supplierId, supplierId))
    );
  if (!candidate) {
    throw new MarketError(
      "FORBIDDEN",
      `Supplier ${supplierId} is not invited to RFQ ${rfqId}.`
    );
  }
  return candidate;
};

const setCandidateStatus = async (
  tx: Tx,
  candidate: CandidateRow,
  next: CandidateStatus,
  extra: Partial<typeof candidates.$inferInsert> = {}
) => {
  const updated = await tx
    .update(candidates)
    .set({ ...extra, status: next })
    .where(
      and(
        eq(candidates.rfqId, candidate.rfqId),
        eq(candidates.supplierId, candidate.supplierId),
        eq(candidates.status, candidate.status)
      )
    )
    .returning({ status: candidates.status });
  if (updated.length === 0) {
    throw guardFailed(
      `Supplier ${candidate.supplierId} changed status concurrently.`
    );
  }
};

// First quote, replaced by the final one once it exists.
const currentQuotes = async (executor: Executor, rfqId: string) => {
  const rows = await executor
    .select({
      quote: quotes,
      winsInCpv: candidates.winsInCpv,
      supplierName: suppliers.name,
    })
    .from(quotes)
    .innerJoin(
      candidates,
      and(
        eq(candidates.rfqId, quotes.rfqId),
        eq(candidates.supplierId, quotes.supplierId)
      )
    )
    .innerJoin(suppliers, eq(suppliers.id, quotes.supplierId))
    .where(eq(quotes.rfqId, rfqId))
    .orderBy(asc(quotes.createdAt));
  const bySupplier = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = bySupplier.get(row.quote.supplierId);
    if (!existing || row.quote.final) {
      bySupplier.set(row.quote.supplierId, row);
    }
  }
  return [...bySupplier.values()];
};

const requiredDeliveryDays = (rfq: RfqRow) =>
  (rfq.need as Need).required_delivery_days ?? DEFAULT_REQUIRED_DELIVERY_DAYS;

// --- Buyer actions ------------------------------------------------------------

export const createRfq = (
  { db }: MarketContext,
  {
    listingId,
    need,
    quotingDeadline,
    budgetTolerance = DEFAULT_BUDGET_TOLERANCE,
  }: {
    listingId: string;
    need: Need;
    quotingDeadline?: Date;
    budgetTolerance?: number;
  }
) =>
  db.transaction(async (tx) => {
    const [listing] = await tx
      .select({
        id: listings.id,
        title: listings.title,
        buyerId: listings.buyerId,
        mainCpv: listings.mainCpv,
        budget: listings.estimatedValueEur,
        isOpen: sql<boolean>`${listings.deadline} >= current_date`,
      })
      .from(listings)
      .where(eq(listings.id, listingId));
    if (!listing) {
      throw notFound(`Listing ${listingId} does not exist.`);
    }
    if (!listing.isOpen) {
      throw guardFailed(`Listing ${listingId} is closed (deadline passed).`);
    }
    const deadline =
      quotingDeadline ?? secondsFromNow(DEFAULT_QUOTING_WINDOW_SECONDS);
    if (deadline.getTime() <= Date.now()) {
      throw new MarketError(
        "INVALID_INPUT",
        "quoting_deadline must be in the future."
      );
    }

    const matches = await matchSupplyForListing(tx, {
      listingId,
      limit: MAX_CANDIDATES,
    });
    const state: RfqState = matches.length > 0 ? "QUOTING" : "FAILED";
    const [rfq] = await tx
      .insert(rfqs)
      .values({
        listingId,
        buyerId: listing.buyerId,
        state,
        need,
        budgetEur: listing.budget,
        budgetTolerance,
        quotingDeadline: deadline,
        failureReason:
          state === "FAILED"
            ? "No eligible supplier matched the listing."
            : null,
      })
      .returning();
    if (!rfq) {
      throw new Error("RFQ insert returned no row.");
    }

    await appendEvent(tx, {
      rfqId: rfq.id,
      actor: BUYER,
      action: "rfq_created",
      audience: "public",
      payload: {
        listing_id: listingId,
        listing_title: listing.title,
        need,
        budget_eur: listing.budget,
        quoting_deadline: deadline.toISOString(),
        candidates: matches.length,
      },
      stateAfter: state,
    });

    for (const match of matches) {
      // Matches without a median award are filtered out in SQL.
      const band = priceBand({
        medianAwardEur: match.median_award_eur ?? 0,
        minAwardEur: match.min_award_eur,
        budgetEur: listing.budget,
        size: match.size,
      });
      const [openDeals] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deals)
        .where(
          and(
            eq(deals.supplierId, match.supplier_id),
            sql`${deals.cpv} like ${`${match.matched_cpv}%`}`
          )
        );
      const openDealsInCpv = openDeals?.count ?? 0;
      await tx.insert(candidates).values({
        rfqId: rfq.id,
        supplierId: match.supplier_id,
        tier: match.tier,
        matchedCpv: match.matched_cpv,
        winsInCpv: match.wins_in_cpv,
        priceLow: band.low,
        priceHigh: band.high,
        priceFloor: band.floor,
        openDealsInCpv,
        status: "invited",
      });
      await appendEvent(tx, {
        rfqId: rfq.id,
        actor: MARKET,
        action: "invited",
        audience: "buyer",
        supplierId: match.supplier_id,
        payload: {
          supplier_name: match.name,
          country: match.country,
          size: match.size,
          tier: match.tier,
          matched_cpv: match.matched_cpv,
          wins_in_cpv: match.wins_in_cpv,
          last_award_date: match.last_award_date,
        },
      });
      await appendEvent(tx, {
        rfqId: rfq.id,
        actor: MARKET,
        action: "price_band",
        audience: "private",
        supplierId: match.supplier_id,
        payload: { ...band, open_deals_in_cpv: openDealsInCpv },
      });
    }

    if (state === "FAILED") {
      await appendEvent(tx, {
        rfqId: rfq.id,
        actor: MARKET,
        action: "failed",
        audience: "public",
        payload: { reason: rfq.failureReason },
        stateAfter: "FAILED",
      });
    }
    return { rfq_id: rfq.id, state, candidates: matches.length };
  });

export const scoreRfq = ({ db }: MarketContext, rfqId: string) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    expectState(rfq, "QUOTING", "NEGOTIATING", "EVALUATING");
    const now = Date.now();
    const pool = await tx
      .select()
      .from(candidates)
      .where(eq(candidates.rfqId, rfqId));

    if (rfq.state === "QUOTING") {
      const waiting = pool.filter((c) => c.status === "invited");
      if (waiting.length > 0 && now < rfq.quotingDeadline.getTime()) {
        throw guardFailed(
          `${waiting.length} invited supplier(s) have not answered and the quoting deadline (${rfq.quotingDeadline.toISOString()}) has not passed.`
        );
      }
      for (const candidate of waiting) {
        const reason = "No answer before the quoting deadline.";
        await setCandidateStatus(tx, candidate, "declined", {
          declineReason: reason,
        });
        await appendEvent(tx, {
          rfqId,
          actor: MARKET,
          action: "declined",
          audience: "buyer",
          supplierId: candidate.supplierId,
          payload: { reason },
        });
      }
    }

    if (rfq.state === "NEGOTIATING") {
      const waiting = pool.filter((c) => c.status === "countered");
      const deadline = rfq.negotiationDeadline?.getTime() ?? now;
      if (waiting.length > 0 && now < deadline) {
        throw guardFailed(
          `${waiting.length} countered supplier(s) have not answered and the negotiation deadline has not passed.`
        );
      }
      // Silence until the deadline means hold: the first quote stands.
      for (const candidate of waiting) {
        await setCandidateStatus(tx, candidate, "final");
        await appendEvent(tx, {
          rfqId,
          actor: MARKET,
          action: "held",
          audience: "buyer",
          supplierId: candidate.supplierId,
          payload: { reason: "No answer before the negotiation deadline." },
        });
      }
    }

    const current = await currentQuotes(tx, rfqId);
    const scored = scoreQuotes(
      current.map((row) => ({
        quoteId: row.quote.id,
        supplierId: row.quote.supplierId,
        priceEur: row.quote.priceEur,
        leadTimeDays: row.quote.leadTimeDays,
        winsInCpv: row.winsInCpv,
      })),
      requiredDeliveryDays(rfq)
    );
    await tx
      .update(quotes)
      .set({ score: null, rank: null })
      .where(eq(quotes.rfqId, rfqId));
    for (const quote of scored) {
      await tx
        .update(quotes)
        .set({ score: quote.score, rank: quote.rank })
        .where(eq(quotes.id, quote.quoteId));
    }

    const names = new Map(
      current.map((row) => [row.quote.supplierId, row.supplierName])
    );
    const table = scored.map((quote) => ({
      rank: quote.rank,
      quote_id: quote.quoteId,
      supplier_id: quote.supplierId,
      supplier_name: names.get(quote.supplierId),
      price_eur: quote.priceEur,
      lead_time_days: quote.leadTimeDays,
      score: quote.score,
      parts: quote.parts,
    }));

    const budgetCap =
      rfq.budgetEur === null ? null : rfq.budgetEur * rfq.budgetTolerance;
    const nothingFits =
      rfq.negotiationUsed &&
      budgetCap !== null &&
      scored.every((quote) => quote.priceEur > budgetCap);
    let next: RfqState = "EVALUATING";
    let failureReason: string | null = null;
    if (scored.length === 0) {
      next = "FAILED";
      failureReason = "No supplier quoted.";
    } else if (nothingFits) {
      next = "FAILED";
      failureReason = "No quote fits the budget tolerance after negotiation.";
    }
    if (next !== rfq.state) {
      await setState(tx, rfq, next, { failureReason });
    }

    await appendEvent(tx, {
      rfqId,
      actor: BUYER,
      action: "scored",
      audience: "buyer",
      payload: {
        required_delivery_days: requiredDeliveryDays(rfq),
        table,
        failure_reason: failureReason,
      },
      stateBefore: rfq.state as RfqState,
      stateAfter: next,
    });
    for (const quote of scored) {
      await appendEvent(tx, {
        rfqId,
        actor: MARKET,
        action: "ranked",
        audience: "private",
        supplierId: quote.supplierId,
        payload: { rank: quote.rank, bidders: scored.length },
      });
    }
    if (next === "FAILED") {
      await appendEvent(tx, {
        rfqId,
        actor: MARKET,
        action: "failed",
        audience: "public",
        payload: { reason: failureReason },
        stateBefore: rfq.state as RfqState,
        stateAfter: "FAILED",
      });
    }
    return { state: next, table, failure_reason: failureReason };
  });

export const counterOffer = (
  { db }: MarketContext,
  {
    rfqId,
    supplierId,
    priceEur,
    leadTimeDays,
    message,
    negotiationDeadline,
  }: {
    rfqId: string;
    supplierId: string;
    priceEur: number;
    leadTimeDays: number;
    message: string;
    negotiationDeadline?: Date;
  }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    const now = Date.now();
    if (rfq.state === "EVALUATING") {
      if (rfq.negotiationUsed) {
        throw guardFailed("The negotiation round has already been used.");
      }
      const current = await currentQuotes(tx, rfqId);
      if (current.length < MIN_QUOTES_TO_NEGOTIATE) {
        throw guardFailed(
          `Negotiation needs at least ${MIN_QUOTES_TO_NEGOTIATE} quotes; there are ${current.length}.`
        );
      }
    } else if (rfq.state === "NEGOTIATING") {
      if (rfq.negotiationDeadline && now >= rfq.negotiationDeadline.getTime()) {
        throw guardFailed("The negotiation deadline has passed.");
      }
    } else {
      throw guardFailed(
        `RFQ is ${rfq.state}; counters are only possible in EVALUATING (once) or NEGOTIATING.`
      );
    }

    const candidate = await getCandidate(tx, rfqId, supplierId);
    if (candidate.status !== "quoted") {
      throw guardFailed(
        `Supplier ${supplierId} is ${candidate.status}; only a supplier that has quoted and not yet been countered can be countered.`
      );
    }
    const [firstQuote] = await tx
      .select()
      .from(quotes)
      .where(
        and(
          eq(quotes.rfqId, rfqId),
          eq(quotes.supplierId, supplierId),
          eq(quotes.final, false)
        )
      );
    if (!firstQuote) {
      throw guardFailed(`Supplier ${supplierId} has no quote to counter.`);
    }
    const min = COUNTER_PRICE_BOUNDS.min * firstQuote.priceEur;
    const max = COUNTER_PRICE_BOUNDS.max * firstQuote.priceEur;
    if (priceEur < min || priceEur > max) {
      throw guardFailed(
        `Counter price must be between ${Math.ceil(min)} and ${Math.floor(max)} EUR (85–100 % of this supplier's quote of ${firstQuote.priceEur} EUR).`
      );
    }

    await setCandidateStatus(tx, candidate, "countered", {
      counterPriceEur: priceEur,
      counterLeadTimeDays: leadTimeDays,
      counterMessage: message,
    });
    let deadline = rfq.negotiationDeadline;
    if (rfq.state === "EVALUATING") {
      deadline =
        negotiationDeadline ??
        secondsFromNow(DEFAULT_NEGOTIATION_WINDOW_SECONDS);
      if (deadline.getTime() <= now) {
        throw new MarketError(
          "INVALID_INPUT",
          "negotiation_deadline must be in the future."
        );
      }
      await setState(tx, rfq, "NEGOTIATING", {
        negotiationUsed: true,
        negotiationDeadline: deadline,
      });
    }
    await appendEvent(tx, {
      rfqId,
      actor: BUYER,
      action: "countered",
      audience: "buyer",
      supplierId,
      payload: {
        price_eur: priceEur,
        lead_time_days: leadTimeDays,
        message,
        your_quote_eur: firstQuote.priceEur,
        your_lead_time_days: firstQuote.leadTimeDays,
        negotiation_deadline: deadline?.toISOString(),
      },
      stateBefore: rfq.state as RfqState,
      stateAfter: "NEGOTIATING",
    });
    return {
      state: "NEGOTIATING" as RfqState,
      supplier_id: supplierId,
      negotiation_deadline: deadline?.toISOString(),
    };
  });

export const awardQuote = (
  { db }: MarketContext,
  {
    rfqId,
    quoteId,
    justification,
  }: { rfqId: string; quoteId: string; justification?: string }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    expectState(rfq, "EVALUATING");
    const [quote] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, quoteId), eq(quotes.rfqId, rfqId)));
    if (!quote) {
      throw notFound(`Quote ${quoteId} is not part of RFQ ${rfqId}.`);
    }
    if (quote.rank === null) {
      throw guardFailed(
        "Only a current, scored quote can be awarded; call score_quotes first."
      );
    }
    const hasJustification = Boolean(justification?.trim());
    if (rfq.budgetEur !== null && quote.priceEur > rfq.budgetEur) {
      const cap = rfq.budgetEur * rfq.budgetTolerance;
      if (quote.priceEur > cap) {
        throw guardFailed(
          `Price ${quote.priceEur} EUR is above the budget tolerance (${Math.round(cap)} EUR).`
        );
      }
      if (!hasJustification) {
        throw guardFailed(
          "Price is above budget (within tolerance): a justification is required."
        );
      }
    }
    if (quote.rank !== 1 && !hasJustification) {
      throw guardFailed(
        `Quote is rank ${quote.rank}: awarding a non rank 1 quote requires a justification.`
      );
    }

    const candidate = await getCandidate(tx, rfqId, quote.supplierId);
    await setCandidateStatus(tx, candidate, "awarded");
    await setState(tx, rfq, "AWARDED", { awardedQuoteId: quote.id });
    await appendEvent(tx, {
      rfqId,
      actor: BUYER,
      action: "awarded",
      audience: "public",
      supplierId: quote.supplierId,
      payload: {
        quote_id: quote.id,
        price_eur: quote.priceEur,
        lead_time_days: quote.leadTimeDays,
        rank: quote.rank,
        score: quote.score,
        justification: justification ?? null,
      },
      stateBefore: "EVALUATING",
      stateAfter: "AWARDED",
    });
    return { state: "AWARDED" as RfqState, quote_id: quote.id };
  });

// --- Supplier actions -----------------------------------------------------------

export const submitQuote = (
  { db }: MarketContext,
  {
    rfqId,
    supplierId,
    priceEur,
    leadTimeDays,
    note,
    final,
  }: {
    rfqId: string;
    supplierId: string;
    priceEur: number;
    leadTimeDays: number;
    note?: string;
    final: boolean;
  }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    const candidate = await getCandidate(tx, rfqId, supplierId);
    const now = Date.now();
    if (final) {
      expectState(rfq, "NEGOTIATING");
      if (candidate.status !== "countered") {
        throw guardFailed(
          `A final quote answers a counter; supplier is ${candidate.status}.`
        );
      }
      if (rfq.negotiationDeadline && now >= rfq.negotiationDeadline.getTime()) {
        throw guardFailed("The negotiation deadline has passed.");
      }
    } else {
      expectState(rfq, "QUOTING");
      if (candidate.status !== "invited") {
        throw guardFailed(
          `Supplier has already answered this RFQ (status ${candidate.status}).`
        );
      }
      if (now >= rfq.quotingDeadline.getTime()) {
        throw guardFailed("The quoting deadline has passed.");
      }
    }
    if (priceEur < candidate.priceFloor) {
      throw guardFailed(
        `Price ${priceEur} EUR is below this supplier's floor (${candidate.priceFloor} EUR).`
      );
    }
    if (final) {
      const [firstQuote] = await tx
        .select()
        .from(quotes)
        .where(
          and(
            eq(quotes.rfqId, rfqId),
            eq(quotes.supplierId, supplierId),
            eq(quotes.final, false)
          )
        );
      if (firstQuote && priceEur > firstQuote.priceEur) {
        throw guardFailed(
          `A final quote cannot exceed the first quote (${firstQuote.priceEur} EUR).`
        );
      }
    }

    const [quote] = await tx
      .insert(quotes)
      .values({
        rfqId,
        supplierId,
        final,
        priceEur,
        leadTimeDays,
        note: note ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!quote) {
      throw guardFailed("This supplier already quoted in this phase.");
    }
    await setCandidateStatus(tx, candidate, final ? "final" : "quoted");
    await appendEvent(tx, {
      rfqId,
      actor: supplierActor(supplierId),
      action: final ? "final_quote" : "quoted",
      audience: "buyer",
      supplierId,
      payload: {
        quote_id: quote.id,
        price_eur: priceEur,
        lead_time_days: leadTimeDays,
        note: note ?? null,
      },
    });
    return { quote_id: quote.id, final };
  });

export const declineRfq = (
  { db }: MarketContext,
  {
    rfqId,
    supplierId,
    reason,
  }: { rfqId: string; supplierId: string; reason: string }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    expectState(rfq, "QUOTING");
    const candidate = await getCandidate(tx, rfqId, supplierId);
    if (candidate.status !== "invited") {
      throw guardFailed(
        `Supplier has already answered this RFQ (status ${candidate.status}).`
      );
    }
    await setCandidateStatus(tx, candidate, "declined", {
      declineReason: reason,
    });
    await appendEvent(tx, {
      rfqId,
      actor: supplierActor(supplierId),
      action: "declined",
      audience: "buyer",
      supplierId,
      payload: { reason },
    });
    return { status: "declined" as CandidateStatus };
  });

const awardee = async (tx: Tx, rfq: RfqRow, supplierId: string) => {
  expectState(rfq, "AWARDED");
  const [quote] = rfq.awardedQuoteId
    ? await tx.select().from(quotes).where(eq(quotes.id, rfq.awardedQuoteId))
    : [];
  if (!quote || quote.supplierId !== supplierId) {
    throw new MarketError(
      "FORBIDDEN",
      "Only the awarded supplier can accept or decline the award."
    );
  }
  return { quote, candidate: await getCandidate(tx, rfq.id, supplierId) };
};

export const acceptAward = (
  { db }: MarketContext,
  {
    rfqId,
    supplierId,
    contractSummary,
  }: { rfqId: string; supplierId: string; contractSummary?: string }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    const { quote, candidate } = await awardee(tx, rfq, supplierId);
    const [listing] = await tx
      .select({ mainCpv: listings.mainCpv, title: listings.title })
      .from(listings)
      .where(eq(listings.id, rfq.listingId));
    const [supplier] = await tx
      .select({ name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId));
    const [buyer] = rfq.buyerId
      ? await tx
          .select({ name: buyers.name })
          .from(buyers)
          .where(eq(buyers.id, rfq.buyerId))
      : [];
    const need = rfq.need as Need;
    const summary =
      contractSummary?.trim() ||
      `${supplier?.name ?? supplierId} supplies ${need.summary_en} to ${buyer?.name ?? "the buyer"} for ${quote.priceEur.toLocaleString("en-GB")} EUR, delivery within ${quote.leadTimeDays} days of award (notice: ${listing?.title ?? rfq.listingId}).`;
    const [deal] = await tx
      .insert(deals)
      .values({
        rfqId,
        quoteId: quote.id,
        buyerId: rfq.buyerId,
        supplierId,
        cpv: listing?.mainCpv ?? null,
        priceEur: quote.priceEur,
        leadTimeDays: quote.leadTimeDays,
        contractSummary: summary,
      })
      .returning();
    await setCandidateStatus(tx, candidate, "accepted");
    await setState(tx, rfq, "CLOSED");
    await appendEvent(tx, {
      rfqId,
      actor: supplierActor(supplierId),
      action: "deal_closed",
      audience: "public",
      supplierId,
      payload: {
        deal_id: deal?.id,
        price_eur: quote.priceEur,
        lead_time_days: quote.leadTimeDays,
        contract_summary: summary,
      },
      stateBefore: "AWARDED",
      stateAfter: "CLOSED",
    });
    return {
      state: "CLOSED" as RfqState,
      deal_id: deal?.id,
      contract_summary: summary,
    };
  });

export const declineAward = (
  { db }: MarketContext,
  {
    rfqId,
    supplierId,
    reason,
  }: { rfqId: string; supplierId: string; reason: string }
) =>
  db.transaction(async (tx) => {
    const rfq = await lockRfq(tx, rfqId);
    const { candidate } = await awardee(tx, rfq, supplierId);
    await setCandidateStatus(tx, candidate, "declined_award", {
      declineReason: reason,
    });
    await setState(tx, rfq, "FAILED", {
      failureReason: `Awarded supplier declined: ${reason}`,
    });
    await appendEvent(tx, {
      rfqId,
      actor: supplierActor(supplierId),
      action: "award_declined",
      audience: "public",
      supplierId,
      payload: { reason },
      stateBefore: "AWARDED",
      stateAfter: "FAILED",
    });
    return { state: "FAILED" as RfqState };
  });

const quoteView = (quote: typeof quotes.$inferSelect) => ({
  quote_id: quote.id,
  supplier_id: quote.supplierId,
  final: quote.final,
  price_eur: quote.priceEur,
  lead_time_days: quote.leadTimeDays,
  note: quote.note,
  score: quote.score,
  rank: quote.rank,
  current: quote.rank !== null,
});

// --- Read with visibility -----------------------------------------------------------

export const getRfqView = async (
  { db }: MarketContext,
  { rfqId, viewer }: { rfqId: string; viewer: Viewer }
) => {
  const [row] = await db
    .select({
      rfq: rfqs,
      listingTitle: listings.title,
      listingUrl: listings.url,
      mainCpv: listings.mainCpv,
      listingDeadline: listings.deadline,
      buyerName: buyers.name,
      buyerCountry: buyers.country,
    })
    .from(rfqs)
    .innerJoin(listings, eq(listings.id, rfqs.listingId))
    .leftJoin(buyers, eq(buyers.id, rfqs.buyerId))
    .where(eq(rfqs.id, rfqId));
  if (!row) {
    throw notFound(`RFQ ${rfqId} does not exist.`);
  }
  const { rfq } = row;
  const base = {
    rfq_id: rfq.id,
    state: rfq.state,
    listing: {
      id: rfq.listingId,
      title: row.listingTitle,
      url: row.listingUrl,
      main_cpv: row.mainCpv,
      deadline: row.listingDeadline,
      buyer: row.buyerName,
      buyer_country: row.buyerCountry,
    },
    need: rfq.need as Need,
    quoting_deadline: rfq.quotingDeadline.toISOString(),
    negotiation_deadline: rfq.negotiationDeadline?.toISOString() ?? null,
    negotiation_used: rfq.negotiationUsed,
    failure_reason: rfq.failureReason,
    now: new Date().toISOString(),
  };

  const pool = await db
    .select({ candidate: candidates, supplier: suppliers })
    .from(candidates)
    .innerJoin(suppliers, eq(suppliers.id, candidates.supplierId))
    .where(eq(candidates.rfqId, rfqId))
    .orderBy(asc(candidates.tier), asc(candidates.supplierId));
  const allQuotes = await db
    .select()
    .from(quotes)
    .where(eq(quotes.rfqId, rfqId))
    .orderBy(asc(quotes.createdAt));
  const [deal] = await db.select().from(deals).where(eq(deals.rfqId, rfqId));

  const dealView = deal
    ? {
        deal_id: deal.id,
        supplier_id: deal.supplierId,
        price_eur: deal.priceEur,
        lead_time_days: deal.leadTimeDays,
        contract_summary: deal.contractSummary,
        closed_at: deal.closedAt.toISOString(),
      }
    : null;
  const candidateView = (entry: (typeof pool)[number], withBand: boolean) => ({
    supplier_id: entry.candidate.supplierId,
    name: entry.supplier.name,
    country: entry.supplier.country,
    size: entry.supplier.size,
    tier: entry.candidate.tier,
    matched_cpv: entry.candidate.matchedCpv,
    wins_in_cpv: entry.candidate.winsInCpv,
    status: entry.candidate.status,
    decline_reason: entry.candidate.declineReason,
    counter:
      entry.candidate.counterPriceEur === null
        ? null
        : {
            price_eur: entry.candidate.counterPriceEur,
            lead_time_days: entry.candidate.counterLeadTimeDays,
            message: entry.candidate.counterMessage,
          },
    ...(withBand
      ? {
          price_band: {
            low: entry.candidate.priceLow,
            high: entry.candidate.priceHigh,
            floor: entry.candidate.priceFloor,
          },
          open_deals_in_cpv: entry.candidate.openDealsInCpv,
        }
      : {}),
  });

  if (viewer.role === "supplier") {
    const mine = pool.find(
      (entry) => entry.candidate.supplierId === viewer.supplierId
    );
    if (!mine) {
      throw new MarketError(
        "FORBIDDEN",
        `Supplier ${viewer.supplierId} is not invited to RFQ ${rfqId}.`
      );
    }
    const myQuotes = allQuotes.filter(
      (quote) => quote.supplierId === viewer.supplierId
    );
    const bidders = allQuotes.filter((quote) => quote.rank !== null).length;
    const isAwardee =
      deal?.supplierId === viewer.supplierId ||
      allQuotes.some(
        (quote) =>
          quote.id === rfq.awardedQuoteId &&
          quote.supplierId === viewer.supplierId
      );
    return {
      ...base,
      you: candidateView(mine, true),
      your_quotes: myQuotes.map(quoteView),
      your_rank: myQuotes.find((quote) => quote.rank !== null)?.rank ?? null,
      bidders,
      awarded_to_you: isAwardee,
      deal: isAwardee ? dealView : null,
    };
  }

  const withBand = viewer.role === "observer";
  return {
    ...base,
    budget_eur: rfq.budgetEur,
    budget_tolerance: rfq.budgetTolerance,
    awarded_quote_id: rfq.awardedQuoteId,
    candidates: pool.map((entry) => candidateView(entry, withBand)),
    quotes: allQuotes.map(quoteView),
    deal: dealView,
  };
};

export const rfqState = async (executor: Executor, rfqId: string) => {
  const [row] = await executor
    .select({
      state: rfqs.state,
      quotingDeadline: rfqs.quotingDeadline,
      negotiationDeadline: rfqs.negotiationDeadline,
    })
    .from(rfqs)
    .where(eq(rfqs.id, rfqId));
  return row;
};
