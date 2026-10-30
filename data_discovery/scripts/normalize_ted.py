"""Flatten raw TED v3 search pages (from fetch_ted.py) into analysis-ready CSVs.

Outputs:
    <out>/ted_notices.csv         one row per notice (common schema + TED extras)
    <out>/ted_award_winners.csv   one row per (award notice, winning organisation)

Usage (from data_discovery/):
    python -I scripts/normalize_ted.py --raw data/raw/ted --out data/raw/staging
"""
import argparse
import csv
import datetime as dt
import gzip
import json
import re
from pathlib import Path

NOTICE_TYPE = {
    "competition": "tender",
    "result": "award",
    "planning": "prior_info",
    "dir-awa-pre": "direct_award_notice",
    "cont-modif": "modification",
    "consultation": "consultation",
    "change": "other",
}
DEFENCE_DIRECTIVE = "32009L0081"
VALUE_SUSPECT_EUR = 2.5e9

# Military buyers across EU languages (MoDs, procurement agencies, armed forces units)
MIL_BUYER = re.compile(
    r"(?<!la )d[ée]fen[cs]e(?! civile)|minist[eè]re des arm[ée]es|direction g[ée]n[ée]rale de l.armement|\bDGA\b|"
    r"verteidigung|bundeswehr|BAAINBw|"
    r"obrony|wojsk|agencja uzbrojenia|inspektorat wsparcia|regionalna baza logistyczna|"
    r"obrany|arm[aá]dn|ministerio de defensa|ej[ée]rcito|\barmada\b|ministero della difesa|esercito|"
    r"militar|defensie|krijgsmacht|f[öo]rsvar|puolustus|"
    r"honv[ée]d|ap[ăa]r[ăa]rii|krašto apsaugos|gynybos|aizsardzības ministrij|bruņotie spēki|"
    r"kaitsevägi|kaitseinvesteeringute|kaitseministeerium|defesa nacional|ex[ée]rcito|for[çc]a a[ée]rea|"
    r"ministry of defence|armed forces|\barmy\b|\bnavy\b|air force|\bNSPA\b|\bNATO\b|vojsk|vojen|"
    r"εθνικ[ήη]ς [άα]μυνας|στρατ|отбраната|obrane|obramb|odbrane|hadsereg",
    re.I,
)
MIL_CPV_PREFIXES = ("353", "354", "355", "356", "357", "358113", "35812", "35813", "358151")


def segment(row):
    """military | security/police/fire | other (35* side-CPV)"""
    cpvs = row["cpv_codes"].split(";")
    mil_cpv = any(c.startswith(MIL_CPV_PREFIXES) for c in cpvs)
    mil_buyer = bool(MIL_BUYER.search(row["buyer_name"]))
    if row["defence_directive"] or mil_cpv or mil_buyer:
        return "military"
    if any(c.startswith(("351", "352")) for c in cpvs):
        return "security/police/fire"
    return "other (35* side-CPV)"


NOTICE_COLS = [
    "source", "source_id", "url", "title", "description", "buyer_name", "buyer_country", "buyer_city",
    "buyer_id", "notice_type", "procedure_type", "cpv_codes", "publication_date", "deadline",
    "estimated_value", "currency", "winner_names", "winner_ids", "winner_countries", "award_value",
    "language",
    # TED extras
    "ted_notice_type", "notice_subtype", "main_cpv", "cpv_division", "contract_nature", "legal_basis",
    "defence_directive", "buyer_legal_type", "performance_countries", "framework", "security_clearance",
    "deadline_min", "deadline_kind", "is_open", "n_lots", "tenders_received", "tenders_received_max_lot", "sme_tenders",
    "foreign_eea_tenders", "non_eea_tenders", "winner_sizes", "winner_owner_nationality", "award_currency",
    "estimated_value_eur", "award_value_eur", "value_suspect", "segment",
]
WINNER_COLS = [
    "source_id", "publication_date", "segment", "buyer_name", "buyer_country", "main_cpv", "cpv_division",
    "contract_nature", "defence_directive", "procedure_type", "winner_name", "winner_id", "winner_country",
    "winner_city", "winner_size", "n_winners", "attribution", "notice_award_value", "award_currency",
    "value_share", "value_share_eur", "tenders_received", "title",
]


def first_lang(d, prefer=("eng",)):
    """TED multilingual fields are {lang: value|[values]}; return (value(s), lang)."""
    if not isinstance(d, dict) or not d:
        return None, ""
    for lang in prefer:
        if lang in d:
            return d[lang], lang
    lang = next(iter(d))
    return d[lang], lang


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def uniq(seq):
    seen, out = set(), []
    for x in seq:
        if x not in (None, "") and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def iso_date(s):
    return s[:10] if s else ""


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_eur(value, cur, fx):
    v = num(value)
    r = fx.get(cur or "")
    return round(v / r, 2) if v is not None and r else ""


def flatten(n, today, fx):
    pub = n["publication-number"]
    title, lang = first_lang(n.get("title-proc"), prefer=())
    desc, _ = first_lang(n.get("description-proc"), prefer=())
    buyer, _ = first_lang(n.get("buyer-name"), prefer=())
    city, _ = first_lang(n.get("buyer-city"), prefer=())
    winners, _ = first_lang(n.get("winner-name"), prefer=())
    cpvs = uniq(as_list(n.get("classification-cpv")))
    main_cpv = (as_list(n.get("main-classification-proc")) or cpvs or [""])[0]
    # open procedures carry a tender deadline; restricted/negotiated ones (common in defence) a request-to-participate deadline
    tender_dl = [iso_date(x) for x in as_list(n.get("deadline-receipt-tender-date-lot"))]
    request_dl = [iso_date(x) for x in as_list(n.get("deadline-receipt-request-date-lot"))]
    deadlines = sorted(tender_dl + request_dl)
    legal = uniq(as_list(n.get("legal-basis")))

    est = num(n.get("estimated-value-proc"))
    est_cur = n.get("estimated-value-cur-proc") or ""
    if est is None and n.get("estimated-value-lot"):
        lots = [num(x) for x in as_list(n.get("estimated-value-lot"))]
        est = sum(x for x in lots if x) or None
        est_cur = (as_list(n.get("estimated-value-cur-lot")) or [""])[0]

    # received-submissions-* are parallel lists: (code, value) per lot result
    codes = as_list(n.get("received-submissions-type-code"))
    vals = as_list(n.get("received-submissions-type-val"))
    subs = {}
    for c, v in zip(codes, vals):
        subs.setdefault(c, []).append(int(num(v) or 0))

    def total(code):
        return sum(subs[code]) if code in subs else ""

    form = n.get("form-type", "")
    row = {
        "source": "TED",
        "source_id": pub,
        "url": f"https://ted.europa.eu/en/notice/-/detail/{pub}",
        "title": (title or "").strip(),
        "description": (desc or "").strip()[:2000],
        "buyer_name": "; ".join(uniq(as_list(buyer))),
        "buyer_country": ";".join(uniq(as_list(n.get("buyer-country")))),
        "buyer_city": ";".join(uniq(as_list(city))),
        "buyer_id": ";".join(uniq(as_list(n.get("buyer-identifier")))),
        "notice_type": NOTICE_TYPE.get(form, "other"),
        "procedure_type": n.get("procedure-type", ""),
        "cpv_codes": ";".join(cpvs),
        "publication_date": iso_date(n.get("publication-date")),
        "deadline": deadlines[-1] if deadlines else "",
        "estimated_value": est if est is not None else "",
        "currency": est_cur,
        "winner_names": "; ".join(uniq(as_list(winners))),
        "winner_ids": ";".join(uniq(as_list(n.get("winner-identifier")))),
        "winner_countries": ";".join(uniq(as_list(n.get("winner-country")))),
        "award_value": n.get("total-value", ""),
        "language": lang,
        "ted_notice_type": n.get("notice-type", ""),
        "notice_subtype": n.get("notice-subtype", ""),
        "main_cpv": main_cpv,
        "cpv_division": main_cpv[:2],
        "contract_nature": ";".join(uniq(as_list(n.get("contract-nature")))),
        "legal_basis": ";".join(legal),
        "defence_directive": DEFENCE_DIRECTIVE in legal,
        "buyer_legal_type": ";".join(uniq(as_list(n.get("buyer-legal-type")))),
        "performance_countries": ";".join(uniq(as_list(n.get("place-of-performance-country-proc")))),
        "framework": any(x != "none" for x in as_list(n.get("framework-agreement-lot"))),
        "security_clearance": "true" in as_list(n.get("security-clearance-lot")),
        "deadline_min": deadlines[0] if deadlines else "",
        "deadline_kind": "request_to_participate" if request_dl and not tender_dl else ("tender" if tender_dl else ""),
        "is_open": bool(deadlines) and form == "competition" and deadlines[-1] >= today,
        "n_lots": len(as_list(n.get("framework-agreement-lot"))) or "",
        "tenders_received": total("tenders"),
        "tenders_received_max_lot": max(subs["tenders"]) if "tenders" in subs else "",
        "sme_tenders": total("t-sme"),
        "foreign_eea_tenders": total("t-oth-eea"),
        "non_eea_tenders": total("t-no-eea"),
        "winner_sizes": ";".join(uniq(as_list(n.get("winner-size")))),
        "winner_owner_nationality": ";".join(uniq(as_list(n.get("winner-owner-nationality")))),
        "award_currency": (as_list(n.get("total-value-cur")) or [""])[0],
    }
    row["estimated_value_eur"] = to_eur(row["estimated_value"], row["currency"], fx)
    row["award_value_eur"] = to_eur(row["award_value"], row["award_currency"], fx)
    # a handful of notices carry obvious data-entry errors (e.g. EUR 1.07 trillion for a municipal IT project)
    row["segment"] = segment(row)
    row["value_suspect"] = any(v != "" and v > VALUE_SUSPECT_EUR for v in (row["estimated_value_eur"], row["award_value_eur"]))
    return row, winner_rows(n, row, as_list(winners))


def winner_rows(n, row, names):
    """One row per winning organisation.

    winner-name is listed per lot result (with repeats) while winner-country/-city/-identifier/-size
    are listed per organisation. When the de-duplicated names line up 1:1 with the organisation lists
    we zip them ("exact" if there's a single winner, "zipped" otherwise); if not, the per-org
    attributes are only kept when they are identical for all winners ("uniform"), else left blank.
    """
    names = uniq(names)
    if row["notice_type"] != "award" or not names:
        return []
    orgs = {k: as_list(n.get(f"winner-{k}")) for k in ("country", "city", "identifier", "size")}
    aligned = all(len(v) in (0, len(names)) for v in orgs.values())
    attribution = "exact" if len(names) == 1 else ("zipped" if aligned else "uniform")
    val = num(row["award_value"])
    val_eur = num(row["award_value_eur"])
    out = []
    for i, name in enumerate(names):
        def pick(k):
            v = orgs[k]
            if aligned and v:
                return v[i]
            u = uniq(v)
            return u[0] if len(u) == 1 else ""
        out.append({
            "source_id": row["source_id"], "publication_date": row["publication_date"], "segment": row["segment"],
            "buyer_name": row["buyer_name"], "buyer_country": row["buyer_country"],
            "main_cpv": row["main_cpv"], "cpv_division": row["cpv_division"],
            "contract_nature": row["contract_nature"], "defence_directive": row["defence_directive"],
            "procedure_type": row["procedure_type"], "winner_name": name.strip(),
            "winner_id": pick("identifier"), "winner_country": pick("country"), "winner_city": pick("city"),
            "winner_size": pick("size"), "n_winners": len(names), "attribution": attribution,
            "notice_award_value": row["award_value"], "award_currency": row["award_currency"],
            "value_share": round(val / len(names), 2) if val else "",
            "value_share_eur": round(val_eur / len(names), 2) if val_eur else "",
            "tenders_received": row["tenders_received"], "title": row["title"][:300],
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fx", help="ecb_fx_rates.csv from fetch_ecb_fx.py (adds *_eur columns)")
    args = ap.parse_args()
    fx = {}
    if args.fx:
        with open(args.fx, encoding="utf-8") as f:
            fx = {r["currency"]: float(r["units_per_eur"]) for r in csv.DictReader(f)}
    today = dt.date.today().isoformat()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    seen, n_notices, n_winners = set(), 0, 0
    with open(out / "ted_notices.csv", "w", newline="", encoding="utf-8") as fn, \
            open(out / "ted_award_winners.csv", "w", newline="", encoding="utf-8") as fw:
        wn = csv.DictWriter(fn, NOTICE_COLS)
        ww = csv.DictWriter(fw, WINNER_COLS)
        wn.writeheader()
        ww.writeheader()
        for page in sorted(Path(args.raw).glob("*/page_*.json.gz")):
            for n in json.load(gzip.open(page, "rt", encoding="utf-8")):
                if n["publication-number"] in seen:
                    continue
                seen.add(n["publication-number"])
                row, winners = flatten(n, today, fx)
                wn.writerow(row)
                ww.writerows(winners)
                n_notices += 1
                n_winners += len(winners)
    print(f"wrote {n_notices} notices, {n_winners} winner rows to {out}")


if __name__ == "__main__":
    main()
