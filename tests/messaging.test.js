'use strict';

// Permanent personal messages (D-028 to D-031): friends only, idempotent sends, unread counters,
// pagination, authorization, rate limit. Messages live in MongoDB (collection personal_messages).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { PersonalMessage, Conversation } = require('../src/database/models');

let server;
let api;
let counter = 0;

before(async () => {
  server = await h.startTestServer();
  api = h.makeApi(server.base);
});

after(async () => {
  g.closeAll();
  await server.stop();
});

const cid = () => `cm-${++counter}-${Date.now()}`;

async function player(prefix = 'ms') {
  const user = await h.registerUser(api, g.uniq(prefix));
  const socket = await g.authed(server.wsUrl, user.token);
  return { user, socket };
}

/** Two users who are friends (mutual requests auto-accept). */
async function friendPair() {
  const a = await player();
  const b = await player();
  const first = await api.post('/api/v1/friends/requests', { username: b.user.name }, a.user.token);
  assert.ok([200, 201].includes(first.status));
  const second = await api.post('/api/v1/friends/requests', { username: a.user.name }, b.user.token);
  assert.ok([200, 201].includes(second.status));
  // Friend request pushes (friend.request, friend.accepted) are still queued on the sockets: drain them,
  // otherwise "no further message arrives" checks in the tests below would see them.
  for (const p of [a, b]) {
    for (;;) {
      try {
        await p.socket.next(150); // consumes one queued push; throws when nothing arrives within 150 ms
      } catch {
        break;
      }
    }
  }
  return { a, b };
}

const send = (from, to, body, clientMessageId = cid()) =>
  g.call(from.socket, 'message.send', { toUserId: to.user.id, clientMessageId, body }, 'message.send.ok');

test('a message is stored, acknowledged and pushed to the friend and to the sender\'s other devices', async () => {
  const { a, b } = await friendPair();
  const a2 = await g.authed(server.wsUrl, a.user.token); // second device of A

  const ok = await send(a, b, 'hello friend');
  assert.equal(ok.duplicate, false);
  assert.equal(ok.message.body, 'hello friend');
  assert.equal(ok.message.senderId, a.user.id);
  assert.equal(ok.message.recipientId, b.user.id);
  assert.equal(ok.message.readAt, null);

  const pushed = await b.socket.nextOfType('message.new');
  assert.equal(pushed.payload.message.id, ok.message.id);
  assert.equal(pushed.payload.conversation.unread, 1);
  const mirrored = await a2.nextOfType('message.new');
  assert.equal(mirrored.payload.message.id, ok.message.id);
  assert.equal(await a.socket.quietFor(300), true, 'the sending device gets the ack, not a second push');

  const stored = await PersonalMessage.find({ senderId: a.user.id }).lean();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body, 'hello friend');
});

test('only friends can message each other; self, strangers and blocked users are refused', async () => {
  const a = await player();
  const b = await player();
  assert.equal(await g.errorOf(a.socket, 'message.send', { toUserId: b.user.id, clientMessageId: cid(), body: 'hi' }), 'NOT_FRIENDS');
  assert.equal(await g.errorOf(a.socket, 'message.send', { toUserId: a.user.id, clientMessageId: cid(), body: 'hi' }), 'CANNOT_MESSAGE_SELF');
  assert.equal(await PersonalMessage.countDocuments({ senderId: a.user.id }), 0, 'nothing was stored');

  const { a: c, b: d } = await friendPair();
  await send(c, d, 'before the block');
  const block = await api.post('/api/v1/friends/blocks', { userId: c.user.id }, d.user.token);
  assert.ok([200, 201, 204].includes(block.status), `block status ${block.status}`);
  // The block is not revealed: the answer is the same as for a stranger.
  assert.equal(await g.errorOf(c.socket, 'message.send', { toUserId: d.user.id, clientMessageId: cid(), body: 'x' }), 'NOT_FRIENDS');
  assert.equal(await g.errorOf(d.socket, 'message.send', { toUserId: c.user.id, clientMessageId: cid(), body: 'x' }), 'NOT_FRIENDS');
});

test('a retried send (same clientMessageId) returns the stored message and is never duplicated', async () => {
  const { a, b } = await friendPair();
  const id = cid();
  const first = await send(a, b, 'once only', id);
  const again = await send(a, b, 'once only', id);
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  assert.equal(await PersonalMessage.countDocuments({ senderId: a.user.id }), 1);
  await b.socket.nextOfType('message.new');
  assert.equal(await b.socket.quietFor(300), true, 'the friend must not be notified twice');

  const conv = await Conversation.findOne({ pairKey: Conversation.makePairKey(a.user.id, b.user.id) }).lean();
  const idx = conv.members.findIndex((m) => String(m) === b.user.id);
  assert.equal(conv.unread[idx], 1, 'unread counted once');

  // The same id for a different recipient is a client bug, not a retry.
  const c = await player();
  assert.equal(
    await g.errorOf(a.socket, 'message.send', { toUserId: c.user.id, clientMessageId: id, body: 'other' }),
    'DUPLICATE_CLIENT_MESSAGE_ID'
  );
});

test('a retry still works after the friendship ended (the message was already stored)', async () => {
  const { a, b } = await friendPair();
  const id = cid();
  await send(a, b, 'sent before unfriend', id);
  const res = await api.del(`/api/v1/friends/${b.user.id}`, a.user.token);
  assert.ok([200, 204].includes(res.status), `unfriend status ${res.status}`);
  const again = await send(a, b, 'sent before unfriend', id);
  assert.equal(again.duplicate, true);
  assert.equal(await g.errorOf(a.socket, 'message.send', { toUserId: b.user.id, clientMessageId: cid(), body: 'new' }), 'NOT_FRIENDS');
});

test('invalid payloads are rejected before anything is stored; control characters are removed', async () => {
  const { a, b } = await friendPair();
  const bad = [
    { toUserId: b.user.id, clientMessageId: cid(), body: '' },
    { toUserId: b.user.id, clientMessageId: cid(), body: '   \n  ' },
    { toUserId: b.user.id, clientMessageId: cid(), body: 'x'.repeat(2001) },
    { toUserId: b.user.id, clientMessageId: 'short', body: 'hi' },
    { toUserId: 'not-an-id', clientMessageId: cid(), body: 'hi' },
    { toUserId: b.user.id, clientMessageId: cid() },
    { toUserId: b.user.id, clientMessageId: cid(), body: 42 },
  ];
  for (const payload of bad) {
    assert.equal(await g.errorOf(a.socket, 'message.send', payload), 'INVALID_PAYLOAD', JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(await PersonalMessage.countDocuments({ senderId: a.user.id }), 0, 'nothing was stored');

  const ok = await send(a, b, 'he\u0000llo\u202E there');
  assert.equal(ok.message.body, 'hello there');
  const long = await send(a, b, 'y'.repeat(2000)); // exactly the maximum
  assert.equal(long.message.body.length, 2000);
});

test('two first messages at the same moment create exactly one conversation', async () => {
  const { a, b } = await friendPair();
  await Promise.all([send(a, b, 'from a'), send(b, a, 'from b')]);
  assert.equal(await Conversation.countDocuments({ pairKey: Conversation.makePairKey(a.user.id, b.user.id) }), 1);
  assert.equal(await PersonalMessage.countDocuments({ senderId: { $in: [a.user.id, b.user.id] } }), 2);
});

test('conversation list: unread counters, last message, ordering and authentication', async () => {
  const { a, b } = await friendPair();
  const c = await player();
  await api.post('/api/v1/friends/requests', { username: b.user.name }, c.user.token);
  await api.post('/api/v1/friends/requests', { username: c.user.name }, b.user.token);

  await send(a, b, 'first from a');
  await send(a, b, 'second from a');
  await send(c, b, 'hello from c');

  const list = await api.get('/api/v1/conversations', b.user.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.items[0].user.id, c.user.id, 'most recent conversation first');
  assert.equal(list.body.items[0].unread, 1);
  assert.equal(list.body.items[1].user.id, a.user.id);
  assert.equal(list.body.items[1].unread, 2);
  assert.equal(list.body.items[1].lastMessage.preview, 'second from a');
  assert.equal(list.body.nextCursor, null);

  // The sender's own view: nothing unread for them.
  const mine = await api.get('/api/v1/conversations', a.user.token);
  assert.equal(mine.body.items[0].unread, 0);

  const page1 = await api.get('/api/v1/conversations?limit=1', b.user.token);
  assert.equal(page1.body.items.length, 1);
  assert.ok(page1.body.nextCursor);
  const page2 = await api.get(`/api/v1/conversations?limit=1&cursor=${page1.body.nextCursor}`, b.user.token);
  assert.equal(page2.body.items.length, 1);
  assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);
  assert.equal(page2.body.nextCursor, null);

  const withA = await api.get(`/api/v1/conversations/with/${a.user.id}`, b.user.token);
  assert.equal(withA.body.conversation.unread, 2);
  const stranger = await player();
  const none = await api.get(`/api/v1/conversations/with/${stranger.user.id}`, b.user.token);
  assert.equal(none.body.conversation, null);

  assert.equal((await api.get('/api/v1/conversations')).status, 401);
  assert.equal((await api.get('/api/v1/conversations?limit=0', b.user.token)).status, 400);
  assert.equal((await api.get('/api/v1/conversations?cursor=garbage', b.user.token)).status, 400);
});

test('message history is paginated newest first without gaps or repeats', async () => {
  const { a, b } = await friendPair();
  const sent = [];
  for (let i = 1; i <= 5; i += 1) sent.push((await send(a, b, `message ${i}`)).message.id);
  const conversationId = (await api.get(`/api/v1/conversations/with/${b.user.id}`, a.user.token)).body.conversation.id;

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await api.get(`/api/v1/conversations/${conversationId}/messages?limit=2${cursor ? `&cursor=${cursor}` : ''}`, b.user.token);
    assert.equal(res.status, 200);
    seen.push(...res.body.items.map((m) => m.id));
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, [...sent].reverse());
});

test('read / unread: marking read clears the counter, sets readAt and tells the sender', async () => {
  const { a, b } = await friendPair();
  const b2 = await g.authed(server.wsUrl, b.user.token); // B's second device
  const one = await send(a, b, 'please read');
  await send(a, b, 'and this');
  const conversationId = one.message.conversationId;

  const res = await api.post(`/api/v1/conversations/${conversationId}/read`, {}, b.user.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.markedRead, 2);
  const seenByA = await a.socket.nextOfType('message.seen');
  assert.equal(seenByA.payload.conversationId, conversationId);
  assert.equal(seenByA.payload.byUserId, b.user.id);
  await b2.nextOfType('message.seen'); // B's other device clears its badge

  const list = await api.get('/api/v1/conversations', b.user.token);
  assert.equal(list.body.items[0].unread, 0);
  const messages = await api.get(`/api/v1/conversations/${conversationId}/messages`, a.user.token);
  assert.ok(messages.body.items.every((m) => m.readAt), 'messages addressed to B are marked read');

  // Marking again changes nothing and does not notify the sender again.
  const again = await api.post(`/api/v1/conversations/${conversationId}/read`, {}, b.user.token);
  assert.equal(again.body.markedRead, 0);

  // The same through WebSocket.
  await send(a, b, 'one more');
  const viaWs = await g.call(b.socket, 'message.read', { conversationId }, 'message.read.ok');
  assert.equal(viaWs.markedRead, 1);
});

test('nobody else can read a conversation or mark it read; the answer is the same as for a missing one', async () => {
  const { a, b } = await friendPair();
  const spy = await player();
  const sent = await send(a, b, 'private');
  const conversationId = sent.message.conversationId;

  assert.equal((await api.get(`/api/v1/conversations/${conversationId}/messages`, spy.user.token)).status, 404);
  assert.equal((await api.post(`/api/v1/conversations/${conversationId}/read`, {}, spy.user.token)).status, 404);
  assert.equal((await api.get(`/api/v1/conversations/${'a'.repeat(24)}/messages`, spy.user.token)).status, 404);
  assert.equal((await api.get(`/api/v1/conversations/${conversationId}/messages`)).status, 401);
  assert.equal(await g.errorOf(spy.socket, 'message.read', { conversationId }), 'CONVERSATION_NOT_FOUND');
  assert.equal((await api.get('/api/v1/conversations', spy.user.token)).body.items.length, 0);

  // The unread counter of the real recipient was not touched by the stranger's attempts.
  const mine = await api.get('/api/v1/conversations', b.user.token);
  assert.equal(mine.body.items[0].unread, 1);
});

test('old history stays readable by both users after an unfriend', async () => {
  const { a, b } = await friendPair();
  const sent = await send(a, b, 'keep me');
  await api.del(`/api/v1/friends/${b.user.id}`, a.user.token);
  for (const who of [a, b]) {
    const res = await api.get(`/api/v1/conversations/${sent.message.conversationId}/messages`, who.user.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].body, 'keep me');
  }
});

test('sending too fast is rate limited per socket', async () => {
  const { a, b } = await friendPair();
  const ids = [];
  for (let i = 0; i < 14; i += 1) {
    ids.push(g.raw(a.socket, 'message.send', { toUserId: b.user.id, clientMessageId: cid(), body: `burst ${i}` }));
  }
  const replies = new Map();
  while (replies.size < ids.length) {
    const msg = await a.socket.next(3000);
    if (ids.includes(msg.id)) replies.set(msg.id, msg);
  }
  const limited = [...replies.values()].filter((r) => r.type === 'error' && r.payload.code === 'RATE_LIMITED');
  const accepted = [...replies.values()].filter((r) => r.type === 'message.send.ok');
  assert.ok(limited.length >= 1, 'some messages must be rate limited');
  assert.ok(accepted.length <= 11, `at most the burst allowance gets through (${accepted.length})`);
  assert.equal(await PersonalMessage.countDocuments({ senderId: a.user.id }), accepted.length, 'limited messages were not stored');
});
