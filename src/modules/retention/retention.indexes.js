'use strict';

/**
 * Index migration for retention changes (D-060). Mongoose cannot change the settings of an index that
 * already exists (createIndexes fails with an "index options conflict"), so a database created before
 * D-060 (its sessions index deleted sessions AT expiry) is fixed here, before the normal index creation.
 * Safe to run on every start: it does nothing when the index is already right or does not exist yet.
 */
const mongoose = require('mongoose');
const Session = require('../../database/models/session.model');

/** Returns true when it changed something. */
async function migrateSessionTtl(db = mongoose.connection.db) {
  const target = Session.RETENTION_AFTER_EXPIRY_SECONDS;
  let indexes;
  try {
    indexes = await db.collection('sessions').indexes();
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return false; // no collection yet
    throw err;
  }
  const current = indexes.find((i) => i.name === 'expiresAt_1');
  if (!current || current.expireAfterSeconds === target) return false;
  if (typeof current.expireAfterSeconds === 'number') {
    await db.command({ collMod: 'sessions', index: { keyPattern: { expiresAt: 1 }, expireAfterSeconds: target } });
  } else {
    // A plain index cannot become a TTL index in place: drop it, ensureIndexes() recreates it.
    await db.collection('sessions').dropIndex('expiresAt_1');
  }
  return true;
}

module.exports = { migrateSessionTtl };
