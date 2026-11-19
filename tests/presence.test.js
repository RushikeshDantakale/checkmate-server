'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeApi, registerUser, authedSocket } = require('./helpers');

let ctx;
let api;
let pat;
let quinn;
let rita;

async function befriend(a, b) {
  const sent = await api.post('/api/v1/friends/requests', { username: b.name }, a.token);
  await api.post(`/api/v1/friends/requests/${sent.body.friendshipId}/accept`, undefined, b.token);
}

before(async () => {
  ctx = await startTestServer();
  api = makeApi(ctx.base);
  pat = await registerUser(api, 'pat');
  quinn = await registerUser(api, 'quinn');
  rita = await registerUser(api, 'rita'); // not a friend of pat
  await befriend(pat, quinn);
});
after(() => ctx.stop());

test('friends are told when a user comes online and goes offline; strangers are not', async () => {
  const quinnSocket = await authedSocket(ctx.wsUrl, quinn.token);
  const ritaSocket = await authedSocket(ctx.wsUrl, rita.token);

  const patSocket = await authedSocket(ctx.wsUrl, pat.token);
  const online = await quinnSocket.nextOfType('presence.update');
  assert.deepEqual(online.payload, { userId: pat.id, online: true });
  assert.equal(await ritaSocket.quietFor(300), true);

  patSocket.close();
  const offline = await quinnSocket.nextOfType('presence.update');
  assert.deepEqual(offline.payload, { userId: pat.id, online: false });
  quinnSocket.close();
  ritaSocket.close();
});

test('friend list shows online status', async () => {
  const quinnSocket = await authedSocket(ctx.wsUrl, quinn.token);
  const list = await api.get('/api/v1/friends', pat.token);
  assert.equal(list.body.items[0].online, true);
  quinnSocket.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await api.get('/api/v1/friends', pat.token)).body.items[0].online, false);
});

test('multiple devices: user stays online until the LAST device disconnects', async () => {
  const watcher = await authedSocket(ctx.wsUrl, quinn.token);
  const second = (await api.post('/api/v1/auth/login', { identifier: 'pat', password: 'pat-password-1' })).body;
  const phone = await authedSocket(ctx.wsUrl, pat.token);
  assert.equal((await watcher.nextOfType('presence.update')).payload.online, true);
  const tablet = await authedSocket(ctx.wsUrl, second.accessToken);
  assert.equal(await watcher.quietFor(300), true); // second device: no duplicate "online"

  phone.close();
  assert.equal(await watcher.quietFor(400), true); // still online via tablet
  tablet.close();
  assert.equal((await watcher.nextOfType('presence.update')).payload.online, false);
  watcher.close();
});

test('showOnlineStatus=false hides the user from friends', async () => {
  await api.patch('/api/v1/users/me/settings', { showOnlineStatus: false }, pat.token);
  const watcher = await authedSocket(ctx.wsUrl, quinn.token);
  const patSocket = await authedSocket(ctx.wsUrl, pat.token);
  assert.equal(await watcher.quietFor(400), true);
  assert.equal((await api.get('/api/v1/friends', quinn.token)).body.items[0].online, false);
  patSocket.close();
  watcher.close();
});
