'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { FileValidationError, normalizeCell } = require('../../backend/file-service/common');
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

const REQUIRED_HEADERS = Object.freeze([
  '银行名称', '所在地', '币种', '银行账号', '账单日期',
  '期初余额', '期初可用余额', '期末余额', '期末可用余额'
]);
const AMOUNT_HEADERS = new Set(['期初余额', '期初可用余额', '期末余额', '期末可用余额']);
const TEMPLATE_BASENAME = '余额账单模版.xlsx';
const NEW_ACCOUNT_EXPORT_NAME = 'NEW_BALANCE';

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
  const allBillDates = new Set();
  const allCurrencies = new Set();
  accounts.forEach((account) => {
    const billDates = buildNewAccountBillDates(account.openingDate, today);
    const currencies = normalizeNewAccountCurrencyValues(account);
    if (!currencies.length) throw new FileValidationError('FILE_READ', '至少需要提供一个币种');
    if (records.length + billDates.length * currencies.length > maxRecords) {
      const error = new FileValidationError('NEW_ACCOUNT_RECORD_LIMIT', '新开账户余额记录数量超过安全上限');
      error.code = 'NEW_ACCOUNT_RECORD_LIMIT';
      throw error;
    }
    for (const billDate of billDates) {
      const billDateLabel = formatDateLabel(billDate);
      allBillDates.add(billDateLabel);
      for (const currency of currencies) {
        allCurrencies.add(currency);
        records.push(buildBalanceTemplateRow(balanceTemplateFields, {
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
      }
    }
  });
  return { records, billDates: Array.from(allBillDates).sort(), currencies: Array.from(allCurrencies) };
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

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

function businessEvidence(headers, records) {
  const indexes = {
    dates: headers.map((header, index) => header === '账单日期' ? index : -1).filter((index) => index >= 0),
    accounts: headers.map((header, index) => header === '银行账号' ? index : -1).filter((index) => index >= 0),
    currencies: headers.map((header, index) => header === '币种' ? index : -1).filter((index) => index >= 0)
  };
  const canonical = records.map((row) => row.map((value, index) => canonicalBusinessValue(headers[index], value)));
  return Object.freeze({
    recordsSha256: canonicalSha256(canonical),
    datesSha256: canonicalSha256(canonical.map((row) => indexes.dates.map((index) => row[index]))),
    accountsSha256: canonicalSha256(canonical.map((row) => indexes.accounts.map((index) => row[index]))),
    currenciesSha256: canonicalSha256(canonical.map((row) => indexes.currencies.map((index) => row[index])))
  });
}

function readBackAndValidate(filePath, expected) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: true, cellStyles: true, raw: true });
  if (workbook.SheetNames.length < 1 || workbook.SheetNames[0] !== expected.sheetName) {
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
  return { headers, rowCount: actualRecords.length, businessEvidence: actualEvidence };
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
  // XLSX 读写是同步重型阶段；先让出一轮 Worker 消息循环，
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
  const readback = readBackAndValidate(input.generation.generationPath, {
    sheetName, headers, records: prepared.records
  });
  await newAccountGenerationCancellationSafePoint(signal);
  const owned = validateTaskOwnedStagingPath({
    stagingRoot: input.generation.stagingRoot,
    candidatePath: input.generation.generationPath,
    finalState: 'file'
  });
  const byteSize = Number(owned.stat.size);
  const sha256 = fileSha256(input.generation.generationPath);
  await newAccountGenerationCancellationSafePoint(signal);
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
  createTemplateEvidence,
  executeNewAccountGeneration,
  fileSha256,
  formatDateLabel,
  newAccountGenerationCancellationSafePoint,
  normalizeNewAccountAccounts,
  normalizeNewAccountCurrencyValues,
  prepareNewAccountGeneration,
  readBackAndValidate,
  validateNewAccountAccounts
};
