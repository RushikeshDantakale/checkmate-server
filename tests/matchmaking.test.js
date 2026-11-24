'use strict';

// Matchmaking queue and friend invitations.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '3000';
process.env.MATCH_TICK_MS = '50';
process.env.INVITE_TTL_MS = '800';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Game, User, MatchmakingEntry } = require('../src/database/models');

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

async function player(connect = true) {
  const user = await h.registerUser(api, g.uniq('mm'));
  const socket = connect ? await g.authed(server.wsUrl, user.token) : null;
  return { user, socket };
}

async function befriend(a, b) {
  const first = await api.post('/api/v1/friends/requests', { username: b.user.name }, a.user.token);
  assert.ok([200, 201].includes(first.status));
  const second = await api.post('/api/v1/friends/requests', { username: a.user.name }, b.user.token);
  assert.ok([200, 201].includes(second.status));
}

test('players with different time controls are not matched', async () => {
  const a = await player();
  const b = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '5+0' }, 'queue.joined');
  await g.call(b.socket, 'queue.join', { timeControl: '3+0' }, 'queue.joined');
  assert.equal(await a.socket.quietFor(300), true);
  assert.equal(await b.socket.quietFor(100), true);
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
  await g.call(b.socket, 'queue.leave', {}, 'queue.left');
});

test('rated and casual players are not matched with each other', async () => {
  const a = await player();
  const b = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '5+0', rated: true }, 'queue.joined');
  await g.call(b.socket, 'queue.join', { timeControl: '5+0', rated: false }, 'queue.joined');
  assert.equal(await a.socket.quietFor(300), true);
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
  await g.call(b.socket, 'queue.leave', {}, 'queue.left');
});

test('players far apart in rating are not matched immediately', async () => {
  const a = await player();
  const b = await player();
  await User.updateOne({ _id: b.user.id }, { $set: { rating: 2000 } });
  await g.call(a.socket, 'queue.join', { timeControl: '10+0' }, 'queue.joined');
  await g.call(b.socket, 'queue.join', { timeControl: '10+0' }, 'queue.joined');
  assert.equal(await a.socket.quietFor(400), true);
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
  await g.call(b.socket, 'queue.leave', {}, 'queue.left');
});

test('leaving the queue prevents a match; the queue entry is removed', async () => {
  const a = await player();
  const b = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '15+10' }, 'queue.joined');
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
  assert.equal(await MatchmakingEntry.countDocuments({ userId: a.user.id }), 0);
  await g.call(b.socket, 'queue.join', { timeControl: '15+10' }, 'queue.joined');
  assert.equal(await b.socket.quietFor(300), true);
  await g.call(b.socket, 'queue.leave', {}, 'queue.left');
});

test('a player who disconnects while queued is removed from the queue', async () => {
  const a = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '30+0' }, 'queue.joined');
  a.socket.terminate();
  await g.waitFor(async () => (await MatchmakingEntry.countDocuments({ userId: a.user.id })) === 0);
});

test('time controls are dynamic: any id inside the limits is accepted and normalised (D-063)', async () => {
  const a = await player();
  const joined = await g.call(a.socket, 'queue.join', { timeControl: '05+03', rated: false }, 'queue.joined');
  assert.equal(joined.timeControlId, '5+3');
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
  const odd = await g.call(a.socket, 'queue.join', { timeControl: '2+1', rated: false }, 'queue.joined');
  assert.equal(odd.timeControlId, '2+1');
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
});

test('unknown time controls and bad payloads are rejected', async () => {
  const a = await player();
  for (const bad of ['abc', '500+0', '5+999', '0+0', '5+-1', '5', '5+3+1']) {
    assert.equal(await g.errorOf(a.socket, 'queue.join', { timeControl: bad }), 'INVALID_TIME_CONTROL', bad);
  }
  assert.equal(await g.errorOf(a.socket, 'queue.join', { timeControl: 5 }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(a.socket, 'queue.join', {}), 'INVALID_PAYLOAD');
});

test('a player already in a game cannot queue or be invited; one live game per user', async () => {
  const m = await g.startMatch(server, api);
  assert.equal(await g.errorOf(m.white.socket, 'queue.join', { timeControl: '5+0' }), 'ALREADY_IN_GAME');
  const c = await player();
  await g.call(c.socket, 'queue.join', { timeControl: '5+0' }, 'queue.joined');
  await g.call(c.socket, 'queue.leave', {}, 'queue.left');
  assert.equal(await Game.countDocuments({ status: 'active', $or: [{ whiteId: m.white.user.id }, { blackId: m.white.user.id }] }), 1);
});

test('invitations need friendship', async () => {
  const a = await player();
  const b = await player();
  assert.equal(await g.errorOf(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }), 'NOT_FRIENDS');
  assert.equal(await g.errorOf(a.socket, 'invite.send', { userId: a.user.id, timeControl: '5+0' }), 'INVALID_OPPONENT');
  assert.equal(await g.errorOf(a.socket, 'invite.send', { userId: 'nope', timeControl: '5+0' }), 'INVALID_PAYLOAD');
});

test('an invitation to an offline friend is refused', async () => {
  const a = await player();
  const b = await player(false);
  await befriend(a, b);
  assert.equal(await g.errorOf(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }), 'USER_OFFLINE');
});

test('invite, accept: both get the game and the inviter is told', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const sent = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '3+2', rated: false }, 'invite.sent');
  const received = await b.socket.nextOfType('invite.received');
  assert.equal(received.payload.inviteId, sent.inviteId);
  assert.equal(received.payload.from.id, a.user.id);
  assert.equal(received.payload.timeControlId, '3+2');

  // Only the invited friend can accept.
  assert.equal(await g.errorOf(a.socket, 'invite.accept', { inviteId: sent.inviteId }), 'INVITE_NOT_FOUND');
  const accepted = await g.call(b.socket, 'invite.accept', { inviteId: sent.inviteId }, 'invite.accepted');
  const startedA = await a.socket.nextOfType('game.started');
  const startedB = await b.socket.nextOfType('game.started');
  assert.equal(startedA.payload.game.id, accepted.gameId);
  assert.equal(startedB.payload.game.id, accepted.gameId);
  assert.equal(startedA.payload.game.rated, false);
  assert.notEqual(startedA.payload.yourColor, startedB.payload.yourColor);
  const updated = await a.socket.nextOfType('invite.updated');
  assert.equal(updated.payload.status, 'accepted');
  assert.equal(updated.payload.gameId, accepted.gameId);

  // Accepting twice is refused; both are now busy.
  assert.equal(await g.errorOf(b.socket, 'invite.accept', { inviteId: sent.inviteId }), 'INVITE_NOT_FOUND');
  assert.equal(await g.errorOf(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }), 'ALREADY_IN_GAME');
});

test('decline and cancel notify the other side; an answered invitation cannot be answered again', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const one = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }, 'invite.sent');
  await b.socket.nextOfType('invite.received');
  await g.call(b.socket, 'invite.decline', { inviteId: one.inviteId }, 'invite.declined');
  assert.equal((await a.socket.nextOfType('invite.updated')).payload.status, 'declined');
  assert.equal(await g.errorOf(b.socket, 'invite.accept', { inviteId: one.inviteId }), 'INVITE_NOT_FOUND');

  const two = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }, 'invite.sent');
  await b.socket.nextOfType('invite.received');
  await g.call(a.socket, 'invite.cancel', { inviteId: two.inviteId }, 'invite.cancelled');
  assert.equal((await b.socket.nextOfType('invite.updated')).payload.status, 'cancelled');
  assert.equal(await g.errorOf(b.socket, 'invite.accept', { inviteId: two.inviteId }), 'INVITE_NOT_FOUND');
});

test('a new invitation replaces the sender\'s previous open one', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const first = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }, 'invite.sent');
  const second = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '3+0' }, 'invite.sent');
  assert.notEqual(first.inviteId, second.inviteId);
  assert.equal(await g.errorOf(b.socket, 'invite.accept', { inviteId: first.inviteId }), 'INVITE_NOT_FOUND');
});

test('an expired invitation cannot be accepted', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const sent = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }, 'invite.sent');
  await g.sleep(1000); // INVITE_TTL_MS is 800 in this file
  assert.equal(await g.errorOf(b.socket, 'invite.accept', { inviteId: sent.inviteId }), 'INVITE_NOT_FOUND');
});
