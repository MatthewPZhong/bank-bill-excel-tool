'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { withBoundedWorkbook } = require('../../src/main-process/bounded-xlsx-writer');
const { SOURCE_TYPES: T, SUPPORTED_CURRENCIES: CURRENCIES, SYSTEM_OP_HEADERS, getSourceDefinition } = require('../../src/backend/vcc-financial-op/definitions');
const { inspectWorkbookImportPlan, resolveImportPlan } = require('../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, handoffMetadata } = require('../../src/backend/vcc-financial-op/import-handoff');
const { createArchiveRepository } = require('../../src/backend/database/archive-repository');
const { importFiles } = require('../../src/backend/vcc-financial-op/import-service');
const { ensureVccFinancialOpTablesSupport } = require('../../src/backend/vcc-financial-op-db/migrations');
const { preflightCalculation, calculateMonth } = require('../../src/backend/vcc-financial-op/calculator');
const { listAdjustmentOptions, getEffectiveRunResult } = require('../../src/backend/vcc-financial-op/result-adjustments');
const MAX_ROWS = 1048575;
function caseSpec(name) {
  if (name === 'pf01-100k') return { subjects: 2, pending: 100000, recharge: 12, adjustments: 0 };
  if (name === 'pf01-1m' || name === 'pf04') return { subjects: 2, pending: 1000000, recharge: 12, adjustments: 0 };
  if (name === 'pf02') return { subjects: 1, pending: 1, recharge: 1048576, adjustments: 0 };
  if (name === 'pf03') return { subjects: 200, pending: 200, recharge: 1200, adjustments: 10000 };
  if (name.startsWith('cancel-')) return { subjects: 2, pending: 10000, recharge: 12, adjustments: 4 };
  return { subjects: 2, pending: 8, recharge: 12, adjustments: 4 };
}
async function createPerformanceFixture(directory, name, buildSha) {
  const spec = caseSpec(name), subjects = Array.from({ length: spec.subjects }, (_, n) => `主体${String(n + 1).padStart(3, '0')}-长名称用于验证截断与重名哈希保存全部语义`);
  const dbPath = path.join(directory, 'business.sqlite'), archiveRoot = path.join(directory, 'archive');
  fs.mkdirSync(path.join(archiveRoot, 'blobs'), { recursive: true });
  const filePath = path.join(directory, '多工作表性能合成样本.xlsx');
  await withBoundedWorkbook({ filePath }, async (session) => {
    async function add(baseName, type, count, valueAt) {
      const headers = type === T.SYSTEM_OP ? SYSTEM_OP_HEADERS : getSourceDefinition(type).headers;
      for (let start = 0, part = 1; start < count; start += MAX_ROWS, part += 1) {
        const sheet = session.addWorksheet(`${baseName}-${part}`);
        await session.commitRow(sheet.addRow(headers));
        for (let index = start; index < Math.min(start + MAX_ROWS, count); index += 1) {
          const values = valueAt(index); const row = sheet.addRow(headers.map((h) => values[h] ?? ''));
          row.eachCell((cell) => { cell.numFmt = '@'; }); await session.commitRow(row);
        }
        await session.commitSheet(sheet);
      }
    }
    await add('充值', T.RECHARGE, spec.recharge, (n) => ({ 订单号: `0000000000000000000000R${String(n).padStart(10, '0')}`,
      BillDate: '2026-06-01', 公司主体: subjects[name === 'pf02' ? 0 : Math.floor(n / 6)], 业务部门: 'VCC', 对手部门: 'OPS',
      业务子类型: name === 'pf02' ? '充值' : `充值分类${n % 6}`, 出入方向: 'in', 我方币种: 'USD', 我方到账金额: '10.25', 备注: `=1+1 唯一备注 ${n}` }));
    await add('费用', T.FEE_FX, subjects.length, (n) => ({ 订单号: `fee-${n}`, BillDate: '2026-06-01', 公司主体: subjects[n],
      业务部门: 'VCC', 对手部门: 'OPS', 业务子类型: '手续费', 出入方向: 'out', 我方币种: 'USD', 我方到账金额: '2' }));
    for (let n = 0; n < subjects.length; n += 1) await add(`C${n}`, T.CHANNEL, 1, () => ({ 渠道订单号: `channel-${n}`,
      账单日期: '2026-06-01', 通道名称: 'CITI', MID: '000009876543210', 交易金额: '3', 交易币种: 'EUR', 借贷方向: 'in' }));
    await add('Pending', T.PENDING, spec.pending, (n) => ({ PendingBizId: `0000000000000000000000P${String(n).padStart(10, '0')}`,
      平账账期: '2026-06', 主体: subjects[n % subjects.length], 对账类型: 'VCC_clearing_credit', 金额: '5', 币种: 'USD',
      流水_币种: 'EUR', 流水_对账金额: '5', channel: 'CITI', 备注: `=1+1 唯一长文本 ${n} ${'文本'.repeat(20)}`, merchant_id: `00000000000000000${n}` }));
    await add('系统OP', T.SYSTEM_OP, subjects.length * CURRENCIES.length, (n) => ({ 账单日期: '2026-06-30',
      主体: subjects[Math.floor(n / CURRENCIES.length)], 业务部门: 'VCC', 币种: CURRENCIES[n % CURRENCIES.length],
      财务余额: '0', 财务主体余额: '0', 创建时间: '2026-07-01 00:00:00' }));
    return {};
  });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT,updated_at TEXT DEFAULT (datetime('now')))");
    ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    const archive = createArchiveRepository(db); archive.ensureSchema();
    const plan = await inspectWorkbookImportPlan([filePath]);
    const files = buildMemberFiles(resolveImportPlan(plan, { planId: plan.planId, excludedSheetIds: [], subjectBySourceId:
      Object.fromEntries(plan.sources.filter((s) => s.requiresSubject).map((s) => [s.sourceId, subjects[Number(/^C(\d+)-/.exec(s.sheetName)[1])]])) }));
    const taskRunId = 'performance-synthetic-input';
    const batch = archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
      operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
      localDate: '2026-09-19', retentionUntil: '2026-11-18' }).batch;
    db.prepare('UPDATE archive_batches SET task_run_id=?,task_key=? WHERE id=?').run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
    for (const file of files) {
      const relativePath = `blobs/${file.sha256}`; fs.copyFileSync(file.filePath, path.join(archiveRoot, relativePath));
      const artifact = archive.addArtifact(batch.id, { artifactKey: 'input:0', direction: 'input', role: 'input',
        sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath, metadata: handoffMetadata(file, taskRunId) });
      archive.startArtifactAttempt(artifact.id); archive.completeArtifact(artifact.id, { sha256: file.sha256, sizeBytes: file.sizeBytes,
        relativePath, fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } }); file.archiveArtifactId = artifact.id;
    }
    const imported = await importFiles({ db, targetMonth: '2026-06', batchId: taskRunId, files, archiveHandoffFiles: { version: 2, taskRunId, files } });
    assert.ok(imported.records.every((r) => r.status === 'success'), JSON.stringify(imported));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_effective_rows').get().n, spec.recharge + subjects.length * 2 + spec.pending);
    db.prepare("UPDATE vcc_fin_op_module_state SET first_month='2026-05' WHERE singleton_id=1").run();
    const previousRun = db.prepare("INSERT INTO vcc_fin_op_runs(target_month,status,input_revisions_json) VALUES ('2026-05','archived','{}')").run().lastInsertRowid;
    for (const subject of subjects) db.prepare("INSERT INTO vcc_fin_op_archives(target_month,subject,balances_json,run_id) VALUES ('2026-05',?,?,?)")
      .run(subject, JSON.stringify(Object.fromEntries(CURRENCIES.map((c) => [c, '0']))), previousRun);
    const preflight = preflightCalculation(db, '2026-06'); assert.equal(preflight.ok, true, JSON.stringify(preflight));
    assert.equal(calculateMonth({ db, targetMonth: '2026-06', expectedInputFingerprint: preflight.inputFingerprint }).status, 'calculated');
    const run = db.prepare("SELECT * FROM vcc_fin_op_runs WHERE target_month='2026-06'").get();
    // Persist synthetic saved adjustments directly; production getEffectiveRunResult validates all
    // coordinates, metadata, canonical amounts, sequence and result revision before export.
    // This avoids measuring the unrelated per-click adjustment command 10,000 times.
    if (spec.adjustments) {
      const options = listAdjustmentOptions(db, run.id).options; let sequence = 0;
      const insert = db.prepare('INSERT INTO vcc_fin_op_run_adjustments(run_id,row_key,subject,source_type,category_major,category_minor,currency,adjustment_amount,reason,sequence,created_app_version,created_build_sha) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      db.exec('BEGIN');
      for (const subject of subjects) {
        let perSubject = 0;
        for (const option of options.filter((o) => o.subject === subject)) {
          for (const currency of CURRENCIES) {
            if (perSubject >= spec.adjustments / subjects.length) break;
            sequence += 1; perSubject += 1;
            insert.run(run.id, option.rowKey, subject, option.sourceType, option.categoryMajor, option.categoryMinor,
              currency, '0.01', `调整 ${sequence} ${'人工核对长原因；'.repeat(20)}`, sequence, '3.2.9', buildSha);
          }
        }
      }
      assert.equal(sequence, spec.adjustments);
      db.prepare('UPDATE vcc_fin_op_runs SET result_revision=? WHERE id=?').run(sequence, run.id); db.exec('COMMIT');
    }
    const effective = getEffectiveRunResult(db, run.id); assert.equal(effective.adjustments.length, spec.adjustments);
    const current = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id=?').get(run.id);
    return { directory, dbPath, archiveRoot, filePath, spec, subjects, physicalFiles: files.length, inputBytes: fs.statSync(filePath).size,
      inputSha256: files[0].sha256, inputSheetCount: plan.sources.length,
      request: { runId: Number(run.id), expectedResultRevision: Number(current.result_revision), expectedInputFingerprint: current.input_fingerprint } };
  } finally { db.close(); }
}
module.exports = { createPerformanceFixture, caseSpec };
