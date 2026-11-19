'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const spectators = require('../../modules/spectators/spectators.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const gameRef = z.object({ gameId: objectId });

/**
 * Spectators (D-041, D-042). `spectate.join` replies `spectate.state` (the full game with its moves);
 * pushes: `spectate.update`, `spectate.over`, `spectate.count`.
 */
module.exports = {
  'spectate.join': {
    requireAuth: true,
    handle: defineHandler(
      gameRef,
      async ({ socket, id, data, userId }) => send(socket, 'spectate.state', await spectators.join(userId, data.gameId, socket), id),
      { rateLimit: { key: 'spectate.join', limit: 10, windowMs: 10000 } }
    ),
  },
  'spectate.leave': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) =>
      send(socket, 'spectate.leave.ok', spectators.leave(userId, data.gameId, socket), id)
    ),
  },
};
