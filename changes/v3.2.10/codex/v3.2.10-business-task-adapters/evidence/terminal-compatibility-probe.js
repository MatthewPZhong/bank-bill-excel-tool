'use strict';

// 在 G2 worktree 根目录执行；只写同目录证据，不改生产代码、测试或 Git 状态。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');

const root = process.cwd();
const baseline = '5ccbf3f022488026f725a5111be00422a04ce221';
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const original = (relative) => cp.execFileSync('git', ['show', `${baseline}:${relative}`], {
  cwd: root, encoding: 'utf8'
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fromRoot = (relative) => require(path.join(root, relative));
const { createTerminalRouteRegistry } = fromRoot('src/main-process/archive-center/terminal-route-registry');
const registrations = [
  ['position-reconciliation', 'operationToken', fromRoot('src/main-process/position-reconciliation/task-owner').normalizePositionTerminalRoute],
  ['pending-run', 'taskRunId', fromRoot('src/main-process/pending-archive-lineage').normalizePendingTerminalRoute],
  ['biz-op-run', 'taskRunId', fromRoot('src/main-process/biz-op-recon-run-data').normalizeBizOpRunTerminalRoute],
  ['pre-fund-run', 'taskRunId', fromRoot('src/main-process/pre-fund-archive-lineage').normalizePreFundTerminalRoute]
];
const registry = createTerminalRouteRegistry(registrations.map(([route, , normalize]) => ({
  route, normalize, finalize() {}
})));
const controllerPath = 'src/main-process/archive-center/controller.js';
function extractNormalizer(contents) {
  const start = contents.indexOf('function normalizeTerminalOutcome(');
  const end = contents.indexOf('\nclass ArchiveCenterController', start);
  if (start < 0 || end <= start) throw new Error('无法定位 Controller normalizer');
  return vm.runInNewContext(`(() => {
    const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
    ${contents.slice(start, end)}
    return normalizeTerminalOutcome;
  })()`);
}
const before = extractNormalizer(original(controllerPath));
const after = extractNormalizer(source(controllerPath));
function observed(fn) {
  try { return { value: JSON.stringify(fn()) }; }
  catch (error) { return { name: error.name, message: error.message }; }
}
function label(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
const samples = [null, undefined, false, 0, [], {}, '', 'bad', { route: 'unknown' }, { route: '' }]
  .map((value) => ({ name: `afterTerminal=${label(value)}`, value }));
for (const [route, field] of registrations) {
  for (const value of [undefined, null, '', '  ', false, 0, 1, ' token ', [], {}, ['token']]) {
    samples.push({
      name: `${route}.${field}=${label(value)};route带空格;extra被裁剪`,
      value: { route: ` ${route} `, [field]: value, extra: 'ignored' }
    });
  }
}
const results = [];
for (const sample of samples) {
  for (const status of [' succeeded ', 'cancelled', 'failed']) {
    const input = { taskStatus: status, afterTerminal: sample.value, metadata: { kept: true } };
    const oldResult = observed(() => before(input));
    const newResult = observed(() => after(input, registry));
    results.push({ sample: sample.name, status, equal: JSON.stringify(oldResult) === JSON.stringify(newResult),
      baseline: oldResult, current: newResult });
  }
}
const relatedSources = [
  'src/main.js', controllerPath,
  'src/main-process/archive-center/terminal-route-registry.js',
  'src/main-process/archive-center/task-lifecycle.js',
  'src/main-process/archive-center/worker-operation-context.js',
  'src/main-process/position-reconciliation/task-owner.js',
  'src/main-process/position-reconciliation/task-adapter.js',
  'src/main-process/pending-archive-lineage.js',
  'src/main-process/pre-fund-archive-lineage.js',
  'src/main-process/biz-op-recon-run-data.js',
  'src/backend/biz-op-legacy-guard.js',
  'src/main-process/toolbox-background/task-adapter.js',
  'src/main-process/vcc-financial-op-output/task-adapter.js',
  'src/main-process/toolbox-archive-recovery.js'
];
const evidence = {
  generatedAt: new Date().toISOString(),
  worktree: root,
  baseline,
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  nodeVersion: process.version,
  command: 'NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules node changes/v3.2.10/codex/v3.2.10-business-task-adapters/evidence/terminal-compatibility-probe.js',
  probeSha256: sha256(fs.readFileSync(__filename)),
  baselineControllerSha256: sha256(original(controllerPath)),
  sources: relatedSources.map((file) => ({ file, sha256: sha256(source(file)) })),
  sampleCount: results.length,
  differences: results.filter((result) => !result.equal),
  status: results.every((result) => result.equal) ? 'PASS' : 'FAIL',
  boundary: '真实领域 normalizer 和 registry；只比较普通持久数据的 normalizer 返回/异常，不代表数据库回放、GUI 或平台验收。',
  results
};
fs.writeFileSync(path.join(__dirname, 'terminal-compatibility-probe.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ baseline, sampleCount: evidence.sampleCount, differences: evidence.differences.length,
  status: evidence.status, output: path.join(__dirname, 'terminal-compatibility-probe.json') }));
if (evidence.status !== 'PASS') process.exitCode = 1;
