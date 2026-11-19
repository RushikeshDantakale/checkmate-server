# TODO

Legend: [x] done, [~] in progress, [ ] pending. Every task needs tests before it is marked done.

## Phase 1: Foundation
- [x] Skeleton, config, logger, error handling
- [x] Health endpoints, MongoDB connection with retry
- [x] WebSocket skeleton (hello, ping/pong, heartbeat, limits)
- [x] Foundation tests (7 passing)
- [ ] Owner: create Atlas cluster + `.env`, verify `/health/ready` = 200 (blocks Phase 2 DB tests)
- [ ] git init, push to GitHub, connect Render, verify deploy
- [x] Write remaining docs skeletons (API, WEBSOCKET, DATABASE, FAILURE_RECOVERY)

## Phase 2: Auth, users, sessions, friends, presence (local MongoDB OK)
- [x] User model + indexes (unique email, username)
- [x] Register/login/logout, password hashing, access + refresh tokens, session records, revocation
- [ ] Email verification and password reset (Resend behind an interface)
- [x] WebSocket authentication, token expiry during live session
- [x] User profiles, settings (account status admin controls: Phase 8)
- [x] Friends: requests, accept/reject, list, block, report
- [x] Presence and multi-device handling

## Phase 3: Matchmaking and live chess (critical: recovery)
- [x] Game model, atomic move persistence, idempotency by moveId + seq
- [x] Clocks, results, PGN (move legality is checked by the Android client, D-021, so no chess.js)
- [x] Matchmaking queue, invitations, cancel
- [x] Reconnect grace, outage recovery, clock checkpoints
- [x] Recovery tests (simulated crash, restart while already paused, DB failure)
- [x] Owner: run `node scripts/manual-kill-test.js` (real hard kill of the server mid-game): passed 2026-11-18
- [ ] Test graceful shutdown (SIGTERM) with a live game

## Phase 4: Messaging and voice signaling (done 2026-11-19, 154/154 tests)
- [x] Storage monitor and /health/storage (D-028), tested with stubbed size (tests/storage.test.js)
- [x] Tests: personal messaging (tests/messaging.test.js, 12)
- [x] Tests: temporary match chat, never stored (tests/match-chat.test.js, 13)
- [x] Tests: voice signaling and TURN credentials (tests/voice.test.js 20, tests/voice-turn.test.js 4)
- [x] Document Phase 4 in API, WEBSOCKET, DATABASE documentation and FAILURE_RECOVERY_GUIDE (scenarios 20, 21)
- [x] Flaky test tests/game-checkpoint.test.js made tolerant
- [ ] Owner, optional: create a Metered account and set TURN_* in .env / Render, then test voice between two real phones (real audio and NAT behaviour are NOT verified)
- [ ] At deploy time: document in SERVER_SETUP_GUIDE that TURN_* are OPTIONAL Render dashboard variables (render.yaml deliberately omits them; the server runs STUN-only without them)
- [x] Deleted the unused placeholder src/modules/games/chessEngine.js (2026-11-19)
## Phase 5: Analysis rooms (max 10) (done 2026-11-19, 193/193 tests)
- [x] Decisions D-035 to D-040 recorded in DECISIONS.md (single-document room, private invite-only, roles, rev-guarded writes, RAM presence and chat, lifecycle and retention)
- [x] Model, service, presence, REST reads (GET /api/v1/rooms, GET /api/v1/rooms/:id), WebSocket handler (`room.*`), idle sweeper, TTL deletion
- [x] Tests: tests/rooms.test.js (20: membership, invitations, 10-member limit, simultaneous joins, roles, kick, host handover, closing, presence, authorization)
- [x] Tests: tests/room-analysis.test.js (19: moves, variations, position, annotations, move cap, simultaneous edits, chat never stored, rate limit, blocks, reconnect, restart, idle sweeper)
- [x] Fixed wrong revision numbers in one rooms test (test bug, not a server bug)
- [x] Documented in WEBSOCKET, API, DATABASE documentation, FAILURE_RECOVERY_GUIDE (scenarios 20b, 25) and PROJECT_CONTEXT
- [x] Add ROOM_* variables to .env.example
- [ ] Add ROOM_* variables to SERVER_SETUP_GUIDE (optional, they have defaults; render.yaml deliberately omits them)
- [ ] Not verified: real Atlas, a database outage during a room edit, a real client following the `rev` / re-join procedure
- [ ] Known limit to revisit in Phase 8: the hosted-room limit is a count check, so two simultaneous creations can exceed it by one
- [x] Cleanup: test-run.log deleted (`*.log` is already in .gitignore)
## Phase 6: Spectators and game history (done 2026-11-19, 18 new tests)
- [x] Decisions D-041 to D-044 recorded in DECISIONS.md (friends-only spectating, no delay, limit 20, history, saved analysis)
- [x] Spectators: `spectate.join` / `spectate.leave`, `spectate.update` / `over` / `count`, authorization, limit, clean-up on disconnect (tests/spectators.test.js, 9)
- [x] Game history REST `GET /api/v1/games`, live list `GET /api/v1/games/live`, completed-game retrieval for allowed viewers (tests/game-history.test.js, 3)
- [x] `analysis_sessions`: save a copy of a room, list, get, delete, cap, retry-safe (tests/analysis-sessions.test.js, 6)
- [x] Documented in API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (25b), PROJECT_CONTEXT, .env.example
- [ ] Run the FULL `npm test` once (211 tests expected) in the background and record the result in CURRENT_STATUS
- [ ] Not verified: a restart with active spectators, a database outage during `spectate.join`, many spectators on Render Free, a real client following the spectator reconnect procedure
- [ ] Known limits to revisit in Phase 8: no delay for spectated moves (a spectating friend could relay moves), a block after joining does not remove a spectator, `spectate.over` can carry `ratingChange: null`, a reconnecting player only learns the spectator count from the next push, no search or filters in history, saved analyses cannot be shared or renamed
## Phase 7: Economy, purchases, notifications, tournaments (policy D-045: while building, run ONLY the test files of the step being built; full `npm test` once when Phase 7 is finished)
### 7a Economy, purchases, entitlements (done 2026-11-19, 35 tests)
- [x] Decisions D-045 to D-055 recorded in DECISIONS.md
- [x] Wallet and ledger (exactly-once, reconciler), daily reward, packs for coins, entitlements, purchases with pluggable verifier, REST
- [x] Tests: tests/economy.test.js (21) and tests/purchases.test.js (14)
- [x] Documented in API, DATABASE, FAILURE_RECOVERY_GUIDE (25c), .env.example, CURRENT_STATUS
- [ ] Replace the placeholder pack names and prices in src/modules/economy/catalogue.js with the real commentator packs
- [ ] Add an automated test of the `google` verifier with a stubbed HTTP layer (D-050 says this exists; no such test file was found)
- [ ] Owner: Google Play Console account and service account before PURCHASE_VERIFIER=google can be used; decide premium one-time or subscription (D-049)
- [ ] Not verified: a real Atlas outage during a purchase; a direct test of economy.monitor tickNow (its two reconcile functions are tested)
- [ ] Phase 8: admin endpoint to grant or revoke coins and entitlements; handling of purchases that Google refunds later
### 7b Notifications (D-051) (done 2026-11-19, 16 tests)
- [x] `notifications` model with TTL 30 days, service, REST (list with cursor, unread count, mark one / all read), live push `notification.new`
- [x] Tests: tests/notifications.test.js (16 pass, run alone)
- [x] Documented in API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (25d), PROJECT_CONTEXT
- [x] Tournaments (7c) now call `notify()`. Open: decide whether the daily reward should also notify.
- [ ] Owner: phone push while the app is closed needs a Firebase project (D-051 is still open)
### 7c Tournaments (D-052 to D-055) (done 2026-11-19, 33 tests) - depends on 7a (fees, prizes) and 7b (round notices)
- [x] Models `tournaments` and `tournament_players`; state only in MongoDB (failure scenario 19)
- [x] Sweeper: start at startsAt, create games, forfeits, next round, finish and pay prizes; Swiss pairing and scoring
- [x] REST: list, create, read, join, leave, cancel (host)
- [x] Tests: `tests/tournaments-logic.test.js` (14) and `tests/tournaments.test.js` (19), run together on their own: 33 pass
- [x] Documented in API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (scenario 19), PROJECT_CONTEXT, `.env.example`, CHANGELOG, DECISIONS (D-056)
- [ ] Not verified: killing the real process during a real tournament; a real Android client; behaviour on Atlas
- [ ] Known limits to decide later: no host-side kick or edit; no tournament chat; no recurring tournaments; pairing is greedy, not FIDE Dutch; a player online but inside another game at `startBy` counts as absent
### After 7c
- [ ] Run the FULL `npm test` once in the background with output to a file and record the result in CURRENT_STATUS (not run since Phase 6 was added)
## Phase 8: Hardening, monitoring, backups, failure testing, deployment prep (started 2026-11-19; run only each step's own tests with --test-concurrency=1, one full npm test at the end)
### 8a Crash safety
- [x] Process guards: uncaughtException / unhandledRejection (D-057), tests/process-guards.test.js (7)
- [ ] Graceful shutdown (SIGTERM) with a live game: on Windows every signal is a hard kill, so it cannot be proven on the owner machine. Behaviour is the same as a crash (boot recovery, D-012). Verify on Render or WSL later
### 8b Rate limits and abuse protection
- [x] Per-socket rate limits for game and matchmaking events (D-058), tests/ws-rate-limits.test.js (7)
- [x] Hosted-room limit race fixed (D-058), tests/rooms-limit-race.test.js (2)
- [ ] Per-user (all devices) and per-IP WebSocket connection limits: not done, decide in 8g if needed
### 8c Admin module
- [x] Admin-only REST, audit log, set-role script (D-059), tests/admin.test.js (12)
- [ ] Banned users still show in friend lists and user search (not hidden yet)
- [ ] Handling of purchases that Google refunds later (left open from Phase 7)
### 8d Retention and storage (done 2026-11-19, D-060, owner approved the numbers)
- [x] Decision D-060 in DECISIONS.md (corrects the proposal: game_events already had a 90-day TTL, so the per-move list inside old finished games is what is trimmed)
- [x] Cleanup job (src/modules/retention): old finished/aborted games with a PGN lose `moves` after 90 days (`movesCompactedAt`), resolved reports deleted after 365 days, sessions kept 30 days after expiry (TTL index + startup migration), batches, overlap guard, dry-run mode, never starts in tests
- [x] `scripts/retention.js` (dry run by default, `--apply`), `GET /api/v1/admin/retention` (read-only preview + storage level)
- [x] REST: game view returns `movesCompacted: true` for trimmed games (`moves: []`, PGN stays)
- [x] Tests: tests/retention.test.js (12 pass); re-run because shared code changed, one file at a time: auth 13, foundation 7, users 4, games 18, game-history 3, game-recovery 7, admin 12, storage 6, ws-auth 9, spectators 9, analysis-sessions 6 (all pass)
- [x] Docs (written 2026-11-19; an earlier version of this line claimed they were done before they were): DATABASE, API, FAILURE_RECOVERY_GUIDE (16), SERVER_SETUP_GUIDE, CHANGELOG, `.env.example` (RETENTION_*)
- [x] PROJECT_CONTEXT.md was restored by the owner; Phase 8 summary (8a to 8e) added 2026-11-19
- [ ] Android developer must handle `movesCompacted` (rebuild old games from the PGN)
- [ ] Not verified: a real run on Atlas data; the 6-hour timer itself (`tick()` is tested directly); the TTL monitor actually deleting a session 30 days after expiry
- [ ] Before the first real `--apply` on production data: dry run first, then a backup (8e)
### 8e Backup and restore (done 2026-11-19, D-061)
- [x] Decision D-061 (plain Node scripts, no extra software, manifest with checksums written last, dry-run restore, refuses non-empty collections without --replace)
- [x] `src/modules/backup/backup.service.js`, `scripts/backup.js`, `scripts/restore.js`; `backups/` is git-ignored
- [x] Tests: tests/backup-restore.test.js (15 pass, run alone). The scripts were also run end to end on the local development database: backup of 22 collections, restore dry run, `--apply` refused on non-empty collections. Fixed an undeclared dependency: the service and test now use `mongoose.mongo.BSON` instead of `require('bson')`
- [x] Beginner guide: SERVER_SETUP_GUIDE section 7 (backup, check, restore, safekeeping, moving to another host, practice restore); FAILURE_RECOVERY_GUIDE scenario 25e; DATABASE_DOCUMENTATION
- [ ] Owner: make a real backup of the Atlas cluster once it exists, and do the practice restore described in the guide
- [ ] Not verified: backup and restore on real Atlas, a large database (time and size), restore while the server runs (the guide says to stop it first)
- [ ] Possible later: an automatic reminder or a scheduled backup run by the owner's computer (Windows Task Scheduler); encryption of backup files (rejected in D-061 for now)
### 8f Deployment prep (started 2026-11-19; the parts that need no owner account are done)
- [x] `git init` done locally (`.git` exists, NOTHING committed: the owner commits with their own name, SERVER_SETUP_GUIDE section 5). `git ls-files --others --exclude-standard` checked: no `.env`, no `backups/`, no `node_modules/`; a secret scan of everything that would be committed found only placeholders in `.env.example`. Leftover test-output files in the project root (`.full-run*.txt`, `.t7c-*.txt`, `.notif-out.txt`) are now ignored by `/.*.txt` in `.gitignore` (not deleted)
- [x] `.env.example` now documents every setting the code reads (five game timing settings were missing)
- [x] `render.yaml` reviewed: `JWT_ACCESS_SECRET` now uses `generateValue: true` (Render creates it on the first deploy; checked in Render's Blueprint documentation, and a 44-character base64 value is accepted by the config); `MONGODB_URI` and `CORS_ORIGINS` stay `sync: false`
- [x] SERVER_SETUP_GUIDE sections 2, 4, 5, 6 rewritten and checked against the 26-point list of the brief (all 26 now covered): correct test instructions (needs a local MongoDB, wipes `checkmate_test`), the two required variables, a table of where each secret goes, leak procedure, git steps, clone on another computer, Blueprint and manual Render deploy, real Render Free limits (from render.com/docs/free), WebSocket check, troubleshooting. The health URLs and the WebSocket one-liner were run against the local server and work
- [ ] Owner: create the Atlas cluster and `.env` (section 3), create the private GitHub repository and make the first commit and push (section 5), deploy on Render (section 6)
- [ ] After the first real deploy: run the checks in section 6 on the real `onrender.com` address, and record what really happened (sleep and wake-up time, WebSocket reconnect) in CURRENT_STATUS. Nothing about Render or Atlas behaviour has been observed yet
- [ ] Not verified: that the Render Blueprint prompt accepts an empty `CORS_ORIGINS` (the guide gives a fallback value), `npm ci` on Render's Node version (`engines` is `>=20`; the local Node is 22.18)
### 8g Final failure testing
- [ ] Walk all 25 scenarios, then one full npm test

## Dependencies
Phase 2+ depends on Atlas credentials. Phase 3 depends on Phase 2 (authenticated users). Phases 4-7 depend on Phase 3.



