'use strict';

// 设置 → 账户管理仓储：建表幂等、整份替换的事务边界、预检后已被替换时整体回滚、渠道与分页查询。
const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ensureBankAccountSnapshotSupport } = require('../../../../src/backend/database/migrations');
const repo = require('../../../../src/backend/database/bank-account-repository');

function setup() {
  const db = new DatabaseSync(':memory:');
  ensureBankAccountSnapshotSupport(db);
  ensureBankAccountSnapshotSupport(db);
  return db;
}

function payload(rows, overrides = {}) {
  return {
    expectedSnapshotNo: 0,
    fileName: '银行账户信息.xlsx',
    fileExtension: 'xlsx',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
    sheetName: '账户',
    headers: ['银行/通道简称', '银行账号'],
    channelHeader: '银行/通道简称',
    structureVersionId: 'v1',
    structureLabel: 'V1',
    appVersion: '3.2.15',
    importedAt: '2026-11-05T13:30:00.000Z',
    rows: rows.map(([channel, account], index) => ({ excelRowNumber: index + 2, channel, values: [channel, account] })),
    ...overrides
  };
}

test('未导入时没有元数据与账户行；整份替换写入元数据与按序账户行', () => {
  const db = setup();
  assert.equal(repo.readSnapshot(db), null);
  assert.equal(repo.currentSnapshotNo(db), 0);
  assert.deepEqual(repo.replaceSnapshot(db, payload([['招商银行', '1'], ['花旗', '2'], ['', '3']])), { snapshotNo: 1, rowCount: 3 });
  const snapshot = repo.readSnapshot(db);
  assert.deepEqual({ ...snapshot }, {
    snapshotNo: 1, fileName: '银行账户信息.xlsx', fileExtension: 'xlsx', sizeBytes: 1024, sha256: 'b'.repeat(64),
    sheetName: '账户', channelHeader: '银行/通道简称', structureVersionId: 'v1', structureLabel: 'V1', rowCount: 3,
    appVersion: '3.2.15', importedAt: '2026-11-05T13:30:00.000Z', headers: ['银行/通道简称', '银行账号']
  });
  assert.deepEqual(repo.listRows(db).map((row) => [row.ordinal, row.excelRowNumber, row.channel, row.values]),
    [[1, 2, '招商银行', ['招商银行', '1']], [2, 3, '花旗', ['花旗', '2']], [3, 4, '', ['', '3']]]);
});

test('渠道去重排除空值并按中文排序；按渠道计数与分页', () => {
  const db = setup();
  repo.replaceSnapshot(db, payload([['招商银行', '1'], ['花旗', '2'], ['招商银行', '3'], ['', '4'], ['招商银行', '5']]));
  assert.deepEqual(repo.listChannels(db), [{ channel: '花旗', rowCount: 1 }, { channel: '招商银行', rowCount: 3 }]);
  assert.equal(repo.countRows(db), 5);
  assert.equal(repo.countRows(db, { channel: '招商银行' }), 3);
  assert.deepEqual(repo.listRows(db, { channel: '招商银行', offset: 1, limit: 1 }).map((row) => row.values[1]), ['3']);
  assert.deepEqual(repo.listRows(db, { offset: 3, limit: 10 }).map((row) => row.values[1]), ['4', '5']);
});

test('再次导入整份替换旧账户行，snapshot_no 递增', () => {
  const db = setup();
  repo.replaceSnapshot(db, payload([['招商银行', '1'], ['花旗', '2']]));
  assert.deepEqual(repo.replaceSnapshot(db, payload([['汇丰', '9']], { expectedSnapshotNo: 1, fileName: '新.xls', fileExtension: 'xls' })),
    { snapshotNo: 2, rowCount: 1 });
  assert.equal(repo.readSnapshot(db).fileName, '新.xls');
  assert.deepEqual(repo.listRows(db).map((row) => row.values), [['汇丰', '9']]);
  assert.deepEqual(repo.listChannels(db), [{ channel: '汇丰', rowCount: 1 }]);
});

test('预检后账户表已被替换：抛冲突并整体回滚；空账户行或写入失败同样不改变旧数据', () => {
  const db = setup();
  repo.replaceSnapshot(db, payload([['招商银行', '1']]));
  assert.throws(() => repo.replaceSnapshot(db, payload([['花旗', '2']], { expectedSnapshotNo: 0 })),
    (error) => error instanceof repo.BankAccountSnapshotConflictError && error.code === 'bank-account-snapshot-conflict'
      && error.expectedSnapshotNo === 0 && error.actualSnapshotNo === 1);
  assert.throws(() => repo.replaceSnapshot(db, payload([], { expectedSnapshotNo: 1 })), /没有账户行/);
  // 元数据违反约束（扩展名不受支持）：账户行的删除随事务回滚。
  assert.throws(() => repo.replaceSnapshot(db, payload([['花旗', '2']], { expectedSnapshotNo: 1, fileExtension: 'csv' })), /CHECK constraint failed/);
  assert.equal(repo.readSnapshot(db).snapshotNo, 1);
  assert.deepEqual(repo.listRows(db).map((row) => row.values), [['招商银行', '1']]);
  assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE 0').all().length, 0, '回滚后连接仍可用');
});
