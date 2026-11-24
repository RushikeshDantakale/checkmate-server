'use strict';

/**
 * Live game logic. The database is the source of truth (D-011); nothing here depends on RAM
 * except the "which device controls the game" map, which is rebuilt as clients reconnect.
 *
 * Chess legality is checked by the Android client, not here (D-021). This service is
 * authoritative for: who may move, in which order (seq), duplicate moves (moveId),
 * clocks, timeouts, results, persistence and recovery.
 *
 * Every state change that must survive a crash is ONE conditional updateOne. A move is
 * acknowledged and broadcast only after that update reports success.
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { requireObjectId } = require('../../utils/objectId');
const { Game, GameEvent, User } = require('../../database/models');
const registry = require('../../websocket/registry');
const { send } = require('../../websocket/messaging');
const { buildPgn } = require('./pgn');
const { parseTimeControl } = require('./timeControl');
const { DEFAULT_VARIANT, isValidVariant, randomChess960Fen } = require('./variants');

const LIVE = Game.LIVE_STATUSES;
const PAUSED = ['paused_disconnect', 'paused_server_recovery'];

// Reasons a client may report together with the move that ended the game (D-021).
const CLIENT_OUTCOME_REASONS = [
  'checkmate',
  'stalemate',
  'insufficient_material',
  'threefold_repetition',
  'fifty_move_rule',
];

// ---------------------------------------------------------------- helpers

function colorOf(game, userId) {
  const id = String(userId);
  if (String(game.whiteId) === id) return 'w';
  if (String(game.blackId) === id) return 'b';
  return null;
}

function opponentOf(game, userId) {
  return colorOf(game, userId) === 'w' ? String(game.blackId) : String(game.whiteId);
}

/** Remaining time of `color`, not clamped (negative = flagged). */
function rawRemaining(game, color, now) {
  const base = color === 'w' ? game.clocks.whiteMs : game.clocks.blackMs;
  if (game.status === 'active' && game.turn === color && game.clocks.turnStartedAt) {
    return base - (now - new Date(game.clocks.turnStartedAt).getTime());
  }
  return base;
}

function currentClocks(game, now) {
  return {
    whiteMs: Math.max(0, Math.round(rawRemaining(game, 'w', now))),
    blackMs: Math.max(0, Math.round(rawRemaining(game, 'b', now))),
    running: game.status === 'active',
  };
}

/** Public snapshot of a game. `withMoves` adds the full move list (used by game.join and REST). */
function view(game, { withMoves = false, now = Date.now() } = {}) {
  const out = {
    id: String(game._id),
    white: { id: String(game.whiteId), username: game.whiteName, rating: game.whiteRating },
    black: { id: String(game.blackId), username: game.blackName, rating: game.blackRating },
    variant: game.variant,
    // Position the game started from. Chess960 starts from a shuffled position, so a client that replays
    // `moves` (reconnect, review) must start from this FEN, not from the normal start (D-062).
    startFen: game.startFen || Game.START_FEN,
    rated: game.rated,
    timeControl: { id: game.timeControl.id, baseMs: game.timeControl.baseMs, incrementMs: game.timeControl.incrementMs },
    status: game.status,
    result: game.result || null,
    resultReason: game.resultReason || null,
    fen: game.fen,
    turn: game.turn,
    seq: game.seq,
    clocks: currentClocks(game, now),
    drawOffer: game.drawOffer && game.drawOffer.by ? { by: String(game.drawOffer.by) } : null,
    tournamentId: game.tournament && game.tournament.tournamentId ? String(game.tournament.tournamentId) : null,
    ratingChange: game.ratingChange && game.ratingChange.white !== undefined
      ? { white: game.ratingChange.white, black: game.ratingChange.black }
      : null,
    serverTime: now,
  };
  if (withMoves) {
    out.moves = game.moves.map((m) => ({ seq: m.seq, uci: m.uci, san: m.san, at: m.at }));
    // D-060: for a very old game the move list was removed; the client rebuilds the game from `pgn`.
    if (game.movesCompactedAt) out.movesCompacted = true;
    if (game.pgn) out.pgn = game.pgn;
  }
  return out;
}

function toPlayers(game, type, payload, exceptSocket) {
  registry.sendToUser(game.whiteId, type, payload, exceptSocket);
  registry.sendToUser(game.blackId, type, payload, exceptSocket);
}

function stateChanged(game) {
  events.emit('game.state.changed', game);
}

/** Best-effort audit trail. Never throws, never blocks gameplay. */
function logEvent(gameId, type, userId, data) {
  GameEvent.create({ gameId, type, userId, data }).catch((err) =>
    logger.warn({ reason: err.message, type }, 'game event log failed')
  );
}

/** Any unexpected (database) failure becomes a retryable 503; the move was NOT applied or acknowledged. */
async function withDb(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ reason: err.message }, 'game database operation failed');
    throw new AppError(503, 'TEMPORARILY_UNAVAILABLE', 'Database temporarily unavailable; retry the same request');
  }
}

// ---------------------------------------------------------------- device control

const controllers = new Map(); // `${gameId}:${userId}` -> connectionId (RAM, D-026)

function controllerKey(gameId, userId) {
  return `${gameId}:${userId}`;
}

function socketAlive(userId, connectionId) {
  return registry.socketsOf(userId).some((s) => s.connectionId === connectionId && s.readyState === s.OPEN);
}

/** `game.join`: this device becomes the controller; a previous live device is told it was replaced. */
function claimController(gameId, userId, socket) {
  const key = controllerKey(gameId, userId);
  const previous = controllers.get(key);
  if (previous && previous !== socket.connectionId) {
    const old = registry.socketsOf(userId).find((s) => s.connectionId === previous);
    if (old) send(old, 'game.session.replaced', { gameId: String(gameId) });
  }
  controllers.set(key, socket.connectionId);
}

/** Moves, resign and draw actions must come from the controlling device. */
function assertController(gameId, userId, socket) {
  const key = controllerKey(gameId, userId);
  const previous = controllers.get(key);
  // Entries are only created by claimController (after the membership check in game.join),
  // so a stranger sending random game ids cannot grow this map.
  if (!previous || previous === socket.connectionId) return;
  if (!socketAlive(userId, previous)) {
    controllers.set(key, socket.connectionId); // the old device is gone: the caller takes over
    return;
  }
  throw new AppError(409, 'SESSION_REPLACED', 'Another device is playing this game; send game.join to take over');
}

function clearControllers(game) {
  controllers.delete(controllerKey(game._id, game.whiteId));
  controllers.delete(controllerKey(game._id, game.blackId));
}

// ---------------------------------------------------------------- reads

async function getGameForUser(userId, gameId) {
  requireObjectId(gameId, 'gameId');
  const game = await withDb(() => Game.findById(gameId).lean());
  // Same answer for "does not exist" and "not yours": private games are not revealed (scenario 25).
  if (!game || !colorOf(game, userId)) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
  return game;
}

async function findLiveGameFor(userId) {
  return Game.findOne({ status: { $in: LIVE }, $or: [{ whiteId: userId }, { blackId: userId }] }).lean();
}

async function liveGamesOf(userId) {
  return Game.find({ status: { $in: LIVE }, $or: [{ whiteId: userId }, { blackId: userId }] }).lean();
}

async function liveGamesOfIds(ids) {
  return Game.find({ _id: { $in: ids }, status: { $in: LIVE } }).lean();
}

async function getActiveGameView(userId) {
  const game = await withDb(() => findLiveGameFor(userId));
  return game ? view(game, { withMoves: true }) : null;
}

// ---------------------------------------------------------------- create

/** Creates a game and tells both players. Callers (matchmaking) hold the match lock. */
async function createGame({ whiteId, blackId, timeControlId, rated, tournament, variant }) {
  const tc = parseTimeControl(timeControlId);
  if (!tc) throw new AppError(400, 'INVALID_TIME_CONTROL', 'Unknown time control');
  if (String(whiteId) === String(blackId)) throw new AppError(400, 'INVALID_OPPONENT', 'Cannot play yourself');
  const gameVariant = variant || DEFAULT_VARIANT;
  if (!isValidVariant(gameVariant)) throw new AppError(400, 'INVALID_VARIANT', 'Unknown game variant');
  // Chess960: the server picks the shuffled start position once, so both phones start identically.
  const startFen = gameVariant === 'chess960' ? randomChess960Fen() : Game.START_FEN;

  return withDb(async () => {
    const users = await User.find({ _id: { $in: [whiteId, blackId] } }).select('username rating status').lean();
    if (users.length !== 2) throw new AppError(404, 'USER_NOT_FOUND', 'Player not found');
    if (users.some((u) => u.status !== 'active')) throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'A player account is not active');
    for (const id of [whiteId, blackId]) {
      if (await findLiveGameFor(id)) throw new AppError(409, 'ALREADY_IN_GAME', 'A player is already in a game');
    }
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const w = byId.get(String(whiteId));
    const b = byId.get(String(blackId));
    const now = new Date();
    let doc;
    try {
      doc = await Game.create({
        whiteId,
        blackId,
        whiteName: w.username,
        blackName: b.username,
        whiteRating: w.rating ?? config.game.startingRating,
        blackRating: b.rating ?? config.game.startingRating,
        rated: Boolean(rated),
        variant: gameVariant,
        fen: startFen,
        startFen,
        timeControl: tc,
        clocks: { whiteMs: tc.baseMs, blackMs: tc.baseMs, turnStartedAt: now },
        startedAt: now,
        ...(tournament ? { tournament } : {}),
      });
    } catch (err) {
      if (tournament && err && err.code === 11000) {
        // The game of this tournament pairing already exists (a race, or a retry after a crash).
        const existing = await Game.findOne({
          'tournament.tournamentId': tournament.tournamentId,
          'tournament.key': tournament.key,
        }).lean();
        if (existing) return existing;
      }
      throw err;
    }
    const game = doc.toObject();
    logEvent(game._id, 'started', undefined, { timeControl: tc.id, rated: Boolean(rated), variant: gameVariant });
    stateChanged(game);
    registry.sendToUser(whiteId, 'game.started', { game: view(game), yourColor: 'w' });
    registry.sendToUser(blackId, 'game.started', { game: view(game), yourColor: 'b' });
    return game;
  });
}

// ---------------------------------------------------------------- moves

function movePayload(game, move, now) {
  return {
    gameId: String(game._id),
    seq: move.seq,
    moveId: move.moveId,
    uci: move.uci,
    san: move.san,
    fen: game.fen,
    turn: game.turn,
    clocks: currentClocks(game, now),
    status: game.status,
    result: game.result || null,
    resultReason: game.resultReason || null,
    serverTime: now,
  };
}

/** Called when the conditional update matched nothing: find out why and answer precisely. */
async function explainRejection(gameId, userId, moveId, expectedSeq) {
  const game = await Game.findById(gameId).lean();
  if (!game) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
  const prior = game.moves.find((m) => m.moveId === moveId);
  if (prior && String(prior.by) === String(userId)) {
    return { duplicate: true, payload: { ...movePayload(game, prior, Date.now()), duplicate: true } };
  }
  if (game.status !== 'active') {
    if (PAUSED.includes(game.status)) throw new AppError(409, 'GAME_PAUSED', 'Game is paused');
    throw new AppError(409, 'GAME_OVER', 'Game is over');
  }
  if (game.seq !== expectedSeq) {
    throw new AppError(409, 'STALE_SEQ', `Out of sync: server is at seq ${game.seq}; send game.join to resynchronise`);
  }
  if (game.turn !== colorOf(game, userId)) throw new AppError(409, 'NOT_YOUR_TURN', 'It is not your turn');
  throw new AppError(409, 'CONFLICT', 'Game changed at the same moment; retry');
}

function checkOutcome(outcome, color) {
  if (!outcome) return null;
  if (!CLIENT_OUTCOME_REASONS.includes(outcome.reason)) {
    throw new AppError(400, 'INVALID_OUTCOME', 'Unknown outcome reason');
  }
  const moverWins = color === 'w' ? '1-0' : '0-1';
  const expected = outcome.reason === 'checkmate' ? moverWins : '1/2-1/2';
  if (outcome.result !== expected) {
    throw new AppError(400, 'INVALID_OUTCOME', 'Outcome does not match the reason or the player who moved');
  }
  return outcome;
}

/**
 * Accepts one move (D-011, brief section 5):
 *  1. caller already authenticated; 2. player belongs to the game; 3. turn and status;
 *  4. (legality is the client's job, D-021); 5. moveId / seq checked; 6. ONE conditional
 *  update persists the move and the new state; 7. only then ack + broadcast.
 * A retried moveId returns the original acknowledgement and is never applied twice.
 */
async function makeMove({ userId, gameId, moveId, seq, uci, san, fen, outcome, fromSocket }) {
  requireObjectId(gameId, 'gameId');
  return withDb(async () => {
    const game = await Game.findById(gameId).lean();
    if (!game) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    const color = colorOf(game, userId);
    if (!color) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');

    // Idempotency first: a retry must succeed even if the game has moved on or ended.
    const prior = game.moves.find((m) => m.moveId === moveId);
    if (prior) {
      if (String(prior.by) !== String(userId)) throw new AppError(409, 'DUPLICATE_MOVE_ID', 'moveId already used');
      return { duplicate: true, payload: { ...movePayload(game, prior, Date.now()), duplicate: true } };
    }

    if (game.status !== 'active') {
      if (PAUSED.includes(game.status)) throw new AppError(409, 'GAME_PAUSED', 'Game is paused');
      throw new AppError(409, 'GAME_OVER', 'Game is over');
    }
    if (game.turn !== color) throw new AppError(409, 'NOT_YOUR_TURN', 'It is not your turn');
    if (seq !== game.seq) {
      throw new AppError(409, 'STALE_SEQ', `Out of sync: server is at seq ${game.seq}; send game.join to resynchronise`);
    }
    const nextTurn = color === 'w' ? 'b' : 'w';
    if (fen.split(' ')[1] !== nextTurn) throw new AppError(400, 'INVALID_POSITION', 'FEN side to move does not match');
    const ended = checkOutcome(outcome, color);

    const nowMs = Date.now();
    const now = new Date(nowMs);
    const remaining = rawRemaining(game, color, nowMs);
    if (remaining <= 0) {
      await finishGame(gameId, timeoutDecider);
      throw new AppError(409, 'GAME_OVER', 'Your time ran out');
    }

    const newMs = Math.round(remaining) + game.timeControl.incrementMs;
    const whiteMs = color === 'w' ? newMs : game.clocks.whiteMs;
    const blackMs = color === 'b' ? newMs : game.clocks.blackMs;
    const move = { seq: game.seq + 1, uci, san, moveId, by: userId, at: now, whiteMs, blackMs };
    const movesAfter = [...game.moves, move];

    const set = {
      fen,
      turn: nextTurn,
      seq: move.seq,
      'clocks.whiteMs': whiteMs,
      'clocks.blackMs': blackMs,
      'clocks.turnStartedAt': now,
    };
    const next = {
      ...game,
      fen,
      turn: nextTurn,
      seq: move.seq,
      moves: movesAfter,
      drawOffer: undefined,
      clocks: { whiteMs, blackMs, turnStartedAt: now },
    };
    if (ended) {
      const pgn = buildPgn({ ...game, moves: movesAfter }, ended.result, ended.reason);
      Object.assign(set, {
        status: 'finished',
        result: ended.result,
        resultReason: ended.reason,
        endedAt: now,
        'clocks.turnStartedAt': null,
        pgn,
        ratingApplied: !game.rated,
      });
      Object.assign(next, {
        status: 'finished',
        result: ended.result,
        resultReason: ended.reason,
        endedAt: now,
        pgn,
        ratingApplied: !game.rated,
        clocks: { whiteMs, blackMs, turnStartedAt: null },
      });
    }

    // The conditional update is the atomic step. It only matches if nobody else changed the game
    // since we read it (same seq, same side to move, still active, moveId not stored yet).
    const res = await Game.updateOne(
      { _id: gameId, status: 'active', seq: game.seq, turn: color, 'moves.moveId': { $ne: moveId } },
      { $set: set, $push: { moves: move }, $unset: { drawOffer: '' } }
    );
    if (res.modifiedCount !== 1) return explainRejection(gameId, userId, moveId, seq);

    // ---- durable from here on: now acknowledge and broadcast.
    const payload = movePayload(next, move, nowMs);
    toPlayers(next, 'game.move', payload, fromSocket);
    stateChanged(next);
    if (ended) await afterFinish(next);
    return { duplicate: false, payload: { ...payload, duplicate: false } };
  });
}

// ---------------------------------------------------------------- finishing

function timeoutDecider(game, now) {
  if (game.status !== 'active') return null;
  if (rawRemaining(game, game.turn, now) > 25) return null; // not due yet (timers fire a little early/late)
  return { result: game.turn === 'w' ? '0-1' : '1-0', reason: 'timeout' };
}

function eloDelta(ratingA, ratingB, score, k) {
  const expected = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  return Math.round(k * (score - expected));
}

/**
 * Applies the rating change once (D-022). The claim is a conditional update; if the process
 * dies between the claim and the user updates, that one rating change is lost (documented limit).
 */
async function applyRatings(game) {
  if (!game.rated || !game.result || game.ratingApplied) return null;
  const scoreWhite = game.result === '1-0' ? 1 : game.result === '0-1' ? 0 : 0.5;
  const deltaWhite = eloDelta(game.whiteRating, game.blackRating, scoreWhite, config.game.ratingK);
  const change = { white: deltaWhite, black: -deltaWhite };
  const claimed = await Game.findOneAndUpdate(
    { _id: game._id, status: 'finished', ratingApplied: false },
    { $set: { ratingApplied: true, ratingChange: change } }
  );
  if (!claimed) return null;
  const bump = (userId, delta) =>
    User.updateOne(
      { _id: userId },
      [{ $set: { rating: { $max: [100, { $add: [{ $ifNull: ['$rating', config.game.startingRating] }, delta] }] } } }],
      { updatePipeline: true }
    );
  await Promise.all([bump(game.whiteId, change.white), bump(game.blackId, change.black)]);
  return change;
}

async function afterFinish(game) {
  let ratingChange = null;
  try {
    ratingChange = await applyRatings(game);
  } catch (err) {
    logger.error({ reason: err.message, gameId: String(game._id) }, 'rating update failed');
  }
  clearControllers(game);
  logEvent(game._id, 'finished', undefined, { result: game.result, reason: game.resultReason });
  toPlayers(game, 'game.over', {
    gameId: String(game._id),
    status: game.status,
    result: game.result || null,
    resultReason: game.resultReason || null,
    ratingChange,
    pgn: game.pgn,
  });
  const finalGame = ratingChange ? { ...game, ratingApplied: true, ratingChange } : game;
  stateChanged(finalGame);
}

/**
 * Ends a game. `decide(game, now)` returns { result, reason }, { abort: true, reason } or null
 * (= not applicable any more). The update is conditional on the status and seq that were read,
 * so a move that lands at the same moment makes it retry instead of producing a wrong PGN.
 */
async function finishGame(gameId, decide) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const game = await Game.findById(gameId).lean();
    if (!game) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    if (!LIVE.includes(game.status)) return { finished: false, alreadyOver: true, game };
    const nowMs = Date.now();
    const outcome = decide(game, nowMs);
    if (!outcome) return { finished: false, game };

    const aborted = Boolean(outcome.abort);
    const result = aborted ? undefined : outcome.result;
    const whiteMs = Math.max(0, Math.round(rawRemaining(game, 'w', nowMs)));
    const blackMs = Math.max(0, Math.round(rawRemaining(game, 'b', nowMs)));
    const endedAt = new Date(nowMs);
    const status = aborted ? 'aborted' : 'finished';
    const pgn = buildPgn(game, result, outcome.reason);
    const ratingApplied = aborted || !game.rated;
    const set = {
      status,
      resultReason: outcome.reason,
      endedAt,
      'clocks.whiteMs': whiteMs,
      'clocks.blackMs': blackMs,
      'clocks.turnStartedAt': null,
      pgn,
      ratingApplied,
    };
    if (result) set.result = result;

    const res = await Game.updateOne(
      { _id: gameId, status: game.status, seq: game.seq },
      { $set: set, $unset: { drawOffer: '' } }
    );
    if (res.modifiedCount === 1) {
      const next = {
        ...game,
        status,
        result,
        resultReason: outcome.reason,
        endedAt,
        pgn,
        ratingApplied,
        drawOffer: undefined,
        clocks: { whiteMs, blackMs, turnStartedAt: null },
      };
      await afterFinish(next);
      return { finished: true, game: next };
    }
  }
  throw new AppError(409, 'CONFLICT', 'Game changed while finishing; retry');
}

/** Timer callback: ends the game only if the DB really says the mover is out of time. */
function claimTimeout(gameId) {
  return withDb(() => finishGame(gameId, timeoutDecider));
}

async function resign(userId, gameId) {
  const game = await getGameForUser(userId, gameId);
  const color = colorOf(game, userId);
  const r = await withDb(() =>
    finishGame(gameId, () => ({ result: color === 'w' ? '0-1' : '1-0', reason: 'resignation' }))
  );
  if (!r.finished) throw new AppError(409, 'GAME_OVER', 'Game is already over');
  logEvent(game._id, 'resign', userId);
  return r.game;
}

// ---------------------------------------------------------------- draw offers

async function offerDraw(userId, gameId) {
  const game = await getGameForUser(userId, gameId);
  if (game.status !== 'active') throw new AppError(409, game.status === 'finished' || game.status === 'aborted' ? 'GAME_OVER' : 'GAME_PAUSED', 'Game is not active');
  const offer = game.drawOffer && game.drawOffer.by ? game.drawOffer : null;
  if (offer && offer.atSeq === game.seq) {
    if (String(offer.by) === String(userId)) return game; // repeated offer: idempotent
    throw new AppError(409, 'DRAW_OFFER_PENDING', 'Your opponent already offered a draw; accept it');
  }
  const res = await withDb(() =>
    Game.updateOne({ _id: gameId, status: 'active', seq: game.seq }, { $set: { drawOffer: { by: userId, atSeq: game.seq } } })
  );
  if (res.modifiedCount !== 1) throw new AppError(409, 'CONFLICT', 'Game changed at the same moment; retry');
  registry.sendToUser(opponentOf(game, userId), 'game.draw.offered', { gameId: String(game._id), by: String(userId) });
  logEvent(game._id, 'draw_offered', userId);
  return game;
}

async function acceptDraw(userId, gameId) {
  await getGameForUser(userId, gameId);
  const r = await withDb(() =>
    finishGame(gameId, (g) => {
      const offer = g.drawOffer && g.drawOffer.by ? g.drawOffer : null;
      if (g.status !== 'active' || !offer) return null;
      if (String(offer.by) === String(userId) || offer.atSeq !== g.seq) return null;
      return { result: '1/2-1/2', reason: 'agreement' };
    })
  );
  if (!r.finished) throw new AppError(409, 'NO_DRAW_OFFER', 'There is no draw offer to accept');
  return r.game;
}

async function declineDraw(userId, gameId) {
  const game = await getGameForUser(userId, gameId);
  const opponent = opponentOf(game, userId);
  const res = await withDb(() =>
    Game.updateOne({ _id: gameId, status: 'active', 'drawOffer.by': opponent }, { $unset: { drawOffer: '' } })
  );
  if (res.modifiedCount !== 1) throw new AppError(409, 'NO_DRAW_OFFER', 'There is no draw offer to decline');
  registry.sendToUser(opponent, 'game.draw.declined', { gameId: String(game._id) });
  return game;
}

// ---------------------------------------------------------------- pause / resume / recovery

/**
 * Pauses an active game. `rebase: true` charges the elapsed time up to now (a normal pause);
 * `rebase: false` keeps the stored snapshot (nobody is charged, D-012).
 */
async function pauseGame(gameId, status, { rebase }) {
  const game = await Game.findById(gameId).lean();
  if (!game || game.status !== 'active') return null;
  const nowMs = Date.now();
  const whiteMs = rebase ? Math.max(0, Math.round(rawRemaining(game, 'w', nowMs))) : game.clocks.whiteMs;
  const blackMs = rebase ? Math.max(0, Math.round(rawRemaining(game, 'b', nowMs))) : game.clocks.blackMs;
  const pausedAt = new Date(nowMs);
  const res = await Game.updateOne(
    { _id: gameId, status: 'active', seq: game.seq },
    { $set: { status, pausedAt, 'clocks.whiteMs': whiteMs, 'clocks.blackMs': blackMs, 'clocks.turnStartedAt': null } }
  );
  if (res.modifiedCount !== 1) return null;
  const next = { ...game, status, pausedAt, clocks: { whiteMs, blackMs, turnStartedAt: null } };
  logEvent(game._id, 'paused', undefined, { status });
  stateChanged(next);
  toPlayers(next, 'game.paused', { gameId: String(game._id), reason: status, clocks: currentClocks(next, nowMs) });
  return next;
}

async function resumeGame(gameId) {
  const now = new Date();
  const game = await Game.findOneAndUpdate(
    { _id: gameId, status: { $in: PAUSED } },
    { $set: { status: 'active', 'clocks.turnStartedAt': now }, $unset: { pausedAt: '' } },
    { returnDocument: 'after' }
  ).lean();
  if (!game) return null;
  logEvent(game._id, 'resumed');
  stateChanged(game);
  toPlayers(game, 'game.resumed', { game: view(game) });
  return game;
}

/**
 * Server restart / database reconnect (D-012): every game that was `active` is paused with its
 * last clock snapshot, so nobody is charged for the outage. Resuming happens when players
 * reconnect (see games.monitor). Returns the paused games.
 */
async function recoverActiveGames() {
  const ids = (await Game.find({ status: 'active' }).select('_id').lean()).map((g) => g._id);
  if (!ids.length) return [];
  await Game.updateMany(
    { _id: { $in: ids }, status: 'active' },
    { $set: { status: 'paused_server_recovery', pausedAt: new Date(), 'clocks.turnStartedAt': null } }
  );
  const games = await Game.find({ _id: { $in: ids }, status: 'paused_server_recovery' }).lean();
  const now = Date.now();
  for (const game of games) {
    logEvent(game._id, 'recovered_after_outage');
    stateChanged(game);
    toPlayers(game, 'game.paused', { gameId: String(game._id), reason: 'paused_server_recovery', clocks: currentClocks(game, now) });
  }
  return games;
}

/** Games that are paused right now (used at boot to give them a hold timer again). */
async function pausedGames() {
  return Game.find({ status: { $in: PAUSED } }).lean();
}

/** Writes a clock snapshot for each game in one atomic update each (no read needed). */
async function checkpointGames(ids) {
  const nowDate = new Date();
  const elapsed = { $subtract: [nowDate, '$clocks.turnStartedAt'] };
  const rebased = (field, color) => ({
    $cond: [{ $eq: ['$turn', color] }, { $max: [0, { $subtract: [`$clocks.${field}`, elapsed] }] }, `$clocks.${field}`],
  });
  await Promise.all(
    ids.map((id) =>
      Game.updateOne(
        { _id: id, status: 'active', 'clocks.turnStartedAt': { $ne: null } },
        [
          {
            $set: {
              'clocks.whiteMs': rebased('whiteMs', 'w'),
              'clocks.blackMs': rebased('blackMs', 'b'),
              'clocks.turnStartedAt': nowDate,
            },
          },
        ],
        { updatePipeline: true }
      ).catch((err) => logger.warn({ reason: err.message }, 'clock checkpoint failed'))
    )
  );
}

/**
 * Settles a game whose player(s) are gone. mode 'grace': one player's grace period ended.
 * mode 'hold': a paused game waited long enough. Re-checks presence at decision time.
 */
async function settleAbsence(gameId, mode) {
  return withDb(() =>
    finishGame(gameId, (game) => {
      if (!LIVE.includes(game.status)) return null;
      const whiteOn = registry.isOnline(game.whiteId);
      const blackOn = registry.isOnline(game.blackId);
      if (whiteOn && blackOn) return null;
      if (!whiteOn && !blackOn) {
        if (mode === 'grace') return null; // caller pauses the game instead
        return game.seq < 2 ? { abort: true, reason: 'abandoned_before_start' } : { result: '1/2-1/2', reason: 'both_abandoned' };
      }
      if (game.seq < 2) return { abort: true, reason: 'abandoned_before_start' };
      return { result: whiteOn ? '1-0' : '0-1', reason: 'abandoned' };
    })
  );
}

module.exports = {
  LIVE,
  PAUSED,
  colorOf,
  opponentOf,
  rawRemaining,
  view,
  toPlayers,
  logEvent,
  withDb,
  claimController,
  assertController,
  getGameForUser,
  getActiveGameView,
  liveGamesOf,
  liveGamesOfIds,
  findLiveGameFor,
  createGame,
  makeMove,
  claimTimeout,
  resign,
  offerDraw,
  acceptDraw,
  declineDraw,
  pauseGame,
  resumeGame,
  recoverActiveGames,
  pausedGames,
  checkpointGames,
  settleAbsence,
};
