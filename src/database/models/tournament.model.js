'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const STATUSES = ['registration', 'running', 'finished', 'cancelled'];

/**
 * One pairing of a round: a game between two players, or a bye (blackId null, whiteId sits out).
 * `key` is stable ("r2p0": round 2, pairing 0). The game of a pairing is created with this key too,
 * so a restart can never create it twice (unique index on games). Scores are written once, when the
 * pairing is done, by a conditional update (D-053).
 */
const pairingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: ['game', 'bye'], required: true },
    whiteId: { type: ObjectId, required: true },
    blackId: { type: ObjectId, default: null },
    status: { type: String, enum: ['pending', 'playing', 'done'], default: 'pending' },
    gameId: { type: ObjectId },
    startBy: { type: Date }, // a player who is not there by this time loses the pairing (D-053)
    whiteScore: { type: Number },
    blackScore: { type: Number },
    // result | aborted | forfeit | double_forfeit | bye
    reason: { type: String },
  },
  { _id: false }
);

const roundSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    doneAt: { type: Date },
    pairings: { type: [pairingSchema], default: [] },
  },
  { _id: false }
);

/**
 * A Swiss tournament (D-052 to D-055). Its whole state lives in this document plus the
 * `tournament_players` collection, never in RAM, so a restart cannot lose it (failure scenario 19).
 * Standings are always recomputed from the stored pairings, never kept as counters.
 */
const tournamentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, minlength: 3, maxlength: 40 },
    hostId: { type: ObjectId, ref: 'User', required: true },
    hostName: { type: String, required: true },
    status: { type: String, enum: STATUSES, default: 'registration' },
    timeControlId: { type: String, required: true },
    rated: { type: Boolean, default: true },
    entryFee: { type: Number, default: 0, min: 0, max: 500 },
    maxPlayers: { type: Number, required: true, min: 4, max: 32 },
    roundsPlanned: { type: Number, default: null }, // chosen by the creator, or null = default at the start
    roundsTotal: { type: Number, default: null }, // fixed when the tournament starts
    startsAt: { type: Date, required: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
    // The players who take part, fixed at the start. A late joiner who is not in it is refunded.
    roster: { type: [ObjectId], default: [] },
    currentRound: { type: Number, default: 0 },
    // When the next round may start (set when a round is done, D-053). Null while a round is playing.
    nextRoundAt: { type: Date, default: null },
    rounds: { type: [roundSchema], default: [] },
    // Written once, together with status `finished`; the payout itself is done by the sweeper.
    prizes: {
      type: [new mongoose.Schema({ userId: ObjectId, place: Number, amount: Number }, { _id: false })],
      default: [],
    },
    prizesPaid: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false }
);

// The sweeper: tournaments that must start, and running ones.
tournamentSchema.index({ status: 1, startsAt: 1 });
// "My hosted tournaments" and the one-open-tournament-per-host rule.
tournamentSchema.index({ hostId: 1, status: 1 });
// Listing, newest first.
tournamentSchema.index({ status: 1, _id: -1 });
// Which tournament does a finished game belong to?
tournamentSchema.index({ 'rounds.pairings.gameId': 1 });

const Tournament = mongoose.model('Tournament', tournamentSchema);
Tournament.STATUSES = STATUSES;

module.exports = Tournament;
