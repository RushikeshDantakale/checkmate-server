'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A real-money purchase that the store confirmed (D-050). The unique `purchaseToken` means one
 * store purchase can be redeemed once, by one user.
 * States: verified (store said yes) -> granted (the user has the item) -> acknowledged
 * (the store was told, or the consumable was consumed). A retry resumes from the stored state.
 */
const purchaseSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    productId: { type: String, required: true, maxlength: 100 },
    kind: { type: String, enum: ['coin_bundle', 'pack', 'premium'], required: true },
    // Needed to acknowledge or consume later; never returned by the API and never logged.
    purchaseToken: { type: String, required: true, unique: true, select: false, maxlength: 1000 },
    orderId: { type: String, maxlength: 100 },
    state: { type: String, enum: ['verified', 'granted', 'acknowledged'], default: 'verified' },
    verifier: { type: String, maxlength: 20 },
  },
  { timestamps: true }
);

purchaseSchema.index({ userId: 1, _id: -1 });
// The reconciler retries purchases that were granted but not yet acknowledged.
purchaseSchema.index({ state: 1, updatedAt: 1 });

module.exports = mongoose.model('Purchase', purchaseSchema);
