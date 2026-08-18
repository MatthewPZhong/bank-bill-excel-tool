// v3.0.1 需求1（task3）集成测试：网关对账单链接表「跨次幂等累加 upsert」端到端契约。
//   镜像 main.js `linked-table:import` handler 的网关分支（流式 + 数组两路），用真实 .xlsx fixture
//   串起真实代码：detector 路由 → 流式/数组 upsert → 按 ReconBillBizId 累加 + 覆盖/空键计数。
//     1. detector 对「物理单 sheet 网关 .xlsx」→ matched/gateway-recon + streamingEligible=true。
//     2. 流式 upsert 首次导入（3 个不同 bizId）→ rowCount=3、overwriteCount=0、rejectedEmptyCount=0。
//     3. 流式 upsert 第二次累加（1 重复 bizId 值不同 + 2 新）→ rowCount=5、overwriteCount=1，
//        被覆盖 bizId 的 raw_json 读回为 file2 新值（证明覆盖语义，非整表替换）。
//     4. 空键拒入（ReconBillBizId='' 1 行 + 正常新键 1 行）→ rejectedEmptyCount=1、空键行未入库、rowCount=6。
//     5. 数组路径（多 sheet → streamingEligible=false）：readRowsWithMetadata + upsertLinkedGatewayBill 同口径累加。
//   注：handler 是 IPC+dialog 绑定无法直接调；本测试镜像其 feed 循环 / 数组 zip（与 v3.0.0 流式测试镜像 feed 同范式），
//     detector / streamLinkedRowsToInsert / readRowsWithMetadata / 仓储 facade 均调真实实现。
//
//   ⚠️ 未覆盖（PR#68 self-review #5，🔴 资金红线，靠人工回归）：linked-table:import handler 内
//     「gateway-bill upsert 导入 / bank-deposit 导入 / deleteByDateRange 删除成功后 processingResult = null」
//     是 main.js 模块级运行时状态的局部副作用，未抽成独立可测函数（不同于已抽到 bank-statement-merge.js 的批量清空），
//     在不拉起 Electron 的前提下无法直接断言。人工回归路径：先跑银行对账 → 重导/删 网关对账单 或 重导 bank-deposit
//     → 必须重跑对账才能导出（导出端不再拿旧 refundBackfillRows / 网关核销结果）。
//
// 用法：node scripts/integration/v3.0.1-linked-gateway-upsert.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { detectTableType } = require('../../src/main-process/table-type-detector');
const { LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
const { readRowsWithMetadata } = require('../../src/backend/file-service/readers');
const { normalizeCell } = require('../../src/backend/file-service/common');

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

// 网关对账单签名（tableKey='gateway-recon' → 仓储 repoKey='gateway-bill'）。
const SIG = LINKED_IMPORT_SIGNATURES.find((s) => s.tableKey === 'gateway-recon');
const HEADERS = SIG.expectedHeaders; // 31 列（关键：ReconBillBizId idx13 / reconciliationid idx14 / Billdate idx0）

// 按表头名建一行（未列出的列留空字符串）→ 转 31 列数组（aoa 一行）。
function rowAoa(fields) {
  return HEADERS.map((h) => {
    const v = fields[h];
    if (v === undefined) return '';
    return typeof v === 'number' ? v : String(v);
  });
}

function buildAoa(dataRows) {
  return [HEADERS, ...dataRows.map(rowAoa)];
}

// 单 sheet → detector streamingEligible=true（流式路径）。bookSST:true 流式 reader 必需。
function writeSingleSheet(filePath, dataRows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildAoa(dataRows)), '1409155847565936642');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 多 sheet → detector streamingEligible=false（数组路径）。
function writeMultiSheet(filePath, dataRows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['封面'], ['说明']]), '封面');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildAoa(dataRows)), '网关对账单');
  XLSX.writeFile(wb, filePath, { bookSST: true });
}

// 镜像 main.js readLinkedRowsAsObjects（数组路径 zip；闭包未导出，调真实 readRowsWithMetadata + 同口径 zip）。
function readGatewayRowsAsObjects(filePath, sheetName) {
  const expected = HEADERS;
  const result = readRowsWithMetadata(filePath, [], { sheetName });
  const rows = Array.isArray(result.rows) ? result.rows : [];
  let headerRowIdx = -1;
  let colOffset = -1;
  for (let ri = 0; ri < rows.length && headerRowIdx < 0; ri += 1) {
    const row = Array.isArray(rows[ri]) ? rows[ri] : [];
    const maxStart = row.length - expected.length;
    for (let cs = 0; cs <= maxStart; cs += 1) {
      let matched = true;
      for (let i = 0; i < expected.length; i += 1) {
        if (normalizeCell(expected[i]) !== normalizeCell(row[cs + i])) { matched = false; break; }
      }
      if (matched) { headerRowIdx = ri; colOffset = cs; break; }
    }
  }
  if (headerRowIdx < 0) throw new Error('数组路径未定位到表头');
  const objects = [];
  for (let ri = headerRowIdx + 1; ri < rows.length; ri += 1) {
    const row = Array.isArray(rows[ri]) ? rows[ri] : [];
    const obj = {};
    for (let i = 0; i < expected.length; i += 1) {
      const headerName = normalizeCell(expected[i]);
      if (headerName === '') continue;
      const cell = row[colOffset + i];
      obj[headerName] = normalizeCell(cell === undefined ? '' : cell);
    }
    objects.push(obj);
  }
  return objects;
}

// 镜像 handler 网关流式分支：feedRows 复用真实 streamLinkedRowsToInsert（网关 transform=恒等）。
async function streamUpsert(appDb, filePath) {
  return appDb.upsertLinkedGatewayBillStreaming(async (writeOne) => {
    const { matched } = await streamLinkedRowsToInsert(filePath, SIG, writeOne, (x) => x);
    assertTrue(matched, '流内定位到网关表头');
  }, { sourceFileName: path.basename(filePath), legacySource: true });
}

// 构一行网关数据（仅填关键字段 + 少量列；其余留空）。
function gwRow(bizId, reconId, billDate, amount) {
  return {
    Billdate: billDate,
    Channel: 'PAY',
    merchantid: 'M001',
    orderid: 'O-' + bizId,
    ReconBillBizId: bizId,
    reconciliationid: reconId,
    amount
  };
}

async function run() {
  console.log('==== v3.0.1 需求1 网关对账单幂等 upsert 集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-gw-upsert-'));
  const file1 = path.join(tmpDir, 'gw1.xlsx');
  const file2 = path.join(tmpDir, 'gw2.xlsx');
  const file3 = path.join(tmpDir, 'gw3.xlsx');
  const fileArr = path.join(tmpDir, 'gw-multi.xlsx');
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  try {
    // file1：3 行，3 个不同 bizId
    const data1 = [
      gwRow('B-1', 'R-1', '2026-06-01', '10'),
      gwRow('B-2', 'R-2', '2026-06-02', '20'),
      gwRow('B-3', 'R-3', '2026-06-03', '30')
    ];
    writeSingleSheet(file1, data1);

    // Step1：detector 单 sheet 网关 xlsx → matched/gateway-recon + streamingEligible=true
    const d1 = await detectTableType(file1, LINKED_IMPORT_SIGNATURES);
    assertEq(d1.status, 'matched', 'Step1.单sheet status=matched');
    assertEq(d1.tableKey, 'gateway-recon', 'Step1.单sheet tableKey=gateway-recon');
    assertEq(d1.streamingEligible, true, 'Step1.单sheet streamingEligible=true');

    appDb = new AppDatabase(dbPath);
    appDb.init();

    // Step2：流式 upsert 首次导入 → rowCount=3、overwriteCount=0、rejectedEmptyCount=0
    const r1 = await streamUpsert(appDb, file1);
    assertEq(r1.rowCount, 3, 'Step2.首次导入 rowCount=3');
    assertEq(r1.overwriteCount, 0, 'Step2.首次导入 overwriteCount=0');
    assertEq(r1.rejectedEmptyCount, 0, 'Step2.首次导入 rejectedEmptyCount=0');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill').length, 3, 'Step2.DB 实查 3 行');

    // Step3：流式 upsert 第二次累加 → file2：B-2 重复（值不同）+ B-4/B-5 新 → rowCount=5、overwriteCount=1
    const data2 = [
      gwRow('B-2', 'R-2X', '2026-06-12', '999'), // 与 file1 的 B-2 重复，值不同（测覆盖）
      gwRow('B-4', 'R-4', '2026-06-04', '40'),
      gwRow('B-5', 'R-5', '2026-06-05', '50')
    ];
    writeSingleSheet(file2, data2);
    const r2 = await streamUpsert(appDb, file2);
    assertEq(r2.rowCount, 5, 'Step3.第二次累加 rowCount=5（3+2 新，非整表覆盖）');
    assertEq(r2.overwriteCount, 1, 'Step3.第二次累加 overwriteCount=1（B-2 命中）');
    assertEq(r2.rejectedEmptyCount, 0, 'Step3.第二次累加 rejectedEmptyCount=0');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill').length, 5, 'Step3.DB 实查 5 行');
    // 被覆盖的 B-2 读回 raw_json = file2 新值（证明覆盖语义）
    const backAfter2 = linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill');
    const b2 = backAfter2.find((r) => r.ReconBillBizId === 'B-2');
    assertTrue(!!b2, 'Step3.读回 B-2');
    assertEq(b2 && b2.reconciliationid, 'R-2X', 'Step3.B-2 reconciliationid 已覆盖为 file2 值 R-2X');
    assertEq(b2 && b2.amount, '999', 'Step3.B-2 amount 已覆盖为 file2 值 999');

    // Step4：空键拒入 → file3：B-EMPTY（ReconBillBizId='' 空）+ B-6（正常新键）→ rejectedEmptyCount=1、rowCount=6
    const data3 = [
      gwRow('', 'R-EMPTY', '2026-06-06', '60'), // 空 bizId → 拒入
      gwRow('B-6', 'R-6', '2026-06-07', '70')
    ];
    writeSingleSheet(file3, data3);
    const r3 = await streamUpsert(appDb, file3);
    assertEq(r3.rejectedEmptyCount, 1, 'Step4.空键拒入 rejectedEmptyCount=1');
    assertEq(r3.rowCount, 6, 'Step4.仅 +1 正常行 rowCount=6（空键行未入库）');
    const backAfter3 = linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill');
    assertEq(backAfter3.length, 6, 'Step4.DB 实查 6 行');
    assertEq(backAfter3.some((r) => r.reconciliationid === 'R-EMPTY'), false, 'Step4.空键行未入库');

    // Step5：数组路径（多 sheet → streamingEligible=false）→ readRowsWithMetadata + upsertLinkedGatewayBill 同口径累加
    const dataArr = [
      gwRow('B-2', 'R-2Y', '2026-06-22', '888'), // 再覆盖 B-2（值不同）
      gwRow('B-7', 'R-7', '2026-06-08', '80')     // 新键
    ];
    writeMultiSheet(fileArr, dataArr);
    const dArr = await detectTableType(fileArr, LINKED_IMPORT_SIGNATURES);
    assertEq(dArr.status, 'matched', 'Step5.多sheet status=matched');
    assertEq(dArr.tableKey, 'gateway-recon', 'Step5.多sheet tableKey=gateway-recon');
    assertEq(dArr.streamingEligible, false, 'Step5.多sheet streamingEligible=false（数组路径）');
    const arrRows = readGatewayRowsAsObjects(fileArr, dArr.sheetName);
    assertEq(arrRows.length, 2, 'Step5.数组路径读出 2 行');
    const r5 = appDb.upsertLinkedGatewayBill(arrRows, {
      sourceFileName: 'gw-multi.xlsx',
      legacySource: true
    });
    assertEq(r5.overwriteCount, 1, 'Step5.数组路径 overwriteCount=1（B-2 命中）');
    assertEq(r5.rowCount, 7, 'Step5.数组路径累加 rowCount=7（6+1 新 B-7）');
    assertEq(r5.rejectedEmptyCount, 0, 'Step5.数组路径 rejectedEmptyCount=0');

    // Step6：对账读取口径不变 —— readLinkedTableRows 读回校验最终行数/值
    const backFinal = linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill');
    assertEq(backFinal.length, 7, 'Step6.最终 DB 7 行');
    const b2Final = backFinal.find((r) => r.ReconBillBizId === 'B-2');
    assertEq(b2Final && b2Final.reconciliationid, 'R-2Y', 'Step6.B-2 最终值=数组路径覆盖后 R-2Y');
    const b7 = backFinal.find((r) => r.ReconBillBizId === 'B-7');
    assertTrue(!!b7, 'Step6.数组路径新键 B-7 已入库');

    // Step7：按数据日期范围删除（v3.0.1 task4，🔴 资金红线）。
    //   当前 7 行 bill_date（经 upsert 覆盖后最终值）：
    //     B-1=2026-06-01, B-2=2026-06-22（数组路径 R-2Y 覆盖后）, B-3=2026-06-03,
    //     B-4=2026-06-04, B-5=2026-06-05, B-6=2026-06-07, B-7=2026-06-08
    //   先 count 预览闭区间 [2026-06-03, 2026-06-05] → 命中 B-3/B-4/B-5 共 3 行（含两端点）。
    const previewCount = appDb.countGatewayBillByDateRange('2026-06-03', '2026-06-05');
    assertEq(previewCount, 3, 'Step7.count 闭区间 [06-03,06-05] 预览 3 行（B-3/B-4/B-5，含端点）');
    // 区间无命中预览
    assertEq(appDb.countGatewayBillByDateRange('2026-07-01', '2026-07-31'), 0, 'Step7.count 区间无命中预览 0 行');

    // delete 该闭区间 → deleted=3、剩余 4 行（B-1/B-2/B-6/B-7）、meta 全表重算。
    const delRet = appDb.deleteGatewayBillByDateRange('2026-06-03', '2026-06-05');
    assertEq(delRet.deleted, 3, 'Step7.delete deleted=3（B-3/B-4/B-5）');
    assertEq(delRet.rowCount, 4, 'Step7.delete 后 meta.rowCount=4（全表重算 7-3）');
    assertEq(delRet.dataDateMin, '2026-06-01', 'Step7.delete 后 dataDateMin=2026-06-01（B-1）');
    assertEq(delRet.dataDateMax, '2026-06-22', 'Step7.delete 后 dataDateMax=2026-06-22（B-2 覆盖后）');

    const backAfterDel = linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill');
    assertEq(backAfterDel.length, 4, 'Step7.DB 实查删后 4 行');
    const remainBiz = backAfterDel.map((r) => r.ReconBillBizId).sort();
    assertEq(remainBiz, ['B-1', 'B-2', 'B-6', 'B-7'], 'Step7.剩余 bizId = B-1/B-2/B-6/B-7');
    assertEq(backAfterDel.some((r) => r.ReconBillBizId === 'B-3'), false, 'Step7.B-3 已删');
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
