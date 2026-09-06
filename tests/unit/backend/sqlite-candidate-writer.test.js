'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSynchronousCandidateWriter, chargeBindRow } = require('../../../src/backend/sqlite-candidate-writer');

function fixture(t, options = {}, wrap = (db) => db) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rows(value TEXT UNIQUE)');
  t.after(() => db.close());
  const writer = createSynchronousCandidateWriter({ db: wrap(db), insertSql: 'INSERT INTO rows VALUES (?)', ...options });
  t.after(() => writer.close());
  return { db, writer, count: () => db.prepare('SELECT count(*) AS n FROM rows').get().n };
}
test('候选逐行立即 INSERT，4095/4096/4097 及 finish/close 不关闭调用方连接', (t) => {
  const { writer, db, count } = fixture(t);
  for (let i = 1; i <= 4095; i += 1) { writer.append([String(i)]); assert.equal(count(), i); }
  assert.equal(writer.snapshot().committedRows, 0);
  writer.append(['4096']); assert.equal(writer.snapshot().committedRows, 4096);
  writer.append(['4097']); assert.equal(writer.snapshot().currentRows, 1);
  const finished = writer.finish(); assert.deepEqual(writer.finish(), finished);
  writer.close(); writer.close(); assert.equal(count(), 4097);
  assert.throws(() => writer.append(['again']), { code: 'CANDIDATE_WRITER_STATE_INVALID' });
  db.exec("INSERT INTO rows VALUES ('caller')"); assert.equal(count(), 4098);
});
test('sqlite-bind-charge-v1 计费；4MiB 边界及越界预 flush / 单行拒绝', (t) => {
  assert.equal(chargeBindRow([null, '中😀', 7, 123n, new Uint8Array(3)]), 64 + 5 * 16 + 7 + 8 + 3 + 3);
  const limit = 4 * 1024 * 1024;
  const { writer, count } = fixture(t);
  writer.append(['a'.repeat(limit - 81)]); assert.equal(writer.snapshot().currentChargedBytes, limit - 1);
  writer.append(['small']); assert.equal(writer.snapshot().committedRows, 1);
  assert.throws(() => writer.append(['x'.repeat(limit - 79)]), { code: 'CANDIDATE_WRITER_ROW_TOO_LARGE' });
  assert.equal(count(), 1); assert.equal(writer.snapshot().rolledBackRows, 1);
  const exact = fixture(t); exact.writer.append(['b'.repeat(limit - 80)]);
  assert.equal(exact.writer.snapshot().committedRows, 1); assert.equal(exact.writer.snapshot().currentRows, 0);
});
test('外层事务已有哨兵时 BEGIN 失败不能回滚、提交或关闭调用方', (t) => {
  const { db, writer, count } = fixture(t);
  db.exec("BEGIN; INSERT INTO rows VALUES ('sentinel')");
  assert.throws(() => writer.append(['new']), { code: 'CANDIDATE_WRITER_TRANSACTION_NOT_OWNED' });
  writer.close(); assert.equal(count(), 1);
  db.exec('ROLLBACK'); assert.equal(count(), 0);
});
test('两块提交后第三块 INSERT 失败只撤当前块，不重放历史', (t) => {
  const { writer, count } = fixture(t, { maxRowsPerTransaction: 2 });
  for (const value of ['1', '2', '3', '4', '5']) writer.append([value]);
  assert.throws(() => writer.append(['1']), /UNIQUE/);
  assert.equal(count(), 4);
  assert.deepEqual(writer.snapshot(), { insertedRows: 5, committedRows: 4, currentRows: 0,
    currentChargedBytes: 0, committedTransactions: 2, rolledBackRows: 1, state: 'FAILED' });
});
test('非法参数失败均回滚自有活动事务，空 finish 不提交', (t) => {
  const invalid = [[undefined], [, 'sparse'], [NaN], [Infinity], [1.2], [Number.MAX_SAFE_INTEGER + 1],
    [Promise.resolve(1)], [{}], new Uint8Array(1)];
  for (const params of invalid) {
    const { writer, count } = fixture(t); writer.append(['before']);
    assert.throws(() => writer.append(params), { code: 'CANDIDATE_WRITER_BIND_INVALID' }); assert.equal(count(), 0);
  }
  const empty = fixture(t); assert.equal(empty.writer.finish().committedTransactions, 0);
});
test('COMMIT 已生效后反馈失败进入 UNCERTAIN，不猜测回滚或重试', (t) => {
  let commits = 0; let rollbacks = 0;
  const { writer, count } = fixture(t, {}, (db) => ({ prepare: (sql) => db.prepare(sql), exec(sql) {
    if (sql === 'ROLLBACK') rollbacks += 1;
    db.exec(sql);
    if (sql === 'COMMIT') { commits += 1; throw new Error('反馈丢失'); }
  } }));
  writer.append(['written']); assert.throws(() => writer.finish(), { code: 'CANDIDATE_WRITER_COMMIT_UNCERTAIN' });
  assert.equal(writer.snapshot().state, 'UNCERTAIN'); writer.close(); writer.close();
  assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(count(), 1);
});
test('ROLLBACK 失败保留 UNCERTAIN，连接所有者独立收口', (t) => {
  const { db, writer, count } = fixture(t, {}, (connection) => ({ prepare: (sql) => connection.prepare(sql), exec(sql) {
    if (sql === 'ROLLBACK') throw new Error('未确定');
    connection.exec(sql);
  } }));
  writer.append(['x']); assert.throws(() => writer.abortCurrent(), { code: 'CANDIDATE_WRITER_ROLLBACK_UNCERTAIN' });
  assert.equal(writer.snapshot().state, 'UNCERTAIN'); writer.close(); assert.equal(count(), 1);
  db.exec('ROLLBACK'); assert.equal(count(), 0);
});
