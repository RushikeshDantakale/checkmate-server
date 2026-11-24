# DATABASE_DOCUMENTATION

Database: MongoDB (local `checkmate` in development, `checkmate_test` for tests, Atlas later). Mongoose models live in `src/database/models`. `bufferCommands` is off (queries fail fast when the DB is down) and `autoIndex` is off; `ensureIndexes()` runs after each successful connect. Only implemented collections are listed.

## users
Fields: `email` (unique, lower-cased), `username`, `usernameLower` (unique; case-insensitive uniqueness), `passwordHash` (bcrypt, `select:false`), `status` (`active|suspended|banned`), `role` (`user|admin`), `emailVerified`, `lastLoginAt`, `createdAt`, `updatedAt`.
Indexes: unique `email`, unique `usernameLower`.

## sessions
One per logged-in device. Fields: `userId`, `refreshTokenHash` (SHA-256 of the refresh token; the token itself is never stored), `previousRefreshTokenHash` (for reuse detection), `deviceName`, `userAgent`, `lastUsedAt`, `expiresAt`, `revokedAt`, `revokedReason` (`logout|logout_all|refresh_token_reuse|account_blocked`), timestamps.
Indexes: `userId`, unique `refreshTokenHash`, `previousRefreshTokenHash`, TTL on `expiresAt` with `expireAfterSeconds` = 30 days (D-060): a session is deleted 30 days AFTER it expires (before 8d: at expiry). The server already refuses expired and revoked sessions, so the extra days only keep a short trail. Databases created before 8d get the new TTL value from a startup migration (`src/modules/retention/retention.indexes.js`, runs before the indexes are created).

## Retention and recovery
What is removed automatically, and when (D-060, D-028, D-040, D-051):

| Data | Rule | Done by |
|---|---|---|
| `sessions` | deleted 30 days after expiry | TTL index |
| `game_events` | deleted 90 days after `at` | TTL index |
| `notifications` | deleted 30 days after creation | TTL index |
| closed `analysis_rooms` | deleted 7 days after closing | TTL index |
| `invitations` | deleted 1 hour after expiry | TTL index |
| `matchmaking_queue` | deleted at `expiresAt` | TTL index |
| `games` (finished or aborted, older than 90 days, with a PGN) | the `moves` list is emptied, `movesCompactedAt` is set; players, result, PGN, rating change and `seq` stay | retention job |
| `reports` (`reviewed` or `dismissed`, older than 365 days by `updatedAt`) | deleted; open reports are never deleted | retention job |

Kept forever and never touched by any cleanup: `users`, `wallets`, `transactions`, `purchases`, `entitlements`, `tournaments`, `tournament_players`, `admin_actions` (audit log), `conversations`, `personal_messages`, `friendships`, `blocks`, `user_settings`, `analysis_sessions`, and the games themselves (only their move list is trimmed).

The retention job (`src/modules/retention`) runs 60 seconds after start and then every 6 hours, in batches, and only while the server is awake (on Render Free it simply runs when the server is up). Every change re-checks its own filter, so a run that is interrupted or run twice does the same thing. Settings and the dry run are described in SERVER_SETUP_GUIDE.md. A removed move list can only be restored from a backup.

Backups (D-061): Atlas M0 has no scheduled backups. `node scripts/backup.js` writes `backups/backup-<UTC time>/` with one `<collection>.ndjson` file per collection (MongoDB Extended JSON, one document per line, so ids and dates keep their type) and `manifest.json` (database name, per collection: file, document count, bytes, SHA-256, index definitions), written LAST so an unfinished backup has no manifest and is refused. `node scripts/restore.js <folder>` is a dry run; `--apply` restores, refuses non-empty collections unless `--replace`, `--only a,b` selects collections. Indexes are not restored from the files: the server recreates them at startup. The backup is not a point-in-time snapshot. Files contain personal data and are never encrypted; `backups/` is git-ignored. Beginner steps: SERVER_SETUP_GUIDE.md section 7.

Planned collections are listed in PROJECT_CONTEXT.md.

## user_settings
One per user (unique userId). preferences: boardTheme, pieceSet, soundEnabled, premove, autoQueen, showOnlineStatus, friendRequestsFrom (everyone|nobody), language. Created on first change; defaults are applied when missing.

## friendships
One per user pair: requester, recipient, pairKey (unique, sorted ids), status (pending|accepted), respondedAt. Indexes: unique pairKey; (recipient,status,_id desc); (requester,status,_id desc).

## blocks
blocker, blocked. Unique (blocker,blocked); index on blocked.

## reports
reporter, reported, reason (cheating|abuse|harassment|spam|other), details, status (open|reviewed|dismissed). Indexes: (status,createdAt desc), reported. Retention (D-060): `reviewed` and `dismissed` reports are deleted 365 days after `updatedAt` by the retention job; `open` reports are never deleted.

## users (additional fields since Phase 2 start)
displayName (<=30), bio (<=160), avatarId, lastSeenAt.

---

# Phase 3 collections

## games
One document per game holds everything needed to restore it (D-011): `whiteId`, `blackId`, denormalised names and ratings, `variant` (`standard`|`dice`|`chess960`, D-062), `startFen` (the position the game began from: the shuffled one for chess960; absent on games made before variants, read as the normal start), `rated`, `timeControl {id, baseMs, incrementMs}`, `status`, `result`, `resultReason`, `fen`, `turn`, `seq` (last confirmed ply), `moves[] {seq, uci, san, moveId, by, at, whiteMs, blackMs}`, `clocks {whiteMs, blackMs, turnStartedAt}`, `drawOffer {by, atSeq}`, `pgn`, `ratingApplied`, `ratingChange {white, black}`, `startedAt`, `endedAt`, `pausedAt`, timestamps.
- Clock model: `clocks.whiteMs/blackMs` are the remaining times AT `clocks.turnStartedAt`. While active, the side to move has `stored - (now - turnStartedAt)`. While paused or finished `turnStartedAt` is null and the values are frozen.
- Every state change is one conditional `updateOne` (status, seq, turn and "moveId not yet stored" must match). Checkpoints (every 5 s) rebase the running clock with a pipeline update (`updatePipeline: true` is required by Mongoose 9).
- Indexes: `{whiteId, status}`, `{blackId, status}`, `{status}`, `{whiteId, _id:-1}`, `{blackId, _id:-1}` (history, Phase 6).
- Size: about 40 moves is roughly 8 KB; a 300-move game stays far below the 16 MB limit.
- Retention (D-060): games are kept, but 90 days after `endedAt` a finished or aborted game that has a stored `pgn` loses its `moves` list and gets `movesCompactedAt` (Date). Players, names, ratings, result, `resultReason`, `pgn`, `ratingChange` and `seq` stay. Games without a PGN are never trimmed. REST then returns `moves: []` and `movesCompacted: true` (the client rebuilds the game from the PGN). Live games are never touched. Only the retention job writes `movesCompactedAt`.
- Tournament link (Phase 7c): a game created for a tournament pairing has `tournament { tournamentId, key }` (`key` such as `r2p0` = round 2, pairing 0). Unique partial index on `{tournament.tournamentId, tournament.key}`: even if a crash makes the sweeper try twice, the database allows only ONE game per pairing.
- Recovery: on boot and on a MongoDB reconnect, every `active` game becomes `paused_server_recovery` with its last snapshot (no downtime charged).

## game_events
Append-only audit trail (`gameId`, `type`, `userId`, `data`, `at`): started, paused, resumed, disconnected, reconnected, resign, draw_offered, recovered_after_outage, finished. Best effort: never blocks play. TTL 90 days on `at`. Index `{gameId, _id}`.

## matchmaking_queue
One entry per waiting user (unique `userId`): `timeControlId`, `rated`, `variant` (D-062; missing on old entries = standard), `rating`, `joinedAt`, `expiresAt`. TTL index removes entries after 10 minutes, so a crash can never leave someone queued. Index `{timeControlId, rated, variant, joinedAt}` (the older index `{timeControlId, rated, joinedAt}` may still exist on databases created before variants; it is harmless and can be dropped).

## invitations
`fromId`, `toId`, `timeControlId`, `rated`, `variant` (D-062), `status` (pending, accepted, declined, cancelled), `gameId`, `expiresAt` (60 s). Documents are deleted 1 hour after expiry (TTL). Indexes `{toId, status, expiresAt}`, `{fromId, status}`.

## users (Phase 3 addition)
`rating` (Elo, default 1200, floor 100, K=32, applied once per rated finished game, D-022).
Known limit: the rating claim (`ratingApplied`) and the two user updates are separate writes; a crash between them loses that one rating change.

# Phase 4 collections
Match chat and room chat have NO collection: they are temporary and relayed in RAM only (brief section 4).

## conversations
One document per pair of users. `pairKey` (unique, the two ids sorted and joined with `:`), `members` (the two user ids, sorted as strings), `unread` (`[Number]`, `unread[i]` belongs to `members[i]`), `lastMessage { messageId, senderId, preview, at }`, `lastMessageAt`, timestamps.
Index: `{ members: 1, lastMessageAt: -1, _id: -1 }` ("my conversations, newest first"); unique `pairKey`.
The summary (`lastMessage`, `unread`) is updated AFTER the message is saved (D-031). Not a transaction: after a crash between the two writes the summary can be briefly stale and is repaired when the client retries the same `clientMessageId`; a message itself is never lost or duplicated.

## personal_messages
`conversationId`, `senderId`, `recipientId`, `clientMessageId` (8-64), `body` (max 2000), `readAt` (null until read), `createdAt`.
Indexes: unique `{ senderId, clientMessageId }` (turns a retry into "return the stored message"); `{ conversationId, _id: -1 }` (history pages); `{ conversationId, recipientId, readAt }` (mark as read).
Retention: kept indefinitely (D-028). The storage monitor (`/health/storage`) warns at 80% and 90% of `STORAGE_LIMIT_MB`; nothing is deleted automatically.

# Phase 5 collection

## analysis_rooms
ONE document per room (D-035). Members, invitations, the variation tree and the annotations are embedded, so every change is a single atomic write. There are no `room_members`, `variations`, `annotations`, `room_messages` collections. Room chat and presence are never stored (D-039).
Fields: `hostId`, `name` (max 40), `status` (`open`|`closed`), `defaultRole` (`editor`|`viewer`), `members [{ userId, role: host|editor|viewer, joinedAt }]` (max 10), `invited [{ userId, by, at }]` (max 20), `startFen`, `cursor` (id of the current node, `null` = start position; the shared board position), `nodes [{ id, parentId, uci, san, fen, by, at }]` (max `ROOM_MAX_NODES`, default 300; `parentId` null = move from the start), `annotations { [nodeId|"root"]: { comment, nags, arrows, squares, by, at } }`, `rev`, `lastActivityAt`, `closedAt`, `closeReason` (`host_closed`|`empty`|`idle`), `expireAt`, timestamps.
Concurrency (D-038): every write is `updateOne({ _id, rev }, ... $inc rev)`; a lost race re-reads and retries up to 5 times, then `ROOM_BUSY`. The same check keeps the room at 10 members. Not a transaction and not needed: one document, one write.
Indexes: `{ "members.userId": 1, status: 1 }` (my rooms), `{ "invited.userId": 1, status: 1 }` (my invitations), `{ hostId: 1, status: 1 }` (hosted-room limit), `{ status: 1, lastActivityAt: 1 }` (idle sweeper), TTL `{ expireAt: 1 }` with `expireAfterSeconds: 0`.
Retention (D-040): when a room closes (host, last member leaves, or idle for `ROOM_IDLE_CLOSE_MS` = 24 h with nobody joined) `expireAt` is set to now + `ROOM_RETENTION_DAYS` (7); MongoDB's TTL monitor (about once a minute) then deletes it. A member can save a COPY of a room's analysis as an `analysis_session` (below) before the room is deleted.
Known limits: a room document can only grow to the node cap (300) so it stays far below 16 MB; the hosted-room limit is a count check, so two simultaneous creations can exceed it by one; the server never checks that room moves are legal.

## Economy and purchases (Phase 7a, D-046 to D-050)

### wallets
One document per user (created on first use). `userId` (unique), `coins` (integer, never below zero: a spend only applies if `coins >= amount`, checked in the same update), `recentTxIds` (the last 50 applied transaction ids, used to apply a transaction exactly once), timestamps. Never deleted.

### transactions (the coin ledger, append-only)
`key` (unique: names the business event, e.g. `daily:<user>:<yyyy-mm-dd>`, `pack:<user>:<packId>`, `purchase:<purchaseId>`), `userId`, `delta` (signed integer, not zero), `reason` (one of `daily_reward`, `pack_purchase`, `coin_bundle`, `admin_grant`, and `tournament_entry`, `tournament_refund`, `tournament_prize`, which are allowed by the schema but not used by any code yet: they are for step 7c), `ref`, `state` (`pending` -> `applied`), `balanceAfter`, `appliedAt`, timestamps. Indexes: `{ key }` unique; `{ userId, _id: -1 }` (history pages); `{ state, createdAt }` (the clean-up that finishes half-done rows). Rows are kept indefinitely, so they count towards the storage watch (D-028). A refused spend (not enough coins) deletes its own pending row.

### entitlements
One document per user: `userId` (unique), `premium` (boolean, one-time purchase, D-049) and `packs` (array of commentator pack ids, set-add so granting twice changes nothing).

### purchases
One document per redeemed Google Play purchase: `userId`, `productId`, `kind` (`coin_bundle`, `pack`, `premium`), `purchaseToken` (unique, `select: false`, never returned by the API and never logged), `orderId`, `state` (`verified` -> `granted` -> `acknowledged`), `verifier` (`fake` or `google`), timestamps. Indexes: `{ purchaseToken }` unique (one store purchase is redeemed once, by one user); `{ userId, _id: -1 }`; `{ state, updatedAt }` (the clean-up that continues unfinished purchases).

Recovery behaviour: see FAILURE_RECOVERY_GUIDE scenario 25c. Backup note: the ledger and purchases are the only copy of who paid for what; include them in every MongoDB backup.

### notifications (Phase 7b, D-051)
One document per notification: `userId`, `type` (enum, see API_DOCUMENTATION), `data` (small free-form object, at most 2000 characters as JSON), `readAt` (null = unread), `key` (optional), `expireAt`, `createdAt`.
- `key` is set by modules that may report the same event twice (a retry, or a sweeper that runs again after a crash). A partial unique index on `{ userId, key }` (only documents that have a key) makes the second attempt return the stored notification and push nothing; notifications without a key are never treated as duplicates.
- Retention: `expireAt` is creation time + 30 days and a TTL index (`expireAfterSeconds: 0`) deletes the document. Unlike messages and games, notifications do not accumulate.
- Indexes: `{ userId, _id: -1 }` (list, newest first); `{ userId, readAt, _id: -1 }` (unread count and "unread only"); the partial unique `{ userId, key }`; the TTL index on `expireAt`.
- Recovery: a notification is stored first and pushed afterwards. If the process dies in between, the notification is still in the list; only the live push is lost. `notify()` (used by other modules) never throws, so a failed notification cannot break a payout or a game; `create()` throws a retryable `TEMPORARILY_UNAVAILABLE`.
## Tournaments (Phase 7c, D-052 to D-055)

### tournaments
One document per Swiss tournament, with the whole running state embedded. Nothing lives in RAM (failure scenario 19).
Fields: `name`, `hostId`, `hostName`, `status` (`registration` | `running` | `finished` | `cancelled`), `timeControlId`, `rated`, `entryFee` (0 to 500 coins), `maxPlayers` (4 to 32), `roundsPlanned` (creator's choice or null), `roundsTotal` (fixed at the start), `startsAt`, `startedAt`, `finishedAt`, `cancelledAt`, `cancelReason`, `roster[]` (user ids, fixed at the start), `currentRound`, `nextRoundAt`, `rounds[]`, `prizes[] { userId, place, amount }`, `prizesPaid`, timestamps.
- `rounds[] { number, startedAt, doneAt, pairings[] }`; `pairings[] { key, kind (game | bye), whiteId, blackId, status (pending | playing | done), gameId, startBy, whiteScore, blackScore, reason (result | aborted | forfeit | double_forfeit | bye) }`. The `key` is stable (`r2p0`).
- Standings are NEVER stored. They are recomputed from the pairings on every read, so a crash cannot leave a stale counter.
- Every change is a conditional `updateOne` (status, current round, pairing `status != done`): a pairing result, a round start, the finish and the prize list are each written once, however many sweepers or restarts try.
- Indexes: `{ status, startsAt }` (sweeper: who must start), `{ hostId, status }` (one open tournament per host), `{ status, _id: -1 }` (listing), `{ rounds.pairings.gameId }`.
- Size: at most 32 players and 31 rounds: far below the 16 MB limit.
- Retention: tournaments are kept as history (small). Plan a cleanup with the game cleanup in Phase 8.
- Recovery: after a restart the sweeper reads the stored timestamps and the stored games of unfinished pairings, so a result that happened while the server was down is found. See FAILURE_RECOVERY_GUIDE scenario 19.

### tournament_players
One document per (tournament, user): `tournamentId`, `userId`, `username`, `rating` (when joining; tie-break), `state` (`pending` | `joined` | `withdrawn`), `refundPending`, timestamps.
- Leaving is final: the ledger keys for the fee and the refund are fixed per (tournament, user), so a retry can never charge or refund twice.
- `refundPending` is set in the same update that withdraws the player. The sweeper pays the refund (idempotent) and clears it, so a crash between the two steps loses nothing. A `pending` join that never finished (crash after the charge) is withdrawn and refunded by the sweeper after twice `WALLET_PENDING_AGE_MS`.
- Capacity: players are ranked by record id; only the first `maxPlayers` keep their seat, the others are withdrawn and refunded. This makes the last seat safe without a transaction.
- Indexes: unique `{ tournamentId, userId }`; `{ tournamentId, state, _id }` (roster in join order, capacity check); `{ userId, _id: -1 }` (my tournaments); `{ state, updatedAt }` (stuck joins); partial `{ refundPending }` (only `true`).

### Coin ledger keys used by tournaments
`tournament:<id>:entry:<user>`, `tournament:<id>:refund:<user>`, `tournament:<id>:prize:<user>` (reasons `tournament_entry`, `tournament_refund`, `tournament_prize`). The keys are unique in `transactions`, so each payment happens at most once. Notification keys follow the same idea (`tournament:<id>:round:<n>:<user>` and so on).

## admin_actions (Phase 8c, D-059)
Append-only audit log of administrator actions. Fields: `key` (optional idempotency key such as `coins:<requestId>`, unique when present), `adminId` (null = the owner's local script), `action` (user_status, coins_grant, coins_revoke, entitlements, report_resolve, tournament_repair, tournament_cancel, role_changed_by_script), `targetType` (user, tournament, report, system), `targetId`, `details` (reason and values, never passwords, tokens or e-mail addresses), `status` (started, done, failed), `errorCode`, `createdAt`, `finishedAt`. A row is written BEFORE the action; a crash leaves a visible `started` row. No TTL and no endpoint edits or deletes rows. Indexes: unique `key` (partial), `createdAt`, `targetId + createdAt`, `adminId + createdAt`. Users also carry `statusReason`, `statusChangedAt`, `statusChangedBy` for suspensions and bans. Reports carry the review fields (`status`, `reviewedBy`, `reviewedAt`, `note`). Transactions gained the reasons `admin_grant` and `admin_revoke`.
