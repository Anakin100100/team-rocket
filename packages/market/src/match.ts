// Matching is a query (plan.md §6.2): tiers by CPV closeness, filtered by
// eligibility, defence track record and budget fit. No process, no waiting.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  BUDGET_MATCH_RANGE,
  DEFENCE_DIVISION,
  EU_EEA_COUNTRIES,
  NATO_COUNTRIES,
} from "./constants";
import type { Executor } from "./context";

export interface SupplyMatch {
  supplier_id: string;
  name: string;
  country: string;
  city: string | null;
  size: string | null;
  tier: number;
  matched_cpv: string;
  wins_in_cpv: number;
  median_award_eur: number | null;
  min_award_eur: number | null;
  last_award_date: string | null;
  total_wins: number;
}

export interface DemandMatch {
  listing_id: string;
  title: string | null;
  url: string | null;
  buyer_name: string | null;
  buyer_country: string | null;
  main_cpv: string | null;
  segment: string | null;
  procedure: string | null;
  deadline: string | null;
  estimated_value_eur: number | null;
  eligibility: string;
  is_open: boolean;
  fetched_at: string;
  tier: number | null;
}

const eligibleSql = (eligibility: SQL, country: SQL) => sql`(
  ${eligibility} = 'any'
  or (${eligibility} = 'eu' and ${country} = any(${sql.param(EU_EEA_COUNTRIES)}::text[]))
  or (${eligibility} = 'nato' and ${country} = any(${sql.param(NATO_COUNTRIES)}::text[]))
)`;

const hasDefenceAward = (supplierId: SQL) => sql`exists (
  select 1 from awards d
  where d.supplier_id = ${supplierId} and left(d.cpv, 2) = ${DEFENCE_DIVISION}
)`;

const countryFilter = (column: SQL, countries?: readonly string[]) =>
  countries && countries.length > 0
    ? sql`and ${column} = any(${sql.param(countries.map((c) => c.toUpperCase()))}::text[])`
    : sql``;

// `execute` returns one result, or one per statement for multi-statement SQL.
const rowsOf = (
  result:
    | { rows: Record<string, unknown>[] }
    | { rows: Record<string, unknown>[] }[]
) => (Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows);

const toNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

const normaliseSupply = (row: Record<string, unknown>): SupplyMatch => ({
  supplier_id: String(row.supplier_id),
  name: String(row.name),
  country: String(row.country),
  city: (row.city as string | null) ?? null,
  size: (row.size as string | null) ?? null,
  tier: Number(row.tier),
  matched_cpv: String(row.matched_cpv),
  wins_in_cpv: Number(row.wins_in_cpv),
  median_award_eur: toNumber(row.median_award_eur),
  min_award_eur: toNumber(row.min_award_eur),
  last_award_date: (row.last_award_date as string | null) ?? null,
  total_wins: Number(row.total_wins),
});

// Tier 1: same 3-digit CPV class as the listing · tier 2: same 2-digit division
// · tier 3: any defence/security (division 35) award. Ordered by tier, then
// wins in the matched CPV.
export const matchSupplyForListing = async (
  executor: Executor,
  {
    listingId,
    countries,
    limit,
  }: { listingId: string; countries?: readonly string[]; limit: number }
): Promise<SupplyMatch[]> => {
  const result = await executor.execute(sql`
    with l as (
      select main_cpv, estimated_value_eur as budget, eligibility
      from listings where id = ${listingId}
    ),
    scoped as (
      select a.supplier_id, a.value_eur, a.award_date,
        case when left(a.cpv, 3) = left(l.main_cpv, 3) then 1
             when left(a.cpv, 2) = left(l.main_cpv, 2) then 2
             else 3 end as tier
      from awards a cross join l
      where left(a.cpv, 2) in (left(l.main_cpv, 2), ${DEFENCE_DIVISION})
    ),
    best as (select supplier_id, min(tier) as tier from scoped group by supplier_id),
    stats as (
      select b.supplier_id, b.tier, count(*)::int as wins_in_cpv,
        percentile_cont(0.5) within group (order by s.value_eur) as median_award_eur,
        min(s.value_eur) as min_award_eur,
        max(s.award_date)::text as last_award_date
      from best b join scoped s on s.supplier_id = b.supplier_id and s.tier = b.tier
      group by b.supplier_id, b.tier
    )
    select st.*, sp.name, sp.country, sp.city, sp.size,
      case st.tier when 1 then left(l.main_cpv, 3)
                   when 2 then left(l.main_cpv, 2)
                   else ${DEFENCE_DIVISION} end as matched_cpv,
      (select count(*)::int from awards t where t.supplier_id = st.supplier_id) as total_wins
    from stats st
    join suppliers sp on sp.id = st.supplier_id
    cross join l
    where st.median_award_eur is not null
      and ${eligibleSql(sql`l.eligibility`, sql`sp.country`)}
      and ${hasDefenceAward(sql`st.supplier_id`)}
      and (l.budget is null or st.median_award_eur between
        ${BUDGET_MATCH_RANGE.min} * l.budget and ${BUDGET_MATCH_RANGE.max} * l.budget)
      ${countryFilter(sql`sp.country`, countries)}
    order by st.tier, st.wins_in_cpv desc, st.supplier_id
    limit ${limit}
  `);
  return rowsOf(result).map(normaliseSupply);
};

// Suppliers with awards under a CPV prefix (no listing): all tier 1.
export const matchSupplyForCpv = async (
  executor: Executor,
  {
    cpvPrefix,
    countries,
    limit,
  }: { cpvPrefix: string; countries?: readonly string[]; limit: number }
): Promise<SupplyMatch[]> => {
  const result = await executor.execute(sql`
    select a.supplier_id, sp.name, sp.country, sp.city, sp.size,
      1 as tier, ${cpvPrefix}::text as matched_cpv,
      count(*)::int as wins_in_cpv,
      percentile_cont(0.5) within group (order by a.value_eur) as median_award_eur,
      min(a.value_eur) as min_award_eur,
      max(a.award_date)::text as last_award_date,
      (select count(*)::int from awards t where t.supplier_id = a.supplier_id) as total_wins
    from awards a
    join suppliers sp on sp.id = a.supplier_id
    where a.cpv like ${`${cpvPrefix}%`}
      and ${hasDefenceAward(sql`a.supplier_id`)}
      ${countryFilter(sql`sp.country`, countries)}
    group by a.supplier_id, sp.name, sp.country, sp.city, sp.size
    order by wins_in_cpv desc, a.supplier_id
    limit ${limit}
  `);
  return rowsOf(result).map(normaliseSupply);
};

const listingColumns = sql`
  l.id as listing_id, l.title, l.url, b.name as buyer_name, b.country as buyer_country,
  l.main_cpv, l.segment, l.procedure, l.deadline::text as deadline,
  l.estimated_value_eur, l.eligibility, (l.deadline >= current_date) as is_open,
  l.fetched_at`;

const normaliseDemand = (row: Record<string, unknown>): DemandMatch => ({
  listing_id: String(row.listing_id),
  title: (row.title as string | null) ?? null,
  url: (row.url as string | null) ?? null,
  buyer_name: (row.buyer_name as string | null) ?? null,
  buyer_country: (row.buyer_country as string | null) ?? null,
  main_cpv: (row.main_cpv as string | null) ?? null,
  segment: (row.segment as string | null) ?? null,
  procedure: (row.procedure as string | null) ?? null,
  deadline: (row.deadline as string | null) ?? null,
  estimated_value_eur: toNumber(row.estimated_value_eur),
  eligibility: String(row.eligibility),
  is_open: Boolean(row.is_open),
  fetched_at: new Date(row.fetched_at as string).toISOString(),
  tier: row.tier === undefined ? null : toNumber(row.tier),
});

// The same tiers with the sides swapped: open listings a supplier could bid on,
// judged by the CPV classes it has already won and its typical award size.
export const matchDemandForSupplier = async (
  executor: Executor,
  {
    supplierId,
    countries,
    openOnly,
    limit,
  }: {
    supplierId: string;
    countries?: readonly string[];
    openOnly: boolean;
    limit: number;
  }
): Promise<DemandMatch[]> => {
  const result = await executor.execute(sql`
    with sp as (select id, country from suppliers where id = ${supplierId}),
    classes as (
      select distinct left(cpv, 3) as c3, left(cpv, 2) as c2
      from awards where supplier_id = ${supplierId}
    ),
    med as (
      select percentile_cont(0.5) within group (order by value_eur) as m
      from awards where supplier_id = ${supplierId}
    ),
    tiered as (
      select l.*,
        case when exists (select 1 from classes where c3 = left(l.main_cpv, 3)) then 1
             when exists (select 1 from classes where c2 = left(l.main_cpv, 2)) then 2
             when exists (select 1 from classes where c2 = ${DEFENCE_DIVISION}) then 3
        end as tier
      from listings l
      where l.main_cpv is not null
        ${openOnly ? sql`and l.deadline >= current_date` : sql``}
    )
    select ${listingColumns}, l.tier
    from tiered l
    left join buyers b on b.id = l.buyer_id
    cross join sp cross join med
    where l.tier is not null
      and ${eligibleSql(sql`l.eligibility`, sql`sp.country`)}
      and (l.tier < 3 or left(l.main_cpv, 2) = ${DEFENCE_DIVISION})
      and (l.estimated_value_eur is null or med.m is null or med.m between
        ${BUDGET_MATCH_RANGE.min} * l.estimated_value_eur and ${BUDGET_MATCH_RANGE.max} * l.estimated_value_eur)
      ${countryFilter(sql`b.country`, countries)}
    order by l.tier, l.deadline nulls last, l.id
    limit ${limit}
  `);
  return rowsOf(result).map(normaliseDemand);
};

export const searchListings = async (
  executor: Executor,
  {
    cpvPrefix,
    countries,
    text,
    openOnly,
    limit,
  }: {
    cpvPrefix?: string;
    countries?: readonly string[];
    text?: string;
    openOnly: boolean;
    limit: number;
  }
): Promise<DemandMatch[]> => {
  const result = await executor.execute(sql`
    select ${listingColumns}
    from listings l
    left join buyers b on b.id = l.buyer_id
    where true
      ${openOnly ? sql`and l.deadline >= current_date` : sql``}
      ${cpvPrefix ? sql`and l.main_cpv like ${`${cpvPrefix}%`}` : sql``}
      ${text ? sql`and (l.title ilike ${`%${text}%`} or l.description ilike ${`%${text}%`})` : sql``}
      ${countryFilter(sql`b.country`, countries)}
    order by l.deadline nulls last, l.id
    limit ${limit}
  `);
  return rowsOf(result).map(normaliseDemand);
};
