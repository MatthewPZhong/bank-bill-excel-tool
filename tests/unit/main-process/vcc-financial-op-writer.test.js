'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../src/backend/vcc-financial-op-db/migrations');
const { SUPPORTED_CURRENCIES, SOURCE_TYPES } = require('../../../src/backend/vcc-financial-op/definitions');
const {
  RESULT_SHEET_NAME,
  PENDING_SHEET_NAME,
  decimalToExcelNumber,
  writeRunWorkbooks
} = require('../../../src/main-process/vcc-financial-op-writer');
const {
  writeXlsxAtomically
} = require('../../../src/main-process/vcc-financial-op-output-publication');

function seedRun(db) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
    VALUES ('2026-06', 'archived', '{}')
  `).run().lastInsertRowid);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const period = currency === 'USD' ? '3' : (currency === 'EUR' ? '8' : '0');
    const calculated = currency === 'USD' ? '103' : (currency === 'EUR' ? '108' : '100');
    const system = currency === 'USD' ? '104' : (currency === 'EUR' ? '106' : '100');
    const difference = currency === 'USD' ? '1' : (currency === 'EUR' ? '-2' : '0');
    insertBalance.run(runId, currency, period, calculated, system, difference);
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', 'OPS', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, 'PPHK', 'CITI', 1, 'EUR', 'USD', 'VCC_clearing_credit', '5', '-5')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, 'PPHK', 'EUR', '5'), (?, 'PPHK', 'USD', '-5')
  `).run(runId, runId);
  return runId;
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
    ['主体', '大类', '分类', ...SUPPORTED_CURRENCIES]
  );
  assert.equal(resultSheet.getCell('A2').value, 'PPHK');
  assert.equal(resultSheet.getCell('B2').value, '上月财务OP');
  const differenceRow = resultSheet.getColumn(1).values.findIndex((value) => value === '差异');
  assert.ok(differenceRow > 0);
  assert.equal(resultSheet.getCell(differenceRow, 12).value, 1);
  assert.ok(resultSheet.getColumn(12).width >= 13);
  assert.equal(resultSheet.pageSetup.orientation, 'landscape');
  assert.equal(resultSheet.pageSetup.fitToPage, true);
  assert.equal(resultSheet.pageSetup.fitToWidth, 1);

  const pendingSheet = workbook.getWorksheet(PENDING_SHEET_NAME);
  assert.equal(pendingSheet.getCell('A1').value, 'channel');
  assert.equal(pendingSheet.getCell('J1').value, '币种');
  assert.equal(pendingSheet.getCell('K1').value, '差额');
  assert.equal(pendingSheet.getCell('B2').value, true);
  assert.equal(pendingSheet.getCell('F2').value, 5);
  assert.equal(pendingSheet.getCell('G2').value, -5);
  assert.equal(pendingSheet.getCell('J2').value, 'EUR');
  assert.equal(pendingSheet.getCell('K2').value, 5);
  assert.ok(pendingSheet.getColumn(11).width >= 15);
  assert.equal(pendingSheet.pageSetup.orientation, 'landscape');
  assert.equal(pendingSheet.pageSetup.fitToWidth, 1);
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
  const runId = seedRun(db);
  db.prepare(`UPDATE vcc_fin_op_run_balances SET subject = 'A/B' WHERE run_id = ?`).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    )
    SELECT run_id, 'A:B', currency, opening_balance, period_amount,
           calculated_balance, system_balance, difference
    FROM vcc_fin_op_run_balances WHERE run_id = ? AND subject = 'A/B'
  `).run(runId);
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
