'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Statuses in which a game still needs the server's attention. */
const LIVE_STATUSES = ['active', 'paused_disconnect', 'paused_server_recovery'];

const moveSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true }, // 1-based ply number
    uci: { type: String, required: true },
    san: { type: String, required: true },
    moveId: { type: String, required: true }, // client-generated idempotency key
    by: { type: ObjectId, required: true },
    at: { type: Date, required: true },
    // Remaining clock of BOTH players right after this move (used for recovery and PGN clock comments).
    whiteMs: { type: Number, required: true },
    blackMs: { type: Number, required: true },
  },
  { _id: false }
);

/**
 * One document holds everything needed to restore a match after a crash (D-011):
 * players, time control, position, full move history, clocks, status and the last
 * confirmed move sequence. The server never relies on RAM for any of it.
 *
 * Clock model: `clocks.whiteMs/blackMs` are the remaining times AT `clocks.turnStartedAt`.
 * While the game is active the side to move has
 *   remaining = clocks[side] - (now - turnStartedAt).
 * While paused, `turnStartedAt` is null and the values are the frozen snapshot.
 */
const gameSchema = new mongoose.Schema(
  {
    whiteId: { type: ObjectId, ref: 'User', required: true },
    blackId: { type: ObjectId, ref: 'User', required: true },
    // Denormalised so PGN and history need no extra reads.
    whiteName: { type: String, required: true },
    blackName: { type: String, required: true },
    whiteRating: { type: Number, required: true },
    blackRating: { type: Number, required: true },
    variant: { type: String, enum: ['standard', 'dice', 'chess960'], default: 'standard' },
    // Position the game started from (differs from the normal start only for Chess960). Used for the PGN.
    startFen: { type: String },
    rated: { type: Boolean, default: true },
    timeControl: {
      id: { type: String, required: true },
      baseMs: { type: Number, required: true },
      incrementMs: { type: Number, required: true },
    },
    status: {
      type: String,
      enum: [...LIVE_STATUSES, 'finished', 'aborted'],
      default: 'active',
    },
    result: { type: String, enum: ['1-0', '0-1', '1/2-1/2'], default: undefined },
    resultReason: { type: String },
    fen: { type: String, default: START_FEN },
    turn: { type: String, enum: ['w', 'b'], default: 'w' },
    seq: { type: Number, default: 0 }, // last confirmed ply
    moves: { type: [moveSchema], default: [] },
    clocks: {
      whiteMs: { type: Number, required: true },
      blackMs: { type: Number, required: true },
      turnStartedAt: { type: Date, default: null },
    },
    drawOffer: {
      by: { type: ObjectId },
      atSeq: { type: Number },
    },
    pgn: { type: String },
    ratingApplied: { type: Boolean, default: false },
    ratingChange: {
      white: { type: Number },
      black: { type: Number },
    },
    startedAt: { type: Date },
    endedAt: { type: Date },
    pausedAt: { type: Date },
    // Set when the retention job removed the per-move list of this old finished game (D-060).
    // The PGN, result, players, rating change and `seq` stay.
    movesCompactedAt: { type: Date },
    // Set for a game that belongs to a tournament pairing (D-053). The unique index below makes the
    // game of one pairing exist only once, even if the sweeper repeats itself after a crash.
    tournament: {
      tournamentId: { type: ObjectId },
      key: { type: String },
    },
  },
  { timestamps: true }
);

gameSchema.index({ whiteId: 1, status: 1 });
gameSchema.index({ blackId: 1, status: 1 });
gameSchema.index({ status: 1 });
// Game history, newest first (Phase 6 pagination).
gameSchema.index({ whiteId: 1, _id: -1 });
gameSchema.index({ blackId: 1, _id: -1 });
// Retention job (D-060): finished games ordered by end time.
gameSchema.index({ status: 1, endedAt: 1 });
gameSchema.index({ 'tournament.tournamentId': 1, 'tournament.key': 1 }, { unique: true, partialFilterExpression: { 'tournament.key': { $type: 'string' } } });

const Game = mongoose.model('Game', gameSchema);
Game.LIVE_STATUSES = LIVE_STATUSES;
Game.START_FEN = START_FEN;

module.exports = Game;
