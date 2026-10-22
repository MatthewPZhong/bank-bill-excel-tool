'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createResultExportFixture } = require('../../helpers/vcc-result-export');
const { createVccFinancialOpService } = require('../../../src/main-process/vcc-financial-op-service');
const { runResultWorkbookWorker } = require('../../../src/main-process/vcc-financial-op-result-workbook-runner');

async function setup(t, options) {
  const f = await createResultExportFixture(t);
  const service = createVccFinancialOpService({ database: { db: f.db, dbPath: f.dbPath }, assetsDir: f.assetsDir, ...options(f) });
  const target = await service.getArchivedRunByMonth('2026-06');
  const staging = fs.mkdtempSync(path.join(f.dir, 'generation-'));
  const request = { targetMonth: target.targetMonth, expectedRunId: target.runId, expectedSubjects: target.subjects,
    expectedResultRevision: target.resultRevision, expectedArchivedAt: target.archivedAt,
    outputPaths: [path.join(f.dir, 'result.xlsx')], publicationStagingDirectory: staging, targetSnapshots: [{ exists: false }] };
  return { ...f, service, request, staging };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('结果 Worker 发出 result 后不提前发布，terminate 仍等待 exit 和发布后收口', async (t) => {
  let worker, notifyStart; const started = new Promise((resolve) => { notifyStart = resolve; });
  let published = 0, released = 0;
  const f = await setup(t, () => ({
    writeResultWorkbookFn: (args) => runResultWorkbookWorker({ ...args,
      acquireLease: async () => ({ release: () => { released += 1; } }),
      workerFactory(_filename, options) { worker = new EventEmitter(); worker.options = options; notifyStart(); return worker; } }),
    publishOutputFilesFn: async () => { published += 1; return { pendingArchiveHandoff: true, warnings: ['saved, retry'] }; }
  }));
  const exporting = f.service.exportRun(f.request, { operationKey: 'exit-barrier' });
  await started;
  const generation = path.join(worker.options.workerData.publicationStagingDirectory, 'generated.xlsx');
  fs.writeFileSync(generation, 'owned');
  worker.emit('message', { type: 'result', result: { filePaths: f.request.outputPaths, generationFilePaths: [generation] } });
  await tick(); assert.equal(published, 0); assert.equal(released, 0);
  let terminated = false;
  const termination = f.service.terminate().then(() => { terminated = true; });
  await tick(); assert.equal(terminated, false);
  worker.emit('exit', 0);
  const result = await exporting; await termination;
  assert.equal(result.pendingArchiveHandoff, true); assert.equal(published, 1); assert.equal(released, 1);
  assert.equal(terminated, true); assert.equal(fs.existsSync(generation), false);
});

test('Writer 返回前归档 revision 漂移则零发布，清理生成文件且保留已有正式目标', async (t) => {
  let generated, published = 0;
  const f = await setup(t, (fixture) => ({
    writeResultWorkbookFn: async (args) => {
      generated = path.join(args.publicationStagingDirectory, 'generated.xlsx'); fs.writeFileSync(generated, 'new generation');
      fixture.db.prepare('UPDATE vcc_fin_op_runs SET result_revision=result_revision+1 WHERE id=?').run(fixture.run.id);
      return { filePaths: args.outputPaths, generationFilePaths: [generated] };
    },
    publishOutputFilesFn: async () => { published += 1; }
  }));
  fs.writeFileSync(f.request.outputPaths[0], 'existing target');
  await assert.rejects(f.service.exportRun(f.request, {}), { code: 'archive-state-inconsistent' });
  assert.equal(published, 0); assert.equal(fs.existsSync(generated), false);
  assert.equal(fs.readFileSync(f.request.outputPaths[0], 'utf8'), 'existing target');
  await f.service.terminate();
});

test('提交结果不确定时保留生成文件，不改判成功、不吞 preserveTemporaryFiles', async (t) => {
  let generated;
  const f = await setup(t, () => ({
    writeResultWorkbookFn: async (args) => {
      generated = path.join(args.publicationStagingDirectory, 'generated.xlsx'); fs.writeFileSync(generated, 'recovery evidence');
      return { filePaths: args.outputPaths, generationFilePaths: [generated] };
    },
    publishOutputFilesFn: async () => { throw Object.assign(new Error('unknown commit state'), { preserveTemporaryFiles: true }); }
  }));
  await assert.rejects(f.service.exportRun(f.request, {}), { preserveTemporaryFiles: true });
  assert.equal(fs.readFileSync(generated, 'utf8'), 'recovery evidence');
  assert.equal(fs.existsSync(f.request.outputPaths[0]), false);
  await f.service.terminate();
});

test('设置 → 模板文件：Pending 计算表按当前版本取租约，字节交给 Writer，Writer 结束后释放', async (t) => {
  const events = [];
  const bytes = Buffer.from('pending-template-bytes');
  const f = await setup(t, () => ({
    pendingTemplateSource: {
      acquire: async (options) => {
        events.push(['acquire', options]);
        return { versionId: 'v3', sha256: 'f'.repeat(64), bytes, release: () => events.push(['release']) };
      }
    },
    writeResultWorkbookFn: async (args) => {
      events.push(['write', args.pendingTemplate]);
      return { filePaths: args.outputPaths };
    }
  }));
  await f.service.exportRun({ ...f.request, publicationStagingDirectory: undefined }, {});
  assert.deepEqual(events, [
    ['acquire', { label: 'VCC 结果导出', withBytes: true }],
    ['write', { versionId: 'v3', sha256: 'f'.repeat(64), bytes }],
    ['release']
  ]);

  events.length = 0;
  const failing = await setup(t, () => ({
    pendingTemplateSource: {
      acquire: async () => { throw Object.assign(new Error('模板「移除归档Pending发生额计算表」当前版本 V3 不可用'), { code: 'template-resource-unavailable' }); }
    },
    writeResultWorkbookFn: async () => { events.push(['write']); return {}; }
  }));
  await assert.rejects(failing.service.exportRun({ ...failing.request, publicationStagingDirectory: undefined }, {}), { code: 'template-resource-unavailable' });
  assert.deepEqual(events, [], '模板不可用时不启动 Writer');
  await f.service.terminate();
  await failing.service.terminate();
});
