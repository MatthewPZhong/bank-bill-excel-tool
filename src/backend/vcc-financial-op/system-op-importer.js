'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const sax = require('sax');
const XLSX = require('xlsx');
const { canonicalizeVccAmount } = require('./amount-rules');
const { normalizeWorksheetTarget } = require('../big-table-import/zip-reader');
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
const {
  attachSourceIdentity,
  assertSourceFileMatchesSync,
  hashSourceFileSync
} = require('./source-lineage');

// 低于 2^46 时 IEEE-754 相邻数间距小于 0.01；达到该数量级后，只有
// SheetJS Number 而没有 OOXML lexical token 时无法证明分币未在解析前合并。
const MAX_FALLBACK_CENT_MAGNITUDE = 2 ** 46;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSystemCurrency(value) {
  return text(value);
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
  if (!Number.isFinite(rawValue)
      || (!Number.isSafeInteger(rawValue) && Math.abs(rawValue) >= MAX_FALLBACK_CENT_MAGNITUDE)) {
    const error = new Error(`Excel raw 数值缺少可核验的原始 token，无法保证两位小数精度：${rawValue}`);
    error.code = 'amount-precision-invalid';
    throw error;
  }
  return Object.is(rawValue, -0) ? '0' : String(rawValue);
}

function systemAmountRead(displayValue, rawValue, context = {}) {
  const hasRawLexicalToken = typeof context.rawLexicalToken === 'string';
  const rawToken = hasRawLexicalToken
    ? context.rawLexicalToken.trim()
    : rawNumericToken(rawValue);
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
    evidence.rawTokenSource = hasRawLexicalToken
      ? 'ooxml-worksheet-v'
      : 'sheetjs-number-fallback';
    if (hasRawLexicalToken) evidence.rawLexicalToken = context.rawLexicalToken;
  }
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

function workbookFileText(workbook, entryPath) {
  const entry = workbook && workbook.files && workbook.files[entryPath];
  if (!entry || entry.content === null || entry.content === undefined) return null;
  if (Buffer.isBuffer(entry.content)) return entry.content.toString('utf8');
  if (entry.content instanceof Uint8Array) return Buffer.from(entry.content).toString('utf8');
  return typeof entry.content === 'string' ? entry.content : null;
}

function lexicalStructureError(message, context = {}, cause = null) {
  const error = new Error(message);
  error.code = 'amount-precision-invalid';
  error.context = { ...context };
  if (cause) error.cause = cause;
  return error;
}

function worksheetEntryPath(workbook, sheetName) {
  const sheets = workbook && workbook.Workbook && Array.isArray(workbook.Workbook.Sheets)
    ? workbook.Workbook.Sheets
    : [];
  const metadata = sheets.find((sheet) => sheet && sheet.name === sheetName);
  const relationshipId = metadata && String(metadata.id || '').trim();
  const relationshipEntryPath = 'xl/_rels/workbook.xml.rels';
  const workbookFiles = workbook && workbook.files;
  if (!relationshipId
      || !workbookFiles
      || !Object.hasOwn(workbookFiles, relationshipEntryPath)) return null;
  const relationshipsXml = workbookFileText(workbook, relationshipEntryPath);
  if (relationshipsXml === null) {
    throw lexicalStructureError(
      '系统财务OP workbook.xml.rels 内容无法读取，不能核验财务余额原始 token',
      { sheetName, relationshipId }
    );
  }

  let target = null;
  let external = false;
  let relationshipsRootSeen = false;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onerror = (error) => { throw error; };
  parser.onopentag = (node) => {
    const localName = node.local || String(node.name || '').replace(/^.*:/, '');
    if (localName === 'Relationships') relationshipsRootSeen = true;
    if (localName !== 'Relationship') return;
    const attributes = Object.values(node.attributes || {}).reduce((result, attribute) => {
      const name = attribute && typeof attribute === 'object'
        ? String(attribute.local || attribute.name || '')
        : '';
      const value = attribute && typeof attribute === 'object' ? attribute.value : attribute;
      result[name] = value;
      return result;
    }, {});
    if (String(attributes.Id || '') !== relationshipId) return;
    if (!String(attributes.Type || '').endsWith('/worksheet')) return;
    target = String(attributes.Target || '');
    external = String(attributes.TargetMode || '').toLowerCase() === 'external';
  };
  try {
    parser.write(relationshipsXml).close();
  } catch (error) {
    throw lexicalStructureError(
      '系统财务OP无法解析 workbook.xml.rels，不能核验财务余额原始 token',
      { sheetName, relationshipId },
      error
    );
  }
  if (!relationshipsRootSeen) {
    throw lexicalStructureError(
      '系统财务OP workbook.xml.rels 结构无效，不能核验财务余额原始 token',
      { sheetName, relationshipId }
    );
  }
  if (!target || external) return null;
  const entryPath = normalizeWorksheetTarget(target);
  if (!Object.hasOwn(workbookFiles, entryPath)) return null;
  if (workbookFileText(workbook, entryPath) === null) {
    throw lexicalStructureError(
      '系统财务OP worksheet XML 内容无法读取，不能核验财务余额原始 token',
      { sheetName, relationshipId, entryPath }
    );
  }
  return entryPath;
}

function systemBalanceLexicalTokens(workbook, sheetName) {
  const entryPath = worksheetEntryPath(workbook, sheetName);
  if (!entryPath) return null;
  const worksheetXml = workbookFileText(workbook, entryPath);

  const balanceColumn = XLSX.utils.encode_col(
    SYSTEM_OP_DEFINITION.indexes[SYSTEM_OP_DEFINITION.balanceHeader]
  );
  const tokens = new Map();
  const seenBalanceRows = new Set();
  let worksheetRootSeen = false;
  let currentCell = null;
  let collectingValue = false;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onerror = (error) => { throw error; };
  parser.onopentag = (node) => {
    const localName = node.local || String(node.name || '').replace(/^.*:/, '');
    if (localName === 'worksheet') worksheetRootSeen = true;
    if (localName === 'c') {
      const attributes = Object.values(node.attributes || {}).reduce((result, attribute) => {
        const name = attribute && typeof attribute === 'object'
          ? String(attribute.local || attribute.name || '')
          : '';
        const value = attribute && typeof attribute === 'object' ? attribute.value : attribute;
        result[name] = value;
        return result;
      }, {});
      const match = String(attributes.r || '').toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/);
      if (match && match[1] === balanceColumn) {
        const rowNumber = Number(match[2]);
        if (seenBalanceRows.has(rowNumber)) {
          throw lexicalStructureError(
            `系统财务OP第 ${rowNumber} 行财务余额单元格重复，不能核验原始 token`,
            { sheetName, entryPath, sourceRow: rowNumber }
          );
        }
        seenBalanceRows.add(rowNumber);
        currentCell = {
          rowNumber,
          type: String(attributes.t || ''),
          valueSeen: false,
          value: ''
        };
      } else {
        currentCell = null;
      }
      return;
    }
    if (localName === 'v' && currentCell) {
      collectingValue = true;
      currentCell.valueSeen = true;
      currentCell.value = '';
    }
  };
  parser.ontext = (value) => {
    if (collectingValue && currentCell) currentCell.value += value;
  };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (name) => {
    const localName = String(name || '').replace(/^.*:/, '');
    if (localName === 'v') {
      collectingValue = false;
      return;
    }
    if (localName !== 'c' || !currentCell) return;
    if (currentCell.valueSeen && (currentCell.type === '' || currentCell.type === 'n')) {
      tokens.set(currentCell.rowNumber, currentCell.value.trim());
    }
    currentCell = null;
    collectingValue = false;
  };
  try {
    parser.write(worksheetXml).close();
  } catch (error) {
    if (error && error.code === 'amount-precision-invalid') throw error;
    throw lexicalStructureError(
      '系统财务OP worksheet XML 结构无效，不能核验财务余额原始 token',
      { sheetName, entryPath },
      error
    );
  }
  if (!worksheetRootSeen) {
    throw lexicalStructureError(
      '系统财务OP worksheet XML 结构无效，不能核验财务余额原始 token',
      { sheetName, entryPath }
    );
  }
  return tokens;
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
  const context = {
    sourceRow: sourceRow || null,
    fieldName: fieldName || '',
    sheetName: sheetName || ''
  };
  error.sourceRow = context.sourceRow;
  error.fieldName = context.fieldName;
  error.sheetName = context.sheetName;
  error.context = context;
  return error;
}

function validationUnitCount(entries) {
  return new Set(entries.map(({ file, error }, index) => (
    error.validationUnitKey
      || `${path.basename(file.filePath)}\u0000error:${index}`
  ))).size;
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

function readSystemOpSnapshotCandidates(filePath, targetMonth, preferredSheetName = '') {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`系统财务OP账期格式无效：${targetMonth}`);

  const sourceFile = path.basename(filePath);
  const workbook = XLSX.readFile(filePath, {
    cellFormula: true,
    cellDates: false,
    bookFiles: true
  });
  if (workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904) {
    throw new Error(`${sourceFile}：系统财务OP暂不支持 1904 日期系统，请改为 1900 日期系统后重新导入`);
  }
  const match = assertUniqueSystemBusinessSheet(workbook, sourceFile, preferredSheetName);
  const sheetName = match.sheetName;
  const sheet = workbook.Sheets[sheetName];
  const displayMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const rawMatrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const balanceLexicalTokens = systemBalanceLexicalTokens(workbook, sheetName);
  const header = findSystemHeader(displayMatrix);
  if (header.rowIndex + 1 !== match.headerRow) {
    throw new Error(`${sourceFile}：系统财务OP表头位置与识别结果不一致`);
  }

  const rowsBySubject = new Map();
  const invalidSubjects = new Set();
  const validationErrors = [];
  let targetMonthRows = 0;
  const snapshotContext = {
    rowsBySubject,
    invalidSubjects,
    validationErrors,
    normalizedMonth,
    sourceFile,
    sheetName,
    headerRow: header.rowIndex + 1
  };
  const rememberError = (error, subject = '') => {
    error.validationUnitKey = `${sourceFile}\u0000${subject || '<unknown-subject>'}`;
    if (subject) invalidSubjects.add(subject);
    validationErrors.push(error);
  };

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
      rememberError(systemRowError(
        `${sheetName} 第 ${sourceRow} 行存在模板外的第 ${columnNumber} 列数据`,
        { sourceRow, fieldName: `第${columnNumber}列`, sheetName }
      ));
      continue;
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
      rememberError(systemRowError(
        `${sheetName} 第 ${sourceRow} 行“账单日期”无法解析为有效日期`,
        { sourceRow, fieldName: SYSTEM_OP_DEFINITION.monthHeader, sheetName }
      ));
      continue;
    }
    if (rowMonth !== normalizedMonth) continue;
    targetMonthRows += 1;

    const subject = text(rowField(displayValues, SYSTEM_OP_DEFINITION.subjectHeader));
    if (!subject) {
      rememberError(systemRowError(
        `${sheetName} 第 ${sourceRow} 行“主体”不能为空`,
        { sourceRow, fieldName: SYSTEM_OP_DEFINITION.subjectHeader, sheetName }
      ));
      continue;
    }
    const department = text(rowField(displayValues, SYSTEM_OP_DEFINITION.departmentHeader));
    if (department !== 'VCC') {
      rememberError(systemRowError(
        `${sheetName} 第 ${sourceRow} 行“业务部门”必须为 VCC，实际为“${department || '空'}”`,
        { sourceRow, fieldName: SYSTEM_OP_DEFINITION.departmentHeader, sheetName }
      ), subject);
      continue;
    }
    const sourceCurrency = text(rowField(displayValues, SYSTEM_OP_DEFINITION.currencyHeader));
    const currency = normalizeSystemCurrency(sourceCurrency);
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      rememberError(systemRowError(
        `${sheetName} 第 ${sourceRow} 行“币种”仅允许 ${SUPPORTED_CURRENCIES.join('、')}，实际为“${sourceCurrency || '空'}”`,
        { sourceRow, fieldName: SYSTEM_OP_DEFINITION.currencyHeader, sheetName }
      ), subject);
      continue;
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
        }),
        rawLexicalToken: balanceLexicalTokens && balanceLexicalTokens.has(sourceRow)
          ? balanceLexicalTokens.get(sourceRow)
          : undefined
      });
      balance = reading.canonicalValue;
      balanceEvidence = reading.evidence;
    } catch (error) {
      const wrapped = systemRowError(
        `${sheetName} 第 ${sourceRow} 行“财务余额”无效：${error.message}`,
        { sourceRow, fieldName: SYSTEM_OP_DEFINITION.balanceHeader, sheetName }
      );
      wrapped.code = error.code || 'amount-precision-invalid';
      rememberError(wrapped, subject);
      continue;
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

  if (targetMonthRows === 0 && validationErrors.length === 0) {
    throw new Error(`${sourceFile}：未找到“账单日期”属于 ${normalizedMonth} 的系统财务OP数据`);
  }

  const snapshots = [];
  for (const [subject, rows] of rowsBySubject) {
    if (invalidSubjects.has(subject)) continue;
    try {
      snapshots.push(buildSubjectSnapshot({ ...snapshotContext, subject, rows }));
    } catch (error) {
      error.validationUnitKey = `${sourceFile}\u0000${subject}`;
      validationErrors.push(error);
    }
  }
  return { snapshots, validationErrors };
}

function readSystemOpSnapshots(filePath, targetMonth, preferredSheetName = '') {
  const result = readSystemOpSnapshotCandidates(filePath, targetMonth, preferredSheetName);
  if (result.validationErrors.length > 0) {
    const error = result.validationErrors[0];
    error.parsedSnapshots = result.snapshots;
    throw error;
  }
  return result.snapshots;
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
      import_record_id, import_source_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, existing_snapshot_id, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordId,
    snapshot.importSourceId || null,
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

function addSystemValidationAnomaly(db, recordId, file, error) {
  const fieldName = String(error.fieldName || '');
  const category = [
    SYSTEM_OP_DEFINITION.subjectHeader,
    SYSTEM_OP_DEFINITION.departmentHeader
  ].includes(fieldName)
    ? 'system_subject_error'
    : (error.hardFailure ? 'file_failure' : 'format_error');
  return repository.addImportAnomaly(db, recordId, {
    importSourceId: file.importSourceId,
    category,
    sourceFile: path.basename(file.filePath),
    sheetName: error.sheetName || file.sheetName || '',
    sourceRow: error.sourceRow,
    abnormalFields: fieldName ? [fieldName] : [],
    description: error.message
  });
}

function addSystemConflictAnomaly(db, recordId, item) {
  return repository.addImportAnomaly(db, recordId, {
    importSourceId: item.snapshot.importSourceId,
    category: 'idempotent_conflict',
    idempotencyKey: item.snapshot.subject,
    sourceFile: item.snapshot.sourceFile,
    sheetName: item.snapshot.sheetName,
    sourceRow: item.snapshot.sourceRow,
    abnormalFields: ['财务余额'],
    description: '同一账期和主体的系统财务OP余额不一致',
    incomingContentHash: item.snapshot.contentHash,
    existingContentHash: item.existing ? item.existing.content_hash : null,
    diffFields: ['财务余额']
  });
}

function importSystemOpGroup({ db, batchId, targetMonth, files, recordId: preparedRecordId }) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`系统财务OP账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('系统财务OP至少需要一个文件');
  let importFiles = files;
  let recordId = preparedRecordId;
  if (!recordId) {
    const hashedFiles = files.map((file) => ({ ...file, ...hashSourceFileSync(file.filePath) }));
    recordId = repository.createImportRecord(db, {
      batchId,
      targetMonth: normalizedMonth,
      sourceType: SOURCE_TYPES.SYSTEM_OP,
      sourceFiles: hashedFiles.map((file) => path.basename(file.filePath))
    });
    importFiles = hashedFiles.map((file, index) => ({
      ...file,
      sourceOrdinal: index + 1,
      importSourceId: repository.createImportSource(db, recordId, {
        sourceOrdinal: index + 1,
        fileName: file.fileName,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes
      })
    }));
  }

  const snapshots = [];
  const validationErrors = [];
  for (const file of importFiles) {
    try {
      const candidates = readSystemOpSnapshotCandidates(
        file.filePath,
        normalizedMonth,
        file.sheetName
      );
      snapshots.push(...candidates.snapshots.map((snapshot) => ({
        ...snapshot,
        importSourceId: file.importSourceId || null
      })));
      for (const error of candidates.validationErrors) validationErrors.push({ file, error });
    } catch (error) {
      attachSourceIdentity(error, file);
      error.hardFailure = true;
      validationErrors.push({ file, error });
    }
  }
  // 系统 OP 解析也是在 worker 中同步完成；在首条业务 DML 前复核完整
  // SHA/size，避免解析期间替换文件后把错误内容绑定到旧来源身份。
  for (const file of importFiles) assertSourceFileMatchesSync(file);
  const hardValidationErrors = validationErrors.filter(({ error }) => error.hardFailure);
  if (hardValidationErrors.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const message = hardValidationErrors.map(({ file, error }) => (
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
        addSystemValidationAnomaly(db, recordId, file, error);
      }
      const formatErrorCount = validationUnitCount(validationErrors);
      repository.finishImportRecord(db, recordId, {
        status: 'failed_validation',
        rawCount: snapshots.length + formatErrorCount,
        formatErrorCount,
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
            classified.push({ snapshot, disposition: 'idempotent_conflict', existing });
          }
        }
        continue;
      }
      if (hashes.size > 1) {
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
      for (const item of classified) {
        if (item.disposition === 'accepted') item.disposition = 'rolled_back';
      }
    }

    if (datasetArchived && classified.some((item) => item.disposition === 'rolled_back')) {
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
      const message = `${normalizedMonth} 系统财务OP已归档，禁止新增快照`;
      for (const entry of insertedAttempts) {
        if (entry.disposition === 'idempotent_conflict') {
          addSystemConflictAnomaly(db, recordId, entry.item);
        }
      }
      if (rolledBackCount > 0) {
        repository.addImportAnomaly(db, recordId, {
          category: 'file_failure',
          sourceFile: snapshots[0] ? snapshots[0].sourceFile : '',
          description: message
        });
      }
      for (const { file, error } of validationErrors) {
        addSystemValidationAnomaly(db, recordId, file, error);
      }
      repository.finishImportRecord(db, recordId, {
        status: 'failed_validation',
        rawCount: snapshots.length + validationUnitCount(validationErrors),
        conflictCount,
        formatErrorCount: validationUnitCount(validationErrors),
        skippedCount,
        rolledBackCount,
        errorMessage: message
      });
      db.exec('COMMIT');
      return repository.getImportRecord(db, recordId);
    }

    let insertedCount = 0;
    let skippedCount = 0;
    let conflictCount = 0;
    const insertedAttempts = [];
    for (const item of classified) {
      if (item.disposition === 'accepted') {
        const result = db.prepare(`
          INSERT INTO vcc_fin_op_system_snapshots (
            target_month, subject, balances_json, content_hash, import_source_id,
            source_file, sheet_name, source_row, raw_json, import_record_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.snapshot.targetMonth,
          item.snapshot.subject,
          item.snapshot.balancesJson,
          item.snapshot.contentHash,
          item.snapshot.importSourceId || null,
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
      } else if (item.disposition === 'idempotent_skip') {
        skippedCount += 1;
      } else {
        conflictCount += 1;
        const attemptId = insertAttempt(
          db,
          recordId,
          item.snapshot,
          'idempotent_conflict',
          item.existing && item.existing.id,
          '同一账期和主体的系统财务OP余额不一致，已过滤该主体快照'
        );
        insertedAttempts.push({ attemptId, item });
        addSystemConflictAnomaly(db, recordId, item);
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
    const linkComparison = db.prepare(`
      UPDATE vcc_fin_op_system_snapshot_attempts
      SET comparison_attempt_id = ?
      WHERE id = ?
    `);
    for (const current of insertedAttempts) {
      if (current.item.existing) continue;
      const peer = insertedAttempts.find((candidate) => (
        candidate.attemptId !== current.attemptId
        && candidate.item.snapshot.subject === current.item.snapshot.subject
        && candidate.item.snapshot.contentHash !== current.item.snapshot.contentHash
      ));
      if (peer) linkComparison.run(peer.attemptId, current.attemptId);
    }
    for (const { file, error } of validationErrors) {
      addSystemValidationAnomaly(db, recordId, file, error);
    }

    const formatErrorCount = validationUnitCount(validationErrors);
    const filteredCount = conflictCount + formatErrorCount;
    const status = insertedCount === 0
      ? (filteredCount > 0
        ? (conflictCount > 0 ? 'failed_conflict' : 'failed_validation')
        : 'all_skipped')
      : (skippedCount > 0 || filteredCount > 0 ? 'success_with_skips' : 'success');
    const errorParts = [];
    if (formatErrorCount > 0) errorParts.push(`格式异常 ${formatErrorCount} 个主体快照`);
    if (conflictCount > 0) errorParts.push(`主体快照冲突 ${conflictCount} 项`);
    repository.finishImportRecord(db, recordId, {
      status,
      rawCount: snapshots.length + formatErrorCount,
      insertedCount,
      skippedCount,
      conflictCount,
      formatErrorCount,
      errorMessage: errorParts.length > 0
        ? `系统财务OP已过滤异常数据：${errorParts.join('、')}`
        : ''
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
    anomalyCount: Number(record.anomaly_count) || 0,
    archiveState: record.archive_state || 'pending',
    errorMessage: record.error_message || ''
  };
}

module.exports = {
  normalizeSystemCurrency,
  displayAmountToken,
  rawNumericToken,
  systemAmountRead,
  systemAmountToken,
  workbookFileText,
  worksheetEntryPath,
  systemBalanceLexicalTokens,
  findSystemHeader,
  meaningfulPreview,
  assertUniqueSystemBusinessSheet,
  readSystemOpSnapshotCandidates,
  readSystemOpSnapshots,
  readSystemOpSnapshot,
  importSystemOpGroup,
  systemRecordResult
};
