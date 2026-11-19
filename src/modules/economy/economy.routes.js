'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { parseQuery } = require('../../middleware/validate');
const { AppError } = require('../../utils/errors');
const wallet = require('./wallet.service');
const store = require('./store.service');
const catalogue = require('./catalogue');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const transactionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: objectId.optional(),
});

// ---- /api/v1/wallet
const walletRouter = express.Router();
walletRouter.use(requireAuth);

// Balance, what I own, and whether today's reward can be claimed.
walletRouter.get('/', async (req, res) => {
  res.json(await store.summary(req.auth.userId));
});

// My coin history, newest first.
walletRouter.get('/transactions', async (req, res) => {
  res.json(await wallet.listTransactions(req.auth.userId, parseQuery(transactionsQuery, req)));
});

// Once per UTC day. A second claim the same day answers 409 DAILY_ALREADY_CLAIMED.
walletRouter.post('/daily-reward', async (req, res) => {
  res.json(await store.claimDaily(req.auth.userId));
});

// ---- /api/v1/store
const storeRouter = express.Router();
storeRouter.use(requireAuth);

storeRouter.get('/catalogue', (req, res) => {
  res.json(catalogue.publicCatalogue());
});

// Buy a commentator pack with coins. The price comes from the server catalogue, never from the client.
storeRouter.post('/packs/:packId/buy', async (req, res) => {
  const packId = req.params.packId;
  if (!/^[a-z0-9_]{1,50}$/.test(packId)) throw new AppError(404, 'PACK_NOT_FOUND', 'Unknown pack');
  res.json(await store.buyPack(req.auth.userId, packId));
});

module.exports = { walletRouter, storeRouter };
