#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  runRuntimeCapabilityProbe,
  assertVccMutationSchema,
  vccTriggers,
  assertVccTriggerPolicy
} = require('../../src/backend/vcc-financial-op/mutation-guard');

function parseArgs(argv) {
  const options = { dbPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') options.dbPath = path.resolve(argv[++index] || '');
    else throw new Error(`未知参数：${value}`);
  }
  if (options.dbPath && !fs.existsSync(options.dbPath)) {
    throw new Error(`数据库不存在：${options.dbPath}`);
  }
  return options;
}

function inspectDatabase(dbPath) {
  if (!dbPath) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;');
    const schema = assertVccMutationSchema(db);
    const triggers = vccTriggers(db).map((trigger) => ({
      name: trigger.name,
      tableName: trigger.tableName
    }));
    assertVccTriggerPolicy(db);
    return { schema, triggers, approved: true };
  } finally {
    db.close();
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = runRuntimeCapabilityProbe();
  const database = inspectDatabase(options.dbPath);
  process.stdout.write(`${JSON.stringify({
    status: 'success',
    node: process.version,
    electron: process.versions.electron || null,
    sqlite: process.versions.sqlite || null,
    runtime,
    database
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'error',
    code: error && error.code ? error.code : null,
    message: error && error.message ? error.message : String(error),
    context: error && error.context ? error.context : null
  }, null, 2)}\n`);
  process.exitCode = 1;
}
