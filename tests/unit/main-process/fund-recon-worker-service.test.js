'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FUND_RECON_ACTIONS
} = require('../../../src/main-process/fund-recon-worker/policies');
const {
  createFundReconService
} = require('../../../src/main-process/fund-recon-worker/service');
const { runReconciliation } = require('../../../src/main-process/reconciliation-orchestrator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function noOpRunResult(bankRows) {
  return {
    modifiedRows: [],
    unmatchedRows: bankRows,
    modifications: [],
    errorReport: [],
    stats: { inputRows: bankRows.length },
    platformCleanupRows: [],
    refundBackfillRows: [],
    refundUnmatchedRows: [],
    refundHitDepositBizIds: [],
    paymentOfflineMatchedPairs: [],
    manyToManyReviewRows: []
  };
}

function evidenceProvider(signatureRef) {
  return {
    openRunSnapshot() {
      return {
        db: {},
        close() {},
        deps: {},
        scenarios: [],
        datePolicy: { enabled: true, toleranceDays: 1, ownerScenarioId: null, signature: 'policy' },
        initialWarnings: [],
        flags: {
          refundBackfillEnabled: false,
          paymentOfflineEnabled: false,
          reconSourceMidEnabled: false,
          dbsChargeScenarioEnabled: false
        },
        gatewayPools: { exactRows: [], c3Rows: [] },
        depositRows: [],
        reconRows: [],
        evidenceSignature: signatureRef.value,
        evidence: { version: 1 }
      };
    }
  };
}

function serviceHarness(overrides = {}) {
  const signatureRef = { value: 'a'.repeat(64) };
  const runCalls = [];
  const service = createFundReconService({
    evidenceProvider: evidenceProvider(signatureRef),
    readBankSource(source) {
      return {
        filePath: source.filePath,
        fileName: source.filePath.split('/').at(-1),
        headers: ['Channel', '地区'],
        rows: [{ _rowId: 'row_0', Channel: 'JPM', 地区: 'US', marker: source.filePath }],
        rowCount: 1
      };
    },
    readGatewaySource(source) {
      return { filePath: source.filePath, fileName: 'gw.xlsx', rows: [], rowCount: 0 };
    },
    readRefundSource(source) {
      return { filePath: source.filePath, fileName: 'refund.xlsx', rows: [], rowCount: 0 };
    },
    async runReconciliation(input) {
      runCalls.push(input);
      if (overrides.runFailure) throw overrides.runFailure;
      return noOpRunResult(input.bankRows);
    },
    artifactGenerator: overrides.artifactGenerator || {
      async generate() {
        return {
          artifactKey: 'manifest-1',
          stagingPath: '/tmp/manifest.json',
          byteSize: 10,
          sha256: 'b'.repeat(64)
        };
      }
    },
    estimateFootprint: () => ({ estimatedBytes: 4096, budgetBytes: 268435456 }),
    now: (() => { let value = 100; return () => ++value; })()
  });
  return { service, signatureRef, runCalls };
}

const adopt = async () => {};

test('import reservation拒绝时保留旧stable state，busy命令不排队', async () => {
  const { service } = serviceHarness();
  await service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/one.xlsx' }]
  }, { adoptCandidate: adopt });
  const stable = service.inspectForTest();

  await assert.rejects(service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/two.xlsx' }]
  }, { adoptCandidate: async () => { throw Object.assign(new Error('reject'), { code: 'RESERVATION_REJECTED' }); } }),
  (error) => error.code === 'RESERVATION_REJECTED');
  assert.strictEqual(service.inspectForTest(), stable);

  const gate = deferred();
  const first = service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/three.xlsx' }]
  }, { adoptCandidate: () => gate.promise });
  await assert.rejects(service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/four.xlsx' }]
  }, { adoptCandidate: adopt }), (error) => error.code === 'SERVICE_BUSY');
  gate.resolve();
  await first;
});

test('run使用同一working rows并仅在全成功+adopt ACK后发布结果', async () => {
  const { service, runCalls } = serviceHarness();
  await service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/bank.xlsx' }]
  }, { adoptCandidate: adopt });
  const beforeRun = service.inspectForTest();
  const adoption = deferred();
  const running = service.execute(FUND_RECON_ACTIONS.RUN, {
    databasePath: '/tmp/main.sqlite'
  }, { adoptCandidate: () => adoption.promise });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(service.inspectForTest(), beforeRun, 'adopt ACK前不得发布processingResult');
  adoption.resolve();
  const result = await running;
  assert.equal(result.operation, 'run');
  assert.equal(result.evidenceSignature, 'a'.repeat(64));
  assert.equal(runCalls.length, 1);
  assert.notStrictEqual(runCalls[0].bankRows, beforeRun.bankSession.rows);
  assert.deepEqual(runCalls[0].bankRows, beforeRun.bankSession.rows);
  assert.equal(service.status().stableSummary.hasProcessingResult, true);
});

test('run失败不覆盖旧结果；证据变化使旧结果fail closed且invalidate ACK失败也不能绕过', async () => {
  const harness = serviceHarness();
  await harness.service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/bank.xlsx' }]
  }, { adoptCandidate: adopt });
  await harness.service.execute(FUND_RECON_ACTIONS.RUN, {
    databasePath: '/tmp/main.sqlite'
  }, { adoptCandidate: adopt });
  const stable = harness.service.inspectForTest();

  await assert.rejects(harness.service.invalidate('scenario-change', {
    adoptCandidate: async () => { throw Object.assign(new Error('ack lost'), { code: 'ADOPT_ACK_LOST' }); }
  }), (error) => error.code === 'ADOPT_ACK_LOST');
  assert.strictEqual(harness.service.inspectForTest(), stable);

  harness.signatureRef.value = 'c'.repeat(64);
  await assert.rejects(harness.service.execute(FUND_RECON_ACTIONS.EXPORT, {
    databasePath: '/tmp/main.sqlite',
    stagingPlan: {}
  }), (error) => error.code === 'FUND_RECON_RESULT_STALE');
  assert.strictEqual(harness.service.inspectForTest(), stable);
});

test('export只返回单一manifest artifact且不改变state revision', async () => {
  const { service } = serviceHarness();
  await service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/bank.xlsx' }]
  }, { adoptCandidate: adopt });
  await service.execute(FUND_RECON_ACTIONS.RUN, {
    databasePath: '/tmp/main.sqlite'
  }, { adoptCandidate: adopt });
  const revision = service.status().stateRevision;
  const result = await service.execute(FUND_RECON_ACTIONS.EXPORT, {
    databasePath: '/tmp/main.sqlite', stagingPlan: {}
  });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.stateRevision, revision);
  assert.equal(service.status().stateRevision, revision);
});

test('run/export缺少databasePath时fail closed而不是误用cwd', async () => {
  const { service } = serviceHarness();
  await service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/one.xlsx' }]
  }, { adoptCandidate: adopt });
  await assert.rejects(
    service.execute(FUND_RECON_ACTIONS.RUN, {}, { adoptCandidate: adopt }),
    (error) => error.code === 'FUND_RECON_DATABASE_PATH_REQUIRED'
  );
});

test('Service真实编排结果与同输入inline golden逐字段等价', async () => {
  const scenario = {
    id: 200,
    name: 'R2-冲销打标',
    category: 'offset-bill-mark',
    priority: 5,
    enabled: true,
    displayIndex: 1,
    config: {
      billTypes: [{ seq: 1, conditions: [{ field: 'BillTag', op: '包含', value: 'OFFSET' }] }],
      reconFields: [],
      markValue: { type: 1, field: 'Transaction Description', value: '已对账' }
    }
  };
  const sourceRows = [
    {
      _rowId: 'row_0', ReconciliationId: '', FundType: '', MerchantId: 'M001', Currency: 'USD',
      'Credit Amount': '10', 'Debit Amount': '', BillDate: '2026-06-01',
      'Transaction Description': '', BillTag: 'OFFSET', Channel: 'JPM', 地区: 'US'
    },
    {
      _rowId: 'row_1', ReconciliationId: '', FundType: '', MerchantId: 'M002', Currency: 'USD',
      'Credit Amount': '20', 'Debit Amount': '', BillDate: '2026-06-01',
      'Transaction Description': '', BillTag: '', Channel: 'JPM', 地区: 'US'
    }
  ];
  const snapshot = () => ({
    db: {}, close() {}, deps: {}, scenarios: [scenario],
    datePolicy: { enabled: true, toleranceDays: 1, ownerScenarioId: null, signature: 'policy' },
    initialWarnings: [],
    flags: {
      refundBackfillEnabled: false,
      paymentOfflineEnabled: false,
      reconSourceMidEnabled: false,
      dbsChargeScenarioEnabled: false
    },
    gatewayPools: { exactRows: [], c3Rows: [] },
    depositRows: [], reconRows: [], evidenceSignature: 'c'.repeat(64), evidence: { version: 1 }
  });
  const service = createFundReconService({
    evidenceProvider: { openRunSnapshot: snapshot },
    readBankSource(source) {
      return {
        filePath: source.filePath,
        fileName: 'golden.xlsx',
        headers: Object.keys(sourceRows[0]).filter((key) => key !== '_rowId'),
        rows: structuredClone(sourceRows),
        rowCount: sourceRows.length
      };
    },
    estimateFootprint: () => ({ estimatedBytes: 4096, budgetBytes: 268435456 }),
    now: (() => { let value = 500; return () => ++value; })()
  });
  await service.execute(FUND_RECON_ACTIONS.IMPORT, {
    sources: [{ kind: 'bank', filePath: '/tmp/golden.xlsx' }]
  }, { adoptCandidate: adopt });
  const expected = await runReconciliation({
    bankRows: structuredClone(sourceRows),
    gwRows: [],
    c3GwRows: [],
    scenarios: [scenario],
    deps: {},
    refundContext: { refundOrderRows: [], depositRows: [] },
    fundTransferReconContext: { reconRows: [] },
    dispatchReconContext: { dispatchReconRows: [] },
    fundTransferAuditContext: { reconRows: [] },
    fundTransferDatePolicy: snapshot().datePolicy,
    initialWarnings: []
  });
  await service.execute(FUND_RECON_ACTIONS.RUN, { databasePath: '/tmp/tool-data.sqlite' }, {
    adoptCandidate: adopt,
    onProgress() {}
  });
  const actual = service.inspectForTest().processingResult;
  for (const key of [
    'modifiedRows', 'unmatchedRows', 'modifications', 'errorReport', 'stats',
    'platformCleanupRows', 'refundBackfillRows', 'refundUnmatchedRows',
    'refundHitDepositBizIds', 'paymentOfflineMatchedPairs', 'manyToManyReviewRows'
  ]) {
    assert.deepEqual(actual[key], expected[key] || [], `${key} 必须与 inline golden 等价`);
  }
  assert.equal(actual.modifiedRows.length + actual.unmatchedRows.length, sourceRows.length);
});
