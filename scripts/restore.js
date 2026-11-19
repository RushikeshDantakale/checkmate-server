'use strict';

/**
 * Checks a backup and, only if you ask, restores it into the database in your .env (D-061).
 *
 *   node scripts/restore.js <backup-folder>                       DRY RUN: checks the files, changes nothing
 *   node scripts/restore.js <backup-folder> --apply               really restores (refuses non-empty collections)
 *   node scripts/restore.js <backup-folder> --apply --replace     drops each collection first, then refills it
 *   node scripts/restore.js <backup-folder> --apply --only users,games   only some collections
 *
 * BEFORE restoring into a live database: STOP the server (otherwise it keeps writing while you restore),
 * and read the "Target" line below carefully: it is the database that will be changed.
 * After a restore, start the server once: it recreates the indexes.
 */
const path = require('node:path');
const mongoose = require('mongoose');
const config = require('../src/config');
const { restoreBackup, inspectBackup } = require('../src/modules/backup/backup.service');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const folder = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
  if (!folder) {
    console.error('Usage: node scripts/restore.js <backup-folder> [--apply] [--replace] [--only a,b]');
    return 2;
  }
  if (!config.mongodb.uri) {
    console.error('MONGODB_URI is not set (see .env).');
    return 2;
  }
  const apply = process.argv.includes('--apply');
  const replace = process.argv.includes('--replace');
  const only = argValue('--only') ? argValue('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;

  const inspected = await inspectBackup(folder);
  console.log(`Backup of database "${inspected.manifest.database}" made at ${inspected.manifest.createdAt}`);
  if (!inspected.ok) {
    console.error('\nTHE BACKUP IS DAMAGED. Nothing was restored:');
    for (const p of inspected.problems) console.error(`- ${p}`);
    return 1;
  }
  console.log('Files and checksums: OK');

  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    console.log(`Target: database "${db.databaseName}" on ${mongoose.connection.host}`);
    const result = await restoreBackup({
      db,
      dir: folder,
      apply,
      replace,
      only,
      onProgress: (name, count) => console.log(`  restored ${name}: ${count} documents`),
    });
    if (!result.applied) {
      console.log('\nDRY RUN: nothing was changed. What --apply would do:');
      for (const p of result.plan) {
        console.log(`- ${p.name}: ${p.count} documents${p.existing ? '  (target already has documents: needs --replace)' : ''}`);
      }
      console.log('\nStop the server, check the Target line above, then run again with --apply.');
      return 0;
    }
    const bad = result.results.filter((r) => r.restored !== r.expected);
    console.log(bad.length === 0 ? '\nRESTORE DONE: every collection has the expected number of documents.' : '\nRESTORE FINISHED WITH DIFFERENCES:');
    for (const r of bad) console.log(`- ${r.name}: expected ${r.expected}, found ${r.restored}`);
    console.log('Start the server once so the indexes are recreated.');
    return bad.length === 0 ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Restore failed: ${err.message}`);
    process.exit(1);
  });
