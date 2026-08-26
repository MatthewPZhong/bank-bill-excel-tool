'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createTaskPolicyRegistry
} = require('../../../../src/main-process/archive-center/task-policy-registry');
const {
  taskResultStatus
} = require('../../../../src/main-process/archive-center/task-lifecycle');
const {
  createPreFundReconciliationService
} = require('../../../../src/main-process/pre-fund-reconciliation/service');
const {
  createOrderedMptCoordinator
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator');

const root = path.resolve(__dirname, '../../../..');
const fixture = JSON.parse(fs.readFileSync(path.join(
  root,
  'tests/fixtures/pre-fund-reconciliation/e05-p0-mixed-result.json'
), 'utf8'));

function mirrorDatabase(userDataDir) {
  const noop = () => null;
  return {
    dbPath: path.join(userDataDir, 'tool-data.sqlite'),
    createPreFundReconciliationRunMirror: noop,
    finishPreFundReconciliationRunMirror: noop,
    getPreFundReconciliationRunMirrorByTaskRun: noop,
    acknowledgePreFundReconciliationRunMirror: noop,
    failPreFundReconciliationRunMirror: noop,
    markPreFundReconciliationRunMirrorUnavailable: noop,
    listPreFundReconciliationRunMirrors: () => []
  };
}

test('真实service任意per-file transport异常形成mixed结果并继续，父shape由fixture冻结', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-p0-mixed-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const service = createPreFundReconciliationService({
    userDataDir,
    database: mirrorDatabase(userDataDir),
    templatePath: 'unused.xlsx'
  });
  let callCount = 0;
  service.tempStore.importFile = async () => {
    callCount += 1;
    if (callCount === 2) {
      throw Object.assign(new Error('worker exited 9'), {
        code: 'PREFUND_PARSER_TRANSPORT_CRASH'
      });
    }
    return callCount === 1
      ? {
          status: 'imported',
          batch: {
            sourceType: 'MPT_INBOUND_GATEWAY',
            rowCount: 1,
            excludedRowCount: 0
          }
        }
      : {
          status: 'replaced',
          batch: {
            sourceType: 'MPT_OUTBOUND_GATEWAY',
            rowCount: 3,
            excludedRowCount: 1
          }
        };
  };

  const result = await service.importMptFiles([
    '/probe/first.txt',
    '/probe/crashed.txt',
    '/probe/last.txt'
  ], { producerTaskRunId: 'task-mixed-golden' });
  assert.equal(callCount, 3, 'transport crash后必须继续最后一个文件');
  assert.deepEqual(result, fixture.serviceResult);
  assert.equal(fixture.transportPolicy, 'fail-unit-and-continue');
});

test('真实policy/TaskLifecycle执行与handler/Renderer源码seam冻结partial terminal', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const handler = main.slice(
    main.indexOf("trackedIpcHandle('pre-fund-reconciliation:import-mpt'"),
    main.indexOf("trackedIpcHandle('pre-fund-reconciliation:mpt-errors:export'")
  );
  assert.match(handler, /const imported = await getPreFundReconciliationService\(\)\.importMptFiles\(/);
  assert.match(handler, /return imported;/);
  assert.doesNotMatch(handler, /failedCount[\s\S]*status:\s*'failed'/);

  const policy = createTaskPolicyRegistry().require('pre-fund-reconciliation:import-mpt');
  assert.equal(policy.resultClassifier(fixture.serviceResult), fixture.taskTerminal);
  assert.equal(
    taskResultStatus(fixture.serviceResult, policy.resultClassifier),
    fixture.taskTerminal
  );

  const rendererHandler = renderer.slice(
    renderer.indexOf('async function handlePreFundImportMpt('),
    renderer.indexOf('async function handlePreFundRun(')
  );
  assert.match(rendererHandler, /result\.results\.filter\(\(item\) => item\.status !== 'ok'\)/);
  assert.match(rendererHandler, /部分文件导入失败/);
  assert.match(rendererHandler, /finally \{[\s\S]*await finishPreFundReconciliationAction\(\)/);
  assert.equal(fixture.rendererTerminal, 'partial-failure-alert-then-session-refresh');
});

test('Ordered Coordinator乱序transport crash同样只失败当前unit并继续后续unit', async () => {
  const consumed = [];
  const coordinator = createOrderedMptCoordinator({
    fileCount: 3,
    readyHighWaterMark: 3,
    async consumeReady(spool, { fileIndex }) {
      consumed.push(fileIndex);
      return { status: 'ok', fileIndex, spoolId: spool.id };
    }
  });
  const [lastPermit, crashPermit, firstPermit] = await Promise.all([
    coordinator.acquireDispatchPermit(),
    coordinator.acquireDispatchPermit(),
    coordinator.acquireDispatchPermit()
  ]);
  lastPermit.submitReady(2, { id: 'last' });
  crashPermit.submitTransportCrash(1, fixture.serviceResult.results[1]);
  firstPermit.submitReady(0, { id: 'first' });
  const results = await coordinator.completion();
  assert.deepEqual(consumed, [0, 2]);
  assert.deepEqual(results.map((result) => result.status), ['ok', 'failed', 'ok']);
  assert.deepEqual(results[1], fixture.serviceResult.results[1]);
});

test('managed strict failure沿用legacy顶层repair token shape且新轮清除旧token', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-b-managed-token-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const service = createPreFundReconciliationService({
    userDataDir,
    database: mirrorDatabase(userDataDir),
    templatePath: path.join(root, 'assets', '前置资金对账模板.xlsx')
  });
  service.beginManagedMptImport();
  const [failed] = service.adoptManagedMptImportResults(['/tmp/MPT_INBOUND_GATEWAY_20260708_1.txt'], [{
    status: 'failed',
    fileName: 'MPT_INBOUND_GATEWAY_20260708_1.txt',
    code: 'MPT_ROW_ERRORS',
    message: 'row failed',
    detailLines: [],
    managedRepairEvidence: {
      sourceType: 'MPT_INBOUND_GATEWAY',
      sourceBatch: 'MPT_INBOUND_20260708',
      contentHash: 'a'.repeat(64),
      rowErrorCount: 2
    }
  }]);
  assert.equal(failed.canRepair, true);
  assert.match(failed.repairToken, /^[a-f0-9-]{36}$/i);
  assert.equal(failed.sourceType, 'MPT_INBOUND_GATEWAY');
  assert.equal(failed.rowErrorCount, 2);
  assert.equal(Object.hasOwn(failed, 'repair'), false);
  assert.equal(Object.hasOwn(failed, 'managedRepairEvidence'), false);
  assert.equal(service.resolveMptImportFailures([failed.repairToken]).length, 1);
  service.beginManagedMptImport();
  assert.throws(() => service.resolveMptImportFailures([failed.repairToken]), {
    code: 'pre-fund-mpt-failure-token-expired'
  });
});

test('managed repair与legacy逐项保持token删除/保留和顶层结果shape', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-b-managed-repair-token-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const service = createPreFundReconciliationService({
    userDataDir,
    database: mirrorDatabase(userDataDir),
    templatePath: path.join(root, 'assets', '前置资金对账模板.xlsx')
  });
  const paths = [1, 2, 3].map((index) => `/tmp/MPT_INBOUND_GATEWAY_20260708_${index}.txt`);
  const seeded = service.adoptManagedMptImportResults(paths, paths.map((filePath, index) => ({
    status: 'failed',
    fileName: path.basename(filePath),
    code: 'MPT_ROW_ERRORS',
    message: `row failed ${index}`,
    detailLines: [`line ${index}`],
    managedRepairEvidence: {
      sourceType: 'MPT_INBOUND_GATEWAY',
      sourceBatch: `MPT_INBOUND_20260708_${index}`,
      contentHash: String(index + 1).repeat(64),
      rowErrorCount: index + 1
    }
  })));
  const failures = service.resolveMptImportFailures(seeded.map((item) => item.repairToken));
  const repaired = service.adoptManagedMptRepairResults(failures, [{
    status: 'ok', fileName: path.basename(paths[0]), sourceType: 'MPT_INBOUND_GATEWAY',
    importStatus: 'imported', rowCount: 1, excludedRowCount: 0
  }, {
    status: 'failed', fileName: path.basename(paths[1]), code: 'MPT_REPAIR_SOURCE_CHANGED',
    message: 'source changed', detailLines: []
  }, {
    status: 'failed', fileName: path.basename(paths[2]), code: 'SQLITE_BUSY',
    message: 'sql busy', detailLines: ['retry later']
  }]);
  assert.equal(Object.hasOwn(repaired[0], 'repairToken'), false);
  assert.equal(Object.hasOwn(repaired[1], 'repairToken'), false);
  assert.deepEqual(repaired[2], {
    status: 'failed', fileName: path.basename(paths[2]), code: 'SQLITE_BUSY',
    message: 'sql busy', detailLines: ['retry later'],
    canRepair: true,
    repairToken: seeded[2].repairToken,
    sourceType: 'MPT_INBOUND_GATEWAY',
    rowErrorCount: 3
  });
  assert.throws(() => service.resolveMptImportFailures([seeded[0].repairToken]), {
    code: 'pre-fund-mpt-failure-token-expired'
  });
  assert.throws(() => service.resolveMptImportFailures([seeded[1].repairToken]), {
    code: 'pre-fund-mpt-failure-token-expired'
  });
  assert.deepEqual(service.resolveMptImportFailures([seeded[2].repairToken]), [failures[2]]);
});
