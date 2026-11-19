'use strict';

// Per-socket rate limits for game and matchmaking events (D-058, Phase 8b).
// Chat, voice, room and spectate events already had limits (D-030).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');

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

const FAKE_GAME = 'a'.repeat(24);

/** Sends `count` events at once and returns every reply, in order of the ids sent. */
async function burst(socket, type, payload, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push(g.raw(socket, type, payload));
  const replies = new Map();
  while (replies.size < ids.length) {
    const msg = await socket.next(4000);
    if (ids.includes(msg.id)) replies.set(msg.id, msg);
  }
  return ids.map((id) => replies.get(id));
}

const isLimited = (r) => r.type === 'error' && r.payload.code === 'RATE_LIMITED';

async function player() {
  const user = await h.registerUser(api, g.uniq('rl'));
  const socket = await g.authed(server.wsUrl, user.token);
  return { user, socket };
}

test('game.move is limited to 20 per 10 s per socket; the rest are refused before any work', async () => {
  const { socket } = await player();
  const payload = { gameId: FAKE_GAME, moveId: 'move-0001', seq: 0, uci: 'e2e4', san: 'e4', fen: 'x y z a b c' };
  const replies = await burst(socket, 'game.move', payload, 26);
  const limited = replies.filter(isLimited);
  assert.equal(limited.length, 6, 'exactly the 6 messages above the allowance are limited');
  assert.ok(replies.slice(0, 20).every((r) => !isLimited(r)), 'the first 20 reached the normal handling');
});

test('game.resign is limited to 5 per 10 s', async () => {
  const { socket } = await player();
  const replies = await burst(socket, 'game.resign', { gameId: FAKE_GAME }, 8);
  assert.equal(replies.filter(isLimited).length, 3);
});

test('queue.join is limited to 10 per 10 s', async () => {
  const { socket } = await player();
  const replies = await burst(socket, 'queue.join', { timeControl: '5+0', rated: false }, 14);
  assert.equal(replies.filter(isLimited).length, 4);
});

test('invite.send is limited to 10 per 10 s', async () => {
  const { socket } = await player();
  const replies = await burst(socket, 'invite.send', { userId: FAKE_GAME, timeControl: '5+0' }, 13);
  assert.equal(replies.filter(isLimited).length, 3);
});

test('a refused message does not use the allowance of other event types', async () => {
  const { socket } = await player();
  await burst(socket, 'game.resign', { gameId: FAKE_GAME }, 8); // resign bucket is empty now
  const [reply] = await burst(socket, 'game.join', { gameId: FAKE_GAME }, 1);
  assert.ok(!isLimited(reply), 'game.join has its own bucket');
});

test('the limit belongs to the socket: another player is not affected by someone else spamming', async () => {
  const spammer = await player();
  const other = await player();
  await burst(spammer.socket, 'game.resign', { gameId: FAKE_GAME }, 8);
  const replies = await burst(other.socket, 'game.resign', { gameId: FAKE_GAME }, 5);
  assert.equal(replies.filter(isLimited).length, 0);
});

test('a limited message still gets an error reply carrying its request id', async () => {
  const { socket } = await player();
  const replies = await burst(socket, 'game.resign', { gameId: FAKE_GAME }, 7);
  const limited = replies.find(isLimited);
  assert.ok(limited && limited.id, 'the client can match the refusal to its request');
});
