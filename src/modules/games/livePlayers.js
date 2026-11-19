'use strict';

/**
 * "Who plays which live game", kept in RAM (D-032) so chat and voice signaling do not read the
 * database for every message. Fed by `game.state.changed` events; on a miss it reads the game
 * once. Only LIVE games (active or paused) are cached, so a stranger sending random game ids
 * cannot grow it. RAM only: after a restart it simply refills from the database.
 */
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { Game } = require('../../database/models');

const MAX_ENTRIES = 5000;
const cache = new Map(); // gameId -> { whiteId, blackId }
let started = false;

function onStateChanged(game) {
  const id = String(game._id);
  if (Game.LIVE_STATUSES.includes(game.status)) {
    if (cache.size >= MAX_ENTRIES) cache.clear(); // safety valve; refills on demand
    cache.set(id, { whiteId: String(game.whiteId), blackId: String(game.blackId) });
  } else {
    cache.delete(id);
  }
}

function start() {
  if (started) return;
  started = true;
  events.on('game.state.changed', onStateChanged);
}

function stop() {
  if (!started) return;
  started = false;
  events.off('game.state.changed', onStateChanged);
  cache.clear();
}

function describe(entry, userId) {
  const me = String(userId);
  if (entry.whiteId !== me && entry.blackId !== me) return null;
  return { opponentId: entry.whiteId === me ? entry.blackId : entry.whiteId };
}

/**
 * Returns { opponentId } if `userId` is a player of the live game `gameId`.
 * Throws GAME_NOT_FOUND (the same answer for "does not exist" and "not yours", scenario 25)
 * or GAME_OVER (the user played in it, but it has ended).
 */
async function requireLivePlayer(gameId, userId) {
  const key = String(gameId);
  const cached = cache.get(key);
  if (cached) {
    const found = describe(cached, userId);
    if (!found) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    return found;
  }
  const game = await withDb(() => Game.findById(key).select('whiteId blackId status').lean(), 'live player lookup');
  const entry = game && { whiteId: String(game.whiteId), blackId: String(game.blackId) };
  const found = entry && describe(entry, userId);
  if (!found) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
  if (!Game.LIVE_STATUSES.includes(game.status)) throw new AppError(409, 'GAME_OVER', 'Game is over');
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, entry);
  return found;
}

module.exports = { start, stop, requireLivePlayer };
