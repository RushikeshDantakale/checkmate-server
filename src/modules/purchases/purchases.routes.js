'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { validateBody, parseQuery } = require('../../middleware/validate');
const purchases = require('./purchases.service');

const router = express.Router();
router.use(requireAuth);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
// The client says WHICH purchase it made; the server asks the store what it is worth.
const redeemBody = z.object({
  productId: z.string().min(1).max(100),
  purchaseToken: z.string().min(1).max(1000),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: objectId.optional(),
});

// Redeem a Google Play purchase. 201 the first time, 200 with duplicate: true for a retry.
router.post('/', validateBody(redeemBody), async (req, res) => {
  const result = await purchases.redeem(req.auth.userId, req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
});

// My purchases, newest first (never includes the purchase token).
router.get('/', async (req, res) => {
  res.json(await purchases.list(req.auth.userId, parseQuery(listQuery, req)));
});

module.exports = router;
