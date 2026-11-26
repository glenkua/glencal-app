"""Daily market brief for GlenCal, built once a day at 7am Singapore time from news.json and markets.json.
Qualitative only: one line on the overall tone (worked out from the actual moves) and 4-5 headline bullets,
one per theme, from the NY session of the previous US business day. No AI and nothing invented: every bullet
is a real headline with its source and link. Standard library only.
Keeps the existing brief.json until it's time for a new one (after 07:00 SGT, when the US business day has changed)."""
import json, re, sys
from datetime import datetime, timedelta, timezone

SGT = timezone(timedelta(hours=8))
now = datetime.now(SGT)
force = "--force" in sys.argv

def load(name):
    try: return json.load(open(name, encoding="utf-8"))
    except Exception: return {}

# the US business day the brief covers: the last weekday before today's Singapore date
asof = (now - timedelta(days=1)).date()
while asof.weekday() >= 5: asof -= timedelta(days=1)
old = load("brief.json")
if not force and old.get("v") == 2 and (now.hour < 7 or old.get("asof") == asof.isoformat()):
    print("keep brief", old.get("asof")); sys.exit(0)

news = load("news.json").get("items", [])
mkt = {q["k"]: q for q in load("markets.json").get("items", [])}

# NY session in Singapore time: from 6pm SGT on the business day to 7am SGT the next morning
lo = datetime(asof.year, asof.month, asof.day, 18, 0, tzinfo=SGT).strftime("%Y-%m-%d %H:%M")
hi = (datetime(asof.year, asof.month, asof.day, 7, 0, tzinfo=SGT) + timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
pool = [n for n in news if lo <= n["t"] <= hi and not (n.get("sg") and not re.search(r"\b(mas|sgd|singapore dollar|sti)\b", n["title"], re.I))]

SRC_W = {"BBG": 3, "FT": 3, "FED": 3, "ECB": 2, "BOJ": 2, "BOE": 2, "RBNZ": 1, "CNBC": 2, "FXS": 2, "INV": 1, "ST": 1}
THEMES = [  # (key, label, emoji, pattern) in display order
    ("cb", "Central banks", "🏛", r"\b(fed|fomc|powell|ecb|lagarde|boj|ueda|boe|bailey|rba|rbnz|pboc|mas|rbi|bok|central bank|rate (cut|hike|decision)|policy rate|minutes)\b"),
    ("rates", "Rates", "📉", r"\b(treasuries|treasury (yields?|notes?|bonds?|bills?|market|auction|curve)|yields?|bond (market|traders|investors|sale)|bonds|gilts?|bunds?|jgbs?|note auction|yield curve|basis points?|duration)\b"),
    ("fx", "FX", "💱", r"\b(dollar|greenback|dxy|euro|yen|sterling|pound|franc|aussie|kiwi|loonie|currenc(y|ies)|fx|forex|intervention)\b"),
    ("asiafx", "Asia FX", "🌏", r"\b(yuan|cnh|renminbi|won|rupee|taiwan dollar|ringgit|rupiah|baht|peso|sgd|singapore dollar|asian currenc\w*|asia fx|emerging-market currenc\w*)\b"),
    ("eq", "Equities", "📈", r"\b(stocks?|shares|equit(y|ies)|s&p|nasdaq|dow|nikkei|hang seng|kospi|earnings|rally|selloff|sell-off|tech|chipmakers?|nvidia)\b"),
    ("cmd", "Commodities", "🛢", r"\b(oil|crude|brent|wti|opec|gold|silver|copper|lng|natural gas|commodit(y|ies))\b"),
    ("macro", "Macro", "🌐", r"\b(inflation|cpi|pce|gdp|jobs|payrolls|jobless|unemployment|pmi|retail sales|tariffs?|trade (war|deal|talks|deficit|surplus|tensions)|recession|economy|china|war|sanctions?|ceasefire)\b"),
]
POLICY = re.compile(r"\b(rates?|policy|monetary|fomc|minutes|inflation|decision|statement|hike|cut|hold|pause|easing|tightening|speech|remarks|testimony|outlook|governing council|mpc)\b", re.I)
ADMIN = re.compile(r"\b(agreement|thresholds?|enforcement|appoint\w*|announces? (the )?(results|approval)|consumer|banking organi[sz]ations?|application|supervis\w*|payments? system|t2|target2|staff|museum|careers?)\b", re.I)
EQ = re.compile(THEMES[4][3], re.I)
USCLOSE = re.compile(r"\b(us stocks|u\.s\. stocks|wall street|s&p 500|nasdaq|dow|stocks close|close (higher|lower))\b", re.I)
SOFT = re.compile(r"\b(opinion|podcast|video|live:|how to|what to know|explainer|newsletter|quiz|watch:)\b", re.I)

def words(t): return set(w for w in re.findall(r"[a-z]{4,}", t.lower()))
picked, used = [], []
for key, label, emo, pat in THEMES:
    rx = re.compile(pat, re.I)
    cands = [n for n in pool if rx.search(n["title"]) and not SOFT.search(n["title"]) and n["url"] not in used
             and not any(len(words(n["title"]) & words(p["t"])) / max(1, len(words(n["title"]) | words(p["t"]))) > 0.4 for p in picked)]
    if key == "cb": cands = [n for n in cands if POLICY.search(n["title"]) and not ADMIN.search(n["title"])]
    else: cands = [n for n in cands if not n.get("cb")]   # central-bank press releases only count as central-bank news
    if key == "macro": cands = [n for n in cands if not EQ.search(n["title"])]   # stock stories belong to Equities
    if not cands: continue
    bonus = (lambda n: 3 if USCLOSE.search(n["title"]) else 0) if key == "eq" else (lambda n: 0)   # equities: the US close, not an earlier global wrap
    best = max(cands, key=lambda n: (SRC_W.get(n["src"], 1) * 2 + (1 if n.get("cb") else 0) + bonus(n), n["t"]))
    picked.append({"k": key, "label": label, "e": emo, "t": best["title"].strip()[:140], "src": best["src"], "url": best["url"]})
    used.append(best["url"])
    if len(picked) >= 5: break
picked = [p for p in picked if p["k"] != "macro"]   # macro stories are left to Headlines

# tone, from the moves themselves (words only; the numbers are already on the Brief)
daily = load("hist-2y.json").get("s", {})
def closes(k):   # (previous close, close) for the business day the brief covers, from daily bars; falls back to live quotes
    s = daily.get(k)
    if s:
        # Yahoo stamps daily bars at the session start (US stocks ~14:30 UTC, FX ~23:00 UTC the evening before);
        # shifting by 6 hours puts both on the right trading date
        days = [((datetime.fromtimestamp(s["t0"] + m * 60, timezone.utc) + timedelta(hours=6)).date(), c) for m, c in zip(s["m"], s["c"])]
        for i in range(1, len(days)):
            if days[i][0] == asof: return days[i - 1][1], days[i][1]
    q = mkt.get(k)
    return (q.get("prev"), q.get("price")) if q else (None, None)
def pct(k):
    a, b = closes(k)
    return (b - a) / a * 100 if a and b else None
def bp(k):
    a, b = closes(k)
    return (b - a) * 100 if a and b else None
def say(v, lo_, hi_, words_):   # words_: (big down, down, flat, up, big up)
    if v is None: return None
    return words_[0] if v <= -hi_ else words_[1] if v <= -lo_ else words_[4] if v >= hi_ else words_[3] if v >= lo_ else words_[2]
spx, ust, dxy, oil, gold = pct("SPX"), bp("UST 10Y"), pct("DXY"), pct("BRENT"), pct("XAUUSD")
parts = [p for p in [
    say(spx, 0.25, 1.0, ("stocks sold off", "stocks softer", "stocks flat", "stocks firmer", "stocks rallied")),
    say(ust, 2, 6, ("Treasuries rallied hard", "yields lower", "yields little changed", "yields higher", "Treasuries sold off")),
    say(dxy, 0.15, 0.5, ("dollar slid", "dollar softer", "dollar steady", "dollar firmer", "dollar surged")),
    say(oil, 0.75, 2.5, ("oil slumped", "oil lower", "oil steady", "oil higher", "oil jumped")),
] if p]
score = sum(x for x in [(1 if (spx or 0) > 0.25 else -1 if (spx or 0) < -0.25 else 0), (1 if (dxy or 0) < -0.15 else -1 if (dxy or 0) > 0.15 else 0)])
mood = "Risk-on" if score >= 1 else "Risk-off" if score <= -1 else "Mixed"
tone = mood + ": " + ", ".join(parts) + "." if parts else ""
spx_days = daily.get("SPX")
if spx_days and not any(((datetime.fromtimestamp(spx_days["t0"] + m * 60, timezone.utc) + timedelta(hours=6)).date() == asof) for m in spx_days["m"]):
    if (datetime.fromtimestamp(spx_days["t0"] + spx_days["m"][-1] * 60, timezone.utc) + timedelta(hours=6)).date() < asof:
        tone = "US holiday: stock and bond markets were closed, so moves were thin."   # no S&P bar for that day, and later days exist or none yet
        gold = None
if gold is not None and abs(gold) >= 1: tone = tone[:-1] + "; gold " + ("up sharply" if gold > 0 else "down sharply") + "."

out = {"v": 2, "asof": asof.isoformat(), "label": "NY close " + asof.strftime("%a %d %b"), "made": now.strftime("%Y-%m-%d %H:%M"),
       "tone": tone, "items": picked, "note": "Headlines from the NY session (6pm–7am SGT). Tone from the day's moves."}
json.dump(out, open("brief.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("brief", out["label"], "|", tone, "|", len(picked), "items")
for p in picked: print("  ", p["e"], p["label"], "|", p["t"][:90], "|", p["src"])
