'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const {
  BANK_SHEET_NAME,
  LINK_HEADERS,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  readResultWorkbook,
  writeLinkedWorkbook,
  writeResultWorkbook
} = require('../../../src/main-process/position-reconciliation/excel-io');

const ROOT = path.resolve(__dirname, '../../..');
const RESULT_TEMPLATE = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');
const TEMPLATE_OUTPUTS = Object.freeze([
  [SOURCE_TYPES.FUND_TRANSFER, '中台调拨平盘对账单.xlsx'],
  [SOURCE_TYPES.TEST_PAYMENT, '中台测试付款对账单.xlsx'],
  [SOURCE_TYPES.GATEWAY_INBOUND, '中台网关入账对账单.xlsx'],
  [SOURCE_TYPES.GATEWAY_OUTBOUND, '中台网关出账对账单.xlsx'],
  [SOURCE_TYPES.BANK_ACCOUNT, '清结算银行账户表.xlsx']
]);
const SOURCE_TEMPLATE_OUTPUTS = Object.freeze([
  [SOURCE_TYPES.FUND_TRANSFER, '中台调拨订单表.xlsx'],
  [SOURCE_TYPES.TEST_PAYMENT, '中台测试付款全量信息表.xlsx'],
  [SOURCE_TYPES.GATEWAY_INBOUND, '中台网关原始入账订单.xlsx'],
  [SOURCE_TYPES.GATEWAY_OUTBOUND, '中台网关原始出账订单.xlsx']
]);

function resultRow(bizId, fundType) {
  return {
    BizId: bizId,
    BillDate: '2026-07-20',
    Channel: 'DBS',
    MerchantId: '000123',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: `RID-${bizId}`,
    FundType: fundType
  };
}

function requiresTextFormat(header) {
  return /id|no|code|账号|账户|卡号|单号|流水号|对账|批次号|清算号码|swift/i.test(
    String(header || '')
  );
}

test('五个链接模板严格使用正式字段、冻结首行和筛选范围', async () => {
  for (const [sourceType, fileName] of TEMPLATE_OUTPUTS) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(ROOT, 'assets', fileName));
    assert.equal(workbook.worksheets.length, 1, `${fileName} 只应有一个 sheet`);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.name, SOURCE_DEFINITIONS[sourceType].linkedName);
    assert.deepEqual(
      sheet.getRow(1).values.slice(1, LINK_HEADERS[sourceType].length + 1),
      [...LINK_HEADERS[sourceType]]
    );
    assert.equal(sheet.rowCount, 1, `${fileName} 模板不得夹带样例数据`);
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 1);
    assert.equal(
      sheet.autoFilter,
      `A1:${sheet.getColumn(LINK_HEADERS[sourceType].length).letter}1`
    );
    LINK_HEADERS[sourceType].forEach((header, index) => {
      if (requiresTextFormat(header)) {
        assert.equal(sheet.getColumn(index + 1).numFmt, '@', `${fileName}/${header} 必须为文本列`);
      }
    });
  }
});

test('四个订单原始表模板使用规范文件名、sheet 和严格表头', async () => {
  for (const [sourceType, fileName] of SOURCE_TEMPLATE_OUTPUTS) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(ROOT, 'assets', fileName));
    assert.equal(workbook.worksheets.length, 1, `${fileName} 只应有一个 sheet`);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.name, SOURCE_DEFINITIONS[sourceType].sourceName.slice(0, 31));
    assert.deepEqual(
      sheet.getRow(1).values.slice(1, SOURCE_DEFINITIONS[sourceType].headers.length + 1),
      [...SOURCE_DEFINITIONS[sourceType].headers]
    );
    assert.equal(sheet.rowCount, 1, `${fileName} 模板不得夹带样例数据`);
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 1);
    SOURCE_DEFINITIONS[sourceType].headers.forEach((header, index) => {
      if (requiresTextFormat(header)) {
        assert.equal(sheet.getColumn(index + 1).numFmt, '@', `${fileName}/${header} 必须为文本列`);
      }
    });
  }
});

test('49列结果只标黄实际改变的 FundType，并保持标识符文本格式', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-excel-'));
  const outputPath = path.join(root, 'result.xlsx');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await writeResultWorkbook({
    templatePath: RESULT_TEMPLATE,
    outputPath,
    rows: [
      {
        resultRow: resultRow('BIZ-1', 'Inbound&FX'),
        hitSummary: 'Inbound → Inbound&FX',
        hitType: '精准命中',
        matchDetail: '币种不同',
        changed: true
      },
      {
        resultRow: resultRow('BIZ-2', 'Inbound'),
        hitType: '精准命中',
        matchDetail: '同值命中',
        changed: false
      }
    ]
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const sheet = workbook.getWorksheet(BANK_SHEET_NAME);
  assert.deepEqual(
    sheet.getRow(1).values.slice(1, POSITION_BANK_HEADERS.length + 1),
    [...POSITION_BANK_HEADERS]
  );
  const fundTypeColumn = POSITION_BANK_HEADERS.indexOf('FundType') + 1;
  assert.equal(sheet.getRow(2).getCell(fundTypeColumn).fill.fgColor.argb, 'FFFFFF00');
  assert.notEqual(
    sheet.getRow(3).getCell(fundTypeColumn).fill?.fgColor?.argb,
    'FFFFFF00',
    '同值命中不得伪造黄色修改'
  );
  assert.equal(
    sheet.getRow(2).getCell(POSITION_BANK_HEADERS.indexOf('MerchantId') + 1).numFmt,
    '@',
    '账号字段必须按文本写入'
  );

  const parsed = readResultWorkbook(outputPath);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].row.FundType, 'Inbound&FX');
});

test('链接表零数据仍导出合法表头，49列表头被篡改时回导拒绝', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-excel-empty-'));
  const linkedPath = path.join(root, 'linked.xlsx');
  const badResultPath = path.join(root, 'bad-result.xlsx');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await writeLinkedWorkbook({
    outputPath: linkedPath,
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    rows: []
  });
  const linked = XLSX.readFile(linkedPath, { raw: true });
  const linkedRows = XLSX.utils.sheet_to_json(
    linked.Sheets[SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].linkedName],
    { header: 1, defval: '' }
  );
  assert.deepEqual(linkedRows, [[...LINK_HEADERS[SOURCE_TYPES.GATEWAY_INBOUND]]]);

  const workbook = XLSX.utils.book_new();
  const headers = [...POSITION_BANK_HEADERS];
  headers[0] = '错误命中明细';
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers]),
    BANK_SHEET_NAME
  );
  XLSX.writeFile(workbook, badResultPath);
  assert.throws(
    () => readResultWorkbook(badResultPath),
    (error) => error && error.code === 'position-result-headers-invalid'
  );
});

test('目标文件已发布后，旧备份清理失败不得把成功导出误报为失败', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-excel-cleanup-'));
  const outputPath = path.join(root, 'result.xlsx');
  const originalUnlinkSync = fs.unlinkSync;
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(outputPath, 'old-content');
  fs.unlinkSync = (filePath) => {
    if (String(filePath).includes('.bak')) throw new Error('模拟备份清理失败');
    return originalUnlinkSync(filePath);
  };

  await assert.doesNotReject(writeResultWorkbook({
    templatePath: RESULT_TEMPLATE,
    outputPath,
    rows: [{
      resultRow: resultRow('BIZ-CLEANUP', 'Inbound'),
      hitType: '精准命中',
      matchDetail: '新结果已发布',
      changed: false
    }]
  }));
  const workbook = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('BizId')], 'BIZ-CLEANUP');
});

test('发布失败时即使临时文件清理失败也必须恢复原目标文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-excel-rollback-'));
  const outputPath = path.join(root, 'result.xlsx');
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(outputPath, 'original-result');
  fs.renameSync = (fromPath, toPath) => {
    if (String(fromPath).includes('.tmp') && toPath === outputPath) {
      throw new Error('模拟新文件发布失败');
    }
    return originalRenameSync(fromPath, toPath);
  };
  fs.unlinkSync = (filePath) => {
    if (String(filePath).includes('.tmp')) throw new Error('模拟临时文件清理失败');
    return originalUnlinkSync(filePath);
  };

  await assert.rejects(
    writeResultWorkbook({
      templatePath: RESULT_TEMPLATE,
      outputPath,
      rows: [{
        resultRow: resultRow('BIZ-ROLLBACK', 'Inbound'),
        hitType: '精准命中',
        matchDetail: '不得覆盖旧文件',
        changed: false
      }]
    }),
    /模拟新文件发布失败/
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'original-result');
});
