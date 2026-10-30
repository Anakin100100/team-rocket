// Matching is a query (plan.md §4.2), run inside both post tools: the same
// rule for a new demand (against open offers) and a new offer (against open
// demands). Every hit becomes a thread with the supplier's public ask as the
// standing proposal and the buyer on turn.
import { matches, proposals } from "@rocket/db/schema/market";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  DEFENCE_DIVISION,
  EU_EEA_COUNTRIES,
  MAX_MATCHES,
  NATO_COUNTRIES,
  THREAD_FLOOR_ANCHOR,
} from "./constants";
import type { Executor } from "./context";
import { appendEvent } from "./events";

interface Pair {
  demand_id: string;
  offer_id: string;
  buyer_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_country: string;
  listing_id: string;
  listing_title: string;
  listing_title_en: string | null;
  tier: number;
  wins: number;
  ask_eur: number;
  lead_time_days: number;
  note: string | null;
  thread_floor_eur: number;
  walk_away_eur: number;
}

// Tier 1: same 3-digit class · 2: same division · 3: both in defence (35).
// Filters: eligibility, at least one defence award, a defence-directive award
// when the listing needs one, and a thread floor the buyer could ever reach.
// One thread per supplier and demand (its closest offer).
const candidatePairs = async (
  executor: Executor,
  where: SQL
): Promise<Pair[]> => {
  const result = await executor.execute(sql`
    with pairs as (
      select d.id as demand_id, o.id as offer_id, d.buyer_id, o.supplier_id,
        s.name as supplier_name, s.country as supplier_country,
        l.id as listing_id, l.title as listing_title, l.title_en as listing_title_en,
        case when o.cpv_class = left(d.cpv, 3) then 1
             when left(o.cpv_class, 2) = left(d.cpv, 2) then 2
             else 3 end as tier,
        o.ask_eur, o.lead_time_days, o.note,
        greatest(o.floor_eur, ${THREAD_FLOOR_ANCHOR} * coalesce(d.estimated_value_eur, 0))
          as thread_floor_eur,
        d.walk_away_eur
      from demands d
      join listings l on l.id = d.listing_id
      join offers o on o.state = 'open'
      join suppliers s on s.id = o.supplier_id
      where d.state = 'open'
        and ${where}
        and (o.cpv_class = left(d.cpv, 3)
          or left(o.cpv_class, 2) = left(d.cpv, 2)
          or (left(o.cpv_class, 2) = ${DEFENCE_DIVISION} and left(d.cpv, 2) = ${DEFENCE_DIVISION}))
        and (l.eligibility = 'any'
          or (l.eligibility = 'eu' and s.country = any(${sql.param(EU_EEA_COUNTRIES)}::text[]))
          or (l.eligibility = 'nato' and s.country = any(${sql.param(NATO_COUNTRIES)}::text[])))
        and exists (
          select 1 from supplier_offer_basis b
          where b.supplier_id = s.id and left(b.cpv_class, 2) = ${DEFENCE_DIVISION})
        and (not l.defence_directive
          or coalesce((s.stats ->> 'defence_directive_awards')::int, 0) >= 1)
        and not exists (
          select 1 from matches m join offers mo on mo.id = m.offer_id
          where m.demand_id = d.id and mo.supplier_id = o.supplier_id)
    ),
    tiered as (
      select p.*,
        case p.tier when 1 then left(d.cpv, 3)
                    when 2 then left(d.cpv, 2)
                    else ${DEFENCE_DIVISION} end as matched_prefix
      from pairs p join demands d on d.id = p.demand_id
    ),
    ranked as (
      select distinct on (t.demand_id, t.supplier_id) t.*,
        (select coalesce(sum(b.wins), 0)::int from supplier_offer_basis b
          where b.supplier_id = t.supplier_id
            and b.cpv_class like t.matched_prefix || '%') as wins
      from tiered t
      where t.thread_floor_eur <= t.walk_away_eur
      order by t.demand_id, t.supplier_id, t.tier
    )
    select * from ranked
    order by tier, wins desc, supplier_id
    limit ${MAX_MATCHES}
  `);
  const rows = Array.isArray(result)
    ? (result.at(-1)?.rows ?? [])
    : result.rows;
  return rows.map((row: Record<string, unknown>) => ({
    ...(row as unknown as Pair),
    tier: Number(row.tier),
    wins: Number(row.wins),
    ask_eur: Number(row.ask_eur),
    lead_time_days: Number(row.lead_time_days),
    thread_floor_eur: Number(row.thread_floor_eur),
    walk_away_eur: Number(row.walk_away_eur),
  }));
};

const openThread = async (executor: Executor, pair: Pair) => {
  const [match] = await executor
    .insert(matches)
    .values({
      demandId: pair.demand_id,
      offerId: pair.offer_id,
      tier: pair.tier,
      floorEur: pair.thread_floor_eur,
      turn: "buyer",
      state: "open",
    })
    .onConflictDoNothing()
    .returning({ id: matches.id });
  if (!match) {
    return null;
  }
  const message = pair.note?.trim() || "Opening ask from our public offer.";
  await executor.insert(proposals).values({
    matchId: match.id,
    by: "supplier",
    priceEur: pair.ask_eur,
    leadTimeDays: pair.lead_time_days,
    message,
  });
  await appendEvent(executor, {
    actor: "market",
    action: "match_opened",
    matchId: match.id,
    demandId: pair.demand_id,
    offerId: pair.offer_id,
    buyerId: pair.buyer_id,
    supplierId: pair.supplier_id,
    payload: {
      tier: pair.tier,
      wins_in_matched_cpv: pair.wins,
      listing_id: pair.listing_id,
      listing_title: pair.listing_title,
      listing_title_en: pair.listing_title_en,
      supplier_name: pair.supplier_name,
      supplier_country: pair.supplier_country,
      opening_ask_eur: pair.ask_eur,
      lead_time_days: pair.lead_time_days,
      message,
      turn: "buyer",
    },
    sealed: {
      thread_floor_eur: pair.thread_floor_eur,
      walk_away_eur: pair.walk_away_eur,
    },
  });
  return {
    match_id: match.id,
    tier: pair.tier,
    supplier_id: pair.supplier_id,
    supplier_name: pair.supplier_name,
    listing_id: pair.listing_id,
    listing_title: pair.listing_title_en ?? pair.listing_title,
    opening_ask_eur: pair.ask_eur,
    lead_time_days: pair.lead_time_days,
  };
};

// Sequential on purpose: one transaction, one connection, ordered events.
const openThreads = async (executor: Executor, pairs: Pair[]) => {
  const opened = [];
  for (const pair of pairs) {
    // oxlint-disable-next-line no-await-in-loop
    const thread = await openThread(executor, pair);
    if (thread) {
      opened.push(thread);
    }
  }
  return opened;
};

export const matchNewDemand = async (executor: Executor, demandId: string) =>
  openThreads(
    executor,
    await candidatePairs(executor, sql`d.id = ${demandId}`)
  );

export const matchNewOffer = async (executor: Executor, offerId: string) =>
  openThreads(executor, await candidatePairs(executor, sql`o.id = ${offerId}`));
