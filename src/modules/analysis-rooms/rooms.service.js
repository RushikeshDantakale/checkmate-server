'use strict';

/**
 * Analysis rooms (D-035 to D-040): up to 10 friends analysing a position together. The room, its
 * members, the variation tree and the annotations live in ONE MongoDB document; every change is a
 * read-modify-write guarded by `rev` (D-038). Presence and chat are RAM only (D-039).
 *
 * Every persisted change is broadcast to the sockets that joined the room, carrying the new `rev`.
 * The socket that made the change gets the same `rev` in its acknowledgement instead of a broadcast.
 * The server does not check chess legality (D-021); it checks structure, permissions and caps.
 */
const crypto = require('node:crypto');
const config = require('../../config');
const events = require('../../utils/events');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { cleanText } = require('../../utils/text');
const registry = require('../../websocket/registry');
const friends = require('../friends/friends.service');
const presence = require('./rooms.presence');
const { AnalysisRoom, User } = require('../../database/models');

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_ATTEMPTS = 5;

let started = false;
let sweepTimer = null;

// ---------------------------------------------------------------- small helpers

const same = (a, b) => String(a) === String(b);
const notFound = () => new AppError(404, 'ROOM_NOT_FOUND', 'Room not found');
const memberOf = (room, userId) => room.members.find((m) => same(m.userId, userId)) || null;
const roleOf = (room, userId) => (memberOf(room, userId) || {}).role || null;
const inviteOf = (room, userId) => room.invited.find((i) => same(i.userId, userId)) || null;
const byJoinedAt = (a, b) => new Date(a.joinedAt) - new Date(b.joinedAt);

function requireOpen(room) {
  if (room.status !== 'open') throw new AppError(409, 'ROOM_CLOSED', 'This room is closed');
}

function requireHost(room, userId) {
  if (roleOf(room, userId) !== 'host') throw new AppError(403, 'ROOM_FORBIDDEN', 'Only the host can do this');
}

function requireEditor(room, userId) {
  const role = roleOf(room, userId);
  if (role !== 'host' && role !== 'editor') throw new AppError(403, 'ROOM_FORBIDDEN', 'You can only watch in this room');
}

/** Editing and chat need the sending socket to have joined (D-039): a client that forgot to re-join is told. */
function requireJoined(roomId, socket) {
  if (!presence.isJoined(roomId, socket)) throw new AppError(409, 'ROOM_NOT_JOINED', 'Join the room first (room.join)');
}

function newNodeId() {
  return `n${crypto.randomBytes(5).toString('hex')}`;
}

function retentionDate(now) {
  return new Date(now.getTime() + config.rooms.retentionMs);
}

// ---------------------------------------------------------------- views

async function usersById(ids) {
  const unique = Array.from(new Set(ids.map(String)));
  const rows = await User.find({ _id: { $in: unique } }).select('username displayName avatarId').lean();
  return new Map(rows.map((u) => [String(u._id), friends.publicUser(u)]));
}

const userOf = (map, id) => map.get(String(id)) || { id: String(id), username: null, displayName: null, avatarId: null };

function nodeView(n) {
  return { id: n.id, parentId: n.parentId || null, uci: n.uci, san: n.san, fen: n.fen, by: String(n.by), at: n.at };
}

function annotationView(a) {
  return {
    comment: a.comment || '',
    nags: a.nags || [],
    arrows: a.arrows || [],
    squares: a.squares || [],
    by: String(a.by),
    at: a.at,
  };
}

function positionOf(room) {
  const node = room.cursor ? room.nodes.find((n) => n.id === room.cursor) : null;
  return { nodeId: node ? node.id : null, fen: node ? node.fen : room.startFen };
}

function memberView(m, users) {
  return { userId: String(m.userId), role: m.role, joinedAt: m.joinedAt, user: userOf(users, m.userId) };
}

/** The complete room as a client needs it to draw the screen. */
async function stateView(room) {
  const users = await usersById([
    ...room.members.map((m) => m.userId),
    ...room.invited.map((i) => i.userId),
    ...room.invited.map((i) => i.by),
  ]);
  return {
    id: String(room._id),
    name: room.name,
    status: room.status,
    hostId: String(room.hostId),
    defaultRole: room.defaultRole,
    maxMembers: config.rooms.maxMembers,
    rev: room.rev,
    startFen: room.startFen,
    position: positionOf(room),
    members: room.members.map((m) => memberView(m, users)),
    invited: room.invited.map((i) => ({ userId: String(i.userId), by: String(i.by), at: i.at, user: userOf(users, i.userId) })),
    nodes: room.nodes.map(nodeView),
    annotations: Object.fromEntries(Object.entries(room.annotations || {}).map(([k, v]) => [k, annotationView(v)])),
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
  };
}

/** Short form for lists and invitation pushes. */
function summaryView(room, userId) {
  return {
    id: String(room._id),
    name: room.name,
    status: room.status,
    hostId: String(room.hostId),
    memberCount: room.members.length,
    maxMembers: config.rooms.maxMembers,
    role: roleOf(room, userId),
    invited: Boolean(inviteOf(room, userId)),
    rev: room.rev,
    lastActivityAt: room.lastActivityAt,
  };
}

// ---------------------------------------------------------------- persistence core

/** Loads the room for a user who is a member (or, with allowInvited, an invitee). Everyone else gets ROOM_NOT_FOUND. */
async function loadForUser(roomId, userId, allowInvited = false) {
  const room = await AnalysisRoom.findById(roomId).lean();
  if (!room) throw notFound();
  if (!memberOf(room, userId) && !(allowInvited && inviteOf(room, userId))) throw notFound();
  return room;
}

/**
 * Read, decide, write, guarded by `rev` (D-038). `plan(room)` must be pure: it may throw an AppError, and it
 * returns `{ update }` (a MongoDB update with $set / $push) or an object without `update` for "nothing to do".
 * A lost race (another change got in first) re-reads and plans again, up to MAX_ATTEMPTS times.
 */
async function mutate(roomId, userId, plan, { allowInvited = false } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const room = await loadForUser(roomId, userId, allowInvited);
    const result = plan(room);
    if (!result.update) return { room, rev: room.rev, noop: true, result };
    const update = {
      ...result.update,
      $inc: { rev: 1 },
      $set: { ...(result.update.$set || {}), lastActivityAt: new Date() },
    };
    const res = await AnalysisRoom.updateOne({ _id: room._id, rev: room.rev }, update);
    if (res.matchedCount === 1) return { room, rev: room.rev + 1, noop: false, result };
  }
  throw new AppError(409, 'ROOM_BUSY', 'The room is being changed by others; retry');
}

// ---------------------------------------------------------------- notifications

function emit(roomId, type, payload, exceptSocket = null) {
  presence.broadcast(roomId, type, payload, { exceptSocket });
}

/** Tells everyone that a room closed and drops all subscriptions. `room` is the document BEFORE it closed. */
function announceClosed(room, rev, reason) {
  const roomId = String(room._id);
  for (const m of room.members) registry.sendToUser(String(m.userId), 'room.closed', { roomId, rev, reason });
  for (const i of room.invited) registry.sendToUser(String(i.userId), 'room.invitation.cancelled', { roomId, reason: 'closed' });
  presence.clearRoom(roomId);
}

// ---------------------------------------------------------------- rooms and membership

async function create(userId, { name, defaultRole, startFen }, socket) {
  return withDb(async () => {
    const hosted = await AnalysisRoom.countDocuments({ hostId: userId, status: 'open' });
    if (hosted >= config.rooms.maxHosted) {
      throw new AppError(409, 'ROOM_LIMIT', `You can host at most ${config.rooms.maxHosted} open rooms`);
    }
    const now = new Date();
    const doc = await AnalysisRoom.create({
      hostId: userId,
      name,
      defaultRole,
      startFen: startFen || DEFAULT_FEN,
      members: [{ userId, role: 'host', joinedAt: now }],
      lastActivityAt: now,
    });
    const room = doc.toObject();
    // D-058: the count above is only a cheap first check. Two simultaneous creations can both pass it,
    // so after saving, the room must be among the host's first `maxHosted` open rooms by _id (a total
    // order). The one that is not is removed again. No transaction needed; both requests agree on the order.
    const allowed = await AnalysisRoom.find({ hostId: userId, status: 'open' })
      .sort({ _id: 1 })
      .limit(config.rooms.maxHosted)
      .select('_id')
      .lean();
    if (!allowed.some((r) => String(r._id) === String(room._id))) {
      await AnalysisRoom.deleteOne({ _id: room._id });
      throw new AppError(409, 'ROOM_LIMIT', `You can host at most ${config.rooms.maxHosted} open rooms`);
    }
    presence.subscribe(String(room._id), socket);
    return { room: await stateView(room), online: [String(userId)], you: { role: 'host' } };
  }, 'create room');
}

async function invite(userId, roomId, targetId) {
  return withDb(async () => {
    if (same(targetId, userId)) throw new AppError(400, 'CANNOT_INVITE_SELF', 'You are already in this room');
    const room0 = await loadForUser(roomId, userId);
    requireOpen(room0);
    requireHost(room0, userId);
    const target = await User.exists({ _id: targetId });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (!(await friends.areFriends(userId, targetId)) || (await friends.isBlockedEitherWay(userId, targetId))) {
      throw new AppError(403, 'NOT_FRIENDS', 'You can only invite your friends');
    }
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      if (memberOf(room, targetId)) throw new AppError(409, 'ALREADY_MEMBER', 'This user is already in the room');
      if (inviteOf(room, targetId)) return { duplicate: true };
      if (room.invited.length >= config.rooms.maxInvites) {
        throw new AppError(409, 'TOO_MANY_INVITES', 'Too many pending invitations; cancel some first');
      }
      return { update: { $push: { invited: { userId: targetId, by: userId, at: new Date() } } } };
    });
    if (out.noop) return { roomId, rev: out.rev, userId: String(targetId), duplicate: true };

    const users = await usersById([targetId, userId]);
    emit(roomId, 'room.invited', { roomId, rev: out.rev, userId: String(targetId), by: String(userId), user: userOf(users, targetId) });
    registry.sendToUser(targetId, 'room.invitation', {
      room: { ...summaryView(out.room, targetId), invited: true },
      by: userOf(users, userId),
    });
    return { roomId, rev: out.rev, userId: String(targetId), duplicate: false };
  }, 'invite to room');
}

async function cancelInvite(userId, roomId, targetId) {
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      if (!inviteOf(room, targetId)) return {};
      return { update: { $set: { invited: room.invited.filter((i) => !same(i.userId, targetId)) } } };
    });
    if (out.noop) return { roomId, rev: out.rev, userId: String(targetId), removed: false };
    emit(roomId, 'room.invite.removed', { roomId, rev: out.rev, userId: String(targetId), reason: 'cancelled' });
    registry.sendToUser(targetId, 'room.invitation.cancelled', { roomId, reason: 'cancelled' });
    return { roomId, rev: out.rev, userId: String(targetId), removed: true };
  }, 'cancel room invitation');
}

async function decline(userId, roomId, socket) {
  return withDb(async () => {
    const out = await mutate(
      roomId,
      userId,
      (room) => {
        if (!inviteOf(room, userId)) return {}; // not invited (any more): nothing to decline
        return { update: { $set: { invited: room.invited.filter((i) => !same(i.userId, userId)) } } };
      },
      { allowInvited: true }
    );
    if (!out.noop) {
      emit(roomId, 'room.invite.removed', { roomId, rev: out.rev, userId: String(userId), reason: 'declined' });
      registry.sendToUser(userId, 'room.invitation.cancelled', { roomId, reason: 'declined' }, socket);
    }
    return { roomId, declined: !out.noop };
  }, 'decline room invitation');
}

/**
 * Enters a room: a member joins again (reconnect), or an invitee becomes a member. Also the way to
 * resynchronise after a gap in `rev`. Returns the full state.
 */
async function join(userId, roomId, socket) {
  return withDb(async () => {
    const room0 = await loadForUser(roomId, userId, true);
    requireOpen(room0);

    if (!memberOf(room0, userId)) {
      const blocked = await friends.blockedEitherWay(userId);
      if (room0.members.some((m) => blocked.has(String(m.userId)))) {
        throw new AppError(403, 'ROOM_UNAVAILABLE', 'This room is not available to you');
      }
      const out = await mutate(
        roomId,
        userId,
        (room) => {
          requireOpen(room);
          if (memberOf(room, userId)) return { already: true }; // joined meanwhile from another device
          if (!inviteOf(room, userId)) throw notFound();
          if (room.members.length >= config.rooms.maxMembers) throw new AppError(409, 'ROOM_FULL', 'This room is full');
          const member = { userId, role: room.defaultRole, joinedAt: new Date() };
          return {
            member,
            update: {
              $push: { members: member },
              $set: { invited: room.invited.filter((i) => !same(i.userId, userId)) },
            },
          };
        },
        { allowInvited: true }
      );
      if (!out.noop) {
        const users = await usersById([userId]);
        emit(roomId, 'room.member.joined', { roomId, rev: out.rev, member: memberView(out.result.member, users) });
      }
    }

    // Subscribe BEFORE reading the state: anything changing from now on reaches this socket, and the client
    // ignores events whose rev is not newer than the state it received.
    const firstDevice = presence.subscribe(roomId, socket);
    const fresh = await AnalysisRoom.findById(roomId).lean();
    const role = fresh ? roleOf(fresh, userId) : null;
    if (!fresh || !role) {
      presence.unsubscribeUser(roomId, userId);
      throw notFound();
    }
    if (firstDevice) emit(roomId, 'room.presence', { roomId, userId: String(userId), online: true }, socket);
    return { room: await stateView(fresh), online: presence.presentUserIds(roomId), you: { role } };
  }, 'join room');
}

async function leave(userId, roomId, socket) {
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      if (!memberOf(room, userId)) throw notFound(); // invitees use decline
      const remaining = room.members.filter((m) => !same(m.userId, userId));
      if (room.status !== 'open') return { update: { $set: { members: remaining } }, silent: true };
      if (remaining.length === 0) {
        const now = new Date();
        return {
          closed: true,
          update: { $set: { members: [], invited: [], status: 'closed', closedAt: now, closeReason: 'empty', expireAt: retentionDate(now) } },
        };
      }
      if (roleOf(room, userId) === 'host') {
        const successor = remaining.filter((m) => m.role === 'editor').sort(byJoinedAt)[0] || remaining.slice().sort(byJoinedAt)[0];
        const members = remaining.map((m) => (same(m.userId, successor.userId) ? { ...m, role: 'host' } : m));
        return { newHostId: String(successor.userId), update: { $set: { members, hostId: successor.userId } } };
      }
      return { update: { $set: { members: remaining } } };
    });

    presence.unsubscribeUser(roomId, userId);
    registry.sendToUser(userId, 'room.left', { roomId, reason: 'left' }, socket); // the user's other devices
    const { result } = out;
    if (result.closed) {
      announceClosed({ ...out.room, members: [] }, out.rev, 'empty');
    } else if (!result.silent) {
      emit(roomId, 'room.member.left', {
        roomId,
        rev: out.rev,
        userId: String(userId),
        reason: 'left',
        ...(result.newHostId ? { newHostId: result.newHostId } : {}),
      });
    }
    return { roomId, rev: out.rev, closed: Boolean(result.closed) };
  }, 'leave room');
}

async function kick(userId, roomId, targetId) {
  return withDb(async () => {
    if (same(targetId, userId)) throw new AppError(400, 'CANNOT_KICK_SELF', 'Use room.leave to leave the room');
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      if (!memberOf(room, targetId)) throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not in the room');
      return {
        update: {
          $set: {
            members: room.members.filter((m) => !same(m.userId, targetId)),
            invited: room.invited.filter((i) => !same(i.userId, targetId)),
          },
        },
      };
    });
    presence.unsubscribeUser(roomId, targetId);
    registry.sendToUser(targetId, 'room.kicked', { roomId });
    emit(roomId, 'room.member.left', { roomId, rev: out.rev, userId: String(targetId), reason: 'kicked' });
    return { roomId, rev: out.rev, userId: String(targetId) };
  }, 'kick from room');
}

async function setRole(userId, roomId, targetId, role) {
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      const target = memberOf(room, targetId);
      if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not in the room');
      if (target.role === 'host') throw new AppError(409, 'CANNOT_CHANGE_HOST', 'Transfer the host role instead');
      if (target.role === role) return {};
      return { update: { $set: { members: room.members.map((m) => (same(m.userId, targetId) ? { ...m, role } : m)) } } };
    });
    if (!out.noop) emit(roomId, 'room.member.role', { roomId, rev: out.rev, userId: String(targetId), role });
    return { roomId, rev: out.rev, userId: String(targetId), role };
  }, 'set room role');
}

async function transferHost(userId, roomId, targetId) {
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      if (same(targetId, userId)) return {};
      if (!memberOf(room, targetId)) throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not in the room');
      const members = room.members.map((m) => {
        if (same(m.userId, targetId)) return { ...m, role: 'host' };
        if (same(m.userId, userId)) return { ...m, role: 'editor' };
        return m;
      });
      return { update: { $set: { members, hostId: targetId } } };
    });
    if (!out.noop) {
      emit(roomId, 'room.host.changed', { roomId, rev: out.rev, hostId: String(targetId), previousHostId: String(userId) });
    }
    return { roomId, rev: out.rev, hostId: out.noop ? String(userId) : String(targetId) };
  }, 'transfer room host');
}

async function close(userId, roomId) {
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireHost(room, userId);
      const now = new Date();
      return {
        update: { $set: { status: 'closed', closedAt: now, closeReason: 'host_closed', expireAt: retentionDate(now), invited: [] } },
      };
    });
    announceClosed(out.room, out.rev, 'host_closed');
    return { roomId, rev: out.rev };
  }, 'close room');
}

// ---------------------------------------------------------------- shared analysis

function subtreeIds(nodes, rootId) {
  const children = new Map();
  for (const n of nodes) {
    const key = n.parentId || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(n.id);
  }
  const ids = [rootId];
  for (let i = 0; i < ids.length; i += 1) ids.push(...(children.get(ids[i]) || []));
  return ids;
}

async function addMove(userId, roomId, { parentId, uci, san, fen }, socket) {
  requireJoined(roomId, socket);
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireEditor(room, userId);
      if (parentId && !room.nodes.some((n) => n.id === parentId)) throw new AppError(404, 'NODE_NOT_FOUND', 'Parent move not found');
      const existing = room.nodes.find((n) => (n.parentId || null) === (parentId || null) && n.uci === uci);
      if (existing) {
        // The same move is already there (a retry, or two people playing the same move): just go to it.
        if (room.cursor === existing.id) return { node: existing, duplicate: true };
        return { node: existing, duplicate: true, moved: true, update: { $set: { cursor: existing.id } } };
      }
      if (room.nodes.length >= config.rooms.maxNodes) {
        throw new AppError(409, 'ROOM_ANALYSIS_FULL', `A room can hold at most ${config.rooms.maxNodes} moves`);
      }
      const node = { id: newNodeId(), parentId: parentId || null, uci, san, fen, by: userId, at: new Date() };
      return { node, duplicate: false, update: { $push: { nodes: node }, $set: { cursor: node.id } } };
    });
    const node = nodeView(out.result.node);
    if (!out.noop) {
      if (out.result.duplicate) {
        emit(roomId, 'room.position', { roomId, rev: out.rev, nodeId: node.id, fen: node.fen, by: String(userId) }, socket);
      } else {
        emit(roomId, 'room.move.added', { roomId, rev: out.rev, node, by: String(userId) }, socket);
      }
    }
    return { roomId, rev: out.rev, node, duplicate: out.result.duplicate };
  }, 'add room move');
}

async function deleteNode(userId, roomId, nodeId, socket) {
  requireJoined(roomId, socket);
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireEditor(room, userId);
      const target = room.nodes.find((n) => n.id === nodeId);
      if (!target) return { removedIds: [], cursor: room.cursor }; // already gone: success, nothing to do
      const removedIds = subtreeIds(room.nodes, nodeId);
      const removed = new Set(removedIds);
      const annotations = Object.fromEntries(Object.entries(room.annotations || {}).filter(([key]) => !removed.has(key)));
      const cursor = room.cursor && removed.has(room.cursor) ? target.parentId || null : room.cursor;
      return {
        removedIds,
        cursor,
        update: { $set: { nodes: room.nodes.filter((n) => !removed.has(n.id)), annotations, cursor } },
      };
    });
    if (!out.noop) {
      emit(
        roomId,
        'room.node.deleted',
        { roomId, rev: out.rev, nodeId, removedIds: out.result.removedIds, cursor: out.result.cursor, by: String(userId) },
        socket
      );
    }
    return { roomId, rev: out.rev, nodeId, removedIds: out.result.removedIds, cursor: out.result.cursor };
  }, 'delete room node');
}

async function setPosition(userId, roomId, nodeId, socket) {
  requireJoined(roomId, socket);
  return withDb(async () => {
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireEditor(room, userId);
      const target = nodeId ? room.nodes.find((n) => n.id === nodeId) : null;
      if (nodeId && !target) throw new AppError(404, 'NODE_NOT_FOUND', 'Move not found');
      const position = { nodeId: target ? target.id : null, fen: target ? target.fen : room.startFen };
      if ((room.cursor || null) === position.nodeId) return { position };
      return { position, update: { $set: { cursor: position.nodeId } } };
    });
    const { position } = out.result;
    if (!out.noop) emit(roomId, 'room.position', { roomId, rev: out.rev, nodeId: position.nodeId, fen: position.fen, by: String(userId) }, socket);
    return { roomId, rev: out.rev, position };
  }, 'set room position');
}

function normalizeAnnotation(input) {
  return {
    comment: input.comment ? cleanText(input.comment) : '',
    nags: Array.from(new Set(input.nags || [])).sort((a, b) => a - b),
    arrows: input.arrows || [],
    squares: input.squares || [],
  };
}

const annotationIsEmpty = (a) => !a.comment && a.nags.length === 0 && a.arrows.length === 0 && a.squares.length === 0;
const annotationKey = (a) => JSON.stringify([a.comment, a.nags, a.arrows, a.squares]);

/** Replaces the annotation of one node (or of the starting position, nodeId 'root'). Empty content removes it. */
async function setAnnotation(userId, roomId, nodeId, input, socket) {
  requireJoined(roomId, socket);
  return withDb(async () => {
    const next = normalizeAnnotation(input);
    const out = await mutate(roomId, userId, (room) => {
      requireOpen(room);
      requireEditor(room, userId);
      if (nodeId !== 'root' && !room.nodes.some((n) => n.id === nodeId)) throw new AppError(404, 'NODE_NOT_FOUND', 'Move not found');
      const current = (room.annotations || {})[nodeId];
      const currentNorm = current ? normalizeAnnotation(current) : null;
      if (annotationIsEmpty(next)) {
        if (!current) return { annotation: null };
        const annotations = { ...room.annotations };
        delete annotations[nodeId];
        return { annotation: null, update: { $set: { annotations } } };
      }
      if (currentNorm && annotationKey(currentNorm) === annotationKey(next)) return { annotation: annotationView(current) };
      const stored = { ...next, by: String(userId), at: new Date() };
      return { annotation: annotationView(stored), update: { $set: { annotations: { ...(room.annotations || {}), [nodeId]: stored } } } };
    });
    const { annotation } = out.result;
    if (!out.noop) emit(roomId, 'room.annotation', { roomId, rev: out.rev, nodeId, annotation, by: String(userId) }, socket);
    return { roomId, rev: out.rev, nodeId, annotation };
  }, 'set room annotation');
}

// ---------------------------------------------------------------- temporary room chat (never stored, D-039)

async function sendChat(userId, roomId, text, socket) {
  requireJoined(roomId, socket);
  const blocked = await withDb(() => friends.blockedEitherWay(userId), 'room chat block check');
  const messageId = crypto.randomUUID();
  const at = Date.now();
  const delivered = presence.broadcast(
    roomId,
    'room.chat.message',
    { roomId, messageId, from: String(userId), text, at },
    { exceptSocket: socket, skipUsers: blocked }
  );
  return { roomId, messageId, at, delivered };
}

// ---------------------------------------------------------------- reads (REST)

async function listRooms(userId) {
  return withDb(async () => {
    const rows = await AnalysisRoom.find({ $or: [{ 'members.userId': userId }, { 'invited.userId': userId }] })
      .select('-nodes -annotations')
      .sort({ lastActivityAt: -1 })
      .limit(50)
      .lean();
    return { items: rows.map((r) => summaryView(r, userId)) };
  }, 'list rooms');
}

async function getRoom(userId, roomId) {
  return withDb(async () => {
    const room = await loadForUser(roomId, userId);
    return { room: await stateView(room), online: presence.presentUserIds(String(room._id)) };
  }, 'get room');
}

// ---------------------------------------------------------------- lifecycle

function onSocketClosed({ userId, connectionId }) {
  for (const { roomId, userId: who, userGone } of presence.unsubscribeSocket({ userId, connectionId })) {
    if (userGone) presence.broadcast(roomId, 'room.presence', { roomId, userId: who, online: false });
  }
}

/** Closes rooms nobody has touched for a long time and nobody is in (D-040). */
async function sweepIdle() {
  const cutoff = new Date(Date.now() - config.rooms.idleCloseMs);
  const stale = await AnalysisRoom.find({ status: 'open', lastActivityAt: { $lt: cutoff } }).select('_id').limit(50).lean();
  for (const { _id } of stale) {
    if (presence.isAnyoneJoined(String(_id))) continue;
    const now = new Date();
    const before = await AnalysisRoom.findOneAndUpdate(
      { _id, status: 'open', lastActivityAt: { $lt: cutoff } },
      {
        $set: { status: 'closed', closedAt: now, closeReason: 'idle', expireAt: retentionDate(now), invited: [] },
        $inc: { rev: 1 },
      },
      { returnDocument: 'before' }
    ).lean();
    if (before) announceClosed(before, before.rev + 1, 'idle');
  }
}

function start() {
  if (started) return;
  started = true;
  events.on('socket.closed', onSocketClosed);
  sweepTimer = setInterval(() => {
    sweepIdle().catch((err) => logger.warn({ reason: err.message }, 'idle room sweep failed'));
  }, config.rooms.sweepIntervalMs);
  sweepTimer.unref();
}

function stop() {
  if (!started) return;
  started = false;
  events.off('socket.closed', onSocketClosed);
  clearInterval(sweepTimer);
  presence.reset();
}

module.exports = {
  start,
  stop,
  sweepIdle,
  create,
  invite,
  cancelInvite,
  decline,
  join,
  leave,
  kick,
  setRole,
  transferHost,
  close,
  addMove,
  deleteNode,
  setPosition,
  setAnnotation,
  sendChat,
  listRooms,
  getRoom,
};
