'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  MODULES,
  createArchiveOperationTracker,
  selectSuccessfulPathsByResultIndex
} = require('../../../src/main-process/archive-center/operation-tracker');

function createHarness() {
  const calls = [];
  let nextId = 1;
  const tracker = createArchiveOperationTracker({
    sink: {
      async createBatch(payload) {
        const batchId = `B-${nextId++}`;
        calls.push({ type: 'create', batchId, payload });
        return { batchId };
      },
      async appendFiles(payload) {
        calls.push({ type: 'append', payload });
        return { status: 'success' };
      }
    }
  });
  return { tracker, calls };
}

test.describe('archive operation tracker', () => {
  test('临时 MPT 修复按结果下标筛选，同名文件不会互相冒充成功', () => {
    const sourcePaths = ['/tmp/first/same.gz', '/tmp/second/same.gz'];
    assert.deepEqual(
      selectSuccessfulPathsByResultIndex(sourcePaths, [
        { fileName: 'same.gz', status: 'ok' },
        { fileName: 'same.gz', status: 'failed' }
      ]),
      ['/tmp/first/same.gz']
    );
  });

  test('仅声明的存档通道进入归档调度', () => {
    const { tracker } = createHarness();

    assert.equal(tracker.supportsChannel('bank-statement:run'), true);
    assert.equal(tracker.supportsChannel('toolbox:merge'), false);
    assert.equal(tracker.supportsChannel('template:save'), false);
    assert.equal(tracker.supportsChannel('pending:diff:export-aggregate'), false);
  });

  test('导入但未运行只保存在内存待办，运行成功才建立批次', async () => {
    const { tracker, calls } = createHarness();

    await tracker.handleOperation({
      channel: 'recon-id-fix:import',
      result: { status: 'ok' },
      selectedPaths: ['/tmp/input.xlsx']
    });
    assert.equal(calls.length, 0);

    await tracker.handleOperation({
      channel: 'recon-id-fix:run',
      result: { status: 'ok' }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.moduleId, MODULES.reconIdFix.id);
    assert.deepEqual(calls[0].payload.files.map((item) => [item.role, item.filePath]), [
      ['input', '/tmp/input.xlsx']
    ]);
  });

  test('资金对账批量导入只暂存 processed，linked 成功文件立即独立建批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'bank-statement:batch-import',
      selectedPaths: ['/tmp/bank.xlsx', '/tmp/gateway.xlsx', '/tmp/bad.xlsx'],
      result: {
        status: 'ok',
        results: [
          { fileName: 'bank.xlsx', status: 'ok', tableKey: 'bank-statement', outcome: 'processed' },
          { fileName: 'gateway.xlsx', status: 'ok', tableKey: 'gateway-bill', outcome: 'linked' },
          { fileName: 'bad.xlsx', status: 'read-error' }
        ]
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.moduleId, MODULES.linkedTable.id);
    assert.deepEqual(calls[0].payload.files.map((item) => item.filePath), ['/tmp/gateway.xlsx']);

    await tracker.handleOperation({ channel: 'bank-statement:run', result: { status: 'ok' } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].payload.moduleId, MODULES.bankStatement.id);
    assert.deepEqual(calls[1].payload.files.map((item) => item.filePath), ['/tmp/bank.xlsx']);
  });

  test('资金对账导出按白名单排除错误报告并挂到运行批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'bank-statement:import',
      result: { status: 'ok' },
      selectedPaths: ['/tmp/bank.xlsx']
    });
    await tracker.handleOperation({
      channel: 'bank-statement:run',
      result: { status: 'ok' },
      runtime: { runKey: 'run-1' }
    });
    await tracker.handleOperation({
      channel: 'bank-statement:export',
      result: {
        status: 'ok',
        mainFilePath: '/tmp/main.xlsx',
        errorReportPath: '/tmp/error.xlsx',
        hitRowsReportPath: '/tmp/hit.xlsx',
        refundBackfillPath: '/tmp/refund.xlsx'
      },
      runtime: { runKey: 'run-1' }
    });

    const append = calls.find((call) => call.type === 'append');
    assert.ok(append);
    assert.deepEqual(append.payload.files.map((item) => item.filePath), [
      '/tmp/main.xlsx',
      '/tmp/hit.xlsx',
      '/tmp/refund.xlsx'
    ]);
  });

  test('operation-tracker 保留通用 skipArchive 跳过能力', async () => {
    const { tracker, calls } = createHarness();
    const result = await tracker.handleOperation({
      channel: 'file:import',
      result: { status: 'success', detailReady: true },
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputPaths: ['/tmp/detail.xlsx'],
        skipArchive: true
      }
    });

    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0);
  });

  test('网银与月度余额携带模板元数据时均正常存档', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'file:import',
      result: { status: 'success', detailReady: true },
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputPaths: ['/tmp/detail.xlsx'],
        templateIds: [1, 2]
      }
    });
    await tracker.handleOperation({
      channel: 'monthly-balance:assemble',
      result: { status: 'ready' },
      runtime: {
        outputPaths: ['/tmp/monthly.xlsx'],
        templateIds: [1, 2]
      }
    });

    const creates = calls.filter((call) => call.type === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].payload.files.map((item) => item.filePath), [
      '/tmp/source.xlsx',
      '/tmp/detail.xlsx'
    ]);
    assert.deepEqual(creates[1].payload.files.map((item) => item.filePath), [
      '/tmp/monthly.xlsx'
    ]);
  });

  test('大账号选择续接成功后才建立网银存档批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'file:import',
      result: { status: 'big-account-selection-required' },
      runtime: { inputPaths: ['/tmp/source.xlsx'] }
    });
    assert.equal(calls.length, 0);

    await tracker.handleOperation({
      channel: 'file:complete-big-account-selection',
      result: { status: 'success', detailReady: true, balanceReady: true },
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputPaths: ['/tmp/detail.xlsx', '/tmp/balance.xlsx']
      }
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload.files.map((item) => item.filePath), [
      '/tmp/source.xlsx',
      '/tmp/detail.xlsx',
      '/tmp/balance.xlsx'
    ]);
  });

  test('余额补录把新生成余额追加到原导入批次，不重复建立批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'file:import',
      result: { status: 'manual-balance-required', detailReady: true },
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputPaths: ['/tmp/detail.xlsx']
      }
    });
    await tracker.handleOperation({
      channel: 'file:save-balance-seed',
      result: { status: 'success', detailReady: true, balanceReady: true },
      runtime: { outputPaths: ['/tmp/detail.xlsx', '/tmp/balance.xlsx'] }
    });

    assert.equal(calls.filter((call) => call.type === 'create').length, 1);
    const append = calls.find((call) => call.type === 'append');
    assert.deepEqual(append.payload.files.map((item) => item.filePath), ['/tmp/balance.xlsx']);
  });

  test('月度余额独立存档不覆盖普通账单等待补录的活动批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'file:import',
      result: { status: 'manual-balance-required', detailReady: true },
      runtime: {
        inputPaths: ['/tmp/source.xlsx'],
        outputPaths: ['/tmp/detail.xlsx']
      }
    });
    await tracker.handleOperation({
      channel: 'monthly-balance:assemble',
      result: { status: 'ready' },
      runtime: { outputPaths: ['/tmp/monthly.xlsx'] }
    });
    await tracker.handleOperation({
      channel: 'file:save-balance-seed',
      result: { status: 'success', detailReady: true, balanceReady: true },
      runtime: { outputPaths: ['/tmp/detail.xlsx', '/tmp/balance.xlsx'] }
    });

    const creates = calls.filter((call) => call.type === 'create');
    const append = calls.find((call) => call.type === 'append');
    assert.equal(creates.length, 2);
    assert.equal(append.payload.batchId, creates[0].batchId);
    assert.notEqual(append.payload.batchId, creates[1].batchId);
    assert.deepEqual(append.payload.files.map((item) => item.filePath), ['/tmp/balance.xlsx']);
  });

  test('导入成功时的源文件身份快照会跟随待办进入运行批次', async () => {
    const { tracker, calls } = createHarness();
    const sourceSnapshot = { sizeBytes: 10, mtimeMs: 20, ctimeMs: 30, ino: 40 };
    const inputPath = path.resolve('/tmp/input.xlsx');
    await tracker.handleOperation({
      channel: 'recon-id-fix:import',
      result: { status: 'ok' },
      selectedPaths: [inputPath],
      runtime: { sourceSnapshots: new Map([[inputPath, sourceSnapshot]]) }
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:run',
      result: { status: 'ok' }
    });

    assert.deepEqual(calls[0].payload.files[0].sourceSnapshot, sourceSnapshot);
  });

  test('存档异常转成告警，不向业务调用方抛出', async () => {
    const warnings = [];
    const tracker = createArchiveOperationTracker({
      sink: {
        async createBatch() { throw new Error('disk full'); },
        async appendFiles() { throw new Error('disk full'); }
      },
      onWarning: (warning) => warnings.push(warning)
    });

    const result = await tracker.handleOperation({
      channel: 'new-account:generate',
      result: { status: 'success' },
      runtime: { outputPaths: ['/tmp/new-account.xlsx'] }
    });

    assert.equal(result.archiveFailed, true);
    assert.equal(result.persistentRetryAvailable, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /disk full/);
  });

  test('链接表部分文件存档失败会汇总为用户可见告警', async () => {
    const calls = [];
    const tracker = createArchiveOperationTracker({
      sink: {
        async createBatch(payload) {
          calls.push(payload);
          return {
            batchId: `B-${calls.length}`,
            archiveFailed: payload.files[0].filePath.endsWith('failed.xlsx'),
            warning: { message: 'copy failed' }
          };
        },
        async appendFiles() { return { status: 'success' }; }
      }
    });

    const result = await tracker.handleOperation({
      channel: 'linked-table:import',
      selectedPaths: ['/tmp/ok.xlsx', '/tmp/failed.xlsx'],
      result: {
        status: 'ok',
        results: [
          { fileName: 'ok.xlsx', status: 'ok' },
          { fileName: 'failed.xlsx', status: 'ok' }
        ]
      }
    });

    assert.equal(result.archiveFailed, true);
    assert.match(result.warning.message, /1 个存档批次/);
  });

  test('收单运行只存一次同路径 diff/report 结果', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'acquiringBillCurrency:importFlow',
      args: [{ monthKey: '2026-07', filePaths: ['/tmp/flow.xlsx'], confirmOverwrite: true }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'acquiringBillCurrency:run',
      args: [{ monthKey: '2026-07' }],
      result: {
        status: 'success',
        runId: 9,
        diffFilePath: '/tmp/diff.xlsx',
        reportFilePath: '/tmp/diff.xlsx'
      }
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload.files.map((item) => item.filePath), [
      '/tmp/flow.xlsx',
      '/tmp/diff.xlsx'
    ]);
  });

  test('同一运行只归档第一次成功结果，后续另存不追加', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'recon-id-fix:import',
      result: { status: 'ok' },
      selectedPaths: ['/tmp/recon.xlsx']
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:run',
      result: { status: 'ok' },
      runtime: { runKey: 'run-1' }
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:export',
      result: { status: 'ok', mainFilePath: '/tmp/first.xlsx' },
      runtime: { runKey: 'run-1' }
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:export',
      result: { status: 'ok', mainFilePath: '/tmp/second.xlsx' },
      runtime: { runKey: 'run-1' }
    });

    const appends = calls.filter((call) => call.type === 'append');
    assert.equal(appends.length, 1);
    assert.equal(appends[0].payload.files[0].filePath, '/tmp/first.xlsx');
  });

  test('资金对账页面发起的网关 ReconID 修复归到资金对账模块', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'recon-id-fix:import',
      result: { status: 'ok' },
      selectedPaths: ['/tmp/gateway-recon.xlsx']
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:run',
      result: { status: 'ok' },
      runtime: {
        runKey: 'gateway-run',
        originModuleId: MODULES.bankStatement.id
      }
    });
    await tracker.handleOperation({
      channel: 'recon-id-fix:export',
      result: { status: 'ok', mainFilePath: '/tmp/gateway-fixed.xlsx' },
      runtime: {
        runKey: 'gateway-run',
        originModuleId: MODULES.bankStatement.id
      }
    });

    const create = calls.find((call) => call.type === 'create');
    const append = calls.find((call) => call.type === 'append');
    assert.equal(create.payload.moduleId, MODULES.bankStatement.id);
    assert.deepEqual(create.payload.files.map((item) => item.filePath), ['/tmp/gateway-recon.xlsx']);
    assert.equal(append.payload.batchId, create.batchId);
  });

  test('聚合与区间导出不进入任何运行批次', async () => {
    const { tracker, calls } = createHarness();
    for (const channel of [
      'pending:diff:export-aggregate',
      'bankBuRecon:export:aggregate',
      'bizOpRecon:export:date-range'
    ]) {
      const result = await tracker.handleOperation({
        channel,
        result: { status: 'success', filePath: `/tmp/${channel}.xlsx` }
      });
      assert.equal(result.excluded, true);
    }
    assert.equal(calls.length, 0);
  });

  test('Pending 批次包含上下月与移除文件，仅单次差异进入结果槽', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'pending:import:start',
      args: [{ yearMonth: '2026-06', files: ['/tmp/upper.xlsx'] }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pending:removed:import',
      args: [{ yearMonth: '2026-06', files: ['/tmp/removed.xlsx'] }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pending:import:start',
      args: [{ yearMonth: '2026-05', files: ['/tmp/lower.xlsx'] }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pending:reconcile:run',
      args: [{ upperMonth: '2026-06', lowerMonth: '2026-05' }],
      result: { status: 'success', runId: 31 }
    });
    await tracker.handleOperation({
      channel: 'pending:diff:export-single',
      args: [{ runId: 31 }],
      result: { status: 'success', filePath: '/tmp/pending-diff.xlsx' }
    });

    const create = calls.find((call) => call.type === 'create');
    assert.equal(create.payload.moduleId, MODULES.pending.id);
    assert.deepEqual(create.payload.files.map((item) => item.filePath), [
      '/tmp/upper.xlsx',
      '/tmp/removed.xlsx',
      '/tmp/lower.xlsx'
    ]);
    assert.equal(calls.find((call) => call.type === 'append').payload.files[0].filePath, '/tmp/pending-diff.xlsx');
  });

  test('银行 BU 与业务 OP 按月份或日期隔离输入并绑定单次输出', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'bankBuRecon:import:run',
      args: [{ yearMonth: '2026-07', pendingPath: '/tmp/bu-pending.xlsx', bankPath: '/tmp/bu-bank.xlsx' }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'bankBuRecon:run',
      args: [{ yearMonth: '2026-07' }],
      result: { status: 'success', runId: 7 }
    });
    await tracker.handleOperation({
      channel: 'bankBuRecon:export:single',
      args: [{ runId: 7 }],
      result: { status: 'success', filePath: '/tmp/bu-result.xlsx' }
    });

    await tracker.handleOperation({
      channel: 'bizOpRecon:import:run-biz-op',
      args: [{ date: '2026-07-20', filePath: '/tmp/op.xlsx' }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'bizOpRecon:import:run-flow',
      args: [{ date: '2026-07-20', filePaths: ['/tmp/flow-a.xlsx', '/tmp/flow-b.xlsx'] }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'bizOpRecon:run',
      args: [{ date: '2026-07-20', buName: 'BU-A' }],
      result: { status: 'success', runId: 8 }
    });
    await tracker.handleOperation({
      channel: 'bizOpRecon:export:date',
      args: [{ runId: 8 }],
      result: { status: 'success', filePath: '/tmp/op-result.xlsx' }
    });

    const creates = calls.filter((call) => call.type === 'create');
    assert.deepEqual(creates[0].payload.files.map((item) => item.filePath), [
      '/tmp/bu-pending.xlsx', '/tmp/bu-bank.xlsx'
    ]);
    assert.deepEqual(creates[1].payload.files.map((item) => item.filePath), [
      '/tmp/op.xlsx', '/tmp/flow-a.xlsx', '/tmp/flow-b.xlsx'
    ]);
    assert.equal(calls.filter((call) => call.type === 'append').length, 2);
  });

  test('VCC 保存只归档流水输入，不虚构结果文件', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'vccOpCalc:import:scan',
      args: [{ filePaths: ['/tmp/vcc-a.xlsx', '/tmp/vcc-b.xlsx'] }],
      result: { status: 'success' }
    });
    assert.equal(calls.length, 0);
    await tracker.handleOperation({
      channel: 'vccOpCalc:run:save',
      result: { status: 'success', runId: 4 }
    });
    assert.deepEqual(calls[0].payload.files.map((item) => [item.role, item.filePath]), [
      ['input', '/tmp/vcc-a.xlsx'],
      ['input', '/tmp/vcc-b.xlsx']
    ]);
  });

  test('前置资金对账将临时 MPT 独立存档，并把银行输入与首次渠道结果绑定', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:import-mpt',
      selectedPaths: ['/tmp/inbound.gz', '/tmp/bad.gz'],
      result: { status: 'ok', results: [{ status: 'ok' }, { status: 'failed' }] }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:import-bank',
      selectedPaths: ['/tmp/pre-bank.xlsx'],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:run',
      result: { status: 'success', runId: 'pre-1' }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:export',
      result: { status: 'success', files: [
        { filePath: '/tmp/channel-a.xlsx' },
        { filePath: '/tmp/channel-b.xlsx' }
      ] }
    });

    const creates = calls.filter((call) => call.type === 'create');
    assert.equal(creates[0].payload.moduleCode, MODULES.preFundTemp.code);
    assert.deepEqual(creates[0].payload.files.map((item) => item.filePath), ['/tmp/inbound.gz']);
    assert.equal(creates[1].payload.moduleCode, MODULES.preFund.code);
    assert.deepEqual(creates[1].payload.files.map((item) => item.filePath), ['/tmp/pre-bank.xlsx']);
    assert.deepEqual(calls.find((call) => call.type === 'append').payload.files.map((item) => item.filePath), [
      '/tmp/channel-a.xlsx', '/tmp/channel-b.xlsx'
    ]);
  });

  test('平盘输入、回导和每次结果导出都独立立即存档，不依赖进程内运行批次', async () => {
    const { tracker, calls } = createHarness();

    await tracker.handleOperation({
      channel: 'position-reconciliation:source:prepare-import',
      result: {
        status: 'ok',
        results: [
          { status: 'ok', fileName: 'transfer.xlsx' },
          { status: 'failed', fileName: 'bad.xlsx' }
        ]
      },
      runtime: { inputPaths: ['/tmp/transfer.xlsx'] }
    });
    await tracker.handleOperation({
      channel: 'position-reconciliation:bank:apply-import',
      result: { status: 'ok' },
      runtime: {
        inputPaths: ['/tmp/position-bank.xlsx'],
        metadata: { scopes: [{ channel: 'DBS', monthKey: '2026-07' }] }
      }
    });
    await tracker.handleOperation({
      channel: 'position-reconciliation:run:export',
      result: { status: 'ok', runId: 31 },
      runtime: { runKey: 31, outputPaths: ['/tmp/position-result.xlsx'] }
    });
    await tracker.handleOperation({
      channel: 'position-reconciliation:run:import-result',
      result: { status: 'ok', runId: 31 },
      runtime: { runKey: 31, inputPaths: ['/tmp/position-edited.xlsx'] }
    });

    const creates = calls.filter((call) => call.type === 'create');
    assert.equal(creates.length, 4);
    assert.deepEqual(creates.map((call) => call.payload.files[0].filePath), [
      '/tmp/transfer.xlsx',
      '/tmp/position-bank.xlsx',
      '/tmp/position-result.xlsx',
      '/tmp/position-edited.xlsx'
    ]);
    assert.equal(calls.filter((call) => call.type === 'append').length, 0);
  });

  test('平盘银行批量导入立即存档全部成功输入，跨重启无需恢复范围内存', async () => {
    const { tracker, calls } = createHarness();

    await tracker.handleOperation({
      channel: 'position-reconciliation:bank:apply-import',
      result: { status: 'ok' },
      runtime: {
        inputPaths: ['/tmp/dbs.xlsx', '/tmp/maybank.xlsx'],
        metadata: {
          scopes: [
            { channel: 'DBS', monthKey: '2026-07' },
            { channel: 'MAYBANK', monthKey: '2026-08' }
          ],
          scopeInputs: [
            { channel: 'DBS', monthKey: '2026-07', inputPaths: ['/tmp/dbs.xlsx'] },
            { channel: 'MAYBANK', monthKey: '2026-08', inputPaths: ['/tmp/maybank.xlsx'] }
          ]
        }
      }
    });

    const importedBatch = calls.find((call) => call.type === 'create');
    assert.deepEqual(
      importedBatch.payload.files.map((item) => item.filePath),
      ['/tmp/dbs.xlsx', '/tmp/maybank.xlsx']
    );
  });

  test('临时 MPT 修复不会抢占正式前置资金对账的首次结果', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:import-bank',
      selectedPaths: ['/tmp/pre-bank.xlsx'],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:run',
      result: { status: 'success', runId: 'pre-1' }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:mpt-errors:repair',
      result: { status: 'success' },
      runtime: { inputPaths: ['/tmp/repaired.gz'] }
    });
    await tracker.handleOperation({
      channel: 'pre-fund-reconciliation:export',
      result: { status: 'success', files: [{ filePath: '/tmp/result.xlsx' }] }
    });

    const creates = calls.filter((call) => call.type === 'create');
    const formalBatch = creates.find((call) => call.payload.moduleCode === MODULES.preFund.code);
    const tempBatch = creates.find((call) => call.payload.moduleCode === MODULES.preFundTemp.code);
    const append = calls.find((call) => call.type === 'append');
    assert.ok(formalBatch);
    assert.ok(tempBatch);
    assert.equal(append.payload.batchId, formalBatch.batchId);
    assert.notEqual(append.payload.batchId, tempBatch.batchId);
  });

  test('没有本次启动周期输入或结果的历史运行不创建空批次', async () => {
    const { tracker, calls } = createHarness();
    const result = await tracker.handleOperation({
      channel: 'pending:reconcile:run',
      args: [{ upperMonth: '2026-06', lowerMonth: '2026-05' }],
      result: { status: 'success', runId: 99 }
    });

    assert.equal(result.handled, false);
    assert.equal(result.excluded, 'no-current-session-files');
    assert.equal(calls.length, 0);
  });

  test('重启后历史单次结果导出不新建输出-only批次', async () => {
    const { tracker, calls } = createHarness();
    const result = await tracker.handleOperation({
      channel: 'pending:diff:export-single',
      args: [{ runId: 99 }],
      result: { status: 'success', filePath: '/tmp/history.xlsx' }
    });

    assert.equal(result.handled, false);
    assert.equal(result.excluded, 'no-active-batch');
    assert.equal(calls.length, 0);
  });

  test('显式历史运行号找不到批次时不得回退并写入最新批次', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'pending:import:start',
      args: [{ yearMonth: '2026-06', files: ['/tmp/current.xlsx'] }],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'pending:reconcile:run',
      args: [{ upperMonth: '2026-06' }],
      result: { status: 'success', runId: 31 }
    });
    const result = await tracker.handleOperation({
      channel: 'pending:diff:export-single',
      args: [{ runId: 99 }],
      result: { status: 'success', filePath: '/tmp/history.xlsx' }
    });

    assert.equal(result.handled, false);
    assert.equal(result.excluded, 'no-active-batch');
    assert.equal(calls.filter((call) => call.type === 'append').length, 0);
  });

  test('重复入金匹配绑定双输入与首次邮件结果', async () => {
    const { tracker, calls } = createHarness();
    await tracker.handleOperation({
      channel: 'duplicate-inbound-match:import-files',
      selectedPaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx'],
      result: { status: 'success' }
    });
    await tracker.handleOperation({
      channel: 'duplicate-inbound-match:run',
      result: { status: 'success', runId: 'dup-1' }
    });
    await tracker.handleOperation({
      channel: 'duplicate-inbound-match:export',
      result: { status: 'success', filePath: '/tmp/mail.xlsx' }
    });

    assert.deepEqual(calls[0].payload.files.map((item) => item.filePath), [
      '/tmp/bank.xlsx', '/tmp/document.xlsx'
    ]);
    assert.equal(calls[1].payload.files[0].filePath, '/tmp/mail.xlsx');
  });
});
