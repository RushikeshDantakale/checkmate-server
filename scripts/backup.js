'use strict';

/**
 * Makes a backup of the whole database into a folder on THIS computer (D-061).
 *
 *   node scripts/backup.js                     writes backups/backup-<time>/
 *   node scripts/backup.js --out D:\my-backups  writes into another folder
 *   node scripts/backup.js --exclude sessions,matchmaking_queue   leave some collections out
 *
 * It uses MONGODB_URI from your .env and only READS the database. Run it on your own computer
 * (Render Free has no shell and no disk that survives a restart).
 *
 * The backup contains personal data (e-mails, password hashes, messages). Keep it private,
 * never put it in git or send it in chat. The default folder `backups/` is git-ignored.
 */
const path = require('node:path');
const mongoose = require('mongoose');
const config = require('../src/config');
const { createBackup } = require('../src/modules/backup/backup.service');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!config.mongodb.uri) {
    console.error('MONGODB_URI is not set (see .env).');
    return 2;
  }
  const outDir = path.resolve(argValue('--out') || path.join(__dirname, '..', 'backups'));
  const exclude = (argValue('--exclude') || '').split(',').map((s) => s.trim()).filter(Boolean);

  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    console.log(`Backing up database "${db.databaseName}" on ${mongoose.connection.host} (read only)...`);
    const { dir, manifest } = await createBackup({
      db,
      outDir,
      exclude,
      onProgress: (name, count) => console.log(`  ${name}: ${count} documents`),
    });
    const total = Object.values(manifest.collections).reduce((sum, c) => sum + c.count, 0);
    console.log(`\nBACKUP DONE: ${Object.keys(manifest.collections).length} collections, ${total} documents.`);
    console.log(`Folder: ${dir}`);
    for (const s of manifest.skipped) console.log(`Skipped ${s.name} (${s.reason})`);
    console.log('\nThis folder holds personal data. Keep it private; never commit or share it.');
    console.log('It is not a point-in-time snapshot: back up when few people are playing.');
    console.log(`To check it: node scripts/restore.js "${dir}"   (dry run, changes nothing)`);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
  });
