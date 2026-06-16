// v3.0.7 需求2d + 修复1 集成测试：「导入文件」按钮通用导入 —— 路由分流端到端契约。
//   bank-statement:batch-import handler 把导入 IPC 升级为「通用导入」：合并预处理识别与链接表识别为一套
//   候选集 ALL_TABLE_SIGNATURES（🔴 不含 bank-deposit），逐文件 detectTableType 后路由：
//     - bank-statement 命中 → 读 Channel 二次路由（逐行判定 Channel+地区，🔴 非组合字符串比白名单）：
//       至少一行非空 Channel 且全部非空 Channel 行都是入金行（ADM/BOC 按裸 Channel 忽略地区、JPM 仅 US）
//       → 该文件【需额外落 bank-deposit 链接表】；否则（含常规渠道 / JPM-HK / 空文件）→ 不落链接表。
//     - 链接签名（mid-allocation/gateway/fx/fx-option）→ 对应链接表（fx-option=unsupported）。
//   🔴🔴 修复1（资金红线 · 语义变更）：ADM/BOC/JPM-US 银行单从旧「落表 XOR 对账」改为「既落表 AND 对账」——
//     落 bank-deposit 链接表是【副作用】（供 JPM-US 二跳 / ADM / BOC 交叉引用），同一文件的行【同时】并入
//     bankStatementSession 走 R1-R5 对账、出现在「开始运行 → 导出」结果表（不再 continue 跳过对账）。
//     故谓词 isBankDepositChannelFile=true 的语义由「跳过对账、只落表」更正为「需额外落表（仍照常对账）」。
//   本测试用真实 .xlsx fixture 串真实代码：detectTableType（通用候选集）+ database.isBankDepositChannelFile
//   （44列 Channel 二次路由谓词，与 C1 状态框前缀同源同模块的纯函数）+ 真实 bank-deposit 落库读回，验证「识别 + 路由分流」契约。
//   覆盖：
//     1. 🔴 UT-D1 不回归：44 列 bank-deposit 同构文件经 ALL_TABLE_SIGNATURES 唯一命中 bank-statement（不 ambiguous）。
//     2. 常规渠道银行对账单（含 Channel=Other 行）→ detector matched/bank-statement → 谓词假（只对账、不落链接表）。
//     3. 纯 ADM/BOC/JPM-US 入金表（BOC 地区=CN，贴合真实数据）→ matched/bank-statement，逐行全入金 → 谓词真（需额外落表），
//        且真实 upsertLinkedBankDeposit 落库后 readLinkedTableRows('bank-deposit') 读回行数一致（落库副作用真实生效）。
//     3b. 🔴 回归护栏：混合 ADM(地区空)+BOC(地区CN)+JPM(地区US) 一份文件 → 谓词真（带地区的 BOC 不拖垮整份判定）。
//     4. JPM-US 口径精确：Channel='JPM'∧地区='US' → 谓词真；地区='HK'（JPM-HK）→ 谓词假。
//     5. 空文件（仅表头）→ 无非空 Channel 行 → 谓词假（保守，绝不吞为"需额外落表"）。
//     6. 链接签名（中台调拨订单 mid-allocation）→ detector matched/zhongtai-dispatch-order → 路由=linked。
//     7. 外汇期权表 → detector unsupported（候选集纳入但本阶段不落库）。
//   注：handler 是 IPC+dialog 绑定无法直接调；本测试镜像其「detectTableType + Channel 谓词」路由决策
//     （与 v3.0.1-linked-gateway-upsert.js 同范式），detectTableType / isBankDepositChannelFile / 仓储 facade 均调真实实现。
//   ⚠️ 修复1 端到端【人工回归点】（本脚本不便驱动 handler 的 merge-into-session）：
//     ADM/BOC/JPM-US 文件的行【同时】并入 bankStatementSession 走 R1-R5、出现在导出结果表 —— 由 handler 控制流保证
//     （删 continue + 复用 merge 路径 outcome:'processed' result + 挂 alsoLinked 副作用）。GUI 手测覆盖：导入
//     一份 BOC/JPM-US 入金表 → 状态框应显示「已导入：…N行」+「N 行已同时存入银行对账单表链接表」，且开始运行后
//     这些行出现在结果表。
//   ⚠️ 其余未覆盖（靠人工回归）：handler 内 processingResult/reconIdFixResult 清空、完整 ADM/BOC 派生链编排
//     （已抽至 importLinkedFileToRepo 与 linked-derive-rebuild.js，由 linked-table:import 既有测试 + GUI 手测覆盖）。
//
// 用法：node scripts/integration/bank-statement-universal-import-routing.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { detectTableType } = require('../../src/main-process/table-type-detector');
const { ALL_TABLE_SIGNATURES, BANK_DEPOSIT_SIGNATURE } = require('../../src/constants/table-signatures');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE, FX_OPTION_SIGNATURE } = require('../../src/constants/table-signatures');
const { AppDatabase } = require('../../src/backend/database');

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label, actual: cond, expected: true });
}

const BANK_STATEMENT_SHEET_NAME = '渠道对账单';
const HEADERS = BANK_STATEMENT_FIELDS; // 44 列；Channel idx5 / 地区 idx6

// 按 {表头名:值} 建一行 44 列数组（未列出列留空）。
function bankRowAoa(fields) {
  return HEADERS.map((h) => {
    const v = fields[h];
    if (v === undefined) return '';
    return typeof v === 'number' ? v : String(v);
  });
}

// 写银行对账单同构 44 列 .xlsx（sheet「渠道对账单」，单 sheet → detector streamingEligible=true）。
function writeBankStatementFile(filePath, dataRows) {
  const aoa = [HEADERS, ...dataRows.map(bankRowAoa)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), BANK_STATEMENT_SHEET_NAME);
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 写中台调拨订单（mid-allocation）.xlsx（sheet「Sheet1」）。
function writeDispatchFile(filePath) {
  const sig = ZHONGTAI_DISPATCH_ORDER_SIGNATURE;
  const headers = sig.expectedHeaders;
  const dataRow = headers.map((h) => {
    if (h === '调拨单号') return 'DSP-1';
    if (h === '调拨状态') return '成功';
    if (h === '交易时间') return '2026-06-01 10:00:00';
    return 'x';
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, dataRow]), 'Sheet1');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 写外汇期权订单 .xlsx（sheet「交易数据」，第 0 行标题、表头在第 1 行 → headerRowOffset=1）。
function writeFxOptionFile(filePath) {
  const sig = FX_OPTION_SIGNATURE;
  const headers = sig.expectedHeaders;
  const dataRow = headers.map((h) => (h === '货币对/ID' ? 'EUR/USD' : 'x'));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['期权交易数据'], headers, dataRow]), '交易数据');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// bank-statement Channel 二次路由谓词：🔴 直接调用 handler 同源的真实纯函数（database.isBankDepositChannelFile，
//   透传 channel-enum-repository.isBankDepositChannelFile），不手抄逻辑 → 杜绝 mirror 漂移（本批次修复根因）。
//   逐行 Channel+地区 判定：ADM/BOC 按裸 Channel 忽略地区、JPM 仅 US 入金；至少一行非空 Channel 且全为入金行 → 真。
//   🔴 修复1 语义更正：谓词为真不再等于「跳过对账、只落表」，而是「该文件需【额外】落 bank-deposit 链接表（副作用），
//     同时照常并入对账 session 走 R1-R5」——故返回值由 'linked-bank-deposit'/'preprocess' 改为
//     'also-link-bank-deposit'（既落表又对账）/ 'preprocess-only'（只对账、不落链接表），口径更贴合 handler 现状。
function decideBankStatementRoute(db, rows) {
  return db.isBankDepositChannelFile(rows) ? 'also-link-bank-deposit' : 'preprocess-only';
}

// 把刚写的 bank-statement 文件读成对象数组（用 readBankStatement 真实读，拿 Channel/地区 列）。
const { readBankStatement } = require('../../src/main-process/bank-statement-io');

async function run() {
  console.log('==== v3.0.7 需求2d 通用导入路由分流 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-import-'));
  const dbPath = path.join(tmpDir, 'tool-data.sqlite');
  let appDb = null;
  try {
    appDb = new AppDatabase(dbPath);
    appDb.init(); // 建表 + 跑迁移（linked_bank_deposit 等表）

    // ---- 用例1+2：常规渠道银行对账单（含 Channel=Other 行）----
    const regularFile = path.join(tmpDir, '银行对账单-常规.xlsx');
    writeBankStatementFile(regularFile, [
      { BizId: 'B1', Channel: 'ADM', '地区': '', 'Credit Amount': '100' },
      { BizId: 'B2', Channel: 'Other', '地区': 'CN', 'Credit Amount': '200' } // 常规渠道 → 不应吞为入金表
    ]);
    const detRegular = await detectTableType(regularFile, ALL_TABLE_SIGNATURES);
    assertEq(detRegular.status, 'matched', '用例1 常规银行对账单 detector status=matched（不 ambiguous，证 UT-D1 不回归）');
    assertEq(detRegular.tableKey, 'bank-statement', '用例1 常规银行对账单 detector tableKey=bank-statement');
    const regularRows = readBankStatement(regularFile).rows;
    assertEq(decideBankStatementRoute(appDb, regularRows), 'preprocess-only', '用例2 含常规渠道 Other → 谓词假（只对账、不落链接表）');

    // ---- 用例3：纯 ADM/BOC/JPM-US 入金表 → 谓词真（需额外落 bank-deposit 链接表），且真实落库读回 ----
    //   🔴 BOC 行 地区='CN'（贴合真实数据：boc-fx-link-fields.js BOC_BANK_FILTER.地区='CN'）——
    //     回归本批次修复：旧组合判定会拼成 'BOC-CN' ∉ 白名单致误路由到预处理；修复后逐行判定 BOC 忽略地区 → bank-deposit。
    const depositFile = path.join(tmpDir, '银行对账单-入金表.xlsx');
    writeBankStatementFile(depositFile, [
      { BizId: 'D1', Channel: 'ADM', '地区': '', 'Credit Amount': '100' },
      { BizId: 'D2', Channel: 'BOC', '地区': 'CN', 'Credit Amount': '200' }, // 真实 BOC 入金行 地区=CN
      { BizId: 'D3', Channel: 'JPM', '地区': 'US', 'Credit Amount': '300' }
    ]);
    const detDeposit = await detectTableType(depositFile, ALL_TABLE_SIGNATURES);
    assertEq(detDeposit.status, 'matched', '用例3 入金表 detector status=matched（44列同构经 ALL 唯一命中，UT-D1 不回归）');
    assertEq(detDeposit.tableKey, 'bank-statement', '用例3 入金表 detector tableKey=bank-statement（不含 bank-deposit 签名）');
    const depositRows = readBankStatement(depositFile).rows;
    assertEq(decideBankStatementRoute(appDb, depositRows), 'also-link-bank-deposit', '用例3 纯 ADM/BOC/JPM-US → 谓词真（需额外落 bank-deposit 链接表 + 仍照常对账）');
    // 真实落库（与 importLinkedFileToRepo 同口径 upsert 数组版）+ 读回，证落库副作用真实生效（修复1：落表是副作用，与对账并存）。
    const { pickBankDepositFields } = require('../../src/backend/database/linked-table-repository');
    const ret = appDb.upsertLinkedBankDeposit(depositRows.map((r) => pickBankDepositFields(r)), { sourceFileName: '银行对账单-入金表.xlsx' });
    assertEq(ret.rowCount, 3, '用例3 bank-deposit 落库 rowCount=3');
    const readBack = appDb.readLinkedTableRows('bank-deposit') || [];
    assertEq(readBack.length, 3, '用例3 readLinkedTableRows(bank-deposit) 读回 3 行（落库副作用生效；同源行另由 handler 并入对账 session，见顶部人工回归点）');

    // ---- 用例3b（🔴 回归护栏）：混合 ADM(地区='')+BOC(地区='CN')+JPM(地区='US') 一份文件 → bank-deposit ----
    //   专护「带地区的 BOC 不拖垮整份文件判定」：旧组合判定 'BOC-CN' ∉ 白名单会让 every() 失败 →
    //   整份（连 ADM/JPM-US 行）被误路由到预处理；修复后逐行判定全为入金行 → linked-bank-deposit。
    const mixedFile = path.join(tmpDir, '银行对账单-混合入金表.xlsx');
    writeBankStatementFile(mixedFile, [
      { BizId: 'M1', Channel: 'ADM', '地区': '', 'Credit Amount': '100' },
      { BizId: 'M2', Channel: 'BOC', '地区': 'CN', 'Credit Amount': '200' }, // 带地区的 BOC（旧实现的杀手）
      { BizId: 'M3', Channel: 'JPM', '地区': 'US', 'Credit Amount': '300' }
    ]);
    const mixedRows = readBankStatement(mixedFile).rows;
    assertEq(decideBankStatementRoute(appDb, mixedRows), 'also-link-bank-deposit',
      '用例3b 混合 ADM(地区空)+BOC(地区CN)+JPM(地区US) → 谓词真（带地区的 BOC 不拖垮 every()）');

    // ---- 用例4：JPM-US 口径精确（地区='US' vs 地区='HK'）----
    const jpmUsRows = readBankStatement(
      (() => { const f = path.join(tmpDir, 'jpm-us.xlsx'); writeBankStatementFile(f, [{ BizId: 'J1', Channel: 'JPM', '地区': 'US' }]); return f; })()
    ).rows;
    assertEq(decideBankStatementRoute(appDb, jpmUsRows), 'also-link-bank-deposit', '用例4 Channel=JPM∧地区=US → JPM-US ∈ 白名单 → 谓词真（需额外落表）');
    const jpmHkRows = readBankStatement(
      (() => { const f = path.join(tmpDir, 'jpm-hk.xlsx'); writeBankStatementFile(f, [{ BizId: 'J2', Channel: 'JPM', '地区': 'HK' }]); return f; })()
    ).rows;
    assertEq(decideBankStatementRoute(appDb, jpmHkRows), 'preprocess-only', '用例4 Channel=JPM∧地区=HK → JPM-HK ∉ 白名单 → 谓词假（只对账；纯比 Channel 列会误判）');

    // ---- 用例5：空文件（仅表头，无数据行）→ 无非空 Channel 行 → 谓词假（保守，不吞为"需额外落表"）----
    const emptyFile = path.join(tmpDir, '银行对账单-空.xlsx');
    writeBankStatementFile(emptyFile, []);
    const detEmpty = await detectTableType(emptyFile, ALL_TABLE_SIGNATURES);
    // 仅表头无数据：detector 可能 matched（表头命中）；路由谓词 sawChannel 守卫保证无入金行时谓词假（不落链接表、仍只对账）。
    const emptyRows = readBankStatement(emptyFile).rows;
    assertEq(appDb.extractChannelRegionCombos(emptyRows).length, 0, '用例5 空文件 combos 为空集（前提：无任何非空 Channel 行）');
    assertEq(decideBankStatementRoute(appDb, emptyRows), 'preprocess-only', '用例5 空文件 → 谓词假（sawChannel 守卫，绝不吞为"需额外落表"）');
    assertTrue(detEmpty.status === 'matched' || detEmpty.status === 'read-error' || detEmpty.status === 'unrecognized',
      '用例5 空文件 detector status 合法（matched/read-error/unrecognized 之一，不崩溃）');

    // ---- 用例6：链接签名（中台调拨订单 mid-allocation）→ linked 路由 ----
    const dispatchFile = path.join(tmpDir, '中台调拨订单.xlsx');
    writeDispatchFile(dispatchFile);
    const detDispatch = await detectTableType(dispatchFile, ALL_TABLE_SIGNATURES);
    assertEq(detDispatch.status, 'matched', '用例6 中台调拨订单 detector status=matched');
    assertEq(detDispatch.tableKey, 'zhongtai-dispatch-order', '用例6 中台调拨订单 detector tableKey=zhongtai-dispatch-order → 路由=linked');

    // ---- 用例7：外汇期权表 → unsupported（候选集纳入但本阶段不落库）----
    const fxOptionFile = path.join(tmpDir, '外汇期权订单.xlsx');
    writeFxOptionFile(fxOptionFile);
    const detFxOption = await detectTableType(fxOptionFile, ALL_TABLE_SIGNATURES);
    assertEq(detFxOption.status, 'unsupported', '用例7 外汇期权表 detector status=unsupported（不落库，待阶段二）');
    assertEq(detFxOption.tableKey, 'fx-option', '用例7 外汇期权表 detector tableKey=fx-option');

    // ---- 守护：ALL_TABLE_SIGNATURES 不含 bank-deposit 签名（候选集红线）----
    assertEq(ALL_TABLE_SIGNATURES.some((s) => s.tableKey === 'bank-deposit'), false,
      '守护 ALL_TABLE_SIGNATURES 绝不含 bank-deposit 签名（与 bank-statement 同构必 ambiguous，UT-D1）');
    assertEq(BANK_DEPOSIT_SIGNATURE.tableKey, 'bank-deposit',
      '守护 BANK_DEPOSIT_SIGNATURE 仍独立导出（供 44列→Channel 二次路由命中后显式取用）');
  } finally {
    if (appDb && appDb.db) { try { appDb.db.close(); } catch (e) { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
