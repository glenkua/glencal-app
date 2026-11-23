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
        prev = by_key.get(item["id"]) or {}
        for k in ("actual", "actualSrc"):            # keep actuals found on earlier runs
            if prev.get(k): item[k] = prev[k]
        by_key[item["id"]] = item
        fresh += 1

# ---- Actual prints ----
# 1) US data from the Bureau of Labor Statistics' public API (official figures; reference month = month before release).
BLS = {"CPI_SA": "CUSR0000SA0", "CORE_SA": "CUSR0000SA0L1E", "CPI_NSA": "CUUR0000SA0", "CORE_NSA": "CUUR0000SA0L1E",
       "NFP": "CES0000000001", "UR": "LNS14000000", "AHE": "CES0500000003"}
def bls_data():
    y = datetime.now(SGT).year
    body = json.dumps({"seriesid": list(BLS.values()), "startyear": str(y - 1), "endyear": str(y)}).encode()
    req = urllib.request.Request("https://api.bls.gov/publicAPI/v1/timeseries/data/", data=body,
                                 headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
    except Exception as e:
        print("BLS skipped:", e); return {}
    if d.get("status") != "REQUEST_SUCCEEDED":
        print("BLS:", d.get("message")); return {}
    inv, out = {v: k for k, v in BLS.items()}, {}
    for srs in d["Results"]["series"]:
        for x in srs["data"]:
            if x["period"].startswith("M") and x["period"] != "M13":
                try: out[(inv[srs["seriesID"]], int(x["year"]), int(x["period"][1:]))] = float(x["value"])
                except ValueError: pass
    return out
def shift(y, m, n):
    t = y * 12 + (m - 1) + n
    return t // 12, t % 12 + 1
def bls_actual(title, release, B):
    y, m = shift(int(release[:4]), int(release[5:7]), -1)
    def pct(k, back):
        a, b = B.get((k, y, m)), B.get((k,) + shift(y, m, -back))
        return (a / b - 1) * 100 if a and b else None
    t = title.lower().strip()
    if t == "cpi m/m": v = pct("CPI_SA", 1); return v is not None and "%.2f%%" % v
    if t == "cpi y/y": v = pct("CPI_NSA", 12); return v is not None and "%.1f%%" % v
    if t == "core cpi m/m": v = pct("CORE_SA", 1); return v is not None and "%.2f%%" % v
    if t == "core cpi y/y": v = pct("CORE_NSA", 12); return v is not None and "%.1f%%" % v
    if t == "non-farm employment change":
        a, b = B.get(("NFP", y, m)), B.get(("NFP",) + shift(y, m, -1))
        return a is not None and b is not None and "%dK" % round(a - b)
    if t == "unemployment rate": a = B.get(("UR", y, m)); return a is not None and "%.1f%%" % a
    if t == "average hourly earnings m/m": v = pct("AHE", 1); return v is not None and "%.2f%%" % v
    return False
today = datetime.now(SGT).date().isoformat()
B = bls_data()
for x in by_key.values():
    if x["ccy"] == "USD" and x["date"] <= today and B:
        a = bls_actual(x["title"], x["date"], B)
        if a: x["actual"], x["actualSrc"] = a, "bls"
# 2) Everything else: the next release of the same series lists this one as "previous" (may be revised).
series = {}
for x in by_key.values():
    series.setdefault((x["ccy"], x["title"]), []).append(x)
for lst in series.values():
    lst.sort(key=lambda z: (z["date"], z["time"]))
    for a, b in zip(lst, lst[1:]):
        if not a.get("actual") and b.get("previous") and a["date"] < b["date"]:
            a["actual"], a["actualSrc"] = b["previous"], "next"

cutoff = (datetime.now(SGT) - timedelta(days=60)).date().isoformat()
items = sorted((x for x in by_key.values() if x["date"] >= cutoff), key=lambda x: (x["date"], x["time"], x["ccy"]))
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"updated": datetime.now(SGT).strftime("%Y-%m-%d %H:%M"), "items": items}, indent=1), encoding="utf-8")
print(fresh, "fetched,", len(items), "kept")
