'use strict';

const config = require('../../config');

const MIN = 60 * 1000;
const SEC = 1000;

/**
 * Time controls are NOT a fixed list: the app sends any id "<minutes>+<increment seconds>" (e.g. "5+3",
 * "2+1", "0.5+0", "45+15") and the server accepts it when it is inside these limits. New controls in the
 * app therefore need no server change. Players are only paired when the normalised id is the same.
 */
const LIMITS = {
  minBaseMs: 10 * SEC,
  maxBaseMs: 180 * MIN,
  maxIncrementMs: 180 * SEC,
};

// Tests need clocks that run out in about a second.
const TEST_IDS = config.isTest
  ? { 'test-1s': { baseMs: 1000, incrementMs: 0 }, 'test-10s': { baseMs: 10000, incrementMs: 0 } }
  : {};

const ID_PATTERN = /^(\d{1,3}(?:\.\d{1,2})?)\+(\d{1,3})$/;

/**
 * Returns { id, baseMs, incrementMs } or null when [id] is not a valid time control. The returned id is
 * normalised ("05+03" and "5.0+3" both become "5+3") so equal controls always pair in the queue.
 */
function parseTimeControl(id) {
  if (typeof id !== 'string') return null;
  if (Object.hasOwn(TEST_IDS, id)) return { id, ...TEST_IDS[id] };
  const m = ID_PATTERN.exec(id);
  if (!m) return null;
  const baseMs = Math.round(parseFloat(m[1]) * MIN);
  const incrementMs = parseInt(m[2], 10) * SEC;
  if (baseMs < LIMITS.minBaseMs || baseMs > LIMITS.maxBaseMs || incrementMs > LIMITS.maxIncrementMs) return null;
  return { id: `${baseMs / MIN}+${incrementMs / SEC}`, baseMs, incrementMs };
}

module.exports = { LIMITS, parseTimeControl };
