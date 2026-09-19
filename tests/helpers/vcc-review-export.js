'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../src/backend/vcc-financial-op-db/migrations');
const { createArchiveRepository } = require('../../src/backend/database/archive-repository');
const { SOURCE_TYPES: T, SUPPORTED_CURRENCIES: CURRENCIES, SYSTEM_OP_HEADERS, getSourceDefinition } = require('../../src/backend/vcc-financial-op/definitions');
const { inspectWorkbookImportPlan, resolveImportPlan } = require('../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, handoffMetadata } = require('../../src/backend/vcc-financial-op/import-handoff');
const { importFiles } = require('../../src/backend/vcc-financial-op/import-service');
const { preflightCalculation, calculateMonth } = require('../../src/backend/vcc-financial-op/calculator');

async function createReviewFixture(t, { subjects = ['甲', '乙'], pendingSameCurrency = false,
  pendingRemark = '=1+1', systemBillDate = '2026-06-30', writeOptions = {}, beforeImport } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-review-'));
  const dbPath = path.join(dir, 'business.sqlite'), archiveRoot = path.join(dir, 'archive');
  fs.mkdirSync(path.join(archiveRoot, 'blobs'), { recursive: true });
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY,setting_value TEXT,updated_at TEXT DEFAULT (datetime('now')))");
  ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
  const archive = createArchiveRepository(db); archive.ensureSchema();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const book = XLSX.utils.book_new();
  const add = (name, type, rows) => {
    const headers = type === T.SYSTEM_OP ? SYSTEM_OP_HEADERS : getSourceDefinition(type).headers;
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((h) => row[h] ?? ''))], writeOptions), name);
  };
  add('充值', T.RECHARGE, subjects.map((subject) => ({ 订单号: `0001-${subject}`, BillDate: '2026-06-01', 公司主体: subject,
    业务部门: 'VCC', 对手部门: 'OPS', 业务子类型: '充值', 出入方向: 'in', 我方币种: 'USD', 我方到账金额: '10.25' })));
  add('费用', T.FEE_FX, subjects.map((subject) => ({ 订单号: `fee-${subject}`, BillDate: '2026-06-01', 公司主体: subject,
    业务部门: 'VCC', 对手部门: 'OPS', 业务子类型: '手续费', 出入方向: 'out', 我方币种: 'USD', 我方到账金额: '2' })));
  for (const subject of subjects) add(subject, T.CHANNEL, [{ 渠道订单号: `channel-${subject}`, 账单日期: '2026-06-01',
    通道名称: 'CITI', MID: '000009876543210', 交易金额: '3', 交易币种: 'EUR', 借贷方向: 'in' }]);
  add('Pending', T.PENDING, subjects.map((subject) => ({ PendingBizId: `pending-${subject}`, 平账账期: '2026-06', 主体: subject,
    对账类型: 'VCC_clearing_credit', 金额: '5', 币种: 'USD', 流水_币种: pendingSameCurrency ? 'USD' : 'EUR', 流水_对账金额: '5',
    channel: 'CITI', 备注: pendingRemark, merchant_id: '00000000000000001' })));
  add('系统 OP', T.SYSTEM_OP, subjects.flatMap((subject) => CURRENCIES.map((币种) => ({ 账单日期: systemBillDate,
    主体: subject, 业务部门: 'VCC', 币种, 财务余额: '0', 财务主体余额: '0', 创建时间: '2026-07-01 00:00:00' }))));
  const filePath = path.join(dir, '全部主体.xlsx'); XLSX.writeFile(book, filePath, writeOptions);
  if (beforeImport) await beforeImport(filePath);
  const plan = await inspectWorkbookImportPlan([filePath]);
  const files = buildMemberFiles(resolveImportPlan(plan, { planId: plan.planId,
    subjectBySourceId: Object.fromEntries(plan.sources.filter((s) => s.requiresSubject).map((s) => [s.sourceId, s.sheetName])), excludedSheetIds: [] }));
  const taskRunId = 'review-input-task';
  const batch = archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
    localDate: '2026-09-18', retentionUntil: '2026-11-17' }).batch;
  db.prepare('UPDATE archive_batches SET task_run_id=?,task_key=? WHERE id=?').run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
  for (const file of files) {
    const relativePath = `blobs/${file.sha256}`; fs.copyFileSync(file.filePath, path.join(archiveRoot, relativePath));
    const artifact = archive.addArtifact(batch.id, { artifactKey: 'input:0', direction: 'input', role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath, metadata: handoffMetadata(file, taskRunId) });
    archive.startArtifactAttempt(artifact.id);
    archive.completeArtifact(artifact.id, { sha256: file.sha256, sizeBytes: file.sizeBytes, relativePath,
      fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } });
    file.archiveArtifactId = artifact.id;
  }
  const imported = await importFiles({ db, targetMonth: '2026-06', batchId: taskRunId, files,
    archiveHandoffFiles: { version: 2, taskRunId, files } });
  if (imported.records.some((r) => r.status !== 'success')) throw new Error(JSON.stringify(imported));
  db.prepare("UPDATE vcc_fin_op_module_state SET first_month='2026-05' WHERE singleton_id=1").run();
  const previousRun = db.prepare("INSERT INTO vcc_fin_op_runs(target_month,status,input_revisions_json) VALUES ('2026-05','archived','{}')").run().lastInsertRowid;
  for (const subject of subjects) db.prepare("INSERT INTO vcc_fin_op_archives(target_month,subject,balances_json,run_id) VALUES ('2026-05',?,?,?)")
    .run(subject, JSON.stringify(Object.fromEntries(CURRENCIES.map((c) => [c, '0']))), previousRun);
  const preflight = preflightCalculation(db, '2026-06');
  if (!preflight.ok) throw new Error(JSON.stringify(preflight));
  const calculated = calculateMonth({ db, targetMonth: '2026-06', expectedInputFingerprint: preflight.inputFingerprint });
  const run = db.prepare("SELECT * FROM vcc_fin_op_runs WHERE target_month='2026-06'").get();
  if (!run || calculated.status !== 'calculated') throw new Error(JSON.stringify(calculated));
  return { dir, dbPath, db, archive, archiveRoot, files, filePath, subjects, run, imported,
    assetsDir: path.resolve(__dirname, '../../assets'),
    request: { runId: Number(run.id), expectedResultRevision: Number(run.result_revision), expectedInputFingerprint: run.input_fingerprint } };
}
module.exports = { createReviewFixture, T, CURRENCIES };
