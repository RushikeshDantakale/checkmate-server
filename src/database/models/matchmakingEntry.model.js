'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * Waiting players. One entry per user (unique userId). Entries expire on their own
 * (TTL) so a crash or restart can never leave someone queued forever.
 */
const matchmakingEntrySchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true, unique: true },
  timeControlId: { type: String, required: true },
  rated: { type: Boolean, default: true },
  // Players are only paired with the same variant (D-062). Entries from before variants existed count as standard.
  variant: { type: String, enum: ['standard', 'dice', 'chess960'], default: 'standard' },
  rating: { type: Number, required: true },
  joinedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

matchmakingEntrySchema.index({ timeControlId: 1, rated: 1, variant: 1, joinedAt: 1 });
matchmakingEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('MatchmakingEntry', matchmakingEntrySchema, 'matchmaking_queue');
