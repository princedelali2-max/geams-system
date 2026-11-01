GEAMS — running it so every device connects
===========================================
1. Put all files in ONE folder: the six geams-*.html files + geams-server.js
2. Install Node.js (nodejs.org), then in that folder run:   node geams-server.js
3. Open  http://<that computer's address>:8080/  on every device.
   Every app then shows "Backend: online · N device(s) connected".

For phones: GPS, camera and Face ID only work on https:// pages. Easiest:
   cloudflared tunnel --url http://localhost:8080      (gives an https:// address)
or deploy geams-server.js to any Node host (Render, Railway, Fly.io, a VPS).

Apps opened from a different address: tap the badge (bottom-left) and enter the
server address. Clear it to go back to this-device-only mode.

Shared through the server: incidents, rosters, alerts, chats, evidence, backup
requests, station locations, officer / fire / ambulance accounts.
Still on one device only: civilian accounts and face data.
Limits: passwords are stored as salted hashes, but the server has no login
protection of its own — keep it behind HTTPS on a trusted network.
Data is saved in geams-data.json beside the server (delete it to reset).


──────────────────────────────────────────────────────────────
HQ LOGIN, CREATING LCRs, GHANA POST GPS  (settings on the server)
──────────────────────────────────────────────────────────────
In Render: your service → Environment → add these variables, then redeploy.

  GEAMS_HQ_ADMIN_USER        owner username (default: hqadmin)
  GEAMS_HQ_ADMIN_PASSWORD    owner password. SET THIS. If it is missing, the
                             server prints a random password in the log at every
                             start and HQ is locked to that until you set one.
  GEAMS_HQ_USERS             (optional) path of the file holding extra HQ
                             operators. Keep it on a persistent disk, or those
                             operators are lost when Render redeploys. The owner
                             always survives because it comes from the variables.
  GEAMS_DATA                 (optional) path of the data file, same advice.

Creating a control room: HQ → Stations → Create LCR. HQ gets a Station ID and a
one-time passphrase to hand to the LCR. LCR passphrases are checked by the server
and can never be read from a browser.

Ghana Post GPS addresses: Ghana Post publishes no open API. To make the "Find"
button work, add a lookup service you are licensed to use:

  GHANAPOST_LOOKUP_URL       e.g. https://provider.example/lookup?address={address}
  GHANAPOST_LOOKUP_METHOD    GET (default) or POST (sends form field "address")
  GHANAPOST_API_KEY          key for that service
  GHANAPOST_API_KEY_HEADER   header name for the key (default: Authorization)

Without it, HQ can still paste the coordinates shown in the GhanaPostGPS app,
search a place name, or use the device's GPS. The LCR can always confirm its
exact position on site (Settings → Verify Station Location).


─────────────────────────────────────────────────────
SERVER-SIDE PERMISSIONS  (who may read and write what)
─────────────────────────────────────────────────────
Every sign-in now returns a signed token, and the server decides access from it.
Roles: HQ, control room (LCR), officer, fire crew, ambulance crew, civilian.

  GEAMS_TOKEN_SECRET         (recommended) a long random string used to sign tokens.
                             If missing, the server creates one and saves it next to
                             the data file (geams-secret.key). On Render's temporary
                             disk that file is lost on redeploy and everyone has to
                             sign in again, so set this variable.
  GEAMS_SEED_DEFAULT_STATIONS  1 = DEMO ONLY. Gives the 13 built-in control rooms
                             their old test passphrases (accra2024, hohoe2024 ...).
                             Leave it unset in real use.

IMPORTANT FIRST STEP AFTER THIS UPDATE
  The built-in control rooms no longer have passphrases written in the app. Sign in
  to HQ → Stations and press the key button on each control room to issue its login.
  Give the passphrase to that commander securely. (For a quick test, set
  GEAMS_SEED_DEFAULT_STATIONS=1 once, then issue real ones and remove it.)

What changed for people
  * Control rooms sign in with Station ID + the passphrase HQ issued.
  * Officers, fire and ambulance crews sign up and sign in on the server. Old
    accounts keep working: the first successful sign-in upgrades the stored
    password to a stronger form, and old hashes are removed from the readable list.
  * Civilians are given a civilian token automatically. It can raise alerts and chat
    but cannot read staff data or change HQ data. (Phone verification is planned.)
  * HQ orders, station records and account lists can only be written by the roles
    that own them. A civilian or crew token cannot forge an HQ order.
  * Evidence files need a sign-in to upload or view.

Honest limits
  * A record is one shared map, so the server decides by ROLE (and a control room's
    own roster by station), not field by field.
  * Officers, fire and ambulance crews are not yet fenced to their own station on
    the server.
  * Civilian tokens prove a device, not a person.
  * Tokens last 12 hours (HQ, control rooms, crews) or 7 days (civilians).
  * Photos and video open in the page through a cookie that only works when the app
    and the server share one web address (the normal Render setup).

CREW FENCING, FIELD CHECKS, APPROVAL AND PHONE CODES
----------------------------------------------------
Fencing: officers, fire and ambulance crews can only read or write their own station's incidents, roster and queues.
Field checks (server refuses with HTTP 422 and logs "REFUSED ..."):
  - a civilian can raise a new alert, update their own position, add reporters and cancel an alert nobody has taken; nothing else
  - an officer can change only incidents assigned to them and only their own roster entry
  - HQ orders are stamped with the signed-in HQ user; stations must lie in Ghana and hold no password fields
  - a control room can only change its own entry in shared station maps; values over 3 MB are refused
Crew approval: new officers, fire and ambulance crews wait until their control room (or HQ) approves them
  (Officers page). Set GEAMS_AUTO_APPROVE_UNITS=1 to switch approval off (demos only).
Phone codes for civilians (SMS gateway needed; without one the app says so and numbers show "unverified"):
  GEAMS_SMS_URL      gateway address; {to}, {to_local} and {message} are filled in
  GEAMS_SMS_METHOD   POST (default) or GET
  GEAMS_SMS_BODY     POST body, default {"to":"{to}","message":"{message}"}
  GEAMS_SMS_API_KEY / GEAMS_SMS_API_KEY_HEADER   key and header name (default Authorization)
  GEAMS_REQUIRE_VERIFIED_CIVILIANS=1   civilian accounts need a verified phone
Codes: 6 digits, 10 minutes, 5 tries, 3 codes per phone per 15 minutes.
Honest limit: one incident list is one shared record, so the checks compare old and new values by role; they are not yet an independent security test.

TAMPER-EVIDENT EVIDENCE, PUBLIC ALERTS, OFFLINE ALERT QUEUE
-----------------------------------------------------------
Evidence seals: each stored file is hashed (SHA-256) and signed by the server; every save, view, download and check goes into
  a chained custody log (<file>.seal and <file>.log beside the file in geams-blobs). A sealed file cannot be replaced; only
  whoever started a recording (or a control room / HQ) can add to it. Control rooms, HQ and officers can Verify any file and download a
  certificate (Evidence page in the Station app, Evidence integrity card in Replay). Limit: the signing key belongs to this server;
  it is not an outside timestamp authority. Keep geams-blobs on a persistent disk.
Public alerts: HQ > Broadcast can send to Civilians and/or Officers & crews, nationally, by region or for one control room's area.
  Phones decide from their own location. Alerts show while GEAMS is open; closed apps need a web-push service (not set up).
  HQ's history shows how many devices have seen each alert. Recall removes it from phones.
Offline alert queue: an alert raised with no signal is kept on the phone and sent when signal returns. The Civilian app
  registers geams-sw.js (service worker) so it can open with no signal after one online visit. Keep geams-sw.js beside the apps.
SECURITY FIX: older server versions could serve geams-secret.key and similar files over the web when the data file sat beside
  the server (the default). This version blocks them. If an older version was ever public, set a NEW GEAMS_TOKEN_SECRET in the
  environment and delete geams-secret.key, so previously issued tokens stop working.

CLOSED-APP ALERTS, OUTSIDE TIMESTAMPS, OFFLINE EVIDENCE, TEXT MESSAGES TO GEAMS
-------------------------------------------------------------------------------
Closed-app alerts (web push): nothing to configure. The server makes a push key pair on first start and keeps it in
  geams-vapid.json beside the data file (keep it; if it is lost, phones silently re-register next time they open GEAMS).
  Optional: GEAMS_VAPID_PUBLIC / GEAMS_VAPID_PRIVATE to set your own, GEAMS_VAPID_SUBJECT (mailto:you@example.org).
  A phone turns it on with the bell button (🔔) in each app. Needs HTTPS. iPhones only receive web push after GEAMS is added
  to the home screen. Phones decide their area from their nearest control room; the server keeps each device's push address
  and area privately.
Outside timestamp (optional): GEAMS_TSA_URL = address of an RFC 3161 timestamp authority. GEAMS_TSA_CA = that authority's
  certificate file (needs openssl on the server) so the server verifies replies itself. Anyone can re-check a download
  from /api/evidence/<incident>/<file>/timestamp with:  openssl ts -verify -in r.tsr -queryfile q.tsq -CAfile ca.pem
Offline evidence: photos, snapshots and video taken in the Civilian and Dispatch apps with no signal are kept in the phone's
  own database and upload in order when signal returns; a chip on screen says how many are waiting.
Texts to GEAMS: set GEAMS_SMS_INBOUND_KEY and point your SMS provider's incoming-message webhook at
  https://YOUR-SERVER/api/sms/inbound  (send the key in header X-Geams-Key or as ?key=). It reads from/sender/msisdn and
  text/message/body, JSON, form or GET. A text with a map link or "lat,lng" (3+ decimals) inside Ghana becomes an incident
  at the nearest control room (needs station positions in HQ) and the sender is thanked through GEAMS_SMS_URL; other texts
  go to the HQ inbox (Officers page). Limit: GEAMS cannot reply to the sender in chat; use the call-back link.
Rules to keep in mind: sealed evidence rejects names ending .type .seal .log .tsa; keep geams-blobs on a persistent disk.


RESPONSE TIMES AND OPEN DATA
----------------------------
Response times (HQ: Analytics page. Control rooms: Reports page)
  * The SERVER stamps each step of an incident: received, assigned, en route, arrived, closed, resolved, cancelled.
    A phone or dashboard cannot set or change these times (the field "srv" is rebuilt by the server on every save).
  * Headline: median time from alert received to officer marks arrival, plus slowest 1 in 10 (90th percentile).
    Also shown: median time to officer assigned, change against the previous period, weekly (or monthly for 12 months)
    trend, a table by district (one control room each) and a roll-up by region.
  * Left out and counted openly: cancelled alerts, imported records, records from before timing began, times over 24 h.
    Alerts with no arrival yet are counted ("No arrival yet") and are not in arrival figures.
  * Limits: "arrival" is when the officer taps it, GEAMS does not check position at that moment. Only incidents created
    after this version was installed are measured. District names and regions come from HQ's station list.
  * HQ can set a target in minutes (kept in that browser only) to highlight slow districts, print a ministerial brief, and
    download the district table as CSV.
  * API: GET /api/analytics/response?days=30[&bucket=month]   (HQ: all; control room: its own area)

Open data (HQ: Analytics page, Open data card. Control rooms: Reports page)
  * Export:  GET /api/export/incidents?format=json|csv|geojson|cap|edxl [&station= &from= &to= &personal=1 &evidence=1]
             GET /api/export/alerts?format=json|cap|edxl     (HQ)
             GET /api/export/all                              (HQ: bundle; never contains passwords, keys, face templates or push subscriptions)
    Names and phone numbers are left out unless personal=1. Spreadsheet cells that start with = + - @ are neutralised.
  * Import:  POST /api/import/incidents?station=<id>[&dry=1]   body = the file (JSON, GeoJSON, CSV, CAP, EDXL-DE)
    Up to 1000 records and 5 MB. dry=1 checks without saving. Existing ids are skipped. Each refused record is listed with a
    reason. Positions must be inside Ghana. XML with DOCTYPE/ENTITY is refused. A control room may import only into its own
    area; HQ may import anywhere. Imported records are filed as resolved history (source "import"), never as live incidents.
  * Honest limit: CAP 1.2 and EDXL-DE output follows the published element lists and value lists and is well-formed XML, but
    has not been checked against the official schema files, and the CAP "sender" is set by GEAMS_CAP_SENDER (default geams@localhost).
  * Tests: t_analytics.js (74 server checks) and t_analytics_ui.js (27 browser checks).
