'use strict';

process.env.WS_AUTH_TIMEOUT_MS = '400';
process.env.WS_REAUTH_GRACE_MS = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, makeApi, registerUser, openSocket, authedSocket, sleep } = require('./helpers');
const config = require('../src/config');

let ctx;
let api;

before(async () => {
  ctx = await startTestServer();
  api = makeApi(ctx.base);
});
after(() => ctx.stop());

function shortToken(user, seconds) {
  return jwt.sign({ sid: user.sessionId }, config.auth.accessSecret, {
    algorithm: 'HS256',
    issuer: 'checkmate-server',
    subject: user.id,
    expiresIn: seconds,
  });
}

test('unauthenticated sockets can ping but not use authenticated events', async () => {
  const socket = await openSocket(ctx.wsUrl);
  await socket.next(); // hello
  socket.send(JSON.stringify({ id: '1', type: 'whoami' }));
  const denied = await socket.next();
  assert.equal(denied.payload.code, 'UNAUTHENTICATED');
  socket.send(JSON.stringify({ id: '2', type: 'ping' }));
  assert.equal((await socket.next()).type, 'pong');
  socket.close();
});

test('valid token authenticates and whoami works', async () => {
  const u = await registerUser(api, 'wsalice');
  const socket = await authedSocket(ctx.wsUrl, u.token);
  socket.send(JSON.stringify({ id: 'w', type: 'whoami' }));
  const who = await socket.next();
  assert.equal(who.type, 'whoami');
  assert.equal(who.payload.userId, u.id);
  socket.close();
});

test('invalid token is rejected and the socket is closed with 4003', async () => {
  const socket = await openSocket(ctx.wsUrl);
  await socket.next();
  socket.send(JSON.stringify({ id: 'x', type: 'auth', payload: { accessToken: 'not-a-real-token-at-all' } }));
  const err = await socket.next();
  assert.equal(err.type, 'error');
  assert.equal((await socket.waitClose()).code, 4003);
});

test('a socket that never authenticates is closed with 4001', async () => {
  const socket = await openSocket(ctx.wsUrl);
  await socket.next();
  assert.equal((await socket.waitClose()).code, 4001);
});

test('logout closes that session socket with 4004', async () => {
  const u = await registerUser(api, 'wslogout');
  const socket = await authedSocket(ctx.wsUrl, u.token);
  assert.equal((await api.post('/api/v1/auth/logout', undefined, u.token)).status, 204);
  assert.equal((await socket.waitClose()).code, 4004);
});

test('logout-all closes every device of the user, other users are unaffected', async () => {
  const u = await registerUser(api, 'wsmulti');
  const other = await registerUser(api, 'wsother');
  const second = (await api.post('/api/v1/auth/login', { identifier: 'wsmulti', password: 'wsmulti-password-1' })).body;
  const s1 = await authedSocket(ctx.wsUrl, u.token);
  const s2 = await authedSocket(ctx.wsUrl, second.accessToken);
  const s3 = await authedSocket(ctx.wsUrl, other.token);
  await api.post('/api/v1/auth/logout-all', undefined, u.token);
  assert.equal((await s1.waitClose()).code, 4004);
  assert.equal((await s2.waitClose()).code, 4004);
  assert.equal(await s3.quietFor(300), true);
  s3.close();
});

test('expiring token: warning, TOKEN_EXPIRED, then re-auth on the same socket keeps it open', async () => {
  const u = await registerUser(api, 'wsexpire');
  const token = shortToken(u, 2);
  const expiresAtMs = jwt.decode(token).exp * 1000;
  const socket = await authedSocket(ctx.wsUrl, token);
  assert.equal((await socket.next()).type, 'auth.expiring');
  await sleep(Math.max(0, expiresAtMs - Date.now()) + 50); // just past the real expiry, inside the grace window
  socket.send(JSON.stringify({ id: 'e', type: 'whoami' }));
  const expired = await socket.nextOfType('error');
  assert.equal(expired.payload.code, 'TOKEN_EXPIRED');

  const refreshed = await api.post('/api/v1/auth/refresh', { refreshToken: u.refreshToken });
  socket.send(JSON.stringify({ id: 'r', type: 'auth', payload: { accessToken: refreshed.body.accessToken } }));
  assert.equal((await socket.nextOfType('auth.ok')).type, 'auth.ok');
  await sleep(1200); // longer than the reauth grace: socket must still be open
  socket.send(JSON.stringify({ id: 'e2', type: 'whoami' }));
  assert.equal((await socket.nextOfType('whoami')).payload.userId, u.id);
  socket.close();
});

test('token expires and client does not re-authenticate: socket closed with 4002', async () => {
  const u = await registerUser(api, 'wsnoreauth');
  const socket = await authedSocket(ctx.wsUrl, shortToken(u, 1));
  assert.equal((await socket.waitClose(4000)).code, 4002);
});

test('re-auth with a different users token is refused', async () => {
  const a = await registerUser(api, 'wsmisa');
  const b = await registerUser(api, 'wsmisb');
  const socket = await authedSocket(ctx.wsUrl, a.token);
  socket.send(JSON.stringify({ id: 'm', type: 'auth', payload: { accessToken: b.token } }));
  assert.equal((await socket.nextOfType('error')).payload.code, 'AUTH_MISMATCH');
  socket.send(JSON.stringify({ id: 'w', type: 'whoami' }));
  assert.equal((await socket.nextOfType('whoami')).payload.userId, a.id);
  socket.close();
});
