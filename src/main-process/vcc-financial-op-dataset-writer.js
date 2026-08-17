'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  normalizeLegacyStoredCurrency,
  SYSTEM_OP_HEADERS,
  SYSTEM_OP_DEFINITION,
  getSourceDefinition,
  headersEqual
} = require('../backend/vcc-financial-op/definitions');
const { canonicalizeVccAmount } = require('../backend/vcc-financial-op/amount-rules');
const {
  mapDetailRow,
  normalizeYearMonth,
  pendingCanonicalValues
} = require('../backend/vcc-financial-op/row-mapper');
const { streamDetailRows } = require('../backend/vcc-financial-op/workbook-reader');
const { hashSourceFile } = require('../backend/vcc-financial-op/source-lineage');
const {
  readSystemOpSnapshots
} = require('../backend/vcc-financial-op/system-op-importer');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const MAX_DATA_ROWS_PER_SHEET = 1048575;
const WORKBOOK_ABORT_TIMEOUT_MS = 2000;
const EXPORT_KINDS = Object.freeze({ RAW: 'raw', CHECK: 'check' });
const ALLOWED_SOURCE_TYPES = new Set(Object.values(SOURCE_TYPES));

const CHECK_EXPORT_DEFINITIONS = Object.freeze({
  [SOURCE_TYPES.RECHARGE]: Object.freeze({
    label: 'VCC充值清退明细_校验表',
    sourceHeaders: Object.freeze([
      '订单号', 'BillDate', '业务部门', '对手部门', '业务子类型',
      '出入方向', '公司主体', '我方币种', '我方到账金额'
    ]),
    derivedHeaders: Object.freeze(['发生额'])
  }),
  [SOURCE_TYPES.FEE_FX]: Object.freeze({
    label: 'VCC费用及换汇明细_校验表',
    sourceHeaders: Object.freeze([
      '订单号', 'BillDate', '业务部门', '业务子类型', '出入方向',
      '公司主体', '我方币种', '我方到账金额'
    ]),
    derivedHeaders: Object.freeze(['发生额'])
  }),
  [SOURCE_TYPES.CHANNEL]: Object.freeze({
    label: 'VCC通道明细_校验表',
    sourceHeaders: Object.freeze([
      '渠道订单号', '账单日期', '部门', '通道名称', 'MID', '交易金额',
      '交易币种', '清算金额', '清算币种', '借贷方向', 'billdate',
      '结算币种', '实际到账金额'
    ]),
    derivedHeaders: Object.freeze(['公司主体', '统计币种', '发生额'])
  }),
  [SOURCE_TYPES.PENDING]: Object.freeze({
    label: '移除归档Pending账单_校验表',
    sourceHeaders: Object.freeze([
      'PendingBizId', '主体', '对账类型', 'channel', '金额', '币种',
      '流水_币种', '流水_对账金额'
    ]),
    derivedHeaders: Object.freeze(['Pending发生额', '流水_发生额', '是否错币'])
  }),
  [SOURCE_TYPES.SYSTEM_OP]: Object.freeze({
    label: SOURCE_LABELS[SOURCE_TYPES.SYSTEM_OP],
    sourceHeaders: SYSTEM_OP_HEADERS,
    derivedHeaders: Object.freeze([])
  })
});

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDatasetExportScope(targetMonth, sourceType, targetKind) {
  const month = normalizeYearMonth(targetMonth);
  if (!month) throw exportError('invalid-month', `月份账期格式无效：${targetMonth || ''}`);
  const type = String(sourceType || '').trim();
  if (!ALLOWED_SOURCE_TYPES.has(type)) {
    throw exportError('invalid-source-type', `不支持导出的目标表：${sourceType || ''}`);
  }
  const kind = String(targetKind || '').trim();
  if (!Object.values(EXPORT_KINDS).includes(kind)) {
    throw exportError('invalid-target-kind', `不支持的导出表类型：${targetKind || ''}`);
  }
  const tableName = kind === EXPORT_KINDS.RAW
    ? SOURCE_LABELS[type]
    : CHECK_EXPORT_DEFINITIONS[type].label;
  return { targetMonth: month, sourceType: type, targetKind: kind, tableName };
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function detailRawValues(row) {
  const definition = getSourceDefinition(row.source_type);
  const values = parseJson(row.raw_json, null);
  let normalizedValues = values;
  if (definition && Array.isArray(values) && row.source_type === SOURCE_TYPES.PENDING) {
    try {
      normalizedValues = pendingCanonicalValues(values, row.raw_contract_version);
    } catch (_error) {
      normalizedValues = null;
    }
  }
  if (!definition || !Array.isArray(normalizedValues) || normalizedValues.length !== definition.headers.length) {
    throw exportError(
      'invalid-export-lineage',
      `${SOURCE_LABELS[row.source_type] || row.source_type}有效行 ${row.id} 的原始字段血缘不完整，无法导出`
    );
  }
  return normalizedValues.map((value) => value == null ? '' : String(value));
}

function selectedValues(sourceType, values, headers) {
  const definition = getSourceDefinition(sourceType);
  return headers.map((header) => values[definition.indexes[header]] ?? '');
}

function detailCheckValues(row, rawValues) {
  const definition = CHECK_EXPORT_DEFINITIONS[row.source_type];
  const sourceValues = selectedValues(row.source_type, rawValues, definition.sourceHeaders);
  const required = (value, field) => {
    if (value === null || value === undefined || value === '') {
      throw exportError(
        'invalid-export-lineage',
        `${definition.label}有效行 ${row.id} 缺少已生效字段“${field}”，无法导出`
      );
    }
    return value;
  };
  if (row.source_type === SOURCE_TYPES.CHANNEL) {
    return [
      ...sourceValues,
      required(row.subject, '公司主体'),
      required(normalizeLegacyStoredCurrency(row.stat_currency), '统计币种'),
      required(row.signed_amount, '发生额')
    ];
  }
  if (row.source_type === SOURCE_TYPES.PENDING) {
    const mismatchValue = required(row.currency_mismatch, '是否错币');
    let currencyMismatch;
    if (mismatchValue === true || mismatchValue === 1 || mismatchValue === '1') {
      currencyMismatch = true;
    } else if (mismatchValue === false || mismatchValue === 0 || mismatchValue === '0') {
      currencyMismatch = false;
    } else {
      throw exportError(
        'invalid-export-lineage',
        `${definition.label}有效行 ${row.id} 的已生效字段“是否错币”不是 0/1，无法导出`
      );
    }
    return [
      ...sourceValues,
      required(row.pending_amount, 'Pending发生额'),
      required(row.flow_amount, '流水_发生额'),
      currencyMismatch
    ];
  }
  required(row.subject, '公司主体');
  required(row.stat_currency, '统计币种');
  return [...sourceValues, required(row.signed_amount, '发生额')];
}

function topLevelJsonObjectKeys(json) {
  const keys = [];
  let objectDepth = 0;
  let arrayDepth = 0;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (char === '"') {
      const tokenStart = index;
      let escaped = false;
      for (index += 1; index < json.length; index += 1) {
        const stringChar = json[index];
        if (escaped) {
          escaped = false;
        } else if (stringChar === '\\') {
          escaped = true;
        } else if (stringChar === '"') {
          break;
        }
      }
      if (objectDepth === 1 && arrayDepth === 0) {
        let next = index + 1;
        while (/\s/.test(json[next] || '')) next += 1;
        if (json[next] === ':') keys.push(JSON.parse(json.slice(tokenStart, index + 1)));
      }
      continue;
    }
    if (char === '{') objectDepth += 1;
    else if (char === '}') objectDepth -= 1;
    else if (char === '[') arrayDepth += 1;
    else if (char === ']') arrayDepth -= 1;
  }
  return keys;
}

function invalidSystemLineage(snapshot, detail) {
  return exportError(
    'invalid-export-lineage',
    `系统财务OP主体 ${snapshot.subject || snapshot.id} ${detail}，无法导出`
  );
}

function systemCanonicalBalances(snapshot) {
  if (typeof snapshot.balances_json !== 'string' || snapshot.balances_json.trim() === '') {
    throw invalidSystemLineage(snapshot, '缺少九币种 canonical 余额血缘');
  }
  let parsed;
  try {
    parsed = JSON.parse(snapshot.balances_json);
  } catch (_error) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidSystemLineage(snapshot, '的九币种 canonical 余额不是有效对象');
  }

  let serializedKeys;
  try {
    serializedKeys = topLevelJsonObjectKeys(snapshot.balances_json);
  } catch (_error) {
    throw invalidSystemLineage(snapshot, '的九币种 canonical 余额键无法解析');
  }
  const seenKeys = new Set();
  const duplicateKeys = serializedKeys.filter((key) => {
    if (seenKeys.has(key)) return true;
    seenKeys.add(key);
    return false;
  });
  if (duplicateKeys.length > 0) {
    throw invalidSystemLineage(
      snapshot,
      `的九币种 canonical 余额存在重复币种：${[...new Set(duplicateKeys)].join('、')}`
    );
  }

  const balanceKeys = Object.keys(parsed);
  const missingCurrencies = SUPPORTED_CURRENCIES.filter((currency) => !Object.hasOwn(parsed, currency));
  const unexpectedCurrencies = balanceKeys.filter((currency) => !SUPPORTED_CURRENCIES.includes(currency));
  if (
    balanceKeys.length !== SUPPORTED_CURRENCIES.length
    || missingCurrencies.length > 0
    || unexpectedCurrencies.length > 0
  ) {
    const details = [];
    if (missingCurrencies.length > 0) details.push(`缺少 ${missingCurrencies.join('、')}`);
    if (unexpectedCurrencies.length > 0) details.push(`未知 ${unexpectedCurrencies.join('、')}`);
    throw invalidSystemLineage(
      snapshot,
      `的九币种 canonical 余额币种集合不完整${details.length > 0 ? `：${details.join('；')}` : ''}`
    );
  }

  const canonicalBalances = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    try {
      canonicalBalances[currency] = canonicalizeVccAmount(
        parsed[currency],
        `系统财务OP ${snapshot.subject || snapshot.id} ${currency} 财务余额`
      );
    } catch (_error) {
      throw invalidSystemLineage(snapshot, `的 ${currency} canonical 财务余额非法`);
    }
  }
  return canonicalBalances;
}

function systemSnapshotRows(snapshot) {
  const payload = parseJson(snapshot.raw_json, null);
  if (
    !payload
    || !headersEqual(payload.displayHeaders, SYSTEM_OP_HEADERS)
    || !Array.isArray(payload.rows)
    || payload.rows.length !== SUPPORTED_CURRENCIES.length
  ) {
    throw exportError(
      'invalid-export-lineage',
      `系统财务OP主体 ${snapshot.subject || snapshot.id} 的 16 列原始行血缘不完整，无法导出`
    );
  }
  const canonicalBalances = systemCanonicalBalances(snapshot);
  const balanceIndex = SYSTEM_OP_DEFINITION.indexes[SYSTEM_OP_DEFINITION.balanceHeader];
  const normalizedCurrencies = new Set();
  const rows = payload.rows.map((row) => {
    if (!row || !Array.isArray(row.displayValues) || row.displayValues.length !== SYSTEM_OP_HEADERS.length) {
      throw exportError(
        'invalid-export-lineage',
        `系统财务OP主体 ${snapshot.subject || snapshot.id} 存在字段不完整的原始行，无法导出`
      );
    }
    const currency = normalizeLegacyStoredCurrency(row.normalizedCurrency);
    if (!SUPPORTED_CURRENCIES.includes(currency) || normalizedCurrencies.has(currency)) {
      throw exportError(
        'invalid-export-lineage',
        `系统财务OP主体 ${snapshot.subject || snapshot.id} 的九币种血缘不完整或重复，无法导出`
      );
    }
    normalizedCurrencies.add(currency);
    const canonicalBalance = canonicalBalances[currency];
    if (row.balanceEvidence !== null && row.balanceEvidence !== undefined) {
      if (typeof row.balanceEvidence !== 'object' || Array.isArray(row.balanceEvidence)) {
        throw invalidSystemLineage(snapshot, `的 ${currency} 余额读取证据无效`);
      }
      if (Object.hasOwn(row.balanceEvidence, 'canonicalValue')) {
        let evidenceCanonical;
        try {
          evidenceCanonical = canonicalizeVccAmount(
            row.balanceEvidence.canonicalValue,
            `系统财务OP ${snapshot.subject || snapshot.id} ${currency} 读取证据`
          );
        } catch (_error) {
          throw invalidSystemLineage(snapshot, `的 ${currency} 余额读取证据非法`);
        }
        if (evidenceCanonical !== canonicalBalance) {
          throw invalidSystemLineage(snapshot, `的 ${currency} 余额读取证据与 canonical 余额不一致`);
        }
      }
    }
    const values = row.displayValues.map((value) => value == null ? '' : String(value));
    values[balanceIndex] = canonicalBalance;
    return values;
  });
  if (SUPPORTED_CURRENCIES.some((currency) => !normalizedCurrencies.has(currency))) {
    throw exportError(
      'invalid-export-lineage',
      `系统财务OP主体 ${snapshot.subject || snapshot.id} 的九币种血缘不完整或重复，无法导出`
    );
  }
  return rows;
}

function exportHeaders(scope) {
  if (scope.sourceType === SOURCE_TYPES.SYSTEM_OP) return [...SYSTEM_OP_HEADERS];
  if (scope.targetKind === EXPORT_KINDS.RAW) {
    return [...getSourceDefinition(scope.sourceType).headers];
  }
  const definition = CHECK_EXPORT_DEFINITIONS[scope.sourceType];
  return [...definition.sourceHeaders, ...definition.derivedHeaders];
}

function tableHasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((row) => row.name === columnName);
}

function *iterateLegacyDatasetRows(db, scope) {
  if (scope.sourceType === SOURCE_TYPES.SYSTEM_OP) {
    const sourceFilter = tableHasColumn(db, 'vcc_fin_op_system_snapshots', 'import_source_id')
      ? 'AND import_source_id IS NULL'
      : '';
    const snapshots = db.prepare(`
      SELECT id, subject, balances_json, raw_json
      FROM vcc_fin_op_system_snapshots
      WHERE target_month = ?
        ${sourceFilter}
      ORDER BY id
    `).iterate(scope.targetMonth);
    for (const snapshot of snapshots) {
      for (const values of systemSnapshotRows(snapshot)) yield values;
    }
    return;
  }

  if (!tableHasColumn(db, 'vcc_fin_op_effective_rows', 'raw_json')) return;
  const sourceFilter = tableHasColumn(db, 'vcc_fin_op_effective_rows', 'import_source_id')
    ? 'AND import_source_id IS NULL'
    : '';
  const rows = db.prepare(`
    SELECT id, source_type, raw_json, raw_contract_version,
           subject, stat_currency, signed_amount,
           pending_amount, flow_amount, currency_mismatch
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ? AND source_type = ?
      ${sourceFilter}
    ORDER BY id
  `).iterate(scope.targetMonth, scope.sourceType);
  for (const row of rows) {
    const rawValues = detailRawValues(row);
    yield scope.targetKind === EXPORT_KINDS.RAW
      ? rawValues
      : detailCheckValues(row, rawValues);
  }
}

function countDatasetRows(db, scope) {
  if (scope.sourceType !== SOURCE_TYPES.SYSTEM_OP) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    `).get(scope.targetMonth, scope.sourceType).row_count) || 0;
  }
  return (Number(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
  `).get(scope.targetMonth).row_count) || 0) * SUPPORTED_CURRENCIES.length;
}

function detailLineageInspection(db, scope) {
  const totalRows = countDatasetRows(db, scope);
  const hasSourceId = tableHasColumn(db, 'vcc_fin_op_effective_rows', 'import_source_id');
  const hasRawJson = tableHasColumn(db, 'vcc_fin_op_effective_rows', 'raw_json');
  if (!hasSourceId) {
    return {
      totalRows,
      exportableRows: hasRawJson ? totalRows : 0,
      missingRows: hasRawJson ? 0 : totalRows,
      missingByImportRecord: [],
      integrityFailureRows: 0,
      integrityFailureSourceIds: []
    };
  }
  const legacyExportable = hasRawJson ? 'e.import_source_id IS NULL' : '0';
  const boundReady = `
    s.id IS NOT NULL
    AND s.archive_state = 'ready'
    AND s.archive_artifact_id IS NOT NULL
  `;
  const retryableFallback = `
    s.id IS NOT NULL
    AND s.archive_artifact_id IS NULL
    AND s.bound_at IS NULL
    AND s.archive_state <> 'ready'
    AND f.effective_row_id IS NOT NULL
  `;
  const integrityFailure = `
    (e.import_source_id IS NOT NULL AND s.id IS NULL)
    OR (
      s.id IS NOT NULL
      AND (s.archive_artifact_id IS NOT NULL OR s.bound_at IS NOT NULL OR s.archive_state = 'ready')
      AND NOT (${boundReady})
    )
  `;
  const exportable = `(${legacyExportable}) OR (${boundReady}) OR (${retryableFallback})`;
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COALESCE(SUM(CASE WHEN ${exportable} THEN 1 ELSE 0 END), 0) AS exportable_rows,
      COALESCE(SUM(CASE WHEN ${integrityFailure} THEN 1 ELSE 0 END), 0)
        AS integrity_failure_rows
    FROM vcc_fin_op_effective_rows e
    LEFT JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    LEFT JOIN vcc_fin_op_effective_raw_fallback f ON f.effective_row_id = e.id
    WHERE e.target_month = ? AND e.source_type = ?
  `).get(scope.targetMonth, scope.sourceType);
  const exportableRows = Number(counts.exportable_rows) || 0;
  const integrityFailures = db.prepare(`
    SELECT COALESCE(s.id, e.import_source_id) AS source_id, COUNT(*) AS row_count
    FROM vcc_fin_op_effective_rows e
    LEFT JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    LEFT JOIN vcc_fin_op_effective_raw_fallback f ON f.effective_row_id = e.id
    WHERE e.target_month = ? AND e.source_type = ?
      AND (${integrityFailure})
    GROUP BY COALESCE(s.id, e.import_source_id)
    ORDER BY COALESCE(s.id, e.import_source_id)
  `).all(scope.targetMonth, scope.sourceType);
  const integrityFailureRows = Number(counts.integrity_failure_rows) || 0;
  const missingByImportRecord = db.prepare(`
    SELECT e.import_record_id AS import_record_id, COUNT(*) AS missing_rows
    FROM vcc_fin_op_effective_rows e
    LEFT JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    LEFT JOIN vcc_fin_op_effective_raw_fallback f ON f.effective_row_id = e.id
    WHERE e.target_month = ? AND e.source_type = ?
      AND NOT (${exportable})
      AND NOT (${integrityFailure})
    GROUP BY e.import_record_id
    ORDER BY e.import_record_id
  `).all(scope.targetMonth, scope.sourceType).map((row) => ({
    importRecordId: Number(row.import_record_id),
    missingRows: Number(row.missing_rows) || 0
  }));
  return {
    totalRows,
    exportableRows,
    missingRows: Math.max(0, totalRows - exportableRows - integrityFailureRows),
    missingByImportRecord,
    integrityFailureRows,
    integrityFailureSourceIds: integrityFailures.map((row) => Number(row.source_id))
  };
}

function systemLineageInspection(db, scope) {
  const hasSourceId = tableHasColumn(db, 'vcc_fin_op_system_snapshots', 'import_source_id');
  if (!hasSourceId) {
    let totalRows = 0;
    for (const values of iterateLegacyDatasetRows(db, scope)) {
      if (values) totalRows += 1;
    }
    return {
      totalRows,
      exportableRows: totalRows,
      missingRows: 0,
      missingByImportRecord: [],
      integrityFailureRows: 0,
      integrityFailureSourceIds: []
    };
  }
  let legacyRows = 0;
  for (const values of iterateLegacyDatasetRows(db, scope)) {
    if (values) legacyRows += 1;
  }
  const boundReady = `
    s.id IS NOT NULL
    AND s.archive_state = 'ready'
    AND s.archive_artifact_id IS NOT NULL
  `;
  const retryableFallback = `
    s.id IS NOT NULL
    AND s.archive_artifact_id IS NULL
    AND s.bound_at IS NULL
    AND s.archive_state <> 'ready'
  `;
  const integrityFailure = `
    (snapshot.import_source_id IS NOT NULL AND s.id IS NULL)
    OR (
      s.id IS NOT NULL
      AND (s.archive_artifact_id IS NOT NULL OR s.bound_at IS NOT NULL OR s.archive_state = 'ready')
      AND NOT (${boundReady})
    )
  `;
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS snapshot_count,
      COALESCE(SUM(CASE WHEN (${boundReady}) OR (${retryableFallback}) THEN 1 ELSE 0 END), 0)
        AS exportable_snapshot_count,
      COALESCE(SUM(CASE WHEN ${integrityFailure} THEN 1 ELSE 0 END), 0)
        AS integrity_snapshot_count
    FROM vcc_fin_op_system_snapshots AS snapshot
    LEFT JOIN vcc_fin_op_import_sources AS s ON s.id = snapshot.import_source_id
    WHERE snapshot.target_month = ?
  `).get(scope.targetMonth);
  const totalRows = (Number(counts.snapshot_count) || 0) * SUPPORTED_CURRENCIES.length;
  const sourceExportableRows = (Number(counts.exportable_snapshot_count) || 0)
    * SUPPORTED_CURRENCIES.length;
  const integrityFailureRows = (Number(counts.integrity_snapshot_count) || 0)
    * SUPPORTED_CURRENCIES.length;
  const exportableRows = legacyRows + sourceExportableRows;
  const missingByImportRecord = db.prepare(`
    SELECT snapshot.import_record_id AS import_record_id, COUNT(*) AS missing_snapshots
    FROM vcc_fin_op_system_snapshots AS snapshot
    LEFT JOIN vcc_fin_op_import_sources AS s ON s.id = snapshot.import_source_id
    WHERE snapshot.target_month = ?
      AND snapshot.import_source_id IS NOT NULL
      AND NOT ((${boundReady}) OR (${retryableFallback}))
      AND NOT (${integrityFailure})
    GROUP BY snapshot.import_record_id
    ORDER BY snapshot.import_record_id
  `).all(scope.targetMonth).map((row) => ({
    importRecordId: Number(row.import_record_id),
    missingRows: (Number(row.missing_snapshots) || 0) * SUPPORTED_CURRENCIES.length
  }));
  const integrityFailures = db.prepare(`
    SELECT COALESCE(s.id, snapshot.import_source_id) AS source_id
    FROM vcc_fin_op_system_snapshots AS snapshot
    LEFT JOIN vcc_fin_op_import_sources AS s ON s.id = snapshot.import_source_id
    WHERE snapshot.target_month = ? AND (${integrityFailure})
    GROUP BY COALESCE(s.id, snapshot.import_source_id)
    ORDER BY COALESCE(s.id, snapshot.import_source_id)
  `).all(scope.targetMonth);
  return {
    totalRows,
    exportableRows,
    missingRows: Math.max(0, totalRows - exportableRows - integrityFailureRows),
    missingByImportRecord,
    integrityFailureRows,
    integrityFailureSourceIds: integrityFailures.map((row) => Number(row.source_id))
  };
}

function inspectDatasetExport(db, targetMonth, sourceType, targetKind, { taskActive = false } = {}) {
  const scope = normalizeDatasetExportScope(targetMonth, sourceType, targetKind);
  const activeBatch = db.prepare(`
    SELECT id FROM vcc_fin_op_import_batches
    WHERE status = 'importing'
    ORDER BY started_at, id
    LIMIT 1
  `).get() || null;
  const lineage = scope.sourceType === SOURCE_TYPES.SYSTEM_OP
    ? systemLineageInspection(db, scope)
    : detailLineageInspection(db, scope);
  let code = '';
  let message = '';
  if (taskActive || activeBatch) {
    code = 'active-task';
    message = '当前仍有 VCC 财务OP任务或原表导入进行中，禁止导出';
  } else if (lineage.integrityFailureRows > 0) {
    code = 'archive-integrity-failure';
    message = `已有 ${lineage.integrityFailureRows} 行绑定的输入 artifact 完整性异常，禁止降级为部分导出`;
  } else if (lineage.totalRows === 0) {
    code = 'no-data';
    message = '当前选择没有可导出的有效数据';
  }
  return {
    ...scope,
    dataCount: lineage.totalRows,
    totalRows: lineage.totalRows,
    exportableRows: lineage.exportableRows,
    missingRows: lineage.missingRows,
    incomplete: lineage.integrityFailureRows === 0 && lineage.missingRows > 0,
    missingByImportRecord: lineage.missingByImportRecord,
    exportable: !code,
    code,
    message
  };
}

function exportInspectionEvidence(inspection = {}) {
  const missingByImportRecord = Array.isArray(inspection.missingByImportRecord)
    ? inspection.missingByImportRecord.map((entry) => ({
        importRecordId: Number(entry.importRecordId),
        missingRows: Number(entry.missingRows) || 0
      }))
    : [];
  return Object.freeze({
    targetMonth: String(inspection.targetMonth || ''),
    sourceType: String(inspection.sourceType || ''),
    targetKind: String(inspection.targetKind || ''),
    totalRows: Number(inspection.totalRows) || 0,
    exportableRows: Number(inspection.exportableRows) || 0,
    missingRows: Number(inspection.missingRows) || 0,
    incomplete: inspection.incomplete === true,
    missingByImportRecord: Object.freeze(missingByImportRecord)
  });
}

function assertExportInspectionEvidence(inspection, expectedInspection) {
  if (!expectedInspection) return;
  const actual = exportInspectionEvidence(inspection);
  const expected = exportInspectionEvidence(expectedInspection);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  throw exportError(
    'export-preview-state-changed',
    '导出确认后有效数据或原表血缘覆盖范围已变化，请重新预览并确认'
  );
}

function detailRowValuesFromRaw(expected, rawValues, scope) {
  return scope.targetKind === EXPORT_KINDS.RAW
    ? rawValues
    : detailCheckValues(expected, rawValues);
}

function assertMappedLineage(expected, mapped) {
  if (mapped.disposition
      || mapped.idempotencyKey !== expected.idempotency_key
      || mapped.contentHash !== expected.content_hash
      || Number(mapped.hashVersion) !== Number(expected.hash_version)) {
    throw exportError(
      'archive-row-integrity-failure',
      `导入记录 ${expected.import_record_id} 原表第 ${expected.source_row} 行与当前有效数据的幂等键或内容哈希不一致`
    );
  }
}

function mapStoredRaw(expected, rawJson) {
  const rawValues = parseJson(rawJson, null);
  if (!Array.isArray(rawValues)) {
    throw exportError('invalid-export-lineage', `有效行 ${expected.id} 的临时原始值无效`);
  }
  const mapped = mapDetailRow({
    sourceType: expected.source_type,
    values: rawValues,
    targetMonth: expected.target_month,
    assignedSubject: expected.subject,
    sourceFile: expected.source_file_name || '',
    sheetName: expected.sheet_name,
    sourceRow: expected.source_row
  });
  assertMappedLineage(expected, mapped);
  return mapped.values;
}

async function emitReconstructedDetailRows(db, scope, archiveSources, emit) {
  for (const values of iterateLegacyDatasetRows(db, scope)) emit(values);

  // fallback 只服务尚未成功存档的新导入；ready 来源始终强制走 artifact，
  // 不允许用残留 fallback 掩盖已绑定文件的完整性故障。
  const fallbackRows = db.prepare(`
    SELECT e.*, s.source_file_name, f.raw_json AS fallback_raw_json
    FROM vcc_fin_op_effective_rows e
    LEFT JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    JOIN vcc_fin_op_effective_raw_fallback f ON f.effective_row_id = e.id
    WHERE e.target_month = ? AND e.source_type = ?
      AND e.import_source_id IS NOT NULL
      AND s.archive_artifact_id IS NULL
      AND s.bound_at IS NULL
      AND s.archive_state <> 'ready'
    ORDER BY e.id
  `).iterate(scope.targetMonth, scope.sourceType);
  for (const expected of fallbackRows) {
    const rawValues = mapStoredRaw(expected, expected.fallback_raw_json);
    emit(detailRowValuesFromRaw(expected, rawValues, scope));
  }

  const sourceById = new Map((archiveSources || []).map((source) => [Number(source.sourceId), source]));
  const sourceGroups = db.prepare(`
    SELECT e.import_source_id AS source_id, COUNT(*) AS row_count
    FROM vcc_fin_op_effective_rows e
    JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    WHERE e.target_month = ? AND e.source_type = ?
      AND s.archive_state = 'ready' AND s.archive_artifact_id IS NOT NULL
    GROUP BY e.import_source_id
    ORDER BY e.import_source_id
  `).all(scope.targetMonth, scope.sourceType);
  const coordinateRowsSql = `
    SELECT e.*, s.source_file_name
    FROM vcc_fin_op_effective_rows e
    JOIN vcc_fin_op_import_sources s ON s.id = e.import_source_id
    WHERE e.import_source_id = ? AND e.target_month = ? AND e.source_type = ?
      AND e.sheet_name = ?
    ORDER BY e.source_row, e.id
  `;

  for (const group of sourceGroups) {
    const sourceId = Number(group.source_id);
    const expectedCount = Number(group.row_count) || 0;
    const source = sourceById.get(sourceId);
    if (!source) {
      throw exportError('archive-lineage-unavailable', `导入来源 ${sourceId} 缺少已核验的存档文件`);
    }
    const actual = await hashSourceFile(source.filePath);
    if (actual.sha256 !== String(source.sha256).toLowerCase()
        || actual.sizeBytes !== Number(source.sizeBytes)) {
      throw exportError('archive-integrity-failure', `导入来源 ${sourceId} 的存档文件 SHA-256 或大小不一致`);
    }
    const duplicateCoordinate = db.prepare(`
      SELECT sheet_name, source_row, COUNT(*) AS row_count
      FROM vcc_fin_op_effective_rows
      WHERE import_source_id = ? AND target_month = ? AND source_type = ?
      GROUP BY sheet_name, source_row
      HAVING COUNT(*) <> 1
      LIMIT 1
    `).get(sourceId, scope.targetMonth, scope.sourceType);
    if (duplicateCoordinate) {
      throw exportError(
        'archive-row-integrity-failure',
        `导入来源 ${sourceId} 的 ${duplicateCoordinate.sheet_name} 第 ${duplicateCoordinate.source_row} 行存在重复有效血缘`
      );
    }
    const expectedSheets = db.prepare(`
      SELECT sheet_name, COUNT(*) AS row_count
      FROM vcc_fin_op_effective_rows
      WHERE import_source_id = ? AND target_month = ? AND source_type = ?
      GROUP BY sheet_name
      ORDER BY sheet_name
    `).all(sourceId, scope.targetMonth, scope.sourceType);
    const cursors = new Map(expectedSheets.map((sheet) => {
      const statement = db.prepare(coordinateRowsSql);
      const iterator = statement.iterate(
        sourceId,
        scope.targetMonth,
        scope.sourceType,
        sheet.sheet_name
      );
      return [sheet.sheet_name, {
        statement,
        iterator,
        next: iterator.next(),
        expectedCount: Number(sheet.row_count) || 0,
        seenCount: 0
      }];
    }));
    let seenCount = 0;
    await streamDetailRows(source.filePath, scope.sourceType, {
      onDataRow: (input) => {
        const cursor = cursors.get(input.sheetName);
        if (!cursor || cursor.next.done) return;
        const expected = cursor.next.value;
        if (Number(input.rowR) < Number(expected.source_row)) return;
        if (Number(input.rowR) > Number(expected.source_row)) {
          throw exportError(
            'archive-row-integrity-failure',
            `导入来源 ${sourceId} 缺少 ${input.sheetName} 第 ${expected.source_row} 行`
          );
        }
        const mapped = mapDetailRow({
          sourceType: scope.sourceType,
          values: input.values,
          targetMonth: scope.targetMonth,
          assignedSubject: expected.subject,
          sourceFile: input.sourceFile,
          sheetName: input.sheetName,
          sourceRow: input.rowR,
          keyCellType: input.keyCellType
        });
        assertMappedLineage(expected, mapped);
        emit(detailRowValuesFromRaw(expected, mapped.values, scope));
        cursor.seenCount += 1;
        seenCount += 1;
        cursor.next = cursor.iterator.next();
      }
    });
    const incompleteCursor = [...cursors.values()].find((cursor) => (
      !cursor.next.done || cursor.seenCount !== cursor.expectedCount
    ));
    if (incompleteCursor || seenCount !== expectedCount) {
      throw exportError(
        'archive-row-integrity-failure',
        `导入来源 ${sourceId} 缺少 ${Math.max(0, expectedCount - seenCount)} 条当前有效行的原表位置`
      );
    }
  }
}

async function emitReconstructedSystemRows(db, scope, archiveSources, emit) {
  for (const values of iterateLegacyDatasetRows(db, scope)) emit(values);

  // 新导入在 artifact 尚未成功绑定时，system snapshot.raw_json 是其临时原表
  // fallback。只要曾绑定过 artifact，就仍按完整性故障失败关闭，不能回退到 raw。
  const fallbackSnapshots = db.prepare(`
    SELECT snapshot.id, snapshot.subject, snapshot.balances_json, snapshot.raw_json
    FROM vcc_fin_op_system_snapshots AS snapshot
    JOIN vcc_fin_op_import_sources AS source ON source.id = snapshot.import_source_id
    WHERE snapshot.target_month = ?
      AND source.archive_artifact_id IS NULL
      AND source.bound_at IS NULL
      AND source.archive_state <> 'ready'
    ORDER BY snapshot.id
  `).iterate(scope.targetMonth);
  for (const snapshot of fallbackSnapshots) {
    for (const values of systemSnapshotRows(snapshot)) emit(values);
  }

  const sourceById = new Map((archiveSources || []).map((source) => [
    Number(source.sourceId),
    source
  ]));
  const sourceIds = db.prepare(`
    SELECT snapshot.import_source_id AS source_id
    FROM vcc_fin_op_system_snapshots AS snapshot
    JOIN vcc_fin_op_import_sources AS source ON source.id = snapshot.import_source_id
    WHERE snapshot.target_month = ?
      AND source.archive_state = 'ready'
      AND source.archive_artifact_id IS NOT NULL
    GROUP BY snapshot.import_source_id
    ORDER BY snapshot.import_source_id
  `).all(scope.targetMonth).map((row) => Number(row.source_id));

  for (const sourceId of sourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) {
      throw exportError('archive-lineage-unavailable', `系统财务OP导入来源 ${sourceId} 缺少已核验存档文件`);
    }
    const actualHash = await hashSourceFile(source.filePath);
    if (actualHash.sha256 !== String(source.sha256 || '').toLowerCase()
        || actualHash.sizeBytes !== Number(source.sizeBytes)) {
      throw exportError(
        'archive-integrity-failure',
        `系统财务OP导入来源 ${sourceId} 的存档文件 SHA-256 或大小不一致`
      );
    }
    let actualSnapshots;
    try {
      actualSnapshots = readSystemOpSnapshots(source.filePath, scope.targetMonth);
    } catch (cause) {
      const error = exportError(
        'archive-row-integrity-failure',
        `系统财务OP导入来源 ${sourceId} 无法按原导入合同重读`
      );
      error.cause = cause;
      throw error;
    }
    const actualBySubject = new Map();
    for (const snapshot of actualSnapshots) {
      if (actualBySubject.has(snapshot.subject)) {
        throw exportError(
          'archive-row-integrity-failure',
          `系统财务OP导入来源 ${sourceId} 的主体 ${snapshot.subject} 重复`
        );
      }
      actualBySubject.set(snapshot.subject, snapshot);
    }
    const expectedSnapshots = db.prepare(`
      SELECT id, subject, content_hash, source_file, sheet_name, source_row
      FROM vcc_fin_op_system_snapshots
      WHERE target_month = ? AND import_source_id = ?
      ORDER BY id
    `).all(scope.targetMonth, sourceId);
    for (const expected of expectedSnapshots) {
      const actual = actualBySubject.get(expected.subject);
      if (!actual
          || actual.contentHash !== expected.content_hash
          || actual.sheetName !== expected.sheet_name
          || Number(actual.sourceRow) !== Number(expected.source_row)) {
        throw exportError(
          'archive-row-integrity-failure',
          `系统财务OP导入来源 ${sourceId} 的主体 ${expected.subject} 与当前有效快照血缘不一致`
        );
      }
      for (const values of systemSnapshotRows({
        id: expected.id,
        subject: actual.subject,
        balances_json: actual.balancesJson,
        raw_json: actual.rawJson
      })) emit(values);
    }
  }
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5EA8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

function worksheetName(baseName, index) {
  const suffix = index > 1 ? `-${index}` : '';
  const safeBase = String(baseName || '导出数据').replace(/[\\/?*:[\]]/g, '_');
  return `${safeBase.slice(0, 31 - suffix.length)}${suffix}`;
}

function createWorksheet(workbook, scope, headers, index) {
  const sheet = workbook.addWorksheet(worksheetName(scope.tableName, index), {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.columns = headers.map((header) => ({
    width: Math.max(10, Math.min(30, String(header).length * 2 + 2))
  }));
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  headerRow.commit();
  return sheet;
}

function createIncompleteExplanationSheet(workbook, inspection) {
  const sheet = workbook.addWorksheet('导出说明');
  sheet.columns = [{ width: 28 }, { width: 60 }];
  const header = sheet.addRow(['项目', '说明']);
  styleHeader(header);
  header.commit();
  sheet.addRow(['导出状态', '不完整（历史血缘缺口）']).commit();
  sheet.addRow(['有效总行数', inspection.totalRows]).commit();
  sheet.addRow(['可导出行数', inspection.exportableRows]).commit();
  sheet.addRow(['缺失行数', inspection.missingRows]).commit();
  sheet.addRow(['覆盖率', `${((inspection.exportableRows / inspection.totalRows) * 100).toFixed(2)}%`]).commit();
  for (const missing of inspection.missingByImportRecord || []) {
    sheet.addRow([
      `导入记录 ${missing.importRecordId}`,
      `缺少 ${missing.missingRows} 行可核验原表血缘`
    ]).commit();
  }
  sheet.commit();
}

async function abortWorkbook(workbook) {
  if (!workbook) return;
  try {
    if (workbook.zip && typeof workbook.zip.abort === 'function') workbook.zip.abort();
  } catch (_error) { /* best effort */ }
  const stream = workbook.stream;
  if (!stream || stream.closed || typeof stream.destroy !== 'function') return;
  await new Promise((resolve) => {
    let settled = false;
    let timeout;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.off('close', done);
      stream.off('finish', done);
      stream.off('error', done);
      resolve();
    };
    stream.once('close', done);
    stream.once('finish', done);
    stream.once('error', done);
    timeout = setTimeout(done, WORKBOOK_ABORT_TIMEOUT_MS);
    stream.destroy();
    if (stream.closed) done();
  });
}

async function writeDatasetWorkbook({
  db,
  targetMonth,
  sourceType,
  targetKind,
  outputPath,
  archiveSources = [],
  expectedInspection = null,
  onProgress,
  maxDataRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  const safeSheetLimit = Number(maxDataRowsPerSheet);
  if (!Number.isInteger(safeSheetLimit) || safeSheetLimit < 1 || safeSheetLimit > MAX_DATA_ROWS_PER_SHEET) {
    throw new RangeError(`单 sheet 数据行上限必须为 1-${MAX_DATA_ROWS_PER_SHEET}`);
  }

  let transactionOpen = false;
  db.exec('BEGIN');
  transactionOpen = true;
  try {
    const inspection = inspectDatasetExport(db, targetMonth, sourceType, targetKind);
    if (!inspection.exportable) throw exportError(inspection.code, inspection.message);
    assertExportInspectionEvidence(inspection, expectedInspection);
    const headers = exportHeaders(inspection);
    let writtenRows = 0;
    let sheetCount = inspection.incomplete
      ? (inspection.exportableRows > 0 ? 2 : 1)
      : 1;

    const publishedPath = await writeXlsxAtomically({
      outputPath,
      writeStaged: async (stagedPath) => {
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: stagedPath,
          useStyles: true,
          useSharedStrings: false
        });
        try {
          if (inspection.incomplete) createIncompleteExplanationSheet(workbook, inspection);
          let dataSheetIndex = 1;
          let sheet = inspection.exportableRows > 0
            ? createWorksheet(workbook, inspection, headers, dataSheetIndex)
            : null;
          let rowsInSheet = 0;
          const writeValues = (values) => {
            if (!sheet) {
              throw exportError('export-count-mismatch', '零覆盖导出不得写入伪造数据行');
            }
            if (rowsInSheet >= safeSheetLimit) {
              sheet.commit();
              dataSheetIndex += 1;
              sheetCount += 1;
              rowsInSheet = 0;
              sheet = createWorksheet(workbook, inspection, headers, dataSheetIndex);
            }
            sheet.addRow(values).commit();
            rowsInSheet += 1;
            writtenRows += 1;
            if (writtenRows % 50000 === 0 && typeof onProgress === 'function') {
              onProgress({ processedRows: writtenRows, totalRows: inspection.exportableRows });
            }
          };
          if (inspection.exportableRows > 0) {
            if (inspection.sourceType === SOURCE_TYPES.SYSTEM_OP) {
              await emitReconstructedSystemRows(db, inspection, archiveSources, writeValues);
            } else {
              await emitReconstructedDetailRows(db, inspection, archiveSources, writeValues);
            }
            sheet.commit();
          }
          if (writtenRows !== inspection.exportableRows) {
            throw exportError('export-count-mismatch', '导出行数与可导出血缘统计不一致，未生成文件');
          }
          await workbook.commit();
        } catch (error) {
          await abortWorkbook(workbook);
          throw error;
        }
      },
      beforePublish: async () => {
        db.exec('COMMIT');
        transactionOpen = false;
      }
    });
    return {
      targetMonth: inspection.targetMonth,
      sourceType: inspection.sourceType,
      targetKind: inspection.targetKind,
      tableName: inspection.tableName,
      dataCount: writtenRows,
      totalRows: inspection.totalRows,
      exportableRows: writtenRows,
      missingRows: inspection.missingRows,
      incomplete: inspection.incomplete,
      sheetCount,
      filePath: path.resolve(publishedPath)
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    }
    throw error;
  }
}

module.exports = {
  MAX_DATA_ROWS_PER_SHEET,
  EXPORT_KINDS,
  CHECK_EXPORT_DEFINITIONS,
  normalizeDatasetExportScope,
  inspectDatasetExport,
  exportInspectionEvidence,
  writeDatasetWorkbook
};
