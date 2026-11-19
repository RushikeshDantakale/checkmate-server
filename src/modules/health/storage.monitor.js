'use strict';

/**
 * Watches database size (D-028). Games and personal messages are never deleted, and Atlas M0 has
 * 512 MB, so this logs a WARNING at 80% and an ERROR at 90% of STORAGE_LIMIT_MB and exposes the
 * level on /health/storage. It only reads statistics; it never changes data.
 */
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../utils/logger');

let status = { level: 'unknown', percentUsed: null, checkedAt: null };
let firstTimer = null;
let timer = null;

function levelFor(percent) {
  if (percent >= config.storage.criticalPercent) return 'critical';
  if (percent >= config.storage.warnPercent) return 'warning';
  return 'ok';
}

/** Reads the database statistics once and updates the status. Returns the status (unchanged if the DB is down). */
async function checkNow() {
  if (mongoose.connection.readyState !== 1) return status;
  const stats = await mongoose.connection.db.stats();
  const usedBytes = (stats.storageSize || 0) + (stats.indexSize || 0);
  const percent = (usedBytes / (config.storage.limitMb * 1024 * 1024)) * 100;
  const level = levelFor(percent);
  status = { level, percentUsed: Math.round(percent * 10) / 10, checkedAt: new Date().toISOString() };
  if (level === 'critical') {
    logger.error({ percentUsed: status.percentUsed, limitMb: config.storage.limitMb }, 'database storage is almost full');
  } else if (level === 'warning') {
    logger.warn({ percentUsed: status.percentUsed, limitMb: config.storage.limitMb }, 'database storage is getting full');
  }
  return status;
}

function getStatus() {
  return status;
}

function safeCheck() {
  checkNow().catch((err) => logger.warn({ reason: err.message }, 'storage check failed'));
}

function start() {
  if (timer) return;
  firstTimer = setTimeout(safeCheck, 10000); // after the database had time to connect
  firstTimer.unref();
  timer = setInterval(safeCheck, config.storage.checkIntervalMs);
  timer.unref();
}

function stop() {
  clearTimeout(firstTimer);
  clearInterval(timer);
  firstTimer = null;
  timer = null;
}

module.exports = { start, stop, checkNow, getStatus, levelFor };
