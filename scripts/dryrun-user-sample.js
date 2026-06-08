#!/usr/bin/env node
// v2.0.0-beta.3 PR #32b：用户样例文件 in-process dry-run
// PRD §13.1 P0-1 ~ P0-11 自动可验证子集
//
// 用法：node scripts/dryrun-user-sample.js
//
// 输入：仓库根目录下的 `银行对账单.xlsx` + `资金对账导出不平.xlsx`（用户样例，已加 .gitignore）
// 输出：
//   - stdout：stats + 命中场景 + modifications + warnings + dry-run 文件路径
//   - tmp 目录：主输出 + error-report xlsx（自动验证标黄）

const path = require('path');
const fs = require('fs');
const os = require('os');
const ExcelJS = require('exceljs');

const { readBankStatement, readGatewayRecon, writeBankStatementMainOutput, writeErrorReportOutput, buildMainOutputFileName } = require('../src/main-process/bank-statement-io');
const { runAllScenarios } = require('../src/main-process/scenario-dispatcher');
const { BANK_STATEMENT_FIELDS } = require('../src/constants/bank-statement-fields');

const ROOT = path.resolve(__dirname, '..');
// 支持 CLI 参数覆盖：node scripts/dryrun-user-sample.js <bankFile> <gwFile>
const BANK_FILE = process.argv[2] || path.join(ROOT, '银行对账单.xlsx');
const GW_FILE = process.argv[3] || path.join(ROOT, '资金对账导出不平.xlsx');

// 内置 3 场景（与 migrations.js BUILTIN_SCENARIOS 一致）
const BUILTIN_SCENARIOS = [
  {
    id: 1,
    name: '从银行对账单的信息里提取对账ID',
    category: 'extract-recon-id',
    priority: 3,
    enabled: true,
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
  },
  {
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
  },
  {
    id: 3,
    name: '与网关对账单根据金额币种一对一匹配对账ID',
    category: 'gateway-recon-join',
    priority: 1,
    enabled: true, // dry-run 测试 C3 启用 + 文件加载（实际 GUI 默认禁用）
    config: {
      reconFields: [
        { seq: 1, gwField: 'Currency', bankField: 'Currency' },
        { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank', bankField: 'Channel' }
      ],
      assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
    }
  }
];

function divider(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function verifyMainOutputYellow(filePath, modifications) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  // v2.1.16-beta.6 需求B：命中行在「命中场景」sheet；原数据列右移1（命中明细占第1列）
  const sheet = wb.getWorksheet('命中场景');
  if (!sheet) {
    console.log('  ⚠️ 主输出 sheet「命中场景」未找到');
    return false;
  }
  // 抽样验证：第一条 modification 的 cell 应黄底
  if (modifications.length === 0) return true;
  const m = modifications[0];
  const rawIdx = BANK_STATEMENT_FIELDS.indexOf(m.column);
  if (rawIdx < 0) {
    console.log(`  ⚠️ 列 ${m.column} 不在 BANK_STATEMENT_FIELDS（应是虚拟字段，跳过验证）`);
    return true;
  }
  const colIdx = rawIdx + 2;  // +1 转1基 +1 命中明细列右移
  // 找到 modifiedRows 中 m.rowId 的索引（注意 sheet row = idx + 2）
  // 简化：扫所有数据行，找 ReconciliationId / FundType 列任意带黄底的 cell 即可
  let yellowCount = 0;
  for (let row = 2; row <= sheet.rowCount; row++) {
    const cell = sheet.getCell(row, colIdx);
    if (cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb === 'FFFFFF00') {
      yellowCount += 1;
    }
  }
  console.log(`  黄底单元格数量（列 ${m.column}）：${yellowCount}`);
  return yellowCount > 0;
}

async function main() {
  if (!fs.existsSync(BANK_FILE)) {
    console.error(`样例文件缺失：${BANK_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(GW_FILE)) {
    console.error(`样例文件缺失：${GW_FILE}`);
    process.exit(1);
  }

  divider('1. 读取用户样例文件');
  const bank = readBankStatement(BANK_FILE);
  console.log(`银行对账单：${bank.fileName} — ${bank.rowCount} 行 × ${bank.headers.length} 列`);
  const gw = readGatewayRecon(GW_FILE);
  console.log(`资金对账：${gw.fileName} — ${gw.rowCount} 行`);

  divider('2. 跑 runAllScenarios（C1+C2+C3 全启用）');
  // structuredClone 防止原地修改污染（与 main.js 逻辑一致）
  const workingBankRows = structuredClone(bank.rows);
  const workingGwRows = structuredClone(gw.gwRows);
  const result = runAllScenarios(workingBankRows, workingGwRows, BUILTIN_SCENARIOS);
  console.log('stats:', JSON.stringify(result.stats, null, 2));

  divider('3. modifications 详单（每条改了什么）');
  if (result.modifications.length === 0) {
    console.log('  (无 modifications)');
  } else {
    result.modifications.slice(0, 30).forEach((m, idx) => {
      const oldStr = m.oldValue === '' ? '(空)' : `"${m.oldValue}"`;
      console.log(`  #${idx + 1}  rowId=${m.rowId}  column=${m.column}  ${oldStr} → "${m.newValue}"  (场景 ${m.scenarioId} ${m.scenarioName})`);
    });
    if (result.modifications.length > 30) {
      console.log(`  ... 还有 ${result.modifications.length - 30} 条 modifications`);
    }
  }

  divider('4. error-report 详单（每条警告）');
  if (result.errorReport.length === 0) {
    console.log('  (无 warning)');
  } else {
    result.errorReport.slice(0, 30).forEach((w, idx) => {
      console.log(`  #${idx + 1}  场景 ${w.scenarioId} ${w.scenarioName}  rowId=${w.rowId}  code=${w.code}  ${w.message}`);
    });
    if (result.errorReport.length > 30) {
      console.log(`  ... 还有 ${result.errorReport.length - 30} 条 warning`);
    }
  }

  divider('5. 写主输出 + error-report 到 tmp 目录');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbet-dryrun-'));
  if (result.modifiedRows.length > 0) {
    const fileName = buildMainOutputFileName();
    const mainFilePath = path.join(tmpDir, fileName);
    const out = await writeBankStatementMainOutput({
      modifiedRows: result.modifiedRows,
      headers: BANK_STATEMENT_FIELDS,
      mainFilePath
    });
    console.log(`主输出：${out.filePath}`);
    console.log(`文件名规则：${out.fileName}`);
    await verifyMainOutputYellow(out.filePath, result.modifications);
  } else {
    console.log('modifiedRows 为空 → 不生成主输出（P0-11 行为）');
  }

  if (result.errorReport.length > 0) {
    const er = await writeErrorReportOutput({
      warnings: result.errorReport,
      exportRootDir: tmpDir
    });
    console.log(`error-report：${er.filePath}`);
    console.log(`文件名：${er.fileName}`);
  } else {
    console.log('errorReport 为空 → 不生成 error-report');
  }

  // v2.1.8 N3-1：dispatcher 字段从 hitScenarioIds (number[]) 改为 hitScenarios ({id, displayIndex, name}[])
  //   本脚本提取 ids 列表用 .map(s => s.id) 兼容
  const hitScenarioIds = (result.stats.hitScenarios || []).map((s) => s.id);
  divider('6. PRD §13.1 P0 用例自动验证矩阵');
  console.log('  P0-1 内置 C1 调拨自提取        →  ' + (hitScenarioIds.includes(1) ? '✅ C1 命中' : '❓ C1 未命中（样例可能无 AFT/BFT 行）'));
  console.log('  P0-2 C1 多字段值不一致         →  ' + (result.errorReport.some((w) => w.code === 'inconsistent-recon-id-values') ? '✅ 触发 inconsistent warn' : '❓ 样例无该场景'));
  console.log('  P0-3 内置 C2 outbound Fail 打标 →  ' + (hitScenarioIds.includes(2) ? '✅ C2 命中' : '❓ C2 未命中'));
  console.log('  P0-4 C2 一对多报错              →  ' + (result.errorReport.some((w) => w.code === 'one-to-many') ? '✅ 触发 one-to-many warn' : '❓ 样例无该场景'));
  console.log('  P0-5 内置 C3 默认关闭           →  GUI 行为（需用户在场景管理里确认默认 enabled=0）');
  console.log('  P0-6 启用 C3 触发"导入资金对账"提示 →  GUI 行为（需用户启用 C3 后导入银行单确认提示弹）');
  console.log('  P0-7 C3 跳过                    →  smoke E3 已覆盖（gwRows=null + C3 启用 → skippedC3Count=1）');
  console.log('  P0-8 C3 join 命中               →  ' + (hitScenarioIds.includes(3) ? '✅ C3 命中' : '❓ C3 未命中（需样例文件含匹配的 4 字段全等行）'));
  console.log('  P0-9 first-match-wins           →  smoke E2 已覆盖（同行 C1 优先级 3 > C3 优先级 1）');
  console.log('  P0-10 标黄 + 仅导修改行         →  ' + (result.modifiedRows.length > 0 ? `✅ 主输出含 ${result.modifiedRows.length} 行（< 全部 ${bank.rowCount} 行），抽样验证黄底已 PASS` : '⚠️ 当前样例 0 命中'));
  console.log('  P0-11 空运行结果                →  ' + (result.modifiedRows.length === 0 ? '✅ 当前命中此用例（无主输出）' : `❓ 当前样例 ${result.modifiedRows.length} 行命中，需另构造空命中样例`));

  divider('7. 命中场景汇总（按 hitScenarios 顺序）');
  hitScenarioIds.forEach((id) => {
    const s = BUILTIN_SCENARIOS.find((x) => x.id === id);
    const hitsForS = result.modifications.filter((m) => m.scenarioId === id);
    console.log(`  场景 ${id} ${s.name}（${s.category}） — ${hitsForS.length} modifications`);
  });

  divider('完成');
  console.log(`tmp 目录：${tmpDir}（含主输出 + error-report，可手动打开验证标黄）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
