'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const notifications = require('./notifications.service');

const router = express.Router();
router.use(requireAuth);

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id').optional(),
  unread: z.enum(['true', 'false']).optional(),
});

// My notifications, newest first. `unread=true` lists only the unread ones.
router.get('/', async (req, res) => {
  const { limit, cursor, unread } = parseQuery(listQuery, req);
  res.json(await notifications.list(req.auth.userId, { limit, cursor, unreadOnly: unread === 'true' }));
});

// Just the number (for the badge).
router.get('/unread-count', async (req, res) => {
  res.json(await notifications.unreadCount(req.auth.userId));
});

// Mark every notification read.
router.post('/read-all', async (req, res) => {
  res.json(await notifications.markAllRead(req.auth.userId));
});

// Mark one read. Safe to repeat. Not mine or unknown: 404.
router.post('/:id/read', async (req, res) => {
  res.json(await notifications.markRead(req.auth.userId, requireObjectId(req.params.id, 'notification id')));
});

module.exports = router;
