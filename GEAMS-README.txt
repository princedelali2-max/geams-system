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
