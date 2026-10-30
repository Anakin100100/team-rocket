"""Fetch the ECB euro foreign exchange reference rates (daily) and write a tidy CSV.

Usage (from data_discovery/):
    python -I scripts/fetch_ecb_fx.py --raw data/raw/ecb --out data/raw/staging
"""
import argparse
import csv
import subprocess
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
UA = "team-rocket-hackathon/0.1 (research; Build the Arsenal hackathon)"
# Currencies with an irrevocably fixed euro rate (no longer quoted by the ECB)
FIXED = {"EUR": 1.0, "BGN": 1.95583, "HRK": 7.5345}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    raw.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    try:
        data = urllib.request.urlopen(req, timeout=60).read()
    except urllib.error.URLError as e:
        # ecb.europa.eu omits its intermediate cert; Python can't fetch it (AIA) but the OS curl can
        print(f"urllib failed ({e.reason}); retrying with system curl")
        data = subprocess.run(["curl", "-sSf", "-A", UA, URL], check=True, capture_output=True).stdout
    (raw / "eurofxref-daily.xml").write_bytes(data)
    root = ET.fromstring(data)
    rates, day = dict(FIXED), ""
    for cube in root.iter():
        if cube.get("time"):
            day = cube.get("time")
        if cube.get("currency"):
            rates[cube.get("currency")] = float(cube.get("rate"))
    with open(out / "ecb_fx_rates.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["currency", "units_per_eur", "rate_date", "source"])
        for cur, r in sorted(rates.items()):
            w.writerow([cur, r, day, "ECB" if cur not in FIXED or cur == "EUR" else "fixed conversion rate"])
    print(f"{len(rates)} rates for {day}")


if __name__ == "__main__":
    main()
