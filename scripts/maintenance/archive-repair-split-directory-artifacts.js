#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');

const packageJson = require('../../package.json');
const {
  createArchiveRepository,
  SPLIT_DIRECTORY_REPAIR_BATCH_NUMBERS
} = require('../../src/backend/database/archive-repository');

function parseArgs(argv) {
  let dbPath = '';
  let backupPath = '';
  let apply = false;
  let explicitDryRun = false;
  const batchNumbers = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') dbPath = argv[++index] || '';
    else if (arg === '--backup') backupPath = argv[++index] || '';
    else if (arg === '--batch-number') batchNumbers.push(argv[++index] || '');
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') explicitDryRun = true;
    else throw new TypeError(`未知参数：${arg}`);
  }
  if (apply && explicitDryRun) throw new TypeError('--apply 与 --dry-run 不能同时使用');
  if (!path.isAbsolute(dbPath)) throw new TypeError('--db 必须是绝对路径');
  const expected = [...SPLIT_DIRECTORY_REPAIR_BATCH_NUMBERS].sort();
  const requested = [...batchNumbers].sort();
  if (requested.length !== expected.length
      || requested.some((number, index) => number !== expected[index])) {
    throw new TypeError('必须各显式传入一次 2026-08-13-017 和 2026-08-13-018');
  }
  if (apply && !path.isAbsolute(backupPath)) {
    throw new TypeError('--apply 必须提供绝对 --backup 路径');
  }
  if (!apply && backupPath) throw new TypeError('dry-run 不创建 backup');
  if (apply && path.resolve(backupPath) === path.resolve(dbPath)) {
    throw new TypeError('--backup 不能覆盖活动数据库');
  }
  return { apply, backupPath, batchNumbers, dbPath };
}

function summarize(result) {
  const summary = {
    batchNumber: result.batchNumber,
    status: result.status
  };
  if (result.reason) summary.reason = result.reason;
  if (result.batchId) summary.batchId = result.batchId;
  if (result.pseudoArtifactId) summary.pseudoArtifactId = result.pseudoArtifactId;
  if (result.repairKey) summary.repairKey = result.repairKey;
  if (Array.isArray(result.realArtifactIds)) summary.realArtifactIds = result.realArtifactIds;
  if (Array.isArray(result.realArtifacts)) {
    summary.realArtifacts = result.realArtifacts.map((artifact) => ({
      id: artifact.id,
      blobId: artifact.blobId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      holdCount: artifact.holds.length
    }));
  }
  return summary;
}

function assertDatabaseFile(dbPath) {
  const stat = fs.statSync(dbPath);
  if (!stat.isFile()) throw new TypeError('--db 必须指向普通 SQLite 文件');
}

function acquireExclusiveMaintenanceConnection(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0');
  const mode = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;
  if (String(mode).toLowerCase() !== 'exclusive') {
    db.close();
    throw new Error('无法取得 Archive maintenance 独占锁，请先退出应用');
  }
  try {
    db.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    db.close();
    throw new Error(`无法取得 Archive maintenance 独占锁，请先退出应用：${error.message}`);
  }
  return db;
}

function verifyBackup(backupPath) {
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA quick_check').get();
    if (!result || result.quick_check !== 'ok') {
      throw new Error('SQLite backup quick_check 未通过');
    }
  } finally {
    db.close();
  }
}

async function run(argv, { backupDatabase = backup } = {}) {
  const options = parseArgs(argv);
  assertDatabaseFile(options.dbPath);
  if (!options.apply) {
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      const repository = createArchiveRepository(db);
      return {
        mode: 'dry-run',
        results: options.batchNumbers.map(
          (batchNumber) => summarize(repository.inspectSplitDirectoryArtifactRepair(batchNumber))
        )
      };
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(options.backupPath)) {
    throw new Error('--backup 已存在，拒绝覆盖');
  }
  const db = acquireExclusiveMaintenanceConnection(options.dbPath);
  try {
    try {
      await backupDatabase(db, options.backupPath);
      verifyBackup(options.backupPath);
    } catch (error) {
      fs.rmSync(options.backupPath, { force: true });
      throw error;
    }
    const repository = createArchiveRepository(db);
    return {
      mode: 'apply',
      backupPath: options.backupPath,
      results: options.batchNumbers.map((batchNumber) => summarize(
        repository.repairSplitDirectoryArtifact(batchNumber, {
          appVersion: packageJson.version
        })
      ))
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  acquireExclusiveMaintenanceConnection,
  parseArgs,
  run,
  summarize,
  verifyBackup
};
