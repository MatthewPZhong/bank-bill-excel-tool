'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  LINK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../src/main-process/position-reconciliation/constants');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const LINK_TEMPLATE_OUTPUTS = Object.freeze([
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

function columnWidth(header) {
  return Math.min(36, Math.max(14, Array.from(String(header)).length * 2 + 4));
}

function requiresTextFormat(header) {
  return /id|no|code|账号|账户|卡号|单号|流水号|对账|批次号|清算号码|swift/i.test(
    String(header || '')
  );
}

async function buildTemplate({ outputName, sheetName, headers }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '网银账单生成小助手';
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const headerRow = sheet.addRow(headers);
  headerRow.height = 30;
  headerRow.eachCell((cell, columnNumber) => {
    cell.font = {
      name: 'Microsoft YaHei',
      size: 11,
      bold: true,
      color: { argb: 'FF1F2937' }
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF8' }
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB8C2D1' } },
      left: { style: 'thin', color: { argb: 'FFB8C2D1' } },
      bottom: { style: 'thin', color: { argb: 'FFB8C2D1' } },
      right: { style: 'thin', color: { argb: 'FFB8C2D1' } }
    };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true
    };
    const column = sheet.getColumn(columnNumber);
    column.width = columnWidth(headers[columnNumber - 1]);
    if (requiresTextFormat(headers[columnNumber - 1])) column.numFmt = '@';
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };
  await workbook.xlsx.writeFile(path.join(ASSETS, outputName));
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  for (const [sourceType, outputName] of LINK_TEMPLATE_OUTPUTS) {
    await buildTemplate({
      outputName,
      sheetName: SOURCE_DEFINITIONS[sourceType].linkedName,
      headers: LINK_HEADERS[sourceType]
    });
  }
  for (const [sourceType, outputName] of SOURCE_TEMPLATE_OUTPUTS) {
    await buildTemplate({
      outputName,
      sheetName: SOURCE_DEFINITIONS[sourceType].sourceName,
      headers: SOURCE_DEFINITIONS[sourceType].headers
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
