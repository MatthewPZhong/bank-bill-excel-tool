'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  BANK_SHEET_NAME,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../src/constants/bank-statement-fields');

const MAX_DATA_ROWS_PER_FILE = 1_048_575;
const SUPPORTED_KINDS = Object.freeze([
  'bank',
  SOURCE_TYPES.GATEWAY_INBOUND,
  SOURCE_TYPES.GATEWAY_OUTBOUND
]);

function parseArgs(values) {
  const options = {
    outputPath: '',
    rowCount: 100,
    kind: SOURCE_TYPES.GATEWAY_OUTBOUND,
    rowsPerFile: MAX_DATA_ROWS_PER_FILE
  };
  const positional = [];
  for (const value of values) {
    if (value.startsWith('--kind=')) {
      options.kind = value.slice('--kind='.length);
    } else if (value.startsWith('--rows-per-file=')) {
      options.rowsPerFile = Number.parseInt(value.slice('--rows-per-file='.length), 10);
    } else {
      positional.push(value);
    }
  }
  options.outputPath = path.resolve(
    positional[0] || 'outputs/position-import-fixture.xlsx'
  );
  options.rowCount = Number.parseInt(positional[1] || '100', 10);
  if (!SUPPORTED_KINDS.includes(options.kind)) {
    throw new Error(`fixture 类型仅允许：${SUPPORTED_KINDS.join('、')}`);
  }
  if (!Number.isSafeInteger(options.rowCount)
      || options.rowCount < 1
      || options.rowCount > 10_000_000) {
    throw new Error('fixture 总行数只允许 1-10000000');
  }
  if (!Number.isSafeInteger(options.rowsPerFile)
      || options.rowsPerFile < 1
      || options.rowsPerFile > MAX_DATA_ROWS_PER_FILE) {
    throw new Error(`单文件数据行数只允许 1-${MAX_DATA_ROWS_PER_FILE}`);
  }
  return options;
}

function fixtureContract(kind) {
  if (kind === 'bank') {
    return {
      headers: BANK_STATEMENT_FIELDS,
      sheetName: BANK_SHEET_NAME,
      values(globalIndex) {
        return {
          BizId: `BENCH-BANK-${globalIndex}`,
          BillDate: '2026-07-20',
          Channel: 'BENCH',
          地区: 'TEST',
          MerchantId: 'M001',
          Currency: 'USD',
          'Credit Amount': globalIndex,
          'Debit Amount': 0,
          ReconciliationId: `BENCH-BANK-RID-${globalIndex}`,
          FundType: 'Inbound'
        };
      }
    };
  }
  if (kind === SOURCE_TYPES.GATEWAY_INBOUND) {
    return {
      headers: SOURCE_DEFINITIONS[kind].headers,
      sheetName: '入账',
      values(globalIndex) {
        return {
          bizId: `BENCH-IN-${globalIndex}`,
          billDate: '2026-07-20',
          tradeType: 'Inbound-VA',
          reconId: `BENCH-IN-RID-${globalIndex}`,
          channel: 'BENCH',
          merchantId: 'M001',
          currency: 'USD',
          amount: globalIndex,
          originOutboundCurrency: 'EUR'
        };
      }
    };
  }
  return {
    headers: SOURCE_DEFINITIONS[kind].headers,
    sheetName: '出账',
    values(globalIndex) {
      return {
        账单日期: '2026-07-20',
        渠道名称: 'BENCH',
        账户号: 'M001',
        交易类型: 'Outbound',
        主对账id: `BENCH-OUT-RID-${globalIndex}`,
        业务单号: `BENCH-OUT-${globalIndex}`,
        币种: 'USD',
        金额: globalIndex,
        原始币种: 'EUR',
        原始金额: globalIndex,
        银行扣款币种: 'USD'
      };
    }
  };
}

function indexedOutputPath(outputPath, fileIndex, fileCount) {
  if (fileCount === 1) return outputPath;
  const extension = path.extname(outputPath) || '.xlsx';
  const stem = path.basename(outputPath, path.extname(outputPath));
  return path.join(
    path.dirname(outputPath),
    `${stem}-${String(fileIndex + 1).padStart(2, '0')}${extension}`
  );
}

async function writeFixtureFile({
  filePath,
  contract,
  firstGlobalIndex,
  rowCount
}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useSharedStrings: false,
    useStyles: false
  });
  const sheet = workbook.addWorksheet(contract.sheetName);
  sheet.addRow(contract.headers).commit();
  const emptyValues = new Array(contract.headers.length).fill('');
  const headerIndexes = new Map(
    contract.headers.map((header, index) => [header, index])
  );
  for (let offset = 0; offset < rowCount; offset += 1) {
    const globalIndex = firstGlobalIndex + offset;
    const values = emptyValues.slice();
    for (const [header, value] of Object.entries(contract.values(globalIndex))) {
      const columnIndex = headerIndexes.get(header);
      if (columnIndex !== undefined) values[columnIndex] = value;
    }
    sheet.addRow(values).commit();
    if (offset > 0 && offset % 100000 === 0) {
      process.stderr.write(
        `${path.basename(filePath)}：${offset}/${rowCount}\n`
      );
    }
  }
  sheet.commit();
  await workbook.commit();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const contract = fixtureContract(options.kind);
  const fileCount = Math.ceil(options.rowCount / options.rowsPerFile);
  const files = [];
  let remaining = options.rowCount;
  let firstGlobalIndex = 1;
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const currentRows = Math.min(options.rowsPerFile, remaining);
    const filePath = indexedOutputPath(options.outputPath, fileIndex, fileCount);
    await writeFixtureFile({
      filePath,
      contract,
      firstGlobalIndex,
      rowCount: currentRows
    });
    files.push({
      filePath,
      rowCount: currentRows,
      sizeBytes: fs.statSync(filePath).size
    });
    firstGlobalIndex += currentRows;
    remaining -= currentRows;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'success',
    kind: options.kind,
    totalRows: options.rowCount,
    files
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
