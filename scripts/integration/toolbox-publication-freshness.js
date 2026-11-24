'use strict';
// v3.2.22 B57 / B58：工具箱合表、按字段拆分的确认前冻结、父目录身份与发布前输入核对（数据保留语义）。
//   执行 Main 原始 prepare / execute、发布 wrapper 与真实发布器，CSV 源 → 正式 xlsx 回读：
//   覆盖确认期间新建的目标不被覆盖；目标目录被同路径替换、源文件在生成后被替换时都不形成正式输出；未变化时照常发布。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CASES, MULTI_PAYLOAD, caseOverrides, casePayload, firstColumn, loadHandlers, setup, generators
} = require('../../tests/helpers/toolbox-main-handlers');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
const { prepareIpcTaskInvocation, createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');

const cleanups = [];
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('多文件拆分：覆盖确认期间新建的目标不被覆盖，已有目标保持原内容，不发布', async () => {
  const env = setup((fn) => cleanups.push(fn));
  const existing = path.join(env.output, 'A.xlsx');
  const created = path.join(env.output, 'B.xlsx');
  fs.writeFileSync(existing, 'old-A');
  const { calls, run } = loadHandlers(env, {
    showMessageBox: () => { fs.writeFileSync(created, 'foreign-B'); return { response: 1 }; }
  });
  const { result } = await run('toolbox:split:export', { ...MULTI_PAYLOAD, sourceFilePath: env.source });
  assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED');
  assert.equal(calls.publication, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'old-A');
  assert.equal(fs.readFileSync(created, 'utf8'), 'foreign-B');
});

check('多文件拆分：确认覆盖后照常发布，两个目标按分组回读', async () => {
  const env = setup((fn) => cleanups.push(fn));
  fs.writeFileSync(path.join(env.output, 'A.xlsx'), 'old-A');
  const { calls, run } = loadHandlers(env);
  const { result } = await run('toolbox:split:export', { ...MULTI_PAYLOAD, sourceFilePath: env.source });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(calls.dialogs.length, 1);
  assert.deepEqual(await firstColumn(path.join(env.output, 'A.xlsx')), ['Name', 'A']);
  assert.deepEqual(await firstColumn(path.join(env.output, 'B.xlsx')), ['Name', 'B']);
});

for (const kind of Object.keys(CASES)) {
  check(`${kind}：发布前目标目录被同路径替换时拒绝，新目录内容保留、未结算`, async () => {
    const env = setup((fn) => cleanups.push(fn));
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      beforePublish: async () => {
        fs.renameSync(env.output, path.join(env.root, 'out-moved'));
        fs.mkdirSync(env.output);
        fs.writeFileSync(path.join(env.output, 'new-owner.txt'), 'keep');
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    // 前提：冻结时拿到可靠的目录身份；拿不到时按 spec D3 只核对路径（单测用受控夹具验证），不在此断言拒绝
    if (!prepared.filePlan.outputs.every((output) => output.targetParentIdentity.identityReliable)) {
      console.log(`  SKIP 前提不满足：临时卷给不出可靠的目录身份（${kind}）`);
      return;
    }
    assert.equal(result.code, 'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED', JSON.stringify(result));
    assert.equal(calls.settle, 0);
    assert.deepEqual(fs.readdirSync(env.output), ['new-owner.txt']);
  });

  check(`${kind}：生成后源文件被替换时不形成正式输出`, async () => {
    const env = setup((fn) => cleanups.push(fn));
    const wrap = (generate) => async (...args) => {
      const generated = await generate(...args);
      fs.writeFileSync(`${env.source}.tmp`, 'Name,Amount\nA,999\nB,2\n');
      fs.renameSync(`${env.source}.tmp`, env.source);
      return generated;
    };
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      toolboxMergeFilesToXlsx: wrap(generators.mergeToolboxFilesToXlsx),
      exportToolboxFilter: wrap(generators.exportToolboxFilter),
      exportToolboxMultiFilters: wrap(generators.exportToolboxMultiFilters)
    }));
    const { result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(result.status, 'failed');
    assert.equal(calls.publication, 0);
    assert.deepEqual(fs.readdirSync(env.output).filter((name) => !name.startsWith('.')), []);
  });
}

// 真实 TaskLifecycle 与临时归档库：生成后源文件被替换时任务终态为失败，替换后的输入不归入本批，没有发布 receipt
const LIFECYCLE_CODES = { merge: 'ARCHIVE_INPUT_CHANGED', single: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE', multiple: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE' };
for (const kind of Object.keys(CASES)) {
  check(`${kind}：真实任务生命周期下生成后源文件被替换，任务失败、输入不归档、无发布 receipt`, async () => {
    const env = setup((fn) => cleanups.push(fn));
    const db = new DatabaseSync(path.join(env.root, 'archive.sqlite'));
    const service = createArchiveService({ database: db, rootDir: path.join(env.root, 'archive') });
    cleanups.unshift(async () => { await service.pauseBackgroundMaterialization(); db.close(); });
    assert.equal((await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const outboxStore = createArchiveOutboxStore(path.join(env.root, 'outbox'));
    const controller = createArchiveCenterController({ service, outboxStore, database: { getSetting: () => null, setSetting() {} } });
    const wrap = (generate) => async (...args) => {
      const generated = await generate(...args);
      fs.writeFileSync(`${env.source}.tmp`, 'Name,Amount\nA,999\nB,2\n');
      fs.renameSync(`${env.source}.tmp`, env.source);
      return generated;
    };
    const { contracts, calls } = loadHandlers(env, caseOverrides(env, kind, {
      toolboxMergeFilesToXlsx: wrap(generators.mergeToolboxFilesToXlsx),
      exportToolboxFilter: wrap(generators.exportToolboxFilter),
      exportToolboxMultiFilters: wrap(generators.exportToolboxMultiFilters)
    }));
    const contract = contracts.get(CASES[kind].channel);
    const payload = casePayload(env, kind);
    const prepared = await prepareIpcTaskInvocation(contract, {}, payload === undefined ? [] : [payload]);
    assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
    const policy = createTaskPolicyRegistry().require(CASES[kind].channel);
    const lifecycle = createTaskLifecycle({ archiveService: service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'fresh-lifecycle' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'fresh-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (intent) => controller.persistTaskTerminalIntent(intent) });
    let batchContext = null;
    const result = await lifecycle.runFileTask({ policy, meta: { channel: policy.channel },
      taskRunId: `fresh-${kind}`, operationKey: `fresh-${kind}-operation`,
      filePlanResolver: () => prepared.filePlan, beforeStart: prepared.beforeStart,
      execute: async (context, controls) => {
        batchContext = context;
        return contract.execute({}, prepared, createIpcTaskContext(context, controls));
      } });
    assert.deepEqual([result.status, result.code], ['failed', LIFECYCLE_CODES[kind]], JSON.stringify(result));
    assert.deepEqual([calls.publication, calls.settle], [0, 0]);
    const task = service.repository.getTaskRun(`fresh-${kind}`);
    assert.deepEqual([task.status, task.failureCode], ['failed', 'BUSINESS_TASK_FAILED']);
    const batch = service.repository.getBatch(batchContext.batchId);
    assert.deepEqual([batch.taskStatus, batch.archiveStatus], ['failed', 'incomplete']);
    const artifacts = service.repository.listArtifacts(batchContext.batchId);
    assert.deepEqual(artifacts.map((item) => [item.direction, item.status]),
      [['input', 'failed'], ...CASES[kind].targets.map(() => ['output', 'failed'])], '替换后的输入与未发布的输出都不归档');
    assert.equal(outboxStore.list().length, 0);
    assert.deepEqual(fs.readdirSync(env.userDataDir), [], '没有发布 journal / receipt');
    assert.deepEqual(fs.readdirSync(env.output).filter((name) => !name.startsWith('.')), []);
  });
}

(async () => {
  console.log('==== 工具箱发布前核对（确认前冻结 / 父目录身份 / 源文件变化） ====');
  let passed = 0;
  const failures = [];
  try {
    for (const { name, fn } of checks) {
      try {
        await fn();
        passed += 1;
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push(name);
        console.log(`FAIL ${name}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
  console.log(`==== ${passed}/${checks.length} ${failures.length ? 'FAIL' : 'PASS'} ====`);
  if (failures.length) {
    console.error('FAILURES', failures);
    process.exitCode = 1;
  }
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
