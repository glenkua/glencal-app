"""Delayed quotes and chart history for GlenCal (ticker, Brief, FX converter, Watchlist). Standard library only.
Run by .github/workflows/markets.yml about every 10 minutes; files are pushed to the 'markets' branch.
  markets.json   last price and previous close for every instrument
  hist-1d.json   today, 5-minute points        (every run)
  hist-1w.json   past 5 days, hourly points     (refreshed when older than 30 minutes)
  hist-1y.json   past year, daily closes        (refreshed when older than 3 hours)"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

SGT = timezone(timedelta(hours=8))
# (key shown in the app, Yahoo symbol, kind, group, name). "tk" items also scroll in the ticker.
U = [
    ("USDSGD", "USDSGD=X", "fx", "FX", "US dollar / Singapore dollar"), ("EURUSD", "EURUSD=X", "fx", "FX", "Euro / US dollar"),
    ("GBPUSD", "GBPUSD=X", "fx", "FX", "Pound / US dollar"), ("USDJPY", "JPY=X", "fx", "FX", "US dollar / yen"),
    ("AUDUSD", "AUDUSD=X", "fx", "FX", "Aussie / US dollar"), ("NZDUSD", "NZDUSD=X", "fx", "FX", "Kiwi / US dollar"),
    ("USDCHF", "CHF=X", "fx", "FX", "US dollar / Swiss franc"), ("USDCAD", "CAD=X", "fx", "FX", "US dollar / Canadian dollar"),
    ("USDCNH", "CNH=X", "fx", "FX", "US dollar / offshore yuan"), ("USDHKD", "HKD=X", "fx", "FX", "US dollar / Hong Kong dollar"),
    ("USDKRW", "KRW=X", "fx", "FX", "US dollar / Korean won"), ("USDINR", "INR=X", "fx", "FX", "US dollar / Indian rupee"),
    ("USDMYR", "MYR=X", "fx", "FX", "US dollar / ringgit"), ("USDIDR", "IDR=X", "fx", "FX", "US dollar / rupiah"),
    ("USDTHB", "THB=X", "fx", "FX", "US dollar / baht"), ("USDPHP", "PHP=X", "fx", "FX", "US dollar / peso"),
    ("USDTWD", "TWD=X", "fx", "FX", "US dollar / Taiwan dollar"),
    ("EURSGD", "EURSGD=X", "fx", "FX", "Euro / Singapore dollar"), ("GBPSGD", "GBPSGD=X", "fx", "FX", "Pound / Singapore dollar"),
    ("AUDSGD", "AUDSGD=X", "fx", "FX", "Aussie / Singapore dollar"), ("SGDJPY", "SGDJPY=X", "fx", "FX", "Singapore dollar / yen"),
    ("EURJPY", "EURJPY=X", "fx", "FX", "Euro / yen"), ("DXY", "DX-Y.NYB", "index", "FX", "US dollar index"),
    ("UST 3M", "^IRX", "yield", "Rates", "US Treasury 3-month yield"), ("UST 2Y", "2YY=F", "yield", "Rates", "US 2-year yield (CBOT futures)"),
    ("UST 5Y", "^FVX", "yield", "Rates", "US Treasury 5-year yield"), ("UST 10Y", "^TNX", "yield", "Rates", "US Treasury 10-year yield"),
    ("UST 30Y", "^TYX", "yield", "Rates", "US Treasury 30-year yield"),
    ("SPX", "^GSPC", "index", "Indices", "S&P 500"), ("NDX", "^NDX", "index", "Indices", "Nasdaq 100"), ("DOW", "^DJI", "index", "Indices", "Dow Jones"),
    ("RUT", "^RUT", "index", "Indices", "Russell 2000"), ("VIX", "^VIX", "index", "Indices", "VIX volatility"),
    ("STI", "^STI", "index", "Indices", "Straits Times Index"), ("NKY", "^N225", "index", "Indices", "Nikkei 225"),
    ("HSI", "^HSI", "index", "Indices", "Hang Seng"), ("SHCOMP", "000001.SS", "index", "Indices", "Shanghai Composite"),
    ("KOSPI", "^KS11", "index", "Indices", "KOSPI"), ("ASX200", "^AXJO", "index", "Indices", "S&P/ASX 200"),
    ("FTSE", "^FTSE", "index", "Indices", "FTSE 100"), ("DAX", "^GDAXI", "index", "Indices", "DAX"), ("SX5E", "^STOXX50E", "index", "Indices", "Euro Stoxx 50"),
    ("GOLD", "GC=F", "cmd", "Commodities", "Gold futures"), ("SILVER", "SI=F", "cmd", "Commodities", "Silver futures"),
    ("WTI", "CL=F", "cmd", "Commodities", "WTI crude futures"), ("BRENT", "BZ=F", "cmd", "Commodities", "Brent crude futures"),
    ("COPPER", "HG=F", "cmd", "Commodities", "Copper futures"), ("NATGAS", "NG=F", "cmd", "Commodities", "Natural gas futures"),
    ("BTC", "BTC-USD", "crypto", "Crypto", "Bitcoin (USD)"), ("ETH", "ETH-USD", "crypto", "Crypto", "Ether (USD)"),
    ("DBS", "D05.SI", "stock", "Stocks", "DBS Group"), ("OCBC", "O39.SI", "stock", "Stocks", "OCBC"), ("UOB", "U11.SI", "stock", "Stocks", "UOB"),
    ("SINGTEL", "Z74.SI", "stock", "Stocks", "Singtel"), ("AAPL", "AAPL", "stock", "Stocks", "Apple"), ("MSFT", "MSFT", "stock", "Stocks", "Microsoft"),
    ("NVDA", "NVDA", "stock", "Stocks", "Nvidia"), ("GOOGL", "GOOGL", "stock", "Stocks", "Alphabet"), ("AMZN", "AMZN", "stock", "Stocks", "Amazon"),
    ("META", "META", "stock", "Stocks", "Meta"), ("TSLA", "TSLA", "stock", "Stocks", "Tesla"),
]
TICKER = ["USDSGD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "SPX", "NDX", "DOW", "UST 2Y", "UST 5Y", "UST 10Y", "UST 30Y"]

def chart(sym, rng, interval):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(sym) + "?range=" + rng + "&interval=" + interval
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.loads(r.read().decode("utf-8"))["chart"]["result"][0]
    ts = res.get("timestamp") or []
    cl = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    pts = [(t, round(c, 6)) for t, c in zip(ts, cl) if c is not None]
    return res["meta"], pts

def pack(pts):   # compact: first time + minute offsets
    if not pts: return None
    t0 = pts[0][0]
    return {"t0": t0, "m": [round((t - t0) / 60) for t, _ in pts], "c": [c for _, c in pts]}

def load(name):
    try: return json.load(open(name, encoding="utf-8"))
    except Exception: return {}

now = time.time()
items, h1d, fails = [], {}, 0
for key, sym, kind, group, name in U:
    try:
        meta, pts = chart(sym, "1d", "5m")
        t = meta.get("regularMarketTime")
        items.append({"k": key, "kind": "fx" if kind == "fx" else kind, "group": group, "name": name, "tk": key in TICKER,
                      "price": meta.get("regularMarketPrice"), "prev": meta.get("chartPreviousClose") or meta.get("previousClose"),
                      "t": datetime.fromtimestamp(t, SGT).strftime("%Y-%m-%d %H:%M") if t else ""})
        h1d[key] = pack(pts)
    except Exception as e:
        fails += 1; print("skip", key, e)
if fails > len(U) // 2:
    sys.exit("too many failures; keeping the previous files")
items.sort(key=lambda it: (TICKER.index(it["k"]) if it["k"] in TICKER else len(TICKER)))   # ticker and Brief keep their order
# yields: keep the conventional "kind" so the app formats them as yields
for it in items:
    if it["group"] == "Rates": it["kind"] = "yield"

def refresh(name, max_age, rng, interval):
    old = load(name)
    if old.get("at", 0) > now - max_age: print("keep", name); return old
    out = {"at": now, "s": {}}
    for key, sym, *_ in U:
        try: out["s"][key] = pack(chart(sym, rng, interval)[1])
        except Exception as e:
            print("skip", name, key, e)
            if key in old.get("s", {}): out["s"][key] = old["s"][key]
    return out

h1w = refresh("hist-1w.json", 30 * 60, "5d", "60m")
h1y = refresh("hist-1y.json", 3 * 3600, "1y", "1d")
stamp = datetime.now(SGT).strftime("%Y-%m-%d %H:%M")
json.dump({"updated": stamp, "source": "Yahoo Finance (delayed)", "items": items}, open("markets.json", "w", encoding="utf-8"), indent=0)
json.dump({"at": now, "updated": stamp, "s": h1d}, open("hist-1d.json", "w", encoding="utf-8"), separators=(",", ":"))
json.dump(h1w, open("hist-1w.json", "w", encoding="utf-8"), separators=(",", ":"))
json.dump(h1y, open("hist-1y.json", "w", encoding="utf-8"), separators=(",", ":"))
print(len(items), "quotes;", len(h1d), "1D;", len(h1w.get("s", {})), "1W;", len(h1y.get("s", {})), "1Y")
