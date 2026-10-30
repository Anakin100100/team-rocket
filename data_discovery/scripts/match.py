"""Market maker, step 1: shortlist suppliers for a tender from their award track record.

Score (explainable, no ML; award counts have diminishing returns so volume sellers don't swamp specialists):
    10*ln(1 + awards in the same CPV group, first 5 digits) + 2*ln(1 + other awards in the CPV division, 3 digits)
    +3 already supplied this buyer        +1 based in the buyer's country
    +1 typical award size within 10x of the tender estimate
    +1 won something in the last 12 months

Usage (from data_discovery/):
    python -I -X utf8 scripts/match.py                       # list open military tenders with shortlist sizes
    python -I -X utf8 scripts/match.py ted:740343-2026       # shortlist for one tender
"""
import argparse
import math
import sqlite3
import statistics


def shortlist(con, tender_id, top=10):
    t = con.execute("SELECT id, title, buyer_name, buyer_country, cpv, value_eur, deadline FROM tenders WHERE id = ?",
                    (tender_id,)).fetchone()
    if not t:
        raise SystemExit(f"unknown tender {tender_id}")
    _, title, buyer, buyer_country, cpv, value, deadline = t
    rows = con.execute(
        """
        SELECT s.id, s.name, s.country, s.size, s.last_award, a.cpv, a.buyer_name, a.value_eur
        FROM awards a JOIN suppliers s ON s.id = a.supplier_id
        WHERE substr(a.cpv, 1, 3) = substr(?, 1, 3)
        """, (cpv,)).fetchall()
    cands = {}
    for sid, name, country, size, last, a_cpv, a_buyer, a_value in rows:
        c = cands.setdefault(sid, {"id": sid, "name": name, "country": country, "size": size, "last": last,
                                   "group": 0, "division": 0, "same_buyer": False, "values": []})
        if a_cpv[:5] == cpv[:5]:
            c["group"] += 1
        else:
            c["division"] += 1
        c["same_buyer"] |= a_buyer == buyer
        if a_value:
            c["values"].append(a_value)
    for c in cands.values():
        med = statistics.median(c["values"]) if c["values"] else None
        reasons, score = [], 10 * math.log1p(c["group"]) + 2 * math.log1p(c["division"])
        reasons.append(f"{c['group']} awards in CPV {cpv[:5]}*" + (f", {c['division']} in {cpv[:3]}*" if c["division"] else ""))
        if c["same_buyer"]:
            score += 3
            reasons.append("supplied this buyer before")
        if c["country"] == buyer_country:
            score += 1
            reasons.append("local")
        if med and value and value / 10 <= med <= value * 10:
            score += 1
            reasons.append(f"typical award €{med / 1e6:.2f}m fits")
        if c["last"] and c["last"] >= "2025-10-30":
            score += 1
            reasons.append("active in last 12 months")
        c.update(score=round(score, 1), median_award=med, reasons="; ".join(reasons))
    ranked = sorted(cands.values(), key=lambda c: -c["score"])[:top]
    return t, ranked, len(cands)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tender_id", nargs="?")
    ap.add_argument("--db", default="data/processed/market.db")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()
    con = sqlite3.connect(args.db)
    if not args.tender_id:
        for tid, title, country, deadline, value in con.execute(
                "SELECT id, title, buyer_country, deadline, value_eur FROM open_tenders WHERE segment = 'military' "
                "ORDER BY value_eur DESC NULLS LAST LIMIT 15"):
            _, _, n = shortlist(con, tid)
            v = f"€{value / 1e6:,.1f}m" if value else "n/a"
            print(f"{tid:18s} {country:4s} {deadline}  {v:>10s}  {n:4d} candidates  {title[:70]}")
        return
    (tid, title, buyer, country, cpv, value, deadline), ranked, n = shortlist(con, args.tender_id, args.top)
    print(f"{tid} | {buyer} ({country}) | CPV {cpv} | est. {'€%.1fm' % (value / 1e6) if value else 'n/a'} | "
          f"deadline {deadline}\n{title}\n{n} candidate suppliers; top {len(ranked)}:")
    for c in ranked:
        print(f"  {c['score']:5.1f}  {c['name'][:45]:45s} {c['country']:4s} {c['size'] or '':7s} {c['reasons']}")


if __name__ == "__main__":
    main()
