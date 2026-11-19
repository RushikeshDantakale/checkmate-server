'use strict';

const express = require('express');
const { pingDatabase } = require('../../database/connection');
const storageMonitor = require('./storage.monitor');
const config = require('../../config');

const router = express.Router();

/**
 * Liveness: the process is up. Does NOT touch the database, so Render's
 * health check and uptime pingers never fail because of Atlas.
 */
router.get('/live', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Readiness: the server can do useful work (database reachable).
 */
router.get('/ready', async (req, res) => {
  const dbUp = await pingDatabase();
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ready' : 'not_ready', db: dbUp ? 'up' : 'down' });
});

/**
 * Storage level (D-028): how full the database is compared to STORAGE_LIMIT_MB.
 * Always answers 200 so uptime pingers and Render's health check never fail because storage is
 * high; read the `level` field instead ("unknown" | "ok" | "warning" | "critical").
 * If nothing has been measured yet and the database is up, it measures once now.
 */
router.get('/storage', async (req, res) => {
  let status = storageMonitor.getStatus();
  if (status.level === 'unknown') {
    try {
      status = await storageMonitor.checkNow();
    } catch {
      // Keep "unknown"; the monitor logs failures on its own schedule.
    }
  }
  res.json({
    level: status.level,
    percentUsed: status.percentUsed,
    limitMb: config.storage.limitMb,
    checkedAt: status.checkedAt,
  });
});

module.exports = router;
