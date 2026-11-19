'use strict';

// Storage monitor (D-028): levels, the /health/storage endpoint, and behaviour with the database down.
process.env.NODE_ENV = 'test';
process.env.STORAGE_LIMIT_MB = '512';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startTestServer } = require('./helpers');
const storageMonitor = require('../src/modules/health/storage.monitor');

const MB = 1024 * 1024;
let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.stop();
});

/** Makes the monitor see a database of the given size (data + indexes, in MB). */
function fakeDatabaseSize(t, usedMb) {
  t.mock.method(mongoose.connection.db, 'stats', async () => ({
    storageSize: Math.round(usedMb * 0.9 * MB),
    indexSize: Math.round(usedMb * 0.1 * MB),
  }));
}

test('levelFor: ok below 80%, warning from 80%, critical from 90%', () => {
  assert.equal(storageMonitor.levelFor(0), 'ok');
  assert.equal(storageMonitor.levelFor(79.9), 'ok');
  assert.equal(storageMonitor.levelFor(80), 'warning');
  assert.equal(storageMonitor.levelFor(89.9), 'warning');
  assert.equal(storageMonitor.levelFor(90), 'critical');
  assert.equal(storageMonitor.levelFor(100), 'critical');
});

test('GET /health/storage measures on demand when nothing was measured yet', async () => {
  const res = await fetch(`${server.base}/health/storage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, 'ok'); // a fresh test database is tiny
  assert.equal(typeof body.percentUsed, 'number');
  assert.equal(body.limitMb, 512);
  assert.ok(body.checkedAt);
});

test('checkNow reports ok, warning and critical for the right sizes', async (t) => {
  fakeDatabaseSize(t, 400); // 78.1%
  assert.equal((await storageMonitor.checkNow()).level, 'ok');

  t.mock.restoreAll();
  fakeDatabaseSize(t, 420); // 82.0%
  const warning = await storageMonitor.checkNow();
  assert.equal(warning.level, 'warning');
  assert.equal(warning.percentUsed, 82);

  t.mock.restoreAll();
  fakeDatabaseSize(t, 470); // 91.8%
  assert.equal((await storageMonitor.checkNow()).level, 'critical');
});

test('GET /health/storage shows the level and still answers 200 when critical', async (t) => {
  fakeDatabaseSize(t, 480);
  await storageMonitor.checkNow();
  const res = await fetch(`${server.base}/health/storage`);
  assert.equal(res.status, 200); // never 503: pingers must not fail because storage is high
  const body = await res.json();
  assert.equal(body.level, 'critical');
  assert.equal(body.percentUsed, 93.8);
});

test('checkNow keeps the last status and does not query when the database is down', async (t) => {
  fakeDatabaseSize(t, 420);
  const before = await storageMonitor.checkNow();
  assert.equal(before.level, 'warning');

  t.mock.restoreAll();
  const stats = t.mock.method(mongoose.connection.db, 'stats', async () => {
    throw new Error('must not be called while the database is down');
  });
  // Pretend the connection is down (readyState 0). The own property is removed again in `finally`,
  // so the real (inherited) readyState is back for the other tests and for server.stop().
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 0 });
  try {
    const during = await storageMonitor.checkNow();
    assert.deepEqual(during, before);
    assert.equal(stats.mock.callCount(), 0);
  } finally {
    delete mongoose.connection.readyState;
  }
  assert.equal(mongoose.connection.readyState, 1);
});

test('a failing stats call rejects (the timer logs it) and keeps the previous status', async (t) => {
  fakeDatabaseSize(t, 420);
  const known = await storageMonitor.checkNow();

  t.mock.restoreAll();
  t.mock.method(mongoose.connection.db, 'stats', async () => {
    throw new Error('stats unavailable');
  });
  await assert.rejects(() => storageMonitor.checkNow(), /stats unavailable/);
  assert.deepEqual(storageMonitor.getStatus(), known);

  const res = await fetch(`${server.base}/health/storage`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).level, 'warning');
});
