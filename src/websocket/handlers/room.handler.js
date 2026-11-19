'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const { cleanText } = require('../../utils/text');
const rooms = require('../../modules/analysis-rooms/rooms.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
// Shape of a FEN only. Chess legality is the client's job (D-021).
const FEN_RE = /^[pnbrqkPNBRQK1-8/]+ [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,3} \d{1,4}$/;
const fen = z.string().max(100).regex(FEN_RE, 'not a FEN position');
const nodeId = z.string().regex(/^n[a-f0-9]{10}$/, 'invalid move id');
const nodeOrRoot = z.union([z.literal('root'), nodeId]);
const square = z.string().regex(/^[a-h][1-8]$/, 'invalid square');
const color = z.enum(['green', 'red', 'blue', 'yellow']);
// Bound the work first (max), clean the text, then check what remains.
const cleaned = (max) => z.string().max(max * 2).transform(cleanText).pipe(z.string().min(1).max(max));
const optionalComment = z.string().max(1000).transform(cleanText).pipe(z.string().max(500));

const roomRef = z.object({ roomId: objectId });
const roomUser = z.object({ roomId: objectId, userId: objectId });

const limit = (key, count, windowMs) => ({ rateLimit: { key, limit: count, windowMs } });

/** Analysis rooms (D-035 to D-040). Replies are `<event>.ok` unless noted; room.join replies `room.state`. */
module.exports = {
  'room.create': {
    requireAuth: true,
    handle: defineHandler(
      z.object({
        name: cleaned(40),
        defaultRole: z.enum(['editor', 'viewer']).default('editor'),
        startFen: fen.optional(),
      }),
      async ({ socket, id, data, userId }) => send(socket, 'room.create.ok', await rooms.create(userId, data, socket), id),
      limit('room.create', 5, 60000)
    ),
  },
  'room.invite': {
    requireAuth: true,
    handle: defineHandler(
      roomUser,
      async ({ socket, id, data, userId }) => send(socket, 'room.invite.ok', await rooms.invite(userId, data.roomId, data.userId), id),
      limit('room.invite', 10, 60000)
    ),
  },
  'room.invite.cancel': {
    requireAuth: true,
    handle: defineHandler(roomUser, async ({ socket, id, data, userId }) =>
      send(socket, 'room.invite.cancel.ok', await rooms.cancelInvite(userId, data.roomId, data.userId), id)
    ),
  },
  'room.decline': {
    requireAuth: true,
    handle: defineHandler(roomRef, async ({ socket, id, data, userId }) =>
      send(socket, 'room.decline.ok', await rooms.decline(userId, data.roomId, socket), id)
    ),
  },
  'room.join': {
    requireAuth: true,
    handle: defineHandler(
      roomRef,
      async ({ socket, id, data, userId }) => send(socket, 'room.state', await rooms.join(userId, data.roomId, socket), id),
      limit('room.join', 10, 10000)
    ),
  },
  'room.leave': {
    requireAuth: true,
    handle: defineHandler(roomRef, async ({ socket, id, data, userId }) =>
      send(socket, 'room.leave.ok', await rooms.leave(userId, data.roomId, socket), id)
    ),
  },
  'room.kick': {
    requireAuth: true,
    handle: defineHandler(roomUser, async ({ socket, id, data, userId }) =>
      send(socket, 'room.kick.ok', await rooms.kick(userId, data.roomId, data.userId), id)
    ),
  },
  'room.role.set': {
    requireAuth: true,
    handle: defineHandler(roomUser.extend({ role: z.enum(['editor', 'viewer']) }), async ({ socket, id, data, userId }) =>
      send(socket, 'room.role.set.ok', await rooms.setRole(userId, data.roomId, data.userId, data.role), id)
    ),
  },
  'room.host.transfer': {
    requireAuth: true,
    handle: defineHandler(roomUser, async ({ socket, id, data, userId }) =>
      send(socket, 'room.host.transfer.ok', await rooms.transferHost(userId, data.roomId, data.userId), id)
    ),
  },
  'room.close': {
    requireAuth: true,
    handle: defineHandler(roomRef, async ({ socket, id, data, userId }) =>
      send(socket, 'room.close.ok', await rooms.close(userId, data.roomId), id)
    ),
  },
  'room.move.add': {
    requireAuth: true,
    handle: defineHandler(
      z.object({
        roomId: objectId,
        parentId: nodeId.nullable().default(null), // null / omitted: a move from the starting position
        uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'invalid uci move'),
        san: z.string().regex(/^[A-Za-z0-9+#=-]{2,12}$/, 'invalid san move'),
        fen,
      }),
      async ({ socket, id, data, userId }) => send(socket, 'room.move.add.ok', await rooms.addMove(userId, data.roomId, data, socket), id),
      limit('room.move.add', 20, 10000)
    ),
  },
  'room.node.delete': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ roomId: objectId, nodeId }),
      async ({ socket, id, data, userId }) =>
        send(socket, 'room.node.delete.ok', await rooms.deleteNode(userId, data.roomId, data.nodeId, socket), id),
      limit('room.node.delete', 10, 10000)
    ),
  },
  'room.position.set': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ roomId: objectId, nodeId: nodeId.nullable() }), // null = the starting position
      async ({ socket, id, data, userId }) =>
        send(socket, 'room.position.set.ok', await rooms.setPosition(userId, data.roomId, data.nodeId, socket), id),
      limit('room.position.set', 30, 10000)
    ),
  },
  'room.annotation.set': {
    requireAuth: true,
    handle: defineHandler(
      z.object({
        roomId: objectId,
        nodeId: nodeOrRoot, // 'root' = the starting position
        comment: optionalComment.optional(),
        nags: z.array(z.number().int().min(1).max(255)).max(4).optional(),
        arrows: z.array(z.object({ from: square, to: square, color })).max(12).optional(),
        squares: z.array(z.object({ square, color })).max(16).optional(),
      }),
      async ({ socket, id, data, userId }) => {
        const { roomId, nodeId: target, ...annotation } = data;
        send(socket, 'room.annotation.set.ok', await rooms.setAnnotation(userId, roomId, target, annotation, socket), id);
      },
      limit('room.annotation.set', 20, 10000)
    ),
  },
  'room.chat.send': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ roomId: objectId, text: cleaned(300) }),
      async ({ socket, id, data, userId }) => send(socket, 'room.chat.send.ok', await rooms.sendChat(userId, data.roomId, data.text, socket), id),
      limit('room.chat.send', 5, 5000)
    ),
  },
};
