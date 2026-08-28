'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const { SUPPORTED_CURRENCIES, SOURCE_TYPES } = require('../../../src/backend/vcc-financial-op/definitions');
const {
  RESULT_SHEET_NAME,
  PENDING_SHEET_NAME,
  MAX_EXCEL_ROW_HEIGHT,
  decimalToExcelNumber,
  adjustmentReasonRowHeight,
  loadEffectiveRunData,
  buildSubjectRowPlan,
  validateStagedWorkbook,
  assertAdjustmentLineage,
  planRunWorkbookOutputPaths,
  writeRunWorkbooks: writeRunWorkbooksExact
} = require('../../../src/main-process/vcc-financial-op-writer');
const {
  writeXlsxAtomically
} = require('../../../src/main-process/vcc-financial-op-output-publication');
const {
  buildRunRowKey
} = require('../../../src/backend/vcc-financial-op/result-adjustments');
const {
  loadResultTemplateContract
} = require('../../../src/backend/vcc-financial-op/result-template-contract');
const {
  encodeAdjustmentLineageName,
  parseAdjustmentLineageName
} = require('../../../src/backend/vcc-financial-op/adjustment-lineage');

async function writeRunWorkbooks(options) {
  const data = loadEffectiveRunData(options.db, Number(options.runId));
  const outputPaths = planRunWorkbookOutputPaths({
    targetMonth: data.run.targetMonth,
    subjects: data.subjects,
    outputDirectory: options.outputDirectory,
    outputPath: options.outputPath
  });
  return writeRunWorkbooksExact({ ...options, outputPaths });
}

test('effective DTO 行模型保留基础/调整相邻顺序并使用生效汇总', () => {
  const zeroes = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, '0']));
  const baseAmounts = { ...zeroes, JPY: '135886024.59' };
  const adjustmentAmounts = Object.fromEntries(
    SUPPORTED_CURRENCIES.map((currency) => [currency, currency === 'JPY' ? '-24.59' : null])
  );
  const data = {
    run: { targetMonth: '2026-06', resultRevision: 1 },
    effective: {
      review: {
        subjects: [{
          subject: 'PPHK',
          rows: [
            {
              type: 'base', rowKey: `v1:${'a'.repeat(64)}`, rowKind: 'movement',
              sourceType: SOURCE_TYPES.RECHARGE, categoryMajor: 'VCC_discharge',
              categoryMinor: 'B2B', currencyAmounts: baseAmounts
            },
            {
              type: 'adjustment', rowKey: `v1:${'a'.repeat(64)}`, rowKind: 'movement',
              sourceType: SOURCE_TYPES.RECHARGE, categoryMajor: 'VCC_discharge',
              categoryMinor: 'B2B', currency: 'JPY', currencyAmounts: adjustmentAmounts,
              adjustmentAmount: '-24.59', reason: '修正样例', sequence: 1
            }
          ],
          summaries: {
            openingBalance: zeroes,
            effectiveCalculatedBalance: { ...zeroes, JPY: '135886000' },
            systemBalance: { ...zeroes, JPY: '135886001' },
            effectiveDifference: { ...zeroes, JPY: '1' }
          }
        }]
      }
    }
  };

  const plan = buildSubjectRowPlan(data, 'PPHK');
  assert.deepEqual(plan.rows.map((row) => row.rowType), [
    'opening', 'movement', 'adjustment', 'calculated', 'system', 'difference'
  ]);
  assert.equal(plan.rows[1].anchorKind, 'classified');
  assert.equal(plan.rows[2].rowKey, plan.rows[1].rowKey);
  assert.equal(plan.rows[2].currency, 'JPY');
  assert.equal(plan.rows[3].amounts.JPY, '135886000');
  assert.equal(plan.rows[5].amounts.JPY, '1');
});

function seedSubjectResult(db, runId, subject) {
  const periodAmounts = {
    EUR: '8',
    JPY: '135886024.59',
    USD: '3'
  };
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const period = periodAmounts[currency] || '0';
    const calculated = currency === 'USD' ? '103' : (
      currency === 'EUR' ? '108' : (
        currency === 'JPY' ? '135886124.59' : '100'
      )
    );
    const system = currency === 'USD' ? '104' : (
      currency === 'EUR' ? '106' : (currency === 'CAD' ? '101' : calculated)
    );
    const difference = currency === 'USD' ? '1' : (
      currency === 'EUR' ? '-2' : (currency === 'CAD' ? '1' : '0')
    );
    insertBalance.run(runId, subject, currency, period, calculated, system, difference);
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES
      (?, ?, 'movement', ?, 'VCC_discharge', 'B2B', 'USD', '10'),
      (?, ?, 'movement', ?, 'VCC_ATMBalance_Inquiry_Fee', '', 'EUR', '5'),
      (?, ?, 'movement', ?, 'DISCOVER-UK', 'TRIBE', 'JPY', '135886024.59'),
      (?, ?, 'pending', ?, '当月移除pending', '', 'USD', '-7'),
      (?, ?, 'pending', ?, '当月移除pending', '', 'EUR', '3')
  `).run(
    runId, subject, SOURCE_TYPES.RECHARGE,
    runId, subject, SOURCE_TYPES.FEE_FX,
    runId, subject, SOURCE_TYPES.CHANNEL,
    runId, subject, SOURCE_TYPES.PENDING,
    runId, subject, SOURCE_TYPES.PENDING
  );
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, ?, 'CITI', 1, 'EUR', 'USD', 'VCC_clearing_credit', '8', '-7')
  `).run(runId, subject);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, ?, 'EUR', '3'), (?, ?, 'USD', '-7')
  `).run(runId, subject, runId, subject);
}

function seedRun(db, subjects = ['PPHK']) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
    VALUES ('2026-06', 'archived', '{}')
  `).run().lastInsertRowid);
  for (const subject of subjects) seedSubjectResult(db, runId, subject);
  return runId;
}

function seedChannelAdjustment(db, runId, subject = 'PPHK', reason = '修正大额样例') {
  const rowKey = buildRunRowKey({
    rowKind: 'movement',
    subject,
    sourceType: SOURCE_TYPES.CHANNEL,
    categoryMajor: 'DISCOVER-UK',
    categoryMinor: 'TRIBE'
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence
    ) VALUES (?, ?, ?, ?, 'DISCOVER-UK', 'TRIBE', 'JPY', '-24.59', ?, 1)
  `).run(runId, rowKey, subject, SOURCE_TYPES.CHANNEL, reason);
  db.prepare('UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?').run(runId);
  return rowKey;
}

test('导出每个主体一个双 Sheet 工作簿并保留固定表头与 Pending J:K', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-output-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });
  assert.equal(result.filePaths.length, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePaths[0]);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [RESULT_SHEET_NAME, PENDING_SHEET_NAME]);

  const resultSheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  assert.deepEqual(
    resultSheet.getRow(1).values.slice(1),
    ['主体', '大类', '分类', ...SUPPORTED_CURRENCIES, '调整值', '调整原因']
  );
  assert.equal(resultSheet.getCell('A2').value, 'PPHK');
  assert.equal(resultSheet.getCell('B2').value, '上月财务OP');
  const differenceRow = resultSheet.getColumn(2).values.findIndex((value) => value === '差异');
  assert.ok(differenceRow > 0);
  assert.equal(resultSheet.getCell(differenceRow, 12).value, 1);
  const channelRow = resultSheet.getColumn(2).values.findIndex((value) => value === 'DISCOVER-UK');
  assert.equal(resultSheet.getCell(channelRow, 10).value, 135886024.59);
  assert.equal(resultSheet.pageSetup.orientation, 'landscape');
  assert.equal(resultSheet.pageSetup.fitToPage, true);
  assert.equal(resultSheet.pageSetup.fitToWidth, 1);
  assert.equal(resultSheet.pageSetup.printArea, `A1:L${differenceRow}`);

  const pendingSheet = workbook.getWorksheet(PENDING_SHEET_NAME);
  assert.equal(pendingSheet.getCell('A1').value, 'channel');
  assert.equal(pendingSheet.getCell('J1').value, '币种');
  assert.equal(pendingSheet.getCell('K1').value, '差额');
  assert.equal(pendingSheet.getCell('B2').value, true);
  assert.equal(pendingSheet.getCell('F2').value, 8);
  assert.equal(pendingSheet.getCell('G2').value, -7);
  assert.equal(pendingSheet.getCell('J2').value, 'EUR');
  assert.equal(pendingSheet.getCell('K2').value, 3);
  assert.ok(pendingSheet.getColumn(11).width >= 15);
  assert.equal(pendingSheet.pageSetup.orientation, 'landscape');
  assert.equal(pendingSheet.pageSetup.fitToWidth, 1);
});

test('调整行、effective 汇总、AUD/CAD fill 和 named-range 血缘可回读', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const rowKey = seedChannelAdjustment(db, runId);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-adjustment-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePaths[0]);
  const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  const channelRow = sheet.getColumn(2).values.findIndex((value) => value === 'DISCOVER-UK');
  const adjustmentRow = channelRow + 1;
  assert.equal(sheet.getCell(adjustmentRow, 2).value, 'DISCOVER-UK');
  assert.equal(sheet.getCell(adjustmentRow, 3).value, 'TRIBE');
  assert.equal(sheet.getCell(adjustmentRow, 10).value, -24.59);
  assert.equal(sheet.getCell(adjustmentRow, 13).value, -24.59);
  assert.equal(sheet.getCell(adjustmentRow, 14).value, '修正大额样例');
  assert.deepEqual(
    parseAdjustmentLineageName(sheet.getCell(adjustmentRow, 13).names[0]),
    { rowKey, currency: 'JPY' }
  );

  const calculatedRow = sheet.getColumn(2).values.findIndex((value) => value === '当月计算财务OP');
  const differenceRow = sheet.getColumn(2).values.findIndex((value) => value === '差异');
  assert.equal(sheet.getCell(calculatedRow, 10).value, 135886100);
  assert.equal(sheet.getCell(differenceRow, 10).value, 24.59);

  const template = new ExcelJS.Workbook();
  await template.xlsx.readFile(path.resolve(
    __dirname,
    '../../../assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx'
  ));
  const templateSheet = template.getWorksheet(RESULT_SHEET_NAME);
  assert.deepEqual(sheet.getCell('D1').fill, templateSheet.getCell('D1').fill);
  assert.deepEqual(sheet.getCell('E1').fill, templateSheet.getCell('E1').fill);
  assert.deepEqual(sheet.getCell('J1').fill, templateSheet.getCell('E1').fill);
  assert.deepEqual(sheet.getCell(adjustmentRow, 10).font, templateSheet.getCell('D45').font);
  assert.equal(sheet.getCell(adjustmentRow, 10).numFmt, templateSheet.getCell('D45').numFmt);
  assert.deepEqual(sheet.getCell(adjustmentRow, 13).font, templateSheet.getCell('D45').font);
  assert.equal(sheet.getCell(adjustmentRow, 13).numFmt, templateSheet.getCell('D45').numFmt);
  assert.deepEqual(sheet.getCell(adjustmentRow, 14).font, templateSheet.getCell('B45').font);
  assert.equal(sheet.getCell(adjustmentRow, 14).alignment.wrapText, true);
});

test('500 字 Unicode 调整原因仅提高调整行行高并在重开后保持可验证', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const longReason = '核'.repeat(500);
  seedChannelAdjustment(db, runId, 'PPHK', longReason);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-long-reason-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const assetsDir = path.resolve(__dirname, '../../../assets');
  const result = await writeRunWorkbooks({ db, runId, outputDirectory, assetsDir });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePaths[0]);
  const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  const channelRow = sheet.getColumn(2).values.findIndex((value) => value === 'DISCOVER-UK');
  const adjustmentRow = channelRow + 1;
  const contract = await loadResultTemplateContract({
    templatePath: path.join(assetsDir, 'VCC财务OP校验', 'VCC财务OP校验结果表_模板.xlsx')
  });
  const baseHeight = sheet.getRow(channelRow).height;
  const adjustmentHeight = sheet.getRow(adjustmentRow).height;

  assert.equal(baseHeight, contract.anchors.channel.height);
  assert.equal(sheet.getCell(adjustmentRow, 14).value, longReason);
  assert.equal(sheet.getCell(adjustmentRow, 14).alignment.wrapText, true);
  assert.equal(
    adjustmentHeight,
    adjustmentReasonRowHeight(longReason, sheet.getColumn(14).width, contract.anchors.channel.height)
  );
  assert.ok(adjustmentHeight > baseHeight * 10, '长调整原因应显著提高调整行行高');
  assert.ok(adjustmentHeight <= MAX_EXCEL_ROW_HEIGHT);
});

test('调整原因 ST_Xstring 字面量与真实 CRLF 经 semantic writer 单次编码后严格往返', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const reason = '核对_x000D_补记；大小写_X000d_；字面_x005F_x000D_；真实CRLF\r\n下一行；普通😀中文';
  const rowKey = seedChannelAdjustment(db, runId, 'PPHK', reason);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-st-xstring-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });

  assert.equal(
    db.prepare('SELECT reason FROM vcc_fin_op_run_adjustments WHERE run_id = ?').get(runId).reason,
    reason,
    '持久化事实保持业务原文，不保存 OOXML 词法'
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePaths[0]);
  const sheet = workbook.getWorksheet(RESULT_SHEET_NAME);
  const channelRow = sheet.getColumn(2).values.findIndex((value) => value === 'DISCOVER-UK');
  const adjustmentRow = channelRow + 1;
  assert.equal(sheet.getCell(adjustmentRow, 14).value, reason);
  assert.deepEqual(
    parseAdjustmentLineageName(sheet.getCell(adjustmentRow, 13).names[0]),
    { rowKey, currency: 'JPY' }
  );

  const zip = await JSZip.loadAsync(fs.readFileSync(result.filePaths[0]));
  const sharedStrings = zip.file('xl/sharedStrings.xml');
  assert.ok(sharedStrings, 'semantic writer 应输出 sharedStrings');
  const sharedStringsXml = await sharedStrings.async('string');
  assert.match(sharedStringsXml, /核对_x005F_x000D_补记/);
  assert.match(sharedStringsXml, /大小写_x005F_X000d_/);
  assert.match(sharedStringsXml, /字面_x005F_x005F_x005F_x000D_/);
  assert.ok(
    sharedStringsXml.includes('真实CRLF_x000D_\n下一行'),
    '真实 CR 经 ST_Xstring 编码且 LF 保持真实换行'
  );
});

test('staged validator 拒绝调整目标格、M/N 结构或覆盖样式漂移', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  seedChannelAdjustment(db, runId);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-style-fault-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });
  const data = loadEffectiveRunData(db, runId);
  const plan = buildSubjectRowPlan(data, 'PPHK');
  const renderedRows = plan.rows.map((row, index) => ({ ...row, rowNumber: index + 2 }));
  const adjustment = renderedRows.find((row) => row.rowType === 'adjustment');
  const lastRow = renderedRows[renderedRows.length - 1].rowNumber;
  const resultContract = await loadResultTemplateContract({
    templatePath: path.resolve(
      __dirname,
      '../../../assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx'
    )
  });
  const ordinaryClassificationRow = renderedRows.find((row) => (
    !resultContract.anchors[row.anchorKind].mergeMajorMinor
  ));
  assert.ok(ordinaryClassificationRow);
  const faults = [
    ['普通分类格 fill', (sheet) => {
      sheet.getCell(ordinaryClassificationRow.rowNumber, 3).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' }
      };
    }],
    ['目标格 border', (sheet) => {
      sheet.getCell(adjustment.rowNumber, 10).border = {
        bottom: { style: 'thick', color: { argb: 'FFFF0000' } }
      };
    }],
    ['目标格 font', (sheet) => { sheet.getCell(adjustment.rowNumber, 10).font = { name: 'Arial' }; }],
    ['M 格 alignment', (sheet) => { sheet.getCell(adjustment.rowNumber, 13).alignment = { horizontal: 'left' }; }],
    ['M 格 numFmt', (sheet) => { sheet.getCell(adjustment.rowNumber, 13).numFmt = 'General'; }],
    ['N 格 fill', (sheet) => {
      sheet.getCell(adjustment.rowNumber, 14).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' }
      };
    }],
    ['N 格 font', (sheet) => { sheet.getCell(adjustment.rowNumber, 14).font = { name: 'Arial' }; }],
    ['N 格 wrapText', (sheet) => {
      sheet.getCell(adjustment.rowNumber, 14).alignment = {
        ...sheet.getCell(adjustment.rowNumber, 14).alignment,
        wrapText: false
      };
    }]
  ];

  for (const [label, mutate] of faults) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePaths[0]);
    mutate(workbook.getWorksheet(RESULT_SHEET_NAME));
    const stagedPath = path.join(outputDirectory, `${label}.xlsx`);
    await workbook.xlsx.writeFile(stagedPath);
    await assert.rejects(
      validateStagedWorkbook({ stagedPath, resultContract, plan, renderedRows, lastRow }),
      (error) => error.code === 'vcc-result-export-validation-failed',
      label
    );
  }
});

test('调整血缘拒绝多引用、跨表、区域引用、额外标记和大小写重复', () => {
  const rowKey = `v1:${'a'.repeat(64)}`;
  const name = encodeAdjustmentLineageName(rowKey, 'JPY');
  const extraName = encodeAdjustmentLineageName(`v1:${'b'.repeat(64)}`, 'USD');
  const renderedRows = [{
    rowType: 'adjustment',
    rowNumber: 3,
    rowKey,
    currency: 'JPY'
  }];
  const baseRange = `'${RESULT_SHEET_NAME}'!$M$3`;
  const makeHarness = (models, namesByRow = new Map([[3, [name]]])) => ({
    workbook: { definedNames: { model: models } },
    sheet: {
      getCell(rowNumber, columnNumber) {
        assert.equal(columnNumber, 13);
        return { names: namesByRow.get(rowNumber) || [] };
      }
    }
  });
  const faults = [
    ['多个引用', [{ name, ranges: [baseRange, `'${RESULT_SHEET_NAME}'!$M$4`] }]],
    ['跨 sheet', [{ name, ranges: ["'其他结果表'!$M$3"] }]],
    ['非 M 列', [{ name, ranges: [`'${RESULT_SHEET_NAME}'!$L$3`] }]],
    ['区域引用', [{ name, ranges: [`'${RESULT_SHEET_NAME}'!$M$3:$M$4`] }]],
    ['孤儿/额外标记', [
      { name, ranges: [baseRange] },
      { name: extraName, ranges: [`'${RESULT_SHEET_NAME}'!$M$4`] }
    ], new Map([[3, [name]], [4, [extraName]]])],
    ['重复引用同一 adjustment 行', [
      { name, ranges: [baseRange] },
      { name: extraName, ranges: [baseRange] }
    ], new Map([[3, [name, extraName]]])],
    ['大小写重复', [
      { name, ranges: [baseRange] },
      { name: name.toLowerCase(), ranges: [baseRange] }
    ]],
    ['缺少标记', []]
  ];

  for (const [label, models, namesByRow] of faults) {
    const { workbook, sheet } = makeHarness(models, namesByRow);
    assert.throws(
      () => assertAdjustmentLineage(workbook, sheet, renderedRows, 6),
      (error) => error.code === 'vcc-result-export-validation-failed',
      label
    );
  }
});

test('同一基础 rowKey 的多币种调整各有唯一可逆血缘', () => {
  const rowKey = `v1:${'c'.repeat(64)}`;
  const jpyName = encodeAdjustmentLineageName(rowKey, 'JPY');
  const usdName = encodeAdjustmentLineageName(rowKey, 'USD');
  const renderedRows = [{
    rowType: 'adjustment', rowNumber: 3, rowKey, currency: 'JPY'
  }, {
    rowType: 'adjustment', rowNumber: 4, rowKey, currency: 'USD'
  }];
  const workbook = { definedNames: { model: [{
    name: jpyName,
    ranges: [`'${RESULT_SHEET_NAME}'!$M$3`]
  }, {
    name: usdName,
    ranges: [`'${RESULT_SHEET_NAME}'!$M$4`]
  }] } };
  const sheet = {
    getCell(rowNumber, columnNumber) {
      assert.equal(columnNumber, 13);
      return { names: rowNumber === 3 ? [jpyName] : [usdName] };
    }
  };

  assert.doesNotThrow(() => (
    assertAdjustmentLineage(workbook, sheet, renderedRows, 6)
  ));
});

test('结果模板缺失或 hash 漂移时不覆盖既有目标且不创建暂存/备份文件', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const goldenTemplate = path.resolve(
    __dirname,
    '../../../assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx'
  );

  for (const fault of ['missing', 'hash-drift']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `vcc-fin-op-template-${fault}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const assetsDir = path.join(root, 'assets');
    const templateDir = path.join(assetsDir, 'VCC财务OP校验');
    fs.mkdirSync(templateDir, { recursive: true });
    if (fault === 'hash-drift') {
      const targetTemplate = path.join(templateDir, 'VCC财务OP校验结果表_模板.xlsx');
      fs.copyFileSync(goldenTemplate, targetTemplate);
      fs.appendFileSync(targetTemplate, Buffer.from('hash-drift'));
    }
    const outputPath = path.join(root, 'result.xlsx');
    fs.writeFileSync(outputPath, 'original-content');

    await assert.rejects(
      writeRunWorkbooks({ db, runId, outputPath, assetsDir }),
      (error) => error.code === (
        fault === 'missing' ? 'result-template-missing' : 'result-template-contract-mismatch'
      ),
      fault
    );
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original-content');
    assert.deepEqual(fs.readdirSync(root).sort(), ['assets', 'result.xlsx']);
  }
});

test('超过 Excel 15 位有效数字时拒绝静默丢失金额精度', () => {
  assert.equal(decimalToExcelNumber('123456789012345', '测试金额'), 123456789012345);
  assert.equal(decimalToExcelNumber('12.34', '测试金额'), 12.34);
  assert.throws(
    () => decimalToExcelNumber('12345678901234.56', '测试金额'),
    /15 位有效数字/
  );
  assert.throws(
    () => decimalToExcelNumber('0.123', '测试金额'),
    /最多支持 2 位小数/
  );
});

test('多主体文件名清洗冲突时生成不同输出路径', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db, ['A:B', 'A/B']);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-collision-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });
  assert.equal(result.filePaths.length, 2);
  assert.equal(new Set(result.filePaths).size, 2);
  assert.ok(result.filePaths.every((filePath) => fs.existsSync(filePath)));
  assert.deepEqual(result.subjects, ['A/B', 'A:B']);
});

test('多主体后续写入失败时错误携带已发布文件供原任务批次登记', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db, ['PPHK', 'PPUS']);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-partial-output-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  let calls = 0;
  let caught;
  try {
    await writeRunWorkbooks({
      db,
      runId,
      outputDirectory,
      assetsDir: path.resolve(__dirname, '../../../assets'),
      writeSubjectWorkbookFn: async ({ outputPath: destination }) => {
        calls += 1;
        if (calls === 2) throw new Error('第二主体注入失败');
        await fs.promises.writeFile(destination, 'first-subject-output');
        return destination;
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.partialResult.partialCommitted, true);
  assert.equal(caught.partialResult.filePaths.length, 1);
  assert.equal(fs.existsSync(caught.partialResult.filePaths[0]), true);
  assert.equal(caught.partialResult.runId, runId);
});

test('durable publication 模式只写 generation 目录并返回 N 个正式目标', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db, ['PPHK', 'PPUS']);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-deferred-output-'));
  const generationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-generation-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(generationDirectory, { recursive: true, force: true }));

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets'),
    publicationStagingDirectory: generationDirectory,
    writeSubjectWorkbookFn: async ({ outputPath: generationPath }) => {
      fs.writeFileSync(generationPath, path.basename(generationPath));
      return generationPath;
    }
  });

  assert.equal(result.filePaths.length, 2);
  assert.equal(result.generationFilePaths.length, 2);
  assert.ok(result.filePaths.every((filePath) => path.dirname(filePath) === outputDirectory));
  assert.ok(result.generationFilePaths.every(
    (filePath) => path.dirname(filePath) === generationDirectory && fs.existsSync(filePath)
  ));
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('自动命名导出不会覆盖目录中已有同名文件', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const runId = seedRun(db);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-existing-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const existingPath = path.join(outputDirectory, '2026-06_PPHK_VCC财务OP校验结果表.xlsx');
  fs.writeFileSync(existingPath, 'existing-content');

  const result = await writeRunWorkbooks({
    db,
    runId,
    outputDirectory,
    assetsDir: path.resolve(__dirname, '../../../assets')
  });

  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'existing-content');
  assert.equal(path.basename(result.filePaths[0]), '2026-06_PPHK_VCC财务OP校验结果表_(2).xlsx');
});

test('临时工作簿校验失败时保留用户原有目标文件并清理暂存文件', async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-atomic-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const outputPath = path.join(outputDirectory, 'result.xlsx');
  fs.writeFileSync(outputPath, 'original-content');

  await assert.rejects(
    writeXlsxAtomically({
      outputPath,
      writeStaged: async (stagedPath) => fs.promises.writeFile(stagedPath, 'invalid-workbook'),
      validateStaged: async () => { throw new Error('结构校验失败'); }
    }),
    /结构校验失败/
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original-content');
  assert.deepEqual(fs.readdirSync(outputDirectory), ['result.xlsx']);
});

test('发布前数据库收口失败时不替换已有文件并清理暂存文件', async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-fin-op-before-publish-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const outputPath = path.join(outputDirectory, 'result.xlsx');
  fs.writeFileSync(outputPath, 'original-content');

  await assert.rejects(
    writeXlsxAtomically({
      outputPath,
      writeStaged: async (stagedPath) => fs.promises.writeFile(stagedPath, 'complete-workbook'),
      beforePublish: async () => { throw new Error('只读快照提交失败'); }
    }),
    /只读快照提交失败/
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original-content');
  assert.deepEqual(fs.readdirSync(outputDirectory), ['result.xlsx']);
});
