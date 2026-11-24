"""Sends the evening wake-up push to each subscribed device. The message carries no calendar data;
the phone builds the notification text from its own encrypted copy. Secrets: VAPID_PRIVATE_KEY, PUSH_SUBSCRIPTIONS."""
import json, os, sys
from pywebpush import webpush, WebPushException
from py_vapid import Vapid

key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
subs = os.environ.get("PUSH_SUBSCRIPTIONS", "").strip()
if not key or not subs:
    print("Not set up yet (missing VAPID_PRIVATE_KEY or PUSH_SUBSCRIPTIONS); nothing sent.")
    sys.exit(0)
vapid = Vapid.from_pem(key.encode())   # the secret is stored as PEM
subs = json.loads(subs)
if isinstance(subs, dict): subs = [subs]
site = "https://" + os.environ["GITHUB_REPOSITORY_OWNER"].lower() + ".github.io/"
ok = 0
for s in subs:
    try:
        webpush(subscription_info=s, data=json.dumps({"t": "briefing"}), vapid_private_key=vapid,
                vapid_claims={"sub": site}, ttl=6 * 3600, headers={"Urgency": "normal"})
        ok += 1
    except WebPushException as e:
        print("failed for one device:", e.response.status_code if e.response is not None else e)
print(ok, "of", len(subs), "sent")
