'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/** Game invitation between two friends. Short-lived; documents are cleaned up an hour after expiry. */
const invitationSchema = new mongoose.Schema(
  {
    fromId: { type: ObjectId, ref: 'User', required: true },
    toId: { type: ObjectId, ref: 'User', required: true },
    timeControlId: { type: String, required: true },
    rated: { type: Boolean, default: false },
    variant: { type: String, enum: ['standard', 'dice', 'chess960'], default: 'standard' },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'cancelled'],
      default: 'pending',
    },
    gameId: { type: ObjectId },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

invitationSchema.index({ toId: 1, status: 1, expiresAt: 1 });
invitationSchema.index({ fromId: 1, status: 1 });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

module.exports = mongoose.model('Invitation', invitationSchema);
