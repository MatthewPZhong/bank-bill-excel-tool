'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { FileValidationError, normalizeCell } = require('../../backend/file-service/common');
const {
  locateSheets,
  openZipWithEntries
} = require('../../backend/big-table-import/zip-reader');
const { extractHeaders } = require('../../backend/file-service/readers');
const { parseDateValue, parseNumericValue } = require('../../backend/file-service/normalizers');
const { writeBalanceWorkbook } = require('../../backend/file-service');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const { validateTaskOwnedStagingPath } = require('../statement-worker/staging-ownership');
const {
  MAX_RECORDS,
  NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
  createNewAccountGenerationInput
} = require('./generation-contract');
const {
  loadNewAccountSharedStrings,
  scanNewAccountWorksheetRows
} = require('./strict-worksheet-readback');

const REQUIRED_HEADERS = Object.freeze([
  '银行名称', '所在地', '币种', '银行账号', '账单日期',
  '期初余额', '期初可用余额', '期末余额', '期末可用余额'
]);
const AMOUNT_HEADERS = new Set(['期初余额', '期初可用余额', '期末余额', '期末可用余额']);
const TEMPLATE_BASENAME = '余额账单模版.xlsx';
const NEW_ACCOUNT_EXPORT_NAME = 'NEW_BALANCE';
const READBACK_ROW_BATCH_SIZE = 1024;
const READBACK_EVIDENCE_BATCH_SIZE = 1024;
const READBACK_HASH_SAFEPOINT_BYTES = 4 * 1024 * 1024;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildNewAccountBillDates(openDate, today = new Date()) {
  const normalizedOpenDate = normalizeDateOnly(openDate);
  const normalizedToday = normalizeDateOnly(today);
  const yesterday = new Date(normalizedToday.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  if (normalizedOpenDate.getTime() > yesterday.getTime()) {
    throw new FileValidationError('FILE_READ', '开户日期不能晚于昨日');
  }
  const totalDays = Math.round(
    (yesterday.getTime() - normalizedOpenDate.getTime()) / (24 * 60 * 60 * 1000)
  ) + 1;
  if (totalDays > 3650) {
    throw new FileValidationError('FILE_READ', '开户日期距今超过 10 年，不支持生成');
  }
  const dates = [];
  let cursor = new Date(normalizedOpenDate.getTime());
  while (cursor.getTime() <= yesterday.getTime()) {
    dates.push(normalizeDateOnly(new Date(cursor.getTime())));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function normalizeNewAccountCurrencyValues({ currency, currencies = [], isMultiCurrency = false }) {
  return Array.from(new Set(
    ((isMultiCurrency && Array.isArray(currencies) && currencies.length) ? currencies : [currency])
      .map((value) => normalizeCell(value))
      .filter((value) => value !== '')
  ));
}

function normalizeNewAccountAccounts(payload = {}) {
  const rawAccounts = Array.isArray(payload.accounts) && payload.accounts.length
    ? payload.accounts
    : [{
        bankName: payload.bankName,
        location: payload.location,
        currency: payload.currency,
        currencies: payload.currencies,
        bankAccount: payload.bankAccount,
        openingDate: payload.openingDate,
        isMultiCurrency: payload.isMultiCurrency
      }];
  return rawAccounts.map((item) => ({
    bankName: normalizeCell(item.bankName),
    location: normalizeCell(item.location),
    currency: normalizeCell(item.currency),
    currencies: Array.isArray(item.currencies) ? item.currencies.map((value) => normalizeCell(value)) : [],
    bankAccount: normalizeCell(item.bankAccount),
    openingDateRaw: normalizeCell(item.openingDate),
    openingDate: parseDateValue(item.openingDate),
    isMultiCurrency: Boolean(item.isMultiCurrency)
  }));
}

function validateNewAccountAccounts(accounts) {
  const detailLines = [];
  accounts.forEach((account, index) => {
    const missingFields = [
      ['银行名称', account.bankName], ['所在地', account.location],
      ['银行账号', account.bankAccount], ['开户日期', account.openingDateRaw]
    ].filter(([, value]) => !value);
    if (!account.isMultiCurrency && !account.currency) missingFields.push(['币种', '']);
    if (missingFields.length) {
      detailLines.push(`${index + 1}. 缺少字段：${missingFields.map(([label]) => label).join('、')}`);
      return;
    }
    const currencies = normalizeNewAccountCurrencyValues(account);
    if (account.isMultiCurrency && currencies.length === 0) {
      detailLines.push(`${index + 1}. 多币种账户至少需要勾选一个币种`);
    } else if (!account.openingDate) {
      detailLines.push(`${index + 1}. 开户日期不是有效日期`);
    }
  });
  if (detailLines.length) {
    throw new FileValidationError('NEW_ACCOUNT_REQUIRED', '请完整填写所有必填项', { detailLines });
  }
  return accounts;
}

function buildBalanceTemplateRow(balanceTemplateFields, valuesByField) {
  const normalizedValues = new Map(
    Object.entries(valuesByField).map(([fieldName, value]) => [normalizeCell(fieldName), value])
  );
  return balanceTemplateFields.map((fieldName) => {
    const normalizedField = normalizeCell(fieldName);
    return normalizedValues.has(normalizedField) ? normalizedValues.get(normalizedField) : '';
  });
}

function buildNewAccountBalanceRecords({
  accounts = [],
  balanceTemplateFields,
  today = new Date(),
  maxRecords = Number.POSITIVE_INFINITY
}) {
  const records = [];
  const generated = visitNewAccountBalanceRecords({
    accounts,
    balanceTemplateFields,
    today,
    maxRecords,
    onRecord(record) {
      records.push(record);
    }
  });
  return { records, billDates: generated.billDates, currencies: generated.currencies };
}

function visitNewAccountBalanceRecords({
  accounts = [],
  balanceTemplateFields,
  today = new Date(),
  maxRecords = Number.POSITIVE_INFINITY,
  onRecord
}) {
  const allBillDates = new Set();
  const allCurrencies = new Set();
  let rowCount = 0;
  accounts.forEach((account) => {
    const billDates = buildNewAccountBillDates(account.openingDate, today);
    const currencies = normalizeNewAccountCurrencyValues(account);
    if (!currencies.length) throw new FileValidationError('FILE_READ', '至少需要提供一个币种');
    if (rowCount + billDates.length * currencies.length > maxRecords) {
      const error = new FileValidationError('NEW_ACCOUNT_RECORD_LIMIT', '新开账户余额记录数量超过安全上限');
      error.code = 'NEW_ACCOUNT_RECORD_LIMIT';
      throw error;
    }
    for (const billDate of billDates) {
      const billDateLabel = formatDateLabel(billDate);
      allBillDates.add(billDateLabel);
      for (const currency of currencies) {
        allCurrencies.add(currency);
        const record = buildBalanceTemplateRow(balanceTemplateFields, {
          银行名称: account.bankName,
          所在地: account.location,
          币种: currency,
          银行账号: account.bankAccount,
          账单日期: billDateLabel,
          期初余额: '',
          期初可用余额: '',
          期末余额: 0,
          期末可用余额: ''
        });
        onRecord(record, rowCount);
        rowCount += 1;
      }
    }
  });
  return {
    rowCount,
    billDates: Array.from(allBillDates).sort(),
    currencies: Array.from(allCurrencies)
  };
}

function sanitizeFileName(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
}

function buildNewAccountOutputName(accounts, currencies) {
  const primary = accounts[0];
  let accountSegment;
  let currencySegment;
  if (accounts.length === 1) {
    accountSegment = primary.bankAccount.length > 4 ? primary.bankAccount.slice(-4) : primary.bankAccount;
    currencySegment = currencies.length > 1 ? '多币种' : (currencies[0] || '');
  } else {
    accountSegment = '多账号';
    currencySegment = '多币种';
  }
  const fileName = sanitizeFileName([
    primary.bankName, primary.location, accountSegment, currencySegment, NEW_ACCOUNT_EXPORT_NAME
  ].filter(Boolean).join('-')) + '.xlsx';
  return { fileName, accountSegment, currencySegment };
}

function prepareNewAccountGeneration({
  payload,
  accounts: rawAccounts,
  balanceTemplateFields,
  today = new Date(),
  maxRecords = Number.POSITIVE_INFINITY
}) {
  const accounts = rawAccounts
    ? rawAccounts.map((account) => ({
        ...account,
        openingDateRaw: normalizeCell(account.openingDateRaw || account.openingDate),
        openingDate: account.openingDate instanceof Date ? account.openingDate : parseDateValue(account.openingDate)
      }))
    : normalizeNewAccountAccounts(payload);
  validateNewAccountAccounts(accounts);
  const generated = buildNewAccountBalanceRecords({ accounts, balanceTemplateFields, today, maxRecords });
  return Object.freeze({
    accounts,
    records: generated.records,
    billDates: generated.billDates,
    currencies: generated.currencies,
    ...buildNewAccountOutputName(accounts, generated.currencies)
  });
}

function createExpectedNewAccountArtifactDescriptor({
  input,
  headers,
  sheetNames
}) {
  const accounts = normalizedExpectedArtifactAccounts(input);
  const accumulator = createBusinessEvidenceAccumulator(headers);
  const generated = visitNewAccountBalanceRecords({
    accounts,
    balanceTemplateFields: headers,
    today: parseDateValue(input.asOfDate),
    maxRecords: MAX_RECORDS,
    onRecord(record) {
      accumulator.add(record);
    }
  });
  return finishExpectedNewAccountArtifactDescriptor({
    input,
    headers,
    sheetNames,
    accounts,
    generated,
    businessEvidence: accumulator.finish()
  });
}

function normalizedExpectedArtifactAccounts(input) {
  const accounts = input.accounts.map((account) => ({
    ...account,
    currency: account.currencies[0],
    isMultiCurrency: account.currencies.length > 1,
    openingDateRaw: account.openingDate,
    openingDate: parseDateValue(account.openingDate)
  }));
  validateNewAccountAccounts(accounts);
  return accounts;
}

function finishExpectedNewAccountArtifactDescriptor({
  input,
  headers,
  sheetNames,
  accounts,
  generated,
  businessEvidence: expectedBusinessEvidence
}) {
  const output = buildNewAccountOutputName(accounts, generated.currencies);
  const expectedUsedRange = `A1:${XLSX.utils.encode_col(headers.length - 1)}${generated.rowCount + 1}`;
  const expectedDimensionRange = `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(2, generated.rowCount + 1)}`;
  return Object.freeze({
    artifactKey: input.generation.artifactKey,
    fileName: output.fileName,
    templateSha256: input.template.sha256,
    sheetNames: Object.freeze(sheetNames.slice()),
    headers: Object.freeze(headers.slice()),
    rowCount: generated.rowCount,
    worksheetAuthority: Object.freeze({
      expectedColumnCount: headers.length,
      expectedUsedRange,
      expectedDimensionRange,
      forbidDynamicContent: true
    }),
    businessEvidence: expectedBusinessEvidence,
    summary: Object.freeze({
      accountCount: accounts.length,
      currencyCount: accounts.reduce((sum, account) => sum + account.currencies.length, 0),
      dateCount: generated.billDates.length,
      rowCount: generated.rowCount
    })
  });
}

async function createExpectedNewAccountArtifactDescriptorCooperatively({
  input,
  headers,
  sheetNames,
  signal = null,
  batchSize = 1024,
  scheduler = () => new Promise((resolve) => setImmediate(resolve)),
  onProgress = null
}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || typeof scheduler !== 'function') {
    throw new TypeError('NewAccount Main authority cooperative参数非法');
  }
  assertNewAccountGenerationNotCancelled(signal);
  const accounts = normalizedExpectedArtifactAccounts(input);
  const accumulator = createBusinessEvidenceAccumulator(headers);
  const allBillDates = new Set();
  const allCurrencies = new Set();
  const today = parseDateValue(input.asOfDate);
  let rowCount = 0;
  for (const account of accounts) {
    const billDates = buildNewAccountBillDates(account.openingDate, today);
    const currencies = normalizeNewAccountCurrencyValues(account);
    if (!currencies.length) throw new FileValidationError('FILE_READ', '至少需要提供一个币种');
    if (rowCount + billDates.length * currencies.length > MAX_RECORDS) {
      const error = new FileValidationError('NEW_ACCOUNT_RECORD_LIMIT', '新开账户余额记录数量超过安全上限');
      error.code = 'NEW_ACCOUNT_RECORD_LIMIT';
      throw error;
    }
    for (const billDate of billDates) {
      const billDateLabel = formatDateLabel(billDate);
      allBillDates.add(billDateLabel);
      for (const currency of currencies) {
        allCurrencies.add(currency);
        accumulator.add(buildBalanceTemplateRow(headers, {
          银行名称: account.bankName,
          所在地: account.location,
          币种: currency,
          银行账号: account.bankAccount,
          账单日期: billDateLabel,
          期初余额: '',
          期初可用余额: '',
          期末余额: 0,
          期末可用余额: ''
        }));
        rowCount += 1;
        if (rowCount % batchSize === 0) {
          if (typeof onProgress === 'function') onProgress(Object.freeze({ rowCount }));
          await scheduler();
          assertNewAccountGenerationNotCancelled(signal);
        }
      }
    }
  }
  if (rowCount % batchSize !== 0) {
    if (typeof onProgress === 'function') onProgress(Object.freeze({ rowCount }));
    await scheduler();
    assertNewAccountGenerationNotCancelled(signal);
  }
  return finishExpectedNewAccountArtifactDescriptor({
    input,
    headers,
    sheetNames,
    accounts,
    generated: {
      rowCount,
      billDates: Array.from(allBillDates).sort(),
      currencies: Array.from(allCurrencies)
    },
    businessEvidence: accumulator.finish()
  });
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function fileSha256Cooperatively(filePath, signal, options = {}) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  let bytesSinceSafePoint = 0;
  try {
    for await (const chunk of stream) {
      assertNewAccountGenerationNotCancelled(signal);
      hash.update(chunk);
      bytesSinceSafePoint += chunk.length;
      if (bytesSinceSafePoint >= READBACK_HASH_SAFEPOINT_BYTES) {
        bytesSinceSafePoint = 0;
        await runNewAccountGenerationStage(signal, options, 'readback:artifact-hash-batch');
      }
    }
    await runNewAccountGenerationStage(signal, options, 'readback:artifact-hash-complete');
    return hash.digest('hex');
  } finally {
    stream.destroy();
  }
}

function assertTemplateEvidence(template, allowedTemplatePath) {
  const resolved = path.resolve(template.filePath);
  const allowed = path.resolve(allowedTemplatePath);
  if (resolved !== allowed || path.basename(resolved) !== TEMPLATE_BASENAME) {
    const error = new Error('NewAccount模板不在冻结白名单');
    error.code = 'NEW_ACCOUNT_TEMPLATE_NOT_ALLOWED';
    throw error;
  }
  const lstat = fs.lstatSync(resolved, { bigint: true });
  if (lstat.isSymbolicLink() || !lstat.isFile() || !sourceSnapshotMatchesStat(template.snapshot, lstat) ||
      fileSha256(resolved) !== template.sha256) {
    const error = new Error('NewAccount模板证据已变化');
    error.code = 'NEW_ACCOUNT_TEMPLATE_CHANGED';
    throw error;
  }
}

function canonicalBusinessValue(header, value) {
  if (header === '账单日期') {
    const date = parseDateValue(value);
    return date ? formatDateLabel(date) : '';
  }
  if (AMOUNT_HEADERS.has(header)) {
    const amount = parseNumericValue(value);
    return amount === null ? '' : amount;
  }
  return normalizeCell(value);
}

function canonicalBusinessScalar(value) {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw Object.assign(new Error('业务证据包含未配对的高位代理项'), {
            code: 'CANONICAL_JSON_INVALID_SURROGATE'
          });
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw Object.assign(new Error('业务证据包含未配对的低位代理项'), {
          code: 'CANONICAL_JSON_INVALID_SURROGATE'
        });
      }
    }
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error('业务证据数字必须有限'), {
        code: 'CANONICAL_JSON_NUMBER_INVALID'
      });
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw Object.assign(new Error('业务证据整数超出安全范围'), {
        code: 'CANONICAL_JSON_INTEGER_UNSAFE'
      });
    }
  } else {
    throw Object.assign(new Error('业务证据只允许规范化字符串或数字'), {
      code: 'CANONICAL_JSON_VALUE_INVALID'
    });
  }
  return JSON.stringify(value);
}

function createBusinessEvidenceAccumulator(headers) {
  const indexes = {
    dates: headers.map((header, index) => header === '账单日期' ? index : -1).filter((index) => index >= 0),
    accounts: headers.map((header, index) => header === '银行账号' ? index : -1).filter((index) => index >= 0),
    currencies: headers.map((header, index) => header === '币种' ? index : -1).filter((index) => index >= 0)
  };
  const streams = {
    records: crypto.createHash('sha256'),
    dates: crypto.createHash('sha256'),
    accounts: crypto.createHash('sha256'),
    currencies: crypto.createHash('sha256')
  };
  Object.values(streams).forEach((stream) => stream.update('['));
  let rowCount = 0;
  let finished = false;

  return Object.freeze({
    add(row) {
      if (finished || !Array.isArray(row)) {
        throw new TypeError('NewAccount业务证据累加器状态非法');
      }
      const canonicalTokens = row.map((value, index) => (
        canonicalBusinessScalar(canonicalBusinessValue(headers[index], value))
      ));
      const separator = rowCount === 0 ? '' : ',';
      streams.records.update(`${separator}[${canonicalTokens.join(',')}]`);
      for (const key of ['dates', 'accounts', 'currencies']) {
        streams[key].update(`${separator}[${indexes[key].map((index) => canonicalTokens[index]).join(',')}]`);
      }
      rowCount += 1;
    },
    finish() {
      if (finished) throw new TypeError('NewAccount业务证据累加器不能重复结束');
      finished = true;
      Object.values(streams).forEach((stream) => stream.update(']'));
      return Object.freeze({
        recordsSha256: streams.records.digest('hex'),
        datesSha256: streams.dates.digest('hex'),
        accountsSha256: streams.accounts.digest('hex'),
        currenciesSha256: streams.currencies.digest('hex')
      });
    }
  });
}

function businessEvidence(headers, records) {
  const accumulator = createBusinessEvidenceAccumulator(headers);
  for (const row of records) accumulator.add(row);
  return accumulator.finish();
}

// 保留给 legacy/golden 的同步对照 oracle；真实 Worker 只调用下方 cooperative stream 版本。
function readBackAndValidate(filePath, expected) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: true, cellStyles: true, raw: true });
  const expectedSheetNames = Array.isArray(expected.sheetNames)
    ? expected.sheetNames
    : [expected.sheetName];
  if (canonicalSha256(workbook.SheetNames) !== canonicalSha256(expectedSheetNames)) {
    throw Object.assign(new Error('NewAccount输出 Sheet 与模板不一致'), { code: 'NEW_ACCOUNT_WORKBOOK_SHEET_MISMATCH' });
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1, blankrows: false, defval: '', raw: true
  });
  const headers = (rows[0] || []).slice(0, expected.headers.length).map(normalizeCell);
  if (canonicalSha256(headers) !== canonicalSha256(expected.headers)) {
    throw Object.assign(new Error('NewAccount输出列顺序与模板不一致'), { code: 'NEW_ACCOUNT_WORKBOOK_HEADERS_MISMATCH' });
  }
  const actualRecords = rows.slice(1).map((row) => {
    const normalized = row.slice(0, headers.length);
    while (normalized.length < headers.length) normalized.push('');
    return normalized;
  });
  const actualEvidence = businessEvidence(headers, actualRecords);
  const expectedEvidence = businessEvidence(headers, expected.records);
  if (actualRecords.length !== expected.records.length ||
      Object.keys(expectedEvidence).some((key) => actualEvidence[key] !== expectedEvidence[key])) {
    throw Object.assign(new Error('NewAccount输出业务记录回读不一致'), { code: 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH' });
  }
  return {
    headers,
    rowCount: actualRecords.length,
    businessEvidence: actualEvidence,
    sheetNames: workbook.SheetNames.slice(),
    sheetCount: workbook.SheetNames.length
  };
}

async function runNewAccountGenerationStage(signal, options, stage, details = {}) {
  // 仅供模块内真实 Worker 阶段探针使用；stage/details 不进入 input/result/Protocol。
  if (typeof options.readbackStageHook === 'function') {
    await options.readbackStageHook(stage, Object.freeze({ ...details }));
  }
  await newAccountGenerationCancellationSafePoint(signal);
}

async function businessEvidenceInBatches(headers, records, signal, options, side) {
  const accumulator = createBusinessEvidenceAccumulator(headers);
  for (let index = 0; index < records.length; index += 1) {
    accumulator.add(records[index]);
    if ((index + 1) % READBACK_EVIDENCE_BATCH_SIZE === 0) {
      await runNewAccountGenerationStage(signal, options, 'readback:evidence-batch', {
        side,
        processedRows: index + 1,
        totalRows: records.length
      });
    }
  }
  await runNewAccountGenerationStage(signal, options, 'readback:evidence-complete', {
    side,
    processedRows: records.length,
    totalRows: records.length
  });
  return accumulator.finish();
}

function openZipEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function workbookRecordMismatch() {
  return Object.assign(new Error('NewAccount输出业务记录回读不一致'), {
    code: 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH'
  });
}

function assertNoDynamicWorkbookPackage(entries) {
  for (const entryName of entries.keys()) {
    if (entryName === 'xl/calcChain.xml' || entryName.startsWith('xl/externalLinks/')) {
      throw Object.assign(new Error('NewAccount输出包含Main authority禁止的动态workbook内容'), {
        code: 'NEW_ACCOUNT_WORKBOOK_DYNAMIC_CONTENT_FORBIDDEN'
      });
    }
  }
}

async function readBackAndValidateCooperatively(filePath, expected, signal, options = {}) {
  const expectedRecords = Array.isArray(expected && expected.records) ? expected.records : null;
  const expectedRowCount = expectedRecords
    ? expectedRecords.length
    : Number(expected && expected.rowCount);
  const expectedBusinessEvidence = expectedRecords ? null : expected && expected.businessEvidence;
  const worksheetAuthority = expected && expected.worksheetAuthority;
  const expectedSheetNames = Array.isArray(expected && expected.sheetNames)
    ? expected.sheetNames
    : [expected && expected.sheetName];
  if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0 ||
      expectedSheetNames.length < 1 ||
      expectedSheetNames.some((name) => typeof name !== 'string' || name.length === 0) ||
      (!expectedRecords && (!expectedBusinessEvidence ||
        !['recordsSha256', 'datesSha256', 'accountsSha256', 'currenciesSha256'].every(
          (key) => typeof expectedBusinessEvidence[key] === 'string' &&
            /^[0-9a-f]{64}$/.test(expectedBusinessEvidence[key])
        ))) || (worksheetAuthority && (
        worksheetAuthority.expectedColumnCount !== expected.headers.length ||
        typeof worksheetAuthority.expectedUsedRange !== 'string' ||
        typeof worksheetAuthority.expectedDimensionRange !== 'string' ||
        worksheetAuthority.forbidDynamicContent !== true
      ))) {
    throw Object.assign(new Error('NewAccount输出预期业务证据非法'), {
      code: 'NEW_ACCOUNT_WORKBOOK_EXPECTED_EVIDENCE_INVALID'
    });
  }
  const sourceFile = path.basename(filePath);
  let zip = null;
  try {
    const opened = await openZipWithEntries(sourceFile, filePath, { rejectDuplicateEntries: true });
    zip = opened.zip;
    if (worksheetAuthority && worksheetAuthority.forbidDynamicContent) {
      assertNoDynamicWorkbookPackage(opened.entries);
    }
    await runNewAccountGenerationStage(signal, options, 'readback:workbook-opened', {
      zipEntryCount: opened.entries.size
    });

    const sheets = await locateSheets(zip, opened.entries);
    const actualSheetNames = sheets.map((sheet) => sheet.name);
    if (canonicalSha256(actualSheetNames) !== canonicalSha256(expectedSheetNames) ||
        !sheets[0].entryPath) {
      throw Object.assign(new Error('NewAccount输出 Sheet 与模板不一致'), {
        code: 'NEW_ACCOUNT_WORKBOOK_SHEET_MISMATCH'
      });
    }
    const sheetEntry = opened.entries.get(sheets[0].entryPath);
    if (!sheetEntry) {
      throw Object.assign(new Error('NewAccount输出 Sheet 与模板不一致'), {
        code: 'NEW_ACCOUNT_WORKBOOK_SHEET_MISMATCH'
      });
    }
    await runNewAccountGenerationStage(signal, options, 'readback:sheet-located', {
      sheetCount: sheets.length
    });

    const sharedStrings = await loadNewAccountSharedStrings(
      zip,
      opened.entries.get('xl/sharedStrings.xml') || null,
      { assertNotCancelled: () => assertNewAccountGenerationNotCancelled(signal) }
    );
    await runNewAccountGenerationStage(signal, options, 'readback:shared-strings-loaded', {
      sharedStringCount: sharedStrings.length
    });

    const stream = await openZipEntryStream(zip, sheetEntry);
    let headers = null;
    let actualRowCount = 0;
    let actualAccumulator = null;
    await scanNewAccountWorksheetRows({
      stream,
      expectedColumnCount: expected.headers.length,
      expectedUsedRange: worksheetAuthority && worksheetAuthority.expectedUsedRange,
      expectedDimensionRange: worksheetAuthority && worksheetAuthority.expectedDimensionRange,
      forbidDynamicContent: Boolean(worksheetAuthority && worksheetAuthority.forbidDynamicContent),
      sharedStrings,
      rowBatchSize: READBACK_ROW_BATCH_SIZE,
      assertNotCancelled: () => assertNewAccountGenerationNotCancelled(signal),
      onRow({ rowNumber, values, hasAnyCellValue }) {
        if (rowNumber === 1) {
          headers = values.map(normalizeCell);
          if (canonicalSha256(headers) !== canonicalSha256(expected.headers)) {
            throw Object.assign(new Error('NewAccount输出列顺序与模板不一致'), {
              code: 'NEW_ACCOUNT_WORKBOOK_HEADERS_MISMATCH'
            });
          }
          actualAccumulator = createBusinessEvidenceAccumulator(headers);
          return;
        }
        if (!hasAnyCellValue) return;
        if (!headers || !actualAccumulator) {
          throw Object.assign(new Error('NewAccount输出列顺序与模板不一致'), {
            code: 'NEW_ACCOUNT_WORKBOOK_HEADERS_MISMATCH'
          });
        }
        const normalized = values;
        actualAccumulator.add(normalized);
        actualRowCount += 1;
        if (actualRowCount > expectedRowCount) throw workbookRecordMismatch();
      },
      async onRowBatch({ parsedRows, lastRowNumber }) {
        await runNewAccountGenerationStage(
          signal,
          options,
          'readback:row-batch',
          {
            processedRows: actualRowCount,
            parsedRows,
            lastRowNumber,
            totalRows: expectedRowCount
          }
        );
      }
    });
    await runNewAccountGenerationStage(signal, options, 'readback:row-scan-complete', {
      processedRows: actualRowCount,
      totalRows: expectedRowCount
    });
    if (!headers || !actualAccumulator || actualRowCount !== expectedRowCount) {
      throw workbookRecordMismatch();
    }

    const actualEvidence = actualAccumulator.finish();
    const expectedEvidence = expectedRecords
      ? await businessEvidenceInBatches(
          headers,
          expectedRecords,
          signal,
          options,
          'expected'
        )
      : expectedBusinessEvidence;
    if (Object.keys(expectedEvidence).some((key) => actualEvidence[key] !== expectedEvidence[key])) {
      throw workbookRecordMismatch();
    }
    return {
      headers,
      rowCount: actualRowCount,
      businessEvidence: actualEvidence,
      sheetNames: actualSheetNames,
      sheetCount: actualSheetNames.length
    };
  } finally {
    if (zip) {
      try { zip.close(); } catch (_) {}
    }
  }
}

function assertRequiredTemplateHeaders(headers) {
  if (new Set(headers).size !== headers.length || REQUIRED_HEADERS.some((header) => !headers.includes(header))) {
    throw new FileValidationError('BALANCE_TEMPLATE_INVALID', '余额账单模板缺少必需列或存在重复列');
  }
}

function assertNewAccountGenerationNotCancelled(signal) {
  if (signal && signal.aborted) {
    const error = new Error('新开账户余额账单生成已取消');
    error.code = 'NEW_ACCOUNT_GENERATION_CANCELLED';
    throw error;
  }
}

async function newAccountGenerationCancellationSafePoint(signal) {
  // 同步 writer 与各有界批次之间先让出一轮 Worker 消息循环，
  // shutdown-only job:cancel 才能到达 AbortController，然后再决定是否继续。
  await new Promise((resolve) => setImmediate(resolve));
  assertNewAccountGenerationNotCancelled(signal);
}

async function executeNewAccountGeneration(rawInput, signal, options = {}) {
  const input = createNewAccountGenerationInput(rawInput);
  const allowedTemplatePath = options.allowedTemplatePath;
  assertNewAccountGenerationNotCancelled(signal);
  assertTemplateEvidence(input.template, allowedTemplatePath);
  validateTaskOwnedStagingPath({
    stagingRoot: input.generation.stagingRoot,
    candidatePath: input.generation.generationPath,
    finalState: 'missing'
  });
  const headers = extractHeaders(input.template.filePath);
  assertRequiredTemplateHeaders(headers);
  const workbook = XLSX.readFile(input.template.filePath, { raw: true });
  const sheetName = workbook.SheetNames[0];
  const today = parseDateValue(input.asOfDate);
  const accounts = input.accounts.map((account) => ({
    ...account,
    currency: account.currencies[0],
    isMultiCurrency: account.currencies.length > 1,
    openingDateRaw: account.openingDate,
    openingDate: parseDateValue(account.openingDate)
  }));
  const prepared = prepareNewAccountGeneration({
    accounts,
    balanceTemplateFields: headers,
    today,
    maxRecords: MAX_RECORDS
  });
  await newAccountGenerationCancellationSafePoint(signal);
  const reservation = fs.openSync(input.generation.generationPath, 'wx', 0o600);
  fs.closeSync(reservation);
  writeBalanceWorkbook({
    templateFilePath: input.template.filePath,
    records: prepared.records,
    templateFields: headers,
    outputFilePath: input.generation.generationPath
  });
  await newAccountGenerationCancellationSafePoint(signal);
  assertTemplateEvidence(input.template, allowedTemplatePath);
  const readback = await readBackAndValidateCooperatively(input.generation.generationPath, {
    sheetNames: workbook.SheetNames, headers, records: prepared.records
  }, signal, options);
  await newAccountGenerationCancellationSafePoint(signal);
  const owned = validateTaskOwnedStagingPath({
    stagingRoot: input.generation.stagingRoot,
    candidatePath: input.generation.generationPath,
    finalState: 'file'
  });
  const byteSize = Number(owned.stat.size);
  const sha256 = await fileSha256Cooperatively(input.generation.generationPath, signal, options);
  await runNewAccountGenerationStage(signal, options, 'terminal:before-result');
  return Object.freeze({
    schemaVersion: NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
    status: 'generated',
    artifact: Object.freeze({
      artifactKey: input.generation.artifactKey,
      fileName: prepared.fileName,
      byteSize,
      sha256,
      sheetName,
      headers: Object.freeze(readback.headers),
      rowCount: readback.rowCount,
      templateSha256: input.template.sha256,
      businessEvidence: readback.businessEvidence
    }),
    summary: Object.freeze({
      accountCount: accounts.length,
      currencyCount: accounts.reduce((sum, account) => sum + account.currencies.length, 0),
      dateCount: prepared.billDates.length,
      rowCount: readback.rowCount
    })
  });
}

function createTemplateEvidence(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw Object.assign(new Error('NewAccount模板必须是普通文件'), { code: 'NEW_ACCOUNT_TEMPLATE_INVALID' });
  }
  return Object.freeze({
    filePath: path.resolve(filePath),
    snapshot: Object.freeze(sourceSnapshotFromStat(stat)),
    sha256: fileSha256(filePath)
  });
}

module.exports = {
  NEW_ACCOUNT_EXPORT_NAME,
  REQUIRED_HEADERS,
  buildNewAccountBalanceRecords,
  buildNewAccountBillDates,
  buildNewAccountOutputName,
  businessEvidence,
  createExpectedNewAccountArtifactDescriptor,
  createExpectedNewAccountArtifactDescriptorCooperatively,
  createBusinessEvidenceAccumulator,
  createTemplateEvidence,
  executeNewAccountGeneration,
  fileSha256,
  formatDateLabel,
  newAccountGenerationCancellationSafePoint,
  normalizeNewAccountAccounts,
  normalizeNewAccountCurrencyValues,
  prepareNewAccountGeneration,
  readBackAndValidate,
  readBackAndValidateCooperatively,
  validateNewAccountAccounts
};
