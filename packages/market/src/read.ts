// Read tools (plan.md §4.1, §4.6). Public records are open to everyone;
// sealed limits (walk-away, floors) are only ever selected for observers,
// except a signed-in user's own limit settings, which they chose.
import {
  awards,
  buyers,
  demands,
  listings,
  matches,
  offers,
  proposals,
  supplierOfferBasis,
  suppliers,
} from "@rocket/db/schema/market";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  like,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { MAX_PROPOSALS_PER_SIDE } from "./constants";
import type { Side } from "./constants";
import type { Actor, MarketContext } from "./context";
import { actsAs } from "./context";
import { notFound } from "./errors";
import { presentLimits, traderLimits } from "./traders";

const awardColumns = {
  external_id: awards.externalId,
  url: awards.url,
  buyer_id: awards.buyerId,
  buyer_name: awards.buyerName,
  buyer_country: awards.buyerCountry,
  supplier_id: awards.supplierId,
  supplier_name: awards.supplierName,
  supplier_country: awards.supplierCountry,
  cpv: awards.cpv,
  value_eur: awards.valueEur,
  tenders_received: awards.tendersReceived,
  award_date: awards.awardDate,
  title: awards.title,
};

const listingColumns = {
  listing_id: listings.id,
  url: listings.url,
  buyer_id: listings.buyerId,
  buyer_name: buyers.name,
  buyer_country: buyers.country,
  main_cpv: listings.mainCpv,
  cpv_codes: listings.cpvCodes,
  title: listings.title,
  title_en: listings.titleEn,
  need: listings.need,
  language: listings.language,
  procedure: listings.procedure,
  deadline: listings.deadline,
  estimated_value_eur: listings.estimatedValueEur,
  n_lots: listings.nLots,
  framework: listings.framework,
  defence_directive: listings.defenceDirective,
  eligibility: listings.eligibility,
  fetched_at: listings.fetchedAt,
};

const isOpenListing = gte(listings.deadline, sql`current_date`);

// Public per-class basis: what the supplier has won, never its floor.
const publicBasis = (db: MarketContext["db"], supplierIds: string[]) =>
  supplierIds.length === 0
    ? Promise.resolve([])
    : db
        .select({
          supplier_id: supplierOfferBasis.supplierId,
          cpv_class: supplierOfferBasis.cpvClass,
          cpv_codes: supplierOfferBasis.cpvCodes,
          wins: supplierOfferBasis.wins,
          median_value_eur: supplierOfferBasis.medianValueEur,
          min_value_eur: supplierOfferBasis.minValueEur,
          last_award_date: supplierOfferBasis.lastAwardDate,
          example_title: supplierOfferBasis.exampleTitle,
        })
        .from(supplierOfferBasis)
        .where(inArray(supplierOfferBasis.supplierId, supplierIds))
        .orderBy(desc(supplierOfferBasis.wins));

export const searchListings = (
  { db }: MarketContext,
  {
    cpvPrefix,
    country,
    text,
    limit,
  }: { cpvPrefix?: string; country?: string; text?: string; limit: number }
) =>
  db
    .select(listingColumns)
    .from(listings)
    .innerJoin(buyers, eq(buyers.id, listings.buyerId))
    .where(
      and(
        isOpenListing,
        cpvPrefix ? like(listings.mainCpv, `${cpvPrefix}%`) : undefined,
        country ? eq(buyers.country, country.toUpperCase()) : undefined,
        text
          ? or(
              ilike(listings.title, `%${text}%`),
              ilike(listings.titleEn, `%${text}%`),
              ilike(listings.need, `%${text}%`)
            )
          : undefined
      )
    )
    .orderBy(asc(listings.deadline))
    .limit(limit);

export const searchSuppliers = async (
  { db }: MarketContext,
  {
    cpvPrefix,
    country,
    limit,
  }: { cpvPrefix?: string; country?: string; limit: number }
) => {
  const rows = await db
    .select({
      supplier_id: suppliers.id,
      name: suppliers.name,
      country: suppliers.country,
      city: suppliers.city,
      size: suppliers.size,
      stats: suppliers.stats,
      wins_in_prefix: sql<number>`coalesce(sum(${supplierOfferBasis.wins}), 0)::int`,
    })
    .from(suppliers)
    .leftJoin(
      supplierOfferBasis,
      eq(supplierOfferBasis.supplierId, suppliers.id)
    )
    .where(
      and(
        cpvPrefix
          ? like(supplierOfferBasis.cpvClass, `${cpvPrefix.slice(0, 3)}%`)
          : undefined,
        country ? eq(suppliers.country, country.toUpperCase()) : undefined
      )
    )
    .groupBy(suppliers.id)
    .orderBy(
      desc(sql`coalesce(sum(${supplierOfferBasis.wins}), 0)`),
      asc(suppliers.id)
    )
    .limit(limit);
  const basis = await publicBasis(
    db,
    rows.map((row) => row.supplier_id)
  );
  return rows.map((row) => ({
    ...row,
    classes: basis.filter((entry) => entry.supplier_id === row.supplier_id),
  }));
};

// A trader's id is in both tables, so its history covers both sides.
export const history = async ({ db }: MarketContext, entityId: string) => {
  const [buyer] = await db
    .select({ id: buyers.id, name: buyers.name })
    .from(buyers)
    .where(eq(buyers.id, entityId));
  const [supplier] = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, entityId));
  if (!(buyer || supplier)) {
    throw notFound(`No buyer or supplier with id ${entityId}.`);
  }
  const rows = await db
    .select(awardColumns)
    .from(awards)
    .where(
      or(
        buyer ? eq(awards.buyerId, entityId) : undefined,
        supplier ? eq(awards.supplierId, entityId) : undefined
      )
    )
    .orderBy(desc(awards.awardDate));
  let kind = "supplier";
  if (buyer && supplier) {
    kind = "buyer and supplier";
  } else if (buyer) {
    kind = "buyer";
  }
  return {
    entity_id: entityId,
    kind,
    name: (buyer ?? supplier)?.name,
    awards: rows,
  };
};

// --- The actor's own market ---------------------------------------------------------

const threadDetails = async (
  db: MarketContext["db"],
  matchIds: string[],
  withSealed: boolean
) => {
  if (matchIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      match: matches,
      demand: demands,
      offer: offers,
      supplierName: suppliers.name,
      supplierCountry: suppliers.country,
      supplierSize: suppliers.size,
      buyerName: buyers.name,
      buyerCountry: buyers.country,
      listingTitle: listings.title,
      listingTitleEn: listings.titleEn,
      listingUrl: listings.url,
      deadline: listings.deadline,
    })
    .from(matches)
    .innerJoin(demands, eq(demands.id, matches.demandId))
    .innerJoin(offers, eq(offers.id, matches.offerId))
    .innerJoin(suppliers, eq(suppliers.id, offers.supplierId))
    .innerJoin(buyers, eq(buyers.id, demands.buyerId))
    .innerJoin(listings, eq(listings.id, demands.listingId))
    .where(inArray(matches.id, matchIds))
    .orderBy(asc(matches.createdAt));
  const moves = await db
    .select()
    .from(proposals)
    .where(inArray(proposals.matchId, matchIds))
    .orderBy(asc(proposals.id));
  return rows.map((row) => {
    const thread = moves.filter((move) => move.matchId === row.match.id);
    const left = (side: string) =>
      MAX_PROPOSALS_PER_SIDE - thread.filter((move) => move.by === side).length;
    return {
      match_id: row.match.id,
      state: row.match.state,
      turn: row.match.state === "open" ? row.match.turn : null,
      tier: row.match.tier,
      demand: {
        demand_id: row.demand.id,
        listing_id: row.demand.listingId,
        title: row.listingTitle,
        title_en: row.listingTitleEn,
        url: row.listingUrl,
        need: row.demand.need,
        cpv: row.demand.cpv,
        estimated_value_eur: row.demand.estimatedValueEur,
        deadline: row.deadline,
        buyer_id: row.demand.buyerId,
        buyer_name: row.buyerName,
        buyer_country: row.buyerCountry,
      },
      offer: {
        offer_id: row.offer.id,
        supplier_id: row.offer.supplierId,
        supplier_name: row.supplierName,
        supplier_country: row.supplierCountry,
        supplier_size: row.supplierSize,
        cpv_class: row.offer.cpvClass,
        ask_eur: row.offer.askEur,
        lead_time_days: row.offer.leadTimeDays,
        note: row.offer.note,
      },
      proposals: thread.map((move, index) => ({
        move: index + 1,
        by: move.by,
        price_eur: move.priceEur,
        lead_time_days: move.leadTimeDays,
        message: move.message,
        cites: move.cites,
        at: move.createdAt.toISOString(),
      })),
      proposals_left: { buyer: left("buyer"), supplier: left("supplier") },
      agreed:
        row.match.state === "agreed"
          ? {
              price_eur: row.match.agreedPriceEur,
              lead_time_days: row.match.agreedLeadTimeDays,
              at: row.match.closedAt?.toISOString(),
            }
          : null,
      closed_reason: row.match.closedReason,
      ...(withSealed
        ? {
            sealed: {
              thread_floor_eur: row.match.floorEur,
              walk_away_eur: row.demand.walkAwayEur,
              offer_floor_eur: row.offer.floorEur,
            },
          }
        : {}),
    };
  });
};

const presentDemand = (
  demand: typeof demands.$inferSelect,
  withSealed: boolean
) => ({
  demand_id: demand.id,
  listing_id: demand.listingId,
  buyer_id: demand.buyerId,
  cpv: demand.cpv,
  need: demand.need,
  estimated_value_eur: demand.estimatedValueEur,
  state: demand.state,
  created_at: demand.createdAt.toISOString(),
  ...(withSealed ? { walk_away_eur: demand.walkAwayEur } : {}),
});

const presentOffer = (
  offer: typeof offers.$inferSelect,
  withSealed: boolean
) => ({
  offer_id: offer.id,
  supplier_id: offer.supplierId,
  cpv_class: offer.cpvClass,
  cpv_codes: offer.cpvCodes,
  ask_eur: offer.askEur,
  lead_time_days: offer.leadTimeDays,
  note: offer.note,
  state: offer.state,
  created_at: offer.createdAt.toISOString(),
  ...(withSealed ? { floor_eur: offer.floorEur } : {}),
});

// Observers see every row; a party only rows on the sides it acts on.
const scoped = (actor: Actor, side: Side, condition: SQL) => {
  if (actor.kind === "observer") {
    return;
  }
  return actsAs(actor, side) ? condition : sql`false`;
};

// The side the actor holds in a thread; a trader can hold either.
const sideIn = (
  actor: Actor,
  thread: { demand: { buyer_id: string }; offer: { supplier_id: string } }
): Side | null => {
  if (actsAs(actor, "buyer") && thread.demand.buyer_id === actor.entityId) {
    return "buyer";
  }
  if (
    actsAs(actor, "supplier") &&
    thread.offer.supplier_id === actor.entityId
  ) {
    return "supplier";
  }
  return null;
};

export const myMarket = async ({ db }: MarketContext, actor: Actor) => {
  const observer = actor.kind === "observer";
  const myDemands = await db
    .select()
    .from(demands)
    .where(scoped(actor, "buyer", eq(demands.buyerId, actor.entityId ?? "")))
    .orderBy(asc(demands.createdAt));
  const myOffers = await db
    .select()
    .from(offers)
    .where(
      scoped(actor, "supplier", eq(offers.supplierId, actor.entityId ?? ""))
    )
    .orderBy(asc(offers.createdAt));
  const matchRows = await db
    .select({ id: matches.id })
    .from(matches)
    .innerJoin(demands, eq(demands.id, matches.demandId))
    .innerJoin(offers, eq(offers.id, matches.offerId))
    .where(
      or(
        scoped(actor, "buyer", eq(demands.buyerId, actor.entityId ?? "")),
        scoped(actor, "supplier", eq(offers.supplierId, actor.entityId ?? ""))
      )
    );
  const details = await threadDetails(
    db,
    matchRows.map((row) => row.id),
    observer
  );
  const threads = observer
    ? details
    : details.map((thread) => ({ ...thread, you_are: sideIn(actor, thread) }));
  return {
    you: { kind: actor.kind, id: actor.entityId, name: actor.name },
    demands: myDemands.map((demand) => presentDemand(demand, observer)),
    offers: myOffers.map((offer) => presentOffer(offer, observer)),
    threads,
    your_turn_in: threads
      .filter(
        (thread) =>
          thread.state === "open" && thread.turn === sideIn(actor, thread)
      )
      .map((thread) => thread.match_id),
  };
};

const listingsOf = (db: MarketContext["db"], buyerId: string) =>
  db
    .select(listingColumns)
    .from(listings)
    .innerJoin(buyers, eq(buyers.id, listings.buyerId))
    .where(eq(listings.buyerId, buyerId))
    .orderBy(asc(listings.deadline));

const awardsAs = (db: MarketContext["db"], side: Side, entityId: string) =>
  db
    .select(awardColumns)
    .from(awards)
    .where(
      side === "buyer"
        ? eq(awards.buyerId, entityId)
        : eq(awards.supplierId, entityId)
    )
    .orderBy(desc(awards.awardDate));

const LIMITS_NOTE =
  "Sealed: no counterparty ever sees them. As a buyer you never pay more than walk_away_pct of a demand's estimated value; as a seller you never go below floor_pct of your ask. Change them with set_limits.";

// A signed-in user: one company that buys and sells, under limits they set.
const traderRecord = async (ctx: MarketContext, actor: Actor) => {
  const { db } = ctx;
  const limits = await traderLimits(db, actor);
  const yourLimits = limits
    ? { ...presentLimits(limits), note: LIMITS_NOTE }
    : null;
  if (!actor.entityId) {
    return {
      kind: actor.kind,
      name: actor.name,
      company: null,
      your_limits: yourLimits,
      next_step:
        "Call set_company with your country and either your VAT or company number (to trade as your public record) or your company's name. Then you can post demands and offers.",
    };
  }
  const [company] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, actor.entityId));
  const market = await myMarket(ctx, actor);
  return {
    kind: actor.kind,
    id: actor.entityId,
    name: company?.name ?? actor.name,
    country: company?.country,
    you_can:
      "Buy (post_demand) and sell (post_offer) as this one company. Each thread says which side you are on (you_are).",
    your_limits: yourLimits,
    your_listings: await listingsOf(db, actor.entityId),
    classes_you_have_won_in: await publicBasis(db, [actor.entityId]),
    your_award_history: {
      as_buyer: await awardsAs(db, "buyer", actor.entityId),
      as_supplier: await awardsAs(db, "supplier", actor.entityId),
    },
    open_demands: market.demands.filter((demand) => demand.state === "open"),
    open_offers: market.offers.filter((offer) => offer.state === "open"),
    open_threads: market.threads.filter((thread) => thread.state === "open")
      .length,
    agreed_threads: market.threads.filter((thread) => thread.state === "agreed")
      .length,
    your_turn_in: market.your_turn_in,
  };
};

export const whoami = async (ctx: MarketContext, actor: Actor) => {
  const { db } = ctx;
  if (actor.kind === "trader") {
    return traderRecord(ctx, actor);
  }
  if (actor.kind === "observer" || !actor.entityId) {
    return {
      kind: actor.kind,
      name: actor.name,
      note: "Observers can read the whole market but cannot post or negotiate.",
    };
  }
  const market = await myMarket(ctx, actor);
  const openThreads = market.threads.filter(
    (thread) => thread.state === "open"
  );
  const agreed = market.threads.filter((thread) => thread.state === "agreed");
  if (actor.kind === "buyer") {
    const [buyer] = await db
      .select()
      .from(buyers)
      .where(eq(buyers.id, actor.entityId));
    if (!buyer) {
      throw notFound(`Buyer ${actor.entityId} does not exist.`);
    }
    const yourListings = await listingsOf(db, buyer.id);
    const yourAwards = await awardsAs(db, "buyer", buyer.id);
    return {
      kind: "buyer",
      id: buyer.id,
      name: buyer.name,
      country: buyer.country,
      city: buyer.city,
      legal_type: buyer.legalType,
      stats: buyer.stats,
      your_listings: yourListings,
      your_award_history: yourAwards,
      open_demands: market.demands.filter((demand) => demand.state === "open"),
      open_threads: openThreads.length,
      agreed_threads: agreed.length,
      your_turn_in: market.your_turn_in,
    };
  }
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, actor.entityId));
  if (!supplier) {
    throw notFound(`Supplier ${actor.entityId} does not exist.`);
  }
  const yourAwards = await awardsAs(db, "supplier", supplier.id);
  return {
    kind: "supplier",
    id: supplier.id,
    name: supplier.name,
    country: supplier.country,
    city: supplier.city,
    size: supplier.size,
    stats: supplier.stats,
    classes_you_can_offer_in: await publicBasis(db, [supplier.id]),
    your_award_history: yourAwards,
    open_offers: market.offers.filter((offer) => offer.state === "open"),
    open_threads: openThreads.length,
    agreed_threads: agreed.length,
    your_turn_in: market.your_turn_in,
  };
};
