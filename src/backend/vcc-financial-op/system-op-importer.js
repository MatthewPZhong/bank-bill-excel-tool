'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const XLSX = require('xlsx');
const { canonicalizeVccAmount } = require('./amount-rules');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  SYSTEM_OP_DEFINITION,
  detectDetailSourceType,
  headersEqual,
  normalizeHeaderRow
} = require('./definitions');
const { normalizeYearMonth, monthOfDate } = require('./row-mapper');
const {
  PREVIEW_MEANINGFUL_ROWS,
  systemHeaderCandidate,
  systemHeaderMismatchDetails
} = require('./workbook-reader');
const repository = require('../vcc-financial-op-db/repository');

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSystemCurrency(value) {
  const currency = text(value);
  return currency === 'CNY' ? 'CNH' : currency;
}

function displayAmountToken(displayValue, rawValue) {
  const display = text(displayValue);
  if (display === '') return rawValue === '' ? '' : rawValue;
  if (/^-+$/.test(display)) return '0';
  const accounting = display.match(/^\((.+)\)$/);
  return accounting ? `-${accounting[1]}` : display;
}

function rawNumericToken(rawValue) {
  if (typeof rawValue !== 'number') return null;
  if (!Number.isFinite(rawValue) || Math.abs(rawValue) > Number.MAX_SAFE_INTEGER) {
    const error = new Error(`Excel raw 数值超出安全范围：${rawValue}`);
    error.code = 'amount-precision-invalid';
    throw error;
  }
  return Object.is(rawValue, -0) ? '0' : String(rawValue);
}

function systemAmountRead(displayValue, rawValue, context = {}) {
  const rawToken = rawNumericToken(rawValue);
  const source = rawToken === null ? 'display-text' : 'raw-numeric';
  const token = rawToken === null ? displayAmountToken(displayValue, rawValue) : rawToken;
  const canonicalValue = canonicalizeVccAmount(token, context.label || '系统财务OP财务余额');
  const evidence = {
    field: context.field || SYSTEM_OP_DEFINITION.balanceHeader,
    cell: context.cell || '',
    source,
    rawValue,
    displayValue: displayValue == null ? '' : String(displayValue),
    canonicalValue
  };
  if (source === 'raw-numeric') {
    try {
      const displayToken = displayAmountToken(displayValue, '');
      if (displayToken !== '') {
        const displayCanonical = canonicalizeVccAmount(displayToken, '系统财务OP财务余额显示值');
        if (displayCanonical !== canonicalValue) {
          evidence.auditCode = 'amount-display-raw-mismatch';
          evidence.displayCanonicalValue = displayCanonical;
        }
      }
    } catch (_error) {
      evidence.auditCode = 'amount-display-raw-mismatch';
      evidence.displayCanonicalValue = null;
    }
  }
  return { token, canonicalValue, evidence };
}

function systemAmountToken(displayValue, rawValue) {
  const rawToken = rawNumericToken(rawValue);
  return rawToken === null ? displayAmountToken(displayValue, rawValue) : rawToken;
}

function findSystemHeader(matrix) {
  const matches = [];
  let meaningfulRows = 0;
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const row = normalizeHeaderRow(matrix[rowIndex]);
    if (!row.some((value) => text(value) !== '')) continue;
    meaningfulRows += 1;
    if (headersEqual(row, SYSTEM_OP_HEADERS)) matches.push({ rowIndex, values: row });
    if (meaningfulRows >= PREVIEW_MEANINGFUL_ROWS) break;
  }
  if (matches.length > 1) throw new Error('系统财务OP检测到多行正式模板表头，拒绝只读取其中一处');
  if (matches.length === 1) return matches[0];
  throw new Error(
    '系统财务OP未找到正式 16 列模板表头；请使用 assets/VCC财务OP校验/系统财务OP.xlsx'
  );
}

function meaningfulPreview(matrix) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const values = normalizeHeaderRow(matrix[rowIndex]);
    if (values.some((value) => text(value) !== '')) {
      rows.push({ rowR: rowIndex + 1, values });
    }
    if (rows.length >= PREVIEW_MEANINGFUL_ROWS) break;
  }
  return rows;
}

function assertUniqueSystemBusinessSheet(workbook, sourceFile, preferredSheetName) {
  const recognized = [];
  const previews = [];
  for (const sheetName of workbook.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: ''
    });
    const rows = meaningfulPreview(matrix);
    previews.push({ sheetName, rows });
    const detail = rows.find((row) => detectDetailSourceType(row.values));
    if (detail) recognized.push({ sheetName, sourceType: detectDetailSourceType(detail.values) });
    for (const row of rows.filter((entry) => headersEqual(entry.values, SYSTEM_OP_HEADERS))) {
      recognized.push({
        sheetName,
        sourceType: SOURCE_TYPES.SYSTEM_OP,
        headerRow: row.rowR
      });
    }
  }
  if (recognized.length > 1) {
    throw new Error(
      `${sourceFile}：正式导入时检测到多个可识别业务表：${recognized.map((item) => `${item.sheetName}（${item.sourceType}）`).join('、')}`
    );
  }
  if (recognized.length === 1) {
    const match = recognized[0];
    if (match.sourceType !== SOURCE_TYPES.SYSTEM_OP) {
      throw new Error(`${sourceFile}：正式导入文件不是系统财务OP`);
    }
    if (preferredSheetName && match.sheetName !== preferredSheetName) {
      throw new Error(`${sourceFile}：系统财务OP sheet 与识别结果不一致`);
    }
    return match;
  }
  const malformed = previews
    .map((preview) => ({
      sheetName: preview.sheetName,
      candidate: systemHeaderCandidate(preview.rows)
    }))
    .filter((entry) => entry.candidate)
    .sort((left, right) => (
      right.candidate.uniqueOverlap - left.candidate.uniqueOverlap
      || right.candidate.positionMatches - left.candidate.positionMatches
    ))[0];
  if (malformed) {
    const error = new Error(`${sourceFile}：系统财务OP表头与正式模板不一致`);
    error.detailLines = [
      `${malformed.sheetName}：第 ${malformed.candidate.rowR} 行`,
      ...systemHeaderMismatchDetails(malformed.candidate)
    ];
    throw error;
  }
  const error = new Error(`${sourceFile}：未找到系统财务OP正式 16 列模板表头`);
  error.detailLines = [
    '请使用 assets/VCC财务OP校验/系统财务OP.xlsx，并保留完整表头及原顺序',
    '旧 YYMMOP 横表不再支持'
  ];
  throw error;
}

function systemRowError(message, { sourceRow, fieldName, sheetName } = {}) {
  const error = new Error(message);
  error.sourceRow = sourceRow || null;
  error.fieldName = fieldName || '';
  error.sheetName = sheetName || '';
  return error;
}

function rowField(values, header) {
  return (values || [])[SYSTEM_OP_DEFINITION.indexes[header]];
}

function buildSubjectSnapshot({
  subject,
  rows,
  normalizedMonth,
  sourceFile,
  sheetName,
  headerRow
}) {
  const byCurrency = new Map();
  for (const row of rows) {
    const existing = byCurrency.get(row.currency);
    if (existing) {
      throw systemRowError(
        `${sheetName} 第 ${row.sourceRow} 行：主体 ${subject} 的币种 ${row.currency} 与第 ${existing.sourceRow} 行重复`,
        { sourceRow: row.sourceRow, fieldName: SYSTEM_OP_DEFINITION.currencyHeader, sheetName }
      );
    }
    byCurrency.set(row.currency, row);
  }
  const missingCurrencies = SUPPORTED_CURRENCIES.filter((currency) => !byCurrency.has(currency));
  if (missingCurrencies.length > 0) {
    throw systemRowError(
      `${sourceFile}：主体 ${subject} 在 ${normalizedMonth} 缺少系统财务OP币种：${missingCurrencies.join('、')}`,
      {
        sourceRow: rows.length > 0 ? Math.min(...rows.map((row) => row.sourceRow)) : null,
        fieldName: SYSTEM_OP_DEFINITION.currencyHeader,
        sheetName
      }
    );
  }

  const balances = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
    currency,
    byCurrency.get(currency).balance
  ]));
  const rawPayload = {
    displayHeaders: SYSTEM_OP_HEADERS,
    headerRow,
    rows: rows.map((row) => ({
      sourceRow: row.sourceRow,
      sourceCurrency: row.sourceCurrency,
      normalizedCurrency: row.currency,
      displayValues: row.displayValues,
      rawValues: row.rawValues,
      balanceEvidence: row.balanceEvidence
    }))
  };
  const balancesJson = JSON.stringify(balances);
  const rawJson = JSON.stringify(rawPayload);
  const contentHash = crypto.createHash('sha256')
    .update(JSON.stringify({ targetMonth: normalizedMonth, subject, balances }), 'utf8')
    .digest('hex');
  return {
    targetMonth: normalizedMonth,
    subject,
    balances,
    balancesJson,
    contentHash,
    sourceFile,
    sheetName,
    sourceRow: Math.min(...rows.map((row) => row.sourceRow)),
    rawJson
  };
}

function buildCompleteSnapshots(context, { ignoreErrors = false } = {}) {
  const snapshots = [];
  const errors = [];
  for (const [subject, rows] of context.rowsBySubject) {
    try {
      snapshots.push(buildSubjectSnapshot({ ...context, subject, rows }));
    } catch (error) {
      errors.push(error);
    }
  }
  if (!ignoreErrors && errors.length > 0) {
    const error = errors[0];
    error.parsedSnapshots = snapshots;
    throw error;
  }
  return snapshots;
}

function readSystemOpSnapshots(filePath, targetMonth, preferredSheetName = '') {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`系统财务OP账期格式无效：${targetMonth}`);

  const sourceFile = path.basename(filePath);
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellDates: false });
  if (workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904) {
    throw new Error(`${sourceFile}：系统财务OP暂不支持 1904 日期系统，请改为 1900 日期系统后重新导入`);
  }
  const match = assertUniqueSystemBusinessSheet(workbook, sourceFile, preferredSheetName);
  const sheetName = match.sheetName;
  const sheet = workbook.Sheets[sheetName];
  const displayMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const rawMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const header = findSystemHeader(displayMatrix);
  if (header.rowIndex + 1 !== match.headerRow) {
    throw new Error(`${sourceFile}：系统财务OP表头位置与识别结果不一致`);
  }

  const rowsBySubject = new Map();
  const snapshotContext = {
    rowsBySubject,
    normalizedMonth,
    sourceFile,
    sheetName,
    headerRow: header.rowIndex + 1
  };
  try {
    for (let rowIndex = header.rowIndex + 1; rowIndex < displayMatrix.length; rowIndex++) {
      const displaySourceRow = Array.isArray(displayMatrix[rowIndex]) ? displayMatrix[rowIndex] : [];
      const rawSourceRow = Array.isArray(rawMatrix[rowIndex]) ? rawMatrix[rowIndex] : [];
      if (![...displaySourceRow, ...rawSourceRow].some((value) => text(value) !== '')) continue;
      const sourceRow = rowIndex + 1;
      const extraColumn = Math.max(displaySourceRow.length, rawSourceRow.length) > SYSTEM_OP_HEADERS.length
        ? Array.from({ length: Math.max(displaySourceRow.length, rawSourceRow.length) - SYSTEM_OP_HEADERS.length })
          .findIndex((_unused, offset) => (
            text(displaySourceRow[SYSTEM_OP_HEADERS.length + offset]) !== ''
            || text(rawSourceRow[SYSTEM_OP_HEADERS.length + offset]) !== ''
          ))
        : -1;
      if (extraColumn >= 0) {
        const columnNumber = SYSTEM_OP_HEADERS.length + extraColumn + 1;
        throw systemRowError(
          `${sheetName} 第 ${sourceRow} 行存在模板外的第 ${columnNumber} 列数据`,
          { sourceRow, fieldName: `第${columnNumber}列`, sheetName }
        );
      }

      const displayValues = SYSTEM_OP_HEADERS.map((_headerName, index) => (
        displaySourceRow[index] == null ? '' : displaySourceRow[index]
      ));
      const rawValues = SYSTEM_OP_HEADERS.map((_headerName, index) => (
        rawSourceRow[index] == null ? '' : rawSourceRow[index]
      ));
      const displayDate = rowField(displayValues, SYSTEM_OP_DEFINITION.monthHeader);
      const rawDate = rowField(rawValues, SYSTEM_OP_DEFINITION.monthHeader);
      const rowMonth = monthOfDate(displayDate) || monthOfDate(rawDate);
      if (!rowMonth) {
        throw systemRowError(
          `${sheetName} 第 ${sourceRow} 行“账单日期”无法解析为有效日期`,
          { sourceRow, fieldName: SYSTEM_OP_DEFINITION.monthHeader, sheetName }
        );
      }
      if (rowMonth !== normalizedMonth) continue;

      const subject = text(rowField(displayValues, SYSTEM_OP_DEFINITION.subjectHeader));
      if (!subject) {
        throw systemRowError(
          `${sheetName} 第 ${sourceRow} 行“主体”不能为空`,
          { sourceRow, fieldName: SYSTEM_OP_DEFINITION.subjectHeader, sheetName }
        );
      }
      const department = text(rowField(displayValues, SYSTEM_OP_DEFINITION.departmentHeader));
      if (department !== 'VCC') {
        throw systemRowError(
          `${sheetName} 第 ${sourceRow} 行“业务部门”必须为 VCC，实际为“${department || '空'}”`,
          { sourceRow, fieldName: SYSTEM_OP_DEFINITION.departmentHeader, sheetName }
        );
      }
      const sourceCurrency = text(rowField(displayValues, SYSTEM_OP_DEFINITION.currencyHeader));
      const currency = normalizeSystemCurrency(sourceCurrency);
      if (!SUPPORTED_CURRENCIES.includes(currency)) {
        throw systemRowError(
          `${sheetName} 第 ${sourceRow} 行“币种”仅允许 AUD、CAD、CNY/CNH、EUR、GBP、HKD、JPY、SGD、USD，实际为“${sourceCurrency || '空'}”`,
          { sourceRow, fieldName: SYSTEM_OP_DEFINITION.currencyHeader, sheetName }
        );
      }
      const displayBalance = rowField(displayValues, SYSTEM_OP_DEFINITION.balanceHeader);
      const rawBalance = rowField(rawValues, SYSTEM_OP_DEFINITION.balanceHeader);
      let balance;
      let balanceEvidence;
      try {
        const reading = systemAmountRead(displayBalance, rawBalance, {
          label: `系统财务OP ${subject} ${sourceCurrency} 财务余额`,
          field: SYSTEM_OP_DEFINITION.balanceHeader,
          cell: XLSX.utils.encode_cell({
            r: rowIndex,
            c: SYSTEM_OP_DEFINITION.indexes[SYSTEM_OP_DEFINITION.balanceHeader]
          })
        });
        balance = reading.canonicalValue;
        balanceEvidence = reading.evidence;
      } catch (error) {
        const wrapped = systemRowError(
          `${sheetName} 第 ${sourceRow} 行“财务余额”无效：${error.message}`,
          { sourceRow, fieldName: SYSTEM_OP_DEFINITION.balanceHeader, sheetName }
        );
        wrapped.code = error.code || 'amount-precision-invalid';
        throw wrapped;
      }

      if (!rowsBySubject.has(subject)) rowsBySubject.set(subject, []);
      rowsBySubject.get(subject).push({
        sourceRow,
        sourceCurrency,
        currency,
        balance,
        balanceEvidence,
        displayValues,
        rawValues
      });
    }
  } catch (error) {
    error.parsedSnapshots = buildCompleteSnapshots(snapshotContext, { ignoreErrors: true });
    throw error;
  }

  if (rowsBySubject.size === 0) {
    throw new Error(`${sourceFile}：未找到“账单日期”属于 ${normalizedMonth} 的系统财务OP数据`);
  }

  return buildCompleteSnapshots(snapshotContext);
}

function readSystemOpSnapshot(filePath, targetMonth, subject = '', preferredSheetName = '') {
  const snapshots = readSystemOpSnapshots(filePath, targetMonth, preferredSheetName);
  const requestedSubject = text(subject);
  if (requestedSubject) {
    const match = snapshots.find((snapshot) => snapshot.subject === requestedSubject);
    if (match) return match;
  }
  if (snapshots.length === 1) return snapshots[0];
  throw new Error(`${path.basename(filePath)}：包含多个主体，请使用系统财务OP多快照读取接口`);
}

function insertAttempt(db, recordId, snapshot, disposition, existingSnapshotId, message) {
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, existing_snapshot_id, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordId,
    snapshot.targetMonth,
    snapshot.subject,
    snapshot.balancesJson,
    snapshot.contentHash,
    snapshot.sourceFile,
    snapshot.sheetName,
    snapshot.sourceRow,
    snapshot.rawJson,
    disposition,
    existingSnapshotId || null,
    message || null
  );
  return Number(result.lastInsertRowid);
}

function importSystemOpGroup({ db, batchId, targetMonth, files, recordId: preparedRecordId }) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`系统财务OP账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('系统财务OP至少需要一个文件');
  const recordId = preparedRecordId || repository.createImportRecord(db, {
    batchId,
    targetMonth: normalizedMonth,
    sourceType: SOURCE_TYPES.SYSTEM_OP,
    sourceFiles: files.map((file) => path.basename(file.filePath))
  });

  const snapshots = [];
  const validationErrors = [];
  for (const file of files) {
    try {
      snapshots.push(...readSystemOpSnapshots(
        file.filePath,
        normalizedMonth,
        file.sheetName
      ));
    } catch (error) {
      if (Array.isArray(error.parsedSnapshots)) snapshots.push(...error.parsedSnapshots);
      validationErrors.push({ file, error });
    }
  }
  if (validationErrors.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const message = validationErrors.map(({ file, error }) => (
        `${path.basename(file.filePath)}：${error.message}`
      )).join('；');
      for (const snapshot of snapshots) {
        insertAttempt(
          db,
          recordId,
          snapshot,
          'rolled_back',
          null,
          '同批存在格式错误，已解析快照未写入有效数据'
        );
      }
      for (const { file, error } of validationErrors) {
        repository.addImportError(db, recordId, {
          errorCode: error.code || 'system-op-validation-error',
          message: error.message,
          sourceFile: path.basename(file.filePath),
          sheetName: error.sheetName || file.sheetName || '',
          sourceRow: error.sourceRow,
          fieldName: error.fieldName
        });
      }
      repository.finishImportRecord(db, recordId, {
        status: 'failed_validation',
        rawCount: snapshots.length + validationErrors.length,
        formatErrorCount: validationErrors.length,
        rolledBackCount: snapshots.length,
        errorMessage: message
      });
      db.exec('COMMIT');
      return repository.getImportRecord(db, recordId);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
      throw error;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const bySubject = new Map();
    for (const snapshot of snapshots) {
      if (!bySubject.has(snapshot.subject)) bySubject.set(snapshot.subject, []);
      bySubject.get(snapshot.subject).push(snapshot);
    }

    let hasConflict = false;
    const classified = [];
    for (const [subject, subjectSnapshots] of bySubject) {
      const existing = db.prepare(`
        SELECT * FROM vcc_fin_op_system_snapshots WHERE target_month = ? AND subject = ?
      `).get(normalizedMonth, subject);
      const hashes = new Set(subjectSnapshots.map((snapshot) => snapshot.contentHash));
      if (existing) {
        for (const snapshot of subjectSnapshots) {
          if (snapshot.contentHash === existing.content_hash) {
            classified.push({ snapshot, disposition: 'idempotent_skip', existing });
          } else {
            hasConflict = true;
            classified.push({ snapshot, disposition: 'idempotent_conflict', existing });
          }
        }
        continue;
      }
      if (hashes.size > 1) {
        hasConflict = true;
        for (const snapshot of subjectSnapshots) {
          classified.push({ snapshot, disposition: 'idempotent_conflict', existing });
        }
        continue;
      }
      classified.push({ snapshot: subjectSnapshots[0], disposition: 'accepted', existing: null });
      for (const snapshot of subjectSnapshots.slice(1)) {
        classified.push({ snapshot, disposition: 'idempotent_skip', existing: null, duplicateInBatch: true });
      }
    }

    const datasetArchived = Boolean(db.prepare(`
      SELECT 1
      FROM vcc_fin_op_archives
      WHERE target_month = ?
      UNION ALL
      SELECT 1
      FROM vcc_fin_op_datasets
      WHERE target_month = ? AND dataset_type = ? AND data_status = 'archived'
      LIMIT 1
    `).get(normalizedMonth, normalizedMonth, SOURCE_TYPES.SYSTEM_OP));
    if (datasetArchived && classified.some((item) => item.disposition === 'accepted')) {
      hasConflict = true;
      for (const item of classified) {
        if (item.disposition === 'accepted') item.disposition = 'rolled_back';
      }
    }

    if (hasConflict) {
      let conflictCount = 0;
      let rolledBackCount = 0;
      let skippedCount = 0;
      const insertedAttempts = [];
      for (const item of classified) {
        const disposition = item.disposition === 'idempotent_conflict'
          ? 'idempotent_conflict'
          : (item.disposition === 'idempotent_skip' ? 'idempotent_skip' : 'rolled_back');
        if (disposition === 'idempotent_conflict') conflictCount += 1;
        else if (disposition === 'idempotent_skip') skippedCount += 1;
        else rolledBackCount += 1;
        const attemptId = insertAttempt(
          db,
          recordId,
          item.snapshot,
          disposition,
          item.existing && item.existing.id,
          disposition === 'idempotent_conflict'
            ? '同一账期和主体的系统财务OP余额不一致'
            : (disposition === 'idempotent_skip'
              ? '同账期同主体同内容，幂等跳过'
              : '同批存在冲突或该账期已归档，未写入快照')
        );
        insertedAttempts.push({ attemptId, item, disposition });
      }
      const linkComparison = db.prepare(`
        UPDATE vcc_fin_op_system_snapshot_attempts
        SET comparison_attempt_id = ?
        WHERE id = ?
      `);
      for (const current of insertedAttempts) {
        if (current.disposition !== 'idempotent_conflict' || current.item.existing) continue;
        const peer = insertedAttempts.find((candidate) => (
          candidate.attemptId !== current.attemptId
          && candidate.item.snapshot.subject === current.item.snapshot.subject
          && candidate.item.snapshot.contentHash !== current.item.snapshot.contentHash
        ));
        if (peer) linkComparison.run(peer.attemptId, current.attemptId);
      }
      const message = datasetArchived
        ? `${normalizedMonth} 系统财务OP已归档，禁止新增快照`
        : '同一账期和主体的系统财务OP余额不一致，整批未导入';
      repository.finishImportRecord(db, recordId, {
        status: datasetArchived ? 'failed_validation' : 'failed_conflict',
        rawCount: snapshots.length,
        conflictCount,
        skippedCount,
        rolledBackCount,
        errorMessage: message
      });
      repository.addImportError(db, recordId, {
        errorCode: datasetArchived ? 'dataset-archived' : 'system-op-conflict',
        message
      });
      db.exec('COMMIT');
      return repository.getImportRecord(db, recordId);
    }

    let insertedCount = 0;
    let skippedCount = 0;
    for (const item of classified) {
      if (item.disposition === 'accepted') {
        const result = db.prepare(`
          INSERT INTO vcc_fin_op_system_snapshots (
            target_month, subject, balances_json, content_hash,
            source_file, sheet_name, source_row, raw_json, import_record_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.snapshot.targetMonth,
          item.snapshot.subject,
          item.snapshot.balancesJson,
          item.snapshot.contentHash,
          item.snapshot.sourceFile,
          item.snapshot.sheetName,
          item.snapshot.sourceRow,
          item.snapshot.rawJson,
          recordId
        );
        item.insertedId = Number(result.lastInsertRowid);
        insertAttempt(
          db,
          recordId,
          item.snapshot,
          'accepted',
          item.insertedId,
          '首次成功导入系统财务OP快照'
        );
        insertedCount += 1;
      } else {
        skippedCount += 1;
      }
    }
    for (const item of classified.filter((entry) => entry.disposition === 'idempotent_skip')) {
      const accepted = classified.find((entry) => (
        entry.snapshot.subject === item.snapshot.subject && entry.disposition === 'accepted'
      ));
      insertAttempt(
        db,
        recordId,
        item.snapshot,
        'idempotent_skip',
        item.existing ? item.existing.id : (accepted && accepted.insertedId),
        '同账期同主体同内容，幂等跳过'
      );
    }

    const status = insertedCount === 0
      ? 'all_skipped'
      : (skippedCount > 0 ? 'success_with_skips' : 'success');
    repository.finishImportRecord(db, recordId, {
      status,
      rawCount: snapshots.length,
      insertedCount,
      skippedCount
    });
    if (insertedCount > 0) {
      db.prepare(`
        INSERT INTO vcc_fin_op_datasets (
          target_month, dataset_type, data_status, generated_at
        ) VALUES (
          ?, ?, 'unprocessed',
          COALESCE(
            (SELECT finished_at FROM vcc_fin_op_import_records WHERE id = ?),
            datetime('now', 'localtime')
          )
        )
        ON CONFLICT(target_month, dataset_type) DO UPDATE SET
          data_status = 'unprocessed', archived_run_id = NULL,
          revision = vcc_fin_op_datasets.revision + 1,
          generated_at = excluded.generated_at,
          updated_at = datetime('now', 'localtime')
      `).run(normalizedMonth, SOURCE_TYPES.SYSTEM_OP, recordId);
    }
    db.exec('COMMIT');
    return repository.getImportRecord(db, recordId);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function systemRecordResult(record) {
  return {
    recordId: record.id,
    batchId: record.batch_id,
    targetMonth: record.target_month,
    sourceType: record.source_type,
    sourceLabel: SOURCE_LABELS[record.source_type],
    status: record.status,
    rawCount: Number(record.raw_count) || 0,
    insertedCount: Number(record.inserted_count) || 0,
    skippedCount: Number(record.skipped_count) || 0,
    invalidKeyCount: Number(record.invalid_key_count) || 0,
    conflictCount: Number(record.conflict_count) || 0,
    formatErrorCount: Number(record.format_error_count) || 0,
    rolledBackCount: Number(record.rolled_back_count) || 0,
    errorMessage: record.error_message || ''
  };
}

module.exports = {
  normalizeSystemCurrency,
  displayAmountToken,
  rawNumericToken,
  systemAmountRead,
  systemAmountToken,
  findSystemHeader,
  meaningfulPreview,
  assertUniqueSystemBusinessSheet,
  readSystemOpSnapshots,
  readSystemOpSnapshot,
  importSystemOpGroup,
  systemRecordResult
};
