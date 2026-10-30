"""Fetch defence & security notices from TED (Tenders Electronic Daily) via the v3 search API.

Scope: CPV 35* (security, fire-fighting, police and defence equipment) OR legal basis
Directive 2009/81/EC (defence & security procurement). Raw pages are stored gzipped per
month so the run is resumable; re-running skips months that are already complete.

Usage (from data_discovery/):
    python -I scripts/fetch_ted.py --out data/raw/ted --since 2024-01 --until 2026-10
"""
import argparse
import datetime as dt
import gzip
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.ted.europa.eu/v3/notices/search"
UA = "team-rocket-hackathon/0.1 (research; Build the Arsenal hackathon)"
DEFENCE_QUERY = "(classification-cpv IN (35000000) OR legal-basis IN (32009L0081))"
FIELDS = [
    "publication-number", "publication-date", "notice-type", "notice-subtype", "form-type",
    "title-proc", "description-proc", "official-language",
    "buyer-name", "buyer-country", "buyer-city", "buyer-legal-type", "buyer-identifier",
    "classification-cpv", "main-classification-proc", "contract-nature", "procedure-type",
    "legal-basis", "place-of-performance-country-proc", "framework-agreement-lot",
    "deadline-receipt-tender-date-lot", "deadline-receipt-request-date-lot", "security-clearance-lot",
    "estimated-value-proc", "estimated-value-cur-proc", "estimated-value-lot", "estimated-value-cur-lot",
    "total-value", "total-value-cur", "tender-value", "tender-value-cur",
    "received-submissions-type-code", "received-submissions-type-val",
    "winner-name", "winner-country", "winner-city", "winner-size", "winner-identifier",
    "winner-owner-nationality",
]
PAGE_SIZE = 250
MIN_INTERVAL = 2.0  # seconds between requests; the API answers 429 when hammered

_last_call = 0.0


def post(body):
    global _last_call
    data = json.dumps(body).encode()
    for attempt in range(8):
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        req = urllib.request.Request(API, data=data, headers={"Content-Type": "application/json", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504):
                delay = int(e.headers.get("Retry-After") or 0) or min(120, 10 * 2 ** attempt)
                print(f"  HTTP {e.code}, backing off {delay}s")
                time.sleep(delay)
                continue
            raise RuntimeError(f"HTTP {e.code}: {e.read()[:500]!r}")
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  network error {e}, retrying")
            time.sleep(10)
    raise RuntimeError("giving up after repeated errors")


def months(since, until):
    y, m = map(int, since.split("-"))
    uy, um = map(int, until.split("-"))
    while (y, m) <= (uy, um):
        start = dt.date(y, m, 1)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        yield start, dt.date(y, m, 1) - dt.timedelta(days=1)


def fetch_window(query, out_dir: Path):
    done = out_dir / "_complete"
    if done.exists():
        print(f"skip {out_dir.name} (complete)")
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    body = {"query": query, "fields": FIELDS, "limit": PAGE_SIZE, "scope": "ALL",
            "paginationMode": "ITERATION"}
    page, total = 0, None
    while True:
        res = post(body)
        total = res.get("totalNoticeCount", total)
        notices = res.get("notices", [])
        if notices:
            page += 1
            with gzip.open(out_dir / f"page_{page:04d}.json.gz", "wt", encoding="utf-8") as f:
                json.dump(notices, f, ensure_ascii=False)
        token = res.get("iterationNextToken")
        print(f"  {out_dir.name} page {page}: +{len(notices)} (total {total})")
        if not token or not notices:
            break
        body["iterationNextToken"] = token
    done.write_text(json.dumps({"query": query, "total": total, "pages": page,
                                "fetched_at": dt.datetime.now().isoformat()}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--since", default="2024-01")
    ap.add_argument("--until", default=dt.date.today().strftime("%Y-%m"))
    args = ap.parse_args()
    out = Path(args.out)
    for start, end in months(args.since, args.until):
        q = f"{DEFENCE_QUERY} AND publication-date>={start:%Y%m%d} AND publication-date<={end:%Y%m%d}"
        print(f"{start:%Y-%m}: {q}")
        # current month is never marked complete so a re-run picks up new notices
        win = out / f"{start:%Y-%m}"
        if start.strftime("%Y-%m") == dt.date.today().strftime("%Y-%m") and (win / "_complete").exists():
            (win / "_complete").unlink()
            for p in win.glob("page_*.json.gz"):
                p.unlink()
        fetch_window(q, win)


if __name__ == "__main__":
    main()
