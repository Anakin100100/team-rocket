#!/usr/bin/env python3
"""Collect public procurement / contract data about the Polish Armament Agency
(Agencja Uzbrojenia, AU) from its own and its parent ministry's public web channels.

Sources (all public, no login):
  1. AU website  https://www.wojsko-polskie.pl/au/  (the old gov.pl/web/agencja-uzbrojenia
     site now 301-redirects to the gov.pl root). The site sits behind an Imperva/Incapsula
     bot challenge: the AU homepage (news grid, ~40 latest items incl. "Umowy SAFE") is
     usually served, deeper pages usually get a JS challenge. We do NOT try to bypass it:
     a per-host circuit breaker stops requests after repeated challenges.
  2. AU BIP      https://au-bip.wp.mil.pl/  (procurement notices, plan postępowań, dialog
     techniczny). Same Incapsula protection -> probed once, recorded in sources_status.json.
  3. MON news    https://www.gov.pl/web/obrona-narodowa/aktualnosci5  (Ministry of National
     Defence, AU's parent). MON publishes a press release for most contracts AU signs,
     typically with contractor and value. robots.txt on gov.pl allows everything.

Outputs:
  <out>/...                         raw HTML (list pages, articles), sources_status.json,
                                    agencja_uzbrojenia_records.json
  data/raw/staging/agencja_uzbrojenia_notices.csv   normalized records

Stdlib only. Polite: >=1.1 s between requests, descriptive UA, caches article HTML so
re-runs only fetch list pages + new articles.  Run with:  python -I scripts/fetch_agencja_uzbrojenia.py --out data/raw/agencja_uzbrojenia
Downloaded content is treated as data only (parsed with regex / html.parser, never executed).
"""
import argparse
import csv
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

UA = "team-rocket-hackathon/0.1 (research)"
MIN_INTERVAL = 1.1  # seconds between any two requests

AU_BASE = "https://www.wojsko-polskie.pl"
AU_HOME = AU_BASE + "/au/"
AU_LISTS = [AU_BASE + "/au/aktualnosci/", AU_BASE + "/au/safe/"]
BIP_HOME = "https://au-bip.wp.mil.pl/"
MON_BASE = "https://www.gov.pl"
MON_LIST = MON_BASE + "/web/obrona-narodowa/aktualnosci5?page={page}&size=10"

BUYER = {"buyer_name": "Agencja Uzbrojenia", "buyer_country": "PL", "buyer_city": "Warszawa", "buyer_id": ""}

CSV_COLUMNS = ["source", "source_id", "url", "title", "description", "buyer_name", "buyer_country",
               "buyer_city", "buyer_id", "notice_type", "procedure_type", "cpv_codes", "publication_date",
               "deadline", "estimated_value", "currency", "winner_names", "winner_ids", "winner_countries",
               "award_value", "language"]

PL_MONTHS = {"stycznia": 1, "lutego": 2, "marca": 3, "kwietnia": 4, "maja": 5, "czerwca": 6, "lipca": 7,
             "sierpnia": 8, "września": 9, "października": 10, "listopada": 11, "grudnia": 12}


# --------------------------------------------------------------------------- HTTP
class Fetcher:
    def __init__(self, raw_dir, refresh=False):
        self.raw_dir = raw_dir
        self.refresh = refresh
        self.last = 0.0
        self.challenges = {}   # host -> consecutive challenge count
        self.blocked = set()   # hosts we stopped requesting
        self.robots = {}       # host -> RobotFileParser | None (unknown)
        self.log = []          # per-request status log
        self.n_requests = 0

    def _wait(self):
        delta = time.time() - self.last
        if delta < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - delta)
        self.last = time.time()

    def _raw(self, url):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept-Language": "pl,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"})
        self._wait()
        self.n_requests += 1
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.status, r.geturl(), r.read()
        except urllib.error.HTTPError as e:
            try:
                body = e.read()
            except Exception:
                body = b""
            return e.code, url, body
        except Exception as e:  # connection reset etc.
            return None, url, repr(e).encode()

    @staticmethod
    def is_challenge(status, body):
        b = body[:2000]
        return (b"_Incapsula_Resource" in b or b"<TITLE>Loading</TITLE>" in b
                or (status is None and b"10054" in b))

    def allowed(self, url):
        host = urllib.parse.urlsplit(url).netloc
        if host not in self.robots:
            rurl = f"https://{host}/robots.txt"
            status, _, body = self._raw(rurl)
            rp = None
            note = "unreadable"
            if status == 200 and not self.is_challenge(status, body) and b"<html" not in body[:500].lower():
                rp = urllib.robotparser.RobotFileParser()
                rp.parse(body.decode("utf-8", "replace").splitlines())
                note = "parsed"
            elif self.is_challenge(status, body):
                note = "behind bot challenge (unreadable); treated as unknown, request volume kept minimal"
            self.robots[host] = rp
            self.log.append({"url": rurl, "status": status, "robots": note})
        rp = self.robots[host]
        return True if rp is None else rp.can_fetch(UA, url)

    def get(self, url, cache_path=None, use_cache=True):
        """Return (text|None, info dict). Caches successful bodies to cache_path."""
        if cache_path and use_cache and not self.refresh and os.path.exists(cache_path):
            with open(cache_path, "rb") as f:
                return f.read().decode("utf-8", "replace"), {"url": url, "status": "cache"}
        host = urllib.parse.urlsplit(url).netloc
        if host in self.blocked:
            return None, {"url": url, "status": "skipped (host blocked by bot challenge)"}
        if not self.allowed(url):
            info = {"url": url, "status": "disallowed by robots.txt"}
            self.log.append(info)
            return None, info
        status, final, body = self._raw(url)
        if self.is_challenge(status, body):
            self.challenges[host] = self.challenges.get(host, 0) + 1
            info = {"url": url, "status": status, "note": "Incapsula bot challenge - not bypassed"}
            self.log.append(info)
            if self.challenges[host] >= 2:
                self.blocked.add(host)
                self.log.append({"host": host, "note": "circuit breaker: stopped requesting this host"})
            return None, info
        self.challenges[host] = 0
        info = {"url": url, "final_url": final, "status": status, "bytes": len(body)}
        self.log.append(info)
        if status != 200:
            return None, info
        if cache_path:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, "wb") as f:
                f.write(body)
        return body.decode("utf-8", "replace"), info


# --------------------------------------------------------------------------- helpers
def clean(s):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def slugify(s, n=120):
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")
    return s[:n] or "index"


def pl_date(s):
    """'29 maja 2026' -> '2026-05-29'; '19.12.2024' -> '2024-12-19'."""
    s = (s or "").strip().lower()
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m:
        return f"{int(m.group(3)):04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    m = re.search(r"(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})", s)
    if m and m.group(2) in PL_MONTHS:
        return f"{int(m.group(3)):04d}-{PL_MONTHS[m.group(2)]:02d}-{int(m.group(1)):02d}"
    return ""


class TextExtractor(HTMLParser):
    """Visible text of an HTML fragment, paragraph-separated, skipping script/style/figure."""
    SKIP = {"script", "style", "noscript", "figure", "picture", "source", "button", "svg"}
    BLOCK = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "tr", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self):
        t = "".join(self.parts)
        t = re.sub(r"[ \t\r\f\v ]+", " ", t)
        t = re.sub(r"\s*\n\s*", "\n", t)
        return t.strip()


def html_text(fragment):
    p = TextExtractor()
    p.feed(fragment)
    return p.text()


# --------------------------------------------------------------------------- extraction
# Known contractors -> (canonical name, ISO country). Matched case-sensitively on stems.
KNOWN = [
    (r"Hut[aąyę] Stalowa Wola|HSW", "Huta Stalowa Wola S.A.", "PL"),
    (r"Rosomak S\.A\.|Rosomak SA|spółk\w+ Rosomak|Rosomak Spółka", "Rosomak S.A.", "PL"),
    (r"Fabryk\w+ Broni|Łucznik", "Fabryka Broni „Łucznik” - Radom Sp. z o.o.", "PL"),
    (r"Mesko|MESKO", "MESKO S.A.", "PL"),
    (r"Jelcz", "Jelcz Sp. z o.o.", "PL"),
    (r"PIT-RADWAR|PIT-Radwar", "PIT-RADWAR S.A.", "PL"),
    (r"WB Electronics|Grup\w+ WB|WB Group|WB GROUP", "WB Electronics S.A. (WB Group)", "PL"),
    (r"Polsk\w+ Grup\w+ Zbrojeniow\w+|\bPGZ\b", "Polska Grupa Zbrojeniowa S.A.", "PL"),
    (r"AMZ[ -]Kutno|AMZ[ -]KUTNO", "AMZ-KUTNO S.A.", "PL"),
    (r"Advanced Protection Systems|\bAPS\b", "Advanced Protection Systems S.A.", "PL"),
    (r"Autocomp", "Autocomp Management Sp. z o.o.", "PL"),
    (r"\bGISS\b", "GISS Sp. z o.o.", "PL"),
    (r"GE Aerospace", "GE Aerospace", "US"),
    (r"Bumar", "Zakłady Mechaniczne Bumar-Łabędy S.A.", "PL"),
    (r"Dezamet", "Dezamet S.A.", "PL"),
    (r"Nitro-Chem", "Nitro-Chem S.A.", "PL"),
    (r"Zakład\w+ Mechaniczn\w+ [„\"]?Tarnów", "Zakłady Mechaniczne Tarnów S.A.", "PL"),
    (r"\bPCO\b", "PCO S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Lotnicz\w+ (?:Nr|nr) ?1|WZL[ -]?(?:Nr ?)?1", "Wojskowe Zakłady Lotnicze Nr 1 S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Lotnicz\w+ (?:Nr|nr) ?2|WZL[ -]?(?:Nr ?)?2", "Wojskowe Zakłady Lotnicze Nr 2 S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Łącznościow\w+|WZŁ", "Wojskowe Zakłady Łączności Nr 1 S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Elektroniczn\w+|WZE", "Wojskowe Zakłady Elektroniczne S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Uzbrojenia|WZU", "Wojskowe Zakłady Uzbrojenia S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Inżynieryjn\w+|WZInż", "Wojskowe Zakłady Inżynieryjne S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Motoryzacyjn\w+|WZM", "Wojskowe Zakłady Motoryzacyjne S.A.", "PL"),
    (r"Wojskow\w+ Zakład\w+ Mechaniczn\w+", "Wojskowe Zakłady Mechaniczne S.A.", "PL"),
    (r"PGZ Stoczni\w+ Wojenn\w+|Stoczni\w+ Wojenn\w+", "PGZ Stocznia Wojenna Sp. z o.o.", "PL"),
    (r"Remontowa Shipbuilding", "Remontowa Shipbuilding S.A.", "PL"),
    (r"Stoczni\w+ Remontow\w+ Nauta|Nauta", "Stocznia Remontowa Nauta S.A.", "PL"),
    (r"Centrum Techniki Morskiej|\bCTM\b", "Ośrodek Badawczo-Rozwojowy Centrum Techniki Morskiej S.A.", "PL"),
    (r"Telesystem-Mesko", "Telesystem-Mesko Sp. z o.o.", "PL"),
    (r"Transbit", "Transbit Sp. z o.o.", "PL"),
    (r"Radmor|RADMOR", "Radmor S.A.", "PL"),
    (r"Teldat", "Teldat Sp. z o.o.", "PL"),
    (r"Lubawa", "Lubawa S.A.", "PL"),
    (r"Maskpol", "Maskpol S.A.", "PL"),
    (r"Arex", "Arex Sp. z o.o.", "PL"),
    (r"PZL[ -]Mielec|Polskie Zakłady Lotnicze", "Polskie Zakłady Lotnicze Sp. z o.o. (PZL Mielec)", "PL"),
    (r"PZL[ -]Świdnik|Świdnik", "Wytwórnia Sprzętu Komunikacyjnego PZL-Świdnik S.A.", "PL"),
    (r"Autosan", "Autosan Sp. z o.o.", "PL"),
    (r"Rheinmetall", "Rheinmetall", "DE"),
    (r"Hanwh?a", "Hanwha Aerospace", "KR"),
    (r"Hyundai Rotem", "Hyundai Rotem", "KR"),
    (r"Korea Aerospace|\bKAI\b", "Korea Aerospace Industries", "KR"),
    (r"Lockheed Martin", "Lockheed Martin", "US"),
    (r"Raytheon|RTX", "Raytheon (RTX)", "US"),
    (r"Northrop Grumman", "Northrop Grumman", "US"),
    (r"Boeing", "Boeing", "US"),
    (r"General Atomics", "General Atomics", "US"),
    (r"General Dynamics", "General Dynamics", "US"),
    (r"Shield AI", "Shield AI", "US"),
    (r"Rząd\w* (?:USA|Stanów Zjednoczonych)|rząd\w* (?:USA|Stanów Zjednoczonych)|\bFMS\b|Foreign Military Sales", "Government of the United States (FMS)", "US"),
    (r"Leonardo", "Leonardo", "IT"),
    (r"Saab", "Saab", "SE"),
    (r"Kongsberg", "Kongsberg", "NO"),
    (r"Nammo", "Nammo", "NO"),
    (r"Thales", "Thales", "FR"),
    (r"Airbus", "Airbus", "FR"),
    (r"MBDA", "MBDA", "FR"),
    (r"KNDS|Nexter|Krauss-Maffei", "KNDS", "FR"),
    (r"Babcock", "Babcock International", "GB"),
    (r"BAE Systems", "BAE Systems", "GB"),
    (r"Rafael", "Rafael Advanced Defense Systems", "IL"),
    (r"Elbit", "Elbit Systems", "IL"),
    (r"Baykar", "Baykar", "TR"),
    (r"Diehl", "Diehl Defence", "DE"),
]
KNOWN_RX = [(re.compile(p), name, cc) for p, name, cc in KNOWN]

# protect inner dots of legal-form suffixes; the final dot is kept so it can still end a sentence
SUFFIX_PROTECT = [("Sp. z o.o", "Sp§z§o§o"), ("sp. z o.o", "sp§z§o§o"), ("S.A", "S§A"), ("Sp.k", "Sp§k"),
                  ("sp.k", "sp§k"), ("Sp. j", "Sp§j"), ("nr ", "nr§"), ("Nr ", "Nr§"), ("Inc.", "Inc§"),
                  ("Ltd.", "Ltd§"), ("Co.", "Co§"), ("GmbH & Co. KG", "GmbH§KG"), (" ok.", " ok§"), (" ul.", " ul§")]

ROLE_RX = re.compile(
    r"(?:pomiędzy|między) Agencj\w+ Uzbrojenia\s*(?:a|oraz|i)\s+(?P<a>[^.;:()]{3,160})"
    r"|(?:Agencj\w+ Uzbrojenia|AU)\s+(?:zawarła|podpisała|zawarło)\s+(?:\w+\s+){0,3}?(?:um[oó]w\w+|kontrakt\w*|aneks\w*)\s+z\s+(?P<b>[^.;:()]{3,160})"
    r"|(?:um[oó]w\w+|kontrakt\w*|aneks\w*)\s+(?:została\s+|zostały\s+|został\s+)?(?:zawart\w+|podpisan\w+)\s+z\s+(?P<c>[^.;:()]{3,160})"
    r"|(?:um[oó]w\w+|kontrakt\w*)\s+z\s+(?P<d>(?:firm|spółk|konsorcj|przedsiębiorstw|rząd|Rząd|Huta|Hut|Fabryk|Wojskow|Zakład|PGZ|WB|Grup|Hanwha|Hyundai|Lockheed|Raytheon|Boeing)[^.;:()]{2,160})"
    r"|(?:Wykonawc\w+|wykonawc\w+)\s+(?:umowy\s+)?(?:jest|są|będzie|będą|została|został|zostało)\s+(?P<e>[^.;:()]{3,160})"
    r"|Stron\w+ (?:um[oó]w\w*|kontrakt\w*)[^.]{0,80}?(?:są|były|jest)\s+Agencj\w+ Uzbrojenia\s*(?:oraz|i|a)\s+(?P<g>[^.;:()]{3,160})"
    r"|(?:Spółka|spółka|Firma|firma|Konsorcjum|konsorcjum)\s+(?P<f>[A-ZŁŚŻŹĆ][^.;:()]{1,120}?)\s+(?:dostarczy|wyprodukuje|zrealizuje|zmodernizuje|wykona)")

STOP_RX = re.compile(r"\s+(?:na|o|w|we|do|dotycząc\w*|której|który|których|obejmując\w*|za|przy|dla|reprezentowan\w*|"
                     r"z siedzibą|zakłada|realizowan\w*|o wartości|wartości|podpisał\w*|zawart\w*|w ramach|dot\.?)(?:\s+.*)?$")


def protect(s):
    for a, b in SUFFIX_PROTECT:
        s = s.replace(a, b)
    return s


def unprotect(s):
    for a, b in SUFFIX_PROTECT:
        s = s.replace(b, a)
    return s


def tidy_name(n):
    n = STOP_RX.sub("", n.strip())
    n = re.sub(r"^(?:z\s+)?(?:(?:firmą|firmy|spółką|spółki|konsorcjum|przedsiębiorstwem)\s+)+(?:firm\w*\s+)?", "", n)
    n = re.sub(r"^(?:Spółk\w+|spółk\w+)\s+(?=[A-ZŁŚŻ])", "", n)
    n = n.strip(" ,-–—\"„”'")
    if len(n) < 2 or len(n) > 140:
        return ""
    if re.match(r"^(?:Agencj|Ministr|MON|Sił Zbrojnych|Skarb|Wojsk\w* Polsk)", n):
        return ""
    return unprotect(n)


NOT_NAME_RX = re.compile(r"\b(?:będzie|będą|podpisywan\w*|Państw\w*|firm[aąy]|joint venture|cyklicznie|"
                         r"najczęściej|który|która|które)\b", re.I)


def plausible_name(p):
    """Trim leading/trailing lowercase words; reject fragments that are clearly not a company name."""
    p = re.sub(r"^(?:[a-ząćęłńóśźż.]+\s+)+(?=[A-ZŁŚŻŹĆ0-9])", "", p.strip())
    while re.search(r"\s[a-ząćęłńóśźż]+$", p) and not re.search(r"(?:sp\.|z) o\.?o\.?$|Sp\. z o\.o$", p):
        p = re.sub(r"\s[a-ząćęłńóśźż]+$", "", p)
    p = p.strip(" ,-–—")
    if re.search(r"(?:S\.A|o\.o|Sp\.k)$", p):
        p += "."
    if (not re.match(r"[A-ZŁŚŻŹĆ0-9]", p) or len(p.split()) > 8 or len(p) < 3 or NOT_NAME_RX.search(p)
            or re.fullmatch(r"(?:Konsorcj|Spółk|Firm|Przedsiębiorstw)\w*", p)):
        return ""
    return p


def split_names(n):
    parts = re.split(r",\s*(?=[A-ZŁŚŻ])|\s+oraz\s+|\s+i\s+(?=[A-ZŁŚŻ])", n)
    return [q for q in (plausible_name(p) for p in parts) if q]


def known_match(name):
    for rx, canon, cc in KNOWN_RX:
        if rx.search(name):
            return canon, cc
    return None, ""


def extract_winners(text):
    t = protect(re.sub(r"(konsorcj\w+(?:\s+firm\w*)?|firm(?:ami|y)?|spółk(?:ami|i))\s*:\s*", r"\g<1> ", text))
    found = []
    for m in ROLE_RX.finditer(t):
        raw = next(v for v in m.groupdict().values() if v)
        nm = tidy_name(raw)
        if nm:
            for part in split_names(nm):
                if part and part not in found:
                    found.append(part)
            # names cut short by a legal-form dot ("X S.A. oraz Y Sp. z o.o."): add known names nearby
            window = unprotect(t[m.start(): m.end() + 120])
            for rx, canon, _cc in KNOWN_RX:
                if rx.search(window) and canon not in found and not canon.startswith("Polska Grupa"):
                    found.append(canon)
    names, countries = [], []
    for nm in found:
        canon, cc = known_match(nm)
        label = canon or nm
        if not cc and re.search(r"Sp\. z o\.o|S\.A|sp\. z o\.o|Spółka", nm):
            cc = "PL"
        if label not in names:
            names.append(label)
            countries.append(cc)
    if not names:  # fallback: known contractors mentioned anywhere in text
        for rx, canon, cc in KNOWN_RX:
            if rx.search(text) and canon not in names:
                names.append(canon)
                countries.append(cc)
            if len(names) >= 3:
                break
    return names[:5], countries[:5]


CUR = {"zł": "PLN", "złotych": "PLN", "złote": "PLN", "pln": "PLN", "usd": "USD", "dolarów": "USD",
       "dolary": "USD", "dolara": "USD", "$": "USD", "eur": "EUR", "euro": "EUR", "gbp": "GBP",
       "funtów": "GBP", "nok": "NOK", "koron": "NOK", "krw": "KRW", "wonów": "KRW", "sek": "SEK"}
MULT = {"mld": 1e9, "miliard": 1e9, "miliardy": 1e9, "miliardów": 1e9, "miliarda": 1e9,
        "mln": 1e6, "milion": 1e6, "miliony": 1e6, "milionów": 1e6, "miliona": 1e6,
        "tys": 1e3, "tys.": 1e3, "tysięcy": 1e3, "bln": 1e12, "": 1}
AMT_RX = re.compile(
    r"(?P<num>\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s*"
    r"(?P<mult>mld|mln|tys\.?|miliard\w*|milion\w*|tysięcy|bln)?\s*"
    r"(?P<cur>zł(?!\w)|złotych|złote|PLN|USD|dolar\w*|EUR(?!\w)|euro|GBP|funtów|NOK|koron|KRW|wonów|SEK)",
    re.I)


def parse_amount(m):
    num = m.group("num").replace(" ", " ")
    if re.search(r"[ .]\d{3}", num) and "," not in num.split(" ")[-1][:0]:
        num = num.replace(" ", "").replace(".", "")
    num = num.replace(",", ".")
    try:
        v = float(num)
    except ValueError:
        return None, ""
    mult = (m.group("mult") or "").lower()
    mult = mult if mult in MULT else (mult.rstrip(".") if mult.rstrip(".") in MULT else "")
    v *= MULT.get(mult, 1)
    cur = m.group("cur").lower()
    cur = "USD" if cur.startswith("dolar") else CUR.get(cur, cur.upper())
    return v, cur


def extract_value(text, year=None):
    """Pick the contract value: prefer sentences about the (total) contract value.
    Sentences mentioning an earlier year than the publication year are skipped (background facts)."""
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-ZŁŚŻ\-–])", text)
    if year:
        old = [any(int(y) < year for y in re.findall(r"\b(20[0-3]\d)\s*(?:r\.|roku|rok)", s)) for s in sentences]
        sentences = [s for i, s in enumerate(sentences) if not old[i] and not (i and old[i - 1])]
    tiers = [
        lambda s: re.search(r"łączn\w+ wartoś|wartość (?:umów|pakietu)", s, re.I),
        lambda s: re.search(r"wartoś\w+ (?:umowy|kontraktu|zamówienia|aneksu)|um[oó]w\w+ o wartości|kontrakt\w* o wartości|"
                            r"wartość (?:ta |tej )?(?:wynosi|to|przekracza|opiewa)", s, re.I),
        lambda s: re.search(r"wartoś|um[oó]w|kontrakt|zamówien|kwot", s, re.I),
    ]
    for tier in tiers:
        for s in sentences:
            if not tier(s):
                continue
            if re.search(r"budżet|PKB|wydatk\w+ na obronność|Fundusz\w* Wsparcia", s, re.I) and not re.search(r"um[oó]w|kontrakt", s, re.I):
                continue
            for m in AMT_RX.finditer(s):
                v, cur = parse_amount(m)
                if v and v >= 1e5:
                    return v, cur
    return None, ""


def classify(text):
    if re.search(r"dialog\w*\s+techniczn", text, re.I):
        return "technical_dialogue"
    if re.search(r"(?:wszcz\w+|ogłosi\w*|rozpocz\w+|prowadzi)\s+(?:\w+\s+){0,2}postępowani\w+|zaprasza do składania ofert|"
                 r"zapytani\w+ ofertow|przetarg\w* (?:ogłoszon|na )", text, re.I) and not re.search(r"podpisan|zawart", text, re.I):
        return "tender"
    if re.search(r"(?:um[oó]w\w+|kontrakt\w*|aneks\w*)[^.]{0,120}(?:podpisan|zawart|zawarł|podpisał)|"
                 r"(?:podpisan|zawart|zawarł|podpisał)\w*[^.]{0,80}(?:um[oó]w|kontrakt|aneks)|zakontraktowan|"
                 r"dostarczy|zamówił|zamówiła|umowa (?:na|dotyczy)", text, re.I):
        return "award"
    if re.search(r"plan\w* postępowań|plan\w* zamówień", text, re.I):
        return "prior_info"
    return "other"


def fmt_value(v):
    if v is None:
        return ""
    return str(int(round(v))) if v >= 1 else str(v)


# --------------------------------------------------------------------------- AU website
NEWSGRID_RX = re.compile(
    r'<a class="newsgrid[^"]*" href="(?P<href>[^"]+)" title="(?P<title>[^"]*)">.*?'
    r'<h3 class="newsgrid-title">(?P<h3>.*?)</h3>.*?'
    r'(?:<div class="newsgrid-date">\s*<div class="text">(?P<date>.*?)</div>.*?)?'
    r'<div class="newsgrid-text">(?P<lead>.*?)</div>\s*</div>\s*</a>', re.S)


def parse_au_grid(page_html):
    items = []
    for m in NEWSGRID_RX.finditer(page_html):
        href = m.group("href")
        if not href.startswith("/au/"):
            continue
        items.append({"href": href, "title": clean(m.group("h3") or m.group("title")),
                      "date": pl_date(clean(m.group("date") or "")), "lead": clean(m.group("lead"))})
    return items


def au_article_text(page_html):
    m = re.search(r'<div class="(?:article|content|richtext|page-content)[^"]*">(.*?)<footer', page_html, re.S)
    frag = m.group(1) if m else page_html
    return html_text(frag)


def collect_au(fetcher, raw_dir, max_articles):
    status = {"home": None, "lists": [], "articles_fetched": 0, "articles_blocked": 0}
    d = os.path.join(raw_dir, "wojsko-polskie_au")
    home, info = fetcher.get(AU_HOME, os.path.join(d, "home.html"), use_cache=False)
    status["home"] = info
    items = parse_au_grid(home) if home else []
    for url in AU_LISTS:
        page, info = fetcher.get(url, os.path.join(d, "list_" + slugify(url.split("/au/")[1]) + ".html"), use_cache=False)
        status["lists"].append(info)
        if page:
            items += parse_au_grid(page)
    seen, recs = set(), []
    for it in items:
        if it["href"] in seen:
            continue
        seen.add(it["href"])
        url = AU_BASE + it["href"]
        body = ""
        if status["articles_fetched"] < max_articles:
            page, info = fetcher.get(url, os.path.join(d, "articles", slugify(it["href"]) + ".html"))
            if page:
                body = au_article_text(page)
                status["articles_fetched"] += 1
            else:
                status["articles_blocked"] += 1
        section = "SAFE" if it["href"].startswith("/au/safe/") else "aktualnosci"
        text = " ".join(x for x in [it["title"] + ".", it["lead"], body] if x)
        recs.append(build_record("agencja_uzbrojenia_www", it["href"].strip("/"), url, it["title"], text,
                                 it["date"], extra_desc=f"[AU section: {section}] " +
                                 ("" if body else "[lead only: article page behind bot challenge] "),
                                 force_type="award" if section == "SAFE" else None))
    return recs, status


# --------------------------------------------------------------------------- MON gov.pl news
MON_ITEM_RX = re.compile(r'<span class="date">\s*([\d.]+)\s*</span>.*?<div class="title">\s*<a href="([^"]+)">(.*?)</a>'
                         r'.*?<div class="intro">(.*?)</div>', re.S)
CANDIDATE_RX = re.compile(
    r"um[oó]w|kontrakt|zamówi|zamawi|dostaw|podpis|zakup|pozysk|Agencj\w+ Uzbrojenia|dialog|przetarg|postępowa|"
    r"moderniz|amunic|pocisk|śmigłow|samolot|czołg|haubic|dron|bezzałog|rosomak|borsuk|krab|piorun|grot|radar|okręt|"
    r"fregat|wyrzutn|SAFE|PGZ|Hut\w|\bWB\b|transporter|karabin|moździerz|rakiet|satelit|apache|patriot|wisła|narew|"
    r"homar|\bk2\b|\bk9\b|f-35|abrams|himars|jelcz|kamizel|hełm|cystern|miliard|mld|mln", re.I)
AU_REL_RX = re.compile(r"Agencj\w+ Uzbrojenia|szef\w* AU\b|\bAU\b|wartoś\w+ (?:umowy|kontraktu|umów)|"
                       r"um[oó]w\w+ (?:na dostaw|wykonawcz)|(?:podpisan|zawart)\w+ (?:um[oó]w|kontrakt)", re.I)


CONTRACT_HEAD = r"um[oó]w|kontrakt|zakup|dostaw|zamówieni|pozyska|aneks|zakontraktow|zamawia"


def mon_article(page_html):
    i, j = page_html.find("<article"), page_html.find("</article>")
    art = page_html[i:j] if i >= 0 and j > i else page_html
    title = clean((re.search(r"<h2[^>]*>(.*?)</h2>", art, re.S) or [None, ""])[1])
    date = pl_date(clean((re.search(r'<p class="event-date">(.*?)</p>', art, re.S) or [None, ""])[1]))
    art = re.sub(r'<div class="(?:main-photo|gallery|video)[^"]*">.*?</div>', " ", art, flags=re.S)
    text = html_text(art)
    text = re.sub(r"(?:>>>\s*)?(?:GALERIA|Wideo|Zdjęcia \(\d+\)|Pokaż zdjęcie \d+ z galerii\.).*$", "", text, flags=re.S)
    return title, date, text.strip()


def collect_mon(fetcher, raw_dir, since, max_pages, max_articles):
    d = os.path.join(raw_dir, "mon_govpl")
    status = {"pages": 0, "list_items": 0, "candidates": 0, "articles_fetched": 0, "kept": 0, "oldest_date": ""}
    recs = []
    fetched = 0
    for page in range(1, max_pages + 1):
        url = MON_LIST.format(page=page)
        ph, info = fetcher.get(url, os.path.join(d, "list", f"page_{page:03d}.html"), use_cache=False)
        if not ph:
            status.setdefault("errors", []).append(info)
            break
        status["pages"] = page
        items = MON_ITEM_RX.findall(ph)
        if not items:
            break
        stop = False
        for date_s, href, title, intro in items:
            date = pl_date(date_s)
            status["list_items"] += 1
            status["oldest_date"] = date
            if date and date < since:
                stop = True
                continue
            title, intro = clean(title), clean(intro)
            if not CANDIDATE_RX.search(title + " " + intro):
                continue
            status["candidates"] += 1
            if fetched >= max_articles:
                continue
            aurl = urllib.parse.urljoin(MON_BASE, href)
            slug = href.rstrip("/").split("/")[-1]
            ah, ainfo = fetcher.get(aurl, os.path.join(d, "articles", slugify(slug) + ".html"))
            if not ah:
                continue
            if ainfo.get("status") != "cache":
                fetched += 1
            status["articles_fetched"] += 1
            atitle, adate, text = mon_article(ah)
            if not AU_REL_RX.search(text):
                continue
            ctype = classify(text)
            au = re.search(r"Agencj\w+ Uzbrojenia", text)
            head = (atitle or title) + " " + text[:1200]
            if ctype == "other":
                continue
            if ctype == "award" and not (re.search(CONTRACT_HEAD, head, re.I) and
                                         (au or re.search(r"wartoś\w+ (?:umowy|kontraktu|umów)", text, re.I))):
                continue
            if ctype != "award" and not au:
                continue
            status["kept"] += 1
            recs.append(build_record("mon_govpl_news", slug, aurl, atitle or title, text, adate or date))
        if stop:
            break
    return recs, status


# --------------------------------------------------------------------------- normalize
def build_record(source, source_id, url, title, text, date, extra_desc="", force_type=None):
    ntype = classify(text)
    if force_type and ntype == "other":
        ntype = force_type
    winners, wcc = (extract_winners(text) if ntype == "award" else ([], []))
    year = int(date[:4]) if date[:4].isdigit() else None
    value, cur = extract_value(text, year) if ntype in ("award", "tender", "prior_info") else (None, "")
    # sanity cap: largest single AU contract 2022-25 was 49.2 bn PLN (AH-64E); >130 bn PLN-equivalent is
    # a budget / programme / EU-loan figure, not a contract value
    if value and value * {"USD": 4.0, "EUR": 4.3, "GBP": 5.0}.get(cur, 1.0) > 130e9:
        value, cur = None, ""
    desc = (extra_desc + text).strip()
    if len(desc) > 2000:
        desc = desc[:1997].rsplit(" ", 1)[0] + "..."
    rec = {c: "" for c in CSV_COLUMNS}
    rec.update(BUYER)
    rec.update({
        "source": source, "source_id": source_id, "url": url, "title": title, "description": desc,
        "notice_type": ntype, "publication_date": date, "language": "pl",
        "winner_names": ";".join(winners), "winner_countries": ";".join(wcc),
        "currency": cur if value else "",
    })
    if ntype == "award":
        rec["award_value"] = fmt_value(value)
    else:
        rec["estimated_value"] = fmt_value(value)
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="data/raw/agencja_uzbrojenia", help="raw output directory")
    ap.add_argument("--csv", default="data/raw/staging/agencja_uzbrojenia_notices.csv")
    ap.add_argument("--months", type=int, default=24, help="look-back window for MON news")
    ap.add_argument("--max-mon-pages", type=int, default=90)
    ap.add_argument("--max-mon-articles", type=int, default=400, help="max NEW MON article fetches per run")
    ap.add_argument("--max-au-articles", type=int, default=60)
    ap.add_argument("--refresh", action="store_true", help="ignore cached article HTML")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(os.path.dirname(args.csv) or ".", exist_ok=True)
    since = (dt.date.today() - dt.timedelta(days=round(args.months * 30.44))).isoformat()
    f = Fetcher(args.out, refresh=args.refresh)
    started = dt.datetime.now().isoformat(timespec="seconds")

    print(f"[AU] {AU_HOME}", file=sys.stderr)
    au_recs, au_status = collect_au(f, args.out, args.max_au_articles)
    print(f"[AU] {len(au_recs)} items; article pages fetched={au_status['articles_fetched']}", file=sys.stderr)

    print(f"[BIP] {BIP_HOME}", file=sys.stderr)
    bip_html, bip_info = f.get(BIP_HOME, os.path.join(args.out, "au_bip", "home.html"), use_cache=False)

    print(f"[MON] news since {since}", file=sys.stderr)
    mon_recs, mon_status = collect_mon(f, args.out, since, args.max_mon_pages, args.max_mon_articles)
    print(f"[MON] {mon_status}", file=sys.stderr)

    recs = au_recs + mon_recs
    recs.sort(key=lambda r: (r["publication_date"], r["source"]), reverse=True)
    with open(os.path.join(args.out, "agencja_uzbrojenia_records.json"), "w", encoding="utf-8") as fh:
        json.dump(recs, fh, ensure_ascii=False, indent=1)
    with open(args.csv, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(recs)

    counts = {}
    for r in recs:
        counts[r["notice_type"]] = counts.get(r["notice_type"], 0) + 1
    status = {
        "run_started": started, "run_finished": dt.datetime.now().isoformat(timespec="seconds"),
        "user_agent": UA, "requests": f.n_requests, "blocked_hosts": sorted(f.blocked),
        "au_website": au_status, "au_bip": bip_info, "mon_news": mon_status,
        "records": len(recs), "by_notice_type": counts,
        "notes": [
            "gov.pl/web/agencja-uzbrojenia 301-redirects to gov.pl root; AU site moved to wojsko-polskie.pl/au/",
            "wojsko-polskie.pl and au-bip.wp.mil.pl are behind Imperva Incapsula JS challenge; not bypassed",
        ],
        "request_log": f.log[-400:],
    }
    with open(os.path.join(args.out, "sources_status.json"), "w", encoding="utf-8") as fh:
        json.dump(status, fh, ensure_ascii=False, indent=1)
    print(f"wrote {len(recs)} records -> {args.csv}; by type {counts}", file=sys.stderr)


if __name__ == "__main__":
    main()
