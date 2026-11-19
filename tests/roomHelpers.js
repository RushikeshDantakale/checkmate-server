'use strict';

// Shared helpers for the analysis room tests. Not a test file (the name does not match *.test.js).
// Test files must set process.env.ROOM_* overrides BEFORE requiring this file or ./helpers.
const h = require('./helpers');
const g = require('./gameHelpers');
const { Friendship, Block } = require('../src/database/models');

/** A registered user with an authenticated socket. */
async function makePlayer(server, api, prefix = 'rm') {
  const user = await h.registerUser(api, g.uniq(prefix));
  const socket = await g.authed(server.wsUrl, user.token);
  return { user, socket };
}

/** Friendship written directly (no pushes to drain). */
async function makeFriends(a, b) {
  await Friendship.create({
    requester: a.user.id,
    recipient: b.user.id,
    pairKey: Friendship.makePairKey(a.user.id, b.user.id),
    status: 'accepted',
    respondedAt: new Date(),
  });
}

async function makeBlock(blocker, blocked) {
  await Block.create({ blocker: blocker.user.id, blocked: blocked.user.id });
}

/** Throws away everything queued on the sockets (pushes from earlier steps). */
async function drain(socket, ms = 100) {
  for (;;) {
    try {
      await socket.next(ms);
    } catch {
      return;
    }
  }
}

const drainAll = (players, ms) => Promise.all(players.map((p) => drain(p.socket, ms)));

/** Host invites `guest` (they must be friends) and the guest joins. Returns the guest's room.state payload. */
async function invite(host, guest, roomId) {
  await g.call(host.socket, 'room.invite', { roomId, userId: guest.user.id }, 'room.invite.ok');
}

async function inviteAndJoin(host, guest, roomId) {
  await makeFriends(host, guest);
  await invite(host, guest, roomId);
  return g.call(guest.socket, 'room.join', { roomId }, 'room.state');
}

/** A host with an open room and `guests` joined members (all friends of the host). Sockets are drained. */
async function setupRoom(server, api, { guests = 1, defaultRole = 'editor', name = 'Study' } = {}) {
  const host = await makePlayer(server, api, 'rh');
  const created = await g.call(host.socket, 'room.create', { name, defaultRole }, 'room.create.ok');
  const roomId = created.room.id;
  const members = [];
  for (let i = 0; i < guests; i += 1) {
    const guest = await makePlayer(server, api, 'rg');
    await inviteAndJoin(host, guest, roomId);
    members.push(guest);
  }
  await drainAll([host, ...members]);
  return { host, guests: members, roomId };
}

// A few distinct, structurally valid moves (the server does not check chess legality, D-021).
const SAMPLE = [
  { uci: 'e2e4', san: 'e4' },
  { uci: 'd2d4', san: 'd4' },
  { uci: 'c2c4', san: 'c4' },
  { uci: 'g1f3', san: 'Nf3' },
  { uci: 'b1c3', san: 'Nc3' },
  { uci: 'a2a3', san: 'a3' },
  { uci: 'h2h3', san: 'h3' },
  { uci: 'f2f4', san: 'f4' },
  { uci: 'g2g3', san: 'g3' },
  { uci: 'b2b3', san: 'b3' },
];
const SAMPLE_FEN = g.MOVES[0].fen;

/** Payload for room.move.add: sample move `i` below `parentId`. */
function moveMsg(roomId, parentId, i = 0) {
  return { roomId, parentId, uci: SAMPLE[i].uci, san: SAMPLE[i].san, fen: SAMPLE_FEN };
}

module.exports = {
  makePlayer,
  makeFriends,
  makeBlock,
  drain,
  drainAll,
  invite,
  inviteAndJoin,
  setupRoom,
  moveMsg,
  SAMPLE_FEN,
};
