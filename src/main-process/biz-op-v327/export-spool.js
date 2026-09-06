'use strict';

const { createHash } = require('node:crypto');
const { setImmediate: yieldWorker } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createSynchronousCandidateWriter } = require('../../backend/sqlite-candidate-writer');
const { configure } = require('./result-sink');
const { NOTE_COLUMNS } = require('./result-schema');
const { registry, schemaFor, cell, text, sheetName, evidenceIdentity } = require('./export-cells');
const { fail } = require('./contracts');

function createEvidence(identity) {
  const hash = createHash('sha256');
  const add = (value) => hash.update(`${JSON.stringify(value)}\n`);
  add(identity);
  return { add, finish: () => hash.digest('hex') };
}
function createExportSpool({ filename, source, maxRowsPerSheet = 1048575, safePoint = () => {} }) {
  if (!Number.isSafeInteger(maxRowsPerSheet) || maxRowsPerSheet < 1 || maxRowsPerSheet > 1048575) fail('BIZOP_OUTPUT_PAGE_LIMIT');
  const schema = schemaFor(source.outputKind, source.columnSchemaVersion);
  const includeNotes = schema.notesSchema !== null;
  const db = new DatabaseSync(filename); configure(db);
  db.exec('CREATE TABLE export_rows(section TEXT NOT NULL,ordinal INTEGER NOT NULL,cells TEXT NOT NULL,PRIMARY KEY(section,ordinal)) WITHOUT ROWID');
  const writer = createSynchronousCandidateWriter({ db, insertSql: 'INSERT INTO export_rows VALUES (?,?,?)' });
  const counts = { DATA: 0, NOTES: 0 }; let finished = false;
  const identity = evidenceIdentity({ ...source, maxRowsPerSheet });
  function append(section, values) {
    safePoint();
    if (finished || values.length !== (section === 'DATA' ? schema.columnCount : 22)) fail('BIZOP_OUTPUT_ROW_INVALID');
    const ordinal = ++counts[section];
    if (Math.ceil(ordinal / maxRowsPerSheet) > 4096) fail('BIZOP_OUTPUT_PAGE_BUDGET');
    writer.append([section, ordinal, JSON.stringify(values)]);
    return ordinal;
  }
  function location(ordinal) { return { sheet_name: sheetName(source.outputKind, Math.floor((ordinal - 1) / maxRowsPerSheet) + 1, source), sheet_row: (ordinal - 1) % maxRowsPerSheet + 2 }; }
  function note(record, preserveParts = false) {
    if (!includeNotes) { safePoint(); return; }
    const value = record.value_part == null ? null : String(record.value_part);
    const chunks = [];
    if (preserveParts || !value) chunks.push(value);
    else for (let i = 0; i < value.length;) {
      let end = Math.min(value.length, i + 8000);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
      chunks.push(value.slice(i, end)); i = end;
    }
    for (let i = 0; i < chunks.length; i += 1) {
      const item = { ...record, owner_id: source.objectId, output_kind: source.outputKind,
        note_ordinal: counts.NOTES + 1, value_part: chunks[i],
        part_index: preserveParts ? record.part_index : i + 1, part_count: preserveParts ? record.part_count : chunks.length };
      append('NOTES', NOTE_COLUMNS.map((key, index) => cell(item[key] ?? null, registry.notesSchema.columns[index].domain)));
    }
  }
  function data(values, metadata = {}) {
    const ordinal = append('DATA', values);
    note({ record_type: 'OUTPUT_ROW_MAP', ...metadata, ...location(ordinal) });
  }
  function precision(column, value, reason, metadata = {}) {
    note({ record_type: 'PRECISION_NOTE', ...metadata, ...location(counts.DATA + 1),
      field_key: schema.columns[column].header, value_type: 'DECIMAL_TEXT', value_part: JSON.stringify({ value, reason }) });
  }
  function pages() {
    return (includeNotes ? ['DATA', 'NOTES'] : ['DATA']).flatMap((section) => {
      const headers = (section === 'DATA' ? schema.columns : registry.notesSchema.columns).map((column) => column.header);
      return Array.from({ length: Math.max(1, Math.ceil(counts[section] / maxRowsPerSheet)) }, (_, index) => ({
        section, page: index + 1, name: sheetName(section === 'DATA' ? source.outputKind : 'NOTES', index + 1, source),
        headers, rowCount: Math.min(maxRowsPerSheet, Math.max(0, counts[section] - index * maxRowsPerSheet)) }));
    });
  }
  function rows(page) { return db.prepare('SELECT * FROM export_rows WHERE section=? AND ordinal>? AND ordinal<=? ORDER BY ordinal')
    .iterate(page.section, (page.page - 1) * maxRowsPerSheet, page.page * maxRowsPerSheet); }
  async function finish() {
    writer.finish(); finished = true;
    const allPages = pages();
    if (allPages.length > 4096) fail('BIZOP_OUTPUT_PAGE_BUDGET');
    const evidence = createEvidence(identity);
    for (const page of allPages) {
      evidence.add({ name: page.name, section: page.section, page: page.page, headers: page.headers });
      evidence.add({ row: 1, values: page.headers.map(text) });
      let n = 0;
      for (const row of rows(page)) {
        if (n % 1024 === 0) await yieldWorker();
        safePoint(); evidence.add({ row: ++n + 1, values: JSON.parse(row.cells) });
      }
      if (n !== page.rowCount) fail('BIZOP_OUTPUT_ROW_COUNT');
      evidence.add({ rows: n });
    }
    return { identity, expectedDigest: evidence.finish(), pages: allPages, dataRowCount: counts.DATA, noteRowCount: counts.NOTES };
  }
  return { db, data, note, precision, finish, rows, counts, close() { try { writer.close(); } finally { db.close(); } } };
}
module.exports = { createExportSpool, createEvidence };
