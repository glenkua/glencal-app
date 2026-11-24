"""Fantasy NBA/NFL feed: RotoWire player alerts (accumulated, they only publish the latest few),
headlines from Yahoo, ESPN and PFF, and Sleeper's most-added players. Writes fantasy.json.
Run by .github/workflows/markets.yml; the previous fantasy.json is restored first so alerts accumulate."""
import json, re, html, os, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

SGT = timezone(timedelta(hours=8))
NOW = datetime.now(SGT)
FEEDS = [  # (sport, source tag, url, kind)
    ("NBA", "ROTO", "https://www.rotowire.com/rss/news.php?sport=NBA", "alert"),
    ("NFL", "ROTO", "https://www.rotowire.com/rss/news.php?sport=NFL", "alert"),
    ("NBA", "YAHOO", "https://sports.yahoo.com/nba/rss.xml", "news"),
    ("NFL", "YAHOO", "https://sports.yahoo.com/nfl/rss.xml", "news"),
    ("NBA", "ESPN", "https://www.espn.com/espn/rss/nba/news", "news"),
    ("NFL", "ESPN", "https://www.espn.com/espn/rss/nfl/news", "news"),
    ("NFL", "PFF", "https://www.pff.com/feed", "news"),
]
KEEP = {"alert": timedelta(hours=72), "news": timedelta(hours=36)}
STATUS = [("out", r"\b(out|ruled out|won't play|will not play|sidelined|inactive|placed on (?:ir|injured reserve)|season-ending|done for)\b"),
          ("doubt", r"\b(questionable|doubtful|game-time decision|gtd|uncertain|limited|day-to-day|probable)\b"),
          ("in", r"\b(starting|will start|available|good to go|cleared|activated|active|in uniform|returns?|back in action|will play|expected to play|upgraded)\b")]

def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def clean(s):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s*Visit RotoWire\.com for more analysis on this update\.?", "", s)
    return re.sub(r"\s+", " ", s).strip()

prev = {}
if os.path.exists("fantasy.json"):
    try: prev = json.load(open("fantasy.json", encoding="utf-8"))
    except Exception: prev = {}
items = {x["id"]: x for x in prev.get("items", [])}
names = prev.get("names", {})

for sport, src, url, kind in FEEDS:
    try: root = ET.fromstring(get(url))
    except Exception as e: print("skip", src, sport, e); continue
    for it in root.iter("item"):
        g = lambda k: (it.find(k).text or "") if it.find(k) is not None else ""
        title = clean(g("title"))
        try: d = parsedate_to_datetime(g("pubDate").strip()).astimezone(SGT)
        except Exception: continue
        if not title or NOW - d > KEEP[kind]: continue
        key = src + "-" + re.sub(r"\W+", "", title.lower())[:70]
        x = {"id": key, "t": d.strftime("%Y-%m-%d %H:%M"), "sport": sport, "src": src, "kind": kind,
             "title": title, "url": g("link").strip().replace(".com//", ".com/")}
        if kind == "alert":
            x["blurb"] = clean(g("description"))[:400]
            low = " " + title.lower() + " " + x["blurb"].lower()[:120] + " "
            x["status"] = next((s for s, rx in STATUS if re.search(rx, low)), "")
        items[key] = x

out = [x for x in items.values() if NOW - datetime.strptime(x["t"], "%Y-%m-%d %H:%M").replace(tzinfo=SGT) <= KEEP[x["kind"]]]
out.sort(key=lambda x: x["t"], reverse=True)

# Sleeper (public API): most-added players in the last 24 hours
trending = {}
for sport in ("nba", "nfl"):
    try:
        tr = json.loads(get("https://api.sleeper.app/v1/players/%s/trending/add?lookback_hours=24&limit=12" % sport))
    except Exception as e:
        print("sleeper skip", sport, e); continue
    missing = [t["player_id"] for t in tr if sport + ":" + t["player_id"] not in names]
    if missing:   # player directory is large; only download it when a new id shows up
        try:
            allp = json.loads(get("https://api.sleeper.app/v1/players/" + sport, timeout=60))
            for pid in missing:
                p = allp.get(pid) or {}
                names[sport + ":" + pid] = {"n": (p.get("full_name") or (p.get("first_name", "") + " " + p.get("last_name", ""))).strip() or pid,
                                            "team": p.get("team") or "", "pos": p.get("position") or ""}
        except Exception as e:
            print("sleeper players skip", sport, e)
    trending[sport.upper()] = [dict(names.get(sport + ":" + t["player_id"], {"n": t["player_id"]}), adds=t["count"]) for t in tr]

json.dump({"updated": NOW.strftime("%Y-%m-%d %H:%M"), "items": out[:400], "trending": trending, "names": names},
          open("fantasy.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(out), "fantasy items;", {k: len(v) for k, v in trending.items()}, "trending")
