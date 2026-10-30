# Building the common format from TED

The common format is one SQLite file, `data/processed/market.db`, with three data tables and two runtime tables:

- **`tenders`**: the demand side.
- **`suppliers`**: the supply side.
- **`awards`**: who won what, for whom, at what price. This is the evidence that connects suppliers to the kinds of work they do.
- **`messages`** and **`deals`**: empty runtime tables for the agents to write into.

Today only TED feeds it. Section 9 covers how to plug in other sources.

```
TED API ─ fetch_ted.py ──────► data/raw/ted/YYYY-MM/page_NNNN.json.gz     raw API pages, per month
ECB     ─ fetch_ecb_fx.py ───► data/raw/staging/ecb_fx_rates.csv         EUR conversion
        ─ normalize_ted.py ──► data/raw/staging/ted_notices.csv           one row per notice
                               data/raw/staging/ted_award_winners.csv     one row per (award, winner)
        ─ build_db.py ───────► data/processed/market.db                   the common format
        ─ match.py ──────────► supplier shortlist for a tender
```

Run all commands from `data_discovery/` (see README). A full rebuild from raw takes about a minute.

---

## 1. Target schema (`build_db.py`)

**`tenders`**: one row per procurement procedure that is (or was) open for bids.

| column | meaning |
| --- | --- |
| `id` | `ted:<publication-number>`, e.g. `ted:740343-2026` |
| `source`, `url` | `ted`, link to the notice on ted.europa.eu |
| `title`, `description`, `language` | original language (24 EU languages); description truncated to 600 chars, full text at `url` |
| `buyer_name`, `buyer_country` | contracting authority; ISO-3 country |
| `cpv`, `cpv_all` | main CPV code (8 digits); all CPV codes, `;`-separated |
| `segment` | `military`, `security/police/fire` or `other (35* side-CPV)` (§4.7) |
| `procedure` | `open`, `restricted`, `neg-w-call`, `neg-wo-call`, `comp-dial`, … (TED codes) |
| `value_eur` | buyer's estimate in EUR, or NULL (only ~43% publish one) |
| `published`, `deadline`, `deadline_kind` | ISO dates; `deadline_kind` = `tender` or `request_to_participate` |

`open_tenders` is a view: `SELECT * FROM tenders WHERE deadline >= date('now')`. Status is computed at query time, so it never goes stale.

**`suppliers`**: every organisation that has won at least one TED award.

| column | meaning |
| --- | --- |
| `id` | `<ISO3>:<registry id>` (e.g. `POL:6630002096`), or `<ISO3>:name:<NORMALIZED NAME>` when no usable id exists (§5.3) |
| `name`, `country`, `city`, `size` | most frequent spelling; `size` = `micro`/`small`/`medium`/`large`/`sme` when declared |
| `n_awards`, `total_value_eur` | track record |
| `top_cpvs` | up to 5 most frequent main CPVs won, `;`-separated (the supplier's capability profile) |
| `first_award`, `last_award` | ISO dates |

**`awards`**: one row per (award notice, winning supplier).

| column | meaning |
| --- | --- |
| `notice_id` | `ted:<publication-number>` of the award notice |
| `supplier_id` | → `suppliers.id` |
| `buyer_name`, `buyer_country`, `cpv`, `segment`, `title` | what was bought, by whom |
| `value_eur` | notice total ÷ number of winners (TED gives no per-winner value we can align reliably) |
| `n_bids` | tenders received (max over lots); `1` means no competition |
| `date` | publication date of the award notice |

**`messages`** (`tender_id, sender, recipient, kind, body JSON, created_at`) and **`deals`** (`tender_id, supplier_id, price_eur, terms JSON, rationale, closed_at`) are empty. The market-maker agents write to them.

---

## 2. Step 1: Fetch (`fetch_ted.py`)

**API.** `POST https://api.ted.europa.eu/v3/notices/search` is anonymous and needs no key. Request body:

```json
{
  "query": "(classification-cpv IN (35000000) OR legal-basis IN (32009L0081)) AND publication-date>=20261001 AND publication-date<=20261031",
  "fields": [
    "publication-number",
    "notice-type",
    "title-proc",
    "buyer-name",
    "..."
  ],
  "limit": 250,
  "scope": "ALL",
  "paginationMode": "ITERATION"
}
```

**Scope.**

- `classification-cpv IN (35000000)` matches all descendants: 35*, i.e. security, fire-fighting, police and defence equipment.
- `legal-basis IN (32009L0081)` is the Defence & Security Directive. It catches defence buyers purchasing outside CPV 35 (vehicles, maintenance, IT, construction).
- Together they give 47,737 notices since 2024-01, about 1,400–1,700 a month.

**Fields.** The full list is `FIELDS` in `fetch_ted.py`. The API supports about 1,830 fields. To list them, request a nonexistent field: the 400 error names every valid one.

**Pagination.**

- Use `ITERATION` and follow `iterationNextToken` until no notices come back. `PAGE_NUMBER` mode stops at 15,000 results.
- `limit` max is 250.

**Rate limit.** The API returns `429` after about 10 rapid calls. The fetcher waits 2 s between calls and backs off on 429/5xx.

**Storage.**

- Pages are saved as `data/raw/ted/YYYY-MM/page_NNNN.json.gz` (≈230 KB each, 42 MB in total), with a `_complete` marker per month.
- Re-running skips completed months but always re-fetches the current month. To refresh daily, run `fetch_ted.py --since <this month>`.

---

## 3. What a raw TED record looks like

```json
{
  "publication-number": "740343-2026",
  "notice-type": "cn-standard",
  "form-type": "competition",
  "procedure-type": "restricted",
  "legal-basis": ["32009L0081"],
  "official-language": ["EST"],
  "buyer-name": { "est": ["Riigi Kaitseinvesteeringute Keskus"] },
  "buyer-city": { "mul": ["Tallinn"] },
  "buyer-country": ["EST"],
  "title-proc": {
    "est": "40mm, 23mm relvade ning 76mm, 40mm ja 23mm laskemoona ostmine koos elutsükli tagamisega"
  },
  "main-classification-proc": ["35331000"],
  "classification-cpv": ["35331000", "35320000", "35331000", "..."],
  "estimated-value-proc": "195000000.00",
  "estimated-value-cur-proc": "EUR",
  "estimated-value-lot": [
    "85000000.00",
    "30000000.00",
    "30000000.00",
    "25000000.00",
    "25000000.00"
  ],
  "deadline-receipt-request-date-lot": [
    "2026-12-03+02:00",
    "2026-12-03+02:00",
    "..."
  ],
  "framework-agreement-lot": ["fa-mix", "fa-mix", "..."],
  "publication-date": "2026-10-26+01:00"
}
```

Fields that don't apply are omitted. There are three shapes to handle:

- **scalars**, e.g. `procedure-type`;
- **multilingual dicts** `{lang: value | [values]}`;
- **per-lot or per-organisation arrays**.

---

## 4. Step 2: Normalize (`normalize_ted.py`)

| # | TED quirk | Rule |
| --- | --- | --- |
| 4.1 | Multilingual dicts (`title-proc`, `description-proc`, `buyer-name`, `winner-name`, `buyer-city` with key `mul`) | Take the first (original-language) entry. Its key becomes `language`. Translating to English is left to the LLM layer. |
| 4.2 | Per-lot arrays repeat values (`classification-cpv`, `contract-nature`, …) | De-duplicate, keep order. Main CPV = `main-classification-proc[0]`. |
| 4.3 | Notice kinds | `form-type` → `competition`=**tender**, `result`=**award**, `planning`=prior_info, `dir-awa-pre`=direct_award_notice, `cont-modif`=modification, `consultation`. |
| 4.4 | Two kinds of deadline | Open procedures use `deadline-receipt-tender-date-lot`. Restricted and negotiated procedures (75% of military tenders, 37% overall) use `deadline-receipt-request-date-lot`. `deadline` = latest lot date (date part only); `deadline_kind` says which kind. |
| 4.5 | Values | Estimate = `estimated-value-proc` (+`-cur-proc`), else the sum of `estimated-value-lot`. Award = `total-value` (+`total-value-cur`). Both are converted to EUR with ECB rates (`ecb_fx_rates.csv`; BGN/HRK at their fixed rates). Anything above **€2.5bn** is flagged `value_suspect` and dropped downstream. Example: a Greek municipality keyed in €1.07 trillion. |
| 4.6 | Competition | `received-submissions-type-code` and `-val` are parallel lists, repeated per lot. Sum the `tenders` codes, and keep the max per lot; `n_bids` uses the max. `t-sme`, `t-oth-eea` and `t-no-eea` give SME, foreign-EU and non-EU bid counts. |
| 4.7 | CPV 35* is noisy (fire brigades, police, CCTV) | `segment` = **military** if the Defence Directive applies, OR any CPV starts with 353–357 / 358113 / 35812 / 35813 / 358151 (weapons, vehicles, ships, aircraft, military electronics, combat uniforms, helmets, body armour), OR the buyer name matches the multilingual `MIL_BUYER` regex (ministries of defence, armed forces units, DGA, BAAINBw, Agencja Uzbrojenia, FMV, …). Else **security/police/fire** if CPV 351/352. Else **other**. |
| 4.8 | Winners don't line up | `winner-name` is listed **per lot result**, with repeats. `winner-country`, `-city`, `-identifier` and `-size` are listed **per organisation**. After de-duplicating names: if they line up 1:1 with the org lists, zip them (`attribution=zipped`; `exact` if there's only one winner). If they don't, keep only attributes shared by all winners (`uniform`). |

Outputs:

- `ted_notices.csv`: 21 common columns + TED extras + `*_eur`, `segment`, `value_suspect`, `deadline_kind`, `is_open`.
- `ted_award_winners.csv`.

---

## 5. Step 3: Build (`build_db.py`)

### 5.1 `tenders`

- Rows with `notice_type == tender`.
- Suspect values become NULL.
- Descriptions are truncated to 600 chars.

### 5.2 Remove republished duplicates

TED re-issues the _full_ notice for every correction, under a new publication number. 8,274 of the 24,944 tender notices repeat an earlier buyer and title, with a median gap of 20 days and 90% within 63 days.

Rule: within each (buyer, title) chain, keep the latest version. A gap of more than 120 days starts a new chain, so genuine yearly re-tenders survive. Result: 17,095 tenders, 701 open, and no duplicates among the open ones.

### 5.3 Supplier identity

The same company appears with different spellings and id formats. The supplier id is built in three steps:

1. **Registry id.** `<winner ISO3>:<normalized registry id>`. Normalizing strips labels and separators, takes the first run of 6–14 digits, and drops a 2-letter VAT prefix:
   - `NIP: 663-000-20-96` → `POL:6630002096`
   - `NL008372809B01` → `NLD:008372809`
   - `RO 15435828` → `ROU:15435828`
   - French SIRET (14 digits) or VAT (11 digits) → SIREN (9 digits)
   - UUIDs and `n_a` are discarded.
2. **No usable id.** Reuse the id of a same-country supplier whose name normalizes the same. Names are uppercased with diacritics and legal forms removed (`SP Z O O`, `GMBH`, `S R L`, `A S`, …).
3. **Otherwise.** `<ISO3>:name:<NORMALIZED NAME>`. This covers 2,753 of 12,513 suppliers. 289 have no known country, because their winner lists didn't line up (§4.8).

### 5.4 `awards` and `suppliers`

- **`awards`:** one row per winner row. `value_eur` = award total ÷ winners.
- **`suppliers`:** grouped by id: most frequent name, city and size, plus `n_awards`, `total_value_eur`, `top_cpvs` (5) and first/last award.

---

## 6. Field mapping (TED → common format)

| common column | TED field(s) | rule |
| --- | --- | --- |
| `tenders.id` | `publication-number` | `ted:` prefix |
| `title`, `description`, `language` | `title-proc`, `description-proc` | §4.1 |
| `buyer_name`, `buyer_country` | `buyer-name`, `buyer-country` | §4.1, ISO-3 kept |
| `cpv`, `cpv_all` | `main-classification-proc`, `classification-cpv` | §4.2 |
| `procedure` | `procedure-type` | as is |
| `value_eur` | `estimated-value-proc`/`-lot` + `-cur-*` | §4.5 |
| `deadline`, `deadline_kind` | `deadline-receipt-tender-date-lot`, `deadline-receipt-request-date-lot` | §4.4 |
| `segment` | `legal-basis`, `classification-cpv`, `buyer-name` | §4.7 |
| `awards.value_eur` | `total-value`, `total-value-cur` | §4.5, ÷ winners |
| `awards.n_bids` | `received-submissions-type-code`/`-val` | §4.6 |
| `suppliers.id` | `winner-identifier`, `winner-country`, `winner-name` | §5.3 |
| `suppliers.city`, `size` | `winner-city`, `winner-size` | §4.8 |

---

## 7. Worked examples

**A tender.** The raw record in §3 becomes:

```json
{
  "id": "ted:740343-2026",
  "source": "ted",
  "url": "https://ted.europa.eu/en/notice/-/detail/740343-2026",
  "title": "40mm, 23mm relvade ning 76mm, 40mm ja 23mm laskemoona ostmine koos elutsükli tagamisega",
  "language": "est",
  "buyer_name": "Riigi Kaitseinvesteeringute Keskus",
  "buyer_country": "EST",
  "cpv": "35331000",
  "cpv_all": "35331000;35320000",
  "segment": "military",
  "procedure": "restricted",
  "value_eur": 195000000.0,
  "published": "2026-10-26",
  "deadline": "2026-12-03",
  "deadline_kind": "request_to_participate"
}
```

The same tender was first published as `693937-2026` (deadline 2026-11-13) and then corrected. §5.2 keeps only this version.

**An award with three winners.**

Raw award notice `218629-2024`, from the Finnish Defence Forces (F/A-18 air-conditioning spare parts):

```json
{
  "form-type": "result",
  "procedure-type": "restricted",
  "legal-basis": ["32009L0081"],
  "buyer-name": { "fin": ["Puolustusvoimat"] },
  "main-classification-proc": ["35640000"],
  "total-value": 439670.05,
  "total-value-cur": ["EUR"],
  "winner-name": {
    "fin": [
      "Relli Tecnology Holland B.V.",
      "All Clear Aerospace & Defense, Inc",
      "Simtech, Inc"
    ]
  },
  "winner-country": ["NLD", "USA", "USA"],
  "winner-identifier": ["NL008372809B01", "U97000459", "8800573"],
  "winner-city": ["Rijswijk", "Miramar", "East Granby"],
  "received-submissions-type-code": ["tenders", "part-req"],
  "received-submissions-type-val": ["5", "13"]
}
```

This becomes three `awards` rows: `value_eur` = 439,670.05 / 3 = 146,556.68 each, and `n_bids` = 5 (13 = requests to participate). It also feeds three `suppliers`:

```json
{"id": "NLD:008372809", "name": "Relli Technology Holland B.V.", "country": "NLD", "city": "Rijswijk", "n_awards": 2, "top_cpvs": "35640000;35000000"}
{"id": "USA:97000459",  "name": "All Clear Aerospace & Defense, Inc", "country": "USA", "city": "Miramar", "n_awards": 3}
{"id": "USA:8800573",   "name": "Simtech, Inc", "country": "USA", "city": "East Granby", "n_awards": 3}
```

This notice misspells the name as "Relli _Tecnology_". The registry id merges it with the supplier's other award, and the name shown is the most frequent spelling.

---

## 8. Using it

**Open military tenders, biggest first:**

```sql
SELECT id, buyer_country, title, value_eur, deadline FROM open_tenders
WHERE segment = 'military' ORDER BY value_eur DESC NULLS LAST;
```

**Who has delivered this kind of thing.** These are the candidate suppliers for the market maker:

```sql
SELECT s.id, s.name, s.country, count(*) AS wins, round(avg(a.value_eur)) AS avg_award_eur
FROM awards a JOIN suppliers s ON s.id = a.supplier_id
WHERE substr(a.cpv, 1, 5) = substr(:tender_cpv, 1, 5)
GROUP BY s.id ORDER BY wins DESC LIMIT 20;
```

**`match.py`** ranks candidates with an explainable score:

- 10·ln(1 + awards in the same 5-digit CPV group) + 2·ln(1 + other awards in the 3-digit division)
- +3 if the supplier has supplied this buyer before; +1 if local; +1 if its typical award is within 10× the estimate; +1 if active in the last 12 months.

The log terms stop volume sellers from swamping specialists. For example, on Spain's combat-helmet tender, Schuberth and STV Group rank above uniform wholesalers.

**Price anchor for supplier agents:** use that supplier's `awards.value_eur` in the same CPV group, or the group median, scaled to the tender's `value_eur`.

---

## 9. Adding another source

**Loader contract:**

- Insert rows into `tenders` and `awards` with your own id prefix (`bzp:`, `nspa:`, …) and the same column meanings: ISO-3 countries, 8-digit CPVs, EUR values, ISO dates.
- Rebuild `suppliers` from `awards`.
- Use supplier ids `<ISO3>:<registry id>`, so a Polish company that won on TED and on BZP becomes **one** supplier. MESKO S.A. merges across 4 sources via NIP `6630002096`.

The fetchers already exist and write to `data/raw/staging/`. Per-source notes:

| source | id | mapping notes |
| --- | --- | --- |
| **e-Zamówienia (BZP)** | `bzp:<bzpNumber>` | `cpvCode` is a string like `"22200000-2 (Gazety),…"`: parse the 8-digit codes. Buyer NIP is in `organizationNationalId`. `contractors[]` lines up with `procedureResult` per part (`zawarcieUmowy` = contract signed, `uniewaznienie` = cancelled → contractor null). The supplier id is `POL:<contractorNationalId>`. `tenderId` (an OCDS id) links tender ↔ result. Dates are UTC (`…Z`). Values are PLN and mostly appear only in the notice HTML. |
| **NATO NSPA** | `nspa:<reference>` | There's no CPV. Map the NSN's first 4 digits (FSC, e.g. `1560` = airframe structural components) to a CPV or category. Buyer = NSPA (LUX) plus programme (`purchasing_org_name`). `closing_date` is local Luxembourg time with no offset. No values, and no public awards. These are the best candidates for a fully autonomous deal (one NSN, one quantity). |
| **EDA** | `eda:<reference>` | Awards come from the annual contract list. Winner VAT `BE0413652243` → `BEL:0413652243`. Buyer = EDA (BEL). |
| **Agencja Uzbrojenia / MoD news** | `au:<slug>` | Awards only. Names come without ids, so use the name-key fallback (§5.3). Values are often package totals, so keep them out of price anchors. |

---

## 10. Known gaps and next steps

- **No tender ↔ award link for TED.** Add the TED field `procedure-identifier` to `FIELDS` and re-fetch (about 15 min). That lets us link each award to its tender and track `stage` (open, closed, awarded), and gives an exact dedupe instead of §5.2.
- **Request-to-participate deadlines** were only fetched for 2026-05 onward. Older restricted tenders are closed anyway.
- **Titles are in 24 languages.** Add `title_en`, generated by the LLM for open tenders only (~700 rows).
- **CPV is coarse.** "Ammunition" mixes 9 mm sports rounds with 40 mm naval ammunition. The shortlist should be re-ranked by the LLM against the tender text and the supplier's past award titles.
- **Award values include framework ceilings** (maximum spend, not actual spend), and per-winner splits are approximate.
