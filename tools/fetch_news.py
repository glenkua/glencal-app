"""Collects headlines from free public feeds into news.json (last 48 hours, newest first).
Run with fetch_markets.py by .github/workflows/markets.yml; pushed to the 'markets' branch. Standard library only."""
import json, re, urllib.request, html
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

SGT = timezone(timedelta(hours=8))
FEEDS = [  # (tag, url, central bank?)
    ("FXS", "https://www.fxstreet.com/rss/news", False),
    ("INV", "https://www.investing.com/rss/news_1.rss", False),
    ("INV", "https://www.investing.com/rss/news_95.rss", False),
    ("BBG", "https://feeds.bloomberg.com/markets/news.rss", False),
    ("BBG", "https://feeds.bloomberg.com/economics/news.rss", False),
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", False),
    ("FT", "https://www.ft.com/markets?format=rss", False),
    ("ST", "https://www.straitstimes.com/news/business/rss.xml", False),
    ("ST SG", "https://www.straitstimes.com/news/singapore/rss.xml", False),
    ("CNA SG", "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416", False),
    ("FED", "https://www.federalreserve.gov/feeds/press_all.xml", True),
    ("ECB", "https://www.ecb.europa.eu/rss/press.html", True),
    ("BOE", "https://www.bankofengland.co.uk/rss/news", True),
    ("BOJ", "https://www.boj.or.jp/en/rss/whatsnew.xml", True),
    ("RBNZ", "https://www.rbnz.govt.nz/feeds/news", True),
]
CCY = [("USD", r"\b(usd|dollar|fed|fomc|powell|treasur|u\.s\.|us )"), ("EUR", r"\b(eur|euro|ecb|lagarde|eurozone|germany|bund)"),
       ("JPY", r"\b(jpy|yen|boj|ueda|japan)"), ("GBP", r"\b(gbp|sterling|pound|boe|bailey|gilts?|uk )"),
       ("AUD", r"\b(aud|aussie|rba|australia)"), ("NZD", r"\b(nzd|kiwi|rbnz|new zealand)"), ("SGD", r"\b(sgd|singapore|mas )")]
# FX/rates/macro first; equity stories are kept but capped so they don't dominate.
MACRO = re.compile(r"\b(dollar|yen|euro|sterling|pound|franc|yuan|renminbi|currenc|fx|forex|usd|eur|jpy|gbp|aud|nzd|sgd|cad|chf|cny|yields?|treasur|bonds?|gilts?|bunds?|jgbs?|rates?|rate cut|rate hike|fed|fomc|ecb|boj|boe|rba|rbnz|mas|central bank|inflation|cpi|pce|ppi|pmi|gdp|payrolls?|jobs|unemployment|jobless|retail sales|econom|recession|tariffs?|trade|deficit|fiscal|budget|debt|oil|crude|gold|commodit|powell|lagarde|ueda|bailey|bullock|monetary|policy|swaps?|ois|curve)\b", re.I)
EQUITY = re.compile(r"\b(stocks?|shares|equit\w*|ipo|earnings|nasdaq|s&p|dow jones|nikkei|hang seng|ftse|stoxx|startups?|ceo|nvidia|apple|tesla|microsoft|amazon|meta|alphabet|google|openai|ai|chips?|semiconductors?|etfs?|buybacks?|dividends?|crypto|bitcoin|valuations?)\b", re.I)
SG_FEEDS = {"ST SG", "CNA SG"}
CB_SRC_CCY = {"FED": "USD", "ECB": "EUR", "BOE": "GBP", "BOJ": "JPY", "RBNZ": "NZD"}

def text(el, *names):
    for n in names:
        x = el.find(n)
        if x is not None:
            v = (x.text or "").strip() or x.get("href", "")
            if v: return v
    return ""

def when(s):
    for f in (parsedate_to_datetime, lambda v: datetime.fromisoformat(v.replace("Z", "+00:00"))):
        try:
            d = f(s)
            return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(SGT)
        except Exception:
            pass
    return None

items, seen = [], set()
cutoff = datetime.now(SGT) - timedelta(hours=48)
cutoff_cb = datetime.now(SGT) - timedelta(days=14)   # central banks post rarely: keep two weeks
for tag, url, cb in FEEDS:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/rss+xml, application/xml, text/xml"})
        root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read())
    except Exception as e:
        print("skip", tag, url, e); continue
    for el in root.iter():
        name = el.tag.split("}")[-1]
        if name not in ("item", "entry"): continue
        kids = {c.tag.split("}")[-1]: c for c in el}
        title = html.unescape(re.sub(r"<[^>]+>", "", (kids.get("title").text if kids.get("title") is not None else "") or "")).strip()
        link_el = kids.get("link")
        link = ((link_el.text or "").strip() or link_el.get("href", "")) if link_el is not None else ""
        d = None
        for k in ("pubDate", "date", "published", "updated"):
            if kids.get(k) is not None and kids[k].text: d = when(kids[k].text.strip()); break
        if not title or not d or d < (cutoff_cb if cb else cutoff): continue
        key = re.sub(r"\W+", "", title.lower())[:80]
        if key in seen: continue
        seen.add(key)
        low = " " + title.lower() + " "
        ccys = [c for c, rx in CCY if re.search(rx, low)]
        if cb and CB_SRC_CCY[tag] not in ccys: ccys.insert(0, CB_SRC_CCY[tag])
        kind = "cb" if cb else "macro" if MACRO.search(title) else "equity" if EQUITY.search(title) else "other"
        items.append({"t": d.strftime("%Y-%m-%d %H:%M"), "src": tag.replace(" SG", ""), "cb": cb, "sg": tag in SG_FEEDS,
                      "kind": kind, "title": title, "url": link, "ccy": ccys})
items.sort(key=lambda x: x["t"], reverse=True)
# FX/rates/macro and central bank items are all kept; equity and general stories are capped relative to them.
# (Singapore feeds are kept in full.)
core = sum(1 for x in items if not x["sg"] and x["kind"] in ("macro", "cb"))
caps = {"equity": round(0.2 * core), "other": round(0.35 * core)}
used = {"equity": 0, "other": 0}
filtered = []
for x in items:
    k = x["kind"]
    if not x["sg"] and k in caps:
        if used[k] >= caps[k]: continue
        used[k] += 1
    filtered.append(x)
print("kept: core", core, "| equity", used["equity"], "| general", used["other"])
items = filtered
out = {"updated": datetime.now(SGT).strftime("%Y-%m-%d %H:%M"), "items": items[:400]}
open("news.json", "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=0))
print(len(out["items"]), "headlines")
