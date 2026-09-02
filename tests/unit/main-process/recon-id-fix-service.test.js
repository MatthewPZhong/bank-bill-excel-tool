'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS,
  ORDER_REPAIR_SHEET_NAME,
  RECON_RESULT_FIELDS,
  RECON_RESULT_SHEET_NAME
} = require('../../../src/constants/recon-id-fix-fields');
const {
  CHANNEL_BILL_FIELDS,
  CHANNEL_BILL_SHEET_NAME,
  GATEWAY_BILL_FIELDS,
  GATEWAY_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS_GATEWAY,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../../src/constants/gateway-bill-recon-fields');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  reconFixEvidenceProjection,
  reconFixEvidenceSha256
} = require('../../../src/main-process/recon-id-fix-service/evidence-projection');
const {
  canonicalSha256
} = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const { readReconIdFixFile } = require('../../../src/main-process/recon-id-fix-io');
const { runReconIdFix } = require('../../../src/main-process/recon-id-fix-engine');
const {
  readBocFxLinkRows
} = require('../../../src/backend/database/linked-table-repository');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_READONLY_POLICIES,
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_SERVICE_KEY,
  validateReconFixServiceResult
} = require('../../../src/main-process/recon-id-fix-service/policies');
const {
  MAX_PHASE_EXTENSION_BYTES,
  createReconFixService,
  estimateImportPhaseBytes
} = require('../../../src/main-process/recon-id-fix-service/service');

const tmpDirs = [];
const TERMINAL_IN_FLIGHT_ITERATIONS =
  process.env.RECON_FIX_TERMINAL_RACE_ITERATIONS === '100' ? 100 : 10;
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tmpDirs.push(dir);
  return dir;
}

function aoaRow(fields, row) {
  return fields.map((field) => row[field] === undefined ? '' : row[field]);
}

function appendSheet(workbook, name, fields, rows = []) {
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([fields.slice(), ...rows.map((row) => aoaRow(fields, row))]),
    name
  );
}

function writeStandardWorkbook(filePath, repeat = 1, overrides = {}) {
  const workbook = XLSX.utils.book_new();
  const businessRows = [];
  const opponentRows = [];
  for (let index = 0; index < repeat; index += 1) {
    const orderId = Object.hasOwn(overrides, 'orderId')
      ? overrides.orderId
      : `ORDER-${index}`;
    const amount = Object.hasOwn(overrides, 'amount')
      ? overrides.amount
      : 100 + index;
    businessRows.push({
      OrderId: orderId, BillType: 'biz', BillDate: '2026-04-09', Amount: amount,
      Bank: '工行', Currency: 'CNY', reconId: ''
    });
    opponentRows.push({
      OrderId: orderId, BillType: 'biz', BillDate: '2026-04-09', Amount: amount,
      Bank: '工行', Currency: 'CNY', reconId: `RID-${index}`
    });
  }
  appendSheet(workbook, RECON_RESULT_SHEET_NAME, RECON_RESULT_FIELDS);
  appendSheet(workbook, BUSINESS_BILL_SHEET_NAME, BUSINESS_BILL_FIELDS, businessRows);
  appendSheet(workbook, OPPONENT_BILL_SHEET_NAME, OPPONENT_BILL_FIELDS, opponentRows);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME, ORDER_REPAIR_FIELDS);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function standardScenario(name = 'E11-A standard') {
  return {
    id: 11,
    category: 'recon-id-fix',
    name,
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
      ],
      reconGroups: [{
        leftTypeSeq: 1,
        rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'Amount', locked: true }]
      }],
      output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT-E11-A' } }
    }
  };
}

function writeGatewayWorkbook(filePath) {
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, RECON_RESULT_FIELDS_GATEWAY);
  appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS, [{
    BillDate: '2026-06-10', Bank: 'BOC', MerchantId: 'M1', OrderId: 'ALC-1',
    DataSource: 'DS', OppBu: 'OB', OriginBillSource: 'OBS', BillType: 'BT',
    Currency: 'USD', Amount: 999, OriginBillBizId: 'OBI', ReconBillBizId: 'RBI'
  }]);
  appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS, [{
    channelName: 'BOC', reconciliationId: 'RID-A', currency: 'USD',
    receiveAmount: 999, createTime: '2026-06-10'
  }]);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function createBocDatabase(dbPath, amount = 15000) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE linked_boc_fx_settlement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_no TEXT,
      group_no TEXT,
      allocation_no TEXT,
      recon_link_id TEXT,
      maturity_date TEXT,
      source_row INTEGER,
      orig_group_no TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    )
  `);
  const raw = {
    '交易编号': 'TXN-1', '货币1金额': amount, '货币2金额': '', '到期日': '2026-06-10',
    '分组': '1', '调拨单号': 'ALC-1', '资金对账不平表链接ID': 'RID-A'
  };
  db.prepare(`
    INSERT INTO linked_boc_fx_settlement
      (transaction_no, group_no, allocation_no, recon_link_id, maturity_date,
       source_row, orig_group_no, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('TXN-1', '1', 'ALC-1', 'RID-A', '2026-06-10', 1, '1', JSON.stringify(raw), new Date().toISOString());
  db.close();
  return dbPath;
}

function bocScenario() {
  return {
    id: 12,
    category: 'gateway-recon-id-fix',
    name: 'BOC调拨订单修复',
    priority: 0,
    enabled: false,
    config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' }
  };
}

function ordinaryGatewayScenario() {
  return {
    id: 13,
    category: 'gateway-recon-id-fix',
    name: 'E11-A ordinary gateway C4',
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'BT' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'channelName', op: '等于', value: 'BOC' }] }
      ],
      reconGroups: [{
        leftTypeSeq: 1,
        rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'receiveAmount', locked: true }]
      }],
      output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: '' } }
    }
  };
}

function legacyDigest(result) {
  const owned = structuredClone(result);
  return reconFixEvidenceSha256({
    fixedRows: owned.fixedRows,
    warnings: owned.warnings,
    unmatchedRows: owned.unmatchedRows || [],
    stats: owned.stats
  });
}

function adopt(service, candidate, reservationId) {
  const result = service.adopt(candidate, reservationId);
  service.finish();
  return result;
}

async function preparePlan(service, actionKey, input) {
  const preparation = await service.prepare(actionKey, input);
  return preparation.begin();
}

function readLegacyBocRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return readBocFxLinkRows(db);
  } finally {
    db.close();
  }
}

function operationContext(operationKey) {
  return {
    kind: 'operation',
    value: {
      taskRunId: `task-${operationKey}`,
      taskKey: 'task.recon-fix:e11-a',
      moduleId: 'recon-fix',
      parentRunId: 'parent-e11-a',
      operationKey
    }
  };
}

function runtimeRequest(actionKey, operationKey, input, production = false) {
  return { actionKey, operationKey, production, context: operationContext(operationKey), input };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等待超时：${label}`);
}

function createActiveShutdownHarness(targetAction, trigger) {
  const baseAdapter = createWorkerThreadAdapter();
  const commands = [];
  const diagnostics = [];
  const events = [];
  let armed = false;
  let runtime = null;
  let shutdownPromise = null;
  let observedActiveState = null;
  let interceptedJobId = null;
  let resolveShutdownStarted;
  const shutdownStarted = new Promise((resolve) => { resolveShutdownStarted = resolve; });
  const adapter = Object.freeze({
    kind: baseAdapter.kind,
    start(options) {
      const handle = baseAdapter.start({
        ...options,
        onMessage(message) {
          events.push(message);
          const terminalTrigger = trigger === 'job:done-before-supervisor' &&
            message.channel === 'job' && message.direction === 'event' &&
            message.operation === 'job:done' && message.actionKey === targetAction;
          if (armed && !interceptedJobId && terminalTrigger) {
            interceptedJobId = message.jobId;
            observedActiveState = runtime.inspect(interceptedJobId).state;
            shutdownPromise = runtime.shutdown({ timeoutMs: 10000 });
            resolveShutdownStarted();
          }
          options.onMessage(message);
        }
      });
      return Object.freeze({
        ready: handle.ready,
        worker: handle.worker,
        send(message, transferList) {
          commands.push(message);
          handle.send(message, transferList);
          const startTrigger = trigger === 'job:start' && message.channel === 'job' &&
            message.direction === 'command' && message.operation === 'job:start' &&
            message.actionKey === targetAction;
          const grantedRequest = message.operation === 'resource:grant' && events.find((event) =>
              event.channel === 'service-control' && event.operation === 'resource:request' &&
              event.payload.requestId === message.payload.requestId);
          const adoptionTrigger = message.channel === 'service-control' &&
            message.direction === 'command' && message.operation === 'resource:grant' &&
            message.jobRef && message.jobRef.actionKey === targetAction && grantedRequest &&
            ((trigger === 'resource:grant' &&
              grantedRequest.payload.requestKind === 'persistent-state-replace') ||
             (trigger === 'phase-grant' && grantedRequest.payload.requestKind === 'phase-extension'));
          if (armed && !interceptedJobId && (startTrigger || adoptionTrigger)) {
            interceptedJobId = startTrigger ? message.jobId : message.jobRef.jobId;
            queueMicrotask(() => {
              observedActiveState = runtime.inspect(interceptedJobId).state;
              shutdownPromise = runtime.shutdown({ timeoutMs: 10000 });
              resolveShutdownStarted();
            });
          }
        },
        close() { return handle.close(); },
        terminate() { return handle.terminate(); }
      });
    }
  });
  runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000,
    diagnostics(entry) { diagnostics.push(entry); },
    workerThreadAdapter: adapter
  });
  return Object.freeze({
    commands,
    diagnostics,
    events,
    runtime,
    armShutdown() { armed = true; },
    async shutdownResult() {
      await shutdownStarted;
      return Object.freeze({
        jobId: interceptedJobId,
        observedActiveState,
        promise: shutdownPromise
      });
    }
  });
}

function assertCleanCancelledShutdown(harness, control, result, report, activeState) {
  assert.equal(activeState, 'running');
  assert.equal(result.outcome, 'cancelled', JSON.stringify(result));
  assert.equal(result.terminalSource, 'job:error');
  assert.equal(result.error.code, 'RECON_FIX_CANCELLED');
  assert.deepEqual(report.cancelledJobs, [control.jobId]);
  assert.deepEqual(report.protectedJobs, []);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.closedServices, [RECON_FIX_SERVICE_KEY]);
  assert.equal(harness.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
  const operations = harness.events
    .filter((event) => event.channel === 'job' && event.direction === 'event' &&
      event.jobId === control.jobId)
    .map((event) => event.operation);
  assert.deepEqual(operations, ['cancel:ack', 'job:error']);
  const phaseRequest = harness.events.find((event) =>
    event.channel === 'service-control' && event.operation === 'resource:request' &&
    event.jobRef && event.jobRef.jobId === control.jobId &&
    event.payload.requestKind === 'phase-extension');
  assert.ok(phaseRequest, 'active shutdown 必须经过真实 phase-extension request');
  const phaseGrant = harness.commands.find((message) =>
    message.operation === 'resource:grant' &&
    message.payload.requestId === phaseRequest.payload.requestId);
  assert.ok(phaseGrant);
  assert.ok(harness.events.some((event) =>
    event.operation === 'resource:adopted' &&
    event.payload.requestId === phaseRequest.payload.requestId));
  assert.ok(harness.commands.some((message) =>
    message.operation === 'resource:adopt-ack' &&
    message.payload.requestId === phaseRequest.payload.requestId));
  assert.ok(harness.events.some((event) =>
    event.operation === 'resource:release' &&
    event.payload.reservationId === phaseGrant.payload.reservationId &&
    event.payload.reason === 'job-failed'));
  assert.ok(harness.commands.some((message) =>
    message.operation === 'resource:release-ack' &&
    message.payload.reservationId === phaseGrant.payload.reservationId));
  assert.equal(harness.diagnostics.some((entry) => entry.type === 'late-message'), false);
}

test('E11-A policy byte-for-byte 沿用 canonical fixture，且 production 保持 false', () => {
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(RECON_FIX_READONLY_POLICIES, [
    fixture[RECON_FIX_IMPORT_ACTION],
    fixture[RECON_FIX_RUN_READONLY_ACTION]
  ]);
  assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_IMPORT_ACTION), false);
  assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_RUN_READONLY_ACTION), false);
  assert.deepEqual(RECON_FIX_READONLY_POLICIES.map((policy) => policy.service.serviceKey), [
    RECON_FIX_SERVICE_KEY,
    RECON_FIX_SERVICE_KEY
  ]);
});

test('phase-extension 预检先于 XLSX.readFile，超出 policy 上限时 fail closed', async () => {
  const dir = tempDir('recon-fix-service-phase-preflight-');
  const filePath = writeStandardWorkbook(path.join(dir, 'phase-preflight.xlsx'));
  const originalReadFile = XLSX.readFile;
  let readFileCalls = 0;
  XLSX.readFile = function instrumentedReadFile(...args) {
    readFileCalls += 1;
    return originalReadFile.apply(this, args);
  };
  try {
    const service = createReconFixService({ serviceGeneration: 1 });
    const preparation = await service.prepare(RECON_FIX_IMPORT_ACTION, {
      expectedRevision: 0, filePath, subMode: 'business'
    });
    assert.equal(readFileCalls, 0, '中央目录资源证据不得提前触发 SheetJS 整表解析');
    assert.equal(preparation.resourcePlan.requestKind, 'phase-extension');
    assert.ok(preparation.resourcePlan.memoryBytes > 0);
    assert.ok(preparation.resourcePlan.memoryBytes <= MAX_PHASE_EXTENSION_BYTES);
    preparation.begin();
    assert.equal(readFileCalls, 1);
    service.finish();
  } finally {
    XLSX.readFile = originalReadFile;
  }
  assert.throws(
    () => estimateImportPhaseBytes(MAX_PHASE_EXTENSION_BYTES, 1, 'business'),
    (error) => error.code === 'RECON_FIX_PHASE_EXTENSION_LIMIT'
  );
});

test('standard Service golden 等价，revision/busy/stale/JPM 边界不越界', async () => {
  const dir = tempDir('recon-fix-service-standard-');
  const filePath = writeStandardWorkbook(path.join(dir, '6222021234567890123.xlsx'));
  const scenario = standardScenario();
  const legacySession = readReconIdFixFile(filePath, 'business');
  const legacy = runReconIdFix(scenario, legacySession.sheets);
  assert.equal(legacy.fixedRows.length, 1);

  const service = createReconFixService({ serviceGeneration: 7 });
  const importPreparation = await service.prepare(RECON_FIX_IMPORT_ACTION, {
    expectedRevision: 0, filePath, subMode: 'business'
  });
  await assert.rejects(
    service.prepare(RECON_FIX_IMPORT_ACTION, { expectedRevision: 0, filePath, subMode: 'business' }),
    (error) => error.code === 'RECON_FIX_SERVICE_BUSY'
  );
  let plan = importPreparation.begin();
  const imported = adopt(service, plan.candidate, 'reservation-standard-import');
  assert.equal(imported.serviceGeneration, 7);
  assert.equal(imported.revision, 1);
  assert.equal(imported.summary.hasResult, false);
  assert.equal(imported.summary.fileName, '[redacted by finance-safe-v1]');

  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: null, expectedRevision: 1, scenario
  });
  const result = adopt(service, plan.execute(), 'reservation-standard-result');
  assert.equal(result.revision, 2);
  assert.equal(result.summary.fixedRowCount, 1);
  assert.equal(result.summary.resultDigest, legacyDigest(legacy));
  assert.equal(validateReconFixServiceResult(result), true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192, '返回 Main 的 DTO 必须有界');

  await assert.rejects(
    service.prepare(RECON_FIX_RUN_READONLY_ACTION, {
      bocDatabasePath: null, expectedRevision: 1, scenario
    }),
    (error) => error.code === 'RECON_FIX_REVISION_STALE'
  );
  await assert.rejects(
    service.prepare(RECON_FIX_RUN_READONLY_ACTION, {
      bocDatabasePath: null,
      expectedRevision: 2,
      scenario: { ...scenario, config: { subCategory: 'jpm-dispatch-order-fix' } }
    }),
    (error) => error.code === 'RECON_FIX_JPM_REQUIRES_E11_P0'
  );
});

test('unsafe integer 仅投影到 evidence，数值型长单号/大金额与 legacy golden 等价', async () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(Number.isSafeInteger(unsafeInteger), false);
  const numericEvidenceHash = reconFixEvidenceSha256({ OrderId: unsafeInteger });
  assert.equal(numericEvidenceHash, reconFixEvidenceSha256({ OrderId: unsafeInteger }));
  assert.notEqual(numericEvidenceHash, reconFixEvidenceSha256({ OrderId: String(unsafeInteger) }));
  const mixedEvidence = {
    rows: [{ OrderId: unsafeInteger, Amount: 12.34, text: 'CNY' }],
    nested: { enabled: true, empty: null }
  };
  assert.equal(
    reconFixEvidenceSha256(mixedEvidence),
    canonicalSha256(reconFixEvidenceProjection(mixedEvidence))
  );

  const dir = tempDir('recon-fix-service-unsafe-integer-');
  const filePath = writeStandardWorkbook(path.join(dir, 'unsafe-integer.xlsx'), 1, {
    orderId: unsafeInteger,
    amount: unsafeInteger
  });
  const scenario = standardScenario('unsafe integer');
  const legacySession = readReconIdFixFile(filePath, 'business');
  assert.equal(typeof legacySession.sheets.businessBills[0].OrderId, 'number');
  assert.equal(legacySession.sheets.businessBills[0].OrderId, unsafeInteger);
  assert.equal(typeof legacySession.sheets.businessBills[0].Amount, 'number');
  assert.equal(legacySession.sheets.businessBills[0].Amount, unsafeInteger);
  const legacy = runReconIdFix(scenario, legacySession.sheets);
  assert.equal(legacy.fixedRows.length, 1);

  const service = createReconFixService({ serviceGeneration: 3 });
  let plan = await preparePlan(service, RECON_FIX_IMPORT_ACTION, {
    expectedRevision: 0, filePath, subMode: 'business'
  });
  const serviceInputRow = plan.candidate.state.session.sheets.businessBills[0];
  assert.equal(typeof serviceInputRow.OrderId, 'number');
  assert.equal(serviceInputRow.OrderId, unsafeInteger);
  assert.equal(typeof serviceInputRow.Amount, 'number');
  assert.equal(serviceInputRow.Amount, unsafeInteger);
  adopt(service, plan.candidate, 'reservation-unsafe-import');

  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: null, expectedRevision: 1, scenario
  });
  const resultCandidate = plan.execute();
  const serviceResultRow = resultCandidate.state.result.fixedRows[0];
  assert.equal(typeof serviceResultRow.OrderId, 'number');
  assert.equal(serviceResultRow.OrderId, unsafeInteger);
  assert.equal(typeof serviceResultRow.Amount, 'number');
  assert.equal(serviceResultRow.Amount, unsafeInteger);
  const result = adopt(service, resultCandidate, 'reservation-unsafe-result');
  assert.equal(result.summary.fixedRowCount, 1);
  assert.equal(result.summary.resultDigest, legacyDigest(legacy));
});

test('scenario 变化先失效旧 result，再原子 adopt 新 result', async () => {
  const dir = tempDir('recon-fix-service-invalidation-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  const service = createReconFixService({ serviceGeneration: 1 });
  let plan = await preparePlan(service, RECON_FIX_IMPORT_ACTION, {
    expectedRevision: 0, filePath, subMode: 'business'
  });
  adopt(service, plan.candidate, 'reservation-import');
  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: null, expectedRevision: 1, scenario: standardScenario('first')
  });
  const first = adopt(service, plan.execute(), 'reservation-first');

  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: null, expectedRevision: 2, scenario: standardScenario('changed')
  });
  assert.equal(plan.evidenceChanged, true);
  service.adopt(plan.invalidationCandidate, 'reservation-invalidated');
  assert.equal(service.boundedStatus().revision, 3);
  assert.equal(service.boundedStatus().hasResult, false);
  const second = adopt(service, plan.execute(), 'reservation-second');
  assert.equal(second.revision, 4);
  assert.notEqual(second.resultHandle, first.resultHandle);
});

test('BOC Service 只读 golden 等价，DB evidence 变化会锁定失效旧 result', async () => {
  const dir = tempDir('recon-fix-service-boc-');
  const filePath = writeGatewayWorkbook(path.join(dir, 'gateway.xlsx'));
  const unsafeAmount = Number.MAX_SAFE_INTEGER + 1;
  const dbPath = createBocDatabase(path.join(dir, 'tool-data.sqlite'), unsafeAmount);
  const scenario = bocScenario();
  const beforeDbHash = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const legacySession = readReconIdFixFile(filePath, 'gateway');
  const bocRows = readLegacyBocRows(dbPath);
  assert.equal(typeof bocRows[0]['货币1金额'], 'number');
  assert.equal(bocRows[0]['货币1金额'], unsafeAmount);
  const legacy = runReconIdFix(scenario, legacySession.sheets, { bocLinkRows: bocRows });
  assert.equal(legacy.fixedRows.length, 1);
  assert.equal(typeof legacy.fixedRows[0].Amount, 'number');
  assert.equal(legacy.fixedRows[0].Amount, unsafeAmount);

  const service = createReconFixService({ serviceGeneration: 2 });
  let plan = await preparePlan(service, RECON_FIX_IMPORT_ACTION, {
    expectedRevision: 0, filePath, subMode: 'gateway'
  });
  adopt(service, plan.candidate, 'reservation-boc-import');
  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: dbPath, expectedRevision: 1, scenario
  });
  const first = adopt(service, plan.execute(), 'reservation-boc-first');
  assert.equal(first.summary.runKind, 'boc');
  assert.equal(first.summary.resultDigest, legacyDigest(legacy));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'), beforeDbHash);

  const writable = new DatabaseSync(dbPath);
  const row = writable.prepare('SELECT id, raw_json FROM linked_boc_fx_settlement LIMIT 1').get();
  const changed = JSON.parse(row.raw_json);
  changed['货币1金额'] = unsafeAmount + 2;
  writable.prepare('UPDATE linked_boc_fx_settlement SET raw_json = ? WHERE id = ?')
    .run(JSON.stringify(changed), row.id);
  writable.close();

  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: dbPath, expectedRevision: 2, scenario
  });
  assert.equal(plan.evidenceChanged, true);
  service.adopt(plan.invalidationCandidate, 'reservation-boc-invalidated');
  assert.equal(service.boundedStatus().hasResult, false);
  const second = adopt(service, plan.execute(), 'reservation-boc-second');
  assert.notEqual(second.linkedEvidenceHash, first.linkedEvidenceHash);
  assert.notEqual(second.summary.resultDigest, first.summary.resultDigest);
});

test('ordinary gateway C4 managed/legacy golden 保持金额币种行数且 phase 回收', async () => {
  const dir = tempDir('recon-fix-service-gateway-c4-');
  const filePath = writeGatewayWorkbook(path.join(dir, 'gateway-c4.xlsx'));
  const scenario = ordinaryGatewayScenario();
  const legacySession = readReconIdFixFile(filePath, 'gateway');
  const legacy = runReconIdFix(scenario, legacySession.sheets);
  assert.equal(legacy.fixedRows.length, 1);
  assert.equal(legacy.unmatchedRows.length, 0);
  assert.equal(legacy.fixedRows[0].Amount, 999);
  assert.equal(legacy.fixedRows[0].Currency, 'USD');

  const service = createReconFixService({ serviceGeneration: 9 });
  let plan = await preparePlan(service, RECON_FIX_IMPORT_ACTION, {
    expectedRevision: 0, filePath, subMode: 'gateway'
  });
  adopt(service, plan.candidate, 'reservation-gateway-c4-import');
  plan = await preparePlan(service, RECON_FIX_RUN_READONLY_ACTION, {
    bocDatabasePath: null, expectedRevision: 1, scenario
  });
  const candidate = plan.execute();
  assert.equal(candidate.state.result.fixedRows.length, 1);
  assert.equal(candidate.state.result.fixedRows[0].Amount, legacy.fixedRows[0].Amount);
  assert.equal(candidate.state.result.fixedRows[0].Currency, legacy.fixedRows[0].Currency);
  const direct = adopt(service, candidate, 'reservation-gateway-c4-result');
  assert.equal(direct.summary.resultDigest, legacyDigest(legacy));
  assert.equal(direct.linkedEvidenceHash, null);

  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  try {
    const imported = await runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'gateway-c4-import', {
      expectedRevision: 0, filePath, subMode: 'gateway'
    }));
    assert.equal(imported.outcome, 'completed', JSON.stringify(imported));
    assert.equal(imported.result.serviceGeneration, 1);
    assert.equal(imported.result.revision, 1);
    assert.equal(runtime.resourceGovernor.snapshot().activeLeases.some((lease) => lease.kind === 'phase'), false);

    const managed = await runtime.execute(runtimeRequest(RECON_FIX_RUN_READONLY_ACTION, 'gateway-c4-run', {
      bocDatabasePath: null, expectedRevision: 1, scenario
    }));
    assert.equal(managed.outcome, 'completed', JSON.stringify(managed));
    assert.equal(managed.result.serviceGeneration, 1);
    assert.equal(managed.result.revision, 2);
    assert.equal(managed.result.summary.fixedRowCount, legacy.fixedRows.length);
    assert.equal(managed.result.summary.unmatchedRowCount, legacy.unmatchedRows.length);
    assert.equal(managed.result.summary.resultDigest, legacyDigest(legacy));
    assert.equal(managed.result.linkedEvidenceHash, null);
    const active = runtime.resourceGovernor.snapshot();
    assert.equal(active.activeLeaseCount, 2);
    assert.equal(active.activeLeases.some((lease) => lease.kind === 'phase'), false);
  } finally {
    const report = await runtime.shutdown({ timeoutMs: 10000 });
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    assert.equal(runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
  }
});

test('import parse 失败仍先获 phase 准入并在 error terminal 前回收', async () => {
  const dir = tempDir('recon-fix-service-import-error-');
  const filePath = path.join(dir, 'missing-sheets.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['unexpected']]), 'unexpected');
  XLSX.writeFile(workbook, filePath);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  try {
    const result = await runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'import-error', {
      expectedRevision: 0, filePath, subMode: 'business'
    }));
    assert.equal(result.outcome, 'failed', JSON.stringify(result));
    const active = runtime.resourceGovernor.snapshot();
    assert.equal(active.activeLeaseCount, 1, '失败后只保留 Service BaseLease');
    assert.equal(active.activeLeases.some((lease) => lease.kind === 'phase'), false);
    assert.equal(active.activeLeases.some((lease) => lease.kind === 'persistent'), false);
  } finally {
    const report = await runtime.shutdown({ timeoutMs: 10000 });
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    assert.equal(runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
  }
});

test('real ServiceHost 复用单 owner，close/crash 升 generation 并回收 lease', async () => {
  const dir = tempDir('recon-fix-service-runtime-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  const gatewayPath = writeGatewayWorkbook(path.join(dir, 'gateway.xlsx'));
  const bocDatabasePath = createBocDatabase(path.join(dir, 'tool-data.sqlite'));
  const baseAdapter = createWorkerThreadAdapter();
  const handles = [];
  const adapter = Object.freeze({
    kind: baseAdapter.kind,
    start(options) {
      const handle = baseAdapter.start(options);
      handles.push(handle);
      return handle;
    }
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000,
    workerThreadAdapter: adapter
  });
  try {
    await assert.rejects(
      runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'recon-production-gate', {
        expectedRevision: 0, filePath, subMode: 'business'
      }, true)),
      (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
    );
    const imported = await runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'recon-import-1', {
      expectedRevision: 0, filePath, subMode: 'business'
    }));
    assert.equal(imported.outcome, 'completed');
    assert.equal(imported.result.serviceGeneration, 1);
    const run = await runtime.execute(runtimeRequest(RECON_FIX_RUN_READONLY_ACTION, 'recon-run-1', {
      bocDatabasePath: null, expectedRevision: 1, scenario: standardScenario()
    }));
    assert.equal(run.result.serviceGeneration, 1);
    assert.equal(run.result.revision, 2);
    assert.equal(handles.length, 1, '两个 action 必须共用同一 Service owner');
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 2, 'BaseLease + 唯一当前 PersistentReservation');

    assert.equal(await runtime.closeService(RECON_FIX_SERVICE_KEY), true);
    await waitFor(() => runtime.resourceGovernor.snapshot().activeLeaseCount === 0, 'close lease 回收');
    const reopened = await runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'recon-import-2', {
      expectedRevision: 0, filePath, subMode: 'business'
    }));
    assert.equal(reopened.result.serviceGeneration, 2);
    assert.equal(handles.length, 2);

    await handles.at(-1).worker.terminate();
    await waitFor(() => runtime.resourceGovernor.snapshot().activeLeaseCount === 0, 'crash lease 回收');
    const afterCrash = await runtime.execute(runtimeRequest(RECON_FIX_IMPORT_ACTION, 'recon-import-3', {
      expectedRevision: 0, filePath: gatewayPath, subMode: 'gateway'
    }));
    assert.equal(afterCrash.outcome, 'completed', JSON.stringify(afterCrash));
    assert.equal(afterCrash.result.serviceGeneration, 3);
    assert.equal(handles.length, 3);
    const bocRun = await runtime.execute(runtimeRequest(RECON_FIX_RUN_READONLY_ACTION, 'recon-boc-run-3', {
      bocDatabasePath,
      expectedRevision: 1,
      scenario: bocScenario()
    }));
    assert.equal(bocRun.outcome, 'completed', JSON.stringify(bocRun));
    assert.equal(bocRun.result.serviceGeneration, 3);
    assert.equal(bocRun.result.summary.runKind, 'boc');
    assert.equal(bocRun.result.summary.fixedRowCount, 1);
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 2);
  } finally {
    const report = await runtime.shutdown({ timeoutMs: 10000 });
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    assert.equal(runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
  }
});

test('active import shutdown 在 parse 后安全点取消，且无 late/double terminal 或资源泄漏', async () => {
  const dir = tempDir('recon-fix-service-cancel-import-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  const harness = createActiveShutdownHarness(RECON_FIX_IMPORT_ACTION, 'resource:grant');
  harness.armShutdown();
  const control = harness.runtime.start(runtimeRequest(
    RECON_FIX_IMPORT_ACTION,
    'recon-cancel-import',
    { expectedRevision: 0, filePath, subMode: 'business' }
  ));
  const shutdown = await harness.shutdownResult();
  assert.equal(shutdown.jobId, control.jobId);
  const [result, report] = await Promise.all([control.promise, shutdown.promise]);
  assertCleanCancelledShutdown(harness, control, result, report, shutdown.observedActiveState);
});

test('phase grant/adoption-in-flight shutdown 收口后再取消且不泄漏', async () => {
  const dir = tempDir('recon-fix-service-cancel-phase-admission-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  const harness = createActiveShutdownHarness(RECON_FIX_IMPORT_ACTION, 'phase-grant');
  harness.armShutdown();
  const control = harness.runtime.start(runtimeRequest(
    RECON_FIX_IMPORT_ACTION,
    'recon-cancel-phase-admission',
    { expectedRevision: 0, filePath, subMode: 'business' }
  ));
  const shutdown = await harness.shutdownResult();
  const [result, report] = await Promise.all([control.promise, shutdown.promise]);
  assertCleanCancelledShutdown(harness, control, result, report, shutdown.observedActiveState);
});

test('active run shutdown 等 invalidation adoption 收口后在 result 前取消', async () => {
  const dir = tempDir('recon-fix-service-cancel-run-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  const harness = createActiveShutdownHarness(RECON_FIX_RUN_READONLY_ACTION, 'resource:grant');
  const imported = await harness.runtime.execute(runtimeRequest(
    RECON_FIX_IMPORT_ACTION,
    'recon-before-cancel-run',
    { expectedRevision: 0, filePath, subMode: 'business' }
  ));
  assert.equal(imported.outcome, 'completed');
  const initialResult = await harness.runtime.execute(runtimeRequest(
    RECON_FIX_RUN_READONLY_ACTION,
    'recon-before-invalidation',
    { bocDatabasePath: null, expectedRevision: 1, scenario: standardScenario('first') }
  ));
  assert.equal(initialResult.outcome, 'completed');
  assert.equal(initialResult.result.revision, 2);
  assert.equal(harness.runtime.resourceGovernor.snapshot().activeLeaseCount, 2);

  harness.armShutdown();
  const control = harness.runtime.start(runtimeRequest(
    RECON_FIX_RUN_READONLY_ACTION,
    'recon-cancel-run',
    { bocDatabasePath: null, expectedRevision: 2, scenario: standardScenario('changed') }
  ));
  const shutdown = await harness.shutdownResult();
  assert.equal(shutdown.jobId, control.jobId);
  const [result, report] = await Promise.all([control.promise, shutdown.promise]);
  assertCleanCancelledShutdown(harness, control, result, report, shutdown.observedActiveState);
});

test('adopt-ack 后 terminal-in-flight shutdown race 幂等收口且不泄漏', async () => {
  const dir = tempDir('recon-fix-service-terminal-race-');
  const filePath = writeStandardWorkbook(path.join(dir, 'standard.xlsx'));
  for (let index = 0; index < TERMINAL_IN_FLIGHT_ITERATIONS; index += 1) {
    const harness = createActiveShutdownHarness(
      RECON_FIX_IMPORT_ACTION,
      'job:done-before-supervisor'
    );
    harness.armShutdown();
    const control = harness.runtime.start(runtimeRequest(
      RECON_FIX_IMPORT_ACTION,
      `recon-terminal-race-${index}`,
      { expectedRevision: 0, filePath, subMode: 'business' }
    ));
    const shutdown = await harness.shutdownResult();
    assert.equal(shutdown.jobId, control.jobId);
    assert.equal(shutdown.observedActiveState, 'running');
    const [result, report] = await Promise.all([control.promise, shutdown.promise]);
    assert.equal(['completed', 'cancelled'].includes(result.outcome), true, JSON.stringify(result));
    assert.deepEqual(report.protectedJobs, []);
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.closedServices, [RECON_FIX_SERVICE_KEY]);
    assert.equal(harness.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
    const commandOperations = harness.commands
      .filter((message) => message.channel === 'job' && message.jobId === control.jobId)
      .map((message) => message.operation);
    assert.equal(commandOperations[0], 'job:start');
    assert.equal(commandOperations.length <= 2, true, JSON.stringify(commandOperations));
    if (commandOperations.length === 2) assert.equal(commandOperations[1], 'job:cancel');
    const eventOperations = harness.events
      .filter((message) => message.channel === 'job' && message.jobId === control.jobId)
      .map((message) => message.operation);
    if (result.outcome === 'completed') {
      assert.equal(result.terminalSource, 'job:done');
      assert.deepEqual(report.cancelledJobs, []);
      assert.deepEqual(eventOperations, ['job:done']);
    } else {
      assert.deepEqual(commandOperations, ['job:start', 'job:cancel']);
      assert.equal(result.terminalSource, 'job:error');
      assert.equal(result.error.code, 'RECON_FIX_CANCELLED');
      assert.deepEqual(report.cancelledJobs, [control.jobId]);
      assert.deepEqual(eventOperations, ['cancel:ack', 'job:error']);
    }
    assert.equal(harness.diagnostics.some((entry) =>
      entry.type === 'service-fatal' || entry.type === 'service-fatal-cleanup-error'), false);
    assert.equal(harness.diagnostics.some((entry) => entry.type === 'late-message'), false);
  }
});

test('E11-A source 不引入 JPM writer/receipt/export 实现', () => {
  const sourcePaths = [
    '../../../src/main-process/recon-id-fix-service/evidence-projection.js',
    '../../../src/main-process/recon-id-fix-service/service.js',
    '../../../src/main-process/recon-id-fix-service/worker-entry.js',
    '../../../src/main-process/recon-id-fix-service/policies.js'
  ].map((relative) => path.resolve(__dirname, relative));
  const source = sourcePaths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /require\([^)]*jpm-dispatch-order-fix/);
  assert.doesNotMatch(source, /readAdmBankDepositRows|writeAdmMatchFlags|writeReconIdFixOutput/);
  assert.doesNotMatch(source, /recon-fix:export|operation-receipt/);
});
