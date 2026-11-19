'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * What a user owns (D-049): premium (one-time) and commentator packs. Granting is always a
 * set-add or a set-true, so granting twice has no extra effect.
 */
const entitlementSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    premium: { type: Boolean, default: false },
    packs: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Entitlement', entitlementSchema);
