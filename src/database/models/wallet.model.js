'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One wallet per user (D-046). `coins` is only ever changed by ONE conditional update that also
 * pushes the transaction id into `recentTxIds` (the last 50 applied ids). That push is what makes
 * a change exactly-once: the same transaction id can never be applied twice.
 */
const walletSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    coins: { type: Number, default: 0, min: 0 },
    recentTxIds: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
