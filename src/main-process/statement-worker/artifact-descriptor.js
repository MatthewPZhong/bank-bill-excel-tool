'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { normalizeCell } = require('../../backend/file-service/common');
const { parseDateValue } = require('../../backend/file-service/normalizers');
const {
  canonicalizeJson,
  canonicalJsonSnapshot
} = require('../background-execution/canonical-json-v1');
const { normalizeTargetAliasKey } = require('../toolbox-target-identity');
const { WATERMARK_AUTHOR } = require('../workbook-watermark');
const { isValidTaskStagingResourceId } = require('./staging-ownership');

const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_HEADERS = 4096;
const SHA256 = /^[0-9a-f]{64}$/;
const DETAIL_PROFILE = 'statement-detail-v1';
const BALANCE_PROFILE = 'statement-balance-v1';
const DATE_FORMATS = new Set(['yyyy-mm-dd', 'yyyy/mm/dd', 'yyyymmdd']);
const DETAIL_REQUIRED_HEADERS = Object.freeze([
  'BillDate',
  'MerchantId',
  'Currency',
  'Credit Amount',
  'Debit Amount'
]);
const BALANCE_REQUIRED_HEADERS = Object.freeze([
  '银行名称',
  '所在地',
  '币种',
  '银行账号',
  '账单日期',
  '期初余额',
  '期初可用余额',
  '期末余额',
  '期末可用余额'
]);
const BUSINESS_EVIDENCE_KEYS = Object.freeze([
  'recordCount',
  'recordsSha256',
  'datesSha256',
  'accountsSha256',
  'currenciesSha256',
  'amountsSha256'
]);

class StatementArtifactDescriptorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementArtifactDescriptorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatementArtifactDescriptorError(code, message);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('STATEMENT_EXPECTED_ARTIFACT_SHAPE_INVALID', `${label} has invalid keys`);
  }
  return value;
}

function boundedText(value, label, max = 512) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail('STATEMENT_EXPECTED_ARTIFACT_VALUE_INVALID', `${label} is invalid`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fileSha256(filePath, fsImpl = fs) {
  const hash = crypto.createHash('sha256');
  const fd = fsImpl.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fsImpl.closeSync(fd);
  }
  return hash.digest('hex');
}

function createFramedHasher(domain) {
  const hash = crypto.createHash('sha256');
  hash.update(`${domain}\0`, 'utf8');
  return {
    update(value) {
      const encoded = canonicalizeJson(value);
      hash.update(`${Buffer.byteLength(encoded, 'utf8')}:`, 'utf8');
      hash.update(encoded, 'utf8');
    },
    digest() {
      return hash.digest('hex');
    }
  };
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function excelSerialDate(value) {
  if (!Number.isFinite(value)) return null;
  const decoded = XLSX.SSF.parse_date_code(value);
  if (!decoded || !decoded.y || !decoded.m || !decoded.d) return null;
  return `${String(decoded.y).padStart(4, '0')}-${String(decoded.m).padStart(2, '0')}-${String(decoded.d).padStart(2, '0')}`;
}

function canonicalDate(value, options = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (options.excelSerialDates && typeof value === 'number') return excelSerialDate(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoDate(value);
  const parsed = parseDateValue(value);
  return parsed ? isoDate(parsed) : null;
}

function decimalParts(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : normalizeCell(value).replaceAll(',', '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  const digitCount = raw.replace(/[^0-9]/g, '').replace(/^0+/, '').length;
  if (digitCount <= 15 || /[eE]/.test(raw)) {
    return { canonical: Object.is(numeric, -0) ? '0' : String(numeric), digitCount, numeric };
  }
  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [integerRaw, fractionRaw = ''] = unsigned.split('.');
  const integer = integerRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const zero = /^0+$/.test(integer) && fraction === '';
  return {
    canonical: `${negative && !zero ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`,
    digitCount,
    numeric
  };
}

function textValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeCell(value).normalize('NFC');
}

function fieldSets(kind, headers) {
  const required = kind === 'detail' ? DETAIL_REQUIRED_HEADERS : BALANCE_REQUIRED_HEADERS;
  if (required.some((header) => !headers.includes(header)) || new Set(headers).size !== headers.length) {
    fail('STATEMENT_EXPECTED_ARTIFACT_HEADERS_INVALID', `${kind} headers do not contain the required unique fields`);
  }
  return kind === 'detail'
    ? {
        dates: new Set(headers.filter((header) => ['BillDate', 'ValueDate'].includes(header))),
        accounts: new Set(['MerchantId']),
        currencies: new Set(['Currency']),
        amounts: new Set(headers.filter((header) => ['Credit Amount', 'Debit Amount', 'Balance'].includes(header)))
      }
    : {
        dates: new Set(['账单日期']),
        accounts: new Set(['银行账号']),
        currencies: new Set(['币种']),
        amounts: new Set(['期初余额', '期初可用余额', '期末余额', '期末可用余额'])
      };
}

function canonicalBusinessCell(header, value, fields, options = {}) {
  if (fields.dates.has(header)) return canonicalDate(value, options);
  if (fields.amounts.has(header)) return decimalParts(value)?.canonical ?? null;
  return textValue(value);
}

function createBusinessEvidenceAccumulator(kind, headers, options = {}) {
  const fields = fieldSets(kind, headers);
  const indexes = {
    dates: [],
    accounts: [],
    currencies: [],
    amounts: []
  };
  headers.forEach((header, index) => {
    for (const [fieldKind, fieldNames] of Object.entries(fields)) {
      if (fieldNames.has(header)) indexes[fieldKind].push(index);
    }
  });
  const records = createFramedHasher(`${kind}:records:v1`);
  const dates = createFramedHasher(`${kind}:dates:v1`);
  const accounts = createFramedHasher(`${kind}:accounts:v1`);
  const currencies = createFramedHasher(`${kind}:currencies:v1`);
  const amounts = createFramedHasher(`${kind}:amounts:v1`);
  let recordCount = 0;
  return {
    add(row) {
      if (!Array.isArray(row) || row.length !== headers.length) {
        fail('STATEMENT_EXPECTED_ARTIFACT_RECORD_INVALID', 'Expected business record width is invalid');
      }
      const canonicalRow = row.map((value, index) =>
        canonicalBusinessCell(headers[index], value, fields, options));
      records.update(canonicalRow);
      dates.update(indexes.dates.map((index) => canonicalRow[index]));
      accounts.update(indexes.accounts.map((index) => canonicalRow[index]));
      currencies.update(indexes.currencies.map((index) => canonicalRow[index]));
      amounts.update(indexes.amounts.map((index) => canonicalRow[index]));
      recordCount += 1;
    },
    finish() {
      return Object.freeze({
        recordCount,
        recordsSha256: records.digest(),
        datesSha256: dates.digest(),
        accountsSha256: accounts.digest(),
        currenciesSha256: currencies.digest(),
        amountsSha256: amounts.digest()
      });
    }
  };
}

function createStatementBusinessEvidence(input) {
  const kind = input && input.kind;
  const headers = input && input.headers;
  const records = input && input.records;
  if (!['detail', 'balance'].includes(kind) || !Array.isArray(headers) || !Array.isArray(records)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_RECORD_INVALID', 'Expected business evidence input is invalid');
  }
  const accumulator = createBusinessEvidenceAccumulator(kind, headers);
  records.forEach((row) => accumulator.add(row));
  return accumulator.finish();
}

function rawSheetXml(workbook) {
  const entry = workbook.files && workbook.files['xl/worksheets/sheet1.xml'];
  return entry && entry.content ? String(entry.content) : '';
}

function headerStyleIndexes(workbook) {
  const result = new Map();
  const xml = rawSheetXml(workbook);
  const row = xml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/);
  if (!row) return result;
  for (const match of row[1].matchAll(/<c\b([^>]*)>/g)) {
    const address = match[1].match(/\br="([^"]+)"/);
    const style = match[1].match(/\bs="(\d+)"/);
    if (address) result.set(address[1], style ? Number(style[1]) : 0);
  }
  return result;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function cellStyleSignature(workbook, styleIndex) {
  const styles = workbook.Styles || {};
  const xf = Array.isArray(styles.CellXf) ? styles.CellXf[styleIndex || 0] : null;
  if (!xf) return null;
  return {
    numberFormat: (Array.isArray(styles.NumberFmt) && styles.NumberFmt[xf.numFmtId]) ||
      XLSX.SSF._table[xf.numFmtId] || null,
    fill: Array.isArray(styles.Fills) ? jsonSafe(styles.Fills[xf.fillId]) : null,
    border: Array.isArray(styles.Borders) ? jsonSafe(styles.Borders[xf.borderId]) : null
  };
}

function headerFont(workbook, styleIndex) {
  const styles = workbook.Styles || {};
  const xf = Array.isArray(styles.CellXf) ? styles.CellXf[styleIndex || 0] : null;
  return xf && Array.isArray(styles.Fonts) ? styles.Fonts[xf.fontId] : null;
}

function normalizedColumns(columns) {
  return Array.isArray(columns) ? Array.from({ length: columns.length }, (_unused, index) => {
    const column = columns[index];
    return column ? {
      hidden: Boolean(column.hidden),
      level: Number(column.level || 0),
      width: Number.isFinite(column.width) ? column.width : null
    } : null;
  }) : [];
}

function workbookStructure(workbook) {
  if (!workbook || !Array.isArray(workbook.SheetNames) || workbook.SheetNames.length !== 1) {
    fail('STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID', 'Statement template lineage requires one sheet');
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
  const headers = (rows[0] || []).map((value) => String(value));
  const styles = headerStyleIndexes(workbook);
  return {
    sheetName,
    headers,
    headerStyles: headers.map((_header, index) => cellStyleSignature(
      workbook,
      styles.get(XLSX.utils.encode_cell({ r: 0, c: index })) || 0
    )),
    columns: normalizedColumns(sheet['!cols']),
    merges: Array.isArray(sheet['!merges'])
      ? sheet['!merges'].map((merge) => XLSX.utils.encode_range(merge))
      : [],
    margins: sheet['!margins'] ? jsonSafe(sheet['!margins']) : null,
    author: workbook.Props && typeof workbook.Props.Author === 'string' ? workbook.Props.Author : null,
    themeColors: Array.isArray(workbook.Themes?.themeElements?.clrScheme)
      ? workbook.Themes.themeElements.clrScheme.map(({ name, rgb }) => ({ name, rgb }))
      : []
  };
}

function readWorkbook(filePath) {
  try {
    return XLSX.readFile(filePath, {
      raw: true,
      cellNF: true,
      cellStyles: true,
      cellText: false,
      bookFiles: true
    });
  } catch (_error) {
    fail('STATEMENT_GENERATION_WORKBOOK_INVALID', 'Statement workbook cannot be read back');
  }
}

function createStatementArtifactLineage({ kind, balanceTemplatePath }) {
  if (kind === 'detail') {
    return Object.freeze({
      writerProfile: DETAIL_PROFILE,
      watermarkAuthor: WATERMARK_AUTHOR,
      templateSha256: null,
      templateStructureSha256: null
    });
  }
  if (kind !== 'balance' || typeof balanceTemplatePath !== 'string') {
    fail('STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID', 'Balance template lineage input is invalid');
  }
  const workbook = readWorkbook(balanceTemplatePath);
  return Object.freeze({
    writerProfile: BALANCE_PROFILE,
    watermarkAuthor: WATERMARK_AUTHOR,
    templateSha256: fileSha256(balanceTemplatePath),
    templateStructureSha256: crypto.createHash('sha256')
      .update(canonicalizeJson(workbookStructure(workbook)))
      .digest('hex')
  });
}

function validateBusinessEvidence(input) {
  const evidence = exact(input, BUSINESS_EVIDENCE_KEYS, 'businessEvidence');
  if (!Number.isSafeInteger(evidence.recordCount) || evidence.recordCount < 0 ||
      BUSINESS_EVIDENCE_KEYS.slice(1).some((key) => !SHA256.test(evidence[key]))) {
    fail('STATEMENT_EXPECTED_ARTIFACT_EVIDENCE_INVALID', 'Expected business evidence is invalid');
  }
  return evidence;
}

function validateLineage(input, kind) {
  const lineage = exact(input, [
    'writerProfile', 'watermarkAuthor', 'templateSha256', 'templateStructureSha256'
  ], 'lineage');
  const expectedProfile = kind === 'detail' ? DETAIL_PROFILE : BALANCE_PROFILE;
  if (lineage.writerProfile !== expectedProfile || lineage.watermarkAuthor !== WATERMARK_AUTHOR) {
    fail('STATEMENT_EXPECTED_ARTIFACT_LINEAGE_INVALID', 'Expected writer/watermark lineage is invalid');
  }
  if (kind === 'detail') {
    if (lineage.templateSha256 !== null || lineage.templateStructureSha256 !== null) {
      fail('STATEMENT_EXPECTED_ARTIFACT_LINEAGE_INVALID', 'Detail artifact must not claim a balance template');
    }
  } else if (!SHA256.test(lineage.templateSha256) || !SHA256.test(lineage.templateStructureSha256)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_LINEAGE_INVALID', 'Balance template lineage is invalid');
  }
  return lineage;
}

function createMainExpectedArtifactDescriptor(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_DESCRIPTOR_BYTES });
  const descriptor = exact(value, [
    'version', 'artifactKey', 'kind', 'ordinal', 'stagingResourceId', 'sheetName',
    'headers', 'rowCounts', 'businessEvidence', 'warningSummary', 'sessionRevision',
    'inputEvidenceHash', 'lineage'
  ], 'MainExpectedArtifactDescriptorV1');
  if (descriptor.version !== 1 || !['detail', 'balance'].includes(descriptor.kind) ||
      !Number.isSafeInteger(descriptor.ordinal) || descriptor.ordinal < 0 || descriptor.ordinal > 1) {
    fail('STATEMENT_EXPECTED_ARTIFACT_VALUE_INVALID', 'Expected artifact version/kind/ordinal is invalid');
  }
  boundedText(descriptor.artifactKey, 'artifactKey', 256);
  if (!isValidTaskStagingResourceId(descriptor.stagingResourceId)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_VALUE_INVALID', 'Expected stagingResourceId is invalid');
  }
  boundedText(descriptor.sheetName, 'sheetName', 128);
  if (descriptor.sheetName !== (descriptor.kind === 'detail' ? 'COMMON' : 'balance')) {
    fail('STATEMENT_EXPECTED_ARTIFACT_LINEAGE_INVALID', 'Expected sheet name does not match writer profile');
  }
  if (!Array.isArray(descriptor.headers) || descriptor.headers.length < 1 ||
      descriptor.headers.length > MAX_HEADERS || descriptor.headers.some((header) =>
        typeof header !== 'string' || header.length < 1 || header.length > 512)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_HEADERS_INVALID', 'Expected headers are invalid');
  }
  fieldSets(descriptor.kind, descriptor.headers);
  const rowCounts = exact(descriptor.rowCounts, ['input', 'output'], 'rowCounts');
  if (![rowCounts.input, rowCounts.output].every((count) =>
    Number.isSafeInteger(count) && count >= 0) || rowCounts.output > rowCounts.input) {
    fail('STATEMENT_EXPECTED_ARTIFACT_ROW_COUNTS_INVALID', 'Expected rowCounts are invalid');
  }
  const evidence = validateBusinessEvidence(descriptor.businessEvidence);
  if (evidence.recordCount !== rowCounts.output) {
    fail('STATEMENT_EXPECTED_ARTIFACT_ROW_COUNTS_INVALID', 'Expected record count is inconsistent');
  }
  const warningSummary = exact(
    descriptor.warningSummary,
    ['count', 'byType', 'manualBalanceRequired'],
    'warningSummary'
  );
  if (!Number.isSafeInteger(warningSummary.count) || warningSummary.count < 0 ||
      typeof warningSummary.manualBalanceRequired !== 'boolean' ||
      !warningSummary.byType || typeof warningSummary.byType !== 'object' ||
      Array.isArray(warningSummary.byType) || Object.keys(warningSummary.byType).length > 16 ||
      Object.entries(warningSummary.byType).some(([type, count]) =>
        type.length < 1 || type.length > 64 || !Number.isSafeInteger(count) || count < 1) ||
      Object.values(warningSummary.byType).reduce((sum, count) => sum + count, 0) !== warningSummary.count ||
      warningSummary.manualBalanceRequired !== Object.hasOwn(warningSummary.byType, 'balance-seed-required')) {
    fail('STATEMENT_EXPECTED_ARTIFACT_WARNING_INVALID', 'Expected warning summary is invalid');
  }
  if (!Number.isSafeInteger(descriptor.sessionRevision) || descriptor.sessionRevision < 1 ||
      !SHA256.test(descriptor.inputEvidenceHash)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_SESSION_INVALID', 'Expected session evidence is invalid');
  }
  validateLineage(descriptor.lineage, descriptor.kind);
  return deepFreeze(value);
}

function createMainExpectedArtifactDescriptors(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
    fail('STATEMENT_EXPECTED_ARTIFACT_COLLECTION_INVALID', 'Expected artifacts must contain one or two descriptors');
  }
  const descriptors = input.map(createMainExpectedArtifactDescriptor);
  if (descriptors.some((descriptor, index) => descriptor.ordinal !== index) ||
      descriptors.map((descriptor) => descriptor.kind).join(',') === 'balance,detail' ||
      new Set(descriptors.map((descriptor) => descriptor.kind)).size !== descriptors.length ||
      new Set(descriptors.map((descriptor) => descriptor.artifactKey)).size !== descriptors.length ||
      new Set(descriptors.map((descriptor) => normalizeTargetAliasKey(
        path.normalize(descriptor.stagingResourceId)
      ))).size !== descriptors.length) {
    fail('STATEMENT_EXPECTED_ARTIFACT_COLLECTION_INVALID', 'Expected artifact order/identity is invalid');
  }
  const inputRows = descriptors[0].rowCounts.input;
  const sessionRevision = descriptors[0].sessionRevision;
  const inputEvidenceHash = descriptors[0].inputEvidenceHash;
  const warningSummary = canonicalizeJson(descriptors[0].warningSummary);
  if (descriptors.some((descriptor) => descriptor.rowCounts.input !== inputRows ||
      descriptor.sessionRevision !== sessionRevision ||
      descriptor.inputEvidenceHash !== inputEvidenceHash ||
      canonicalizeJson(descriptor.warningSummary) !== warningSummary)) {
    fail('STATEMENT_EXPECTED_ARTIFACT_COLLECTION_INVALID', 'Expected artifact group evidence differs');
  }
  return Object.freeze(descriptors);
}

function isBlankCell(cell) {
  return !cell || cell.v === null || cell.v === undefined || cell.v === '';
}

function validateWorksheetBounds(worksheet, range, descriptor) {
  for (const address of Object.keys(worksheet)) {
    if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(address)) continue;
    const coordinate = XLSX.utils.decode_cell(address);
    if (coordinate.r < range.s.r || coordinate.r > range.e.r ||
        coordinate.c < range.s.c || coordinate.c > range.e.c) {
      fail('STATEMENT_GENERATION_ROW_COUNTS_MISMATCH', 'Statement workbook contains cells outside its bounded range');
    }
  }
  if (descriptor.kind === 'balance' && descriptor.rowCounts.output === 0) {
    for (let column = 0; column < descriptor.headers.length; column += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 1, c: column })];
      if (!isBlankCell(cell) || (cell && typeof cell.f === 'string')) {
        fail('STATEMENT_GENERATION_ROW_COUNTS_MISMATCH', 'Zero-output balance workbook contains a business row');
      }
    }
  }
}

function validateHeaderFont(workbook, styles, headers) {
  for (let index = 0; index < headers.length; index += 1) {
    const address = XLSX.utils.encode_cell({ r: 0, c: index });
    const font = headerFont(workbook, styles.get(address) || 0);
    if (!font || font.name !== 'Courier New' || Number(font.sz) !== 10) {
      fail('STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID', 'Statement header font/style is invalid');
    }
  }
}

function validateDetailHeaderStyles(workbook, styles, headers) {
  const expected = canonicalizeJson({
    numberFormat: 'General',
    fill: { patternType: 'none' },
    border: {}
  });
  for (let index = 0; index < headers.length; index += 1) {
    const address = XLSX.utils.encode_cell({ r: 0, c: index });
    if (canonicalizeJson(cellStyleSignature(workbook, styles.get(address) || 0)) !== expected) {
      fail('STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID', 'Statement detail header style is invalid');
    }
  }
}

function validateTextCell(cell, required, label) {
  if (isBlankCell(cell)) {
    if (required) fail('STATEMENT_GENERATION_WORKBOOK_RECORD_INVALID', `${label} is missing`);
    return;
  }
  if (cell.t !== 's' || cell.z !== '@') {
    fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', `${label} must be a text cell with @ format`);
  }
}

function validateDateCell(cell, required, label) {
  if (isBlankCell(cell)) {
    if (required) fail('STATEMENT_GENERATION_WORKBOOK_RECORD_INVALID', `${label} is missing`);
    return;
  }
  if (cell.t !== 'n' || !Number.isFinite(cell.v) || typeof cell.z !== 'string' ||
      !DATE_FORMATS.has(cell.z) || !XLSX.SSF.is_date(cell.z) || !excelSerialDate(cell.v)) {
    fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', `${label} must be a numeric date cell`);
  }
}

function validateAmountCell(cell, required, allowNegative, label) {
  if (isBlankCell(cell)) {
    if (required) fail('STATEMENT_GENERATION_WORKBOOK_RECORD_INVALID', `${label} is missing`);
    return null;
  }
  const parsed = decimalParts(cell.v);
  if (!parsed || (!allowNegative && parsed.canonical.startsWith('-'))) {
    fail('STATEMENT_GENERATION_WORKBOOK_AMOUNT_INVALID', `${label} amount direction/value is invalid`);
  }
  if (cell.t === 'n') {
    if (!['0.00', 'General'].includes(cell.z || 'General')) {
      fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', `${label} numeric format is invalid`);
    }
  } else if (cell.t === 's') {
    if (cell.z !== '@' || parsed.digitCount <= 15) {
      fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', `${label} precision-preserving text format is invalid`);
    }
  } else {
    fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', `${label} cell type is invalid`);
  }
  return parsed;
}

function validateRecordCells(kind, headers, cells) {
  const index = new Map(headers.map((header, column) => [header, column]));
  for (const cell of cells) {
    if (cell && typeof cell.f === 'string') {
      fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', 'Statement data cells must not contain formulas');
    }
  }
  if (kind === 'detail') {
    for (const header of headers.filter((item) => ['BillDate', 'ValueDate'].includes(item))) {
      validateDateCell(cells[index.get(header)], header === 'BillDate', header);
    }
    for (const header of headers.filter((item) => ['MerchantId', 'Currency', 'Channel'].includes(item))) {
      validateTextCell(cells[index.get(header)], false, header);
    }
    const credit = validateAmountCell(cells[index.get('Credit Amount')], false, false, 'Credit Amount');
    const debit = validateAmountCell(cells[index.get('Debit Amount')], false, false, 'Debit Amount');
    const creditEffective = credit && credit.canonical !== '0';
    const debitEffective = debit && debit.canonical !== '0';
    if (Boolean(creditEffective) === Boolean(debitEffective)) {
      fail('STATEMENT_GENERATION_WORKBOOK_AMOUNT_INVALID', 'Detail credit/debit direction is not mutually exclusive');
    }
    if (index.has('Balance')) validateAmountCell(cells[index.get('Balance')], false, true, 'Balance');
    return;
  }
  for (const header of ['银行名称', '所在地', '币种', '银行账号']) {
    validateTextCell(cells[index.get(header)], header === '银行账号', header);
  }
  validateDateCell(cells[index.get('账单日期')], true, '账单日期');
  for (const header of ['期初余额', '期初可用余额', '期末余额', '期末可用余额']) {
    validateAmountCell(cells[index.get(header)], header === '期末余额', true, header);
  }
}

function assertEvidenceMatches(actual, expected) {
  if (BUSINESS_EVIDENCE_KEYS.some((key) => actual[key] !== expected[key])) {
    fail('STATEMENT_GENERATION_BUSINESS_EVIDENCE_MISMATCH', 'Statement workbook business evidence mismatch');
  }
}

function validateTemplateLineage(workbook, descriptor, balanceTemplatePath) {
  if (descriptor.kind === 'detail') return;
  if (typeof balanceTemplatePath !== 'string') {
    fail('STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID', 'Trusted balance template path is required');
  }
  const expected = createStatementArtifactLineage({ kind: 'balance', balanceTemplatePath });
  if (expected.templateSha256 !== descriptor.lineage.templateSha256 ||
      expected.templateStructureSha256 !== descriptor.lineage.templateStructureSha256) {
    fail('STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID', 'Trusted balance template evidence changed');
  }
  const actualStructure = crypto.createHash('sha256')
    .update(canonicalizeJson(workbookStructure(workbook)))
    .digest('hex');
  if (actualStructure !== descriptor.lineage.templateStructureSha256) {
    fail('STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID', 'Balance workbook template lineage mismatch');
  }
}

function validateStatementArtifactWorkbook(options) {
  const { filePath, descriptor, balanceTemplatePath } = options;
  const workbook = readWorkbook(filePath);
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== descriptor.sheetName) {
    fail('STATEMENT_GENERATION_WORKBOOK_KIND_INVALID', 'Statement workbook sheet/kind is invalid');
  }
  if (workbook.Workbook?.WBProps?.date1904 === true) {
    fail('STATEMENT_GENERATION_WORKBOOK_CELL_INVALID', 'Statement workbook date system is invalid');
  }
  const worksheet = workbook.Sheets[descriptor.sheetName];
  const range = worksheet && worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null;
  const expectedEndRow = descriptor.kind === 'balance'
    ? Math.max(descriptor.rowCounts.output, 1)
    : descriptor.rowCounts.output;
  if (!range || range.s.r !== 0 || range.s.c !== 0 ||
      range.e.c !== descriptor.headers.length - 1 || range.e.r !== expectedEndRow) {
    fail(
      'STATEMENT_GENERATION_ROW_COUNTS_MISMATCH',
      `Statement ${descriptor.kind} workbook range/rowCounts mismatch (${worksheet?.['!ref'] || 'none'})`
    );
  }
  validateWorksheetBounds(worksheet, range, descriptor);
  const actualHeaders = descriptor.headers.map((_header, column) => {
    const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    if (!cell || cell.t !== 's') return null;
    return String(cell.v);
  });
  if (actualHeaders.some((header, index) => header !== descriptor.headers[index])) {
    fail('STATEMENT_GENERATION_WORKBOOK_HEADERS_INVALID', 'Statement workbook headers mismatch');
  }
  if (!workbook.Props || workbook.Props.LastAuthor !== descriptor.lineage.watermarkAuthor) {
    fail('STATEMENT_GENERATION_WORKBOOK_WATERMARK_INVALID', 'Statement workbook watermark is invalid');
  }
  const styles = headerStyleIndexes(workbook);
  validateHeaderFont(workbook, styles, descriptor.headers);
  if (descriptor.kind === 'detail') {
    validateDetailHeaderStyles(workbook, styles, descriptor.headers);
  }
  validateTemplateLineage(workbook, descriptor, balanceTemplatePath);

  const accumulator = createBusinessEvidenceAccumulator(
    descriptor.kind,
    descriptor.headers,
    { excelSerialDates: true }
  );
  for (let row = 1; row <= descriptor.rowCounts.output; row += 1) {
    const cells = descriptor.headers.map((_header, column) =>
      worksheet[XLSX.utils.encode_cell({ r: row, c: column })] || null);
    validateRecordCells(descriptor.kind, descriptor.headers, cells);
    accumulator.add(cells.map((cell) => isBlankCell(cell) ? '' : cell.v));
  }
  const evidence = accumulator.finish();
  assertEvidenceMatches(evidence, descriptor.businessEvidence);
  return Object.freeze({ evidence });
}

module.exports = {
  BALANCE_PROFILE,
  DETAIL_PROFILE,
  MAX_DESCRIPTOR_BYTES,
  StatementArtifactDescriptorError,
  createMainExpectedArtifactDescriptor,
  createMainExpectedArtifactDescriptors,
  createStatementArtifactLineage,
  createStatementBusinessEvidence,
  fileSha256,
  validateStatementArtifactWorkbook,
  workbookStructure
};
