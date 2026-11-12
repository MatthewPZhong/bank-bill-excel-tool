'use strict';

// v3.2.17 通道明细预检补录的血缘重建：从存档原件读回的行先按补录记录还原为导入时的取值，
// 再交给 assertMappedLineage 比对内容哈希。原件存档不改，补录记录见 vcc_fin_op_channel_corrections。
const { SOURCE_TYPES, getSourceDefinition } = require('./definitions');

function correctionsTableExists(db) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vcc_fin_op_channel_corrections'
  `).get());
}

function rowKey(sheetName, sourceRow) {
  return `${sheetName}\u0000${Number(sourceRow)}`;
}

// 返回 Map：`${sheet}\0${row}` → { field: { original, corrected } }。
function loadChannelCorrectionIndex(db, importSourceId) {
  const index = new Map();
  if (!importSourceId || !correctionsTableExists(db)) return index;
  for (const row of db.prepare(`
    SELECT sheet_name, source_row, field_name, original_value, corrected_value
    FROM vcc_fin_op_channel_corrections
    WHERE import_source_id = ?
    ORDER BY id
  `).iterate(Number(importSourceId))) {
    const key = rowKey(row.sheet_name, row.source_row);
    if (!index.has(key)) index.set(key, {});
    index.get(key)[row.field_name] = Object.freeze({
      original: String(row.original_value),
      corrected: String(row.corrected_value)
    });
  }
  return index;
}

function channelCorrectionsFor(index, sheetName, sourceRow) {
  return index.get(rowKey(sheetName, sourceRow)) || null;
}

// values 为内置列序。原件中的值必须等于补录原值（存档原件）或已等于补录新值（导入时保存的 fallback），
// 否则视为血缘不一致，由调用方按完整性故障处理。
function applyChannelCorrections(values, corrections, onMismatch) {
  if (!corrections) return values;
  const definition = getSourceDefinition(SOURCE_TYPES.CHANNEL);
  const next = [...values];
  for (const [field, { original, corrected }] of Object.entries(corrections)) {
    const index = definition.indexes[field];
    if (index === undefined) {
      onMismatch(field);
      continue;
    }
    const current = String(values[index] == null ? '' : values[index]);
    if (current === corrected) continue;
    if (current !== original) {
      onMismatch(field);
      continue;
    }
    next[index] = corrected;
  }
  return next;
}

module.exports = {
  loadChannelCorrectionIndex,
  channelCorrectionsFor,
  applyChannelCorrections
};
