'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { validateBody, parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const friends = require('./friends.service');

const router = express.Router();
router.use(requireAuth);

const objectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdString.optional(),
});
const requestsQuery = pageQuery.extend({ direction: z.enum(['incoming', 'outgoing']).default('incoming') });
const sendRequestBody = z.object({ username: z.string().trim().min(3).max(20) });
const blockBody = z.object({ userId: objectIdString });
const reportBody = z.object({
  userId: objectIdString,
  reason: z.enum(['cheating', 'abuse', 'harassment', 'spam', 'other']),
  details: z.string().trim().max(500).optional(),
});

router.get('/', async (req, res) => {
  res.json(await friends.listFriends(req.auth.userId, parseQuery(pageQuery, req)));
});

router.get('/requests', async (req, res) => {
  res.json(await friends.listRequests(req.auth.userId, parseQuery(requestsQuery, req)));
});

router.post('/requests', validateBody(sendRequestBody), async (req, res) => {
  const result = await friends.sendRequest(req.auth.userId, req.body.username);
  res.status(result.autoAccepted ? 200 : 201).json(result);
});

router.post('/requests/:id/accept', async (req, res) => {
  res.json(await friends.acceptRequest(req.auth.userId, requireObjectId(req.params.id, 'request id')));
});

router.post('/requests/:id/reject', async (req, res) => {
  await friends.rejectRequest(req.auth.userId, requireObjectId(req.params.id, 'request id'));
  res.status(204).end();
});

router.delete('/requests/:id', async (req, res) => {
  await friends.cancelRequest(req.auth.userId, requireObjectId(req.params.id, 'request id'));
  res.status(204).end();
});

router.get('/blocks', async (req, res) => {
  res.json(await friends.listBlocks(req.auth.userId, parseQuery(pageQuery, req)));
});

router.post('/blocks', validateBody(blockBody), async (req, res) => {
  await friends.blockUser(req.auth.userId, req.body.userId);
  res.status(204).end();
});

router.delete('/blocks/:userId', async (req, res) => {
  await friends.unblockUser(req.auth.userId, requireObjectId(req.params.userId, 'user id'));
  res.status(204).end();
});

router.delete('/:userId', async (req, res) => {
  await friends.unfriend(req.auth.userId, requireObjectId(req.params.userId, 'user id'));
  res.status(204).end();
});

// Mounted separately at /api/v1/reports
const reportsRouter = express.Router();
reportsRouter.use(requireAuth);
reportsRouter.post('/', validateBody(reportBody), async (req, res) => {
  res.status(201).json(await friends.reportUser(req.auth.userId, req.body));
});

module.exports = { router, reportsRouter };
