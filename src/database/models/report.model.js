'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: ObjectId, ref: 'User', required: true },
    reported: { type: ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['cheating', 'abuse', 'harassment', 'spam', 'other'], required: true },
    details: { type: String, maxlength: 500 },
    status: { type: String, enum: ['open', 'reviewed', 'dismissed'], default: 'open' },
    // Filled in when an administrator resolves the report (D-059).
    reviewedBy: { type: ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    note: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reported: 1 });

module.exports = mongoose.model('Report', reportSchema);
