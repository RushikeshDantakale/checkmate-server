'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const messaging = require('./messaging.service');

const router = express.Router();
router.use(requireAuth);

const objectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdString.optional(),
});
const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().regex(/^\d{10,15}_[a-f\d]{24}$/i, 'invalid cursor').optional(),
});

// My conversations, most recent first.
router.get('/', async (req, res) => {
  res.json(await messaging.listConversations(req.auth.userId, parseQuery(conversationsQuery, req)));
});

// My conversation with one user, or { conversation: null } if we never wrote to each other.
router.get('/with/:userId', async (req, res) => {
  const otherId = requireObjectId(req.params.userId, 'user id');
  res.json({ conversation: await messaging.getConversationWith(req.auth.userId, otherId) });
});

// A page of messages, newest first. Anyone who is not one of the two members gets 404.
router.get('/:id/messages', async (req, res) => {
  const id = requireObjectId(req.params.id, 'conversation id');
  res.json(await messaging.listMessages(req.auth.userId, id, parseQuery(messagesQuery, req)));
});

// Marks everything addressed to me in this conversation as read.
router.post('/:id/read', async (req, res) => {
  const id = requireObjectId(req.params.id, 'conversation id');
  res.json(await messaging.markRead(req.auth.userId, id));
});

module.exports = router;
