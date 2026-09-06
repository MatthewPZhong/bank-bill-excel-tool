'use strict';

const CHARGE_VERSION = 'sqlite-bind-charge-v1';
const MAX_ROWS_PER_TRANSACTION = 4096;
const MAX_CHARGED_BYTES_PER_TRANSACTION = 4 * 1024 * 1024;

class CandidateWriterError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CandidateWriterError';
    this.code = code;
  }
}

function problem(suffix, message, cause) {
  return new CandidateWriterError(`CANDIDATE_WRITER_${suffix}`, message, cause);
}

function chargeBindRow(params) {
  if (!Array.isArray(params)) throw problem('BIND_INVALID', '候选参数必须是非稀疏数组');
  let bytes = 64;
  for (let index = 0; index < params.length; index += 1) {
    if (!Object.hasOwn(params, index)) throw problem('BIND_INVALID', '候选参数不能包含空位');
    const value = params[index];
    bytes += 16;
    if (value === null) continue;
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
    else if (typeof value === 'number' && Number.isSafeInteger(value)) bytes += 8;
    else if (typeof value === 'bigint') bytes += Buffer.byteLength(value.toString(), 'utf8');
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else throw problem('BIND_INVALID', '候选参数只接受 null、文本、安全整数、bigint 或 Uint8Array');
    if (!Number.isSafeInteger(bytes)) throw problem('BIND_TOO_LARGE', '候选行计费超出安全整数');
  }
  return bytes;
}

function createSynchronousCandidateWriter({ db, insertSql,
  maxRowsPerTransaction = MAX_ROWS_PER_TRANSACTION,
  maxChargedBytesPerTransaction = MAX_CHARGED_BYTES_PER_TRANSACTION }) {
  for (const limit of [maxRowsPerTransaction, maxChargedBytesPerTransaction]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('候选事务上限必须是正安全整数');
  }
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function'
      || typeof insertSql !== 'string' || !/^\s*INSERT\b/i.test(insertSql)) {
    throw new TypeError('候选 writer 需要独占借用的 DatabaseSync 和受信任 INSERT');
  }
  let connection = db;
  let statement = db.prepare(insertSql);
  let ownsTransaction = false;
  let closed = false;
  let entered = false;
  const counters = { insertedRows: 0, committedRows: 0, currentRows: 0, currentChargedBytes: 0,
    committedTransactions: 0, rolledBackRows: 0, state: 'READY' };
  const snapshot = () => Object.freeze({ ...counters });

  function rollback() {
    if (!ownsTransaction) return;
    try { connection.exec('ROLLBACK'); }
    catch (error) { counters.state = 'UNCERTAIN'; throw problem('ROLLBACK_UNCERTAIN', '候选事务回滚状态不确定', error); }
    ownsTransaction = false;
    counters.rolledBackRows += counters.currentRows;
    counters.currentRows = 0;
    counters.currentChargedBytes = 0;
  }
  function failOwned(error) {
    counters.state = 'FAILED';
    try { rollback(); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], '候选写入失败且回滚未确认', { cause: error }); }
    throw error;
  }
  function assertWritable() {
    if (closed || !['READY', 'WRITING'].includes(counters.state)) {
      throw problem('STATE_INVALID', `候选 writer 已停止接受数据：${counters.state}`);
    }
  }
  function exclusive(work) {
    if (entered) throw problem('REENTRANT', '候选 writer 不允许重入');
    entered = true;
    try { return work(); } finally { entered = false; }
  }
  function commit() {
    if (!ownsTransaction) return;
    try { connection.exec('COMMIT'); }
    catch (error) {
      counters.state = 'UNCERTAIN';
      // COMMIT 可能已经生效；不猜测回滚或重放，由连接所有者关闭并隔离候选。
      throw problem('COMMIT_UNCERTAIN', '候选事务提交状态不确定', error);
    }
    ownsTransaction = false;
    counters.committedRows += counters.currentRows;
    counters.committedTransactions += 1;
    counters.currentRows = 0;
    counters.currentChargedBytes = 0;
    counters.state = 'READY';
  }
  return Object.freeze({
    append(params) {
      return exclusive(() => {
        assertWritable();
        let bytes;
        try {
          bytes = chargeBindRow(params);
          if (bytes > maxChargedBytesPerTransaction) throw problem('ROW_TOO_LARGE', '单行超过候选事务字节上限');
          if (counters.insertedRows === Number.MAX_SAFE_INTEGER) throw problem('COUNTER_LIMIT', '候选计数超出安全范围');
        } catch (error) { failOwned(error); }
        if (counters.currentRows && (counters.currentRows + 1 > maxRowsPerTransaction
            || counters.currentChargedBytes + bytes > maxChargedBytesPerTransaction)) commit();
        if (!ownsTransaction) {
          try { connection.exec('BEGIN IMMEDIATE'); }
          catch (error) {
            counters.state = 'FAILED';
            throw problem('TRANSACTION_NOT_OWNED', '未取得候选事务；调用方事务保持原状', error);
          }
          ownsTransaction = true;
          counters.state = 'WRITING';
        }
        try {
          const result = statement.run(...params);
          if (result.changes !== 1 && result.changes !== 1n) throw problem('INSERT_CARDINALITY', '每次候选 INSERT 必须恰好写入一行');
          counters.insertedRows += 1;
          counters.currentRows += 1;
          counters.currentChargedBytes += bytes;
        } catch (error) { failOwned(error); }
        if (counters.currentRows === maxRowsPerTransaction || counters.currentChargedBytes === maxChargedBytesPerTransaction) commit();
      });
    },
    flush() { return exclusive(() => { assertWritable(); commit(); }); },
    finish() {
      return exclusive(() => {
        if (counters.state === 'FINISHED') return snapshot();
        assertWritable(); commit(); counters.state = 'FINISHED'; return snapshot();
      });
    },
    abortCurrent() {
      return exclusive(() => {
        if (counters.state === 'ABORTED') return snapshot();
        assertWritable(); rollback(); counters.state = 'ABORTED'; return snapshot();
      });
    },
    close() {
      return exclusive(() => {
        if (closed) return;
        try {
          if (['READY', 'WRITING'].includes(counters.state)) { rollback(); counters.state = 'ABORTED'; }
        } finally { closed = true; connection = null; statement = null; }
      });
    },
    snapshot
  });
}

module.exports = { CHARGE_VERSION, MAX_ROWS_PER_TRANSACTION, MAX_CHARGED_BYTES_PER_TRANSACTION,
  CandidateWriterError, chargeBindRow, createSynchronousCandidateWriter };
