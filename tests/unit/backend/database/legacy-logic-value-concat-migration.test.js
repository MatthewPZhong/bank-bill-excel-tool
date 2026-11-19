'use strict';

// v3.2.19：映射字段「逻辑取值」模式之前，mapped_field 为「逻辑取值」、mapped_fields_json 有多个字段的行是旧式按序拼接
//   （首个源字段恰好叫「逻辑取值」）。首次升级时一次性还原为需要拼接字段；单字段 / 无字段的直接映射不动；
//   之后新建的逻辑取值不受影响（app_settings 标记保证只执行一次）。

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { upgradeLegacyLogicValueConcatMappings } = require('../../../../src/backend/database/migrations');

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT);
    CREATE TABLE template_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER, template_field TEXT,
      mapped_field TEXT NOT NULL, mapped_fields_json TEXT NOT NULL DEFAULT '[]', row_index INTEGER);
    CREATE TABLE template_bill_split_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER, template_field TEXT,
      mapped_field TEXT, mapped_fields_json TEXT, row_index INTEGER);
  `);
  return db;
}

function mappings(db, table) {
  return db.prepare(`SELECT template_field AS field, mapped_field AS mappedField, mapped_fields_json AS json FROM ${table} ORDER BY id`).all()
    .map((row) => [row.field, row.mappedField, JSON.parse(row.json || '[]')]);
}

test('升级：旧库「逻辑取值」多字段映射还原为需要拼接字段，直接映射不动；只执行一次，之后新建的逻辑取值不受影响', () => {
  const db = createDatabase();
  const insert = (table, field, mappedField, fields) => db.prepare(
    `INSERT INTO ${table} (template_id, template_field, mapped_field, mapped_fields_json, row_index) VALUES (1, ?, ?, ?, 0)`
  ).run(field, mappedField, JSON.stringify(fields));
  insert('template_mappings', 'Credit Amount', '逻辑取值', ['逻辑取值', '尾数']);
  insert('template_mappings', 'Remark', '逻辑取值', ['逻辑取值']);
  insert('template_mappings', 'Payee Name', '逻辑取值', []);
  insert('template_mappings', 'BillDate', '交易日期', []);
  insert('template_bill_split_mappings', 'Remark', ' 逻辑取值 ', ['逻辑取值', '', '附言']);

  assert.deepEqual(upgradeLegacyLogicValueConcatMappings(db), { status: 'migrated', updated: 2 });
  assert.deepEqual(mappings(db, 'template_mappings'), [
    ['Credit Amount', '需要拼接字段', ['逻辑取值', '尾数']],
    ['Remark', '逻辑取值', ['逻辑取值']],
    ['Payee Name', '逻辑取值', []],
    ['BillDate', '交易日期', []]
  ]);
  assert.deepEqual(mappings(db, 'template_bill_split_mappings'), [['Remark', '需要拼接字段', ['逻辑取值', '', '附言']]]);

  // 升级之后新建的逻辑取值（有序候补字段）：再次启动不再改动
  insert('template_mappings', 'Payee Name', '逻辑取值', ['对方户名', '摘要']);
  assert.deepEqual(upgradeLegacyLogicValueConcatMappings(db), { status: 'done' });
  assert.deepEqual(mappings(db, 'template_mappings').at(-1), ['Payee Name', '逻辑取值', ['对方户名', '摘要']]);
});

test('升级：app_settings 尚不存在时跳过，等下次启动', () => {
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(upgradeLegacyLogicValueConcatMappings(db), { status: 'skipped' });
});
