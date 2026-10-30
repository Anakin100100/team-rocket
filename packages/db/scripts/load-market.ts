// Load the committed TED snapshot (data_discovery/data/processed/market.db)
// into Postgres: raw tables verbatim, then entity tables and the
// `supplier_stats` view built on top with SQL (plan.md §2.2).
//
// Usage (from packages/db): bun run market:load
// Re-runnable: raw tables are replaced, entities are upserted so existing RFQs,
// quotes and deals keep their references.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import path from "node:path";

import "varlock/auto-load";
import { Pool } from "pg";

const MARKET_DB = path.resolve(
  import.meta.dirname,
  "../../../data_discovery/data/processed/market.db"
);
const BATCH_SIZE = 1000;

// Military notices fall under the defence directive, which lets buyers limit
// bidding to EU/EEA suppliers; everything else is open to any supplier.
const ELIGIBILITY_SQL = `case when t.segment = 'military' then 'eu' else 'any' end`;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sqlite = new Database(MARKET_DB, { readonly: true });
const fetchedAt = statSync(MARKET_DB).mtime.toISOString();
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

const copyTable = async (
  source: string,
  target: string,
  columns: readonly string[]
) => {
  const rows = sqlite
    .query(`select ${columns.join(", ")} from ${source}`)
    .values() as unknown[][];
  // Batches run in one transaction on one connection: one after another.
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const placeholders = batch
      .map(
        (_, rowIndex) =>
          `(${columns
            .map(
              (__, columnIndex) =>
                `$${rowIndex * columns.length + columnIndex + 1}`
            )
            .join(", ")})`
      )
      .join(", ");
    // oxlint-disable-next-line no-await-in-loop
    await client.query(
      `insert into ${target} (${columns.join(", ")}) values ${placeholders}`,
      batch.flat()
    );
  }
  console.log(`${target}: ${rows.length} rows`);
};

try {
  await client.query("begin");
  await client.query(
    "truncate raw_ted_tenders, raw_ted_awards, raw_ted_suppliers restart identity"
  );
  await copyTable("tenders", "raw_ted_tenders", [
    "id",
    "source",
    "url",
    "title",
    "description",
    "language",
    "buyer_name",
    "buyer_country",
    "cpv",
    "cpv_all",
    "segment",
    "procedure",
    "value_eur",
    "published",
    "deadline",
    "deadline_kind",
  ]);
  await copyTable("awards", "raw_ted_awards", [
    "notice_id",
    "supplier_id",
    "buyer_name",
    "buyer_country",
    "cpv",
    "segment",
    "value_eur",
    "n_bids",
    "date",
    "title",
  ]);
  await copyTable("suppliers", "raw_ted_suppliers", [
    "id",
    "name",
    "country",
    "city",
    "size",
    "n_awards",
    "total_value_eur",
    "top_cpvs",
    "first_award",
    "last_award",
  ]);

  await client.query(`
    insert into buyers (name, country)
    select distinct buyer_name, buyer_country from (
      select buyer_name, buyer_country from raw_ted_tenders
      union select buyer_name, buyer_country from raw_ted_awards
    ) b
    where buyer_name is not null and buyer_country is not null
    on conflict (name, country) do nothing`);

  await client.query(`
    insert into suppliers (id, name, country, city, size)
    select id, coalesce(name, id), coalesce(country, split_part(id, ':', 1)), city, size
    from raw_ted_suppliers
    on conflict (id) do update set
      name = excluded.name, country = excluded.country,
      city = excluded.city, size = excluded.size`);

  // Registry ids are the part after '<ISO3>:'; name-keyed suppliers have none.
  await client.query(`
    insert into identifiers (entity_type, entity_id, system, external_id)
    select 'supplier', id, 'national-registry', substr(id, position(':' in id) + 1)
    from suppliers where id not like '%:name:%'
    on conflict do nothing`);

  await client.query(
    `
    insert into listings (id, source_system, external_id, url, buyer_id, main_cpv,
      cpv_codes, title, description, language, procedure, segment, deadline,
      estimated_value_eur, eligibility, fetched_at)
    select t.id, 'ted', regexp_replace(t.id, '^ted:', ''), t.url, b.id, t.cpv,
      string_to_array(t.cpv_all, ';'), t.title, t.description, t.language,
      t.procedure, t.segment, nullif(t.deadline, '')::date, t.value_eur,
      ${ELIGIBILITY_SQL}, $1::timestamptz
    from raw_ted_tenders t
    left join buyers b on b.name = t.buyer_name and b.country = t.buyer_country
    on conflict (id) do update set
      url = excluded.url, buyer_id = excluded.buyer_id, main_cpv = excluded.main_cpv,
      cpv_codes = excluded.cpv_codes, title = excluded.title,
      description = excluded.description, language = excluded.language,
      procedure = excluded.procedure, segment = excluded.segment,
      deadline = excluded.deadline, estimated_value_eur = excluded.estimated_value_eur,
      eligibility = excluded.eligibility, fetched_at = excluded.fetched_at`,
    [fetchedAt]
  );

  await client.query(`
    insert into identifiers (entity_type, entity_id, system, external_id)
    select 'listing', id, source_system, external_id from listings
    on conflict do nothing`);

  // Awards are only referenced through suppliers and buyers, so replace them.
  await client.query("delete from awards where source_system = 'ted'");
  await client.query(`
    insert into awards (source_system, external_id, buyer_id, supplier_id, cpv,
      title, value_eur, award_date, tenders_received)
    select 'ted', regexp_replace(a.notice_id, '^ted:', ''), b.id, a.supplier_id,
      a.cpv, a.title, a.value_eur, nullif(a.date, '')::date, a.n_bids
    from raw_ted_awards a
    join suppliers s on s.id = a.supplier_id
    left join buyers b on b.name = a.buyer_name and b.country = a.buyer_country
    where a.cpv is not null`);

  await client.query(`
    create or replace view supplier_stats as
    select supplier_id,
      count(*)::int as win_count,
      percentile_cont(0.5) within group (order by value_eur) as median_value_eur,
      min(value_eur) as min_value_eur,
      max(award_date) as last_award_date,
      array_agg(distinct left(cpv, 3)) as cpv_classes
    from awards
    group by supplier_id`);

  await client.query("commit");

  const { rows } = await client.query(`
    select
      (select count(*) from buyers) as buyers,
      (select count(*) from suppliers) as suppliers,
      (select count(*) from listings) as listings,
      (select count(*) from listings where deadline >= current_date) as open_listings,
      (select count(*) from awards) as awards`);
  console.log("loaded", rows[0], "fetched_at", fetchedAt);
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
