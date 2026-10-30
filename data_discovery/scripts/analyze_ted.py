"""Exploratory analysis of the normalized TED defence/security data.

Usage (from data_discovery/):
    python -I -X utf8 scripts/analyze_ted.py --data data/raw/staging
"""
import argparse

import pandas as pd

SEGMENT_CPV = {
    "351": "emergency & security equipment",
    "352": "police equipment",
    "353": "weapons & ammunition",
    "354": "military vehicles",
    "355": "warships",
    "356": "military aircraft, missiles, space",
    "357": "military electronics (C4ISR)",
    "358": "individual & support equipment",
}


def pct(a, b):
    return f"{100 * a / b:.1f}%" if b else "n/a"


def eur(v):
    return f"€{v / 1e9:.2f}bn" if v >= 1e9 else f"€{v / 1e6:.1f}m"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    n = pd.read_csv(f"{args.data}/ted_notices.csv", dtype={"main_cpv": str, "cpv_division": str, "cpv_codes": str},
                    parse_dates=["publication_date"], low_memory=False)
    # drop obviously mis-keyed values (> EUR 2.5bn) from all value sums
    for c in ("estimated_value_eur", "award_value_eur"):
        n.loc[n.value_suspect, c] = None
    w = pd.read_csv(f"{args.data}/ted_award_winners.csv", dtype={"main_cpv": str, "winner_id": str},
                    parse_dates=["publication_date"])
    n["cpv3"] = n.main_cpv.str[:3]
    w.loc[w.source_id.isin(n.loc[n.value_suspect, "source_id"]), "value_share_eur"] = None

    print(f"== Notices: {len(n):,}  ({n.publication_date.min():%Y-%m-%d} → {n.publication_date.max():%Y-%m-%d})")
    print(n.notice_type.value_counts().to_string())
    print("\n== Segment x notice type")
    print(pd.crosstab(n.segment, n.notice_type, margins=True).to_string())

    mil = n[n.segment == "military"]
    print("\n== Military: buyer countries (all notice types)")
    print(mil.buyer_country.value_counts().head(15).to_string())
    print("\n== Military: main CPV 3-digit")
    print(mil.cpv3.value_counts().head(15).rename(lambda c: f"{c} {SEGMENT_CPV.get(c, '')}").to_string())

    print("\n== Open tenders (deadline >= today)")
    op = n[n.is_open]
    print(pd.crosstab(op.segment, op.deadline_kind).to_string())
    opm = op[op.segment == "military"]
    print("military open tenders by buyer country:", opm.buyer_country.value_counts().head(12).to_dict())
    print(f"military open tenders with a value estimate: {opm.estimated_value_eur.notna().sum()} totalling {eur(opm.estimated_value_eur.sum())}")
    print(opm.sort_values("estimated_value_eur", ascending=False)[
        ["source_id", "buyer_country", "buyer_name", "title", "estimated_value_eur", "deadline"]
    ].head(15).to_string(max_colwidth=60))

    aw = n[n.notice_type == "award"]
    awm = aw[aw.segment == "military"]
    print(f"\n== Awards: {len(aw):,} (military {len(awm):,})")
    val = awm.award_value_eur
    print(f"military award value: {eur(val.sum())} across {val.notna().sum():,} notices with a value "
          f"({awm.value_suspect.sum()} suspect values excluded); median {eur(val.median())}")
    print("military award value by year:", awm.groupby(awm.publication_date.dt.year).award_value_eur.sum()
          .map(eur).to_dict())
    tr = awm.tenders_received_max_lot.dropna()
    print(f"military competition: median max-lot bids {tr.median():.0f}; single-bid awards {pct((tr == 1).sum(), len(tr))}")
    tr_all = aw.tenders_received_max_lot.dropna()
    print(f"all-35* competition: single-bid awards {pct((tr_all == 1).sum(), len(tr_all))}")
    print("procedure types (military awards):", awm.procedure_type.value_counts().head(8).to_dict())

    print("\n== Winners")
    wm = w[w.segment == "military"].copy()
    wm["name_key"] = wm.winner_name.str.upper().str.replace(r"[^\w]+", " ", regex=True).str.strip()
    print(f"military winner rows {len(wm):,}; distinct winners {wm.name_key.nunique():,}")
    known = wm[wm.winner_country.notna() & wm.buyer_country.notna()]
    cross = known[known.winner_country != known.buyer_country]
    print(f"cross-border military wins: {pct(len(cross), len(known))} of {len(known):,} with known countries")
    print("winner size mix (military):", wm.winner_size.value_counts(normalize=True).round(3).to_dict())
    top = wm.groupby("name_key").agg(wins=("source_id", "nunique"), countries=("buyer_country", "nunique"),
                                    home=("winner_country", "first"),
                                    value_eur=("value_share_eur", "sum")).sort_values("wins", ascending=False)
    print(top.head(20).to_string())
    print("\ncross-border flows (winner -> buyer), military:")
    print(cross.groupby(["winner_country", "buyer_country"]).size().sort_values(ascending=False).head(15).to_string())

    print("\n== Poland")
    pl = n[n.buyer_country.str.contains("POL", na=False)]
    print(pd.crosstab(pl.segment, pl.notice_type).to_string())
    plw = wm[wm.buyer_country.str.contains("POL", na=False)]
    print("top winners of Polish military awards:")
    print(plw.name_key.value_counts().head(12).to_string())
    print("Polish companies winning abroad (military):",
          wm[(wm.winner_country == "POL") & ~wm.buyer_country.str.contains("POL", na=False)].buyer_country
          .value_counts().to_dict())

    print("\n== Matchability: open military tenders vs. historical winners in same CPV (5-digit)")
    wm["cpv5"] = wm.main_cpv.str[:5]
    pool = wm.groupby("cpv5").name_key.nunique()
    opm = opm.assign(cpv5=opm.main_cpv.str[:5])
    opm = opm.assign(candidates=opm.cpv5.map(pool).fillna(0).astype(int))
    print(opm.candidates.describe().round(1).to_string())
    print(f"open military tenders with >=5 historical candidate suppliers: {pct((opm.candidates >= 5).sum(), len(opm))}")

    print("\n== Data quality")
    for c in ["estimated_value", "deadline", "winner_names", "winner_ids", "description", "tenders_received"]:
        sub = n if c not in ("winner_names", "winner_ids", "tenders_received") else aw
        print(f"{c:20s} filled {pct(sub[c].notna().sum(), len(sub))}")
    print("languages:", n.language.value_counts().head(12).to_dict())


if __name__ == "__main__":
    main()
