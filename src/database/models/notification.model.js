'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// `system` and `reward` are used by any module. The `tournament_*` types are reserved for step 7c
// (D-051): no code creates them yet.
const TYPES = [
  'system',
  'reward',
  'tournament_starting',
  'tournament_round',
  'tournament_game_ready',
  'tournament_finished',
  'tournament_cancelled',
  'tournament_prize',
];

const RETENTION_DAYS = 30; // D-051

/**
 * A stored notification (D-051). Persisted so a user who was offline sees it when the app next
 * opens, and pushed live as `notification.new` to every connected device. Deleted automatically
 * RETENTION_DAYS after creation by the TTL index on `expireAt`.
 * `key` is optional: when set it must be unique per user, so a module that repeats itself after a
 * crash (for example a tournament sweeper) cannot notify the same event twice.
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: TYPES, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }, // small object for the client (ids, names, amounts)
    readAt: { type: Date, default: null },
    key: { type: String, maxlength: 200 },
    expireAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

// A user's notifications, newest first.
notificationSchema.index({ userId: 1, _id: -1 });
// Unread counter and the "unread only" list.
notificationSchema.index({ userId: 1, readAt: 1, _id: -1 });
// One notification per (user, key). Only documents that have a key take part.
notificationSchema.index({ userId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
// Automatic deletion.
notificationSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const Notification = mongoose.model('Notification', notificationSchema);
Notification.TYPES = TYPES;
Notification.RETENTION_DAYS = RETENTION_DAYS;

module.exports = Notification;
