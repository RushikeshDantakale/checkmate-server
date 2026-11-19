'use strict';

/**
 * Spectators (D-041, D-042): friends of a player follow a LIVE game. Nothing here is stored.
 * The game itself lives in MongoDB; this module only keeps, in RAM, which sockets are watching which
 * game. After a restart the map is empty and clients send `spectate.join` again.
 *
 * Moves reach spectators through the `game.state.changed` event, which the games service emits only
 * AFTER the move is durable, so a spectator never sees a move that could be lost.
 */
const config = require('../../config');
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const registry = require('../../websocket/registry');
const friends = require('../friends/friends.service');
const games = require('../games/games.service');
const { Game, Friendship } = require('../../database/models');

const LIVE = Game.LIVE_STATUSES;

// gameId -> { whiteId, blackId, sockets: Map<connectionId, socket> }
const watched = new Map();
// connectionId -> Set<gameId>
const byConnection = new Map();
let started = false;

const notFound = () => new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
const isPlayer = (game, userId) => [String(game.whiteId), String(game.blackId)].includes(String(userId));

// ---------------------------------------------------------------- authorization

/**
 * D-041: may `userId` watch (or read, once it is over) this game as a non-player?
 * True for a friend of at least one player who has no block with either player. Players get false:
 * they use game.join.
 */
async function mayWatch(userId, game) {
  const me = String(userId);
  const white = String(game.whiteId);
  const black = String(game.blackId);
  if (me === white || me === black) return false;
  const [friendOfWhite, friendOfBlack] = await Promise.all([friends.areFriends(me, white), friends.areFriends(me, black)]);
  if (!friendOfWhite && !friendOfBlack) return false;
  const [blockedWhite, blockedBlack] = await Promise.all([
    friends.isBlockedEitherWay(me, white),
    friends.isBlockedEitherWay(me, black),
  ]);
  return !blockedWhite && !blockedBlack;
}

// ---------------------------------------------------------------- RAM bookkeeping

function userCount(entry) {
  return new Set(Array.from(entry.sockets.values()).map((s) => s.auth.userId)).size;
}

function spectatorCount(gameId) {
  const entry = watched.get(String(gameId));
  return entry ? userCount(entry) : 0;
}

function forget(connectionId, gameId) {
  const set = byConnection.get(connectionId);
  if (!set) return;
  set.delete(gameId);
  if (set.size === 0) byConnection.delete(connectionId);
}

/** Sends to every watching socket (optionally skipping one) and returns how many users were reached. */
function toWatchers(gameId, type, payload, exceptSocket = null) {
  const entry = watched.get(gameId);
  if (!entry) return 0;
  const text = JSON.stringify({ type, payload });
  const reached = new Set();
  for (const socket of entry.sockets.values()) {
    if (socket === exceptSocket || socket.readyState !== socket.OPEN) continue;
    socket.send(text);
    reached.add(socket.auth.userId);
  }
  return reached.size;
}

/** Tells the spectators and both players how many people are watching now. */
function announceCount(gameId, exceptSocket = null) {
  const entry = watched.get(gameId);
  if (!entry) return;
  const payload = { gameId, count: userCount(entry) };
  toWatchers(gameId, 'spectate.count', payload, exceptSocket);
  registry.sendToUser(entry.whiteId, 'spectate.count', payload);
  registry.sendToUser(entry.blackId, 'spectate.count', payload);
}

function tellPlayersCountIsZero(entry, gameId) {
  const payload = { gameId, count: 0 };
  registry.sendToUser(entry.whiteId, 'spectate.count', payload);
  registry.sendToUser(entry.blackId, 'spectate.count', payload);
}

// ---------------------------------------------------------------- join / leave

async function join(userId, gameId, socket) {
  const game = await withDb(() => Game.findById(gameId).lean(), 'spectate lookup');
  if (!game) throw notFound();
  if (isPlayer(game, userId)) throw new AppError(409, 'YOU_ARE_A_PLAYER', 'You play this game: use game.join');
  if (!(await withDb(() => mayWatch(userId, game), 'spectate authorization'))) throw notFound();
  if (!LIVE.includes(game.status)) throw new AppError(409, 'GAME_OVER', 'Game is over');

  // From here on everything is synchronous: two simultaneous joins cannot both take the last seat.
  const key = String(game._id);
  let entry = watched.get(key);
  if (!entry) {
    entry = { whiteId: String(game.whiteId), blackId: String(game.blackId), sockets: new Map() };
    watched.set(key, entry);
  }
  const alreadyWatching = Array.from(entry.sockets.values()).some((s) => s.auth.userId === String(userId));
  if (!alreadyWatching && userCount(entry) >= config.spectators.maxPerGame) {
    if (entry.sockets.size === 0) watched.delete(key);
    throw new AppError(409, 'SPECTATOR_LIMIT', 'This game already has the maximum number of spectators');
  }
  entry.sockets.set(socket.connectionId, socket);
  let set = byConnection.get(socket.connectionId);
  if (!set) {
    set = new Set();
    byConnection.set(socket.connectionId, set);
  }
  set.add(key);

  if (!alreadyWatching) announceCount(key, socket);
  return { game: games.view(game, { withMoves: true }), spectators: userCount(entry) };
}

/** Idempotent: leaving a game you were not watching is fine. */
function leave(userId, gameId, socket) {
  const entry = watched.get(gameId);
  if (entry && entry.sockets.get(socket.connectionId) === socket) {
    entry.sockets.delete(socket.connectionId);
    forget(socket.connectionId, gameId);
    const userGone = !Array.from(entry.sockets.values()).some((s) => s.auth.userId === String(userId));
    if (entry.sockets.size === 0) {
      watched.delete(gameId);
      if (userGone) tellPlayersCountIsZero(entry, gameId);
    } else if (userGone) {
      announceCount(gameId);
    }
  }
  return { gameId, spectators: spectatorCount(gameId) };
}

// ---------------------------------------------------------------- events

function lastMoveOf(game) {
  const m = game.moves && game.moves.length ? game.moves[game.moves.length - 1] : null;
  return m ? { seq: m.seq, uci: m.uci, san: m.san, at: m.at } : null;
}

function onGameStateChanged(game) {
  const gameId = String(game._id);
  const entry = watched.get(gameId);
  if (!entry) return;
  if (LIVE.includes(game.status)) {
    toWatchers(gameId, 'spectate.update', { game: games.view(game), lastMove: lastMoveOf(game) });
    return;
  }
  toWatchers(gameId, 'spectate.over', {
    gameId,
    status: game.status,
    result: game.result || null,
    resultReason: game.resultReason || null,
    ratingChange: game.ratingChange && game.ratingChange.white !== undefined ? game.ratingChange : null,
    pgn: game.pgn || null,
  });
  for (const connectionId of entry.sockets.keys()) forget(connectionId, gameId);
  watched.delete(gameId);
  tellPlayersCountIsZero(entry, gameId);
}

function onSocketClosed({ userId, connectionId }) {
  const gameIds = byConnection.get(connectionId);
  if (!gameIds) return;
  byConnection.delete(connectionId);
  for (const gameId of Array.from(gameIds)) {
    const entry = watched.get(gameId);
    if (!entry) continue;
    entry.sockets.delete(connectionId);
    const userGone = !Array.from(entry.sockets.values()).some((s) => s.auth.userId === String(userId));
    if (entry.sockets.size === 0) {
      watched.delete(gameId);
      tellPlayersCountIsZero(entry, gameId);
    } else if (userGone) {
      announceCount(gameId);
    }
  }
}

function start() {
  if (started) return;
  started = true;
  events.on('game.state.changed', onGameStateChanged);
  events.on('socket.closed', onSocketClosed);
}

function stop() {
  if (!started) return;
  started = false;
  events.off('game.state.changed', onGameStateChanged);
  events.off('socket.closed', onSocketClosed);
  watched.clear();
  byConnection.clear();
}

// ---------------------------------------------------------------- list of live games to watch

/** Live games of my friends that I may watch (D-043), newest first. */
async function listWatchable(userId, { limit = 20 } = {}) {
  return withDb(async () => {
    const me = String(userId);
    const rows = await Friendship.find({ status: 'accepted', $or: [{ requester: me }, { recipient: me }] })
      .select('requester recipient')
      .limit(500)
      .lean();
    const friendIds = rows.map((r) => (String(r.requester) === me ? String(r.recipient) : String(r.requester)));
    if (friendIds.length === 0) return { items: [] };
    const blocked = await friends.blockedEitherWay(me);
    const live = await Game.find({
      status: { $in: LIVE },
      $or: [{ whiteId: { $in: friendIds } }, { blackId: { $in: friendIds } }],
    })
      .select('whiteId blackId whiteName blackName whiteRating blackRating rated timeControl status seq startedAt')
      .sort({ _id: -1 })
      .limit(100)
      .lean();
    const items = live
      .filter((g) => !isPlayer(g, me) && !blocked.has(String(g.whiteId)) && !blocked.has(String(g.blackId)))
      .slice(0, limit)
      .map((g) => ({
        id: String(g._id),
        white: { id: String(g.whiteId), username: g.whiteName, rating: g.whiteRating },
        black: { id: String(g.blackId), username: g.blackName, rating: g.blackRating },
        rated: g.rated,
        timeControl: { id: g.timeControl.id, baseMs: g.timeControl.baseMs, incrementMs: g.timeControl.incrementMs },
        status: g.status,
        moveCount: g.seq,
        spectators: spectatorCount(g._id),
        startedAt: g.startedAt,
      }));
    return { items };
  }, 'list watchable games');
}

module.exports = { start, stop, mayWatch, join, leave, spectatorCount, listWatchable };
