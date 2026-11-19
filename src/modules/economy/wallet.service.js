'use strict';

/**
 * Coin wallet and ledger (D-046, D-047).
 *
 * Every change to a balance goes through apply(). It is exactly-once without database
 * transactions:
 *   1. insert the ledger row with a caller-chosen unique `key` (a retry finds the same row),
 *   2. ONE conditional update on the wallet: the transaction id must not already be in
 *      `recentTxIds` and, for a spend, the balance must cover it. It changes `coins` and pushes
 *      the id in the same step, so the same transaction can never be applied twice,
 *   2b. run the reason's completer (an idempotent side effect such as granting a pack),
 *   3. mark the ledger row `applied`.
 * A crash anywhere leaves the row `pending`; a retry or the reconciler continues from there.
 * A balance can never go below zero, because the spend filter checks it atomically.
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { Wallet, Transaction } = require('../../database/models');

const MAX_RECENT = 50;
const completers = new Map(); // reason -> async (tx) => void. MUST be idempotent: it can run more than once.

function registerCompleter(reason, fn) {
  completers.set(reason, fn);
}

async function ensureWallet(userId) {
  try {
    await Wallet.updateOne({ userId }, { $setOnInsert: { coins: 0, recentTxIds: [] } }, { upsert: true });
  } catch (err) {
    // Two first requests at the same moment: the other upsert created it.
    if (!(err && err.code === 11000)) throw err;
  }
}

function transactionView(t) {
  return {
    id: String(t._id),
    delta: t.delta,
    reason: t.reason,
    ref: t.ref || null,
    balanceAfter: t.balanceAfter ?? null,
    at: t.appliedAt || t.createdAt,
  };
}

async function readBalance(userId) {
  const wallet = await Wallet.findOne({ userId }).select('coins').lean();
  return wallet ? wallet.coins : 0;
}

/** Steps 2 to 3 for one ledger row. Safe to call again for the same row. */
async function finish(tx) {
  await ensureWallet(tx.userId);
  const id = String(tx._id);
  const filter = { userId: tx.userId, recentTxIds: { $ne: id } };
  if (tx.delta < 0) filter.coins = { $gte: -tx.delta };
  const changed = await Wallet.findOneAndUpdate(
    filter,
    { $inc: { coins: tx.delta }, $push: { recentTxIds: { $each: [id], $slice: -MAX_RECENT } } },
    { returnDocument: 'after' }
  ).lean();

  let balance;
  let freshlyApplied;
  if (changed) {
    balance = changed.coins;
    freshlyApplied = true;
  } else {
    // No match: either this id was applied before, or a spend is not covered.
    const wallet = await Wallet.findOne({ userId: tx.userId }).lean();
    if (wallet && wallet.recentTxIds.includes(id)) {
      balance = wallet.coins;
      freshlyApplied = false;
    } else {
      await Transaction.deleteOne({ _id: tx._id, state: 'pending' }); // nothing was charged
      throw new AppError(402, 'INSUFFICIENT_COINS', 'Not enough coins');
    }
  }

  const completer = completers.get(tx.reason);
  if (completer) await completer(tx);

  let applied = await Transaction.findOneAndUpdate(
    { _id: tx._id, state: 'pending' },
    { $set: { state: 'applied', balanceAfter: balance, appliedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();
  if (!applied) applied = await Transaction.findById(tx._id).lean(); // another request finished it first
  return { tx: applied, balance, duplicate: !freshlyApplied };
}

/**
 * Applies one signed change. `key` identifies the business event ("daily:<user>:<date>",
 * "tournament:<id>:prize:<user>"): calling again with the same key never applies it twice.
 * Throws INSUFFICIENT_COINS (402) if a spend is not covered, nothing is changed then.
 */
async function apply({ key, userId, delta, reason, ref }) {
  if (!Number.isInteger(delta) || delta === 0) throw new TypeError('delta must be a non-zero integer');
  return withDb(async () => {
    await ensureWallet(userId);
    let tx = await Transaction.findOne({ key }).lean();
    if (!tx) {
      try {
        tx = (await Transaction.create({ key, userId, delta, reason, ref })).toObject();
      } catch (err) {
        if (err && err.code === 11000) tx = await Transaction.findOne({ key }).lean();
        else throw err;
      }
    }
    if (!tx) throw new Error('ledger row disappeared'); // a concurrent rejected spend removed it: retryable
    if (String(tx.userId) !== String(userId) || tx.delta !== delta || tx.reason !== reason) {
      throw new AppError(409, 'TRANSACTION_KEY_CONFLICT', 'This transaction key was already used for something else');
    }
    if (tx.state === 'applied') return { tx, balance: await readBalance(userId), duplicate: true };
    return finish(tx);
  }, 'wallet transaction');
}

const credit = ({ amount, ...rest }) => apply({ ...rest, delta: amount });
const debit = ({ amount, ...rest }) => apply({ ...rest, delta: -amount });

async function getBalance(userId) {
  return withDb(() => readBalance(userId), 'read balance');
}

async function listTransactions(userId, { limit, cursor }) {
  return withDb(async () => {
    const filter = { userId, state: 'applied' };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Transaction.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(transactionView), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }, 'list transactions');
}

/**
 * Continues ledger rows that a crash left `pending` (D-046). A spend that never reached the
 * wallet is discarded (the user was not charged); everything else is finished. Returns counts.
 */
async function reconcile(now = Date.now()) {
  const cutoff = new Date(now - config.economy.pendingAgeMs);
  const rows = await Transaction.find({ state: 'pending', createdAt: { $lt: cutoff } })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();
  let healed = 0;
  let discarded = 0;
  for (const tx of rows) {
    try {
      const wallet = await Wallet.findOne({ userId: tx.userId }).select('recentTxIds').lean();
      const charged = Boolean(wallet && wallet.recentTxIds.includes(String(tx._id)));
      if (tx.delta < 0 && !charged) {
        await Transaction.deleteOne({ _id: tx._id, state: 'pending' });
        discarded += 1;
        continue;
      }
      await finish(tx);
      healed += 1;
    } catch (err) {
      if (!(err instanceof AppError)) logger.warn({ reason: err.message, key: tx.key }, 'ledger reconcile failed for a row');
    }
  }
  return { healed, discarded };
}

module.exports = {
  registerCompleter,
  apply,
  credit,
  debit,
  getBalance,
  listTransactions,
  reconcile,
  transactionView,
};
