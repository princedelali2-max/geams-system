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
Roles: HQ, control room (LCR), officer, fire crew, ambulance crew, civilian, Fire HQ, Ambulance HQ.

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
  * Officers, fire and ambulance crews are fenced to their own control room's records on
    the server (another area answers 403); within one area, access is by role.
  * Civilian tokens prove a device, not a person.
  * Tokens last 12 hours (HQ, control rooms, crews) or 7 days (civilians).
  * Photos and video open in the page through a cookie that only works when the app
    and the server share one web address (the normal Render setup).

CREW FENCING, FIELD CHECKS, APPROVAL AND PHONE CODES
----------------------------------------------------
FIRE HQ and AMBULANCE HQ (stand-alone; they do not report to Police)
  Open geams-fire-hq.html or geams-ambulance-hq.html. The HQ owner creates the accounts: HQ dashboard > "Fire & Ambulance HQ accounts"
  (shows a one-time password; the person must choose their own at first sign-in). Control rooms are unchanged: they still receive every
  alert and forward it to the nearest fire or ambulance station. The agency HQ then sees that forwarded copy live (refreshes about every
  5 seconds; it is not a push alert). Crews stay attached to control-room areas; the HQs have no stations of their own.
  Each HQ can: see all its stations, alerts and crew accounts; be warned when a forwarded alert is not taken (GEAMS_AGENCY_ESCALATE_SECS, default 120);
  move a waiting alert to another station; message its crews (shown in the crew app while it is open); add, reset, disable, enable, move and approve its
  own people; pull reports (CSV or print) with server-stamped times; download an encrypted backup of its own data
  (open with: node tools/open-agency-backup.js file.enc); read its own action log.
  Also: the HQ can create an alert for one station's crews directly (Command tab). It goes straight to those crews and does not pass through a
  control room, so the control room does not have it on its own screen. And crews and their HQ can exchange administrative messages (Messages tab
  on the HQ; a 💬 button inside the fire and ambulance crew apps). Delivered while both sides have the app open; checked every 5-6 seconds; not an SMS,
  not for emergencies; the last 200 messages per person are kept, on the server only.
  AMBULANCE HQ ONLY: patient transfer. Collect a patient at one hospital and deliver them to another (Command tab: pick both hospitals by search or by
  clicking the map, choose the station whose crew does it). The crew app guides to the pickup, then (button: Patient on board) to the destination, and
  the HQ sees both legs live. En route and ETA are real: position is the crew phone's GPS, sent every few seconds and re-sent every 10 s while stationary;
  ETA is by road route when the routing service answers (GEAMS_CONFIG.routeUrl) and otherwise a straight-line estimate that says so. The server stamps when
  each position arrived; if none arrives for 60 s the HQ screen warns to phone the crew. GEAMS does not contact the hospitals.
  FIRE CREWS: the fire crew app works the same way for alerts (including HQ-created ones): live GPS position every few seconds and every 10 s while
  stationary, ETA to the scene by road route when available (otherwise a labelled straight-line estimate), and the Fire HQ gets the same 60 s warning.
  Limits: a warning only tells people, someone must act. Crew counts are accounts, not who is on shift. A call handled only by phone never reaches it.
  An HQ can never read police records, and Fire and Ambulance cannot read each other. The pages are generated from tools/agency-hq.template.html by
  tools/make-agency-hq.js (run it after editing the template). Tests: t_agency.js (server), t_agency_ui.js (screens).

Fencing: officers, fire and ambulance crews can only read or write their own station's incidents, roster and queues.
Field checks (server refuses with HTTP 422 and logs "REFUSED ..."):
  - a civilian can raise a new alert, update their own position, add reporters and cancel an alert nobody has taken; nothing else
  - an officer can change only incidents assigned to them and only their own roster entry
  - HQ orders are stamped with the signed-in HQ user; stations must lie in Ghana and hold no password fields
  - a control room can only change its own entry in shared station maps; values over 3 MB are refused
Crew approval: new police officers wait until their control room approves them (Officers page). New fire crews wait for the Fire HQ and
  new ambulance crews for the Ambulance HQ (People tab; the HQ's Live screen shows a banner and the People tab a count while any are waiting). The national
  HQ can approve any. A crew member signs in with name, phone number or badge plus password. Set GEAMS_AUTO_APPROVE_UNITS=1 to switch approval off (demos only).
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


STORAGE, DATABASE AND BACKUPS
-----------------------------
Why: on hosting that resets its disk on every restart (low-cost Render, for example) a file-only GEAMS loses everything.
Fix: connect a database. Without one GEAMS works exactly as before, and HQ is warned that data lives on the disk only.

Connect a database (environment variable, either name)
  GEAMS_DATABASE_URL=postgres://user:password@host:5432/dbname      (managed PostgreSQL; needs "npm install", which fetches pg)
  GEAMS_DATABASE_URL=sqlite:/data/geams.db                          (Node 22.5+; the file MUST be on a persistent disk to help)
  DATABASE_URL is also read. GEAMS_DATABASE_SSL=1 turns on TLS without certificate checks for hosts that need it.
What goes in: every record (incidents, rosters, alerts, station logins), HQ operator accounts, the signing key and push key,
and every evidence file with its seal, custody log and timestamp. Files over GEAMS_DB_MAX_FILE_MB (default 64) stay on disk only.
Start-up: GEAMS first makes the disk match the database. On an empty disk it restores everything. If the database is set but
cannot be read and the disk is empty, GEAMS refuses to start rather than begin blank (GEAMS_DB_OPTIONAL=1 overrides).
First start with an existing file install: the files are copied into the database; nothing is lost.
If the database goes down: GEAMS keeps working, holds the changes, retries, and HQ sees "NOT reachable". On SIGTERM it saves before it exits.
Honest limits: evidence in the database suits pilot volumes, not national scale (use object storage then). A SQLite file on the same
disk gives no protection from a wiped disk. Records last written within about half a second before a hard crash can be lost.

Backups (HQ owner: account menu > Storage and backups)
  GEAMS_BACKUP_HOURS=24 (0 = off)  GEAMS_BACKUP_KEEP=7  GEAMS_BACKUP_DIR=...  GEAMS_BACKUP_PASSPHRASE=...
  GEAMS_BACKUP_PUT_URL=https://store/path  GEAMS_BACKUP_PUT_AUTH="Bearer ..."   (each backup is also sent with an HTTP PUT)
  A backup holds all records, HQ accounts and evidence with a fingerprint for each file. With a passphrase it is encrypted
  (AES-256-GCM) and ALSO holds the signing keys. Without one, signing keys are left out; keep GEAMS_TOKEN_SECRET in the environment.
  Backups on the same disk are lost with the disk: download one regularly or set the off-server copy.
  Commands, run at the server:
    node geams-persist.js verify <file>            checks every file against its fingerprint (exit 3 if anything changed)
    node geams-persist.js restore <file> [--force] puts the data back (server stopped). --force keeps the old data in pre-restore-*
    node geams-persist.js backup | status
  With a database set, restore also rewrites the database.
  API (HQ): GET /api/storage/status  | owner only: GET /api/backup/list, POST /api/backup/run, GET /api/backup/download?name=
Tests: t_storage.js sqlite|pg (24 and 28 checks), t_backup.js (38), t_storage_ui.js (9).


SELF-CONTAINED APPS, ROUTING FALLBACK AND COMMANDER ACCOUNTS
------------------------------------------------------------
Self-contained apps
  Leaflet, the fonts (Exo 2, Share Tech Mono) and the face-recognition library with three models are in the vendor/ folder and
  served by GEAMS itself (see vendor/NOTICE.txt). Keep the vendor/ folder next to the server. The service worker caches them, so
  they work with no network after the first visit. No app asks a CDN or font service for anything any more.
  Still online unless you set your own servers (environment variables, read by every app through /config.js):
    GEAMS_TILE_URL=https://tiles.example/{z}/{x}/{y}.png   map pictures (default: ArcGIS satellite)
    GEAMS_TILE_ATTRIBUTION="..."
    GEAMS_ROUTE_URL=https://router.example                 OSRM-compatible road routing (default: router.project-osrm.org)
    GEAMS_GEOCODE_URL=https://geocode.example              Photon-compatible place search (default: photon.komoot.io)
  If map pictures cannot load, the map shows a notice and keeps pins and routes. If road routing is down, Dispatch shows a
  straight-line estimate marked "(est.)" and the station map says it is showing straight-line distance only.
  Not done: running a tile server, routing engine or geocoder. That needs a server and Ghana map data.

Commander accounts
  HQ: Stations page, the person icon on a control room row. Create an account (username, full name, rank, phone). A password is
  generated and shown once. HQ can issue a new password, disable, enable or remove an account; the commander's session ends at once.
  Once a control room has an active account, sign-in needs the station passphrase AND the commander username and password. A station
  sign-in without an account stops working (it is signed out on its next request). A control room with no accounts still signs in as
  before and its commander name is recorded as unverified.
  GEAMS_REQUIRE_COMMANDER_ACCOUNTS=1 refuses sign-in to any control room that has no commander account yet.
  The name and rank on the shared commander record must match the signed-in account; the server stamps verified and the account name.
  A commander can change their own password under Settings (My Commander Account); this ends their other sessions.
  Five wrong tries lock that account at that station for 5 minutes. Passwords are stored as salted hashes in a server-only record.
  Not done: linking accounts to government staff records or single sign-on.
Tests: t_vendor.js (32), t_commander.js (42), t_commander_ui.js (15).


BUTTON SWEEP: WHAT NOW DOES A REAL THING
----------------------------------------
Every button that used to only show a message now either does the job or has been removed.
Control room (station) dashboard
  Reassign dispatch, merge duplicates, flag caller, scene-photo request, backup request, escalate to HQ, notes, walk-in registration
  all write onto the shared incident record, so HQ, the officer and the civilian app see them. Reassign frees the old officer.
  Merge closes the duplicate (server-stamped) and links both cases. Walk-in creates a real case (source "walk-in"); only name and
  phone are stored, never ID numbers.
  Call back / call officer open the phone's dialler (tel:). GEAMS does not carry calls or video.
  Docket print and station reports use the browser's print dialog (save as PDF there) or a CSV download. They are not digitally signed.
  Intelligence reports are filed to lcr:<station>:intel, readable by that station and HQ only, append-only (the server refuses edits).
  Test connection runs real checks (browser online, server round trip in ms, signed-in read of the station record, sync mode).
  Station lockdown records the lockdown on the station's status so HQ sees it, with a banner. It cannot lock doors or reroute calls.
  Settings: Export audit log (CSV), Download station data (JSON). Removed: roadblock order, plainclothes deployment, refresh token,
  update profile, "backup to HQ". The officer list shows an EQUIPMENT warning when an officer reports a problem.
HQ dashboard
  Escalate raises an incident to critical and stamps who did it; Add notes writes hqNotes to the incident; incident view shows
  station backup requests, escalations, flags and notes. Exports (incidents, stations, audit, health) are CSV. Disable Station
  signs that control room out. Removed: override dispatch, HQ resolve (only police-harassment cases are resolved by HQ), reassign,
  suppress alert, restart push service, fake sessions list.
  Security: "Sign out all stations and officers" (POST /api/hq/rotate-tokens, owner only; HQ and civilian sessions unaffected);
  "System lockdown" (POST /api/hq/lockdown, owner only): the server refuses every write from control rooms, officers, fire and
  ambulance with HTTP 503 until lifted. Civilian SOS and HQ keep working. Stations show a banner.
  "Security configuration check" (GET /api/security/check, HQ) reviews GEAMS's own settings (HTTPS, database, backups, encryption,
  commander accounts, lockdown). It is not a vulnerability scan. "Back up now" runs the owner backup.
Civilian app
  Photo attach on tips, road hazards and missing-person reports uploads the photo as evidence. The control room's photo request
  appears as a sheet in the open app (no push). "Send video" uploads a clip as evidence. Removed: rating screen, claims of
  untraceable anonymity and automatic face matching.
Dispatch app
  Equipment report starts with every item unticked, and the report reaches the station through the roster. Sketch uploads as an
  evidence PNG. Call Station uses the commander's phone number. Removed: fake video call panel and the encryption claim.
Tests: t_sweep.js (41 browser/server checks), t_sweep2.js (8), t_sweep3.js (4). They need the full set of files in one folder.


=== PASSWORDS AND ACCOUNT RECOVERY ===
Crew passwords (officers, fire, ambulance)
- A crew member can change their own password: dispatch app (Profile screen, "Change Password"), fire and ambulance apps (key button at the top). They need the current password and a new one of at least 8 characters. Their other devices are signed out; the one they are on stays signed in.
- Forgotten password: the control room opens Officers, finds the person under "Crew accounts at this station" and presses "Reset password". The server signs them out everywhere and shows a temporary password once. Give it to them in person or by a phone call you place yourself. At next sign-in they must choose their own password before they can continue. HQ can do the same through the same endpoint (POST /api/lcr/unit/reset).
- A reset also clears a lock-out from too many wrong attempts. Control rooms can only reset their own station's crews. Every reset is written to the server log.
- The fake "IT Support" phone number and email on the dispatch sign-in screen were removed. It now says to call the control room.

Civilian account recovery (lost or new phone)
- Profile > "Recovery Code (for a new phone)" makes a code (XXXXX-XXXXX-XXXXX). It is shown once; the server keeps only a scrambled copy. People are also offered one a few seconds after creating an account. Making a new code replaces the old one.
- On a new phone: sign-in or sign-up screen > "New phone? Restore my account". Enter the account number (CIV-12345), the code and a new 4-digit PIN. The profile, Face ID and past alerts move to that phone. The old phone stops seeing them. A fresh code is issued, and the used one stops working.
- Guessing is limited: 5 wrong codes lock that account for an hour, and 20 tries per address per hour. Wrong account and wrong code give the same message.
- If SMS verification is on (GEAMS_REQUIRE_VERIFIED_CIVILIANS=1), a phone verified with the same number may also restore (server supports it; the app screen for that path is not built yet and is untested).
- Limits: anyone holding the account number and code can take the account over, so people must keep it private. A person who never made a code and lost the phone cannot recover through this route; they need to register again (a control room can see the old record).
- Tests: t_recovery.js (42 server checks), t_recovery_ui.js (45 browser checks).

PRIVACY NOTICE, CONSENT AND RETENTION
- Signup requires accepting the privacy notice (Profile > Privacy notice & my consents shows it again). Existing users see it once.
- Face ID is optional with its own tickbox; the server stores the consent time and notice version with the face record. Withdrawing deletes the face record.
- HQ owner > Data retention: preview, legal hold, back up then apply. Open incidents and held incidents are never touched.
- Load and soak test: t_load.js. Pilot documents: docs/.

FEEDBACK / DRILLS / OFFLINE QUEUE / LANGUAGES
- Feedback: all apps, read by HQ. Drills: station "Drill" button. Offline queue: crew apps. Language: civilian app (Profile > Language, and a button on the sign-in screen; about 90 phrases in Twi/Hausa/Ewe, fewer in Ga). All translations are unchecked drafts until a native speaker verifies them with docs/translation-sheet*.csv and make-lang.js. Anything not in a word list stays in English.

PILOT SUPPORT: app errors and version banner, staff action log, duplicate alert warning, false-alarm flag/block (all in HQ or the control room), restore by phone number.

NEW IN THIS VERSION: display settings and screen-reader names (all apps), shift handover notes saved on the server, crew roster with self-set availability, staff-app language picker (Aa button; about 100 button and label words in Twi and Hausa, about 40 in Ewe), guided tour in every app, make-lang.js to turn filled translation sheets into language files. See GEAMS-DEPLOY-CHECKLIST.txt section K.

PILOT READINESS: unanswered-alert warnings to HQ and neighbours, pilot strip and HQ pause switch, honest "sent / not sent" in the civilian app, server save-failure and damaged-file handling, deployment kit (deploy/), bulk crew and control-room setup with printable login sheets, HQ pilot report. See GEAMS-DEPLOY-CHECKLIST.txt section L.

SIGN-IN BOXES: vendor/geams-loginclear.js (loaded on every app) empties the username, password, passphrase, Station ID and recovery boxes whenever a sign-in screen appears and after sign-in, and tells the browser not to remember them. It never clears a box being typed in. Test: tests/t_loginclear.js. A browser's own saved-password manager is the person's setting; this stops the apps from leaving values behind.

CREW POSITION AND MAPS: a fire or ambulance crew is not at the Police control room (LCR) it signs up under; the LCR only decides which alerts the crew receives. After accepting a call the crew's position is this phone's own GPS (never the control room's coordinates); until the first GPS fix there is no position and no map marker. Map pictures from OpenStreetMap (and your own tile server, if set in config.js) are asked for with this site's address as the Referer, because their tile policy returns 403 without one; Esri satellite pictures send none. Test: tests/t_crewposition.js.

INCOMING CALLS AND NAVIGATION (fire and ambulance crew apps): a new call takes over the screen with vibration, a beep and one big Accept and navigate button (or Later, which keeps it in Calls). Accepting opens the map already zoomed to the route from the phone's GPS to the scene (or, for a transfer, the pickup hospital), draws the road route when the routing service answers, and shows the ETA before the crew departs. A Navigate in Maps app button hands the current leg to the phone's own maps app for turn-by-turn directions (it needs that app and a data connection; GEAMS does not give voice directions itself). For a transfer, once Patient on board is pressed, the map and the Navigate button switch to the destination hospital. Sound and vibration only work while the app is open on the phone. HQ patient transfers: Set on map jumps to the typed hospital and places the pin; other matches are offered, and My location is available. Tests: tests/t_navigate.js.

MAPS, SEARCH AND CLOSING (Fire HQ, Ambulance HQ and the two crew apps): the maps are now as tall as the LCR map, with a Street / Satellite switch and a full-screen button (the choice is remembered on that device). If satellite pictures cannot be reached the HQ map falls back to street and says so. When Fire HQ or Ambulance HQ creates an alert, Find street, landmark or town on the map searches by name, jumps there and places the pin (Use this device's position is still there). Search needs the place-search service in config.js (default photon.komoot.io, OpenStreetMap data) and an internet connection; if it is unreachable the screen says so and the pin can be placed by tapping. Resolve / close: the HQ can close any open alert (resolved, false alarm, duplicate, cancelled, with a note); the crew on it is told on their screen, and an alert nobody had accepted disappears from the crew's waiting list. A crew can close its own call at any stage (resolved, false alarm, cannot reach, cancelled) and the HQ sees who closed it and why. Tests: tests/t_mapclose.js.

CREW FEEDBACK TO THE HQ: when a crew presses Complete (or Close call) it must say how the call ended: Resolved, Handed over (patient handed over for ambulance transfers), NOT resolved - needs follow-up, False alarm (Close call adds Cannot reach and Cancelled), with an optional short note. The Fire HQ / Ambulance HQ Live screen shows a Reported back by crews card (last 6 hours): alert, station, crew, outcome, note and time, with NEW on anything not yet marked seen on that device and the unseen count in the browser tab title. The Alerts table shows the same outcome and note. Calls completed by an older app without an outcome show as Completed (no outcome given). The HQ screen refreshes every 3 s while it is open; GEAMS does not push to a closed browser. Test: tests/t_feedback.js.

AUTOMATIC LOG AND IDLE SIGN-OUT (Fire HQ and Ambulance HQ): the Backups and log tab now starts with an Automatic activity log, written by the system from the times the server stamped on each alert and never typed by anyone: alert received (or moved in from another station), crew accepted, en route, patient on board and arrived at destination (transfers), on scene, call ended (with the crew's outcome and note) and calls closed by the HQ; last 48 hours, with a CSV download. Public names and phone numbers are not in it. The existing list below it records what the HQ staff themselves did (sign-ins, creating alerts, reassigning, closing, crew changes). A screen left idle signs itself out after 15 minutes with a warning in the last minute; only a person's mouse, key or touch counts as activity. Change it with hqIdleMins in config.js (0 turns it off). The idle sign-out is done by the page: it ends the session on the server too, but a copied token stays valid until it expires on its own. Test: tests/t_activity.js.

STATION DASHBOARD WHEN THE SERVER IS NOT REACHABLE
- An unreachable server is no longer treated as "HQ has disabled this control room". Before, a failed
  read of the station list looked like an empty list, so every station counted as disabled and the
  person was signed out. Now an empty/failed answer, or a server known to be down, changes nothing:
  the station stays signed in and a banner says "GEAMS server not reachable ... retrying automatically".
  The banner disappears when the connection returns.
- A real disable by HQ still shows the alert and signs the station out (tests/t_serverdown.js, 9 checks).
- Fire HQ, Ambulance HQ and the HQ dashboard were never signed out by this; they have no connection-lost
  banner yet.

DISPATCH: SOUND FOR AN INCOMING JOB
- When a control room assigns a job to the signed-in officer, the Dispatch app vibrates and plays one 880 Hz tone, the same alert the Fire
  and Ambulance crew apps give, and shows the "New Job Available" toast. It also sounds if the officer is busy on another case.
- Limits: browsers allow sound only after the person has tapped something on the page (signing in counts), phones that are muted or in
  silent mode stay silent, and a locked or closed page cannot play it. Vibration is not available on iPhones. Test: tests/t_dispatchsound.js (7 checks).

MESSAGING ACROSS CONTROL ROOM, DISPATCH AND CIVILIAN (fix)
- Problem found: Dispatch only listened to an incident's chat once the Comms screen had been opened, so a control-room message
  reached the Civilian but not the officer (and nothing told the officer). The control room had the same gap: it only listened to the
  chat of the incident it had open.
- Now Dispatch follows the chat from the moment a job is loaded, on every screen: unread badge on Comms, a toast, the alert tone and
  vibration. The control room follows every live incident's chat in the background: unread count on Communications, a toast and a tone.
  Opening the chat marks it read. Message text is shown as text (never as markup) in Dispatch.
- The Accept sheet in Dispatch no longer shows a fixed "1.8 km / ~6 min"; it shows the real distance and ETA, or says they appear
  once the device has a GPS fix.
- Test: tests/t_messaging.js (14 checks, real Civilian, Dispatch and control-room apps).

INCIDENT POSITION (fix)
- Problem found: an alert raised before the phone had a GPS fix used the registered/estimated place (the town's station) with no warning,
  and a later real fix moved only the live pin, not the incident itself. The place text on the alert was the registered home address, not
  where the person was. The emergency screen showed a fixed "±8m".
- Now: the alert carries the phone's real GPS position, its real accuracy and a place text built from that GPS fix (the registered address
  is kept separately). With no fix, an area-only choice, a fix worse than 200 m or older than 10 minutes, the alert says "LOCATION NOT CONFIRMED:
  ask the caller where they are", the control room and the officer both see a warning, and a fresh GPS reading is requested at once.
  When a real (or at least twice as accurate) fix arrives, the alert itself moves, the flag clears, and the control room and the officer's job follow.
  The server lets a phone refine only its own alert, and only inside Ghana. The emergency screen shows the real accuracy.
- Limits: GEAMS can only be as exact as the phone's GPS; indoors or with location switched off it may be coarse or missing, and it then says so.
  There is no street-address lookup from the GPS position (needs a geocoder); the text shows the coordinates.
- Test: tests/t_location.js (17 checks).
