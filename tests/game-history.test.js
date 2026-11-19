'use strict';

// Game history and completed-game retrieval (D-043, D-041).
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '3000';
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');

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

/** Ends the game: white's first move is checkmate. */
async function finish(m, result = '1-0') {
  const outcome = { result, reason: result === '1-0' ? 'checkmate' : 'stalemate' };
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0, { fields: { outcome } }), 'game.move.ack');
  await m.black.socket.nextOfType('game.over');
}

test('history lists only my finished games, newest first, as short summaries', async () => {
  const m = await g.startMatch(server, api);
  assert.equal((await api.get('/api/v1/games', m.white.user.token)).body.items.length, 0, 'a live game is not history');
  await finish(m);
  const res = await api.get('/api/v1/games', m.black.user.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  const item = res.body.items[0];
  assert.equal(item.id, m.gameId);
  assert.equal(item.yourColor, 'b');
  assert.equal(item.result, '1-0');
  assert.equal(item.resultReason, 'checkmate');
  assert.equal(item.status, 'finished');
  assert.equal(item.moveCount, 1);
  assert.equal(item.timeControl.id, '5+0');
  assert.deepEqual(item.ratingChange, { white: 16, black: -16 });
  assert.equal(item.moves, undefined);
  assert.equal(item.pgn, undefined);
  assert.equal((await api.get('/api/v1/games', m.white.user.token)).body.items[0].yourColor, 'w');
  assert.equal((await api.get('/api/v1/games')).status, 401);
});

test('history is paginated with a cursor and never shows other people\'s games', async () => {
  const a = await h.registerUser(api, g.uniq('hist'));
  const sa = await g.authed(server.wsUrl, a.token);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const b = await h.registerUser(api, g.uniq('opp'));
    const sb = await g.authed(server.wsUrl, b.token);
    await g.call(sa, 'queue.join', { timeControl: '5+0', rated: false }, 'queue.joined');
    await g.call(sb, 'queue.join', { timeControl: '5+0', rated: false }, 'queue.joined');
    const started = await sa.nextOfType('game.started');
    await sb.nextOfType('game.started');
    const gameId = started.payload.game.id;
    const aIsWhite = started.payload.yourColor === 'w';
    const mover = aIsWhite ? sa : sb;
    const outcome = { result: '1/2-1/2', reason: 'stalemate' };
    await g.call(mover, 'game.move', g.moveMsg(gameId, 0, { fields: { outcome } }), 'game.move.ack');
    await sa.nextOfType('game.over');
    ids.push(gameId);
  }
  const first = await api.get('/api/v1/games?limit=2', a.token);
  assert.deepEqual(first.body.items.map((x) => x.id), [ids[2], ids[1]]);
  assert.ok(first.body.nextCursor);
  const second = await api.get(`/api/v1/games?limit=2&cursor=${first.body.nextCursor}`, a.token);
  assert.deepEqual(second.body.items.map((x) => x.id), [ids[0]]);
  assert.equal(second.body.nextCursor, null);
  assert.equal((await api.get('/api/v1/games?limit=0', a.token)).status, 400);
  assert.equal((await api.get('/api/v1/games?limit=51', a.token)).status, 400);
  assert.equal((await api.get('/api/v1/games?cursor=abc', a.token)).status, 400);
});

test('a friend of a player can read a COMPLETED game and its PGN; strangers and blocked friends cannot', async () => {
  const m = await g.startMatch(server, api);
  const friend = await r.makePlayer(server, api, 'fr');
  await r.makeFriends(friend, m.white);
  const stranger = await r.makePlayer(server, api, 'st');
  const blocked = await r.makePlayer(server, api, 'bl');
  await r.makeFriends(blocked, m.black);
  await r.makeBlock(blocked, m.white);

  // While the game is live, non-players cannot read it over REST (they use spectate.join).
  assert.equal((await api.get(`/api/v1/games/${m.gameId}`, friend.user.token)).status, 404);
  assert.equal((await api.get(`/api/v1/games/${m.gameId}/pgn`, friend.user.token)).status, 404);

  await finish(m);

  const game = await api.get(`/api/v1/games/${m.gameId}`, friend.user.token);
  assert.equal(game.status, 200);
  assert.equal(game.body.game.status, 'finished');
  assert.equal(game.body.game.moves.length, 1);
  const pgn = await api.get(`/api/v1/games/${m.gameId}/pgn`, friend.user.token);
  assert.equal(pgn.status, 200);
  assert.match(pgn.body.pgn, /1\. e4 1-0/);

  for (const who of [stranger, blocked]) {
    assert.equal((await api.get(`/api/v1/games/${m.gameId}`, who.user.token)).status, 404);
    assert.equal((await api.get(`/api/v1/games/${m.gameId}/pgn`, who.user.token)).status, 404);
  }
  // The players keep full access, and an unknown id is the same 404 as "not allowed".
  assert.equal((await api.get(`/api/v1/games/${m.gameId}`, m.white.user.token)).status, 200);
  assert.equal((await api.get(`/api/v1/games/${'0'.repeat(24)}`, stranger.user.token)).status, 404);
  assert.equal((await api.get('/api/v1/games/not-an-id', stranger.user.token)).status, 400);
});
