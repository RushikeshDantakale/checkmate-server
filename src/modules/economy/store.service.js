'use strict';

/**
 * Entitlements, the daily reward and buying packs with coins (D-047, D-049).
 * Every coin movement goes through wallet.service (exactly-once, D-046).
 */
const config = require('../../config');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { Entitlement, Transaction } = require('../../database/models');
const wallet = require('./wallet.service');
const catalogue = require('./catalogue');

async function updateEntitlement(userId, update) {
  try {
    await Entitlement.updateOne({ userId }, update, { upsert: true });
  } catch (err) {
    // Two first grants at the same moment: the second upsert lost the race, run it again.
    if (err && err.code === 11000) await Entitlement.updateOne({ userId }, update, { upsert: true });
    else throw err;
  }
}

/** Idempotent: granting the same pack twice changes nothing. */
async function grantPack(userId, packId) {
  await updateEntitlement(userId, { $addToSet: { packs: packId } });
}

async function grantPremium(userId) {
  await updateEntitlement(userId, { $set: { premium: true } });
}

// A pack paid with coins is granted by the ledger's completer, so a crash between charging and
// granting is finished by the retry or the reconciler (D-046).
wallet.registerCompleter('pack_purchase', (tx) => grantPack(tx.userId, tx.ref));

async function getEntitlements(userId) {
  return withDb(async () => {
    const doc = await Entitlement.findOne({ userId }).lean();
    return { premium: Boolean(doc && doc.premium), packs: doc ? doc.packs : [] };
  }, 'read entitlements');
}

function dayOf(date) {
  return date.toISOString().slice(0, 10); // UTC day
}

function nextDayStart(date) {
  const d = new Date(date);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

function dailyKey(userId, date) {
  return `daily:${userId}:${dayOf(date)}`;
}

async function summary(userId, now = new Date()) {
  const [coins, entitlements, claimed] = await Promise.all([
    wallet.getBalance(userId),
    getEntitlements(userId),
    withDb(() => Transaction.exists({ key: dailyKey(userId, now) }), 'read daily reward'),
  ]);
  const amount = config.economy.dailyRewardCoins;
  return {
    coins,
    entitlements,
    dailyReward: { amount, available: amount > 0 && !claimed, nextAt: nextDayStart(now).toISOString() },
  };
}

/** Once per UTC day. A second claim the same day answers 409 DAILY_ALREADY_CLAIMED. */
async function claimDaily(userId, now = new Date()) {
  const amount = config.economy.dailyRewardCoins;
  if (amount <= 0) throw new AppError(409, 'DAILY_REWARD_DISABLED', 'There is no daily reward');
  const result = await wallet.credit({
    key: dailyKey(userId, now),
    userId,
    amount,
    reason: 'daily_reward',
    ref: dayOf(now),
  });
  if (result.duplicate) {
    throw new AppError(409, 'DAILY_ALREADY_CLAIMED', `Already claimed today; next reward at ${nextDayStart(now).toISOString()}`);
  }
  return { claimed: amount, coins: result.balance, nextAt: nextDayStart(now).toISOString() };
}

/**
 * Buys a commentator pack with coins. A retry of a purchase that already went through answers
 * success with `duplicate: true`; buying something already owned answers ALREADY_OWNED.
 */
async function buyPack(userId, packId) {
  const pack = catalogue.findPack(packId);
  if (!pack) throw new AppError(404, 'PACK_NOT_FOUND', 'Unknown pack');
  if (pack.coinPrice == null) throw new AppError(400, 'NOT_FOR_COINS', 'This pack cannot be bought with coins');

  const key = `pack:${userId}:${pack.id}`;
  const done = await withDb(() => Transaction.findOne({ key, state: 'applied' }).lean(), 'read pack purchase');
  if (done) return { ...(await summary(userId)), duplicate: true };

  if ((await getEntitlements(userId)).packs.includes(pack.id)) {
    throw new AppError(409, 'ALREADY_OWNED', 'You already own this pack');
  }
  const result = await wallet.debit({ key, userId, amount: pack.coinPrice, reason: 'pack_purchase', ref: pack.id });
  return { ...(await summary(userId)), duplicate: result.duplicate };
}

module.exports = { getEntitlements, grantPack, grantPremium, summary, claimDaily, buyPack };
