'use strict';

// Backup and restore (Phase 8e, D-061). Uses the real test database; no server is started.
process.env.NODE_ENV = 'test';
const uri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/checkmate_test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { EJSON, ObjectId } = mongoose.mongo.BSON;
const { createBackup, inspectBackup, restoreBackup } = require('../src/modules/backup/backup.service');

let db;
const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkmate-backup-test-'));
  tmpDirs.push(dir);
  return dir;
}

before(async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  db = mongoose.connection.db;
  await mongoose.connection.dropDatabase();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function reset() {
  await mongoose.connection.dropDatabase();
}

const same = (a, b) => EJSON.stringify(a, { relaxed: false }) === EJSON.stringify(b, { relaxed: false });

function sampleDocs() {
  return {
    bk_users: [
      {
        _id: new ObjectId(),
        username: 'Zoë "the\\rook"\nsecond line',
        createdAt: new Date('2026-11-19T10:00:00.123Z'),
        rating: 1216,
        score: 1.5,
        active: true,
        nothing: null,
        tags: ['a', { nested: new ObjectId() }, 3],
        deep: { x: { y: [new Date('2020-01-01T00:00:00Z')] } },
      },
      { _id: new ObjectId(), username: 'plain', createdAt: new Date(0) },
    ],
    bk_games: [{ _id: new ObjectId(), whiteId: new ObjectId(), moves: [{ seq: 1, san: 'e4' }], pgn: '1. e4 *' }],
  };
}

async function seed() {
  const data = sampleDocs();
  for (const [name, docs] of Object.entries(data)) await db.collection(name).insertMany(docs);
  await db.createCollection('bk_empty');
  return data;
}

test('a backup has one file per collection, correct counts and checksums, and a manifest written last', async () => {
  await reset();
  await seed();
  const out = tmpDir();
  const { dir, manifest } = await createBackup({ db, outDir: out });

  assert.equal(manifest.format, 'checkmate-backup-v1');
  assert.equal(manifest.database, db.databaseName);
  assert.equal(manifest.collections.bk_users.count, 2);
  assert.equal(manifest.collections.bk_games.count, 1);
  assert.equal(manifest.collections.bk_empty.count, 0, 'empty collections are included');
  assert.ok(manifest.collections.bk_users.indexes.some((i) => i.name === '_id_'));
  for (const name of ['bk_users', 'bk_games', 'bk_empty']) {
    assert.ok(fs.existsSync(path.join(dir, `${name}.ndjson`)), `${name}.ndjson exists`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(!Object.keys(manifest.collections).some((n) => n.startsWith('system.')));

  const check = await inspectBackup(dir);
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems, []);
});

test('the backup only reads: the database is unchanged afterwards', async () => {
  await reset();
  const data = await seed();
  const out = tmpDir();
  await createBackup({ db, outDir: out });
  const users = await db.collection('bk_users').find({}).sort({ _id: 1 }).toArray();
  assert.equal(users.length, 2);
  assert.ok(same(users, [...data.bk_users].sort((a, b) => (a._id < b._id ? -1 : 1))));
});

test('a backup never overwrites an existing backup folder', async () => {
  await reset();
  await seed();
  const out = tmpDir();
  const now = new Date('2026-11-19T12:00:00Z');
  await createBackup({ db, outDir: out, now });
  await assert.rejects(() => createBackup({ db, outDir: out, now }), /EEXIST|exist/i);
});

test('round trip: every document comes back identical, with ObjectId and Date types intact', async () => {
  await reset();
  const data = await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });

  await reset(); // "disaster"
  const result = await restoreBackup({ db, dir, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.results.map((r) => [r.name, r.expected, r.restored]).sort(),
    [['bk_empty', 0, 0], ['bk_games', 1, 1], ['bk_users', 2, 2]]
  );

  for (const [name, docs] of Object.entries(data)) {
    const restored = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    const original = [...docs].sort((a, b) => (a._id < b._id ? -1 : 1));
    assert.ok(same(restored, original), `${name} is identical after the round trip`);
  }
  const user = await db.collection('bk_users').findOne({ _id: data.bk_users[0]._id });
  assert.ok(user._id instanceof ObjectId);
  assert.ok(user.createdAt instanceof Date);
  assert.equal(user.createdAt.toISOString(), '2026-11-19T10:00:00.123Z');
  assert.equal(user.username, 'Zoë "the\\rook"\nsecond line');
  assert.equal(user.nothing, null);
  assert.ok(user.tags[1].nested instanceof ObjectId);
});

test('a restore is a DRY RUN unless apply is given: nothing is changed', async () => {
  await reset();
  await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });
  await reset();

  const result = await restoreBackup({ db, dir });
  assert.equal(result.applied, false);
  assert.deepEqual(result.plan.map((p) => [p.name, p.count, p.existing]).sort(), [['bk_empty', 0, false], ['bk_games', 1, false], ['bk_users', 2, false]]);
  assert.equal(await db.collection('bk_users').countDocuments({}), 0);
  assert.equal(await db.collection('bk_games').countDocuments({}), 0);
});

test('a restore refuses to touch collections that already have documents unless replace is given', async () => {
  await reset();
  await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });

  // Changed after the backup: an extra user exists and one game was removed.
  await db.collection('bk_users').insertOne({ _id: new ObjectId(), username: 'added after backup' });
  await db.collection('bk_games').deleteMany({});

  const dry = await restoreBackup({ db, dir });
  assert.equal(dry.plan.find((p) => p.name === 'bk_users').existing, true, 'the dry run warns about it');

  await assert.rejects(() => restoreBackup({ db, dir, apply: true }), /already contain documents.*bk_users.*Nothing was changed/s);
  assert.equal(await db.collection('bk_users').countDocuments({}), 3, 'nothing was changed by the refused restore');
  assert.equal(await db.collection('bk_games').countDocuments({}), 0, 'not even the empty collections were filled');

  const result = await restoreBackup({ db, dir, apply: true, replace: true });
  assert.equal(result.applied, true);
  assert.equal(await db.collection('bk_users').countDocuments({}), 2, 'the extra user is gone: the collection was replaced');
  assert.equal(await db.collection('bk_games').countDocuments({}), 1);
});

test('only restores the collections asked for; an unknown name is an error before anything changes', async () => {
  await reset();
  await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });
  await reset();

  await assert.rejects(() => restoreBackup({ db, dir, apply: true, only: ['bk_users', 'nope'] }), /no collection called "nope"/);
  assert.equal(await db.collection('bk_users').countDocuments({}), 0);

  await restoreBackup({ db, dir, apply: true, only: ['bk_games'] });
  assert.equal(await db.collection('bk_games').countDocuments({}), 1);
  assert.equal(await db.collection('bk_users').countDocuments({}), 0);
});

test('exclude leaves collections out and records it in the manifest', async () => {
  await reset();
  await seed();
  const { dir, manifest } = await createBackup({ db, outDir: tmpDir(), exclude: ['bk_games'] });
  assert.ok(!manifest.collections.bk_games);
  assert.deepEqual(manifest.skipped, [{ name: 'bk_games', reason: 'excluded' }]);
  assert.ok(!fs.existsSync(path.join(dir, 'bk_games.ndjson')));
});

test('collections with names this tool does not handle are skipped, not silently written', async () => {
  await reset();
  await seed();
  await db.createCollection('bad.name');
  const { manifest } = await createBackup({ db, outDir: tmpDir() });
  assert.ok(manifest.skipped.some((s) => s.name === 'bad.name' && /unsupported/.test(s.reason)));
  assert.ok(!manifest.collections['bad.name']);
});

test('a changed backup file is detected and the restore refuses to start', async () => {
  await reset();
  await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });
  const file = path.join(dir, 'bk_users.ndjson');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('plain', 'pl4in'));

  const check = await inspectBackup(dir);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /bk_users.*checksum/.test(p)), check.problems.join('|'));

  await reset();
  await assert.rejects(() => restoreBackup({ db, dir, apply: true }), /damaged, nothing was restored/);
  assert.equal(await db.collection('bk_games').countDocuments({}), 0, 'even the undamaged collections were not restored');
});

test('a truncated or missing data file is detected', async () => {
  await reset();
  await seed();
  const { dir } = await createBackup({ db, outDir: tmpDir() });
  const file = path.join(dir, 'bk_users.ndjson');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, `${lines[0]}\n`); // second document cut off
  fs.rmSync(path.join(dir, 'bk_games.ndjson'));

  const check = await inspectBackup(dir);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /bk_users: 1 documents in the file, the manifest says 2/.test(p)), check.problems.join('|'));
  assert.ok(check.problems.some((p) => /bk_games.*missing/.test(p)), check.problems.join('|'));
});

test('an unfinished backup (no manifest) and a foreign folder are refused', async () => {
  const dir = tmpDir();
  await assert.rejects(() => inspectBackup(dir), /No valid manifest\.json/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
  await assert.rejects(() => inspectBackup(dir), /No valid manifest\.json/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'something-else', collections: {} }));
  await assert.rejects(() => inspectBackup(dir), /Unknown backup format/);
  await assert.rejects(() => restoreBackup({ db, dir, apply: true }), /Unknown backup format/);
});

test('a damaged manifest cannot make the tool read files outside the backup folder', async () => {
  await reset();
  await seed();
  const { dir, manifest } = await createBackup({ db, outDir: tmpDir() });
  const secret = path.join(path.dirname(dir), 'outside.ndjson');
  fs.writeFileSync(secret, '{"_id":{"$oid":"000000000000000000000001"}}\n');

  const evil = JSON.parse(JSON.stringify(manifest));
  evil.collections['../outside'] = { ...evil.collections.bk_games, file: '../outside.ndjson' };
  evil.collections.bk_users.file = '..\\..\\bk_users.ndjson';
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(evil));

  const check = await inspectBackup(dir);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /\.\.\/outside.*unsafe/.test(p)), check.problems.join('|'));
  assert.ok(check.problems.some((p) => /bk_users.*unsafe/.test(p)), check.problems.join('|'));
  await reset();
  await assert.rejects(() => restoreBackup({ db, dir, apply: true }), /damaged/);
  assert.equal(await db.collection('outside').countDocuments({}), 0);
});

test('a bigger collection (several insert batches) and a large document survive the round trip', async () => {
  await reset();
  const many = Array.from({ length: 1234 }, (_, i) => ({ _id: new ObjectId(), n: i, at: new Date(1700000000000 + i) }));
  await db.collection('bk_many').insertMany(many);
  const big = { _id: new ObjectId(), text: 'x'.repeat(1024 * 1024) };
  await db.collection('bk_big').insertOne(big);

  const { dir, manifest } = await createBackup({ db, outDir: tmpDir() });
  assert.equal(manifest.collections.bk_many.count, 1234);
  assert.ok(manifest.collections.bk_big.bytes > 1024 * 1024);

  await reset();
  const result = await restoreBackup({ db, dir, apply: true });
  assert.equal(result.results.find((r) => r.name === 'bk_many').restored, 1234);
  const restoredBig = await db.collection('bk_big').findOne({ _id: big._id });
  assert.equal(restoredBig.text.length, 1024 * 1024);
  const sample = await db.collection('bk_many').findOne({ n: 1000 });
  assert.equal(sample.at.getTime(), 1700000001000);
});

test('an empty database can be backed up and restored', async () => {
  await reset();
  const { dir, manifest } = await createBackup({ db, outDir: tmpDir() });
  assert.deepEqual(manifest.collections, {});
  const result = await restoreBackup({ db, dir, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual(result.results, []);
});
