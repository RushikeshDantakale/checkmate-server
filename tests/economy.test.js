'use strict';

// Coin wallet, ledger, daily reward, packs bought with coins (D-046 to D-049).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Transaction, Wallet } = require('../src/database/models');
const wallet = require('../src/modules/economy/wallet.service');
const store = require('../src/modules/economy/store.service');

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

const newUser = (prefix) => h.registerUser(api, g.uniq(prefix));
const grant = (user, amount, key) => wallet.credit({ key, userId: user.id, amount, reason: 'admin_grant' });
const summary = async (user) => (await api.get('/api/v1/wallet', user.token)).body;

test('wallet, store and purchases need a login', async () => {
  for (const path of ['/api/v1/wallet', '/api/v1/wallet/transactions', '/api/v1/store/catalogue']) {
    assert.equal((await api.get(path)).status, 401, path);
  }
  assert.equal((await api.post('/api/v1/wallet/daily-reward')).status, 401);
  assert.equal((await api.post('/api/v1/store/packs/pack_classic/buy')).status, 401);
});

test('a new user has an empty wallet, owns nothing and may claim the daily reward', async () => {
  const user = await newUser('w1');
  const s = await summary(user);
  assert.equal(s.coins, 0);
  assert.deepEqual(s.entitlements, { premium: false, packs: [] });
  assert.equal(s.dailyReward.amount, 20);
  assert.equal(s.dailyReward.available, true);
});

test('the daily reward can be claimed once per day; the ledger shows it once', async () => {
  const user = await newUser('d1');
  const first = await api.post('/api/v1/wallet/daily-reward', undefined, user.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.claimed, 20);
  assert.equal(first.body.coins, 20);

  const second = await api.post('/api/v1/wallet/daily-reward', undefined, user.token);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'DAILY_ALREADY_CLAIMED');

  const s = await summary(user);
  assert.equal(s.coins, 20);
  assert.equal(s.dailyReward.available, false);
  const history = await api.get('/api/v1/wallet/transactions', user.token);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].reason, 'daily_reward');
  assert.equal(history.body.items[0].delta, 20);
});

test('five simultaneous daily-reward claims pay exactly once', async () => {
  const user = await newUser('d2');
  const results = await Promise.all(
    Array.from({ length: 5 }, () => api.post('/api/v1/wallet/daily-reward', undefined, user.token))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  assert.equal((await summary(user)).coins, 20);
});

test('the daily reward follows the UTC day', async () => {
  const user = await newUser('d3');
  const day1 = await store.claimDaily(user.id, new Date('2030-01-01T10:00:00Z'));
  assert.equal(day1.coins, 20);
  assert.equal(day1.nextAt, '2030-01-02T00:00:00.000Z');
  await assert.rejects(store.claimDaily(user.id, new Date('2030-01-01T23:59:59Z')), { code: 'DAILY_ALREADY_CLAIMED' });
  const day2 = await store.claimDaily(user.id, new Date('2030-01-02T00:00:01Z'));
  assert.equal(day2.coins, 40);
});

test('the catalogue lists coin bundles, packs and premium', async () => {
  const user = await newUser('c1');
  const res = await api.get('/api/v1/store/catalogue', user.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.coinBundles.length > 0);
  assert.ok(res.body.packs.some((p) => p.id === 'pack_classic' && p.coinPrice === 300));
  assert.equal(res.body.premium.id, 'premium');
});

test('buying a pack without enough coins is refused and changes nothing', async () => {
  const user = await newUser('b1');
  await grant(user, 100, `seed:${user.id}`);
  const res = await api.post('/api/v1/store/packs/pack_classic/buy', undefined, user.token);
  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'INSUFFICIENT_COINS');
  const s = await summary(user);
  assert.equal(s.coins, 100);
  assert.deepEqual(s.entitlements.packs, []);
  assert.equal(await Transaction.countDocuments({ userId: user.id, state: 'pending' }), 0, 'no half-done row is left behind');
});

test('a pack bought with coins is charged once, owned, and a retry does not charge again', async () => {
  const user = await newUser('b2');
  await grant(user, 700, `seed:${user.id}`);
  const buy = await api.post('/api/v1/store/packs/pack_classic/buy', undefined, user.token);
  assert.equal(buy.status, 200);
  assert.equal(buy.body.duplicate, false);
  assert.equal(buy.body.coins, 400);
  assert.deepEqual(buy.body.entitlements.packs, ['pack_classic']);

  const retry = await api.post('/api/v1/store/packs/pack_classic/buy', undefined, user.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.coins, 400, 'not charged twice');

  const other = await api.post('/api/v1/store/packs/pack_comedy/buy', undefined, user.token);
  assert.equal(other.body.coins, 100);
  assert.deepEqual(other.body.entitlements.packs.sort(), ['pack_classic', 'pack_comedy']);
});

test('unknown packs, and packs sent with odd ids, answer 404', async () => {
  const user = await newUser('b3');
  assert.equal((await api.post('/api/v1/store/packs/pack_nope/buy', undefined, user.token)).body.error.code, 'PACK_NOT_FOUND');
  assert.equal((await api.post('/api/v1/store/packs/PACK%24%7Bx%7D/buy', undefined, user.token)).status, 404);
});

test('a pack the user already owns (granted another way) is not sold again', async () => {
  const user = await newUser('b4');
  await grant(user, 500, `seed:${user.id}`);
  await store.grantPack(user.id, 'pack_comedy');
  const res = await api.post('/api/v1/store/packs/pack_comedy/buy', undefined, user.token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_OWNED');
  assert.equal((await summary(user)).coins, 500);
});

test('simultaneous spends can never take the balance below zero', async () => {
  const user = await newUser('s1');
  await grant(user, 250, `seed:${user.id}`);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      wallet.debit({ key: `spend:${user.id}:${i}`, userId: user.id, amount: 100, reason: 'admin_grant' })
    )
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 2);
  assert.equal(refused.length, 3);
  for (const r of refused) assert.equal(r.reason.code, 'INSUFFICIENT_COINS');
  assert.equal((await summary(user)).coins, 50);
  assert.equal(await Transaction.countDocuments({ userId: user.id }), 3, 'seed + 2 spends; refused spends leave no row');
});

test('the same key is applied once; the same key for something else is a conflict', async () => {
  const user = await newUser('k1');
  const a = await grant(user, 30, 'key-once');
  const b = await grant(user, 30, 'key-once');
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal((await summary(user)).coins, 30);
  await assert.rejects(grant(user, 99, 'key-once'), { code: 'TRANSACTION_KEY_CONFLICT' });
  const stranger = await newUser('k2');
  await assert.rejects(grant(stranger, 30, 'key-once'), { code: 'TRANSACTION_KEY_CONFLICT' });
  assert.equal((await summary(stranger)).coins, 0);
});

test('the same key sent ten times at once is applied once', async () => {
  const user = await newUser('k3');
  const results = await Promise.all(Array.from({ length: 10 }, () => grant(user, 5, 'burst')));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal((await summary(user)).coins, 5);
});

test('crash after charging but before granting: the retry finishes it and the user is charged once', async () => {
  const user = await newUser('r1');
  await grant(user, 700, `seed:${user.id}`);
  // What a crash between wallet update and completer leaves behind.
  const tx = await Transaction.create({
    key: `pack:${user.id}:pack_classic`,
    userId: user.id,
    delta: -300,
    reason: 'pack_purchase',
    ref: 'pack_classic',
  });
  await Wallet.updateOne({ userId: user.id }, { $inc: { coins: -300 }, $push: { recentTxIds: String(tx._id) } });
  let s = await summary(user);
  assert.equal(s.coins, 400);
  assert.deepEqual(s.entitlements.packs, [], 'charged but not yet granted');

  const retry = await api.post('/api/v1/store/packs/pack_classic/buy', undefined, user.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.coins, 400, 'not charged a second time');
  assert.deepEqual(retry.body.entitlements.packs, ['pack_classic']);
  assert.equal((await Transaction.findById(tx._id)).state, 'applied');
});

test('crash after charging, and the client never retries: the reconciler grants the pack', async () => {
  const user = await newUser('r2');
  await grant(user, 700, `seed:${user.id}`);
  const tx = await Transaction.create({
    key: `pack:${user.id}:pack_comedy`,
    userId: user.id,
    delta: -300,
    reason: 'pack_purchase',
    ref: 'pack_comedy',
  });
  await Wallet.updateOne({ userId: user.id }, { $inc: { coins: -300 }, $push: { recentTxIds: String(tx._id) } });

  const out = await wallet.reconcile(Date.now() + 120000);
  assert.equal(out.healed, 1);
  assert.equal(out.discarded, 0);
  const s = await summary(user);
  assert.equal(s.coins, 400);
  assert.deepEqual(s.entitlements.packs, ['pack_comedy']);
  assert.equal((await Transaction.findById(tx._id)).state, 'applied');
});

test('a stale spend that never reached the wallet is discarded, not charged later', async () => {
  const user = await newUser('r3');
  await grant(user, 700, `seed:${user.id}`);
  const tx = await Transaction.create({
    key: `pack:${user.id}:pack_classic`,
    userId: user.id,
    delta: -300,
    reason: 'pack_purchase',
    ref: 'pack_classic',
  });
  const out = await wallet.reconcile(Date.now() + 120000);
  assert.equal(out.discarded, 1);
  assert.equal(await Transaction.findById(tx._id), null);
  const s = await summary(user);
  assert.equal(s.coins, 700);
  assert.deepEqual(s.entitlements.packs, []);
});

test('a stale credit that never reached the wallet is applied by the reconciler', async () => {
  const user = await newUser('r4');
  const tx = await Transaction.create({ key: `late:${user.id}`, userId: user.id, delta: 50, reason: 'admin_grant' });
  const out = await wallet.reconcile(Date.now() + 120000);
  assert.equal(out.healed, 1);
  assert.equal((await summary(user)).coins, 50);
  assert.equal((await Transaction.findById(tx._id)).state, 'applied');
  // Running it again changes nothing.
  assert.deepEqual(await wallet.reconcile(Date.now() + 120000), { healed: 0, discarded: 0 });
  assert.equal((await summary(user)).coins, 50);
});

test('a fresh pending row is left alone (it may belong to a request that is still running)', async () => {
  const user = await newUser('r5');
  await Transaction.create({ key: `fresh:${user.id}`, userId: user.id, delta: 10, reason: 'admin_grant' });
  assert.deepEqual(await wallet.reconcile(Date.now()), { healed: 0, discarded: 0 });
});

test('the wallet remembers only the last 50 transaction ids, and an old key still cannot be applied twice', async () => {
  const user = await newUser('m1');
  for (let i = 0; i < 55; i += 1) await grant(user, 1, `many:${user.id}:${i}`);
  const doc = await Wallet.findOne({ userId: user.id }).lean();
  assert.equal(doc.coins, 55);
  assert.equal(doc.recentTxIds.length, 50);
  const again = await grant(user, 1, `many:${user.id}:0`); // far outside the 50-id window
  assert.equal(again.duplicate, true);
  assert.equal((await summary(user)).coins, 55);
});

test('transaction history is paged newest first and is private', async () => {
  const user = await newUser('h1');
  const other = await newUser('h2');
  for (let i = 1; i <= 5; i += 1) {
    await wallet.credit({ key: `hist:${user.id}:${i}`, userId: user.id, amount: i, reason: 'admin_grant', ref: `n${i}` });
  }
  await grant(other, 9, `hist-other:${other.id}`);

  const p1 = (await api.get('/api/v1/wallet/transactions?limit=2', user.token)).body;
  assert.deepEqual(p1.items.map((t) => t.ref), ['n5', 'n4']);
  assert.ok(p1.nextCursor);
  const p2 = (await api.get(`/api/v1/wallet/transactions?limit=2&cursor=${p1.nextCursor}`, user.token)).body;
  assert.deepEqual(p2.items.map((t) => t.ref), ['n3', 'n2']);
  const p3 = (await api.get(`/api/v1/wallet/transactions?limit=2&cursor=${p2.nextCursor}`, user.token)).body;
  assert.deepEqual(p3.items.map((t) => t.ref), ['n1']);
  assert.equal(p3.nextCursor, null);

  const mine = (await api.get('/api/v1/wallet/transactions?limit=100', other.token)).body;
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].delta, 9);
});

test('a bad cursor or limit is a validation error', async () => {
  const user = await newUser('h3');
  assert.equal((await api.get('/api/v1/wallet/transactions?cursor=nope', user.token)).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await api.get('/api/v1/wallet/transactions?limit=0', user.token)).status, 400);
  assert.equal((await api.get('/api/v1/wallet/transactions?limit=101', user.token)).status, 400);
});
