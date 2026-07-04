// v2.0.0-beta.3 PR #32a：bank-statement-io 集成 smoke 测试
// 接入 smoke 流程

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const {
  BANK_STATEMENT_SHEET_NAME,
  GATEWAY_RECON_SHEET_NAME,
  readBankStatement,
  readGatewayRecon,
  writeBankStatementMainOutput,
  writeErrorReportOutput,
  buildMainOutputFileName,
  sanitizeFileName
} = require('../../src/main-process/bank-statement-io');

const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { GATEWAY_RECON_FIELDS } = require('../../src/constants/gateway-recon-fields');
const { FileValidationError } = require('../../src/backend/file-service/common');

// 构造一份临时 .xlsx：sheetName → header 数组 + 数据二维数组
function makeXlsxFile(sheetName, headers, rows, savePath) {
  const wb = XLSX.utils.book_new();
  const aoa = [headers, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  XLSX.writeFile(wb, savePath);
}

function makeMultiSheetXlsx(sheets, savePath) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, headers, rows }) => {
    const aoa = [headers, ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, sheet, name);
  });
  XLSX.writeFile(wb, savePath);
}

async function runBankStatementIoSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke-io');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // ===== R1: readBankStatement 正常路径 =====
  {
    const filePath = path.join(tmpDir, 'bank-ok.xlsx');
    const sample = BANK_STATEMENT_FIELDS.map((h) => `${h}-1`);
    makeXlsxFile(BANK_STATEMENT_SHEET_NAME, BANK_STATEMENT_FIELDS, [sample, sample], filePath);
    const result = readBankStatement(filePath);
    assert.strictEqual(result.rowCount, 2, 'R1 行数');
    assert.strictEqual(result.rows[0]._rowId, 'row_0', 'R1 _rowId');
    assert.strictEqual(result.rows[1]._rowId, 'row_1', 'R1 _rowId 递增');
    assert.deepStrictEqual(result.headers, BANK_STATEMENT_FIELDS, 'R1 headers 全等');
  }

  // ===== R2: readBankStatement 缺 sheet =====
  {
    const filePath = path.join(tmpDir, 'bank-no-sheet.xlsx');
    makeXlsxFile('其他sheet', BANK_STATEMENT_FIELDS, [], filePath);
    assert.throws(
      () => readBankStatement(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R2 应抛 missing-sheet'
    );
  }

  // ===== R3: readBankStatement 列数不符 =====
  {
    const filePath = path.join(tmpDir, 'bank-bad-cols.xlsx');
    const wrongHeaders = BANK_STATEMENT_FIELDS.slice(0, 30); // 缺列
    makeXlsxFile(BANK_STATEMENT_SHEET_NAME, wrongHeaders, [], filePath);
    assert.throws(
      () => readBankStatement(filePath),
      (err) => err instanceof FileValidationError && err.code === 'invalid-column-count',
      'R3 应抛 invalid-column-count'
    );
  }

  // ===== R4: readBankStatement 列名错位 =====
  {
    const filePath = path.join(tmpDir, 'bank-wrong-name.xlsx');
    const wrongHeaders = [...BANK_STATEMENT_FIELDS];
    wrongHeaders[5] = 'WrongName'; // 第 6 列改名
    makeXlsxFile(BANK_STATEMENT_SHEET_NAME, wrongHeaders, [], filePath);
    assert.throws(
      () => readBankStatement(filePath),
      (err) => err instanceof FileValidationError && err.code === 'invalid-column-name',
      'R4 应抛 invalid-column-name'
    );
  }

  // ===== R5: readGatewayRecon 正常 =====
  {
    const filePath = path.join(tmpDir, 'gw-ok.xlsx');
    const sample = GATEWAY_RECON_FIELDS.map((h) => `${h}-V`);
    makeMultiSheetXlsx(
      [
        { name: '对账结果', headers: ['col'], rows: [] },
        { name: GATEWAY_RECON_SHEET_NAME, headers: GATEWAY_RECON_FIELDS, rows: [sample] }
      ],
      filePath
    );
    const result = readGatewayRecon(filePath);
    assert.strictEqual(result.rowCount, 1, 'R5 行数');
    assert.strictEqual(result.gwRows[0].Currency, 'Currency-V', 'R5 字段读取');
  }

  // ===== R6: readGatewayRecon 缺「网关账单」sheet =====
  {
    const filePath = path.join(tmpDir, 'gw-no-sheet.xlsx');
    makeXlsxFile('对账结果', ['col'], [], filePath);
    assert.throws(
      () => readGatewayRecon(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R6 应抛 missing-sheet'
    );
  }

  // ===== W1: writeBankStatementMainOutput 单一场景（用户另存为路径） =====
  {
    const exportRootDir = path.join(tmpDir, 'export-root', '2026-04-29');
    fs.mkdirSync(exportRootDir, { recursive: true });
    const modifiedRows = [
      {
        _rowId: 'row_0',
        _hitScenarioId: 1,
        _hitScenarioName: 'C1 调拨ReconId自提取',
        _modifiedColumns: new Set(['ReconciliationId']),
        ...Object.fromEntries(BANK_STATEMENT_FIELDS.map((h) => [h, '']))
      }
    ];
    modifiedRows[0].ReconciliationId = 'AFT123456789012';
    const mainFilePath = path.join(exportRootDir, '银行对账单-202604290000-处理结果.xlsx');
    const result = await writeBankStatementMainOutput({
      modifiedRows,
      headers: BANK_STATEMENT_FIELDS,
      mainFilePath
    });
    assert(fs.existsSync(result.filePath), 'W1 文件应存在');
    assert.strictEqual(result.fileName, '银行对账单-202604290000-处理结果.xlsx', 'W1 文件名应为新统一格式');
    // 读回校验标黄
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    // v3.0.13：命中行在「命中场景」sheet；原数据列右移2（命中明细 + 异常说明）
    const sheet = wb.getWorksheet('命中场景');
    assert.strictEqual(sheet.getCell(1, 2).value, '异常说明', 'W1 第 2 列 = 异常说明');
    const reconColIdx = BANK_STATEMENT_FIELDS.indexOf('ReconciliationId') + 1;
    const reconCell = sheet.getCell(2, reconColIdx + 2);
    assert.strictEqual(reconCell.value, 'AFT123456789012', 'W1 ReconciliationId 写入');
    assert(
      reconCell.fill && reconCell.fill.fgColor && reconCell.fill.fgColor.argb === 'FFFFFF00',
      'W1 ReconciliationId 应黄底'
    );
  }

  // ===== W2: writeBankStatementMainOutput 多场景命中 → 仍统一命名 =====
  {
    const exportRootDir = path.join(tmpDir, 'export-root-2', '2026-04-29');
    fs.mkdirSync(exportRootDir, { recursive: true });
    const baseRow = Object.fromEntries(BANK_STATEMENT_FIELDS.map((h) => [h, '']));
    const modifiedRows = [
      { ...baseRow, _rowId: 'r1', _hitScenarioName: 'C1 提取', _modifiedColumns: new Set() },
      { ...baseRow, _rowId: 'r2', _hitScenarioName: 'C2 打标', _modifiedColumns: new Set() }
    ];
    const mainFilePath = path.join(exportRootDir, '银行对账单-202604290001-处理结果.xlsx');
    const result = await writeBankStatementMainOutput({
      modifiedRows,
      headers: BANK_STATEMENT_FIELDS,
      mainFilePath
    });
    assert.strictEqual(result.fileName, '银行对账单-202604290001-处理结果.xlsx', 'W2 多场景仍用统一格式');
  }

  // ===== W3: writeErrorReportOutput 5 列 + bankRows enrich（v3.0.4 F3）=====
  //   传 bankRows → 第 3 列「对账ID」按 _rowId → ReconciliationId enrich 后显示银行行对账ID。
  {
    const exportRootDir = path.join(tmpDir, 'export-root');
    const warnings = [
      { scenarioId: 1, scenarioName: 'C1 提取', rowId: 'row_5', code: 'inconsistent-recon-id-values', message: '多字段值不一致' }
    ];
    const bankRows = [
      { _rowId: 'row_5', ReconciliationId: 'AFT123456789012' },
      { _rowId: 'row_6', ReconciliationId: 'OTHER' }
    ];
    const result = await writeErrorReportOutput({
      warnings,
      exportRootDir,
      timestamp: '20260429000002',
      bankRows
    });
    assert(result && fs.existsSync(result.filePath), 'W3 error-report 应被创建');
    assert(result.fileName.endsWith('-error-report.xlsx'), 'W3 文件名格式');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet('error-report');
    assert.strictEqual(sheet.getCell(1, 3).value, '对账ID', 'W3 表头第 3 列 = 对账ID');
    assert.strictEqual(sheet.getCell(2, 3).value, 'AFT123456789012', 'W3 第 3 列 = enrich 后银行行 ReconciliationId');
  }

  // ===== W3b: writeErrorReportOutput 回退（缺省 bankRows / 空 ReconciliationId → 回退 rowId）=====
  {
    const exportRootDir = path.join(tmpDir, 'export-root');
    const warnings = [
      // rowId=row_9 但既不传 bankRows，也无 reconciliationId → 第 3 列回退 row_9
      { scenarioId: 1, scenarioName: 'C2 打标', rowId: 'row_9', code: 'one-to-many', message: '一对多匹配' }
    ];
    // bankRows 含 row_9 但 ReconciliationId 为空 → enrich 跳过 → 仍回退 rowId
    const bankRows = [{ _rowId: 'row_9', ReconciliationId: '' }];
    const result = await writeErrorReportOutput({
      warnings,
      exportRootDir,
      timestamp: '20260429000003',
      bankRows
    });
    assert(result && fs.existsSync(result.filePath), 'W3b error-report 应被创建');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.filePath);
    const sheet = wb.getWorksheet('error-report');
    assert.strictEqual(sheet.getCell(2, 3).value, 'row_9', 'W3b 空 ReconciliationId → 第 3 列回退 rowId');
  }

  // ===== W4: writeErrorReportOutput 空数组 → null =====
  {
    const exportRootDir = path.join(tmpDir, 'export-root');
    const result = await writeErrorReportOutput({ warnings: [], exportRootDir });
    assert.strictEqual(result, null, 'W4 空 warnings 应返回 null');
  }

  // ===== F1: buildMainOutputFileName 统一命名（PR #32b UX 决策） =====
  {
    // 新规则：银行对账单-{YYYYMMDDHHmm}-处理结果.xlsx，不含场景名
    assert.strictEqual(
      buildMainOutputFileName('202604290000'),
      '银行对账单-202604290000-处理结果.xlsx',
      'F1 命名规则：银行对账单-{ts}-处理结果.xlsx'
    );
    // 默认 timestamp = buildTimestampMinute（12 位 YYYYMMDDHHmm）
    const defaultName = buildMainOutputFileName();
    assert(/^银行对账单-\d{12}-处理结果\.xlsx$/.test(defaultName), 'F1.2 默认 timestamp 12 位');
  }

  // ===== P1（sandbox sync）：preload.js inline 常量必须与 src/constants/* 一致 =====
  // Electron sandbox 限制 preload require 自定义模块，preload 内联常量副本
  // 必须与 src/constants/bank-statement-fields.js / gateway-recon-fields.js 同步
  {
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload.js'), 'utf8');
    // 提取 BANK_STATEMENT_FIELDS（44 列）
    const bankMatch = preloadSrc.match(/const BANK_STATEMENT_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
    assert(bankMatch, 'P1.1 preload.js 缺 BANK_STATEMENT_FIELDS inline 副本');
    const preloadBankCols = bankMatch[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.deepStrictEqual(preloadBankCols, BANK_STATEMENT_FIELDS, 'P1.2 BANK_STATEMENT_FIELDS preload 与 src/constants 不同步');
    // v2.1.15 W1：GATEWAY_RECON_FIELDS 不再 inline 于 preload —— C3 网关账单字段改读 assets/网关对账单.xlsx 表头，
    //   经 IPC scenarios:gateway-recon-headers 暴露（main 进程 require loader）。契约反转：
    //   P1.3 preload 必须【不含】GATEWAY_RECON_FIELDS inline 副本；P1.4 必须暴露 getGatewayReconHeaders IPC 桥。
    assert(
      !/const GATEWAY_RECON_FIELDS = Object\.freeze\(/.test(preloadSrc),
      'P1.3 preload.js 不应再有 GATEWAY_RECON_FIELDS inline 副本（W1 已改走 IPC scenarios:gateway-recon-headers）'
    );
    assert(
      preloadSrc.includes('getGatewayReconHeaders') && preloadSrc.includes('scenarios:gateway-recon-headers'),
      'P1.4 preload.js 必须暴露 getGatewayReconHeaders（invoke scenarios:gateway-recon-headers）'
    );
    // 虚拟字段
    assert(preloadSrc.includes("const BANK_STATEMENT_VIRTUAL_AMOUNT_ABS = '发生额绝对值'"), 'P1.5 BANK_STATEMENT_VIRTUAL_AMOUNT_ABS preload 不同步');
  }

  // ===== S1（self-review #2）：sanitizeFileName Windows / macOS 跨平台兜底 =====
  {
    // 控制字符替换为 _
    assert.strictEqual(sanitizeFileName('调拨\u0001ReconId\u0007'), '调拨_ReconId_', 'S1.1 控制字符');
    // Windows 禁用字符
    assert.strictEqual(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j', 'S1.2 Windows 禁用字符');
    // 尾点 + 尾空格（Windows 自动 trim 导致冲突）
    assert.strictEqual(sanitizeFileName('调拨ReconId. '), '调拨ReconId', 'S1.3 尾点空格');
    assert.strictEqual(sanitizeFileName('调拨...'), '调拨', 'S1.4 多尾点');
    // 设备保留名 → 加 _ 前缀
    assert.strictEqual(sanitizeFileName('CON'), '_CON', 'S1.5 CON');
    assert.strictEqual(sanitizeFileName('con'), '_con', 'S1.6 小写也命中');
    assert.strictEqual(sanitizeFileName('CON.txt'), '_CON.txt', 'S1.7 CON.txt（含扩展名）');
    assert.strictEqual(sanitizeFileName('LPT1'), '_LPT1', 'S1.8 LPT1');
    // 普通名不加前缀
    assert.strictEqual(sanitizeFileName('CONS'), 'CONS', 'S1.9 CONS 非保留名');
    // 空 / 全控制字符 → '_'
    assert.strictEqual(sanitizeFileName(''), '_', 'S1.10 空');
    assert.strictEqual(sanitizeFileName('   '), '_', 'S1.11 全空格');
    // 长度限制
    const longName = '调'.repeat(150);
    assert.strictEqual(sanitizeFileName(longName).length, 100, 'S1.12 长度截断到 100');
    // 正常名不变
    assert.strictEqual(sanitizeFileName('调拨ReconId自提取'), '调拨ReconId自提取', 'S1.13 正常名不变');
  }

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('  bank-statement-io: 13/13 PASS');
}

module.exports = {
  runBankStatementIoSmokeTests
};
