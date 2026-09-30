'use strict';
// 合成验证共用工作流；只由集成测试和容量脚本导入，不装配到生产 runtime。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { createMemorySampler, sampleProcessMemory } = require('../../src/main-process/background-execution/memory-telemetry');
const { createNonProductionBackgroundExecutionRuntime } = require('../../src/main-process/execution-descriptors/composition');
const { createToolboxSplitReadOwner } = require('../../src/main-process/toolbox-split-read-owner');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
const { planRowCounts, buildRowTargets } = require('../../src/main-process/toolbox-row-split/contracts');
const { createPublicationMemoryAdmission } = require('../../src/main-process/execution-descriptors/publication-memory');
const { createTestPublicationHarness } = require('../../tests/helpers/publication-authority');
const { createExportHost, request } = require('../../tests/helpers/biz-op-v327-export');
const { seed, compute, readResult } = require('../../tests/helpers/biz-op-v327-compute');
const { inventoryForGovernor, sealMemoryActivityInventory } = require('../../src/main-process/memory-activity');
const MiB = 1024 ** 2;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function runScenario({ rows = 2000, availableMiB = 512, realSystem = false, mode = null, inspectExport = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'low-memory-complete-')));
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  const phases = [], grants = [], samples = [];
  const sampler = createMemorySampler();
  let phase = 'fixture';
  function sample() { samples.push({ phase, at: Date.now(), ...sampler(), ...sampleProcessMemory() }); }
  async function measured(name, work) {
    phase = name; sample(); const started = performance.now();
    try { return await work(); } finally { sample(); phases.push({ phase: name, elapsedMs: performance.now() - started }); }
  }
  function governor() {
    sealMemoryActivityInventory();
    const g = createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 1,
      ioHeavySlots: 2, memoryBytes: 2048 * MiB },
    memoryAdmission: createExperimentalMemoryPolicy({
      sampleMemory: () => realSystem ? sampler() : ({ availableBytes: availableMiB * MiB, sampledAt: Date.now() }),
      inventory: () => inventoryForGovernor(() => g), modes: mode ? [mode] : ['normal', 'low']
    }), diagnostics(event) {
      if (event.type === 'resource-granted' && event.memoryProfile) grants.push({ phase,
        profileId: event.memoryProfile, policyDigest: event.policyDigest, mode: event.memoryMode,
        memoryBytes: event.memoryBytes, actualAvailableBytes: sampler().availableBytes, at: event.at });
    } });
    return g;
  }
  let timer;
  try {
    const source = path.join(root, 'synthetic.xlsx');
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: source, useSharedStrings: true, useStyles: true });
    const sheet = writer.addWorksheet('合成样本'); sheet.addRow(['序号', '编号', '分组', '文本']).commit();
    for (let i = 0; i < rows; i++) {
      const row = sheet.addRow([i + 1, String(i).padStart(12, '0'), i % 2 ? '乙' : '甲', `文本-${i}-${'样本'.repeat(128)}`]);
      row.getCell(2).numFmt = '@'; row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${(i % 128).toString(16).padStart(6, '0')}` } };
      row.commit();
    }
    await writer.commit();
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    timer = setInterval(sample, 50); // 源文件生成不算用户选择后工作量。
    const runtime = createNonProductionBackgroundExecutionRuntime({ resourceGovernor: governor() });
    t.after(() => runtime.shutdown());
    const readOwner = createToolboxSplitReadOwner({ governor: runtime.resourceGovernor, temporaryRoot: root });
    t.after(() => readOwner.close());
    const sender = new EventEmitter(); sender.id = 1;
    const metadata = await measured('prepare-metadata', () => readOwner.read(sender,
      { version: 2, scanKind: 'metadata', requestId: 'capacity-metadata' }, async () => source));
    assert.equal(metadata.dataRowCount, rows); assert.equal(metadata.valuesByField, undefined);
    const values = await measured('prepare-values', () => readOwner.readValues(sender, { version: 2,
      splitReadToken: metadata.splitReadToken, requestId: 'capacity-values', field: '分组' }));
    assert.deepEqual([...values.values].sort(), ['乙', '甲'].sort());
    const output = path.join(root, 'outputs'); const control = path.join(root, 'publication-control');
    fs.mkdirSync(output); fs.mkdirSync(control);
    const counts = planRowCounts(rows, Math.ceil(rows / 8));
    const targets = buildRowTargets(source, output, counts);
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: [{ filePath: source, role: 'input', sourceOperation: 'toolbox:split:export' }],
      outputs: targets.map((item) => ({ filePath: item.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
    const batchContext = { batchId: 1, batchNumber: 'CAPACITY-SYNTHETIC', taskRunId: 'capacity-rows',
      taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'capacity-parent', operationKey: 'capacity-rows' };
    const publication = createTestPublicationHarness(control, { acquireMemory: createPublicationMemoryAdmission(() => runtime) });
    const privateDirectory = fs.mkdtempSync(path.join(root, 'rows-private-'));
    const generated = await measured('rows-generate-validate-publish', () => generateValidateAndPublishRows({
      runtime: { resourceGovernor: runtime.resourceGovernor, execute: (request) => runtime.execute({ ...request, production: false }) },
      filePlan, batchContext, counts, privateDirectory, publisher: (artifacts) => publication.dispatcher.publish({
        taskId: 'toolbox-split-rows-capacity', artifacts, targets: filePlan.outputs.map((item) => ({ targetPath: item.filePath,
          expectedTargetSnapshot: item.targetSnapshot, expectedTargetParentIdentity: item.targetParentIdentity })),
        userDataDir: control, batchContext, archiveInputFiles: filePlan.inputs, protectedSourcePaths: [source], requireValidatedArtifacts: true
      }) }));
    const rowsDigest = await measured('independent-rows-readback', async () => {
      const hash = crypto.createHash('sha256'); let count = 0;
      for (const file of generated.publication.files) {
        const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file.filePath);
        for (const page of book.worksheets) for (let n = 2; n <= page.rowCount; n++) {
          const row = page.getRow(n); count++;
          assert.equal(row.getCell(1).value, count);
          assert.equal(row.getCell(2).value, String(count - 1).padStart(12, '0'));
          assert.equal(row.getCell(2).numFmt, '@');
          hash.update(JSON.stringify([row.values, row.getCell(1).fill]) + '\n');
        }
      }
      assert.equal(count, rows); return hash.digest('hex');
    });
    await measured('rows-publication-recovery', () => publication.recovery.recover({ reason: 'business-retry' }));
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    await readOwner.close(); await runtime.shutdown();

    const f = await createExportHost(t, { resourceGovernor: governor() });
    await measured('op-import', () => seed(f, { count: rows }));
    const result = await measured('op-compute', () => compute(f));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const opDigest = await measured('independent-op-readback', () => digest(readResult(f, result.runId).rows));
    const exports = [];
    for (const kind of ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'RESULT_FULL', 'RESULT_DIFF']) {
      const id = kind.startsWith('RESULT') ? result.runId
        : f.db.prepare('SELECT dataset_id FROM biz_op_v327_datasets WHERE kind=? ORDER BY data_date LIMIT 1').get(kind.split('_')[0]).dataset_id;
      const exported = await measured(`op-export-${kind.toLowerCase()}`, () => request(f, kind, id));
      assert.equal(exported.status, 'ok', JSON.stringify(exported));
      exports.push(await measured(`independent-export-readback-${kind.toLowerCase()}`, () => {
        const book = XLSX.readFile(exported.filePath);
        inspectExport?.(kind, book.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true }) })));
        return { kind, dataRowCount: exported.dataRowCount, digest: digest(book.SheetNames.map((name) => {
          const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true });
          // 说明页的运行 UUID、摘要和两项提交时间每次不同；仅规范这些技术身份。
          // 说明内容、金额、日期、顺序和业务页逐值保留，Worker 的绑定验证也独立执行。
          return name.startsWith('核对说明') ? rows.map((row) => row.map((value) => typeof value === 'string'
            ? value.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<uuid>')
              .replace(/\b[a-f0-9]{64}\b/g, '<sha256>')
              .replace(/"(activatedAt|publishedAt)":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g, '"$1":"<timestamp>"') : value)) : rows;
        })) };
      }));
    }
    assert.equal((await measured('op-recovery', () => f.module.recovery.run())).ready, true);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash);
    assert.ok(grants.every((grant) => grant.memoryBytes < 1024 * MiB));
    return { scope: 'synthetic-Main-components-native-workers', productionEvidence: false,
      injectedAvailableMemory: !realSystem, availableMiB: realSystem ? null : availableMiB,
      rows, rowsDigest, opDigest, exports, sourceHash, phases, grants, samples,
      limitations: ['合成数据与领域 Main 组件；不代表真实 Main GUI、安装包、Excel/WPS 或真实业务验收。',
        '独立结果验证阶段单列；RSS 为当前 PID 整体值，heap/external 为采样线程，external 已包含 arrayBuffers。'] };
  } finally {
    clearInterval(timer);
    for (const cleanup of cleanups.reverse()) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { runScenario };
