"""Cross-source analysis over the unified tables (run build_unified.py first).

Usage (from data_discovery/):
    python -I -X utf8 scripts/analyze_all.py --data data/raw/staging
"""
import argparse
import datetime as dt

import pandas as pd


def pct(a, b):
    return f"{100 * a / b:.1f}%" if b else "n/a"


def eur(v):
    return f"€{v / 1e9:.2f}bn" if abs(v) >= 1e9 else f"€{v / 1e6:.1f}m"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    d = args.data
    today = pd.Timestamp(dt.date.today())
    n = pd.read_csv(f"{d}/all_notices.csv", low_memory=False, dtype={"main_cpv": str, "cpv_codes": str})
    sa = pd.read_csv(f"{d}/supplier_awards.csv", low_memory=False, dtype={"main_cpv": str, "winner_id": str})
    sup = pd.read_csv(f"{d}/suppliers.csv", low_memory=False, dtype={"registry_id": str})
    eda = pd.read_csv(f"{d}/eda_defence_data_national.csv")
    n["deadline_ts"] = pd.to_datetime(n.deadline_date, errors="coerce")

    print("== 1. LIVE DEMAND: open defence tenders by source (deadline >= today)")
    op = n[n.is_open & n.defence]
    print(op.groupby("source").agg(open=("source_id", "size"), with_value=("estimated_value_eur", "count"),
                                   value=("estimated_value_eur", "sum")).to_string())
    print(f"total open defence opportunities: {len(op):,}; closing within 14 days: "
          f"{(op.deadline_ts <= today + pd.Timedelta(days=14)).sum():,}")
    print("by buyer country:", op.buyer_country.value_counts().head(12).to_dict())
    nspa = n[n.source.eq("nspa")]
    print(f"NSPA pipeline: {nspa.is_open.sum()} open RFPs + "
          f"{(nspa.notice_type.eq('prior_info') & nspa.deadline_ts.isna()).sum()} future-business notices (all-time in sample)")

    print("\n== 2. SUPPLY: who wins defence work")
    ds = sup[sup.n_defence_awards > 0]
    print(f"suppliers with >=1 defence award: {len(ds):,}  (in >1 source: {ds.sources.str.contains(';').sum():,})")
    print("by country:", ds.country.value_counts().head(12).to_dict())
    print(f"sell across borders at least once: {pct(ds.sells_abroad.sum(), len(ds))}")
    # concentration over defence awards only, excluding press-release package totals
    dv = sa[sa.defence.astype(str).str.lower().eq("true") & ~sa.source.isin(["mon_govpl_news", "agencja_uzbrojenia_www"])]
    conc = dv.groupby("supplier_key").value_eur.sum().sort_values(ascending=False)
    tv = conc.sum()
    print(f"value concentration: top 1% of defence suppliers hold {pct(conc.head(len(conc) // 100).sum(), tv)} "
          f"of attributed defence award value ({eur(tv)}); top 10 hold {pct(conc.head(10).sum(), tv)}")
    print("one-off winners (1 defence award):", pct((ds.n_defence_awards == 1).sum(), len(ds)))

    print("\n== 3. POLAND: national (BZP) vs EU (TED) supplier pools")
    pl = sa[(sa.winner_country == "POL") & sa.defence.astype(str).str.lower().eq("true")]
    bzp_keys = set(pl[pl.source == "ezamowienia_bzp"].supplier_key)
    ted_keys = set(pl[pl.source == "TED"].supplier_key)
    print(f"Polish defence suppliers: BZP-only {len(bzp_keys - ted_keys):,} | TED-only {len(ted_keys - bzp_keys):,} | "
          f"both {len(bzp_keys & ted_keys):,}")
    abroad = set(sa[(sa.winner_country == "POL") & sa.cross_border].supplier_key)
    print(f"Polish defence suppliers that ever won abroad: {len((bzp_keys | ted_keys) & abroad):,} "
          f"of {len(bzp_keys | ted_keys):,} ({pct(len((bzp_keys | ted_keys) & abroad), len(bzp_keys | ted_keys))})")
    bz = n[n.source.eq("ezamowienia_bzp") & n.defence]
    print("BZP defence buyers (top):", bz.buyer_name.str.upper().value_counts().head(8).to_dict())
    print("BZP defence CPV divisions:", bz.main_cpv.str[:2].value_counts().head(10).to_dict())

    print("\n== 4. SPEND vs VISIBLE PROCUREMENT (EDA defence data x TED awards)")
    tot = eda[eda.metric == "total_defence_expenditure"].pivot_table(index="country_code", columns="year", values="value")
    inv = eda[eda.metric == "defence_investment"].pivot_table(index="country_code", columns="year", values="value")
    eu_tot = tot.sum()
    print("EU27 total defence expenditure (EUR bn):", (eu_tot[[2021, 2022, 2023, 2024, 2025]] / 1e3).round(1).to_dict())
    ted_aw = n[n.source.eq("TED") & n.defence & n.notice_type.eq("award")].copy()
    ted_aw["year"] = ted_aw.publication_date.str[:4].astype(int)
    vis = ted_aw[ted_aw.year == 2025].groupby(ted_aw.buyer_country.str[:3]).award_value_eur.sum() / 1e6
    iso3_to2 = {"AUT": "AT", "BEL": "BE", "BGR": "BG", "HRV": "HR", "CYP": "CY", "CZE": "CZ", "DNK": "DK",
                "EST": "EE", "FIN": "FI", "FRA": "FR", "DEU": "DE", "GRC": "EL", "HUN": "HU", "IRL": "IE",
                "ITA": "IT", "LVA": "LV", "LTU": "LT", "LUX": "LU", "MLT": "MT", "NLD": "NL", "POL": "PL",
                "PRT": "PT", "ROU": "RO", "SVK": "SK", "SVN": "SI", "ESP": "ES", "SWE": "SE"}
    vis.index = vis.index.map(iso3_to2)
    vis = vis[vis.index.notna()]
    cmp = pd.DataFrame({"investment_2025_eur_m": inv.get(2025), "ted_awards_2025_eur_m": vis}).dropna()
    if not cmp.empty:
        cmp["visible_share"] = (cmp.ted_awards_2025_eur_m / cmp.investment_2025_eur_m).map("{:.0%}".format)
        print(cmp.sort_values("investment_2025_eur_m", ascending=False).head(15).round(0).to_string())
        print(f"EU27: TED-visible defence awards 2025 = {eur(cmp.ted_awards_2025_eur_m.sum() * 1e6)} vs "
              f"defence investment {eur(cmp.investment_2025_eur_m.sum() * 1e6)}")

    print("\n== 5. MATCHABILITY: open defence tenders with a ready shortlist of past winners (same CPV group)")
    sa["cpv5"] = sa.main_cpv.str[:5]
    pool = sa[sa.defence.astype(str).str.lower().eq("true")].groupby("cpv5").supplier_key.nunique()
    opc = op[op.main_cpv.notna()].assign(cpv5=lambda x: x.main_cpv.str[:5])
    opc = opc.assign(cands=opc.cpv5.map(pool).fillna(0))
    print(f"open defence tenders with a CPV: {len(opc):,}; with >=5 past winners in same CPV group: "
          f"{pct((opc.cands >= 5).sum(), len(opc))}; median shortlist {opc.cands.median():.0f}")
    print(f"open tenders without CPV (need text/LLM classification): {op.main_cpv.isna().sum():,} "
          f"(mostly {op[op.main_cpv.isna()].source.value_counts().index[0] if op.main_cpv.isna().any() else '-'})")


if __name__ == "__main__":
    main()
