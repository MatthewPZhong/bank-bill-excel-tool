'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSynchronousCandidateWriter } = require('../../backend/sqlite-candidate-writer');
const { PART_TARGET_ROWS, PART_TARGET_BYTES } = require('./candidate-router');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { RESULT_COLUMNS, NOTE_COLUMNS, RESULT_SCHEMA, NOTES_SCHEMA, PART_SCHEMA } = require('./result-schema');
const { fail } = require('./contracts');

function configure(db) {
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384');
}
function createResultSink({ directory, objectId, taskRunId, safePoint = () => {},
  partTargetRows = PART_TARGET_ROWS, partTargetBytes = PART_TARGET_BYTES }) {
  for (const limit of [partTargetRows, partTargetBytes]) if (!Number.isSafeInteger(limit) || limit < 1) fail('BIZOP_PART_TARGET_INVALID');
  const parts = []; let current = null; let noteCount = 0; let resultCount = 0;
  let transactions = 0;
  function close() {
    if (!current) return;
    const { db, writer, part } = current;
    const errors = [];
    try {
      const state = writer.snapshot().state;
      if (!['READY', 'WRITING', 'FINISHED'].includes(state)) fail('BIZOP_RESULT_WRITER_FAILED');
      transactions += writer.finish().committedTransactions;
      const table = part.partKind === 'RESULT' ? 'result_rows' : 'explanation_records';
      if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== part.rowCount) fail('BIZOP_ROW_COUNT_MISMATCH');
      if (part.partKind === 'RESULT') db.exec('CREATE INDEX result_rows_diff ON result_rows(is_difference,row_ordinal)');
      else db.exec('CREATE INDEX explanation_by_result ON explanation_records(result_row_ordinal,record_type,note_ordinal); CREATE INDEX explanation_by_source ON explanation_records(source_artifact_id,source_sheet,source_row,note_ordinal)');
      if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('BIZOP_CANDIDATE_SQLITE_INVALID');
      db.prepare("UPDATE part_meta SET state='SEALED',row_count=?").run(part.rowCount);
    } catch (error) { errors.push(error); }
    try { writer.close(); } catch (error) { errors.push(error); }
    try { db.close(); } catch (error) { errors.push(error); }
    current = null;
    if (errors.length) throw new AggregateError(errors, '结果写入或关闭未完成');
  }
  function open(partKind) {
    close(); safePoint();
    if (parts.length >= 4096) fail('BIZOP_RESULT_PART_BUDGET');
    const number = parts.length + 1;
    const name = `part-${String(number).padStart(6, '0')}.sqlite`;
    const filename = path.join(directory, name);
    const db = new DatabaseSync(filename);
    try {
      configure(db); db.exec(PART_SCHEMA); db.exec(partKind === 'RESULT' ? RESULT_SCHEMA : NOTES_SCHEMA);
      db.prepare('INSERT INTO part_meta VALUES (1,1,?,?,?,?,?,?,?,0)').run(objectId, partKind, number, taskRunId,
        CELL_CONTRACT_VERSION, RULE_VERSION, 'STAGING');
      const table = partKind === 'RESULT' ? 'result_rows' : 'explanation_records';
      const fields = partKind === 'RESULT' ? RESULT_COLUMNS.length + 7 : NOTE_COLUMNS.length;
      const writer = createSynchronousCandidateWriter({ db, insertSql: `INSERT INTO ${table} VALUES (${Array(fields).fill('?').join(',')})` });
      const part = { name, rowCount: 0, partKind }; parts.push(part);
      current = { db, writer, part, filename };
    } catch (error) { db.close(); throw error; }
  }
  function append(partKind, values) {
    safePoint();
    if (!current || current.part.partKind !== partKind || current.part.rowCount >= partTargetRows
        || (current.writer.snapshot().currentRows === 0 && fs.statSync(current.filename).size >= partTargetBytes)) open(partKind);
    current.writer.append(values); current.part.rowCount += 1;
  }
  return Object.freeze({ close,
    result(row) {
      if (row.rowOrdinal !== resultCount + 1 || row.values.length !== 19) fail('BIZOP_RESULT_ORDER_INVALID');
      append('RESULT', [row.rowOrdinal, ...row.values, ...row.key, row.isDifference, row.reasonBits, row.descriptionSourceRole]);
      resultCount += 1;
    },
    note(record) {
      // 分片保留完整文本，避免大值或代理对在 Excel 单元格边界被截断。
      const value = record.value_part == null ? null : String(record.value_part);
      const chunks = [];
      if (value === null || value.length === 0) chunks.push(value);
      else for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 8000, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
        chunks.push(value.slice(offset, end)); offset = end;
      }
      for (let i = 0; i < chunks.length; i += 1) {
        const item = { ...record, owner_id: objectId, note_ordinal: noteCount + 1, value_part: chunks[i], part_index: i + 1, part_count: chunks.length };
        append('NOTES', NOTE_COLUMNS.map((key) => item[key] ?? null)); noteCount += 1;
      }
    },
    finish() {
      close();
      if (!parts.some((part) => part.partKind === 'RESULT')) { open('RESULT'); close(); }
      return { parts: parts.map((part) => ({ ...part })), resultCount, noteCount, transactions, peakOutputConnections: 1 };
    }
  });
}

module.exports = { createResultSink, configure };
