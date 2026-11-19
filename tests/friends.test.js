'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeApi, registerUser, authedSocket } = require('./helpers');
const { Friendship } = require('../src/database/models');

let ctx;
let api;
let alice;
let bob;
let carol;
let dave;

before(async () => {
  ctx = await startTestServer();
  api = makeApi(ctx.base);
  alice = await registerUser(api, 'alice');
  bob = await registerUser(api, 'bob');
  carol = await registerUser(api, 'carol');
  dave = await registerUser(api, 'dave');
});
after(() => ctx.stop());

const requestTo = (from, username) => api.post('/api/v1/friends/requests', { username }, from.token);

test('all friend endpoints require authentication', async () => {
  assert.equal((await api.get('/api/v1/friends')).status, 401);
  assert.equal((await api.post('/api/v1/friends/requests', { username: 'bob' })).status, 401);
  assert.equal((await api.post('/api/v1/reports', {})).status, 401);
});

test('search finds users by username prefix, excludes self', async () => {
  const res = await api.get('/api/v1/users/search?q=bo', alice.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((u) => u.username), ['bob']);
  const self = await api.get('/api/v1/users/search?q=al', alice.token);
  assert.equal(self.body.items.length, 0);
  assert.equal((await api.get('/api/v1/users/search?q=a', alice.token)).status, 400);
});

test('send, list, and accept a friend request; only the recipient may accept', async () => {
  const sent = await requestTo(alice, 'bob');
  assert.equal(sent.status, 201);
  assert.equal(sent.body.status, 'pending');
  assert.equal((await requestTo(alice, 'bob')).body.error.code, 'REQUEST_EXISTS');

  const incoming = await api.get('/api/v1/friends/requests', bob.token);
  assert.equal(incoming.body.items.length, 1);
  assert.equal(incoming.body.items[0].user.username, 'alice');
  const outgoing = await api.get('/api/v1/friends/requests?direction=outgoing', alice.token);
  assert.equal(outgoing.body.items[0].user.username, 'bob');

  const requestId = sent.body.friendshipId;
  // Authorization: the requester and a third party cannot accept it.
  assert.equal((await api.post(`/api/v1/friends/requests/${requestId}/accept`, undefined, alice.token)).status, 404);
  assert.equal((await api.post(`/api/v1/friends/requests/${requestId}/accept`, undefined, carol.token)).status, 404);

  assert.equal((await api.post(`/api/v1/friends/requests/${requestId}/accept`, undefined, bob.token)).status, 200);
  const aliceFriends = await api.get('/api/v1/friends', alice.token);
  const bobFriends = await api.get('/api/v1/friends', bob.token);
  assert.equal(aliceFriends.body.items[0].user.username, 'bob');
  assert.equal(aliceFriends.body.items[0].online, false);
  assert.equal(bobFriends.body.items[0].user.username, 'alice');
  assert.equal((await requestTo(alice, 'bob')).body.error.code, 'ALREADY_FRIENDS');
});

test('invalid requests: self, unknown user, bad id', async () => {
  assert.equal((await requestTo(alice, 'alice')).body.error.code, 'CANNOT_ADD_SELF');
  assert.equal((await requestTo(alice, 'nobodyhere')).status, 404);
  assert.equal((await api.post('/api/v1/friends/requests/not-an-id/accept', undefined, alice.token)).status, 400);
});

test('reject and cancel remove the request; others cannot cancel it', async () => {
  const toCarol = await requestTo(alice, 'carol');
  assert.equal((await api.del(`/api/v1/friends/requests/${toCarol.body.friendshipId}`, carol.token)).status, 404);
  assert.equal((await api.del(`/api/v1/friends/requests/${toCarol.body.friendshipId}`, alice.token)).status, 204);

  const again = await requestTo(alice, 'carol');
  assert.equal((await api.post(`/api/v1/friends/requests/${again.body.friendshipId}/reject`, undefined, carol.token)).status, 204);
  assert.equal((await api.get('/api/v1/friends/requests', carol.token)).body.items.length, 0);
  assert.equal(await Friendship.countDocuments({ pairKey: Friendship.makePairKey(alice.id, carol.id) }), 0);
});

test('requesting someone who already asked you accepts it', async () => {
  await requestTo(carol, 'dave');
  const back = await requestTo(dave, 'carol');
  assert.equal(back.status, 200);
  assert.equal(back.body.autoAccepted, true);
  assert.equal((await api.get('/api/v1/friends', carol.token)).body.items.length, 1);
});

test('simultaneous requests between the same two users create exactly one friendship', async () => {
  const [a, b] = await Promise.all([requestTo(alice, 'dave'), requestTo(dave, 'alice')]);
  assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), `${a.status}/${b.status}`);
  const docs = await Friendship.find({ pairKey: Friendship.makePairKey(alice.id, dave.id) });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, 'accepted');
});

test('unfriend removes the friendship', async () => {
  assert.equal((await api.del(`/api/v1/friends/${dave.id}`, alice.token)).status, 204);
  assert.equal((await api.del(`/api/v1/friends/${dave.id}`, alice.token)).body.error.code, 'NOT_FRIENDS');
});

test('friend list pagination with cursor', async () => {
  // alice is friends with bob; add carol and dave again
  await requestTo(alice, 'carol');
  const carolReqs = await api.get('/api/v1/friends/requests', carol.token);
  await api.post(`/api/v1/friends/requests/${carolReqs.body.items[0].requestId}/accept`, undefined, carol.token);
  await requestTo(alice, 'dave');
  const daveReqs = await api.get('/api/v1/friends/requests', dave.token);
  await api.post(`/api/v1/friends/requests/${daveReqs.body.items[0].requestId}/accept`, undefined, dave.token);

  const page1 = await api.get('/api/v1/friends?limit=2', alice.token);
  assert.equal(page1.body.items.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = await api.get(`/api/v1/friends?limit=2&cursor=${page1.body.nextCursor}`, alice.token);
  assert.equal(page2.body.items.length, 1);
  assert.equal(page2.body.nextCursor, null);
  const names = [...page1.body.items, ...page2.body.items].map((i) => i.user.username).sort();
  assert.deepEqual(names, ['bob', 'carol', 'dave']);
  assert.equal((await api.get('/api/v1/friends?limit=0', alice.token)).status, 400);
});

test('blocking removes the friendship and hides users from each other', async () => {
  assert.equal((await api.post('/api/v1/friends/blocks', { userId: bob.id }, alice.token)).status, 204);
  assert.equal((await api.post('/api/v1/friends/blocks', { userId: bob.id }, alice.token)).status, 204); // idempotent
  assert.equal((await api.get('/api/v1/friends', bob.token)).body.items.length, 0);

  assert.equal((await requestTo(alice, 'bob')).body.error.code, 'USER_BLOCKED');
  assert.equal((await requestTo(bob, 'alice')).body.error.code, 'USER_NOT_FOUND'); // block is not revealed
  assert.equal((await api.get(`/api/v1/users/${alice.id}`, bob.token)).status, 404);
  assert.equal((await api.get('/api/v1/users/search?q=bo', alice.token)).body.items.length, 0);
  assert.equal((await api.get('/api/v1/users/search?q=al', bob.token)).body.items.length, 0);

  const list = await api.get('/api/v1/friends/blocks', alice.token);
  assert.equal(list.body.items[0].user.username, 'bob');

  assert.equal((await api.del(`/api/v1/friends/blocks/${bob.id}`, alice.token)).status, 204);
  assert.equal((await requestTo(bob, 'alice')).status, 201);
  assert.equal((await api.post('/api/v1/friends/blocks', { userId: alice.id }, alice.token)).status, 400);
});

test('friendRequestsFrom=nobody blocks new requests', async () => {
  const eve = await registerUser(api, 'eve');
  await api.patch('/api/v1/users/me/settings', { friendRequestsFrom: 'nobody' }, eve.token);
  assert.equal((await requestTo(alice, 'eve')).body.error.code, 'REQUESTS_DISABLED');
});

test('reports: validation, creation and duplicate protection', async () => {
  assert.equal((await api.post('/api/v1/reports', { userId: bob.id, reason: 'bogus' }, alice.token)).status, 400);
  assert.equal((await api.post('/api/v1/reports', { userId: alice.id, reason: 'spam' }, alice.token)).status, 400);
  const ok = await api.post('/api/v1/reports', { userId: bob.id, reason: 'cheating', details: 'engine use' }, alice.token);
  assert.equal(ok.status, 201);
  assert.equal((await api.post('/api/v1/reports', { userId: bob.id, reason: 'abuse' }, alice.token)).body.error.code, 'ALREADY_REPORTED');
});

test('friend request is pushed to the recipient over WebSocket', async () => {
  const zed = await registerUser(api, 'zed');
  const socket = await authedSocket(ctx.wsUrl, zed.token);
  await requestTo(alice, 'zed');
  const evt = await socket.nextOfType('friend.request');
  assert.equal(evt.payload.from.username, 'alice');
  socket.close();
});
