// The marketplace (plan.md §2): real TED demand and supply, plus the market
// state agents act on. Raw tables mirror data_discovery/data/processed/market.db
// and are only written by the loader (packages/db/scripts/load-market.ts);
// entity tables and the `supplier_stats` view are built from them with SQL.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// --- Raw TED data (verbatim from market.db) ---------------------------------

export const rawTedTenders = pgTable("raw_ted_tenders", {
  id: text("id").primaryKey(),
  source: text("source"),
  url: text("url"),
  title: text("title"),
  description: text("description"),
  language: text("language"),
  buyerName: text("buyer_name"),
  buyerCountry: text("buyer_country"),
  cpv: text("cpv"),
  cpvAll: text("cpv_all"),
  segment: text("segment"),
  procedure: text("procedure"),
  valueEur: doublePrecision("value_eur"),
  published: text("published"),
  deadline: text("deadline"),
  deadlineKind: text("deadline_kind"),
});

export const rawTedAwards = pgTable("raw_ted_awards", {
  id: serial("id").primaryKey(),
  noticeId: text("notice_id"),
  supplierId: text("supplier_id"),
  buyerName: text("buyer_name"),
  buyerCountry: text("buyer_country"),
  cpv: text("cpv"),
  segment: text("segment"),
  valueEur: doublePrecision("value_eur"),
  nBids: integer("n_bids"),
  date: text("date"),
  title: text("title"),
});

export const rawTedSuppliers = pgTable("raw_ted_suppliers", {
  id: text("id").primaryKey(),
  name: text("name"),
  country: text("country"),
  city: text("city"),
  size: text("size"),
  nAwards: integer("n_awards"),
  totalValueEur: doublePrecision("total_value_eur"),
  topCpvs: text("top_cpvs"),
  firstAward: text("first_award"),
  lastAward: text("last_award"),
});

// --- Entity tables (built from the raw tables) ------------------------------

export const buyers = pgTable(
  "buyers",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    city: text("city"),
    legalType: text("legal_type"),
  },
  (table) => [
    uniqueIndex("buyers_name_country_uidx").on(table.name, table.country),
  ]
);

export const suppliers = pgTable(
  "suppliers",
  {
    // market.db key: '<ISO3>:<registry id>' or '<ISO3>:name:<name>'.
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    city: text("city"),
    vatId: text("vat_id"),
    size: text("size"),
  },
  (table) => [index("suppliers_country_idx").on(table.country)]
);

export const identifiers = pgTable(
  "identifiers",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    system: text("system").notNull(),
    externalId: text("external_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId, table.system] }),
  ]
);

export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    buyerId: integer("buyer_id").references(() => buyers.id),
    mainCpv: text("main_cpv"),
    cpvCodes: text("cpv_codes").array(),
    title: text("title"),
    description: text("description"),
    language: text("language"),
    procedure: text("procedure"),
    segment: text("segment"),
    deadline: date("deadline", { mode: "string" }),
    estimatedValueEur: doublePrecision("estimated_value_eur"),
    nLots: integer("n_lots"),
    framework: boolean("framework"),
    securityClearance: boolean("security_clearance"),
    // eu | nato | any — who may bid (see packages/market eligibility rules).
    eligibility: text("eligibility").notNull().default("any"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("listings_main_cpv_idx").on(table.mainCpv),
    index("listings_deadline_idx").on(table.deadline),
  ]
);

export const awards = pgTable(
  "awards",
  {
    id: serial("id").primaryKey(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    buyerId: integer("buyer_id").references(() => buyers.id),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    cpv: text("cpv").notNull(),
    title: text("title"),
    valueEur: doublePrecision("value_eur"),
    awardDate: date("award_date", { mode: "string" }),
    tendersReceived: integer("tenders_received"),
  },
  (table) => [
    index("awards_supplier_idx").on(table.supplierId),
    index("awards_cpv_idx").on(table.cpv),
  ]
);

// Created by the loader; counts and medians are never stored on `suppliers`.
export const supplierStats = pgView("supplier_stats", {
  supplierId: text("supplier_id").notNull(),
  winCount: integer("win_count").notNull(),
  medianValueEur: doublePrecision("median_value_eur"),
  minValueEur: doublePrecision("min_value_eur"),
  lastAwardDate: date("last_award_date", { mode: "string" }),
  cpvClasses: text("cpv_classes").array(),
}).existing();

// --- Market state -------------------------------------------------------------

export const rfqs = pgTable(
  "rfqs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id),
    buyerId: integer("buyer_id").references(() => buyers.id),
    // QUOTING | EVALUATING | NEGOTIATING | AWARDED | CLOSED | FAILED
    state: text("state").notNull(),
    need: jsonb("need").notNull(),
    budgetEur: doublePrecision("budget_eur"),
    budgetTolerance: doublePrecision("budget_tolerance").notNull().default(1.1),
    quotingDeadline: timestamp("quoting_deadline", {
      withTimezone: true,
    }).notNull(),
    negotiationDeadline: timestamp("negotiation_deadline", {
      withTimezone: true,
    }),
    negotiationUsed: boolean("negotiation_used").notNull().default(false),
    awardedQuoteId: text("awarded_quote_id"),
    failureReason: text("failure_reason"),
    running: boolean("running").notNull().default(false),
    runningSince: timestamp("running_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("rfqs_listing_idx").on(table.listingId)]
);

export const candidates = pgTable(
  "candidates",
  {
    rfqId: text("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    tier: integer("tier").notNull(),
    // CPV prefix the supplier matched on (3-digit class, 2-digit division or "35").
    matchedCpv: text("matched_cpv").notNull(),
    winsInCpv: integer("wins_in_cpv").notNull(),
    priceLow: doublePrecision("price_low").notNull(),
    priceHigh: doublePrecision("price_high").notNull(),
    priceFloor: doublePrecision("price_floor").notNull(),
    openDealsInCpv: integer("open_deals_in_cpv").notNull(),
    counterPriceEur: doublePrecision("counter_price_eur"),
    counterLeadTimeDays: integer("counter_lead_time_days"),
    counterMessage: text("counter_message"),
    declineReason: text("decline_reason"),
    // invited | quoted | declined | countered | final | awarded | accepted | declined_award
    status: text("status").notNull(),
  },
  (table) => [primaryKey({ columns: [table.rfqId, table.supplierId] })]
);

export const quotes = pgTable(
  "quotes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    final: boolean("final").notNull(),
    priceEur: doublePrecision("price_eur").notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    note: text("note"),
    score: doublePrecision("score"),
    rank: integer("rank"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // One quote per supplier per phase: a resumed run can't double quote.
  (table) => [
    uniqueIndex("quotes_rfq_supplier_phase_uidx").on(
      table.rfqId,
      table.supplierId,
      table.final
    ),
  ]
);

export const deals = pgTable(
  "deals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    buyerId: integer("buyer_id").references(() => buyers.id),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    cpv: text("cpv"),
    priceEur: doublePrecision("price_eur").notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    contractSummary: text("contract_summary").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("deals_rfq_uidx").on(table.rfqId),
    index("deals_supplier_idx").on(table.supplierId),
  ]
);

// Append only. The UI, MCP clients and resumed runs read it by cursor (`id`).
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    rfqId: text("rfq_id").references(() => rfqs.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    // public: everyone · buyer: buyer + observers · private: the supplier + observers.
    // Rows about one supplier carry its id, and that supplier always sees them.
    audience: text("audience").notNull(),
    supplierId: text("supplier_id"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    stateBefore: text("state_before"),
    stateAfter: text("state_after"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("events_rfq_idx").on(table.rfqId, table.id)]
);
