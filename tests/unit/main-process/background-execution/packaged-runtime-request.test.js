'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_REPORT_BYTES,
  REPORT_CHECK_KEYS,
  REPORT_MODE,
  normalizePackagedRuntimeReport,
  parsePackagedRuntimeRequest,
  serializePackagedRuntimeReport
} = require('../../../../src/main-process/background-execution/canary/packaged-runtime-request');

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: REPORT_MODE,
    status: 'PASS',
    packaged: true,
    appAsar: true,
    checks: Object.fromEntries(REPORT_CHECK_KEYS.map((key) => [key, true])),
    ...overrides
  };
}

test('未显式请求时保持普通启动，孤立 report env fail closed', () => {
  assert.equal(parsePackagedRuntimeRequest({}), null);
  assert.throws(
    () => parsePackagedRuntimeRequest({
      BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH: path.join(os.tmpdir(), 'report.json')
    }),
    { code: 'PACKAGED_CANARY_MODE_REQUIRED' }
  );
  assert.throws(
    () => parsePackagedRuntimeRequest({ BACKGROUND_EXECUTION_PACKAGED_CANARY: 'true' }),
    { code: 'PACKAGED_CANARY_MODE_INVALID' }
  );
});

test('显式模式只接受 RUNNER_TEMP 直属安全 JSON path', () => {
  const runnerTemp = path.resolve(os.tmpdir(), 'packaged-canary-runner');
  const request = parsePackagedRuntimeRequest({
    BACKGROUND_EXECUTION_PACKAGED_CANARY: '1',
    BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH: path.join(runnerTemp, 'setup-canary.json'),
    RUNNER_TEMP: runnerTemp
  });
  assert.deepEqual(request, {
    mode: REPORT_MODE,
    reportPath: path.join(runnerTemp, 'setup-canary.json'),
    runnerTemp
  });
  assert.equal(Object.isFrozen(request), true);

  for (const candidate of [
    path.join(runnerTemp, 'nested', 'report.json'),
    path.resolve(runnerTemp, '..', 'report.json'),
    path.join(runnerTemp, 'unsafe name.json'),
    path.join(runnerTemp, 'report.txt')
  ]) {
    assert.throws(
      () => parsePackagedRuntimeRequest({
        BACKGROUND_EXECUTION_PACKAGED_CANARY: '1',
        BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH: candidate,
        RUNNER_TEMP: runnerTemp
      }),
      { code: 'PACKAGED_CANARY_REPORT_PATH_OUTSIDE_RUNNER_TEMP' }
    );
  }
});

test('安全 report shape 严格、无自由文本或路径字段且 PASS 必须全真', () => {
  const normalized = normalizePackagedRuntimeReport(report());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.checks), true);
  assert.deepEqual(Object.keys(normalized).sort(), [
    'appAsar', 'checks', 'mode', 'packaged', 'schemaVersion', 'status'
  ]);
  assert.equal(Object.keys(normalized).some((key) => /path|file|user|error/i.test(key)), false);

  assert.throws(
    () => normalizePackagedRuntimeReport({ ...report(), reportPath: '/private/user.sqlite' }),
    { code: 'PACKAGED_CANARY_REPORT_SHAPE_INVALID' }
  );
  assert.throws(
    () => normalizePackagedRuntimeReport(report({
      checks: { ...report().checks, workerComplete: false }
    })),
    { code: 'PACKAGED_CANARY_REPORT_STATUS_INVALID' }
  );
  assert.equal(normalizePackagedRuntimeReport(report({
    status: 'FAIL',
    checks: { ...report().checks, workerComplete: false }
  })).status, 'FAIL');
});

test('序列化输出为有界单行 UTF-8 JSON', () => {
  const serialized = serializePackagedRuntimeReport(report());
  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(serialized.slice(0, -1).includes('\n'), false);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_REPORT_BYTES);
  assert.deepEqual(JSON.parse(serialized), report());
});
