#!/usr/bin/env python3
"""Fetch public procurement notices and Defence Data statistics from the European Defence Agency (EDA).

Sources (public, no login):
  * https://eda.europa.eu/procurement/            - "Ongoing Calls For Tenders" cards (links to the EU
    Funding & Tenders portal), older cards kept as HTML comments (archived), "Other notices"
    (ex-ante publicity notices for negotiated/low-value procedures, calls for expression of interest,
    prize contests, Annual List of Contractors).
  * https://eda.europa.eu/procurement/other-notices/<slug>  - notice detail pages.
  * Annual List of Contracts / Specific Contracts PDFs (award data: reference, value, subject,
    contractor, VAT id).  PDF text extraction uses `pypdf` if it is installed (optional; skipped otherwise).
  * https://eda.europa.eu/publications-and-data/defence-data - Defence Data portal; .xlsx datasets are
    downloaded and parsed with the stdlib (zipfile + xml.etree; no openpyxl needed) into tidy CSVs.

Notes: eda.europa.eu has no robots.txt (404). It is fronted by Cloudflare, which intermittently serves a
JS challenge (HTTP 403 "Just a moment...") - we never try to solve it; we wait and retry once, then skip.

Usage (from data_discovery/):
    python -I scripts/fetch_eda.py --out data/raw/eda
"""
import argparse
import csv
import datetime as dt
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

UA = "team-rocket-hackathon/0.1 (research)"
BASE = "https://eda.europa.eu"
PROCUREMENT_URL = BASE + "/procurement/"
OTHER_NOTICES_URL = BASE + "/procurement/other-notices"
DEFENCE_DATA_URL = BASE + "/publications-and-data/defence-data"

NOTICE_COLUMNS = [
    "source", "source_id", "url", "title", "description", "buyer_name", "buyer_country",
    "buyer_city", "buyer_id", "notice_type", "procedure_type", "cpv_codes", "publication_date",
    "deadline", "estimated_value", "currency", "winner_names", "winner_ids", "winner_countries",
    "award_value", "language",
]
BUYER = {"buyer_name": "European Defence Agency (EDA)", "buyer_country": "BE", "buyer_city": "Brussels",
         "buyer_id": "EDA"}

MONTHS = {}
for i, (s, l) in enumerate(zip(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
        ["january", "february", "march", "april", "may", "june", "july", "august", "september",
         "october", "november", "december"]), 1):
    MONTHS[s] = MONTHS[l] = i
MONTHS["sept"] = 9

ISO2 = {
    "Austria": "AT", "Belgium": "BE", "Bulgaria": "BG", "Croatia": "HR", "Cyprus": "CY",
    "Czech Republic": "CZ", "Czechia": "CZ", "Denmark": "DK", "Estonia": "EE", "Finland": "FI",
    "France": "FR", "Germany": "DE", "Greece": "GR", "Hungary": "HU", "Ireland": "IE", "Italy": "IT",
    "Latvia": "LV", "Lithuania": "LT", "Luxembourg": "LU", "Malta": "MT", "Netherlands": "NL",
    "Poland": "PL", "Portugal": "PT", "Romania": "RO", "Slovakia": "SK", "Slovenia": "SI", "Spain": "ES",
    "Sweden": "SE",
}

# label (normalised) -> (metric, unit, kind) ; kind 'ratio' values are fractions converted to percent
METRICS = {
    "total defence expenditure": ("total_defence_expenditure", "EUR million", "abs"),
    "total defence expenditure as % of gdp": ("defence_expenditure_pct_gdp", "percent", "ratio"),
    "total defence expenditure as % of government expenditure": ("defence_expenditure_pct_gov_expenditure", "percent", "ratio"),
    "total defence expenditure per capita": ("defence_expenditure_per_capita", "EUR", "abs"),
    "defence investment": ("defence_investment", "EUR million", "abs"),
    "defence equipment procurement expenditure": ("defence_equipment_procurement", "EUR million", "abs"),
    "defence r&d expenditure": ("defence_rd", "EUR million", "abs"),
    "defence r&t expenditure": ("defence_rt", "EUR million", "abs"),
    "collaborative defence equipment procurement expenditure": ("collaborative_equipment_procurement", "EUR million", "abs"),
    "european collaborative defence equipment procurement expenditure": ("european_collaborative_equipment_procurement", "EUR million", "abs"),
    "collaborative defence r&t expenditure": ("collaborative_rt", "EUR million", "abs"),
    "european collaborative defence r&t expenditure": ("european_collaborative_rt", "EUR million", "abs"),
    "gdp (mrd)": ("gdp", "EUR billion", "abs"),
}
COUNTRY_NOTES = {"*": "estimate", "**": "share of GNI (not GDP) for Luxembourg",
                 "***": "figures at publication cut-off; later corrected by national authorities"}


# --------------------------------------------------------------------------- HTTP
class Client:
    def __init__(self, delay=1.1, timeout=90):
        self.delay, self.timeout, self.last = delay, timeout, 0.0

    def get(self, url, retries=1):
        for attempt in range(retries + 1):
            wait = self.delay - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                body = e.read() if hasattr(e, "read") else b""
                challenged = is_cf(e.code, body)
                if (challenged or e.code >= 500) and attempt < retries:
                    time.sleep(6)  # be patient once; never try to solve the challenge
                    continue
                return e.code, body
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < retries:
                    time.sleep(4)
                    continue
                return 0, str(e).encode()
        return 0, b""


def is_cf(status, body):
    b = body[:20000].decode("utf-8", "replace")
    return status in (403, 503) and ("Just a moment" in b or "cf_chl" in b or "challenge-platform" in b)


def text_of(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(s)


def ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def parse_date(s):
    """'12 Oct 2026' / '16 November 2026' / '04 June 2026 12:00' -> ISO date (or datetime)."""
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?", s or "")
    if not m or m.group(2).lower() not in MONTHS:
        return ""
    d = dt.date(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1))).isoformat()
    if m.group(4):
        return f"{d}T{int(m.group(4)):02d}:{m.group(5)}:00"
    return d


def save(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def slug(s, n=90):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)[:n].strip("_")


# --------------------------------------------------------------------------- procurement
def comment_spans(page):
    return [(m.start(), m.end()) for m in re.finditer(r"(?s)<!--.*?-->", page)]


def in_spans(pos, spans):
    return any(a <= pos < b for a, b in spans)


def parse_tender_cards(page):
    spans = comment_spans(page)
    out = []
    pat = re.compile(
        r"""window\.open\('([^']+)'[^>]*>\s*<span class="reference">([^<]+)</span>\s*<h3[^>]*>(.*?)</h3>(.*?)(?:</div>\s*</div>)""",
        re.S)
    for m in pat.finditer(page):
        url, ref, title, rest = html.unescape(m.group(1)), ws(m.group(2)), ws(text_of(m.group(3))), m.group(4)
        pub = re.search(r"Publication date:\s*([^<]+)<", rest)
        dl = re.search(r"Deadline:\s*([^<]+)<", rest)
        out.append({
            "reference": ref, "title": title.rstrip(". "), "url": url,
            "publication_date": parse_date(pub.group(1)) if pub else "",
            "deadline": parse_date(dl.group(1)) if dl else "",
            "archived": in_spans(m.start(), spans),
        })
    return out


def parse_other_notice_cards(page):
    out = []
    for m in re.finditer(r'(?s)<a [^>]*href="(other-notices/[^"]+)"[^>]*>(.*?)</a>', page):
        body = m.group(2)
        t = re.search(r'(?s)<h3 class="eda-card-title">(.*?)</h3>', body)
        st = re.search(r"Started:\s*([^<]+)<", body)
        cl = re.search(r"Closing:\s*([^<]+)<", body)
        out.append({
            "path": html.unescape(m.group(1)), "card_title": ws(text_of(t.group(1))) if t else "",
            "started": parse_date(st.group(1)) if st else "", "closing": parse_date(cl.group(1)) if cl else "",
        })
    return out


def parse_notice_page(page):
    """Return (title, date, body_text, document_links) for an other-notices detail page."""
    t = re.search(r"(?is)<title>(.*?)</title>", page)
    title = ws(html.unescape(t.group(1))) if t else ""
    txt = ws(text_of(page))
    i = txt.find("Procurement Portals Menu")
    j = txt.find("PARTICIPATING MEMBER STATES")
    body = txt[i + len("Procurement Portals Menu"): j if j > i else None].strip() if i >= 0 else txt
    if title and body.startswith(title):
        body = body[len(title):].strip()
    body = re.sub(r"^Other notices\s+", "", body)
    date = parse_date(body[:40])
    docs = sorted(set(html.unescape(u) for u in re.findall(
        r"""href=['"](https?://eda\.europa\.eu/docs/[^'"]+)['"]""", page)))
    return title, date, body, docs


VAT_RE = re.compile(r"^(?:[A-Z]{2}[A-Z0-9]{2,14}|N/?A)$")
# EDA internal procedure references, e.g. 26.CSD-INF.NP3.379, 26.RTI.PRZ.063, 24.CAP.NP1.B-1510
REF_RE = re.compile(r"\b([0-9]{2}\.[A-Z]{2,6}(?:-[A-Z]{2,6})?\.[A-Z]{1,4}[0-9]?\.(?:[A-Z]-)?[0-9]{2,5})\b")


def parse_contract_pdf(path):
    """Parse an EDA 'Annual List of (Specific) Contracts' PDF (one wide table per section)."""
    try:
        import pypdf  # optional third-party dependency
    except ImportError:
        print("[eda] pypdf not installed - skipping award PDF parsing", file=sys.stderr)
        return [], 0
    rows, skipped, section = [], 0, ""
    reader = pypdf.PdfReader(path)
    for page in reader.pages:
        try:
            txt = page.extract_text(extraction_mode="layout")
        except TypeError:
            txt = page.extract_text()
        for line in txt.splitlines():
            s = line.strip()
            if not s:
                continue
            low = s.lower()
            if low.startswith(("contracts below", "modifications of contracts", "specific contracts")):
                section = ws(s)
                continue
            f = re.split(r"\s{2,}", s)
            if len(f) < 4 or not f[0].isdigit() or not re.match(r"^\d{2}\.[A-Z]", f[1]):
                if re.match(r"^\d+\s", s) and "Reference" not in s:
                    skipped += 1
                continue
            vat, contractor = f[-1], f[-2]
            if not VAT_RE.match(vat) and len(f) >= 6 and re.match(r"^[A-Z]{2,4}\s?[0-9][0-9A-Z]{3,}$", vat):
                pass  # non-VAT company id (e.g. German 'HRB 505607' register number)
            elif not VAT_RE.match(vat):  # VAT glued to contractor name
                parts = vat.rsplit(" ", 1)
                if len(parts) == 2 and VAT_RE.match(parts[1]):
                    contractor, vat = parts
                    f = f[:-1] + [contractor, vat]
                else:
                    skipped += 1
                    continue
            middle = " ".join(f[2:-2]).replace("€", " ").replace("�", " ")
            m = re.match(r"^\s*([\d,]+\.\d{2})\s*(.*)$", middle)
            if not m:
                skipped += 1
                continue
            rows.append({
                "no": int(f[0]), "reference": f[1], "value": float(m.group(1).replace(",", "")),
                "subject": ws(m.group(2)), "contractor": ws(contractor),
                "vat": "" if vat.upper().replace("/", "") == "NA" else vat, "section": section,
            })
    return rows, skipped


def proc_type_from_ref(ref):
    codes = {"OP": "open", "NP": "negotiated", "NP1": "negotiated (single candidate)",
             "NP3": "negotiated (min. 3 candidates)", "IP": "interinstitutional framework contract",
             "AMD": "contract modification", "FC": "financial contribution / agreement",
             "PO": "purchase order (very low value)", "SC": "specific contract", "PRZ": "prize contest",
             "FWC": "framework contract"}
    for tok in ref.split(".")[2:]:
        if tok in codes:
            return f"{codes[tok]} ({tok})"
    return ""


VAT_PREFIXES = {"AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
                "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI", "CH", "NO", "GB"}


def vat_country(vat):
    """Country from an EU VAT number prefix; '' for N/A or non-VAT ids (e.g. 'HRB 505607')."""
    if not vat or not re.match(r"^[A-Z]{2}[0-9A-Z]{7,13}$", vat) or vat[:2] not in VAT_PREFIXES:
        return ""
    strict = {"HR": r"^HR\d{11}$", "DE": r"^DE\d{9}$", "PL": r"^PL\d{10}$", "IT": r"^IT\d{11}$"}
    if vat[:2] in strict and not re.match(strict[vat[:2]], vat):
        return ""  # e.g. German register numbers 'HRA581075' are not Croatian VAT ids
    return {"EL": "GR", "XI": "GB"}.get(vat[:2], vat[:2])


# --------------------------------------------------------------------------- xlsx (stdlib)
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def read_xlsx(path):
    """Return {sheet_name: {row_number: {col_number: value_str}}} using only zipfile + ElementTree."""
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    ss = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    out = {}
    for sh in wb.find("m:sheets", NS):
        tgt = rels[sh.get("{%s}id" % NS["r"])].lstrip("/")
        tgt = tgt if tgt.startswith("xl/") else "xl/" + tgt
        rows = {}
        for c in ET.fromstring(z.read(tgt)).iter("{%s}c" % NS["m"]):
            m = re.match(r"([A-Z]+)(\d+)", c.get("r", ""))
            if not m:
                continue
            col = 0
            for ch in m.group(1):
                col = col * 26 + ord(ch) - 64
            t, v = c.get("t"), c.find("m:v", NS)
            if t == "s" and v is not None:
                val = ss[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
            elif v is not None:
                val = v.text
            else:
                continue
            rows.setdefault(int(m.group(2)), {})[col] = val
        out[sh.get("name")] = rows
    return out


def num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def norm_label(s):
    return ws(str(s)).lower()


def clean_country(raw):
    raw = ws(raw)
    stars = re.search(r"(\*+)\s*$", raw)
    name = re.sub(r"\*+\s*$", "", raw).strip()
    return name, COUNTRY_NOTES.get(stars.group(1), "") if stars else ""


def metric_value(kind, v):
    return round(v * 100, 6) if kind == "ratio" else round(v, 6)


def parse_defence_workbook(path, fname):
    """Yield dicts (country, year, metric, value, unit, note) from one EDA Defence Data workbook."""
    wb = read_xlsx(path)
    recs = []
    for sheet, rows in wb.items():
        sname = ws(sheet)
        if not rows:
            continue
        header = rows.get(min(rows), {})
        # (a) long panel: 'Billions' sheet  PMS | Year | metrics...
        if norm_label(header.get(1, "")) == "pms" and norm_label(header.get(2, "")) == "year":
            cols = {c: METRICS.get(norm_label(h)) for c, h in header.items() if c > 2}
            for r, row in rows.items():
                if r == min(rows):
                    continue
                country, note = clean_country(row.get(1, ""))
                year = num(row.get(2))
                if country not in ISO2 or not year:
                    continue
                for c, meta in cols.items():
                    v = num(row.get(c))
                    if meta and v is not None:
                        recs.append((country, int(year), meta[0], metric_value(meta[2], v), meta[1], note, f"{fname}:{sname}"))
            continue
        # (b) 'Member States <year>' sheet: EU MS | Year | metrics... (one year, all countries)
        if norm_label(header.get(1, "")) == "eu ms" and norm_label(header.get(2, "")) == "year":
            cols = {c: METRICS.get(norm_label(h)) for c, h in header.items() if c > 2}
            for r, row in rows.items():
                country, note = clean_country(row.get(1, ""))
                year = num(row.get(2))
                if country not in ISO2 or not year:
                    continue
                for c, meta in cols.items():
                    v = num(row.get(c))
                    if meta and v is not None:
                        recs.append((country, int(year), meta[0], metric_value(meta[2], v), meta[1], note, f"{fname}:{sname}"))
            continue
        # (c) wide sheet: <Country|EU27|EDA 26> | 2017 | 2018 ... ; metric rows below
        years = {c: int(num(v)) for c, v in header.items() if c > 1 and num(v) and 2000 <= num(v) <= 2100}
        if len(years) >= 2:
            entity, note = clean_country(header.get(1, sname))
            if entity not in ISO2 and not re.match(r"^(EU\s?2\d|EDA\s?2\d)$", entity):
                continue
            for r, row in rows.items():
                meta = METRICS.get(norm_label(row.get(1, "")))
                if not meta:
                    continue
                for c, y in years.items():
                    v = num(row.get(c))
                    if v is not None:
                        recs.append((entity, y, meta[0], metric_value(meta[2], v), meta[1], note, f"{fname}:{sname}"))
    return recs


def workbook_vintage(recs):
    ys = [r[1] for r in recs]
    return max(ys) if ys else 0


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/raw/eda")
    ap.add_argument("--processed", default="data/raw/staging")
    ap.add_argument("--delay", type=float, default=1.1)
    ap.add_argument("--skip-procurement", action="store_true")
    ap.add_argument("--skip-defence-data", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.processed, exist_ok=True)
    c = Client(delay=args.delay)
    log = {"fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "user_agent": UA,
           "pages": {}, "external_sources": {
               "eu_funding_tenders_portal_eda_tenders": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-tenders?cftPartyLegalEntityId=47352396",
               "legacy_etendering_closed_eda_tenders": "https://etendering.ted.europa.eu/cft/cft-search.html?caList=29&status=CLOSED"}}

    st, body = c.get(BASE + "/robots.txt")
    log["pages"]["robots.txt"] = st

    notices = []
    if not args.skip_procurement:
        st, body = c.get(PROCUREMENT_URL)
        log["pages"][PROCUREMENT_URL] = {"status": st, "cloudflare_challenge": is_cf(st, body)}
        if st == 200:
            save(os.path.join(args.out, "procurement.html"), body)
            page = body.decode("utf-8", "replace")
            cards = parse_tender_cards(page)
            print(f"[eda] procurement page: {len(cards)} tender cards ({sum(not x['archived'] for x in cards)} visible)")
            for t in cards:
                status = "archived entry (HTML comment) on EDA procurement page; closed" if t["archived"] else "listed under 'Ongoing Calls For Tenders' on EDA procurement page"
                notices.append({**BUYER, "source": "eda", "source_id": t["reference"], "url": t["url"],
                                "title": t["title"],
                                "description": f"EDA call for tenders {t['reference']}: {t['title']}. Status: {status}."
                                               + (" Tender documents and e-submission via the EU Funding & Tenders portal."
                                                  if "ec.europa.eu" in t["url"] else ""),
                                "notice_type": "other" if ".PRZ." in t["reference"] else "tender",
                                "procedure_type": proc_type_from_ref(t["reference"].replace("/", ".")) or "call for tenders",
                                "publication_date": t["publication_date"], "deadline": t["deadline"], "language": "en"})
            other = parse_other_notice_cards(page)
        else:
            print(f"[eda] procurement page HTTP {st} (Cloudflare challenge={is_cf(st, body)}) - skipped")
            other = []
        st, body = c.get(OTHER_NOTICES_URL)
        log["pages"][OTHER_NOTICES_URL] = {"status": st, "cloudflare_challenge": is_cf(st, body)}
        if st == 200:
            save(os.path.join(args.out, "other_notices.html"), body)
            pg = body.decode("utf-8", "replace")
            seen = {o["path"] for o in other}
            for m in re.finditer(r'href="(?:/procurement/)?(other-notices/[^"#?]+)"', pg):
                p = html.unescape(m.group(1))
                if p not in seen:
                    seen.add(p)
                    other.append({"path": p, "card_title": "", "started": "", "closing": ""})
        print(f"[eda] other notices: {len(other)}")
        award_pdfs = []
        for o in other:
            url = BASE + "/procurement/" + urllib.parse.quote(o["path"], safe="/().-_~")
            st, body = c.get(url)
            log["pages"][url] = {"status": st, "cloudflare_challenge": is_cf(st, body)}
            if st != 200:
                print(f"[eda]   {o['path']}: HTTP {st} - skipped")
                continue
            save(os.path.join(args.out, "other_notices", slug(o["path"].split("/", 1)[-1]) + ".html"), body)
            title, date, text, docs = parse_notice_page(body.decode("utf-8", "replace"))
            low = (title or o["card_title"]).lower()
            if "annual list of contract" in low:
                award_pdfs += [(d, title, date) for d in docs if d.lower().split("?")[0].endswith(".pdf")]
                continue
            ref = REF_RE.search(title + " " + text)
            if ref and ("EDA/" + ref.group(1)) in {n["source_id"] for n in notices}:
                continue  # same procedure already captured from the tender cards
            tnorm = re.sub(r"[^a-z0-9]+", " ", (title or o["card_title"]).lower()).strip()
            if tnorm and tnorm in {re.sub(r"[^a-z0-9]+", " ", n["title"].lower()).strip() for n in notices}:
                continue  # same notice already captured (e.g. prize contest card)
            if "ex-ante" in low:
                ntype, ptype = "tender", "negotiated procedure - ex-ante publicity (low/middle value)"
            elif "expression of interest" in low:
                ntype, ptype = "tender", "call for expression of interest"
            elif "prize" in low:
                ntype, ptype = "other", "prize contest"
            else:
                ntype, ptype = "other", ""
            notices.append({**BUYER, "source": "eda",
                            "source_id": ref.group(1).rstrip(".") if ref else slug(o["path"].split("/", 1)[-1], 60),
                            "url": url, "title": title or o["card_title"], "description": text[:2000],
                            "notice_type": ntype, "procedure_type": ptype,
                            "publication_date": o["started"] or date, "deadline": o["closing"],
                            "language": "en"})
        # award PDFs
        n_awards = 0
        for pdf_url, ptitle, pdate in award_pdfs:
            st, body = c.get(pdf_url)
            if st != 200:
                print(f"[eda]   award pdf HTTP {st}: {pdf_url}")
                continue
            fn = os.path.join(args.out, "awards", slug(urllib.parse.urlparse(pdf_url).path.rsplit("/", 1)[-1]))
            save(fn, body)
            rows, skipped = parse_contract_pdf(fn)
            year = re.search(r"(20\d\d)", pdf_url)
            print(f"[eda]   {os.path.basename(fn)}: {len(rows)} award rows ({skipped} unparsed lines)")
            log.setdefault("award_pdfs", {})[pdf_url] = {"rows": len(rows), "unparsed": skipped}
            for r in rows:
                notices.append({**BUYER, "source": "eda", "source_id": r["reference"], "url": pdf_url,
                                "title": r["subject"],
                                "description": (f"{ptitle} ({year.group(1) if year else ''}). Section: {r['section']}. "
                                                f"Contract {r['reference']} - {r['subject']}. Contractor: {r['contractor']}"
                                                f"{' (VAT ' + r['vat'] + ')' if r['vat'] else ''}. Value: EUR {r['value']:,.2f}.")[:2000],
                                "notice_type": "award", "procedure_type": proc_type_from_ref(r["reference"]),
                                "publication_date": pdate, "winner_names": r["contractor"], "winner_ids": r["vat"],
                                "winner_countries": vat_country(r["vat"]), "award_value": f"{r['value']:.2f}",
                                "currency": "EUR", "language": "en"})
                n_awards += 1
        # unique ids + write
        counts = {}
        for n in notices:
            k = n["source_id"]
            counts[k] = counts.get(k, 0) + 1
            if counts[k] > 1:
                n["source_id"] = f"{k}#{counts[k]}"
        out_csv = os.path.join(args.processed, "eda_notices.csv")
        with open(out_csv, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=NOTICE_COLUMNS, restval="")
            w.writeheader()
            w.writerows(notices)
        by_type = {}
        for n in notices:
            by_type[n["notice_type"]] = by_type.get(n["notice_type"], 0) + 1
        log["notices"] = {"total": len(notices), "by_type": by_type}
        print(f"[eda] wrote {len(notices)} notices {by_type} -> {out_csv}")

    if not args.skip_defence_data:
        st, body = c.get(DEFENCE_DATA_URL)
        log["pages"][DEFENCE_DATA_URL] = {"status": st, "cloudflare_challenge": is_cf(st, body)}
        if st != 200:
            print(f"[eda] defence data page HTTP {st} - skipped")
        else:
            save(os.path.join(args.out, "defence_data_portal.html"), body)
            page = body.decode("utf-8", "replace")
            links = sorted(set(html.unescape(u) for u in re.findall(
                r"""href=['"](https?://eda\.europa\.eu/docs/[^'"]+\.(?:xlsx|xls|csv|pdf))['"]""", page, re.I)))
            log["defence_data_files_listed"] = links
            xlsx = [u for u in links if u.lower().endswith(".xlsx")]
            print(f"[eda] defence data: {len(links)} files listed, {len(xlsx)} xlsx")
            # latest report PDF (linked from the newest thematic report page)
            rep = sorted(set(re.findall(r'href="(thematic-policy-reports/eda-defence-data-(\d{4})-\d{4})"', page)), key=lambda x: x[1])
            if rep:
                rurl = BASE + "/publications-and-data/" + rep[-1][0]
                st, rb = c.get(rurl)
                if st == 200:
                    pdfs = sorted(set(re.findall(r"href='(https://eda\.europa\.eu/docs/[^']+\.pdf)'", rb.decode("utf-8", "replace"))))
                    for p in pdfs[:1]:
                        st, pb = c.get(p)
                        if st == 200:
                            save(os.path.join(args.out, "defence_data", p.rsplit("/", 1)[-1]), pb)
                            log["defence_data_report_pdf"] = p
            all_recs = []
            for u in xlsx:
                fn = urllib.parse.unquote(u.rsplit("/", 1)[-1])
                path = os.path.join(args.out, "defence_data", slug(fn))
                st, xb = c.get(u)
                if st != 200:
                    print(f"[eda]   {fn}: HTTP {st}")
                    continue
                save(path, xb)
                try:
                    recs = parse_defence_workbook(path, fn)
                except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
                    print(f"[eda]   {fn}: could not parse ({e})")
                    continue
                v = workbook_vintage(recs)
                print(f"[eda]   {fn}: {len(recs)} values, latest year {v}")
                all_recs.append((v, fn, recs))
            # newer vintages override older ones; only vintages >= 2020 are used (older layouts differ)
            best = {}
            for v, fn, recs in sorted(all_recs, key=lambda x: (x[0], x[1])):
                if v < 2020:
                    continue
                # within one workbook, the 'Billions' long panel is the most revised source -> apply last
                for rec in sorted(recs, key=lambda r: ":Billions" in r[6]):
                    best[(rec[0], rec[1], rec[2])] = rec
            national, aggregate = [], []
            for (ent, y, metric), rec in sorted(best.items()):
                row = {"country": ent, "year": y, "metric": metric, "value": rec[3], "unit": rec[4],
                       "country_code": ISO2.get(ent, ""), "note": rec[5], "source_file": rec[6]}
                (national if ent in ISO2 else aggregate).append(row)
            cols = ["country", "year", "metric", "value", "unit", "country_code", "note", "source_file"]
            for name, data in (("eda_defence_data_national.csv", national), ("eda_defence_data_eu_aggregate.csv", aggregate)):
                with open(os.path.join(args.processed, name), "w", encoding="utf-8", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=cols)
                    w.writeheader()
                    w.writerows(data)
                print(f"[eda] wrote {len(data)} rows -> {os.path.join(args.processed, name)}")
            log["defence_data"] = {"national_rows": len(national), "aggregate_rows": len(aggregate),
                                   "countries": sorted({r['country'] for r in national}),
                                   "years": [min(r['year'] for r in national), max(r['year'] for r in national)] if national else None}

    with open(os.path.join(args.out, "fetch_log.json"), "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)


if __name__ == "__main__":
    main()
