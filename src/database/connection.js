'use strict';

const mongoose = require('mongoose');

// Fail fast when the database is down instead of silently queueing queries.
// A move must never be acknowledged while its write is waiting in a buffer.
mongoose.set('bufferCommands', false);
// Indexes are created explicitly by ensureIndexes() once connected.
mongoose.set('autoIndex', false);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Creates all indexes declared on the models (safe to call repeatedly). */
async function ensureIndexes() {
  // D-060: fix index settings that changed since an older database was created, before creating indexes.
  await require('../modules/retention/retention.indexes').migrateSessionTtl();
  const models = require('./models');
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
}

/**
 * Connect to MongoDB, retrying with exponential backoff (max 30s). Never
 * throws: if the database is unreachable at boot the HTTP server still starts
 * and /health/ready reports 503 until the connection succeeds.
 */
async function connectWithRetry({ uri, maxPoolSize, logger, signal }) {
  let attempt = 0;
  while (!signal.aborted) {
    attempt += 1;
    try {
      await mongoose.connect(uri, {
        maxPoolSize,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      await ensureIndexes();
      logger.info({ attempt }, 'mongodb connected');
      return true;
    } catch (err) {
      const retryInMs = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      logger.error({ attempt, retryInMs, reason: err.name }, 'mongodb connection failed');
      await sleep(retryInMs);
    }
  }
  return false;
}

function attachConnectionLogging(logger) {
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongodb reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ reason: err.name }, 'mongodb error'));
}

async function pingDatabase(timeoutMs = 2000) {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connectWithRetry, attachConnectionLogging, pingDatabase, ensureIndexes, disconnect };
