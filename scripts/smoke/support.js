const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

function makeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function makeLegacyDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_file_name TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      template_field TEXT NOT NULL,
      mapped_field TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
      UNIQUE(template_id, row_index)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id TEXT NOT NULL UNIQUE,
      clearing_account_id TEXT NOT NULL,
      row_index INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db
    .prepare(`
      INSERT INTO templates (name, source_file_name, headers_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-template',
      'legacy.xlsx',
      JSON.stringify(['字段A', '字段B']),
      '2026-03-12T00:00:00.000Z',
      '2026-03-12T00:00:00.000Z'
    );
  db.close();
}

function createSmokeContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bill-tool-'));
  const projectRoot = path.resolve(__dirname, '..', '..');
  const context = {
    root,
    projectRoot,
    bundledEnumPath: path.join(projectRoot, 'COMMON枚举.xlsx'),
    currencyMappingPath: path.join(projectRoot, 'assets', '币种映射表.xlsx'),
    iconSourcePath: path.join(projectRoot, 'assets', 'app-icon-source.png'),
    runtimeIconPath: path.join(projectRoot, 'assets', 'app-icon.ico'),
    buildIconPath: path.join(projectRoot, 'build', 'icon.ico'),
    dbPath: path.join(root, 'app.sqlite'),
    templatePath: path.join(root, 'template.xlsx'),
    dataPath: path.join(root, 'input.xlsx'),
    unmappedDataPath: path.join(root, 'input-unmapped.xlsx'),
    amountMappingDataPath: path.join(root, 'amount-mapping-input.xlsx'),
    signedAmountDataPath: path.join(root, 'input-signed-amount.xlsx'),
    datePartsDataPath: path.join(root, 'input-date-parts.xlsx'),
    simultaneousAmountDataPath: path.join(root, 'input-simultaneous.xlsx'),
    skippedAmountDataPath: path.join(root, 'input-skipped-amounts.xlsx'),
    rawStatementPath: path.join(root, 'input-raw-statement.xlsx'),
    rawStatementWithSummaryPath: path.join(root, 'input-raw-statement-with-summary.xlsx'),
    detailOutputPath: path.join(root, '2026-03-09', 'detail', 'template-COMMON-2026-03-09~2026-03-10.xlsx'),
    balanceTemplatePath: path.join(root, 'balance-template.xlsx'),
    balanceOutputPath: path.join(root, '2026-03-09', 'balance', 'template-BALANCE-2026-03-09.xlsx'),
    errorReportRoot: path.join(root, 'reports'),
    activityLogPath: path.join(root, 'app_activity_log.txt'),
    startupFailureLogPath: path.join(root, 'startup-failure.log'),
    storageRoot: path.join(root, 'storage'),
    legacyDbPath: path.join(root, 'legacy.sqlite')
  };

  makeWorkbook(context.templatePath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['值1', '值2', '值3', '值4', '值5', '值6', '值7', '值8']
  ]);
  makeWorkbook(context.dataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['$1,234.56CR', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', 'BAL 456.78元'],
    ['', 'DB789.01元', '2026-03-10', '20260311', 'NET_002', 99, '港元', '99.99']
  ]);
  makeWorkbook(context.unmappedDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '测试币', '456.78']
  ]);
  makeWorkbook(context.amountMappingDataPath, [
    ['户名源', '账号源', '收入', '支出', '账单日期'],
    ['收款户名', '收款账号', '100', '', '2026-03-09'],
    ['付款户名', '付款账号', '', '200', '2026-03-10']
  ]);
  makeWorkbook(context.signedAmountDataPath, [
    ['账单日期', '发生额', '银行账号'],
    ['11/02/26 09:01:19', '+123.45', 'NET_001'],
    ['2026/1/2 09:01:19', '-54.3', 'NET_001']
  ]);
  makeWorkbook(context.datePartsDataPath, [
    ['Year', 'Date', 'Currency', 'Credit', 'Debit'],
    ['2026', '02-Feb', 'USD', '10.00', '0.00'],
    ['03-Mar', '2026', 'USD', '0.00', '5.00']
  ]);
  makeWorkbook(context.simultaneousAmountDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78']
  ]);
  makeWorkbook(context.skippedAmountDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78'],
    ['', '', '2026-03-10', '20260311', 'NET_001', 88, '美元', '460.00'],
    ['0', '0', '2026-03-11', '20260312', 'NET_001', 88, '美元', '470.00']
  ]);
  makeWorkbook(context.rawStatementPath, [
    ['账户信息', '', '', '', '', '', '', '', '', ''],
    ['', '原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H', '脏列'],
    ['', '$1,234.56CR', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', 'BAL 456.78元', '忽略'],
    ['', '', 'DB789.01元', '2026-03-10', '20260311', 'NET_002', 99, '港元', '99.99', '忽略']
  ]);
  makeWorkbook(context.rawStatementWithSummaryPath, [
    ['账户明细', '', '', '', '', '', '', '', ''],
    ['账号:19-005100048400017', '户名:PING PONG GLOBAL HOLDINGS LIMITED', '币种:美元', '', '', '', '起止日期: 2026年03月01日 - 2026年03月16日', '', ''],
    ['交易时间', '收入金额', '支出金额', '账户余额', '对方账号', '对方户名', '对方开户行', '交易用途', '摘要'],
    ['2026-03-02 14:53:51', '', '20000000.00', '59480546.65', 'FTN00107489600196100052', 'PING PONG GLOBAL HOLDINGSLIMITED', '北京银行股份有限公司', 'OUTWARD T/T，NRA PAYMENTNonResident.', '汇款扣款'],
    ['总收入笔数', '总收入金额', '总支出笔数', '总支出金额', '', '', '', '', ''],
    ['0', '0.00', '1', '20000000.00', '', '', '', '', '']
  ]);
  makeWorkbook(context.balanceTemplatePath, [
    ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额', '扩展字段'],
    ['旧银行', '旧地点', '旧币种', '旧账号', '旧日期', '旧期初', '旧可用', '旧期末', '旧期末可用', '旧扩展']
  ]);
  makeLegacyDatabase(context.legacyDbPath);

  return context;
}

module.exports = {
  createSmokeContext,
  makeLegacyDatabase,
  makeWorkbook
};
