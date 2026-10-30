"""Merge all per-source processed CSVs into marketplace-ready tables.

Inputs (data/raw/staging): ted_notices.csv, ted_award_winners.csv, ezamowienia_notices.csv, nspa_notices.csv,
eda_notices.csv, agencja_uzbrojenia_notices.csv, ecb_fx_rates.csv

Outputs:
    all_notices.csv      every notice from every source in one schema (demand side), with defence/is_open flags
    supplier_awards.csv  one row per (award, winning supplier) across sources
    suppliers.csv        one row per supplier (supply side): what they've won, for whom, where, how much

Usage (from data_discovery/):
    python -I -X utf8 scripts/build_unified.py --data data/raw/staging
"""
import argparse
import datetime as dt
import re
import unicodedata

import pandas as pd

COMMON = [
    "source", "source_id", "url", "title", "description", "buyer_name", "buyer_country", "buyer_city",
    "buyer_id", "notice_type", "procedure_type", "cpv_codes", "publication_date", "deadline",
    "estimated_value", "currency", "winner_names", "winner_ids", "winner_countries", "award_value", "language",
]
ISO2_TO_3 = {
    "AT": "AUT", "BE": "BEL", "BG": "BGR", "HR": "HRV", "CY": "CYP", "CZ": "CZE", "DK": "DNK", "EE": "EST",
    "FI": "FIN", "FR": "FRA", "DE": "DEU", "GR": "GRC", "EL": "GRC", "HU": "HUN", "IE": "IRL", "IT": "ITA",
    "LV": "LVA", "LT": "LTU", "LU": "LUX", "MT": "MLT", "NL": "NLD", "PL": "POL", "PT": "PRT", "RO": "ROU",
    "SK": "SVK", "SI": "SVN", "ES": "ESP", "SE": "SWE", "NO": "NOR", "IS": "ISL", "LI": "LIE", "CH": "CHE",
    "GB": "GBR", "UK": "GBR", "US": "USA", "CA": "CAN", "TR": "TUR", "UA": "UKR", "IL": "ISR", "KR": "KOR",
    "JP": "JPN", "AU": "AUS", "AL": "ALB", "ME": "MNE", "MK": "MKD", "RS": "SRB", "BA": "BIH", "MD": "MDA",
}
ISO3_TO_2 = {v: k for k, v in ISO2_TO_3.items() if k not in ("EL", "UK")}
LEGAL_FORMS = re.compile(
    r"\b(SP(OLKA)? Z O ?O|SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA|SPOLKA AKCYJNA|SPOLKA KOMANDYTOWA|SP K|SP J|"
    r"S A|SA|GMBH CO KG|GMBH|AG|KG|SE|SRL|S R L|SAS|SASU|SARL|S A R L|BV|B V|NV|N V|AB|OY|OYJ|AS|A S|ASA|APS|"
    r"LTD|LIMITED|PLC|INC|LLC|CORP|SPOL S R O|S R O|SRO|A S|SPA|S P A|SL|S L|SLU|OU|AS|UAB|SIA|KFT|ZRT|NYRT|"
    r"EOOD|OOD|AD|D O O|DOO|D D|LDA|EIRL|ZOO)\b"
)


def iso3(code):
    code = str(code).strip().upper()
    return ISO2_TO_3.get(code, code) if code and code != "NAN" else ""


def norm_countries(s):
    return ";".join(dict.fromkeys(iso3(c) for c in str(s).split(";") if iso3(c))) if pd.notna(s) else ""


def norm_cpv(s):
    """'35110000-8;18100000-0' -> '35110000;18100000'"""
    if pd.isna(s):
        return ""
    return ";".join(dict.fromkeys(c.strip()[:8] for c in str(s).split(";") if c.strip()[:8].isdigit()))


def name_key(name):
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().upper()
    s = re.sub(r"[^A-Z0-9]+", " ", s)
    s = LEGAL_FORMS.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_id(raw, country):
    """Best-effort company registry/VAT id -> bare digits (NIP, SIREN, VAT number without prefix...)."""
    if pd.isna(raw):
        return ""
    s = re.sub(r"[\s.\-/]", "", str(raw).upper())
    m = re.search(r"([A-Z]{2})?(\d{6,14})", s)
    if not m or (len(s) >= 32 and re.fullmatch(r"[0-9A-F]+", s)):  # UUIDs are not registry ids
        return ""
    digits = m.group(2)
    if country == "FRA":
        if len(digits) == 14:  # SIRET -> SIREN
            digits = digits[:9]
        elif len(digits) == 11:  # FR VAT: 2-digit key + SIREN
            digits = digits[2:]
    return digits


def load(path, **kw):
    try:
        return pd.read_csv(path, dtype=str, low_memory=False, **kw)
    except FileNotFoundError:
        print(f"  (missing {path}, skipped)")
        return pd.DataFrame(columns=COMMON)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    d = args.data
    today = dt.date.today().isoformat()
    fx = load(f"{d}/ecb_fx_rates.csv").set_index("currency").units_per_eur.astype(float).to_dict()

    def to_eur(v, cur):
        v = pd.to_numeric(v, errors="coerce")
        rate = cur.map(lambda c: fx.get(c if isinstance(c, str) and c else "EUR"))
        return (v / rate).round(2)

    # ---------- notices ----------
    ted = load(f"{d}/ted_notices.csv")
    ted["defence"] = ted.segment.eq("military")
    ezam = load(f"{d}/ezamowienia_notices.csv")
    ezam["defence"] = ezam.defence_relevant.str.lower().eq("true")
    ezam["segment"] = ezam.defence.map({True: "military/security (PL)", False: "general (PL)"})
    others = []
    for src in ("nspa", "eda", "agencja_uzbrojenia"):
        df = load(f"{d}/{src}_notices.csv")
        df["defence"] = True
        df["segment"] = "military"
        others.append(df)
    extra = ["defence", "segment", "value_suspect", "deadline_kind", "tender_id", "award_currency",
             "estimated_value_eur", "award_value_eur"]
    frames = [f.reindex(columns=COMMON + extra) for f in [ted, ezam, *others]]
    n = pd.concat(frames, ignore_index=True)
    n["buyer_country"] = n.buyer_country.map(norm_countries)
    n["winner_countries"] = n.winner_countries.map(norm_countries)
    n["cpv_codes"] = n.cpv_codes.map(norm_cpv)
    n["main_cpv"] = n.cpv_codes.str.split(";").str[0]
    n["value_suspect"] = n.value_suspect.str.lower().eq("true")
    # BZP (e-Zamówienia) values are PLN even where the currency column is blank
    bzp = n.source.eq("ezamowienia_bzp")
    n.loc[bzp, "currency"] = n.loc[bzp, "currency"].fillna("PLN")
    # TED rows already carry EUR values converted with their own (estimate vs award) currencies
    award_cur = n.award_currency.fillna(n.currency).fillna("EUR")
    n["estimated_value_eur"] = pd.to_numeric(n.estimated_value_eur, errors="coerce").fillna(
        to_eur(n.estimated_value, n.currency))
    n["award_value_eur"] = pd.to_numeric(n.award_value_eur, errors="coerce").fillna(to_eur(n.award_value, award_cur))
    n.loc[n.value_suspect, ["estimated_value_eur", "award_value_eur"]] = None
    # values parsed from MoD/AU press releases are often multi-contract package totals: keep, but flag
    n["value_from_press"] = n.source.isin(["mon_govpl_news", "agencja_uzbrojenia_www"])
    n["deadline_date"] = n.deadline.str[:10]
    n["is_open"] = n.notice_type.eq("tender") & n.deadline_date.ge(today)
    n.to_csv(f"{d}/all_notices.csv", index=False)
    print(f"all_notices.csv: {len(n):,} rows")
    print(pd.crosstab(n.source, n.notice_type).to_string())

    # ---------- supplier awards ----------
    tw = load(f"{d}/ted_award_winners.csv")
    tw = tw.assign(source="TED", defence=tw.segment.eq("military"))
    tw = tw.rename(columns={"value_share_eur": "value_eur"})
    tw.loc[tw.source_id.isin(n.loc[n.value_suspect & n.source.eq("TED"), "source_id"]), "value_eur"] = None
    tw = tw[["source", "source_id", "publication_date", "defence", "segment", "buyer_name", "buyer_country",
             "main_cpv", "winner_name", "winner_id", "winner_country", "winner_city", "winner_size", "value_eur",
             "title"]]

    rows = []
    non_ted = n[(n.source != "TED") & n.notice_type.eq("award") & n.winner_names.notna()]
    for r in non_ted.itertuples():
        names = str(r.winner_names).split(";")
        ids = str(r.winner_ids).split(";") if pd.notna(r.winner_ids) else []
        ctry = r.winner_countries.split(";") if r.winner_countries else []
        aligned_ids = len(ids) == len(names)
        aligned_ctry = len(ctry) == len(names)
        pairs = {}
        for i, nm in enumerate(names):
            nm = nm.strip()
            if not nm:
                continue
            key = (nm, ids[i].strip() if aligned_ids else "")
            pairs.setdefault(key, ctry[i] if aligned_ctry else (ctry[0] if len(set(ctry)) == 1 else ""))
        share = (r.award_value_eur / len(pairs)
                 if pairs and pd.notna(r.award_value_eur) and not r.value_from_press else None)
        for (nm, wid), c in pairs.items():
            rows.append({"source": r.source, "source_id": r.source_id, "publication_date": r.publication_date,
                         "defence": r.defence, "segment": r.segment, "buyer_name": r.buyer_name,
                         "buyer_country": r.buyer_country, "main_cpv": r.main_cpv, "winner_name": nm,
                         "winner_id": wid, "winner_country": c, "winner_city": "", "winner_size": "",
                         "value_eur": share, "title": str(r.title)[:300]})
    sa = pd.concat([tw, pd.DataFrame(rows)], ignore_index=True)
    sa["value_eur"] = pd.to_numeric(sa.value_eur, errors="coerce")
    sa["winner_country"] = sa.winner_country.map(norm_countries)
    sa["name_key"] = sa.winner_name.map(name_key)
    sa["id_norm"] = [norm_id(i, c) for i, c in zip(sa.winner_id, sa.winner_country)]
    # supplier key: country + registry id when we have one, else country + normalized name;
    # rows without an id inherit the id-key of a same-name, same-country supplier seen elsewhere
    sa["supplier_key"] = (sa.winner_country + ":" + sa.id_norm).where(sa.id_norm != "", "")
    by_name = sa[sa.supplier_key != ""].groupby(["winner_country", "name_key"]).supplier_key.agg(
        lambda s: s.value_counts().index[0])
    missing = sa.supplier_key == ""
    sa.loc[missing, "supplier_key"] = [
        by_name.get((c, k), f"{c}:name:{k}") for c, k in zip(sa.winner_country[missing], sa.name_key[missing])]
    sa["cross_border"] = [bool(w and b and w not in b.split(";"))
                          for w, b in zip(sa.winner_country, sa.buyer_country.fillna(""))]
    sa.drop(columns=["name_key"]).to_csv(f"{d}/supplier_awards.csv", index=False)
    print(f"supplier_awards.csv: {len(sa):,} rows")

    # ---------- supplier registry ----------
    sa["cpv_div"] = sa.main_cpv.str[:2]
    sa["year"] = sa.publication_date.str[:4]

    def top(s, k=5):
        s = s.dropna()
        s = s[s != ""]
        return ";".join(s.value_counts().index[:k])

    g = sa.groupby("supplier_key")
    sup = pd.DataFrame({
        "name": g.winner_name.agg(lambda s: s.value_counts().index[0]),
        "country": g.winner_country.first(),
        "registry_id": g.id_norm.agg(lambda s: top(s, 1)),
        "city": g.winner_city.agg(lambda s: top(s, 1)),
        "size": g.winner_size.agg(lambda s: top(s, 1)),
        "n_awards": g.source_id.nunique(),
        "n_defence_awards": sa[sa.defence.astype(str).str.lower() == "true"].groupby("supplier_key").source_id.nunique(),
        "sources": g.source.agg(lambda s: ";".join(sorted(set(s)))),
        "total_value_eur": g.value_eur.sum().round(0),
        "n_buyers": g.buyer_name.nunique(),
        "buyer_countries": g.buyer_country.agg(top),
        "sells_abroad": g.cross_border.any(),
        "top_cpv_divisions": g.cpv_div.agg(top),
        "top_cpvs": g.main_cpv.agg(top),
        "first_award": g.publication_date.min(),
        "last_award": g.publication_date.max(),
        "sample_titles": g.title.agg(lambda s: " | ".join(s.dropna().astype(str).str[:80].unique()[:3])),
    })
    sup["n_defence_awards"] = sup.n_defence_awards.fillna(0).astype(int)
    sup = sup.sort_values(["n_defence_awards", "n_awards"], ascending=False)
    sup.index.name = "supplier_key"
    sup.to_csv(f"{d}/suppliers.csv")
    print(f"suppliers.csv: {len(sup):,} suppliers ({(sup.n_defence_awards > 0).sum():,} with defence awards)")


if __name__ == "__main__":
    main()
