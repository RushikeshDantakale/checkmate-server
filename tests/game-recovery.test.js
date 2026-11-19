'use strict';

// Recovery: process restart, clocks during downtime, database failure, lost acknowledgements.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '5000'; // long: these tests must not hit the hold timeout
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Game } = require('../src/database/models');
const monitor = require('../src/modules/games/games.monitor');

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

const gameOf = async (m, who = 'white') => (await api.get(`/api/v1/games/${m.gameId}`, m[who].user.token)).body.game;

test('after a simulated crash the game is restored from the database, paused, with its clocks and moves', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  const before = await Game.findById(m.gameId).lean();

  // "Crash": all timers and RAM state are lost and every socket drops.
  monitor.stop();
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.sleep(100);

  // "Boot": the monitor starts again and recovery runs.
  monitor.start();
  const paused = await monitor.recover();
  assert.equal(paused, 1);

  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.status, 'paused_server_recovery');
  assert.equal(stored.seq, 2);
  assert.equal(stored.moves.length, 2);
  assert.equal(stored.fen, g.MOVES[1].fen);
  assert.equal(stored.clocks.turnStartedAt, null);
  // Clock snapshot is the last confirmed one (a checkpoint may only have moved it forward by running time).
  assert.ok(stored.clocks.whiteMs <= before.clocks.whiteMs && stored.clocks.whiteMs > before.clocks.whiteMs - 2000);
  assert.equal(stored.clocks.blackMs, before.clocks.blackMs);

  // Downtime is not charged: while paused the clocks do not move.
  const a = (await gameOf(m)).clocks;
  await g.sleep(300);
  const b = (await gameOf(m)).clocks;
  assert.deepEqual(a, b);
  assert.equal(b.running, false);
  assert.equal((await gameOf(m)).status, 'paused_server_recovery');
});

test('a recovered game resumes only when BOTH players are back, then play continues', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  monitor.stop();
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.sleep(100);
  monitor.start();
  await monitor.recover();

  const whiteBack = await g.authed(server.wsUrl, m.white.user.token);
  const active = await whiteBack.nextOfType('game.active');
  assert.equal(active.payload.gameId, m.gameId);
  await g.sleep(150);
  assert.equal((await gameOf(m)).status, 'paused_server_recovery', 'one player is not enough after a server outage');

  const blackBack = await g.authed(server.wsUrl, m.black.user.token);
  const resumed = await whiteBack.nextOfType('game.resumed');
  await blackBack.nextOfType('game.resumed');
  assert.equal(resumed.payload.game.status, 'active');
  assert.equal(resumed.payload.game.seq, 2);

  const ack = await g.call(whiteBack, 'game.move', g.moveMsg(m.gameId, 2), 'game.move.ack');
  assert.equal(ack.seq, 3);
  const stored = await Game.findById(m.gameId).lean();
  assert.equal(stored.moves.length, 3);
  assert.equal(stored.status, 'active');
});

test('the clock of the mover does not run during the outage', async () => {
  const m = await g.startMatch(server, api, { timeControl: '10+0' });
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  monitor.stop();
  m.white.socket.terminate();
  m.black.socket.terminate();
  await g.sleep(100);
  monitor.start();
  await monitor.recover();
  const frozen = (await gameOf(m)).clocks.whiteMs;
  await g.sleep(700); // "downtime"
  const whiteBack = await g.authed(server.wsUrl, m.white.user.token);
  await g.authed(server.wsUrl, m.black.user.token);
  await whiteBack.nextOfType('game.resumed');
  const after = (await gameOf(m)).clocks.whiteMs;
  assert.ok(frozen - after < 400, `white lost ${frozen - after} ms; downtime must not be charged`);
});

test('a database write failure rejects the move: no ack, no broadcast, nothing stored; the retry then works', async () => {
  const m = await g.startMatch(server, api);
  const msg = g.moveMsg(m.gameId, 0);
  const realUpdateOne = Game.updateOne;
  Game.updateOne = () => Promise.reject(new Error('simulated MongoDB outage'));
  let code;
  try {
    code = await g.errorOf(m.white.socket, 'game.move', msg);
  } finally {
    Game.updateOne = realUpdateOne;
  }
  assert.equal(code, 'TEMPORARILY_UNAVAILABLE');
  assert.equal(await m.black.socket.quietFor(300), true, 'opponent must not see an unpersisted move');
  assert.equal((await Game.findById(m.gameId).lean()).seq, 0);

  const ack = await g.call(m.white.socket, 'game.move', msg, 'game.move.ack'); // same moveId
  assert.equal(ack.seq, 1);
  assert.equal(ack.duplicate, false);
  assert.equal((await Game.findById(m.gameId).lean()).moves.length, 1);
});

test('a database read failure also gives a retryable error instead of a crash', async () => {
  const m = await g.startMatch(server, api);
  const realFindById = Game.findById;
  Game.findById = () => ({ lean: () => Promise.reject(new Error('simulated MongoDB outage')) });
  let code;
  try {
    code = await g.errorOf(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0));
  } finally {
    Game.findById = realFindById;
  }
  assert.equal(code, 'TEMPORARILY_UNAVAILABLE');
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(ack.seq, 1);
});

test('MongoDB coming back (reconnected event) pauses and resumes live games without charging the outage', async () => {
  const m = await g.startMatch(server, api, { timeControl: '10+0' });
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  const mongoose = require('mongoose');
  mongoose.connection.emit('reconnected');
  // Both players are online, so recovery pauses and immediately resumes the game.
  const resumed = await m.white.socket.nextOfType('game.resumed', 3000);
  assert.equal(resumed.payload.game.status, 'active');
  assert.equal(resumed.payload.game.seq, 1);
  const ack = await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  assert.equal(ack.seq, 2);
});

test('recover() is safe to run repeatedly and ignores finished games', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.resign', { gameId: m.gameId }, 'game.resign.ok');
  const before = await Game.findById(m.gameId).lean();
  await monitor.recover();
  await monitor.recover();
  const after = await Game.findById(m.gameId).lean();
  assert.equal(after.status, 'finished');
  assert.equal(after.result, before.result);
});
