'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { validateBody, parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const { withDb } = require('../../utils/db');
const { AppError } = require('../../utils/errors');
const retention = require('../retention/retention.service');
const storageMonitor = require('../health/storage.monitor');
const admin = require('./admin.service');

/** Administrator API (D-059). Every route needs a logged-in user whose role is `admin`. */
const router = express.Router();
router.use(requireAuth, requireAdmin);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const reason = z.string().trim().min(3).max(300);
const limitField = (def) => z.coerce.number().int().min(1).max(100).default(def);

const usersQuery = z.object({
  search: z.string().trim().min(1).max(20).optional(),
  status: z.enum(['active', 'suspended', 'banned']).optional(),
  limit: limitField(30),
  cursor: objectId.optional(),
});
const reportsQuery = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed', 'all']).default('open'),
  limit: limitField(30),
  cursor: objectId.optional(),
});
const auditQuery = z.object({
  adminId: objectId.optional(),
  targetId: objectId.optional(),
  action: z.string().max(60).optional(),
  limit: limitField(50),
  cursor: objectId.optional(),
});

const statusBody = z.object({ status: z.enum(['active', 'suspended', 'banned']), reason });
const coinsBody = z.object({
  amount: z.number().int().min(-100000).max(100000).refine((n) => n !== 0, 'must not be 0'),
  reason,
  // Chosen by the admin client and reused when it retries, so a coin change is never applied twice.
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, '8-64 characters: letters, digits, _ or -'),
});
const entitlementsBody = z.object({
  premium: z.boolean().optional(),
  grantPacks: z.array(z.string().max(40)).max(20).optional(),
  revokePacks: z.array(z.string().max(40)).max(20).optional(),
  reason,
});
const resolveBody = z.object({ status: z.enum(['reviewed', 'dismissed']), note: z.string().trim().max(300).optional() });
const cancelBody = z.object({ reason });

// ---- users
router.get('/users', async (req, res) => {
  res.json(await admin.searchUsers(parseQuery(usersQuery, req)));
});
router.get('/users/:id', async (req, res) => {
  res.json(await admin.getUser(requireObjectId(req.params.id, 'user id')));
});
router.post('/users/:id/status', validateBody(statusBody), async (req, res) => {
  res.json(await admin.setStatus(req.auth.userId, requireObjectId(req.params.id, 'user id'), req.body));
});
router.post('/users/:id/coins', validateBody(coinsBody), async (req, res) => {
  res.json(await admin.adjustCoins(req.auth.userId, requireObjectId(req.params.id, 'user id'), req.body));
});
router.post('/users/:id/entitlements', validateBody(entitlementsBody), async (req, res) => {
  res.json(await admin.setEntitlements(req.auth.userId, requireObjectId(req.params.id, 'user id'), req.body));
});

// ---- reports
router.get('/reports', async (req, res) => {
  res.json(await admin.listReports(parseQuery(reportsQuery, req)));
});
router.post('/reports/:id/resolve', validateBody(resolveBody), async (req, res) => {
  res.json(await admin.resolveReport(req.auth.userId, requireObjectId(req.params.id, 'report id'), req.body));
});

// ---- tournaments
router.post('/tournaments/:id/repair', async (req, res) => {
  res.json(await admin.repairTournament(req.auth.userId, requireObjectId(req.params.id, 'tournament id')));
});
router.post('/tournaments/:id/cancel', validateBody(cancelBody), async (req, res) => {
  res.json(await admin.cancelTournament(req.auth.userId, requireObjectId(req.params.id, 'tournament id'), req.body));
});

// ---- audit log (read only)
router.get('/audit', async (req, res) => {
  res.json(await admin.listAudit(parseQuery(auditQuery, req)));
});

// ---- retention preview (D-060): what the cleanup job WOULD change right now. Read only, changes nothing.
router.get('/retention', async (req, res) => {
  const report = await withDb(() => retention.run({ dryRun: true }), 'retention preview');
  if (!report) throw new AppError(409, 'RETENTION_BUSY', 'A cleanup run is in progress; try again in a moment');
  res.json({ ...report, storage: storageMonitor.getStatus() });
});

module.exports = router;
