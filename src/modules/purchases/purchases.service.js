'use strict';

/**
 * Real-money purchases (D-050). The Android app sends ONLY { productId, purchaseToken }; the
 * server asks the store (the verifier) what was really paid and decides what the user gets.
 *
 * States of a purchase row: verified -> granted -> acknowledged. Every step is idempotent, so
 * a retry (or the reconciler) continues from the stored state:
 *   - one store token can be redeemed once, by one user (unique `purchaseToken`),
 *   - coin bundles are credited with the ledger key `purchase:<purchase id>` (never twice),
 *   - packs and premium are set-adds, so granting twice changes nothing,
 *   - telling the store (acknowledge / consume) may fail; the user already has the item and the
 *     reconciler retries it (Google refunds purchases that are not acknowledged after 3 days).
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { Purchase } = require('../../database/models');
const catalogue = require('../economy/catalogue');
const wallet = require('../economy/wallet.service');
const store = require('../economy/store.service');
const verifiers = require('./verifiers');

function purchaseView(p) {
  return {
    id: String(p._id),
    productId: p.productId,
    kind: p.kind,
    state: p.state,
    orderId: p.orderId || null,
    at: p.createdAt,
  };
}

async function verifyWithStore(verifier, args) {
  try {
    return await verifier.verify(args);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ reason: err.message, verifier: verifier.name }, 'purchase verification failed');
    throw new AppError(503, 'PURCHASE_VERIFICATION_UNAVAILABLE', 'Could not reach the store; retry the same request');
  }
}

async function moveTo(purchase, from, to) {
  await Purchase.updateOne({ _id: purchase._id, state: from }, { $set: { state: to } });
}

/** Gives the user what the purchase is worth. Idempotent. */
async function grant(purchase, item) {
  if (purchase.kind === 'coin_bundle') {
    await wallet.credit({
      key: `purchase:${purchase._id}`,
      userId: purchase.userId,
      amount: item.coins,
      reason: 'coin_bundle',
      ref: purchase.productId,
    });
  } else if (purchase.kind === 'pack') {
    await store.grantPack(purchase.userId, item.id);
  } else {
    await store.grantPremium(purchase.userId);
  }
}

/** Continues a purchase from its stored state. Returns whether the store has been told. */
async function advance(purchase, found, verifier) {
  let state = purchase.state;
  if (state === 'verified') {
    await grant(purchase, found.item);
    await withDb(() => moveTo(purchase, 'verified', 'granted'), 'purchase granted');
    state = 'granted';
  }
  if (state === 'granted') {
    try {
      await verifier.finalize({
        productId: purchase.productId,
        purchaseToken: purchase.purchaseToken,
        consumable: purchase.kind === 'coin_bundle',
      });
      await withDb(() => moveTo(purchase, 'granted', 'acknowledged'), 'purchase acknowledged');
      state = 'acknowledged';
    } catch (err) {
      // The user already has the item. The reconciler tries again; never fail the request for this.
      logger.warn({ reason: err.message, purchaseId: String(purchase._id) }, 'could not acknowledge purchase, will retry');
    }
  }
  return state;
}

async function redeem(userId, { productId, purchaseToken }) {
  const found = catalogue.findByPlayProduct(productId);
  if (!found) throw new AppError(400, 'UNKNOWN_PRODUCT', 'Unknown product');
  const verifier = verifiers.current();
  const me = String(userId);

  let purchase = await withDb(
    () => Purchase.findOne({ purchaseToken }).select('+purchaseToken').lean(),
    'find purchase'
  );
  let duplicate = false;

  if (purchase) {
    if (String(purchase.userId) !== me) {
      throw new AppError(409, 'PURCHASE_ALREADY_REDEEMED', 'This purchase was already redeemed');
    }
    if (purchase.productId !== productId) {
      throw new AppError(409, 'PURCHASE_PRODUCT_MISMATCH', 'This purchase belongs to a different product');
    }
    duplicate = true;
  } else {
    const result = await verifyWithStore(verifier, { productId, purchaseToken });
    if (result.status === 'invalid') throw new AppError(400, 'PURCHASE_INVALID', 'The store does not know this purchase');
    if (result.status === 'pending') throw new AppError(409, 'PURCHASE_PENDING', 'Payment is still pending; try again later');
    if (result.status === 'cancelled') throw new AppError(400, 'PURCHASE_CANCELLED', 'This purchase was cancelled or refunded');
    if (result.accountId && result.accountId !== me) {
      throw new AppError(403, 'PURCHASE_WRONG_ACCOUNT', 'This purchase was made for a different account');
    }
    purchase = await withDb(async () => {
      try {
        const doc = await Purchase.create({
          userId,
          productId,
          kind: found.kind,
          purchaseToken,
          orderId: result.orderId,
          verifier: verifier.name,
        });
        return { ...doc.toObject(), purchaseToken };
      } catch (err) {
        if (!(err && err.code === 11000)) throw err;
        // The same token arrived twice at once; the other request created the row.
        return Purchase.findOne({ purchaseToken }).select('+purchaseToken').lean();
      }
    }, 'create purchase');
    if (!purchase) throw new AppError(503, 'TEMPORARILY_UNAVAILABLE', 'Retry the same request');
    if (String(purchase.userId) !== me) {
      throw new AppError(409, 'PURCHASE_ALREADY_REDEEMED', 'This purchase was already redeemed');
    }
  }

  const state = await advance(purchase, found, verifier);
  const summary = await store.summary(userId);
  return {
    purchase: { ...purchaseView(purchase), state },
    coins: summary.coins,
    entitlements: summary.entitlements,
    finalized: state === 'acknowledged',
    duplicate,
  };
}

async function list(userId, { limit, cursor }) {
  return withDb(async () => {
    const filter = { userId };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Purchase.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(purchaseView), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }, 'list purchases');
}

/** Continues purchases that a crash or a store outage left unfinished (D-050). */
async function reconcile(now = Date.now()) {
  const cutoff = new Date(now - config.economy.pendingAgeMs);
  const rows = await Purchase.find({ state: { $in: ['verified', 'granted'] }, updatedAt: { $lt: cutoff } })
    .select('+purchaseToken')
    .sort({ updatedAt: 1 })
    .limit(50)
    .lean();
  let continued = 0;
  for (const purchase of rows) {
    try {
      const found = catalogue.findByPlayProduct(purchase.productId);
      if (!found) continue;
      await advance(purchase, found, verifiers.current());
      continued += 1;
    } catch (err) {
      if (!(err instanceof AppError)) logger.warn({ reason: err.message }, 'purchase reconcile failed for a row');
    }
  }
  return { continued };
}

module.exports = { redeem, list, reconcile };
