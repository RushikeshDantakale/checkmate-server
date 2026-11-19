'use strict';

/**
 * Periodic clean-up for the economy (D-046, D-050): finishes ledger rows and purchases that a
 * crash or a store outage left half done. Everything it does is idempotent, so running it often,
 * or while a user request does the same work, is safe.
 */
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../utils/logger');
const wallet = require('./wallet.service');
const purchases = require('../purchases/purchases.service');

let timer = null;

async function tickNow(now = Date.now()) {
  if (mongoose.connection.readyState !== 1) return null; // database not connected: try again next tick
  try {
    const ledger = await wallet.reconcile(now);
    const store = await purchases.reconcile(now);
    if (ledger.healed || ledger.discarded || store.continued) {
      logger.info({ ledger, purchases: store }, 'economy reconcile finished work');
    }
    return { ledger, purchases: store };
  } catch (err) {
    logger.warn({ reason: err.message }, 'economy reconcile failed');
    return null;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => tickNow(), config.economy.reconcileIntervalMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tickNow };
