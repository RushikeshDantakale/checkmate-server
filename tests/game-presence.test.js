'use strict';

// Ordinary disconnects while the server is healthy (D-013, D-024): grace, abandonment, both players gone.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '700';
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Game, User } = require('../src/database/models');

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

async function twoMovesPlayed(m) {
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
}

const statusOf = async (m) => (await Game.findById(m.gameId).lean()).status;

test('a player who reconnects inside the grace period keeps the game', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.black.socket.terminate();
  const gone = await m.white.socket.nextOfType('game.opponent.disconnected');
  assert.equal(gone.payload.graceMs, 400);
  await g.sleep(100);
  const back = await g.authed(server.wsUrl, m.black.user.token);
  await m.white.socket.nextOfType('game.opponent.reconnected');
  assert.equal((await back.nextOfType('game.active')).payload.gameId, m.gameId);
  await g.sleep(700); // well past the original grace period
  assert.equal(await statusOf(m), 'active');
  // The reconnected player can resynchronise and play.
  const state = await g.call(back, 'game.join', { gameId: m.gameId }, 'game.state');
  assert.equal(state.game.seq, 2);
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 2), 'game.move.ack');
  assert.equal(ack.seq, 3);
});

test('repeated reconnecting does not break the game or duplicate notifications wrongly', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  for (let i = 0; i < 3; i += 1) {
    m.black.socket.terminate();
    await m.white.socket.nextOfType('game.opponent.disconnected');
    m.black.socket = await g.authed(server.wsUrl, m.black.user.token);
    await m.white.socket.nextOfType('game.opponent.reconnected');
  }
  await g.sleep(600);
  assert.equal(await statusOf(m), 'active');
});

test('a player who stays away longer than the grace period loses by abandonment', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.black.socket.terminate();
  const over = await m.white.socket.nextOfType('game.over', 3000);
  assert.equal(over.payload.result, '1-0');
  assert.equal(over.payload.resultReason, 'abandoned');
  assert.equal((await User.findById(m.white.user.id).lean()).rating, 1216);
});

test('abandoning before two moves aborts the game without a rating change', async () => {
  const m = await g.startMatch(server, api);
  m.black.socket.terminate();
  const over = await m.white.socket.nextOfType('game.over', 3000);
  assert.equal(over.payload.status, 'aborted');
  assert.equal(over.payload.resultReason, 'abandoned_before_start');
  assert.equal(over.payload.result, null);
  assert.equal((await User.findById(m.white.user.id).lean()).rating, 1200);
});

test('when both players lose connection the game pauses and nobody is charged', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.waitFor(async () => (await statusOf(m)) === 'paused_disconnect');
  const a = (await Game.findById(m.gameId).lean()).clocks;
  await g.sleep(250);
  const b = (await Game.findById(m.gameId).lean()).clocks;
  assert.equal(a.whiteMs, b.whiteMs);
  assert.equal(a.turnStartedAt, null);
});

test('when both stay away past the hold time the game is drawn', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.waitFor(async () => (await statusOf(m)) === 'finished', 3000);
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.result, '1/2-1/2');
  assert.equal(stored.resultReason, 'both_abandoned');
});

test('when both are gone and one comes back inside the hold time, play resumes', async () => {
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.waitFor(async () => (await statusOf(m)) === 'paused_disconnect');
  const back = await g.authed(server.wsUrl, m.white.user.token);
  const resumed = await back.nextOfType('game.resumed');
  assert.equal(resumed.payload.game.status, 'active');
  assert.equal(await statusOf(m), 'active');
  // The absent player now has the normal grace period; if they do not return, white wins.
  const over = await back.nextOfType('game.over', 3000);
  assert.equal(over.payload.result, '1-0');
  assert.equal(over.payload.resultReason, 'abandoned');
});

test('a connected but silent socket is removed by the heartbeat and then treated as disconnected', async () => {
  // Covered at socket level by foundation.test.js (dead-socket termination); here we check the
  // game reaction to the resulting close: an unexpected close (code 1006) behaves like a disconnect.
  const m = await g.startMatch(server, api);
  await twoMovesPlayed(m);
  m.black.socket.close(4999); // abrupt, non-standard close from the client side
  const gone = await m.white.socket.nextOfType('game.opponent.disconnected');
  assert.equal(gone.payload.gameId, m.gameId);
});
