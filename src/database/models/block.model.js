'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const blockSchema = new mongoose.Schema(
  {
    blocker: { type: ObjectId, ref: 'User', required: true },
    blocked: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });

module.exports = mongoose.model('Block', blockSchema);
