'use strict';

/**
 * Game history and completed-game retrieval (D-043). Read-only.
 *  - listHistory: my finished or aborted games, newest first, short summaries (no moves, no PGN).
 *  - getGameForViewer: the two players always; everybody else only for COMPLETED games and only if
 *    they are allowed to watch it (D-041). Anything else answers GAME_NOT_FOUND (scenario 25).
 */
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { requireObjectId } = require('../../utils/objectId');
const { Game } = require('../../database/models');
const spectators = require('../spectators/spectators.service');

const DONE = ['finished', 'aborted'];

function summaryView(game, userId) {
  const mine = String(game.whiteId) === String(userId) ? 'w' : 'b';
  return {
    id: String(game._id),
    white: { id: String(game.whiteId), username: game.whiteName, rating: game.whiteRating },
    black: { id: String(game.blackId), username: game.blackName, rating: game.blackRating },
    yourColor: mine,
    rated: game.rated,
    timeControl: { id: game.timeControl.id, baseMs: game.timeControl.baseMs, incrementMs: game.timeControl.incrementMs },
    status: game.status,
    result: game.result || null,
    resultReason: game.resultReason || null,
    moveCount: game.seq,
    ratingChange:
      game.ratingChange && game.ratingChange.white !== undefined
        ? { white: game.ratingChange.white, black: game.ratingChange.black }
        : null,
    startedAt: game.startedAt || null,
    endedAt: game.endedAt || null,
  };
}

async function listHistory(userId, { limit, cursor }) {
  return withDb(async () => {
    const filter = { status: { $in: DONE }, $or: [{ whiteId: userId }, { blackId: userId }] };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Game.find(filter)
      .select(
        'whiteId blackId whiteName blackName whiteRating blackRating variant rated timeControl status result resultReason seq ratingChange startedAt endedAt'
      )
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map((g) => summaryView(g, userId)), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }, 'game history');
}

async function getGameForViewer(userId, gameId) {
  requireObjectId(gameId, 'gameId');
  return withDb(async () => {
    const game = await Game.findById(gameId).lean();
    if (!game) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    const me = String(userId);
    if (String(game.whiteId) === me || String(game.blackId) === me) return game;
    if (!DONE.includes(game.status)) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    if (!(await spectators.mayWatch(me, game))) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    return game;
  }, 'game for viewer');
}

module.exports = { listHistory, getGameForViewer };
