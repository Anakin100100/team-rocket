#!/usr/bin/env python3
"""Fetch defence/security procurement notices from e-Zamowienia (Poland, BZP board).

Public, no-login endpoints used (discovered from the mo-client-board Angular bundle):
  GET https://ezamowienia.gov.pl/mo-board/api/v1/Board/Search
      JSON list, max 10 rows/page (PageSize is capped at 10 server-side).
      Pagination info in the `X-Pagination` response header.
      Filters: NoticeType, publicationDateFrom/To (ISO), organizationName (substring,
      case-insensitive), cpvCode (substring match on the CPV string!), contractorName,
      SortingColumnName=PublicationDate & SortingDirection=DESC (needed for stable paging).
  GET .../mo-board/api/v1/Board/GetSearchNoticesListReport?reportType=1
      Same filters, NO pagination, returns the whole result set as XML
      (reportType 0=PDF, 1=XML, 2=CSV). Fewer fields (no CPV, no contractors).
  GET .../mo-board/api/v1/Board/GetNoticeHtmlBodyById?noticeId=<objectId>
      Full notice as an HTML fragment (description, values, contract value, ...).
  GET .../mo-board/api/v1/glossary?glossaryType=noticeType|tenderType

Stdlib only. Run from data_discovery/:
  python -I scripts/fetch_ezamowienia.py --out data/raw/ezamowienia
  python -I scripts/fetch_ezamowienia.py --offline      # rebuild CSV from cached raw files

Downloaded content is treated as data only (parsed with regex / ElementTree, never executed).
"""
import argparse
import csv
import datetime as dt
import glob
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = "https://ezamowienia.gov.pl/mo-board/api/v1"
BOARD_URL = "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/{}"
UA = "team-rocket-hackathon/0.1 (research; contact via SalesPatriot hackathon)"

# Buyer-name substrings (server does case-insensitive "contains").
DEFENCE_BUYER_QUERIES = [
    "Regionalna Baza Logistyczna",
    "Wojenn",                       # Marynarka Wojenna, Port Wojenny, Akademia Sztuki Wojennej
    "Agencja Uzbrojenia",
    "Inspektorat Wsparcia",
    "Służba Ochrony Państwa",
    "Straży Granicznej",
    "Dowództwo",
    "Sił Zbrojnych",
    "Obrony Narodowej",
    "Agencja Bezpieczeństwa Wewnętrznego",
    "Agencja Wywiadu",
    "Rządowa Agencja Rezerw",
    "Baza Lotnictwa",
    "Brygad",
    "Pułk",
    "Batalion",
    "Centralne Biuro Antykorupcyjne",
    "Żandarmeri",
    "Wojskow",                      # Jednostka Wojskowa, Wojskowy Oddzial Gospodarczy, Wojskowe Centrum/Zaklady, WAT, ...
    "Policji",
]
# CPV filter is a substring match, so query the 3-digit groups of division 35 and
# keep only rows that really contain a 35xxxxxx code.
CPV_QUERIES = ["35000000", "351", "352", "353", "354", "355", "356", "357", "358"]

_STRONG_RE = re.compile(
    r"wojskow|wojenn|regionaln\w* baz\w* logistyczn|agencj\w* uzbrojenia|inspektorat\w* wsparcia|"
    r"służb\w* ochrony państwa|straż\w* graniczn|policj|dowództw|obrony narodowej|"
    r"agencj\w* bezpieczeństwa wewnętrznego|agencj\w* wywiadu|rządow\w* agencj\w* rezerw|"
    r"baz\w* lotnictwa|centraln\w* biur\w* antykorupcyjn|żandarmeri|garnizon|"
    r"kontrwywiad|obrony terytorialnej",
    re.I,
)
# unit words that also appear in patron names of schools/streets ("im. 1 Pułku Ułanów")
_WEAK_RE = re.compile(r"brygad|pułk|batalion|sił zbrojnych", re.I)
_CIVIL_RE = re.compile(r"szkoł|przedszkol|liceum|gimnazj|gmina|miasto|powiat|urząd|stowarzysz|"
                       r"fundacj|parafi|dom |kultury|bibliotek|muzeum|spółdziel|\bim\.", re.I)


def is_def_buyer(name):
    if _STRONG_RE.search(name or ""):
        return True
    return bool(_WEAK_RE.search(name or "")) and not _CIVIL_RE.search(name or "")
CPV_RE = re.compile(r"\b(\d{8}-\d)\b")

TENDER_TYPES = {"ContractNotice", "CompetitionNotice", "ConcessionNotice", "SmallContractNotice"}
AWARD_TYPES = {"TenderResultNotice", "CompetitionResultNotice", "ConcessionAgreementNotice"}
PRIOR_TYPES = {"TenderPlanNotice"}
PROC_FALLBACK = {"1.1": "tryb podstawowy", "1.2": "partnerstwo innowacyjne",
                 "1.3": "negocjacje bez ogłoszenia", "1.4": "zamówienie z wolnej ręki"}

COLUMNS = ["source", "source_id", "url", "title", "description", "buyer_name", "buyer_country",
           "buyer_city", "buyer_id", "notice_type", "procedure_type", "cpv_codes",
           "publication_date", "deadline", "estimated_value", "currency", "winner_names",
           "winner_ids", "winner_countries", "award_value", "language", "defence_relevant",
           # extras (not in the shared schema, useful for matching)
           "winner_cities", "tender_id", "procedure_result", "buyer_province", "raw_notice_type"]


class Client:
    def __init__(self, min_interval=1.0, max_requests=3000):
        self.min_interval = min_interval
        self.max_requests = max_requests
        self.n = 0
        self._last = 0.0

    def get(self, path, params, accept="application/json"):
        if self.n >= self.max_requests:
            raise RuntimeError("request budget exhausted")
        url = f"{BASE}/{path}?{urllib.parse.urlencode(params)}"
        for attempt in range(4):
            wait = self.min_interval - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            self.n += 1
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    return r.read(), dict(r.headers)
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise


def slug(s):
    a = re.sub(r"[^A-Za-z0-9]+", "_", s.encode("ascii", "ignore").decode()).strip("_")[:40]
    return f"{a}_{hashlib.md5(s.encode()).hexdigest()[:6]}"


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- fetch
def fetch_search(cl, out, label, params, max_pages=400):
    """Page through Board/Search; each page cached as one JSON file."""
    d = os.path.join(out, "search")
    os.makedirs(d, exist_ok=True)
    key = slug(label + json.dumps(params, sort_keys=True))
    page, total_pages, rows = 1, None, 0
    while True:
        fn = os.path.join(d, f"{key}__p{page:04d}.json")
        if os.path.exists(fn):
            with open(fn, encoding="utf-8") as f:
                blob = json.load(f)
        else:
            p = dict(params, PageNumber=page, PageSize=10,
                     SortingColumnName="PublicationDate", SortingDirection="DESC")
            body, hdr = cl.get("Board/Search", p)
            pag = json.loads(hdr.get("X-Pagination") or "{}")
            blob = {"query_label": label, "params": p, "pagination": pag,
                    "fetched_at": iso(dt.datetime.now(dt.timezone.utc)),
                    "items": json.loads(body.decode("utf-8"))}
            with open(fn, "w", encoding="utf-8") as f:
                json.dump(blob, f, ensure_ascii=False)
        pag = blob.get("pagination") or {}
        total_pages = pag.get("TotalPages", 0)
        rows += len(blob["items"])
        if page == 1:
            log(f"  search {label} {params.get('NoticeType','')}: total={pag.get('TotalCount')} pages={total_pages}")
        if not pag.get("HasNext") or page >= min(total_pages, max_pages) or not blob["items"]:
            break
        page += 1
    return rows


def fetch_report(cl, out, label, params):
    """Unpaginated XML listing via GetSearchNoticesListReport."""
    d = os.path.join(out, "report")
    os.makedirs(d, exist_ok=True)
    fn = os.path.join(d, f"{slug(label + json.dumps(params, sort_keys=True))}.xml")
    if not os.path.exists(fn):
        body, _ = cl.get("Board/GetSearchNoticesListReport", dict(params, reportType=1),
                         accept="application/xml")
        with open(fn, "wb") as f:
            f.write(body)
        meta = fn[:-4] + ".meta.json"
        with open(meta, "w", encoding="utf-8") as f:
            json.dump({"query_label": label, "params": params}, f, ensure_ascii=False)
    try:
        n = len(ET.parse(fn).getroot())
    except ET.ParseError:
        n = -1
    log(f"  report {label} {params.get('NoticeType','')}: rows={n}")
    return n


def fetch_detail(cl, out, object_id):
    d = os.path.join(out, "details")
    os.makedirs(d, exist_ok=True)
    fn = os.path.join(d, f"{object_id}.html")
    if os.path.exists(fn):
        return False
    body, _ = cl.get("Board/GetNoticeHtmlBodyById", {"noticeId": object_id}, accept="text/plain")
    with open(fn, "wb") as f:
        f.write(body)
    return True


# ----------------------------------------------------------------------------- parse
def html_to_text(s):
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<(h[1-6]|p|div|li|tr)\b[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s


def money(s):
    s = s.replace(" ", "").replace("\xa0", "")
    if "," in s and "." in s:
        s = s.replace(".", "")
    s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


VAL_RE = r":?\s*([0-9][0-9 \xa0.,]*[0-9])\s*([A-Z]{3})"


def parse_detail(text):
    out = {}
    m = re.search(r"Krótki opis przedmiotu zamówienia:?\s*(.+?)(?=\n\s*\d+\.\d+(?:\.\d+)*\.?\)|\n\s*Część \d|$)",
                  text, re.S)
    if m:
        out["description"] = re.sub(r"\s+", " ", m.group(1)).strip()
    m = re.search(r"w trybie (.+?) na podstawie", text)
    if m:
        out["procedure_type"] = m.group(1).strip()
    est = re.findall(r"Wartość (?:zamówienia|części)[^:\n]{0,80}" + VAL_RE, text)
    if est:
        vals = [money(v) for v, _ in est]
        vals = [v for v in vals if v is not None]
        if vals:
            out["estimated_value"] = round(sum(vals), 2)
            out["currency"] = est[0][1]
    aw = re.findall(r"Wartość umowy(?:/umowy ramowej)?[^:\n]{0,40}" + VAL_RE, text)
    if not aw:
        aw = re.findall(r"Cena lub koszt oferty wykonawcy, któremu udzielono zamówienia" + VAL_RE, text)
    if aw:
        vals = [money(v) for v, _ in aw]
        vals = [v for v in vals if v is not None]
        if vals:
            out["award_value"] = round(sum(vals), 2)
            out.setdefault("currency", aw[0][1])
    m = re.search(r"Termin składania ofert:\s*(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?", text)
    if m:
        out["deadline"] = m.group(1) + (f"T{m.group(2)}" if m.group(2) else "")
    cpvs = re.findall(r"(?:Główny kod CPV|Dodatkowy kod CPV)[^:]*:\s*(\d{8}-\d)", text)
    if cpvs:
        out["cpv_codes"] = list(dict.fromkeys(cpvs))
    return out


def build_proc_map(out):
    fn = os.path.join(out, "glossary_tenderType.json")
    mp = {}
    try:
        with open(fn, encoding="utf-8") as f:
            items = json.load(f).get("items", [])
        for it in items:
            m = re.search(r"w trybie (.+?)(?: na podstawie|$)", it.get("key", ""))
            if m:
                mp[it["identifier"]] = m.group(1).strip()
    except (OSError, ValueError, AttributeError):
        pass
    return mp or dict(PROC_FALLBACK)


def proc_from_code(code, mp):
    if not code:
        return ""
    parts = code.split(".")
    for i in range(len(parts), 0, -1):
        k = ".".join(parts[:i])
        if k in mp:
            return mp[k]
    return ""


_PROC_NORM = [("podstawow", "tryb podstawowy"), ("wolnej ręki", "zamówienie z wolnej ręki"),
              ("negocjacji bez ogłoszenia", "negocjacje bez ogłoszenia"),
              ("partnerstwa innowacyjnego", "partnerstwo innowacyjne"),
              ("przetargu nieograniczonego", "przetarg nieograniczony"),
              ("przetargu ograniczonego", "przetarg ograniczony")]


def norm_proc(p):
    for k, v in _PROC_NORM:
        if k in (p or ""):
            return v
    return p or ""


def classify(nt):
    if nt in TENDER_TYPES:
        return "tender"
    if nt in AWARD_TYPES:
        return "award"
    if nt in PRIOR_TYPES:
        return "prior_info"
    return "other"


def is_def_cpv(codes):
    return any(c.startswith("35") for c in codes)


def build_rows(out, months_cutoff=None):
    proc_map = build_proc_map(out)
    nt_map = {}
    try:
        with open(os.path.join(out, "glossary_noticeType.json"), encoding="utf-8") as f:
            for it in json.load(f):
                nt_map.setdefault(it["value"], it["key"])
    except (OSError, ValueError):
        pass

    rows = {}

    # 1) JSON search results (richest list data)
    for fn in sorted(glob.glob(os.path.join(out, "search", "*.json"))):
        with open(fn, encoding="utf-8") as f:
            blob = json.load(f)
        label = blob.get("query_label", "")
        for x in blob.get("items", []):
            if not x.get("noticeType"):          # TED mirror rows (2026/S ...) -> skip, TED handled elsewhere
                continue
            codes = CPV_RE.findall(x.get("cpvCode") or "")
            buyer = x.get("organizationName") or ""
            def_buyer = is_def_buyer(buyer)
            def_cpv = is_def_cpv(codes)
            if not (def_cpv or def_buyer):
                continue                          # substring-match noise (CPV / patron-name hits)
            cons = [c for c in (x.get("contractors") or []) if c and c.get("contractorName")]
            r = {
                "source": "ezamowienia_bzp",
                "source_id": x.get("noticeNumber", ""),
                "url": BOARD_URL.format(x["objectId"]) if x.get("objectId") else "",
                "title": (x.get("orderObject") or "").strip(),
                "description": "",
                "buyer_name": buyer.strip(),
                "buyer_country": x.get("organizationCountry") or "",
                "buyer_city": x.get("organizationCity") or "",
                "buyer_id": x.get("organizationNationalId") or "",
                "notice_type": classify(x.get("noticeType")),
                "procedure_type": norm_proc(proc_from_code(x.get("tenderType"), proc_map)),
                "cpv_codes": ";".join(dict.fromkeys(codes)),
                "publication_date": (x.get("publicationDate") or "")[:10],
                "deadline": (x.get("submittingOffersDate") or "")[:16].rstrip("Z"),
                "estimated_value": "", "currency": "",
                "winner_names": ";".join(re.sub(r"[\s,;]+$", "", c["contractorName"].replace(";", ",").strip()) for c in cons),
                "winner_ids": ";".join((c.get("contractorNationalId") or "").strip() for c in cons) if cons else "",
                "winner_countries": ";".join((c.get("contractorCountry") or "") for c in cons) if cons else "",
                "award_value": "",
                "language": "pl",
                "defence_relevant": def_buyer or def_cpv,
                "winner_cities": ";".join((c.get("contractorCity") or "").replace(";", ",").strip() for c in cons) if cons else "",
                "tender_id": x.get("tenderId") or "",
                "procedure_result": x.get("procedureResult") or "",
                "buyer_province": x.get("organizationProvince") or "",
                "raw_notice_type": x.get("noticeType"),
                "_object_id": x.get("objectId") or "",
            }
            rows[r["source_id"]] = r

    # 2) XML report rows (fill in what JSON search did not cover)
    for fn in sorted(glob.glob(os.path.join(out, "report", "*.xml"))):
        try:
            root = ET.parse(fn).getroot()
        except ET.ParseError:
            log("  bad xml", fn)
            continue
        for e in root:
            g = {c.tag: (c.text or "").strip() for c in e}
            num = g.get("NoticeNumber", "")
            if not num or num in rows:
                continue
            nt = nt_map.get(g.get("NoticeType", ""), g.get("NoticeType", ""))
            oid = g.get("Details", "").rstrip("/").split("/")[-1]
            buyer = g.get("OrganizationName", "")
            rows[num] = {
                "source": "ezamowienia_bzp", "source_id": num,
                "url": g.get("Details", ""), "title": g.get("Title", ""), "description": "",
                "buyer_name": buyer, "buyer_country": "PL", "buyer_city": g.get("OrganizationCity", ""),
                "buyer_id": "", "notice_type": classify(nt), "procedure_type": "", "cpv_codes": "",
                "publication_date": g.get("PublicationDate", "")[:10],
                "deadline": g.get("SubmittingOffersDate", "")[:16].rstrip("Z"),
                "estimated_value": "", "currency": "", "winner_names": "", "winner_ids": "",
                "winner_countries": "", "award_value": "", "language": "pl",
                "defence_relevant": is_def_buyer(buyer),
                "winner_cities": "", "tender_id": "", "procedure_result": "",
                "buyer_province": g.get("OrganizationProvince", ""), "raw_notice_type": nt,
                "_object_id": oid,
            }

    # 3) enrich from detail HTML
    for r in rows.values():
        oid = r.get("_object_id")
        fn = os.path.join(out, "details", f"{oid}.html") if oid else ""
        if not oid or not os.path.exists(fn):
            continue
        with open(fn, encoding="utf-8", errors="replace") as f:
            info = parse_detail(html_to_text(f.read()))
        if info.get("description"):
            r["description"] = info["description"][:2000]
        if not r["procedure_type"] and info.get("procedure_type"):
            r["procedure_type"] = norm_proc(info["procedure_type"])
        for k in ("estimated_value", "award_value", "currency"):
            if info.get(k) is not None and info.get(k) != "":
                r[k] = info[k]
        if not r["deadline"] and info.get("deadline"):
            r["deadline"] = info["deadline"]
        if not r["cpv_codes"] and info.get("cpv_codes"):
            r["cpv_codes"] = ";".join(info["cpv_codes"])
            if is_def_cpv(info["cpv_codes"]):
                r["defence_relevant"] = True
    return rows


def write_csv(rows, path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    data = sorted(rows.values(), key=lambda r: (r["publication_date"], r["source_id"]), reverse=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in data:
            w.writerow(r)
    return data


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/raw/ezamowienia")
    ap.add_argument("--csv", default="data/raw/staging/ezamowienia_notices.csv")
    ap.add_argument("--days", type=int, default=365, help="defence slice look-back (days)")
    ap.add_argument("--tender-json-days", type=int, default=120,
                    help="look-back for JSON (CPV/NIP-rich) tender search on big buyer queries; "
                         "older tenders come from the XML report")
    ap.add_argument("--context-days", type=int, default=30, help="broad all-buyer slice (XML report)")
    ap.add_argument("--max-details", type=int, default=150)
    ap.add_argument("--max-pages", type=int, default=300, help="max pages (x10 rows) per search query")
    ap.add_argument("--cpv-max-pages", type=int, default=60,
                    help="max pages per CPV query (substring matching makes short prefixes noisy; newest first)")
    ap.add_argument("--max-requests", type=int, default=2500)
    ap.add_argument("--interval", type=float, default=1.0, help="min seconds between requests")
    ap.add_argument("--offline", action="store_true", help="only rebuild CSV from cached raw files")
    ap.add_argument("--skip", default="", help="comma list of stages to skip: awards,cpv,tenders,report,context,details")
    a = ap.parse_args()

    out = a.out
    os.makedirs(out, exist_ok=True)
    skip = set(s for s in a.skip.split(",") if s)
    cl = Client(a.interval, a.max_requests)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.replace(hour=0, minute=0, second=0)
    d_from = iso(today - dt.timedelta(days=a.days))
    end_today = today + dt.timedelta(days=1) - dt.timedelta(seconds=1)
    d_to = iso(end_today)  # stable within a day so cached pages are reused on re-runs
    t_from = iso(today - dt.timedelta(days=a.tender_json_days))

    if not a.offline:
        try:
            for gt, extra in (("noticeType", {}), ("tenderType", {"isNested": "true"})):
                fn = os.path.join(out, f"glossary_{gt}.json")
                if not os.path.exists(fn):
                    body, _ = cl.get("glossary", dict(glossaryType=gt, **extra))
                    with open(fn, "wb") as f:
                        f.write(body)

            win = {"publicationDateFrom": d_from, "publicationDateTo": d_to}
            if "report" not in skip:
                log("== full 12-month tender listing (XML report) for defence buyers")
                for q in DEFENCE_BUYER_QUERIES:
                    fetch_report(cl, out, f"buyer:{q}", dict(win, organizationName=q, NoticeType="ContractNotice"))
            if "context" not in skip:
                log("== broad context slice, all buyers (XML report)")
                for nt in ("ContractNotice", "TenderResultNotice"):
                    for k in range(0, a.context_days, 5):
                        s = today - dt.timedelta(days=min(k + 5, a.context_days))
                        e = today - dt.timedelta(days=k) - dt.timedelta(seconds=1) if k else end_today
                        fetch_report(cl, out, f"context:{nt}",
                                     {"NoticeType": nt, "publicationDateFrom": iso(s), "publicationDateTo": iso(e)})
            if "awards" not in skip:
                log("== award notices (JSON, contractors) for defence buyers")
                for q in DEFENCE_BUYER_QUERIES:
                    fetch_search(cl, out, f"buyer:{q}", dict(win, organizationName=q, NoticeType="TenderResultNotice"), a.max_pages)
            if "cpv" not in skip:
                log("== CPV 35 groups (JSON), tenders + awards")
                for c in CPV_QUERIES:
                    for nt in ("ContractNotice", "TenderResultNotice"):
                        fetch_search(cl, out, f"cpv:{c}", dict(win, cpvCode=c, NoticeType=nt), a.cpv_max_pages)
            if "tenders" not in skip:
                log("== recent tenders (JSON) for defence buyers")
                big = {"Wojskow", "Policji"}
                for q in DEFENCE_BUYER_QUERIES:
                    f = t_from if q in big else d_from
                    fetch_search(cl, out, f"buyer:{q}",
                                 {"publicationDateFrom": f, "publicationDateTo": d_to,
                                  "organizationName": q, "NoticeType": "ContractNotice"}, a.max_pages)
            if "details" not in skip and a.max_details > 0:
                log("== notice details (HTML) for prioritised defence notices")
                rows = build_rows(out)
                today_s = today.strftime("%Y-%m-%d")
                core = re.compile(r"jednostka wojskowa|regionaln\w* baz|wojskow\w* oddział gospodarcz|"
                                  r"agencj\w* uzbrojenia|inspektorat wsparcia|wojskow\w* (?:centrum|zakład)|"
                                  r"dowództw|sił zbrojnych|wojenn|baz\w* lotnictwa|żandarmeri|"
                                  r"służb\w* ochrony państwa|straż\w* graniczn", re.I)

                def prio(r):
                    c35 = is_def_cpv(r["cpv_codes"].split(";")) if r["cpv_codes"] else False
                    is_open = r["notice_type"] == "tender" and r["deadline"][:10] >= today_s
                    corebuyer = bool(core.search(r["buyer_name"]))
                    return (not c35, not is_open, not (corebuyer and r["notice_type"] == "award"),
                            not corebuyer, r["notice_type"] != "award")
                cand = [r for r in rows.values() if r["defence_relevant"] and r.get("_object_id")
                        and r["notice_type"] in ("tender", "award")]
                cand.sort(key=lambda r: r["publication_date"], reverse=True)
                cand.sort(key=prio)
                n = 0
                for r in cand:
                    if n >= a.max_details:
                        break
                    if fetch_detail(cl, out, r["_object_id"]):
                        n += 1
                        if n % 50 == 0:
                            log(f"  details fetched: {n}")
                log(f"  details fetched this run: {n}")
        except RuntimeError as e:
            log("STOP:", e)
        except KeyboardInterrupt:
            log("interrupted; building CSV from what is cached")

    rows = build_rows(out)
    data = write_csv(rows, a.csv)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"run_at": iso(now), "window_from": d_from, "window_to": d_to,
                   "requests_this_run": cl.n, "rows": len(data),
                   "defence_rows": sum(1 for r in data if r["defence_relevant"]),
                   "endpoints": {"search": f"{BASE}/Board/Search",
                                 "report": f"{BASE}/Board/GetSearchNoticesListReport",
                                 "detail": f"{BASE}/Board/GetNoticeHtmlBodyById"}}, f, indent=1)
    log(f"requests this run: {cl.n}; rows written: {len(data)} -> {a.csv}")


if __name__ == "__main__":
    main()
