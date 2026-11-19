'use strict';

/**
 * Makes a user an administrator, or removes the role (D-059). The ONLY way to change a role:
 * there is deliberately no REST endpoint for it.
 *
 *   node scripts/set-role.js <username> admin
 *   node scripts/set-role.js <username> user
 *
 * It uses the MONGODB_URI from your .env, so run it on your own computer (Render Free has no shell).
 * Every change is written to the audit log (collection admin_actions).
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const { User, AdminAction } = require('../src/database/models');

async function main() {
  const [username, role] = process.argv.slice(2);
  if (!username || !['admin', 'user'].includes(role)) {
    console.error('Usage: node scripts/set-role.js <username> <admin|user>');
    return 2;
  }
  if (!config.mongodb.uri) {
    console.error('MONGODB_URI is not set (see .env).');
    return 2;
  }
  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const before = await User.findOneAndUpdate(
      { usernameLower: username.trim().toLowerCase() },
      { $set: { role } },
      { returnDocument: 'before' }
    ).lean();
    if (!before) {
      console.error(`No user named "${username}".`);
      return 1;
    }
    await AdminAction.create({
      adminId: null,
      action: 'role_changed_by_script',
      targetType: 'user',
      targetId: before._id,
      details: { from: before.role, to: role },
      status: 'done',
      finishedAt: new Date(),
    });
    console.log(`${before.username}: role ${before.role} -> ${role}`);
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
