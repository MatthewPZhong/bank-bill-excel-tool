'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { ensureBizOpReconTablesSupport } = require('../../backend/biz-op-recon-db/migrations');
const { fail, hash } = require('./contracts');
const TABLES = Object.freeze(['biz_op_recon_diff_rows', 'biz_op_recon_runs', 'biz_op_recon_imports',
  'biz_op_recon_flow_imports', 'biz_op_recon_dataset_heads', 'biz_op_recon_month_end_copy_intents']);
const FILE = /^month-\d{4}-(?:0[1-9]|1[0-2])\.sqlite(?:-wal|-shm)?$/;
const BASE = /^month-\d{4}-(?:0[1-9]|1[0-2])\.sqlite$/;
const LIMIT = 4096;
function statIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('BIZOP_LEGACY_FILE_UNSAFE');
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(stat[key])]));
}
function legacyRoot(userDataDir) {
  const configured = path.resolve(userDataDir);
  const rootStat = fs.lstatSync(configured);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('BIZOP_LEGACY_ROOT_UNSAFE');
  const root = fs.realpathSync(configured);
  let current = root;
  for (const name of ['run-data', 'biz-op-recon']) {
    current = path.join(current, name);
    if (!fs.existsSync(current)) {
      try { fs.lstatSync(current); fail('BIZOP_LEGACY_ROOT_UNSAFE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('BIZOP_LEGACY_ROOT_UNSAFE');
  }
  return current;
}
function enumerate(userDataDir) {
  const root = legacyRoot(userDataDir); let directory;
  try { directory = fs.opendirSync(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (!FILE.test(entry.name) || !entry.isFile() || files.length >= LIMIT) fail('BIZOP_LEGACY_INVENTORY_UNSAFE');
      files.push({ name: entry.name, identity: statIdentity(path.join(root, entry.name)) });
    }
  } finally { directory.closeSync(); }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
let knownTriggers;
function triggers() {
  if (!knownTriggers) {
    const expected = new DatabaseSync(':memory:');
    try { ensureBizOpReconTablesSupport(expected); knownTriggers = new Map(expected.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all()
      .map((row) => [row.name, hash(row.sql)])); } finally { expected.close(); }
  }
  return knownTriggers;
}
function validateSchema(db, { side = false, quiescent = false } = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  if (tables.length > 4096 || side && tables.some((name) => !TABLES.includes(name) && name !== 'sqlite_sequence')) fail('BIZOP_LEGACY_SCHEMA_UNKNOWN');
  for (const table of tables) {
    const quoted = '"' + table.replace(/"/g, '""') + '"';
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()) {
      if (TABLES.includes(fk.table) || TABLES.includes(table)) {
        if (table !== 'biz_op_recon_diff_rows' || fk.table !== 'biz_op_recon_runs' || fk.from !== 'run_id' || fk.to !== 'id') fail('BIZOP_LEGACY_FOREIGN_REFERENCE');
      }
    }
  }
  for (const row of db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").iterate()) {
    if (TABLES.includes(row.tbl_name) && triggers().get(row.name) !== hash(row.sql)) fail('BIZOP_LEGACY_TRIGGER_UNKNOWN');
  }
  if (side && TABLES.some((name) => !tables.includes(name))) fail('BIZOP_LEGACY_SCHEMA_INCOMPLETE');
  if (quiescent) {
    if (tables.includes('biz_op_recon_runs') && db.prepare(`SELECT 1 FROM biz_op_recon_runs
      WHERE archive_contract_version=1 AND archive_terminal_ack_at IS NULL LIMIT 1`).get()) fail('BIZOP_LEGACY_RECEIPT_PENDING');
    if (tables.includes('biz_op_recon_month_end_copy_intents') && db.prepare('SELECT 1 FROM biz_op_recon_month_end_copy_intents LIMIT 1').get()) fail('BIZOP_LEGACY_COPY_PENDING');
  }
  return tables.filter((name) => TABLES.includes(name));
}
async function hashIdentity(file, safePoint) {
  const before = statIdentity(file); const hasher = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) { safePoint(); hasher.update(chunk); }
  if (hash(before) !== hash(statIdentity(file))) fail('BIZOP_LEGACY_FILE_CHANGED');
  return { identity: before, sha256: hasher.digest('hex') };
}
async function inspectFiles(userDataDir, names, quiescent, safePoint) {
  if (!Array.isArray(names) || names.length > 32 || names.some((name) => !BASE.test(name))) fail('BIZOP_UPGRADE_PLAN_INVALID');
  const root = legacyRoot(userDataDir);
  for (const name of names) {
    safePoint(); statIdentity(path.join(root, name));
    const db = new DatabaseSync(path.join(root, name), { readOnly: true });
    try {
      validateSchema(db, { side: true, quiescent });
      if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('BIZOP_LEGACY_SQLITE_INVALID');
    } finally { db.close(); }
  }
  // SQLite 只读连接也可能处理 WAL/SHM；关闭后记录真实存在的完整文件身份。
  const files = [];
  for (const file of enumerate(userDataDir)) if (names.includes(file.name.replace(/-(wal|shm)$/, ''))) {
    files.push({ name: file.name, ...await hashIdentity(path.join(root, file.name), safePoint) });
  }
  return files;
}
async function syncDirectory(root) {
  const handle = await fs.promises.open(root, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function reclaimFiles(userDataDir, files, safePoint) {
  if (!Array.isArray(files) || files.length > 96) fail('BIZOP_UPGRADE_PLAN_INVALID');
  const root = legacyRoot(userDataDir);
  for (const file of files) {
    safePoint(); if (!FILE.test(file.name)) fail('BIZOP_LEGACY_FILE_UNSAFE');
    const target = path.join(root, file.name);
    try {
      const actual = await hashIdentity(target, safePoint);
      if (hash(actual.identity) !== hash(file.identity) || actual.sha256 !== file.sha256) fail('BIZOP_LEGACY_FILE_CHANGED');
      // 不在验证与 unlink 之间启动其他异步步骤；实际目录耐久成功后才确认回收。
      if (hash(statIdentity(target)) !== hash(file.identity)) fail('BIZOP_LEGACY_FILE_CHANGED');
      fs.unlinkSync(target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (fs.existsSync(root)) await syncDirectory(root);
  return files.map((file) => file.name);
}
module.exports = { TABLES, BASE, LIMIT, enumerate, legacyRoot, statIdentity, validateSchema, inspectFiles, reclaimFiles };
