'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { validateBody, parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const { cleanText } = require('../../utils/text');
const config = require('../../config');
const tournaments = require('./tournaments.service');
const { MIN_PLAYERS, MAX_PLAYERS } = require('./tournaments.logic');

const router = express.Router();
router.use(requireAuth);

const createBody = z.object({
  name: z.string().max(80).transform(cleanText).pipe(z.string().min(3).max(40)),
  timeControl: z.string().max(16),
  rated: z.boolean().default(true),
  entryFee: z.number().int().min(0).max(config.tournament.maxEntryFee).default(0),
  maxPlayers: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS).default(16),
  rounds: z.number().int().min(1).max(MAX_PLAYERS - 1).optional(),
  startsAt: z.string().datetime({ offset: true }),
});

const listQuery = z.object({
  status: z.enum(['registration', 'running', 'finished', 'cancelled']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id').optional(),
});

// Tournaments, newest first. `status` filters, `mine=true` lists the ones I host or joined (my history).
router.get('/', async (req, res) => {
  const { status, mine, limit, cursor } = parseQuery(listQuery, req);
  res.json(await tournaments.list(req.auth.userId, { status, mine: mine === 'true', limit, cursor }));
});

// Create a tournament (any user; limited to a few open ones per host).
router.post('/', validateBody(createBody), async (req, res) => {
  res.status(201).json(await tournaments.create(req.auth.userId, req.body));
});

// One tournament in full: entrants, standings, rounds and pairings, prizes. Visible to every logged-in user.
router.get('/:id', async (req, res) => {
  res.json(await tournaments.get(req.auth.userId, requireObjectId(req.params.id, 'tournament id')));
});

router.post('/:id/join', async (req, res) => {
  res.json(await tournaments.join(req.auth.userId, requireObjectId(req.params.id, 'tournament id')));
});

router.post('/:id/leave', async (req, res) => {
  res.json(await tournaments.leave(req.auth.userId, requireObjectId(req.params.id, 'tournament id')));
});

// Host only, before the start.
router.post('/:id/cancel', async (req, res) => {
  res.json(await tournaments.cancelByHost(req.auth.userId, requireObjectId(req.params.id, 'tournament id')));
});

module.exports = router;
