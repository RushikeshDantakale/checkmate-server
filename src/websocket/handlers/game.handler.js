'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const games = require('../../modules/games/games.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const gameRef = z.object({ gameId: objectId });

const moveSchema = z.object({
  gameId: objectId,
  moveId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, '8-64 characters: letters, digits, _ or -'),
  seq: z.number().int().min(0).max(100000), // number of moves already confirmed (the seq the client has seen)
  uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'must be UCI like e2e4 or e7e8q'),
  san: z.string().regex(/^[A-Za-z0-9+#=-]{2,12}$/, 'must be SAN like Nf3 or O-O'),
  fen: z.string().max(100).regex(/^\S+( \S+){5}$/, 'must be a full FEN after the move'),
  outcome: z
    .object({
      result: z.enum(['1-0', '0-1', '1/2-1/2']),
      reason: z.string().max(32),
    })
    .optional(),
});

/** Registers game events. All of them need an authenticated socket. */
module.exports = {
  'game.join': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      const game = await games.getGameForUser(userId, data.gameId);
      games.claimController(game._id, userId, socket); // newest device takes over (D-026)
      send(socket, 'game.state', { game: games.view(game, { withMoves: true }) }, id);
    }, { rateLimit: { key: 'game.join', limit: 20, windowMs: 10000 } }),
  },
  'game.move': {
    requireAuth: true,
    handle: defineHandler(moveSchema, async ({ socket, id, data, userId }) => {
      games.assertController(data.gameId, userId, socket);
      const { payload } = await games.makeMove({ userId, ...data, fromSocket: socket });
      // Only reached after the move is durable (or was already stored, for a retry).
      send(socket, 'game.move.ack', payload, id);
    }, { rateLimit: { key: 'game.move', limit: 20, windowMs: 10000 } }),
  },
  'game.resign': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      games.assertController(data.gameId, userId, socket);
      await games.resign(userId, data.gameId);
      send(socket, 'game.resign.ok', { gameId: data.gameId }, id);
    }, { rateLimit: { key: 'game.resign', limit: 5, windowMs: 10000 } }),
  },
  'game.draw.offer': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      games.assertController(data.gameId, userId, socket);
      await games.offerDraw(userId, data.gameId);
      send(socket, 'game.draw.offer.ok', { gameId: data.gameId }, id);
    }, { rateLimit: { key: 'game.draw.offer', limit: 5, windowMs: 10000 } }),
  },
  'game.draw.accept': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      games.assertController(data.gameId, userId, socket);
      await games.acceptDraw(userId, data.gameId);
      send(socket, 'game.draw.accept.ok', { gameId: data.gameId }, id);
    }, { rateLimit: { key: 'game.draw.accept', limit: 10, windowMs: 10000 } }),
  },
  'game.draw.decline': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      games.assertController(data.gameId, userId, socket);
      await games.declineDraw(userId, data.gameId);
      send(socket, 'game.draw.decline.ok', { gameId: data.gameId }, id);
    }, { rateLimit: { key: 'game.draw.decline', limit: 10, windowMs: 10000 } }),
  },
};
