'use strict';

const logger = require('./logger');
const { AppError } = require('./errors');

/**
 * Runs a database operation. Any unexpected failure (database down, pool exhausted, storage full)
 * becomes a retryable 503 so the client knows the request was NOT applied. AppErrors pass through.
 */
async function withDb(fn, what = 'database operation') {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ reason: err.message, what }, 'database operation failed');
    throw new AppError(503, 'TEMPORARILY_UNAVAILABLE', 'Database temporarily unavailable; retry the same request');
  }
}

module.exports = { withDb };
