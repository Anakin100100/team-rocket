// The marketplace (plan.md §2.3). Data side: loaded from
// data_discovery/data/processed/demo_seed.json by the loader
// (packages/db/scripts/load-market.ts). Market side: written only through the
// tools in packages/market. Columns marked "sealed" are never returned to a
// party, only to observers.
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

// --- Data side (public TED records) -------------------------------------------

export const buyers = pgTable("buyers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  city: text("city"),
  legalType: text("legal_type"),
  // award_count, median_value_eur, median_tenders_received, cpv_classes
  stats: jsonb("stats").notNull(),
});

export const suppliers = pgTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    city: text("city"),
    vatId: text("vat_id"),
    size: text("size"),
    // win_count, median_value_eur, min_value_eur, last_award_date,
    // cpv_classes, defence_directive_awards
    stats: jsonb("stats").notNull(),
  },
  (table) => [index("suppliers_country_idx").on(table.country)]
);

// What a supplier has won per 3-digit CPV class: the basis of its offers.
export const supplierOfferBasis = pgTable(
  "supplier_offer_basis",
  {
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    cpvClass: text("cpv_class").notNull(),
    cpvCodes: text("cpv_codes").array().notNull(),
    wins: integer("wins").notNull(),
    medianValueEur: doublePrecision("median_value_eur"),
    minValueEur: doublePrecision("min_value_eur"),
    // sealed
    floorEur: doublePrecision("floor_eur").notNull(),
    lastAwardDate: date("last_award_date", { mode: "string" }),
    exampleTitle: text("example_title"),
  },
  (table) => [primaryKey({ columns: [table.supplierId, table.cpvClass] })]
);

export const listings = pgTable("listings", {
  id: text("id").primaryKey(),
  externalId: text("external_id").notNull(),
  url: text("url"),
  buyerId: text("buyer_id")
    .notNull()
    .references(() => buyers.id),
  mainCpv: text("main_cpv").notNull(),
  cpvCodes: text("cpv_codes").array().notNull(),
  title: text("title").notNull(),
  titleEn: text("title_en"),
  need: text("need"),
  description: text("description"),
  language: text("language"),
  procedure: text("procedure"),
  deadline: date("deadline", { mode: "string" }),
  estimatedValueEur: doublePrecision("estimated_value_eur"),
  // sealed
  walkAwayEur: doublePrecision("walk_away_eur"),
  nLots: integer("n_lots"),
  framework: boolean("framework"),
  defenceDirective: boolean("defence_directive").notNull().default(false),
  // eu | nato | any
  eligibility: text("eligibility").notNull().default("any"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const awards = pgTable(
  "awards",
  {
    id: serial("id").primaryKey(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    buyerId: text("buyer_id").references(() => buyers.id),
    buyerName: text("buyer_name"),
    buyerCountry: text("buyer_country"),
    supplierId: text("supplier_id").references(() => suppliers.id),
    supplierName: text("supplier_name"),
    supplierCountry: text("supplier_country"),
    cpv: text("cpv"),
    valueEur: doublePrecision("value_eur"),
    tendersReceived: integer("tenders_received"),
    awardDate: date("award_date", { mode: "string" }),
    title: text("title"),
  },
  (table) => [
    index("awards_buyer_idx").on(table.buyerId),
    index("awards_supplier_idx").on(table.supplierId),
  ]
);

// --- Market side ----------------------------------------------------------------

// One row per persona token (plan.md §5.1). Only the hash is stored.
export const marketAgents = pgTable(
  "market_agents",
  {
    tokenHash: text("token_hash").primaryKey(),
    // buyer | supplier | observer
    kind: text("kind").notNull(),
    entityId: text("entity_id"),
    name: text("name").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("market_agents_identity_uidx").on(table.kind, table.entityId),
  ]
);

// One row per signed-in user who trades (plan.md §5.1). A user buys and sells
// as one company id, present in both `buyers` and `suppliers`: a public record
// claimed by its company number (users are trusted), or `user:<user id>`.
export const marketTraders = pgTable(
  "market_traders",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // null until the user names a company (set_company)
    entityId: text("entity_id"),
    // sealed, set by the user: walk-away = a demand's estimated value × this
    walkAwayFactor: doublePrecision("walk_away_factor").notNull(),
    // sealed, set by the user: floor = an offer's ask × this
    floorFactor: doublePrecision("floor_factor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("market_traders_entity_uidx").on(table.entityId)]
);

export const demands = pgTable(
  "demands",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id),
    buyerId: text("buyer_id")
      .notNull()
      .references(() => buyers.id),
    cpv: text("cpv").notNull(),
    need: text("need").notNull(),
    estimatedValueEur: doublePrecision("estimated_value_eur"),
    // sealed
    walkAwayEur: doublePrecision("walk_away_eur").notNull(),
    // open | filled | withdrawn
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("demands_buyer_idx").on(table.buyerId)]
);

export const offers = pgTable(
  "offers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    cpvClass: text("cpv_class").notNull(),
    cpvCodes: text("cpv_codes").array().notNull(),
    askEur: doublePrecision("ask_eur").notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    note: text("note"),
    // sealed
    floorEur: doublePrecision("floor_eur").notNull(),
    // open | filled | withdrawn
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("offers_supplier_idx").on(table.supplierId)]
);

export const matches = pgTable(
  "matches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    demandId: text("demand_id")
      .notNull()
      .references(() => demands.id),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    tier: integer("tier").notNull(),
    // sealed: max(offer floor, 0.6 × the demand's published value)
    floorEur: doublePrecision("floor_eur").notNull(),
    // buyer | supplier
    turn: text("turn").notNull(),
    // open | agreed | abandoned | superseded
    state: text("state").notNull(),
    agreedPriceEur: doublePrecision("agreed_price_eur"),
    agreedLeadTimeDays: integer("agreed_lead_time_days"),
    closedReason: text("closed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("matches_demand_offer_uidx").on(table.demandId, table.offerId),
  ]
);

export const proposals = pgTable(
  "proposals",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id),
    // buyer | supplier
    by: text("by").notNull(),
    priceEur: doublePrecision("price_eur").notNull(),
    leadTimeDays: integer("lead_time_days").notNull(),
    message: text("message").notNull(),
    // TED award URLs the agent cites
    cites: jsonb("cites").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("proposals_match_idx").on(table.matchId, table.id)]
);

// Append only; the admin UI and `wait` read it by cursor. An event is
// addressed to the buyer and/or supplier it names; observers see everything,
// including `sealed`.
export const marketEvents = pgTable(
  "market_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    matchId: text("match_id"),
    demandId: text("demand_id"),
    offerId: text("offer_id"),
    buyerId: text("buyer_id"),
    supplierId: text("supplier_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    payload: jsonb("payload").notNull(),
    sealed: jsonb("sealed"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("market_events_buyer_idx").on(table.buyerId, table.id),
    index("market_events_supplier_idx").on(table.supplierId, table.id),
  ]
);
