'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { validateBody, parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const { cleanText } = require('../../utils/text');
const sessions = require('./sessions.service');

const router = express.Router();
router.use(requireAuth);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
// Bound the work first (max), clean the text, then check what remains.
const title = z.string().max(120).transform(cleanText).pipe(z.string().min(1).max(60));
const saveBody = z.object({ roomId: objectId, title: title.optional() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: objectId.optional(),
});

// Saves a COPY of a room I am a member of (D-044). Returns 201, or 200 with duplicate: true for a retry.
router.post('/', validateBody(saveBody), async (req, res) => {
  const result = await sessions.save(req.auth.userId, req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
});

// My saved analyses, newest first.
router.get('/', async (req, res) => {
  res.json(await sessions.list(req.auth.userId, parseQuery(listQuery, req)));
});

// One saved analysis with its tree and annotations. Not the owner (or unknown): 404.
router.get('/:id', async (req, res) => {
  res.json(await sessions.get(req.auth.userId, requireObjectId(req.params.id, 'analysis session id')));
});

router.delete('/:id', async (req, res) => {
  res.json(await sessions.remove(req.auth.userId, requireObjectId(req.params.id, 'analysis session id')));
});

module.exports = router;
