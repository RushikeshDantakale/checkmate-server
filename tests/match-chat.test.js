'use strict';

// Temporary match chat (D-032, D-034): relayed in RAM between the two players of a LIVE game,
// never stored in MongoDB, lost on restart by design (failure scenario 20).
process.env.GAME_PAUSED_HOLD_MS = '5000';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
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

/** Reads everything that arrives within `ms` and returns the message types. */
async function drain(socket, ms = 300) {
  const types = [];
  for (;;) {
    try {
      types.push((await socket.next(ms)).type);
    } catch {
      return types;
    }
  }
}

const sendChat = (p, gameId, text) => g.call(p.socket, 'chat.match.send', { gameId, text }, 'chat.match.send.ok');

/** Every document currently stored in every collection, as one JSON string (to prove chat is never written). */
async function wholeDatabaseAsText() {
  const collections = await mongoose.connection.db.collections();
  let all = '';
  for (const c of collections) all += JSON.stringify(await c.find({}).toArray());
  return all;
}

test('the opponent receives a match chat message; the sender gets an ok with delivered: true', async () => {
  const m = await g.startMatch(server, api);
  const ok = await sendChat(m.white, m.gameId, 'good luck!');
  assert.equal(ok.delivered, true);
  assert.equal(ok.gameId, m.gameId);
  assert.ok(ok.messageId);
  const got = await m.black.socket.nextOfType('chat.match.message');
  assert.equal(got.payload.text, 'good luck!');
  assert.equal(got.payload.from, m.white.user.id);
  assert.equal(got.payload.gameId, m.gameId);
  assert.equal(got.payload.messageId, ok.messageId);
});

test('the sender\'s other devices see the message too, the sending device does not get an echo', async () => {
  const m = await g.startMatch(server, api);
  const second = await g.authed(server.wsUrl, m.white.user.token);
  await sendChat(m.white, m.gameId, 'from my phone');
  assert.equal((await second.nextOfType('chat.match.message')).payload.text, 'from my phone');
  await m.black.socket.nextOfType('chat.match.message');
  // Other pushes may be queued; what matters is that no chat message came back to the sending device.
  assert.ok(!(await drain(m.white.socket)).includes('chat.match.message'), 'the sending device must not get an echo');
});

test('match chat is never stored: the text appears nowhere in the database', async () => {
  const m = await g.startMatch(server, api);
  const secret = `needle-${Date.now()}-needle`;
  await sendChat(m.white, m.gameId, secret);
  await m.black.socket.nextOfType('chat.match.message');
  await sendChat(m.black, m.gameId, `${secret}-reply`);
  await g.sleep(200);
  assert.equal((await wholeDatabaseAsText()).includes('needle-'), false);
  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.ok(!names.includes('match_messages') && !names.includes('room_messages'));
});

test('only the two players of a live game can chat; strangers get the same answer as for a missing game', async () => {
  const m = await g.startMatch(server, api);
  const spy = await h.registerUser(api, g.uniq('spy'));
  const spySocket = await g.authed(server.wsUrl, spy.token);
  assert.equal(await g.errorOf(spySocket, 'chat.match.send', { gameId: m.gameId, text: 'let me in' }), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(spySocket, 'chat.match.send', { gameId: 'a'.repeat(24), text: 'x' }), 'GAME_NOT_FOUND');
  assert.equal(await m.white.socket.quietFor(300), true);
  assert.equal(await m.black.socket.quietFor(100), true);
});

test('chat needs authentication', async () => {
  const socket = await h.openSocket(server.wsUrl);
  await socket.next(); // server.hello
  socket.send(JSON.stringify({ id: '1', type: 'chat.match.send', payload: { gameId: 'a'.repeat(24), text: 'hi' } }));
  assert.equal((await socket.next()).payload.code, 'UNAUTHENTICATED');
  socket.terminate();
});

test('after the game ends chat is refused with GAME_OVER (also for a stale cache)', async () => {
  const m = await g.startMatch(server, api);
  await sendChat(m.white, m.gameId, 'still playing'); // fills the player cache
  await g.call(m.black.socket, 'game.resign', { gameId: m.gameId }, 'game.resign.ok');
  await m.white.socket.nextOfType('game.over');
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: 'gg' }), 'GAME_OVER');
  assert.equal(await g.errorOf(m.black.socket, 'chat.match.send', { gameId: m.gameId, text: 'gg' }), 'GAME_OVER');
});

test('chat works throughout an active game, including after moves have been played', async () => {
  const m = await g.startMatch(server, api);
  await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  await g.call(m.black.socket, 'game.move', g.moveMsg(m.gameId, 1), 'game.move.ack');
  const ok = await sendChat(m.black, m.gameId, 'my move was quick');
  assert.equal(ok.delivered, true);
});

test('an offline opponent means the message is dropped (delivered: false), never queued for later', async () => {
  const m = await g.startMatch(server, api);
  m.black.socket.terminate();
  await g.sleep(150);
  const ok = await sendChat(m.white, m.gameId, 'are you there?');
  assert.equal(ok.delivered, false);
  const back = await g.authed(server.wsUrl, m.black.user.token);
  assert.ok(!(await drain(back, 300)).includes('chat.match.message'), 'a missed message must not be replayed');
});

test('if either player has blocked the other the message is silently not delivered', async () => {
  const m = await g.startMatch(server, api);
  const block = await api.post('/api/v1/friends/blocks', { userId: m.white.user.id }, m.black.user.token);
  assert.ok([200, 201, 204].includes(block.status), `block status ${block.status}`);
  const ok = await sendChat(m.white, m.gameId, 'hello?');
  assert.equal(ok.delivered, false, 'the sender is not told about the block');
  assert.equal(await m.black.socket.quietFor(300), true);
  // The blocker cannot reach the blocked player either.
  const back = await sendChat(m.black, m.gameId, 'hi');
  assert.equal(back.delivered, false);
});

// Note: the rate limit (5 per 5 s, D-030) is applied BEFORE the payload is parsed, so invalid sends use up
// the allowance too. That is why the invalid and the valid cases are separate tests with separate matches.
test('invalid chat payloads are rejected and nothing is relayed', async () => {
  const m = await g.startMatch(server, api);
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: '' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: '  \n ' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: 'x'.repeat(301) }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: 'nope', text: 'hi' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: 5 }), 'INVALID_PAYLOAD');
  assert.equal(await m.black.socket.quietFor(300), true);
});

test('control characters are removed from chat text and 300 characters is the maximum allowed', async () => {
  const m = await g.startMatch(server, api);
  await sendChat(m.white, m.gameId, 'a\u0000b\u202Ec');
  assert.equal((await m.black.socket.nextOfType('chat.match.message')).payload.text, 'abc');
  await sendChat(m.white, m.gameId, 'z'.repeat(300));
  assert.equal((await m.black.socket.nextOfType('chat.match.message')).payload.text.length, 300);
});

test('markup is relayed as plain text and is not interpreted by the server', async () => {
  const m = await g.startMatch(server, api);
  await sendChat(m.white, m.gameId, '<script>alert(1)</script>');
  assert.equal((await m.black.socket.nextOfType('chat.match.message')).payload.text, '<script>alert(1)</script>');
});

test('match chat is rate limited per socket (5 per 5 seconds)', async () => {
  const m = await g.startMatch(server, api);
  const ids = [];
  for (let i = 0; i < 9; i += 1) ids.push(g.raw(m.white.socket, 'chat.match.send', { gameId: m.gameId, text: `spam ${i}` }));
  const replies = new Map();
  while (replies.size < ids.length) {
    const msg = await m.white.socket.next(3000);
    if (ids.includes(msg.id)) replies.set(msg.id, msg);
  }
  const limited = [...replies.values()].filter((r) => r.type === 'error' && r.payload.code === 'RATE_LIMITED');
  const accepted = [...replies.values()].filter((r) => r.type === 'chat.match.send.ok');
  assert.ok(limited.length >= 3, `limited: ${limited.length}`);
  assert.ok(accepted.length <= 6, `accepted: ${accepted.length}`);
});
