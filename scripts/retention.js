'use strict';

/**
 * Shows, or runs, the old-data cleanup by hand (D-060). The server runs the same cleanup by itself
 * every few hours; use this to SEE what it would delete first.
 *
 *   node scripts/retention.js            dry run: counts only, changes nothing (default)
 *   node scripts/retention.js --apply    really do it
 *
 * It uses MONGODB_URI from your .env, so run it on your own computer (Render Free has no shell).
 * Tip: take a backup first (see SERVER_SETUP_GUIDE) before the first --apply on real data.
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const retention = require('../src/modules/retention/retention.service');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!config.mongodb.uri) {
    console.error('MONGODB_URI is not set (see .env).');
    return 2;
  }
  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const report = await retention.run({ dryRun: !apply });
    console.log(apply ? 'CLEANUP DONE' : 'DRY RUN: nothing was changed');
    console.log(`Move list removed after ${config.retention.gameMovesDays} days, resolved reports deleted after ${config.retention.reportsDays} days.\n`);
    for (const rule of report.rules) {
      const result = apply && rule.mode !== 'ttl' ? `changed ${rule.changed} of ${rule.matched}` : `would change ${rule.matched}`;
      console.log(`- ${rule.id}: ${result}\n    ${rule.description}`);
    }
    if (!apply) console.log('\nRun again with --apply to do it.');
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
