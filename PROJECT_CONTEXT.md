# PROJECT_CONTEXT

Permanent technical context. Update when architecture or conventions change.

## Purpose
Backend for "Checkmate", an online chess app. The Android app is developed separately in `D:\AndroidProjects\checkmate` and is out of scope; this project only exposes REST and WebSocket contracts. Stockfish runs on the Android device, not here.

## Constraints
- About 40 users initially; target cost is zero.
- Hosting: GitHub + Render Free (onrender.com subdomain) + MongoDB Atlas M0.
- Free tiers give no uptime guarantee. Render Free sleeps after a period of inactivity (cold start takes a while), restarts can happen at any time, and all WebSocket connections drop on sleep or restart. Atlas M0 has small storage and connection limits. Verify current limits on the providers' pricing pages before relying on any number.
- Must be migratable to paid hosting without a rewrite: configuration only through environment variables; providers (email, TURN, DB) sit behind interfaces.
- Audio never passes through this server (WebRTC peer-to-peer, TURN relay only when needed).

## Technology (installed versions, 2026-11-18)
Node.js >= 20 (developed on v22.18.0), JavaScript (CommonJS). express ^5.3.0, mongoose ^9.12.2, ws ^8.23.0, zod ^4.6.7, pino ^10.4.0, helmet ^8.3.0, cors ^2.8.6, express-rate-limit ^8.7.4, dotenv ^18.0.10. Tests: built-in `node:test`.

## Architecture
Modular monolith. Layers: `config` (the only place that reads process.env) -> `database` (Mongoose models and repositories) -> `modules/*` (business logic per feature) -> `websocket` (event routing) and `app.js` (HTTP). Modules must not reach into each other's repositories; they call each other's services.

```
src/
  config/        env validation (zod)
  database/      connection.js (retry, ping), models/, repositories/ (later)
  middleware/    errorHandler (notFound, errorHandler), auth etc. later
  modules/       health (done); auth, users, friends, matchmaking, games, messaging,
                 analysis-rooms, spectators, tournaments, economy, purchases,
                 signaling, notifications (stored 30 days + live push, D-051)
  services/      shared infra services (email, TURN credentials) later
  utils/         logger (pino, redacts secrets), errors (AppError)
  websocket/     index.js (server, heartbeat, envelope validation); handlers/ later
  server.js      createServer() + main() with graceful shutdown
tests/           node:test files
```

## Conventions
- All env vars are validated in `src/config/index.js`; add new ones there and in `.env.example`.
- HTTP errors: `{ "error": { "code": "UPPER_SNAKE", "message": "..." } }`. Throw `AppError(status, code, message)`.
- WebSocket envelope (client and server): `{ "id"?: string<=64, "type": string<=64, "payload"?: any }`. Errors: `{ "type": "error", "id"?, "payload": { "code", "message" } }`. Server replies echo the request `id`.
- Never log passwords, tokens or connection strings. Use the shared logger only (it redacts known fields).
- Never acknowledge a move before it is durably persisted (D-009, D-011).
- Temporary match chat and analysis-room chat are never stored in MongoDB.

## Current WebSocket protocol (protocol version 1)
Endpoint `/ws`. Max payload `WS_MAX_PAYLOAD_BYTES` (default 16384); larger frames close the socket with code 1009. Binary frames close with 1003. On connect the server sends `server.hello { protocol, connectionId, heartbeatMs, serverTime }`. Client `ping` -> server `pong { serverTime }`. Protocol-level ping every `WS_HEARTBEAT_INTERVAL_MS`; sockets that miss one are terminated. Authentication, games, matchmaking, messaging, match chat and voice signaling are implemented: the full event list is in WEBSOCKET_DOCUMENTATION (this paragraph only describes the connection basics).

## Planned database collections
users, sessions, user_settings, friendships, blocks, reports, games, game_events, matchmaking_queue, invitations, conversations, personal_messages, analysis_rooms, analysis_sessions (saved COPIES of a room's analysis, Phase 6) (all implemented). Planned: tournaments, tournament_players, transactions, purchases, notifications. By design there are NO separate room_members, variations or annotations collections (they are embedded in analysis_rooms, D-035) and no persistent match_messages or room_messages collections.

## Security principles
Argon2id/bcrypt password hashing, short-lived access tokens with rotating refresh tokens stored hashed, all input validated with Zod, rate limiting, payload limits, helmet headers, CORS allowlist, secrets only in environment variables, no `.env` in git, logs redacted.

## Hosting
Render Free web service, `npm ci` build, `npm start`, health check `/health/live`. Blueprint in `render.yaml`. Render provides the PORT variable.

## Phase 3 summary (added 2026-11-18)
- `src/modules/games`: `games.service.js` (moves, results, pause/resume, recovery, ratings), `games.monitor.js` (flag, grace and hold timers, 5 s clock checkpoints, recovery on boot and on MongoDB reconnect; timers are in RAM but rebuilt from the database), `games.routes.js` (REST reads), `timeControl.js`, `pgn.js`. The server does not validate chess legality (D-021); the unused `chessEngine.js` placeholder was deleted on 2026-11-19.
- `src/modules/matchmaking`: DB-backed queue and friend invitations behind an in-process lock.
- WebSocket handlers: `game.handler.js`, `matchmaking.handler.js`. Events are in WEBSOCKET_DOCUMENTATION.
- Rules to keep: a move is acknowledged only after the conditional update succeeds; the client resends with the same `moveId`; outage time is never charged; one live game per user; newest device controls the game.
- Config: `GAME_RECONNECT_GRACE_MS` (60000), `GAME_PAUSED_HOLD_MS` (300000), `GAME_CHECKPOINT_INTERVAL_MS` (5000), `INVITE_TTL_MS` (60000), `MATCH_TICK_MS` (2000).
- Mongoose 9: pipeline-style updates need `{ updatePipeline: true }`.

## Phase 4 summary (added 2026-11-19)
- `src/modules/messaging`: `messaging.service.js` (permanent personal messages: friends only, idempotent by `clientMessageId`, summary updated after the message is saved), `matchChat.service.js` (temporary match chat: RAM relay, never stored), `conversations.routes.js` (REST history and read state).
- `src/modules/signaling/signaling.service.js` (WebRTC offer/answer/ICE relay between the two players of a live game; one RAM record per call; audio never touches the server) and `src/services/iceServers.js` (STUN always, TURN only if configured, static or time-limited credentials).
- `src/modules/games/livePlayers.js`: small RAM cache of "who plays which live game", fed by `game.state.changed` events, used to authorize chat and voice without a database read per message.
- WebSocket: `src/websocket/handlers/chat.handler.js`, `voice.handler.js`, per-socket token-bucket limiter `rateLimiter.js` used through `defineHandler(schema, fn, { rateLimit })`.
- Rules to keep: messaging is friends only and a block is never revealed (D-029, D-034); match chat and room chat are never written to MongoDB; personal messages are never deleted automatically (D-028, storage monitor instead); signaling state is RAM only and the client restarts a call after any reconnect.
- Storage monitor: `src/modules/health/storage.monitor.js`, `GET /health/storage`.
- Config: `ICE_STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`/`TURN_CREDENTIAL` or `TURN_SECRET`, `TURN_CREDENTIAL_TTL_SECONDS`, `VOICE_RING_TIMEOUT_MS` (45000), `STORAGE_LIMIT_MB`, `STORAGE_CHECK_INTERVAL_MS`.

## Phase 5 summary (added 2026-11-19)
- `src/modules/analysis-rooms`: `rooms.service.js` (rooms, invitations, membership, roles, shared analysis, room chat, idle sweeper), `rooms.presence.js` (RAM map of which sockets joined which room, broadcast helper), `rooms.routes.js` (REST reads: list and one room). Model `src/database/models/analysisRoom.model.js`. WebSocket handler `src/websocket/handlers/room.handler.js` (`room.*` events, rate limits per event).
- A room is ONE document (D-035). Every write is `updateOne({ _id, rev })` with `$inc rev`, retried up to 5 times (`mutate()` in the service; the plan function must be pure) (D-038). Every stored change is pushed to joined sockets with the new `rev`; clients ignore old revs and re-join on a gap.
- Rules to keep: private, invite-only, friends only (D-036); roles host/editor/viewer (D-037); editing and chat require a joined socket (`ROOM_NOT_JOINED`), joining is per connection (D-039); room chat and presence never stored; unknown, foreign and removed rooms all answer `ROOM_NOT_FOUND`; closed rooms are deleted 7 days later by a TTL index (D-040); server does not check chess legality (D-021).
- Config: `ROOM_MAX_NODES` (300), `ROOM_MAX_HOSTED` (3), `ROOM_IDLE_CLOSE_MS` (24 h), `ROOM_RETENTION_DAYS` (7), `ROOM_SWEEP_INTERVAL_MS` (60 s). The member limit (10) is fixed in code.
- Tests: `tests/rooms.test.js` (membership, invitations, limit, roles, closing, presence, authorization), `tests/room-analysis.test.js` (moves, variations, annotations, chat never stored, concurrency, reconnect, restart, sweeper), helpers in `tests/roomHelpers.js`.

## Phase 6 summary (added 2026-11-19)
- `src/modules/spectators/spectators.service.js`: RAM map of which sockets watch which live game (per connection, like rooms), `mayWatch` (friend of a player, no block either way; D-041), live-friends list, and the pushes `spectate.update` / `spectate.over` / `spectate.count` driven by the existing `game.state.changed` and `socket.closed` events (D-042). WebSocket handler `src/websocket/handlers/spectate.handler.js` (`spectate.join`, `spectate.leave`). Started and stopped in `server.js` with the other timers.
- `src/modules/games/history.service.js` (history list and `getGameForViewer`) and `games.routes.js` (`GET /api/v1/games`, `/live`, `/:id`, `/:id/pgn`) (D-043).
- `src/modules/analysis-sessions` (`sessions.service.js`, `sessions.routes.js`, mounted at `/api/v1/analysis-sessions`) and model `analysisSession.model.js` (D-044).
- Rules to keep: spectators never change a game (only players can); a spectator sees a move only after it is stored (the event fires after persistence); unknown, foreign and not-allowed games all answer `GAME_NOT_FOUND`; the spectator count is distinct users, capped by `SPECTATOR_MAX_PER_GAME`; saved analyses are copies owned by one user.
- Config: `SPECTATOR_MAX_PER_GAME` (20), `ANALYSIS_SESSIONS_MAX` (50).
- Tests: `tests/spectators.test.js` (9), `tests/game-history.test.js` (3), `tests/analysis-sessions.test.js` (6).

## Phase 7 summary (added 2026-11-19)
- Economy (7a): `src/modules/economy` (wallet ledger with unique keys, daily reward, packs bought with coins, entitlements), `src/modules/purchases` (pluggable verifier: `disabled`, `fake`, `google`). Coins are a closed economy (D-047).
- Notifications (7b): `src/modules/notifications`. `notify()` never throws, `create()` does. A `key` makes a repeated event return the stored notification.
- Tournaments (7c): `src/modules/tournaments` (`tournaments.logic.js` pure rules, `tournaments.service.js` registration and the sweeper, `tournaments.routes.js`, mounted at `/api/v1/tournaments`), models `tournament.model.js` and `tournamentPlayer.model.js`. Started and stopped in `server.js` (`tournaments.start()` / `stop()`).
- Rules to keep: ALL tournament state is in MongoDB, RAM holds only a timer that calls `tick()`; every step is a conditional update or an idempotent call (ledger keys `tournament:<id>:entry|refund|prize:<user>`, notification keys, unique game per pairing key); standings are recomputed, never stored; games for pairings are created by the server through `games.createGame({ tournament })` and results arrive through the `game.state.changed` event plus the sweeper; tournaments have no WebSocket events of their own.
- Config: `TOURNAMENT_SHOW_UP_MS` (180000), `TOURNAMENT_ROUND_BREAK_MS` (30000), `TOURNAMENT_MIN_LEAD_MS` (60000), `TOURNAMENT_MAX_LEAD_DAYS` (7), `TOURNAMENT_MAX_HOSTED` (1); max entry fee 500 is a constant in `config.tournament`.
- Tests: `tests/economy.test.js` (21), `purchases.test.js` (14), `notifications.test.js` (16), `tournaments-logic.test.js` (14), `tournaments.test.js` (19).
## Phase 8 summary (added 2026-11-19)
- 8a `src/utils/processGuards.js` (D-057): an uncaught exception is logged and the process exits with code 1 so Render restarts it and boot recovery restores live games; unhandled rejections are logged and counted (more than 5 in 60 s exits). Installed by `main()` in `src/server.js` only.
- 8b (D-058): per-socket token-bucket limits on `game.*`, `queue.*` and `invite.*` events (same mechanism as chat and voice, `defineHandler(..., { rateLimit })`, answer `RATE_LIMITED`); the hosted-room limit race is fixed in `rooms.service.js`.
- 8c `src/modules/admin` (`admin.routes.js`, `admin.service.js`, `admin.audit.js`) and `src/middleware/requireAdmin.js` (D-059): REST only under `/api/v1/admin`; the role is read from the database on every request; every action is written to `admin_actions`; `scripts/set-role.js` is the only way to change a role.
- 8d `src/modules/retention` (service, monitor, startup index migration), `scripts/retention.js` (dry run by default, `--apply`), `GET /api/v1/admin/retention` (D-060): finished or aborted games older than `RETENTION_GAME_MOVES_DAYS` (90) with a PGN lose their `moves` (`movesCompacted: true` in REST); resolved reports and old sessions are removed. Config `RETENTION_*`.
- 8e `src/modules/backup/backup.service.js`, `scripts/backup.js`, `scripts/restore.js` (D-061): the owner backs up the whole database to `backups/backup-<UTC time>/` (one `.ndjson` file per collection plus `manifest.json` with checksums, written last); restore is a dry run unless `--apply`, refuses non-empty collections unless `--replace`, and checks every file before touching anything. EJSON comes from `mongoose.mongo.BSON` (do not `require('bson')`: it is not a declared dependency). Beginner steps are in SERVER_SETUP_GUIDE section 7.
- Rules to keep: never run `node --test` with several files without `--test-concurrency=1` (they share the database `checkmate_test`); backups hold personal data and are never committed or encrypted; run the retention job with `--apply` only after a dry run AND a backup.
- Tests: `process-guards` (7), `ws-rate-limits` (7), `rooms-limit-race` (2), `admin` (12), `retention` (12), `backup-restore` (15).