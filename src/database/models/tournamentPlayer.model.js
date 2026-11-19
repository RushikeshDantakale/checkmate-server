'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One document per (tournament, user): registration state and refund bookkeeping (D-054).
 *   pending    the user asked to join; the entry fee may or may not have been charged yet
 *   joined     registered (the fee was charged)
 *   withdrawn  left before the start, was evicted (full or started meanwhile) or the tournament was cancelled
 * A user can join a tournament only once: leaving is final, because the ledger keys for the fee
 * and the refund are fixed per (tournament, user) so that a retry can never charge or pay twice.
 * `refundPending` is set in the same update that withdraws the user; the sweeper pays the refund
 * (idempotent) and clears it, so a crash between the two steps loses nothing.
 */
const tournamentPlayerSchema = new mongoose.Schema(
  {
    tournamentId: { type: ObjectId, ref: 'Tournament', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    rating: { type: Number, required: true }, // rating when the user joined: tie-break (D-055)
    state: { type: String, enum: ['pending', 'joined', 'withdrawn'], default: 'pending' },
    refundPending: { type: Boolean, default: false },
  },
  { collection: 'tournament_players', timestamps: true }
);

tournamentPlayerSchema.index({ tournamentId: 1, userId: 1 }, { unique: true });
// The roster in join order, and the capacity check.
tournamentPlayerSchema.index({ tournamentId: 1, state: 1, _id: 1 });
// "My tournaments", newest first.
tournamentPlayerSchema.index({ userId: 1, _id: -1 });
// The sweeper: half-finished joins and refunds that still have to be paid.
tournamentPlayerSchema.index({ state: 1, updatedAt: 1 });
tournamentPlayerSchema.index({ refundPending: 1 }, { partialFilterExpression: { refundPending: true } });

module.exports = mongoose.model('TournamentPlayer', tournamentPlayerSchema);
