'use strict';

const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Audit log of administrator actions (D-059). A row is written BEFORE the action (`started`) and then
 * marked `done` or `failed`, so no effect can exist without a record. Append-only: nothing in the API
 * edits or deletes rows, and there is no TTL. Never put passwords, tokens or e-mail addresses in `details`.
 */
const adminActionSchema = new mongoose.Schema(
  {
    // Optional idempotency key chosen by the admin client (for example "coins:<requestId>").
    key: { type: String, maxlength: 200 },
    // null = the owner's local script (scripts/set-role.js), not a logged-in admin.
    adminId: { type: ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, maxlength: 60 },
    targetType: { type: String, enum: ['user', 'tournament', 'report', 'system'], required: true },
    targetId: { type: ObjectId, default: null },
    details: { type: Mixed, default: () => ({}) },
    status: { type: String, enum: ['started', 'done', 'failed'], default: 'started' },
    errorCode: { type: String, maxlength: 60 },
    finishedAt: { type: Date },
  },
  { collection: 'admin_actions', timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

adminActionSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
adminActionSchema.index({ createdAt: -1 });
adminActionSchema.index({ targetId: 1, createdAt: -1 });
adminActionSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAction', adminActionSchema);
