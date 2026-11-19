'use strict';

// Real-money purchases verified by the store (D-050), using the fake verifier.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Purchase } = require('../src/database/models');
const verifiers = require('../src/modules/purchases/verifiers');
const fake = require('../src/modules/purchases/verifiers/fake');
const disabled = require('../src/modules/purchases/verifiers/disabled');
const purchases = require('../src/modules/purchases/purchases.service');

let server;
let api;

before(async () => {
  server = await h.startTestServer();
  api = h.makeApi(server.base);
});

after(async () => {
  verifiers.setVerifierForTests(null);
  g.closeAll();
  await server.stop();
});

beforeEach(() => {
  fake.reset();
  verifiers.setVerifierForTests(fake);
});

const newUser = (prefix) => h.registerUser(api, g.uniq(prefix));
const token = (kind = 'valid') => `fake-${kind}-${g.uniq('tok')}`;
const redeem = (user, productId, purchaseToken) => api.post('/api/v1/purchases', { productId, purchaseToken }, user.token);
const wallet = async (user) => (await api.get('/api/v1/wallet', user.token)).body;
const verifyCalls = () => fake.calls.filter((c) => c.op === 'verify').length;

test('purchases need a login', async () => {
  assert.equal((await api.get('/api/v1/purchases')).status, 401);
  assert.equal((await api.post('/api/v1/purchases', { productId: 'coins_100', purchaseToken: 'x' })).status, 401);
});

test('purchases are switched off until a verifier is configured (default)', async () => {
  verifiers.setVerifierForTests(disabled);
  const user = await newUser('p0');
  const res = await redeem(user, 'coins_100', token());
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'PURCHASES_NOT_CONFIGURED');
  assert.equal(await Purchase.countDocuments({ userId: user.id }), 0);
  assert.equal((await wallet(user)).coins, 0);
});

test('a bad request body is a validation error', async () => {
  const user = await newUser('p1');
  assert.equal((await api.post('/api/v1/purchases', { productId: 'coins_100' }, user.token)).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await api.post('/api/v1/purchases', { purchaseToken: 'x' }, user.token)).status, 400);
  assert.equal((await api.post('/api/v1/purchases', { productId: '', purchaseToken: '' }, user.token)).status, 400);
});

test('a verified coin bundle credits the coins once, consumes the purchase and never exposes the token', async () => {
  const user = await newUser('p2');
  const t = token();
  const res = await redeem(user, 'coins_500', t);
  assert.equal(res.status, 201);
  assert.equal(res.body.coins, 500);
  assert.equal(res.body.purchase.state, 'acknowledged');
  assert.equal(res.body.finalized, true);
  assert.equal(res.body.duplicate, false);
  assert.ok(fake.calls.some((c) => c.op === 'consume' && c.productId === 'coins_500'), 'a coin bundle is consumed so it can be bought again');
  assert.equal(JSON.stringify(res.body).includes(t), false, 'the token is not returned');

  const history = (await api.get('/api/v1/wallet/transactions', user.token)).body.items;
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, 'coin_bundle');
  assert.equal(history[0].delta, 500);
});

test('a retry of the same purchase answers success again but changes nothing and does not ask the store again', async () => {
  const user = await newUser('p3');
  const t = token();
  await redeem(user, 'coins_100', t);
  const retry = await redeem(user, 'coins_100', t);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.coins, 100, 'not credited twice');
  assert.equal(verifyCalls(), 1);
  assert.equal(await Purchase.countDocuments({ userId: user.id }), 1);
});

test('one store purchase cannot be redeemed by a second user', async () => {
  const first = await newUser('p4a');
  const thief = await newUser('p4b');
  const t = token();
  await redeem(first, 'coins_100', t);
  const res = await redeem(thief, 'coins_100', t);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PURCHASE_ALREADY_REDEEMED');
  assert.equal((await wallet(thief)).coins, 0);
  assert.equal((await wallet(first)).coins, 100);
});

test('a token redeemed for one product cannot be reused for a different product', async () => {
  const user = await newUser('p5');
  const t = token();
  await redeem(user, 'coins_100', t);
  const res = await redeem(user, 'coins_1200', t);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PURCHASE_PRODUCT_MISMATCH');
  assert.equal((await wallet(user)).coins, 100);
});

test('a pack and premium bought with real money become entitlements; the pack is acknowledged, not consumed', async () => {
  const user = await newUser('p6');
  const pack = await redeem(user, 'pack_grandmaster', token());
  assert.equal(pack.status, 201);
  assert.deepEqual(pack.body.entitlements.packs, ['pack_grandmaster']);
  assert.ok(fake.calls.some((c) => c.op === 'acknowledge' && c.productId === 'pack_grandmaster'));

  const premium = await redeem(user, 'premium', token());
  assert.equal(premium.body.entitlements.premium, true);
  assert.deepEqual(premium.body.entitlements.packs, ['pack_grandmaster']);
  assert.equal(premium.body.coins, 0, 'no coins were involved');
});

test('unknown products and every non-purchased store answer are refused and give nothing', async () => {
  const user = await newUser('p7');
  const cases = [
    ['coins_nope', token(), 400, 'UNKNOWN_PRODUCT'],
    ['coins_100', token('garbage'), 400, 'PURCHASE_INVALID'],
    ['coins_100', token('pending'), 409, 'PURCHASE_PENDING'],
    ['coins_100', token('cancelled'), 400, 'PURCHASE_CANCELLED'],
    ['coins_100', token('otheraccount'), 403, 'PURCHASE_WRONG_ACCOUNT'],
  ];
  for (const [productId, t, status, code] of cases) {
    const res = await redeem(user, productId, t);
    assert.equal(res.status, status, code);
    assert.equal(res.body.error.code, code);
  }
  assert.equal(await Purchase.countDocuments({ userId: user.id }), 0, 'nothing was stored');
  const w = await wallet(user);
  assert.equal(w.coins, 0);
  assert.deepEqual(w.entitlements, { premium: false, packs: [] });
});

test('a store outage during verification is retryable and gives nothing', async () => {
  const user = await newUser('p8');
  const original = fake.verify;
  fake.verify = async () => {
    throw new Error('store unreachable');
  };
  try {
    const res = await redeem(user, 'coins_100', token());
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'PURCHASE_VERIFICATION_UNAVAILABLE');
  } finally {
    fake.verify = original;
  }
  assert.equal(await Purchase.countDocuments({ userId: user.id }), 0);
  assert.equal((await wallet(user)).coins, 0);
  const retry = await redeem(user, 'coins_100', token());
  assert.equal(retry.status, 201, 'the same request works once the store is back');
});

test('ten simultaneous redeems of one new purchase credit the coins exactly once', async () => {
  const user = await newUser('p9');
  const t = token();
  const results = await Promise.all(Array.from({ length: 10 }, () => redeem(user, 'coins_100', t)));
  for (const r of results) assert.ok(r.status === 200 || r.status === 201, `unexpected status ${r.status}`);
  assert.equal((await wallet(user)).coins, 100);
  assert.equal(await Purchase.countDocuments({ userId: user.id }), 1);
});

test('the store cannot be told (acknowledge fails): the user keeps the item and the reconciler finishes it later', async () => {
  const user = await newUser('p10');
  fake.failFinalize = true;
  const res = await redeem(user, 'coins_100', token());
  assert.equal(res.status, 201, 'the request still succeeds: the user already has the item');
  assert.equal(res.body.coins, 100);
  assert.equal(res.body.finalized, false);
  assert.equal(res.body.purchase.state, 'granted');

  fake.failFinalize = false;
  const out = await purchases.reconcile(Date.now() + 120000);
  assert.ok(out.continued >= 1);
  const row = await Purchase.findOne({ userId: user.id });
  assert.equal(row.state, 'acknowledged');
  assert.equal((await wallet(user)).coins, 100, 'the reconciler never credits again');
});

test('crash after the store said yes but before the item was granted: the reconciler grants it once', async () => {
  const user = await newUser('p11');
  const t = token();
  await Purchase.create({ userId: user.id, productId: 'coins_100', kind: 'coin_bundle', purchaseToken: t, state: 'verified', verifier: 'fake' });
  assert.equal((await wallet(user)).coins, 0, 'verified but not granted yet');

  await purchases.reconcile(Date.now() + 120000);
  assert.equal((await wallet(user)).coins, 100);
  assert.equal((await Purchase.findOne({ userId: user.id })).state, 'acknowledged');

  // The app retries the redeem afterwards: still exactly once.
  const retry = await redeem(user, 'coins_100', t);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.coins, 100);
  await purchases.reconcile(Date.now() + 240000);
  assert.equal((await wallet(user)).coins, 100);
});

test('the purchase list is newest first, paged, private and has no tokens', async () => {
  const user = await newUser('p12');
  const other = await newUser('p13');
  await redeem(user, 'coins_100', token());
  await redeem(user, 'pack_classic', token());
  await redeem(user, 'premium', token());
  await redeem(other, 'coins_500', token());

  const p1 = (await api.get('/api/v1/purchases?limit=2', user.token)).body;
  assert.deepEqual(p1.items.map((p) => p.productId), ['premium', 'pack_classic']);
  assert.ok(p1.nextCursor);
  const p2 = (await api.get(`/api/v1/purchases?limit=2&cursor=${p1.nextCursor}`, user.token)).body;
  assert.deepEqual(p2.items.map((p) => p.productId), ['coins_100']);
  assert.equal(p2.nextCursor, null);
  assert.equal(JSON.stringify([p1, p2]).includes('fake-valid-'), false, 'no token in the list');

  const mine = (await api.get('/api/v1/purchases', other.token)).body;
  assert.deepEqual(mine.items.map((p) => p.productId), ['coins_500']);
  assert.equal((await api.get('/api/v1/purchases?cursor=nope', user.token)).body.error.code, 'VALIDATION_ERROR');
});
