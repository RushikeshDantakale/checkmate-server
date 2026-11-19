'use strict';

const mongoose = require('mongoose');

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * An analysis room is ONE document (D-035): members, pending invitations, the variation tree and the
 * annotations are embedded, so every change is a single atomic write guarded by `rev` (D-038).
 * Room chat and presence are NEVER stored (D-039).
 */
const memberSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, required: true },
    role: { type: String, enum: ['host', 'editor', 'viewer'], required: true },
    joinedAt: { type: Date, required: true },
  },
  { _id: false }
);

const inviteSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, required: true },
    by: { type: ObjectId, required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

// One move in the variation tree. `parentId` null means "a move from the starting position".
const nodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    parentId: { type: String, default: null },
    uci: { type: String, required: true },
    san: { type: String, required: true },
    fen: { type: String, required: true }, // position AFTER the move
    by: { type: ObjectId, required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const analysisRoomSchema = new mongoose.Schema(
  {
    hostId: { type: ObjectId, required: true },
    name: { type: String, required: true, maxlength: 40 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    defaultRole: { type: String, enum: ['editor', 'viewer'], default: 'editor' },
    members: { type: [memberSchema], default: [] },
    invited: { type: [inviteSchema], default: [] },
    startFen: { type: String, required: true },
    // Shared board position: the id of the current node, or null for the starting position.
    cursor: { type: String, default: null },
    nodes: { type: [nodeSchema], default: [] },
    // { [nodeId | 'root']: { comment, nags, arrows, squares, by, at } }
    annotations: { type: Mixed, default: () => ({}) },
    // Incremented by every write. Used as the optimistic lock and as the public change counter.
    rev: { type: Number, default: 0 },
    lastActivityAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: null },
    // Set when the room closes; a TTL index deletes the document after the retention time (D-040).
    expireAt: { type: Date, default: null },
  },
  { collection: 'analysis_rooms', timestamps: true, minimize: false }
);

analysisRoomSchema.index({ 'members.userId': 1, status: 1 }); // "my rooms"
analysisRoomSchema.index({ 'invited.userId': 1, status: 1 }); // "rooms I am invited to"
analysisRoomSchema.index({ hostId: 1, status: 1 }); // hosted-room limit
analysisRoomSchema.index({ status: 1, lastActivityAt: 1 }); // idle sweeper
analysisRoomSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // retention after close

module.exports = mongoose.model('AnalysisRoom', analysisRoomSchema);
