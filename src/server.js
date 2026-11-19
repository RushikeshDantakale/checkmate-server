'use strict';

const http = require('node:http');
const config = require('./config');
const logger = require('./utils/logger');
const { installProcessGuards } = require('./utils/processGuards');
const { createApp } = require('./app');
const { createWebSocketServer } = require('./websocket');
const db = require('./database/connection');
const gamesMonitor = require('./modules/games/games.monitor');
const matchmaking = require('./modules/matchmaking/matchmaking.service');
const storageMonitor = require('./modules/health/storage.monitor');
const retentionMonitor = require('./modules/retention/retention.monitor');
const livePlayers = require('./modules/games/livePlayers');
const signaling = require('./modules/signaling/signaling.service');
const analysisRooms = require('./modules/analysis-rooms/rooms.service');
const spectators = require('./modules/spectators/spectators.service');
const economyMonitor = require('./modules/economy/economy.monitor');
const tournaments = require('./modules/tournaments/tournaments.service');

/** Builds the HTTP + WebSocket server without listening (tests reuse this). */
function createServer() {
  const app = createApp();
  const httpServer = http.createServer(app);
  const wss = createWebSocketServer({ server: httpServer, config, logger });
  // Timers, grace periods and the matchmaking tick. Stopped again when the WebSocket server closes.
  gamesMonitor.start();
  matchmaking.start();
  storageMonitor.start(); // D-028: read-only database size watch
  livePlayers.start(); // D-032: RAM cache of "who plays which live game", invalidated when a game ends
  signaling.start(); // D-033: ends voice calls when a peer disconnects or the game ends
  analysisRooms.start(); // D-039/D-040: room presence clean-up and the idle-room sweeper
  spectators.start(); // D-042: pushes game updates to spectators, cleans up when sockets close
  economyMonitor.start(); // D-046/D-050: finishes half-done ledger rows and purchases
  tournaments.start(); // D-053: the tournament sweeper (starts, rounds, forfeits, prizes, refunds)
  retentionMonitor.start(); // D-060: old-data cleanup (never in tests)
  wss.on('close', () => {
    retentionMonitor.stop();
    tournaments.stop();
    economyMonitor.stop();
    spectators.stop();
    analysisRooms.stop();
    gamesMonitor.stop();
    matchmaking.stop();
    storageMonitor.stop();
    livePlayers.stop();
    signaling.stop();
  });
  return { app, httpServer, wss };
}

/**
 * After the database is reachable, restore live games that were interrupted by a restart:
 * they are paused with their last clock snapshot (D-012). Retries until it works or shutdown.
 */
async function recoverGamesWithRetry(signal) {
  for (let attempt = 1; !signal.aborted; attempt += 1) {
    try {
      const count = await gamesMonitor.recover();
      logger.info({ games: count }, 'game recovery finished');
      return;
    } catch (err) {
      logger.error({ attempt, reason: err.message }, 'game recovery failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))));
    }
  }
}

async function main() {
  installProcessGuards({ logger }); // D-057: crash and stray-rejection handling, only for the real process
  const { httpServer, wss } = createServer();
  const abort = new AbortController();

  db.attachConnectionLogging(logger);

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'server listening');
  });

  // Connect in the background so the port opens immediately (important on Render).
  db.connectWithRetry({
    uri: config.mongodb.uri,
    maxPoolSize: config.mongodb.maxPoolSize,
    logger,
    signal: abort.signal,
  }).then((connected) => {
    if (!connected) return undefined;
    // First storage reading as soon as the database is up (not only after the hourly timer).
    storageMonitor.checkNow().catch((err) => logger.warn({ reason: err.message }, 'storage check failed'));
    return recoverGamesWithRetry(abort.signal);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    abort.abort();
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    for (const socket of wss.clients) socket.close(1001, 'Server restarting');
    wss.close();
    httpServer.close(async () => {
      await db.disconnect().catch(() => {});
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ reason: err.message }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { createServer };
