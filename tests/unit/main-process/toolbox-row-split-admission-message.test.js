'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const { planRowCounts, buildRowTargets } = require('../../../src/main-process/toolbox-row-split/contracts');
const { generateValidateAndPublishRows } = require('../../../src/main-process/toolbox-row-split/service');

const mainSource = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const failureStart = mainSource.indexOf('function toolboxFailureResult(error) {');
const failureEnd = mainSource.indexOf('\nfunction shouldPreserveToolboxTemporaryFiles', failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart);
const failureResult = vm.runInNewContext(mainSource.slice(failureStart, failureEnd) + '\ntoolboxFailureResult;');
const plain = (value) => JSON.parse(JSON.stringify(value));
const batchContext = { batchId: 1, batchNumber: 'ROWS-ADMISSION', taskRunId: 'rows-admission-test',
  taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-admission-parent',
  operationKey: 'rows-admission-operation' };

async function failBeforeGeneration(t, error, direct = false) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-admission-message-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'fixture.csv');
  const original = Buffer.from('编号,说明\n1,测试\n');
  fs.writeFileSync(source, original);
  const counts = planRowCounts(1, 1);
  const targets = buildRowTargets(source, directory, counts);
  fs.writeFileSync(targets[0].filePath, '已存在的目标');
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }],
    outputs: targets.map((target) => ({ filePath: target.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
  const privateDirectory = fs.mkdtempSync(path.join(directory, '.private-'));
  let calls = 0;
  let publishing = 0;
  const runtime = { execute: async () => {
    calls += 1;
    if (direct) throw Object.assign(new Error(error.message), error);
    return { outcome: 'failed', terminalSource: 'admission', error };
  } };
  let caught;
  await assert.rejects(generateValidateAndPublishRows({ runtime, filePlan, batchContext, counts,
    privateDirectory, publisher: async () => { publishing += 1; } }), (error) => { caught = error; return true; });
  assert.equal(calls, 1);
  assert.equal(publishing, 0);
  assert.deepEqual(fs.readdirSync(privateDirectory), ['plan.json']);
  assert.deepEqual(fs.readFileSync(source), original);
  assert.equal(fs.readFileSync(targets[0].filePath, 'utf8'), '已存在的目标');
  return caught;
}

for (const code of ['RESOURCE_BUDGET_UNAVAILABLE', 'ADMISSION_TIMEOUT']) {
  for (const direct of [false, true]) {
    test(`${code} ${direct ? '直接拒绝' : 'SafeErrorV1'} 经 service 与 Main 保留错误码和中文诊断`, async (t) => {
      const details = ['申请资源：内存 1,024.000 MiB', '总预算：内存 768.000 MiB'];
      const error = await failBeforeGeneration(t, { code, message: 'Admission failed', stage: 'admission', detailLines: details }, direct);
      const result = plain(failureResult(error));
      assert.equal(result.status, 'failed');
      assert.equal(result.code, code);
      assert.match(result.message, code === 'ADMISSION_TIMEOUT' ? /按行拆分等待后台资源超时/ : /按行拆分暂时无法启动.*配额不足/);
      assert.equal(result.detailLines[0], '本次尚未开始生成拆分文件。');
      assert.deepEqual(result.detailLines.slice(1, -1), details);
      assert.match(result.detailLines.at(-1), code === 'ADMISSION_TIMEOUT' ? /等待其他后台任务完成/ : /释放内存后重新启动应用/);
      assert.equal(error.stage, 'admission');
    });
  }
}

test('非准入错误保持原文、原诊断和错误码，不添加未开始生成的保证', async (t) => {
  const source = { code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE', message: '拆分源文件已变化',
    stage: 'generation', detailLines: ['请重新选择文件'] };
  const error = await failBeforeGeneration(t, source);
  assert.deepEqual(plain(failureResult(error)), { status: 'failed', code: source.code,
    message: source.message, detailLines: source.detailLines });
});

test('Main 无错误码的旧异常返回形状不变，恢复路径仍完整且不重复', () => {
  const error = Object.assign(new Error('发布恢复失败'), { detailLines: ['恢复路径：/fixture/a'],
    recoveryPaths: ['/fixture/a', '/fixture/b'] });
  const result = plain(failureResult(error));
  assert.deepEqual(result, { status: 'failed', message: '发布恢复失败',
    detailLines: ['恢复路径：/fixture/a', '恢复路径：/fixture/b'] });
  result.detailLines.push('额外信息');
  assert.deepEqual(error.detailLines, ['恢复路径：/fixture/a']);
});
