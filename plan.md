# Team Rocket — Agent Marketplace for the European Defence Supply Chain

Build the Arsenal · SalesPatriot Europe Challenge · Warsaw, 30 Oct 2026

## 1. The problem, in plain words

Europe is buying a lot of military and security equipment right now. The buying
happens through public tenders: a ministry, an army unit or NATO's procurement
agency publishes a notice, companies read it, send offers, and the buyer picks one.

Today that process runs on email, PDFs and portals in 24 languages. Three things go
wrong:

- **Fragmented.** Notices are spread across TED, national platforms, NSPA, EDA and
  ministries' own sites. Nobody sees the whole market.
- **Manual.** Finding a supplier, getting a quote, comparing offers and awarding takes
  weeks of human work on both sides.
- **Missed.** A Czech vest maker that just won in Prague never hears about the Slovak
  notice next door. Capacity sits idle while demand waits.

**What we build:** a two sided market where every participant is an agent.

1. **Buyers post demands** from real TED notices. **Suppliers post offers** from
   their real award history. Both sides are proactive. The missed tender finds the
   supplier because the supplier is already on the market.
2. **Code matches them** by CPV the moment either side posts. Nobody waits.
3. **Matched pairs negotiate** in private threads, each side arguing from public
   award records, until one accepts the other's standing proposal. That acceptance
   is the contract. No human in the loop.
4. **The server is a database with guards.** Who may act, whose turn it is, what
   price is allowed, who sees what. All judgement is in the agents.

**Why this is credible:** demand and supply are both real public data. Real open
notices, real companies that won EU defence contracts, with what they won and for how
much. Agents quote those records to each other with URLs.

**How we frame it on stage:** a public tender cannot legally be closed by two agents
today. We show the market as it looks when every company runs its own agent, seeded
from its public award history. Say this up front.

### What the judges require

| Must have | How we satisfy it |
|---|---|
| Live app on the host's computer, no slides | Admin UI on a deployed URL; agent terminals on the laptop; Claude Desktop on the same MCP endpoint |
| Real public European data | TED notices and award winners. Fetch timestamp shown. Every number an agent cites links to a TED notice |
| Both market sides, one deal closed with no human | Buyer and supplier agents agree a price through the server; the agreed match is the deal |

Scoring: usefulness 30, creativity 30, use of data 20, demo quality 20. Creativity is
won in the thread view: two agents arguing from each other's public history.

## 2. Data

### 2.1 What we have (`data_discovery/`)

Staging CSVs live in `data_discovery/data/raw/staging/` (gitignored). The committed
common format is `data_discovery/data/processed/market.db` (SQLite, TED only): 701
open notices, 141 of them with a value and a 35* CPV; 4,369 suppliers with at least
one 35* award; 35,739 awards with values. Supplier deduplication is done.

### 2.2 The seed (`data_discovery/data/processed/demo_seed.json`)

Built by `scripts/build_demo_seed.py` from `market.db`. This is the only data the
demo loads. Everything in it is public TED data except `title_en` and `need`.

| Key | Contents | Used for |
|---|---|---|
| `buyers[]` | 6 contracting authorities with `stats` and their own `awards[]` (what they paid, to whom, how many bidders) | buyer persona |
| `listings[]` | 6 curated open notices with CPV, description, published value, `walk_away_eur` (sealed), `candidates[]` as a match preview | demands |
| `suppliers[]` | 30 real companies with `stats`, `offer_basis[]` per CPV class (wins, median, min, `floor_eur` sealed) and recent `awards[]` | offers, supplier persona |
| `personas[]` | per listing: the buyer id and the top 3 supplier ids | agent directories |

Demo listing: `ted:549292-2026`, Slovak Prison and Court Guard, 350 plate carriers,
published €698,856. Personas: Fabrica Española de Confecciones (ESP, 15 wins in class
358), STV GROUP (CZE, 10), GARED (CZE, 6). The buyer has 9 past awards at a median of
€736k with a median of 2 bidders. All three suppliers have medians above the published
value, so the negotiation is real, not decorative.

### 2.3 Postgres (Neon)

Data side, loaded from the seed:

```
buyers      id, name, country, city, legal_type
suppliers   id, name, country, city, vat_id, size
listings    id, external_id, url, buyer_id, main_cpv, cpv_codes, title, title_en, need,
            description, language, deadline, estimated_value_eur, walk_away_eur,
            defence_directive, eligibility, fetched_at
awards      id, external_id, url, buyer_id?, buyer_name, supplier_id?, supplier_name,
            cpv, value_eur, tenders_received, award_date, title
```

Market side, written only through tools:

```
agents      token_hash, kind (buyer|supplier|observer), entity_id, name
traders     user_id, entity_id, walk_away_factor (sealed), floor_factor (sealed)
demands     id, listing_id, buyer_id, cpv, need, estimated_value_eur,
            walk_away_eur (sealed), state (open|filled|withdrawn), created_at
offers      id, supplier_id, cpv_class, cpv_codes, ask_eur, lead_time_days, note,
            floor_eur (sealed), state (open|filled|withdrawn), created_at
matches     id, demand_id, offer_id, tier, floor_eur (sealed, thread level),
            turn (buyer|supplier), state (open|agreed|abandoned|superseded),
            agreed_price_eur, agreed_lead_time_days, created_at, closed_at
proposals   id, match_id, by (buyer|supplier), price_eur, lead_time_days, message,
            cites (json: award urls), created_at
events      id (bigserial), match_id?, demand_id?, offer_id?, actor, action,
            payload (json), ts
```

An agreed match is the deal. There is no deals table. `events` is append only and is
the only thing the admin UI reads.

## 3. Architecture

```
 agents/buyer-549292/        agents/supplier-ESP-28030062/   ... x3      Claude Desktop (human)
   claude -p "Trade."           claude -p "Trade."                        OAuth door
   CLAUDE.md  .mcp.json         CLAUDE.md  .mcp.json
        |                            |                                        |
        +------------- bearer token --+---------- streamable HTTP ------------+
                                      v
                        Hono on Vercel   /api/mcp  (eleven tools, lib/tools.ts)
                                         /api/events?since=   (admin UI)
                                      |
                                      v
                                 Neon Postgres
                                      ^
                                      |
                        Vite SPA  /market  (admin UI, read only, polls events)
```

Three parts, nothing else:

- **The market.** One tools module. Every write is `UPDATE ... WHERE state = expected`
  plus one event row. Zero rows updated means the guard failed and the tool returns
  the reason. The server has no loop, no timer, no knowledge that agents exist.
- **The agents.** Claude Code sessions. One directory per persona. The CLAUDE.md is the
  real company. The `.mcp.json` carries its token. The agent's clock is the `wait` tool.
- **The admin UI.** One read only page over the events table.

Principles kept from the first plan: the database is the only state, every write checks
state, visibility is enforced in tools and never in prompts, code decides bounds and the
model decides within them, the events table is the only integration point.

## 4. Market rules

### 4.1 Tools (`lib/tools.ts`, exposed at `/api/mcp`)

Identity comes from the connection, never from arguments. Every tool receives
`actor = { kind, entity_id }`.

| Tool | Who | Input | Returns / effect |
|---|---|---|---|
| `whoami` | any | | the actor's own record: profile, stats, award history, open postings, open threads |
| `search_listings` | any | cpv_prefix?, country?, text?, limit | open listings with published value and deadline |
| `search_suppliers` | any | cpv_prefix?, country?, limit | suppliers with public stats |
| `history` | any | entity_id | public award rows for a buyer or supplier, with TED URLs |
| `my_market` | any | | demands, offers, matches and proposals where the actor is a party. Observer sees all |
| `wait` | any | since (event id), timeout_s ≤ 20 | long poll: events addressed to the actor since the cursor, new cursor |
| `post_demand` | buyer | listing_id, need? — or, with no listing: title, cpv, estimated_value_eur, deadline | demand in `open`; walk-away from 4.3; runs matching; events to every matched supplier. Guards: listing open, actor owns it, listing never bought before, a published value |
| `post_offer` | supplier | cpv_class, ask_eur, lead_time_days, note | offer in `open`; floor from 4.3; runs matching; events to every matched buyer. Guards: ask ≥ floor, one open offer per class, personas only in classes they have won in |
| `propose` | party | match_id, price_eur, lead_time_days, message, cites? | new standing proposal, turn flips. Guards in 4.4 |
| `accept` | party | match_id | signs the other side's standing proposal: match `agreed`, demand `filled`, buyer's other matches `superseded`, offer `filled`. Guard: a standing proposal by the other side exists |
| `walk_away` | party | match_id, reason | match `abandoned`, reason visible to the other side |
| `withdraw` | party | posting_id, reason | demand or offer `withdrawn`; its open threads `abandoned`, reason visible to each counterparty |
| `set_company` | trader | country, registry_number?, name? | the company a signed-in user trades as (5.1). Guard: no open postings when switching |
| `set_limits` | trader | walk_away_pct?, floor_pct? | a signed-in user's sealed limits (4.3), for postings made afterwards |

Fourteen tools; the two trader tools are listed only to signed-in users. No create_rfq, no score, no counter, no award, no accept_award.

Every write takes one market-wide lock first (`packages/market/src/write.ts`), so writes run one at a time: guards cannot race, matching sees every posting and event ids commit in order.

### 4.2 Matching (pure SQL, runs inside both post tools)

For a new demand, candidate offers; for a new offer, candidate demands. Same rule
both ways:

| Tier | CPV |
|---|---|
| 1 | same 3 digit class |
| 2 | same 2 digit division |
| 3 | any division 35 |

Plus: never a company with itself; the listing's deadline not passed; supplier eligible
for the listing (`eu`, `nato`, `any`); supplier has at least one award in division 35;
if the listing is under the defence directive, the supplier has at least one defence
directive award. Signed-in users are trusted and skip both award checks. No second
thread between a supplier and a demand, unless the first was only superseded (the
supplier sold elsewhere and offers again). Order by tier, then wins in the matched
class. Take 6. Every hit becomes a match row, unless its thread floor exceeds the
buyer's walk-away (4.3), in which case no thread is opened and nobody is told why.

### 4.3 Sealed limits (set by code, never returned)

- **Buyer walk-away** = published estimated value × 1.10. Stored on the demand.
- **Offer floor** = min priced award in that CPV class × size margin (small 0.9,
  medium 0.85, large 0.8). Stored on the offer.
- **Thread floor** = min(ask, max(offer floor, 0.6 × demand's published value)).
  Stored on the match. The middle term stops a tiny historical lot from giving a
  supplier a floor of €4k on a €700k demand; capping at the ask means a supplier can
  always stand on its opening price.
- **Signed-in users set their own** (`set_limits`): walk-away = estimated value ×
  walk_away_pct (default 110%), floor = ask × floor_pct (default 80%), and the
  thread floor is that floor. They apply to postings made afterwards.

The buyer never learns any floor. The supplier never learns the walk-away. Both only
ever see "outside your limit" when they overstep their own. After a listing's
deadline only `walk_away` is left.

### 4.4 Negotiation

A thread opens with the supplier's public ask as the standing proposal and the buyer
on turn. From there, three verbs:

- `propose` guards: it is your turn; your price concedes against your own last
  proposal (buyer non decreasing, supplier non increasing); buyer price ≤ walk-away;
  supplier price ≥ thread floor; at most 3 proposals per side. After the third, only
  `accept` or `walk_away`.
- `accept` takes the other side's standing proposal as is. That is the contract.
- `walk_away` ends the thread. Capacity, impossible lead time, insulting price, or
  silence from the other side are all reasons the agent writes itself.

A thread ends in at most seven moves. A buyer runs its threads in parallel and may
use what it learns across them in its reasoning, but it can only write words in a
message, never another supplier's number, because the server never gives it one to
quote into another thread. (Strip digits from messages server side if you want this
enforced rather than prompted. Not for the hackathon.)

### 4.5 States

```
demand   open --accept--> filled          open --> withdrawn
offer    open --accept--> filled          open --> withdrawn
match    open --accept--> agreed          open --walk_away--> abandoned
         open --other thread agreed--> superseded
```

### 4.6 Visibility

| Sees | Buyer | Supplier | Trader (signed-in user) | Observer |
|---|---|---|---|---|
| own postings and threads | yes | yes | yes, both sides | all |
| counterparty public profile and awards | yes | yes | yes | yes |
| other suppliers on the same demand | names and tiers only | nothing, not even a count | as buyer or supplier, per thread | all |
| any sealed limit | no | no | only the limit percentages it set itself | yes (admin UI only) |

### 4.7 Code vs model

| Decision | Code | Model |
|---|---|---|
| Matching, tiers, eligibility | ✓ | |
| Walk-away, floors, turn order, concession, round cap | ✓ | |
| State transitions and visibility | ✓ | |
| Reading a Slovak notice, writing the need | | buyer |
| Which CPV classes to offer in, the ask, the lead time | | supplier |
| Every price, every message, every citation | | both |
| When to push, when to accept, when to walk away | | both |

## 5. Agents (Claude Code)

### 5.1 Identity

The MCP route gets a second door in front of `requireMcpAuth`. If the bearer token
hashes to a row in `agents`, the handler runs with that actor. A table rather than an
env map so adding a persona needs no redeploy.

Otherwise the OAuth path runs and a signed in human is a **trader**: one company that
buys and sells, under one id present in both `buyers` and `suppliers`
(`market_traders` maps user → company). `set_company` picks it, and users are trusted:

- a VAT or company number is normalized like the loader does (bare digits, French
  SIRET/VAT to SIREN) and claims the public record it names, `<country>:<digits>` for
  suppliers or the matching `ted-buyer:` id, unless an agent persona or another user
  holds it. Its awards become the user's history.
- otherwise a name and country give the user a company of its own, `user:<user id>`.

A trader's side in each thread follows from which end holds its id; `my_market` marks
it (`you_are`). Observers remain only for the admin UI and scripts.

### 5.2 Layout, generated from the seed

```
agents/
  buyer-549292/
    CLAUDE.md     the Slovak authority: notice in Slovak + English need, its 9 past awards
                  and bidder counts, how to negotiate, the loop
    .mcp.json     market URL + this persona's bearer token
  supplier-ESP-28030062/
    CLAUDE.md     Fabrica Española: profile, 20 wins, class 358 median €990k, 15 recent
                  awards with URLs, capacity, how to negotiate, the loop
    .mcp.json
  supplier-CZE-26181134/   STV GROUP
  supplier-CZE-28819446/   GARED
```

`bun agents:seed <listing_id>` reads `demo_seed.json` and `personas[]`, inserts the
token rows, writes the directories. Re-runnable.

### 5.3 CLAUDE.md shape

Three parts. The first two are generated, the third is fixed text.

1. **Who you are.** The real record, in prose and a table. Suppliers: every recent
   award with buyer, CPV, value, bidders, date, URL. Buyers: the notice and your own
   past purchases.
2. **How you trade.** Suppliers: post offers in the classes you have won in, open
   near your usual price, concede in steps, cite your own awards, decline when you
   are at capacity (two agreed matches). Buyers: cite the supplier's awards and your
   own, push hardest where you want to win, keep a second thread alive as leverage,
   walk away early from what you will not take, accept when a price is right.
3. **The loop.** Call `whoami`. Call `my_market`. If you are a supplier with no open
   offer in your top classes, post one. Answer every thread where it is your turn.
   Call `wait`. Repeat until your postings are filled or every thread is closed, then
   stop.

### 5.4 Running

From each directory:

```
claude -p "Trade." --mcp-config .mcp.json --allowedTools "mcp__market__*" --max-turns 60
```

Headless, no permission prompts, turn capped. Suppliers start first and post their
offers. The buyer starts last and posts the demand, so matches fire on screen. A
human in Claude Desktop connected through the OAuth door can join as a fifth
participant with the same tools.

## 6. Admin UI (`/market`, Vite SPA)

Read only. Polls `/api/events?since=cursor` every two seconds and rebuilds its view
from events. No run button, no form. The agents are already running.

```
+------------------+-------------------------------+------------------+
| DEMAND           | MATCHES                       | OFFERS           |
| Slovak Prison    |  ESP Fabrica  T1  open  3 msg |  ESP Fabrica 358 |
|  Guard           |  CZE STV      T1  open  2 msg |  CZE STV     358 |
|  35815000        |  CZE GARED    T1  agreed 380k |  CZE GARED   358 |
|  698,856         |                               |  ...             |
|  deadline 16 Dec |  [click a match]              |                  |
+------------------+-------------------------------+------------------+
| THREAD  Slovak Prison Guard  x  Fabrica Espanola                      |
|  price chart: proposals over moves, floor and walk-away as dashed     |
|  lines (observer only)                                                |
|  10:41 supplier  860,000  "Our class 358 median is 990k ..."   [TED]  |
|  10:41 buyer     650,000  "Guardia Civil paid you 729k against        |
|                           5 bidders last month ..."           [TED]  |
|  10:42 supplier  780,000  ...                                         |
|  10:42 buyer     accept                                               |
+-----------------------------------------------------------------------+
| fetched from TED 2026-10-30 10:54   .   replay >                      |
+-----------------------------------------------------------------------+
```

- **Three columns.** Demands, matches with a state chip and message count, offers.
  Hover a supplier for its public stats.
- **Thread view.** Click a match. Proposals as a timeline with the agent's message
  and its citations as links to TED notices. Above it a line chart of price per move
  with the sealed floor and walk-away drawn as dashed lines. The observer sees the
  limits; this is the one place they appear.
- **Replay.** A button that streams the events of a past run from the table at
  speed. This is the stage fallback.
- **Badges.** TED fetch timestamp, event count, agents online (an agent is online if
  it called `wait` in the last 30 seconds).

## 7. Demo script (under 90 seconds)

1. Three supplier terminals are already trading. The admin UI shows three offers in
   class 358 and no demand.
2. Start the buyer terminal. It reads the Slovak notice, posts the demand in English.
   Three matches appear.
3. Threads fill. Point at one message: "Guardia Civil paid you €729k against 5
   bidders last month", click the TED link.
4. One thread agrees. The other two flip to superseded. The deal card shows price,
   lead time, both real companies.
5. Click the chart: the proposals converged between two lines nobody in the room
   could see.
6. Optional: a human in Claude Desktop asks "which Slovak or Czech suppliers could
   bid on this?" It calls `search_suppliers`. Same market, different client.
7. Fallback: replay the morning run.

## 8. Build order and ownership

| Step | Deliverable | Owner |
|---|---|---|
| 1 | Postgres tables, loader from `demo_seed.json`, token door on `/api/mcp` | server |
| 2 | Eleven tools with guards, matching SQL, events | server |
| 3 | `bun agents:seed`: CLAUDE.md and `.mcp.json` per persona, token rows | agents |
| 4 | **Checkpoint: buyer and one supplier in two terminals until a match agrees.** No UI needed. Everyone stops for this if it is not there | all |
| 5 | Admin UI: three columns, thread view, chart, polling | ui |
| 6 | Three suppliers, rehearse three times, capture a replay | all |
| 7 | Replay button, badges, Claude Desktop observer login | ui + server |

Working rules: the tools module is the contract, nobody adds a tool without updating
it first. The events table is the only integration point. Deploy from hour one. Freeze
with one hour left.

## 9. Stack

- Hono (oRPC, Drizzle, Better Auth, MCP) as a Vercel function. `wait` holds a
  request up to 20 seconds, well inside the function limit.
- Vite + TanStack Router SPA on Vercel.
- Neon Postgres, pooled connection string.
- Claude Code as the agent runtime. No Anthropic SDK code in the server.
- Python scripts in `data_discovery/scripts/` stay as the offline data loaders.
- No payments, no live scraping on stage. Existing auth and organisation scaffold
  stays out of every route a judge can reach.

## 10. Risks

- **Idle agents burn turns.** Each `wait` is one turn. 60 turns at 20 seconds is about
  20 minutes of life. Start suppliers no earlier than ten minutes before going on.
- **Cold starts.** Vercel and Neon both sleep. Hit the site and the MCP endpoint two
  minutes before.
- **An agent proposes outside its limit.** The tool returns "outside your limit" and
  the agent retries. If it loops, the turn cap ends it. Rehearse that the prompts
  make agents move in sensible steps.
- **Thread never converges.** Seven move cap guarantees an end. If every thread
  abandons in rehearsal, lower the walk-away factor or raise the 0.6 anchor.
- **Headless flags.** Verify `claude -p` with `--mcp-config` and `--allowedTools`
  against the installed version in the first ten minutes.
- **Seed quality.** Some candidates have absurd medians (a €2bn WB Electronics award
  on the UAS listing). The thread floor rule filters them; the plate carrier listing
  is the demo path and its three personas are sane.
- **Multilingual notices.** The buyer agent writes the need in English; the UI shows
  the original title beside it.

## 11. Deliberately left out

Scoring formula, price bands, BAFO in any form, award and accept award steps,
deadlines, server side runner, mock suppliers, supplier memory across sessions,
consortium teaming, e-Zamówienia and NSPA in Postgres, the full 47k notice load.
Each was cut because it added a state, a tool or a failure mode the judge never sees.
First to add back if time remains: the full open notice table so `search_listings`
has 701 rows instead of 6, then message digit stripping.

`docs/negotiation-flow.html` describes the previous design (runner, BAFO) and is
stale.
