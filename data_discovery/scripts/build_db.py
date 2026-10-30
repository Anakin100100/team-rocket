"""Build the marketplace database (SQLite) from normalized TED data.

    tenders    demand:  what buyers need (TED contract notices; open = deadline >= today)
    suppliers  supply:  who can deliver (every organisation that has won a TED award)
    awards     history: who won what, for whom, at what price (links suppliers to CPV codes)
    messages   runtime: agent conversation per tender (invite / bid / counter / accept / reject)
    deals      runtime: deals closed by the market maker

Ids are namespaced by source ("ted:740343-2026", "POL:6630002096") so other sources can be added
later as extra loaders without changing the schema.

Usage (from data_discovery/, after fetch_ted.py + normalize_ted.py):
    python -I -X utf8 scripts/build_db.py --staging data/raw/staging --db data/processed/market.db
"""
import argparse
import re
import sqlite3
import unicodedata
from pathlib import Path

import pandas as pd

SCHEMA = """
CREATE TABLE tenders (
    id            TEXT PRIMARY KEY,   -- 'ted:740343-2026'
    source        TEXT NOT NULL,      -- 'ted'
    url           TEXT,
    title         TEXT,               -- original language
    description   TEXT,               -- truncated; full notice is one API call away (url)
    language      TEXT,
    buyer_name    TEXT,
    buyer_country TEXT,               -- ISO3
    cpv           TEXT,               -- main CPV code (8 digits)
    cpv_all       TEXT,               -- ';'-separated
    segment       TEXT,               -- military | security/police/fire | other (35* side-CPV)
    procedure     TEXT,               -- open | restricted | neg-w-call | ...
    value_eur     REAL,               -- buyer's estimate, if published
    published     TEXT,               -- ISO date
    deadline      TEXT,               -- ISO date (tender or request-to-participate)
    deadline_kind TEXT
);
CREATE TABLE suppliers (
    id              TEXT PRIMARY KEY, -- 'POL:6630002096' (country:registry id) or 'POL:name:MESKO'
    name            TEXT,
    country         TEXT,
    city            TEXT,
    size            TEXT,             -- micro | small | medium | large | sme
    n_awards        INTEGER,
    total_value_eur REAL,
    top_cpvs        TEXT,             -- ';'-separated, most frequent first
    first_award     TEXT,
    last_award      TEXT
);
CREATE TABLE awards (
    notice_id     TEXT,               -- award notice 'ted:...'
    supplier_id   TEXT REFERENCES suppliers(id),
    buyer_name    TEXT,
    buyer_country TEXT,
    cpv           TEXT,
    segment       TEXT,
    value_eur     REAL,               -- notice value split equally across winners
    n_bids        INTEGER,            -- tenders received (max per lot)
    date          TEXT,
    title         TEXT
);
CREATE TABLE messages (
    id         INTEGER PRIMARY KEY,
    tender_id  TEXT REFERENCES tenders(id),
    sender     TEXT,                  -- 'market_maker' | 'buyer:<tender id>' | 'supplier:<supplier id>'
    recipient  TEXT,
    kind       TEXT,                  -- invite | bid | counter | accept | reject | info
    body       TEXT,                  -- JSON
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE deals (
    id          INTEGER PRIMARY KEY,
    tender_id   TEXT REFERENCES tenders(id),
    supplier_id TEXT REFERENCES suppliers(id),
    price_eur   REAL,
    terms       TEXT,                 -- JSON: delivery, quantities, conditions
    rationale   TEXT,                 -- why this supplier won
    closed_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_tenders_deadline ON tenders(deadline);
CREATE INDEX idx_tenders_cpv ON tenders(cpv);
CREATE INDEX idx_awards_cpv ON awards(cpv);
CREATE INDEX idx_awards_supplier ON awards(supplier_id);
CREATE INDEX idx_messages_tender ON messages(tender_id);
CREATE VIEW open_tenders AS SELECT * FROM tenders WHERE deadline >= date('now');
"""

LEGAL_FORMS = re.compile(
    r"\b(SP(OLKA)? Z O ?O|SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA|SPOLKA AKCYJNA|SP K|S A|SA|GMBH CO KG|GMBH|AG|"
    r"KG|SE|SRL|S R L|SAS|SARL|BV|B V|NV|AB|OY|OYJ|AS|A S|APS|LTD|LIMITED|PLC|INC|LLC|SPOL S R O|S R O|SPA|"
    r"S P A|SL|S L|UAB|SIA|KFT|ZRT|EOOD|OOD|AD|D O O|LDA)\b"
)


def name_key(name):
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().upper()
    s = LEGAL_FORMS.sub(" ", re.sub(r"[^A-Z0-9]+", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def norm_id(raw, country):
    """Registry/VAT id -> bare digits ('NIP: 663-000-20-96' -> '6630002096'); '' if unusable."""
    if pd.isna(raw):
        return ""
    s = re.sub(r"[\s.\-/]", "", str(raw).upper())
    m = re.search(r"([A-Z]{2})?(\d{6,14})", s)
    if not m or (len(s) >= 32 and re.fullmatch(r"[0-9A-F]+", s)):  # UUIDs are not registry ids
        return ""
    digits = m.group(2)
    if country == "FRA" and len(digits) == 14:  # SIRET -> SIREN
        digits = digits[:9]
    elif country == "FRA" and len(digits) == 11:  # FR VAT -> SIREN
        digits = digits[2:]
    return digits


def supplier_ids(w):
    """country:registry-id where known; otherwise reuse the id of a same-name supplier, else country:name:key."""
    w = w.assign(name_key=w.winner_name.map(name_key), country=w.winner_country.fillna(""))
    w["rid"] = [norm_id(i, c) for i, c in zip(w.winner_id, w.country)]
    w["supplier_id"] = (w.country + ":" + w.rid).where(w.rid != "", "")
    by_name = w[w.supplier_id != ""].groupby(["country", "name_key"]).supplier_id.agg(lambda s: s.mode()[0])
    miss = w.supplier_id == ""
    w.loc[miss, "supplier_id"] = [by_name.get((c, k), f"{c}:name:{k}") for c, k in zip(w.country[miss], w.name_key[miss])]
    return w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging", default="data/raw/staging")
    ap.add_argument("--db", default="data/processed/market.db")
    ap.add_argument("--desc-chars", type=int, default=600)
    args = ap.parse_args()

    n = pd.read_csv(f"{args.staging}/ted_notices.csv", low_memory=False,
                    dtype={"main_cpv": str, "cpv_codes": str, "source_id": str})
    w = pd.read_csv(f"{args.staging}/ted_award_winners.csv", low_memory=False,
                    dtype={"main_cpv": str, "winner_id": str, "source_id": str})

    t = n[n.notice_type == "tender"]
    # TED republishes the full notice for every correction (median gap 20 days): keep the latest version of each
    # (buyer, title) chain; a gap > 120 days starts a new chain, so genuine yearly re-tenders are kept
    t = t.sort_values("publication_date")
    gap = pd.to_datetime(t.publication_date).groupby([t.buyer_name, t.title], dropna=False).diff().dt.days
    chain = (gap.isna() | (gap > 120)).astype(int).groupby([t.buyer_name, t.title], dropna=False).cumsum()
    t = t.assign(chain=chain).drop_duplicates(["buyer_name", "title", "chain"], keep="last")
    tenders = pd.DataFrame({
        "id": "ted:" + t.source_id, "source": "ted", "url": t.url, "title": t.title,
        "description": t.description.fillna("").str[: args.desc_chars], "language": t.language,
        "buyer_name": t.buyer_name, "buyer_country": t.buyer_country, "cpv": t.main_cpv, "cpv_all": t.cpv_codes,
        "segment": t.segment, "procedure": t.procedure_type,
        "value_eur": t.estimated_value_eur.where(~t.value_suspect.astype(bool)),
        "published": t.publication_date, "deadline": t.deadline, "deadline_kind": t.deadline_kind,
    })

    suspect = set(n.loc[n.value_suspect.astype(bool), "source_id"])
    w = supplier_ids(w)
    awards = pd.DataFrame({
        "notice_id": "ted:" + w.source_id, "supplier_id": w.supplier_id, "buyer_name": w.buyer_name,
        "buyer_country": w.buyer_country, "cpv": w.main_cpv, "segment": w.segment,
        "value_eur": w.value_share_eur.where(~w.source_id.isin(suspect)),
        "n_bids": pd.to_numeric(w.tenders_received, errors="coerce"), "date": w.publication_date, "title": w.title,
    })

    g = w.assign(value=awards.value_eur.values).groupby("supplier_id")
    first = lambda s: s.dropna().mode().iloc[0] if s.notna().any() else None  # noqa: E731
    suppliers = pd.DataFrame({
        "name": g.winner_name.agg(first), "country": g.country.first(), "city": g.winner_city.agg(first),
        "size": g.winner_size.agg(first), "n_awards": g.source_id.nunique(), "total_value_eur": g.value.sum().round(0),
        "top_cpvs": g.main_cpv.agg(lambda s: ";".join(s.dropna().value_counts().index[:5])),
        "first_award": g.publication_date.min(), "last_award": g.publication_date.max(),
    }).reset_index().rename(columns={"supplier_id": "id"})

    db = Path(args.db)
    db.parent.mkdir(parents=True, exist_ok=True)
    db.unlink(missing_ok=True)
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    for name, df in (("tenders", tenders), ("suppliers", suppliers), ("awards", awards)):
        df.to_sql(name, con, if_exists="append", index=False)
    con.commit()
    open_n = con.execute("SELECT count(*) FROM open_tenders").fetchone()[0]
    con.execute("VACUUM")
    con.close()
    print(f"{db}: {len(tenders):,} tenders ({open_n:,} open), {len(suppliers):,} suppliers, {len(awards):,} awards, "
          f"{db.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
