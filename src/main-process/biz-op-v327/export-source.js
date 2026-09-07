'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { setImmediate: yieldMessages } = require('node:timers/promises');
const { openSingleSheetRichWorkbook } = require('../../backend/xlsx-rich-reader');
const { readVerifiedManifest } = require('./payload-store');
const { openReadonly, verifyOriginal } = require('./compute-pipeline');
const { detectHeader, createImportAdapter, OP_COLUMNS, FLOW_COLUMNS, CELL_CONTRACT_VERSION } = require('./import-adapter');
const { RESULT_COLUMNS, NOTE_COLUMNS, resultContractFor } = require('./result-schema');
const { schemaFor, cell, rawCell, outputName } = require('./export-cells');
const { fail, hash } = require('./contracts');

async function buildExportSource({ payloadStore, source, spool, tempDirectory, cancelToken, safePoint }) {
  const token = await payloadStore.verifyManifest(source.manifestRelativePath, source.manifestDigest);
  const manifest = readVerifiedManifest(token);
  if (manifest.objectId !== source.objectId || manifest.objectKind !== source.objectKind) fail('BIZOP_EXPORT_OWNER_MISMATCH');
  const schema = schemaFor(source.outputKind, source.columnSchemaVersion);
  const isResult = source.outputKind.startsWith('RESULT_');
  const isRaw = source.outputKind.endsWith('_RAW');
  const kind = source.outputKind.split('_')[0];
  if (isResult ? source.objectKind !== 'RESULT'
    : source.outputKind === 'ERRORS' ? source.objectKind !== 'DIAGNOSTIC'
      : source.objectKind !== 'DATASET' || manifest.catalog.kind !== kind) fail('BIZOP_EXPORT_KIND_MISMATCH');
  const resultContract = isResult ? resultContractFor(manifest.catalog) : null;
  if (resultContract && resultContract.columnSchemaVersion !== source.columnSchemaVersion) fail('BIZOP_EXPORT_CONTRACT_MISMATCH');
  if (source.objectKind !== 'DIAGNOSTIC' && manifest.catalog.cellContractVersion !== CELL_CONTRACT_VERSION) fail('BIZOP_EXPORT_CONTRACT_MISMATCH');
  spool.note({ record_type: 'RUN_META', field_key: 'export', value_type: 'JSON',
    value_part: JSON.stringify({ ownerId: source.objectId, outputKind: source.outputKind, manifestDigest: source.manifestDigest,
      outputName: outputName(source.outputKind, source.metadata), metadata: source.metadata, sourceCatalog: manifest.catalog }) });
  if (isResult) {
    const start = manifest.catalog.inputs.find((item) => item.role === 'START_OP');
    const end = manifest.catalog.inputs.find((item) => item.role === 'END_OP');
    if (!start || !end || start.inputVersion !== source.metadata.startInputVersion
        || end.inputVersion !== source.metadata.endInputVersion || start.dataDate !== source.metadata.startDate
        || end.dataDate !== source.metadata.endDate) fail('BIZOP_EXPORT_INPUT_METADATA_MISSING');
    spool.note({ record_type: 'RUN_META', field_key: '源表对比', value_type: 'TEXT',
      value_part: `${outputName('OP_CHECK', { dataDate: start.dataDate, version: start.inputVersion })} VS ${outputName('OP_CHECK', { dataDate: end.dataDate, version: end.inputVersion })}` });
  }
  const append = (values, metadata) => {
    const cells = values.map((value, index) => cell(value, schema.columns[index].domain,
      (decimal, reason) => spool.precision(index, decimal, reason, metadata)));
    spool.data(cells, metadata);
  };
  if (isRaw) {
    if (!Array.isArray(source.originals) || !source.originals.length) fail('BIZOP_EXPORT_ORIGINALS_MISSING');
    const expectedSources = manifest.catalog.sources;
    if (hash(source.originals.map(({ artifactId, sha256, order, sheetName, bu, rowCount }) =>
      ({ artifactId, sha256, order, sheetName, bu, rowCount }))) !== hash(expectedSources)) fail('BIZOP_EXPORT_ORIGINALS_CHANGED');
    for (const original of source.originals) {
      safePoint();
      await verifyOriginal(original, safePoint);
      const before = await fs.promises.stat(original.filePath);
      // 读取器拥有并递归删除 SST 目录；每份原件只交付独立子目录的所有权。
      const workbook = await openSingleSheetRichWorkbook(original.filePath, { sstTempRoot: path.join(tempDirectory, `sst-raw-${randomUUID()}`),
        memoryBudgetBytes: 32 * 1024 * 1024, cacheMaxBytes: 32 * 1024 * 1024, cancelToken });
      let selected = 0; const adapter = createImportAdapter(kind);
      try {
        if (workbook.sheet.name !== original.sheetName) fail('BIZOP_EXPORT_ORIGINAL_CHANGED');
        await workbook.scan((row) => {
          safePoint();
          if (row.rowIndex === 1) { if (detectHeader(row) !== kind) fail('BIZOP_EXPORT_KIND_MISMATCH'); return; }
          const adapted = adapter.adapt(row);
          if (adapted.blank) return;
          if (adapted.errors.length) fail('BIZOP_EXPORT_ORIGINAL_CHANGED');
          if (adapted.dataDate !== manifest.catalog.dataDate) return;
          const metadata = { source_artifact_id: original.artifactId, source_dataset_id: source.objectId,
            source_date: manifest.catalog.dataDate, source_version: source.metadata.version, source_sheet: row.sourceSheet,
            source_row: row.rowIndex, key_bu: adapted.key[0], key_account: adapted.key[1], key_currency: adapted.key[2] };
          const byColumn = new Map(row.cells.map((value) => [value.columnIndex, value]));
          spool.data(adapted.originalValues.map((value, index) => rawCell(byColumn.get(index), value, kind, index,
            (decimal, reason) => spool.precision(index, decimal, reason, metadata))), metadata);
          selected += 1;
        });
      } finally { await workbook.close(); }
      const after = await fs.promises.stat(original.filePath);
      if (selected !== original.rowCount || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key])) fail('BIZOP_EXPORT_ORIGINAL_CHANGED');
      spool.note({ record_type: 'INPUT_VERSION', source_artifact_id: original.artifactId,
        source_dataset_id: source.objectId, source_date: manifest.catalog.dataDate, source_version: source.metadata.version,
        field_key: 'original', value_type: 'JSON', value_part: JSON.stringify({ sha256: original.sha256, name: original.originalName,
          sheet: original.sheetName, rowCount: original.rowCount }) });
    }
  } else if (source.outputKind === 'ERRORS') {
    if (manifest.parts.length !== 1) fail('BIZOP_REPORT_SCHEMA_INVALID');
    const stream = fs.createReadStream(payloadStore.resolve(path.posix.join(path.posix.dirname(source.manifestRelativePath), manifest.parts[0].name)));
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        safePoint();
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) fail('BIZOP_REPORT_SCHEMA_INVALID');
        const item = JSON.parse(line);
        append([item.type, item.artifactId ?? null, item.fileOrder ?? null, item.sheetName ?? null, item.rowIndex ?? null,
          item.code ?? null, item.message || item.errors?.join('；') || ''], {});
      }
    } finally { lines.close(); stream.destroy(); if (!stream.closed) await new Promise((resolve) => stream.once('close', resolve)); }
  } else {
    let seen = 0; let notesSeen = 0;
    for (const part of manifest.parts) {
      safePoint();
      const db = openReadonly(payloadStore.resolve(path.posix.join(path.posix.dirname(source.manifestRelativePath), part.name)));
      try {
        const meta = db.prepare('SELECT * FROM part_meta').get();
        if (meta.owner_id !== source.objectId || meta.state !== 'SEALED' || meta.row_count !== part.rowCount
            || resultContract && meta.rule_version !== resultContract.computeRuleVersion) fail('BIZOP_EXPORT_PART_INVALID');
        const notes = isResult && part.partKind === 'NOTES';
        const table = notes ? 'explanation_records' : isResult ? 'result_rows' : kind === 'OP' ? 'op_check_rows' : 'flow_check_rows';
        let n = 0;
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${notes ? 'note_ordinal' : 'row_ordinal'}`).iterate()) {
          if (n % 1024 === 0) await yieldMessages();
          safePoint(); n += 1;
          if (notes) {
            if (row.note_ordinal !== ++notesSeen) fail('BIZOP_EXPORT_ROW_ORDER');
            spool.note(Object.fromEntries(NOTE_COLUMNS.map((key) => [key, row[key]])), true);
          } else {
            if (row.row_ordinal !== ++seen) fail('BIZOP_EXPORT_ROW_ORDER');
            if (source.outputKind === 'RESULT_DIFF' && row.is_difference !== 1) continue;
            const fields = isResult ? RESULT_COLUMNS : kind === 'OP' ? OP_COLUMNS : FLOW_COLUMNS;
            const values = fields.map((name) => row[name]);
            if (source.outputKind === 'RESULT_DIFF' && typeof values[18] === 'string') {
              values[18] = values[18].replace(/；详见核对说明:(\d+)$/u, '；完整说明见导出原表，定位:$1');
            }
            append(values, { result_row_ordinal: isResult ? row.row_ordinal : null,
              key_bu: row.key_bu, key_account: row.key_account, key_currency: row.key_currency,
              source_dataset_id: isResult ? null : source.objectId, source_artifact_id: row.source_artifact_id ?? null,
              source_sheet: row.source_sheet ?? null, source_row: row.source_row ?? null });
          }
        }
        if (n !== part.rowCount) fail('BIZOP_EXPORT_ROW_COUNT');
      } finally { db.close(); }
    }
    if (seen !== manifest.rowCount || isResult && notesSeen !== manifest.catalog.noteRowCount) fail('BIZOP_EXPORT_ROW_COUNT');
  }
  const expectedCount = source.outputKind === 'RESULT_DIFF' ? manifest.catalog.diffRowCount : manifest.rowCount;
  if (spool.counts.DATA !== expectedCount) fail('BIZOP_EXPORT_ROW_COUNT');
  return manifest;
}
module.exports = { buildExportSource };
