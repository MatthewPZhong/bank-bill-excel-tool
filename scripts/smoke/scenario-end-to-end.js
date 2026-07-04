// v2.0.0-beta.3 PR #32b：E2E smoke
// 全链路：mock bankRows + gwRows + 3 类场景 → dispatcher → exceljs writer → 读回 xlsx 验证
// 不依赖 GUI；纯内存 + tmp 文件落盘验证

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ExcelJS = require('exceljs');

const { runAllScenarios } = require('../../src/main-process/scenario-dispatcher');
const {
  writeBankStatementMainOutput,
  writeErrorReportOutput,
  buildMainOutputFileName,
  buildTimestampMinute
} = require('../../src/main-process/bank-statement-io');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');

function makeBankRow(overrides) {
  const base = Object.fromEntries(BANK_STATEMENT_FIELDS.map((h) => [h, '']));
  return { ...base, ...overrides };
}

function makeC1Scenario() {
  return {
    id: 1,
    name: '从银行对账单的信息里提取对账ID',
    category: 'extract-recon-id',
    priority: 3,
    enabled: true,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
      extractByFeature: {
        enabled: true,
        searchFields: ['CustomerRef'],
        featureCode: 'FT',
        digitCount: 12,
        totalLength: 15
      },
      extractByOtherField: null
    }
  };
}

function makeC2Scenario() {
  return {
    id: 2,
    name: 'outbound改标为outbound Fail',
    category: 'offset-bill-mark',
    priority: 2,
    enabled: true,
    config: {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' },
        { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
      ],
      markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
    }
  };
}

function makeC3Scenario() {
  return {
    id: 3,
    name: '与网关对账单根据金额币种一对一匹配对账ID',
    category: 'gateway-recon-join',
    priority: 1,
    enabled: true,
    config: {
      reconFields: [
        { seq: 1, gwField: 'Currency', bankField: 'Currency' },
        { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank', bankField: 'Channel' }
      ],
      assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
    }
  };
}

async function runScenarioEndToEndSmokeTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbet-e2e-'));
  let count = 0;
  function check(label, cond, msg) {
    count += 1;
    assert(cond, `${label} ${msg || 'assert failed'}`);
  }

  try {
    // ===== E1：C1 + C2 + C3 三类场景同时命中（不同行） =====
    {
      const bankRows = [
        // C1 命中：CustomerRef 含 FT + 12 位数字
        makeBankRow({ _rowId: 'r1', CustomerRef: 'AFT123456789012', ReconciliationId: '' }),
        // C2 一对配对（rA leftType=1: outbound Fail / rB rightType=2: outbound 同 CustomerRef + Credit==Debit）
        makeBankRow({
          _rowId: 'r2',
          FundType: 'outbound Fail',
          CustomerRef: 'CUST-X',
          'Credit Amount': 100,
          'Debit Amount': 0
        }),
        makeBankRow({
          _rowId: 'r3',
          FundType: 'outbound',
          CustomerRef: 'CUST-X',
          'Credit Amount': 0,
          'Debit Amount': 100
        }),
        // C3 命中（gw join）
        makeBankRow({
          _rowId: 'r4',
          Currency: 'CNY',
          'Credit Amount': 200,
          'Debit Amount': 0,
          MerchantId: 'M001',
          Channel: 'BankA',
          ReconciliationId: ''
        }),
        // 不命中
        makeBankRow({ _rowId: 'r5', CustomerRef: 'no_match' })
      ];
      const gwRows = [
        { Currency: 'CNY', Amount: 200, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_E2E_999' }
      ];

      const result = runAllScenarios(bankRows, gwRows, [makeC1Scenario(), makeC2Scenario(), makeC3Scenario()]);

      // 命中行数：r1（C1）+ r2/r3（C2 双锁）+ r4（C3）= 4
      check('E1.1', result.modifiedRows.length === 4, `命中应 4 行，实 ${result.modifiedRows.length}`);
      // v2.1.8 N3-1：hitScenarioIds → hitScenarios（{id, displayIndex, name}[]）
      const hitIds = result.stats.hitScenarios.map((s) => s.id);
      check('E1.2', hitIds.length === 3, 'hitScenarios 应 3 项');
      check('E1.3', hitIds.includes(1), 'C1 应入 hitScenarios');
      check('E1.4', hitIds.includes(2), 'C2 应入 hitScenarios');
      check('E1.5', hitIds.includes(3), 'C3 应入 hitScenarios');
      // 写出
      const tsMinute = buildTimestampMinute();
      const expectedName = buildMainOutputFileName(tsMinute);
      check('E1.6', /^银行对账单-\d{12}-处理结果\.xlsx$/.test(expectedName), '文件名规则');
      const mainFilePath = path.join(tmpDir, expectedName);
      const writeOut = await writeBankStatementMainOutput({
        modifiedRows: result.modifiedRows,
        headers: BANK_STATEMENT_FIELDS,
        mainFilePath
      });
      check('E1.7', fs.existsSync(writeOut.filePath), '主输出文件应存在');
      check('E1.8', writeOut.fileName === expectedName, '回传 fileName 应一致');

      // 读回校验：r1 ReconciliationId = 'AFT123456789012' + 标黄
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(writeOut.filePath);
      // v3.0.13：命中行在「命中场景」sheet；原数据列右移2（命中明细 + 异常说明）
      const sheet = wb.getWorksheet('命中场景');
      check('E1.8b', sheet.getCell(1, 2).value === '异常说明', '命中场景第 2 列 = 异常说明');
      const reconColIdx = BANK_STATEMENT_FIELDS.indexOf('ReconciliationId') + 3;  // +1 转1基 +2 前导列
      // 行序对应 modifiedRows 顺序：r1, r2, r3, r4（按 bankRows.filter 顺序）
      // sheet 第 1 行是 header，第 2 行 = r1
      const r1Cell = sheet.getCell(2, reconColIdx);
      check('E1.9', r1Cell.value === 'AFT123456789012', `r1 ReconciliationId 写入，实 ${r1Cell.value}`);
      check(
        'E1.10',
        r1Cell.fill && r1Cell.fill.fgColor && r1Cell.fill.fgColor.argb === 'FFFFFF00',
        'r1 ReconciliationId 应黄底'
      );
      // r4（modifiedRows 第 4 行）的 ReconciliationId = GW_E2E_999
      const r4Cell = sheet.getCell(5, reconColIdx);
      check('E1.11', r4Cell.value === 'GW_E2E_999', `r4 ReconciliationId 应被 C3 写入，实 ${r4Cell.value}`);
      check(
        'E1.12',
        r4Cell.fill && r4Cell.fill.fgColor && r4Cell.fill.fgColor.argb === 'FFFFFF00',
        'r4 ReconciliationId 应黄底'
      );
      // r3 FundType = outbound Fail（C2 打标）
      const fundTypeColIdx = BANK_STATEMENT_FIELDS.indexOf('FundType') + 3;  // +1 转1基 +2 前导列
      const r3Cell = sheet.getCell(4, fundTypeColIdx);
      check('E1.13', r3Cell.value === 'outbound Fail', `r3 FundType 应被打标 outbound Fail，实 ${r3Cell.value}`);
      check(
        'E1.14',
        r3Cell.fill && r3Cell.fill.fgColor && r3Cell.fill.fgColor.argb === 'FFFFFF00',
        'r3 FundType 应黄底'
      );
    }

    // ===== E2：first-match-wins 在跨场景下行不重复锁定 =====
    {
      // 单行同时满足 C1 + C3：C1 优先级 3 > C3 优先级 1
      const bankRows = [
        makeBankRow({
          _rowId: 'rX',
          CustomerRef: 'AFT888888888888',
          Currency: 'CNY',
          'Credit Amount': 100,
          'Debit Amount': 0,
          MerchantId: 'M002',
          Channel: 'BankB',
          ReconciliationId: ''
        })
      ];
      const gwRows = [
        { Currency: 'CNY', Amount: 100, MerchantId: 'M002', Bank: 'BankB', reconciliationId: 'GW_SHOULD_NOT_OVERRIDE' }
      ];
      const result = runAllScenarios(bankRows, gwRows, [makeC1Scenario(), makeC3Scenario()]);
      check('E2.1', result.modifiedRows.length === 1, 'first-match-wins 不应重复入 modifiedRows');
      check(
        'E2.2',
        result.modifiedRows[0].ReconciliationId === 'AFT888888888888',
        `应被 C1 写入（高优先级），不应被 C3 覆盖`
      );
      check('E2.3', result.stats.hitScenarios.length === 1 && result.stats.hitScenarios[0].id === 1, 'hitScenarios 仅含 C1');
    }

    // ===== E3：gwRows = null + 启用 C3 → skippedC3Count = 1 =====
    {
      const bankRows = [makeBankRow({ _rowId: 'rZ', CustomerRef: 'AFT111111111111', ReconciliationId: '' })];
      const result = runAllScenarios(bankRows, null, [makeC1Scenario(), makeC3Scenario()]);
      check('E3.1', result.stats.skippedC3Count === 1, 'C3 应被过滤 → skippedC3Count = 1');
      check('E3.2', result.stats.hitScenarios.length === 1 && result.stats.hitScenarios[0].id === 1, '仅 C1 命中');
      check('E3.3', result.modifiedRows.length === 1, '仅 1 行命中');
    }

    // ===== E4：error-report 路径独立 =====
    {
      // 构造 C1 多字段值不一致 → 不写入 + warn
      const bankRows = [
        makeBankRow({
          _rowId: 'rW',
          CustomerRef: 'AFT111111111111',
          'Extra Information': 'BFT222222222222',
          ReconciliationId: ''
        })
      ];
      const c1MultiSearch = {
        ...makeC1Scenario(),
        config: {
          conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
          extractByFeature: {
            enabled: true,
            searchFields: ['CustomerRef', 'Extra Information'],
            featureCode: 'FT',
            digitCount: 12,
            totalLength: 15
          },
          extractByOtherField: null
        }
      };
      const result = runAllScenarios(bankRows, null, [c1MultiSearch]);
      check('E4.1', result.modifiedRows.length === 0, '多值不一致不应写入');
      check('E4.2', result.errorReport.length > 0, 'error-report 应有内容');
      // 写 error-report（v3.0.4 F3：传 bankRows enrich 对账ID 列）
      //   本样本 C1 多值不一致 → ReconciliationId 始终为空（不写入）→ 第 3 列端到端回退 rowId
      const exportRootDir = path.join(tmpDir, 'export-root');
      const er = await writeErrorReportOutput({
        warnings: result.errorReport,
        exportRootDir,
        timestamp: '20260429000099',
        bankRows: [...result.modifiedRows, ...result.unmatchedRows]
      });
      check('E4.3', er && fs.existsSync(er.filePath), 'error-report 文件应存在');
      // E4.4：空 reconid 回退链路端到端——第 3 列回退到 _rowId（rW）
      {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(er.filePath);
        const sheet = wb.getWorksheet('error-report');
        check('E4.4', sheet.getCell(1, 3).value === '对账ID', 'error-report 第 3 列表头 = 对账ID');
        check('E4.5', sheet.getCell(2, 3).value === 'rW', '空 reconid → 第 3 列回退 _rowId（rW）');
      }
    }

    console.log(`  scenario-end-to-end: ${count}/${count} PASS`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runScenarioEndToEndSmokeTests };

if (require.main === module) {
  runScenarioEndToEndSmokeTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
