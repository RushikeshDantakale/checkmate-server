'use strict';

// Retention and cleanup (D-060): old finished games lose their move list (PGN stays), resolved reports
// are deleted after a year, nothing else is touched, dry run changes nothing, sessions keep a 30 day trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const h = require('./helpers');
const g = require('./gameHelpers');
const config = require('../src/config');
const retention = require('../src/modules/retention/retention.service');
const monitor = require('../src/modules/retention/retention.monitor');
const { migrateSessionTtl } = require('../src/modules/retention/retention.indexes');
const { Game, GameEvent, Report, Session, User } = require('../src/database/models');

const DAY = 24 * 60 * 60 * 1000;

let server;
let api;
let alice;
let bob;

before(async () => {
  server = await h.startTestServer();
  api = h.makeApi(server.base);
  alice = await h.registerUser(api, g.uniq('reta'));
  bob = await h.registerUser(api, g.uniq('retb'));
});

after(async () => {
  g.closeAll();
  await server.stop();
});

async function makeGame({ daysAgo, status = 'finished', pgn = '1. e4 e5 *', moves = 2 } = {}) {
  const ended = new Date(Date.now() - daysAgo * DAY);
  return Game.create({
    whiteId: alice.id,
    blackId: bob.id,
    whiteName: alice.username || 'alice',
    blackName: bob.username || 'bob',
    whiteRating: 1200,
    blackRating: 1200,
    timeControl: { id: '5+0', baseMs: 300000, incrementMs: 0 },
    status,
    result: status === 'finished' ? '1-0' : undefined,
    resultReason: status === 'finished' ? 'checkmate' : undefined,
    seq: moves,
    moves: Array.from({ length: moves }, (_, i) => ({
      seq: i + 1,
      uci: 'e2e4',
      san: 'e4',
      moveId: `m${i}-${Math.random().toString(36).slice(2, 8)}`,
      by: alice.id,
      at: ended,
      whiteMs: 1000,
      blackMs: 1000,
    })),
    clocks: { whiteMs: 1000, blackMs: 1000 },
    startedAt: ended,
    endedAt: ended,
    pgn,
  });
}

const rule = (report, id) => report.rules.find((r) => r.id === id);
const fresh = (id) => Game.findById(id).lean();

test('old finished games lose their move list; everything that must stay does stay', async () => {
  const old = await makeGame({ daysAgo: 91 });
  const edge = await makeGame({ daysAgo: 89 });
  const recent = await makeGame({ daysAgo: 5 });
  const live = await makeGame({ daysAgo: 300, status: 'active' });
  const noPgn = await makeGame({ daysAgo: 200, pgn: '' });
  const aborted = await makeGame({ daysAgo: 150, status: 'aborted' });

  const report = await retention.run();
  assert.equal(rule(report, 'game_moves').changed, 2, 'the 91 day old game and the 150 day old aborted game; the rest must stay');

  const o = await fresh(old._id);
  assert.deepEqual(o.moves, []);
  assert.ok(o.movesCompactedAt);
  assert.equal(o.pgn, '1. e4 e5 *');
  assert.equal(o.result, '1-0');
  assert.equal(o.resultReason, 'checkmate');
  assert.equal(o.seq, 2);
  assert.equal(o.status, 'finished');

  assert.deepEqual((await fresh(aborted._id)).moves, [], 'aborted games with a PGN are compacted too');
  assert.equal((await fresh(edge._id)).moves.length, 2, '89 days is not old enough');
  assert.equal((await fresh(recent._id)).moves.length, 2);
  assert.equal((await fresh(live._id)).moves.length, 2, 'a live game is never touched, however old');
  assert.equal((await fresh(noPgn._id)).moves.length, 2, 'without a stored PGN nothing is removed');

  const again = await retention.run();
  assert.equal(rule(again, 'game_moves').matched, 0, 'repeating changes nothing');
  assert.equal(rule(again, 'game_moves').changed, 0);
});

test('a compacted game is still readable: PGN and history work, the move list is empty and flagged', async () => {
  const game = await makeGame({ daysAgo: 120 });
  await retention.run();

  const read = await api.get(`/api/v1/games/${game._id}`, alice.token);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.game.moves, []);
  assert.equal(read.body.game.movesCompacted, true);
  assert.equal(read.body.game.pgn, '1. e4 e5 *');
  assert.equal(read.body.game.result, '1-0');

  const pgn = await api.get(`/api/v1/games/${game._id}/pgn`, bob.token);
  assert.equal(pgn.body.pgn, '1. e4 e5 *');

  const history = await api.get('/api/v1/games?limit=50', alice.token);
  const item = history.body.items.find((i) => i.id === String(game._id));
  assert.equal(item.moveCount, 2, 'the move count comes from seq, not from the removed list');

  const recent = await makeGame({ daysAgo: 1 });
  const normal = await api.get(`/api/v1/games/${recent._id}`, alice.token);
  assert.equal(normal.body.game.moves.length, 2);
  assert.equal(normal.body.game.movesCompacted, undefined);
});

test('a dry run only counts', async () => {
  const game = await makeGame({ daysAgo: 400 });
  const report = await retention.run({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.ok(rule(report, 'game_moves').matched >= 1);
  assert.equal(rule(report, 'game_moves').changed, 0);
  assert.equal((await fresh(game._id)).moves.length, 2);
  assert.equal((await fresh(game._id)).movesCompactedAt, undefined);
  await retention.run(); // leave the database clean for the next tests
});

test('a large backlog is worked off in batches', async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await makeGame({ daysAgo: 200 + i })).id);
  const report = await retention.run({ settings: { ...config.retention, batchSize: 2 } });
  assert.equal(rule(report, 'game_moves').matched, 5);
  assert.equal(rule(report, 'game_moves').changed, 5, 'three batches of 2, 2 and 1');
  for (const id of ids) assert.deepEqual((await fresh(id)).moves, []);
});

test('only resolved reports older than a year are deleted; open reports and recent ones stay', async () => {
  const mk = (status, daysAgo) =>
    Report.collection.insertOne({
      reporter: new mongoose.Types.ObjectId(alice.id),
      reported: new mongoose.Types.ObjectId(bob.id),
      reason: 'spam',
      status,
      createdAt: new Date(Date.now() - daysAgo * DAY),
      updatedAt: new Date(Date.now() - daysAgo * DAY),
    });
  const oldReviewed = (await mk('reviewed', 400)).insertedId;
  const oldDismissed = (await mk('dismissed', 366)).insertedId;
  const oldOpen = (await mk('open', 800)).insertedId;
  const recentReviewed = (await mk('reviewed', 100)).insertedId;

  const report = await retention.run();
  assert.equal(rule(report, 'resolved_reports').changed, 2);
  assert.equal(await Report.findById(oldReviewed), null);
  assert.equal(await Report.findById(oldDismissed), null);
  assert.ok(await Report.findById(oldOpen), 'an open report is never deleted, however old');
  assert.ok(await Report.findById(recentReviewed));
});

test('audit log, coin transactions, purchases, tournaments and messages are never touched', async () => {
  const db = mongoose.connection.db;
  const longAgo = new Date(Date.now() - 2000 * DAY);
  const names = ['admin_actions', 'transactions', 'purchases', 'tournaments', 'personal_messages', 'conversations'];
  const ids = {};
  for (const name of names) {
    ids[name] = (await db.collection(name).insertOne({ marker: 'retention-test', status: 'done', createdAt: longAgo, updatedAt: longAgo, endedAt: longAgo })).insertedId;
  }
  await retention.run();
  for (const name of names) {
    assert.ok(await db.collection(name).findOne({ _id: ids[name] }), `${name} must keep its old documents`);
  }
});

test('two runs at once: the second one does nothing', async () => {
  const [a, b] = await Promise.all([retention.run({ dryRun: true }), retention.run({ dryRun: true })]);
  assert.equal([a, b].filter((x) => x === null).length, 1);
});

test('sessions: the old index (delete at expiry) is migrated to 30 days after expiry, and only once', async () => {
  const coll = mongoose.connection.db.collection('sessions');
  const spec = async () => (await coll.indexes()).find((i) => i.name === 'expiresAt_1');
  assert.equal((await spec()).expireAfterSeconds, 30 * DAY / 1000, 'a fresh database already has the new setting');

  // Simulate a database created before D-060.
  await mongoose.connection.db.command({ collMod: 'sessions', index: { keyPattern: { expiresAt: 1 }, expireAfterSeconds: 0 } });
  assert.equal((await spec()).expireAfterSeconds, 0);
  assert.equal(await migrateSessionTtl(), true);
  assert.equal((await spec()).expireAfterSeconds, 30 * DAY / 1000);
  assert.equal(await migrateSessionTtl(), false, 'nothing to do the second time');

  // A plain index cannot be converted: it is dropped and created again by ensureIndexes.
  await coll.dropIndex('expiresAt_1');
  await coll.createIndex({ expiresAt: 1 }, { name: 'expiresAt_1' });
  assert.equal(await migrateSessionTtl(), true);
  assert.equal(await spec(), undefined);
  await Session.createIndexes();
  assert.equal((await spec()).expireAfterSeconds, 30 * DAY / 1000);
});

test('sessions are reported but never deleted by the job itself (the TTL index does that)', async () => {
  const report = await retention.run({ dryRun: true });
  const sessions = rule(report, 'old_sessions');
  assert.equal(sessions.mode, 'ttl');
  const real = await retention.run();
  assert.equal(rule(real, 'old_sessions').changed, 0);
});

test('game_events keep their 90 day TTL index (already in place before D-060)', async () => {
  const idx = (await GameEvent.collection.indexes()).find((i) => i.key.at === 1);
  assert.equal(idx.expireAfterSeconds, 90 * DAY / 1000);
});

test('the background job never starts in tests; its tick works and never throws', async () => {
  assert.equal(config.retention.enabled, false);
  monitor.start();
  monitor.stop();
  const report = await monitor.tick();
  assert.equal(report.rules.length, 3);
});

test('admin preview shows what would be cleaned, changes nothing, and is admin only', async () => {
  const game = await makeGame({ daysAgo: 500 });
  const admin = await h.registerUser(api, g.uniq('retadm'));
  await User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });

  const res = await api.get('/api/v1/admin/retention', admin.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.deepEqual(res.body.rules.map((r) => r.id), ['game_moves', 'resolved_reports', 'old_sessions']);
  assert.ok(res.body.rules[0].matched >= 1);
  assert.ok(res.body.storage && 'level' in res.body.storage);
  assert.equal((await fresh(game._id)).moves.length, 2, 'the preview did not change anything');

  const denied = await api.get('/api/v1/admin/retention', alice.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'ADMIN_ONLY');
  assert.equal((await api.get('/api/v1/admin/retention')).status, 401);
});
