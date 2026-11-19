'use strict';

const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

// Same shape as a node of an analysis room (analysisRoom.model.js): this is a COPY (D-044).
const nodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    parentId: { type: String, default: null },
    uci: { type: String, required: true },
    san: { type: String, required: true },
    fen: { type: String, required: true },
    by: { type: ObjectId, required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

/**
 * A saved copy of an analysis room at one moment (D-044). The owner is the user who saved it; nobody
 * else can read it. It is kept until the owner deletes it, because rooms disappear 7 days after closing.
 */
const analysisSessionSchema = new mongoose.Schema(
  {
    ownerId: { type: ObjectId, required: true },
    title: { type: String, required: true, maxlength: 60 },
    sourceRoomId: { type: ObjectId, required: true },
    sourceRev: { type: Number, required: true }, // the room revision that was copied
    startFen: { type: String, required: true },
    cursor: { type: String, default: null }, // current position of the room when it was saved
    nodes: { type: [nodeSchema], default: [] },
    annotations: { type: Mixed, default: () => ({}) },
  },
  { collection: 'analysis_sessions', timestamps: true, minimize: false }
);

analysisSessionSchema.index({ ownerId: 1, _id: -1 }); // "my saved analyses", newest first
// Saving the same room at the same revision twice gives the same document (retry safety).
analysisSessionSchema.index({ ownerId: 1, sourceRoomId: 1, sourceRev: 1 }, { unique: true });

module.exports = mongoose.model('AnalysisSession', analysisSessionSchema);
