'use strict';

// Core live-game behaviour: ordering, idempotency, concurrency, permissions, results, ratings.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '3000';
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { User, Game } = require('../src/database/models');

let server;
let api;

before(async () => {
  server = await h.startTestServer();
  api = h.makeApi(server.base);
});

after(async () => {
  g.closeAll();
  await server.stop();
});

test('two queued players are matched into one game with opposite colours', async () => {
  const m = await g.startMatch(server, api);
  assert.notEqual(m.white.user.id, m.black.user.id);
  const res = await api.get(`/api/v1/games/${m.gameId}`, m.white.user.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.game.status, 'active');
  assert.equal(res.body.game.white.id, m.white.user.id);
  assert.equal(res.body.game.timeControl.id, '5+0');
});

test('an accepted move is persisted, acknowledged and broadcast; clocks come from the server', async () => {
  const m = await g.startMatch(server, api);
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(ack.seq, 1);
  assert.equal(ack.duplicate, false);
  assert.equal(ack.turn, 'b');
  const pushed = await m.black.socket.nextOfType('game.move');
  assert.equal(pushed.payload.san, 'e4');
  assert.equal(pushed.payload.seq, 1);
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.seq, 1);
  assert.equal(stored.moves.length, 1);
  assert.equal(stored.fen, g.MOVES[0].fen);
});

test('a retried move (same moveId) is acknowledged again but applied only once', async () => {
  const m = await g.startMatch(server, api);
  const msg = g.moveMsg(m.gameId, 0);
  await g.call(m.white.socket, 'game.move', msg, 'game.move.ack');
  await m.black.socket.nextOfType('game.move');
  const again = await g.call(m.white.socket, 'game.move', msg, 'game.move.ack');
  assert.equal(again.duplicate, true);
  assert.equal(again.seq, 1);
  assert.equal(await m.black.socket.quietFor(300), true, 'opponent must not get the move twice');
  assert.equal((await Game.findById(m.gameId).lean()).moves.length, 1);
});

test('a retry still succeeds after the game has moved on', async () => {
  const m = await g.startMatch(server, api);
  const first = g.moveMsg(m.gameId, 0);
  await g.call(m.white.socket, 'game.move', first, 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  const again = await g.call(m.white.socket, 'game.move', first, 'game.move.ack');
  assert.equal(again.duplicate, true);
  assert.equal((await Game.findById(m.gameId).lean()).seq, 2);
});

test('wrong turn, stale seq and bad data are rejected with precise codes', async () => {
  const m = await g.startMatch(server, api);
  assert.equal(await g.errorOf(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1, { fields: { seq: 0 } })), 'NOT_YOUR_TURN');
  assert.equal(await g.errorOf(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0, { fields: { seq: 5 } })), 'STALE_SEQ');
  // FEN says white to move again after white moved: impossible.
  const badFen = g.moveMsg(m.gameId, 0, { fields: { fen: g.MOVES[1].fen } });
  assert.equal(await g.errorOf(m.white.socket, 'game.move', badFen), 'INVALID_POSITION');
  assert.equal(await g.errorOf(m.white.socket, 'game.move', { gameId: m.gameId, uci: 'zz' }), 'INVALID_PAYLOAD');
  const badOutcome = g.moveMsg(m.gameId, 0, { fields: { outcome: { result: '0-1', reason: 'checkmate' } } });
  assert.equal(await g.errorOf(m.white.socket, 'game.move', badOutcome), 'INVALID_OUTCOME');
  assert.equal((await Game.findById(m.gameId).lean()).seq, 0, 'nothing may have been applied');
});

test('two simultaneous moves for the same position: exactly one wins', async () => {
  const m = await g.startMatch(server, api);
  const a = g.moveMsg(m.gameId, 0, { tag: 'a' });
  const b = g.moveMsg(m.gameId, 0, { tag: 'b', fields: { uci: 'd2d4', san: 'd4' } });
  const idA = g.raw(m.white.socket, 'game.move', a);
  const idB = g.raw(m.white.socket, 'game.move', b);
  const replies = new Map();
  while (replies.size < 2) {
    const msg = await m.white.socket.next();
    if (msg.id === idA || msg.id === idB) replies.set(msg.id, msg);
  }
  const types = [...replies.values()].map((r) => r.type).sort();
  assert.deepEqual(types, ['error', 'game.move.ack']);
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.moves.length, 1);
  assert.equal(stored.seq, 1);
});

test('private games are not visible to other users (REST and WebSocket)', async () => {
  const m = await g.startMatch(server, api);
  const spy = await h.registerUser(api, g.uniq('spy'));
  assert.equal((await api.get(`/api/v1/games/${m.gameId}`, spy.token)).status, 404);
  assert.equal((await api.get(`/api/v1/games/${m.gameId}/pgn`, spy.token)).status, 404);
  const sock = await g.authed(server.wsUrl, spy.token);
  assert.equal(await g.errorOf(sock, 'game.join', { gameId: m.gameId }), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(sock, 'game.move', g.moveMsg(m.gameId, 0)), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(sock, 'game.resign', { gameId: m.gameId }), 'GAME_NOT_FOUND');
  assert.equal((await api.get(`/api/v1/games/${m.gameId}`)).status, 401);
});

test('game events need authentication', async () => {
  const socket = await h.openSocket(server.wsUrl);
  await socket.next(); // server.hello
  socket.send(JSON.stringify({ id: '1', type: 'game.join', payload: { gameId: 'a'.repeat(24) } }));
  const reply = await socket.next();
  assert.equal(reply.payload.code, 'UNAUTHENTICATED');
  socket.terminate();
});

test('game.join returns the full state with the move list', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  const state = await g.call(m.black.socket, 'game.join', { gameId: m.gameId }, 'game.state');
  assert.equal(state.game.seq, 1);
  assert.equal(state.game.moves.length, 1);
  assert.equal(state.game.moves[0].san, 'e4');
  assert.equal(state.game.clocks.running, true);
  const active = await api.get('/api/v1/games/active', m.black.user.token);
  assert.equal(active.body.game.id, m.gameId);
});

test('a second device takes over; the first device is told and can no longer play', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.join', { gameId: m.gameId }, 'game.state');
  const second = await g.authed(server.wsUrl, m.white.user.token);
  await g.call(second, 'game.join', { gameId: m.gameId }, 'game.state');
  const replaced = await m.white.socket.nextOfType('game.session.replaced');
  assert.equal(replaced.payload.gameId, m.gameId);
  assert.equal(await g.errorOf(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0)), 'SESSION_REPLACED');
  const ack = await g.call(second, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(ack.seq, 1);
});

test('a move that ends the game finishes it, builds the PGN and updates ratings once', async () => {
  const m = await g.startMatch(server, api);
  const outcome = { result: '1-0', reason: 'checkmate' };
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0, { fields: { outcome } }), 'game.move.ack');
  assert.equal(ack.status, 'finished');
  assert.equal(ack.result, '1-0');
  const overWhite = await m.white.socket.nextOfType('game.over');
  const overBlack = await m.black.socket.nextOfType('game.over');
  assert.equal(overBlack.payload.result, '1-0');
  assert.deepEqual(overWhite.payload.ratingChange, { white: 16, black: -16 });
  assert.match(overWhite.payload.pgn, /1\. e4 1-0/);
  assert.match(overWhite.payload.pgn, /\[Termination "checkmate"\]/);
  assert.equal((await User.findById(m.white.user.id).lean()).rating, 1216);
  assert.equal((await User.findById(m.black.user.id).lean()).rating, 1184);
  // Nothing more can be played, and the rating is not applied a second time.
  assert.equal(await g.errorOf(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1)), 'GAME_OVER');
  assert.equal((await User.findById(m.white.user.id).lean()).rating, 1216);
  const pgn = await api.get(`/api/v1/games/${m.gameId}/pgn`, m.black.user.token);
  assert.equal(pgn.status, 200);
  assert.equal((await api.get('/api/v1/games/active', m.white.user.token)).body.game, null);
});

test('unrated games do not change ratings', async () => {
  const m = await g.startMatch(server, api, { rated: false });
  const outcome = { result: '1/2-1/2', reason: 'stalemate' };
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0, { fields: { outcome } }), 'game.move.ack');
  const over = await m.black.socket.nextOfType('game.over');
  assert.equal(over.payload.ratingChange, null);
  assert.equal((await User.findById(m.white.user.id).lean()).rating, 1200);
});

test('resigning ends the game in favour of the opponent', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.black.socket, 'game.resign', { gameId: m.gameId }, 'game.resign.ok');
  const over = await m.white.socket.nextOfType('game.over');
  assert.equal(over.payload.result, '1-0');
  assert.equal(over.payload.resultReason, 'resignation');
  assert.equal(await g.errorOf(m.black.socket, 'game.resign', { gameId: m.gameId }), 'GAME_OVER');
});

test('draw by agreement; an offer disappears when a move is played', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.draw.offer', { gameId: m.gameId }, 'game.draw.offer.ok');
  const offered = await m.black.socket.nextOfType('game.draw.offered');
  assert.equal(offered.payload.by, m.white.user.id);
  // Offering again is harmless; the opponent cannot "offer" over a pending offer.
  await g.call(m.white.socket, 'game.draw.offer', { gameId: m.gameId }, 'game.draw.offer.ok');
  assert.equal(await g.errorOf(m.black.socket, 'game.draw.offer', { gameId: m.gameId }), 'DRAW_OFFER_PENDING');
  // You cannot accept your own offer.
  assert.equal(await g.errorOf(m.white.socket, 'game.draw.accept', { gameId: m.gameId }), 'NO_DRAW_OFFER');
  // A move cancels the offer.
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(await g.errorOf(m.black.socket, 'game.draw.accept', { gameId: m.gameId }), 'NO_DRAW_OFFER');
  // New offer, accepted.
  await g.call(m.black.socket, 'game.draw.offer', { gameId: m.gameId }, 'game.draw.offer.ok');
  await g.call(m.white.socket, 'game.draw.accept', { gameId: m.gameId }, 'game.draw.accept.ok');
  const over = await m.black.socket.nextOfType('game.over');
  assert.equal(over.payload.result, '1/2-1/2');
  assert.equal(over.payload.resultReason, 'agreement');
});

test('declining a draw clears the offer and tells the offerer', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.draw.offer', { gameId: m.gameId }, 'game.draw.offer.ok');
  await g.call(m.black.socket, 'game.draw.decline', { gameId: m.gameId }, 'game.draw.decline.ok');
  await m.white.socket.nextOfType('game.draw.declined');
  assert.equal(await g.errorOf(m.black.socket, 'game.draw.accept', { gameId: m.gameId }), 'NO_DRAW_OFFER');
});

test('a player who runs out of time loses (server clock, checkpoints running)', async () => {
  const m = await g.startMatch(server, api, { timeControl: 'test-1s' });
  // White never moves.
  const over = await m.black.socket.nextOfType('game.over', 4000);
  assert.equal(over.payload.resultReason, 'timeout');
  assert.equal(over.payload.result, '0-1');
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.status, 'finished');
  assert.equal(stored.clocks.whiteMs, 0);
});

test('a move submitted after the clock ran out is refused and the game is lost on time', async () => {
  const m = await g.startMatch(server, api, { timeControl: 'test-1s' });
  await g.sleep(1100);
  const code = await g.errorOf(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0));
  assert.equal(code, 'GAME_OVER');
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.resultReason, 'timeout');
  assert.equal(stored.seq, 0);
});

test('the clock of the side to move runs, the other stays frozen; increment is added', async () => {
  const m = await g.startMatch(server, api, { timeControl: '3+2' });
  await g.sleep(300);
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  // 3 minutes - ~0.3 s + 2 s increment
  assert.ok(ack.clocks.whiteMs > 180000 && ack.clocks.whiteMs < 182000, `white clock ${ack.clocks.whiteMs}`);
  const a = (await api.get(`/api/v1/games/${m.gameId}`, m.white.user.token)).body.game.clocks;
  await g.sleep(250);
  const b = (await api.get(`/api/v1/games/${m.gameId}`, m.white.user.token)).body.game.clocks;
  assert.equal(a.whiteMs, b.whiteMs, "white's clock must not run while black is thinking");
  assert.ok(b.blackMs < a.blackMs, "black's clock must run");
});
