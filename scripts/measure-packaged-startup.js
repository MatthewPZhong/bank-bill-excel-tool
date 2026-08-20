'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  createProcessAdapter
} = require('./startup-process-adapter');

const REQUIRED_VARIANTS = Object.freeze([
  '3.1.11-installer',
  '3.1.11-portable',
  '3.1.12-installer',
  '3.1.12-portable'
]);
const REQUIRED_SCENARIOS = Object.freeze([
  'normal-clean-shutdown',
  'migration-vacuum',
  'crash-recovery'
]);

function codedError(code, message, evidence = {}) {
  const error = new Error(message);
  error.code = code;
  error.evidence = evidence;
  return error;
}

function parseSentinel(value) {
  const separator = String(value).indexOf('=');
  if (separator < 1) throw new TypeError('--recovery-sentinel 必须为 sourcePath=relativeUserDataPath');
  const sourcePath = path.resolve(String(value).slice(0, separator));
  const relativePath = String(value).slice(separator + 1).replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new TypeError('--recovery-sentinel 目标必须是 userData 内安全相对路径');
  }
  return { sourcePath, relativePath };
}

function parseWalSentinel(value) {
  const separator = String(value).indexOf('=');
  if (separator < 1) throw new TypeError('--wal-sentinel 必须为 settingKey=expectedValue');
  const settingKey = String(value).slice(0, separator);
  const expectedValue = String(value).slice(separator + 1);
  if (!expectedValue) throw new TypeError('--wal-sentinel expectedValue 不得为空');
  return { settingKey, expectedValue };
}

function parseArgs(argv) {
  const options = {
    variants: new Map(), runs: 5, output: '', goldenDb: '', goldenWal: '', goldenShm: '',
    workRoot: '', scenario: 'normal-clean-shutdown', timeoutMs: 300000,
    recoverySentinel: null, walSentinel: null,
    defenderState: 'unknown', storageMedium: 'unknown', cacheState: 'unknown'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--variant' && argv[index + 1]) {
      const pair = argv[++index];
      const separator = pair.indexOf('=');
      if (separator < 1) throw new TypeError('--variant 必须为 label=exePath');
      options.variants.set(pair.slice(0, separator), path.resolve(pair.slice(separator + 1)));
    } else if (token === '--golden-db' && argv[index + 1]) options.goldenDb = path.resolve(argv[++index]);
    else if (token === '--golden-wal' && argv[index + 1]) options.goldenWal = path.resolve(argv[++index]);
    else if (token === '--golden-shm' && argv[index + 1]) options.goldenShm = path.resolve(argv[++index]);
    else if (token === '--scenario' && argv[index + 1]) options.scenario = argv[++index];
    else if (token === '--runs' && argv[index + 1]) options.runs = Number(argv[++index]);
    else if (token === '--timeout-ms' && argv[index + 1]) options.timeoutMs = Number(argv[++index]);
    else if (token === '--recovery-sentinel' && argv[index + 1]) options.recoverySentinel = parseSentinel(argv[++index]);
    else if (token === '--wal-sentinel' && argv[index + 1]) options.walSentinel = parseWalSentinel(argv[++index]);
    else if (token === '--defender-state' && argv[index + 1]) options.defenderState = String(argv[++index]);
    else if (token === '--storage-medium' && argv[index + 1]) options.storageMedium = String(argv[++index]);
    else if (token === '--cache-state' && argv[index + 1]) options.cacheState = String(argv[++index]);
    else if (token === '--output' && argv[index + 1]) options.output = path.resolve(argv[++index]);
    else if (token === '--work-root' && argv[index + 1]) options.workRoot = path.resolve(argv[++index]);
    else throw new TypeError(`未知参数：${token}`);
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 5) throw new TypeError('packaged startup 每个变体至少运行 5 次');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10000) throw new TypeError('--timeout-ms 必须是不小于 10000 的整数');
  if (!options.goldenDb || !fs.statSync(options.goldenDb).isFile()) throw new TypeError('必须提供可读的 --golden-db');
  if (!REQUIRED_SCENARIOS.includes(options.scenario)) throw new TypeError(`--scenario 必须为 ${REQUIRED_SCENARIOS.join(' / ')}`);
  for (const [name, value] of [['golden-wal', options.goldenWal], ['golden-shm', options.goldenShm]]) {
    if (value && !fs.statSync(value).isFile()) throw new TypeError(`必须提供可读的 --${name}`);
  }
  if (options.scenario === 'crash-recovery') {
    if (!options.goldenWal) throw new TypeError('crash-recovery 场景必须提供独立的 --golden-wal');
    if (!options.walSentinel) throw new TypeError('crash-recovery 场景必须提供 --wal-sentinel');
    if (options.recoverySentinel && !fs.statSync(options.recoverySentinel.sourcePath).isFile()) {
      throw new TypeError('--recovery-sentinel sourcePath 必须可读');
    }
  } else if ((options.scenario === 'normal-clean-shutdown' || options.scenario === 'migration-vacuum')
      && (options.goldenWal || options.goldenShm || options.recoverySentinel || options.walSentinel)) {
    throw new TypeError(`${options.scenario} 不得提供 WAL/SHM/recovery sentinel 参数`);
  }
  for (const label of REQUIRED_VARIANTS) {
    const executable = options.variants.get(label);
    if (!executable || !fs.statSync(executable).isFile()) throw new TypeError(`缺少 packaged 变体：${label}`);
  }
  if (options.variants.size !== REQUIRED_VARIANTS.length) throw new TypeError('只能提供 TechDoc 约定的四个 packaged 变体');
  return options;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(handle); }
  return hash.digest('hex');
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function summarize(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const round = (value) => Number(value.toFixed(3));
  return { status: 'success', average: round(values.reduce((sum, value) => sum + value, 0) / values.length), median: round(median), min: round(sorted[0]), max: round(sorted.at(-1)) };
}

function rotatedOrder(round) {
  const offset = round % REQUIRED_VARIANTS.length;
  return REQUIRED_VARIANTS.slice(offset).concat(REQUIRED_VARIANTS.slice(0, offset));
}

function copyGoldenBundle(options, databasePath, copyFlag = 0) {
  fs.copyFileSync(options.goldenDb, databasePath, copyFlag);
  if (options.goldenWal) fs.copyFileSync(options.goldenWal, `${databasePath}-wal`, copyFlag);
  if (options.goldenShm) fs.copyFileSync(options.goldenShm, `${databasePath}-shm`, copyFlag);
  if (options.recoverySentinel) {
    const target = path.join(path.dirname(databasePath), ...options.recoverySentinel.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(options.recoverySentinel.sourcePath, target, copyFlag);
  }
}

function prepareVariant(options, label, rootDir, goldenSha256) {
  const variantRoot = path.join(rootDir, label);
  const userDataDir = path.join(variantRoot, 'userData');
  const documentsDir = path.join(variantRoot, 'Documents');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(documentsDir, { recursive: true });
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  copyGoldenBundle(options, databasePath, fs.constants.COPYFILE_EXCL);
  const initialSha256 = sha256(databasePath);
  if (initialSha256 !== goldenSha256) throw codedError('GOLDEN_DB_COPY_MISMATCH', `${label} 初始数据库 SHA-256 不一致`);
  const initialWalSha256 = options.goldenWal ? sha256(`${databasePath}-wal`) : null;
  const initialShmSha256 = options.goldenShm ? sha256(`${databasePath}-shm`) : null;
  if (initialWalSha256 && initialWalSha256 !== sha256(options.goldenWal)) throw codedError('GOLDEN_WAL_COPY_MISMATCH', `${label} 初始 WAL SHA-256 不一致`);
  if (initialShmSha256 && initialShmSha256 !== sha256(options.goldenShm)) throw codedError('GOLDEN_SHM_COPY_MISMATCH', `${label} 初始 SHM SHA-256 不一致`);
  return { label, executable: options.variants.get(label), variantRoot, userDataDir, documentsDir, databasePath, initialSha256, initialWalSha256, initialShmSha256, samples: [] };
}

function prepareSampleDatabase(variant, options, sampleRoot) {
  if (options.scenario === 'normal-clean-shutdown') return { userDataDir: variant.userDataDir, documentsDir: variant.documentsDir, databasePath: variant.databasePath };
  const userDataDir = path.join(sampleRoot, 'userData');
  const documentsDir = path.join(sampleRoot, 'Documents');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(documentsDir, { recursive: true });
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  copyGoldenBundle(options, databasePath, fs.constants.COPYFILE_EXCL);
  return { userDataDir, documentsDir, databasePath };
}

function readArtifactFileVersion(executablePath) {
  if (process.platform !== 'win32') return 'unknown';
  const escaped = String(executablePath).replace(/'/g, "''");
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  return output || 'unknown';
}

function validateArtifactIdentities(variants, dependencies = {}) {
  const versionReader = dependencies.readArtifactFileVersion || readArtifactFileVersion;
  const identities = variants.map((variant) => {
    const executable = variant.executable;
    const fileVersion = String(versionReader(executable, variant.label) || 'unknown').trim();
    const expectedVersion = variant.label.split('-')[0];
    const parsedVersion = /^(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(fileVersion);
    const expectedParts = expectedVersion.split('.').map(Number);
    const versionMatches = fileVersion === 'unknown' || (parsedVersion
      && Number(parsedVersion[1]) === expectedParts[0]
      && Number(parsedVersion[2]) === expectedParts[1]
      && Number(parsedVersion[3]) === expectedParts[2]);
    if (!versionMatches) {
      throw codedError('ARTIFACT_VERSION_MISMATCH', `${variant.label} fileVersion 与 label 不匹配`, {
        label: variant.label, expectedVersion, fileVersion
      });
    }
    return {
      label: variant.label,
      sha256: sha256(executable),
      sizeBytes: fileSize(executable),
      fileVersion,
      pathRecorded: false
    };
  });
  const bySha = new Map();
  for (const identity of identities) {
    const previous = bySha.get(identity.sha256);
    if (previous) {
      throw codedError('DUPLICATE_ARTIFACT_IDENTITY', '四个 packaged label 必须绑定不同制品 SHA-256', {
        labels: [previous, identity.label], sha256: identity.sha256
      });
    }
    bySha.set(identity.sha256, identity.label);
  }
  return identities;
}

function assertArtifactIdentity(variant, dependencies = {}) {
  const current = validateArtifactIdentities([variant], dependencies)[0];
  const expected = variant.artifactIdentity;
  if (!expected || current.sha256 !== expected.sha256
      || current.sizeBytes !== expected.sizeBytes
      || current.fileVersion !== expected.fileVersion) {
    const error = codedError('ARTIFACT_IDENTITY_DRIFT', `${variant.label} 制品在测量 run 内发生漂移`, {
      label: variant.label, expected: expected || null, current
    });
    error.abortRun = true;
    throw error;
  }
  return current;
}

function freezeGoldenInputs(options, rootDir) {
  const sourceEvidence = goldenBundleEvidence(options);
  const frozenDir = path.join(rootDir, 'runner-owned-golden');
  fs.mkdirSync(frozenDir, { recursive: true });
  const frozenDb = path.join(frozenDir, 'tool-data.sqlite');
  fs.copyFileSync(options.goldenDb, frozenDb, fs.constants.COPYFILE_EXCL);
  const frozenOptions = { ...options, goldenDb: frozenDb, goldenWal: '', goldenShm: '' };
  if (options.goldenWal) {
    frozenOptions.goldenWal = path.join(frozenDir, 'tool-data.sqlite-wal-input');
    fs.copyFileSync(options.goldenWal, frozenOptions.goldenWal, fs.constants.COPYFILE_EXCL);
  }
  if (options.goldenShm) {
    frozenOptions.goldenShm = path.join(frozenDir, 'tool-data.sqlite-shm-input');
    fs.copyFileSync(options.goldenShm, frozenOptions.goldenShm, fs.constants.COPYFILE_EXCL);
  }
  if (options.recoverySentinel) {
    const sentinelSource = path.join(frozenDir, 'recovery-sentinel-input');
    fs.copyFileSync(options.recoverySentinel.sourcePath, sentinelSource, fs.constants.COPYFILE_EXCL);
    frozenOptions.recoverySentinel = { ...options.recoverySentinel, sourcePath: sentinelSource };
  }
  const frozenEvidence = goldenBundleEvidence(frozenOptions);
  if (!databaseBundleIdentityEqual(sourceEvidence, frozenEvidence)) {
    throw codedError('RUNNER_GOLDEN_FREEZE_MISMATCH', 'runner-owned golden 与 source main/WAL/SHM 不一致', {
      sourceEvidence, frozenEvidence
    });
  }
  for (const frozenPath of [
    frozenOptions.goldenDb,
    frozenOptions.goldenWal,
    frozenOptions.goldenShm,
    frozenOptions.recoverySentinel && frozenOptions.recoverySentinel.sourcePath
  ].filter(Boolean)) fs.chmodSync(frozenPath, 0o444);
  frozenOptions.frozenGoldenEvidence = frozenEvidence;
  return { frozenOptions, sourceEvidence, frozenEvidence };
}

function assertFrozenGoldenIdentity(options) {
  const expected = options && options.frozenGoldenEvidence;
  if (!expected) return null;
  const current = goldenBundleEvidence(options);
  if (!databaseBundleIdentityEqual(expected, current)) {
    const error = codedError(
      'RUNNER_GOLDEN_IDENTITY_DRIFT',
      'runner-owned frozen golden main/WAL/SHM 与 run 起点固定证据不一致',
      { expected, current }
    );
    error.abortRun = true;
    throw error;
  }
  return current;
}

function collectEnvironmentEvidence(options = {}) {
  const cpus = os.cpus();
  const explicit = {
    defenderState: options.defenderState || 'unknown',
    storageMedium: options.storageMedium || 'unknown',
    cacheState: options.cacheState || 'unknown'
  };
  const complete = Object.values(explicit).every((value) => value !== 'unknown');
  return {
    status: complete ? 'recorded' : 'not-evaluated',
    missing: Object.entries(explicit).filter(([, value]) => value === 'unknown').map(([name]) => name),
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0] && cpus[0].model || 'unknown', logicalCores: cpus.length },
    memory: { totalBytes: os.totalmem() },
    runner: { node: process.version },
    ...explicit
  };
}

function readMetricsFile(metricsPath) {
  try { return JSON.parse(fs.readFileSync(metricsPath, 'utf8')); } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return null;
    throw error;
  }
}

function fullReadyEvidence(label, metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const rendererMs = metrics.renderer && metrics.renderer.durations
    && metrics.renderer.durations.totalInitMs;
  if (!Number.isFinite(rendererMs)) return null;
  if (label.startsWith('3.1.11-')) {
    return { mode: 'legacy-renderer-complete', rendererInitMs: rendererMs };
  }
  const phases = Array.isArray(metrics.phases) ? metrics.phases : [];
  const windowReady = phases.find((phase) => phase.phase === 'window-ready' && phase.outcome === 'success');
  const startupTotal = phases.find((phase) => phase.phase === 'startup-total' && phase.outcome === 'success');
  return windowReady && startupTotal ? {
    mode: 'phase-and-renderer-contract',
    rendererInitMs: rendererMs,
    windowReadyMs: windowReady.durationMs,
    startupTotalMs: startupTotal.durationMs
  } : null;
}

function incompleteReadyEvidence(label, metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    return {
      status: 'incomplete',
      mode: label.startsWith('3.1.11-') ? 'legacy-renderer-contract' : 'phase-and-renderer-contract',
      observedMetrics: false,
      missing: ['metrics']
    };
  }
  const rendererMs = metrics.renderer && metrics.renderer.durations
    && metrics.renderer.durations.totalInitMs;
  const missing = [];
  if (!Number.isFinite(rendererMs)) missing.push('renderer.durations.totalInitMs');
  const evidence = {
    status: 'incomplete',
    mode: label.startsWith('3.1.11-') ? 'legacy-renderer-contract' : 'phase-and-renderer-contract',
    observedMetrics: true,
    missing
  };
  if (!label.startsWith('3.1.11-')) {
    const phases = Array.isArray(metrics.phases) ? metrics.phases : [];
    const windowReady = phases.some((phase) => phase.phase === 'window-ready' && phase.outcome === 'success');
    const startupTotal = phases.some((phase) => phase.phase === 'startup-total' && phase.outcome === 'success');
    if (!windowReady) missing.push('phases.window-ready.success');
    if (!startupTotal) missing.push('phases.startup-total.success');
  }
  return evidence;
}

function validateWalPrecondition(walPath) {
  const bytes = fs.readFileSync(walPath);
  if (bytes.length <= 32) throw codedError('CRASH_WAL_PRECONDITION_EMPTY', 'crash golden WAL 为空或只有 header', { walBytes: bytes.length });
  const magic = bytes.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) throw codedError('CRASH_WAL_PRECONDITION_INVALID', 'crash golden WAL header 非法', { walBytes: bytes.length });
  return { walBytes: bytes.length, walMagic: magic.toString(16) };
}

function readVacuumFlag(databasePath) {
  return readSettingValue(databasePath, 'db_one_time_vacuum_v3_0_5_done');
}

function readSettingValue(databasePath, settingKey) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get();
    if (!table) return null;
    const row = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(settingKey);
    return row && row.setting_value || null;
  } finally { db.close(); }
}

function readSchemaState(databasePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schemaRows = db.prepare(`
      SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
      FROM sqlite_schema
      ORDER BY type, name, tbl_name, sql
    `).all();
    const systemColumns = db.prepare('PRAGMA table_info(vcc_fin_op_system_snapshots)').all();
    const importSourceIndex = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'index' AND name = 'idx_vcc_fin_op_system_snapshots_import_source'
    `).get();
    const fingerprint = crypto.createHash('sha256')
      .update(JSON.stringify(schemaRows)).digest('hex');
    const normalizedSystemColumns = systemColumns.map((column) => ({
      cid: Number(column.cid),
      name: String(column.name || ''),
      type: String(column.type || '').toUpperCase(),
      notNull: Number(column.notnull),
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKey: Number(column.pk)
    }));
    const normalizeSchemaSql = (sql) => String(sql || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1')
      .toLowerCase();
    const normalizedImportSourceIndexSql = normalizeSchemaSql(importSourceIndex && importSourceIndex.sql);
    const expectedImportSourceIndexSql = normalizeSchemaSql(`
      CREATE INDEX idx_vcc_fin_op_system_snapshots_import_source
      ON vcc_fin_op_system_snapshots(import_source_id, id)
      WHERE import_source_id IS NOT NULL
    `);
    const importSourceColumn = normalizedSystemColumns.find((column) => column.name === 'import_source_id');
    const hasImportSourceColumn = Boolean(importSourceColumn
      && importSourceColumn.type === 'INTEGER'
      && importSourceColumn.notNull === 0
      && importSourceColumn.defaultValue === null
      && importSourceColumn.primaryKey === 0);
    const hasImportSourcePartialIndex = normalizedImportSourceIndexSql === expectedImportSourceIndexSql;
    return {
      fingerprint,
      objects: schemaRows.map((row) => ({
        type: row.type, name: row.name, tableName: row.tableName, sql: row.sql
      })),
      current: hasImportSourceColumn && hasImportSourcePartialIndex,
      hasSystemSnapshotTable: systemColumns.length > 0,
      systemSnapshotColumns: normalizedSystemColumns,
      importSourceIndexSql: normalizedImportSourceIndexSql,
      expectedImportSourceIndexSql,
      hasImportSourceColumn,
      hasImportSourcePartialIndex
    };
  } finally { db.close(); }
}

function diffSchemaObjects(before, after) {
  const keyOf = (item) => `${item.type}\u0000${item.name}\u0000${item.tableName}`;
  const beforeMap = new Map((before.objects || []).map((item) => [keyOf(item), item]));
  const afterMap = new Map((after.objects || []).map((item) => [keyOf(item), item]));
  return {
    added: [...afterMap].filter(([key]) => !beforeMap.has(key)).map(([, item]) => item),
    removed: [...beforeMap].filter(([key]) => !afterMap.has(key)).map(([, item]) => item),
    changed: [...afterMap].filter(([key, item]) => (
      beforeMap.has(key) && beforeMap.get(key).sql !== item.sql
    )).map(([, item]) => item)
  };
}

function schemaFingerprint(databasePath) {
  return readSchemaState(databasePath).fingerprint;
}

function withGoldenDatabaseProbe(options, dependencies, inspect) {
  const createProbeDir = dependencies.createDatabaseProbeDir
    || dependencies.createWalProbeDir
    || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'startup-db-probe-')));
  const removeProbeDir = dependencies.removeDatabaseProbeDir
    || ((probeDir) => fs.rmSync(probeDir, { recursive: true, force: true }));
  const probeDir = createProbeDir();
  const databasePath = path.join(probeDir, 'tool-data.sqlite');
  try {
    copyGoldenBundle({ ...options, recoverySentinel: null }, databasePath, fs.constants.COPYFILE_EXCL);
    return inspect({ databasePath, userDataDir: probeDir });
  } finally {
    removeProbeDir(probeDir);
  }
}

function withCurrentBundleProbe(sampleDatabase, dependencies, inspect, options = {}) {
  const createProbeDir = dependencies.createCurrentBundleProbeDir
    || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'startup-current-probe-')));
  const removeProbeDir = dependencies.removeCurrentBundleProbeDir
    || ((probeDir) => fs.rmSync(probeDir, { recursive: true, force: true }));
  const probeDir = createProbeDir();
  const databasePath = path.join(probeDir, 'tool-data.sqlite');
  try {
    fs.copyFileSync(sampleDatabase.databasePath, databasePath, fs.constants.COPYFILE_EXCL);
    for (const suffix of options.mainOnly ? [] : ['-wal', '-shm']) {
      const sourcePath = `${sampleDatabase.databasePath}${suffix}`;
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, `${databasePath}${suffix}`, fs.constants.COPYFILE_EXCL);
      }
    }
    return inspect({ ...sampleDatabase, databasePath });
  } finally {
    removeProbeDir(probeDir);
  }
}

function withPostconditionDatabaseProbe(sampleDatabase, dependencies, inspect) {
  const createProbeDir = dependencies.createPostconditionProbeDir
    || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'startup-post-probe-')));
  const removeProbeDir = dependencies.removePostconditionProbeDir
    || ((probeDir) => fs.rmSync(probeDir, { recursive: true, force: true }));
  const probeDir = createProbeDir();
  const databasePath = path.join(probeDir, 'tool-data.sqlite');
  try {
    // 进程树已退出后只复制 main file；所有 SQL 后验在 disposable main-only
    // clone 上执行，既证明 checkpoint，又绝不让 SQLite 创建 timed -shm。
    fs.copyFileSync(sampleDatabase.databasePath, databasePath, fs.constants.COPYFILE_EXCL);
    return inspect({ ...sampleDatabase, databasePath, timedDatabasePath: sampleDatabase.databasePath });
  } finally {
    removeProbeDir(probeDir);
  }
}

function readPendingRecoveryCounts(databasePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const countWhere = (table, where = '1=1') => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      return exists ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count) : 0;
    };
    return {
      activeTaskRuns: countWhere('archive_task_runs', "status IN ('prepared','running')"),
      activeBatches: countWhere('archive_batches', "task_status IN ('reserved','running')"),
      pendingArtifacts: countWhere('archive_artifacts', "status = 'pending'"),
      flowBindIntents: countWhere('archive_flow_bind_intents') + countWhere('archive_task_flow_bind_intents')
    };
  } finally { db.close(); }
}

function scenarioPrecondition(options, sampleDatabase, dependencies = {}) {
  if (options.scenario === 'migration-vacuum') {
    if (options.goldenWal || options.goldenShm || options.recoverySentinel || options.walSentinel) {
      throw codedError('MIGRATION_RECOVERY_ARGUMENT', 'migration-vacuum 不得携带恢复输入');
    }
    const base = withCurrentBundleProbe(sampleDatabase, dependencies, (probe) => ({
      flag: readVacuumFlag(probe.databasePath),
      pendingRecovery: readPendingRecoveryCounts(probe.databasePath),
      schema: readSchemaState(probe.databasePath)
    }));
    const expectedLegacyShape = base.schema.hasSystemSnapshotTable
      && !base.schema.hasImportSourceColumn
      && !base.schema.hasImportSourcePartialIndex;
    if (!expectedLegacyShape || Object.values(base.pendingRecovery).some((count) => count !== 0)) {
      throw codedError('MIGRATION_BASE_NOT_ISOLATED', 'migration-vacuum golden 不是约定的 3.1.11 schema 或含 recovery 工作', base);
    }
    const flag = base.flag;
    if (flag === '1') throw codedError('VACUUM_PRECONDITION_ALREADY_DONE', 'golden DB 已完成一次性 VACUUM');
    return { vacuumFlagBefore: flag, pendingRecovery: base.pendingRecovery, schema: base.schema };
  }
  if (options.scenario === 'crash-recovery') {
    const sentinelPath = options.recoverySentinel
      ? path.join(sampleDatabase.userDataDir, ...options.recoverySentinel.relativePath.split('/'))
      : null;
    const timedWalPath = `${sampleDatabase.databasePath}-wal`;
    const walEvidence = validateWalPrecondition(timedWalPath);
    const baseSteady = withCurrentBundleProbe(sampleDatabase, dependencies,
      (probe) => ({
        baseValue: readSettingValue(probe.databasePath, options.walSentinel.settingKey),
        vacuumFlag: readVacuumFlag(probe.databasePath),
        pendingRecovery: readPendingRecoveryCounts(probe.databasePath),
        schema: readSchemaState(probe.databasePath)
      }), { mainOnly: true });
    if (baseSteady.vacuumFlag !== '1' || !baseSteady.schema.current
        || Object.values(baseSteady.pendingRecovery).some((count) => count !== 0)) {
      throw codedError('CRASH_BASE_NOT_STEADY', 'crash base golden 含 migration/非目标 recovery 工作', baseSteady);
    }
    const baseValue = baseSteady.baseValue;
    const walVisibleValue = withCurrentBundleProbe(sampleDatabase, dependencies,
      (probe) => readSettingValue(probe.databasePath, options.walSentinel.settingKey));
    if (baseValue === options.walSentinel.expectedValue) {
      throw codedError('CRASH_WAL_SENTINEL_ALREADY_IN_BASE', 'WAL sentinel 已存在于主库，不能证明 WAL 恢复');
    }
    if (walVisibleValue !== options.walSentinel.expectedValue) {
      throw codedError('CRASH_WAL_SENTINEL_NOT_VISIBLE', 'golden WAL 未携带可查询 sentinel');
    }
    const journalSentinelPresent = options.recoverySentinel
      ? fs.existsSync(sentinelPath)
      : null;
    if (options.recoverySentinel && !journalSentinelPresent) {
      throw codedError('RECOVERY_SENTINEL_PRECONDITION_MISSING', '恢复 journal sentinel 未复制到独立 userData');
    }
    return {
      ...walEvidence,
      walSentinel: { baseValue, walVisibleValue },
      journalSentinelPresent,
      pendingRecovery: baseSteady.pendingRecovery,
      schema: baseSteady.schema
    };
  }
  if (options.scenario === 'normal-clean-shutdown') {
    if (options.goldenWal || options.goldenShm || options.recoverySentinel || options.walSentinel) {
      throw codedError('NORMAL_STARTUP_RECOVERY_ARGUMENT', 'normal 场景不得携带恢复输入');
    }
    const walBytes = fileSize(`${sampleDatabase.databasePath}-wal`);
    if (walBytes > 32) {
      throw codedError('NORMAL_STARTUP_WAL_PENDING', 'normal 场景 timed DB 含有效 WAL frames', { walBytes });
    }
    const steady = withCurrentBundleProbe(sampleDatabase, dependencies, (probe) => ({
      vacuumFlagBefore: readVacuumFlag(probe.databasePath),
      pendingRecovery: readPendingRecoveryCounts(probe.databasePath),
      schema: readSchemaState(probe.databasePath)
    }));
    if (!steady.schema.current) {
      throw codedError('NORMAL_STARTUP_SCHEMA_NOT_CURRENT', 'normal golden 缺少 v3.1.12 current schema', steady.schema);
    }
    if (steady.vacuumFlagBefore !== '1'
        || Object.values(steady.pendingRecovery).some((count) => count !== 0)) {
      throw codedError('NORMAL_STARTUP_PRECONDITION_NOT_STEADY', 'normal golden 含待执行 migration/recovery', steady);
    }
    return { ...steady, walBytesBefore: walBytes };
  }
  return {};
}

function scenarioPostconditionOnProbe(options, variant, sampleDatabase, metrics, dependencies) {
  if (options.scenario === 'normal-clean-shutdown') {
    const vacuumFlagAfter = readVacuumFlag(sampleDatabase.databasePath);
    const pendingRecovery = readPendingRecoveryCounts(sampleDatabase.databasePath);
    const schema = readSchemaState(sampleDatabase.databasePath);
    const beforeSchema = dependencies.precondition && dependencies.precondition.schema;
    const schemaChanged = Boolean(beforeSchema && schema.fingerprint !== beforeSchema.fingerprint);
    const postBundle = dependencies.postBundleEvidence || {};
    const validWalPending = Boolean(postBundle.wal && postBundle.wal.validFrames);
    const realStateDirty = Object.values(pendingRecovery).some((count) => count !== 0)
      || schemaChanged || validWalPending;
    const phases = Array.isArray(metrics.phases) ? metrics.phases : [];
    if (variant.label.startsWith('3.1.11-')) {
      if (vacuumFlagAfter !== '1' || realStateDirty) {
        throw codedError('NORMAL_STARTUP_NOT_STEADY', 'legacy normal 启动后真实状态不再 steady', {
          vacuumFlagAfter, pendingRecovery, schemaChanged, validWalPending,
          schemaBefore: beforeSchema && beforeSchema.fingerprint,
          schemaAfter: schema.fingerprint
        });
      }
      return { vacuumFlagAfter, legacySteady: true, pendingRecovery, schema, schemaChanged, validWalPending };
    }
    const vacuum = phases.find((item) => item.phase === 'database-vacuum');
    const archiveOutbox = phases.find((item) => item.phase === 'archive-outbox');
    const vccGate = phases.find((item) => item.phase === 'vcc-lineage-gate');
    const nonzeroRecoveryCounts = [
      ['archive-outbox', 'pendingTerminalBatches', archiveOutbox],
      ['archive-outbox', 'pendingTerminalTasks', archiveOutbox],
      ['vcc-lineage-gate', 'failed', vccGate],
      ['vcc-lineage-gate', 'pending', vccGate],
      ['vcc-lineage-gate', 'released', vccGate]
    ].flatMap(([phase, name, record]) => Number(record && record.counts && record.counts[name]) !== 0
      ? [{ phase, name, count: Number(record && record.counts && record.counts[name]) }]
      : []);
    if (vacuumFlagAfter !== '1' || realStateDirty || !vacuum || vacuum.outcome !== 'skipped'
        || !archiveOutbox || archiveOutbox.outcome !== 'success'
        || !vccGate || vccGate.outcome !== 'success'
        || nonzeroRecoveryCounts.length > 0) {
      throw codedError('NORMAL_STARTUP_NOT_STEADY', 'normal 启动执行了 migration/recovery 工作', {
        vacuumFlagAfter,
        vacuumOutcome: vacuum && vacuum.outcome || 'missing',
        nonzeroRecoveryCounts,
        pendingRecovery,
        schemaChanged,
        validWalPending,
        schemaBefore: beforeSchema && beforeSchema.fingerprint,
        schemaAfter: schema.fingerprint
      });
    }
    return {
      vacuumFlagAfter,
      vacuumOutcome: 'skipped',
      recoveryCountsZero: true,
      pendingRecovery,
      schema,
      schemaChanged,
      validWalPending
    };
  }
  if (options.scenario === 'migration-vacuum') {
    const flag = readVacuumFlag(sampleDatabase.databasePath);
    const pendingRecovery = readPendingRecoveryCounts(sampleDatabase.databasePath);
    const schema = readSchemaState(sampleDatabase.databasePath);
    const beforeSchema = dependencies.precondition && dependencies.precondition.schema;
    const schemaChanged = Boolean(beforeSchema && schema.fingerprint !== beforeSchema.fingerprint);
    const schemaDelta = beforeSchema ? diffSchemaObjects(beforeSchema, schema)
      : { added: [], removed: [], changed: [] };
    const legacy = variant.label.startsWith('3.1.11-');
    const beforeColumns = beforeSchema && beforeSchema.systemSnapshotColumns || [];
    const afterColumns = schema.systemSnapshotColumns || [];
    const expectedAddedColumn = {
      cid: beforeColumns.length,
      name: 'import_source_id',
      type: 'INTEGER',
      notNull: 0,
      defaultValue: null,
      primaryKey: 0
    };
    const columnDeltaValid = afterColumns.length === beforeColumns.length + 1
      && JSON.stringify(afterColumns.slice(0, beforeColumns.length)) === JSON.stringify(beforeColumns)
      && JSON.stringify(afterColumns.at(-1)) === JSON.stringify(expectedAddedColumn);
    const indexDefinitionValid = schema.importSourceIndexSql === schema.expectedImportSourceIndexSql;
    const allowed312Delta = schemaDelta.removed.length === 0
      && schemaDelta.added.length === 1
      && schemaDelta.added[0].type === 'index'
      && schemaDelta.added[0].name === 'idx_vcc_fin_op_system_snapshots_import_source'
      && schemaDelta.changed.length === 1
      && schemaDelta.changed[0].type === 'table'
      && schemaDelta.changed[0].name === 'vcc_fin_op_system_snapshots'
      && columnDeltaValid
      && indexDefinitionValid;
    const schemaValid = legacy
      ? Boolean(beforeSchema && !schemaChanged && !schema.current)
      : Boolean(beforeSchema && schema.current && allowed312Delta);
    const phases = Array.isArray(metrics.phases) ? metrics.phases : [];
    const phase = phases.find((item) => item.phase === 'database-vacuum');
    if (flag !== '1' || !schemaValid
        || Object.values(pendingRecovery).some((count) => count !== 0)
        || (!variant.label.startsWith('3.1.11-') && (!phase || phase.outcome !== 'success'))) {
      throw codedError('VACUUM_POSTCONDITION_NOT_EXECUTED', '一次性 VACUUM 未形成隔离且成功的后验', {
        vacuumFlagAfter: flag,
        phaseOutcome: phase && phase.outcome || 'missing',
        pendingRecovery,
        schema,
        schemaChanged,
        schemaDelta,
        columnDeltaValid,
        indexDefinitionValid,
        schemaValid
      });
    }
    return {
      vacuumFlagAfter: flag,
      vacuumOutcome: phase && phase.outcome || 'legacy-flag-transition',
      pendingRecovery,
      schema,
      schemaChanged,
      schemaDelta,
      columnDeltaValid,
      indexDefinitionValid,
      schemaValid
    };
  }
  if (options.scenario === 'crash-recovery') {
    const sentinelPath = options.recoverySentinel
      ? path.join(sampleDatabase.userDataDir, ...options.recoverySentinel.relativePath.split('/'))
      : null;
    if (sentinelPath && fs.existsSync(sentinelPath)) {
      throw codedError('RECOVERY_SENTINEL_NOT_CONSUMED', '恢复 journal sentinel 未被消费');
    }
    const pendingRecovery = readPendingRecoveryCounts(sampleDatabase.databasePath);
    const schema = readSchemaState(sampleDatabase.databasePath);
    const beforeSchema = dependencies.precondition && dependencies.precondition.schema;
    const schemaChanged = Boolean(beforeSchema && schema.fingerprint !== beforeSchema.fingerprint);
    const validWalPending = Boolean(dependencies.postBundleEvidence
      && dependencies.postBundleEvidence.wal
      && dependencies.postBundleEvidence.wal.validFrames);
    if (!schema.current || schemaChanged || validWalPending
        || Object.values(pendingRecovery).some((count) => count !== 0)) {
      throw codedError('CRASH_POSTCONDITION_DIRTY', 'crash recovery 后仍有 pending/schema/WAL 工作', {
        pendingRecovery, schema, schemaChanged, validWalPending
      });
    }
    const checkpointValue = readSettingValue(sampleDatabase.databasePath, options.walSentinel.settingKey);
    if (checkpointValue !== options.walSentinel.expectedValue) {
      throw codedError('CRASH_WAL_NOT_CHECKPOINTED', '进程关闭后 WAL sentinel 未进入独立主库副本', {
        checkpointValue
      });
    }
    return {
      walSentinelCheckpointed: true,
      checkpointValue,
      journalSentinelConsumed: sentinelPath ? true : null,
      walBytesAfter: dependencies.postBundleEvidence && dependencies.postBundleEvidence.walBytes,
      shmBytesAfter: dependencies.postBundleEvidence && dependencies.postBundleEvidence.shmBytes,
      pendingRecovery,
      schema,
      schemaChanged,
      validWalPending
    };
  }
  return {};
}

function scenarioPostcondition(options, variant, sampleDatabase, metrics, dependencies = {}) {
  return withPostconditionDatabaseProbe(sampleDatabase, dependencies, (probeDatabase) => (
    scenarioPostconditionOnProbe(options, variant, probeDatabase, metrics, dependencies)
  ));
}

async function waitForRootExitEvidence(adapter, handle, timeoutMs) {
  if (!handle || !handle.exitPromise || typeof handle.exitPromise.then !== 'function') {
    throw codedError('PROCESS_ROOT_EXIT_EVIDENCE_MISSING', 'process adapter 未提供 root exitPromise');
  }
  if (adapter && typeof adapter.waitForRootExit === 'function') {
    return adapter.waitForRootExit(handle, timeoutMs);
  }
  let timeoutId = null;
  try {
    return await Promise.race([
      handle.exitPromise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function fileEvidence(filePath, options = {}) {
  try {
    const stat = fs.statSync(filePath);
    const evidence = { exists: true, size: stat.size, sha256: sha256(filePath) };
    if (options.wal) {
      const handle = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(4);
      try { fs.readSync(handle, header, 0, 4, 0); } finally { fs.closeSync(handle); }
      const magic = stat.size >= 4 ? header.readUInt32BE(0) : null;
      evidence.magic = magic === null ? null : magic.toString(16);
      evidence.validFrames = stat.size > 32 && (magic === 0x377f0682 || magic === 0x377f0683);
    }
    return evidence;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, size: 0, sha256: null, ...(options.wal ? { magic: null, validFrames: false } : {}) };
    }
    throw error;
  }
}

function freezeDatabaseBundle(databasePath) {
  const database = fileEvidence(databasePath);
  const wal = fileEvidence(`${databasePath}-wal`, { wal: true });
  const shm = fileEvidence(`${databasePath}-shm`);
  return {
    databaseBytes: database.size,
    walBytes: wal.size,
    shmBytes: shm.size,
    database,
    wal,
    shm
  };
}

function databaseBundleIdentityEqual(left, right) {
  return ['database', 'wal', 'shm'].every((name) => (
    left && right
    && left[name].exists === right[name].exists
    && left[name].size === right[name].size
    && left[name].sha256 === right[name].sha256
  ));
}

function goldenBundleEvidence(options) {
  return {
    database: fileEvidence(options.goldenDb),
    wal: options.goldenWal ? fileEvidence(options.goldenWal, { wal: true })
      : { exists: false, size: 0, sha256: null, magic: null, validFrames: false },
    shm: options.goldenShm ? fileEvidence(options.goldenShm)
      : { exists: false, size: 0, sha256: null }
  };
}

async function verifyNormalSchemaSteady(options, rootDir, dependencies = {}) {
  if (options.scenario !== 'normal-clean-shutdown') return [];
  const now = dependencies.now || (() => Number(process.hrtime.bigint()) / 1e6);
  const adapter = dependencies.adapter || createProcessAdapter({ now });
  const probeParent = path.join(rootDir, 'schema-probes');
  const labels = ['3.1.11-portable', '3.1.12-portable'];
  const goldenHash = sha256(options.goldenDb);
  const evidence = [];
  fs.mkdirSync(probeParent, { recursive: true });
  try {
    for (const label of labels) {
      const probeRoot = path.join(probeParent, label);
      const userDataDir = path.join(probeRoot, 'userData');
      const documentsDir = path.join(probeRoot, 'Documents');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(documentsDir, { recursive: true });
      const databasePath = path.join(userDataDir, 'tool-data.sqlite');
      fs.copyFileSync(options.goldenDb, databasePath, fs.constants.COPYFILE_EXCL);
      if (sha256(databasePath) !== goldenHash) {
        throw codedError('NORMAL_SCHEMA_PROBE_GOLDEN_MISMATCH', `${label} schema probe 非 exact golden copy`);
      }
      const before = readSchemaState(databasePath);
      if (!before.current) {
        throw codedError('NORMAL_STARTUP_SCHEMA_NOT_CURRENT', `${label} normal golden 缺少 current schema`, before);
      }
      const metricsPath = path.join(probeRoot, 'startup-metrics.json');
      let handle = null;
      let closed = false;
      try {
        if (dependencies.assertArtifactsBeforeLaunch) dependencies.assertArtifactsBeforeLaunch();
        handle = await adapter.launch({
          executable: options.variants.get(label),
          cwd: path.dirname(options.variants.get(label)),
          env: {
            ...process.env,
            APP_STARTUP_METRICS_PATH: metricsPath,
            APP_USER_DATA_DIR: userDataDir,
            APP_DOCUMENTS_DIR: documentsDir
          }
        });
        await waitForFullReady({
          label,
          metricsPath,
          adapter,
          handle,
          timeoutMs: options.timeoutMs,
          readMetrics: dependencies.readMetrics,
          now
        });
        const livePids = await adapter.refreshTree(handle);
        if (!Array.isArray(livePids) || livePids.length === 0) {
          throw codedError('PROCESS_TREE_CLOSE_TARGET_MISSING', `${label} schema probe 无 owned live target`);
        }
        const closeEvidence = await adapter.gracefulClose(handle);
        if (!closeEvidence || !Array.isArray(closeEvidence.acceptedPids)
            || closeEvidence.acceptedPids.length === 0) {
          throw codedError('PROCESS_TREE_CLOSE_NOT_ACCEPTED', `${label} schema probe 无 CloseMainWindow receipt`);
        }
        const exitResult = await adapter.waitForExit(handle, 15000);
        if (!(exitResult && exitResult.exited && exitResult.verifiedEmpty === true)) {
          throw codedError('PROCESS_TREE_GRACEFUL_CLOSE_TIMEOUT', `${label} schema probe 进程树未退出`);
        }
        const rootExit = await waitForRootExitEvidence(adapter, handle, 5000);
        if (!rootExit || Number(rootExit.code) !== 0 || rootExit.signal !== null) {
          throw codedError('PROCESS_TREE_NONZERO_EXIT', `${label} schema probe root 非正常退出`, rootExit || {});
        }
        closed = true;
      } finally {
        if (handle && !closed) {
          try {
            await adapter.forceCleanup(handle, { timeoutMs: 15000 });
          } catch (cleanupError) {
            const error = codedError('PROCESS_CLEANUP_FATAL', `${label} schema probe cleanup 无法证明完成`, {
              cleanupCode: String(cleanupError && cleanupError.code || 'PROCESS_CLEANUP_FAILED'),
              cleanupEvidence: cleanupError && cleanupError.evidence || {},
              requiresManualCleanup: Boolean(cleanupError && cleanupError.evidence
                && cleanupError.evidence.requiresManualCleanup)
            });
            error.abortRun = true;
            throw error;
          }
        }
      }
      const after = readSchemaState(databasePath);
      if (after.fingerprint !== before.fingerprint) {
        throw codedError('NORMAL_STARTUP_SCHEMA_CHANGED', `${label} normal schema probe 发生 DDL`, {
          label, before: before.fingerprint, after: after.fingerprint
        });
      }
      evidence.push({ family: label.slice(0, 6), fingerprint: before.fingerprint, unchanged: true });
    }
    return evidence;
  } finally {
    fs.rmSync(probeParent, { recursive: true, force: true });
  }
}

async function waitForFullReady({ label, metricsPath, adapter, handle, timeoutMs, readMetrics = readMetricsFile, now = () => Number(process.hrtime.bigint()) / 1e6 }) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let lastMetrics = null;
  let lastReadyEvidence = incompleteReadyEvidence(label, null);
  while (now() < deadline) {
    const metrics = readMetrics(metricsPath);
    const evidence = fullReadyEvidence(label, metrics);
    if (evidence) return { metrics, evidence, fullReadyMs: Number((now() - startedAt).toFixed(3)) };
    if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
      lastMetrics = metrics;
      lastReadyEvidence = incompleteReadyEvidence(label, metrics);
    }
    if (handle && handle.exitPromise && typeof handle.exitPromise.then === 'function') {
      const outcome = await Promise.race([
        handle.exitPromise.then((exit) => ({ exit })),
        Promise.resolve(adapter.delay(100)).then(() => ({ waited: true }))
      ]);
      if (outcome.exit) {
        throw codedError('PROCESS_EXITED_BEFORE_FULL_READY', `${label} 在完整 ready 前退出`, {
          code: outcome.exit.code,
          signal: outcome.exit.signal,
          ownership: handle.processTokens instanceof Map && handle.processTokens.size > 0
            ? 'established'
            : 'unestablished',
          readyEvidence: lastReadyEvidence,
          lastMetrics
        });
      }
    } else {
      await adapter.delay(100);
    }
  }
  throw codedError('STARTUP_FULL_READY_TIMEOUT', `${label} 未在超时内形成完整 ready 证据`, {
    readyEvidence: lastReadyEvidence,
    lastMetrics
  });
}

async function measureSample(variant, round, options, dependencies = {}) {
  const now = dependencies.now || (() => Number(process.hrtime.bigint()) / 1e6);
  const adapter = dependencies.adapter || createProcessAdapter({ now });
  const sampleRoot = path.join(variant.variantRoot, 'samples', String(round + 1).padStart(2, '0'));
  fs.mkdirSync(sampleRoot, { recursive: true });
  assertFrozenGoldenIdentity(options);
  const sampleDatabase = prepareSampleDatabase(variant, options, sampleRoot);
  assertFrozenGoldenIdentity(options);
  const metricsPath = path.join(sampleRoot, 'startup-metrics.json');
  const sampleDeadline = Date.now() + options.timeoutMs;
  const remainingMs = (cap = options.timeoutMs) => Math.max(1, Math.min(cap, sampleDeadline - Date.now()));
  const evidence = {
    round: round + 1,
    before: 'unavailable',
    readyEvidence: 'unavailable',
    phases: 'unavailable',
    recoveryCounts: 'unavailable',
    gracefulCloseEvidence: 'unavailable',
    cleanupEvidence: 'unavailable',
    after: 'unavailable',
    scenarioEvidence: { precondition: 'unavailable', postcondition: 'unavailable' }
  };
  let handle = null;
  let closed = false;
  let failure = null;
  try {
    const copied = freezeDatabaseBundle(sampleDatabase.databasePath);
    evidence.before = copied;
    if (options.scenario !== 'normal-clean-shutdown') {
      const golden = goldenBundleEvidence(options);
      if (!databaseBundleIdentityEqual(copied, golden)) {
        throw codedError('TIMED_BUNDLE_COPY_MISMATCH', 'timed main/WAL/SHM 与 golden 字节身份不一致', {
          copied, golden
        });
      }
    }
    const precondition = scenarioPrecondition(options, sampleDatabase, dependencies);
    const before = freezeDatabaseBundle(sampleDatabase.databasePath);
    if (!databaseBundleIdentityEqual(copied, before)) {
      throw codedError('TIMED_BUNDLE_PREFLIGHT_MUTATED', 'scenario preflight 改写了 timed main/WAL/SHM', {
        copied, before
      });
    }
    evidence.before = before;
    evidence.scenarioEvidence.precondition = precondition;
    if (dependencies.assertArtifactsBeforeLaunch) dependencies.assertArtifactsBeforeLaunch();
    else if (variant.artifactIdentity) assertArtifactIdentity(variant, dependencies);
    handle = await adapter.launch({
      executable: variant.executable,
      cwd: path.dirname(variant.executable),
      timeoutMs: remainingMs(),
      env: {
        ...process.env,
        APP_STARTUP_METRICS_PATH: metricsPath,
        APP_USER_DATA_DIR: sampleDatabase.userDataDir,
        APP_DOCUMENTS_DIR: sampleDatabase.documentsDir
      }
    });
    const ready = await waitForFullReady({
      label: variant.label,
      metricsPath,
      adapter,
      handle,
      timeoutMs: options.timeoutMs,
      readMetrics: dependencies.readMetrics,
      now
    });
    evidence.readyEvidence = ready.evidence;
    evidence.phases = Array.isArray(ready.metrics.phases) ? ready.metrics.phases : [];
    evidence.recoveryCounts = Object.fromEntries(evidence.phases.flatMap((phase) => (
      phase.counts ? [[phase.phase, phase.counts]] : []
    )));
    if (!Number.isFinite(handle.processCreatedAt)) {
      throw codedError('PROCESS_CREATED_AT_MISSING', 'process adapter 未提供进程创建时刻');
    }
    const externalFullReadyMs = Number((now() - handle.processCreatedAt).toFixed(3));
    evidence.externalFullReadyMs = externalFullReadyMs;
    const processIds = await adapter.refreshTree(handle, {
      timeoutMs: remainingMs(DEFAULT_EXTERNAL_TIMEOUT_MS)
    });
    if (processIds.length === 0) {
      throw codedError('PROCESS_TREE_CLOSE_TARGET_MISSING', 'ready 后没有 token-matched owned live process');
    }
    const closeEvidence = await adapter.gracefulClose(handle, {
      timeoutMs: remainingMs(DEFAULT_EXTERNAL_TIMEOUT_MS)
    });
    if (!closeEvidence || !Array.isArray(closeEvidence.acceptedPids)
        || closeEvidence.acceptedPids.length === 0) {
      throw codedError('PROCESS_TREE_CLOSE_NOT_ACCEPTED', '没有 owned 主窗口接受 graceful close');
    }
    evidence.gracefulCloseEvidence = closeEvidence;
    const exitResult = await adapter.waitForExit(handle, remainingMs(15000));
    const treeExited = Boolean(exitResult && exitResult.exited && exitResult.verifiedEmpty === true);
    if (!treeExited) throw codedError('PROCESS_TREE_GRACEFUL_CLOSE_TIMEOUT', 'ready 后进程树未在宽限期退出', { processCount: processIds.length });
    closed = true;
    const after = freezeDatabaseBundle(sampleDatabase.databasePath);
    evidence.after = after;
    const rootExit = await waitForRootExitEvidence(adapter, handle, remainingMs(5000));
    if (!rootExit || Number(rootExit.code) !== 0 || rootExit.signal !== null) {
      throw codedError('PROCESS_TREE_NONZERO_EXIT', '被测根进程未形成 code=0 且无 signal 的退出证据', rootExit || {});
    }
    // readiness 已在上方取时；退出耗时不进入 externalFullReadyMs。DB/WAL 后置证据只在
    // 整棵进程树关闭后读取，避免 Windows 文件锁和未完成 checkpoint 污染结论。
    let postcondition;
    try {
      postcondition = scenarioPostcondition(options, variant, sampleDatabase, ready.metrics, {
        ...dependencies,
        postBundleEvidence: after,
        precondition
      });
    } catch (postError) {
      evidence.scenarioEvidence.postcondition = {
        status: 'failed',
        evidenceCode: String(postError && postError.code || 'SCENARIO_POSTCONDITION_FAILED'),
        evidence: postError && postError.evidence || {}
      };
      if (postError && postError.evidence && postError.evidence.pendingRecovery) {
        evidence.recoveryCounts = {
          ...evidence.recoveryCounts,
          actualPostcondition: postError.evidence.pendingRecovery
        };
      }
      throw postError;
    }
    const phases = Array.isArray(ready.metrics.phases) ? ready.metrics.phases : [];
    evidence.scenarioEvidence.postcondition = postcondition;
    evidence.recoveryCounts = {
      ...evidence.recoveryCounts,
      actualPostcondition: postcondition.pendingRecovery || {}
    };
    return {
      round: round + 1,
      status: 'success',
      externalFullReadyMs,
      readyEvidence: ready.evidence,
      gracefulClose: true,
      gracefulCloseEvidence: closeEvidence,
      processTree: {
        observedProcessCount: processIds.length,
        nonceSha256: handle.nonce
          ? crypto.createHash('sha256').update(handle.nonce).digest('hex')
          : null
      },
      appReportedReadyToShowMs: ready.metrics.durations && ready.metrics.durations.totalReadyToShowMs,
      before,
      after,
      scenarioEvidence: evidence.scenarioEvidence,
      recoveryCounts: evidence.recoveryCounts,
      phases
    };
  } catch (error) {
    const partialMetrics = error && error.evidence && error.evidence.lastMetrics;
    const partialReady = error && error.evidence && error.evidence.readyEvidence;
    if (partialReady && partialReady.status === 'incomplete') {
      evidence.readyEvidence = partialReady;
    }
    if (partialMetrics && Array.isArray(partialMetrics.phases)) {
      evidence.phases = partialMetrics.phases;
      evidence.recoveryCounts = Object.fromEntries(evidence.phases.flatMap((phase) => (
        phase.counts ? [[phase.phase, phase.counts]] : []
      )));
    }
    failure = error;
  }
  if (handle && !closed) {
    try {
      evidence.cleanupEvidence = await adapter.forceCleanup(handle, { timeoutMs: 15000 });
      if (!evidence.cleanupEvidence || evidence.cleanupEvidence.verifiedEmpty !== true) {
        throw codedError(
          'PROCESS_CLEANUP_UNVERIFIED',
          'cleanup 未返回 token-aware verifiedEmpty receipt',
          { cleanupEvidence: evidence.cleanupEvidence || 'unavailable' }
        );
      }
    } catch (cleanupError) {
      const fatal = codedError('PROCESS_CLEANUP_FATAL', '无法证明失败样本的 owned process tree 已清空，整次测量必须中止', {
        originalCode: String(failure && failure.code || 'STARTUP_SAMPLE_FAILED'),
        cleanupCode: String(cleanupError && cleanupError.code || 'PROCESS_CLEANUP_FAILED'),
        cleanupEvidence: cleanupError && cleanupError.evidence || {},
        requiresManualCleanup: String(cleanupError && cleanupError.code || '')
          === 'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED'
          || Boolean(cleanupError && cleanupError.evidence
            && cleanupError.evidence.requiresManualCleanup)
      });
      fatal.abortRun = true;
      fatal.requiresManualCleanup = fatal.evidence.requiresManualCleanup;
      fatal.sampleEvidence = evidence;
      throw fatal;
    }
    try {
      const freezeAfterCleanup = dependencies.freezeDatabaseBundle || freezeDatabaseBundle;
      evidence.after = freezeAfterCleanup(sampleDatabase.databasePath);
    } catch (freezeError) {
      evidence.after = {
        status: 'unavailable',
        reason: 'post-cleanup-bundle-freeze-failed',
        evidenceCode: String(freezeError && freezeError.code || 'DATABASE_BUNDLE_FREEZE_FAILED')
      };
      const afterFailure = codedError(
        'STARTUP_SAMPLE_AFTER_FREEZE_FAILED',
        'cleanup 已证明空树，但无法冻结失败样本的 DB/WAL/SHM 后置证据',
        {
          originalCode: String(failure && failure.code || 'STARTUP_SAMPLE_FAILED'),
          freezeCode: evidence.after.evidenceCode
        }
      );
      afterFailure.sampleEvidence = evidence;
      throw afterFailure;
    }
  }
  failure.sampleEvidence = evidence;
  throw failure;
}

function buildReport(options, goldenSha256, variants, rotation, schemaProbeEvidence = [], metadata = {}) {
  const successfulSamples = (variant) => variant.samples.filter((sample) => sample.status === 'success');
  const fixedGoldenEvidence = metadata.goldenEvidence || null;
  return {
    schemaVersion: 2,
    scenario: options.scenario,
    generatedAt: new Date().toISOString(),
    environment: metadata.environment || collectEnvironmentEvidence(options),
    run: metadata.run || { status: 'completed', requiresManualCleanup: false },
    golden: {
      sha256: fixedGoldenEvidence ? fixedGoldenEvidence.database.sha256 : goldenSha256,
      walSha256: fixedGoldenEvidence ? fixedGoldenEvidence.wal.sha256
        : options.goldenWal ? sha256(options.goldenWal) : null,
      shmSha256: fixedGoldenEvidence ? fixedGoldenEvidence.shm.sha256
        : options.goldenShm ? sha256(options.goldenShm) : null,
      sizeBytes: fixedGoldenEvidence ? fixedGoldenEvidence.database.size : fileSize(options.goldenDb),
      sourcePathRecorded: false,
      runnerOwnedFrozenCopy: true
    },
    contract: {
      runsPerVariant: options.runs,
      firstSampleRetained: true,
      rotatingOrder: rotation,
      databaseCopyTimeExcluded: true,
      sourceGoldenIdentityCheckedAfterRun: true,
      artifactIdentityCheckedBeforeEverySpawnAndAfterRun: true,
      freshGoldenPerSample: options.scenario !== 'normal-clean-shutdown',
      independentDocumentsPerSample: options.scenario !== 'normal-clean-shutdown',
      gracefulCloseRequested: true,
      processTreeCleanupRequired: true,
      readyProbeRequired: true,
      sampleTimeoutMs: options.timeoutMs,
      acceptanceMetric: 'externalFullReadyMs.median',
      claimedReductionPercent: null
    },
    schemaProbeEvidence,
    evaluation: {
      status: 'not-evaluated',
      reason: '真实 Windows 3.1.11 vs 3.1.12 性能结论由 PR5 对拍与人工签字形成',
      missingSamples: Object.fromEntries(variants.map((variant) => [variant.label, Math.max(0, options.runs - successfulSamples(variant).length)]))
    },
    variants: Object.fromEntries(variants.map((variant) => [variant.label, {
      initialSha256: variant.initialSha256,
      initialWalSha256: variant.initialWalSha256,
      initialShmSha256: variant.initialShmSha256,
      executablePathRecorded: false,
      artifact: variant.artifactIdentity || null,
      summary: { externalFullReadyMs: summarize(successfulSamples(variant).map((sample) => sample.externalFullReadyMs)) },
      samples: variant.samples
    }]))
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const temporary = !options.workRoot;
  const rootDir = options.workRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'startup-packaged-'));
  fs.mkdirSync(rootDir, { recursive: true });
  const frozenInput = freezeGoldenInputs(options, rootDir);
  const runtimeOptions = frozenInput.frozenOptions;
  const goldenSha256 = sha256(runtimeOptions.goldenDb);
  const environment = collectEnvironmentEvidence(options);
  const artifactIdentities = validateArtifactIdentities(
    REQUIRED_VARIANTS.map((label) => ({ label, executable: options.variants.get(label) })),
    dependencies
  );
  const artifactByLabel = new Map(artifactIdentities.map((identity) => [identity.label, identity]));
  const artifactCandidates = REQUIRED_VARIANTS.map((label) => ({
    label,
    executable: options.variants.get(label),
    artifactIdentity: artifactByLabel.get(label)
  }));
  const assertArtifactsBeforeLaunch = () => {
    for (const candidate of artifactCandidates) assertArtifactIdentity(candidate, dependencies);
  };
  const runtimeDependencies = { ...dependencies, assertArtifactsBeforeLaunch };
  assertFrozenGoldenIdentity(runtimeOptions);
  const schemaProbeEvidence = dependencies.skipSchemaProbe
    ? []
    : await verifyNormalSchemaSteady(runtimeOptions, rootDir, runtimeDependencies);
  assertFrozenGoldenIdentity(runtimeOptions);
  const variants = REQUIRED_VARIANTS.map((label) => prepareVariant(runtimeOptions, label, rootDir, goldenSha256));
  assertFrozenGoldenIdentity(runtimeOptions);
  for (const variant of variants) variant.artifactIdentity = artifactByLabel.get(variant.label);
  const byLabel = new Map(variants.map((variant) => [variant.label, variant]));
  const rotation = [];
  let abortEvidence = null;
  measurement: for (let round = 0; round < options.runs; round += 1) {
    const order = rotatedOrder(round);
    rotation.push(order);
    for (const label of order) {
      try {
        byLabel.get(label).samples.push(await measureSample(
          byLabel.get(label), round, runtimeOptions, runtimeDependencies
        ));
      } catch (error) {
        const partial = error && error.sampleEvidence || {};
        byLabel.get(label).samples.push({
          ...partial,
          round: round + 1,
          status: 'failed',
          evidenceCode: String(error && error.code || 'STARTUP_SAMPLE_FAILED'),
          evidence: error && error.evidence || {}
        });
        if (error && error.abortRun) {
          abortEvidence = {
            round: round + 1,
            label,
            evidenceCode: String(error.code),
            evidence: error.evidence || {},
            requiresManualCleanup: Boolean(error.requiresManualCleanup)
          };
          break measurement;
        }
      }
    }
  }
  if (!abortEvidence) {
    try {
      for (const variant of variants) assertArtifactIdentity(variant, dependencies);
      assertFrozenGoldenIdentity(runtimeOptions);
      const sourceAfter = goldenBundleEvidence(options);
      if (!databaseBundleIdentityEqual(frozenInput.sourceEvidence, sourceAfter)) {
        throw codedError('GOLDEN_SOURCE_IDENTITY_DRIFT', 'source golden main/WAL/SHM 在 run 内发生漂移', {
          before: frozenInput.sourceEvidence, after: sourceAfter
        });
      }
    } catch (error) {
      abortEvidence = {
        round: null,
        label: null,
        evidenceCode: String(error && error.code || 'RUN_IDENTITY_DRIFT'),
        evidence: error && error.evidence || {},
        requiresManualCleanup: false
      };
    }
  }
  const report = buildReport(runtimeOptions, goldenSha256, variants, rotation, schemaProbeEvidence, {
    environment,
    goldenEvidence: frozenInput.frozenEvidence,
    run: abortEvidence ? {
      status: 'aborted',
      requiresManualCleanup: abortEvidence.requiresManualCleanup,
      abortEvidence
    } : { status: 'completed', requiresManualCleanup: false }
  });
  const output = options.output || path.join(rootDir, 'startup-comparison.json');
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`packaged startup report: ${output}\n`);
  if (temporary) process.stdout.write(`work copies retained: ${rootDir}\n`);
  if (abortEvidence) {
    const error = codedError('STARTUP_MEASUREMENT_ABORTED', 'packaged startup measurement 已中止', abortEvidence);
    error.report = report;
    throw error;
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
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
  validateWalPrecondition,
  verifyNormalSchemaSteady,
  waitForRootExitEvidence,
  waitForFullReady
};
