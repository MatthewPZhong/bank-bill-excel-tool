// VCC 财务OP历史月份模板导出链（真实文件 SQLite + 金标准模板 + Excel 回读）
//
// 覆盖：
//   1. 两个一致归档月份按倒序枚举，显式选择旧月份不回退到 latest；
//   2. 历史 run 的生效调整、汇总、样式模板和 named-range 血缘写入同一结果表；
//   3. Excel 回读金额与目标 run 保持一致，证明 targetMonth → runId 血缘未串月。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../src/backend/vcc-financial-op-db/migrations');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  PENDING_HEADERS
} = require('../../src/backend/vcc-financial-op/definitions');
const {
  REQUIRED_DATASET_TYPES,
  preflightCalculation
} = require('../../src/backend/vcc-financial-op/calculator');
const {
  buildRunRowKey
} = require('../../src/backend/vcc-financial-op/result-adjustments');
const {
  previewUnarchive: previewLegacyUnarchive
} = require('../../src/backend/vcc-financial-op/unarchive');
const {
  parseAdjustmentLineageName
} = require('../../src/backend/vcc-financial-op/adjustment-lineage');
const {
  RESULT_SHEET_NAME,
  PENDING_SHEET_NAME
} = require('../../src/main-process/vcc-financial-op-writer');
const {
  createVccFinancialOpService
} = require('../../src/main-process/vcc-financial-op-service');

const HISTORICAL_MONTH = '2026-05';
const LATEST_MONTH = '2026-06';
const SUBJECT = 'PPHK';

let passed = 0;
const failures = [];

function printable(value) {
  try { return JSON.stringify(value); } catch (_error) { return String(value); }
}

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(
    Object.is(actual, expected),
    label,
    `expected=${printable(expected)} actual=${printable(actual)}`
  );
}

function archivedBalances(usd) {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
    currency,
    currency === 'USD' ? usd : '100'
  ]));
}

function seedPreflightFacts(db, targetMonth, systemUsd) {
  const batchId = `historical-export-input-${targetMonth}`;
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at, finished_at
    ) VALUES (?, ?, 'success', 5, '2026-08-01 08:00:00', '2026-08-01 08:05:00')
  `).run(batchId, targetMonth);
  const insertRecord = db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, started_at, finished_at
    ) VALUES (?, ?, ?, ?, 'success', 1, 1,
              '2026-08-01 08:00:00', '2026-08-01 08:05:00')
  `);
  const detailTypes = [
    SOURCE_TYPES.RECHARGE,
    SOURCE_TYPES.FEE_FX,
    SOURCE_TYPES.CHANNEL,
    SOURCE_TYPES.PENDING
  ];
  for (const sourceType of detailTypes) {
    const sourceFile = `${targetMonth}-${sourceType}.xlsx`;
    const key = `${targetMonth}-${sourceType}-preflight`;
    const recordId = Number(insertRecord.run(
      batchId,
      targetMonth,
      sourceType,
      JSON.stringify([sourceFile])
    ).lastInsertRowid);
    const pending = sourceType === SOURCE_TYPES.PENDING;
    db.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key_raw, idempotency_key, content_hash,
        hash_version, raw_contract_version, target_month, subject,
        stat_currency, signed_amount, business_sub_type, counterparty_department,
        channel_name, mid, recon_type, pending_currency, pending_amount,
        flow_currency, flow_amount, currency_mismatch,
        source_file, sheet_name, source_row, raw_json, import_record_id
      ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, 'Sheet1', 2, ?, ?)
    `).run(
      sourceType,
      key,
      key,
      `hash-${key}`,
      pending ? 2 : 1,
      targetMonth,
      SUBJECT,
      pending ? null : 'USD',
      pending ? null : '0',
      sourceType === SOURCE_TYPES.RECHARGE ? '充值' : '',
      sourceType === SOURCE_TYPES.RECHARGE ? 'OPS' : '',
      sourceType === SOURCE_TYPES.CHANNEL || pending ? 'CITI' : '',
      sourceType === SOURCE_TYPES.CHANNEL ? 'MID-1' : '',
      pending ? 'normal' : null,
      pending ? 'USD' : null,
      pending ? '0' : null,
      pending ? 'USD' : null,
      pending ? '0' : null,
      pending ? 0 : null,
      sourceFile,
      pending ? JSON.stringify(PENDING_HEADERS.map(() => '')) : '[]',
      recordId
    );
  }

  const systemFile = `${targetMonth}-${SOURCE_TYPES.SYSTEM_OP}.xlsx`;
  const systemRecordId = Number(insertRecord.run(
    batchId,
    targetMonth,
    SOURCE_TYPES.SYSTEM_OP,
    JSON.stringify([systemFile])
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, 'Validate', 3, '{}', ?)
  `).run(
    targetMonth,
    SUBJECT,
    JSON.stringify(archivedBalances(systemUsd)),
    `system-hash-${targetMonth}`,
    systemFile,
    systemRecordId
  );
}

function seedArchivedRun(db, targetMonth, {
  usdPeriod,
  usdCalculated,
  usdSystem,
  adjustmentAmount = null
}) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, 'archived', ?, ?, ?,
              '2026-08-01 08:30:00', '2026-08-01 09:00:00', '2026-08-01 09:30:00')
  `).run(
    targetMonth,
    JSON.stringify(Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]))),
    adjustmentAmount === null ? 0 : 1,
    'b'.repeat(64)
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, 'movement', ?, 'VCC_discharge', 'B2B', 'USD', ?)
  `).run(runId, SUBJECT, SOURCE_TYPES.RECHARGE, usdPeriod);

  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const isUsd = currency === 'USD';
    insertBalance.run(
      runId,
      SUBJECT,
      currency,
      isUsd ? usdPeriod : '0',
      isUsd ? usdCalculated : '100',
      isUsd ? usdSystem : '100',
      isUsd ? String(Number(usdSystem) - Number(usdCalculated)) : '0'
    );
  }

  let rowKey = null;
  if (adjustmentAmount !== null) {
    rowKey = buildRunRowKey({
      rowKind: 'movement',
      subject: SUBJECT,
      sourceType: SOURCE_TYPES.RECHARGE,
      categoryMajor: 'VCC_discharge',
      categoryMinor: 'B2B'
    });
    db.prepare(`
      INSERT INTO vcc_fin_op_run_adjustments (
        run_id, row_key, subject, source_type, category_major, category_minor,
        currency, adjustment_amount, reason, sequence,
        created_app_version, created_build_sha
      ) VALUES (?, ?, ?, ?, 'VCC_discharge', 'B2B',
                'USD', ?, '历史月份人工核对', 1, '3.1.8', 'historical-fixture')
    `).run(runId, rowKey, SUBJECT, SOURCE_TYPES.RECHARGE, adjustmentAmount);
  }

  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, ?, 'CITI', 0, 'USD', 'USD', 'normal', '1', '1')
  `).run(runId, SUBJECT);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, ?, 'USD', '0')
  `).run(runId, SUBJECT);

  const effectiveUsd = String(Number(usdCalculated) + Number(adjustmentAmount || '0'));
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES (?, ?, ?, ?, '2026-08-01 09:30:00')
  `).run(targetMonth, SUBJECT, JSON.stringify(archivedBalances(effectiveUsd)), runId);
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id, revision,
      generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, 1,
              '2026-08-01 08:20:00', '2026-08-01 09:30:00')
  `);
  for (const sourceType of REQUIRED_DATASET_TYPES) {
    insertDataset.run(targetMonth, sourceType, runId);
  }
  return { runId, rowKey, effectiveUsd };
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-historical-template-export-'));
  const dbPath = path.join(tempDir, 'tool-data.sqlite');
  const outputPath = path.join(tempDir, 'historical-result.xlsx');
  let db = null;
  let service = null;
  console.log('==== VCC 财务OP历史月份模板导出链 ====' );
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    ensureVccFinancialOpTablesSupport(db);
    const historical = seedArchivedRun(db, HISTORICAL_MONTH, {
      usdPeriod: '10',
      usdCalculated: '110',
      usdSystem: '111',
      adjustmentAmount: '1'
    });
    const latest = seedArchivedRun(db, LATEST_MONTH, {
      usdPeriod: '20',
      usdCalculated: '120',
      usdSystem: '120'
    });
    seedPreflightFacts(db, LATEST_MONTH, '120');
    db.prepare(`
      UPDATE vcc_fin_op_module_state
      SET first_month = ?, updated_at = '2026-08-01 08:10:00'
      WHERE singleton_id = 1
    `).run(HISTORICAL_MONTH);
    service = createVccFinancialOpService({
      database: { db, dbPath },
      assetsDir: path.resolve(__dirname, '../../assets')
    });

    const months = await service.listArchivedResultMonths();
    assertEq(months.length, 2, '两个一致归档月份均可导出');
    assertEq(months[0].targetMonth, LATEST_MONTH, '归档月份默认按 latest 倒序展示');
    assertEq(months[0].runId, latest.runId, 'latest 月份指向 latest run');
    assertEq(months[1].targetMonth, HISTORICAL_MONTH, '旧月份仍保留为显式候选');

    const exported = await service.exportRun({
      targetMonth: HISTORICAL_MONTH,
      outputPath
    });
    assertEq(exported.runId, historical.runId, '历史 targetMonth 严格解析为历史 runId');
    assertEq(exported.targetMonth, HISTORICAL_MONTH, '导出返回历史目标月份');
    assertTrue(exported.runId !== latest.runId, '历史导出没有回退到 latest run');
    assertEq(exported.filePaths[0], outputPath, '单主体导出发布到明确目标路径');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assertEq(workbook.worksheets[0].name, RESULT_SHEET_NAME, '结果表保持模板目标 sheet 名');
    assertEq(workbook.worksheets[1].name, PENDING_SHEET_NAME, 'Pending 表保持第二 sheet');
    const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
    const movementRow = sheet.getColumn(2).values.findIndex((value) => value === 'VCC_discharge');
    const adjustmentRow = movementRow + 1;
    const calculatedRow = sheet.getColumn(2).values.findIndex((value) => value === '当月计算财务OP');
    const systemRow = sheet.getColumn(2).values.findIndex((value) => value === '当月系统财务OP');
    const differenceRow = sheet.getColumn(2).values.findIndex((value) => value === '差异');
    assertEq(sheet.getCell(adjustmentRow, 13).value, 1, '历史调整值写入 M 列');
    assertEq(sheet.getCell(adjustmentRow, 14).value, '历史月份人工核对', '历史调整原因写入 N 列');
    assertEq(sheet.getCell(calculatedRow, 12).value, 111, '历史生效计算余额包含调整');
    assertEq(sheet.getCell(systemRow, 12).value, 111, '历史系统余额来自目标 run');
    assertEq(sheet.getCell(differenceRow, 12).value, 0, '历史生效差异归零');
    assertEq(sheet.pageSetup.printArea, `A1:L${differenceRow}`, '动态打印区覆盖历史结果末行');
    assertEq(
      parseAdjustmentLineageName(sheet.getCell(adjustmentRow, 13).names[0]).rowKey,
      historical.rowKey,
      'defined name 可还原历史调整 rowKey'
    );

    // B/C1 中间分支只保留 v1 preview 作为旧 write 实现证据；生产入口已切 v2 并安全拒绝。
    const latestPreview = previewLegacyUnarchive(db, LATEST_MONTH, {
      taskGeneration: service._taskStateForTests().taskGeneration
    });
    assertEq(latestPreview.canUnarchive, true, 'latest 月份可通过真实状态预检解归档');
    const unarchived = await service.unarchiveMonth({
      targetMonth: LATEST_MONTH,
      expectedPreviewToken: latestPreview.previewToken,
      taskGeneration: latestPreview.taskGeneration
    });
    assertEq(unarchived.status, 'unarchived', 'latest 月份通过真实 worker 原子解归档');
    const afterUnarchive = await service.listArchivedResultMonths();
    assertEq(afterUnarchive.length, 1, '解归档后月份立即从可导出枚举消失');
    assertEq(afterUnarchive[0].targetMonth, HISTORICAL_MONTH, '解归档后仅保留仍一致归档的历史月份');

    const removedOutputPath = path.join(tempDir, 'removed-month-result.xlsx');
    let removedExportError = null;
    try {
      await service.exportRun({
        targetMonth: LATEST_MONTH,
        outputPath: removedOutputPath
      });
    } catch (error) {
      removedExportError = error;
    }
    assertEq(
      removedExportError && removedExportError.code,
      'no-archived-results',
      '解归档月份立即禁止再次导出'
    );
    assertEq(fs.existsSync(removedOutputPath), false, '禁止导出不会创建目标文件');

    const rearchivePreflight = preflightCalculation(db, LATEST_MONTH);
    assertEq(rearchivePreflight.ok, true, '重新归档前五表与上月归档预检通过');
    db.prepare(`
      UPDATE vcc_fin_op_runs
      SET input_fingerprint = ?, input_revisions_json = ?
      WHERE id = ?
    `).run(
      rearchivePreflight.inputFingerprint,
      JSON.stringify(rearchivePreflight.revisions),
      latest.runId
    );
    const rearchivePreview = await service.getRunResult(latest.runId);
    const rearchived = await service.archive({
      runId: latest.runId,
      expectedResultRevision: 0,
      expectedPreviewToken: rearchivePreview.previewTokens.archive,
      taskGeneration: rearchivePreview.taskGeneration
    });
    assertEq(rearchived.status, 'archived', '解归档结果可经正式 service 重新归档');
    const rearchivedResult = await service.getRunResult(latest.runId);
    assertEq(rearchivedResult.status, 'archived', '重新归档后通过正式只读入口 refetch 最新结果');
    const afterRearchive = await service.listArchivedResultMonths();
    assertEq(afterRearchive.length, 2, '重新归档后月份重新进入可导出枚举');
    assertEq(afterRearchive[0].targetMonth, LATEST_MONTH, '重新归档月份恢复为默认 latest');
    assertEq(
      (await service.getArchivedRunByMonth(LATEST_MONTH)).runId,
      latest.runId,
      '重新归档月份恢复严格导出 resolver'
    );
  } catch (error) {
    failures.push({ label: '集成链未捕获异常', detail: error && error.stack || String(error) });
  } finally {
    if (service) {
      try { await service.terminate(); } catch (_error) { /* 测试清理 */ }
    }
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('FAILURES');
    failures.forEach((failure) => console.error(`- ${failure.label}: ${failure.detail}`));
    process.exitCode = 1;
    return;
  }
  console.log(`==== ${passed}/${passed} PASS ====`);
}

run();
