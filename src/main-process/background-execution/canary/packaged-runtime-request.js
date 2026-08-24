'use strict';

const path = require('node:path');

const PACKAGED_CANARY_ENV = 'BACKGROUND_EXECUTION_PACKAGED_CANARY';
const PACKAGED_CANARY_REPORT_PATH_ENV = 'BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH';
const RUNNER_TEMP_ENV = 'RUNNER_TEMP';
const REPORT_MODE = 'packaged-background-execution-canary';
const MAX_REPORT_BYTES = 16 * 1024;
const REPORT_CHECK_KEYS = Object.freeze([
  'durableCrashAfterCommit',
  'productionPoliciesDisabled',
  'quickCheck',
  'shutdownNoLeak',
  'startupExactlyOnce',
  'workerComplete'
]);
const REPORT_KEYS = Object.freeze([
  'appAsar',
  'checks',
  'mode',
  'packaged',
  'schemaVersion',
  'status'
]);

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parsePackagedRuntimeRequest(env = process.env) {
  const mode = env[PACKAGED_CANARY_ENV];
  const reportPathValue = env[PACKAGED_CANARY_REPORT_PATH_ENV];
  if (mode === undefined || mode === '') {
    if (reportPathValue !== undefined && reportPathValue !== '') {
      throw requestError(
        'PACKAGED_CANARY_MODE_REQUIRED',
        `${PACKAGED_CANARY_REPORT_PATH_ENV} 只能与显式 canary 模式同时使用`
      );
    }
    return null;
  }
  if (mode !== '1') {
    throw requestError('PACKAGED_CANARY_MODE_INVALID', `${PACKAGED_CANARY_ENV} 只接受精确值 1`);
  }

  const runnerTempValue = env[RUNNER_TEMP_ENV];
  if (typeof runnerTempValue !== 'string' || runnerTempValue.length === 0 || !path.isAbsolute(runnerTempValue)) {
    throw requestError('PACKAGED_CANARY_RUNNER_TEMP_INVALID', 'packaged canary 需要绝对 RUNNER_TEMP');
  }
  if (typeof reportPathValue !== 'string' || reportPathValue.length === 0 || !path.isAbsolute(reportPathValue)) {
    throw requestError('PACKAGED_CANARY_REPORT_PATH_INVALID', 'packaged canary 需要绝对 report path');
  }

  const runnerTemp = path.resolve(runnerTempValue);
  const reportPath = path.resolve(reportPathValue);
  const reportName = path.basename(reportPath);
  if (path.dirname(reportPath) !== runnerTemp || !/^[A-Za-z0-9_-]{1,96}\.json$/.test(reportName)) {
    throw requestError(
      'PACKAGED_CANARY_REPORT_PATH_OUTSIDE_RUNNER_TEMP',
      'packaged canary report 必须是 RUNNER_TEMP 直属的安全 JSON 文件'
    );
  }

  return Object.freeze({
    mode: REPORT_MODE,
    reportPath,
    runnerTemp
  });
}

function normalizePackagedRuntimeReport(value) {
  if (!exactKeys(value, REPORT_KEYS) || !exactKeys(value.checks, REPORT_CHECK_KEYS)) {
    throw requestError('PACKAGED_CANARY_REPORT_SHAPE_INVALID', 'packaged canary report shape 非法');
  }
  if (value.schemaVersion !== 1 || value.mode !== REPORT_MODE ||
      typeof value.packaged !== 'boolean' || typeof value.appAsar !== 'boolean' ||
      !['PASS', 'FAIL'].includes(value.status) ||
      REPORT_CHECK_KEYS.some((key) => typeof value.checks[key] !== 'boolean')) {
    throw requestError('PACKAGED_CANARY_REPORT_VALUE_INVALID', 'packaged canary report value 非法');
  }

  const allPassed = value.packaged === true && value.appAsar === true &&
    REPORT_CHECK_KEYS.every((key) => value.checks[key] === true);
  if ((value.status === 'PASS') !== allPassed) {
    throw requestError('PACKAGED_CANARY_REPORT_STATUS_INVALID', 'packaged canary status 与 checks 不一致');
  }

  return Object.freeze({
    schemaVersion: 1,
    mode: REPORT_MODE,
    status: value.status,
    packaged: value.packaged,
    appAsar: value.appAsar,
    checks: Object.freeze(Object.fromEntries(REPORT_CHECK_KEYS.map((key) => [key, value.checks[key]])))
  });
}

function serializePackagedRuntimeReport(value) {
  const serialized = `${JSON.stringify(normalizePackagedRuntimeReport(value))}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) {
    throw requestError('PACKAGED_CANARY_REPORT_TOO_LARGE', 'packaged canary report 超过大小上限');
  }
  return serialized;
}

module.exports = {
  MAX_REPORT_BYTES,
  PACKAGED_CANARY_ENV,
  PACKAGED_CANARY_REPORT_PATH_ENV,
  REPORT_CHECK_KEYS,
  REPORT_MODE,
  RUNNER_TEMP_ENV,
  normalizePackagedRuntimeReport,
  parsePackagedRuntimeRequest,
  serializePackagedRuntimeReport
};
