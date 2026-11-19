'use strict';
// 合成验证共用工作流；只由集成测试和容量脚本导入，不装配到生产 runtime。
// v3.2.20：业务OP数据核对下线，原 OP 导入/计算/六类导出段随之删除，只保留 Toolbox rows 完整链路。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
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
const { inventoryForGovernor, sealMemoryActivityInventory } = require('../../src/main-process/memory-activity');
const MiB = 1024 ** 2;

async function runScenario({ rows = 2000, availableMiB = 512, realSystem = false, mode = null, memoryPolicyFactory = null } = {}) {
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
    let g;
    const sampleMemory = () => realSystem ? sampler() : ({ availableBytes: availableMiB * MiB, sampledAt: Date.now() });
    // 测试专用策略工厂可接入真实生产选档代码，生产 runtime 不消费此参数。
    const memoryAdmission = memoryPolicyFactory
      ? memoryPolicyFactory({ getGovernor: () => g, sampleMemory })
      : createExperimentalMemoryPolicy({ sampleMemory, inventory: () => inventoryForGovernor(() => g),
        modes: mode ? [mode] : ['normal', 'low'] });
    g = createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 1,
      ioHeavySlots: 2, memoryBytes: 2048 * MiB }, memoryAdmission, diagnostics(event) {
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

    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash);
    assert.ok(grants.every((grant) => grant.memoryBytes < 1024 * MiB));
    return { scope: 'synthetic-Main-components-native-workers', productionEvidence: false,
      injectedAvailableMemory: !realSystem, availableMiB: realSystem ? null : availableMiB,
      rows, rowsDigest, sourceHash, phases, grants, samples,
      limitations: ['合成数据与领域 Main 组件；不代表真实 Main GUI、安装包、Excel/WPS 或真实业务验收。',
        '独立结果验证阶段单列；RSS 为当前 PID 整体值，heap/external 为采样线程，external 已包含 arrayBuffers。'] };
  } finally {
    clearInterval(timer);
    for (const cleanup of cleanups.reverse()) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { runScenario };
