'use strict';

// v3.2.22 B45：多模板分组生成的写出记录——原有文件原地还原（文件身份不变）、新建文件删除、同一路径只记首次状态，
//   还原失败时报告路径并保留备份，成功提交只清理临时目录。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStatementOutputJournal } = require('../../../src/main-process/statement-output-rollback');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-rollback-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  return { root, staging };
}

test('回滚：原有文件按首次记录前的内容原地还原，新建文件删除，备份目录清理', (t) => {
  const { root, staging } = setup(t);
  const existing = path.join(root, 'seed.json');
  const created = path.join(root, 'detail.xlsx');
  fs.writeFileSync(existing, 'before');
  const ino = fs.statSync(existing).ino;
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.record(existing);
  fs.writeFileSync(existing, 'group-1');
  journal.record(existing); // 同批再次写入：仍按首次记录前的内容还原
  fs.writeFileSync(existing, 'group-2');
  journal.record(created);
  fs.writeFileSync(created, 'new');
  const { failures } = journal.rollback();
  assert.deepEqual(failures, []);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'before');
  assert.equal(fs.statSync(existing).ino, ino, '原地写回，文件身份不变');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('提交：保留新内容，只清理备份目录', (t) => {
  const { root, staging } = setup(t);
  const existing = path.join(root, 'balance.xlsx');
  fs.writeFileSync(existing, 'before');
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.record(existing);
  fs.writeFileSync(existing, 'after');
  journal.commit();
  assert.equal(fs.readFileSync(existing, 'utf8'), 'after');
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('还原失败时报告路径与原因并保留备份，其余文件照常还原', (t) => {
  const { root, staging } = setup(t);
  const blocked = path.join(root, 'blocked.xlsx');
  const other = path.join(root, 'other.xlsx');
  fs.writeFileSync(blocked, 'blocked-before');
  fs.writeFileSync(other, 'other-before');
  const failingFs = { ...fs, writeFileSync(filePath, ...rest) {
    if (filePath === blocked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return fs.writeFileSync(filePath, ...rest);
  } };
  const journal = createStatementOutputJournal({ fsImpl: failingFs, stagingRoot: staging });
  journal.record(blocked);
  journal.record(other);
  fs.writeFileSync(blocked, 'blocked-after');
  fs.writeFileSync(other, 'other-after');
  const { failures, backupDirectory } = journal.rollback();
  assert.deepEqual(failures.map((item) => item.filePath), [blocked]);
  assert.equal(fs.readFileSync(other, 'utf8'), 'other-before');
  assert.ok(backupDirectory && fs.existsSync(backupDirectory), '保留备份便于人工恢复');
  assert.ok(fs.readdirSync(backupDirectory).some((name) => fs.readFileSync(path.join(backupDirectory, name), 'utf8') === 'blocked-before'));
});

test('目标不是普通文件时不备份、不删除', (t) => {
  const { root, staging } = setup(t);
  const directory = path.join(root, 'occupied');
  fs.mkdirSync(directory);
  const journal = createStatementOutputJournal({ stagingRoot: staging });
  journal.record(directory);
  assert.deepEqual(journal.rollback().failures, []);
  assert.ok(fs.statSync(directory).isDirectory());
});
