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

function replaceExactlyOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label} 的冻结锚点必须精确出现一次`);
  return source.replace(before, after);
}

test('v3.2.5 顶层合同只允许已记录的 E13-B 拓扑与来源证据修订', () => {
  const frozenHashes = new Map([
    ['spec.md', '13410e4e5cf64798255cab30dd2487d4da4323eddf59d44cf2a0653e950898f2'],
    ['techdoc.md', '3fb1845979823f2c39a8e26d9d5adc5d7f3e351fda90d2f4086d6c355d17e64f']
  ]);
  const currentHashes = new Map([
    ['spec.md', '5991258849cc1071778bdb2dac3baab24e58338ee34645e5c6d2cf015011a321'],
    ['techdoc.md', '2b58346f76f8d71008c5f2f296aaa04f0095c74930ce80fd91d9ed4772260381']
  ]);
  const amendments = new Map([
    ['spec.md', (frozen) => {
      const policyAmended = replaceExactlyOnce(
        frozen,
        '| `position:export-run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `existing-dispatch` | `main-settlement` | `false` | 具体 adapterKey 在 inventory 固化 |',
        '| `position:export-run` | `legacy-preserved` | `managed` | `thread-single` | `job` | `native` | `main-settlement` | `false` | 模块专用只读 Worker；不得复用 position import dispatcher |',
        'spec.md Position export policy'
      );
      const nonGoalAmended = replaceExactlyOnce(
        policyAmended,
        '-不把Position改成worker thread；',
        '-不把 Position 现有 import utility-process/child_process dispatcher 改成 worker thread；只读 export 按 3.1 的 native thread-single action 执行；',
        'spec.md Position import non-goal'
      );
      return replaceExactlyOnce(
        nonGoalAmended,
        '-把Position改为thread；',
        '-把 Position 现有 import utility-process/child_process dispatcher 改为 thread；',
        'spec.md Position import adapter prohibition'
      );
    }],
    ['techdoc.md', (frozen) => {
      const executorAmended = replaceExactlyOnce(
        frozen,
        '每个模块目录有自己的query、writer、business-validator和worker entry；公共目录不包含业务SQL或Workbook规则。',
        '每个模块目录有自己的query、writer、business-validator和worker entry；公共目录不包含业务SQL或Workbook规则。\n\n' +
          '`position:export-run` 属于本节的模块专用 native read-only executor。仓库中没有可复用的 Position export dispatcher；第 5 节 Position utility-process adapter 仅适用于 `position:import`（E13-F），不得把 import dispatcher、虚构的 compound topology 或外层套 Worker 代替真实 export 拓扑。',
        'techdoc.md Position executor'
      );
      return replaceExactlyOnce(
        executorAmended,
        '- runId/datasetId/revision；',
        '- runId/datasetId/revision；\n' +
          '-参与 Workbook 语义的模板或受管归档文件 SHA-256/byteSize authority；Main 与 Worker 均须复核，不能只冻结路径；',
        'techdoc.md template/archive evidence'
      );
    }]
  ]);

  for (const [fileName, frozenHash] of frozenHashes) {
    const topLevel = fs.readFileSync(path.join(CHANGE_ROOT, fileName), 'utf8');
    const frozen = fs.readFileSync(path.join(FROZEN_ROOT, fileName));
    assert.equal(sha256(frozen), frozenHash, `${fileName} 冻结来源 SHA-256 漂移`);
    assert.equal(
      topLevel,
      amendments.get(fileName)(frozen.toString('utf8')),
      `${fileName} 存在未记录的合同漂移`
    );
    assert.equal(
      sha256(Buffer.from(topLevel)),
      currentHashes.get(fileName),
      `${fileName} 当前 authority SHA-256 漂移`
    );
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
