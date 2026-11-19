# WEBSOCKET_DOCUMENTATION

Endpoint: `ws://localhost:3000/ws` locally, `wss://<name>.onrender.com/ws` when deployed. Protocol version 1. Only implemented events are listed; game, chat, room and signaling events arrive in later phases.

## Envelope
Every message in both directions is JSON text (binary frames are refused, close code 1003):
`{ "id"?: string (max 64), "type": string (max 64), "payload"?: any }`
Server replies to a request echo its `id`. Errors: `{ "type": "error", "id"?, "payload": { "code", "message" } }`.
Maximum message size: 16384 bytes by default (`WS_MAX_PAYLOAD_BYTES`); larger frames close the socket with code 1009.

## Connection lifecycle
1. Client connects. Server sends `server.hello` `{ protocol, connectionId, heartbeatMs, authTimeoutMs, serverTime }`.
2. Client must send `auth` within `authTimeoutMs` (default 10 s) or the socket is closed with 4001.
3. Until authenticated only `ping` and `auth` are accepted; anything else returns `UNAUTHENTICATED`.
4. Wait for `auth.ok` before sending other events (events are processed concurrently, not queued behind `auth`).

## Events: client -> server
| type | auth needed | payload | response |
|---|---|---|---|
| `ping` | no | none | `pong { serverTime }` |
| `auth` | no | `{ accessToken }` (the REST access token) | `auth.ok { userId, sessionId, expiresAt }` or `error` |
| `whoami` | yes | none | `whoami { userId, sessionId }` (debug/diagnostics) |

`auth` can be sent again on the same socket to renew an expiring token. It must be the same user AND the same session, otherwise `error AUTH_MISMATCH`. The first `auth` that fails closes the socket with 4003.

## Events: server -> client (pushed)
| type | payload | sent when |
|---|---|---|
| `auth.expiring` | `{ expiresAt }` | 30 s (`WS_TOKEN_WARNING_MS`) before the access token expires. Client: refresh via REST `/api/v1/auth/refresh`, then send `auth` with the new access token |
| `presence.update` | `{ userId, online }` | a friend's first device connects or last device disconnects (not sent for users who hid their online status) |
| `friend.request` | `{ requestId, from: {id, username, displayName, avatarId} }` | someone sent you a friend request |
| `friend.accepted` | `{ friendshipId, user: {...} }` | someone accepted your request |

## Error codes
`INVALID_JSON`, `INVALID_MESSAGE`, `UNKNOWN_EVENT`, `INVALID_PAYLOAD`, `UNAUTHENTICATED`, `TOKEN_EXPIRED` (refresh then re-`auth`), `SESSION_REVOKED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_BANNED`, `AUTH_MISMATCH`, `INTERNAL_ERROR`.

## Close codes
| code | meaning | client action |
|---|---|---|
| 1001 | server restarting/shutting down | reconnect with backoff, then `auth` |
| 1003 | binary frame sent | fix client |
| 1009 | message too large | fix client |
| 4001 | no `auth` in time | reconnect and `auth` immediately |
| 4002 | token expired and not renewed | refresh token via REST, reconnect, `auth` |
| 4003 | authentication failed | refresh/login again |
| 4004 | session revoked (logout, logout-all, ban) | go to login screen |

## Heartbeat
The server sends a protocol-level ping every `heartbeatMs` (30 s) and terminates sockets that did not answer the previous one. Standard WebSocket clients (e.g. OkHttp) answer automatically. Clients may also send application `ping` to measure latency or detect a dead connection.

## Reconnect procedure (client)
On any close except 4004: wait with exponential backoff (1 s, 2 s, 4 s ... max 30 s, with jitter), refresh the access token if needed, connect, wait for `server.hello`, send `auth`, wait for `auth.ok`. Render Free sleeps when idle, so the first connection after a long idle period may take a minute to succeed; keep retrying.

## Multiple devices
One account may hold several authenticated sockets at once (e.g. phone and tablet). A user is "online" while at least one socket is connected. The "same account playing from two devices" rule for live games will be added in Phase 3.

---

# Phase 3: matchmaking and live games

All events below need an authenticated socket (otherwise `UNAUTHENTICATED`). Request/reply events carry the request `id` in the reply. Chess legality is checked by the Android client, not the server (D-021).

## Client -> server: matchmaking

| Event | Payload | Reply |
|---|---|---|
| `queue.join` | `{ timeControl, rated? = true }` | `queue.joined { queued, timeControlId, rated }` |
| `queue.leave` | `{}` | `queue.left { left: true }` |
| `invite.send` | `{ userId, timeControl, rated? = false }` (friends only, friend must be online) | `invite.sent { inviteId, expiresAt }` |
| `invite.accept` | `{ inviteId }` | `invite.accepted { gameId }` |
| `invite.decline` | `{ inviteId }` | `invite.declined { status }` |
| `invite.cancel` | `{ inviteId }` | `invite.cancelled { status }` |

Time controls: `1+0`, `3+0`, `3+2`, `5+0`, `5+3`, `10+0`, `15+10`, `30+0` (D-026). Rating window: 100 + 20 per second waited (D-023). A queue entry is removed when the user disconnects and expires after 10 minutes. Invitations expire after 60 s; a new invitation replaces the sender's old one.

## Client -> server: game

| Event | Payload | Reply |
|---|---|---|
| `game.join` | `{ gameId }` | `game.state { game }` (full state with `moves`). This device becomes the controlling device. |
| `game.move` | `{ gameId, moveId, seq, uci, san, fen, outcome? }` | `game.move.ack` |
| `game.resign` | `{ gameId }` | `game.resign.ok { gameId }` |
| `game.draw.offer` | `{ gameId }` | `game.draw.offer.ok { gameId }` |
| `game.draw.accept` | `{ gameId }` | `game.draw.accept.ok { gameId }` |
| `game.draw.decline` | `{ gameId }` | `game.draw.decline.ok { gameId }` |

`game.move` fields: `moveId` 8-64 characters (letters, digits, `_`, `-`), generated by the client once per move and REUSED when retrying. `seq` is the number of moves the client has seen confirmed (the server's `seq` before this move). `uci` like `e2e4` or `e7e8q`, `san` like `Nf3`, `fen` is the full position AFTER the move. `outcome` is sent only when this move ends the game: `{ result: "1-0"|"0-1"|"1/2-1/2", reason: "checkmate"|"stalemate"|"insufficient_material"|"threefold_repetition"|"fifty_move_rule" }`. Checkmate must be a win for the mover; the other reasons must be `1/2-1/2`.

`game.move.ack` payload: `{ gameId, seq, moveId, uci, san, fen, turn, clocks: { whiteMs, blackMs, running }, status, result, resultReason, serverTime, duplicate }`. It is sent ONLY after the move is stored in MongoDB. `duplicate: true` means this `moveId` was already stored; nothing was applied again and the ack repeats the original. Retrying after a lost ack is always safe, even if the game has moved on or ended.

Server checks per move, in order: game exists and caller is a player (else `GAME_NOT_FOUND`), this device controls the game (`SESSION_REPLACED`), `moveId` already stored (duplicate ack), game active (`GAME_OVER` / `GAME_PAUSED`), caller's turn (`NOT_YOUR_TURN`), `seq` equals the server's (`STALE_SEQ`), FEN side to move (`INVALID_POSITION`), outcome consistent (`INVALID_OUTCOME`), clock not expired (`GAME_OVER`, lost on time), then ONE conditional database update. If two moves race, exactly one wins and the other gets `STALE_SEQ`, `NOT_YOUR_TURN` or `CONFLICT`.

## Server -> client (pushed)

| Event | Payload | When |
|---|---|---|
| `game.started` | `{ game, yourColor: "w"\|"b" }` | A match was created (queue or invitation). |
| `game.move` | same as `game.move.ack` payload | An accepted move; sent to the players except the socket that sent it. |
| `game.over` | `{ gameId, status, result, resultReason, ratingChange, pgn }` | Game finished or aborted. `ratingChange` is `{ white, black }` or `null` (unrated, aborted, or update failed). |
| `game.paused` | `{ gameId, reason: "paused_disconnect"\|"paused_server_recovery", clocks }` | Both players gone, or server/database recovery. Clocks are frozen. |
| `game.resumed` | `{ game }` | Play continues. |
| `game.active` | `{ gameId, status }` | Sent to a user right after connecting if they are in a live game. |
| `game.opponent.disconnected` | `{ gameId, graceMs }` | Opponent lost connection; they have `graceMs` to return (default 60 s) and the clock keeps running. |
| `game.opponent.reconnected` | `{ gameId }` | Opponent is back. |
| `game.session.replaced` | `{ gameId }` | Another device of yours joined the game; this device can no longer play. |
| `game.draw.offered` | `{ gameId, by }` | Opponent offers a draw. An offer is cancelled by any move. |
| `game.draw.declined` | `{ gameId }` | Opponent declined. |
| `invite.received` | `{ inviteId, from: { id, username }, timeControlId, rated, expiresAt }` | A friend invited you. |
| `invite.updated` | `{ inviteId, status, gameId? }` | Your invitation was accepted (with `gameId`), declined or cancelled. |
| `queue.cancelled` | `{ reason }` | Pairing succeeded but the game could not be created; join the queue again. |

`result` is `1-0`, `0-1` or `1/2-1/2`. `resultReason` values: `checkmate`, `stalemate`, `insufficient_material`, `threefold_repetition`, `fifty_move_rule`, `resignation`, `timeout`, `agreement`, `abandoned`, `both_abandoned`, `abandoned_before_start` (status `aborted`, no result, no rating change).

## Game error codes

`INVALID_PAYLOAD`, `GAME_NOT_FOUND` (also for other people's games), `SESSION_REPLACED`, `NOT_YOUR_TURN`, `STALE_SEQ`, `INVALID_POSITION`, `INVALID_OUTCOME`, `DUPLICATE_MOVE_ID` (moveId used by the other player), `GAME_OVER`, `GAME_PAUSED`, `CONFLICT` (retry), `DRAW_OFFER_PENDING`, `NO_DRAW_OFFER`, `INVALID_TIME_CONTROL`, `ALREADY_IN_GAME`, `INVALID_OPPONENT`, `ACCOUNT_NOT_ACTIVE`, `USER_NOT_FOUND`, `NOT_FRIENDS`, `USER_OFFLINE`, `INVITE_NOT_FOUND`, `TEMPORARILY_UNAVAILABLE` (database problem: the request was NOT applied; retry the same request with the same `moveId`).

## Game reconnect procedure (client)

1. Reconnect the WebSocket and send `auth` (refresh the token over REST first if it expired).
2. Wait for `game.active`, or call `GET /api/v1/games/active`.
3. Send `game.join { gameId }`. The reply `game.state` is the truth: compare its `seq` and `moves` with the local board and fix the local state.
4. If the last move you sent has no ack and its `seq` is not in `game.state`, send it again with the SAME `moveId` and the same `seq`. If it is already in `game.state`, drop it.
5. If `game.state.game.status` is `paused_*`, show "waiting" and keep the socket open. Play resumes with `game.resumed`.
6. After a SERVER restart the game is paused (`paused_server_recovery`) and resumes only when BOTH players are connected again. Nobody is charged for the downtime. If nobody returns within 5 minutes the game is settled (see FAILURE_RECOVERY_GUIDE).

## Clocks

The server owns the clocks. The client should display `clocks` from the latest ack, `game.move`, `game.state` or `game.resumed`, counting down locally only for the side to move while `running` is true, and correct itself with each server message. `serverTime` is the server clock in ms since epoch when the payload was made.

# Phase 4: personal messages, match chat, voice signaling

All events below need an authenticated socket (`UNAUTHENTICATED` otherwise). Several are rate limited per socket (D-030, D-058); exceeding the limit answers `RATE_LIMITED` and the event is dropped (the reply carries the request `id`; wait a few seconds and retry the same event). Limits per 10 s per socket: `game.join` and `game.move` 20; `game.resign` and `game.draw.offer` 5; `game.draw.accept` and `game.draw.decline` 10; `queue.join`, `queue.leave`, `invite.send`, `invite.accept`, `invite.decline`, `invite.cancel` 10. A move retry after a lost ack stays far below these limits.

## Personal messages (permanent, stored in MongoDB; friends only, D-029)
| Client sends | Payload | Reply |
|---|---|---|
| `message.send` (10 per 10 s) | `{ toUserId, clientMessageId (8-64 chars: letters, digits, _ -), body (1-2000, control characters removed) }` | `message.send.ok { message, duplicate }` only AFTER the message is stored |
| `message.read` | `{ conversationId }` | `message.read.ok { conversationId, markedRead }` |

`message` = `{ id, conversationId, senderId, recipientId, body, createdAt, readAt }`.
**Retry rule:** if the ack is lost, resend with the SAME `clientMessageId`. The server returns the stored message with `duplicate: true` and never stores it twice. A new text needs a new `clientMessageId` (reuse for another recipient gives `DUPLICATE_CLIENT_MESSAGE_ID`).
Pushed to the recipient and to the sender's OTHER devices: `message.new { message, conversation: { id, unread } }`. Pushed when the other side reads: `message.seen { conversationId, byUserId, readAt }` (also to the reader's other devices). Offline users get nothing pushed: they read history over REST when they come back (`GET /api/v1/conversations`).
Errors: `NOT_FRIENDS` (not friends, or either user blocked the other; not distinguishable on purpose), `CANNOT_MESSAGE_SELF`, `DUPLICATE_CLIENT_MESSAGE_ID`, `CONVERSATION_NOT_FOUND`, `INVALID_PAYLOAD`, `RATE_LIMITED`, `TEMPORARILY_UNAVAILABLE` (database down: retry with the same `clientMessageId`).

## Match chat (temporary: RAM relay only, NEVER stored; D-032, D-034)
| Client sends | Payload | Reply |
|---|---|---|
| `chat.match.send` (5 per 5 s) | `{ gameId, text (1-300, control characters removed) }` | `chat.match.send.ok { gameId, messageId, at, delivered }` |

Only the two players of a live game (active or paused) can send. The opponent gets `chat.match.message { gameId, messageId, from, text, at }`; the sender's other devices get the same push (the sending device does not). `delivered: false` means the opponent had no connected device: the message is DROPPED, not queued. If either player has blocked the other the message is not delivered but the sender still gets `ok` (`delivered: false`), so a block is not revealed. Text is plain text; render it as text.
Errors: `GAME_NOT_FOUND` (also for strangers: same answer as a missing game), `GAME_OVER` (chat closes when the game ends), `RATE_LIMITED`, `INVALID_PAYLOAD`.
After a server restart or when the game ends, the chat is gone by design (failure scenario 20): the client should keep its own copy for display only and must not expect it back.

## Voice signaling (WebRTC; audio never passes through the server; D-027, D-033)
The server relays the session descriptions and ICE candidates between the two players of a live game. Nothing is stored. One call per game.
| Client sends | Payload | Reply |
|---|---|---|
| `voice.config` | `{}` | `voice.config { iceServers, turnAvailable, ttlSeconds }` |
| `voice.offer` (5 per 10 s, shared with answer) | `{ gameId, sdp }` | `voice.offer.ok { gameId }` |
| `voice.answer` | `{ gameId, sdp }` | `voice.answer.ok { gameId }` |
| `voice.ice` (60 per 10 s) | `{ gameId, candidate: { candidate, sdpMid?, sdpMLineIndex?, usernameFragment? } }` | `voice.ice.ok` only if the request had an `id` |
| `voice.end` | `{ gameId }` | `voice.end.ok { gameId }` |
| `voice.failed` | `{ gameId }` | `voice.failed.ok { gameId, turnAvailable }` |

Pushed to the other player: `voice.offer { gameId, from, sdp }`, `voice.answer { gameId, from, sdp }`, `voice.ice { gameId, from, candidate }`, `voice.ended { gameId, reason, turnAvailable? }`.
`voice.ended.reason`: `hangup`, `no_answer` (nobody answered within `VOICE_RING_TIMEOUT_MS`), `peer_disconnected`, `game_over`, `ice_failed`, `answered_elsewhere` (another device of the callee answered).
Flow: call `voice.config` once, build the `RTCPeerConnection` with `iceServers`, caller sends `voice.offer`, callee sends `voice.answer`, both send `voice.ice` as candidates appear. If the connection fails, send `voice.failed`: the opponent is told, and `turnAvailable: false` tells the client that no relay exists, so show "voice not available on this network" and keep playing. The game never depends on voice.
`iceServers` carries TURN credentials only when TURN is configured; with a TURN secret they are time limited (`ttlSeconds`), so ask `voice.config` again before each call.
After a reconnect or server restart the call is gone: start it again with a new `voice.offer`.
Errors: `GAME_NOT_FOUND`, `GAME_OVER`, `VOICE_BUSY` (a call already exists for this game), `VOICE_UNAVAILABLE` (a block exists between the players), `OPPONENT_OFFLINE`, `NO_CALL` (answer/ice/end without a call, or from a device that is not part of it), `RATE_LIMITED`, `INVALID_PAYLOAD`.

# Phase 5: analysis rooms (D-035 to D-040)

Up to 10 friends analyse a position together. The room, members, variation tree and annotations are stored in MongoDB (one document, `rev` counter). Presence and room chat are RAM only. All events need an authenticated socket. Chess legality is NOT checked by the server (D-021): it checks structure, permissions and size limits.

**Roles:** `host` (one), `editor`, `viewer`. Host and editors change the position, moves and annotations; viewers watch and chat. Only the host invites, kicks, changes roles, transfers host and closes the room. The room is private: only invited friends can enter. Unknown rooms, rooms you are not part of and rooms you were removed from all answer `ROOM_NOT_FOUND`.

**Joined sockets:** being a member is stored; being "in the room" on a connection is not. Send `room.join` on every new connection (including after reconnect or server restart). Editing and chat from a socket that has not joined return `ROOM_NOT_JOINED`.

**Revisions:** every stored change increases `rev` by 1. Every change is pushed to all joined sockets with its new `rev` (the socket that made the change gets the same `rev` in its reply instead of a push). Client rule: ignore a push whose `rev` is not greater than the state you have; if you see a gap (`rev` more than 1 ahead), send `room.join` again to get the full state.

## Client -> server
| Event | Payload | Reply | Who |
|---|---|---|---|
| `room.create` (5 per 60 s) | `{ name (1-40), defaultRole? = "editor"\|"viewer", startFen? }` | `room.create.ok { room, online, you }` (creator is host and joined) | any user, max 3 open hosted rooms |
| `room.invite` (10 per 60 s) | `{ roomId, userId }` | `room.invite.ok { roomId, rev, userId, duplicate }` | host; target must be a friend, no block |
| `room.invite.cancel` | `{ roomId, userId }` | `room.invite.cancel.ok { roomId, rev, userId, removed }` | host |
| `room.decline` | `{ roomId }` | `room.decline.ok { roomId, declined }` | invited user |
| `room.join` (10 per 10 s) | `{ roomId }` | `room.state { room, online, you: { role } }` | member, or invited user (becomes a member with the default role) |
| `room.leave` | `{ roomId }` | `room.leave.ok { roomId, rev, closed }` | member |
| `room.kick` | `{ roomId, userId }` | `room.kick.ok { roomId, rev, userId }` | host |
| `room.role.set` | `{ roomId, userId, role: "editor"\|"viewer" }` | `room.role.set.ok { roomId, rev, userId, role }` | host |
| `room.host.transfer` | `{ roomId, userId }` | `room.host.transfer.ok { roomId, rev, hostId }` | host (old host becomes editor) |
| `room.close` | `{ roomId }` | `room.close.ok { roomId, rev }` | host |
| `room.move.add` (20 per 10 s) | `{ roomId, parentId? (null = from start), uci, san, fen }` | `room.move.add.ok { roomId, rev, node, duplicate }` | host, editor |
| `room.node.delete` (10 per 10 s) | `{ roomId, nodeId }` | `room.node.delete.ok { roomId, rev, nodeId, removedIds, cursor }` | host, editor |
| `room.position.set` (30 per 10 s) | `{ roomId, nodeId (null = start position) }` | `room.position.set.ok { roomId, rev, position }` | host, editor |
| `room.annotation.set` (20 per 10 s) | `{ roomId, nodeId ("root" = start position), comment? (max 500), nags? (max 4, 1-255), arrows? (max 12 of {from,to,color}), squares? (max 16 of {square,color}) }` | `room.annotation.set.ok { roomId, rev, nodeId, annotation }` | host, editor |
| `room.chat.send` (5 per 5 s) | `{ roomId, text (1-300) }` | `room.chat.send.ok { roomId, messageId, at, delivered }` | any joined member |

Details:
- `room` (state) = `{ id, name, status, hostId, defaultRole, maxMembers, rev, startFen, position: { nodeId, fen }, members: [{ userId, role, joinedAt, user }], invited: [{ userId, by, at, user }], nodes: [{ id, parentId, uci, san, fen, by, at }], annotations: { [nodeId|"root"]: { comment, nags, arrows, squares, by, at } }, createdAt, lastActivityAt }`. Colors: `green`, `red`, `blue`, `yellow`.
- The same move under the same parent is never stored twice: `room.move.add` answers `duplicate: true` with the existing node and, if needed, moves the shared position to it (safe to retry). Deleting a node deletes its whole variation and their annotations; deleting something already gone is a success. An empty annotation (no comment, nags, arrows or squares) removes it. Repeating identical content changes nothing and does not increase `rev`.
- A room holds at most 10 members including the host, 20 pending invitations and `ROOM_MAX_NODES` (300) moves.
- `room.chat.send.ok.delivered` is the number of OTHER people reached. Chat is never stored and never delivered to someone who is in a block with the sender (the sender is not told).

## Server -> client (pushed)
| Event | Payload | Sent to / when |
|---|---|---|
| `room.invitation` | `{ room: summary, by: user }` | every device of the invited user |
| `room.invitation.cancelled` | `{ roomId, reason: "cancelled"\|"declined"\|"closed" }` | the invited user (declined: also their other devices) |
| `room.invited` | `{ roomId, rev, userId, by, user }` | joined members: someone was invited |
| `room.invite.removed` | `{ roomId, rev, userId, reason: "cancelled"\|"declined" }` | joined members |
| `room.member.joined` | `{ roomId, rev, member }` | joined members |
| `room.member.left` | `{ roomId, rev, userId, reason: "left"\|"kicked", newHostId? }` | joined members |
| `room.member.role` | `{ roomId, rev, userId, role }` | joined members |
| `room.host.changed` | `{ roomId, rev, hostId, previousHostId }` | joined members |
| `room.presence` | `{ roomId, userId, online }` | joined members, when a member's first device joins or last device disconnects (no `rev`) |
| `room.move.added` | `{ roomId, rev, node, by }` | joined sockets except the sender |
| `room.position` | `{ roomId, rev, nodeId, fen, by }` | joined sockets except the sender |
| `room.node.deleted` | `{ roomId, rev, nodeId, removedIds, cursor, by }` | joined sockets except the sender |
| `room.annotation` | `{ roomId, rev, nodeId, annotation (null = removed), by }` | joined sockets except the sender |
| `room.chat.message` | `{ roomId, messageId, from, text, at }` | joined sockets except the sender, skipping people in a block with the sender |
| `room.kicked` | `{ roomId }` | every device of the kicked user |
| `room.left` | `{ roomId, reason: "left" }` | the leaving user's other devices |
| `room.closed` | `{ roomId, rev, reason: "host_closed"\|"empty"\|"idle" }` | all members (joined or not) |

## Room error codes
`ROOM_NOT_FOUND` (also for rooms you may not see), `ROOM_CLOSED`, `ROOM_FULL`, `ROOM_FORBIDDEN` (host-only action, or an editing action as a viewer), `ROOM_NOT_JOINED` (send `room.join` first), `ROOM_UNAVAILABLE` (a block exists with a current member), `ROOM_LIMIT` (3 open hosted rooms), `ROOM_ANALYSIS_FULL` (too many moves), `ROOM_BUSY` (many simultaneous changes; retry), `TOO_MANY_INVITES`, `ALREADY_MEMBER`, `MEMBER_NOT_FOUND`, `NODE_NOT_FOUND`, `CANNOT_INVITE_SELF`, `CANNOT_KICK_SELF`, `CANNOT_CHANGE_HOST`, `NOT_FRIENDS`, `USER_NOT_FOUND`, `RATE_LIMITED`, `INVALID_PAYLOAD`, `TEMPORARILY_UNAVAILABLE` (database problem: the change was NOT applied; retry).

## Room reconnect procedure (client)
1. After reconnecting and `auth`, call `GET /api/v1/rooms` (or keep the room id) and send `room.join { roomId }` for the room that is open on screen.
2. `room.state` is the truth: replace the local room with it (nodes, annotations, position, members, `rev`). Keep ignoring pushes with `rev` <= the state's `rev`.
3. Edits sent while disconnected were not applied unless their ack arrived. `room.move.add` and `room.annotation.set` are safe to repeat; check the state first.
4. After a SERVER restart the room is intact but nobody is joined and room chat is gone: join again. `ROOM_NOT_JOINED` on an edit means you must join again.
5. `ROOM_NOT_FOUND` on join means you were removed or the room was deleted: leave the screen.
6. Closed rooms stay readable by members (REST) for 7 days, then are deleted.

# Phase 6: spectators (D-041, D-042)
A friend of a player follows a LIVE game (active or paused). Nothing is stored; subscriptions are per connection and RAM only. Authorization: not a player, friend of at least one player, no block (either way) with either player. Everything else, including unknown ids, answers `GAME_NOT_FOUND`.

## Client -> server
| Event | Payload | Reply | Notes |
|---|---|---|---|
| `spectate.join` | `{ gameId }` | `spectate.state { game, spectators }` | `game` is the full game with `moves` (same shape as `game.state`). Rate limit 10 per 10 s. Errors: `GAME_NOT_FOUND`, `YOU_ARE_A_PLAYER` (use `game.join`), `GAME_OVER` (a friend's game that already ended: read it over REST), `SPECTATOR_LIMIT` (the game already has `SPECTATOR_MAX_PER_GAME` = 20 distinct users; a second device of the same user does not count) |
| `spectate.leave` | `{ gameId }` | `spectate.leave.ok { gameId, spectators }` | Idempotent. |

A spectator cannot send `game.move`, `game.resign`, draw events, `chat.match.send` or `voice.*`: they all answer `GAME_NOT_FOUND` for non-players.

## Server -> client (pushed)
| Event | Payload | Sent to |
|---|---|---|
| `spectate.update` | `{ game, lastMove: { seq, uci, san, at } \| null }` | spectators, after EVERY stored change of the game (a move, pause, resume). `game` has no `moves`; it carries `seq`, `fen`, `turn`, `status`, `clocks`, `serverTime`. A retried move produces no second update |
| `spectate.over` | `{ gameId, status, result, resultReason, ratingChange, pgn }` | spectators, once, when the game ends; the server then drops the subscription. `ratingChange` can be `null` here (ratings are applied just after): read the game over REST for it |
| `spectate.count` | `{ gameId, count }` | spectators AND both players when a user starts or stops watching (`count` = distinct users) |

## Spectator reconnect procedure (client)
1. After reconnecting and `auth`, send `spectate.join` again for the game on screen. A server restart or a dropped connection removes the subscription, nothing else.
2. `spectate.state` is the truth: replace the local game. Ignore updates with `seq` below the state's `seq`; if an update's `seq` is more than one ahead of yours, send `spectate.join` again to resynchronise.
3. `GAME_OVER` on join means the game ended while you were away: `GET /api/v1/games/:id` returns the finished game and PGN.
4. After a server restart a live game is paused (`paused_server_recovery`) and resumes when both players are back; you keep receiving `spectate.update` with the new `status`.
5. A block created after you joined does not remove you from that game (D-041).

# Notifications (Phase 7b, D-051)
No client-to-server events: reading and marking read use REST (API_DOCUMENTATION, Notifications). The server pushes these to EVERY connected device of the user, and to nobody else.

| Event | Payload | When |
|---|---|---|
| `notification.new` | `{ notification: { id, type, data, readAt, createdAt }, unread }` | A notification was stored for you. `unread` is your total unread count. |
| `notification.read` | `{ ids: [id], unread }` or `{ all: true, unread }` | You marked one notification, or all of them, read on another device. Clear the badge and update the count. Sent only when something actually changed. |

Reconnect procedure: pushes are not replayed. After every (re)connect call `GET /api/v1/notifications/unread-count` (or the list) to catch up on what arrived while you were offline. A notification pushed to a device that is offline is simply found in the list later.

# Tournaments (Phase 7c, D-052 to D-055)
Tournaments have NO events of their own. Registration, listing and reading use REST (API_DOCUMENTATION, Tournaments). While a tournament runs, the app learns what to do from events that already exist:

| Event | Where it is documented | What it means for a tournament |
|---|---|---|
| `notification.new` with type `tournament_starting`, `tournament_round`, `tournament_game_ready`, `tournament_finished`, `tournament_prize` or `tournament_cancelled` | Notifications (above) | Show the round, the opponent and the deadline (`startBy`), or the result and the prize. `tournament_game_ready` carries the `gameId`. |
| `game.started` | Phase 3 | Sent to both players when the server creates the tournament game. The game object has `tournamentId` (null for ordinary games). Open the game from this event; the stored notification is the fallback. |
| `game.*` (move, clock, over, resumed, ...) | Phase 3 | Tournament games are ordinary games. The same clocks, reconnect grace and recovery rules apply. |

Rules the client must follow:
- Be connected (WebSocket authenticated) and not inside another game when a round starts. The server creates the game only when BOTH players are online and free; a player who is absent when `startBy` (3 minutes after the round started) passes loses the pairing.
- Do not create a game for a tournament pairing yourself. Joining the matchmaking queue is not needed and does not count as showing up.
- Reconnect procedure: pushes are not replayed. After every (re)connect read `GET /api/v1/notifications?unread=true` (a missed `tournament_game_ready` is there) and `GET /api/v1/tournaments/:id` (current round, your pairing, standings). If `game.active` arrives, rejoin that game as usual.
- A tournament game that is paused by a server outage resumes through the normal `game.resumed` flow; the pairing waits for its result.
