# CHANGELOG

## 2026-11-18 — Phase 1 foundation
- Added project skeleton (Express 5, Mongoose 9, ws, zod, pino, helmet).
- Added `/health/live`, `/health/ready`.
- Added WebSocket server with hello, ping/pong, heartbeat and payload limits.
- Added `render.yaml`, `.env.example`, `.gitignore`.
- Added 7 foundation tests.
- Added handoff docs: PROJECT_CONTEXT, CURRENT_STATUS, TODO, DECISIONS, SERVER_SETUP_GUIDE.
- No database schema changes yet; no REST API beyond health.

## 2026-11-18 - Phase 2 auth core
- Added users and sessions collections (unique email, unique usernameLower, TTL on sessions).
- Added REST: POST /api/v1/auth/register, login, refresh, logout, logout-all; GET /api/v1/users/me.
- Added requireAuth middleware with DB-checked sessions, bcryptjs hashing, JWT access tokens, rotating refresh tokens.
- Config: new env vars JWT_ACCESS_SECRET, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS (JWT_ACCESS_SECRET is now required outside tests).
- Mongoose autoIndex disabled; indexes created by ensureIndexes() after connect.
- Added 13 auth tests (20 total passing). Added API_DOCUMENTATION.md and DATABASE_DOCUMENTATION.md.

## 2026-11-18 - Phase 2 completed (except email flows)
- WebSocket authentication, token-expiry handling, close codes 4001-4004, socket registry, live sockets closed on logout/logout-all.
- Users: PATCH /me, GET /users/:id, GET /users/search, GET/PATCH /me/settings.
- Friends: requests, accept/reject/cancel, list, unfriend, block/unblock, reports (POST /api/v1/reports), cursor pagination.
- Presence with multi-device handling and showOnlineStatus privacy; WebSocket pushes friend.request, friend.accepted, presence.update.
- Database: new collections user_settings, friendships, blocks, reports; users gained displayName, bio, avatarId, lastSeenAt.
- Config: WS_AUTH_TIMEOUT_MS, WS_REAUTH_GRACE_MS, WS_TOKEN_WARNING_MS.
- Tests: 50 passing. npm test now runs files one at a time. Added WEBSOCKET_DOCUMENTATION.md, rewrote API_DOCUMENTATION.md.

## 2026-11-18 - Phase 3 verified, three bugs fixed
- Phase 3 code (games, matchmaking, recovery, ratings) was already present but undocumented; documented in CURRENT_STATUS.
- Fix: pipeline-style updates (rating bump, clock checkpoint) now pass updatePipeline: true (required by Mongoose 9); previously ratings were never applied and checkpoints failed silently.
- Fix: game.move.ack now always includes duplicate (false for a newly applied move).
- Tests: 96 passing.

## 2026-11-18 - Phase 3 documentation and recovery fix
- Fix: a game already paused at boot now gets its hold timer again (monitor.recover + service.pausedGames); before, it stayed paused forever.
- Fix: render.yaml lists JWT_ACCESS_SECRET.
- Tests: new game-checkpoint.test.js and game-recovery-paused.test.js. 99 passing.
- Docs: Phase 3 added to WEBSOCKET_DOCUMENTATION, API_DOCUMENTATION, DATABASE_DOCUMENTATION, PROJECT_CONTEXT; new FAILURE_RECOVERY_GUIDE with the manual kill-the-server test.

## 2026-11-18 - Storage monitor (D-028)
- Added `GET /health/storage` and an hourly database-size check (WARNING at 80%, ERROR at 90% of `STORAGE_LIMIT_MB`). Read-only. 6 tests.

## 2026-11-18/19 - Phase 4 implemented and tested (messaging, match chat, voice signaling)
- Database: new collections `conversations` and `personal_messages` (indexes in DATABASE_DOCUMENTATION). No collection for match chat (by design).
- REST: `GET /api/v1/conversations`, `GET /conversations/with/:userId`, `GET /conversations/:id/messages`, `POST /conversations/:id/read`.
- WebSocket: `message.send` / `message.read` (pushes `message.new`, `message.seen`); `chat.match.send` (push `chat.match.message`); `voice.config`, `voice.offer`, `voice.answer`, `voice.ice`, `voice.end`, `voice.failed` (pushes `voice.offer`, `voice.answer`, `voice.ice`, `voice.ended`).
- New per-socket rate limiter (D-030), STUN/TURN provider module (D-027), idempotent personal messages by `clientMessageId` (D-031).
- Config: `ICE_STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `TURN_SECRET`, `TURN_CREDENTIAL_TTL_SECONDS`, `VOICE_RING_TIMEOUT_MS` (now in `.env.example`).
- Tests: messaging 12, match chat 13, voice 20, TURN credentials 4. Whole suite: 154 passing (single clean run, 2026-11-19). The flaky checkpoint test was already made tolerant.
- Docs: Phase 4 added to API, WEBSOCKET and DATABASE documentation and to FAILURE_RECOVERY_GUIDE (scenarios 20 and 21). Decision D-034 recorded.

## 2026-11-18 - Manual kill test script
- Added scripts/manual-kill-test.js: starts the server, plays a game, hard-kills the server, restarts it and checks recovery, clocks and move idempotency. Guide updated to use it.

- Owner ran scripts/manual-kill-test.js on 2026-11-18: all checks passed (boot recovery, clocks not charged for downtime, resume when both back, duplicate move ack).

## 2026-11-18 - Storage monitor and /health/storage (D-028)
- Wired src/modules/health/storage.monitor.js into the server (started with the other timers, stopped when the WebSocket server closes, first reading right after the database connects).
- New endpoint GET /health/storage: always 200, body { level, percentUsed, limitMb, checkedAt }, level is unknown | ok | warning (>= 80%) | critical (>= 90%). Measures once on demand if nothing was measured yet.
- Config/env: STORAGE_LIMIT_MB (default 512), STORAGE_CHECK_INTERVAL_MS (default 3600000); added to .env.example.
- Docs: API_DOCUMENTATION (Health), FAILURE_RECOVERY_GUIDE scenario 16.
- Tests: new tests/storage.test.js (6 tests, database size stubbed). Full suite: 105 run, 104 pass, 1 flaky (game-checkpoint.test.js, see CURRENT_STATUS).

## 2026-11-19 - Phase 5 analysis rooms verified and completed (D-035 to D-040)
- Database: new collection `analysis_rooms` (one document per room: members, invitations, variation nodes, annotations, shared position cursor, `rev`). Indexes on members, invitations, host, idle sweeper, and a TTL index on `expireAt` (closed rooms are deleted 7 days later). No separate room_members / variations / annotations collections (D-035).
- API: REST `GET /api/v1/rooms` (my rooms and invitations) and `GET /api/v1/rooms/:id` (members only, 404 for everyone else).
- WebSocket: new `room.*` events (create, invite, invite.cancel, decline, join, leave, kick, role.set, host.transfer, close, move.add, node.delete, position.set, annotation.set, chat.send) and pushes (`room.state`, `room.member.*`, `room.move.added`, `room.position`, `room.node.deleted`, `room.annotation`, `room.chat.message`, `room.presence`, `room.closed`, ...). Per-event rate limits (D-030 style). Every stored change carries `rev`.
- Behaviour: editing and chat need a joined socket (`ROOM_NOT_JOINED`); room chat is never stored; unknown, foreign and removed rooms all answer `ROOM_NOT_FOUND`; idle rooms (24 h, nobody joined) are closed by a sweeper.
- Config/env: ROOM_MAX_NODES, ROOM_MAX_HOSTED, ROOM_IDLE_CLOSE_MS, ROOM_RETENTION_DAYS, ROOM_SWEEP_INTERVAL_MS (added to .env.example).
- Tests: new tests/room-analysis.test.js (19 tests); tests/rooms.test.js (20) had one wrong revision expectation corrected (test bug) and a no-op leftover line removed. Full suite: 193 run, 193 pass.
- Docs: WEBSOCKET_DOCUMENTATION (Phase 5), API_DOCUMENTATION, DATABASE_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (20b, 25), PROJECT_CONTEXT (Phase 5 summary, collections list), TODO, CURRENT_STATUS.
- Not verified: real Atlas, database outage during a room edit, a real Android client.

## 2026-11-19 - Phase 6: spectators, game history, saved analysis (D-041 to D-044)
- Decisions D-041 to D-044 recorded (friends-only spectating, no delay, limit 20; history and viewer access; saved analysis copies).
- Spectators: new `src/modules/spectators/spectators.service.js` and WebSocket events `spectate.join`, `spectate.leave`; pushes `spectate.update`, `spectate.over`, `spectate.count`. RAM subscriptions per connection, fed by `game.state.changed` and cleaned up on `socket.closed`. Started in `server.js`.
- Game history: `GET /api/v1/games` (my finished games, cursor pagination), `GET /api/v1/games/live` (friends' live games I may watch); `GET /api/v1/games/:id` and `/pgn` now also allow a friend of a player for COMPLETED games (new `history.service.js`). Players keep full access; everyone else still gets 404.
- Saved analysis: new collection `analysis_sessions`, REST `/api/v1/analysis-sessions` (save a copy of a room, list, get, delete; cap 50 per user; retry-safe per room revision).
- Config and env: `SPECTATOR_MAX_PER_GAME` (20), `ANALYSIS_SESSIONS_MAX` (50) added to `.env.example`.
- Removed the unused placeholder `src/modules/games/chessEngine.js`.
- Tests: new `tests/spectators.test.js` (9), `tests/game-history.test.js` (3), `tests/analysis-sessions.test.js` (6): all pass. `tests/games.test.js` (18) re-run because `games.routes.js` changed: pass. A full `npm test` has NOT been run since these were added.
- Docs: API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (25b), PROJECT_CONTEXT.

## 2026-11-19 - Phase 7a economy and purchases: audited, tested and documented
- The 7a code (wallets, ledger, daily reward, packs, entitlements, purchases with pluggable verifier, reconciler) existed from an earlier session without status, tests for purchases or documentation. This session audited it, ran `tests/economy.test.js` (21 pass), added `tests/purchases.test.js` (14 pass) and documented it.
- API changes (documented): `GET /api/v1/wallet`, `GET /api/v1/wallet/transactions`, `POST /api/v1/wallet/daily-reward`, `GET /api/v1/store/catalogue`, `POST /api/v1/store/packs/:packId/buy`, `POST /api/v1/purchases`, `GET /api/v1/purchases`.
- Database changes (documented): collections `wallets`, `transactions`, `entitlements`, `purchases` with their indexes.
- Added env variables to `.env.example`: DAILY_REWARD_COINS, WALLET_RECONCILE_INTERVAL_MS, WALLET_PENDING_AGE_MS, PURCHASE_VERIFIER, GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.
- Docs: API_DOCUMENTATION, DATABASE_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (scenario 25c), CURRENT_STATUS, TODO.
- Fixed `npm test`: it now runs `tests/**/*.test.js` only. Before, `node --test` also picked up `scripts/manual-kill-test.js` (its name ends in `-test.js`), which fails when the normal server is running on port 3000.
- Not changed: no game, auth, messaging or other earlier-phase code was touched in this step.

## 2026-11-19 - Phase 7b notifications verified and documented (D-051)
- Verified code written by an earlier session: model `notifications`, `notifications.service`, REST `/api/v1/notifications`, live push `notification.new` / `notification.read`. Ran only `tests/notifications.test.js`: 16 pass.
- API changes (documented): `GET /api/v1/notifications`, `GET /api/v1/notifications/unread-count`, `POST /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all`.
- WebSocket changes (documented): server pushes `notification.new` and `notification.read`.
- Database changes (documented): collection `notifications` (TTL 30 days, partial unique index on `{ userId, key }`).
- Docs: API_DOCUMENTATION (also removed notifications from the "not yet implemented" line), WEBSOCKET_DOCUMENTATION, DATABASE_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (25d), PROJECT_CONTEXT, CURRENT_STATUS, TODO. No source code was changed in this step.

## 2026-11-19 - Phase 7c tournaments verified and documented (D-052 to D-056)
- Verified code written by an earlier session: models `tournaments` and `tournament_players`, `tournaments.logic` (Swiss pairing, standings, prizes), `tournaments.service` (registration, fees and refunds, sweeper, forfeits, rounds, prizes), REST `/api/v1/tournaments`. Ran only `tests/tournaments-logic.test.js` and `tests/tournaments.test.js`: 33 pass (14 + 19).
- API changes (documented): `GET/POST /api/v1/tournaments`, `GET /:id`, `POST /:id/join`, `/leave`, `/cancel`. New ledger reasons `tournament_entry`, `tournament_refund`, `tournament_prize`. Notification types `tournament_*` are now created.
- WebSocket changes (documented): no new events; tournaments reuse `notification.new` and `game.started` (game view carries `tournamentId`).
- Database changes (documented): collections `tournaments`, `tournament_players`; unique partial index on `games` `{tournament.tournamentId, tournament.key}`.
- Config: `TOURNAMENT_SHOW_UP_MS`, `TOURNAMENT_ROUND_BREAK_MS`, `TOURNAMENT_MIN_LEAD_MS`, `TOURNAMENT_MAX_LEAD_DAYS`, `TOURNAMENT_MAX_HOSTED` (added to `.env.example`).
- Docs: API, WEBSOCKET, DATABASE, FAILURE_RECOVERY_GUIDE (scenario 19), PROJECT_CONTEXT, CURRENT_STATUS, TODO, DECISIONS (D-056). No source code was changed in this step.

## 2026-11-19 - Phase 8a process guards
- Added src/utils/processGuards.js (D-057): uncaughtException exits with code 1 after a log flush; unhandled rejections are logged and counted, more than 5 in 60 s exits. Installed by main() in src/server.js only.
- Added tests/process-guards.test.js (7 tests, run alone: 7 pass).
- No API, WebSocket or database changes.

## 2026-11-19 - Phase 8b abuse limits
- Per-socket rate limits on game.* and queue.* / invite.* events (D-058). Clients can now receive RATE_LIMITED for these events.
- Hosted-room limit race fixed in rooms.service.js create(): simultaneous creations can no longer exceed it (D-058).
- Added tests/ws-rate-limits.test.js (7) and tests/rooms-limit-race.test.js (2).
- No database changes.

## 2026-11-19 - Phase 8c admin module
- Added /api/v1/admin (users, status, coins, entitlements, reports, tournament repair and cancel, audit log), D-059.
- Added collection admin_actions, user status fields, report review fields, transaction reasons admin_grant and admin_revoke.
- Added scripts/set-role.js (the only way to change a role).
- Added tournaments.repair and tournaments.adminCancel in the tournaments service.
- Added tests/admin.test.js (12). Docs: API_DOCUMENTATION, DATABASE_DOCUMENTATION, SERVER_SETUP_GUIDE.

## 2026-11-19 - Phase 8d retention and cleanup (D-060)
- Added `src/modules/retention` (service, monitor, startup index migration), `scripts/retention.js` (dry run by default, `--apply`) and `GET /api/v1/admin/retention` (read only). The job runs 60 s after start and then every 6 h, in batches, never in tests.
- Database changes: finished or aborted games older than 90 days (and with a PGN) lose `moves` and get `movesCompactedAt`; reviewed or dismissed reports older than 365 days are deleted; the TTL on `sessions.expiresAt` is now 30 days after expiry (existing databases are migrated at startup). `game_events` already had a 90-day TTL.
- API change: `GET /api/v1/games/:id` returns `moves: []` and `movesCompacted: true` for trimmed games; the Android client must rebuild them from `pgn`. New admin error `RETENTION_BUSY` (409).
- Config: `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_INTERVAL_MS`, `RETENTION_FIRST_RUN_MS`, `RETENTION_GAME_MOVES_DAYS` (min 7), `RETENTION_REPORTS_DAYS` (min 30), `RETENTION_BATCH_SIZE`.
- Tests: `tests/retention.test.js` (12 pass). Because shared code changed, these files were re-run one at a time and pass: auth 13, foundation 7, users 4, games 18, game-history 3, game-recovery 7, admin 12, storage 6, ws-auth 9, spectators 9, analysis-sessions 6 (output kept in `batch-run.log`, since deleted).
- Docs written in a later session (the earlier TODO line that said they were done was premature): DATABASE_DOCUMENTATION, API_DOCUMENTATION, FAILURE_RECOVERY_GUIDE (scenario 16), SERVER_SETUP_GUIDE, `.env.example`.
- Also in this session: `{ new: true }` (deprecated in Mongoose 9) replaced by `returnDocument: 'after'` in four services; game-checkpoint test made tolerant of timing.

## 2026-11-19 - Phase 8e backup and restore (D-061)
- Added `src/modules/backup/backup.service.js`, `scripts/backup.js` and `scripts/restore.js`. Backup writes `backups/backup-<UTC time>/` (one `.ndjson` per collection and `manifest.json` with counts, SHA-256 and index definitions, written last). Restore is a dry run by default; `--apply` restores, refuses non-empty collections unless `--replace`, `--only a,b` selects collections; a damaged, truncated or unfinished backup is refused before anything changes. No database or API changes.
- Review fix in this session: the service and its test used `require('bson')`, which is not in package.json (it only worked because Mongoose installs it); they now use `mongoose.mongo.BSON`.
- Tests: `tests/backup-restore.test.js` (15 pass, run alone). The scripts were run end to end on the local development database (read-only backup, dry run, refused `--apply`).
- Docs: SERVER_SETUP_GUIDE section 7 rewritten as a beginner procedure, FAILURE_RECOVERY_GUIDE scenario 25e (and 17), DATABASE_DOCUMENTATION, PROJECT_CONTEXT (Phase 8 summary, file restored by the owner).
## 2026-11-19 - Phase 8f deployment prep (part 1, no owner account needed)
- `git init` run locally; nothing committed. Checked what git would track: no `.env`, `backups/` or `node_modules/`, no real secrets. `.gitignore` now ignores `/.*.txt` (leftover test-output files in the project root).
- `.env.example`: added GAME_RECONNECT_GRACE_MS, GAME_PAUSED_HOLD_MS, GAME_CHECKPOINT_INTERVAL_MS, INVITE_TTL_MS, MATCH_TICK_MS (they were read by the config but undocumented).
- `render.yaml`: `JWT_ACCESS_SECRET` is generated by Render (`generateValue: true`) instead of asked for.
- SERVER_SETUP_GUIDE sections 2, 4, 5, 6 rewritten (the old text said the tests need no database and never mentioned JWT_ACCESS_SECRET for Render). Covers all 26 points of the original brief. Commands verified locally.
- No source code changes in this step.