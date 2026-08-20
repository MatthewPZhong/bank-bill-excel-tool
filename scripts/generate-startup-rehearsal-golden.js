'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AppDatabase } = require('../src/backend/database');

const VACUUM_FLAG = 'db_one_time_vacuum_v3_0_5_done';
const FIXED_AT = '2026-01-01T00:00:00.000Z';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const bytes = fs.readFileSync(filePath);
  hash.update(bytes);
  return hash.digest('hex');
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readLogicalFingerprint(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = db.prepare(`
      SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name, tbl_name, sql
    `).all();
    const settings = db.prepare(`
      SELECT setting_key, setting_value
      FROM app_settings
      WHERE setting_key IN (?, ?)
      ORDER BY setting_key
    `).all(VACUUM_FLAG, 'startup_rehearsal_fixture');
    return {
      schemaSha256: stableDigest(schema),
      objectCounts: Object.fromEntries(['table', 'index', 'trigger', 'view'].map((type) => [
        type, schema.filter((row) => row.type === type).length
      ])),
      settings
    };
  } finally {
    db.close();
  }
}

function createPreseed(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO app_settings(setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
    `).run(VACUUM_FLAG, '1', FIXED_AT);
  } finally {
    db.close();
  }
}

function generateRehearsalGolden(outputDirectory) {
  const root = path.resolve(outputDirectory);
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, 'tool-data.sqlite');
  if (fs.existsSync(databasePath)) throw new Error('rehearsal golden 已存在，拒绝覆盖');
  createPreseed(databasePath);
  const appDb = new AppDatabase(databasePath);
  try {
    appDb.init();
    appDb.db.prepare(`
      INSERT INTO app_settings(setting_key, setting_value, updated_at)
      VALUES ('startup_rehearsal_fixture', 'deterministic-v1', ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at
    `).run(FIXED_AT);
    appDb.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    appDb.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size === 0) fs.rmSync(sidecar);
  }
  const logicalFingerprint = readLogicalFingerprint(databasePath);
  const manifest = {
    schemaVersion: 1,
    kind: 'windows-startup-rehearsal-golden',
    mode: 'rehearsal',
    synthetic: true,
    formalUseAllowed: false,
    pathRecorded: false,
    sizeBytes: fs.statSync(databasePath).size,
    sha256: sha256File(databasePath),
    logicalFingerprint,
    evaluation: {
      status: 'not-evaluated',
      reasonCode: 'SYNTHETIC_REHEARSAL_NEVER_FORMAL'
    }
  };
  fs.writeFileSync(path.join(root, 'rehearsal-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { databasePath, manifest };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--output-dir') {
    throw new TypeError('用法：node scripts/generate-startup-rehearsal-golden.js --output-dir <目录>');
  }
  const result = generateRehearsalGolden(argv[1]);
  process.stdout.write(`rehearsal golden generated (${result.manifest.sizeBytes} bytes, formalUseAllowed=false)\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error && error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  generateRehearsalGolden,
  readLogicalFingerprint
};
