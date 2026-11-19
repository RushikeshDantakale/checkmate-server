# SERVER_SETUP_GUIDE

Beginner-friendly. Website menus change over time, so button names below may differ slightly. This guide is extended each phase. Never paste real secrets into this file, into source code, or into GitHub.

## 1. What you need
- Node.js 20 or newer (check with `node -v`; download the LTS from nodejs.org).
- A code editor (Android Studio or VS Code both work).
- Free accounts: GitHub, MongoDB Atlas, Render. Later: Resend (email), Metered (TURN).

## 2. Run the project locally
1. Open PowerShell in the project folder (`D:\AndroidProjects\checkmate-server`, the folder that contains `package.json`).
2. `npm install`
3. Create `.env`: copy `.env.example` to a new file named `.env`, then fill in `MONGODB_URI` and `JWT_ACCESS_SECRET` (sections 3 and 4). Every other setting has a working default; `.env.example` explains each one.
4. `npm run dev` starts the server and restarts it when you change a file. `npm start` runs it normally. Stop it with Ctrl+C.
5. Open `http://localhost:3000/health/live` in a browser. You should see `{"status":"ok",...}`.
6. Open `http://localhost:3000/health/ready`. It shows 200 once MongoDB is connected, and 503 while it is not.
7. Open `http://localhost:3000/health/storage`. It shows how full the database is (`level`: `ok`, `warning` from 80%, `critical` from 90% of `STORAGE_LIMIT_MB`).
8. Check the WebSocket too (the part the Android app uses): `node -e "const W=require('ws');const s=new W('ws://localhost:3000/ws');s.on('message',m=>{console.log(m.toString());s.close()});s.on('error',e=>console.log('error:',e.message))"`. It must print one line starting with `{"type":"server.hello"`. For a deployed server use `wss://<name>.onrender.com/ws` instead.

### Run the tests (optional, for developers)
The tests need a MongoDB running on your own computer (default `mongodb://localhost:27017`). They use a SEPARATE database called `checkmate_test` and DELETE everything in it when they start and when they finish. To use another MongoDB, set `MONGODB_URI_TEST`. NEVER point it at your real data or at your Atlas cluster.
- Everything: `npm test`. It takes several minutes. To keep the screen readable: `npm test > test-output.txt 2>&1`, then read the file (it is git-ignored).
- One file: `node --test --test-concurrency=1 tests/foundation.test.js`.
- Never run two test commands at the same time, and never give `node --test` several files without `--test-concurrency=1`: they share one database and break each other, which gives fake failures.
## 3. MongoDB Atlas
Three different "passwords" exist; do not mix them up:
- **Atlas account password**: logs you into the Atlas website. Never goes in `.env`.
- **Database user password**: a separate user you create inside your project for the app to connect. This one goes inside the connection string.
- **Connection string**: the address plus the database user and password. It is a secret; it goes only in `.env` locally and in Render's dashboard.

Steps:
1. Create an account at mongodb.com/cloud/atlas.
2. Create a project, then create a free **M0** cluster (pick a region close to your Render region).
3. Database Access -> Add New Database User -> choose a username and a generated password (save it in a password manager). Give it "Read and write to any database".
4. Network Access -> Add IP Address. Render Free has no fixed IP, so you must use "Allow access from anywhere" (0.0.0.0/0). This is a known trade-off; protection then relies on the strong database password. Use a strong, unique password.
5. Database -> Connect -> Drivers -> copy the connection string.
6. In the string replace `<db_user>`/`<db_password>` with your database user and password. If the password has special characters (`@ : / ? # %`), URL-encode them, or generate a password using only letters and numbers.
7. Add a database name after the host, for example `.../checkmate?retryWrites=true&w=majority`.
8. Put the final string in `.env` as `MONGODB_URI=...`.

## 4. Secrets and `.env`
- `.env` is ignored by git (see `.gitignore`). Never commit it, never paste it into a chat, a ticket or a screenshot.
- Only TWO values are required to start the server in production: `MONGODB_URI` and `JWT_ACCESS_SECRET`. If one is missing the server stops at start-up and prints which one (it never prints the values).
- Make a strong secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` (at least 32 characters are required).

| Value | Needed? | What it is | Where it goes |
|---|---|---|---|
| `MONGODB_URI` | required | The Atlas connection string; it contains the DATABASE USER's password (section 3) | `.env` locally; Render dashboard (Environment) |
| `JWT_ACCESS_SECRET` | required | A secret you make up (not issued by anyone). It signs the login tokens | `.env` locally; on Render the Blueprint generates it for you (section 6) |
| `TURN_URLS` and `TURN_USERNAME` + `TURN_CREDENTIAL`, or `TURN_SECRET` | optional | A relay for voice when two phones cannot connect directly (from Metered or your own coturn). Without it voice uses STUN only | `.env` / Render dashboard. Never in git |
| `PURCHASE_VERIFIER=google`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | optional | Real-money purchases. Needs a Google Play Console account and a service account. The JSON key is a SECRET, written as ONE line | Render dashboard / `.env` only. Leave `PURCHASE_VERIFIER=disabled` until you have them |
| E-mail key (Resend) | not used yet | E-mail verification and password reset are not built yet, so there is nothing to enter | - |
| everything else | optional | Limits and timings with safe defaults | listed with explanations in `.env.example` |

How these differ: the **Atlas account password** logs you into the Atlas website and is never used by the server. The **database user password** is inside the **connection string**. The **JWT secret** is made up by you or by Render. **Render environment variables** are only a private place on Render to keep these values, so you do not have to put them in files. **TURN credentials** and **other API keys** come from the provider that issued them.

If a secret leaks (it was committed to GitHub, pasted in a chat, or a backup folder was shared), treat it as stolen: removing the commit is not enough.
1. Database password / connection string: Atlas -> Database Access -> Edit the database user -> new password; put the new string in `.env` and Render; redeploy or restart.
2. `JWT_ACCESS_SECRET`: set a new value in Render and `.env`; restart. Every existing access token stops working at once, so players have to refresh or sign in again.
3. TURN credentials: change them at the provider, then in `.env` and Render. Google service account: delete the key in Google Cloud, create a new one, update the variable.
4. Then check the logs for activity you do not recognise, and make a backup (section 7).

## 5. GitHub
Git may already be set up in this folder (look for a hidden `.git` folder); if it is, nothing has been committed yet.
1. On github.com create an EMPTY **private** repository (no README, no .gitignore).
2. Tell git who you are, once: `git config user.name "Your Name"` and `git config user.email "you@example.com"`.
3. Run `git status`. You must NOT see `.env`, `backups/` or `node_modules/` in the list (they are ignored). If you see one of them, stop and fix `.gitignore` first.
4. `git add .` then `git commit -m "Initial commit"`.
5. Connect and upload (use the address GitHub shows you): `git branch -M main`, `git remote add origin <repository-address>`, `git push -u origin main`.
6. On github.com open the repository and check that `.env` is not there.
7. From now on commit after every working session (`git add .`, `git commit -m "what changed"`). It also gives you a history to go back to.

**Getting the project onto another computer (or downloading it fresh):** install Node.js (section 1), then `git clone <repository-address>`, `cd` into the folder, `npm install`, and create `.env` as in section 2. The repository does not contain `.env`, so you must create it again from your password manager. Without git you can also use GitHub's "Download ZIP" on the repository page, unzip it and do the same.

## 6. Deploy on Render (free)
Two ways; the first is easier.

**A. With the Blueprint (`render.yaml` is already in the project):**
1. Render dashboard -> New -> Blueprint -> connect your GitHub repository.
2. Render reads `render.yaml` and asks you for `MONGODB_URI` (paste your Atlas string) and `CORS_ORIGINS` (leave it empty if only the Android app calls the server; if the box refuses an empty value, type `https://example.invalid`, which allows no real website). `JWT_ACCESS_SECRET` is generated by Render for you.
3. Apply. Render builds with `npm ci` and starts with `npm start`.

**B. By hand:** New -> Web Service -> your repository. Runtime Node, build command `npm ci`, start command `npm start`, instance type Free, health check path `/health/live`. Environment tab: `NODE_ENV=production`, `MONGODB_URI=<your string>`, `JWT_ACCESS_SECRET=<a secret from section 4>`, and any optional variables you want (see `.env.example`). Do not set `PORT`; Render sets it.

**After the first deploy**
1. Render shows your address, like `https://<name>.onrender.com`. That is your free `onrender.com` subdomain; no domain purchase is needed.
2. Open `https://<name>.onrender.com/health/live` (server up) and `/health/ready` (200 means Atlas is reachable).
3. Test the WebSocket with the command in section 2, step 8, using `wss://<name>.onrender.com/ws`. Give the Android developer the same address.
4. Updates: push to GitHub; Render redeploys automatically. Logs: Render dashboard -> your service -> Logs. A bad deploy can be rolled back from the dashboard (Deploys / Events).

**What Render Free really means** (from Render's documentation, checked 2026-11-19; Render can change it, see render.com/docs/free)
- A free web service is spun down after 15 minutes without inbound traffic. HTTP requests and WebSocket messages from existing connections count as traffic. The next request wakes it, which takes about a minute, and every WebSocket connection is dropped when it sleeps.
- Render may also restart a free service at any time, and its disk is not kept: this project stores nothing on disk, everything is in MongoDB.
- Each workspace gets 750 free instance hours a month (one always-awake service uses about 744 in a 31-day month), plus limits on outbound bandwidth and build minutes. Render itself says free instances are not meant for production apps.
- What the server does about it: games are stored in MongoDB after every move. After a restart or wake-up, live games are paused with their last clock values (nobody loses time) and resume when both players are back. The Android app must reconnect by itself and then send `game.join` / `spectate.join` / `room.join` again (see WEBSOCKET_DOCUMENTATION).
- Optional: an external uptime service that calls `/health/live` every 10 minutes keeps the server awake while nobody plays, but it uses almost all of the 750 hours and is no guarantee. Do not promise your players uninterrupted service on the free plan.

**When something does not work**
- The deploy fails or stops at start with `Invalid environment configuration`: the message names the missing variable (`MONGODB_URI` or `JWT_ACCESS_SECRET`). Add it in the dashboard (Environment) and redeploy. `PURCHASE_VERIFIER=fake` is refused in production on purpose.
- `/health/ready` answers 503 or the logs say the database is unreachable: in Atlas check Network Access (section 3, step 4), the database user and password (special characters must be URL-encoded), and that the cluster is not paused.
- The first request after a quiet period is very slow or the app lost its connection: the free service was asleep (see above).
- The WebSocket closes with a code 4001 to 4004: see "Close codes" in WEBSOCKET_DOCUMENTATION (not authenticated in time, token expired, authentication failed, session ended).
- Logs never contain passwords or tokens (they are redacted), so it is safe to copy a few log lines when asking for help; still read them first.
## 7. Backups, restore and moving to another host
Atlas M0 (the free cluster) does NOT make scheduled backups for you, so you make them yourself. This project has two small scripts for it (decision D-061). You do not need to install anything extra: they use the same Node.js and the same `.env` as the server.

**What a backup is.** A folder on your computer with one file per collection (`users.ndjson`, `games.ndjson`, ...) and a `manifest.json` that lists every file with its size and a checksum. The checksum lets the restore script notice a damaged or edited file before it touches your database.

**When to make one.** Once a week, and ALWAYS before: the first cleanup with `--apply` (section "Cleaning up old data"), a restore, a big update, or moving to another host. If you only do it when you remember, you will have an old one when you need it.

### Make a backup
1. Open PowerShell in the project folder (the one that contains `package.json`).
2. Check that `.env` has `MONGODB_URI` pointing at the database you want to save (your Atlas cluster, section 3). Atlas must allow your current IP address (Atlas -> Network Access), otherwise the script says it cannot connect.
3. Run: `node scripts/backup.js`
4. It prints every collection with its number of documents and ends with `BACKUP DONE` and the folder name, for example `backups\backup-2026-11-19T11-42-41-780Z` (the time is UTC). The backup only READS your database; nothing is changed.
5. Optional: `node scripts/backup.js --out D:\my-backups` writes somewhere else (for example a USB drive), and `--exclude sessions,matchmaking_queue` leaves out collections you do not need.

Make it when few people are playing. It is not a snapshot of one single moment: a game or a coin purchase that happens while it runs can be slightly out of step between two collections.

### Check a backup (changes nothing)
Run `node scripts/restore.js "backups\backup-2026-11-19T11-42-41-780Z"` (use your folder name). Without `--apply` this is a DRY RUN: it verifies every file against the manifest and lists what a restore would do. `Files and checksums: OK` means the backup is complete and unchanged. If it says THE BACKUP IS DAMAGED, do not use that folder; use an older one.

### Restore a backup
Only do this when something is really wrong (data lost or damaged), and read every line before you press Enter.
1. Stop the server so nobody writes while you restore: Render dashboard -> your service -> Suspend (locally: Ctrl+C in the terminal that runs it).
2. Run the dry run first (command above) and read the `Target: database "..." on ...` line. That is the database that will be changed. Check it is the one you mean.
3. Restore into an EMPTY database (a new cluster, or after you dropped it): `node scripts/restore.js "<folder>" --apply`
4. Restore into a database that still has data: `node scripts/restore.js "<folder>" --apply --replace`. For every collection in the backup this DROPS the current collection and fills it from the backup, so everything written after the backup is lost. Without `--replace` the script refuses and changes nothing.
5. Only some collections: add `--only users,games` (names separated by commas, no spaces).
6. The script ends with `RESTORE DONE: every collection has the expected number of documents` (or lists the differences). Start the server again: it recreates the indexes by itself. Render: Resume.
7. Tell your players that data after the time of the backup is gone. Coins and purchases (`wallets`, `transactions`, `purchases`, `entitlements`) are the part that matters most: see which of them changed since the backup before you reply to players who say they lost something.

### Keep backups safe
- A backup contains personal data: e-mail addresses, password hashes, personal messages and session token hashes. Keep the folder private. Never put it on GitHub or send it in chat. The folder `backups/` is already listed in `.gitignore`.
- Nothing is encrypted. Keep copies only on drives you control. A second copy on another disk or a private cloud drive protects you if this computer breaks.
- Old backups are not deleted automatically. Delete old folders yourself (keep, for example, the last 4 weekly ones). When you delete a player at their request, remember that older backups still contain them.
- Do not edit files inside a backup folder: the checksum check will (correctly) refuse it.

### Move to another host later (Render -> somewhere else, or a new Atlas cluster)
1. Make a backup (above).
2. New MongoDB cluster: create it like in section 3, and put its connection string in `.env` as `MONGODB_URI`. Run the dry run, then `node scripts/restore.js "<folder>" --apply` (the new database is empty). Start the server once so the indexes are created.
3. New web host: set the same environment variables there (every variable in `.env.example` that you use), run `npm ci` and `npm start`; no code change is needed. Point the Android app at the new address. Live games that were running are paused by the server and resume when both players are back, without charging clock time (see FAILURE_RECOVERY_GUIDE).
4. Keep the old database untouched until the new one has worked for a few days.

### Practice once, before you need it
Do a restore into a throw-away database now, while nothing depends on it. Open `.env`, and in `MONGODB_URI` change only the database name (the word after the last `/` and before any `?`), for example from `checkmate` to `checkmate_practice`. The database does not have to exist: MongoDB creates it. Run `node scripts/restore.js "<folder>" --apply` and check that it ends with `RESTORE DONE`. Then CHANGE THE NAME BACK in `.env`, otherwise the server will start on the empty practice database. A procedure you have never run is the one that fails on the bad day.
## Making yourself an administrator
Administrator rights are given only from your own computer, never through the API. This way a stolen token can never create new administrators.
1. Register the account normally in the app (or through `POST /api/v1/auth/register`).
2. On your computer, in the project folder, make sure `.env` contains your real `MONGODB_URI` (the same Atlas database the server uses).
3. Run: `node scripts/set-role.js YOUR_USERNAME admin`
4. To remove the role again: `node scripts/set-role.js YOUR_USERNAME user`
5. The change takes effect on the next request. Every change is recorded in the `admin_actions` collection.
Render Free has no shell, which is why the script runs on your computer against Atlas.

## Cleaning up old data (retention)
The free Atlas database holds 512 MB. To keep it from filling up, the server runs a cleanup job by itself, 60 seconds after it starts and then every 6 hours. It only does two things:
- A game that finished more than **90 days** ago loses its list of moves. The game itself stays: players, result, rating change and the PGN (the full game as text). The app rebuilds old games from the PGN.
- A report that an admin marked reviewed or dismissed more than **365 days** ago is deleted. Open reports are never deleted.

Sessions (logins) are deleted 30 days after they expire by MongoDB itself. Messages, coins, purchases, tournaments and the admin log are never deleted.

**See what it would do first (changes nothing):** on your computer, in the project folder, with your real `MONGODB_URI` in `.env`:
`node scripts/retention.js`
It prints how many games and reports match. Add `--apply` to really do it by hand: `node scripts/retention.js --apply`. An admin can also see the same numbers with `GET /api/v1/admin/retention` in the app or API.

**Before the very first cleanup on real data, make a backup** (section 7). A removed move list cannot be brought back without one.

Settings (optional, in `.env` locally and in the Render dashboard under Environment; the defaults are fine):
| Variable | Default | Meaning |
|---|---|---|
| `RETENTION_ENABLED` | `true` | `false` switches the job off completely |
| `RETENTION_DRY_RUN` | `false` | `true` = the job only counts and writes to the log, changes nothing |
| `RETENTION_GAME_MOVES_DAYS` | `90` | age at which the move list of a finished game is removed (not below 7) |
| `RETENTION_REPORTS_DAYS` | `365` | age at which resolved reports are deleted (not below 30) |
| `RETENTION_INTERVAL_MS` | `21600000` | time between runs (6 hours) |
| `RETENTION_FIRST_RUN_MS` | `60000` | wait after start before the first run |
| `RETENTION_BATCH_SIZE` | `200` | documents changed per step |
The job only runs while the server is awake: on Render Free it runs whenever the server is up. The numbers cannot be set below the minimums, so a typing mistake cannot wipe recent data.

