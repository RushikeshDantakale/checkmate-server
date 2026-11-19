'use strict';

const config = require('../../config');

const MIN = 60 * 1000;
const SEC = 1000;

/** Allowed time controls. Clients send the id (e.g. "5+3" = 5 minutes + 3 seconds increment). */
const PRESETS = {
  '1+0': { baseMs: 1 * MIN, incrementMs: 0 },
  '3+0': { baseMs: 3 * MIN, incrementMs: 0 },
  '3+2': { baseMs: 3 * MIN, incrementMs: 2 * SEC },
  '5+0': { baseMs: 5 * MIN, incrementMs: 0 },
  '5+3': { baseMs: 5 * MIN, incrementMs: 3 * SEC },
  '10+0': { baseMs: 10 * MIN, incrementMs: 0 },
  '15+10': { baseMs: 15 * MIN, incrementMs: 10 * SEC },
  '30+0': { baseMs: 30 * MIN, incrementMs: 0 },
};

// Tests need clocks that run out in about a second.
if (config.isTest) {
  PRESETS['test-1s'] = { baseMs: 1000, incrementMs: 0 };
  PRESETS['test-10s'] = { baseMs: 10000, incrementMs: 0 };
}

/** Returns { id, baseMs, incrementMs } or null when the id is not an allowed preset. */
function parseTimeControl(id) {
  if (typeof id !== 'string' || !Object.hasOwn(PRESETS, id)) return null;
  return { id, ...PRESETS[id] };
}

module.exports = { PRESETS, parseTimeControl };
