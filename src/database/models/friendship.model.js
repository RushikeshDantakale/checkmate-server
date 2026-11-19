'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One document per pair of users, whichever direction the request went.
 * `pairKey` (the two ids sorted and joined) is unique, so duplicate or
 * simultaneous requests between the same two users cannot create two documents.
 */
const friendshipSchema = new mongoose.Schema(
  {
    requester: { type: ObjectId, ref: 'User', required: true },
    recipient: { type: ObjectId, ref: 'User', required: true },
    pairKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

friendshipSchema.index({ recipient: 1, status: 1, _id: -1 });
friendshipSchema.index({ requester: 1, status: 1, _id: -1 });

friendshipSchema.statics.makePairKey = function makePairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
};

module.exports = mongoose.model('Friendship', friendshipSchema);
