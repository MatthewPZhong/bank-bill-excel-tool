'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const CHANGE_ROOT = path.join(ROOT, 'changes', '3.2.5');
const FROZEN_ROOT = path.join(
  ROOT,
  'changes',
  'background-execution-v3.2.x-contract-baseline',
  'changes',
  '3.2.5'
);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('v3.2.5 顶层合同逐字节同步冻结来源', () => {
  const expected = new Map([
    ['spec.md', '13410e4e5cf64798255cab30dd2487d4da4323eddf59d44cf2a0653e950898f2'],
    ['techdoc.md', '3fb1845979823f2c39a8e26d9d5adc5d7f3e351fda90d2f4086d6c355d17e64f']
  ]);

  for (const [fileName, expectedHash] of expected) {
    const topLevel = fs.readFileSync(path.join(CHANGE_ROOT, fileName));
    const frozen = fs.readFileSync(path.join(FROZEN_ROOT, fileName));
    assert.deepEqual(topLevel, frozen, `${fileName} 必须逐字节同步冻结来源`);
    assert.equal(sha256(topLevel), expectedHash, `${fileName} SHA-256 漂移`);
  }
});

test('v3.2.5 实施序列保持 E13-A 到 R3.2.5 的严格顺序', () => {
  const sequence = read('changes/3.2.5/implementation-sequence.md').toString('utf8');
  const labels = ['E13-A', 'E13-B', 'E13-C', 'E13-D', 'E13-E', 'E13-F', 'E13-G', 'R3.2.5'];
  let cursor = -1;
  for (const label of labels) {
    const next = sequence.indexOf(`| ${label} |`, cursor + 1);
    assert.ok(next > cursor, `${label} 必须且只能在前序节点之后出现`);
    cursor = next;
  }
  assert.match(sequence, /不新增独立功能 PR/);
  assert.match(sequence, /不运行 `release-check`、`check-vars` 或 `scan:vars`/);
});

test('v3.2.5 preflight 不得用历史绿灯代偿当前 binding authority 漂移', () => {
  const evidence = JSON.parse(
    read('changes/3.2.5/preflight-baseline-validation.json').toString('utf8')
  );
  assert.equal(evidence.publishedValidationReport.status, 'PASS');
  assert.equal(evidence.publishedValidationReport.classification, 'historical-only');
  assert.equal(evidence.packageChecksum.status, 'FAIL');
  assert.equal(evidence.packageChecksum.passedFileCount, 61);
  assert.equal(evidence.packageChecksum.failedFileCount, 8);
  assert.equal(evidence.currentTreeValidation.status, 'FAIL');
  assert.deepEqual(evidence.currentTreeValidation.failedChecks, [
    'canonical-action-legacy-task-binding'
  ]);
  assert.equal(evidence.currentTreeValidation.classification, 'E13-G-preflight-finding');
  assert.equal(evidence.resolutionOwner, 'E13-G');
  assert.equal(evidence.productionEnabled, false);
  assert.equal(evidence.humanReviewStatus, 'PENDING_HUMAN_REVIEW');
});
