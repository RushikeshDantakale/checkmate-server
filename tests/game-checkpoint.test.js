'use strict';

// Clock checkpoints: while a game is active, the running clock is written to the database
// regularly, so a crash loses at most one checkpoint interval of clock accuracy (D-012).
process.env.GAME_CHECKPOINT_INTERVAL_MS = '100';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
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

test('the checkpoint writes the running clock of the side to move to the database', async () => {
  const m = await g.startMatch(server, api, { timeControl: '5+0' });
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  const afterMove = await Game.findById(m.gameId).lean();
  // A checkpoint (every 100 ms here) may already have run between the ack and this read, so black
  // has "barely" used time rather than exactly none. (Fixes the timing race noted in CURRENT_STATUS.)
  assert.ok(
    afterMove.clocks.blackMs <= 300000 && afterMove.clocks.blackMs > 299000,
    `black has barely used any time yet (${afterMove.clocks.blackMs})`
  );

  // Black is thinking. Wait for a checkpoint NEWER than the state we just read; without checkpoints
  // the stored reference time would never move.
  const readStartedAt = new Date(afterMove.clocks.turnStartedAt).getTime();
  const checkpointed = await g.waitFor(async () => {
    const stored = await Game.findById(m.gameId).lean();
    const newer = new Date(stored.clocks.turnStartedAt).getTime() > readStartedAt;
    return newer && stored.clocks.blackMs < afterMove.clocks.blackMs ? stored : null;
  }, 3000);

  assert.ok(checkpointed.clocks.blackMs > 290000, 'only a little time has passed');
  assert.ok(
    new Date(checkpointed.clocks.turnStartedAt).getTime() > new Date(afterMove.clocks.turnStartedAt).getTime(),
    'the checkpoint moves the reference time forward'
  );
  assert.equal(checkpointed.clocks.whiteMs, afterMove.clocks.whiteMs, "white's clock does not run on black's turn");
  assert.equal(checkpointed.seq, 1, 'a checkpoint never changes the move sequence');
  assert.equal(checkpointed.moves.length, 1);

  // The reported clock is the same whether it is computed from the snapshot or from the move.
  const view = (await api.get(`/api/v1/games/${m.gameId}`, m.black.user.token)).body.game.clocks;
  assert.ok(view.blackMs <= checkpointed.clocks.blackMs && view.blackMs > checkpointed.clocks.blackMs - 2000);
});
