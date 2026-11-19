'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * One conversation per pair of users (unique sorted pairKey, same idea as friendships).
 * `members` is the two user ids sorted as strings; `unread[i]` is the unread count of members[i].
 * lastMessage / unread are a summary kept up to date AFTER a message is saved (D-031): after a
 * crash they can be briefly stale, never the messages themselves.
 */
const conversationSchema = new mongoose.Schema(
  {
    pairKey: { type: String, required: true, unique: true },
    members: {
      type: [ObjectId],
      required: true,
      validate: { validator: (v) => Array.isArray(v) && v.length === 2, message: 'a conversation has exactly two members' },
    },
    unread: { type: [Number], default: () => [0, 0] },
    lastMessage: {
      messageId: { type: ObjectId },
      senderId: { type: ObjectId },
      preview: { type: String },
      at: { type: Date },
    },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// "My conversations, most recent first" (multikey on members).
conversationSchema.index({ members: 1, lastMessageAt: -1, _id: -1 });

conversationSchema.statics.makePairKey = function makePairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
};

conversationSchema.statics.sortedMembers = function sortedMembers(a, b) {
  return [String(a), String(b)].sort();
};

module.exports = mongoose.model('Conversation', conversationSchema);
