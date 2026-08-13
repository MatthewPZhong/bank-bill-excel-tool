'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createArchiveOperationTracker,
  resolveOperationInputPaths,
  resolveOperationFiles,
  selectSuccessfulPathsByResultIndex
} = require('../../../src/main-process/archive-center/operation-tracker');
const {
  captureArchiveSourceSnapshots
} = require('../../../src/main-process/archive-center/source-snapshot');

function batchContext(batchId) {
  return {
    batchId,
    batchNumber: `2026-08-10-${String(batchId).padStart(3, '0')}`,
    taskRunId: `task-${batchId}`,
    taskKey: 'test',
    moduleId: 'test-module',
    parentRunId: `parent-${batchId}`,
    operationKey: `operation-${batchId}`
  };
}

function createHarness() {
  const calls = [];
  const tracker = createArchiveOperationTracker({
    sink: {
      async appendFiles(payload) {
        calls.push(payload);
        return { archiveFailed: false, attempted: payload.files.length };
      }
    }
  });
  return { calls, tracker };
}

test.describe('stateless archive operation tracker', () => {
  test('只接受 append sink，不提供成功后建批能力', () => {
    assert.throws(
      () => createArchiveOperationTracker({ sink: { async createBatch() {} } }),
      /appendFiles sink/
    );
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'main-process', 'archive-center', 'operation-tracker.js'),
      'utf8'
    );
    assert.doesNotMatch(source, /pendingInputs|activeBatches|getActiveBatch|getPendingSnapshot|findLatest/);
    assert.doesNotMatch(source, /sink\.createBatch|\.createBatch\(/);
  });

  test('每次只向显式当前 batch 追加，不记忆或回退 latest', async () => {
    const { calls, tracker } = createHarness();
    await tracker.appendOperationFiles({
      batchContext: batchContext(11),
      channel: 'recon-id-fix:import',
      selectedPaths: ['/tmp/first.xlsx'],
      result: { status: 'ok' }
    });
    await tracker.appendOperationFiles({
      batchContext: batchContext(12),
      channel: 'recon-id-fix:import',
      selectedPaths: ['/tmp/second.xlsx'],
      result: { status: 'ok' }
    });
    assert.deepEqual(calls.map((call) => call.batchId), [11, 12]);
    assert.deepEqual(calls.map((call) => call.files[0].filePath), [
      '/tmp/first.xlsx',
      '/tmp/second.xlsx'
    ]);
  });

  test('无文件 action 仍正常结束当前任务，不建批或猜历史批次', async () => {
    const { calls, tracker } = createHarness();
    const result = await tracker.appendOperationFiles({
      batchContext: batchContext(21),
      channel: 'pending:reconcile:run',
      result: { status: 'success', runId: 3 }
    });
    assert.deepEqual(result, { ok: true, handled: false, batchId: 21, attempted: 0 });
    assert.deepEqual(calls, []);
  });

  test('资金对账批量导入只登记本次成功处理的输入', async () => {
    const { calls, tracker } = createHarness();
    await tracker.appendOperationFiles({
      batchContext: batchContext(31),
      channel: 'bank-statement:batch-import',
      selectedPaths: ['/tmp/bank.xlsx', '/tmp/gateway.xlsx', '/tmp/bad.xlsx'],
      result: {
        status: 'ok',
        results: [
          { fileName: 'bank.xlsx', status: 'ok' },
          { fileName: 'gateway.xlsx', status: 'ok' },
          { fileName: 'bad.xlsx', status: 'read-error' }
        ]
      }
    });
    assert.deepEqual(calls[0].files.map((file) => file.filePath), [
      '/tmp/bank.xlsx',
      '/tmp/gateway.xlsx'
    ]);
  });

  test('资金对账导出按白名单排除错误报告', () => {
    const files = resolveOperationFiles({
      channel: 'bank-statement:export',
      result: {
        status: 'ok',
        mainFilePath: '/tmp/main.xlsx',
        errorReportPath: '/tmp/error.xlsx',
        hitRowsReportPath: '/tmp/hit.xlsx',
        refundBackfillPath: '/tmp/refund.xlsx'
      }
    });
    assert.deepEqual(files.map((file) => file.filePath), [
      '/tmp/main.xlsx',
      '/tmp/hit.xlsx',
      '/tmp/refund.xlsx'
    ]);
  });

  test('runtime input descriptor 的解析快照和 SHA 优先保留', async () => {
    const { calls, tracker } = createHarness();
    const inputPath = path.resolve('/tmp/position-input.xlsx');
    const parsedSnapshot = { sizeBytes: 10, mtimeMs: 20, ctimeMs: 30, ino: 40 };
    const laterSnapshot = { sizeBytes: 10, mtimeMs: 50, ctimeMs: 60, ino: 40 };
    const expectedSha256 = 'b'.repeat(64);
    await tracker.appendOperationFiles({
      batchContext: batchContext(41),
      channel: 'position-reconciliation:bank:apply-import',
      result: { status: 'ok' },
      runtime: {
        inputPaths: [inputPath],
        inputFiles: [{
          filePath: inputPath,
          sourceSnapshot: parsedSnapshot,
          expectedSha256,
          sizeBytes: 10
        }],
        sourceSnapshots: new Map([[inputPath, laterSnapshot]])
      }
    });
    assert.deepEqual(calls[0].files[0].sourceSnapshot, parsedSnapshot);
    assert.equal(calls[0].files[0].expectedSha256, expectedSha256);
    assert.equal(calls[0].files[0].sizeBytes, 10);
  });

  test('普通输入可附加调用时捕获的 source snapshot', () => {
    const inputPath = path.resolve('/tmp/input.xlsx');
    const snapshot = { sizeBytes: 1, mtimeMs: 2, ctimeMs: 3, ino: 4 };
    const files = resolveOperationFiles({
      channel: 'recon-id-fix:import',
      selectedPaths: [inputPath],
      runtime: { sourceSnapshots: new Map([[inputPath, snapshot]]) }
    });
    assert.deepEqual(files[0].sourceSnapshot, snapshot);
  });

  test('收单、场景与 Pending 导入从 prepared 解析已选择输入文件', () => {
    const cases = [
      ['acquiringBillCurrency:importFlow', '/tmp/acquiring-flow.xlsx'],
      ['acquiringBillCurrency:importBill', '/tmp/acquiring-bill.xlsx'],
      ['pending:import:start', '/tmp/pending.xlsx'],
      ['scenarios:import-bundle-apply', '/tmp/scenario-bundle.json']
    ];
    for (const [channel, inputPath] of cases) {
      const files = resolveOperationFiles({
        channel,
        prepared: { inputPaths: [inputPath] },
        result: { status: 'success' }
      });
      assert.deepEqual(
        files.map((file) => [file.role, file.filePath]),
        [['input', inputPath]],
        channel
      );
    }
  });

  test('savePath 与 prepare.outputPaths 不进入 beforeStart 输入快照，覆盖后采集新输出', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-output-snapshot-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const outputPath = path.join(dir, 'existing.json');
    fs.writeFileSync(outputPath, 'old', 'utf8');

    const inputPaths = resolveOperationInputPaths({
      channel: 'scenarios:export-bundle',
      args: [{ savePath: outputPath }],
      prepared: { outputPaths: [outputPath] },
      selectedPaths: []
    });
    assert.deepEqual(inputPaths, []);
    const before = captureArchiveSourceSnapshots({ selectedPaths: inputPaths });
    assert.equal(before.has(path.resolve(outputPath)), false);

    fs.writeFileSync(outputPath, 'new-content', 'utf8');
    const after = captureArchiveSourceSnapshots({
      result: { filePath: outputPath }
    });
    assert.equal(after.get(path.resolve(outputPath)).sizeBytes, 11);
  });

  test('预存目标文件在 execute 失败时不得因 prepared.outputPaths 被当作本任务输出', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-old-target-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const outputPath = path.join(dir, 'already-exists.xlsx');
    fs.writeFileSync(outputPath, 'user-old-file', 'utf8');
    const files = resolveOperationFiles({
      channel: 'file:export-detail',
      prepared: { outputPaths: [outputPath] },
      result: { status: 'failed', message: 'copy failed' },
      runtime: {}
    });
    assert.deepEqual(files, []);
  });

  test('临时 MPT 按结果下标筛选，同名文件不互相冒充成功', () => {
    const sourcePaths = ['/tmp/first/same.gz', '/tmp/second/same.gz'];
    assert.deepEqual(
      selectSuccessfulPathsByResultIndex(sourcePaths, [
        { fileName: 'same.gz', status: 'ok' },
        { fileName: 'same.gz', status: 'failed' }
      ]),
      ['/tmp/first/same.gz']
    );
  });

  test('输入和输出均只归入同一个当前批次', async () => {
    const { calls, tracker } = createHarness();
    await tracker.appendOperationFiles({
      batchContext: batchContext(51),
      channel: 'position-reconciliation:source:prepare-import',
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputFiles: [{
          filePath: '/tmp/anomaly.xlsx',
          artifactKey: 'source-import-anomaly-report'
        }]
      },
      result: { status: 'ok' }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].batchId, 51);
    assert.deepEqual(calls[0].files.map((file) => [file.role, file.filePath]), [
      ['input', '/tmp/source.xlsx'],
      ['output', '/tmp/anomaly.xlsx']
    ]);
  });

  test('Pending writer 保留 path 同时返回 filePath 后会追加真实成功输出', async () => {
    const { calls, tracker } = createHarness();
    await tracker.appendOperationFiles({
      batchContext: batchContext(52),
      channel: 'pending:diff:export-single',
      result: {
        status: 'success',
        path: '/tmp/pending-diff.xlsx',
        filePath: '/tmp/pending-diff.xlsx'
      },
      runtime: {}
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].files.map((file) => [file.role, file.filePath]), [
      ['output', '/tmp/pending-diff.xlsx']
    ]);
  });

  test('skipArchive 明确跳过本次文件登记但保留任务批次', async () => {
    const { calls, tracker } = createHarness();
    const result = await tracker.appendOperationFiles({
      batchContext: batchContext(61),
      channel: 'file:import',
      runtime: { skipArchive: true, inputPaths: ['/tmp/source.xlsx'] }
    });
    assert.equal(result.handled, false);
    assert.deepEqual(calls, []);
  });

  test('append sink 异常向 lifecycle 传播，由 lifecycle 统一记录 failure/warning', async () => {
    const tracker = createArchiveOperationTracker({
      sink: { async appendFiles() { throw new Error('disk full'); } }
    });
    await assert.rejects(
      tracker.appendOperationFiles({
        batchContext: batchContext(71),
        channel: 'new-account:generate',
        result: { status: 'success' },
        runtime: { outputPaths: ['/tmp/result.xlsx'] }
      }),
      /disk full/
    );
  });

  test('PR3 tracker 同时支持 VCC 财务与 toolbox 文件动作', () => {
    const { tracker } = createHarness();
    assert.equal(tracker.supportsChannel('bank-statement:export'), true);
    assert.equal(tracker.supportsChannel('vccFinancialOp:export:result'), true);
    assert.equal(tracker.supportsChannel('vccOpCalc:import:scan'), true);
    assert.equal(tracker.supportsChannel('toolbox:merge'), true);
    assert.equal(tracker.supportsChannel('toolbox:split:export'), true);
    assert.equal(tracker.supportsChannel('toolbox:split:read'), false);
  });

  test('toolbox 同一批登记全部真实输入与最终输出，并保留 writer 摘要', async () => {
    const { calls, tracker } = createHarness();
    await tracker.appendOperationFiles({
      batchContext: batchContext(81),
      channel: 'toolbox:merge',
      result: { status: 'success', filePath: '/tmp/public/result.xlsx' },
      runtime: {
        inputPaths: ['/tmp/input-a.xlsx', '/tmp/input-b.xlsx'],
        inputFiles: [
          { filePath: '/tmp/input-a.xlsx', sourceSnapshot: { sizeBytes: 10, mtimeMs: 20 } },
          { filePath: '/tmp/input-b.xlsx', sourceSnapshot: { sizeBytes: 30, mtimeMs: 40 } }
        ],
        outputPaths: ['/tmp/public/result.xlsx'],
        outputFiles: [{
          filePath: '/tmp/public/result.xlsx',
          expectedSha256: 'a'.repeat(64),
          expectedSizeBytes: 52
        }]
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].batchId, 81);
    assert.deepEqual(calls[0].files.map((file) => [file.role, file.filePath]), [
      ['input', '/tmp/input-a.xlsx'],
      ['input', '/tmp/input-b.xlsx'],
      ['output', '/tmp/public/result.xlsx']
    ]);
    assert.equal(calls[0].files[2].expectedSha256, 'a'.repeat(64));
    assert.equal(calls[0].files[2].expectedSizeBytes, 52);
    assert.equal(calls[0].files.some((file) => file.filePath.includes('.toolbox-')), false);
  });

  test('VCC财务五类导入只登记成功处理组，三个export登记writer全部输出', () => {
    const files = [
      { sourceType: 'recharge_refund', filePath: '/tmp/recharge.xlsx' },
      { sourceType: 'fee_fx', filePath: '/tmp/fee.xlsx' },
      { sourceType: 'channel', filePath: '/tmp/channel.xlsx' },
      { sourceType: 'pending_archive_removal', filePath: '/tmp/pending.xlsx' },
      { sourceType: 'system_op', filePath: '/tmp/system.xlsx' }
    ];
    const imported = resolveOperationFiles({
      channel: 'vccFinancialOp:import:apply',
      args: [{ files }],
      result: {
        status: 'completed_with_errors',
        records: [
          { sourceType: 'recharge_refund', status: 'success' },
          { sourceType: 'fee_fx', status: 'success_with_skips' },
          { sourceType: 'channel', status: 'all_skipped' },
          { sourceType: 'pending_archive_removal', status: 'failed_validation' },
          { sourceType: 'system_op', status: 'failed_conflict' }
        ]
      }
    });
    assert.deepEqual(imported.map((file) => file.filePath), [
      '/tmp/recharge.xlsx',
      '/tmp/fee.xlsx',
      '/tmp/channel.xlsx'
    ]);
    assert.deepEqual(resolveOperationFiles({
      channel: 'vccFinancialOp:import:apply',
      args: [{ files }],
      result: {
        status: 'error',
        partialCommitted: true,
        records: [
          { sourceType: 'recharge_refund', status: 'success' },
          { sourceType: 'fee_fx', status: 'failed_validation' }
        ]
      }
    }).map((file) => file.filePath), ['/tmp/recharge.xlsx']);
    assert.deepEqual(resolveOperationFiles({
      channel: 'vccFinancialOp:export:result',
      result: { status: 'success', filePaths: ['/tmp/a.xlsx', '/tmp/b.xlsx'] }
    }).map((file) => file.filePath), ['/tmp/a.xlsx', '/tmp/b.xlsx']);
    assert.deepEqual(resolveOperationFiles({
      channel: 'vccFinancialOp:export:result',
      result: { status: 'error', partialCommitted: true, filePaths: ['/tmp/a.xlsx'] }
    }).map((file) => file.filePath), ['/tmp/a.xlsx']);
    assert.deepEqual(resolveOperationFiles({
      channel: 'vccFinancialOp:data-manager:export',
      result: { status: 'success', filePath: '/tmp/data.xlsx' }
    }).map((file) => file.filePath), ['/tmp/data.xlsx']);
    assert.deepEqual(resolveOperationFiles({
      channel: 'vccFinancialOp:export:import-audit',
      result: { status: 'success', filePath: '/tmp/audit.xlsx' }
    }).map((file) => file.filePath), ['/tmp/audit.xlsx']);
  });
});
