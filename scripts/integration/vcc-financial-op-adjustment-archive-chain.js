// VCC 财务OP结果调整、归档导出与跨月继承链集成验证（真实文件 SQLite + 真实 worker）
//
// 覆盖：
//   1. 首月真实计算后新增调整，revision 与创建版本元数据原子落库；
//   2. 关闭并重新打开数据库后，调整仍紧邻目标基础行展示且生效汇总不漂移；
//   3. 归档写入九币种生效余额，并固化含调整事实的完整审计证据；
//   4. 归档月份经正式 resolver 导出，重新打开 Excel 后逐字段核对生效 DTO 与调整血缘；
//   5. 次月真实计算从上月归档生效值继承期初，验证跨月余额血缘；
//   6. stale revision 与已归档结果修改均 fail closed。
//
// 用法：node scripts/integration/vcc-financial-op-adjustment-archive-chain.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  PENDING_HEADERS
} = require('../../src/backend/vcc-financial-op/definitions');
const {
  REQUIRED_DATASET_TYPES
} = require('../../src/backend/vcc-financial-op/calculator');
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

const M1 = '2026-05';
const M2 = '2026-06';
const SUBJECT = 'PPHK';
const APP_VERSION = '3.1.8';
const BUILD_SHA = 'adjustment-archive-integration-sha';
const ADJUSTMENT_REASON =
  '系统外核对_x000D_补记；大小写_X000d_；字面_x005F_x000D_；真实CRLF\r\n下一行；普通😀中文';

let passed = 0;
let failed = 0;
const failures = [];
let lifecycleBatchSequence = 0;

function createBatchContext(taskKey) {
  lifecycleBatchSequence += 1;
  return Object.freeze({
    batchId: lifecycleBatchSequence,
    batchNumber: `integration-${lifecycleBatchSequence}`,
    taskRunId: `integration-task-${lifecycleBatchSequence}`,
    taskKey,
    moduleId: 'vcc-financial-op',
    parentRunId: `integration-parent-${lifecycleBatchSequence}`,
    operationKey: `${taskKey}:integration-${lifecycleBatchSequence}`
  });
}

function printable(value) {
  try { return JSON.stringify(value); } catch (_error) { return String(value); }
}

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(
    Object.is(actual, expected),
    label,
    `expected=${printable(expected)} actual=${printable(actual)}`
  );
}

function assertDeepEq(actual, expected, label) {
  const actualJson = printable(actual);
  const expectedJson = printable(expected);
  assertTrue(actualJson === expectedJson, label, `expected=${expectedJson} actual=${actualJson}`);
}

async function expectCode(action, expectedCode, expectedMessage, label) {
  try {
    await action();
    assertTrue(false, label, `expected error ${expectedCode}: ${expectedMessage}`);
    return null;
  } catch (error) {
    assertTrue(
      error && error.code === expectedCode && error.message === expectedMessage,
      label,
      `expected=${expectedCode}/${expectedMessage} actual=${error && error.code}/${error && error.message}`
    );
    return error;
  }
}

function fixedBalances(value = '100', overrides = {}) {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
    currency,
    Object.hasOwn(overrides, currency) ? overrides[currency] : value
  ]));
}

function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;
  `);
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

function createSuccessfulRecord(db, targetMonth, sourceType) {
  const batchId = `adjustment-chain-${targetMonth}-${sourceType}`;
  const sourceFile = `${targetMonth}-${sourceType}.xlsx`;
  repository.createImportBatch(db, { id: batchId, targetMonth, fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth,
    sourceType,
    sourceFiles: [sourceFile]
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success',
    rawCount: 1,
    insertedCount: 1
  });
  repository.finishImportBatch(db, batchId, 'success');
  return { recordId, sourceFile };
}

function insertEffectiveRow(db, targetMonth, fields) {
  const { recordId, sourceFile } = createSuccessfulRecord(
    db,
    targetMonth,
    fields.sourceType
  );
  const rawJson = fields.sourceType === SOURCE_TYPES.PENDING
    ? JSON.stringify(PENDING_HEADERS.map(() => ''))
    : '[]';
  const key = `${targetMonth}-${fields.sourceType}`;
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      business_sub_type, counterparty_department, channel_name, mid,
      recon_type, pending_currency, pending_amount, flow_currency, flow_amount,
      currency_mismatch, source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sheet1', 2, ?, ?)
  `).run(
    fields.sourceType,
    key,
    key,
    `fixture-hash-${key}`,
    targetMonth,
    SUBJECT,
    fields.statCurrency || null,
    fields.signedAmount || null,
    fields.businessSubType || '',
    fields.counterpartyDepartment || '',
    fields.channelName || '',
    fields.mid || '',
    fields.reconType || null,
    fields.pendingCurrency || null,
    fields.pendingAmount || null,
    fields.flowCurrency || null,
    fields.flowAmount || null,
    fields.currencyMismatch ?? null,
    sourceFile,
    rawJson,
    recordId
  );
}

function seedMonth(db, targetMonth, systemBalances) {
  insertEffectiveRow(db, targetMonth, {
    sourceType: SOURCE_TYPES.RECHARGE,
    statCurrency: 'USD',
    signedAmount: '10',
    businessSubType: '充值',
    counterpartyDepartment: 'OPS'
  });
  insertEffectiveRow(db, targetMonth, {
    sourceType: SOURCE_TYPES.FEE_FX,
    statCurrency: 'USD',
    signedAmount: '-2',
    businessSubType: '手续费'
  });
  insertEffectiveRow(db, targetMonth, {
    sourceType: SOURCE_TYPES.CHANNEL,
    statCurrency: 'EUR',
    signedAmount: '3',
    channelName: 'CITI',
    mid: 'MID-1'
  });
  insertEffectiveRow(db, targetMonth, {
    sourceType: SOURCE_TYPES.PENDING,
    reconType: 'VCC_clearing_credit',
    pendingCurrency: 'USD',
    pendingAmount: '-5',
    flowCurrency: 'EUR',
    flowAmount: '5',
    currencyMismatch: 1,
    channelName: 'CITI'
  });

  const systemRecord = createSuccessfulRecord(db, targetMonth, SOURCE_TYPES.SYSTEM_OP);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, 'Validate', 3, '{}', ?)
  `).run(
    targetMonth,
    SUBJECT,
    JSON.stringify(systemBalances),
    `system-hash-${targetMonth}`,
    systemRecord.sourceFile,
    systemRecord.recordId
  );

  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, revision
    ) VALUES (?, ?, 'unprocessed', 1)
  `);
  for (const sourceType of REQUIRED_DATASET_TYPES) insertDataset.run(targetMonth, sourceType);

  // 直接 SQL fixture 也走与正式启动相同的 Pending v2 幂等迁移。
  ensureVccFinancialOpTablesSupport(db);
}

function balanceOf(result, currency) {
  return result.balances.find((row) => row.subject === SUBJECT && row.currency === currency);
}

function operationAudit(db, targetMonth, operationType) {
  return db.prepare(`
    SELECT status, evidence_json, app_version, build_sha
    FROM vcc_fin_op_operation_audit
    WHERE target_month = ? AND operation_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(targetMonth, operationType) || null;
}

function assertCurrencyCells(sheet, rowNumber, amounts, label) {
  SUPPORTED_CURRENCIES.forEach((currency, index) => {
    const expected = Number(amounts && amounts[currency] != null ? amounts[currency] : 0);
    assertEq(
      sheet.getCell(rowNumber, index + 4).value,
      expected,
      `${label} ${currency} 回读值与生效 DTO 一致`
    );
  });
}

function assertExportMatchesEffectiveResult(workbook, effectiveResult, archivedBalances) {
  assertEq(workbook.worksheets.length, 2, '归档导出只包含结果表与 Pending 计算表');
  assertEq(workbook.worksheets[0].name, RESULT_SHEET_NAME, '归档导出首个 sheet 为结果表');
  assertEq(workbook.worksheets[1].name, PENDING_SHEET_NAME, '归档导出第二个 sheet 为 Pending 计算表');

  const review = effectiveResult.review.subjects.find((item) => item.subject === SUBJECT);
  const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  const expectedRows = [
    {
      type: 'opening',
      major: '上月财务OP',
      minor: '',
      amounts: review.summaries.openingBalance
    },
    ...review.rows.map((row) => ({
      ...row,
      major: row.categoryMajor,
      minor: row.categoryMinor,
      amounts: row.currencyAmounts
    })),
    {
      type: 'calculated',
      major: '当月计算财务OP',
      minor: '',
      amounts: review.summaries.effectiveCalculatedBalance
    },
    {
      type: 'system',
      major: '当月系统财务OP',
      minor: '',
      amounts: review.summaries.systemBalance
    },
    {
      type: 'difference',
      major: '差异',
      minor: '',
      amounts: review.summaries.effectiveDifference
    }
  ];

  assertEq(sheet.actualRowCount, expectedRows.length + 1, 'Excel 结果行数与生效 DTO 完全一致');
  expectedRows.forEach((row, index) => {
    const rowNumber = index + 2;
    assertEq(sheet.getCell(rowNumber, 1).value, SUBJECT, `Excel 第 ${rowNumber} 行主体一致`);
    assertEq(sheet.getCell(rowNumber, 2).value, row.major, `Excel 第 ${rowNumber} 行大类一致`);
    if (row.minor) {
      assertEq(sheet.getCell(rowNumber, 3).value, row.minor, `Excel 第 ${rowNumber} 行小类一致`);
    }
    assertCurrencyCells(sheet, rowNumber, row.amounts, `Excel 第 ${rowNumber} 行`);

    if (row.type === 'adjustment') {
      assertEq(
        sheet.getCell(rowNumber, 13).value,
        Number(row.adjustmentAmount),
        `Excel 第 ${rowNumber} 行调整值一致`
      );
      assertEq(
        sheet.getCell(rowNumber, 14).value,
        row.reason,
        `Excel 第 ${rowNumber} 行调整原因一致`
      );
      const lineageNames = sheet.getCell(rowNumber, 13).names;
      assertEq(lineageNames.length, 1, `Excel 第 ${rowNumber} 行调整血缘唯一`);
      const lineage = parseAdjustmentLineageName(lineageNames[0]);
      assertEq(lineage && lineage.rowKey, row.rowKey, `Excel 第 ${rowNumber} 行血缘 rowKey 一致`);
      assertEq(lineage && lineage.currency, row.currency, `Excel 第 ${rowNumber} 行血缘币种一致`);
    } else {
      assertEq(sheet.getCell(rowNumber, 13).value, null, `Excel 第 ${rowNumber} 行没有伪调整值`);
      assertEq(sheet.getCell(rowNumber, 14).value, null, `Excel 第 ${rowNumber} 行没有伪调整原因`);
    }
  });

  SUPPORTED_CURRENCIES.forEach((currency) => {
    assertEq(
      archivedBalances[currency],
      review.summaries.effectiveCalculatedBalance[currency],
      `归档快照 ${currency} 与生效计算余额一致`
    );
  });
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-adjustment-archive-chain-'));
  const dbPath = path.join(tempDir, 'tool-data.sqlite');
  const outputPath = path.join(tempDir, 'archived-adjusted-result.xlsx');
  const assetsDir = path.resolve(__dirname, '../../assets');
  let db = null;
  let service = null;
  console.log('==== VCC 财务OP结果调整与跨月归档链集成验证 ====');
  try {
    db = openDatabase(dbPath);
    seedMonth(db, M1, fixedBalances('100', { USD: '104.25', EUR: '108' }));

    service = createVccFinancialOpService({
      database: { db, dbPath },
      assetsDir,
      appVersion: APP_VERSION,
      buildSha: BUILD_SHA
    });
    const opening = await service.initializeOpening({
      targetMonth: M1,
      entries: [{ subject: SUBJECT, balances: fixedBalances('100') }],
      note: '集成链逐币种核对首月期初'
    }, createBatchContext('vccFinancialOp:opening:initialize'));
    assertEq(opening.status, 'initialized', '首月九币种期初真实初始化成功');

    const m1Preflight = service.preflightRun({ targetMonth: M1 });
    assertEq(m1Preflight.ok, true, 'M1 计算预检通过');
    assertTrue(/^[a-f0-9]{64}$/.test(m1Preflight.inputFingerprint), 'M1 预检生成有效输入指纹');
    const m1Calculation = await service.calculate({
      targetMonth: M1,
      expectedInputFingerprint: m1Preflight.inputFingerprint
    }, createBatchContext('vccFinancialOp:run:calculate'));
    assertEq(m1Calculation.status, 'calculated', 'M1 真实 worker 计算成功');
    assertEq(m1Calculation.inputFingerprint, m1Preflight.inputFingerprint, 'M1 worker 使用预检指纹');

    const runId = m1Calculation.runId;
    const initial = await service.getRunResult(runId);
    assertEq(initial.resultRevision, 0, '新计算结果 revision 从 0 开始');
    assertEq(balanceOf(initial, 'USD').effectiveCalculatedBalance, '103', 'M1 调整前 USD 基础计算余额正确');
    assertEq(balanceOf(initial, 'EUR').effectiveCalculatedBalance, '108', 'M1 EUR 基础计算余额正确');

    const options = service.listAdjustmentOptions({ runId });
    const rechargeOption = options.options.find((row) => (
      row.sourceType === SOURCE_TYPES.RECHARGE
      && row.categoryMajor === '充值'
      && row.categoryMinor === 'OPS'
    ));
    assertTrue(Boolean(rechargeOption), '调整候选由后端返回充值/OPS稳定坐标');
    assertTrue(rechargeOption.availableCurrencies.includes('USD'), '充值目标初始可选 USD');
    assertEq(options.resultRevision, 0, '调整候选携带当前 revision');

    const adjusted = await service.addRunAdjustment({
      runId,
      rowKey: rechargeOption.rowKey,
      currency: 'USD',
      adjustmentAmount: '1.25',
      reason: ADJUSTMENT_REASON,
      expectedResultRevision: options.resultRevision,
      expectedPreviewToken: initial.previewTokens.adjustment,
      taskGeneration: initial.taskGeneration
    }, undefined, createBatchContext('vccFinancialOp:run:adjustment-add'));
    assertEq(adjusted.status, 'adjusted', '调整通过真实 service 原子写入');
    assertEq(adjusted.resultRevision, 1, '新增调整后 revision 递增为 1');
    assertEq(adjusted.adjustment.reason, ADJUSTMENT_REASON, '调整写入保持业务原文');
    assertEq(adjusted.adjustment.createdAppVersion, APP_VERSION, '调整事实记录创建应用版本');
    assertEq(adjusted.adjustment.createdBuildSha, BUILD_SHA, '调整事实记录创建 build SHA');

    const afterAdjustment = await service.getRunResult(runId);

    await expectCode(
      () => service.addRunAdjustment({
        runId,
        rowKey: rechargeOption.rowKey,
        currency: 'EUR',
        adjustmentAmount: '1',
        reason: '故意使用过期 revision',
        expectedResultRevision: 0,
        expectedPreviewToken: afterAdjustment.previewTokens.adjustment,
        taskGeneration: afterAdjustment.taskGeneration
      }, undefined, createBatchContext('vccFinancialOp:run:adjustment-add')),
      'result-revision-changed',
      '结果已发生变化，请重新核对后归档。',
      '过期 revision 的第二次调整 fail closed'
    );
    assertEq(
      Number(db.prepare(`
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_adjustments WHERE run_id = ?
      `).get(runId).row_count),
      1,
      'stale 调整失败后仅保留原调整事实'
    );

    await service.terminate();
    service = null;
    db.close();
    db = null;

    db = openDatabase(dbPath);
    service = createVccFinancialOpService({
      database: { db, dbPath },
      assetsDir,
      appVersion: APP_VERSION,
      buildSha: BUILD_SHA
    });
    const reopened = await service.getRunResult(runId);
    assertEq(reopened.status, 'calculated', '重开数据库后结果仍为待归档');
    assertEq(reopened.resultRevision, 1, '重开数据库后 revision 保持 1');
    assertEq(reopened.adjustments.length, 1, '重开数据库后调整事实仍可见');
    assertEq(balanceOf(reopened, 'USD').effectivePeriodAmount, '4.25', '重开后 USD 生效发生额包含调整');
    assertEq(balanceOf(reopened, 'USD').effectiveCalculatedBalance, '104.25', '重开后 USD 生效余额包含调整');
    assertEq(balanceOf(reopened, 'USD').effectiveDifference, '0', '重开后 USD 生效差异归零');

    const subjectReview = reopened.review.subjects.find((item) => item.subject === SUBJECT);
    const baseIndex = subjectReview.rows.findIndex((row) => (
      row.type === 'base' && row.rowKey === rechargeOption.rowKey
    ));
    const adjustmentIndex = subjectReview.rows.findIndex((row) => row.type === 'adjustment');
    assertEq(adjustmentIndex, baseIndex + 1, '调整行紧邻目标基础行展示');
    assertEq(subjectReview.rows[adjustmentIndex].reason, ADJUSTMENT_REASON, '结果复核保留调整原因');
    assertDeepEq(reopened.review.currencies, SUPPORTED_CURRENCIES, '结果复核币种顺序固定为完整九币种');

    const optionsAfterAdjustment = service.listAdjustmentOptions({ runId });
    const rechargeAfter = optionsAfterAdjustment.options.find((row) => (
      row.rowKey === rechargeOption.rowKey
    ));
    assertTrue(!rechargeAfter.availableCurrencies.includes('USD'), '已调整 USD 从可用坐标移除');
    assertTrue(rechargeAfter.adjustedCurrencies.includes('USD'), '已调整 USD 在后端事实中标记');

    const archived = await service.archive({
      runId,
      expectedResultRevision: reopened.resultRevision,
      expectedPreviewToken: reopened.previewTokens.archive,
      taskGeneration: reopened.taskGeneration
    }, undefined, createBatchContext('vccFinancialOp:run:archive'));
    assertEq(archived.status, 'archived', 'M1 按当前 revision 归档成功');
    assertEq(archived.resultRevision, 1, '归档保留已核对 revision');

    const archivedResult = await service.getRunResult(runId);
    assertEq(archivedResult.status, 'archived', '归档后同一结果只读可重开');
    assertEq(archivedResult.adjustments.length, 1, '归档后调整事实仍可审阅');
    await expectCode(
      () => service.listAdjustmentOptions({ runId }),
      'adjustment-locked',
      '已归档结果不能修改，请先解归档。',
      '已归档结果不再提供调整候选'
    );
    const archiveRow = db.prepare(`
      SELECT balances_json, run_id FROM vcc_fin_op_archives
      WHERE target_month = ? AND subject = ?
    `).get(M1, SUBJECT);
    const archivedBalances = JSON.parse(archiveRow.balances_json);
    assertEq(Number(archiveRow.run_id), runId, '归档快照绑定原 run');
    assertDeepEq(Object.keys(archivedBalances), SUPPORTED_CURRENCIES, '归档快照完整保存九币种');
    assertEq(archivedBalances.USD, '104.25', '归档快照使用调整后 USD 生效余额');
    assertEq(archivedBalances.EUR, '108', '归档快照保留 EUR 生效余额');
    assertEq(
      Number(db.prepare(`
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_datasets
        WHERE target_month = ? AND data_status = 'archived' AND archived_run_id = ?
      `).get(M1, runId).row_count),
      REQUIRED_DATASET_TYPES.length,
      'M1 五类数据集与结果原子归档'
    );

    const archiveAudit = operationAudit(db, M1, 'archive_result');
    const archiveEvidence = JSON.parse(archiveAudit.evidence_json);
    assertEq(archiveAudit.status, 'success', '归档审计状态 success');
    assertEq(archiveAudit.app_version, APP_VERSION, '归档审计记录应用版本');
    assertEq(archiveAudit.build_sha, BUILD_SHA, '归档审计记录 build SHA');
    assertEq(archiveEvidence.evidenceVersion, 2, '归档审计使用冻结的 v2 摘要证据');
    assertEq(archiveEvidence.operation, 'archive_result', '归档审计操作类型一致');
    assertEq(archiveEvidence.runId, runId, '归档审计绑定原 run');
    assertEq(archiveEvidence.resultRevision, 1, '归档审计绑定已核对 revision');
    assertDeepEq(archiveEvidence.subjects, [SUBJECT], '归档审计固化归档主体集合');
    assertTrue(/^[a-f0-9]{64}$/.test(archiveEvidence.resultEvidenceDigest), '归档审计结果证据摘要有效');
    assertTrue(/^[a-f0-9]{64}$/.test(archiveEvidence.effectiveBalanceHash), '归档审计生效余额摘要有效');
    assertEq(archiveEvidence.expectedTotalChanges, 8, '单主体归档审计固定 N+7 变化预算');

    const exported = await service.exportRun(
      { targetMonth: M1, outputPath },
      createBatchContext('vccFinancialOp:export:result')
    );
    assertEq(exported.runId, runId, '归档导出月份严格解析回原 run');
    assertEq(exported.targetMonth, M1, '归档导出返回原目标月份');
    assertEq(exported.filePaths[0], outputPath, '归档导出发布到指定路径');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assertExportMatchesEffectiveResult(workbook, archivedResult, archivedBalances);

    seedMonth(db, M2, fixedBalances('100', { USD: '107.25', EUR: '116' }));
    const m2Preflight = service.preflightRun({ targetMonth: M2 });
    assertEq(m2Preflight.ok, true, 'M2 在 M1 归档后预检通过');
    assertEq(m2Preflight.openingState.source, 'previous_archive', 'M2 期初来源明确为上月归档');
    const m2Calculation = await service.calculate({
      targetMonth: M2,
      expectedInputFingerprint: m2Preflight.inputFingerprint
    }, createBatchContext('vccFinancialOp:run:calculate'));
    assertEq(m2Calculation.status, 'calculated', 'M2 真实 worker 计算成功');
    const m2Result = await service.getRunResult(m2Calculation.runId);
    const m2Usd = balanceOf(m2Result, 'USD');
    const m2Eur = balanceOf(m2Result, 'EUR');
    SUPPORTED_CURRENCIES.forEach((currency) => {
      assertEq(
        balanceOf(m2Result, currency).openingBalance,
        archivedBalances[currency],
        `M2 ${currency} 期初逐币种继承 M1 生效归档值`
      );
    });
    assertEq(m2Usd.openingBalance, '104.25', 'M2 USD 期初继承 M1 调整后归档值');
    assertEq(m2Usd.effectivePeriodAmount, '3', 'M2 USD 当期发生额保持源事实汇总');
    assertEq(m2Usd.effectiveCalculatedBalance, '107.25', 'M2 USD 计算余额血缘闭合');
    assertEq(m2Usd.effectiveDifference, '0', 'M2 USD 与系统余额核平');
    assertEq(m2Eur.openingBalance, '108', 'M2 EUR 期初继承 M1 归档值');
    assertEq(m2Eur.effectivePeriodAmount, '8', 'M2 EUR 当期发生额包含通道与 Pending');
    assertEq(m2Eur.effectiveCalculatedBalance, '116', 'M2 EUR 计算余额血缘闭合');
    assertEq(m2Eur.effectiveDifference, '0', 'M2 EUR 与系统余额核平');
  } finally {
    if (service) {
      try { await service.terminate(); } catch (_error) { /* cleanup */ }
    }
    if (db) {
      try { db.close(); } catch (_error) { /* cleanup */ }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((failure) => {
      console.error(`  - ${failure.label}${failure.detail ? `: ${failure.detail}` : ''}`);
    });
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
