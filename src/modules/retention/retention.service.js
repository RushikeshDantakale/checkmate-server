'use strict';

/**
 * Retention and cleanup (D-060). Keeps the free 512 MB database from filling up.
 *
 * What this job does (everything else is kept forever, see DATABASE_DOCUMENTATION):
 *  - game_moves:       finished or aborted games older than RETENTION_GAME_MOVES_DAYS lose their per-move
 *                      list (`moves`). The game itself, its PGN, result and rating change stay, and the
 *                      document gets `movesCompactedAt`. Only games that HAVE a stored PGN are touched.
 *  - resolved_reports: reviewed or dismissed reports older than RETENTION_REPORTS_DAYS are deleted.
 *                      Open reports are never deleted.
 *  - old_sessions:     only COUNTED here. MongoDB's TTL index on `sessions` deletes them 30 days after expiry.
 *
 * Already handled by TTL indexes elsewhere: game_events 90 days, notifications 30 days, closed analysis
 * rooms 7 days, invitations 1 hour, matchmaking entries at expiry.
 *
 * Safe to repeat: every change re-checks its own filter, so a run that is interrupted or run twice does
 * the same thing. `dryRun: true` only counts.
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const { Game, Report, Session } = require('../../database/models');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCHES_PER_RULE = 20; // per run: at most batchSize * 20 documents per rule; the rest waits for the next run

function buildRules(now, settings) {
  const gameCutoff = new Date(now - settings.gameMovesDays * DAY_MS);
  const reportCutoff = new Date(now - settings.reportsDays * DAY_MS);
  const sessionCutoff = new Date(now - Session.RETENTION_AFTER_EXPIRY_SECONDS * 1000);
  return [
    {
      id: 'game_moves',
      description: `remove the move list of finished games older than ${settings.gameMovesDays} days (PGN stays)`,
      model: Game,
      mode: 'update',
      filter: {
        status: { $in: ['finished', 'aborted'] },
        endedAt: { $lt: gameCutoff },
        movesCompactedAt: { $exists: false },
        'moves.0': { $exists: true },
        pgn: { $type: 'string', $ne: '' },
      },
      change: { $set: { moves: [], movesCompactedAt: new Date(now) } },
    },
    {
      id: 'resolved_reports',
      description: `delete reviewed or dismissed reports older than ${settings.reportsDays} days`,
      model: Report,
      mode: 'delete',
      filter: { status: { $in: ['reviewed', 'dismissed'] }, updatedAt: { $lt: reportCutoff } },
    },
    {
      id: 'old_sessions',
      description: 'sessions expired more than 30 days ago (deleted by the MongoDB TTL index, only counted here)',
      model: Session,
      mode: 'ttl',
      filter: { expiresAt: { $lt: sessionCutoff } },
    },
  ];
}

async function applyInBatches(rule, batchSize) {
  let changed = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RULE; i += 1) {
    const batch = await rule.model.find(rule.filter).select('_id').limit(batchSize).lean();
    if (batch.length === 0) break;
    const where = { ...rule.filter, _id: { $in: batch.map((d) => d._id) } }; // the filter is re-checked
    let done;
    if (rule.mode === 'update') {
      done = (await rule.model.updateMany(where, rule.change)).modifiedCount;
    } else {
      done = (await rule.model.deleteMany(where)).deletedCount;
    }
    changed += done;
    if (done === 0) break; // nothing changed: do not loop on the same documents
  }
  return changed;
}

let running = false;

/**
 * Runs every rule once. Options: `dryRun` (default false), `now` (ms, for tests), `settings` (override config).
 * Returns { dryRun, startedAt, finishedAt, rules: [{ id, description, mode, matched, changed }] }.
 * Throws if a database call fails; a run that is already in progress returns `null`.
 */
async function run({ dryRun = false, now = Date.now(), settings = config.retention } = {}) {
  if (running) return null;
  running = true;
  try {
    const startedAt = new Date().toISOString();
    const rules = [];
    for (const rule of buildRules(now, settings)) {
      const matched = await rule.model.countDocuments(rule.filter);
      let changed = 0;
      if (!dryRun && matched > 0 && rule.mode !== 'ttl') {
        changed = await applyInBatches(rule, settings.batchSize);
        if (changed > 0) logger.info({ rule: rule.id, changed }, 'retention: cleaned up');
      }
      rules.push({ id: rule.id, description: rule.description, mode: rule.mode, matched, changed });
    }
    return { dryRun, startedAt, finishedAt: new Date().toISOString(), rules };
  } finally {
    running = false;
  }
}

module.exports = { run, buildRules };
