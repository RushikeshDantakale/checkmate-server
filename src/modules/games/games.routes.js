'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { parseQuery } = require('../../middleware/validate');
const { AppError } = require('../../utils/errors');
const games = require('./games.service');
const history = require('./history.service');
const spectators = require('../spectators/spectators.service');

const router = express.Router();
router.use(requireAuth);

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id').optional(),
});

// My finished and aborted games, newest first, as short summaries (D-043).
router.get('/', async (req, res) => {
  res.json(await history.listHistory(req.auth.userId, parseQuery(historyQuery, req)));
});

// The game the caller is currently in (live or paused), or { game: null }. Call this after (re)connecting.
router.get('/active', async (req, res) => {
  res.json({ game: await games.getActiveGameView(req.auth.userId) });
});

// Live games of my friends that I may watch (D-041). Watching itself is a WebSocket event: spectate.join.
router.get('/live', async (req, res) => {
  res.json(await spectators.listWatchable(req.auth.userId));
});

// A game the caller played (any status), or a COMPLETED game the caller may watch (D-041). Others get 404.
router.get('/:id', async (req, res) => {
  const game = await history.getGameForViewer(req.auth.userId, req.params.id);
  res.json({ game: games.view(game, { withMoves: true }) });
});

router.get('/:id/pgn', async (req, res) => {
  const game = await history.getGameForViewer(req.auth.userId, req.params.id);
  if (!game.pgn) throw new AppError(409, 'GAME_NOT_FINISHED', 'PGN is available when the game is over');
  res.json({ pgn: game.pgn });
});

module.exports = router;
