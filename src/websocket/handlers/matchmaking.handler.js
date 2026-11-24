'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const matchmaking = require('../../modules/matchmaking/matchmaking.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const timeControl = z.string().max(16);

const variant = z.enum(['standard', 'dice', 'chess960']).default('standard'); // optional: older clients omit it

const queueJoin = z.object({ timeControl, rated: z.boolean().default(true), variant });
const inviteSend = z.object({
  userId: objectId,
  timeControl,
  rated: z.boolean().default(false),
  variant,
});
const inviteRef = z.object({ inviteId: objectId });

/** Matchmaking queue and friend invitations. A match start is announced with `game.started`. */
module.exports = {
  'queue.join': {
    requireAuth: true,
    handle: defineHandler(queueJoin, async ({ socket, id, data, userId }) => {
      const result = await matchmaking.joinQueue(userId, data.timeControl, data.rated, data.variant);
      send(socket, 'queue.joined', result, id);
    }, { rateLimit: { key: 'queue.join', limit: 10, windowMs: 10000 } }),
  },
  'queue.leave': {
    requireAuth: true,
    handle: defineHandler(z.object({}), async ({ socket, id, userId }) => {
      send(socket, 'queue.left', await matchmaking.leaveQueue(userId), id);
    }, { rateLimit: { key: 'queue.leave', limit: 10, windowMs: 10000 } }),
  },
  'invite.send': {
    requireAuth: true,
    handle: defineHandler(inviteSend, async ({ socket, id, data, userId }) => {
      const result = await matchmaking.sendInvite(userId, data.userId, data.timeControl, data.rated, data.variant);
      send(socket, 'invite.sent', result, id);
    }, { rateLimit: { key: 'invite.send', limit: 10, windowMs: 10000 } }),
  },
  'invite.accept': {
    requireAuth: true,
    handle: defineHandler(inviteRef, async ({ socket, id, data, userId }) => {
      send(socket, 'invite.accepted', await matchmaking.acceptInvite(userId, data.inviteId), id);
    }, { rateLimit: { key: 'invite.accept', limit: 10, windowMs: 10000 } }),
  },
  'invite.decline': {
    requireAuth: true,
    handle: defineHandler(inviteRef, async ({ socket, id, data, userId }) => {
      send(socket, 'invite.declined', await matchmaking.declineInvite(userId, data.inviteId), id);
    }, { rateLimit: { key: 'invite.decline', limit: 10, windowMs: 10000 } }),
  },
  'invite.cancel': {
    requireAuth: true,
    handle: defineHandler(inviteRef, async ({ socket, id, data, userId }) => {
      send(socket, 'invite.cancelled', await matchmaking.cancelInvite(userId, data.inviteId), id);
    }, { rateLimit: { key: 'invite.cancel', limit: 10, windowMs: 10000 } }),
  },
};
