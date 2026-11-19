'use strict';

// Saved analysis sessions (D-044): copy of a room, ownership, limit, retry safety.
process.env.ANALYSIS_SESSIONS_MAX = '2';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');
const { AnalysisSession } = require('../src/database/models');

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

const save = (user, body) => api.post('/api/v1/analysis-sessions', body, user.token);

/** A room with a host, one editor and one viewer, one move and one annotation. */
async function roomWithContent() {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [editor, viewer] = guests;
  await g.call(host.socket, 'room.role.set', { roomId, userId: viewer.user.id, role: 'viewer' }, 'room.role.set.ok');
  const added = await g.call(editor.socket, 'room.move.add', r.moveMsg(roomId, null, 0), 'room.move.add.ok');
  await g.call(editor.socket, 'room.annotation.set', { roomId, nodeId: added.node.id, comment: 'best by test' }, 'room.annotation.set.ok');
  await r.drainAll([host, editor, viewer]);
  return { host, editor, viewer, roomId, nodeId: added.node.id };
}

test('any member can save a copy of a room; the copy holds the tree, the annotations and the position', async () => {
  const { host, editor, viewer, roomId, nodeId } = await roomWithContent();
  for (const member of [host, editor, viewer]) {
    const res = await save(member.user, { roomId });
    assert.equal(res.status, 201);
    assert.equal(res.body.duplicate, false);
    const s = res.body.session;
    assert.equal(s.title, 'Study', 'the room name is the default title');
    assert.equal(s.sourceRoomId, roomId);
    assert.equal(s.nodes.length, 1);
    assert.equal(s.nodes[0].id, nodeId);
    assert.equal(s.nodes[0].san, 'e4');
    assert.equal(s.annotations[nodeId].comment, 'best by test');
    assert.equal(s.moveCount, 1);
  }
});

test('the copy is independent of the room and only its owner can read, list or delete it', async () => {
  const { host, editor, roomId, nodeId } = await roomWithContent();
  // Titles are plain text: surrounding spaces and invisible bidi overrides are removed.
  const saved = (await save(host.user, { roomId, title: '  My line \u202E ' })).body.session;
  assert.equal(saved.title, 'My line');

  // The room changes afterwards: the saved copy does not.
  await g.call(editor.socket, 'room.node.delete', { roomId, nodeId }, 'room.node.delete.ok');
  const again = await api.get(`/api/v1/analysis-sessions/${saved.id}`, host.user.token);
  assert.equal(again.status, 200);
  assert.equal(again.body.session.nodes.length, 1);

  // Not the owner: same 404 as an unknown id.
  assert.equal((await api.get(`/api/v1/analysis-sessions/${saved.id}`, editor.user.token)).status, 404);
  assert.equal((await api.del(`/api/v1/analysis-sessions/${saved.id}`, editor.user.token)).status, 404);
  assert.equal((await api.get(`/api/v1/analysis-sessions/${'0'.repeat(24)}`, host.user.token)).status, 404);
  assert.equal((await api.get('/api/v1/analysis-sessions', editor.user.token)).body.items.length, 0);

  const list = await api.get('/api/v1/analysis-sessions', host.user.token);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, saved.id);
  assert.equal(list.body.items[0].nodes, undefined, 'the list is short: no tree');

  const del = await api.del(`/api/v1/analysis-sessions/${saved.id}`, host.user.token);
  assert.equal(del.status, 200);
  assert.equal((await api.get(`/api/v1/analysis-sessions/${saved.id}`, host.user.token)).status, 404);
});

test('a non-member cannot save a room, and a missing room looks the same', async () => {
  const { roomId } = await roomWithContent();
  const outsider = await r.makePlayer(server, api, 'out');
  const denied = await save(outsider.user, { roomId });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error.code, 'ROOM_NOT_FOUND');
  assert.equal((await save(outsider.user, { roomId: '0'.repeat(24) })).body.error.code, 'ROOM_NOT_FOUND');
  assert.equal((await save(outsider.user, { roomId: 'x' })).status, 400);
  assert.equal((await save(outsider.user, { roomId, title: '' })).status, 400);
  assert.equal((await api.post('/api/v1/analysis-sessions', { roomId })).status, 401);
  assert.equal(await AnalysisSession.countDocuments({ ownerId: outsider.user.id }), 0);
});

test('saving the same room revision twice returns the stored copy; a changed room is a new copy', async () => {
  const { host, editor, roomId } = await roomWithContent();
  const first = await save(host.user, { roomId });
  const retry = await save(host.user, { roomId });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.session.id, first.body.session.id);

  const [a, b] = await Promise.all([save(editor.user, { roomId }), save(editor.user, { roomId })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], 'two simultaneous saves make exactly one copy');
  assert.equal(await AnalysisSession.countDocuments({ ownerId: editor.user.id }), 1);

  await g.call(editor.socket, 'room.move.add', r.moveMsg(roomId, null, 1), 'room.move.add.ok');
  const changed = await save(host.user, { roomId });
  assert.equal(changed.status, 201);
  assert.equal(changed.body.session.nodes.length, 2);
  assert.notEqual(changed.body.session.id, first.body.session.id);
});

test('the per-user limit is enforced and deleting one frees a slot', async () => {
  const { host, editor, roomId } = await roomWithContent(); // limit is 2 in this test file
  const one = await save(host.user, { roomId });
  await g.call(editor.socket, 'room.move.add', r.moveMsg(roomId, null, 2), 'room.move.add.ok');
  assert.equal((await save(host.user, { roomId })).status, 201);
  await g.call(editor.socket, 'room.move.add', r.moveMsg(roomId, null, 3), 'room.move.add.ok');
  const over = await save(host.user, { roomId });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'ANALYSIS_SESSION_LIMIT');
  await api.del(`/api/v1/analysis-sessions/${one.body.session.id}`, host.user.token);
  assert.equal((await save(host.user, { roomId })).status, 201);
});

test('the list is paginated newest first', async () => {
  const { host, editor, roomId } = await roomWithContent();
  const first = (await save(host.user, { roomId })).body.session;
  await g.call(editor.socket, 'room.move.add', r.moveMsg(roomId, null, 4), 'room.move.add.ok');
  const second = (await save(host.user, { roomId })).body.session;
  const page1 = await api.get('/api/v1/analysis-sessions?limit=1', host.user.token);
  assert.deepEqual(page1.body.items.map((x) => x.id), [second.id]);
  const page2 = await api.get(`/api/v1/analysis-sessions?limit=1&cursor=${page1.body.nextCursor}`, host.user.token);
  assert.deepEqual(page2.body.items.map((x) => x.id), [first.id]);
  assert.equal(page2.body.nextCursor, null);
});
