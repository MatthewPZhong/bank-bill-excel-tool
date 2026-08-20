'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  REQUIRED_SCENARIOS,
  REQUIRED_VARIANTS,
  buildReport,
  collectEnvironmentEvidence,
  freezeDatabaseBundle,
  fullReadyEvidence,
  main,
  measureSample,
  parseArgs,
  prepareSampleDatabase,
  rotatedOrder,
  scenarioPostcondition,
  scenarioPrecondition,
  schemaFingerprint,
  summarize,
  validateArtifactIdentities,
  verifyNormalSchemaSteady,
  waitForFullReady
} = require('../../../scripts/measure-packaged-startup');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function createSettingsDatabase(filePath, entries = []) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE vcc_fin_op_system_snapshots (
      id INTEGER PRIMARY KEY,
      import_source_id INTEGER
    );
    CREATE TABLE archive_blobs (
      id INTEGER PRIMARY KEY,
      sha256 TEXT NOT NULL,
      fingerprint_size_bytes INTEGER,
      fingerprint_mtime_ms REAL,
      fingerprint_ctime_ms REAL,
      fingerprint_ino TEXT
    );
    CREATE TABLE archive_artifacts (
      id INTEGER PRIMARY KEY,
      blob_id INTEGER,
      status TEXT,
      storage_fingerprint_size_bytes INTEGER,
      storage_fingerprint_mtime_ms REAL,
      storage_fingerprint_ctime_ms REAL,
      storage_fingerprint_ino TEXT
    );
    CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL;
  `);
  const insert = db.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)');
  for (const [key, value] of entries) insert.run(key, value);
  db.close();
}

function createLegacySettingsDatabase(filePath, entries = []) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE vcc_fin_op_system_snapshots (id INTEGER PRIMARY KEY);
    CREATE TABLE archive_blobs (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL);
    CREATE TABLE archive_artifacts (id INTEGER PRIMARY KEY, blob_id INTEGER, status TEXT);
  `);
  const insert = db.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)');
  for (const [key, value] of entries) insert.run(key, value);
  db.close();
}

function addArchiveFingerprintColumns(db) {
  db.exec(`
    ALTER TABLE archive_blobs ADD COLUMN fingerprint_size_bytes INTEGER;
    ALTER TABLE archive_blobs ADD COLUMN fingerprint_mtime_ms REAL;
    ALTER TABLE archive_blobs ADD COLUMN fingerprint_ctime_ms REAL;
    ALTER TABLE archive_blobs ADD COLUMN fingerprint_ino TEXT;
    ALTER TABLE archive_artifacts ADD COLUMN storage_fingerprint_size_bytes INTEGER;
    ALTER TABLE archive_artifacts ADD COLUMN storage_fingerprint_mtime_ms REAL;
    ALTER TABLE archive_artifacts ADD COLUMN storage_fingerprint_ctime_ms REAL;
    ALTER TABLE archive_artifacts ADD COLUMN storage_fingerprint_ino TEXT;
  `);
}

function fileFingerprint(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

test('packaged startup 轮换四变体且至少五轮不丢首样本', () => {
  const orders = Array.from({ length: 5 }, (_, index) => rotatedOrder(index));
  assert.deepEqual(orders[0], REQUIRED_VARIANTS);
  assert.deepEqual(orders[1], REQUIRED_VARIANTS.slice(1).concat(REQUIRED_VARIANTS[0]));
  for (const label of REQUIRED_VARIANTS) {
    assert.equal(orders.flat().filter((value) => value === label).length, 5);
  }
});

test('report 以 external full-ready median 验收且缺样本保持 not-evaluated', () => {
  const samples = [10, 30, 20, 50, 40];
  const variants = REQUIRED_VARIANTS.map((label) => ({
    label,
    initialSha256: 'a'.repeat(64),
    initialWalSha256: null,
    initialShmSha256: null,
    samples: samples.map((externalFullReadyMs, index) => ({
      round: index + 1,
      status: 'success',
      externalFullReadyMs,
      phases: [{ phase: 'database-optimize', outcome: 'success', durationMs: 1 }]
    }))
  }));
  const report = buildReport({
    goldenDb: __filename,
    goldenWal: '',
    goldenShm: '',
    runs: 5,
    scenario: 'normal-clean-shutdown',
    timeoutMs: 300000
  }, 'a'.repeat(64), variants, Array.from({ length: 5 }, (_, index) => rotatedOrder(index)));
  assert.equal(summarize(samples).median, 30);
  assert.equal(report.variants['3.1.12-portable'].summary.externalFullReadyMs.median, 30);
  assert.equal(report.contract.acceptanceMetric, 'externalFullReadyMs.median');
  assert.equal(report.contract.claimedReductionPercent, null);
  assert.equal(report.evaluation.status, 'not-evaluated');
  assert.equal(report.evaluation.missingSamples['3.1.11-installer'], 0);
});

test('3.1.11/3.1.12 都等 renderer 完整初始化，3.1.12 额外要求两个 main phase', () => {
  assert.equal(fullReadyEvidence('3.1.11-portable', { renderer: null }), null);
  assert.equal(fullReadyEvidence('3.1.11-portable', {
    renderer: { durations: { totalInitMs: 321 } }
  }).mode, 'legacy-renderer-complete');
  assert.equal(fullReadyEvidence('3.1.12-portable', {
    renderer: { durations: { totalInitMs: 1 } },
    phases: [{ phase: 'window-ready', outcome: 'success' }]
  }), null);
  assert.equal(fullReadyEvidence('3.1.12-portable', {
    phases: [
      { phase: 'window-ready', outcome: 'success', durationMs: 2 },
      { phase: 'startup-total', outcome: 'success', durationMs: 8 }
    ]
  }), null, 'main ready-to-show 不能提前截断 renderer 初始化尾段');
  assert.deepEqual(fullReadyEvidence('3.1.12-portable', {
    renderer: { durations: { totalInitMs: 9 } },
    phases: [
      { phase: 'window-ready', outcome: 'success', durationMs: 2 },
      { phase: 'startup-total', outcome: 'success', durationMs: 8 }
    ]
  }), {
    mode: 'phase-and-renderer-contract',
    rendererInitMs: 9,
    windowReadyMs: 2,
    startupTotalMs: 8
  });
});

test('sample 以 adapter 的 processCreatedAt 计时，ready 后 graceful close 且不混入退出耗时', async () => {
  const root = tempDir('startup-sample');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  let clock = 5000;
  let graceful = 0;
  let forced = 0;
  const adapter = {
    async launch() { return { processCreatedAt: 5000, exitPromise: Promise.resolve({ code: 0, signal: null }) }; },
    async refreshTree() { return [10, 11, 12]; },
    async gracefulClose() { graceful += 1; clock += 9000; return { livePids: [10, 11, 12], acceptedPids: [10] }; },
    async waitForExit() { return { exited: true, verifiedEmpty: true }; },
    async forceCleanup() { forced += 1; return { verifiedEmpty: true, stoppedPids: [20, 21] }; },
    async delay() {}
  };
  const result = await measureSample({
    label: '3.1.12-portable',
    executable: __filename,
    variantRoot: root,
    userDataDir,
    documentsDir,
    databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
    adapter,
    now: () => { clock += 10; return clock; },
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success', durationMs: 1 },
      { phase: 'startup-total', outcome: 'success', durationMs: 2 },
      { phase: 'database-vacuum', outcome: 'skipped' },
      { phase: 'archive-outbox', outcome: 'success', counts: {
        pendingTerminalBatches: 0, pendingTerminalTasks: 0
      } },
      { phase: 'vcc-lineage-gate', outcome: 'success', counts: {
        bound: 2, failed: 0, pending: 0, released: 0
      } }
    ] })
  });
  assert.ok(result.externalFullReadyMs > 0 && result.externalFullReadyMs < 100);
  assert.equal(graceful, 1);
  assert.equal(forced, 0);
  assert.equal(result.processTree.observedProcessCount, 3);
});

test('graceful close 超时形成证据码并强制清理整棵进程树', async () => {
  const root = tempDir('startup-close-timeout');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  let forced = 0;
  const adapter = {
    async launch() { return { processCreatedAt: 0 }; },
    async refreshTree() { return [20, 21]; },
    async gracefulClose() { return { livePids: [20, 21], acceptedPids: [20] }; },
    async waitForExit() { return false; },
    async forceCleanup() { forced += 1; return { verifiedEmpty: true, stoppedPids: [20, 21] }; },
    async delay() {}
  };
  let clock = 0;
  await assert.rejects(measureSample({
    label: '3.1.11-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
    adapter,
    now: () => ++clock,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } } })
  }), (error) => error.code === 'PROCESS_TREE_GRACEFUL_CLOSE_TIMEOUT');
  assert.equal(forced, 1);
});

test('ready 后失败但 cleanup verified 时立即冻结 after；freeze 失败仍保留 cleanup receipt', async () => {
  for (const freezeFails of [false, true]) {
    const root = tempDir(`startup-cleanup-after-${freezeFails ? 'fail' : 'success'}`);
    const userDataDir = path.join(root, 'userData');
    const documentsDir = path.join(root, 'Documents');
    fs.mkdirSync(userDataDir);
    fs.mkdirSync(documentsDir);
    const databasePath = path.join(userDataDir, 'tool-data.sqlite');
    createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
    const cleanupReceipt = { verifiedEmpty: true, stoppedPids: [25], quiescenceSnapshots: [[], [], []] };
    const adapter = {
      async launch() { return { processCreatedAt: 0 }; },
      async refreshTree() {
        const error = new Error('snapshot timeout after ready');
        error.code = 'PROCESS_SNAPSHOT_TIMEOUT';
        throw error;
      },
      async forceCleanup() { return cleanupReceipt; },
      async delay() {}
    };
    let clock = 0;
    await assert.rejects(measureSample({
      label: '3.1.12-portable', executable: __filename, variantRoot: root,
      userDataDir, documentsDir, databasePath
    }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
      adapter,
      now: () => ++clock,
      readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
        { phase: 'window-ready', outcome: 'success', durationMs: 1 },
        { phase: 'startup-total', outcome: 'success', durationMs: 2 }
      ] }),
      freezeDatabaseBundle: freezeFails ? (() => {
        const error = new Error('synthetic freeze failure');
        error.code = 'SYNTHETIC_FREEZE_FAILED';
        throw error;
      }) : undefined
    }), (error) => {
      assert.deepEqual(error.sampleEvidence.cleanupEvidence, cleanupReceipt);
      assert.notEqual(error.sampleEvidence.readyEvidence, 'unavailable');
      if (freezeFails) {
        assert.equal(error.code, 'STARTUP_SAMPLE_AFTER_FREEZE_FAILED');
        assert.deepEqual(error.sampleEvidence.after, {
          status: 'unavailable',
          reason: 'post-cleanup-bundle-freeze-failed',
          evidenceCode: 'SYNTHETIC_FREEZE_FAILED'
        });
      } else {
        assert.equal(error.code, 'PROCESS_SNAPSHOT_TIMEOUT');
        assert.equal(error.sampleEvidence.after.database.exists, true);
        assert.equal(error.sampleEvidence.after.database.sha256, fileFingerprint(databasePath).sha256);
      }
      return true;
    });
  }
});

test('metrics 已 ready 时先取证且不执行慢 CIM，external 指标不含 runner snapshot', async () => {
  let clock = 1000;
  let snapshots = 0;
  const ready = await waitForFullReady({
    label: '3.1.12-portable',
    metricsPath: 'unused',
    handle: {},
    timeoutMs: 10000,
    now: () => clock,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success', durationMs: 1 },
      { phase: 'startup-total', outcome: 'success', durationMs: 2 }
    ] }),
    adapter: {
      async refreshTree() { snapshots += 1; clock += 400; },
      async delay() { clock += 100; }
    }
  });
  assert.equal(snapshots, 0);
  assert.equal(ready.fullReadyMs, 0);
});

test('metrics 未ready时 root code9 在500ms立即失败，不跑CIM或等满timeout', async () => {
  let clock = 0;
  let snapshots = 0;
  let resolveExit;
  const handle = {
    processTokens: new Map(),
    exitPromise: new Promise((resolve) => { resolveExit = resolve; })
  };
  await assert.rejects(waitForFullReady({
    label: '3.1.12-portable', metricsPath: 'unused', handle, timeoutMs: 10000,
    now: () => clock,
    readMetrics: () => null,
    adapter: {
      async refreshTree() { snapshots += 1; },
      async delay(milliseconds) {
        clock += milliseconds;
        if (clock === 500) resolveExit({ code: 9, signal: null });
        await Promise.resolve();
      }
    }
  }), (error) => error.code === 'PROCESS_EXITED_BEFORE_FULL_READY'
    && error.evidence.ownership === 'unestablished');
  assert.equal(clock, 500);
  assert.equal(snapshots, 0);
});

test('partial phases 已成功但 renderer 缺失直到 timeout 时失败样本保留阶段与缺失 marker', async () => {
  const root = tempDir('startup-partial-ready-timeout');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const partialMetrics = { phases: [
    { phase: 'window-ready', outcome: 'success', durationMs: 11 },
    { phase: 'startup-total', outcome: 'success', durationMs: 22 },
    { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
    { phase: 'vcc-lineage-gate', outcome: 'success', counts: { bound: 3, failed: 0, pending: 0, released: 0 } }
  ] };
  let clock = 0;
  let forced = 0;
  await assert.rejects(measureSample({
    label: '3.1.12-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 300, goldenDb: databasePath }, {
    now: () => clock,
    readMetrics: () => partialMetrics,
    adapter: {
      async launch() {
        return { processCreatedAt: 0, exitPromise: new Promise(() => {}) };
      },
      async delay(milliseconds) { clock += milliseconds; },
      async forceCleanup() {
        forced += 1;
        return { verifiedEmpty: true, stoppedPids: [71], quiescenceSnapshots: [[], [], []] };
      }
    }
  }), (error) => {
    assert.equal(error.code, 'STARTUP_FULL_READY_TIMEOUT');
    assert.equal(error.evidence.readyEvidence.status, 'incomplete');
    assert.equal(error.evidence.lastMetrics, partialMetrics);
    assert.equal(error.sampleEvidence.readyEvidence.status, 'incomplete');
    assert.deepEqual(error.sampleEvidence.readyEvidence.missing, ['renderer.durations.totalInitMs']);
    assert.deepEqual(error.sampleEvidence.phases, partialMetrics.phases);
    assert.deepEqual(error.sampleEvidence.recoveryCounts['archive-outbox'], {
      pendingTerminalBatches: 0, pendingTerminalTasks: 0
    });
    assert.equal(Object.hasOwn(error.sampleEvidence, 'externalFullReadyMs'), false);
    return true;
  });
  assert.equal(forced, 1);
  assert.equal(clock, 300, '进程保持存活直到完整 timeout，不能提前形成 ready success');
});

test('root early-exit 前已有 partial metrics 时仍保留阶段与缺失 marker', async () => {
  const root = tempDir('startup-partial-ready-early-exit');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const partialMetrics = { phases: [
    { phase: 'window-ready', outcome: 'success', durationMs: 7 },
    { phase: 'startup-total', outcome: 'success', durationMs: 13 },
    { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0 } }
  ] };
  await assert.rejects(measureSample({
    label: '3.1.12-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 1000, goldenDb: databasePath }, {
    now: () => 0,
    readMetrics: () => partialMetrics,
    adapter: {
      async launch() {
        return {
          processCreatedAt: 0,
          processTokens: new Map(),
          exitPromise: Promise.resolve({ code: 9, signal: null })
        };
      },
      async delay() {},
      async forceCleanup() {
        return { verifiedEmpty: true, stoppedPids: [], quiescenceSnapshots: [[], [], []] };
      }
    }
  }), (error) => {
    assert.equal(error.code, 'PROCESS_EXITED_BEFORE_FULL_READY');
    assert.equal(error.evidence.readyEvidence.status, 'incomplete');
    assert.equal(error.evidence.lastMetrics, partialMetrics);
    assert.equal(error.sampleEvidence.readyEvidence.status, 'incomplete');
    assert.deepEqual(error.sampleEvidence.readyEvidence.missing, ['renderer.durations.totalInitMs']);
    assert.deepEqual(error.sampleEvidence.phases, partialMetrics.phases);
    assert.deepEqual(error.sampleEvidence.recoveryCounts['archive-outbox'], {
      pendingTerminalBatches: 0
    });
    assert.equal(Object.hasOwn(error.sampleEvidence, 'externalFullReadyMs'), false);
    return true;
  });
});

test('metrics 与 root exit 同 tick ready 时先固定 ready 证据', async () => {
  const result = await waitForFullReady({
    label: '3.1.12-portable', metricsPath: 'unused', timeoutMs: 10000,
    handle: { exitPromise: Promise.resolve({ code: 9, signal: null }), processTokens: new Map() },
    now: () => 100,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success' },
      { phase: 'startup-total', outcome: 'success' }
    ] }),
    adapter: { async delay() { throw new Error('ready tick 不应等待'); } }
  });
  assert.equal(result.evidence.mode, 'phase-and-renderer-contract');
});

test('ready 后 owned live target 为空不得伪造 graceful success', async () => {
  const root = tempDir('startup-no-close-target');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  let forced = 0;
  const adapter = {
    async launch() { return { processCreatedAt: 0, rootExit: { code: 9, signal: null } }; },
    async refreshTree() { return []; },
    async gracefulClose() { return { livePids: [], acceptedPids: [] }; },
    async waitForExit() { return { exited: true, verifiedEmpty: true, rootExit: { code: 9, signal: null } }; },
    async forceCleanup() { forced += 1; return { verifiedEmpty: true, stoppedPids: [] }; },
    async delay() {}
  };
  let clock = 0;
  await assert.rejects(measureSample({
    label: '3.1.12-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
    adapter,
    now: () => ++clock,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success' },
      { phase: 'startup-total', outcome: 'success' }
    ] })
  }), (error) => error.code === 'PROCESS_TREE_CLOSE_TARGET_MISSING');
  assert.equal(forced, 1);
});

test('receipt 与 tree-empty 不能掩盖 exitPromise code=9', async () => {
  const root = tempDir('startup-root-code9');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  let forced = 0;
  const adapter = {
    async launch() {
      return { processCreatedAt: 0, rootExit: null, exitPromise: Promise.resolve({ code: 9, signal: null }) };
    },
    async refreshTree() { return [30, 31]; },
    async gracefulClose() { return { livePids: [30, 31], acceptedPids: [30] }; },
    async waitForExit() { return { exited: true, verifiedEmpty: true, rootExit: null }; },
    async forceCleanup() { forced += 1; },
    async delay() {}
  };
  let clock = 0;
  await assert.rejects(measureSample({
    label: '3.1.12-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
    adapter,
    now: () => ++clock,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success' },
      { phase: 'startup-total', outcome: 'success' },
      { phase: 'database-vacuum', outcome: 'skipped' }
    ] })
  }), (error) => error.code === 'PROCESS_TREE_NONZERO_EXIT');
  assert.equal(forced, 0, 'tree 已退出且 after 已冻结时，非零 root 不应再伪造需要 cleanup');
});

test('migration-vacuum 有真实 flag 前后条件且不能 skipped', () => {
  const root = tempDir('startup-vacuum');
  const databasePath = path.join(root, 'tool-data.sqlite');
  createLegacySettingsDatabase(databasePath);
  const sample = { databasePath, userDataDir: root };
  const options = { scenario: 'migration-vacuum' };
  const precondition = scenarioPrecondition(options, sample);
  assert.equal(precondition.vacuumFlagBefore, null);
  const db = new DatabaseSync(databasePath);
  db.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)')
    .run('db_one_time_vacuum_v3_0_5_done', '1');
  db.exec(`
    ALTER TABLE vcc_fin_op_system_snapshots ADD COLUMN import_source_id INTEGER;
    CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL;
  `);
  addArchiveFingerprintColumns(db);
  db.close();
  assert.throws(() => scenarioPostcondition(options, { label: '3.1.12-portable' }, sample, {
    phases: [{ phase: 'database-vacuum', outcome: 'skipped' }]
  }, { precondition }), (error) => error.code === 'VACUUM_POSTCONDITION_NOT_EXECUTED');
  assert.equal(scenarioPostcondition(options, { label: '3.1.12-portable' }, sample, {
    phases: [{ phase: 'database-vacuum', outcome: 'success' }]
  }, { precondition }).vacuumFlagAfter, '1');
});

test('migration 只允许精确 VCC delta 与 Archive 8 个 nullable 指纹列，额外列仍拒绝', () => {
  const root = tempDir('startup-migration-column-whitelist');
  const databasePath = path.join(root, 'tool-data.sqlite');
  createLegacySettingsDatabase(databasePath);
  const sample = { databasePath, userDataDir: root };
  const options = { scenario: 'migration-vacuum' };
  const precondition = scenarioPrecondition(options, sample);
  const db = new DatabaseSync(databasePath);
  db.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)')
    .run('db_one_time_vacuum_v3_0_5_done', '1');
  db.exec(`
    ALTER TABLE vcc_fin_op_system_snapshots ADD COLUMN import_source_id INTEGER;
    ALTER TABLE vcc_fin_op_system_snapshots ADD COLUMN unexpected_extra TEXT;
    CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL;
  `);
  addArchiveFingerprintColumns(db);
  db.close();
  assert.throws(() => scenarioPostcondition(options, { label: '3.1.12-portable' }, sample, {
    phases: [{ phase: 'database-vacuum', outcome: 'success' }]
  }, { precondition }), (error) => (
    error.code === 'VACUUM_POSTCONDITION_NOT_EXECUTED'
    && error.evidence.schema.current === true
    && error.evidence.columnDeltaValid === false
    && error.evidence.indexDefinitionValid === true
  ));
});

test('postcondition 不打开 timed WAL bundle，冻结后 SHM 仍不存在且 probe 删除', () => {
  const root = tempDir('startup-post-probe');
  const source = path.join(root, 'source.sqlite');
  const writer = new DatabaseSync(source);
  writer.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE vcc_fin_op_system_snapshots(id INTEGER PRIMARY KEY, import_source_id INTEGER);
    CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL;
  `);
  writer.prepare('INSERT INTO app_settings VALUES (?, ?)').run('db_one_time_vacuum_v3_0_5_done', '1');
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const mainOnly = path.join(root, 'main-only.sqlite');
  fs.copyFileSync(source, mainOnly);
  const mainSchemaFingerprint = schemaFingerprint(mainOnly);
  writer.exec('CREATE TABLE wal_tail(id INTEGER PRIMARY KEY);');
  const timed = path.join(root, 'timed.sqlite');
  fs.copyFileSync(source, timed);
  fs.copyFileSync(`${source}-wal`, `${timed}-wal`);
  assert.equal(fs.existsSync(`${timed}-shm`), false);
  const probeRoot = path.join(root, 'post-probe');
  const precondition = { schema: { fingerprint: mainSchemaFingerprint } };
  const result = scenarioPostcondition(
    { scenario: 'normal-clean-shutdown' },
    { label: '3.1.12-portable' },
    { databasePath: timed, userDataDir: root },
    { phases: [
      { phase: 'database-vacuum', outcome: 'skipped' },
      { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
      { phase: 'vcc-lineage-gate', outcome: 'success', counts: { failed: 0, pending: 0, released: 0 } }
    ] },
    {
      precondition,
      createPostconditionProbeDir() { fs.mkdirSync(probeRoot); return probeRoot; }
    }
  );
  assert.equal(result.vacuumFlagAfter, '1');
  assert.equal(fs.existsSync(`${timed}-shm`), false);
  assert.equal(fs.existsSync(probeRoot), false);
  writer.close();
});

test('crash recovery 用 disposable clone 验 WAL sentinel，timed sample launch 前逐字节不变', () => {
  const root = tempDir('startup-wal');
  const active = path.join(root, 'active.sqlite');
  const writer = new DatabaseSync(active);
  writer.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE vcc_fin_op_system_snapshots (id INTEGER PRIMARY KEY, import_source_id INTEGER);
    CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL;
  `);
  writer.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)')
    .run('db_one_time_vacuum_v3_0_5_done', '1');
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  writer.prepare('INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)')
    .run('startup_wal_probe', `visible-${'x'.repeat(256)}`);
  const goldenDb = path.join(root, 'golden.sqlite');
  const goldenWal = path.join(root, 'golden.sqlite-wal-input');
  const goldenShm = path.join(root, 'golden.sqlite-shm-input');
  fs.copyFileSync(active, goldenDb);
  fs.copyFileSync(`${active}-wal`, goldenWal);
  fs.copyFileSync(`${active}-shm`, goldenShm);

  const userDataDir = path.join(root, 'sample');
  fs.mkdirSync(userDataDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  fs.copyFileSync(goldenDb, databasePath);
  fs.copyFileSync(goldenWal, `${databasePath}-wal`);
  fs.copyFileSync(`${active}-shm`, `${databasePath}-shm`);
  const options = {
    scenario: 'crash-recovery', goldenDb, goldenWal, goldenShm,
    walSentinel: { settingKey: 'startup_wal_probe', expectedValue: `visible-${'x'.repeat(256)}` },
    recoverySentinel: null
  };
  const sample = { databasePath, userDataDir };
  const trackedPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const timedBefore = trackedPaths.map(fileFingerprint);
  const probeRoot = path.join(root, 'disposable-wal-probe');
  const before = scenarioPrecondition(options, sample, {
    createWalProbeDir() {
      fs.mkdirSync(probeRoot);
      return probeRoot;
    }
  });
  assert.ok(before.walBytes > 32);
  assert.equal(before.walSentinel.baseValue, null);
  assert.equal(before.walSentinel.walVisibleValue, options.walSentinel.expectedValue);
  assert.deepEqual(trackedPaths.map(fileFingerprint), timedBefore,
    'precondition 不得打开或改写 timed sample 的 main/WAL/SHM');
  assert.equal(fs.existsSync(probeRoot), false, 'disposable WAL probe 必须在 launch 前删除干净');

  const appDb = new DatabaseSync(databasePath);
  appDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  appDb.close();
  writer.close();
  const after = scenarioPostcondition(options, { label: '3.1.12-portable' }, sample, { phases: [] });
  assert.equal(after.walSentinelCheckpointed, true);
  assert.equal(after.checkpointValue, options.walSentinel.expectedValue);
});

test('非稳态每个 sample 都有独立 userData 与 Documents golden 副本', () => {
  const root = tempDir('startup-isolation');
  const goldenDb = path.join(root, 'golden.sqlite');
  fs.writeFileSync(goldenDb, 'golden');
  const options = { scenario: 'migration-vacuum', goldenDb, goldenWal: '', goldenShm: '', recoverySentinel: null };
  const variant = { userDataDir: 'unused', documentsDir: 'unused', databasePath: 'unused' };
  const first = prepareSampleDatabase(variant, options, path.join(root, 'sample-1'));
  const second = prepareSampleDatabase(variant, options, path.join(root, 'sample-2'));
  assert.notEqual(first.userDataDir, second.userDataDir);
  assert.notEqual(first.documentsDir, second.documentsDir);
  assert.equal(fs.readFileSync(first.databasePath, 'utf8'), 'golden');
  assert.equal(fs.readFileSync(second.databasePath, 'utf8'), 'golden');
});

test('runner 场景与失败证据合同完整且不依赖 app auto-quit', () => {
  assert.deepEqual(REQUIRED_SCENARIOS, ['normal-clean-shutdown', 'migration-vacuum', 'crash-recovery']);
  const source = fs.readFileSync(path.join(__dirname, '../../../scripts/measure-packaged-startup.js'), 'utf8');
  assert.doesNotMatch(source, /APP_STARTUP_MEASURE_AUTO_QUIT/);
  assert.match(source, /evidenceCode/);
  assert.match(source, /walSentinelCheckpointed/);
  assert.match(source, /freshGoldenPerSample/);
});

test('crash CLI 强制 WAL setting sentinel，不能用任意文件删除冒充恢复', () => {
  const root = tempDir('startup-crash-args');
  const goldenDb = path.join(root, 'golden.sqlite');
  const goldenWal = path.join(root, 'golden.sqlite-wal-input');
  fs.writeFileSync(goldenDb, 'db');
  fs.writeFileSync(goldenWal, 'wal');
  const args = REQUIRED_VARIANTS.flatMap((label) => ['--variant', `${label}=${__filename}`]);
  args.push(
    '--golden-db', goldenDb,
    '--golden-wal', goldenWal,
    '--scenario', 'crash-recovery'
  );
  assert.throws(() => parseArgs(args), /--wal-sentinel/);
});

test('normal 场景拒绝 WAL 与 recovery 参数，避免把恢复工作计入 steady median', () => {
  const root = tempDir('startup-normal-args');
  const goldenDb = path.join(root, 'golden.sqlite');
  const goldenWal = path.join(root, 'golden.sqlite-wal-input');
  fs.writeFileSync(goldenDb, 'db');
  fs.writeFileSync(goldenWal, 'wal');
  const args = REQUIRED_VARIANTS.flatMap((label) => ['--variant', `${label}=${__filename}`]);
  args.push('--golden-db', goldenDb, '--golden-wal', goldenWal);
  assert.throws(() => parseArgs(args), /normal-clean-shutdown.*WAL|WAL.*normal-clean-shutdown/);
});

test('normal 用牺牲 clone 验 vacuum steady，post 拒绝 vacuum/recovery 工作', () => {
  const root = tempDir('startup-normal-steady');
  const databasePath = path.join(root, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const fingerprint = fileFingerprint(databasePath);
  const probeRoot = path.join(root, 'normal-probe');
  const pre = scenarioPrecondition({
    scenario: 'normal-clean-shutdown', recoverySentinel: null, goldenWal: '', goldenShm: '', walSentinel: null,
    goldenDb: databasePath
  }, { databasePath, userDataDir: root }, {
    createWalProbeDir() { fs.mkdirSync(probeRoot); return probeRoot; }
  });
  assert.equal(pre.vacuumFlagBefore, '1');
  assert.deepEqual(fileFingerprint(databasePath), fingerprint);
  assert.equal(fs.existsSync(probeRoot), false);
  assert.throws(() => scenarioPostcondition(
    { scenario: 'normal-clean-shutdown' },
    { label: '3.1.12-portable' },
    { databasePath, userDataDir: root },
    { phases: [
      { phase: 'database-vacuum', outcome: 'success' },
      { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalTasks: 1 } }
    ] }
  ), (error) => error.code === 'NORMAL_STARTUP_NOT_STEADY');
  const steadyPost = scenarioPostcondition(
    { scenario: 'normal-clean-shutdown' },
    { label: '3.1.12-portable' },
    { databasePath, userDataDir: root },
    { phases: [
      { phase: 'database-vacuum', outcome: 'skipped' },
      { phase: 'archive-outbox', outcome: 'success', counts: {
        pendingTerminalBatches: 0, pendingTerminalTasks: 0
      } },
      { phase: 'vcc-lineage-gate', outcome: 'success', counts: {
        bound: 3, failed: 0, pending: 0, released: 0
      } }
    ] }
  );
  assert.equal(steadyPost.recoveryCountsZero, true, 'bound 是稳态安全核验计数，允许非零');
});

test('normal 拒绝 schema-less golden，required system snapshot 列与 partial index 必须已存在', () => {
  const root = tempDir('startup-normal-schema-less');
  const databasePath = path.join(root, 'tool-data.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT);');
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('db_one_time_vacuum_v3_0_5_done', '1');
  db.close();
  assert.throws(() => scenarioPrecondition({
    scenario: 'normal-clean-shutdown', goldenDb: databasePath,
    goldenWal: '', goldenShm: '', recoverySentinel: null, walSentinel: null
  }, { databasePath, userDataDir: root }),
  (error) => error.code === 'NORMAL_STARTUP_SCHEMA_NOT_CURRENT');
});

test('normal 每轮检查当前 working bundle，不以 clean 原 golden 掩盖 round2 running task', () => {
  const root = tempDir('startup-normal-round2');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const timedRoot = path.join(root, 'timed');
  fs.mkdirSync(timedRoot);
  const timedDb = path.join(timedRoot, 'tool-data.sqlite');
  fs.copyFileSync(goldenDb, timedDb);
  const db = new DatabaseSync(timedDb);
  db.exec("CREATE TABLE archive_task_runs(task_run_id TEXT PRIMARY KEY, status TEXT); INSERT INTO archive_task_runs VALUES ('round2-running', 'running');");
  db.close();
  const timedBefore = fileFingerprint(timedDb);
  const probeRoot = path.join(root, 'round2-probe');
  assert.throws(() => scenarioPrecondition({
    scenario: 'normal-clean-shutdown', goldenDb,
    goldenWal: '', goldenShm: '', recoverySentinel: null, walSentinel: null
  }, { databasePath: timedDb, userDataDir: timedRoot }, {
    createCurrentBundleProbeDir() { fs.mkdirSync(probeRoot); return probeRoot; }
  }), (error) => error.code === 'NORMAL_STARTUP_PRECONDITION_NOT_STEADY'
    && error.evidence.pendingRecovery.activeTaskRuns === 1);
  assert.deepEqual(fileFingerprint(timedDb), timedBefore);
  assert.equal(fs.existsSync(probeRoot), false);
});

test('normal 对 3.1.11/3.1.12 两版本族运行 untimed disposable schema fingerprint probe', async () => {
  const root = tempDir('startup-schema-probes');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const exe311 = path.join(root, '311.exe');
  const exe312 = path.join(root, '312.exe');
  fs.writeFileSync(exe311, 'exe');
  fs.writeFileSync(exe312, 'exe');
  const variants = new Map(REQUIRED_VARIANTS.map((label) => [
    label,
    label === '3.1.11-portable' ? exe311 : label === '3.1.12-portable' ? exe312 : __filename
  ]));
  const launchFingerprints = [];
  const adapter = {
    async launch({ executable, env }) {
      const databasePath = path.join(env.APP_USER_DATA_DIR, 'tool-data.sqlite');
      launchFingerprints.push({ executable, fingerprint: schemaFingerprint(databasePath) });
      return { processCreatedAt: 0, rootExit: { code: 0, signal: null }, exitPromise: Promise.resolve({ code: 0, signal: null }) };
    },
    async refreshTree() { return [40, 41]; },
    async gracefulClose() { return { livePids: [40, 41], acceptedPids: [40] }; },
    async waitForExit() { return { exited: true, verifiedEmpty: true, rootExit: { code: 0, signal: null } }; },
    async forceCleanup() {},
    async delay() {}
  };
  const options = { scenario: 'normal-clean-shutdown', goldenDb, variants, timeoutMs: 10000 };
  const evidence = await verifyNormalSchemaSteady(options, path.join(root, 'work'), {
    adapter,
    readMetrics: () => ({
      renderer: { durations: { totalInitMs: 1 } },
      phases: [
        { phase: 'window-ready', outcome: 'success' },
        { phase: 'startup-total', outcome: 'success' }
      ]
    }),
    now: () => 1
  });
  assert.equal(evidence.length, 2);
  assert.deepEqual(launchFingerprints.map((item) => item.fingerprint), [
    schemaFingerprint(goldenDb), schemaFingerprint(goldenDb)
  ]);
  assert.equal(fs.existsSync(path.join(root, 'work', 'schema-probes')), false);
});

test('normal 任一版本族产生 DDL 都拒绝，不按 variant canonicalize golden', async () => {
  const root = tempDir('startup-schema-mutation');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const exe = path.join(root, 'app.exe');
  fs.writeFileSync(exe, 'exe');
  const variants = new Map(REQUIRED_VARIANTS.map((label) => [label, exe]));
  const adapter = {
    async launch({ env }) {
      const db = new DatabaseSync(path.join(env.APP_USER_DATA_DIR, 'tool-data.sqlite'));
      db.exec('CREATE TABLE unexpected_migration(id INTEGER PRIMARY KEY)');
      db.close();
      return { exitPromise: Promise.resolve({ code: 0, signal: null }) };
    },
    async refreshTree() { return [50]; },
    async gracefulClose() { return { livePids: [50], acceptedPids: [50] }; },
    async waitForExit() { return { exited: true, verifiedEmpty: true }; },
    async forceCleanup() {}, async delay() {}
  };
  await assert.rejects(verifyNormalSchemaSteady({
    scenario: 'normal-clean-shutdown', goldenDb, variants, timeoutMs: 10000
  }, path.join(root, 'work'), {
    adapter,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } } }),
    now: () => 1
  }), (error) => error.code === 'NORMAL_STARTUP_SCHEMA_CHANGED');
  assert.equal(schemaFingerprint(goldenDb), schemaFingerprint(goldenDb));
});

test('migration 拒绝 recovery inputs，crash 拒绝未完成 vacuum 的 base golden', () => {
  const root = tempDir('startup-scenario-isolation');
  const goldenDb = path.join(root, 'golden.sqlite');
  const goldenWal = path.join(root, 'golden.sqlite-wal-input');
  fs.writeFileSync(goldenDb, 'db');
  fs.writeFileSync(goldenWal, Buffer.alloc(64));
  const args = REQUIRED_VARIANTS.flatMap((label) => ['--variant', `${label}=${__filename}`]);
  args.push('--golden-db', goldenDb, '--golden-wal', goldenWal, '--scenario', 'migration-vacuum');
  assert.throws(() => parseArgs(args), /migration-vacuum.*WAL|WAL.*migration-vacuum/);

  const active = path.join(root, 'active.sqlite');
  const writer = new DatabaseSync(active);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT); PRAGMA wal_checkpoint(TRUNCATE);');
  writer.prepare('INSERT INTO app_settings VALUES (?, ?)').run('startup_wal_probe', 'wal-only');
  const crashDb = path.join(root, 'crash.sqlite');
  const crashWal = path.join(root, 'crash.sqlite-wal-input');
  fs.copyFileSync(active, crashDb);
  fs.copyFileSync(`${active}-wal`, crashWal);
  fs.copyFileSync(crashWal, `${crashDb}-wal`);
  assert.throws(() => scenarioPrecondition({
    scenario: 'crash-recovery', goldenDb: crashDb, goldenWal: crashWal, goldenShm: '',
    recoverySentinel: null,
    walSentinel: { settingKey: 'startup_wal_probe', expectedValue: 'wal-only' }
  }, { databasePath: crashDb, userDataDir: root }),
  (error) => error.code === 'CRASH_BASE_NOT_STEADY');
  writer.close();
});

test('normal post 用冻结 clone 拒绝本轮 pending/DDL，terminal interrupted 不算 active', () => {
  const root = tempDir('startup-post-real-state');
  const databasePath = path.join(root, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const beforeSchema = schemaFingerprint(databasePath);
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE archive_task_runs(task_run_id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO archive_task_runs VALUES ('historical', 'interrupted');
  `);
  db.close();
  const options = {
    scenario: 'normal-clean-shutdown', goldenDb: databasePath,
    goldenWal: '', goldenShm: '', recoverySentinel: null, walSentinel: null
  };
  const sample = { databasePath, userDataDir: root };
  const pre = scenarioPrecondition(options, sample);
  assert.equal(pre.pendingRecovery.activeTaskRuns, 0, 'interrupted 是 terminal audit');

  const active = new DatabaseSync(databasePath);
  active.prepare('INSERT INTO archive_task_runs VALUES (?, ?)').run('live', 'running');
  active.exec('CREATE TABLE unexpected_post_ddl(id INTEGER PRIMARY KEY)');
  active.close();
  assert.throws(() => scenarioPostcondition(options, { label: '3.1.11-portable' }, sample, {
    renderer: { durations: { totalInitMs: 1 } }
  }, {
    precondition: { ...pre, schema: { ...pre.schema, fingerprint: beforeSchema } },
    postBundleEvidence: freezeDatabaseBundle(databasePath)
  }), (error) => error.code === 'NORMAL_STARTUP_NOT_STEADY'
    && error.evidence.pendingRecovery.activeTaskRuns === 1
    && error.evidence.schemaChanged === true);
});

test('migration/crash preflight 检查实际 timed copy，launch 前 main/WAL/SHM SHA 保持相同', () => {
  const root = tempDir('startup-actual-copy');
  const goldenDb = path.join(root, 'golden.sqlite');
  createLegacySettingsDatabase(goldenDb);
  const userDataDir = path.join(root, 'actual');
  fs.mkdirSync(userDataDir);
  const actualDb = path.join(userDataDir, 'tool-data.sqlite');
  fs.copyFileSync(goldenDb, actualDb);
  const actual = new DatabaseSync(actualDb);
  actual.prepare('INSERT INTO app_settings VALUES (?, ?)')
    .run('db_one_time_vacuum_v3_0_5_done', '1');
  actual.close();
  const before = freezeDatabaseBundle(actualDb);
  assert.throws(() => scenarioPrecondition({
    scenario: 'migration-vacuum', goldenDb, goldenWal: '', goldenShm: '',
    recoverySentinel: null, walSentinel: null
  }, { databasePath: actualDb, userDataDir }),
  (error) => error.code === 'VACUUM_PRECONDITION_ALREADY_DONE');
  assert.deepEqual(freezeDatabaseBundle(actualDb), before);
});

test('cleanup ownership/receipt 无法证明时整次 run 立即中止，不继续 20 个样本', async () => {
  const root = tempDir('startup-cleanup-abort');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const artifacts = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, `artifact-${index}`);
    return [label, file];
  });
  const args = artifacts.flatMap(([label, file]) => ['--variant', `${label}=${file}`]);
  args.push('--golden-db', goldenDb, '--runs', '5', '--work-root', path.join(root, 'work'),
    '--output', path.join(root, 'report.json'), '--defender-state', 'disabled-for-measurement',
    '--storage-medium', 'local-ssd', '--cache-state', 'warm');
  let launches = 0;
  let report;
  await assert.rejects(main(args, {
    skipSchemaProbe: true,
    readArtifactFileVersion: (file, label) => label.split('-')[0],
    adapter: {
      async launch() {
        launches += 1;
        return { processCreatedAt: 0, exitPromise: new Promise(() => {}) };
      },
      async refreshTree() {
        const error = new Error('ownership missing');
        error.code = 'PROCESS_OWNERSHIP_UNESTABLISHED';
        throw error;
      },
      async forceCleanup() {
        const error = new Error('manual cleanup required');
        error.code = 'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED';
        throw error;
      },
      async delay() {}
    },
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success' },
      { phase: 'startup-total', outcome: 'success' }
    ] }),
    now: (() => { let value = 0; return () => ++value; })()
  }), (error) => {
    report = error.report;
    return error.code === 'STARTUP_MEASUREMENT_ABORTED';
  });
  assert.equal(launches, 1);
  assert.equal(report.run.status, 'aborted');
  assert.equal(report.run.requiresManualCleanup, true);
});

test('artifact 每spawn前重验，run内漂移立即非0中止且不再launch', async () => {
  const root = tempDir('startup-artifact-drift');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const artifacts = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, `artifact-${index}`);
    return [label, file];
  });
  const args = artifacts.flatMap(([label, file]) => ['--variant', `${label}=${file}`]);
  args.push('--golden-db', goldenDb, '--runs', '5', '--work-root', path.join(root, 'work'),
    '--output', path.join(root, 'report.json'));
  let launches = 0;
  await assert.rejects(main(args, {
    skipSchemaProbe: true,
    readArtifactFileVersion: (_file, label) => label.split('-')[0],
    adapter: {
      async launch() {
        launches += 1;
        if (launches === 1) fs.appendFileSync(artifacts[0][1], '-drift');
        return { processCreatedAt: 0, exitPromise: Promise.resolve({ code: 0, signal: null }) };
      },
      async refreshTree() { return [1]; },
      async gracefulClose() { return { livePids: [1], acceptedPids: [1] }; },
      async waitForExit() { return { exited: true, verifiedEmpty: true }; },
      async waitForRootExit() { return { code: 0, signal: null }; },
      async forceCleanup() {}, async delay() {}
    },
    readMetrics: () => ({
      renderer: { durations: { totalInitMs: 1 } },
      phases: [
        { phase: 'window-ready', outcome: 'success' },
        { phase: 'startup-total', outcome: 'success' },
        { phase: 'database-vacuum', outcome: 'skipped' },
        { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
        { phase: 'vcc-lineage-gate', outcome: 'success', counts: { failed: 0, pending: 0, released: 0 } }
      ]
    }),
    now: (() => { let value = 0; return () => ++value; })()
  }), (error) => error.code === 'STARTUP_MEASUREMENT_ABORTED'
    && error.report.run.abortEvidence.evidenceCode === 'ARTIFACT_IDENTITY_DRIFT');
  assert.equal(launches, 1);
});

test('artifact 在 scenario preflight 中被替换时，launch 紧前固定身份检查阻断且零启动', async () => {
  const root = tempDir('startup-artifact-preflight-drift');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const artifacts = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, `artifact-${index}`);
    return [label, file];
  });
  const args = artifacts.flatMap(([label, file]) => ['--variant', `${label}=${file}`]);
  args.push('--golden-db', goldenDb, '--runs', '5', '--work-root', path.join(root, 'work'),
    '--output', path.join(root, 'report.json'));
  let launches = 0;
  let preflightMutated = false;
  await assert.rejects(main(args, {
    skipSchemaProbe: true,
    readArtifactFileVersion: (_file, label) => label.split('-')[0],
    createCurrentBundleProbeDir() {
      if (!preflightMutated) {
        preflightMutated = true;
        fs.appendFileSync(artifacts[0][1], '-replaced-during-preflight');
      }
      return fs.mkdtempSync(path.join(root, 'preflight-'));
    },
    adapter: {
      async launch() { launches += 1; throw new Error('launch 不应到达'); },
      async delay() {}
    },
    now: (() => { let value = 0; return () => ++value; })()
  }), (error) => error.code === 'STARTUP_MEASUREMENT_ABORTED'
    && error.report.run.abortEvidence.evidenceCode === 'ARTIFACT_IDENTITY_DRIFT');
  assert.equal(preflightMutated, true);
  assert.equal(launches, 0);
});

test('runner-owned frozen golden 首轮后漂移时按创建时固定证据中止，报告不采用漂移 SHA', async () => {
  const root = tempDir('startup-frozen-golden-drift');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const fixedGoldenSha = fileFingerprint(goldenDb).sha256;
  const workRoot = path.join(root, 'work');
  const artifacts = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, `artifact-${index}`);
    return [label, file];
  });
  const args = artifacts.flatMap(([label, file]) => ['--variant', `${label}=${file}`]);
  args.push('--golden-db', goldenDb, '--runs', '5', '--work-root', workRoot,
    '--output', path.join(root, 'report.json'));
  let launches = 0;
  await assert.rejects(main(args, {
    skipSchemaProbe: true,
    readArtifactFileVersion: (_file, label) => label.split('-')[0],
    adapter: {
      async launch() {
        launches += 1;
        if (launches === 1) {
          const frozenDb = path.join(workRoot, 'runner-owned-golden', 'tool-data.sqlite');
          fs.chmodSync(frozenDb, 0o644);
          fs.appendFileSync(frozenDb, '-internal-drift');
        }
        return { processCreatedAt: 0, exitPromise: Promise.resolve({ code: 0, signal: null }) };
      },
      async refreshTree() { return [1]; },
      async gracefulClose() { return { livePids: [1], acceptedPids: [1] }; },
      async waitForExit() { return { exited: true, verifiedEmpty: true }; },
      async waitForRootExit() { return { code: 0, signal: null }; },
      async forceCleanup() {}, async delay() {}
    },
    readMetrics: () => ({
      renderer: { durations: { totalInitMs: 1 } },
      phases: [
        { phase: 'window-ready', outcome: 'success' },
        { phase: 'startup-total', outcome: 'success' },
        { phase: 'database-vacuum', outcome: 'skipped' },
        { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
        { phase: 'vcc-lineage-gate', outcome: 'success', counts: { failed: 0, pending: 0, released: 0 } }
      ]
    }),
    now: (() => { let value = 0; return () => ++value; })()
  }), (error) => error.code === 'STARTUP_MEASUREMENT_ABORTED'
    && error.report.run.abortEvidence.evidenceCode === 'RUNNER_GOLDEN_IDENTITY_DRIFT'
    && error.report.golden.sha256 === fixedGoldenSha);
  assert.equal(launches, 1);
});

test('source golden 漂移不污染runner-owned副本，并在run结束非0中止', async () => {
  const root = tempDir('startup-golden-drift');
  const goldenDb = path.join(root, 'golden.sqlite');
  createSettingsDatabase(goldenDb, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const originalGoldenHash = fileFingerprint(goldenDb).sha256;
  const artifacts = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, `artifact-${index}`);
    return [label, file];
  });
  const args = artifacts.flatMap(([label, file]) => ['--variant', `${label}=${file}`]);
  args.push('--golden-db', goldenDb, '--runs', '5', '--work-root', path.join(root, 'work'),
    '--output', path.join(root, 'report.json'));
  let launches = 0;
  await assert.rejects(main(args, {
    skipSchemaProbe: true,
    readArtifactFileVersion: (_file, label) => label.split('-')[0],
    adapter: {
      async launch() {
        launches += 1;
        if (launches === 1) fs.appendFileSync(goldenDb, '-source-drift');
        return { processCreatedAt: 0, exitPromise: Promise.resolve({ code: 0, signal: null }) };
      },
      async refreshTree() { return [1]; },
      async gracefulClose() { return { livePids: [1], acceptedPids: [1] }; },
      async waitForExit() { return { exited: true, verifiedEmpty: true }; },
      async waitForRootExit() { return { code: 0, signal: null }; },
      async forceCleanup() {}, async delay() {}
    },
    readMetrics: () => ({
      renderer: { durations: { totalInitMs: 1 } },
      phases: [
        { phase: 'window-ready', outcome: 'success' },
        { phase: 'startup-total', outcome: 'success' },
        { phase: 'database-vacuum', outcome: 'skipped' },
        { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
        { phase: 'vcc-lineage-gate', outcome: 'success', counts: { failed: 0, pending: 0, released: 0 } }
      ]
    }),
    now: (() => { let value = 0; return () => ++value; })()
  }), (error) => {
    const first = error.report.variants['3.1.11-installer'].samples[0];
    return error.code === 'STARTUP_MEASUREMENT_ABORTED'
      && error.report.run.abortEvidence.evidenceCode === 'GOLDEN_SOURCE_IDENTITY_DRIFT'
      && first.before.database.sha256 === originalGoldenHash
      && error.report.golden.runnerOwnedFrozenCopy === true;
  });
  assert.equal(launches, 20);
});

test('postcondition failure 保留已取得的 before/ready/phases/recovery/close/after 证据', async () => {
  const root = tempDir('startup-partial-evidence');
  const userDataDir = path.join(root, 'userData');
  const documentsDir = path.join(root, 'Documents');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(documentsDir);
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  let launchEnv;
  const adapter = {
    async launch({ env }) {
      launchEnv = env;
      return { processCreatedAt: 0, exitPromise: Promise.resolve({ code: 0, signal: null }) };
    },
    async refreshTree() { return [10]; },
    async gracefulClose() {
      const db = new DatabaseSync(path.join(launchEnv.APP_USER_DATA_DIR, 'tool-data.sqlite'));
      db.exec("CREATE TABLE archive_task_runs(task_run_id TEXT PRIMARY KEY, status TEXT); INSERT INTO archive_task_runs VALUES ('late', 'running');");
      db.close();
      return { livePids: [10], acceptedPids: [10] };
    },
    async waitForExit() { return { exited: true, verifiedEmpty: true }; },
    async waitForRootExit() { return { code: 0, signal: null }; },
    async forceCleanup() {}, async delay() {}
  };
  let clock = 0;
  await assert.rejects(measureSample({
    label: '3.1.12-portable', executable: __filename, variantRoot: root,
    userDataDir, documentsDir, databasePath
  }, 0, { scenario: 'normal-clean-shutdown', timeoutMs: 10000, goldenDb: databasePath }, {
    adapter, now: () => ++clock,
    readMetrics: () => ({ renderer: { durations: { totalInitMs: 1 } }, phases: [
      { phase: 'window-ready', outcome: 'success' },
      { phase: 'startup-total', outcome: 'success' },
      { phase: 'database-vacuum', outcome: 'skipped' },
      { phase: 'archive-outbox', outcome: 'success', counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } },
      { phase: 'vcc-lineage-gate', outcome: 'success', counts: { failed: 0, pending: 0, released: 0 } }
    ] })
  }), (error) => Boolean(error.code === 'NORMAL_STARTUP_NOT_STEADY'
    && error.sampleEvidence.before.database.sha256
    && error.sampleEvidence.readyEvidence.mode === 'phase-and-renderer-contract'
    && error.sampleEvidence.phases.length > 0
    && error.sampleEvidence.recoveryCounts['archive-outbox']
    && error.sampleEvidence.gracefulCloseEvidence.acceptedPids[0] === 10
    && error.sampleEvidence.after.database.sha256));
});

test('report 绑定环境与四制品身份，重复 SHA 或明显 label/version mismatch 拒绝', () => {
  const root = tempDir('startup-artifact-identity');
  const files = REQUIRED_VARIANTS.map((label, index) => {
    const file = path.join(root, `${label}.exe`);
    fs.writeFileSync(file, index < 2 ? 'duplicate' : `artifact-${index}`);
    return { label, executable: file };
  });
  assert.throws(() => validateArtifactIdentities(files, {
    readArtifactFileVersion: (_file, label) => label.split('-')[0]
  }), (error) => error.code === 'DUPLICATE_ARTIFACT_IDENTITY');
  fs.writeFileSync(files[1].executable, 'unique-legacy-portable');
  assert.throws(() => validateArtifactIdentities(files, {
    readArtifactFileVersion: (_file, label) => label === '3.1.12-portable' ? '3.1.11.9' : label.split('-')[0]
  }), (error) => error.code === 'ARTIFACT_VERSION_MISMATCH');
  assert.throws(() => validateArtifactIdentities(files, {
    readArtifactFileVersion: (_file, label) => label === '3.1.11-portable' ? '3.1.110' : label.split('-')[0]
  }), (error) => error.code === 'ARTIFACT_VERSION_MISMATCH');
  const environment = collectEnvironmentEvidence({
    defenderState: 'unknown', storageMedium: 'unknown', cacheState: 'unknown'
  });
  assert.equal(environment.status, 'not-evaluated');
  assert.ok(environment.os.release);
  assert.ok(environment.cpu.model);
  assert.ok(environment.memory.totalBytes > 0);
});

test('migration/crash post 对真实 pending、额外 DDL 与有效 WAL fail closed', () => {
  const root = tempDir('startup-nonnormal-post');
  const databasePath = path.join(root, 'tool-data.sqlite');
  createSettingsDatabase(databasePath, [['db_one_time_vacuum_v3_0_5_done', '1']]);
  const beforeSchema = schemaFingerprint(databasePath);
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE archive_task_runs(task_run_id TEXT PRIMARY KEY,status TEXT); INSERT INTO archive_task_runs VALUES ('late','running'); CREATE TABLE unexpected_ddl(id INTEGER);");
  db.close();
  assert.throws(() => scenarioPostcondition(
    { scenario: 'migration-vacuum' }, { label: '3.1.12-portable' },
    { databasePath, userDataDir: root },
    { phases: [{ phase: 'database-vacuum', outcome: 'success' }] },
    { precondition: { schema: { fingerprint: beforeSchema } }, postBundleEvidence: freezeDatabaseBundle(databasePath) }
  ), (error) => error.code === 'VACUUM_POSTCONDITION_NOT_EXECUTED'
    && error.evidence.pendingRecovery.activeTaskRuns === 1
    && error.evidence.schemaChanged === true);

  const walPath = `${databasePath}-wal`;
  const wal = Buffer.alloc(64);
  wal.writeUInt32BE(0x377f0682, 0);
  fs.writeFileSync(walPath, wal);
  assert.throws(() => scenarioPostcondition(
    { scenario: 'crash-recovery', walSentinel: { settingKey: 'missing', expectedValue: 'x' } },
    { label: '3.1.12-portable' }, { databasePath, userDataDir: root }, { phases: [] },
    { precondition: { schema: { fingerprint: schemaFingerprint(databasePath) } }, postBundleEvidence: freezeDatabaseBundle(databasePath) }
  ), (error) => error.code === 'CRASH_POSTCONDITION_DIRTY');
});
