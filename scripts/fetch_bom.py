"""
fetch_bom.py — pobiera z TED prawdziwą, wielolotową notyfikację
i zapisuje jej loty jako BOM w CSV. Bez klucza API, bez logowania.
"""
import csv
import requests

URL = "https://api.ted.europa.eu/v3/notices/search"

def find_candidates(cpv_prefix="35", limit=50):
    """Szuka otwartych notyfikacji w danym dziale CPV i liczy loty."""
    payload = {
        "query": f"classification-cpv IN ({cpv_prefix}000000) AND publication-date >= 20260901",
        "fields": ["publication-number", "notice-title", "buyer-name",
                   "buyer-country", "title-lot"],
        "scope": "ACTIVE",
        "limit": limit,
    }
    resp = requests.post(URL, json=payload)
    resp.raise_for_status()
    notices = resp.json().get("notices", [])

    rows = []
    for n in notices:
        title_lot = n.get("title-lot") or []
        n_lots = len(title_lot) if isinstance(title_lot, list) else 0
        rows.append({
            "publication_number": n.get("publication-number"),
            "buyer": n.get("buyer-name", [""])[0] if isinstance(n.get("buyer-name"), list) else n.get("buyer-name"),
            "country": n.get("buyer-country"),
            "title": n.get("notice-title", {}).get("eng", "") if isinstance(n.get("notice-title"), dict) else n.get("notice-title"),
            "n_lots": n_lots,
        })
    rows.sort(key=lambda r: abs(r["n_lots"] - 10))

    with open("bom_candidates.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["publication_number", "buyer", "country", "title", "n_lots"])
        writer.writeheader()
        writer.writerows(rows)

    print("Zapisano bom_candidates.csv — posortowane najbliżej 10 lotów.")
    for r in rows[:10]:
        print(f"{r['publication_number']} | {r['n_lots']} lotów | {r['buyer']} | {r['title']}")


def fetch_lots_as_bom(publication_number: str):
    """Dociąga treść lotów wybranej notyfikacji i zapisuje bom.csv."""
    payload = {
        "query": f"publication-number = {publication_number}",
        "fields": ["publication-number", "title-lot", "description-lot",
                   "main-classification-lot", "deadline-receipt-tender-date-lot"],
        "limit": 1,
    }
    resp = requests.post(URL, json=payload)
    resp.raise_for_status()
    notices = resp.json().get("notices", [])
    if not notices:
        print("Nie znaleziono notyfikacji o tym numerze.")
        return
    n = notices[0]

    titles = n.get("title-lot") or []
    descriptions = n.get("description-lot") or []
    cpvs = n.get("main-classification-lot") or []
    deadlines = n.get("deadline-receipt-tender-date-lot") or []

    rows = []
    for i, title in enumerate(titles):
        t = title.get("eng", title) if isinstance(title, dict) else title
        d = descriptions[i] if i < len(descriptions) else ""
        d = d.get("eng", d) if isinstance(d, dict) else d
        rows.append({
            "lot_no": i + 1,
            "component": t,
            "description": d,
            "cpv": cpvs[i] if i < len(cpvs) else "",
            "deadline": deadlines[i] if i < len(deadlines) else "",
            "source_notice": publication_number,
            "source_url": f"https://ted.europa.eu/en/notice/-/detail/{publication_number}",
        })

    with open("bom.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["lot_no", "component", "description",
                                                "cpv", "deadline", "source_notice", "source_url"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Zapisano bom.csv — {len(rows)} pozycji z notyfikacji {publication_number}.")


if __name__ == "__main__":
    find_candidates(cpv_prefix="35")  # zmień prefiks CPV na swoją kategorię
    choice = input("\nWklej publication_number wybranej notyfikacji: ").strip()
    fetch_lots_as_bom(choice)