"""Fetches delayed quotes for the GlenCal ticker and writes markets.json. Standard library only.
Run by .github/workflows/markets.yml about every 10 minutes; the file is pushed to the 'markets' branch."""
import json, sys, urllib.request
from datetime import datetime, timedelta, timezone

SYMBOLS = [  # (label, Yahoo symbol, kind)
    ("USDSGD", "USDSGD=X", "fx"), ("EURUSD", "EURUSD=X", "fx"), ("GBPUSD", "GBPUSD=X", "fx"),
    ("USDJPY", "JPY=X", "fx"), ("AUDUSD", "AUDUSD=X", "fx"),
    ("SPX", "^GSPC", "index"), ("NDX", "^NDX", "index"), ("DOW", "^DJI", "index"),
    ("UST 2Y", "2YY=F", "yield"), ("UST 5Y", "^FVX", "yield"), ("UST 10Y", "^TNX", "yield"), ("UST 30Y", "^TYX", "yield"),
]
SGT = timezone(timedelta(hours=8))

def quote(sym):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(sym) + "?range=1d&interval=5m"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        m = json.loads(r.read().decode("utf-8"))["chart"]["result"][0]["meta"]
    return m["regularMarketPrice"], m.get("chartPreviousClose") or m.get("previousClose"), m.get("regularMarketTime")

import urllib.parse
items = []
for label, sym, kind in SYMBOLS:
    try:
        price, prev, t = quote(sym)
        items.append({"k": label, "kind": kind, "price": price, "prev": prev,
                      "t": datetime.fromtimestamp(t, SGT).strftime("%Y-%m-%d %H:%M") if t else ""})
    except Exception as e:
        print("skip", sym, e)
if len(items) < len(SYMBOLS) // 2:
    sys.exit("too many failures; keeping the previous file")
out = {"updated": datetime.now(SGT).strftime("%Y-%m-%d %H:%M"), "source": "Yahoo Finance (delayed)", "items": items}
open("markets.json", "w", encoding="utf-8").write(json.dumps(out, indent=1))
print(len(items), "quotes")
