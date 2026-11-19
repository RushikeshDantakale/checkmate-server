'use strict';

/**
 * Keeps the time-based and presence-based rules of live games running:
 *  - flag timers (timeout), grace timers (player disconnected), hold timers (paused games),
 *  - the periodic clock checkpoint (D-012),
 *  - recovery after a restart or a database reconnect.
 *
 * All timers live in RAM but are NOT the source of truth: they are rebuilt from the database
 * (`recover()` on boot) and every callback re-checks the database before acting.
 */
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../utils/logger');
const events = require('../../utils/events');
const registry = require('../../websocket/registry');
const service = require('./games.service');

const flagTimers = new Map(); // gameId -> timeout
const graceTimers = new Map(); // `${gameId}:${userId}` -> timeout
const holdTimers = new Map(); // gameId -> timeout
const activeIds = new Set(); // games that need clock checkpoints
let checkpointTimer = null;
let started = false;

function timer(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

function clearMap(map, key) {
  const t = map.get(key);
  if (t) clearTimeout(t);
  map.delete(key);
}

function clearGame(gameId) {
  const id = String(gameId);
  clearMap(flagTimers, id);
  clearMap(holdTimers, id);
  activeIds.delete(id);
  for (const key of Array.from(graceTimers.keys())) {
    if (key.startsWith(`${id}:`)) clearMap(graceTimers, key);
  }
}

function safe(label, fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      logger.error({ reason: err.message, label }, 'game monitor task failed');
    }
  };
}

// ---------------------------------------------------------------- timers

function scheduleFlag(game) {
  const id = String(game._id);
  clearMap(flagTimers, id);
  const remaining = service.rawRemaining(game, game.turn, Date.now());
  flagTimers.set(
    id,
    timer(
      safe('flag', async () => {
        flagTimers.delete(id);
        let result;
        try {
          result = await service.claimTimeout(id);
        } catch (err) {
          // Database trouble: try again shortly. Nothing is lost, the DB still has the clocks.
          logger.warn({ reason: err.message }, 'timeout check failed, retrying');
          flagTimers.set(id, timer(() => scheduleFlagFromDb(id), 2000));
          return;
        }
        if (!result.finished && !result.alreadyOver && result.game.status === 'active') scheduleFlag(result.game);
      }),
      Math.max(0, remaining) + 30
    )
  );
}

const scheduleFlagFromDb = safe('flag-reload', async (id) => {
  const game = (await service.liveGamesOfIds([id]))[0];
  if (game && game.status === 'active') scheduleFlag(game);
});

function startGrace(game, userId) {
  const key = `${game._id}:${userId}`;
  if (graceTimers.has(key)) return;
  graceTimers.set(
    key,
    timer(
      safe('grace', async () => {
        graceTimers.delete(key);
        const result = await service.settleAbsence(String(game._id), 'grace');
        if (!result.finished && !result.alreadyOver) {
          // Both players are gone: pause instead of declaring a winner.
          if (!registry.isOnline(game.whiteId) && !registry.isOnline(game.blackId)) {
            await service.pauseGame(String(game._id), 'paused_disconnect', { rebase: true });
          }
        }
      }),
      config.game.reconnectGraceMs
    )
  );
}

function startHold(game) {
  const id = String(game._id);
  if (holdTimers.has(id)) return;
  holdTimers.set(
    id,
    timer(
      safe('hold', async () => {
        holdTimers.delete(id);
        await service.settleAbsence(id, 'hold');
      }),
      config.game.pausedHoldMs
    )
  );
}

// ---------------------------------------------------------------- reactions

/** Every committed state change of a game ends up here (see games.service stateChanged). */
function onStateChanged(game) {
  const id = String(game._id);
  if (game.status === 'active') {
    activeIds.add(id);
    clearMap(holdTimers, id);
    scheduleFlag(game);
    // A player who is already offline when the game (re)starts gets the grace period.
    for (const userId of [String(game.whiteId), String(game.blackId)]) {
      if (!registry.isOnline(userId)) startGrace(game, userId);
    }
  } else if (service.PAUSED.includes(game.status)) {
    activeIds.delete(id);
    clearMap(flagTimers, id);
    for (const key of Array.from(graceTimers.keys())) {
      if (key.startsWith(`${id}:`)) clearMap(graceTimers, key);
    }
    startHold(game);
  } else {
    clearGame(id);
  }
}

const onUserConnected = safe('user.connected', async ({ userId }) => {
  const games = await service.liveGamesOf(userId);
  for (const game of games) {
    clearMap(graceTimers, `${game._id}:${userId}`);
    const opponent = service.opponentOf(game, userId);
    registry.sendToUser(opponent, 'game.opponent.reconnected', { gameId: String(game._id) });
    registry.sendToUser(userId, 'game.active', { gameId: String(game._id), status: game.status });
    service.logEvent(game._id, 'reconnected', userId);

    if (game.status === 'paused_disconnect') {
      await service.resumeGame(String(game._id)); // one player is back: play on, the other has the grace period
    } else if (game.status === 'paused_server_recovery') {
      // D-012: resume only when BOTH players are connected again.
      if (registry.isOnline(game.whiteId) && registry.isOnline(game.blackId)) {
        await service.resumeGame(String(game._id));
      }
    }
  }
});

const onUserDisconnected = safe('user.disconnected', async ({ userId }) => {
  const games = await service.liveGamesOf(userId);
  for (const game of games) {
    service.logEvent(game._id, 'disconnected', userId);
    if (game.status !== 'active') continue; // paused games already have a hold timer
    const opponent = service.opponentOf(game, userId);
    if (registry.isOnline(opponent)) {
      registry.sendToUser(opponent, 'game.opponent.disconnected', {
        gameId: String(game._id),
        graceMs: config.game.reconnectGraceMs,
      });
      startGrace(game, userId);
    } else {
      // Both players are gone: stop the clocks (charged up to now) and wait for someone to return.
      await service.pauseGame(String(game._id), 'paused_disconnect', { rebase: true });
    }
  }
});

// ---------------------------------------------------------------- recovery and checkpoints

/**
 * Pauses every game that was active (server restart, or MongoDB came back after an outage)
 * and resumes those whose players are already connected. Safe to call repeatedly.
 */
async function recover() {
  const games = await service.recoverActiveGames();
  for (const game of games) {
    if (registry.isOnline(game.whiteId) && registry.isOnline(game.blackId)) {
      await service.resumeGame(String(game._id));
    }
  }
  // Games that were ALREADY paused before this boot (for example a second restart before the hold
  // time ended) have no timer in RAM. Give them one, so they are settled instead of staying paused forever.
  const handled = new Set(games.map((game) => String(game._id)));
  for (const game of await service.pausedGames()) {
    if (handled.has(String(game._id))) continue;
    onStateChanged(game); // starts the hold timer (does nothing if one already exists)
    if (game.status === 'paused_server_recovery' && registry.isOnline(game.whiteId) && registry.isOnline(game.blackId)) {
      await service.resumeGame(String(game._id));
    }
  }
  return games.length;
}

const recoverSafely = safe('recover', async () => {
  const count = await recover();
  if (count) logger.warn({ games: count }, 'live games paused and restored after outage');
});

async function checkpointTick() {
  if (!activeIds.size) return;
  await service.checkpointGames(Array.from(activeIds));
}

function onDbReconnected() {
  recoverSafely();
}

function start() {
  if (started) return;
  started = true;
  events.on('game.state.changed', onStateChanged);
  events.on('user.connected', onUserConnected);
  events.on('user.disconnected', onUserDisconnected);
  mongoose.connection.on('reconnected', onDbReconnected);
  checkpointTimer = setInterval(() => {
    checkpointTick().catch((err) => logger.warn({ reason: err.message }, 'checkpoint tick failed'));
  }, config.game.checkpointIntervalMs);
  checkpointTimer.unref();
}

/** Stops all timers and listeners (graceful shutdown, tests simulating a crash). RAM state is dropped. */
function stop() {
  if (!started) return;
  started = false;
  events.off('game.state.changed', onStateChanged);
  events.off('user.connected', onUserConnected);
  events.off('user.disconnected', onUserDisconnected);
  mongoose.connection.off('reconnected', onDbReconnected);
  clearInterval(checkpointTimer);
  for (const map of [flagTimers, graceTimers, holdTimers]) {
    for (const t of map.values()) clearTimeout(t);
    map.clear();
  }
  activeIds.clear();
}

module.exports = { start, stop, recover };
