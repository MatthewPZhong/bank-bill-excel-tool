'use strict';
const { readIdentityStatSync } = require('../../src/main-process/archive-center/filesystem-identity');

// 由存档永久删除集成测试启动；所有输出仅写入父进程传入的隔离临时目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const {
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
} = require('../../src/main-process/toolbox-output-publication');
const { acknowledgeToolboxPublicationReceipts: acknowledgeToolboxPublicationReceiptsIntoArchive }
  = require('../../src/main-process/toolbox-archive-recovery');

async function run() {
  const directory = process.argv[2];
  const mode = process.argv[3];
  assert.ok(directory && path.isAbsolute(directory));
  assert.ok(['crash-before-completion', 'vcc-nondurable'].includes(mode));
  const userDataDir = path.join(directory, 'userdata');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(path.join(directory, 'generation'));
  fs.mkdirSync(path.join(directory, 'output'));
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
  await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const controller = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service,
    outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox'))
  });
  // 运行 Main 实际 wrapper，避免只验证 helper 而遗漏正常入口接线。
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
  const acknowledgeSource = mainSource.match(/async function acknowledgeToolboxPublicationReceipts\(taskIds\) \{[\s\S]*?\n\}/);
  assert.ok(acknowledgeSource, 'Main 应保留正常发布 receipt 收口入口');
  const acknowledge = vm.runInNewContext(`(${acknowledgeSource[0]})`, {
    app: { getPath: () => userDataDir }, archiveCenterService: controller,
    recoverToolboxPublicationsAsync: recoverPendingToolboxPublications,
    acknowledgeToolboxPublicationReceiptsIntoArchive
  });
  const generationPath = path.join(directory, 'generation', 'generated.xlsx');
  const outputPath = path.join(directory, 'output', 'result.xlsx');
  const inputPath = path.join(directory, 'input.xlsx');
  const content = `publication-${mode}`;
  fs.writeFileSync(generationPath, content);
  fs.writeFileSync(inputPath, 'external-original-input');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const channel = mode === 'vcc-nondurable' ? 'vccFinancialOp:data-manager:export' : 'toolbox:merge';
  const policy = createTaskPolicyRegistry().require(channel);
  const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: mode === 'vcc-nondurable' ? [] : [{ filePath: inputPath, role: 'input', sourceOperation: channel }],
    outputs: [{ filePath: outputPath, role: 'output', sourceOperation: channel }] });
  const lifecycle = createTaskLifecycle({ archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: mode }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: `${mode}-parent`, source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
  if (mode === 'crash-before-completion') {
    // 模拟真正进程退出，不能被 lifecycle 的 catch 补写终态意图覆盖。
    service.recordFileTaskOwnerCompletion = async () => process.exit(77);
  } else {
    // 正式目标已提交，当前进程对归档根暂时无写权限；下一进程恢复实际存储。
    service.settleManifestArtifacts = async () => ({ ok: false, durable: false, code: 'EACCES' });
  }
  let afterTerminalCalls = 0;
  try {
    const result = await lifecycle.runFileTask({ policy,
      taskRunId: `${mode}-task`, operationKey: `${mode}-operation`, filePlanResolver: () => plan,
      execute: async (batchContext) => {
        fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ version: 1, kind: 'file-batch', batchContext }));
        const prepared = prepareToolboxPublication({ taskId: `${mode}-publication`, userDataDir, batchContext,
          requireArchiveHandoff: true, requireValidatedArtifacts: true,
          allowEmptyArchiveInputs: mode === 'vcc-nondurable', archiveInputFiles: plan.inputs,
          protectedSourcePaths: plan.inputs.map((file) => file.filePath),
          artifacts: [{ sourcePath: generationPath, byteSize: Buffer.byteLength(content), sha256 }],
          targets: [outputPath] });
        publishPreparedToolboxPublication(prepared);
        const stat = readIdentityStatSync(fs, outputPath, 'statSync');
        fs.writeFileSync(path.join(directory, 'publication-evidence.json'), JSON.stringify({
          taskId: `${mode}-publication`, outputPath, inputPath, sha256,
          size: stat.size, ino: String(stat.ino), mtimeMs: stat.mtimeMs
        }));
        return { status: 'success' };
      },
      afterTerminal: async () => {
        afterTerminalCalls += 1;
        await acknowledge([`${mode}-publication`]);
      }
    });
    assert.equal(result.status, 'success');
    assert.equal(mode, 'vcc-nondurable', '退出故障点必须实际触发');
    assert.equal(afterTerminalCalls, 0);
    const pending = controller.outboxStore.list();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, true);
  } finally {
    db.close();
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
