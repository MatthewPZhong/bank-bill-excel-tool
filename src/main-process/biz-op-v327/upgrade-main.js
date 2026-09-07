'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EXPORT_IO_RESOURCES } = require('./export-publication');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { withLegacyRecovery, assertLegacyRecoveryClosed } = require('../../backend/biz-op-legacy-guard');
const { TABLES, BASE, enumerate, validateSchema } = require('./upgrade-legacy');
const { fail, hash, snapshot } = require('./contracts');
const { evaluateReleaseGates, RELEASE_GATES } = require('./release-gates');
const ACTION = 'biz-op-v327:upgrade-preflight';
const TASK = 'bizOpReconV327:maintenance:upgrade';
const STAGES = ['MIGRATING', 'LEGACY_QUIESCED', 'LEGACY_DB_CLEARED', 'LEGACY_FILES_RECLAIMED', 'ACTIVE'];
function activationIntent(gatesDigest) {
  return { schemaVersion: 1, kind: 'legacy-upgrade-v1', gatesDigest,
    tables: [...TABLES], root: 'run-data/biz-op-recon', filePattern: 'month-YYYY-MM.sqlite[|-wal|-shm]' };
}
function createBizOpUpgrade({ catalog, payloadStore, protection, admission, prepareOperation, prepareDispatch,
  forgetDispatch, userDataDir, readRepository, releaseGates = RELEASE_GATES }) {
  const { db, transaction, now } = catalog;
  let host = null; let pending = null;
  const row = () => db.prepare('SELECT * FROM biz_op_v327_activation WHERE singleton=1').get() || null;
  const decision = evaluateReleaseGates(releaseGates);
  function stage(phase, evidence) {
    const current = row();
    if (STAGES.indexOf(phase) !== STAGES.indexOf(current.phase) + 1) fail('BIZOP_ACTIVATION_STAGE_CONFLICT');
    db.prepare('INSERT INTO biz_op_v327_activation_stages VALUES(?,?,?,?)').run(current.task_run_id, phase, hash(evidence), now());
    db.prepare('UPDATE biz_op_v327_activation SET phase=?,updated_at=? WHERE singleton=1').run(phase, now());
  }
  const taskGuard = `CREATE TRIGGER biz_op_v327_guard_legacy_task BEFORE INSERT ON archive_task_runs
      WHEN NEW.module_id='biz-op-recon' AND NEW.task_key GLOB 'bizOpRecon:*'
      BEGIN SELECT RAISE(ABORT,'BIZOP_LEGACY_RETIRED: 请使用新版客户端'); END`;
  function tableGuards() {
    const entries = [];
    for (const table of TABLES) if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) entries.push([`${table}_v327_guard_${action}`,
        `CREATE TRIGGER ${table}_v327_guard_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'BIZOP_LEGACY_RETIRED: 请使用新版客户端'); END`]);
    }
    return entries;
  }
  function requireGuard(name, sql, install) {
    let saved = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if (!saved && install) { db.exec(sql); saved = { sql }; }
    if (!saved || hash(saved.sql) !== hash(sql)) fail('BIZOP_LEGACY_GUARD_CHANGED');
  }
  function guardTaskCreation() { requireGuard('biz_op_v327_guard_legacy_task', taskGuard, true); }
  function guardTables() { for (const [name, sql] of tableGuards()) requireGuard(name, sql, true); }
  function verifyActive() {
    const current = row();
    // 当前门禁必须有效；已完成升级继续核验首次授权绑定的固定清理范围，证据补充不改写历史收据。
    if (!decision.ready || !current || current.phase !== 'ACTIVE' || current.intent_digest !== hash(activationIntent(current.gates_digest))
        || catalog.control().mode !== 'ACTIVE' || !catalog.receipt(current.task_run_id, current.intent_digest)) fail('BIZOP_ACTIVATION_RECEIPT_MISSING');
    if (tableGuards().length !== TABLES.length * 3) fail('BIZOP_LEGACY_SCHEMA_INCOMPLETE');
    requireGuard('biz_op_v327_guard_legacy_task', taskGuard, false);
    for (const [name, sql] of tableGuards()) requireGuard(name, sql, false);
    return true;
  }
  function assertLegacySettled() {
    if (db.prepare(`SELECT 1 FROM archive_task_flow_bind_intents i JOIN archive_task_runs t ON t.task_run_id=i.source_task_run_id
      WHERE t.module_id='biz-op-recon' AND t.task_key GLOB 'bizOpRecon:*' LIMIT 1`).get()
      || db.prepare(`SELECT 1 FROM archive_flow_bind_intents i JOIN archive_batches b ON b.id=i.source_batch_id
        WHERE b.module_id='biz-op-recon' AND b.task_key GLOB 'bizOpRecon:*' LIMIT 1`).get()) fail('BIZOP_LEGACY_LINEAGE_PENDING');
    if (db.prepare(`SELECT 1 FROM archive_task_runs WHERE module_id='biz-op-recon' AND task_key GLOB 'bizOpRecon:*'
      AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1`).get()) fail('BIZOP_LEGACY_TASK_PENDING');
    if (db.prepare(`SELECT 1 FROM archive_batches WHERE module_id='biz-op-recon' AND task_key GLOB 'bizOpRecon:*'
      AND (task_status NOT IN ('succeeded','failed','cancelled') OR archive_status!='complete') LIMIT 1`).get()) fail('BIZOP_LEGACY_ARCHIVE_PENDING');
  }
  function assertOwner() {
    const current = row(); const op = catalog.operation(current.task_run_id);
    if (!op || op.action !== 'UPGRADE' || op.intent_digest !== current.intent_digest
        || current.intent_digest !== hash(activationIntent(current.gates_digest))
        || hash(payloadStore.readDocument(op.intent_rel_path).value) !== current.intent_digest) fail('BIZOP_ACTIVATION_INTENT_CONFLICT');
    catalog.assertTask(op); assertLegacyRecoveryClosed(userDataDir); protection.refresh(current.task_run_id);
    if (!protection.closed(current.task_run_id)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
    for (const hold of readRepository.listActiveRecoveryHolds()) {
      if (hold.actionKey.startsWith('biz-op-v327:') && hold.taskRunId !== current.task_run_id) fail('BIZOP_ACTIVATION_OTHER_HOLD');
    }
    if (db.prepare("SELECT 1 FROM biz_op_v327_prepared_ops WHERE task_run_id!=? AND phase!='CLOSED' LIMIT 1").get(current.task_run_id)
        || db.prepare('SELECT 1 FROM biz_op_v327_read_pins LIMIT 1').get()) fail('BIZOP_ACTIVATION_OTHER_OPERATION');
    return op;
  }
  async function job(context, plan) {
    assertOwner(); const candidateRef = `candidate-${randomUUID()}`;
    const request = prepareDispatch({ taskContext: context, actionKey: ACTION, plan: { ...plan, phase: 'upgrade-legacy-v1',
      userDataDir, candidateRef, intentDigest: row().intent_digest } });
    const planDigest = payloadStore.readDocument(`operations/${context.taskRunId}/${request.input.planRef}.json`).digest;
    const control = host.getRuntime().start(request); protection.attachControl(control);
    let outcome;
    try { await boundary('WORKER_STARTED'); outcome = await control.promise; await control.waitForCarrierClosure({ timeoutMs: 5000 }); }
    finally { protection.refresh(context.taskRunId); if (protection.closed(context.taskRunId)) forgetDispatch(request); }
    if (!protection.closed(context.taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
    if (outcome.outcome !== 'completed') fail(outcome.error?.code || 'BIZOP_UPGRADE_JOB_FAILED');
    if (outcome.result.planDigest !== planDigest || outcome.result.candidateRef !== candidateRef) fail('BIZOP_UPGRADE_PROOF_INVALID');
    const proof = payloadStore.readDocument(`operations/${context.taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
    if (proof.taskRunId !== context.taskRunId || proof.intentDigest !== row().intent_digest
        || proof.candidateRef !== candidateRef || proof.step !== plan.step || proof.result.length !== outcome.result.rowCount) fail('BIZOP_UPGRADE_PROOF_INVALID');
    return proof.result;
  }
  async function scan(context, quiescent) {
    const before = enumerate(userDataDir); const names = before.filter((file) => BASE.test(file.name)).map((file) => file.name);
    if (before.some((file) => !names.includes(file.name.replace(/-(wal|shm)$/, '')))) fail('BIZOP_LEGACY_ORPHAN_COMPANION');
    const files = [];
    for (let i = 0; i < names.length; i += 32) files.push(...await job(context, { step: 'inspect', names: names.slice(i, i + 32), quiescent }));
    const after = enumerate(userDataDir);
    if (hash(after) !== hash(files.map(({ name, identity }) => ({ name, identity })).sort((a, b) => a.name.localeCompare(b.name, 'en')))) fail('BIZOP_LEGACY_INVENTORY_CHANGED');
    return files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  const savedFiles = () => db.prepare('SELECT * FROM biz_op_v327_activation_files WHERE task_run_id=? ORDER BY file_name').all(row().task_run_id)
    .map((file) => ({ name: file.file_name, identity: JSON.parse(file.identity_json), sha256: file.sha256, reclaimed: file.reclaimed }));
  async function boundary(phase) { if (host.afterStage) await host.afterStage(phase, row()); }
  function assertFileReferences(files) {
    const selected = new Set(files.map((file) => path.resolve(userDataDir, 'run-data', 'biz-op-recon', file.name)));
    // Archive 未决原路径仍由它自己的 owner 决定处理；不能因为它恰好落在旧根就清除。
    for (const row of db.prepare("SELECT source_path FROM archive_artifacts WHERE status!='ready'").iterate()) {
      if (selected.has(path.resolve(row.source_path))) fail('BIZOP_LEGACY_SOURCE_STILL_REQUIRED');
    }
  }
  async function advance(context, quiesceOnly) {
    assertOwner();
    if (row().phase === 'MIGRATING') {
      // 先完整检查路径和旧 schema，再允许原 provider 打开侧库；其结果不能授权最终清理。
      validateSchema(db); await scan(context, false);
      await withLegacyRecovery(userDataDir, () => host.recoverLegacy());
      if (quiesceOnly) return { status: 'pending', phase: row().phase };
      await withLegacyRecovery(userDataDir, () => host.flushLegacyOutbox());
      assertLegacySettled(); validateSchema(db, { quiescent: true });
      transaction(() => stage('LEGACY_QUIESCED', { recoveredBy: 'original-legacy-provider' }));
      await boundary('LEGACY_QUIESCED');
    }
    if (quiesceOnly) return { status: 'pending', phase: row().phase };
    if (row().phase === 'LEGACY_QUIESCED') {
      await withLegacyRecovery(userDataDir, () => host.flushLegacyOutbox());
      assertLegacySettled(); validateSchema(db, { quiescent: true });
      const files = await scan(context, true);
      transaction(() => {
        assertOwner(); assertLegacySettled(); validateSchema(db, { quiescent: true }); assertFileReferences(files);
        if (hash(enumerate(userDataDir)) !== hash(files.map(({ name, identity }) => ({ name, identity })))) fail('BIZOP_LEGACY_INVENTORY_CHANGED');
        for (const file of files) db.prepare('INSERT INTO biz_op_v327_activation_files(task_run_id,file_name,identity_json,sha256) VALUES(?,?,?,?)')
          .run(context.taskRunId, file.name, JSON.stringify(file.identity), file.sha256);
        const tables = validateSchema(db, { quiescent: true });
        for (const table of TABLES) if (tables.includes(table)) db.exec(`DELETE FROM ${table}`);
        guardTables();
        db.prepare('UPDATE biz_op_v327_activation SET inventory_digest=? WHERE singleton=1').run(hash(files));
        stage('LEGACY_DB_CLEARED', { inventory: hash(files), tables });
      });
      await boundary('LEGACY_DB_CLEARED');
    }
    if (row().phase === 'LEGACY_DB_CLEARED') {
      const files = savedFiles();
      if (hash(files.map(({ reclaimed, ...file }) => file)) !== row().inventory_digest) fail('BIZOP_ACTIVATION_INVENTORY_CONFLICT');
      assertLegacySettled(); assertFileReferences(files);
      const byName = new Map(files.map((file) => [file.name, file]));
      for (const actual of enumerate(userDataDir)) {
        const saved = byName.get(actual.name);
        if (!saved || saved.reclaimed || hash(saved.identity) !== hash(actual.identity)) fail('BIZOP_LEGACY_INVENTORY_CHANGED');
      }
      const remaining = files.filter((file) => !file.reclaimed);
      for (let i = 0; i < remaining.length; i += 96) {
        const page = remaining.slice(i, i + 96).map(({ reclaimed, ...file }) => file);
        const done = await job(context, { step: 'reclaim', files: page });
        if (hash(done) !== hash(page.map((file) => file.name))) fail('BIZOP_UPGRADE_PROOF_INVALID');
        await boundary('FILE_WORKER_CLOSED');
        transaction(() => { for (const name of done) db.prepare('UPDATE biz_op_v327_activation_files SET reclaimed=1 WHERE task_run_id=? AND file_name=?').run(context.taskRunId, name); });
        await boundary('FILE_PAGE_RECLAIMED');
      }
      if (enumerate(userDataDir).length) fail('BIZOP_LEGACY_FILES_REMAIN');
      transaction(() => stage('LEGACY_FILES_RECLAIMED', { inventory: row().inventory_digest }));
      await boundary('LEGACY_FILES_RECLAIMED');
    }
    if (row().phase === 'LEGACY_FILES_RECLAIMED') {
      assertOwner(); assertLegacySettled();
      requireGuard('biz_op_v327_guard_legacy_task', taskGuard, false);
      for (const [name, sql] of tableGuards()) requireGuard(name, sql, false);
      if (enumerate(userDataDir).length) fail('BIZOP_LEGACY_FILES_REMAIN');
      protection.completeInputObligation(context.taskRunId);
      transaction(() => {
        stage('ACTIVE', { inventory: row().inventory_digest, gates: row().gates_digest });
        catalog.commitActivation({ taskRunId: context.taskRunId, intentDigest: row().intent_digest });
      });
      await boundary('ACTIVE');
    }
    return { status: 'ok', phase: row().phase, taskRunId: context.taskRunId };
  }
  function begin(context) {
    const intent = activationIntent(decision.digest);
    transaction(() => {
      if (catalog.control().mode !== 'DISABLED' || row()) fail('BIZOP_ACTIVATION_ALREADY_STARTED');
      const op = prepareOperation({ taskRunId: context.taskRunId, operationKey: context.operationKey, actionKey: ACTION, intent });
      db.prepare(`INSERT INTO biz_op_v327_activation(singleton,task_run_id,intent_digest,gates_digest,phase,updated_at) VALUES(1,?,?,?,'MIGRATING',?)`)
        .run(context.taskRunId, op.intent_digest, decision.digest, now());
      db.prepare("UPDATE biz_op_v327_control SET mode='MIGRATING',activation_task_id=? WHERE singleton=1").run(context.taskRunId);
      db.prepare('INSERT INTO biz_op_v327_activation_stages VALUES(?,?,?,?)').run(context.taskRunId, 'MIGRATING', op.intent_digest, now());
      guardTaskCreation();
    });
  }
  async function acquirePrecheckCapacity() {
    const runtime = host.getRuntime();
    if (!runtime?.resourceGovernor) fail('BIZOP_ACTIVATION_RUNTIME_REQUIRED');
    try {
      // 启动阶段不能等待不可满足的固定预算；已有队列时 reject 仍会排队，必须同时限定等待时间。
      return await runtime.resourceGovernor.acquirePhaseLease({ ownerKey: `biz-op-v327:precheck:${randomUUID()}`,
        actionKey: ACTION, operationKey: `biz-op-v327:precheck:${randomUUID()}`, resources: EXPORT_IO_RESOURCES,
        lowMemoryBehavior: 'reject', timeoutMs: 0 });
    } catch (error) {
      if (['RESOURCE_BUDGET_UNAVAILABLE', 'ADMISSION_TIMEOUT'].includes(error.code)) {
        fail('BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE', '业务 OP 升级所需内存或后台资源不足，请释放资源后重新启动');
      }
      throw error;
    }
  }
  async function runAttempt({ quiesceOnly = false } = {}) {
    if (!decision.ready) {
      if (catalog.control().mode === 'DISABLED') return { status: 'disabled', missing: decision.missing };
      fail('BIZOP_RELEASE_GATES_REQUIRED', '业务 OP 发布门禁尚未全部通过，已保留现有保护');
    }
    if (!host) fail('BIZOP_ACTIVATION_HOST_REQUIRED');
    if (row()?.phase === 'ACTIVE') {
      verifyActive();
      return { status: 'ok', phase: 'ACTIVE', reused: true };
    }
    return admission.exclusive(async () => {
      if (row()) {
        const original = catalog.task(row().task_run_id);
        // 平台已标记 interrupted 时保持其恢复 overlay；完成收据后由原 Coordinator
        // 执行 begin/complete recovery，不能经 Archive 的旧接口单独改回 running。
        if (!['running', 'interrupted'].includes(original.status)) fail('BIZOP_ACTIVATION_TASK_CONFLICT');
        // 中断后的启动同样可能需要 inspect/reclaim worker，不能绕过容量预检。
        (await acquirePrecheckCapacity()).release('upgrade-resume-precheck-complete');
        return advance({ taskRunId: original.taskRunId, taskKey: original.taskKey, moduleId: original.moduleId,
          operationKey: original.operationKey, parentRunId: original.parentRunId }, quiesceOnly);
      }
      await host.assertStartAllowed();
      if (validateSchema(db).length !== TABLES.length) fail('BIZOP_LEGACY_SCHEMA_INCOMPLETE');
      const capacity = await acquirePrecheckCapacity();
      try {
        const disk = fs.statfsSync(userDataDir, { bigint: true });
        const mainPath = db.prepare('PRAGMA database_list').all().find((item) => item.name === 'main')?.file;
        const reserve = 128n * 1024n * 1024n + (mainPath ? fs.statSync(mainPath, { bigint: true }).size : 0n);
        if (disk.bavail * disk.bsize < reserve) fail('BIZOP_ACTIVATION_DISK_SPACE');
        // 与实际 intent 使用相同的目录耐久能力；失败发生在创建迁移 Task 和改模式之前。
        payloadStore.writeDocument(`upgrade/precheck-${randomUUID()}.json`, { gatesDigest: decision.digest, checkedAt: now() });
      } finally { capacity.release('upgrade-precheck-complete'); }
      let context;
      try {
        return await host.getTaskLifecycle().runOperationOnly({ policy: createTaskPolicyRegistry().require(TASK),
          meta: { channel: TASK }, beforeTerminalSettlement({ businessError }) {
            if (row() && (businessError || !catalog.receipt(row().task_run_id))) {
              if (businessError) throw businessError;
              fail('BIZOP_ACTIVATION_PENDING');
            }
          }, execute: async (value) => {
            context = value; begin(value); await boundary('MIGRATING');
            const result = await advance(value, quiesceOnly);
            if (result.status === 'pending') fail('BIZOP_ACTIVATION_PENDING');
            return result;
          } });
      } catch (error) {
        if (error.code === 'BIZOP_ACTIVATION_PENDING' && quiesceOnly && ['MIGRATING', 'LEGACY_QUIESCED'].includes(row()?.phase)) {
          return { status: 'pending', phase: row().phase, taskRunId: context.taskRunId };
        }
        throw error;
      }
    }, { recovery: true });
  }
  return Object.freeze({
    bindHost(value) {
      if (host || !value || ['getRuntime', 'getTaskLifecycle', 'getArchiveService', 'recoverLegacy', 'flushLegacyOutbox', 'assertStartAllowed']
        .some((key) => typeof value[key] !== 'function')) fail('BIZOP_ACTIVATION_HOST_INVALID');
      host = value;
    },
    run(options) { if (pending) return pending; pending = runAttempt(options).finally(() => { pending = null; }); return pending; },
    status: () => snapshot({ releaseReady: decision.ready, phase: row()?.phase || 'DISABLED', missing: decision.missing }),
    verifyActive, needed: () => decision.ready || catalog.control().mode !== 'DISABLED'
  });
}
module.exports = { createBizOpUpgrade, STAGES };
