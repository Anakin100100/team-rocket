# Data discovery

This folder holds the data exploration done for the hackathon. It contains:
- downloaders for 5 European procurement sources, plus ECB exchange rates;
- a cross-source analysis;
- a minimal **TED-only common format** (`data/processed/market.db`) with a supplier matcher, which the marketplace can build on.

Data was fetched on 2026-10-30. **[COMMON_FORMAT.md](COMMON_FORMAT.md)** explains, step by step, how TED becomes the common format and how to add other sources.

## What's inside

```
data_discovery/
├── README.md               this file
├── COMMON_FORMAT.md        how to build the common format (market.db) from TED
├── .gitignore              ignores data/raw/
├── scripts/
│   ├── fetch_ted.py            ┐
│   ├── fetch_ecb_fx.py         │ core pipeline (TED only)
│   ├── normalize_ted.py        │ fetch → normalize → build → match
│   ├── build_db.py             │
│   ├── match.py                ┘
│   ├── fetch_ezamowienia.py    ┐
│   ├── fetch_nspa.py           │ other sources (working, not in the common format yet)
│   ├── fetch_eda.py            │
│   ├── fetch_agencja_uzbrojenia.py ┘
│   ├── build_unified.py        first attempt at merging every source (staging only)
│   ├── analyze_ted.py          TED deep-dive (prints findings)
│   └── analyze_all.py          cross-source findings
└── data/
    ├── raw/                    gitignored, regenerable
    │   ├── ted/2024-01 … 2026-10/page_NNNN.json.gz   raw TED API pages, one folder per month
    │   ├── ezamowienia/ nspa/ eda/ agencja_uzbrojenia/ ecb/   raw downloads per source
    │   └── staging/            flat per-source CSVs (see below)
    └── processed/
        └── market.db           THE common format: SQLite, ~27 MB, committed
```

**Run every command from this folder** (`cd data_discovery`). Only Python 3 and pandas are needed (`pypdf` too for EDA).

```sh
python -I -X utf8 scripts/fetch_ted.py --out data/raw/ted --since 2024-01        # ~15 min first run; re-run refreshes the current month
python -I -X utf8 scripts/fetch_ecb_fx.py --raw data/raw/ecb --out data/raw/staging
python -I -X utf8 scripts/normalize_ted.py --raw data/raw/ted --out data/raw/staging --fx data/raw/staging/ecb_fx_rates.csv
python -I -X utf8 scripts/build_db.py                                            # -> data/processed/market.db
python -I -X utf8 scripts/match.py                                               # open military tenders + shortlist sizes
python -I -X utf8 scripts/match.py ted:740343-2026                               # supplier shortlist for one tender
```

Other sources: `fetch_ezamowienia.py`, `fetch_nspa.py`, `fetch_eda.py` and `fetch_agencja_uzbrojenia.py`, each taking `--out data/raw/<source>`. They write their flat CSV to `data/raw/staging/`. Then run `build_unified.py --data data/raw/staging` and `analyze_all.py --data data/raw/staging`.

## Sources

| Source | What we got | How | Notes |
|---|---|---|---|
| **TED** (EU) | 47,737 defence & security notices, 2024-01 → 2026-10-30: 24,944 tenders, 19,661 awards, 38,656 award×winner rows | Anonymous v3 search API (`api.ted.europa.eu/v3/notices/search`) | Scope is CPV 35* OR Directive 2009/81/EC. Returns 429 if hammered, so 2 s between calls. **Basis of the common format.** |
| **e-Zamówienia / BZP** (PL) | 33,979 notices from the last 12 months: 12,010 defence-relevant (5,710 tenders, 6,300 awards with contractor NIP) and ~22k general context rows | Public `ezamowienia.gov.pl/mo-board/api/v1` JSON | Below-EU-threshold national procurement. PageSize is capped at 10, so bulk lists come from the XML report. The CPV filter is a substring match. `tenderId` links a tender to its result. |
| **Agencja Uzbrojenia** (PL) | 76 signed-contract records, 2024-11 → 2026-10 | MoD press releases on gov.pl, plus the AU homepage | AU's own sites (wojsko-polskie.pl/au, au-bip.wp.mil.pl) are behind an Imperva bot wall, which we did not bypass. AU *tenders* are in TED instead (145 notices). Values are often package totals. |
| **NATO NSPA** | 2,200 notices, 2025-02 → today: 1,296 RFPs (93 open) and 904 future-business notices | Public grid on `eportal.nspa.nato.int/eProcurement5G` | The www site is Cloudflare-blocked. Records have no CPV, value or end buyer. 75 have an NSN or part number in the title. Bidders need an NCAGE code and NSPA Source File registration. |
| **EDA** | 120 notices (101 awards from the 2025 contract list), plus **Defence Data 2005–2025** for EU27 | eda.europa.eu HTML, PDFs, Excel | Defence Data covers total spend, investment, equipment procurement, R&D and % of GDP per country and year. National figures sum to EDA's EU27 totals. |
| **ECB** | Euro reference FX rates for 32 currencies (2026-10-29) | `eurofxref-daily.xml` | Used for every `*_eur` value. |

### Staging files (`data/raw/staging/`, gitignored)

| File | Rows | Content |
|---|---|---|
| `ted_notices.csv` | 47,737 | one row per TED notice: common columns plus TED extras (segment, deadline_kind, tenders_received, value_suspect, …) |
| `ted_award_winners.csv` | 38,656 | one row per (award notice, winner) |
| `ezamowienia_notices.csv` | 33,979 | BZP notices with a `defence_relevant` flag and `tender_id` |
| `nspa_notices.csv` | 2,200 | NSPA RFPs and future-business notices |
| `eda_notices.csv` | 120 | EDA calls and 2025 awards |
| `agencja_uzbrojenia_notices.csv` | 76 | AU contracts from press releases |
| `eda_defence_data_national.csv`, `_eu_aggregate.csv` | 3,768 / 144 | `country, year, metric, value, unit, note` |
| `ecb_fx_rates.csv` | 32 | `currency, units_per_eur` |
| `all_notices.csv`, `supplier_awards.csv`, `suppliers.csv` | 84k / 47k / 17k | first multi-source merge (`build_unified.py`), superseded by `market.db` |

All per-source notice CSVs share 21 columns: `source, source_id, url, title, description, buyer_name, buyer_country, buyer_city, buyer_id, notice_type, procedure_type, cpv_codes, publication_date, deadline, estimated_value, currency, winner_names, winner_ids, winner_countries, award_value, language`.

## What the data says

Numbers are as of 2026-10-30. They come from `analyze_ted.py` and `analyze_all.py`.

**Demand**
- There are **653 open defence opportunities**: TED 287, BZP 271, NSPA 93, EDA 2. 443 of them close within 14 days.
- In `market.db`, after removing republished duplicates, TED has 701 open tenders, 263 of them military.
- 211 of TED's open military tenders are restricted or negotiated procedures. Firms must *request to participate* first.
- Open military tenders that publish an estimate add up to about **€1.47bn**.

**Supply**
- **10,205** suppliers have at least one defence award; 70% won only once.
- Only **8%** have ever sold across a border, and **9.4%** of TED military wins are cross-border.
- **53% of military awards on TED received a single bid.** This is the "missed" problem from the challenge brief, in numbers.
- The top 1% of suppliers hold 62% of attributed defence award value.

**Poland**
- 5,468 Polish defence suppliers appear in the data; **only 26 (0.5%) ever won abroad**.
- 4,557 appear only in national BZP tenders, never at EU level.
- The largest AU contracts (e.g. 13.5bn PLN for 155 mm ammunition, Borsuk IFVs) appear only in press releases, never as open tenders.

**Market size**
- EU27 defence spending went from €214bn (2021) to **€418bn (2025)**. Poland has the highest share of GDP at 4.32%.
- TED-visible defence awards in 2025 were €40.6bn, against €132.6bn of defence investment. So about **⅓** of defence investment is visible on TED; Germany shows 9% and Italy 4%.

**Matchability**
- **88%** of open defence tenders that have a CPV code also have at least 5 past winners in the same CPV group (median 32). Every RFQ starts with a real shortlist.

## Caveats

- **"Military" in TED** means any of: Directive 2009/81, a military CPV (353–357, plus combat uniforms, helmets and body armour), or a military buyer matched by a multilingual name regex. CPV 35* alone also pulls in fire brigades, police and municipal CCTV, which go to the `security/police/fire` segment.
- **Values:** award values include framework ceilings. Values above €2.5bn are flagged as suspect and excluded; for example, one Greek municipality keyed in €1.07 trillion. AU/MoD press values are often package totals. Only 43% of TED notices publish an estimate.
- **Deadlines:** request-to-participate deadlines were only fetched for May 2026 onward. Older restricted tenders have no deadline in the data, which doesn't matter because they are closed.
- **Not collected:** NSPA's main site and AU's own sites (bot protection, not bypassed); NSPA contract awards (not public); BZP CPV groups 351 and 355 (capped at 600 rows each).
- Public data only. No export-controlled, classified or customer data.
