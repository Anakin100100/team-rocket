// Load the demo seed (data_discovery/data/processed/demo_seed.json, built by
// data_discovery/scripts/build_demo_seed.py) into Postgres: buyers, suppliers,
// their per-class offer basis, listings and public awards (plan.md §2.2–2.3).
//
// Usage (from packages/db): bun run market:load
// Re-runnable: everything is upserted, awards are replaced; market-side rows
// (demands, offers, matches, events) are left alone.
//
// Every write runs in one transaction on one connection, so the loops await
// each statement in turn.
/* oxlint-disable no-await-in-loop */
import { readFileSync } from "node:fs";
import path from "node:path";

import "varlock/auto-load";
import { Pool } from "pg";

const SEED = path.resolve(
  import.meta.dirname,
  "../../../data_discovery/data/processed/demo_seed.json"
);
const TIMEZONE_SUFFIX = /[zZ]|[+-]\d\d:?\d\d$/u;

interface SeedAward {
  external_id: string;
  url?: string | null;
  buyer_name?: string | null;
  buyer_country?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  cpv?: string | null;
  value_eur?: number | null;
  tenders_received?: number | null;
  award_date?: string | null;
  title?: string | null;
}

interface Seed {
  meta: { ted_fetched_at: string };
  buyers: {
    id: string;
    name: string;
    country: string;
    city: string | null;
    legal_type: string | null;
    stats: unknown;
    awards: SeedAward[];
  }[];
  suppliers: {
    id: string;
    name: string;
    country: string;
    city: string | null;
    vat_id: string | null;
    size: string | null;
    stats: unknown;
    offer_basis: {
      cpv_class: string;
      cpv_codes: string[];
      wins: number;
      median_value_eur: number | null;
      min_value_eur: number | null;
      floor_eur: number;
      last_award_date: string | null;
      example_title: string | null;
    }[];
    awards: SeedAward[];
  }[];
  listings: {
    id: string;
    external_id: string;
    url: string | null;
    buyer_id: string;
    main_cpv: string;
    cpv_codes: string[];
    title: string;
    title_en: string | null;
    need: string | null;
    description: string | null;
    language: string | null;
    procedure: string | null;
    deadline: string | null;
    estimated_value_eur: number | null;
    walk_away_eur: number | null;
    n_lots: number | null;
    framework: boolean | null;
    defence_directive: boolean;
    eligibility: string;
    fetched_at: string;
  }[];
}

type MergedAward = SeedAward & { buyer_id: string | null };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const seed = JSON.parse(readFileSync(SEED, "utf-8")) as Seed;
// TED timestamps carry no zone; they are UTC.
const utc = (timestamp: string) =>
  TIMEZONE_SUFFIX.test(timestamp) ? timestamp : `${timestamp}Z`;

// The same award appears under its buyer and under its supplier; merge them.
const awardKey = (award: SeedAward) =>
  [
    award.external_id,
    award.supplier_id ?? award.supplier_name,
    award.buyer_name,
  ].join("|");

const mergeAwards = () => {
  const byKey = new Map<string, MergedAward>();
  for (const buyer of seed.buyers) {
    for (const award of buyer.awards) {
      const merged = {
        ...award,
        buyer_name: buyer.name,
        buyer_country: buyer.country,
        buyer_id: buyer.id,
      };
      byKey.set(awardKey(merged), merged);
    }
  }
  for (const supplier of seed.suppliers) {
    for (const award of supplier.awards) {
      const key = awardKey({ ...award, supplier_id: supplier.id });
      const existing = byKey.get(key);
      byKey.set(key, {
        ...award,
        ...existing,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        supplier_country: supplier.country,
        buyer_id: existing?.buyer_id ?? null,
      });
    }
  }
  return [...byKey.values()];
};

const supplierIds = new Set(seed.suppliers.map((supplier) => supplier.id));
const awards = mergeAwards();
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query("begin");
  // Leftover from the previous (RFQ) design.
  await client.query("drop view if exists supplier_stats");

  for (const buyer of seed.buyers) {
    await client.query(
      `insert into buyers (id, name, country, city, legal_type, stats)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set name = excluded.name, country = excluded.country,
         city = excluded.city, legal_type = excluded.legal_type, stats = excluded.stats`,
      [
        buyer.id,
        buyer.name,
        buyer.country,
        buyer.city,
        buyer.legal_type,
        JSON.stringify(buyer.stats),
      ]
    );
  }

  for (const supplier of seed.suppliers) {
    await client.query(
      `insert into suppliers (id, name, country, city, vat_id, size, stats)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set name = excluded.name, country = excluded.country,
         city = excluded.city, vat_id = excluded.vat_id, size = excluded.size,
         stats = excluded.stats`,
      [
        supplier.id,
        supplier.name,
        supplier.country,
        supplier.city,
        supplier.vat_id,
        supplier.size,
        JSON.stringify(supplier.stats),
      ]
    );
    await client.query(
      "delete from supplier_offer_basis where supplier_id = $1",
      [supplier.id]
    );
    for (const basis of supplier.offer_basis) {
      await client.query(
        `insert into supplier_offer_basis (supplier_id, cpv_class, cpv_codes, wins,
           median_value_eur, min_value_eur, floor_eur, last_award_date, example_title)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          supplier.id,
          basis.cpv_class,
          basis.cpv_codes,
          basis.wins,
          basis.median_value_eur,
          basis.min_value_eur,
          basis.floor_eur,
          basis.last_award_date,
          basis.example_title,
        ]
      );
    }
  }

  for (const listing of seed.listings) {
    await client.query(
      `insert into listings (id, external_id, url, buyer_id, main_cpv, cpv_codes, title,
         title_en, need, description, language, procedure, deadline, estimated_value_eur,
         walk_away_eur, n_lots, framework, defence_directive, eligibility, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20)
       on conflict (id) do update set external_id = excluded.external_id, url = excluded.url,
         buyer_id = excluded.buyer_id, main_cpv = excluded.main_cpv,
         cpv_codes = excluded.cpv_codes, title = excluded.title,
         title_en = excluded.title_en, need = excluded.need,
         description = excluded.description, language = excluded.language,
         procedure = excluded.procedure, deadline = excluded.deadline,
         estimated_value_eur = excluded.estimated_value_eur,
         walk_away_eur = excluded.walk_away_eur, n_lots = excluded.n_lots,
         framework = excluded.framework, defence_directive = excluded.defence_directive,
         eligibility = excluded.eligibility, fetched_at = excluded.fetched_at`,
      [
        listing.id,
        listing.external_id,
        listing.url,
        listing.buyer_id,
        listing.main_cpv,
        listing.cpv_codes,
        listing.title,
        listing.title_en,
        listing.need,
        listing.description,
        listing.language,
        listing.procedure,
        listing.deadline,
        listing.estimated_value_eur,
        listing.walk_away_eur,
        listing.n_lots,
        listing.framework,
        listing.defence_directive,
        listing.eligibility,
        utc(listing.fetched_at),
      ]
    );
  }

  await client.query("delete from awards");
  for (const award of awards) {
    await client.query(
      `insert into awards (external_id, url, buyer_id, buyer_name, buyer_country,
         supplier_id, supplier_name, supplier_country, cpv, value_eur, tenders_received,
         award_date, title)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        award.external_id,
        award.url ?? null,
        award.buyer_id,
        award.buyer_name ?? null,
        award.buyer_country ?? null,
        award.supplier_id && supplierIds.has(award.supplier_id)
          ? award.supplier_id
          : null,
        award.supplier_name ?? null,
        award.supplier_country ?? null,
        award.cpv ?? null,
        award.value_eur ?? null,
        award.tenders_received ?? null,
        award.award_date ?? null,
        award.title ?? null,
      ]
    );
  }

  await client.query("commit");
  console.log(
    `Loaded ${seed.buyers.length} buyers, ${seed.suppliers.length} suppliers, ${seed.listings.length} listings, ${awards.length} awards (TED fetched ${seed.meta.ted_fetched_at}).`
  );
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
