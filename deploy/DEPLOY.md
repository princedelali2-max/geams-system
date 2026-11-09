# GEAMS: putting it on a real server

This is the short, tested route. About 30 minutes if your domain name already points at the server.

## 1. What you need
- A small Linux server (Ubuntu 22.04 or newer, 1 GB memory is enough for a pilot) with a public address.
- A domain name (for example `geams.yourorg.org`) whose DNS record points at that server. Phones need **https** for GPS and camera, so this is not optional.
- Ports 80 and 443 open.
- A Postgres database is strongly recommended (many hosts offer one). Without it, everything lives on one disk.

## 2. Install
Copy the whole GEAMS folder to the server, then:

    sudo bash deploy/install.sh geams.yourorg.org caddy

(use `nginx` instead of `caddy` if you already run nginx; the script then tells you the two extra commands.)
It installs Node if needed, creates a `geams` user, copies the app to `/opt/geams`, puts data in `/var/lib/geams`, writes `/etc/geams/geams.env` with **random** HQ owner and backup passwords, starts the service and the web proxy, and checks that the server answers.
**Write down the two passwords it prints.** They are shown once.

## 3. Settings
Edit `/etc/geams/geams.env` (every line is explained in the file), then `sudo systemctl restart geams`. The ones that matter for a pilot:
- `GEAMS_PILOT_LABEL` is shown to civilians (for example `Hohoe pilot`).
- `GEAMS_DATABASE_URL` is the database copy.
- `GEAMS_BACKUP_*` controls backups. Set `GEAMS_BACKUP_PUT_URL` to also send each backup off the server.
- `GEAMS_SMS_*` is needed for phone restore. Until set, GEAMS says plainly that texts are off.
Leave `GEAMS_SEED_DEFAULT_STATIONS` off. Create real stations in HQ (or import a CSV: see `docs/` and the HQ "Bulk setup" button).

## 4. Check it
- `curl https://geams.yourorg.org/api/health` shows `"ok":true,"saving":true`.
- Log in to HQ, open the account menu, then **Storage**. Everything should be green; anything red says what to do.
- Run `sudo journalctl -u geams -f` to watch the log. Lines starting `!!` need attention.
- From a phone, open the civilian page and send a test alert to a test station.

## 5. Practise restoring (do this once before the pilot)
1. In HQ, take a backup. 2. On a spare folder or machine, with the same backup passphrase:

       node geams-persist.js verify /var/lib/geams/backups/geams-backup-XXXX.tar.gz.enc
       GEAMS_DATA=/tmp/try/d.json GEAMS_HQ_USERS=/tmp/try/u.json GEAMS_BLOBS=/tmp/try/blobs \
         node geams-persist.js restore /var/lib/geams/backups/geams-backup-XXXX.tar.gz.enc
3. Start a server on that folder and log in. `t_restore.js` in the test pack does exactly this automatically.
To restore for real: `sudo systemctl stop geams`, run the same restore command with the real paths and `--force` (your current data is kept in a `pre-restore-…` folder), then `sudo systemctl start geams`.

## 6. Updating
Copy the new files over `/opt/geams` (or run `install.sh` again: it keeps your settings and data), then `sudo systemctl restart geams`. Users are signed out only if you change the signing key.

## 7. What can go wrong, in plain words
- **Disk full:** HQ shows "SERVER CANNOT SAVE" and the log shows `!! SAVE FAILED`. Free space; saving resumes by itself within 5 seconds and nothing already accepted is lost while the server stays up. If the server is killed while it cannot save, those changes are lost: act quickly.
- **Power cut or kill:** up to about half a second of the newest changes may not be on disk (they are in the database copy if one is configured). Everything older is kept.
- **Damaged data file:** the server keeps the damaged file, recovers from the last complete copy if there is one, and tells HQ. If it must start empty it says so loudly; restore from a backup.
- **The server is down:** civilian phones keep the alert and show "not sent, call 112". They do not claim help is coming.
- **Never expose port 8080 directly.** `GEAMS_BIND=127.0.0.1` keeps it private; only the proxy talks to it. Rate limits rely on that.

## 8. Not covered here
Telephone/SMS gateway accounts, a Postgres host, and DNS are yours to arrange. GEAMS has been tested with local stand-ins for these, not with your real providers.
