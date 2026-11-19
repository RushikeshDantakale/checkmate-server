'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeApi, registerUser } = require('./helpers');

let ctx;
let api;
let ann;
let ben;

before(async () => {
  ctx = await startTestServer();
  api = makeApi(ctx.base);
  ann = await registerUser(api, 'ann');
  ben = await registerUser(api, 'ben');
});
after(() => ctx.stop());

test('profile can be updated and cleared; invalid or unknown fields are rejected', async () => {
  const set = await api.patch('/api/v1/users/me', { displayName: 'Ann The Great', bio: 'I like endgames' }, ann.token);
  assert.equal(set.status, 200);
  assert.equal(set.body.user.displayName, 'Ann The Great');
  assert.equal(set.body.user.bio, 'I like endgames');

  const cleared = await api.patch('/api/v1/users/me', { bio: null }, ann.token);
  assert.equal(cleared.body.user.bio, null);
  assert.equal(cleared.body.user.displayName, 'Ann The Great');

  assert.equal((await api.patch('/api/v1/users/me', { bio: 'x'.repeat(161) }, ann.token)).status, 400);
  assert.equal((await api.patch('/api/v1/users/me', { role: 'admin' }, ann.token)).status, 400); // cannot self-promote
  assert.equal((await api.patch('/api/v1/users/me', { status: 'active' }, ann.token)).status, 400);
});

test('public profile hides private fields and validates the id', async () => {
  const res = await api.get(`/api/v1/users/${ann.id}`, ben.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'ann');
  assert.equal(res.body.user.email, undefined);
  assert.equal(res.body.user.passwordHash, undefined);
  assert.equal((await api.get('/api/v1/users/xyz', ben.token)).status, 400);
  assert.equal((await api.get('/api/v1/users/000000000000000000000000', ben.token)).status, 404);
  assert.equal((await api.get(`/api/v1/users/${ann.id}`)).status, 401);
});

test('settings: defaults, partial update, persistence, validation', async () => {
  const defaults = await api.get('/api/v1/users/me/settings', ben.token);
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.settings.boardTheme, 'classic');
  assert.equal(defaults.body.settings.showOnlineStatus, true);

  const updated = await api.patch('/api/v1/users/me/settings', { boardTheme: 'wood', soundEnabled: false }, ben.token);
  assert.equal(updated.body.settings.boardTheme, 'wood');
  assert.equal(updated.body.settings.soundEnabled, false);
  assert.equal(updated.body.settings.pieceSet, 'standard'); // untouched default

  const again = await api.get('/api/v1/users/me/settings', ben.token);
  assert.equal(again.body.settings.boardTheme, 'wood');

  assert.equal((await api.patch('/api/v1/users/me/settings', { soundEnabled: 'yes' }, ben.token)).status, 400);
  assert.equal((await api.patch('/api/v1/users/me/settings', { isAdmin: true }, ben.token)).status, 400);
  const empty = await api.patch('/api/v1/users/me/settings', {}, ben.token);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.settings.boardTheme, 'wood');
});

test("one user's settings never affect another's", async () => {
  const annSettings = await api.get('/api/v1/users/me/settings', ann.token);
  assert.equal(annSettings.body.settings.boardTheme, 'classic');
});
