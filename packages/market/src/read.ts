import {
  awards,
  buyers,
  deals,
  listings,
  supplierStats,
  suppliers,
} from "@rocket/db/schema/market";
import { desc, eq, sql } from "drizzle-orm";

import { DEFENCE_DIVISION } from "./constants";
import type { MarketContext } from "./context";
import { notFound } from "./errors";

const PAST_AWARDS_LIMIT = 15;
const DAY_MS = 86_400_000;

const ELIGIBILITY_TEXT: Record<string, string> = {
  any: "Any supplier may bid.",
  eu: "EU/EEA suppliers only (defence directive).",
  nato: "NATO-country suppliers only.",
};

export const getListing = async ({ db }: MarketContext, listingId: string) => {
  const [row] = await db
    .select({ listing: listings, buyer: buyers })
    .from(listings)
    .leftJoin(buyers, eq(buyers.id, listings.buyerId))
    .where(eq(listings.id, listingId));
  if (!row) {
    throw notFound(`Listing ${listingId} does not exist.`);
  }
  const { listing, buyer } = row;
  const deadline = listing.deadline
    ? new Date(`${listing.deadline}T23:59:59Z`)
    : null;
  return {
    listing_id: listing.id,
    source_system: listing.sourceSystem,
    external_id: listing.externalId,
    url: listing.url,
    title: listing.title,
    description: listing.description,
    language: listing.language,
    procedure: listing.procedure,
    segment: listing.segment,
    main_cpv: listing.mainCpv,
    cpv_codes: listing.cpvCodes,
    deadline: listing.deadline,
    estimated_value_eur: listing.estimatedValueEur,
    eligibility: listing.eligibility,
    fetched_at: listing.fetchedAt.toISOString(),
    buyer: buyer
      ? {
          id: buyer.id,
          name: buyer.name,
          country: buyer.country,
          city: buyer.city,
        }
      : null,
    derived: {
      is_open: deadline !== null && deadline.getTime() >= Date.now(),
      days_to_deadline:
        deadline === null
          ? null
          : Math.ceil((deadline.getTime() - Date.now()) / DAY_MS),
      cpv_class: listing.mainCpv?.slice(0, 3) ?? null,
      cpv_division: listing.mainCpv?.slice(0, 2) ?? null,
      defence_related: listing.mainCpv?.startsWith(DEFENCE_DIVISION) ?? false,
      eligibility_rule:
        ELIGIBILITY_TEXT[listing.eligibility] ?? listing.eligibility,
    },
  };
};

export const getSupplier = async (
  { db }: MarketContext,
  supplierId: string
) => {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId));
  if (!supplier) {
    throw notFound(`Supplier ${supplierId} does not exist.`);
  }
  const [stats] = await db
    .select()
    .from(supplierStats)
    .where(eq(supplierStats.supplierId, supplierId));
  const pastAwards = await db
    .select({
      external_id: awards.externalId,
      cpv: awards.cpv,
      title: awards.title,
      value_eur: awards.valueEur,
      award_date: awards.awardDate,
      tenders_received: awards.tendersReceived,
      buyer: buyers.name,
      buyer_country: buyers.country,
    })
    .from(awards)
    .leftJoin(buyers, eq(buyers.id, awards.buyerId))
    .where(eq(awards.supplierId, supplierId))
    .orderBy(desc(awards.awardDate))
    .limit(PAST_AWARDS_LIMIT);
  const [buyerCountries] = await db
    .select({
      countries: sql<
        string[]
      >`coalesce(array_agg(distinct ${buyers.country}), '{}')`,
    })
    .from(awards)
    .innerJoin(buyers, eq(buyers.id, awards.buyerId))
    .where(eq(awards.supplierId, supplierId));
  const [openDeals] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deals)
    .where(eq(deals.supplierId, supplierId));
  return {
    supplier_id: supplier.id,
    name: supplier.name,
    country: supplier.country,
    city: supplier.city,
    size: supplier.size,
    stats: stats
      ? {
          win_count: stats.winCount,
          median_award_eur: stats.medianValueEur,
          min_award_eur: stats.minValueEur,
          last_award_date: stats.lastAwardDate,
          cpv_classes: stats.cpvClasses,
        }
      : null,
    buyer_countries: buyerCountries?.countries ?? [],
    deals_in_this_market: openDeals?.count ?? 0,
    past_awards: pastAwards,
  };
};
