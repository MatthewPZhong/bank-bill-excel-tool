'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_TAG = 'v3.1.7';
const SOURCE_COMMIT = '1117c8b7d047cf408807b023368c63123a90d81f';
const TARGET_MONTH = '2026-06';
const SUBJECT = 'PPHK';
const OUTPUT_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'vcc-financial-op');
const OUTPUT_DB = path.join(OUTPUT_DIR, 'v3.1.7-four-dataset.sqlite');
const OUTPUT_MANIFEST = path.join(OUTPUT_DIR, 'v3.1.7-four-dataset.manifest.json');
const RUNTIME_DEPENDENCIES = Object.freeze([
  'xlsx',
  'sax',
  'yauzl',
  'buffer-crc32',
  'pend'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  }).trim();
}

function assertSourceTag() {
  const commit = git(['rev-parse', `${SOURCE_TAG}^{commit}`]);
  if (commit !== SOURCE_COMMIT) {
    throw new Error(`${SOURCE_TAG} commit 不匹配：${commit}`);
  }
  return commit;
}

function extractTagSource(tempRoot) {
  const archivePath = path.join(tempRoot, 'source.tar');
  const tagRoot = path.join(tempRoot, 'tag-source');
  fs.mkdirSync(tagRoot);
  execFileSync('git', [
    'archive',
    '--format=tar',
    '--output',
    archivePath,
    SOURCE_TAG
  ], { cwd: REPO_ROOT });
  execFileSync('tar', ['-xf', archivePath, '-C', tagRoot]);
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tagRoot, 'node_modules'), 'dir');
  return tagRoot;
}

function normalizedLock(lock, version) {
  const normalized = structuredClone(lock);
  normalized.version = version;
  normalized.packages[''].version = version;
  return normalized;
}

function inspectDependencies(tagRoot, tagRequire) {
  const tagPackage = JSON.parse(fs.readFileSync(path.join(tagRoot, 'package.json'), 'utf8'));
  const tagLock = JSON.parse(fs.readFileSync(path.join(tagRoot, 'package-lock.json'), 'utf8'));
  const currentLock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  if (
    JSON.stringify(normalizedLock(tagLock, currentLock.version))
    !== JSON.stringify(currentLock)
  ) {
    throw new Error('v3.1.7 与当前 package-lock 除根版本外不一致，停止生成 fixture');
  }
  const packages = Object.fromEntries(RUNTIME_DEPENDENCIES.map((name) => {
    const packagePath = tagRequire.resolve(`${name}/package.json`);
    const resolvedVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    const tagLockVersion = tagLock.packages[`node_modules/${name}`]?.version || null;
    const currentLockVersion = currentLock.packages[`node_modules/${name}`]?.version || null;
    if (resolvedVersion !== tagLockVersion || resolvedVersion !== currentLockVersion) {
      throw new Error(`${name} 依赖版本不一致，停止生成 fixture`);
    }
    return [name, {
      declaredRange: tagPackage.dependencies[name] || null,
      tagLockVersion,
      currentLockVersion,
      resolvedVersion,
      resolvedPath: path.relative(REPO_ROOT, packagePath),
      resolvedRealPath: path.relative(REPO_ROOT, fs.realpathSync(packagePath))
    }];
  }));
  return {
    locksEqualAfterRootVersionNormalization: true,
    packages
  };
}

function writeWorkbook(XLSX, inputsRoot, fileName, rows) {
  const filePath = path.join(inputsRoot, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath, { bookType: 'xlsx', compression: true });
  return filePath;
}

function buildInputWorkbooks({ XLSX, definitions, inputsRoot }) {
  const {
    SOURCE_TYPES,
    SOURCE_DEFINITIONS,
    SYSTEM_OP_HEADERS,
    SUPPORTED_CURRENCIES
  } = definitions;
  const detailValues = (sourceType, fields) => (
    SOURCE_DEFINITIONS[sourceType].headers.map((header) => (
      Object.hasOwn(fields, header) ? fields[header] : ''
    ))
  );
  const rechargePath = writeWorkbook(XLSX, inputsRoot, 'vcc-recharge.xlsx', [
    SOURCE_DEFINITIONS[SOURCE_TYPES.RECHARGE].headers,
    detailValues(SOURCE_TYPES.RECHARGE, {
      '订单号': 'R-202606-001',
      'BillDate': '2026-06-15',
      '业务部门': 'VCC',
      '对手部门': 'OPS',
      '业务子类型': '充值',
      '出入方向': 'in',
      '公司主体': SUBJECT,
      '我方币种': 'USD',
      '我方到账金额': '10'
    })
  ]);
  const feePath = writeWorkbook(XLSX, inputsRoot, 'vcc-fee-fx.xlsx', [
    SOURCE_DEFINITIONS[SOURCE_TYPES.FEE_FX].headers,
    detailValues(SOURCE_TYPES.FEE_FX, {
      '订单号': 'F-202606-001',
      'BillDate': '2026-06-16',
      '业务部门': 'VCC',
      '业务子类型': '手续费',
      '出入方向': 'out',
      '公司主体': SUBJECT,
      '我方币种': 'USD',
      '我方到账金额': '2'
    })
  ]);
  const channelPath = writeWorkbook(XLSX, inputsRoot, 'vcc-channel.xlsx', [
    SOURCE_DEFINITIONS[SOURCE_TYPES.CHANNEL].headers,
    detailValues(SOURCE_TYPES.CHANNEL, {
      '账单日期': '2026-06-17',
      '部门': 'VCC',
      '通道名称': 'CITI',
      'MID': 'MID-001',
      '渠道订单号': 'C-202606-001',
      '交易金额': '3',
      '交易币种': 'EUR',
      '借贷方向': 'in',
      'billdate': '2026-06-17'
    })
  ]);
  const systemRows = SUPPORTED_CURRENCIES.map((currency) => {
    const fields = {
      '账单日期': '2026-06-30',
      '主体': SUBJECT,
      '业务部门': 'VCC',
      '币种': currency,
      '财务余额': currency === 'USD' ? '108' : (currency === 'EUR' ? '103' : '100')
    };
    return SYSTEM_OP_HEADERS.map((header) => (
      Object.hasOwn(fields, header) ? fields[header] : ''
    ));
  });
  const systemPath = writeWorkbook(XLSX, inputsRoot, 'vcc-system-op.xlsx', [
    SYSTEM_OP_HEADERS,
    ...systemRows
  ]);
  return [rechargePath, feePath, channelPath, systemPath];
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function tableColumns(db, tableName) {
  return tableExists(db, tableName)
    ? db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name)
    : [];
}

function tableCount(db, tableName) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count) || 0;
}

function collectEvidence(db, phase) {
  const schemaRows = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name LIKE 'vcc_fin_op_%'
    ORDER BY type, name
  `).all();
  const tableNames = schemaRows.filter((row) => row.type === 'table').map((row) => row.name);
  const runColumns = tableColumns(db, 'vcc_fin_op_runs');
  const hasResultRevision = runColumns.includes('result_revision');
  const hasInputFingerprint = runColumns.includes('input_fingerprint');
  const hasUpdatedAt = runColumns.includes('updated_at');
  const runs = db.prepare(`
    SELECT id, target_month, status, input_revisions_json,
           ${hasResultRevision ? 'result_revision' : 'NULL'} AS result_revision,
           ${hasInputFingerprint ? 'input_fingerprint' : 'NULL'} AS input_fingerprint,
           ${hasUpdatedAt ? 'updated_at' : 'NULL'} AS updated_at,
           created_at, archived_at
    FROM vcc_fin_op_runs
    WHERE target_month = ?
    ORDER BY id
  `).all(TARGET_MONTH);
  const runId = runs.length === 1 ? Number(runs[0].id) : null;
  const datasets = db.prepare(`
    SELECT dataset_type, data_status, revision, archived_run_id
    FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(TARGET_MONTH);
  const archives = db.prepare(`
    SELECT subject, run_id, archived_at, balances_json
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    ORDER BY subject
  `).all(TARGET_MONTH);
  return {
    phase,
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version,
    schemaHash: sha256(JSON.stringify(schemaRows)),
    tableCounts: Object.fromEntries(tableNames.map((tableName) => [
      tableName,
      tableCount(db, tableName)
    ])),
    runColumnPresence: {
      resultRevision: hasResultRevision,
      inputFingerprint: hasInputFingerprint,
      updatedAt: hasUpdatedAt
    },
    runs: runs.map((run) => ({
      id: Number(run.id),
      targetMonth: run.target_month,
      status: run.status,
      inputRevisionsJson: run.input_revisions_json,
      inputRevisions: JSON.parse(run.input_revisions_json),
      resultRevision: hasResultRevision ? Number(run.result_revision) : null,
      inputFingerprint: hasInputFingerprint ? run.input_fingerprint : null,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      archivedAt: run.archived_at
    })),
    datasets: datasets.map((dataset) => ({
      datasetType: dataset.dataset_type,
      dataStatus: dataset.data_status,
      revision: Number(dataset.revision),
      archivedRunId: Number(dataset.archived_run_id)
    })),
    archives: archives.map((archive) => ({
      subject: archive.subject,
      runId: Number(archive.run_id),
      archivedAt: archive.archived_at,
      balances: JSON.parse(archive.balances_json)
    })),
    runRows: db.prepare(`
      SELECT id, run_id AS runId, subject, row_kind AS rowKind,
             source_type AS sourceType, category_major AS categoryMajor,
             category_minor AS categoryMinor, currency, amount
      FROM vcc_fin_op_run_rows
      WHERE run_id = ?
      ORDER BY id
    `).all(runId),
    storedRunBalances: db.prepare(`
      SELECT run_id AS runId, subject, currency,
             opening_balance AS openingBalance,
             period_amount AS periodAmount,
             calculated_balance AS calculatedBalance,
             system_balance AS systemBalance,
             difference
      FROM vcc_fin_op_run_balances
      WHERE run_id = ?
      ORDER BY subject, currency
    `).all(runId),
    pendingCounts: {
      effectiveFacts: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = 'pending_archive_removal'
      `).get(TARGET_MONTH).count) || 0,
      runRows: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM vcc_fin_op_run_rows
        WHERE run_id = ? AND (row_kind = 'pending' OR source_type = 'pending_archive_removal')
      `).get(runId).count) || 0,
      summaries: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_pending_summary_rows WHERE run_id = ?
      `).get(runId).count) || 0,
      currencyTotals: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_pending_currency_totals WHERE run_id = ?
      `).get(runId).count) || 0
    },
    adjustmentTablePresent: tableExists(db, 'vcc_fin_op_run_adjustments'),
    adjustmentCount: tableExists(db, 'vcc_fin_op_run_adjustments')
      ? tableCount(db, 'vcc_fin_op_run_adjustments')
      : null
  };
}

function assertLegacyShape(evidence) {
  const expectedTypes = ['channel', 'fee_fx', 'recharge_refund', 'system_op'];
  const run = evidence.runs[0];
  if (
    evidence.runs.length !== 1
    || run.status !== 'archived'
    || run.resultRevision !== 0
    || run.inputFingerprint !== null
    || JSON.stringify(evidence.datasets.map((item) => item.datasetType)) !== JSON.stringify(expectedTypes)
    || evidence.datasets.some((item) => item.dataStatus !== 'archived' || item.archivedRunId !== run.id)
    || evidence.adjustmentCount !== 0
    || Object.values(evidence.pendingCounts).some((count) => count !== 0)
    || evidence.archives.length !== 1
    || Object.keys(evidence.archives[0].balances).length !== 9
  ) {
    throw new Error('current migration 后不满足精确 legacy-four shape');
  }
}

async function generate() {
  const sourceCommit = assertSourceTag();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-v3.1.7-fixture-'));
  let db = null;
  try {
    const tagRoot = extractTagSource(tempRoot);
    const tagRequire = createRequire(path.join(tagRoot, 'package.json'));
    const dependencies = inspectDependencies(tagRoot, tagRequire);
    const XLSX = tagRequire('xlsx');
    const definitions = tagRequire('./src/backend/vcc-financial-op/definitions.js');
    const { ensureVccFinancialOpTablesSupport: tagMigration } = tagRequire(
      './src/backend/vcc-financial-op-db/migrations.js'
    );
    const { inspectFiles, importFiles } = tagRequire(
      './src/backend/vcc-financial-op/import-service.js'
    );
    const {
      initializeOpeningBalances,
      calculateMonth,
      archiveRun
    } = tagRequire('./src/backend/vcc-financial-op/calculator.js');
    const { ensureVccFinancialOpTablesSupport: currentMigration } = require(
      path.join(REPO_ROOT, 'src', 'backend', 'vcc-financial-op-db', 'migrations.js')
    );
    const inputsRoot = path.join(tempRoot, 'inputs');
    fs.mkdirSync(inputsRoot);
    const inputPaths = buildInputWorkbooks({ XLSX, definitions, inputsRoot });
    const inspected = await inspectFiles(inputPaths);
    const prepared = inspected.map((file) => ({
      ...file,
      subject: file.requiresSubject ? SUBJECT : ''
    }));
    const sourceDbPath = path.join(tempRoot, 'v3.1.7-four-dataset.sqlite');
    db = new DatabaseSync(sourceDbPath);
    db.exec('PRAGMA foreign_keys = ON');
    tagMigration(db);
    const imported = await importFiles({
      db,
      targetMonth: TARGET_MONTH,
      files: prepared,
      batchId: 'fixture-v3.1.7-four-dataset'
    });
    const opening = initializeOpeningBalances({
      db,
      targetMonth: TARGET_MONTH,
      entries: [{
        subject: SUBJECT,
        balances: Object.fromEntries(
          definitions.SUPPORTED_CURRENCIES.map((currency) => [currency, '100'])
        )
      }],
      note: 'v3.1.7 fixture opening balance'
    });
    const calculated = calculateMonth({ db, targetMonth: TARGET_MONTH });
    if (calculated.status !== 'calculated') {
      throw new Error(`v3.1.7 calculateMonth 未成功：${JSON.stringify(calculated)}`);
    }
    const archived = archiveRun({ db, runId: calculated.runId });
    db.close();
    db = null;

    db = new DatabaseSync(sourceDbPath, { readOnly: true });
    const sourceEvidence = collectEvidence(db, 'v3.1.7-close-reopen');
    db.close();
    db = null;
    const sourceDbSha256 = sha256File(sourceDbPath);

    const migratedDbPath = path.join(tempRoot, 'current-migrated.sqlite');
    fs.copyFileSync(sourceDbPath, migratedDbPath);
    db = new DatabaseSync(migratedDbPath);
    db.exec('PRAGMA foreign_keys = ON');
    const migrationResult = currentMigration(db);
    db.close();
    db = null;
    db = new DatabaseSync(migratedDbPath, { readOnly: true });
    const migratedEvidence = collectEvidence(db, 'current-migration-close-reopen');
    db.close();
    db = null;
    assertLegacyShape(migratedEvidence);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.copyFileSync(sourceDbPath, OUTPUT_DB);
    if (sha256File(OUTPUT_DB) !== sourceDbSha256) {
      throw new Error('fixture 复制后 SHA-256 不一致');
    }
    const manifest = {
      manifestVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        tag: SOURCE_TAG,
        commit: sourceCommit
      },
      generator: {
        path: path.relative(REPO_ROOT, __filename),
        sha256: sha256File(__filename),
        inputWorkbookHashesAreGenerationProvenanceOnly: true
      },
      runtime: {
        node: process.version,
        sqlite: process.versions.sqlite,
        modulesAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch
      },
      dependencies,
      calls: {
        tagMigration: 'src/backend/vcc-financial-op-db/migrations.js#ensureVccFinancialOpTablesSupport',
        tagInspect: 'src/backend/vcc-financial-op/import-service.js#inspectFiles',
        tagImporter: 'src/backend/vcc-financial-op/import-service.js#importFiles',
        tagOpening: 'src/backend/vcc-financial-op/calculator.js#initializeOpeningBalances',
        tagCalculate: 'src/backend/vcc-financial-op/calculator.js#calculateMonth',
        tagArchive: 'src/backend/vcc-financial-op/calculator.js#archiveRun',
        currentVccMigration: 'src/backend/vcc-financial-op-db/migrations.js#ensureVccFinancialOpTablesSupport'
      },
      inputs: prepared.map((file) => ({
        fileName: path.basename(file.filePath),
        sourceType: file.sourceType,
        sheetName: file.sheetName,
        headerRow: file.headerRow,
        assignedSubject: file.subject,
        generationSha256: sha256File(file.filePath)
      })),
      results: {
        imported,
        opening,
        calculated,
        archived
      },
      fixture: {
        fileName: path.basename(OUTPUT_DB),
        generationTimeDbSha256: sourceDbSha256,
        sourceEvidence
      },
      currentMigrationProbe: {
        migrationResult,
        migratedDbSha256: sha256File(migratedDbPath),
        evidence: migratedEvidence,
        expectedContract: 'legacy-v3.1.7-four-dataset'
      }
    };
    fs.writeFileSync(OUTPUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      fixture: path.relative(REPO_ROOT, OUTPUT_DB),
      manifest: path.relative(REPO_ROOT, OUTPUT_MANIFEST),
      dbSha256: sourceDbSha256,
      schemaHash: sourceEvidence.schemaHash,
      migratedSchemaHash: migratedEvidence.schemaHash,
      runId: calculated.runId,
      datasetRevisions: sourceEvidence.runs[0].inputRevisions
    }, null, 2)}\n`);
  } finally {
    if (db) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

generate().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
