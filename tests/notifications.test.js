'use strict';

// Stored notifications with live push (D-051).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Notification } = require('../src/database/models');
const notifications = require('../src/modules/notifications/notifications.service');

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
const make = (user, n = 1, extra = {}) =>
  Promise.all(Array.from({ length: n }, (_, i) => notifications.create({ userId: user.id, type: 'system', data: { n: i }, ...extra })));
const list = async (user, query = '') => (await api.get(`/api/v1/notifications${query}`, user.token)).body;

test('every notification endpoint needs a login', async () => {
  assert.equal((await api.get('/api/v1/notifications')).status, 401);
  assert.equal((await api.get('/api/v1/notifications/unread-count')).status, 401);
  assert.equal((await api.post('/api/v1/notifications/read-all')).status, 401);
  assert.equal((await api.post('/api/v1/notifications/000000000000000000000001/read')).status, 401);
});

test('a new user has no notifications', async () => {
  const user = await newUser('n0');
  assert.deepEqual(await list(user), { items: [], nextCursor: null, unread: 0 });
  assert.deepEqual((await api.get('/api/v1/notifications/unread-count', user.token)).body, { unread: 0 });
});

test('a created notification is stored with its data, unread, and listed newest first', async () => {
  const user = await newUser('n1');
  for (let i = 1; i <= 3; i += 1) {
    await notifications.create({ userId: user.id, type: i === 2 ? 'reward' : 'system', data: { n: i } });
  }
  const body = await list(user);
  assert.equal(body.unread, 3);
  assert.deepEqual(body.items.map((n) => n.data.n), [3, 2, 1]);
  assert.equal(body.items[1].type, 'reward');
  assert.equal(body.items[0].readAt, null);
  assert.ok(body.items[0].id && body.items[0].createdAt);
  assert.equal('userId' in body.items[0], false, 'no internal fields are returned');
  assert.equal('key' in body.items[0], false);
});

test('notifications are paged with a cursor and can be filtered to unread', async () => {
  const user = await newUser('n2');
  for (let i = 1; i <= 5; i += 1) await notifications.create({ userId: user.id, type: 'system', data: { n: i } });
  const p1 = await list(user, '?limit=2');
  assert.deepEqual(p1.items.map((n) => n.data.n), [5, 4]);
  assert.ok(p1.nextCursor);
  const p2 = await list(user, `?limit=2&cursor=${p1.nextCursor}`);
  assert.deepEqual(p2.items.map((n) => n.data.n), [3, 2]);
  const p3 = await list(user, `?limit=2&cursor=${p2.nextCursor}`);
  assert.deepEqual(p3.items.map((n) => n.data.n), [1]);
  assert.equal(p3.nextCursor, null);

  await api.post(`/api/v1/notifications/${p1.items[0].id}/read`, undefined, user.token);
  const unread = await list(user, '?unread=true&limit=100');
  assert.deepEqual(unread.items.map((n) => n.data.n), [4, 3, 2, 1]);
  assert.equal(unread.unread, 4);
});

test('a notification is pushed live to every connected device of the user and to nobody else', async () => {
  const user = await newUser('n3');
  const other = await newUser('n3b');
  const phone = await g.authed(server.wsUrl, user.token);
  const tablet = await g.authed(server.wsUrl, user.token);
  const stranger = await g.authed(server.wsUrl, other.token);

  await notifications.create({ userId: user.id, type: 'reward', data: { coins: 20 } });
  for (const device of [phone, tablet]) {
    const push = await device.nextOfType('notification.new');
    assert.equal(push.payload.notification.type, 'reward');
    assert.deepEqual(push.payload.notification.data, { coins: 20 });
    assert.equal(push.payload.unread, 1);
  }
  assert.equal(await stranger.quietFor(300), true, 'another user receives nothing');
});

test('a user who is offline finds the notification later; creating one for an offline user works', async () => {
  const user = await newUser('n4');
  const result = await notifications.create({ userId: user.id, type: 'system', data: { hello: true } });
  assert.equal(result.duplicate, false);
  const body = await list(user);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0].data, { hello: true });
});

test('the same key creates one notification; the repeat returns the stored one and pushes nothing', async () => {
  const user = await newUser('n5');
  const socket = await g.authed(server.wsUrl, user.token);
  const first = await notifications.create({ userId: user.id, type: 'system', key: 'event-1' });
  await socket.nextOfType('notification.new');
  const again = await notifications.create({ userId: user.id, type: 'system', key: 'event-1' });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.notification.id, first.notification.id);
  assert.equal(await socket.quietFor(300), true, 'no second push');
  assert.equal(await Notification.countDocuments({ userId: user.id }), 1);

  const another = await newUser('n5b');
  const other = await notifications.create({ userId: another.id, type: 'system', key: 'event-1' });
  assert.equal(other.duplicate, false, 'keys are per user');
});

test('ten simultaneous creates with one key store exactly one notification', async () => {
  const user = await newUser('n6');
  const results = await Promise.all(Array.from({ length: 10 }, () => notifications.create({ userId: user.id, type: 'system', key: 'burst' })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(await Notification.countDocuments({ userId: user.id }), 1);
});

test('notifications without a key are never treated as duplicates of each other', async () => {
  const user = await newUser('n7');
  await make(user, 3);
  assert.equal(await Notification.countDocuments({ userId: user.id }), 3);
});

test('marking one notification read lowers the unread count, tells the other devices, and is safe to repeat', async () => {
  const user = await newUser('n8');
  await make(user, 2);
  const phone = await g.authed(server.wsUrl, user.token);
  const tablet = await g.authed(server.wsUrl, user.token);
  const [newest] = (await list(user)).items;

  const res = await api.post(`/api/v1/notifications/${newest.id}/read`, undefined, user.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, newest.id);
  assert.ok(res.body.readAt);
  assert.equal(res.body.unread, 1);
  for (const device of [phone, tablet]) {
    const push = await device.nextOfType('notification.read');
    assert.deepEqual(push.payload, { ids: [newest.id], unread: 1 });
  }

  const repeat = await api.post(`/api/v1/notifications/${newest.id}/read`, undefined, user.token);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.readAt, res.body.readAt, 'the first read time is kept');
  assert.equal(await phone.quietFor(300), true, 'a repeat pushes nothing');
  assert.equal((await list(user)).unread, 1);
});

test('read-all marks everything read, tells the devices once, and a second call changes nothing', async () => {
  const user = await newUser('n9');
  await make(user, 4);
  const phone = await g.authed(server.wsUrl, user.token);

  const res = await api.post('/api/v1/notifications/read-all', undefined, user.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { markedRead: 4, unread: 0 });
  const push = await phone.nextOfType('notification.read');
  assert.deepEqual(push.payload, { all: true, unread: 0 });

  const again = await api.post('/api/v1/notifications/read-all', undefined, user.token);
  assert.deepEqual(again.body, { markedRead: 0, unread: 0 });
  assert.equal(await phone.quietFor(300), true);
  assert.equal((await list(user, '?unread=true')).items.length, 0);
});

test('notifications are private: nobody can list or mark another user\'s', async () => {
  const owner = await newUser('n10');
  const intruder = await newUser('n10b');
  await make(owner, 2);
  const [mine] = (await list(owner)).items;

  assert.deepEqual(await list(intruder), { items: [], nextCursor: null, unread: 0 });
  const stolen = await api.post(`/api/v1/notifications/${mine.id}/read`, undefined, intruder.token);
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body.error.code, 'NOTIFICATION_NOT_FOUND');
  assert.equal((await list(owner)).unread, 2, 'the owner\'s notification is still unread');

  const unknown = await api.post('/api/v1/notifications/000000000000000000000001/read', undefined, owner.token);
  assert.equal(unknown.status, 404, 'an unknown id gets the same answer as someone else\'s');
  assert.equal((await api.post('/api/v1/notifications/not-an-id/read', undefined, owner.token)).status, 400);

  await api.post('/api/v1/notifications/read-all', undefined, intruder.token);
  assert.equal((await list(owner)).unread, 2, 'read-all only touches the caller\'s notifications');
});

test('bad list parameters are validation errors', async () => {
  const user = await newUser('n11');
  for (const q of ['?limit=0', '?limit=101', '?cursor=nope', '?unread=maybe']) {
    const res = await api.get(`/api/v1/notifications${q}`, user.token);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR', q);
  }
});

test('notifications expire after 30 days (TTL index and expiry date)', async () => {
  const user = await newUser('n12');
  const before = Date.now();
  const { notification } = await notifications.create({ userId: user.id, type: 'system' });
  const doc = await Notification.findById(notification.id).lean();
  const days = (doc.expireAt.getTime() - before) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29.99 && days < 30.01, `expires in ${days} days`);
  const indexes = await Notification.collection.indexes();
  assert.ok(indexes.some((i) => i.key.expireAt === 1 && i.expireAfterSeconds === 0), 'TTL index exists');
  assert.ok(indexes.some((i) => i.unique && i.key.key === 1 && i.partialFilterExpression), 'partial unique key index exists');
});

test('bad input from the code that creates notifications is rejected, and notify() never throws', async () => {
  const user = await newUser('n13');
  await assert.rejects(notifications.create({ userId: user.id, type: 'nope' }), TypeError);
  await assert.rejects(notifications.create({ userId: user.id, type: 'system', data: { big: 'x'.repeat(3000) } }), TypeError);
  assert.equal(await notifications.notify({ userId: user.id, type: 'nope' }), null);
  assert.equal(await Notification.countDocuments({ userId: user.id }), 0);
});

test('a database failure: create() reports a retryable error, notify() returns null, nothing is pushed or stored', async () => {
  const user = await newUser('n14');
  const socket = await g.authed(server.wsUrl, user.token);
  const original = Notification.create;
  Notification.create = async () => {
    throw new Error('database down');
  };
  try {
    await assert.rejects(notifications.create({ userId: user.id, type: 'system' }), { code: 'TEMPORARILY_UNAVAILABLE' });
    assert.equal(await notifications.notify({ userId: user.id, type: 'system' }), null);
  } finally {
    Notification.create = original;
  }
  assert.equal(await socket.quietFor(300), true);
  assert.equal(await Notification.countDocuments({ userId: user.id }), 0);
  const retry = await notifications.create({ userId: user.id, type: 'system' });
  assert.equal(retry.duplicate, false, 'the same call works once the database is back');
});
