'use strict';

// Analysis rooms, part 2: shared analysis (moves, variations, position, annotations), permissions inside a
// room, temporary room chat (never stored), concurrency, reconnect and restart, idle clean-up (D-035 to D-040).
// Membership, invitations, the 10-member limit and closing are in rooms.test.js.
process.env.ROOM_MAX_NODES = '5';
process.env.ROOM_IDLE_CLOSE_MS = '300'; // only matters when sweepIdle() is called by hand below

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');
const rooms = require('../src/modules/analysis-rooms/rooms.service');
const { AnalysisRoom } = require('../src/database/models');

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

const roomInDb = (id) => AnalysisRoom.findById(id).lean();
const add = (p, roomId, parentId, i = 0) => g.call(p.socket, 'room.move.add', r.moveMsg(roomId, parentId, i), 'room.move.add.ok');

test('an editor adds a move: acknowledged with the new rev, broadcast to the others, stored, position follows', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [editor, watcher] = guests;
  const base = (await api.get(`/api/v1/rooms/${roomId}`, host.user.token)).body.room.rev;

  const ok = await add(editor, roomId, null, 0);
  assert.equal(ok.duplicate, false);
  assert.equal(ok.rev, base + 1);
  assert.match(ok.node.id, /^n[a-f0-9]{10}$/);
  assert.equal(ok.node.parentId, null);
  assert.equal(ok.node.by, editor.user.id);
  assert.equal(ok.node.uci, 'e2e4');

  for (const p of [host, watcher]) {
    const push = await p.socket.nextOfType('room.move.added');
    assert.equal(push.payload.rev, base + 1);
    assert.equal(push.payload.node.id, ok.node.id);
    assert.equal(push.payload.by, editor.user.id);
  }
  assert.equal(await editor.socket.quietFor(150), true, 'the sender gets the ack, not a broadcast');

  const stored = await roomInDb(roomId);
  assert.equal(stored.nodes.length, 1);
  assert.equal(stored.cursor, ok.node.id);
  assert.equal(stored.rev, base + 1);

  const child = await add(host, roomId, ok.node.id, 1);
  assert.equal(child.node.parentId, ok.node.id);
  const read = (await api.get(`/api/v1/rooms/${roomId}`, watcher.user.token)).body.room;
  assert.equal(read.nodes.length, 2);
  assert.equal(read.position.nodeId, child.node.id);
  assert.equal(read.position.fen, r.SAMPLE_FEN);
});

test('the same move under the same parent is not added twice: the room just goes to it', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const first = await add(host, roomId, null, 0);
  const second = await add(host, roomId, first.node.id, 1);
  await r.drainAll([host, ...guests]);

  const again = await add(host, roomId, null, 0); // already exists, and the cursor is elsewhere
  assert.equal(again.duplicate, true);
  assert.equal(again.node.id, first.node.id);
  assert.equal(again.rev, second.rev + 1, 'moving the cursor is a change');
  const pos = await guests[0].socket.nextOfType('room.position');
  assert.equal(pos.payload.nodeId, first.node.id);

  const retry = await add(host, roomId, null, 0); // cursor already there: nothing to do
  assert.equal(retry.duplicate, true);
  assert.equal(retry.rev, again.rev, 'no write, no new revision');
  assert.equal((await roomInDb(roomId)).nodes.length, 2);
});

test('move payloads are validated and the parent must exist', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 0 });
  const good = r.moveMsg(roomId, null, 0);
  assert.equal(await g.errorOf(host.socket, 'room.move.add', { ...good, uci: 'e2e9' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.move.add', { ...good, san: '<script>' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.move.add', { ...good, fen: 'hello' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.move.add', { ...good, parentId: 'zz' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.move.add', { ...good, parentId: 'n0123456789' }), 'NODE_NOT_FOUND');
  assert.equal((await roomInDb(roomId)).nodes.length, 0);
});

test('viewers can watch and chat but cannot change the analysis', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1, defaultRole: 'viewer' });
  const [viewer] = guests;
  const node = (await add(host, roomId, null, 0)).node;
  await r.drainAll([host, viewer]);

  assert.equal(await g.errorOf(viewer.socket, 'room.move.add', r.moveMsg(roomId, null, 1)), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(viewer.socket, 'room.position.set', { roomId, nodeId: null }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(viewer.socket, 'room.node.delete', { roomId, nodeId: node.id }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(viewer.socket, 'room.annotation.set', { roomId, nodeId: node.id, comment: 'hi' }), 'ROOM_FORBIDDEN');
  const chat = await g.call(viewer.socket, 'room.chat.send', { roomId, text: 'nice line' }, 'room.chat.send.ok');
  assert.equal(chat.delivered, 1);
  assert.equal((await host.socket.nextOfType('room.chat.message')).payload.text, 'nice line');
  assert.equal((await roomInDb(roomId)).nodes.length, 1);

  // Promoted to editor: the same request now works.
  await g.call(host.socket, 'room.role.set', { roomId, userId: viewer.user.id, role: 'editor' }, 'room.role.set.ok');
  const ok = await g.call(viewer.socket, 'room.move.add', r.moveMsg(roomId, null, 1), 'room.move.add.ok');
  assert.equal(ok.duplicate, false);
});

test('editing and chat need a joined socket; a member who forgot to re-join is told', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [member] = guests;
  const fresh = await g.authed(server.wsUrl, member.user.token); // new connection, has not sent room.join
  assert.equal(await g.errorOf(fresh, 'room.move.add', r.moveMsg(roomId, null, 0)), 'ROOM_NOT_JOINED');
  assert.equal(await g.errorOf(fresh, 'room.chat.send', { roomId, text: 'hello' }), 'ROOM_NOT_JOINED');
  assert.equal(await g.errorOf(fresh, 'room.position.set', { roomId, nodeId: null }), 'ROOM_NOT_JOINED');
  await g.call(fresh, 'room.join', { roomId }, 'room.state');
  const ok = await g.call(fresh, 'room.move.add', r.moveMsg(roomId, null, 0), 'room.move.add.ok');
  assert.equal(ok.duplicate, false);

  // A stranger cannot join, so every edit is refused for them too.
  const stranger = await r.makePlayer(server, api);
  assert.equal(await g.errorOf(stranger.socket, 'room.move.add', r.moveMsg(roomId, null, 1)), 'ROOM_NOT_JOINED');
  assert.equal(await g.errorOf(stranger.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND');
  assert.equal((await roomInDb(roomId)).nodes.length, 1);
  assert.ok(host);
});

test('a kicked member can no longer edit or chat, even on a socket that was joined', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [victim] = guests;
  await g.call(host.socket, 'room.kick', { roomId, userId: victim.user.id }, 'room.kick.ok');
  assert.equal(await g.errorOf(victim.socket, 'room.move.add', r.moveMsg(roomId, null, 0)), 'ROOM_NOT_JOINED');
  assert.equal(await g.errorOf(victim.socket, 'room.chat.send', { roomId, text: 'still here?' }), 'ROOM_NOT_JOINED');
});

test('the shared position moves for everyone; setting the same position again changes nothing', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [other] = guests;
  const a = (await add(host, roomId, null, 0)).node;
  const b = (await add(host, roomId, a.id, 1)).node;
  await r.drainAll([host, other]);

  const back = await g.call(other.socket, 'room.position.set', { roomId, nodeId: a.id }, 'room.position.set.ok');
  assert.equal(back.position.nodeId, a.id);
  const push = await host.socket.nextOfType('room.position');
  assert.deepEqual([push.payload.nodeId, push.payload.rev, push.payload.by], [a.id, back.rev, other.user.id]);

  const same = await g.call(other.socket, 'room.position.set', { roomId, nodeId: a.id }, 'room.position.set.ok');
  assert.equal(same.rev, back.rev);
  assert.equal(await host.socket.quietFor(150), true);

  const start = await g.call(host.socket, 'room.position.set', { roomId, nodeId: null }, 'room.position.set.ok');
  assert.equal(start.position.nodeId, null);
  assert.match(start.position.fen, /^rnbqkbnr\/pppppppp/);
  assert.equal(await g.errorOf(host.socket, 'room.position.set', { roomId, nodeId: 'n0123456789' }), 'NODE_NOT_FOUND');
  assert.ok(b);
});

test('deleting a move removes its whole variation, its annotations, and moves the position if needed', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const a = (await add(host, roomId, null, 0)).node;
  const b = (await add(host, roomId, a.id, 1)).node;
  const c = (await add(host, roomId, b.id, 2)).node;
  const side = (await add(host, roomId, a.id, 3)).node; // a second line from a
  await g.call(host.socket, 'room.annotation.set', { roomId, nodeId: c.id, comment: 'deep' }, 'room.annotation.set.ok');
  await g.call(host.socket, 'room.annotation.set', { roomId, nodeId: a.id, comment: 'keep me' }, 'room.annotation.set.ok');
  await g.call(host.socket, 'room.position.set', { roomId, nodeId: c.id }, 'room.position.set.ok');
  await r.drainAll([host, ...guests]);

  const ok = await g.call(guests[0].socket, 'room.node.delete', { roomId, nodeId: b.id }, 'room.node.delete.ok');
  assert.deepEqual(ok.removedIds.sort(), [b.id, c.id].sort());
  assert.equal(ok.cursor, a.id, 'the position was inside the deleted line, so it moves to the parent');
  const push = await host.socket.nextOfType('room.node.deleted');
  assert.deepEqual(push.payload.removedIds.sort(), [b.id, c.id].sort());
  assert.equal(push.payload.cursor, a.id);

  const stored = await roomInDb(roomId);
  assert.deepEqual(stored.nodes.map((n) => n.id).sort(), [a.id, side.id].sort());
  assert.deepEqual(Object.keys(stored.annotations), [a.id]);
  assert.equal(stored.cursor, a.id);

  const again = await g.call(guests[0].socket, 'room.node.delete', { roomId, nodeId: b.id }, 'room.node.delete.ok');
  assert.deepEqual(again.removedIds, []);
  assert.equal(again.rev, ok.rev, 'deleting something already gone is a no-op');
});

test('annotations: set, replace, clear; shown to everyone; the starting position can have one', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const node = (await add(host, roomId, null, 0)).node;
  await r.drainAll([host, ...guests]);

  const set = await g.call(
    host.socket,
    'room.annotation.set',
    {
      roomId,
      nodeId: node.id,
      comment: '  Best by test  ',
      nags: [3, 1, 3],
      arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
      squares: [{ square: 'e4', color: 'red' }],
    },
    'room.annotation.set.ok'
  );
  assert.equal(set.annotation.comment, 'Best by test');
  assert.deepEqual(set.annotation.nags, [1, 3], 'sorted and without duplicates');
  assert.equal(set.annotation.by, host.user.id);
  const push = await guests[0].socket.nextOfType('room.annotation');
  assert.equal(push.payload.nodeId, node.id);
  assert.equal(push.payload.annotation.comment, 'Best by test');
  assert.equal(push.payload.rev, set.rev);

  const same = await g.call(host.socket, 'room.annotation.set', { roomId, nodeId: node.id, comment: 'Best by test', nags: [1, 3], arrows: [{ from: 'e2', to: 'e4', color: 'green' }], squares: [{ square: 'e4', color: 'red' }] }, 'room.annotation.set.ok');
  assert.equal(same.rev, set.rev, 'identical content is not a change');

  const root = await g.call(guests[0].socket, 'room.annotation.set', { roomId, nodeId: 'root', comment: 'Start here' }, 'room.annotation.set.ok');
  assert.equal(root.annotation.comment, 'Start here');
  assert.equal(root.annotation.by, guests[0].user.id);

  const cleared = await g.call(host.socket, 'room.annotation.set', { roomId, nodeId: node.id }, 'room.annotation.set.ok');
  assert.equal(cleared.annotation, null);
  const gone = await guests[0].socket.nextOfType('room.annotation');
  assert.equal(gone.payload.annotation, null);

  const read = (await api.get(`/api/v1/rooms/${roomId}`, guests[0].user.token)).body.room;
  assert.deepEqual(Object.keys(read.annotations), ['root']);
});

test('annotation payloads are validated', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 0 });
  const node = (await add(host, roomId, null, 0)).node;
  const send = (extra) => g.errorOf(host.socket, 'room.annotation.set', { roomId, nodeId: node.id, ...extra });
  assert.equal(await send({ comment: 'x'.repeat(501) }), 'INVALID_PAYLOAD');
  assert.equal(await send({ arrows: [{ from: 'z9', to: 'e4', color: 'green' }] }), 'INVALID_PAYLOAD');
  assert.equal(await send({ arrows: [{ from: 'e2', to: 'e4', color: 'pink' }] }), 'INVALID_PAYLOAD');
  assert.equal(await send({ nags: [1, 2, 3, 4, 5] }), 'INVALID_PAYLOAD');
  assert.equal(await send({ squares: Array.from({ length: 17 }, () => ({ square: 'a1', color: 'red' })) }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.annotation.set', { roomId, nodeId: 'n0123456789', comment: 'x' }), 'NODE_NOT_FOUND');
  assert.equal(await g.errorOf(host.socket, 'room.annotation.set', { roomId, nodeId: 'bogus', comment: 'x' }), 'INVALID_PAYLOAD');
});

test('a room holds a limited number of moves; repeating an existing move still works when full', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 0 }); // ROOM_MAX_NODES = 5 in this file
  let parent = null;
  for (let i = 0; i < 5; i += 1) parent = (await add(host, roomId, parent, i)).node.id;
  assert.equal(await g.errorOf(host.socket, 'room.move.add', r.moveMsg(roomId, parent, 5)), 'ROOM_ANALYSIS_FULL');
  const repeat = await add(host, roomId, null, 0);
  assert.equal(repeat.duplicate, true);
  assert.equal((await roomInDb(roomId)).nodes.length, 5);
});

test('simultaneous edits from several people are all applied exactly once, with distinct revisions', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 3 });
  const everyone = [host, ...guests];
  const base = (await roomInDb(roomId)).rev;

  const results = await Promise.all(everyone.map((p, i) => add(p, roomId, null, i)));
  assert.equal(results.filter((x) => !x.duplicate).length, 4);
  assert.equal(new Set(results.map((x) => x.rev)).size, 4, 'each change got its own revision');
  const stored = await roomInDb(roomId);
  assert.equal(stored.nodes.length, 4);
  assert.equal(stored.rev, base + 4);
});

test('two people playing the same move at the same moment create one move', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [a, b] = await Promise.all([add(host, roomId, null, 0), add(guests[0], roomId, null, 0)]);
  assert.equal([a, b].filter((x) => !x.duplicate).length, 1);
  assert.equal(a.node.id, b.node.id);
  assert.equal((await roomInDb(roomId)).nodes.length, 1);
});

test('room chat: relayed to the others, never stored, never sent back to the sender', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const secret = `chat-${Date.now()}-never-stored`;
  const before = await roomInDb(roomId);

  const ok = await g.call(host.socket, 'room.chat.send', { roomId, text: `  ${secret}  ` }, 'room.chat.send.ok');
  assert.equal(ok.delivered, 2);
  assert.ok(ok.messageId && ok.at);
  for (const p of guests) {
    const msg = await p.socket.nextOfType('room.chat.message');
    assert.equal(msg.payload.text, secret);
    assert.equal(msg.payload.from, host.user.id);
    assert.equal(msg.payload.messageId, ok.messageId);
  }
  assert.equal(await host.socket.quietFor(150), true);

  const after = await roomInDb(roomId);
  assert.equal(after.rev, before.rev, 'chat is not a room change');
  assert.equal(JSON.stringify(after).includes(secret), false, 'the text is nowhere in the room document');
  const collections = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.equal(collections.some((n) => /room_messages|match_messages/.test(n)), false);
  for (const name of collections) {
    const docs = await mongoose.connection.db.collection(name).find({}).toArray();
    assert.equal(JSON.stringify(docs).includes(secret), false, `${name} must not contain the chat text`);
  }
});

test('room chat is validated, rate limited, and hidden from people in a block with the sender', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [a, b] = guests;
  assert.equal(await g.errorOf(host.socket, 'room.chat.send', { roomId, text: '   ' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.chat.send', { roomId, text: 'x'.repeat(301) }), 'INVALID_PAYLOAD');

  await r.makeBlock(a, b); // blocked AFTER both joined: they stay in the room, chat is filtered (D-036)
  await r.drainAll([host, a, b]);
  const ok = await g.call(b.socket, 'room.chat.send', { roomId, text: 'can you see this' }, 'room.chat.send.ok');
  assert.equal(ok.delivered, 1, 'only the host receives it');
  assert.equal((await host.socket.nextOfType('room.chat.message')).payload.text, 'can you see this');
  assert.equal(await a.socket.quietFor(200), true, 'the blocker receives nothing from the blocked user');

  const codes = [];
  for (let i = 0; i < 8; i += 1) codes.push(await g.errorOf(host.socket, 'room.chat.send', { roomId, text: `m${i}` }).catch(() => 'ok'));
  assert.ok(codes.includes('RATE_LIMITED'), 'more than 5 messages in 5 s are refused');
});

test('after a reconnect the state shows everything that happened meanwhile; edits need a new room.join', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [member] = guests;
  const first = (await add(host, roomId, null, 0)).node;
  member.socket.terminate();
  await g.sleep(100);
  const second = await add(host, roomId, first.id, 1);
  await g.call(host.socket, 'room.annotation.set', { roomId, nodeId: second.node.id, comment: 'while you were away' }, 'room.annotation.set.ok');

  const back = await g.authed(server.wsUrl, member.user.token);
  assert.equal(await g.errorOf(back, 'room.move.add', r.moveMsg(roomId, null, 2)), 'ROOM_NOT_JOINED');
  const state = await g.call(back, 'room.join', { roomId }, 'room.state');
  assert.equal(state.room.nodes.length, 2);
  assert.equal(state.room.position.nodeId, second.node.id);
  assert.equal(state.room.annotations[second.node.id].comment, 'while you were away');
  assert.ok(state.room.rev > second.rev, 'the state carries the revision the client continues from');
  assert.ok(state.online.includes(host.user.id));
  const ok = await g.call(back, 'room.move.add', r.moveMsg(roomId, second.node.id, 2), 'room.move.add.ok');
  assert.equal(ok.rev, state.room.rev + 1);
});

test('a server restart keeps rooms in MongoDB; subscriptions and chat are gone until clients join again', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const node = (await add(host, roomId, null, 0)).node;

  rooms.stop(); // what a restart does to RAM: presence forgotten
  rooms.start();

  assert.equal(await g.errorOf(host.socket, 'room.move.add', r.moveMsg(roomId, node.id, 1)), 'ROOM_NOT_JOINED');
  assert.equal(await g.errorOf(host.socket, 'room.chat.send', { roomId, text: 'hello?' }), 'ROOM_NOT_JOINED');
  const state = await g.call(host.socket, 'room.join', { roomId }, 'room.state');
  assert.equal(state.room.nodes.length, 1);
  assert.deepEqual(state.online, [host.user.id], 'the other member is offline until they join again');
  const ok = await g.call(host.socket, 'room.move.add', r.moveMsg(roomId, node.id, 1), 'room.move.add.ok');
  assert.equal(ok.duplicate, false);
  assert.ok(guests);
});

test('REST: only members can read a room, and the analysis is included', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const node = (await add(host, roomId, null, 0)).node;
  const outsider = await r.makePlayer(server, api);
  assert.equal((await api.get(`/api/v1/rooms/${roomId}`, outsider.user.token)).status, 404);
  const read = await api.get(`/api/v1/rooms/${roomId}`, guests[0].user.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.room.nodes[0].id, node.id);
  assert.equal(read.body.room.members.length, 2);
});

test('the idle sweeper closes abandoned rooms and leaves rooms that someone is in', async () => {
  const abandoned = await r.makePlayer(server, api);
  const a = await g.call(abandoned.socket, 'room.create', { name: 'Forgotten' }, 'room.create.ok');
  abandoned.socket.terminate();

  const occupied = await r.makePlayer(server, api);
  const o = await g.call(occupied.socket, 'room.create', { name: 'In use' }, 'room.create.ok');

  await g.sleep(450); // longer than ROOM_IDLE_CLOSE_MS (300)
  await rooms.sweepIdle();

  const closed = await roomInDb(a.room.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeReason, 'idle');
  assert.ok(closed.expireAt > new Date());
  assert.equal((await roomInDb(o.room.id)).status, 'open', 'someone is joined, so it stays open');
});
