'use strict';

// Analysis rooms: creation, invitations, membership, roles, the 10-member limit, presence, closing,
// authorization (D-035 to D-040). Room content (moves, annotations, chat) is in room-analysis.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');
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

test('creating a room makes the creator the host, joined, with a default position; REST shows it', async () => {
  const host = await r.makePlayer(server, api);
  const res = await g.call(host.socket, 'room.create', { name: '  Sicilian study  ' }, 'room.create.ok');
  assert.equal(res.room.name, 'Sicilian study');
  assert.equal(res.room.status, 'open');
  assert.equal(res.room.rev, 0);
  assert.equal(res.room.hostId, host.user.id);
  assert.equal(res.room.maxMembers, 10);
  assert.equal(res.room.members.length, 1);
  assert.equal(res.room.members[0].role, 'host');
  assert.equal(res.room.members[0].user.username, host.user.name);
  assert.equal(res.room.position.nodeId, null);
  assert.match(res.room.position.fen, /^rnbqkbnr\/pppppppp/);
  assert.deepEqual(res.online, [host.user.id]);
  assert.deepEqual(res.you, { role: 'host' });

  const list = await api.get('/api/v1/rooms', host.user.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, res.room.id);
  assert.equal(list.body.items[0].role, 'host');
  assert.equal(list.body.items[0].memberCount, 1);

  const one = await api.get(`/api/v1/rooms/${res.room.id}`, host.user.token);
  assert.equal(one.status, 200);
  assert.equal(one.body.room.id, res.room.id);
});

test('room events need authentication and payloads are validated', async () => {
  const anon = await h.openSocket(server.wsUrl);
  await anon.next(); // server.hello
  assert.equal(await g.errorOf(anon, 'room.create', { name: 'x' }), 'UNAUTHENTICATED');
  assert.equal(await g.errorOf(anon, 'room.join', { roomId: '0'.repeat(24) }), 'UNAUTHENTICATED');
  anon.terminate();

  const host = await r.makePlayer(server, api);
  assert.equal(await g.errorOf(host.socket, 'room.create', {}), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: '   ' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: 'x'.repeat(41) }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: 'ok', defaultRole: 'host' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: 'ok', startFen: 'not a fen' }), 'INVALID_PAYLOAD');
  assert.equal(await g.errorOf(host.socket, 'room.join', { roomId: 'nope' }), 'INVALID_PAYLOAD');
});

test('a user can host at most 3 open rooms', async () => {
  const host = await r.makePlayer(server, api);
  for (let i = 0; i < 3; i += 1) await g.call(host.socket, 'room.create', { name: `r${i}` }, 'room.create.ok');
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: 'one too many' }), 'ROOM_LIMIT');
});

test('only friends can be invited; blocked users and yourself cannot', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 0 });
  const stranger = await r.makePlayer(server, api);
  assert.equal(await g.errorOf(host.socket, 'room.invite', { roomId, userId: stranger.user.id }), 'NOT_FRIENDS');
  assert.equal(await g.errorOf(host.socket, 'room.invite', { roomId, userId: host.user.id }), 'CANNOT_INVITE_SELF');
  assert.equal(await g.errorOf(host.socket, 'room.invite', { roomId, userId: '0'.repeat(24) }), 'USER_NOT_FOUND');

  const blockedFriend = await r.makePlayer(server, api);
  await r.makeFriends(host, blockedFriend);
  await r.makeBlock(blockedFriend, host);
  assert.equal(await g.errorOf(host.socket, 'room.invite', { roomId, userId: blockedFriend.user.id }), 'NOT_FRIENDS');
});

test('an invitation is pushed to every device of the invitee and shown to joined members; a repeat is a no-op', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [member] = guests;
  const friend = await r.makePlayer(server, api);
  const friendPhone = await g.authed(server.wsUrl, friend.user.token); // second device
  await r.makeFriends(host, friend);
  await r.drainAll([host, member, friend]);

  const ok = await g.call(host.socket, 'room.invite', { roomId, userId: friend.user.id }, 'room.invite.ok');
  assert.equal(ok.duplicate, false);
  assert.equal(ok.rev, 3); // setupRoom: invite (1) + join (2); this invitation is the third change

  for (const socket of [friend.socket, friendPhone]) {
    const push = await socket.nextOfType('room.invitation');
    assert.equal(push.payload.room.id, roomId);
    assert.equal(push.payload.room.invited, true);
    assert.equal(push.payload.room.role, null);
    assert.equal(push.payload.by.username, host.user.name);
  }
  const seen = await member.socket.nextOfType('room.invited');
  assert.equal(seen.payload.userId, friend.user.id);
  assert.equal(seen.payload.rev, 3);

  const again = await g.call(host.socket, 'room.invite', { roomId, userId: friend.user.id }, 'room.invite.ok');
  assert.equal(again.duplicate, true);
  assert.equal(again.rev, 3);
  assert.equal(await friend.socket.quietFor(150), true, 'no second invitation push');

  const list = await api.get('/api/v1/rooms', friend.user.token);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].invited, true);
  assert.equal(list.body.items[0].role, null);
});

test('only invited users can join; a stranger gets the same answer as for a room that does not exist', async () => {
  const { roomId } = await r.setupRoom(server, api, { guests: 0 });
  const stranger = await r.makePlayer(server, api);
  const forStranger = await g.errorOf(stranger.socket, 'room.join', { roomId });
  const forMissing = await g.errorOf(stranger.socket, 'room.join', { roomId: '0'.repeat(24) });
  assert.equal(forStranger, 'ROOM_NOT_FOUND');
  assert.equal(forMissing, 'ROOM_NOT_FOUND');

  const rest = await api.get(`/api/v1/rooms/${roomId}`, stranger.user.token);
  const restMissing = await api.get(`/api/v1/rooms/${'0'.repeat(24)}`, stranger.user.token);
  assert.equal(rest.status, 404);
  assert.deepEqual(rest.body, restMissing.body);
  assert.equal((await api.get('/api/v1/rooms/not-an-id', stranger.user.token)).status, 400);
  assert.equal((await api.get('/api/v1/rooms')).status, 401);
});

test('joining by invitation: default role, state for the newcomer, push for the others', async () => {
  const host = await r.makePlayer(server, api);
  const created = await g.call(host.socket, 'room.create', { name: 'Viewers', defaultRole: 'viewer' }, 'room.create.ok');
  const roomId = created.room.id;
  const guest = await r.makePlayer(server, api);
  await r.makeFriends(host, guest);
  await r.invite(host, guest, roomId);
  await r.drainAll([host, guest]);

  const state = await g.call(guest.socket, 'room.join', { roomId }, 'room.state');
  assert.deepEqual(state.you, { role: 'viewer' });
  assert.equal(state.room.members.length, 2);
  assert.equal(state.room.invited.length, 0);
  assert.ok(state.online.includes(host.user.id) && state.online.includes(guest.user.id));
  assert.equal(state.room.rev, 2); // invite (1) + join (2)

  const joined = await host.socket.nextOfType('room.member.joined');
  assert.equal(joined.payload.member.userId, guest.user.id);
  assert.equal(joined.payload.member.role, 'viewer');
  assert.equal(joined.payload.rev, 2);
  const presence = await host.socket.nextOfType('room.presence');
  assert.deepEqual(presence.payload, { roomId, userId: guest.user.id, online: true });

  const stored = await roomInDb(roomId);
  assert.equal(stored.members.length, 2);
  assert.equal(stored.invited.length, 0);
});

test('a room holds at most 10 members including the host', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 9 });
  assert.equal(guests.length, 9);
  const eleventh = await r.makePlayer(server, api);
  await r.makeFriends(host, eleventh);
  await r.invite(host, eleventh, roomId);
  assert.equal(await g.errorOf(eleventh.socket, 'room.join', { roomId }), 'ROOM_FULL');
  const stored = await roomInDb(roomId);
  assert.equal(stored.members.length, 10);
  assert.equal(stored.invited.length, 1, 'the invitation stays; they can join when someone leaves');

  await g.call(guests[0].socket, 'room.leave', { roomId }, 'room.leave.ok');
  const state = await g.call(eleventh.socket, 'room.join', { roomId }, 'room.state');
  assert.equal(state.room.members.length, 10);
});

test('simultaneous joins for the last seats: exactly as many succeed as there are seats', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 6 }); // 7 members, 3 seats left
  const racers = [];
  for (let i = 0; i < 4; i += 1) {
    const p = await r.makePlayer(server, api, 'rc');
    await r.makeFriends(host, p);
    await r.invite(host, p, roomId);
    racers.push(p);
  }
  const results = await Promise.allSettled(racers.map((p) => g.call(p.socket, 'room.join', { roomId }, 'room.state')));
  const ok = results.filter((x) => x.status === 'fulfilled').length;
  const full = results.filter((x) => x.status === 'rejected' && x.reason.code === 'ROOM_FULL').length;
  assert.equal(ok, 3);
  assert.equal(full, 1);
  const stored = await roomInDb(roomId);
  assert.equal(stored.members.length, 10);
  assert.equal(new Set(stored.members.map((m) => String(m.userId))).size, 10, 'no duplicate members');
});

test('someone who is in a block with a current member cannot join', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const newcomer = await r.makePlayer(server, api);
  await r.makeFriends(host, newcomer);
  await r.makeBlock(guests[0], newcomer);
  await r.invite(host, newcomer, roomId);
  assert.equal(await g.errorOf(newcomer.socket, 'room.join', { roomId }), 'ROOM_UNAVAILABLE');
  assert.equal((await roomInDb(roomId)).members.length, 2);
});

test('declining and cancelling an invitation remove it', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const a = await r.makePlayer(server, api);
  const b = await r.makePlayer(server, api);
  await r.makeFriends(host, a);
  await r.makeFriends(host, b);
  await r.invite(host, a, roomId);
  await r.invite(host, b, roomId);
  await r.drainAll([host, guests[0], a, b]);

  const declined = await g.call(a.socket, 'room.decline', { roomId }, 'room.decline.ok');
  assert.equal(declined.declined, true);
  const seen = await host.socket.nextOfType('room.invite.removed');
  assert.deepEqual([seen.payload.userId, seen.payload.reason], [a.user.id, 'declined']);
  assert.equal(await g.errorOf(a.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND');

  const cancelled = await g.call(host.socket, 'room.invite.cancel', { roomId, userId: b.user.id }, 'room.invite.cancel.ok');
  assert.equal(cancelled.removed, true);
  const push = await b.socket.nextOfType('room.invitation.cancelled');
  assert.equal(push.payload.reason, 'cancelled');
  assert.equal(await g.errorOf(b.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND');
  assert.equal((await roomInDb(roomId)).invited.length, 0);
});

test('only the host can invite, kick, change roles, transfer the host role or close the room', async () => {
  const { guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [editor, other] = guests;
  const friend = await r.makePlayer(server, api);
  await r.makeFriends(editor, friend);
  assert.equal(await g.errorOf(editor.socket, 'room.invite', { roomId, userId: friend.user.id }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(editor.socket, 'room.kick', { roomId, userId: other.user.id }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(editor.socket, 'room.role.set', { roomId, userId: other.user.id, role: 'viewer' }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(editor.socket, 'room.host.transfer', { roomId, userId: other.user.id }), 'ROOM_FORBIDDEN');
  assert.equal(await g.errorOf(editor.socket, 'room.close', { roomId }), 'ROOM_FORBIDDEN');
  assert.equal((await roomInDb(roomId)).status, 'open');
});

test('changing a role is broadcast; the host role cannot be changed that way', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [a, b] = guests;
  const ok = await g.call(host.socket, 'room.role.set', { roomId, userId: a.user.id, role: 'viewer' }, 'room.role.set.ok');
  assert.equal(ok.role, 'viewer');
  for (const p of [a, b]) {
    const push = await p.socket.nextOfType('room.member.role');
    assert.deepEqual([push.payload.userId, push.payload.role, push.payload.rev], [a.user.id, 'viewer', ok.rev]);
  }
  const again = await g.call(host.socket, 'room.role.set', { roomId, userId: a.user.id, role: 'viewer' }, 'room.role.set.ok');
  assert.equal(again.rev, ok.rev, 'no change, no new revision');
  assert.equal(await g.errorOf(host.socket, 'room.role.set', { roomId, userId: host.user.id, role: 'viewer' }), 'CANNOT_CHANGE_HOST');
  assert.equal(await g.errorOf(host.socket, 'room.role.set', { roomId, userId: '0'.repeat(24), role: 'viewer' }), 'MEMBER_NOT_FOUND');
  assert.equal(await g.errorOf(host.socket, 'room.role.set', { roomId, userId: b.user.id, role: 'host' }), 'INVALID_PAYLOAD');
});

test('kicking removes the member for good: they are told, others see it, and they cannot come back', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const [victim, bystander] = guests;
  const victimPhone = await g.authed(server.wsUrl, victim.user.token);
  await g.call(victimPhone, 'room.join', { roomId }, 'room.state');
  await r.drainAll([host, victim, bystander]);
  await r.drain(victimPhone);

  assert.equal(await g.errorOf(host.socket, 'room.kick', { roomId, userId: host.user.id }), 'CANNOT_KICK_SELF');
  const ok = await g.call(host.socket, 'room.kick', { roomId, userId: victim.user.id }, 'room.kick.ok');
  await victim.socket.nextOfType('room.kicked');
  await victimPhone.nextOfType('room.kicked');
  const left = await bystander.socket.nextOfType('room.member.left');
  assert.deepEqual([left.payload.userId, left.payload.reason, left.payload.rev], [victim.user.id, 'kicked', ok.rev]);

  assert.equal(await g.errorOf(victim.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND');
  assert.equal((await api.get(`/api/v1/rooms/${roomId}`, victim.user.token)).status, 404);
  assert.equal(await g.errorOf(host.socket, 'room.kick', { roomId, userId: victim.user.id }), 'MEMBER_NOT_FOUND');
  assert.equal((await roomInDb(roomId)).members.length, 2);
});

test('leaving: the room tells the others; the host role passes to the longest-standing editor', async () => {
  const host = await r.makePlayer(server, api);
  const created = await g.call(host.socket, 'room.create', { name: 'Handover' }, 'room.create.ok');
  const roomId = created.room.id;
  const viewer = await r.makePlayer(server, api);
  const editor = await r.makePlayer(server, api);
  await r.inviteAndJoin(host, viewer, roomId);
  await g.call(host.socket, 'room.role.set', { roomId, userId: viewer.user.id, role: 'viewer' }, 'room.role.set.ok');
  await r.inviteAndJoin(host, editor, roomId); // joined later than the viewer, but is an editor
  await r.drainAll([host, viewer, editor]);

  const ok = await g.call(host.socket, 'room.leave', { roomId }, 'room.leave.ok');
  assert.equal(ok.closed, false);
  const left = await viewer.socket.nextOfType('room.member.left');
  assert.equal(left.payload.userId, host.user.id);
  assert.equal(left.payload.reason, 'left');
  assert.equal(left.payload.newHostId, editor.user.id);

  const stored = await roomInDb(roomId);
  assert.equal(String(stored.hostId), editor.user.id);
  assert.equal(stored.members.find((m) => String(m.userId) === editor.user.id).role, 'host');
  assert.equal(stored.members.length, 2);
  assert.equal(await g.errorOf(host.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND', 'the old host is no longer a member');

  // A plain member leaving does not change the host.
  const quiet = await g.call(viewer.socket, 'room.leave', { roomId }, 'room.leave.ok');
  assert.equal(quiet.closed, false);
  assert.equal(String((await roomInDb(roomId)).hostId), editor.user.id);
});

test('the host can hand the role over; the old host becomes an editor', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [next] = guests;
  const ok = await g.call(host.socket, 'room.host.transfer', { roomId, userId: next.user.id }, 'room.host.transfer.ok');
  assert.equal(ok.hostId, next.user.id);
  const push = await next.socket.nextOfType('room.host.changed');
  assert.deepEqual([push.payload.hostId, push.payload.previousHostId], [next.user.id, host.user.id]);
  const stored = await roomInDb(roomId);
  assert.equal(String(stored.hostId), next.user.id);
  assert.equal(stored.members.find((m) => String(m.userId) === host.user.id).role, 'editor');
  assert.equal(await g.errorOf(host.socket, 'room.kick', { roomId, userId: next.user.id }), 'ROOM_FORBIDDEN');
  const kicked = await g.call(next.socket, 'room.kick', { roomId, userId: host.user.id }, 'room.kick.ok');
  assert.ok(kicked.rev > ok.rev);
});

test('when the last member leaves the room closes and is scheduled for deletion', async () => {
  const { host, roomId } = await r.setupRoom(server, api, { guests: 0 });
  const ok = await g.call(host.socket, 'room.leave', { roomId }, 'room.leave.ok');
  assert.equal(ok.closed, true);
  const stored = await roomInDb(roomId);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.closeReason, 'empty');
  assert.ok(stored.expireAt > new Date(), 'expireAt is in the future (TTL index deletes the document later)');
  assert.equal(stored.members.length, 0);
});

test('closing: everyone is told, the room becomes read-only, members can still read it, nobody can join', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 2 });
  const pending = await r.makePlayer(server, api);
  await r.makeFriends(host, pending);
  await r.invite(host, pending, roomId);
  await r.drainAll([host, ...guests, pending]);

  const ok = await g.call(host.socket, 'room.close', { roomId }, 'room.close.ok');
  for (const p of guests) {
    const push = await p.socket.nextOfType('room.closed');
    assert.deepEqual([push.payload.roomId, push.payload.reason, push.payload.rev], [roomId, 'host_closed', ok.rev]);
  }
  const cancelled = await pending.socket.nextOfType('room.invitation.cancelled');
  assert.equal(cancelled.payload.reason, 'closed');

  const stored = await roomInDb(roomId);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.closeReason, 'host_closed');
  assert.ok(stored.expireAt);
  assert.equal(stored.invited.length, 0);

  assert.equal(await g.errorOf(host.socket, 'room.close', { roomId }), 'ROOM_CLOSED');
  assert.equal(await g.errorOf(host.socket, 'room.invite', { roomId, userId: pending.user.id }), 'ROOM_CLOSED');
  assert.equal(await g.errorOf(guests[0].socket, 'room.join', { roomId }), 'ROOM_CLOSED');
  assert.equal(await g.errorOf(pending.socket, 'room.join', { roomId }), 'ROOM_NOT_FOUND');
  const read = await api.get(`/api/v1/rooms/${roomId}`, guests[0].user.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.room.status, 'closed');
  assert.deepEqual(read.body.online, [], 'nobody is joined to a closed room');
});

test('presence: others see a member come online and go offline; a second device keeps them online', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const [guest] = guests;
  await r.drainAll([host, guest]);

  const phone = await g.authed(server.wsUrl, guest.user.token);
  await g.call(phone, 'room.join', { roomId }, 'room.state');
  assert.equal(await host.socket.quietFor(200), true, 'a second device of someone already online is not news');

  guest.socket.terminate(); // phone still joined
  assert.equal(await host.socket.quietFor(250), true, 'still online through the other device');

  phone.terminate();
  const gone = await host.socket.nextOfType('room.presence');
  assert.deepEqual(gone.payload, { roomId, userId: guest.user.id, online: false });

  // Membership is not presence: the guest is still a member and can come back.
  const again = await g.authed(server.wsUrl, guest.user.token);
  const state = await g.call(again, 'room.join', { roomId }, 'room.state');
  assert.deepEqual(state.you, { role: 'editor' });
  assert.deepEqual(state.online.sort(), [host.user.id, guest.user.id].sort());
  const online = await host.socket.nextOfType('room.presence');
  assert.deepEqual(online.payload, { roomId, userId: guest.user.id, online: true });
});

test('the room list shows my rooms and invitations; other people\'s rooms never appear', async () => {
  const { host, guests, roomId } = await r.setupRoom(server, api, { guests: 1 });
  const outsider = await r.makePlayer(server, api);
  assert.deepEqual((await api.get('/api/v1/rooms', outsider.user.token)).body.items, []);
  const mine = (await api.get('/api/v1/rooms', guests[0].user.token)).body.items;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, roomId);
  assert.equal(mine[0].role, 'editor');
  assert.equal(mine[0].invited, false);
  assert.equal(mine[0].memberCount, 2);
  assert.equal(mine[0].hostId, host.user.id);
  assert.equal(mine[0].nodes, undefined, 'the list never carries the analysis itself');
});
