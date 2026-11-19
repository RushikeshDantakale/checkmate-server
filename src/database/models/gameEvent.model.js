'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * Append-only audit trail of non-move game events (start, pause, resume, disconnect,
 * resign, timeout, recovery...). Moves live in the game document itself.
 * Written best-effort: a failure here must never block or fail gameplay.
 * Retention: documents expire after 90 days (TTL on `at`).
 */
const gameEventSchema = new mongoose.Schema({
  gameId: { type: ObjectId, required: true },
  type: { type: String, required: true, maxlength: 64 },
  userId: { type: ObjectId },
  data: { type: mongoose.Schema.Types.Mixed },
  at: { type: Date, default: Date.now },
});

gameEventSchema.index({ gameId: 1, _id: 1 });
gameEventSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('GameEvent', gameEventSchema, 'game_events');
