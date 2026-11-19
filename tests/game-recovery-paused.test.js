'use strict';

// A game that is ALREADY paused when the server (re)starts has no timer in RAM.
// Recovery must give it a hold timer again, otherwise the game stays paused forever
// and its players can never start another game.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '300';
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

for (const pausedStatus of ['paused_server_recovery', 'paused_disconnect']) {
  test(`a game already ${pausedStatus} at boot is settled after the hold time if nobody returns`, async () => {
    const m = await g.startMatch(server, api);
    await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
    await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');

    // The server dies and both players are gone. The game was paused by an earlier boot.
    monitor.stop();
    m.white.socket.terminate();
    m.black.socket.terminate();
    await g.sleep(100);
    await Game.updateOne({ _id: m.gameId }, { $set: { status: pausedStatus, 'clocks.turnStartedAt': null } });

    // New boot: recovery runs, and finds a game that is not `active` any more.
    monitor.start();
    await monitor.recover();

    const stored = await g.waitFor(async () => {
      const game = await Game.findById(m.gameId).lean();
      return game.status === 'finished' ? game : null;
    }, 3000);
    assert.equal(stored.result, '1/2-1/2');
    assert.equal(stored.resultReason, 'both_abandoned');
  });
}
