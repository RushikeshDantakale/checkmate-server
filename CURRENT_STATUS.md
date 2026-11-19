# CURRENT_STATUS

Last updated: 2026-11-19

## Phase
- Phase 1 (foundation): complete.
- Phase 2 (auth, users, friends, presence): complete EXCEPT email verification and password reset (waiting for a Resend API key).
- Phase 3 (matchmaking and live chess with recovery): complete and verified. The manual kill-the-server test (scripts/manual-kill-test.js) passed on the owner's machine on 2026-11-18.
- Phase 4 (personal messaging, temporary match chat, voice signaling, storage monitor): complete, tested, documented (2026-11-19).
- Phase 5 (analysis rooms): complete, tested, documented (2026-11-19). Design in D-035 to D-040.
- Phase 6 (spectators, game history, saved analysis): complete, tested, documented (2026-11-19). Design in D-041 to D-044.
- Phase 7 (economy and purchases, notifications, tournaments): ALL THREE STEPS IMPLEMENTED AND VERIFIED (7a, 7b, 7c), each by running only its own test files. The full `npm test` is still OWED (see "Exact next task"). Design in D-045 to D-056.
- Test policy (owner instruction 2026-11-19, D-045): the full `npm test` after Phase 6 was deliberately NOT run. Run the full suite once now that Phase 7 is finished, and once more before any deployment.

## Phase 7 progress (update after every step)
- Design decisions D-045 to D-055 written.
- **7a economy, purchases and entitlements: implemented and verified (2026-11-19, 35 tests).** The code was written in an earlier session without updating this file; this session audited it, ran it, added the missing purchases tests and the missing documentation.
  - Wallet and ledger (exactly-once without transactions, D-046), daily reward, commentator packs bought with coins, entitlements (`premium`, `packs`), purchases verified by a pluggable verifier (`disabled` default, `fake` for tests, `google` written but untested), reconciler (`economy.monitor`, every 30 s).
  - REST: `GET /api/v1/wallet`, `GET /api/v1/wallet/transactions`, `POST /api/v1/wallet/daily-reward`, `GET /api/v1/store/catalogue`, `POST /api/v1/store/packs/:packId/buy`, `POST /api/v1/purchases`, `GET /api/v1/purchases`. Collections: `wallets`, `transactions`, `entitlements`, `purchases`.
  - Tests: `tests/economy.test.js` (21 pass) and `tests/purchases.test.js` (14 pass), each run alone on 2026-11-19. Only these two files were run; the full suite was deliberately not run (D-045).
  - Docs: API_DOCUMENTATION, DATABASE_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (25c), `.env.example` (DAILY_REWARD_COINS, WALLET_*, PURCHASE_VERIFIER, GOOGLE_PLAY_*).
  - Not verified: the `google` verifier against real Google Play AND with a stubbed HTTP layer (D-050 says such a test exists; no test file for it was found); a real Atlas outage during a purchase; the 30 s timer itself (`tickNow` has no direct test, the two `reconcile` functions it calls do); a real Android client; the placeholder pack names and prices in `catalogue.js` must be replaced with the real ones.
  - Known limits: coin balances can only be changed by the server (no admin endpoint to grant coins yet: Phase 8); no refund handling for a purchase that Google refunds later (the `cancelled` answer only applies when redeeming).
- **7b notifications: implemented and verified (2026-11-19, 16 tests).** The code and tests were written by an earlier session that stopped before updating this file; this session re-ran `tests/notifications.test.js` alone (16 pass), then wrote the missing documentation.
  - Model `notifications` (type, data, `readAt`, optional `key`, TTL 30 days), service (`create` throws, `notify` never throws, a `key` makes a repeat return the stored one), REST `GET /api/v1/notifications` (cursor, `unread=true`), `GET /unread-count`, `POST /:id/read`, `POST /read-all`, live push `notification.new` and `notification.read` to every device of the user.
  - Docs: API_DOCUMENTATION, WEBSOCKET_DOCUMENTATION, DATABASE_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (25d), PROJECT_CONTEXT.
  - Not verified: a real Android client; behaviour on Atlas. Limits: no phone push while the app is closed (needs Firebase, D-051 open); the `tournament_*` types exist but nothing creates them yet; no other module calls `notify()` yet (not even the daily reward).
- **7c tournaments: implemented and verified (2026-11-19, 33 tests).** The code and tests were written by an earlier session that stopped before updating this file; this session audited the wiring, ran `tests/tournaments-logic.test.js` (14) and `tests/tournaments.test.js` (19) together and alone (33 pass), then wrote the missing documentation.
  - Swiss tournaments, 4 to 32 players, optional entry fee (0 to 500 coins) pooled and paid as prizes (D-054), greedy pairing (not FIDE Dutch), Buchholz tie-break, byes, forfeits after `TOURNAMENT_SHOW_UP_MS`, refunds on leave before the start or on cancel, a sweeper that recovers from stored data only (D-053, D-056).
  - REST: `GET/POST /api/v1/tournaments`, `GET /:id`, `POST /:id/join`, `/leave`, `/cancel`. Collections: `tournaments`, `tournament_players`. No WebSocket events of their own: notifications (`tournament_*`) and `game.started`.
  - Docs: API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (scenario 19), PROJECT_CONTEXT, `.env.example`, CHANGELOG, TODO, DECISIONS (D-056).
  - Not verified: killing the real process during a real tournament; the 2 s timer itself (`tick()` is tested directly); behaviour on Atlas; a real Android client.
  - Known limits: no host kick or edit; no tournament chat; no recurring tournaments; a player online but inside another game at show-up time counts as absent; nothing yet lets an admin repair a stuck tournament (Phase 8).
- Open owner questions: premium as one-time purchase or subscription (D-049); phone push with Firebase (D-051); real Google Play account for the `google` verifier (D-050).

## Phase 8 progress
- 8a process guards: implemented and verified 2026-11-19 (src/utils/processGuards.js, D-057, tests/process-guards.test.js 7 pass). Wired in main() of src/server.js; that wiring has no automated test.
- Graceful shutdown finding: shutdown() closes sockets and exits; live games stay active in MongoDB and boot recovery pauses them from the last checkpoint, exactly like a crash (D-012). On Windows SIGTERM is a hard kill, so a real SIGTERM test must run on Linux (Render) or WSL.
- 8b abuse limits: implemented and verified 2026-11-19 (D-058). Per-socket rate limits on game.* (join/move 20, resign/draw.offer 5, draw.accept/decline 10 per 10 s) and queue.* / invite.* (10 per 10 s). Hosted-room limit race fixed. New tests: tests/ws-rate-limits.test.js (7), tests/rooms-limit-race.test.js (2). Re-run because their code changed: games, matchmaking, game-recovery, game-recovery-paused, game-presence, game-checkpoint, spectators, voice, match-chat (91 pass) and rooms, room-analysis, analysis-sessions (45 pass). The race test was not run against the old code, so it is not proven to fail without the fix.
- LESSON: `node --test` with several files runs them in parallel and they share the database. Always use `node --test --test-concurrency=1 file1 file2 ...` (a run without it gave 48 bogus failures).
- 8c admin module: implemented and verified 2026-11-19 (D-059; src/modules/admin, middleware/requireAdmin.js, models admin_actions and report, scripts/set-role.js). Code and decision were written by another session without updating the status files; this session checked it: tests/admin.test.js 12 pass, and the files touching changed code were re-run one at a time: economy, purchases, auth, users, friends, notifications, foundation (88 pass), tournaments-logic (14 pass), tournaments (19 pass). Docs added this session (API, DATABASE, SERVER_SETUP_GUIDE, CHANGELOG, TODO).
- NOTE: one run of all those files together in a single `node --test` command hit the 15 minute timeout with no output, while the same files pass in about a minute when split. Cause not found; if it recurs run the tournament files on their own.
- 8d retention and cleanup: implemented and verified 2026-11-19 (D-060, owner approved the numbers). `src/modules/retention` (service, monitor, startup index migration), `scripts/retention.js` (dry run by default, `--apply`), `GET /api/v1/admin/retention`. Finished or aborted games older than 90 days with a PGN lose their `moves` (`movesCompactedAt` set; REST returns `moves: []` and `movesCompacted: true`); reviewed or dismissed reports older than 365 days are deleted; sessions are kept 30 days after expiry. Tests: `tests/retention.test.js` 12 pass; re-run one file at a time because shared code changed: auth 13, foundation 7, users 4, games 18, game-history 3, game-recovery 7, admin 12, storage 6, ws-auth 9, spectators 9, analysis-sessions 6 (all pass, read from `batch-run.log`). Docs written 2026-11-19 (an earlier TODO line said they were done before they were): DATABASE, API, FAILURE_RECOVERY_GUIDE 16, SERVER_SETUP_GUIDE, `.env.example`, CHANGELOG, DECISIONS D-060. NOT verified: a run on real Atlas data, the 6-hour timer itself (`tick()` is tested directly), the TTL monitor really deleting a session 30 days after expiry. The Android client must handle `movesCompacted`.
- 8e backup and restore: implemented and verified 2026-11-19 (D-061; src/modules/backup, scripts/backup.js, scripts/restore.js). Written by another session without updating the status files; this session audited it against D-061, fixed an undeclared dependency (`require('bson')` replaced by `mongoose.mongo.BSON`), ran tests/backup-restore.test.js alone (15 pass) and ran both scripts end to end on the local development database (backup of 22 collections, restore dry run, `--apply` refused because the collections had data). Docs: SERVER_SETUP_GUIDE section 7 (beginner procedure), FAILURE_RECOVERY_GUIDE 25e, DATABASE_DOCUMENTATION, CHANGELOG, TODO. Not verified: a real backup or restore on Atlas, a large database, a restore while the server runs.
- 8f deployment prep, part 1 (no owner account needed) done 2026-11-19: `git init` (nothing committed), what git would track checked (no secrets, no `.env`), `.gitignore` extended, `.env.example` completed, `render.yaml` JWT secret generated by Render, SERVER_SETUP_GUIDE sections 2/4/5/6 rewritten and covering all 26 points of the brief (commands run locally: health URLs and WebSocket check pass). Still needed from the OWNER: Atlas cluster and `.env`, private GitHub repository with the first commit, Render deploy. Nothing about real Render or Atlas behaviour has been observed.
- 8g not started yet. The full suite has NOT been re-run since 8a/8b (last full run 295/295 before them); only each step's own test files were run since (D-045 policy). Phase 4 tests (messaging 12, match-chat 13, voice 20, voice-turn 4) were re-run on their own on 2026-11-19 and pass.

## Latest test run
Latest FULL run (2026-11-19, after Phase 7, one process at a time): **295 tests, 295 pass, 0 fail**. Partial runs before it (each file alone, D-045): `tests/economy.test.js` 21 pass, `tests/purchases.test.js` 14 pass, `tests/notifications.test.js` 16 pass, `tests/tournaments-logic.test.js` + `tests/tournaments.test.js` 33 pass (14 + 19). Also on 2026-11-19, before Phase 4 was finished, the full suite gave 99 of 99 pass after `npm test` was changed to run only `tests/**/*.test.js` (it used to pick up `scripts/manual-kill-test.js` by accident). The full suite after Phase 6 and 7 was run on 2026-11-19: 295 of 295 pass.
`npm test` on 2026-11-19, one clean run: **193 tests, 193 pass, 0 fail** (154 before Phase 5 + 39 for rooms). Never run two test processes at once: they share the database `checkmate_test` and drop it under each other, which produces bogus failures. If a command times out, check for leftover `node` processes (`Get-Process node`) before running tests again. The full suite takes several minutes; run it in the background and write the output to a file.

## Phase 6 (implemented and verified, 18 new tests, 2026-11-19)
- Spectators (D-041, D-042): a friend of a player (no block either way) follows a LIVE game with `spectate.join`; replies `spectate.state` (full game with moves); pushes `spectate.update` (snapshot + newest move, after every stored change), `spectate.over` (result + PGN, then dropped) and `spectate.count` (spectators and both players). Limit `SPECTATOR_MAX_PER_GAME` (20 distinct users). RAM only, per connection: clients re-join after a reconnect or restart. Spectators cannot move, resign or chat as players.
- History (D-043): `GET /api/v1/games` (my finished games, newest first, cursor), `GET /api/v1/games/live` (friends' live games I may watch). `GET /api/v1/games/:id` and `/pgn` also work for allowed viewers of COMPLETED games; strangers still get 404.
- Saved analysis (D-044): `/api/v1/analysis-sessions` (save a COPY of a room I am a member of, list, get, delete); owner only; cap `ANALYSIS_SESSIONS_MAX` (50); same room revision saved twice returns the stored copy.
- Tests: `tests/spectators.test.js` (9), `tests/game-history.test.js` (3), `tests/analysis-sessions.test.js` (6) all pass; `tests/games.test.js` (18) re-run because `games.routes.js` changed and passes. The full `npm test` was run afterwards (after Phase 7): 295 of 295 pass, so Phase 6 is covered by it.
- Not verified: a restart with active spectators, a database outage during `spectate.join`, many spectators on Render Free, a real Android client.
- Limits: no delay for spectated moves (a spectating friend could relay moves to a player); a block created after joining does not remove a spectator; `spectate.over` can carry `ratingChange: null` (REST has it); a player who reconnects learns the spectator count only from the next `spectate.count`; history has no filters; saved analyses cannot be shared or renamed.
- Docs: API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (25b), PROJECT_CONTEXT, .env.example.

## Phase 5 (implemented and verified, 39 room tests)
- One document per room in `analysis_rooms` (members, invitations, variation tree, annotations, shared position); every write is guarded by a `rev` number (D-035, D-038). Private, invite-only, friends only (D-036). Roles host / editor / viewer (D-037).
- WebSocket `room.*` events (create, invite, cancel, decline, join, leave, kick, role, host transfer, close, move add, node delete, position set, annotation set, chat send) and pushes; REST `GET /api/v1/rooms` and `GET /api/v1/rooms/:id` (members only).
- Presence and room chat are RAM only and per connection: a socket must send `room.join` (also after reconnect or restart) or editing and chat return `ROOM_NOT_JOINED` (D-039). Room chat is never stored (tested).
- Lifecycle (D-040): closed by host, when the last member leaves, or by the idle sweeper (24 h, nobody joined); deleted 7 days after closing by a TTL index.
- Tests: `tests/rooms.test.js` (20), `tests/room-analysis.test.js` (19), helpers `tests/roomHelpers.js`.
- Docs: WEBSOCKET, API, DATABASE, FAILURE_RECOVERY_GUIDE (20b, 25), PROJECT_CONTEXT, .env.example (ROOM_* variables).
- Not verified: real Atlas, a database outage during a room edit, a real Android client using the rev / re-join procedure.
- Limits: the hosted-room limit (3) is a count check, so two simultaneous creations can exceed it by one; the server never checks that room moves are legal (D-021); a room holds at most 300 moves.

## Implemented and verified (local MongoDB v5.0.9, not yet on Atlas)
- Foundation: config validation, pino logger with redaction, Express app (helmet, CORS allowlist, rate limits, 100 kb body limit, JSON errors), `/health/live`, `/health/ready`, `/health/storage`.
- Auth REST: register, login, refresh (rotation, reuse detection), logout, logout-all; bcryptjs; DB-checked sessions so revocation is immediate.
- WebSocket `/ws`: envelope validation, size limit, authentication, token-expiry handling, close codes 4001-4004, heartbeat, per-socket rate limiter for chat and voice events (D-030).
- Users (profile, settings), friends (requests, block, report, pagination), presence (multi-device, privacy setting).
- Phase 3: games (one conditional update per move, moveId idempotency, clocks, 5 s checkpoints, timeouts, resign, draws, PGN, Elo), matchmaking queue and friend invitations, reconnect grace, pause/resume, recovery after crash and DB reconnect, device takeover.
- Phase 4: personal messages (REST history + WebSocket send, friends only, idempotent by `clientMessageId`, read/unread), temporary match chat (RAM relay, never stored), voice signaling (offer/answer/ICE relay for live games, glare protection, clean-up on disconnect or game end), STUN/TURN provider module (TURN optional), storage monitor.
- Collections with indexes: users, sessions, user_settings, friendships, blocks, reports, games, game_events, matchmaking_queue, invitations, conversations, personal_messages, analysis_rooms.
- Docs: API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE and PROJECT_CONTEXT cover Phases 1-4.

## Not implemented
- Email verification and password reset (needs Resend key).
- Phase 8 admin controls, hardening and backups. (Phase 7, economy, notifications and tournaments, is implemented: see "Phase 7 progress".)
- No git repository yet, nothing deployed.

## Not verified (be honest about these)
- Real voice: no real audio, real NAT traversal or real TURN account has been tested; only the signaling logic and credential generation (tests).
- Behaviour on a real Atlas cluster (everything ran on local MongoDB), including a full cluster refusing writes (assumed `TEMPORARILY_UNAVAILABLE`) and Atlas storage accounting versus the `dbStats` estimate.
- Graceful shutdown (SIGTERM) with a live game; dead-socket heartbeat in a long run; MongoDB going down mid-request on Atlas.
- Real Render behaviour (sleep, cold start, restarts).

## Known issues / limits
- Refresh-token reuse grace window is 10 s: a client that loses a refresh response must log in again (D-016).
- Auth rate limit is per IP (20 per 15 min); players behind one NAT share it.
- Presence, the socket registry, match chat, voice call records and the live-player cache live in RAM: after a restart clients reconnect (by design; the database is the source of truth for games and personal messages).
- Per-socket rate limits exist for chat, voice, game and matchmaking events (D-030, D-058). There is no per-user (all devices) or per-IP WebSocket connection limit yet (decide in 8g).
- Process guards exist (D-057, 8a): an uncaught exception exits the process so Render restarts it, and boot recovery restores live games. A real SIGTERM test cannot run on Windows (every signal is a hard kill); verify on Render or WSL.
- Personal messages are never deleted; games are kept but their move list is removed after 90 days (D-060, the PGN stays). Atlas M0 has 512 MB (the monitor warns at 80% and 90%). A removed move list can only be restored from a backup.
- Personal message summary (last message, unread) is updated after the message is saved and is not a transaction: it can be briefly stale after a crash and is repaired on retry (D-031).
- `render.yaml` has no TURN variables on purpose (TURN is optional); add them in the Render dashboard when a TURN account exists.

## Deployment state
Not deployed. No git repository initialised. `.env` exists locally (git-ignored).

## Exact next task
0. (Phase 8, current) 8a to 8e are done (8a without a SIGTERM test) and 8f part 1 is done. Next: the OWNER creates the Atlas cluster, `.env`, the private GitHub repository (first commit) and the Render service following SERVER_SETUP_GUIDE sections 3, 5 and 6; then run the section 6 checks on the real address and record the results here (8f part 2). Then 8g: walk all 25 scenarios in FAILURE_RECOVERY_GUIDE, then ONE full `npm test` run with output to a file (expected about 295 + 7 + 7 + 2 + 12 + 12 + 15 tests; count what it really prints). `PROJECT_CONTEXT.md` was restored by the owner and now has a Phase 8 summary (8a to 8e): keep it updated. The items below are older notes from before Phase 8.
1. DONE 2026-11-19: the FULL `npm test` was run after Phase 7: **295 tests, 295 pass, 0 fail**. The first full run had 2 failures (`tournaments.test.js`: "a game result that arrives while the sweeper is down..." and, as a cascade, "many sweepers at once..."); both passed when the file was run alone. Cause (a hypothesis that the second full run supports, not a proven one): `tournaments.stop()` did not wait for a sweeper tick that was already running, so under full-suite load that tick could record results after "stop". Fix: `stop()` is now `async` and waits up to 5 s for an in-flight tick; the test awaits it. If a tournament test is flaky again, look at timing under load first.
2. Then start Phase 8: admin controls (including a way to grant coins and to repair a stuck tournament), per-socket rate limits for game and matchmaking events, global `uncaughtException` / `unhandledRejection` handlers, retention and cleanup of old games, MongoDB backup and restore procedure, final failure testing, deployment preparation (git repository, Render, Atlas). Present the Phase 8 plan to the owner before building.
OWNER DECISION 2026-11-19: Google Play purchases and Firebase phone push are NOT being integrated for now. Keep `PURCHASE_VERIFIER=disabled` and do not build push delivery; the questions D-049 (premium one-time or subscription), D-050 (Google verifier) and D-051 (push) are parked, not forgotten. Still open for the owner: the real commentator pack names and prices (`catalogue.js`), and a Resend key for e-mail verification and password reset (not built yet).
Optional earlier: Resend key for email verification and password reset; Metered TURN account to test real voice; delete nothing else.
