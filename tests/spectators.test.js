'use strict';

// Spectators (D-041, D-042): authorization, limit, updates, count, clean-up, game over, live list.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '3000';
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';
process.env.SPECTATOR_MAX_PER_GAME = '2';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');
const { Game } = require('../src/database/models');

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

/** A new user with a socket, friends with `player` ('white' or 'black') of match `m`. */
async function friendOf(m, side = 'white') {
  const spec = await r.makePlayer(server, api, 'sp');
  await r.makeFriends(spec, m[side]);
  return spec;
}

const watch = (spec, m) => g.call(spec.socket, 'spectate.join', { gameId: m.gameId }, 'spectate.state');

test('a friend of a player can join a live game and gets the full game; both players see the count', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  const spec = await friendOf(m, 'black'); // a friend of EITHER player is enough
  const state = await watch(spec, m);
  assert.equal(state.game.id, m.gameId);
  assert.equal(state.game.moves.length, 1);
  assert.equal(state.game.moves[0].san, 'e4');
  assert.equal(state.spectators, 1);
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 1);
  assert.equal((await m.black.socket.nextOfType('spectate.count')).payload.gameId, m.gameId);
});

test('an accepted move reaches the spectator after it is stored; a retried move is not sent twice', async () => {
  const m = await g.startMatch(server, api);
  const spec = await friendOf(m);
  await watch(spec, m);
  const msg = g.moveMsg(m.gameId, 0);
  await g.call(m.white.socket, 'game.move', msg, 'game.move.ack');
  const update = await spec.socket.nextOfType('spectate.update');
  assert.equal(update.payload.lastMove.san, 'e4');
  assert.equal(update.payload.game.seq, 1);
  assert.equal(update.payload.game.fen, g.MOVES[0].fen);
  assert.equal(update.payload.game.moves, undefined, 'updates carry only the newest move');
  assert.equal((await Game.findById(m.gameId).lean()).seq, 1, 'already durable when the spectator hears about it');
  await g.call(m.white.socket, 'game.move', msg, 'game.move.ack'); // retry
  assert.equal(await spec.socket.quietFor(300), true, 'a duplicate must not produce a second update');
});

test('strangers, blocked friends, unknown games and the players themselves cannot spectate', async () => {
  const m = await g.startMatch(server, api);
  const stranger = await r.makePlayer(server, api, 'st');
  assert.equal(await g.errorOf(stranger.socket, 'spectate.join', { gameId: m.gameId }), 'GAME_NOT_FOUND');

  const blocked = await friendOf(m);
  await r.makeBlock(blocked, m.black); // a block with EITHER player is enough
  assert.equal(await g.errorOf(blocked.socket, 'spectate.join', { gameId: m.gameId }), 'GAME_NOT_FOUND');

  assert.equal(await g.errorOf(stranger.socket, 'spectate.join', { gameId: '0'.repeat(24) }), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(m.white.socket, 'spectate.join', { gameId: m.gameId }), 'YOU_ARE_A_PLAYER');
  assert.equal(await g.errorOf(m.black.socket, 'spectate.join', { gameId: m.gameId }), 'YOU_ARE_A_PLAYER');
  assert.equal(await g.errorOf(stranger.socket, 'spectate.join', { gameId: 'nope' }), 'INVALID_PAYLOAD');
});

test('a spectator cannot play, resign or use the match chat', async () => {
  const m = await g.startMatch(server, api);
  const spec = await friendOf(m);
  await watch(spec, m);
  assert.equal(await g.errorOf(spec.socket, 'game.move', g.moveMsg(m.gameId, 0)), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(spec.socket, 'game.resign', { gameId: m.gameId }), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(spec.socket, 'chat.match.send', { gameId: m.gameId, text: 'hi' }), 'GAME_NOT_FOUND');
  assert.equal((await Game.findById(m.gameId).lean()).seq, 0);
});

test('the spectator limit counts users, not devices, and frees up when someone leaves', async () => {
  const m = await g.startMatch(server, api);
  const a = await friendOf(m);
  const b = await friendOf(m);
  const c = await friendOf(m);
  await watch(a, m);
  assert.equal((await watch(b, m)).spectators, 2);
  assert.equal(await g.errorOf(c.socket, 'spectate.join', { gameId: m.gameId }), 'SPECTATOR_LIMIT');

  const aSecondDevice = await g.authed(server.wsUrl, a.user.token);
  const again = await g.call(aSecondDevice, 'spectate.join', { gameId: m.gameId }, 'spectate.state');
  assert.equal(again.spectators, 2, 'a second device of the same user is not a new spectator');

  await g.call(b.socket, 'spectate.leave', { gameId: m.gameId }, 'spectate.leave.ok');
  assert.equal((await watch(c, m)).spectators, 2);
});

test('leaving stops the updates and tells the players the count', async () => {
  const m = await g.startMatch(server, api);
  const spec = await friendOf(m);
  await watch(spec, m);
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 1);
  const left = await g.call(spec.socket, 'spectate.leave', { gameId: m.gameId }, 'spectate.leave.ok');
  assert.equal(left.spectators, 0);
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 0);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(await spec.socket.quietFor(300), true);
  // Leaving again, or leaving a game never watched, is fine.
  const twice = await g.call(spec.socket, 'spectate.leave', { gameId: m.gameId }, 'spectate.leave.ok');
  assert.equal(twice.spectators, 0);
});

test('a spectator whose connection drops is removed and the players see the count fall', async () => {
  const m = await g.startMatch(server, api);
  const a = await friendOf(m);
  const b = await friendOf(m);
  await watch(a, m);
  await watch(b, m);
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 1);
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 2);
  a.socket.terminate();
  assert.equal((await m.white.socket.nextOfType('spectate.count')).payload.count, 1);
  // b is still watching and still gets updates.
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal((await b.socket.nextOfType('spectate.update')).payload.game.seq, 1);
});

test('when the game ends spectators get spectate.over with the result and PGN, then are dropped', async () => {
  const m = await g.startMatch(server, api);
  const spec = await friendOf(m);
  await watch(spec, m);
  const outcome = { result: '1-0', reason: 'checkmate' };
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0, { fields: { outcome } }), 'game.move.ack');
  const over = await spec.socket.nextOfType('spectate.over');
  assert.equal(over.payload.status, 'finished');
  assert.equal(over.payload.result, '1-0');
  assert.equal(over.payload.resultReason, 'checkmate');
  assert.match(over.payload.pgn, /1\. e4 1-0/);
  assert.equal(await spec.socket.quietFor(300), true, 'no second "over" and no further updates');
  assert.equal(await g.errorOf(spec.socket, 'spectate.join', { gameId: m.gameId }), 'GAME_OVER');
});

test('GET /games/live lists friends\' live games for those who may watch them', async () => {
  const m = await g.startMatch(server, api);
  const spec = await friendOf(m);
  const stranger = await r.makePlayer(server, api, 'st');
  const blocked = await friendOf(m);
  await r.makeBlock(blocked, m.black);

  const list = await api.get('/api/v1/games/live', spec.user.token);
  assert.equal(list.status, 200);
  const item = list.body.items.find((x) => x.id === m.gameId);
  assert.ok(item, 'the friend\'s live game is listed');
  assert.equal(item.white.id, m.white.user.id);
  assert.equal(item.spectators, 0);
  assert.equal(item.moves, undefined);

  await watch(spec, m);
  assert.equal((await api.get('/api/v1/games/live', spec.user.token)).body.items.find((x) => x.id === m.gameId).spectators, 1);

  assert.equal((await api.get('/api/v1/games/live', stranger.user.token)).body.items.length, 0);
  assert.equal((await api.get('/api/v1/games/live', blocked.user.token)).body.items.some((x) => x.id === m.gameId), false);
  // The players themselves do not see their own game in the list of games to watch.
  assert.equal((await api.get('/api/v1/games/live', m.white.user.token)).body.items.some((x) => x.id === m.gameId), false);
  assert.equal((await api.get('/api/v1/games/live')).status, 401);
});
