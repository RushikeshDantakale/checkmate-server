'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const REASONS = [
  'daily_reward',
  'pack_purchase',
  'coin_bundle',
  'tournament_entry',
  'tournament_refund',
  'tournament_prize',
  'admin_grant',
  'admin_revoke',
];

/**
 * Append-only coin ledger (D-046). `key` is chosen by the code that creates the transaction and is
 * unique, so a retry finds the same row instead of creating a second one. Rows are never edited
 * except to move from `pending` to `applied`.
 */
const transactionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 200 },
    userId: { type: ObjectId, ref: 'User', required: true },
    delta: {
      type: Number,
      required: true,
      validate: { validator: (v) => Number.isInteger(v) && v !== 0, message: 'delta must be a non-zero integer' },
    },
    reason: { type: String, enum: REASONS, required: true },
    ref: { type: String, maxlength: 100 }, // pack id, tournament id, purchase id...
    state: { type: String, enum: ['pending', 'applied'], default: 'pending' },
    balanceAfter: { type: Number },
    appliedAt: { type: Date },
  },
  { timestamps: true }
);

// A user's history, newest first.
transactionSchema.index({ userId: 1, _id: -1 });
// The reconciler looks for old pending rows.
transactionSchema.index({ state: 1, createdAt: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
Transaction.REASONS = REASONS;

module.exports = Transaction;
