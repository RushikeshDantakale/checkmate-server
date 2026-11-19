'use strict';

/**
 * Backup and restore of the whole database as plain files (D-061). No extra software needed.
 *
 * Format: a folder with one `<collection>.ndjson` file per collection (one MongoDB Extended JSON
 * document per line, so ObjectIds and dates keep their type) and `manifest.json`, which is written LAST.
 * A folder without a valid manifest is an unfinished backup and is refused.
 *
 * Backup only READS. It is not a point-in-time snapshot: documents that change while it runs can be
 * slightly inconsistent between collections.
 *
 * Restore is safe by default: it checks every file against the manifest first (SHA-256 and counts),
 * does nothing unless `apply` is true, and refuses to touch a collection that already has documents
 * unless `replace` is true (that collection is then dropped first).
 *
 * This module takes a `db` (a MongoDB driver Db, e.g. mongoose.connection.db) so tests can use it.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const readline = require('node:readline');
const path = require('node:path');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
// EJSON comes through mongoose (a declared dependency) so package.json needs no extra entry for `bson`.
const { EJSON } = require('mongoose').mongo.BSON;

const FORMAT = 'checkmate-backup-v1';
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/; // collection names this tool handles (all of ours match)
const INSERT_BATCH = 500;

function fileNameOf(collection) {
  return `${collection}.ndjson`;
}

/**
 * Writes a backup into `outDir/backup-<time>/`. Returns { dir, manifest }.
 * Options: exclude (collection names to skip), now (Date, for tests), onProgress(name, count).
 */
async function createBackup({ db, outDir, exclude = [], now = new Date(), onProgress = () => {} }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outDir, `backup-${stamp}`);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(dir); // not recursive: fails if the folder already exists, a backup is never overwritten

  const manifest = {
    format: FORMAT,
    createdAt: now.toISOString(),
    database: db.databaseName,
    consistency: 'not a point-in-time snapshot',
    collections: {},
    skipped: [],
  };

  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = infos.map((c) => c.name).sort();
  for (const name of names) {
    if (name.startsWith('system.')) continue;
    if (exclude.includes(name)) {
      manifest.skipped.push({ name, reason: 'excluded' });
      continue;
    }
    if (!NAME_PATTERN.test(name)) {
      manifest.skipped.push({ name, reason: 'unsupported collection name' });
      continue;
    }

    const file = fileNameOf(name);
    const stream = fs.createWriteStream(path.join(dir, file));
    const hash = crypto.createHash('sha256');
    let count = 0;
    let bytes = 0;
    for await (const doc of db.collection(name).find({})) {
      const line = `${EJSON.stringify(doc, { relaxed: false })}\n`;
      hash.update(line);
      bytes += Buffer.byteLength(line);
      count += 1;
      if (!stream.write(line)) await once(stream, 'drain');
    }
    stream.end();
    await finished(stream);

    let indexes = [];
    try {
      indexes = await db.collection(name).indexes();
    } catch {
      /* a view or a collection that vanished: the data file is what matters */
    }
    manifest.collections[name] = { file, count, bytes, sha256: hash.digest('hex'), indexes };
    onProgress(name, count);
  }

  // Last: only a finished backup has a manifest.
  await fsp.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

async function hashAndCount(filePath) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  let pendingTail = false;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    for (let i = 0; i < chunk.length; i += 1) if (chunk[i] === 0x0a) count += 1;
    pendingTail = chunk[chunk.length - 1] !== 0x0a;
  }
  if (pendingTail) count += 1; // a last line without a newline still counts (and will fail the hash check anyway)
  return { sha256: hash.digest('hex'), count };
}

/**
 * Checks a backup folder without touching any database. Returns { ok, manifest, problems }.
 * Throws only when there is no readable manifest at all (not a backup, or an unfinished one).
 */
async function inspectBackup(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error('No valid manifest.json in this folder: it is not a Checkmate backup, or the backup was not finished.');
  }
  if (!manifest || manifest.format !== FORMAT || typeof manifest.collections !== 'object' || manifest.collections === null) {
    throw new Error(`Unknown backup format (expected ${FORMAT}).`);
  }

  const problems = [];
  for (const [name, info] of Object.entries(manifest.collections)) {
    if (!NAME_PATTERN.test(name) || !info || info.file !== fileNameOf(name)) {
      problems.push(`${name}: unsafe or unexpected collection name or file name in the manifest`);
      continue; // never read a path that came from a damaged manifest
    }
    const filePath = path.join(dir, info.file);
    let actual;
    try {
      actual = await hashAndCount(filePath);
    } catch {
      problems.push(`${name}: file ${info.file} is missing or unreadable`);
      continue;
    }
    if (actual.count !== info.count) problems.push(`${name}: ${actual.count} documents in the file, the manifest says ${info.count}`);
    if (actual.sha256 !== info.sha256) problems.push(`${name}: the file was changed or damaged (checksum does not match)`);
  }
  return { ok: problems.length === 0, manifest, problems };
}

async function isEmpty(db, name) {
  const first = await db.collection(name).findOne({}, { projection: { _id: 1 } });
  return first === null;
}

async function dropIfExists(db, name) {
  try {
    await db.collection(name).drop();
  } catch (err) {
    if (err && (err.code === 26 || err.codeName === 'NamespaceNotFound')) return; // nothing to drop
    throw err;
  }
}

async function insertFile(db, dir, name) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, fileNameOf(name))), crlfDelay: Infinity });
  const collection = db.collection(name);
  let batch = [];
  let inserted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await collection.insertMany(batch, { ordered: false });
    inserted += res.insertedCount;
    batch = [];
  };
  for await (const line of rl) {
    if (line.trim() === '') continue;
    batch.push(EJSON.parse(line, { relaxed: false }));
    if (batch.length >= INSERT_BATCH) await flush();
  }
  await flush();
  return inserted;
}

/**
 * Restores a backup. Without `apply` nothing is changed: it returns the plan.
 * Returns { applied, plan: [{ name, count, existing }], results?: [{ name, expected, restored }] }.
 * Throws (before changing anything) if the backup is damaged, if a collection is not empty and `replace`
 * is false, or if `only` names a collection that is not in the backup.
 */
async function restoreBackup({ db, dir, apply = false, replace = false, only = null, onProgress = () => {} }) {
  const inspected = await inspectBackup(dir);
  if (!inspected.ok) throw new Error(`The backup is damaged, nothing was restored:\n- ${inspected.problems.join('\n- ')}`);

  const available = Object.keys(inspected.manifest.collections);
  const names = only ? only : available;
  for (const name of names) {
    if (!available.includes(name)) throw new Error(`The backup has no collection called "${name}".`);
  }

  const plan = [];
  for (const name of names) {
    plan.push({ name, count: inspected.manifest.collections[name].count, existing: !(await isEmpty(db, name)) });
  }
  if (!apply) return { applied: false, plan };

  const blocked = plan.filter((p) => p.existing).map((p) => p.name);
  if (blocked.length > 0 && !replace) {
    throw new Error(`These collections already contain documents: ${blocked.join(', ')}. Nothing was changed. Use --replace to drop and refill them.`);
  }

  const results = [];
  for (const p of plan) {
    if (replace) await dropIfExists(db, p.name);
    const restored = await insertFile(db, dir, p.name);
    const present = await db.collection(p.name).countDocuments({});
    results.push({ name: p.name, expected: p.count, restored: present }); // what is really in the collection now
    onProgress(p.name, restored);
  }
  return { applied: true, plan, results };
}

module.exports = { createBackup, inspectBackup, restoreBackup, FORMAT };
