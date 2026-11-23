"""Fetches this week's (and next week's, when published) high-impact releases for tier-1 currencies
and keeps a rolling file at data/finance-live.json. Times are converted to Singapore time (UTC+8).
Runs on GitHub Actions every 6 hours. Standard library only."""
import json, re, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CCY = {"USD", "JPY", "EUR", "GBP", "AUD", "NZD", "SGD"}
URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]
OUT = Path(__file__).resolve().parent.parent / "data" / "finance-live.json"
SGT = timezone(timedelta(hours=8))
CB = re.compile(r"rate decision|cash rate|funds rate|policy rate|bank rate|monetary policy|press conference|policy statement|interest rate", re.I)

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print("skip", url, e)
        return []

old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else []
by_key = {x["id"]: x for x in old}
fresh = 0
for url in URLS:
    for e in fetch(url):
        if e.get("impact") != "High" or e.get("country") not in CCY:
            continue
        try:
            t = datetime.fromisoformat(e["date"]).astimezone(SGT)
        except Exception:
            continue
        item = {"date": t.date().isoformat(), "time": t.strftime("%H:%M"), "ccy": e["country"], "title": e["title"].strip(),
                "kind": "cb" if CB.search(e["title"]) else "data",
                "forecast": (e.get("forecast") or "").strip(), "previous": (e.get("previous") or "").strip()}
        item["id"] = "live-" + item["date"] + "-" + item["ccy"] + "-" + re.sub(r"\W+", "", item["title"]).lower()
        by_key[item["id"]] = item
        fresh += 1

cutoff = (datetime.now(SGT) - timedelta(days=60)).date().isoformat()
items = sorted((x for x in by_key.values() if x["date"] >= cutoff), key=lambda x: (x["date"], x["time"], x["ccy"]))
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"updated": datetime.now(SGT).strftime("%Y-%m-%d %H:%M"), "items": items}, indent=1), encoding="utf-8")
print(fresh, "fetched,", len(items), "kept")
