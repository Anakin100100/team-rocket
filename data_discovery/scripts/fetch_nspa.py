#!/usr/bin/env python3
"""Fetch public procurement opportunities from NATO NSPA (NATO Support and Procurement Agency).

Sources (public, no login):
  * https://eportal.nspa.nato.int/eProcurement5G/Opportunities/OpportunitiesList
    The NSPA eProcurement "5G" opportunity list: Future Business Opportunities (FBO)
    and Requests For Proposal (RFP), with full history (published + closed + cancelled).
    The page is an HTML grid; rows are loaded via an AJAX HTML fragment endpoint
    (".../OpportunitiesList/OpportunitiesList?CurrentPageIndex=N&PageSize=100"), which
    we call exactly as the browser does (same session cookie, X-Requested-With header).
  * Detail modal per opportunity (".../DetailsOpportunity?RowIDEncrypted=...") - fetched
    only for currently open opportunities (adds "Level Distribution": Public / Limited).
  * https://www.nspa.nato.int/business/procurement is probed once and recorded; it sits
    behind a Cloudflare JS challenge, which we do NOT try to bypass.

Only the Python standard library is used. Polite: ~1 request/second, descriptive UA,
robots.txt checked. Downloaded content is treated as data only.

Usage (from data_discovery/):
    python -I scripts/fetch_nspa.py --out data/raw/nspa
    python -I scripts/fetch_nspa.py --out data/raw/nspa --max-pages 2 --details none   # quick test
"""
import argparse
import csv
import datetime as dt
import gzip
import html
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

UA = "team-rocket-hackathon/0.1 (research)"
BASE = "https://eportal.nspa.nato.int"
LIST_URL = BASE + "/eProcurement5G/Opportunities/OpportunitiesList"
FEED_URL = BASE + "/eProcurement5G/Opportunities/OpportunitiesList/OpportunitiesList"
PAGER_URL = BASE + "/eProcurement5G/Opportunities/OpportunitiesList/OpportunitiesListPager"
DETAIL_URL = BASE + "/eProcurement5G/Opportunities/Opportunities/DetailsOpportunity"
WWW_PROCUREMENT = "https://www.nspa.nato.int/business/procurement"

NOTICE_COLUMNS = [
    "source", "source_id", "url", "title", "description", "buyer_name", "buyer_country",
    "buyer_city", "buyer_id", "notice_type", "procedure_type", "cpv_codes", "publication_date",
    "deadline", "estimated_value", "currency", "winner_names", "winner_ids", "winner_countries",
    "award_value", "language",
]

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


class Client:
    """Tiny polite HTTP client: cookie jar, fixed delay between requests, retries."""

    def __init__(self, delay=1.1, timeout=60):
        self.delay = delay
        self.timeout = timeout
        self.last = 0.0
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def get(self, url, headers=None, retries=2):
        hdrs = {"User-Agent": UA, "Accept-Language": "en"}
        hdrs.update(headers or {})
        for attempt in range(retries + 1):
            wait = self.delay - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            req = urllib.request.Request(url, headers=hdrs)
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    return r.status, r.read(), r.headers.get("Content-Type", "")
            except urllib.error.HTTPError as e:
                body = e.read() if hasattr(e, "read") else b""
                if e.code >= 500 and attempt < retries:
                    time.sleep(3 * (attempt + 1))
                    continue
                return e.code, body, e.headers.get("Content-Type", "") if e.headers else ""
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < retries:
                    time.sleep(3 * (attempt + 1))
                    continue
                return 0, str(e).encode(), ""
        return 0, b"", ""


def is_cloudflare_challenge(status, body):
    b = body[:20000].decode("utf-8", "replace")
    return status in (403, 503) and ("Just a moment" in b or "cf_chl" in b or "challenge-platform" in b)


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return s


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def parse_date(s):
    """'30 Oct 2026' -> '2026-10-30'; '27 Nov 2026 12:00:00' -> '2026-11-27T12:00:00'."""
    m = re.search(r"(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})(?: (\d{1,2}:\d{2}(?::\d{2})?))?", s or "")
    if not m:
        return ""
    d = dt.date(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1))).isoformat()
    if m.group(4):
        t = m.group(4)
        if len(t) == 5:
            t += ":00"
        return f"{d}T{t.zfill(8)}"
    return d


NSN_RE = re.compile(r"\b(\d{4}-\d{2}-\d{3}-\d{4}|\d{4}\d{2}\d{3}\d{4})\b")
PN_RE = re.compile(r"(?:\bP/N|\bPN(?=[\s:#]))[:\s#.]*([A-Z0-9][A-Z0-9\-./]{2,})", re.I)


def extract_part_numbers(title):
    nsns = sorted(set(NSN_RE.findall(title or "")))
    pns = sorted(set(p.rstrip(".,;") for p in PN_RE.findall(title or "") if re.search(r"\d", p)))
    return nsns, pns


def parse_grid_fragment(frag):
    """Parse the AJAX grid HTML fragment into a list of dicts."""
    rows = []
    for m in re.finditer(r'(?s)<tr\b[^>]*\brow-id="([^"]+)"[^>]*>(.*?)</tr>', frag):
        row_id, body = m.group(1), m.group(2)
        tds = re.findall(r"(?s)<td\b[^>]*>(.*?)</td>", body)
        if len(tds) < 6:
            continue
        ref = ""
        href = re.search(r'href="(/eProcurement5G/Opportunities/Opportunities/DetailsOpportunity\?[^"]+)"', tds[0])
        if href:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(html.unescape(href.group(1))).query)
            ref = (q.get("reference") or [""])[0].strip()
        title = norm_ws(strip_tags(tds[0]))
        if ref and title.startswith(ref):
            title = title[len(ref):].strip()
        opp =[norm_ws(x) for x in strip_tags(tds[1]).split("\n") if norm_ws(x)]
        org = [norm_ws(x) for x in strip_tags(tds[2]).split("\n") if norm_ws(x)]
        status = norm_ws(strip_tags(tds[3]))
        dates1 = norm_ws(strip_tags(tds[4]))
        dates2 = norm_ws(strip_tags(tds[5]))
        pub = re.search(r"Publication Date\s+(\d{1,2} \w{3} \d{4})", dates1)
        mod = re.search(r"Modified on\s+(\d{1,2} \w{3} \d{4})", dates1)
        clo = re.search(r"Closing Date\s+(\d{1,2} \w{3} \d{4}(?: \d{1,2}:\d{2}(?::\d{2})?)?)", dates2)
        tent = re.search(r"Tentative RFP Date\s+(\d{1,2} \w{3} \d{4})", dates2)
        rows.append({
            "row_id": row_id,
            "reference": ref,
            "title": title,
            "opportunity_type": opp[0] if opp else "",
            "type": opp[1] if len(opp) > 1 else "",
            "purchasing_org_code": org[0] if org else "",
            "purchasing_org_name": org[1] if len(org) > 1 else "",
            "status": status,
            "publication_date": parse_date(pub.group(1)) if pub else "",
            "last_modified_date": parse_date(mod.group(1)) if mod else "",
            "closing_date": parse_date(clo.group(1)) if clo else "",
            "tentative_rfp_date": parse_date(tent.group(1)) if tent else "",
            "detail_url": f"{DETAIL_URL}?RowIDEncrypted={urllib.parse.quote(row_id)}&reference={urllib.parse.quote(ref)}",
        })
    return rows


def parse_detail(frag):
    """Detail modal is a list of label/value pairs; return a dict of the interesting ones."""
    lines = [norm_ws(x) for x in strip_tags(frag).split("\n")]
    lines = [x for x in lines if x]
    out = {}
    labels = ["Collective Number", "Opportunity Id", "Title", "Product Name", "Type",
              "Closing Time (CET)", "Tentative RFP Date", "Publication Date", "Level Distribution",
              "Description", "Eligibility", "Eligible Nations", "NSN", "Part Number"]
    for i, ln in enumerate(lines[:-1]):
        if ln in labels and ln not in out:
            out[ln] = lines[i + 1]
    if lines:
        out["_header"] = " ".join(lines[:2])
    return out


def build_query(page_index, page_size):
    params = [
        ("DisplayMode", "Default"), ("QueryMode", "AvailableForActionOnly"),
        ("NavigationContext", "None"), ("CurrentPageIndex", str(page_index)),
        ("SkippedPages", "0"), ("PageSize", str(page_size)), ("ColumnsToGet", "*"),
        ("IsFavorite", "False"), ("IsImportant", "False"), ("IsTodo", "False"),
        ("IsDone", "False"), ("UseDelegation", "False"), ("IsDelegationFilterVisible", "True"),
        ("isFlagFilterVisible", "True"), ("IsContractPointOfContactFilterVisible", "True"),
        ("IsAssignToMeFilterVisible", "False"),
    ]
    return urllib.parse.urlencode(params)


def save(path, data, gz=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if gz:
        with gzip.open(path + ".gz", "wb") as f:
            f.write(data)
    else:
        with open(path, "wb") as f:
            f.write(data)


def to_notice(r, detail):
    opp = r["opportunity_type"].upper()
    status = r["status"]
    if opp in ("FBO", "NPO"):  # NPO is listed as an FBO sub-type on the portal (advance notice, tentative RFP date)
        notice_type = "prior_info"
    elif opp == "RFP":
        notice_type = "tender"
    else:
        notice_type = "other"
    nsns, pns = extract_part_numbers(r["title"])
    org = " - ".join(x for x in [r["purchasing_org_code"], r["purchasing_org_name"]] if x)
    parts = [
        f"NSPA {r['opportunity_type']} ({r['type']})" if r["type"] else f"NSPA {r['opportunity_type']}",
        f"Status: {status}",
        f"Purchasing organisation / programme: {org}" if org else "",
        f"Tentative RFP date: {r['tentative_rfp_date']}" if r["tentative_rfp_date"] else "",
        f"Closing (CET): {r['closing_date']}" if r["closing_date"] else "",
        f"Last modified: {r['last_modified_date']}" if r["last_modified_date"] else "",
        f"NSN: {';'.join(nsns)}" if nsns else "",
        f"Part numbers: {';'.join(pns)}" if pns else "",
        f"Level distribution: {detail.get('Level Distribution')}" if detail.get("Level Distribution") else "",
        "Eligibility (general NSPA rule, not notice-specific): bidders must be firms from NATO member nations "
        "registered in the NSPA Source File; RFP documents may restrict participating nations further.",
    ]
    desc = " | ".join(p for p in parts if p)[:2000]
    return {
        "source": "nspa",
        "source_id": r["reference"] or r["row_id"],
        "url": r["detail_url"],
        "title": r["title"],
        "description": desc,
        "buyer_name": f"NATO Support and Procurement Agency (NSPA) - {r['purchasing_org_name'] or r['purchasing_org_code']}".rstrip(" -"),
        "buyer_country": "LU",
        "buyer_city": "Capellen",
        "buyer_id": f"NSPA-{r['purchasing_org_code']}" if r["purchasing_org_code"] else "NSPA",
        "notice_type": notice_type,
        "procedure_type": {"RFP": "request_for_proposal", "FBO": "future_business_opportunity",
                           "NPO": "future_business_opportunity (NPO)"}.get(opp, opp.lower()),
        "cpv_codes": "",
        "publication_date": r["publication_date"],
        "deadline": r["closing_date"],
        "estimated_value": "",
        "currency": "",
        "winner_names": "",
        "winner_ids": "",
        "winner_countries": "",
        "award_value": "",
        "language": "en",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/raw/nspa", help="raw output directory")
    ap.add_argument("--processed", default="data/raw/staging", help="normalized output directory")
    ap.add_argument("--page-size", type=int, default=100, choices=[10, 25, 50, 100])
    ap.add_argument("--max-pages", type=int, default=0, help="0 = all pages")
    ap.add_argument("--details", choices=["none", "open", "all"], default="open",
                    help="fetch detail modal for none / currently open / all opportunities")
    ap.add_argument("--max-details", type=int, default=300)
    ap.add_argument("--delay", type=float, default=1.1, help="seconds between requests")
    ap.add_argument("--reparse", action="store_true",
                    help="no network: rebuild outputs from previously saved grid_pages/ and details/ in --out")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.processed, exist_ok=True)
    if args.reparse:
        return reparse(args)
    c = Client(delay=args.delay)
    log = {"fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "user_agent": UA, "probes": {}}

    # 0) robots.txt + probe of the main (Cloudflare-protected) website, recorded for the report.
    for host in ("https://eportal.nspa.nato.int", "https://www.nspa.nato.int"):
        st, body, ct = c.get(host + "/robots.txt")
        cf = is_cloudflare_challenge(st, body)
        log["probes"][host + "/robots.txt"] = {"status": st, "cloudflare_challenge": cf}
        if st == 200 and "text/plain" in ct and not cf:
            rp = urllib.robotparser.RobotFileParser()
            rp.parse(body.decode("utf-8", "replace").splitlines())
            if host.startswith("https://eportal") and not rp.can_fetch(UA, LIST_URL):
                print("robots.txt disallows the eProcurement list - aborting", file=sys.stderr)
                sys.exit(2)
    st, body, ct = c.get(WWW_PROCUREMENT)
    log["probes"][WWW_PROCUREMENT] = {"status": st, "cloudflare_challenge": is_cloudflare_challenge(st, body)}
    if is_cloudflare_challenge(st, body):
        print(f"[nspa] {WWW_PROCUREMENT} -> HTTP {st} Cloudflare challenge; not bypassing (using eportal instead)")

    # 1) Landing page (sets session cookie; contains the first page of currently published items).
    st, body, ct = c.get(LIST_URL)
    print(f"[nspa] list page HTTP {st}, {len(body)} bytes")
    if st != 200:
        log["error"] = f"list page HTTP {st}"
        json.dump(log, open(os.path.join(args.out, "fetch_log.json"), "w"), indent=2)
        sys.exit(1)
    save(os.path.join(args.out, "opportunities_list_landing.html"), body)

    ajax = {"X-Requested-With": "XMLHttpRequest", "Referer": LIST_URL}
    # 2) Pager -> total record count.
    st, body, ct = c.get(PAGER_URL + "?" + build_query(1, args.page_size), headers=ajax)
    pager_txt = norm_ws(strip_tags(body.decode("utf-8", "replace")))
    m = re.search(r"out of\s+([\d,]+)\s+records", pager_txt)
    total = int(m.group(1).replace(",", "")) if m else None
    n_pages = -(-total // args.page_size) if total else 1
    print(f"[nspa] pager: total={total} pages={n_pages} (page size {args.page_size})")
    log["total_records_reported"] = total

    # 3) All grid pages.
    rows, seen = [], set()
    last_page = n_pages if not args.max_pages else min(n_pages, args.max_pages)
    for p in range(1, last_page + 1):
        st, body, ct = c.get(FEED_URL + "?" + build_query(p, args.page_size), headers=ajax)
        if st != 200:
            print(f"[nspa] page {p}: HTTP {st}; stopping")
            log.setdefault("errors", []).append(f"page {p}: HTTP {st}")
            break
        save(os.path.join(args.out, "grid_pages", f"page_{p:03d}.html"), body, gz=True)
        page_rows = parse_grid_fragment(body.decode("utf-8", "replace"))
        new = [r for r in page_rows if r["row_id"] not in seen]
        for r in new:
            seen.add(r["row_id"])
        rows.extend(new)
        print(f"[nspa] page {p}/{last_page}: {len(page_rows)} rows ({len(new)} new), total {len(rows)}")
        if not page_rows:
            # Observed 2026-10-30: the server returns empty pages beyond ~2,200 rows (22 x 100) even though the
            # pager reports ~6,850 records -> unfiltered deep paging is capped; older items need date filters.
            log["pagination_note"] = f"empty page at index {p}; server-side paging cap reached ({len(rows)} rows of {total})"
            break

    # 4) Details for open opportunities (adds Level Distribution etc.).
    details = {}
    if args.details != "none":
        open_status = re.compile(r"^(FBO )?Published$", re.I)
        targets = [r for r in rows if args.details == "all" or open_status.match(r["status"])]
        targets = targets[: args.max_details]
        print(f"[nspa] fetching {len(targets)} detail pages")
        for i, r in enumerate(targets, 1):
            st, body, ct = c.get(f"{DETAIL_URL}?RowIDEncrypted={urllib.parse.quote(r['row_id'])}", headers=ajax)
            if st == 200:
                save(os.path.join(args.out, "details", f"{re.sub(r'[^A-Za-z0-9_-]', '_', r['reference'] or r['row_id'])}.html"), body, gz=True)
                details[r["row_id"]] = parse_detail(body.decode("utf-8", "replace"))
            if i % 25 == 0:
                print(f"[nspa]   details {i}/{len(targets)}")
    write_outputs(args, rows, details, log)


def write_outputs(args, rows, details, log):
    # 5) Outputs: parsed raw JSON + wide CSV in raw dir; normalized notices in processed dir.
    for r in rows:
        d = details.get(r["row_id"], {})
        r["level_distribution"] = d.get("Level Distribution", "")
        nsns, pns = extract_part_numbers(r["title"])
        r["nsns"] = ";".join(nsns)
        r["part_numbers"] = ";".join(pns)
    with open(os.path.join(args.out, "nspa_opportunities.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    wide_cols = ["reference", "title", "opportunity_type", "type", "purchasing_org_code", "purchasing_org_name",
                 "status", "publication_date", "last_modified_date", "closing_date", "tentative_rfp_date",
                 "level_distribution", "nsns", "part_numbers", "detail_url", "row_id"]
    with open(os.path.join(args.out, "nspa_opportunities.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=wide_cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    notices, ids = [], {}
    for r in rows:
        n = to_notice(r, details.get(r["row_id"], {}))
        k = n["source_id"]
        ids[k] = ids.get(k, 0) + 1
        if ids[k] > 1:  # same reference reused (e.g. FBO -> RFP); keep ids unique
            n["source_id"] = f"{k}#{ids[k]}"
        notices.append(n)
    out_csv = os.path.join(args.processed, "nspa_notices.csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=NOTICE_COLUMNS)
        w.writeheader()
        w.writerows(notices)

    log["records_parsed"] = len(rows)
    log["details_fetched"] = len(details)
    log["status_counts"] = {}
    for r in rows:
        log["status_counts"][r["status"]] = log["status_counts"].get(r["status"], 0) + 1
    pubs = sorted(r["publication_date"] for r in rows if r["publication_date"])
    log["publication_date_range"] = [pubs[0], pubs[-1]] if pubs else None
    with open(os.path.join(args.out, "fetch_log.json"), "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)
    print(f"[nspa] wrote {len(notices)} notices -> {out_csv}")
    print(json.dumps({k: log[k] for k in ("records_parsed", "details_fetched", "status_counts", "publication_date_range")}, indent=1))


def reparse(args):
    """Rebuild all outputs from saved raw pages (no network)."""
    log_path = os.path.join(args.out, "fetch_log.json")
    log = json.load(open(log_path, encoding="utf-8")) if os.path.exists(log_path) else {}
    log["reparsed_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    gdir = os.path.join(args.out, "grid_pages")
    rows, seen = [], set()
    for fn in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        if fn.endswith(".html.gz"):
            for r in parse_grid_fragment(gzip.open(os.path.join(gdir, fn)).read().decode("utf-8", "replace")):
                if r["row_id"] not in seen:
                    seen.add(r["row_id"])
                    rows.append(r)
    by_ref = {}
    ddir = os.path.join(args.out, "details")
    for fn in os.listdir(ddir) if os.path.isdir(ddir) else []:
        if fn.endswith(".html.gz"):
            by_ref[fn[: -len(".html.gz")]] = parse_detail(gzip.open(os.path.join(ddir, fn)).read().decode("utf-8", "replace"))
    details = {}
    for r in rows:
        key = re.sub(r"[^A-Za-z0-9_-]", "_", r["reference"] or r["row_id"])
        if key in by_ref:
            details[r["row_id"]] = by_ref[key]
    total = log.get("total_records_reported")
    if total and len(rows) < total and "pagination_note" not in log:
        log["pagination_note"] = (f"server-side paging cap: only {len(rows)} of {total} reported records retrievable "
                                  f"by unfiltered paging (later pages empty)")
    print(f"[nspa] reparse: {len(rows)} rows from saved grid pages, {len(details)} details")
    write_outputs(args, rows, details, log)


if __name__ == "__main__":
    main()
