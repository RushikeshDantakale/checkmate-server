'use strict';

// Admin module (D-059): admin-only access, status changes, coins, entitlements, reports,
// tournament repair/cancel and the audit log.
process.env.TOURNAMENT_SHOW_UP_MS = '1500';
process.env.TOURNAMENT_ROUND_BREAK_MS = '100';
process.env.TOURNAMENT_MIN_LEAD_MS = '0';
process.env.MATCH_TICK_MS = '50';
process.env.WALLET_PENDING_AGE_MS = '100';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');
const g = require('./gameHelpers');
const { User, Report, AdminAction, Tournament } = require('../src/database/models');
const wallet = require('../src/modules/economy/wallet.service');

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

const A = '/api/v1/admin';
const newUser = (prefix) => h.registerUser(api, g.uniq(prefix));
async function newAdmin(prefix = 'adm') {
  const u = await newUser(prefix);
  await User.updateOne({ _id: u.id }, { $set: { role: 'admin' } });
  return u;
}
let reqCounter = 0;
const rid = () => `req-${Date.now().toString(36)}-${(reqCounter += 1)}`;
const soon = (ms) => new Date(Date.now() + ms).toISOString();
const code = (res) => res.body && res.body.error && res.body.error.code;
const fund = (user, amount) =>
  wallet.credit({ key: `test-fund:${user.id}:${rid()}`, userId: user.id, amount, reason: 'admin_grant' });

test('admin routes need a login and the admin role', async () => {
  const user = await newUser('plain');
  assert.equal((await api.get(`${A}/users`)).status, 401);
  const res = await api.get(`${A}/users`, user.token);
  assert.equal(res.status, 403);
  assert.equal(code(res), 'ADMIN_ONLY');
  for (const p of ['/reports', '/audit']) assert.equal(code(await api.get(`${A}${p}`, user.token)), 'ADMIN_ONLY');
  assert.equal(code(await api.post(`${A}/users/${user.id}/status`, { status: 'banned', reason: 'trying' }, user.token)), 'ADMIN_ONLY');
  const admin = await newAdmin();
  assert.equal((await api.get(`${A}/users`, admin.token)).status, 200);
});

test('losing the admin role takes effect on the next request', async () => {
  const admin = await newAdmin();
  assert.equal((await api.get(`${A}/audit`, admin.token)).status, 200);
  await User.updateOne({ _id: admin.id }, { $set: { role: 'user' } });
  assert.equal(code(await api.get(`${A}/audit`, admin.token)), 'ADMIN_ONLY');
});

test('user search and detail show what an admin needs', async () => {
  const admin = await newAdmin();
  const user = await newUser('look');
  const found = await api.get(`${A}/users?search=${user.name.slice(0, 5)}`, admin.token);
  assert.equal(found.status, 200);
  assert.ok(found.body.items.some((u) => u.id === user.id));
  const detail = await api.get(`${A}/users/${user.id}`, admin.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.user.email, `${user.name}@example.com`);
  assert.equal(detail.body.coins, 0);
  assert.deepEqual(detail.body.entitlements, { premium: false, packs: [] });
  assert.equal((await api.get(`${A}/users/000000000000000000000000`, admin.token)).status, 404);
  assert.equal((await api.get(`${A}/users/not-an-id`, admin.token)).status, 400);
});

test('an admin cannot target themselves or change another admin', async () => {
  const a1 = await newAdmin();
  const a2 = await newAdmin();
  const self = await api.post(`${A}/users/${a1.id}/status`, { status: 'banned', reason: 'oops' }, a1.token);
  assert.equal(self.status, 409);
  assert.equal(code(self), 'CANNOT_TARGET_SELF');
  assert.equal(code(await api.post(`${A}/users/${a1.id}/coins`, { amount: 10, reason: 'self', requestId: rid() }, a1.token)), 'CANNOT_TARGET_SELF');
  assert.equal(code(await api.post(`${A}/users/${a1.id}/entitlements`, { premium: true, reason: 'self' }, a1.token)), 'CANNOT_TARGET_SELF');
  const other = await api.post(`${A}/users/${a2.id}/status`, { status: 'banned', reason: 'coup' }, a1.token);
  assert.equal(other.status, 403);
  assert.equal(code(other), 'CANNOT_TARGET_ADMIN');
  assert.equal((await User.findById(a2.id).lean()).status, 'active');
});

test('suspend revokes sessions and closes sockets; restore lets the user back in', async () => {
  const admin = await newAdmin();
  const user = await newUser('sus');
  const socket = await g.authed(server.wsUrl, user.token);

  assert.equal((await api.post(`${A}/users/${user.id}/status`, { status: 'suspended' }, admin.token)).status, 400); // reason required
  const res = await api.post(`${A}/users/${user.id}/status`, { status: 'suspended', reason: 'spam in chat' }, admin.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.status, 'suspended');
  assert.equal(res.body.user.statusReason, 'spam in chat');
  assert.equal(res.body.user.statusChangedBy, admin.id);

  assert.equal((await socket.waitClose()).code, 4004);
  const me = await api.get('/api/v1/users/me', user.token);
  assert.equal(me.status, 401); // the session was revoked, so the old token is no longer valid at all
  const login = await api.post('/api/v1/auth/login', { identifier: user.name, password: `${user.name}-password-1` });
  assert.equal(login.status, 403);
  assert.equal(code(login), 'ACCOUNT_SUSPENDED');

  // The same request again changes nothing and says so.
  const again = await api.post(`${A}/users/${user.id}/status`, { status: 'suspended', reason: 'spam in chat' }, admin.token);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);

  const ban = await api.post(`${A}/users/${user.id}/status`, { status: 'banned', reason: 'repeat offence' }, admin.token);
  assert.equal(ban.body.user.status, 'banned');
  assert.equal(code(await api.post('/api/v1/auth/login', { identifier: user.name, password: `${user.name}-password-1` })), 'ACCOUNT_BANNED');

  const restore = await api.post(`${A}/users/${user.id}/status`, { status: 'active', reason: 'appeal accepted' }, admin.token);
  assert.equal(restore.body.user.status, 'active');
  const back = await api.post('/api/v1/auth/login', { identifier: user.name, password: `${user.name}-password-1` });
  assert.equal(back.status, 200);
});

test('coins: grant, revoke, retry once, conflict, insufficient', async () => {
  const admin = await newAdmin();
  const user = await newUser('coin');
  const other = await newUser('coin2');
  const r1 = rid();

  const grant = await api.post(`${A}/users/${user.id}/coins`, { amount: 150, reason: 'contest prize', requestId: r1 }, admin.token);
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(grant.body.balance, 150);
  assert.equal(grant.body.duplicate, false);

  const retry = await api.post(`${A}/users/${user.id}/coins`, { amount: 150, reason: 'contest prize', requestId: r1 }, admin.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.balance, 150);
  assert.equal(retry.body.duplicate, true);
  assert.equal(await wallet.getBalance(user.id), 150);

  // The same requestId for a different user or action is refused.
  const clash = await api.post(`${A}/users/${other.id}/coins`, { amount: 150, reason: 'contest prize', requestId: r1 }, admin.token);
  assert.equal(clash.status, 409);
  assert.equal(code(clash), 'REQUEST_ID_CONFLICT');
  assert.equal(await wallet.getBalance(other.id), 0);

  const revoke = await api.post(`${A}/users/${user.id}/coins`, { amount: -50, reason: 'granted by mistake', requestId: rid() }, admin.token);
  assert.equal(revoke.body.balance, 100);

  const tooMuch = await api.post(`${A}/users/${user.id}/coins`, { amount: -101, reason: 'too greedy', requestId: rid() }, admin.token);
  assert.equal(tooMuch.status, 402);
  assert.equal(code(tooMuch), 'INSUFFICIENT_COINS');
  assert.equal(await wallet.getBalance(user.id), 100);

  const bad = [
    { amount: 0, reason: 'nothing', requestId: rid() },
    { amount: 1.5, reason: 'fraction', requestId: rid() },
    { amount: 100001, reason: 'too big', requestId: rid() },
    { amount: 5, reason: 'ab', requestId: rid() },
    { amount: 5, reason: 'short id', requestId: 'x' },
  ];
  for (const body of bad) assert.equal((await api.post(`${A}/users/${user.id}/coins`, body, admin.token)).status, 400, JSON.stringify(body));

  const failed = await AdminAction.findOne({ adminId: admin.id, action: 'coins_revoke', status: 'failed' }).lean();
  assert.ok(failed, 'the refused revoke is in the audit log as failed');
  assert.equal(failed.errorCode, 'INSUFFICIENT_COINS');
});

test('entitlements: premium and packs, repeatable, validated', async () => {
  const admin = await newAdmin();
  const user = await newUser('ent');
  const set = (body) => api.post(`${A}/users/${user.id}/entitlements`, { reason: 'support ticket', ...body }, admin.token);

  const first = await set({ premium: true, grantPacks: ['pack_classic', 'pack_comedy'] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.entitlements.premium, true);
  assert.deepEqual([...first.body.entitlements.packs].sort(), ['pack_classic', 'pack_comedy']);

  const repeat = await set({ premium: true, grantPacks: ['pack_classic'] });
  assert.equal(repeat.body.entitlements.packs.filter((p) => p === 'pack_classic').length, 1);

  const revoke = await set({ premium: false, revokePacks: ['pack_comedy'] });
  assert.equal(revoke.body.entitlements.premium, false);
  assert.deepEqual(revoke.body.entitlements.packs, ['pack_classic']);

  assert.equal(code(await set({ grantPacks: ['pack_nope'] })), 'UNKNOWN_PACK');
  assert.equal((await set({ grantPacks: ['pack_classic'], revokePacks: ['pack_classic'] })).status, 400);
  assert.equal((await set({})).status, 400);
});

test('reports: list with context, resolve once', async () => {
  const admin = await newAdmin();
  const bad = await newUser('rep');
  const r1 = await newUser('rpa');
  const r2 = await newUser('rpb');
  const one = await Report.create({ reporter: r1.id, reported: bad.id, reason: 'cheating', details: 'engine moves' });
  await Report.create({ reporter: r2.id, reported: bad.id, reason: 'abuse' });

  const list = await api.get(`${A}/reports?status=open&limit=50`, admin.token);
  assert.equal(list.status, 200);
  const row = list.body.items.find((x) => x.id === String(one._id));
  assert.ok(row);
  assert.equal(row.reported.username, bad.name);
  assert.equal(row.reporter.username, r1.name);
  assert.equal(row.reported.totalReports, 2);

  const page1 = await api.get(`${A}/reports?status=all&limit=1`, admin.token);
  assert.equal(page1.body.items.length, 1);
  assert.ok(page1.body.nextCursor);
  const page2 = await api.get(`${A}/reports?status=all&limit=1&cursor=${page1.body.nextCursor}`, admin.token);
  assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);

  const done = await api.post(`${A}/reports/${one._id}/resolve`, { status: 'reviewed', note: 'warned the player' }, admin.token);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.report.status, 'reviewed');
  assert.equal(done.body.report.reviewedBy, admin.id);
  assert.equal(done.body.report.note, 'warned the player');

  const same = await api.post(`${A}/reports/${one._id}/resolve`, { status: 'reviewed' }, admin.token);
  assert.equal(same.body.duplicate, true);
  const flip = await api.post(`${A}/reports/${one._id}/resolve`, { status: 'dismissed' }, admin.token);
  assert.equal(flip.status, 409);
  assert.equal(code(flip), 'REPORT_ALREADY_RESOLVED');
  assert.equal((await api.post(`${A}/reports/000000000000000000000000/resolve`, { status: 'dismissed' }, admin.token)).status, 404);
  assert.equal((await api.post(`${A}/reports/${one._id}/resolve`, { status: 'open' }, admin.token)).status, 400);
});

test('tournament cancel in registration refunds every joined player', async () => {
  const admin = await newAdmin();
  const host = await newUser('th');
  const players = [];
  for (let i = 0; i < 3; i += 1) {
    const p = await newUser(`tp${i}`);
    await fund(p, 100);
    players.push(p);
  }
  const created = await api.post(
    '/api/v1/tournaments',
    { name: 'Cancel me', timeControl: '5+0', rated: false, maxPlayers: 8, entryFee: 30, startsAt: soon(60000) },
    host.token
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.tournament.id;
  for (const p of players) assert.equal((await api.post(`/api/v1/tournaments/${id}/join`, undefined, p.token)).status, 200);
  for (const p of players) assert.equal(await wallet.getBalance(p.id), 70);

  assert.equal((await api.post(`${A}/tournaments/${id}/cancel`, { reason: 'x' }, admin.token)).status, 400);
  const res = await api.post(`${A}/tournaments/${id}/cancel`, { reason: 'venue problem' }, admin.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await Tournament.findById(id).lean()).status, 'cancelled');
  await g.waitFor(async () => {
    for (const p of players) if ((await wallet.getBalance(p.id)) !== 100) return false;
    return true;
  }, 8000);

  const again = await api.post(`${A}/tournaments/${id}/cancel`, { reason: 'venue problem' }, admin.token);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  for (const p of players) assert.equal(await wallet.getBalance(p.id), 100);
});

test('tournament cancel while running refunds players; repair is safe to repeat', async () => {
  const admin = await newAdmin();
  const host = await newUser('rh');
  const players = [];
  for (let i = 0; i < 4; i += 1) {
    const p = await newUser(`rp${i}`);
    await fund(p, 100);
    players.push(p);
  }
  const created = await api.post(
    '/api/v1/tournaments',
    { name: 'Stuck cup', timeControl: '5+0', rated: false, maxPlayers: 8, entryFee: 20, startsAt: soon(1500) },
    host.token
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.tournament.id;
  for (const p of players) assert.equal((await api.post(`/api/v1/tournaments/${id}/join`, undefined, p.token)).status, 200);
  await g.waitFor(async () => (await Tournament.findById(id).lean()).status === 'running', 10000);

  const fix1 = await api.post(`${A}/tournaments/${id}/repair`, undefined, admin.token);
  assert.equal(fix1.status, 200, JSON.stringify(fix1.body));
  assert.equal(fix1.body.status, 'running');
  const fix2 = await api.post(`${A}/tournaments/${id}/repair`, undefined, admin.token);
  assert.equal(fix2.status, 200);
  assert.equal(fix2.body.status, 'running');

  const res = await api.post(`${A}/tournaments/${id}/cancel`, { reason: 'server problem' }, admin.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await Tournament.findById(id).lean()).status, 'cancelled');
  await g.waitFor(async () => {
    for (const p of players) if ((await wallet.getBalance(p.id)) !== 100) return false;
    return true;
  }, 8000);
});

test('the audit log lists actions, pages, filters and holds no secrets', async () => {
  const admin = await newAdmin();
  const user = await newUser('aud');
  for (let i = 0; i < 3; i += 1) {
    const r = await api.post(`${A}/users/${user.id}/coins`, { amount: 5, reason: `bonus ${i}`, requestId: rid() }, admin.token);
    assert.equal(r.status, 200);
  }
  const all = await api.get(`${A}/audit?adminId=${admin.id}&limit=2`, admin.token);
  assert.equal(all.status, 200);
  assert.equal(all.body.items.length, 2);
  assert.ok(all.body.nextCursor);
  const next = await api.get(`${A}/audit?adminId=${admin.id}&limit=2&cursor=${all.body.nextCursor}`, admin.token);
  assert.equal(next.body.items.length, 1);
  assert.equal(next.body.nextCursor, null);

  const byTarget = await api.get(`${A}/audit?targetId=${user.id}&action=coins_grant&limit=50`, admin.token);
  assert.equal(byTarget.body.items.length, 3);
  for (const row of byTarget.body.items) {
    assert.equal(row.status, 'done');
    assert.equal(row.adminId, admin.id);
    assert.ok(row.finishedAt);
  }
  const text = JSON.stringify(await AdminAction.find({}).lean()).toLowerCase();
  for (const secret of ['password', 'accesstoken', 'refreshtoken', '@example.com']) assert.ok(!text.includes(secret), secret);
  assert.equal((await api.get(`${A}/audit?limit=0`, admin.token)).status, 400);
  assert.equal((await api.get(`${A}/audit?cursor=zzz`, admin.token)).status, 400);
});

test('scripts/set-role.js promotes and demotes a user and logs it', async () => {
  const user = await newUser('role');
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'set-role.js'), ...args], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 30000,
    });

  const up = run(user.name, 'admin');
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.equal((await User.findById(user.id).lean()).role, 'admin');
  assert.equal((await api.get(`${A}/audit`, user.token)).status, 200);
  const row = await AdminAction.findOne({ action: 'role_changed_by_script', targetId: user.id }).lean();
  assert.ok(row);
  assert.equal(row.adminId, null);
  assert.deepEqual({ from: row.details.from, to: row.details.to }, { from: 'user', to: 'admin' });

  assert.equal(run(user.name, 'user').status, 0);
  assert.equal((await User.findById(user.id).lean()).role, 'user');
  assert.notEqual(run('nobody_here_x', 'admin').status, 0);
  assert.notEqual(run(user.name, 'superuser').status, 0);
  assert.notEqual(run().status, 0);
});
