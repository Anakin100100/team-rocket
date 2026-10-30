"""Demo seed: a few curated open TED listings plus the real suppliers that match them.

Reads market.db (and the staging CSV when present, for buyer city/id, lots, framework, legal basis)
and writes data/processed/demo_seed.json in the shape of plan.md §2 and §5:

    buyers[]     id, name, country, city, legal_type, identifiers[], stats, awards[] (the buyer's own history)
    listings[]   notice + derived fields + walk_away_eur (sealed) + candidates[] (match preview, §4.2)
    suppliers[]  profile + identifiers[] + stats + offer_basis[] (per CPV class: wins, median, min, floor) + awards[]
    personas[]   per listing: the buyer and the top supplier ids to turn into agent directories (§5)

Everything comes from public TED data. Only `title_en` and `need` are written by hand.

Usage (from data_discovery/):
    python -I -X utf8 scripts/build_demo_seed.py
    python -I -X utf8 scripts/build_demo_seed.py --listings ted:686086-2026 ted:752841-2026 --top 6
"""
import argparse
import csv
import json
import math
import sqlite3
import statistics
from datetime import datetime, timezone
from pathlib import Path

DB = Path("data/processed/market.db")
STAGING = Path("data/raw/staging/ted_notices.csv")
FETCH_MARKER = Path("data/raw/ted/2026-10/_complete")
OUT = Path("data/processed/demo_seed.json")

# Hand-written English titles and a one-line structured need per curated listing.
CURATED = {
    "ted:549292-2026": {
        "title_en": "Ballistic plate carriers and add-on ballistic plates",
        "need": "Plate carriers with additional hard ballistic plates for the Slovak Prison and Court "
                "Guard, open procedure, delivery to Bratislava.",
    },
    "ted:752841-2026": {
        "title_en": "Acquisition and operational deployment of two Unmanned Aircraft Systems (UAS) "
                    "for border surveillance",
        "need": "Two complete UAS for border surveillance, including ground control, training and "
                "operational deployment for the Cyprus Police.",
    },
    "ted:615123-2026": {
        "title_en": "Framework agreement: 5.56x45 mm cartridges",
        "need": "4,020,000 rounds of 5.56x45 mm in five loadings (SS109, HPBT, XRG, FMJ, AP), "
                "framework agreement for the Czech Ministry of the Interior.",
    },
    "ted:712369-2026": {
        "title_en": "JP-90 chemical protective suits",
        "need": "Framework agreement for JP-90 NBC protective suits for the Slovak Armed Forces, "
                "with STANAG 4177 codification data.",
    },
    "ted:752151-2026": {
        "title_en": "Spare parts and tools for the 12.70 mm heavy machine gun",
        "need": "Spare parts and tooling for the 12.70 mm AMP heavy machine gun fleet of the Spanish "
                "Army, negotiated procedure with a call for competition.",
    },
    "ted:741774-2026": {
        "title_en": "Manufacture of concealed and overt bulletproof vests",
        "need": "Manufacture of discreet-wear and overt ballistic vests in two lots for the French "
                "armed forces' clothing service (PFC-RBT), framework agreement.",
    },
}

TIER_SIZE = 6
BUDGET_LO, BUDGET_HI = 0.2, 5.0          # §6.2 median award vs budget
BASE_CLIP_LO, BASE_CLIP_HI = 0.5, 1.5    # §6.3 base clipped around the budget
BAND_LO, BAND_HI = 0.85, 1.15
SIZE_SHIFT = {"micro": -0.05, "small": -0.05, "sme": -0.05, "medium": 0.0, "large": 0.05}
FLOOR_MARGIN = {"micro": 0.9, "small": 0.9, "sme": 0.9, "medium": 0.85, "large": 0.8}
DEFAULT_FLOOR_MARGIN = 0.85
FLOOR_MIN_SHARE_OF_LOW = 0.5           # keep the floor within [0.5 x low, low] so it means something
MAX_PER_COUNTRY = 2                    # demo diversity: no shortlist made of one country
RECENT_MONTHS_CUTOFF = "2025-10-30"
RECENT_AWARDS_PER_SUPPLIER = 15
RECENT_AWARDS_PER_BUYER = 15
WALK_AWAY_FACTOR = 1.10                # plan §4.3: buyer's sealed limit = published value × 1.10
PERSONA_SUPPLIERS = 3                  # plan §5: supplier agents generated per listing
EU = {"AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL",
      "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE"}
NATO_EXTRA = {"USA", "CAN", "GBR", "NOR", "ISL", "TUR", "ALB", "MNE", "MKD"}


def load_staging(ids):
    """Extra per-notice fields that market.db does not keep. Empty dict when the CSV is absent."""
    if not STAGING.exists():
        return {}
    csv.field_size_limit(10**9)
    want = {i.removeprefix("ted:") for i in ids}
    extra = {}
    with STAGING.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["source_id"] in want:
                extra[f"ted:{row['source_id']}"] = row
    return extra


def supplier_awards(con):
    by_sid = {}
    for row in con.execute(
        "SELECT supplier_id, notice_id, buyer_name, buyer_country, cpv, segment, value_eur, n_bids, date, title "
        "FROM awards WHERE cpv IS NOT NULL ORDER BY date DESC"
    ):
        by_sid.setdefault(row[0], []).append(row)
    return by_sid


def buyer_awards(con, buyer_name):
    """What this contracting authority paid before, and how many bidders it drew. Buyer persona input."""
    rows = con.execute(
        "SELECT a.notice_id, a.supplier_id, s.name, s.country, a.cpv, a.value_eur, a.n_bids, a.date, a.title "
        "FROM awards a LEFT JOIN suppliers s ON s.id = a.supplier_id "
        "WHERE a.buyer_name = ? AND a.cpv IS NOT NULL ORDER BY a.date DESC",
        (buyer_name,),
    ).fetchall()
    values = [r[5] for r in rows if r[5]]
    bids = [r[6] for r in rows if r[6]]
    stats = {
        "award_count": len(rows),
        "median_value_eur": round(statistics.median(values), 2) if values else None,
        "median_tenders_received": statistics.median(bids) if bids else None,
        "cpv_classes": sorted({r[4][:3] for r in rows}),
    }
    awards = []
    for r in rows[:RECENT_AWARDS_PER_BUYER]:
        notice = r[0].removeprefix("ted:")
        awards.append({
            "source_system": "ted",
            "external_id": notice,
            "url": f"https://ted.europa.eu/en/notice/-/detail/{notice}",
            "supplier_id": r[1],
            "supplier_name": r[2],
            "supplier_country": r[3],
            "cpv": r[4],
            "value_eur": r[5],
            "tenders_received": r[6],
            "award_date": r[7],
            "title": r[8],
        })
    return stats, awards


def offer_basis(rows, size):
    """Plan §4.3: per 3-digit CPV class the supplier has won in, what it may offer and its sealed floor.

    floor = min priced award in the class × size margin. The agent picks the ask; code rejects below floor.
    """
    by_class = {}
    for r in rows:
        by_class.setdefault(r[4][:3], []).append(r)
    margin = FLOOR_MARGIN.get(size or "", DEFAULT_FLOOR_MARGIN)
    basis = []
    for cls, cls_rows in by_class.items():
        values = [r[6] for r in cls_rows if r[6]]
        if not values:
            continue
        basis.append({
            "cpv_class": cls,
            "cpv_codes": sorted({r[4] for r in cls_rows}),
            "wins": len(cls_rows),
            "median_value_eur": round(statistics.median(values), 2),
            "min_value_eur": round(min(values), 2),
            "floor_eur": round(min(values) * margin, 2),
            "last_award_date": max((r[8] for r in cls_rows if r[8]), default=None),
            "example_title": cls_rows[0][9],
        })
    basis.sort(key=lambda b: (-b["wins"], b["cpv_class"]))
    return basis


def stats_for(rows):
    values = [r[6] for r in rows if r[6]]
    dates = [r[8] for r in rows if r[8]]
    return {
        "win_count": len(rows),
        "median_value_eur": round(statistics.median(values), 2) if values else None,
        "min_value_eur": round(min(values), 2) if values else None,
        "last_award_date": max(dates) if dates else None,
        "cpv_classes": sorted({r[4][:3] for r in rows}),
        "defence_directive_awards": sum(1 for r in rows if r[5] == "military"),
    }


def tier_of(cpv, listing_cpv):
    if cpv[:3] == listing_cpv[:3]:
        return 1
    if cpv[:2] == listing_cpv[:2]:
        return 2
    if cpv.startswith("35"):
        return 3
    return None


def eligible(country, eligibility):
    if eligibility == "any" or not country:
        return True
    if eligibility == "eu":
        return country in EU
    return country in EU or country in NATO_EXTRA


def price_band(sup, matched_values, budget):
    """Plan §6.3: band and floor for one candidate. Floor is clipped into [0.5 x low, low]."""
    med, lowest = statistics.median(matched_values), min(matched_values)
    base = min(max(med, BASE_CLIP_LO * budget), BASE_CLIP_HI * budget) if budget else med
    size = sup["size"] or ""
    shift = SIZE_SHIFT.get(size, 0.0)
    price_low = round(base * (BAND_LO + shift), 2)
    price_high = round(base * (BAND_HI + shift), 2)
    raw_floor = lowest * FLOOR_MARGIN.get(size, DEFAULT_FLOOR_MARGIN)
    floor = round(min(max(raw_floor, FLOOR_MIN_SHARE_OF_LOW * price_low), price_low), 2)
    return med, price_low, price_high, floor


def score(group_wins, class_wins, same_buyer, local, last_award):
    """match.py formula: log-scaled wins so volume sellers do not swamp specialists."""
    pts = 10 * math.log1p(group_wins) + 2 * math.log1p(class_wins)
    pts += 3 if same_buyer else 0
    pts += 1 if local else 0
    pts += 1 if last_award and last_award >= RECENT_MONTHS_CUTOFF else 0
    return round(pts, 1)


def diversify(cands, top):
    picked, per_country = [], {}
    for c in cands:
        if per_country.get(c["country"], 0) >= MAX_PER_COUNTRY:
            continue
        picked.append(c)
        per_country[c["country"]] = per_country.get(c["country"], 0) + 1
        if len(picked) == top:
            return picked
    for c in cands:  # not enough countries: fill up anyway
        if c not in picked:
            picked.append(c)
            if len(picked) == top:
                break
    return picked


def match(listing, awards_by_sid, suppliers, top):
    """Plan §6.2: tiered candidates. Within a tier, ordered by the match.py score."""
    budget = listing["estimated_value_eur"]
    lcpv = listing["main_cpv"]
    cands = []
    for sid, rows in awards_by_sid.items():
        sup = suppliers.get(sid)
        if not sup or not sup["country"] or not eligible(sup["country"], listing["eligibility"]):
            continue
        if not any(r[4].startswith("35") for r in rows):
            continue  # supply restricted to firms with at least one award in division 35
        tiers = {t for t in (tier_of(r[4], lcpv) for r in rows) if t}
        if not tiers:
            continue
        tier = min(tiers)
        matched = [r for r in rows if tier_of(r[4], lcpv) == tier]
        group = [r for r in matched if r[4][:5] == lcpv[:5]]
        priced = [r[6] for r in (group or matched) if r[6]]
        if not priced:
            continue
        st = stats_for(rows)
        if listing["security_clearance"] and st["defence_directive_awards"] == 0:
            continue
        med_all = st["median_value_eur"]
        if budget and med_all and not (BUDGET_LO * budget <= med_all <= BUDGET_HI * budget):
            continue
        same_buyer = any(r[2] == listing["buyer_name"] for r in rows)
        local = sup["country"] == listing["buyer_country"]
        med, price_low, price_high, floor = price_band(sup, priced, budget)
        cands.append({
            "supplier_id": sid,
            "country": sup["country"],
            "tier": tier,
            "wins_in_matched_cpv": len(matched),
            "wins_in_cpv_group": len(group),
            "match_score": score(len(group), len(matched) - len(group), same_buyer, local, st["last_award_date"]),
            "median_matched_award_eur": round(med, 2),
            "supplied_this_buyer_before": same_buyer,
            "local": local,
            "price_low": price_low,
            "price_high": price_high,
            "price_floor": floor,
            "open_deals_in_cpv": 0,
            "status": "invited",
        })
    cands.sort(key=lambda c: (c["tier"], -c["match_score"], -c["wins_in_matched_cpv"]))
    return diversify(cands, top)


def build_listing(t, x, fetched_at):
    lid = t["id"]
    ext = lid.removeprefix("ted:")
    buyer_ext = (x.get("buyer_id") or "").split(";")[0] or None
    buyer_id = f"ted-buyer:{buyer_ext}" if buyer_ext else f"ted-buyer:name:{t['buyer_name'].upper()}"
    buyer = {
        "id": buyer_id,
        "name": t["buyer_name"],
        "country": t["buyer_country"],
        "city": x.get("buyer_city") or None,
        "legal_type": x.get("buyer_legal_type") or None,
        "identifiers": [{"system": "ted", "external_id": buyer_ext}] if buyer_ext else [],
    }
    defence = x.get("defence_directive") == "True" or t["segment"] == "military"
    original = None
    if x.get("estimated_value"):
        original = {"amount": float(x["estimated_value"]), "currency": x["currency"]}
    listing = {
        "id": lid,
        "source_system": "ted",
        "external_id": ext,
        "url": t["url"],
        "buyer_id": buyer_id,
        "buyer_name": t["buyer_name"],
        "buyer_country": t["buyer_country"],
        "main_cpv": t["cpv"],
        "cpv_codes": (t["cpv_all"] or t["cpv"]).split(";"),
        "title": t["title"],
        "title_en": CURATED.get(lid, {}).get("title_en"),
        "need": CURATED.get(lid, {}).get("need"),
        "description": t["description"],
        "language": t["language"],
        "segment": t["segment"],
        "procedure": t["procedure"],
        "legal_basis": x.get("legal_basis") or None,
        "defence_directive": defence,
        "published": t["published"],
        "deadline": t["deadline"],
        "deadline_kind": t["deadline_kind"],
        "estimated_value_eur": t["value_eur"],
        "walk_away_eur": round(t["value_eur"] * WALK_AWAY_FACTOR, 2) if t["value_eur"] else None,
        "estimated_value_original": original,
        "n_lots": int(x["n_lots"]) if x.get("n_lots") else None,
        "framework": (x.get("framework") == "True") if x else None,
        "security_clearance": x.get("security_clearance") == "True",
        "eligibility": "eu" if defence else "any",
        "is_open": True,
        "fetched_at": fetched_at,
    }
    return buyer, listing


def build_supplier(sid, s, rows):
    _, _, rest = sid.partition(":")
    registry = None if rest.startswith("name:") else rest
    awards = []
    for r in rows[:RECENT_AWARDS_PER_SUPPLIER]:
        notice = r[1].removeprefix("ted:")
        awards.append({
            "source_system": "ted",
            "external_id": notice,
            "url": f"https://ted.europa.eu/en/notice/-/detail/{notice}",
            "buyer_name": r[2],
            "buyer_country": r[3],
            "cpv": r[4],
            "segment": r[5],
            "value_eur": r[6],
            "tenders_received": r[7],
            "award_date": r[8],
            "title": r[9],
        })
    return {
        "id": sid,
        "name": s["name"],
        "country": s["country"],
        "city": s["city"],
        "vat_id": registry,
        "size": s["size"],
        "identifiers": [{"system": "national-registry", "external_id": registry}] if registry else [],
        "stats": stats_for(rows) if rows else None,
        "offer_basis": offer_basis(rows, s["size"]),
        "awards": awards,
    }


def print_summary(listings, suppliers, out, n_buyers):
    for l in listings:
        v = f"€{l['estimated_value_eur'] / 1e6:.2f}m" if l["estimated_value_eur"] else "n/a"
        print(f"\n{l['id']}  {l['buyer_country']}  CPV {l['main_cpv']}  {v}  deadline {l['deadline']}  {l['procedure']}")
        print(f"  {l['title_en'] or l['title']}")
        budget = l["estimated_value_eur"]
        if budget:
            print(f"  published {budget:,.0f}  walk-away (sealed) {l['walk_away_eur']:,.0f}")
        cls = l["main_cpv"][:3]
        for i, c in enumerate(l["candidates"]):
            s = suppliers[c["supplier_id"]]
            flags = ("B" if c["supplied_this_buyer_before"] else "-") + ("L" if c["local"] else "-")
            basis = next((b for b in s["offer_basis"] if b["cpv_class"] == cls), None)
            floor = f"class {cls} median {basis['median_value_eur']:,.0f} floor {basis['floor_eur']:,.0f}" if basis else "no awards in this class"
            persona = "*" if i < PERSONA_SUPPLIERS else " "
            print(f"  {persona}T{c['tier']} {flags} {c['match_score']:5.1f} {c['wins_in_matched_cpv']:3d}w  {s['name'][:40]:40s} "
                  f"{s['country'] or '':4s} {s['size'] or '':6s} {floor}")
    print(f"\nwrote {out}: {len(listings)} listings, {n_buyers} buyers, {len(suppliers)} suppliers; "
          f"* = persona ({PERSONA_SUPPLIERS} suppliers per listing)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listings", nargs="*", default=list(CURATED))
    ap.add_argument("--top", type=int, default=TIER_SIZE)
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    extra = load_staging(args.listings)
    fetched_at = json.loads(FETCH_MARKER.read_text()).get("fetched_at") if FETCH_MARKER.exists() else None
    suppliers = {r["id"]: dict(r) for r in con.execute("SELECT * FROM suppliers")}
    awards_by_sid = supplier_awards(con)

    buyers, listings, used = {}, [], {}
    for lid in args.listings:
        t = con.execute("SELECT * FROM tenders WHERE id = ?", (lid,)).fetchone()
        if not t:
            raise SystemExit(f"unknown listing {lid}")
        buyer, listing = build_listing(dict(t), extra.get(lid, {}), fetched_at)
        if buyer["id"] not in buyers:
            buyer["stats"], buyer["awards"] = buyer_awards(con, buyer["name"])
            buyers[buyer["id"]] = buyer
        listing["candidates"] = match(listing, awards_by_sid, suppliers, args.top)
        for c in listing["candidates"]:
            used[c["supplier_id"]] = True
        listings.append(listing)

    out_suppliers = [build_supplier(sid, suppliers[sid], awards_by_sid.get(sid, [])) for sid in used]
    personas = [
        {
            "listing_id": l["id"],
            "buyer_id": l["buyer_id"],
            "supplier_ids": [c["supplier_id"] for c in l["candidates"][:PERSONA_SUPPLIERS]],
        }
        for l in listings
    ]
    seed = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ted_fetched_at": fetched_at,
            "source": "TED (ted.europa.eu) via data_discovery/data/processed/market.db",
            "hand_written_fields": ["listings[].title_en", "listings[].need"],
            "sealed_fields": ["listings[].walk_away_eur", "suppliers[].offer_basis[].floor_eur"],
            "match_rules": "plan.md §4.2: tier 1 same 3-digit CPV class, tier 2 same 2-digit division, "
                           "tier 3 any 35*; supplier has ≥1 award in division 35; overall median award "
                           "within 0.2×–5× budget; ordered by tier, then match.py score "
                           "(10·ln(1+wins in 5-digit group) + 2·ln(1+other wins in 3-digit class) "
                           "+3 same buyer +1 local +1 active in last 12 months); at most 2 per country",
            "limit_rules": "plan.md §4.3: buyer walk_away_eur = published estimated value × 1.10; "
                           "supplier floor_eur per CPV class = min priced award in the class × size margin "
                           "(small 0.9, medium 0.85, large 0.8). At match time the server sets the thread floor = "
                           "max(offer floor_eur, 0.6 × demand estimated_value_eur) and skips the match when that floor "
                           "exceeds walk_away_eur. All limits are sealed: stored, enforced, never returned. "
                           "candidates[].price_low/high are legacy band hints; the agent chooses its own ask",
        },
        "buyers": list(buyers.values()),
        "listings": listings,
        "suppliers": out_suppliers,
        "personas": personas,
    }
    Path(args.out).write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")
    print_summary(listings, {s["id"]: s for s in out_suppliers}, args.out, len(buyers))


if __name__ == "__main__":
    main()
