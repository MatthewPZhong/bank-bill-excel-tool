'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const XLSX = require('xlsx');
const { createPositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { SOURCE_DEFINITIONS, SOURCE_TYPES } = require('../../src/main-process/position-reconciliation/constants');
const { dispatchPositionLargeImportSchemaMigration } = require('../../src/main-process/position-reconciliation/import-dispatch');
const { createPositionSourceImportTaskContract } = require('../../src/main-process/position-reconciliation/interactive-task-preflight');
const { positionInputFilePlanEvidence, positionFilePlanSettlementFiles } = require('../../src/main-process/position-reconciliation/archive-file-plan-evidence');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createPositionOwnedDeleteSourceResolver, positionDeleteSourceReferences } = require('../../src/main-process/archive-center/position-owned-delete-sources');

const { createPositionReportDeleteProtection } = require('../../src/main-process/position-reconciliation/archive-report-delete-protection');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]), sheetName);
  XLSX.writeFile(workbook, filePath);
}

async function cleanupThroughMain(controller, position, userDataDir, sourcePaths) {
  const main = fs.readFileSync(path.join(PROJECT_ROOT, 'src/main.js'), 'utf8');
  const start = main.indexOf('function positionArchiveStagingRoot()');
  const end = main.indexOf('async function cleanupPositionArchiveStaging(runtime)', start);
  assert.ok(start >= 0 && end > start);
  const scope = { fs, path, database: { dbPath: path.join(userDataDir, 'tool-data.sqlite') },
    archiveCenterService: controller, positionReconciliationService: position,
    readPositionPendingOperation: () => null,
    positionPersistentStagingProtectionPaths: require('../../src/main-process/position-reconciliation/operation-lifecycle').positionPersistentStagingProtectionPaths,
    filterStagingPathsWithoutProtectedSources: require('../../src/main-process/position-reconciliation/input-staging').filterStagingPathsWithoutProtectedSources };
  vm.createContext(scope);
  vm.runInContext(main.slice(start, end), scope);
  await scope.cleanupPositionArchiveSourcePaths(sourcePaths);
}

async function verifyPositionFilePlanDeletion(parentDirectory, options = {}) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'position-fileplan-delete-'));
  const userDataDir = path.join(directory, 'user-data');
  const rootDir = path.join(directory, 'archive');
  fs.mkdirSync(userDataDir);
  const outboundPath = path.join(directory, 'outbound.xlsx');
  const accountPath = path.join(directory, 'account.xlsx');
  writeWorkbook(outboundPath, '账单明细', SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND].headers, [{
    账单日期: '2026-07-20', 渠道名称: 'DBS', 账户号: 'M001', 交易类型: 'Outbound',
    主对账id: 'SYNTHETIC-RID', 业务单号: 'SYNTHETIC-ORDER', 币种: 'USD', 金额: '100',
    原始币种: 'EUR', 原始金额: '95', 银行扣款币种: 'USD'
  }]);
  writeWorkbook(accountPath, '清结算银行账户表', SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers, [{
    账户状态: '正常', 账户性质: '自有', 币种: 'USD', 银行账号: 'SYNTHETIC-ACCOUNT'
  }]);
  if (options.anomalyReport) {
    const transfer = { 调拨单号: 'SYNTHETIC-VALID', 调拨状态: '付款成功', 渠道流水号: 'RID-VALID',
      交易时间: new Date(2026, 6, 20), '付款账户（卡号）': 'PAY-1', '收款账户（卡号）': 'REC-1',
      付款金额: 100, 付款币种: 'USD', 收款金额: 95, 收款币种: 'EUR' };
    writeWorkbook(outboundPath, SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].sheetName || '调拨',
      SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers,
      [transfer, { ...transfer, 调拨单号: 'SYNTHETIC-FILTERED', 调拨状态: '付款失败',
        渠道流水号: 'RID-FILTERED', 付款金额: '' }]);
  }
  const originals = [outboundPath, accountPath].map((filePath) => [filePath, fs.readFileSync(filePath)]);
  let position;
  let database;
  let service;
  let controller;
  let outbox;
  let context;
  let sequence = 0;
  let reservedEvidenceCount = 0;
  const batchIds = [];

  async function openArchive() {
    database = new DatabaseSync(path.join(directory, 'archive.sqlite'));
    database.exec('PRAGMA foreign_keys = ON');
    service = createArchiveService({ database, rootDir });
    outbox = createArchiveOutboxStore(path.join(directory, 'outbox'));
    service.resolveOwnedDeleteSources = createPositionOwnedDeleteSourceResolver({
      userDataPath: userDataDir,
      reportReferenceProvider: createPositionReportDeleteProtection({
        userDataPath: userDataDir, getExpectedCheckpoint: () => position.persistenceCheckpoint()
      }),
      protectedPathProvider: async ({ batch, artifacts }) => {
        const references = positionDeleteSourceReferences(service.repository, batch.id, artifacts);
        return {
          sharedPaths: references.sharedPaths,
          protectedPaths: references.protectedPaths.concat(outbox.listSourcePaths(), position.activeImportStagingPaths())
        };
      }
    });
    controller = createArchiveCenterController({
      database: { getSetting: () => null, setSetting() {} }, service, outboxStore: outbox
    });
    assert.equal((await controller.initialize()).ok, true);
  }

  async function runFileTask(channel, filePlan, execute, archiveEvidence) {
    const policy = createTaskPolicyRegistry().require(channel);
    const lifecycle = createTaskLifecycle({
      archiveService: service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: `position-${++sequence}` }), end() {} },
      flowResolver: {
        resolve: async () => ({ parentRunId: 'position-fixture-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true })
      },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
    });
    const taskRunId = `position-fixture-task-${++sequence}`;
    return lifecycle.runFileTask({
      policy, meta: { channel }, taskRunId, operationKey: `position:${taskRunId}:${channel}`, filePlanResolver: () => filePlan,
      beforeStart: async (batchContext) => {
        context = batchContext;
        batchIds.push(batchContext.batchId);
        for (const input of filePlan.inputs.filter((item) => item.expectedSha256)) {
          const artifact = service.repository.getArtifactByKey(batchContext.batchId, input.artifactKey);
          assert.equal(artifact.status, 'pending');
          assert.deepEqual(artifact.metadata.sourceSnapshot, input.sourceSnapshot);
          assert.equal(artifact.metadata.expectedSha256, input.expectedSha256);
          assert.equal(artifact.metadata.expectedSizeBytes, input.expectedSizeBytes);
          reservedEvidenceCount += 1;
        }
        return {};
      },
      execute: async (batchContext, controls) => {
        context = batchContext;
        const result = await execute(batchContext);
        const settled = await controls.settleArtifacts({ files: positionFilePlanSettlementFiles(filePlan, archiveEvidence) });
        assert.equal(settled.durable, true, JSON.stringify(settled));
        return result;
      }
    });
  }

  try {
    position = createPositionReconciliationService({
      userDataDir, templatePath: path.join(PROJECT_ROOT, 'assets', '平盘银行对账单.xlsx'),
      ...(options.engine ? { positionImportEngine: options.engine } : {}),
      operationTokenProvider: () => context.taskRunId,
      authorizeStreamingSourceApply: async (ready) => {
        const baseCheckpoint = position.persistenceCheckpoint();
        const schema = await dispatchPositionLargeImportSchemaMigration({
          engine: 'streaming', userDataDir, sideDbPath: position.store.dbPath,
          expectedCheckpoint: baseCheckpoint, batchContext: context
        }).promise;
        return { operationToken: context.taskRunId, archiveManifestHash: ready.archiveManifestHash,
          schemaFingerprint: schema.fingerprint, baseCheckpoint };
      }
    });
    await openArchive();
    const contract = createPositionSourceImportTaskContract({
      pickFiles: async () => ({ canceled: false, filePaths: [outboundPath, accountPath] }),
      getService: () => position, withSourceLock: (operation) => operation()
    });
    const prepared = await contract.prepare();
    assert.equal(prepared.preparedImport.requiresExecution, true);
    const preparePlan = normalizeFilePlanV1(prepared.filePlan);
    const preparedResult = await runFileTask('position-reconciliation:source:prepare-import', preparePlan,
      (batchContext) => position.executePreparedSourceImport(prepared.preparedImport.plan, batchContext, {
        executionInputPaths: prepared.executionInputIndexes.map((index) => preparePlan.inputs[index].filePath),
        outputs: preparePlan.outputs
      }), prepared.positionArchiveEvidence);
    assert.equal(preparedResult.status, 'ok', JSON.stringify(preparedResult));
    assert.equal(preparedResult.successCount, 1);
    assert.equal(preparedResult.confirmationCount, 1);
    const token = preparedResult.results.find((item) => item.status === 'needs-confirmation').token;
    const intent = position.sourceImportArchiveIntent(token);
    const sourcePath = intent[0].filePath;
    const sharedInPrepare = preparePlan.inputs.some((item) => item.filePath === sourcePath);
    if (sharedInPrepare) {
      const blocked = await controller.prepareDeleteBatch(batchIds[0]);
      assert.equal(blocked.code, 'ARCHIVE_DELETE_SOURCE_HELD', '真实账户确认 token 仍持有暂存输入');
    }
    const applyPlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: intent.map((file) => ({ filePath: file.filePath, originalName: file.originalName,
        ...positionInputFilePlanEvidence(file), role: 'input',
        sourceOperation: 'position-reconciliation:source:apply-import' })), outputs: [] });
    const applied = await runFileTask('position-reconciliation:source:apply-import', applyPlan,
      (batchContext) => position.applySourceImport(token, batchContext, applyPlan.inputs.map((item) => item.filePath)));
    assert.equal(applied.status, 'ok', JSON.stringify(applied));
    assert.equal(applied.rowCount, 1);
    assert.ok(reservedEvidenceCount >= 2);
    assert.equal(position.activeImportStagingPaths().length, 0);

    const reports = preparePlan.outputs;
    if (options.anomalyReport) {
      assert.ok(reports.length > 0, '真实过滤行必须生成报告并进入 FilePlan outputs');
      assert.equal(position.store.countSourceRows(SOURCE_TYPES.FUND_TRANSFER), 1);
      const held = await controller.prepareDeleteBatch(batchIds[0]);
      assert.equal(held.code, 'ARCHIVE_DELETE_SOURCE_HELD', JSON.stringify(held));
      assert.equal(position.store.countSourceRows(SOURCE_TYPES.FUND_TRANSFER), 1);
      context = {
        taskRunId: 'position-fixture-delete-source', taskKey: 'position-reconciliation:source:delete',
        moduleId: 'position-reconciliation-process', parentRunId: 'position-fixture-parent',
        operationKey: 'position:position-fixture-delete-source:position-reconciliation:source:delete'
      };
      const deletion = await position.deleteSource({ sourceType: SOURCE_TYPES.FUND_TRANSFER, months: ['2026-07'] }, context);
      assert.equal(deletion.deletedCount, 1);
      assert.equal(deletion.resolvedFilteredCount, 1);
      if (options.sourceMissing) {
        await cleanupThroughMain(controller, position, userDataDir, preparePlan.inputs.map((file) => file.filePath));
        for (const report of reports) assert.equal(fs.existsSync(report.filePath), false);
      }
    }
    if (options.sourceMissing) {
      await position.cleanupUnprotectedStagingPathsAsync(applied.cleanupPaths || []);
      assert.equal(fs.existsSync(sourcePath), false);
    }
    if (options.replaceSource) {
      const replacement = path.join(directory, 'source-replacement.xlsx');
      fs.copyFileSync(sourcePath, replacement);
      fs.renameSync(replacement, sourcePath);
    }
    if (options.restart) {
      await service.pauseBackgroundMaterialization();
      database.close();
      database = null;
      await openArchive();
    }
    const order = options.reverse ? [...batchIds].reverse() : batchIds;
    if (options.replaceSource) {
      const ownerBatch = sharedInPrepare ? order[0] : batchIds[1];
      const blocked = await controller.prepareDeleteBatch(ownerBatch);
      assert.equal(blocked.code, 'ARCHIVE_DELETE_SOURCE_CHANGED', JSON.stringify(blocked));
      assert.equal(fs.existsSync(sourcePath), true);
      assert.equal(service.repository.listCleanupJobs().length, 0);
      assert.equal(service.repository.getDeletionReceipt(ownerBatch), null);
      return { batchCount: batchIds.length, reservedEvidenceCount, blockedCode: blocked.code };
    }
    const receipts = [];
    for (let index = 0; index < order.length; index += 1) {
      const batchId = order[index];
      const preparation = await controller.prepareDeleteBatch(batchId);
      assert.equal(preparation.ok, true, JSON.stringify(preparation));
      const deleted = await controller.deleteBatch(batchId, preparation.confirmationToken);
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
      receipts.push(deleted.deletionId);
      assert.equal(service.repository.getBatch(batchId), null);
      const repeated = await service.deleteBatch(batchId);
      assert.equal(repeated.fullyDeleted, true);
      assert.equal(repeated.deletionId, deleted.deletionId);
      if (index === 0) {
        if (sharedInPrepare) assert.equal(fs.existsSync(sourcePath), !options.sourceMissing);
        const remaining = service.repository.listArtifacts(order[1]);
        for (const artifact of remaining) {
          const readable = await service.resolveVerifiedArtifact(artifact.id);
          assert.equal(readable.ok, true, JSON.stringify(readable));
        }
      }
    }
    assert.equal(fs.existsSync(sourcePath), false);
    for (const report of reports) assert.equal(fs.existsSync(report.filePath), false);
    assert.equal(service.repository.listCleanupJobs().length, 0);
    assert.equal(position.store.countSourceRows(SOURCE_TYPES.BANK_ACCOUNT), 1, '删除存档不改变有效业务数据');
    for (const [filePath, content] of originals) assert.deepEqual(fs.readFileSync(filePath), content);
    return { batchCount: batchIds.length, reservedEvidenceCount, sharedInPrepare, reportCount: reports.length, deletionIds: receipts };
  } finally {
    if (service) await service.pauseBackgroundMaterialization();
    if (position) position.close();
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyPositionFilePlanDeletion };
