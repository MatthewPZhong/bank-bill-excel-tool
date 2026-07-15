'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const {
  MAIL_HEADERS,
  buildWorkbook,
  buildDefaultFileName,
  validateWrittenWorkbook,
  writeDuplicateInboundWorkbook
} = require('../../../../src/main-process/duplicate-inbound-match/excel-writer');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const MAIL_TEMPLATE = path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx');
const BANK_TEMPLATE = path.join(ROOT, 'assets', '银行对账单.xlsx');

test('重复入金导出固定两 sheet，删除说明行并追加人工原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const savePath = path.join(dir, 'result.xlsx');
  try {
    await writeDuplicateInboundWorkbook({
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      savePath,
      mailRows: [{
        BillDate: '2026-07-12',
        Channel: 'CITI',
        MerchantId: 'M1',
        Currency: 'USD',
        'Debit Amount': 10,
        '加款单号': 'O1、O2',
        '业务来源': 'VA',
        '客户号': 'C1',
        '账户号': 'A1',
        '备注': '重复入账后被Reverse'
      }],
      manualRows: [{ row: { BizId: 'B-MANUAL', Channel: 'DBS' }, reason: 'Inbound数量为1' }]
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(savePath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
      '邮件模板',
      '匹配不成功需人工判定'
    ]);
    const mail = workbook.getWorksheet('邮件模板');
    assert.deepEqual(mail.getRow(1).values.slice(1), MAIL_HEADERS);
    assert.equal(mail.rowCount, 2);
    assert.equal(mail.getCell('E2').value, 10);
    assert.equal(mail.getCell('E2').numFmt ?? 'General', 'General');
    assert.equal(mail.getCell('F2').value, 'O1、O2');
    assert.equal(mail.getCell('J2').value, '重复入账后被Reverse');
    assert.doesNotMatch(String(mail.getCell('A2').value), /取FundType/);

    const manual = workbook.getWorksheet('匹配不成功需人工判定');
    assert.deepEqual(manual.getRow(1).values.slice(1), [...BANK_STATEMENT_FIELDS, '人工判定原因']);
    assert.equal(manual.getRow(2).getCell(BANK_STATEMENT_FIELDS.indexOf('BizId') + 1).value, 'B-MANUAL');
    assert.equal(manual.getRow(2).getCell(BANK_STATEMENT_FIELDS.length + 1).value, 'Inbound数量为1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重复入金导出允许仅人工结果，邮件 sheet 保留表头', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const savePath = path.join(dir, 'result.xlsx');
  try {
    await writeDuplicateInboundWorkbook({
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      savePath,
      mailRows: [],
      manualRows: [{ row: { BizId: 'B1' }, reason: 'MPT未命中' }]
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(savePath);
    assert.equal(workbook.getWorksheet('邮件模板').rowCount, 1);
    assert.equal(workbook.getWorksheet('匹配不成功需人工判定').rowCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重复入金默认文件名取导出当天本地 YYMMDD', () => {
  assert.equal(buildDefaultFileName(new Date(2026, 6, 14, 23, 59, 59)), '260714_重复入金召回邮件模板.xlsx');
});

test('覆盖已有文件时发布失败会恢复原文件且清理临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const savePath = path.join(dir, 'result.xlsx');
  fs.writeFileSync(savePath, 'original-content', 'utf8');
  const originalRenameSync = fs.renameSync;
  let renameCount = 0;
  try {
    fs.renameSync = (fromPath, toPath) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('simulated publish failure');
      return originalRenameSync(fromPath, toPath);
    };

    await assert.rejects(
      () => writeDuplicateInboundWorkbook({
        mailTemplatePath: MAIL_TEMPLATE,
        bankTemplatePath: BANK_TEMPLATE,
        savePath,
        mailRows: [],
        manualRows: [{ row: { BizId: 'B1' }, reason: 'MPT未命中' }]
      }),
      /simulated publish failure/
    );
    assert.equal(fs.readFileSync(savePath, 'utf8'), 'original-content');
    assert.deepEqual(fs.readdirSync(dir), ['result.xlsx']);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('发布与临时文件清理同时失败时优先恢复原文件并报告残留路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const savePath = path.join(dir, 'result.xlsx');
  fs.writeFileSync(savePath, 'original-content', 'utf8');
  const originalRenameSync = fs.renameSync;
  const originalRmSync = fs.rmSync;
  let renameCount = 0;
  try {
    fs.renameSync = (fromPath, toPath) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('simulated publish failure');
      return originalRenameSync(fromPath, toPath);
    };
    fs.rmSync = (target, options) => {
      if (path.basename(target).startsWith('.result.xlsx.tmp-')) {
        throw new Error('simulated temp cleanup failure');
      }
      return originalRmSync(target, options);
    };

    await assert.rejects(
      () => writeDuplicateInboundWorkbook({
        mailTemplatePath: MAIL_TEMPLATE,
        bankTemplatePath: BANK_TEMPLATE,
        savePath,
        mailRows: [],
        manualRows: [{ row: { BizId: 'B1' }, reason: 'MPT未命中' }]
      }),
      (error) => /simulated publish failure/.test(error.message)
        && /simulated temp cleanup failure/.test(error.message)
    );
    assert.equal(fs.readFileSync(savePath, 'utf8'), 'original-content');
    const entries = fs.readdirSync(dir);
    assert.equal(entries.some((name) => name.includes('.backup-')), false);
    assert.equal(entries.some((name) => name.startsWith('.result.xlsx.tmp-')), true);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync = originalRmSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('新文件发布成功但旧备份删除失败时返回可见告警', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const savePath = path.join(dir, 'result.xlsx');
  fs.writeFileSync(savePath, 'original-content', 'utf8');
  const originalRmSync = fs.rmSync;
  try {
    fs.rmSync = (target, options) => {
      if (String(target).includes('.backup-')) throw new Error('simulated backup cleanup failure');
      return originalRmSync(target, options);
    };
    const result = await writeDuplicateInboundWorkbook({
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      savePath,
      mailRows: [],
      manualRows: [{ row: { BizId: 'B1' }, reason: 'MPT未命中' }]
    });

    assert.equal(result.status, 'success');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /旧文件备份未能删除.*simulated backup cleanup failure/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(savePath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['邮件模板', '匹配不成功需人工判定']);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写入前拒绝超过 Excel 单 sheet 行数上限的结果', async () => {
  await assert.rejects(
    () => buildWorkbook({
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      mailRows: { length: 1048576 },
      manualRows: []
    }),
    (error) => error.code === 'duplicate-inbound-mail-row-limit'
  );
  await assert.rejects(
    () => buildWorkbook({
      mailTemplatePath: MAIL_TEMPLATE,
      bankTemplatePath: BANK_TEMPLATE,
      mailRows: [],
      manualRows: { length: 1048576 }
    }),
    (error) => error.code === 'duplicate-inbound-manual-row-limit'
  );
});

test('发布前回读校验拒绝 sheet 契约或结果行数损坏的临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-writer-'));
  const malformedPath = path.join(dir, 'malformed.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('错误 sheet').addRow(['错误表头']);
    await workbook.xlsx.writeFile(malformedPath);

    await assert.rejects(
      () => validateWrittenWorkbook(malformedPath, { mailRowCount: 0, manualRowCount: 0 }),
      (error) => error.code === 'duplicate-inbound-output-verification-failed'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
