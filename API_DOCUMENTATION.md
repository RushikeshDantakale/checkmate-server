# API_DOCUMENTATION

Base URL: `http://localhost:3000` locally, `https://<name>.onrender.com` when deployed. All bodies are JSON. Only implemented endpoints are listed.

## Conventions
- Authenticated requests send `Authorization: Bearer <accessToken>`.
- Errors: `{ "error": { "code": "UPPER_SNAKE", "message": "..." } }`.
- Common codes: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `TOKEN_EXPIRED` 401 (call refresh, then retry), `SESSION_REVOKED` 401 (log in again), `ACCOUNT_SUSPENDED` / `ACCOUNT_BANNED` 403, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `INTERNAL_ERROR` 500.
- Access tokens last 15 minutes by default. Refresh tokens last 30 days and rotate on every use: always store the newest one.
- Ids are 24-character hex strings; a malformed id returns 400.
- Pagination (list endpoints): `?limit=1..100` (default 50) and `?cursor=<id>`. Response: `{ "items": [...], "nextCursor": "<id>" | null }`. Pass `nextCursor` as `cursor` for the next page. Newest first.
- Global rate limit 300 requests/minute/IP.

## Health
- `GET /health/live` -> 200 `{ "status": "ok", "uptimeSeconds": 12 }`
- `GET /health/ready` -> 200 `{ "status": "ready", "db": "up" }` or 503 `{ "status": "not_ready", "db": "down" }`
- `GET /health/storage` (D-028) -> always 200 `{ "level": "unknown" | "ok" | "warning" | "critical", "percentUsed": 41.3 | null, "limitMb": 512, "checkedAt": "<ISO date>" | null }`. `warning` from 80%, `critical` from 90% of `STORAGE_LIMIT_MB`. It never returns 503, so uptime pingers do not fail because storage is high: read `level`. The value is measured every hour (`STORAGE_CHECK_INTERVAL_MS`) and once when the database connects; if nothing was measured yet and the database is up, the request measures once. `unknown` means no reading yet (database down since boot). No authentication, no secrets in the response.

## Auth (`/api/v1/auth`) — limited to 20 requests per 15 minutes per IP
### POST /register
Body: `{ "email", "username" (3-20 letters/digits/_), "password" (8-72 chars), "deviceName"? }`
201: `{ "user", "accessToken", "refreshToken", "tokenType": "Bearer", "expiresIn": 900, "sessionId" }`
Errors: 400 `VALIDATION_ERROR`, 409 `EMAIL_TAKEN`, 409 `USERNAME_TAKEN`.
### POST /login
Body: `{ "identifier": "<email or username>", "password", "deviceName"? }` -> 200 same shape. Errors: 401 `INVALID_CREDENTIALS` (identical for wrong password and unknown user), 403 `ACCOUNT_SUSPENDED|ACCOUNT_BANNED`.
### POST /refresh
Body: `{ "refreshToken" }` -> 200 same shape with a NEW refreshToken (old one stops working). 401 `INVALID_REFRESH_TOKEN` -> log in again. Replaying an already-rotated token revokes that session. Do not blindly retry a refresh whose response was lost; if the retry fails, log in again.
### POST /logout (auth) -> 204. Revokes the session and closes its WebSocket (code 4004).
### POST /logout-all (auth) -> 204. Revokes all sessions of the user and closes all their sockets.

## Users (`/api/v1/users`) — all need auth
- `GET /me` -> `{ "user": { id, email, username, displayName, bio, avatarId, status, role, emailVerified, createdAt } }`
- `PATCH /me` body: any of `{ displayName (<=30), bio (<=160), avatarId (<=50) }`; `null` clears a field. Unknown fields (e.g. `role`) -> 400.
- `GET /me/settings` -> `{ "settings": { boardTheme, pieceSet, soundEnabled, premove, autoQueen, showOnlineStatus, friendRequestsFrom ("everyone"|"nobody"), language } }` (defaults when never changed)
- `PATCH /me/settings` partial body of the same keys -> updated settings. Unknown keys / wrong types -> 400.
- `GET /search?q=<2-20 chars>` -> `{ "items": [{id, username, displayName, avatarId}] }` username prefix match, max 10; excludes yourself and blocked users (either direction).
- `GET /:id` -> `{ "user": { id, username, displayName, bio, avatarId, createdAt, online } }`; 404 if missing, inactive, or blocked either way.

## Friends (`/api/v1/friends`) — all need auth
- `GET /` -> paginated `{ items: [{ friendshipId, user, online, since }] }`
- `GET /requests?direction=incoming|outgoing` (default incoming) -> paginated `{ items: [{ requestId, user, createdAt }] }`
- `POST /requests` body `{ "username" }` -> 201 `{ friendshipId, status: "pending", autoAccepted: false, user }`; if that user already asked you, 200 with `autoAccepted: true, status: "accepted"`. Errors: 400 `CANNOT_ADD_SELF`; 404 `USER_NOT_FOUND` (also returned when THEY blocked you); 403 `USER_BLOCKED` (you blocked them); 403 `REQUESTS_DISABLED`; 409 `ALREADY_FRIENDS`; 409 `REQUEST_EXISTS`.
- `POST /requests/:id/accept` (recipient only) -> 200; `POST /requests/:id/reject` (recipient only) -> 204; `DELETE /requests/:id` (requester cancels) -> 204. Others get 404 `REQUEST_NOT_FOUND`.
- `DELETE /:userId` unfriend -> 204, 404 `NOT_FRIENDS`.
- `GET /blocks` -> paginated `{ items: [{ user, blockedAt }] }`; `POST /blocks` body `{ "userId" }` -> 204 (idempotent; also removes any friendship/request; 400 `CANNOT_BLOCK_SELF`); `DELETE /blocks/:userId` -> 204.
- Real-time: friend requests and acceptances are also pushed over WebSocket (see WEBSOCKET_DOCUMENTATION.md).

## Reports (`/api/v1/reports`) — auth
- `POST /` body `{ "userId", "reason": "cheating|abuse|harassment|spam|other", "details"? (<=500) }` -> 201 `{ reportId }`. 400 `CANNOT_REPORT_SELF`, 404 `USER_NOT_FOUND`, 409 `ALREADY_REPORTED` (an open report from you already exists).

Not yet implemented: email verification, password reset. Administrator endpoints are documented under "Administration" below.

## Games (`/api/v1/games`) - all need auth
Matchmaking and playing happen over WebSocket (see WEBSOCKET_DOCUMENTATION). REST is for reading and for resynchronising after a reconnect.

### GET / (history, D-043)
The caller's finished or aborted games, newest first, as short summaries (no moves, no PGN). Query: `limit` 1-50 (default 20), `cursor` (the `nextCursor` of the previous page). Reply `{ items: [{ id, white: {id, username, rating}, black: {...}, yourColor: "w"|"b", rated, timeControl: {id, baseMs, incrementMs}, status: "finished"|"aborted", result, resultReason, moveCount, ratingChange: {white, black}|null, startedAt, endedAt }], nextCursor }`. Live games are not listed (use `/active`). `400 VALIDATION_ERROR` for a bad `limit` or `cursor`.

### GET /live (games I may watch, D-041)
Live games (active or paused) of my friends that I am allowed to watch: not my own games, no block with either player. Reply `{ items: [{ id, white, black, rated, timeControl, status, moveCount, spectators, startedAt }] }` (newest first, at most 20). Watching itself is the WebSocket event `spectate.join`.

### GET /active
The caller's live game (status `active`, `paused_disconnect` or `paused_server_recovery`) or `{ "game": null }`. Includes the move list. Call after (re)connecting.

### GET /:id
A game the caller played (any status), or a COMPLETED game (`finished` or `aborted`) that the caller may watch (D-041: friend of at least one player, no block with either player), with `moves` (`[{ seq, uci, san, at }]`) and `pgn` when finished. Everyone else, unknown ids, and non-players asking for a game that is still live all get `404 GAME_NOT_FOUND` (private games are never revealed). Non-players watch live games over WebSocket (`spectate.join`). **Old games (D-060):** 90 days after a finished or aborted game ended, the server removes its move list to save space. The reply then has `moves: []` and `movesCompacted: true`, while `pgn`, `result`, players and `ratingChange` are unchanged. The client must rebuild the moves from `pgn` when `movesCompacted` is true (the field is absent otherwise). Games younger than 90 days, and live games, always have `moves`.

### GET /:id/pgn
`{ "pgn": "..." }`. `409 GAME_NOT_FINISHED` while the game is still live. Same access rule as `GET /:id`; 404 otherwise.

Game object: `{ id, white: {id, username, rating}, black: {...}, variant: "standard", rated, timeControl: {id, baseMs, incrementMs}, status, result, resultReason, fen, turn: "w"|"b", seq, clocks: {whiteMs, blackMs, running}, drawOffer: {by}|null, ratingChange: {white, black}|null, serverTime, moves?, pgn?, movesCompacted? }` (`movesCompacted` is only present, as `true`, for old games whose move list was removed). `status`: `active`, `paused_disconnect`, `paused_server_recovery`, `finished`, `aborted`. `503 TEMPORARILY_UNAVAILABLE` means the database is down; retry.

Route order matters for clients only in one way: `/active` and `/live` are fixed paths, everything else is a game id.

## Conversations: permanent personal messages (`/api/v1/conversations`) - all need auth
Messages are SENT over WebSocket (`message.send`, see WEBSOCKET_DOCUMENTATION); REST is for reading history and unread state. Friends only (D-029). Messages are kept indefinitely (D-028). Message text is plain text: render it as text, never as HTML.

### GET /
My conversations, most recent first. Query: `limit` (1-100, default 30), `cursor` (opaque, from `nextCursor`). Only conversations that contain at least one message are listed.
`200 { "items": [ { "id", "user": { "id", "username", "displayName", "avatarId" }, "lastMessage": { "id", "senderId", "preview" (80 chars), "at" } | null, "unread": number, "lastMessageAt" } ], "nextCursor": string | null }`

### GET /with/:userId
My conversation with one user. `200 { "conversation": {...same shape as an item above...} | null }` (`null` if we never wrote to each other). Use it to open a chat from a friend's profile.

### GET /:id/messages
A page of messages, NEWEST first. Query: `limit` (1-100, default 50), `cursor` (message id from `nextCursor`; omit for the newest page).
`200 { "items": [ { "id", "conversationId", "senderId", "recipientId", "body", "createdAt", "readAt": date | null } ], "nextCursor": string | null }`
`404 CONVERSATION_NOT_FOUND` for a conversation that does not exist AND for one that belongs to other users (same answer, so ids cannot be probed).

### POST /:id/read
Marks everything addressed to me in this conversation as read. `200 { "conversationId", "markedRead": number }`. The other user gets `message.seen` over WebSocket; my other devices get it too so they clear their badge. Same 404 rule.

History stays readable by both users after an unfriend or block; only sending stops (`NOT_FRIENDS`). Match chat and room chat are NOT available here: they are temporary and never stored.

## Analysis rooms (`/api/v1/rooms`) - all need auth
Rooms are created, joined and edited over WebSocket (`room.*`, see WEBSOCKET_DOCUMENTATION, Phase 5). REST is read-only: use it to list rooms and to open one without joining.

### GET /
Rooms I am a member of or invited to (open and recently closed), most recently active first, at most 50. The analysis itself is not included.
`200 { "items": [ { "id", "name", "status": "open"|"closed", "hostId", "memberCount", "maxMembers": 10, "role": "host"|"editor"|"viewer"|null, "invited": boolean, "rev", "lastActivityAt" } ] }`. `role` is `null` and `invited` is `true` for a pending invitation.

### GET /:id
The full state of one room: `200 { "room": { id, name, status, hostId, defaultRole, maxMembers, rev, startFen, position: {nodeId, fen}, members, invited, nodes, annotations, createdAt, lastActivityAt }, "online": [userId] }`. `online` lists members currently joined over WebSocket (always empty for a closed room). Members only (an invited user joins with `room.join` to see the room): everyone else, and every unknown id, gets the same `404 ROOM_NOT_FOUND`; a malformed id gets `400`. Closed rooms stay readable by their members for 7 days (`ROOM_RETENTION_DAYS`), then they are deleted.

## Saved analysis (`/api/v1/analysis-sessions`) - all need auth (D-044)
A saved analysis is a COPY of an analysis room taken at one moment, kept until its owner deletes it (rooms are deleted 7 days after closing). Only the owner can read or delete it. A saved analysis that is not yours and an unknown id both answer `404 ANALYSIS_SESSION_NOT_FOUND`.

### POST /
Body `{ "roomId": "<id>", "title"?: "<1-60 characters>" }`. The caller must be a CURRENT member of the room (host, editor or viewer; open or closed but not yet deleted); otherwise `404 ROOM_NOT_FOUND` (same answer for unknown rooms). The default title is the room name. Reply `201 { session, duplicate: false }`. Saving the same room at the same revision again (a retry, or two simultaneous requests) returns `200 { session, duplicate: true }` with the stored copy. `409 ANALYSIS_SESSION_LIMIT` when the user already has `ANALYSIS_SESSIONS_MAX` (50) copies: delete one first. `400 VALIDATION_ERROR` for a bad id or an empty title.

### GET /
Query `limit` 1-50 (default 20), `cursor`. Newest first. Reply `{ items: [{ id, title, sourceRoomId, sourceRev, moveCount, createdAt }], nextCursor }` (no tree).

### GET /:id
`{ session: { id, title, sourceRoomId, sourceRev, moveCount, createdAt, startFen, position: { nodeId, fen }, nodes: [{ id, parentId, uci, san, fen, by, at }], annotations: { "<nodeId>|root": { comment, nags, arrows, squares, by, at } } } }`. Same shapes as `room.state`.

### DELETE /:id
`{ id, deleted: true }`.

## Wallet, store and purchases (`/api/v1/wallet`, `/api/v1/store`, `/api/v1/purchases`) - all need auth (D-046 to D-050)
Coins are a CLOSED economy (D-047): the server never gives coins for playing. Sources: the daily reward, coin bundles bought with real money, tournament prizes (Phase 7c). Sinks: commentator packs, tournament entry fees. The app never sends a price or an amount: the server decides from its own catalogue. Names and prices in the catalogue are PLACEHOLDERS until the real packs exist.

### GET /api/v1/wallet
`200 { "coins": number, "entitlements": { "premium": boolean, "packs": [packId] }, "dailyReward": { "amount": number, "available": boolean, "nextAt": ISO date } }`. `nextAt` is the start of the next UTC day.

### GET /api/v1/wallet/transactions
My coin history, newest first, only completed entries, only mine. Query: `limit` (1-100, default 30), `cursor` (from `nextCursor`).
`200 { "items": [ { "id", "delta": signed number, "reason", "ref": string | null, "balanceAfter": number, "at" } ], "nextCursor": string | null }`. Reasons so far: `daily_reward`, `pack_purchase`, `coin_bundle`, `admin_grant`, `tournament_entry`, `tournament_refund`, `tournament_prize`. `400 VALIDATION_ERROR` for a bad cursor or limit.

### POST /api/v1/wallet/daily-reward
No body. Once per UTC day. `200 { "claimed": number, "coins": number, "nextAt" }`. `409 DAILY_ALREADY_CLAIMED` (the message contains the time of the next reward) or `409 DAILY_REWARD_DISABLED` when the server has `DAILY_REWARD_COINS=0`. Five simultaneous requests pay exactly once.

### GET /api/v1/store/catalogue
`200 { "coinBundles": [ { "id", "coins", "playProductId" } ], "packs": [ { "id", "name", "coinPrice": number | null, "playProductId": string | null } ], "premium": { "id", "name", "playProductId" } }`. `playProductId` is what the app asks Google Play for.

### POST /api/v1/store/packs/:packId/buy
Buys a commentator pack with coins. No body: the price comes from the server catalogue. `200 { "coins", "entitlements", "dailyReward", "duplicate": boolean }`. Safe to retry: a retry of a purchase that already went through answers `200` with `duplicate: true` and charges nothing more.
Errors: `404 PACK_NOT_FOUND`, `400 NOT_FOR_COINS` (the pack is sold for real money only), `409 ALREADY_OWNED`, `402 INSUFFICIENT_COINS` (nothing was changed), `503 TEMPORARILY_UNAVAILABLE` (retry the same request).

### POST /api/v1/purchases
Redeems a Google Play purchase. Body `{ "productId", "purchaseToken" }` and nothing else: the server asks the store what was really paid. `201` the first time, `200` with `duplicate: true` for a retry.
`{ "purchase": { "id", "productId", "kind": "coin_bundle"|"pack"|"premium", "state": "verified"|"granted"|"acknowledged", "orderId", "at" }, "coins", "entitlements", "finalized": boolean, "duplicate": boolean }`.
`finalized: false` means the user ALREADY has the item but the store has not been told yet (it was unreachable); the server retries by itself. The app does not need to do anything.
One store purchase can be redeemed once, by one user. Errors:
- `400 VALIDATION_ERROR`, `400 UNKNOWN_PRODUCT`, `400 PURCHASE_INVALID` (the store does not know it), `400 PURCHASE_CANCELLED` (cancelled or refunded)
- `409 PURCHASE_PENDING` (payment not finished: try again later), `409 PURCHASE_ALREADY_REDEEMED` (by another user), `409 PURCHASE_PRODUCT_MISMATCH` (same token, different product)
- `403 PURCHASE_WRONG_ACCOUNT` (made for another account)
- `503 PURCHASE_VERIFICATION_UNAVAILABLE` (could not reach the store: retry the SAME request; nothing was granted)
- `503 PURCHASES_NOT_CONFIGURED` (no verifier is set up on this server; the default until a Google Play account exists)

### GET /api/v1/purchases
My purchases, newest first. Query `limit` (1-50, default 20), `cursor`. `200 { "items": [ { "id", "productId", "kind", "state", "orderId", "at" } ], "nextCursor" }`. The purchase token is never returned.

Verification status: tested with the built-in fake verifier only (`PURCHASE_VERIFIER=fake`, refused in production). The `google` verifier has NOT been run against real Google Play and has no automated test yet (see CURRENT_STATUS).

## Notifications (`/api/v1/notifications`) - all need auth (Phase 7b, D-051)
Stored for 30 days, then deleted automatically. A user who was offline finds them here when the app next opens. Live delivery to connected devices is the WebSocket event `notification.new` (see WEBSOCKET_DOCUMENTATION). Phone push while the app is closed (Firebase) is NOT included.

Notification object: `{ id, type, data, readAt, createdAt }`. `type` is one of `system`, `reward`, `tournament_starting`, `tournament_round`, `tournament_game_ready`, `tournament_finished`, `tournament_cancelled`, `tournament_prize`. `data` is a small object whose fields depend on the type (ids, names, amounts). Internal fields are never returned. The `tournament_*` types are created by the tournament sweeper (Phase 7c): `tournament_starting`, `tournament_round`, `tournament_game_ready`, `tournament_finished`, `tournament_cancelled`, `tournament_prize`. Their `data` fields are listed in the Tournaments section.

### GET /
My notifications, newest first. Query: `limit` (1-100, default 30), `cursor` (the `nextCursor` of the previous page), `unread=true` (only unread ones). `200 { "items": [ ... ], "nextCursor": "<id>" | null, "unread": <number of unread notifications in total> }`.

### GET /unread-count
`200 { "unread": 3 }`. For the badge on the app icon.

### POST /:id/read
Marks one notification read. Safe to repeat: the first read time is kept. `200 { "id", "readAt", "unread" }`. Someone else's notification and an unknown id both answer `404 NOTIFICATION_NOT_FOUND` (private notifications are never revealed). Your other connected devices receive `notification.read`.

### POST /read-all
Marks all of my notifications read. `200 { "markedRead": 4, "unread": 0 }`. A second call returns `markedRead: 0` and pushes nothing.

Errors: `400 VALIDATION_ERROR` (bad `limit`, `cursor` or `unread`, or a malformed id), `401`, `404 NOTIFICATION_NOT_FOUND`, `503 TEMPORARILY_UNAVAILABLE` (database problem: retry).

## Tournaments (`/api/v1/tournaments`) - all need auth (Phase 7c, D-052 to D-055)
Swiss tournaments for 4 to 32 players. Everything runs on the server: the app only lists, joins and then reacts to notifications (`tournament_game_ready` gives the `gameId` to open with the normal game events). Pairing is a simple greedy algorithm, not the full FIDE Dutch system. All state is stored in MongoDB, so a server restart does not lose a tournament.

Rules in short:
- Scoring: win 1, draw 0.5, loss 0, bye 1, win by forfeit 1 (the absent player 0), a game the server aborted (fewer than 2 moves) 0.5 each. Tie-breaks: Buchholz (sum of the scores of the opponents you actually played), then rating when you joined, then join order.
- Rounds: chosen at creation (1 to `maxPlayers - 1`), or `ceil(log2(players))` fixed when the tournament starts. An odd number of players gives one bye per round to the lowest-ranked player who has not had one.
- Start: at `startsAt` (between 60 seconds and 7 days after creation). With fewer than 4 players it is cancelled and everyone is refunded.
- Show-up: both players must be online and not in another game. A player who is not there 3 minutes after the round started loses the pairing (both absent: both score 0). The next round starts 30 seconds after the last result of a round.
- Money (coins, closed economy): the entry fee (0 to 500) is charged when you join and pooled. When the tournament finishes the pool is paid out: 1 player gets all; 2 to 7 players pay 60/40; 8 or more pay 50/30/20; the rounding remainder goes to first place. A cancelled tournament refunds every fee. Leaving BEFORE the start refunds the fee; leaving is final (you cannot join that tournament again). After the start the fee is not refunded.
- Tournament games use the tournament's time control and `rated` flag. A game is created by the server; the app does not create it.

Tournament summary: `{ id, name, host: { id, username }, status: "registration"|"running"|"finished"|"cancelled", timeControl, rated, entryFee, maxPlayers, playerCount, startsAt, rounds: number | null, currentRound, joined: boolean, createdAt }`.

### POST /
Body: `{ "name": 3-40 characters, "timeControl": "<preset id, e.g. 5+0>", "rated": boolean (default true), "entryFee": 0-500 (default 0), "maxPlayers": 4-32 (default 16), "rounds": 1-31 (optional), "startsAt": ISO 8601 date with offset }`. `201 { "tournament": summary }`.
Errors: `400 VALIDATION_ERROR`, `400 INVALID_TIME_CONTROL`, `400 INVALID_ROUNDS` (more than `maxPlayers - 1`), `400 INVALID_START_TIME` (sooner than 60 s or later than 7 days), `403 ACCOUNT_NOT_ACTIVE`, `409 TOURNAMENT_LIMIT` (you already host the maximum number of open tournaments: 1 by default; cancelling or finishing one frees the slot).

### GET /
Newest first. Query: `status` (`registration`, `running`, `finished`, `cancelled`), `mine=true` (tournaments I host or joined: my history), `limit` (1-50, default 20), `cursor`. `200 { "items": [ summary ], "nextCursor": string | null }`.

### GET /:id
One tournament in full. `200 { "tournament": { ...summary, "entrants": [ { id, username, rating } ], "startedAt", "finishedAt", "cancelReason", "nextRoundAt", "standings": [ { place, userId, username, score, buchholz, rating, played } ], "rounds": [ { number, startedAt, doneAt, pairings: [ { key, kind: "game"|"bye", status: "pending"|"playing"|"done", white: { id, username }, black: { id, username } | null, gameId: string | null, whiteScore, blackScore, reason: "result"|"aborted"|"forfeit"|"double_forfeit"|"bye" | null, startBy } ] } ], "prizes": [ { place, userId, username, amount } ] } }`. `standings` and `rounds` exist only once the tournament is `running` or `finished`; standings are recomputed from the stored pairings on every read. Visible to every logged-in user.

### POST /:id/join
No body. `200 { "joined": true, "duplicate": boolean }`. Safe to retry: joining twice charges once and answers `duplicate: true`.
Errors: `404 TOURNAMENT_NOT_FOUND`, `409 TOURNAMENT_CLOSED` (not in registration, or the start time has passed), `409 TOURNAMENT_ALREADY_LEFT`, `409 TOURNAMENT_FULL` (you are refunded at once), `402 INSUFFICIENT_COINS` (nothing was charged or stored), `403 ACCOUNT_NOT_ACTIVE`, `409 CONFLICT` (registration changed at the same moment: retry), `503 TEMPORARILY_UNAVAILABLE` (database problem: retry the same request; nothing is charged twice).

### POST /:id/leave
No body. Before the start only. `200 { "left": true, "duplicate": boolean }`. The refund is paid exactly once; if it fails at this moment the server retries by itself.
Errors: `404 TOURNAMENT_NOT_FOUND`, `404 NOT_JOINED`, `409 TOURNAMENT_STARTED` (the fee is not refunded after the start).

### POST /:id/cancel
Host only, before the start. Everyone who joined is refunded and notified (`tournament_cancelled`). `200 { "cancelled": true, "duplicate": boolean }`.
Errors: `403 NOT_HOST`, `404 TOURNAMENT_NOT_FOUND`, `409 TOURNAMENT_STARTED`.

### Notifications created by tournaments
Each one is stored once per user (fixed key), so a restart never sends it twice. `data` fields:
- `tournament_starting`: `{ tournamentId, name, players, rounds, timeControl, entryFee }`
- `tournament_round`: `{ tournamentId, name, round, rounds, color: "w"|"b", opponent: { id, username } | null, bye: boolean, startBy }`. Be online and free by `startBy` or you forfeit the pairing.
- `tournament_game_ready`: `{ tournamentId, name, round, gameId, color }`. Open this game with the normal game events.
- `tournament_finished`: `{ tournamentId, name, place, score, prize }`
- `tournament_prize`: `{ tournamentId, name, place, amount }`
- `tournament_cancelled`: `{ tournamentId, name, reason: "host_cancelled"|"not_enough_players", entryFee }`

## Administration (`/api/v1/admin`) - admin only (Phase 8c, D-059)
Every route needs a valid access token AND a user whose `role` is `admin` (checked in the database on every request). Others get `403 ADMIN_ONLY`. The role can only be changed with the local script `scripts/set-role.js` (see SERVER_SETUP_GUIDE.md), never over REST. Lists use `limit` (1-100) and `cursor` (the `nextCursor` of the previous page). Every state-changing call is written to the audit log first. Retrying any of them is safe.
- `GET /users?search=<prefix>&status=active|suspended|banned&limit&cursor` -> `{ items: [user], nextCursor }`. The admin user view includes e-mail, status, role, reason, rating and last login.
- `GET /users/:id` -> `{ user, coins, entitlements, reports: { against, made }, recentAdminActions }`.
- `POST /users/:id/status` body `{ "status": "active|suspended|banned", "reason": "3-300 chars" }` -> `{ user, duplicate }`. All sessions of that user are revoked and live sockets closed with code 4004 at once. Restoring to `active` lets the user log in again.
- `POST /users/:id/coins` body `{ "amount": -100000..100000 but not 0, "reason", "requestId": "8-64 chars, chosen by you and reused on retry" }` -> `{ userId, balance, transactionId, duplicate }`. A revoke larger than the balance gives `INSUFFICIENT_COINS`. Reusing a requestId for a different action gives `409 REQUEST_ID_CONFLICT`.
- `POST /users/:id/entitlements` body `{ "premium"?: bool, "grantPacks"?: [packId], "revokePacks"?: [packId], "reason" }` -> `{ userId, entitlements }`. Unknown pack: `UNKNOWN_PACK`.
- `GET /reports?status=open|reviewed|dismissed|all&limit&cursor` -> `{ items: [report with reporter, reported, totalReports], nextCursor }`.
- `POST /reports/:id/resolve` body `{ "status": "reviewed|dismissed", "note"? }` -> `{ report, duplicate }`. Resolving again the same way is a no-op; the other way gives `409 REPORT_ALREADY_RESOLVED`.
- `POST /tournaments/:id/repair` runs the same idempotent steps as the background sweeper for one tournament (advance rounds, refunds, prizes).
- `POST /tournaments/:id/cancel` body `{ "reason" }` cancels a tournament in registration or running, refunds every joined player; games already in progress are not aborted, they just stop counting.
- `GET /audit?adminId&targetId&action&limit&cursor` -> `{ items: [ { id, adminId, action, targetType, targetId, details, status: started|done|failed, errorCode, createdAt, finishedAt } ], nextCursor }` (read only).
- `GET /retention` (D-060, read only, changes nothing) -> what the old-data cleanup WOULD change right now: `{ dryRun: true, startedAt, finishedAt, rules: [ { id: "game_moves"|"resolved_reports"|"old_sessions", description, mode: "update"|"delete"|"ttl", matched, changed: 0 } ], storage: { level, percentUsed, limitMb, checkedAt } }`. `matched` is how many documents the rule currently applies to; `old_sessions` is only counted (a MongoDB TTL index deletes them). Gives `409 RETENTION_BUSY` while a cleanup run is in progress (try again in a moment).
Errors: `ADMIN_ONLY` (403), `CANNOT_TARGET_SELF` (409; status, coins and entitlements of your own account), `CANNOT_TARGET_ADMIN` (403; status of another admin), `USER_NOT_FOUND`, `REPORT_NOT_FOUND`, `REPORT_ALREADY_RESOLVED`, `REQUEST_ID_CONFLICT`, `UNKNOWN_PACK`, `INSUFFICIENT_COINS`, `RETENTION_BUSY` (409), `VALIDATION_ERROR`, `TEMPORARILY_UNAVAILABLE` (database problem, retry; if the audit row could not be written the action was NOT performed).
