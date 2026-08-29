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
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    boundedText(currency, `accounts[${index}].currencies[${currencyIndex}]`, { max: 64 }));
  if (new Set(currencies).size !== currencies.length) {
    fail('NEW_ACCOUNT_GENERATION_CURRENCIES_INVALID', `accounts[${index}].currencies存在重复值`);
  }
  return Object.freeze({
    bankName: boundedText(account.bankName, `accounts[${index}].bankName`, { max: 256 }),
    location: boundedText(account.location, `accounts[${index}].location`, { max: 256 }),
    bankAccount: boundedText(account.bankAccount, `accounts[${index}].bankAccount`, { max: 256 }),
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

function projectNewAccountGenerationRecordCount(accounts, asOfDate, options = {}) {
  if (!Array.isArray(accounts)) {
    fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', 'NewAccount账户数组非法');
  }
  const maxRecords = options.maxRecords === undefined ? MAX_RECORDS : options.maxRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    fail('NEW_ACCOUNT_GENERATION_RECORD_LIMIT', 'NewAccount记录数上限非法');
  }
  const yesterdayOrdinal = isoDayOrdinal(asOfDate, 'asOfDate') - 1;
  let projectedRecords = 0;
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (!account || !Array.isArray(account.currencies)) {
      fail('NEW_ACCOUNT_GENERATION_INPUT_INVALID', `accounts[${index}]非法`);
    }
    const openingOrdinal = isoDayOrdinal(account.openingDate, `accounts[${index}].openingDate`);
    const dayCount = yesterdayOrdinal - openingOrdinal + 1;
    if (dayCount <= 0) continue;
    const accountRecords = dayCount * account.currencies.length;
    const nextProjectedRecords = projectedRecords + accountRecords;
    if (!Number.isSafeInteger(accountRecords) || !Number.isSafeInteger(nextProjectedRecords) ||
        nextProjectedRecords > maxRecords) {
      fail('NEW_ACCOUNT_GENERATION_RECORD_LIMIT', 'NewAccount预计记录数超过安全上限');
    }
    projectedRecords = nextProjectedRecords;
  }
  return projectedRecords;
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

function validateNewAccountGenerationResult(value) {
  try {
    const result = exact(value, ['schemaVersion', 'status', 'artifact', 'summary'], 'result');
    if (result.schemaVersion !== NEW_ACCOUNT_GENERATION_SCHEMA_VERSION || result.status !== 'generated') return false;
    const artifact = exact(result.artifact, [
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
    const evidence = exact(
      artifact.businessEvidence,
      ['recordsSha256', 'datesSha256', 'accountsSha256', 'currenciesSha256'],
      'artifact.businessEvidence'
    );
    if (Object.values(evidence).some((digest) => !SHA256.test(digest))) return false;
    const summary = exact(
      result.summary,
      ['accountCount', 'currencyCount', 'dateCount', 'rowCount'],
      'summary'
    );
    if (![summary.accountCount, summary.currencyCount, summary.dateCount, summary.rowCount]
      .every((count) => Number.isSafeInteger(count) && count >= 1) ||
      summary.accountCount > MAX_ACCOUNTS || summary.currencyCount > MAX_ACCOUNTS * MAX_CURRENCIES_PER_ACCOUNT ||
      summary.rowCount !== artifact.rowCount || summary.rowCount > MAX_RECORDS) return false;
    canonicalJsonSnapshot(result, { maxBytes: MAX_RESULT_BYTES });
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  MAX_ACCOUNTS,
  MAX_ARTIFACT_BYTES,
  MAX_CURRENCIES_PER_ACCOUNT,
  MAX_INPUT_BYTES,
  MAX_RECORDS,
  MAX_RESULT_BYTES,
  NEW_ACCOUNT_GENERATION_ACTION,
  NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
  NewAccountGenerationContractError,
  createNewAccountGenerationInput,
  projectNewAccountGenerationRecordCount,
  validateNewAccountGenerationResult
};
