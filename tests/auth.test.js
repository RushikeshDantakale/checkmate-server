'use strict';

// Uses a SEPARATE database so tests never touch development data.
// Requires a local MongoDB at localhost:27017.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/checkmate_test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const db = require('../src/database/connection');
const { createServer } = require('../src/server');
const { User, Session } = require('../src/database/models');

let httpServer;
let wss;
let base;

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await db.ensureIndexes();
  ({ httpServer, wss } = createServer());
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Session.deleteMany({});
});

async function post(path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function get(path, token) {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

const alice = { email: 'Alice@Example.com', username: 'Alice_1', password: 'correct-horse-9' };

async function registerAlice() {
  const res = await post('/api/v1/auth/register', alice);
  assert.equal(res.status, 201);
  return res.body;
}

test('register returns tokens, a public user, and never the password hash', async () => {
  const body = await registerAlice();
  assert.equal(body.user.email, 'alice@example.com');
  assert.equal(body.user.username, 'Alice_1');
  assert.ok(body.accessToken && body.refreshToken);
  assert.equal(body.user.passwordHash, undefined);
  const stored = await User.findOne({ email: 'alice@example.com' }).select('+passwordHash');
  assert.notEqual(stored.passwordHash, alice.password);
  assert.match(stored.passwordHash, /^\$2[aby]\$/);
});

test('register rejects duplicates (email and case-insensitive username)', async () => {
  await registerAlice();
  const dupEmail = await post('/api/v1/auth/register', { ...alice, username: 'other_user' });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupEmail.body.error.code, 'EMAIL_TAKEN');
  const dupName = await post('/api/v1/auth/register', { ...alice, email: 'b@example.com', username: 'ALICE_1' });
  assert.equal(dupName.status, 409);
  assert.equal(dupName.body.error.code, 'USERNAME_TAKEN');
});

test('register validates input', async () => {
  const bad = [
    { ...alice, password: 'short' },
    { ...alice, email: 'not-an-email' },
    { ...alice, username: 'a b' },
    { ...alice, password: 'x'.repeat(80) },
  ];
  for (const payload of bad) {
    const res = await post('/api/v1/auth/register', payload);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
  const noBody = await post('/api/v1/auth/register');
  assert.equal(noBody.status, 400);
});

test('login works with email or username and gives one generic error for bad credentials', async () => {
  await registerAlice();
  const byEmail = await post('/api/v1/auth/login', { identifier: 'alice@example.com', password: alice.password });
  assert.equal(byEmail.status, 200);
  const byName = await post('/api/v1/auth/login', { identifier: 'alice_1', password: alice.password });
  assert.equal(byName.status, 200);

  const wrongPassword = await post('/api/v1/auth/login', { identifier: 'alice_1', password: 'wrong-password' });
  const unknownUser = await post('/api/v1/auth/login', { identifier: 'nobody', password: 'wrong-password' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(wrongPassword.body, unknownUser.body);
});

test('protected route needs a valid access token', async () => {
  const { accessToken } = await registerAlice();
  assert.equal((await get('/api/v1/users/me')).status, 401);
  assert.equal((await get('/api/v1/users/me', 'garbage')).status, 401);
  assert.equal((await get('/api/v1/users/me', accessToken + 'x')).status, 401);
  const ok = await get('/api/v1/users/me', accessToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'Alice_1');
});

test('refresh rotates the token and the old one stops working', async () => {
  const first = await registerAlice();
  const rotated = await post('/api/v1/auth/refresh', { refreshToken: first.refreshToken });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refreshToken, first.refreshToken);
  assert.equal((await get('/api/v1/users/me', rotated.body.accessToken)).status, 200);

  const replay = await post('/api/v1/auth/refresh', { refreshToken: first.refreshToken });
  assert.equal(replay.status, 401);
});

test('reusing an old refresh token revokes the whole session (theft detection)', async () => {
  const first = await registerAlice();
  const rotated = await post('/api/v1/auth/refresh', { refreshToken: first.refreshToken });
  await post('/api/v1/auth/refresh', { refreshToken: first.refreshToken }); // attacker replays old token
  const afterTheft = await post('/api/v1/auth/refresh', { refreshToken: rotated.body.refreshToken });
  assert.equal(afterTheft.status, 401);
  assert.equal((await get('/api/v1/users/me', rotated.body.accessToken)).status, 401);
});

test('concurrent refreshes with the same token: only one succeeds', async () => {
  const first = await registerAlice();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => post('/api/v1/auth/refresh', { refreshToken: first.refreshToken }))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('logout revokes the session immediately; other devices stay logged in', async () => {
  const deviceA = await registerAlice();
  const deviceB = (await post('/api/v1/auth/login', { identifier: 'alice_1', password: alice.password })).body;
  const out = await post('/api/v1/auth/logout', undefined, deviceA.accessToken);
  assert.equal(out.status, 204);
  assert.equal((await get('/api/v1/users/me', deviceA.accessToken)).status, 401);
  assert.equal((await post('/api/v1/auth/refresh', { refreshToken: deviceA.refreshToken })).status, 401);
  assert.equal((await get('/api/v1/users/me', deviceB.accessToken)).status, 200);
});

test('logout-all revokes every session', async () => {
  const deviceA = await registerAlice();
  const deviceB = (await post('/api/v1/auth/login', { identifier: 'alice_1', password: alice.password })).body;
  assert.equal((await post('/api/v1/auth/logout-all', undefined, deviceA.accessToken)).status, 204);
  assert.equal((await get('/api/v1/users/me', deviceA.accessToken)).status, 401);
  assert.equal((await get('/api/v1/users/me', deviceB.accessToken)).status, 401);
});

test('suspended accounts cannot log in and existing tokens stop working', async () => {
  const { accessToken } = await registerAlice();
  await User.updateOne({ email: 'alice@example.com' }, { $set: { status: 'suspended' } });
  const me = await get('/api/v1/users/me', accessToken);
  assert.equal(me.status, 403);
  assert.equal(me.body.error.code, 'ACCOUNT_SUSPENDED');
  const login = await post('/api/v1/auth/login', { identifier: 'alice_1', password: alice.password });
  assert.equal(login.status, 403);
});

test('expired access token returns TOKEN_EXPIRED', async () => {
  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const { user, sessionId } = await registerAlice();
  const expired = jwt.sign({ sid: sessionId }, config.auth.accessSecret, {
    algorithm: 'HS256',
    issuer: 'checkmate-server',
    subject: user.id,
    expiresIn: -10,
  });
  const res = await get('/api/v1/users/me', expired);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'TOKEN_EXPIRED');
});

test('a token for another user cannot be used with someone else session', async () => {
  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const a = await registerAlice();
  const b = (await post('/api/v1/auth/register', { email: 'bob@example.com', username: 'bob', password: 'bobs-password-1' })).body;
  // Forge: Bob's user id with Alice's session id (needs the secret, so only simulated here).
  const forged = jwt.sign({ sid: a.sessionId }, config.auth.accessSecret, {
    algorithm: 'HS256',
    issuer: 'checkmate-server',
    subject: b.user.id,
    expiresIn: 60,
  });
  assert.equal((await get('/api/v1/users/me', forged)).status, 401);
});
