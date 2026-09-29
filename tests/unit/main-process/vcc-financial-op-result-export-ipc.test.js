'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResultExportHandlers } = require('../../../src/main-process/vcc-financial-op-result-export-ipc');

function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const handlers = createResultExportHandlers({
    getService: () => ({
      getArchivedRunByMonth: async (month) => ({ targetMonth: month, runId: 7, subjects: ['甲', '乙'], resultRevision: 4, archivedAt: 'today' }),
      exportRun: async (request) => { calls.push(request); return options.result || { filePaths: [path.join(dir, 'result.xlsx')] }; }
    }),
    dialog: { showSaveDialog: async (_window, request) => { calls.push(request); return options.choice || { filePath: path.join(dir, 'result.xlsx') }; } },
    getWindow: () => null, documentsPath: dir,
    createStagingDirectory: () => dir,
    cleanupStagingDirectory: () => { if (options.cleanupFailure) throw new Error('cleanup'); },
    settlePublication() {}
  });
  return { dir, handlers, calls };
}

test('多个主体使用单个另存为与月度文件名，不接受 Renderer 路径/主体', async (t) => {
  const { handlers, dir, calls } = harness(t);
  const prepared = await handlers.prepare(null, { targetMonth: '2026-06', subjects: ['伪造'], outputPath: '/evil.xlsx' });
  assert.equal(calls[0].defaultPath, path.join(dir, '2026-06_VCC财务OP校验结果表.xlsx'));
  assert.deepEqual(prepared.subjects, ['甲', '乙']);
  assert.equal(prepared.filePlan.outputs.length, 1);
  const authorized = path.join(dir, 'authorized.xlsx');
  const result = await handlers.execute(null, prepared, { batchContext: {},
    fileEvidence: { filePlan: { outputs: [{ filePath: authorized }] }, targetSnapshots: [{ exists: false }] } });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls[1].outputPaths, [authorized]);
  assert.equal(calls[1].expectedResultRevision, 4);
});

test('保存位置取消不生成计划；已提交 pending 告警及清理失败仍为成功', async (t) => {
  const cancelled = harness(t, { choice: { canceled: true } });
  assert.deepEqual(await cancelled.handlers.prepare(null, { targetMonth: '2026-06' }), { proceed: false, result: { status: 'cancelled' } });
  const { handlers } = harness(t, { result: { filePaths: ['saved.xlsx'], pendingArchiveHandoff: true, warnings: ['接管待重试'] }, cleanupFailure: true });
  const result = await handlers.execute(null, { targetMonth: '2026-06', runId: 7, subjects: ['甲', '乙'] }, {
    batchContext: {}, fileEvidence: { filePlan: { outputs: [{ filePath: 'saved.xlsx' }] }, targetSnapshots: [{ exists: false }] }
  });
  assert.equal(result.status, 'success'); assert.equal(result.pendingArchiveHandoff, true);
  assert.equal(result.warnings[0], '接管待重试'); assert.match(result.warnings[1], /清理/);
});
