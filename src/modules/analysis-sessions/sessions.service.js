'use strict';

/**
 * Saved analysis (D-044): a member of an analysis room saves a COPY of its variation tree and
 * annotations. Only the owner can read or delete it. REST only.
 */
const config = require('../../config');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { AnalysisRoom, AnalysisSession } = require('../../database/models');

function nodeView(n) {
  return { id: n.id, parentId: n.parentId || null, uci: n.uci, san: n.san, fen: n.fen, by: String(n.by), at: n.at };
}

function annotationView(a) {
  return {
    comment: a.comment || '',
    nags: a.nags || [],
    arrows: a.arrows || [],
    squares: a.squares || [],
    by: String(a.by),
    at: a.at,
  };
}

function summaryView(s) {
  return {
    id: String(s._id),
    title: s.title,
    sourceRoomId: String(s.sourceRoomId),
    sourceRev: s.sourceRev,
    moveCount: s.nodes.length,
    createdAt: s.createdAt,
  };
}

function fullView(s) {
  const node = s.cursor ? s.nodes.find((n) => n.id === s.cursor) : null;
  return {
    ...summaryView(s),
    startFen: s.startFen,
    position: { nodeId: node ? node.id : null, fen: node ? node.fen : s.startFen },
    nodes: s.nodes.map(nodeView),
    annotations: Object.fromEntries(Object.entries(s.annotations || {}).map(([k, v]) => [k, annotationView(v)])),
  };
}

const notFound = () => new AppError(404, 'ANALYSIS_SESSION_NOT_FOUND', 'Saved analysis not found');

async function save(userId, { roomId, title }) {
  return withDb(async () => {
    // Same answer for "no such room" and "not your room" (scenario 25).
    const room = await AnalysisRoom.findOne({ _id: roomId, 'members.userId': userId }).lean();
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found');

    const existing = await AnalysisSession.findOne({ ownerId: userId, sourceRoomId: room._id, sourceRev: room.rev }).lean();
    if (existing) return { session: fullView(existing), duplicate: true };

    const count = await AnalysisSession.countDocuments({ ownerId: userId });
    if (count >= config.analysisSessions.maxPerUser) {
      throw new AppError(409, 'ANALYSIS_SESSION_LIMIT', `You can keep at most ${config.analysisSessions.maxPerUser} saved analyses; delete one first`);
    }

    try {
      const doc = await AnalysisSession.create({
        ownerId: userId,
        title: title || room.name,
        sourceRoomId: room._id,
        sourceRev: room.rev,
        startFen: room.startFen,
        cursor: room.cursor || null,
        nodes: room.nodes,
        annotations: room.annotations || {},
      });
      return { session: fullView(doc.toObject()), duplicate: false };
    } catch (err) {
      if (err && err.code === 11000) {
        // The same save arrived twice at the same moment; the other request won.
        const stored = await AnalysisSession.findOne({ ownerId: userId, sourceRoomId: room._id, sourceRev: room.rev }).lean();
        if (stored) return { session: fullView(stored), duplicate: true };
      }
      throw err;
    }
  }, 'save analysis session');
}

async function list(userId, { limit, cursor }) {
  return withDb(async () => {
    const filter = { ownerId: userId };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await AnalysisSession.find(filter)
      .select('title sourceRoomId sourceRev createdAt nodes.id')
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(summaryView), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }, 'list analysis sessions');
}

async function get(userId, id) {
  return withDb(async () => {
    const session = await AnalysisSession.findOne({ _id: id, ownerId: userId }).lean();
    if (!session) throw notFound();
    return { session: fullView(session) };
  }, 'get analysis session');
}

async function remove(userId, id) {
  return withDb(async () => {
    const res = await AnalysisSession.deleteOne({ _id: id, ownerId: userId });
    if (!res.deletedCount) throw notFound();
    return { id: String(id), deleted: true };
  }, 'delete analysis session');
}

module.exports = { save, list, get, remove };
