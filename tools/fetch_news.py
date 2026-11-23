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
    ("FED", "https://www.federalreserve.gov/feeds/press_all.xml", True),
    ("ECB", "https://www.ecb.europa.eu/rss/press.html", True),
    ("BOE", "https://www.bankofengland.co.uk/rss/news", True),
    ("BOJ", "https://www.boj.or.jp/en/rss/whatsnew.xml", True),
    ("RBNZ", "https://www.rbnz.govt.nz/feeds/news", True),
]
CCY = [("USD", r"\b(usd|dollar|fed|fomc|powell|treasur|u\.s\.|us )"), ("EUR", r"\b(eur|euro|ecb|lagarde|eurozone|germany|bund)"),
       ("JPY", r"\b(jpy|yen|boj|ueda|japan)"), ("GBP", r"\b(gbp|sterling|pound|boe|bailey|gilts?|uk )"),
       ("AUD", r"\b(aud|aussie|rba|australia)"), ("NZD", r"\b(nzd|kiwi|rbnz|new zealand)"), ("SGD", r"\b(sgd|singapore|mas )")]
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
        items.append({"t": d.strftime("%Y-%m-%d %H:%M"), "src": tag, "cb": cb, "title": title, "url": link, "ccy": ccys})
items.sort(key=lambda x: x["t"], reverse=True)
out = {"updated": datetime.now(SGT).strftime("%Y-%m-%d %H:%M"), "items": items[:400]}
open("news.json", "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=0))
print(len(out["items"]), "headlines")
