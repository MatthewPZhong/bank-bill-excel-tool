// rows 准入错误：真实生产策略/Governor/Supervisor/SafeError/service/Main 返回的原因、候选额度和建议。
// 平台身份、内存采样、冻结输入计数为夹具；准入拒绝时不启动 Worker，不调用 Publisher。
// 用法：node scripts/integration/toolbox-rows-admission-diagnostics.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withRowsCsv } = require('../../tests/helpers/toolbox-rows-csv');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
const { planRowCounts, buildRowTargets } = require('../../src/main-process/toolbox-row-split/contracts');
const large = 'a,b,c,d,e,f,g,h\n' + '1,2,3,4,5,6,7,8\n'.repeat(20000);
const small = 'a\n1\n';
const cases = [
  { name: '普通档 768 MiB 超过固定 512 MiB：最终提示保留实际候选和固定上限，不建议重启',
    options: { content: large, hardMiB: 512 }, rows: 20000, candidates: '768.000 MiB', limit: '512.000 MiB', compatibility: false },
  { name: '普通/低档均超固定上限：最终提示同时保留 768/384 MiB 候选',
    options: { content: small, hardMiB: 256 }, rows: 1, candidates: '768.000 MiB / 384.000 MiB', limit: '256.000 MiB', compatibility: false },
  { name: '明确的旧兼容预算不足：区分 2048 MiB 固定上限和 512 MiB 兼容预算，并保留重启建议',
    options: { content: large, pending: true, hardMiB: 2048, freeMiB: 2560 }, rows: 20000,
    candidates: '1,024.000 MiB', limit: '512.000 MiB', compatibility: true }
];
async function run(item) {
  return withRowsCsv(item.options, async (h) => {
    const before = h.hash(h.source);
    const counts = planRowCounts(item.rows, item.rows), targets = buildRowTargets(h.source, h.output, counts);
    fs.writeFileSync(targets[0].filePath, '原有正式文件');
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: [{ filePath: h.source, role: 'input', sourceOperation: 'toolbox:split:export' }],
      outputs: targets.map((target) => ({ filePath: target.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
    const privateDirectory = fs.mkdtempSync(path.join(h.root, 'direct-'));
    let caught, published = false;
    await assert.rejects(generateValidateAndPublishRows({ runtime: h.runtime, filePlan, counts, privateDirectory,
      batchContext: { batchId: 1, batchNumber: 'DIAGNOSTIC', taskRunId: 'rows-diagnostic', taskKey: 'toolbox:split:export',
        moduleId: 'toolbox', parentRunId: 'parent', operationKey: 'rows-diagnostic' },
      publisher() { published = true; throw new Error('不应进入发布'); }
    }), (error) => { caught = error; return error.code === 'RESOURCE_BUDGET_UNAVAILABLE'; });
    const result = h.failureResult(caught), text = result.detailLines.join('\n');
    if (process.env.ROWS_DIAGNOSTIC_EVIDENCE === '1') console.log(JSON.stringify({ name: item.name, result }));
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'RESOURCE_BUDGET_UNAVAILABLE');
    assert.match(result.message, /按行拆分暂时无法启动/);
    assert.ok(result.detailLines.includes(`本次适用候选内存：${item.candidates}`), text);
    assert.ok(result.detailLines.includes(`适用内存上限：${item.limit}`), text);
    assert.match(text, item.compatibility ? /启动时冻结的兼容预算/ : /固定资源上限/);
    if (item.compatibility) {
      assert.match(text, /释放内存后重新启动应用/);
      assert.ok(result.detailLines.some((line) => line.startsWith('总预算：') && line.includes('2,048.000 MiB')));
    } else assert.doesNotMatch(text, /重启|重新启动|兼容预算/);
    assert.ok(result.detailLines.some((line) => line.startsWith('静态资源基线：') && line.includes('1,024.000 MiB')));
    assert.doesNotMatch(text, /申请资源：.*1,024\.000/);
    assert.doesNotMatch(text, /redacted|ownerKey|rows-diagnostic/);
    assert.equal(caught.details, undefined, '验证的是经过 SafeError 的返回，不依赖 Error.details');
    assert.equal(h.starts.length, 0); assert.equal(h.workers.length, 0); assert.equal(published, false);
    assert.equal(h.runtime.resourceGovernor.snapshot().diagnostics.granted, 0);
    assert.deepEqual(fs.readdirSync(privateDirectory), ['plan.json']);
    assert.equal(h.hash(h.source), before); assert.equal(fs.readFileSync(targets[0].filePath, 'utf8'), '原有正式文件');
  });
}
(async () => {
  let passed = 0;
  for (const item of cases) { await run(item); passed++; console.log('PASS', item.name); }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
