'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A permanent personal message (collection personal_messages). Match chat and room chat are
 * NEVER stored here or anywhere else in MongoDB (brief section 4).
 */
const personalMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    senderId: { type: ObjectId, ref: 'User', required: true },
    recipientId: { type: ObjectId, ref: 'User', required: true },
    // Chosen by the client and reused when it retries (D-031).
    clientMessageId: { type: String, required: true, minlength: 8, maxlength: 64 },
    body: { type: String, required: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { collection: 'personal_messages', timestamps: { createdAt: true, updatedAt: false } }
);

// A retried send hits this index instead of creating a second message (D-031).
personalMessageSchema.index({ senderId: 1, clientMessageId: 1 }, { unique: true });
// History pages, newest first.
personalMessageSchema.index({ conversationId: 1, _id: -1 });
// "Mark everything addressed to me as read".
personalMessageSchema.index({ conversationId: 1, recipientId: 1, readAt: 1 });

module.exports = mongoose.model('PersonalMessage', personalMessageSchema);
