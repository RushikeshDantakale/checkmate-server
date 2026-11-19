'use strict';

/**
 * Background timer for the cleanup job (D-060). First run shortly after start, then every
 * RETENTION_INTERVAL_MS (6 h). On Render Free the server sleeps when idle, so the job simply runs
 * whenever the server is awake. A failed run is logged and tried again at the next interval.
 * Never starts in tests (config.retention.enabled is false when NODE_ENV=test).
 */
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../utils/logger');
const retention = require('./retention.service');

let first = null;
let timer = null;

/** One run now. Never throws. Returns the report, or null (database down, already running, error). */
async function tick() {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const report = await retention.run({ dryRun: config.retention.dryRun });
    if (report && config.retention.dryRun) {
      logger.info({ rules: report.rules.map((r) => ({ rule: r.id, wouldChange: r.matched })) }, 'retention dry run (nothing was changed)');
    }
    return report;
  } catch (err) {
    logger.warn({ reason: err.message }, 'retention run failed, will try again later');
    return null;
  }
}

function start() {
  if (!config.retention.enabled || timer) return;
  first = setTimeout(tick, config.retention.firstRunMs);
  first.unref();
  timer = setInterval(tick, config.retention.intervalMs);
  timer.unref();
}

function stop() {
  clearTimeout(first);
  clearInterval(timer);
  first = null;
  timer = null;
}

module.exports = { start, stop, tick };
