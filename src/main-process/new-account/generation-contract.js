'use strict';

const path = require('node:path');

const { normalizeSourceSnapshot } = require('../archive-center/source-snapshot');
const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { isValidTaskStagingResourceId, resolveTaskStagingResource } = require('../statement-worker/staging-ownership');

const NEW_ACCOUNT_GENERATION_ACTION = 'new-account:generate';
const NEW_ACCOUNT_GENERATION_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 64;
const MAX_CURRENCIES_PER_ACCOUNT = 64;
const MAX_RECORDS = 250000;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const NEW_ACCOUNT_GENERATION_SHAPE_LIMITS = Object.freeze({
  bankNameCodeUnits: 256,
  locationCodeUnits: 256,
  bankAccountCodeUnits: 256,
  currencyCodeUnits: 64,
  outputCellsPerRecord: 9,
  outputDateUtf8Bytes: 10,
  outputDateUtf16Bytes: 20,
  maxUtf8BytesPerCodeUnit: 3,
  maxCellEncodedUtf8BytesPerCodeUnit: 7
});
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NEW_ACCOUNT_FINANCE_SAFE_DIGEST_PATHS = Object.freeze({
  '/payload/result/artifact/templateSha256': 'templateSha256',
  '/payload/result/artifact/businessEvidence/recordsSha256': 'recordsSha256',
  '/payload/result/artifact/businessEvidence/datesSha256': 'datesSha256',
  '/payload/result/artifact/businessEvidence/accountsSha256': 'accountsSha256',
  '/payload/result/artifact/businessEvidence/currenciesSha256': 'currenciesSha256'
});

class NewAccountGenerationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NewAccountGenerationContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NewAccountGenerationContractError(code, message);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('NEW_ACCOUNT_GENERATION_SHAPE_INVALID', `${label}字段非法`);
  }
  return value;
}

function boundedText(value, label, { max = 512, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    fail('NEW_ACCOUNT_GENERATION_VALUE_INVALID', `${label}非法`);
  }
  return value;
}

function absolutePath(value, label) {
  const result = path.normalize(boundedText(value, label, { max: 4096 }));
  if (!path.isAbsolute(result)) fail('NEW_ACCOUNT_GENERATION_PATH_INVALID', `${label}必须是绝对路径`);
  return result;
}

function normalizeAccount(value, index) {
  const account = exact(
    value,
    ['bankName', 'location', 'bankAccount', 'openingDate', 'currencies'],
    `accounts[${index}]`
  );
  if (!ISO_DATE.test(account.openingDate)) {
    fail('NEW_ACCOUNT_GENERATION_DATE_INVALID', `accounts[${index}].openingDate非法`);
  }
  if (!Array.isArray(account.currencies) || account.currencies.length < 1 ||
      account.currencies.length > MAX_CURRENCIES_PER_ACCOUNT) {
    fail('NEW_ACCOUNT_GENERATION_CURRENCIES_INVALID', `accounts[${index}].currencies非法`);
  }
  const currencies = account.currencies.map((currency, currencyIndex) =>
    boundedText(currency, `accounts[${index}].currencies[${currencyIndex}]`, {
      max: NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.currencyCodeUnits
    }));
  if (new Set(currencies).size !== currencies.length) {
    fail('NEW_ACCOUNT_GENERATION_CURRENCIES_INVALID', `accounts[${index}].currencies存在重复值`);
  }
  return Object.freeze({
    bankName: boundedText(account.bankName, `accounts[${index}].bankName`, {
      max: NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.bankNameCodeUnits
    }),
    location: boundedText(account.location, `accounts[${index}].location`, {
      max: NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.locationCodeUnits
    }),
    bankAccount: boundedText(account.bankAccount, `accounts[${index}].bankAccount`, {
      max: NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.bankAccountCodeUnits
    }),
    openingDate: account.openingDate,
    currencies: Object.freeze(currencies)
  });
}

function isoDayOrdinal(value, label) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail('NEW_ACCOUNT_GENERATION_DATE_INVALID', `${label}非法`);
  }
  return Math.floor(date.getTime() / 86400000);
}

function checkedProjectionAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('NEW_ACCOUNT_GENERATION_SHAPE_OVERFLOW', `${label}超过安全整数范围`);
  }
  return value;
}

function checkedProjectionMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('NEW_ACCOUNT_GENERATION_SHAPE_OVERFLOW', `${label}超过安全整数范围`);
  }
  return value;
}

function utf16Bytes(value, label) {
  if (typeof value !== 'string') {
    fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', `${label}非法`);
  }
  return checkedProjectionMultiply(value.length, 2, `${label} UTF-16 bytes`);
}

// SheetJS `escapexml` 对字符串单元格的确定性字节膨胀。这里按原值 UTF-8
// 加实体/控制字符的增量计数，不构造按业务行展开的 XML 字符串。
function cellEncodedUtf8Bytes(value, label) {
  if (typeof value !== 'string') {
    fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', `${label}非法`);
  }
  let bytes = Buffer.byteLength(value);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let expansionBytes = 0;
    if (codeUnit === 0x26) expansionBytes = 4; // &amp;
    else if (codeUnit === 0x3c || codeUnit === 0x3e) expansionBytes = 3; // &lt; / &gt;
    else if (codeUnit === 0x27 || codeUnit === 0x22) expansionBytes = 5; // &apos; / &quot;
    else if (codeUnit <= 0x08 || (codeUnit >= 0x0b && codeUnit <= 0x1f)) {
      expansionBytes = 6; // `_xHHHH_` replaces one ASCII control byte
    }
    bytes = checkedProjectionAdd(bytes, expansionBytes, `${label}单元格编码 bytes`);
  }
  return bytes;
}

function projectNewAccountGenerationShape(accounts, asOfDate, options = {}) {
  if (!Array.isArray(accounts)) {
    fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', 'NewAccount账户数组非法');
  }
  const maxRecords = options.maxRecords === undefined ? MAX_RECORDS : options.maxRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    fail('NEW_ACCOUNT_GENERATION_RECORD_LIMIT', 'NewAccount记录数上限非法');
  }
  const yesterdayOrdinal = isoDayOrdinal(asOfDate, 'asOfDate') - 1;
  let projectedOutputRows = 0;
  let projectedOutputCells = 0;
  let repeatedTextUtf8Bytes = 0;
  let repeatedTextUtf16Bytes = 0;
  let repeatedCellEncodedUtf8Bytes = 0;
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (!account || !Array.isArray(account.currencies) ||
        typeof account.bankName !== 'string' || typeof account.location !== 'string' ||
        typeof account.bankAccount !== 'string') {
      fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', `accounts[${index}]非法`);
    }
    const openingOrdinal = isoDayOrdinal(account.openingDate, `accounts[${index}].openingDate`);
    const dayCount = yesterdayOrdinal - openingOrdinal + 1;
    if (dayCount <= 0) continue;
    const accountRows = checkedProjectionMultiply(
      dayCount,
      account.currencies.length,
      `accounts[${index}]预计记录数`
    );
    projectedOutputRows = checkedProjectionAdd(
      projectedOutputRows,
      accountRows,
      'NewAccount预计记录数'
    );
    if (projectedOutputRows > maxRecords) {
      fail('NEW_ACCOUNT_GENERATION_RECORD_LIMIT', 'NewAccount预计记录数超过安全上限');
    }
    projectedOutputCells = checkedProjectionAdd(
      projectedOutputCells,
      checkedProjectionMultiply(
        accountRows,
        NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputCellsPerRecord,
        `accounts[${index}]预计单元格数`
      ),
      'NewAccount预计单元格数'
    );
    const stableUtf8Bytes = checkedProjectionAdd(
      checkedProjectionAdd(
        Buffer.byteLength(account.bankName),
        Buffer.byteLength(account.location),
        `accounts[${index}]银行/地点 UTF-8 bytes`
      ),
      checkedProjectionAdd(
        Buffer.byteLength(account.bankAccount),
        NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf8Bytes,
        `accounts[${index}]账户/日期 UTF-8 bytes`
      ),
      `accounts[${index}]固定文本 UTF-8 bytes`
    );
    const stableUtf16Bytes = checkedProjectionAdd(
      checkedProjectionAdd(
        utf16Bytes(account.bankName, `accounts[${index}].bankName`),
        utf16Bytes(account.location, `accounts[${index}].location`),
        `accounts[${index}]银行/地点 UTF-16 bytes`
      ),
      checkedProjectionAdd(
        utf16Bytes(account.bankAccount, `accounts[${index}].bankAccount`),
        NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf16Bytes,
        `accounts[${index}]账户/日期 UTF-16 bytes`
      ),
      `accounts[${index}]固定文本 UTF-16 bytes`
    );
    const stableCellEncodedUtf8Bytes = checkedProjectionAdd(
      checkedProjectionAdd(
        cellEncodedUtf8Bytes(account.bankName, `accounts[${index}].bankName`),
        cellEncodedUtf8Bytes(account.location, `accounts[${index}].location`),
        `accounts[${index}]银行/地点单元格编码 bytes`
      ),
      checkedProjectionAdd(
        cellEncodedUtf8Bytes(account.bankAccount, `accounts[${index}].bankAccount`),
        NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf8Bytes,
        `accounts[${index}]账户/日期单元格编码 bytes`
      ),
      `accounts[${index}]固定文本单元格编码 bytes`
    );
    for (let currencyIndex = 0; currencyIndex < account.currencies.length; currencyIndex += 1) {
      const currency = account.currencies[currencyIndex];
      if (typeof currency !== 'string') {
        fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', `accounts[${index}].currencies[${currencyIndex}]非法`);
      }
      const perRowUtf8Bytes = checkedProjectionAdd(
        stableUtf8Bytes,
        Buffer.byteLength(currency),
        `accounts[${index}].currencies[${currencyIndex}]每行 UTF-8 bytes`
      );
      const perRowUtf16Bytes = checkedProjectionAdd(
        stableUtf16Bytes,
        utf16Bytes(currency, `accounts[${index}].currencies[${currencyIndex}]`),
        `accounts[${index}].currencies[${currencyIndex}]每行 UTF-16 bytes`
      );
      const perRowCellEncodedUtf8Bytes = checkedProjectionAdd(
        stableCellEncodedUtf8Bytes,
        cellEncodedUtf8Bytes(currency, `accounts[${index}].currencies[${currencyIndex}]`),
        `accounts[${index}].currencies[${currencyIndex}]每行单元格编码 bytes`
      );
      repeatedTextUtf8Bytes = checkedProjectionAdd(
        repeatedTextUtf8Bytes,
        checkedProjectionMultiply(
          dayCount,
          perRowUtf8Bytes,
          `accounts[${index}].currencies[${currencyIndex}]重复 UTF-8 bytes`
        ),
        'NewAccount重复 UTF-8 bytes'
      );
      repeatedTextUtf16Bytes = checkedProjectionAdd(
        repeatedTextUtf16Bytes,
        checkedProjectionMultiply(
          dayCount,
          perRowUtf16Bytes,
          `accounts[${index}].currencies[${currencyIndex}]重复 UTF-16 bytes`
        ),
        'NewAccount重复 UTF-16 bytes'
      );
      repeatedCellEncodedUtf8Bytes = checkedProjectionAdd(
        repeatedCellEncodedUtf8Bytes,
        checkedProjectionMultiply(
          dayCount,
          perRowCellEncodedUtf8Bytes,
          `accounts[${index}].currencies[${currencyIndex}]重复单元格编码 bytes`
        ),
        'NewAccount重复单元格编码 bytes'
      );
    }
  }
  return Object.freeze({
    projectedOutputRows,
    projectedOutputCells,
    repeatedTextUtf8Bytes,
    repeatedTextUtf16Bytes,
    repeatedCellEncodedUtf8Bytes
  });
}

function projectNewAccountGenerationRecordCount(accounts, asOfDate, options = {}) {
  return projectNewAccountGenerationShape(accounts, asOfDate, options).projectedOutputRows;
}

function createNewAccountGenerationInput(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_INPUT_BYTES });
  const record = exact(
    value,
    ['schemaVersion', 'accounts', 'asOfDate', 'template', 'generation'],
    'NewAccountGenerationInput'
  );
  if (record.schemaVersion !== NEW_ACCOUNT_GENERATION_SCHEMA_VERSION ||
      !Array.isArray(record.accounts) || record.accounts.length < 1 ||
      record.accounts.length > MAX_ACCOUNTS || !ISO_DATE.test(record.asOfDate)) {
    fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', 'NewAccount generation input非法');
  }
  const template = exact(record.template, ['filePath', 'snapshot', 'sha256'], 'template');
  const snapshot = normalizeSourceSnapshot(template.snapshot);
  if (!snapshot || !SHA256.test(template.sha256)) {
    fail('NEW_ACCOUNT_TEMPLATE_EVIDENCE_INVALID', 'NewAccount模板证据非法');
  }
  const generation = exact(
    record.generation,
    ['artifactKey', 'stagingRoot', 'stagingResourceId', 'generationPath'],
    'generation'
  );
  const stagingRoot = absolutePath(generation.stagingRoot, 'generation.stagingRoot');
  const stagingResourceId = boundedText(
    generation.stagingResourceId,
    'generation.stagingResourceId',
    { max: 256 }
  );
  if (!isValidTaskStagingResourceId(stagingResourceId)) {
    fail('NEW_ACCOUNT_GENERATION_PATH_INVALID', 'stagingResourceId非法');
  }
  const generationPath = absolutePath(generation.generationPath, 'generation.generationPath');
  if (resolveTaskStagingResource(stagingRoot, stagingResourceId) !== generationPath) {
    fail('NEW_ACCOUNT_GENERATION_PATH_INVALID', 'generationPath与task staging resource不一致');
  }
  if (path.extname(generationPath).toLowerCase() !== '.xlsx') {
    fail('NEW_ACCOUNT_GENERATION_PATH_INVALID', 'generationPath必须是xlsx文件');
  }
  const accounts = record.accounts.map(normalizeAccount);
  projectNewAccountGenerationRecordCount(accounts, record.asOfDate);
  return Object.freeze({
    schemaVersion: NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
    accounts: Object.freeze(accounts),
    asOfDate: record.asOfDate,
    template: Object.freeze({
      filePath: absolutePath(template.filePath, 'template.filePath'),
      snapshot: Object.freeze(snapshot),
      sha256: template.sha256
    }),
    generation: Object.freeze({
      artifactKey: boundedText(generation.artifactKey, 'generation.artifactKey', { max: 256 }),
      stagingRoot,
      stagingResourceId,
      generationPath
    })
  });
}

function validateNewAccountBusinessEvidence(value) {
  try {
    const evidence = exact(
      value,
      ['recordsSha256', 'datesSha256', 'accountsSha256', 'currenciesSha256'],
      'artifact.businessEvidence'
    );
    return Object.values(evidence).every((digest) => SHA256.test(digest));
  } catch (_error) {
    return false;
  }
}

function validateNewAccountGenerationArtifact(value) {
  try {
    const artifact = exact(value, [
      'artifactKey', 'fileName', 'byteSize', 'sha256', 'sheetName', 'headers',
      'rowCount', 'templateSha256', 'businessEvidence'
    ], 'artifact');
    if (!boundedText(artifact.artifactKey, 'artifact.artifactKey', { max: 256 }) ||
        !boundedText(artifact.fileName, 'artifact.fileName', { max: 1024 }) ||
        path.basename(artifact.fileName) !== artifact.fileName ||
        path.extname(artifact.fileName).toLowerCase() !== '.xlsx' ||
        !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 1 ||
        artifact.byteSize > MAX_ARTIFACT_BYTES || !SHA256.test(artifact.sha256) ||
        !boundedText(artifact.sheetName, 'artifact.sheetName', { max: 128 }) ||
        !Array.isArray(artifact.headers) || artifact.headers.length < 1 || artifact.headers.length > 4096 ||
        artifact.headers.some((header) => typeof header !== 'string' || header.length > 256) ||
        !Number.isSafeInteger(artifact.rowCount) || artifact.rowCount < 1 || artifact.rowCount > MAX_RECORDS ||
        !SHA256.test(artifact.templateSha256)) return false;
    return validateNewAccountBusinessEvidence(artifact.businessEvidence);
  } catch (_error) {
    return false;
  }
}

function validateNewAccountGenerationResult(value) {
  try {
    const result = exact(value, ['schemaVersion', 'status', 'artifact', 'summary'], 'result');
    if (result.schemaVersion !== NEW_ACCOUNT_GENERATION_SCHEMA_VERSION || result.status !== 'generated' ||
        !validateNewAccountGenerationArtifact(result.artifact)) return false;
    const summary = exact(
      result.summary,
      ['accountCount', 'currencyCount', 'dateCount', 'rowCount'],
      'summary'
    );
    if (![summary.accountCount, summary.currencyCount, summary.dateCount, summary.rowCount]
      .every((count) => Number.isSafeInteger(count) && count >= 1) ||
      summary.accountCount > MAX_ACCOUNTS || summary.currencyCount > MAX_ACCOUNTS * MAX_CURRENCIES_PER_ACCOUNT ||
      summary.rowCount !== result.artifact.rowCount || summary.rowCount > MAX_RECORDS) return false;
    canonicalJsonSnapshot(result, { maxBytes: MAX_RESULT_BYTES });
    return true;
  } catch (_error) {
    return false;
  }
}

function allowNewAccountFinanceSafeValue(input = {}) {
  if (!input || typeof input !== 'object') return false;
  const { value, path: valuePath, parent, key } = input;
  const expectedKey = NEW_ACCOUNT_FINANCE_SAFE_DIGEST_PATHS[valuePath];
  if (!expectedKey || key !== expectedKey || typeof value !== 'string' || !SHA256.test(value) ||
      !parent || typeof parent !== 'object' || Array.isArray(parent) || parent[key] !== value) {
    return false;
  }
  if (key === 'templateSha256') return validateNewAccountGenerationArtifact(parent);
  return validateNewAccountBusinessEvidence(parent);
}

Object.defineProperty(validateNewAccountGenerationResult, 'allowFinanceSafeValue', {
  value: allowNewAccountFinanceSafeValue
});

module.exports = {
  MAX_ACCOUNTS,
  MAX_ARTIFACT_BYTES,
  MAX_CURRENCIES_PER_ACCOUNT,
  MAX_INPUT_BYTES,
  MAX_RECORDS,
  MAX_RESULT_BYTES,
  NEW_ACCOUNT_GENERATION_ACTION,
  NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS,
  NewAccountGenerationContractError,
  createNewAccountGenerationInput,
  projectNewAccountGenerationRecordCount,
  projectNewAccountGenerationShape,
  validateNewAccountGenerationResult
};
