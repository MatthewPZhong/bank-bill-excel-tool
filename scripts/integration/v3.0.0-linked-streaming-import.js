// v3.0.0 块 B 集成测试：链接表大文件流式导入链路端到端契约（detector → 落库 → ADM 候选）
//   用真实 .xlsx fixture 串起 PR-1/PR-2/PR-3 的真实代码：
//     1. detector 对「物理单 sheet .xlsx」返回 matched/bank-deposit + streamingEligible=true（PR-1/PR-2 路由输入）
//     2. detector 对「多 sheet .xlsx」返回 streamingEligible=false（维持数组路径，不退化）
//     3. replaceLinkedTableStreaming + readXlsxStreamed 流式落库 → DB row_count 正确、值口径正确（PR-2）
//     4. readBankDepositAdmCandidates 只返回 Channel=ADM 子集（PR-3）
//   注：流式行源 feed 循环镜像 main.js streamLinkedRowsToInsert（闭包未导出）；其余均调真实实现。
//
// 用法：node scripts/integration/v3.0.0-linked-streaming-import.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { detectTableType } = require('../../src/main-process/table-type-detector');
const { LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
const { CHANNEL_VALUE, ADM_FUND_TYPES } = require('../../src/constants/adm-bank-deposit-fields');

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

const SIG = LINKED_IMPORT_SIGNATURES.find((s) => s.tableKey === 'bank-deposit');
const HEADERS = SIG.expectedHeaders; // 44 列

// 按表头名建一行（未列出的列留空字符串）→ 转 44 列数组（aoa 一行）。
//   数字保留为数值（写成 t="n"，模拟真实文件金额列）→ 流式 String(parseFloat) 口径；其余 String 化。
function rowAoa(fields) {
  return HEADERS.map((h) => {
    const v = fields[h];
    if (v === undefined) return '';
    return typeof v === 'number' ? v : String(v);
  });
}

// 5 行：2 行 Channel=ADM（Fundtransfer-out）+ 3 行 JPM。Credit Amount 为数字（测数字口径）。
const DATA = [
  { ReconciliationId: 'R-ADM-1', BillDate: '2026-05-06', Channel: CHANNEL_VALUE, FundType: ADM_FUND_TYPES[0], CustomerRef: 'REF1', ChannelOrderNo: 'CO1', 'Credit Amount': 1.2 },
  { ReconciliationId: 'R-JPM-1', BillDate: '2026-05-07', Channel: 'JPM', FundType: 'X', 'Credit Amount': 2.5 },
  { ReconciliationId: 'R-ADM-2', BillDate: '2026-05-08', Channel: CHANNEL_VALUE, FundType: ADM_FUND_TYPES[1], CustomerRef: 'REF2', ChannelOrderNo: 'CO2', 'Credit Amount': 3 },
  { ReconciliationId: 'R-JPM-2', BillDate: '2026-05-09', Channel: 'JPM', FundType: 'Y', 'Credit Amount': 4 },
  { ReconciliationId: 'R-JPM-3', BillDate: '2026-05-10', Channel: 'PingPong', FundType: 'Z', 'Credit Amount': 5 }
];

function writeSingleSheet(filePath) {
  const aoa = [HEADERS, ...DATA.map(rowAoa)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  // bookSST:true → 字符串走 sharedStrings（流式 reader 的 s 分支可读；默认 inline t="str" 流式读不出）。
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

function writeMultiSheet(filePath) {
  const aoa = [HEADERS, ...DATA.map(rowAoa)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['封面'], ['说明']]), '封面');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 单 sheet + 中间一行全空（测 streamLinkedRowsToInsert 的 isRowMeaningful 空行过滤 = 对齐数组路径）
function writeSingleSheetWithBlankRow(filePath) {
  const rows = DATA.map(rowAoa);
  rows.splice(2, 0, HEADERS.map(() => '')); // 第 3 行插一整行空（44 列全空字符串）
  const aoa = [HEADERS, ...rows];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '渠道对账单');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

async function run() {
  console.log('==== v3.0.0 块B 链接表流式导入 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-stream-import-'));
  const singleFile = path.join(tmpDir, 'single.xlsx');
  const multiFile = path.join(tmpDir, 'multi.xlsx');
  const blankRowFile = path.join(tmpDir, 'single-blank.xlsx');
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  try {
    writeSingleSheet(singleFile);
    writeMultiSheet(multiFile);

    // Step1：detector 物理单 sheet .xlsx → matched/bank-deposit + streamingEligible=true
    const dSingle = await detectTableType(singleFile, LINKED_IMPORT_SIGNATURES);
    assertEq(dSingle.status, 'matched', 'Step1.单sheet status=matched');
    assertEq(dSingle.tableKey, 'bank-deposit', 'Step1.单sheet tableKey=bank-deposit');
    assertEq(dSingle.streamingEligible, true, 'Step1.单sheet streamingEligible=true');

    // Step2：detector 多 sheet .xlsx → 仍 matched 但 streamingEligible=false（维持数组路径）
    const dMulti = await detectTableType(multiFile, LINKED_IMPORT_SIGNATURES);
    assertEq(dMulti.status, 'matched', 'Step2.多sheet status=matched');
    assertEq(dMulti.tableKey, 'bank-deposit', 'Step2.多sheet tableKey=bank-deposit');
    assertEq(dMulti.streamingEligible, false, 'Step2.多sheet streamingEligible=false');

    // Step3：流式落库（PR-2 真实 replaceLinkedTableStreaming + 真实 readXlsxStreamed）
    appDb = new AppDatabase(dbPath);
    appDb.init();
    const { pickBankDepositFields } = linkedRepo;
    const ret = await appDb.replaceLinkedTableStreaming('bank-deposit', async (insertOne) => {
      const { matched } = await streamLinkedRowsToInsert(singleFile, SIG, insertOne, pickBankDepositFields);
      assertTrue(matched, 'Step3.流内定位到表头');
    }, { sourceFileName: 'single.xlsx' });
    assertEq(ret.rowCount, 5, 'Step3.流式落库 rowCount=5');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit').length, 5, 'Step3.DB 实际 5 行');

    // Step4：值口径 —— 读回首行校验关键字段（裁列到 13 字段 + 值正确）
    const back = linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit');
    const r1 = back.find((r) => r.ReconciliationId === 'R-ADM-1');
    assertTrue(!!r1, 'Step4.读回 R-ADM-1');
    assertEq(r1 && r1.Channel, CHANNEL_VALUE, 'Step4.R-ADM-1 Channel=ADM');
    assertEq(r1 && r1['Credit Amount'], '1.2', 'Step4.R-ADM-1 Credit Amount=1.2（数字 String(parseFloat) 口径）');
    assertEq(r1 && Object.keys(r1).length, 13, 'Step4.bank-deposit 裁列后 13 字段');

    // Step5：ADM 候选下推过滤（PR-3）→ 只 Channel=ADM 的 2 行
    const cands = linkedRepo.readBankDepositAdmCandidates(appDb.db);
    assertEq(cands.length, 2, 'Step5.readBankDepositAdmCandidates=2（仅 Channel=ADM）');
    assertEq(cands.map((r) => r.ReconciliationId).sort(), ['R-ADM-1', 'R-ADM-2'], 'Step5.候选=R-ADM-1/2');
    assertEq(linkedRepo.hasLinkedTableRows(appDb.db, 'bank-deposit'), true, 'Step5.hasLinkedTableRows=true');

    // Step6：🔴 全空行过滤（Finding-1 回归）——含 1 行全空的单 sheet 流式落库，空行被 isRowMeaningful 跳过（对齐数组路径，防空 key 垃圾行 + row_count 虚高）
    writeSingleSheetWithBlankRow(blankRowFile);
    const retBlank = await appDb.replaceLinkedTableStreaming('bank-deposit', async (insertOne) => {
      const { matched } = await streamLinkedRowsToInsert(blankRowFile, SIG, insertOne, pickBankDepositFields);
      assertTrue(matched, 'Step6.流内定位到表头');
    }, { sourceFileName: 'single-blank.xlsx' });
    assertEq(retBlank.rowCount, 5, 'Step6.含1空行文件流式落库 rowCount=5（空行被跳过，非 6）');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'bank-deposit').length, 5, 'Step6.DB 实际 5 行（无空 key 垃圾行）');
  } finally {
    try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
