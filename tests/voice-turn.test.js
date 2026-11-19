'use strict';

// TURN credentials in "secret" mode (D-027): short-lived, per-user credentials derived from a shared
// secret (coturn use-auth-secret style). The environment is fixed per process, so this has its own file.
const TURN_SECRET = 'test-turn-shared-secret-0123456789';
process.env.TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp';
process.env.TURN_SECRET = TURN_SECRET;
process.env.TURN_CREDENTIAL_TTL_SECONDS = '3600';
process.env.GAME_PAUSED_HOLD_MS = '5000';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

test('voice.config returns STUN plus TURN with time-limited credentials for this user', async () => {
  const m = await g.startMatch(server, api);
  const before = Math.floor(Date.now() / 1000);
  const cfg = await g.call(m.white.socket, 'voice.config', {}, 'voice.config');
  assert.equal(cfg.turnAvailable, true);
  assert.equal(cfg.ttlSeconds, 3600);
  assert.equal(cfg.iceServers.length, 2);
  assert.ok(cfg.iceServers[0].urls.every((u) => u.startsWith('stun:')));

  const turn = cfg.iceServers[1];
  assert.equal(turn.urls.length, 2);
  const [expiry, userId] = turn.username.split(':');
  assert.equal(userId, m.white.user.id);
  assert.ok(Number(expiry) >= before + 3590 && Number(expiry) <= before + 3610, `expiry ${expiry}`);
  const expected = crypto.createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
  assert.equal(turn.credential, expected);
  assert.equal(JSON.stringify(cfg).includes(TURN_SECRET), false, 'the shared secret itself is never sent to clients');
});

test('every user gets their own credentials', async () => {
  const m = await g.startMatch(server, api);
  const a = (await g.call(m.white.socket, 'voice.config', {}, 'voice.config')).iceServers[1];
  const b = (await g.call(m.black.socket, 'voice.config', {}, 'voice.config')).iceServers[1];
  assert.notEqual(a.username, b.username);
  assert.notEqual(a.credential, b.credential);
});

test('voice.config needs authentication', async () => {
  const socket = await h.openSocket(server.wsUrl);
  await socket.next(); // server.hello
  socket.send(JSON.stringify({ id: '1', type: 'voice.config', payload: {} }));
  assert.equal((await socket.next()).payload.code, 'UNAUTHENTICATED');
  socket.terminate();
});

test('voice.failed reports that TURN is available', async () => {
  const m = await g.startMatch(server, api);
  const sdp = 'v=0\r\ns=-\r\n';
  await g.call(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp }, 'voice.offer.ok');
  await m.black.socket.nextOfType('voice.offer');
  await g.call(m.black.socket, 'voice.answer', { gameId: m.gameId, sdp }, 'voice.answer.ok');
  const reply = await g.call(m.black.socket, 'voice.failed', { gameId: m.gameId }, 'voice.failed.ok');
  assert.equal(reply.turnAvailable, true);
  assert.equal((await m.white.socket.nextOfType('voice.ended')).payload.turnAvailable, true);
});
