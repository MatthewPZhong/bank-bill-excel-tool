// 主功能「月度 Pending 移除核对」端到端集成测试（v2.1.11 T2 / 🔴 资金·对账红线）
//   覆盖：
//     1. 移除归档 xlsx 真实文件解析（removed-reader 第一 sheet + 46 列表头校验）→ replaceByMonth 入库
//     2. 对账（engine.runReconciliation）产出 missing → matchRemoval 配对（复用 matchFields 语义）
//     3. exportSingleRun 导出 → 读回 xlsx 校验：
//        - sheetA「missing核对移除」存在、位置在最右区、含末列「移除核对状态」
//        - 状态列三态（手测增强）：核对无误 / 核对有差异：<字段(missing≠移除)> / missing有_移除无 正确逐行对应
//        - sheetB「移除有_missing无」存在（有未匹配 removed 时）、46 列结构、按 raw 还原
//        - sheet 顺序：移除核对 2 sheet 在原有 sheet 之后（最右）
//     4. 幂等 + 边界：无移除数据时不追加（行为零变化）
//     5. 🔴 内容核对（compareFields 共用对账规则）：配对后比对内容，金额格式不同但数值同→核对无误；
//        金额真不同→核对有差异（复用 C1 数值归一化，展示原始值）
//
// 端到端契约（真实 SQLite + 真实 xlsx 读写）：移除核对错误 = 对账结论错误（资金红线），
// 必须 e2e 验匹配结果 → 导出标记的完整链路一致性。
//
// 用法：node scripts/integration/pending-removal-reconcile.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx-js-style');

const { runMigrations } = require('../../src/backend/pending-db/migrations');
const PENDING_COLUMNS = require('../../src/backend/pending-db/columns');
const removedReader = require('../../src/backend/pending-import/removed-reader');
const removedRepo = require('../../src/backend/pending-db/removed-repository');
const monthRepo = require('../../src/backend/pending-db/month-repository');
const reconcileEngine = require('../../src/backend/pending-reconcile/engine');
const removalMatch = require('../../src/backend/pending-reconcile/removal-match');
const ruleRepo = require('../../src/backend/pending-db/rule-repository');
const exportWriter = require('../../src/backend/pending-export/writer');
// C1 端到端：pending 侧走真实流式 reader（数值 cell → String(parseFloat)）
const { readXlsxStreamed } = require('../../src/backend/pending-import/streaming-xlsx-reader');

const UPPER = '2026-04';
const LOWER = '2026-05';

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

// 插一条 pending_rows，仅给 order_no（其余空），row_hash 用 order_no+月唯一
function insertPending(db, ym, orderNo) {
  const hash = `${ym}|${orderNo}`;
  db.prepare(
    'INSERT INTO pending_rows (year_month, row_hash, `order_no`) VALUES (?, ?, ?)'
  ).run(ym, hash, orderNo);
}

// 写一个符合 46 列模板的移除归档 xlsx（第一行表头 + 数据行）；orderNos = 每行的 order_no 值
function writeRemovedXlsx(filePath, orderNos) {
  const headers = removedReader.REMOVED_PENDING_COLUMNS.slice(); // 46 列
  const orderIdx = headers.indexOf('order_no');
  const aoa = [headers];
  for (const o of orderNos) {
    const row = headers.map(() => '');
    row[orderIdx] = o;
    aoa.push(row);
  }
  // 模板 sheet 名是数字 ID（reader 取第一个 sheet，不硬编码）→ 这里用一个数字串 sheet 名验证 D-T2-4
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '1405800876820465666');
  XLSX.writeFile(wb, filePath);
}

// C1 端到端：写一个「金额列为数值 cell（numFmt #,##0.00）」的移除归档 xlsx。
//   removed-reader 用 sheet_to_json({raw:false}) → 金额渲染为显示格式串（如 "1,234.50" 带千分位+尾零）。
//   amounts = 每行金额（number）；orderNos = 每行 order_no（可空串）
function writeRemovedXlsxNumericAmount(filePath, rows) {
  const headers = removedReader.REMOVED_PENDING_COLUMNS.slice(); // 46 列
  const amtIdx = headers.indexOf('金额');
  const ordIdx = headers.indexOf('order_no');
  const aoa = [headers];
  for (const _ of rows) aoa.push(headers.map(() => ''));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  rows.forEach((row, i) => {
    const r = i + 1; // 数据行从第 2 行（r=1）起
    const amtAddr = XLSX.utils.encode_cell({ r, c: amtIdx });
    ws[amtAddr] = { t: 'n', v: row.amount, z: '#,##0.00' }; // 数值 + 千分位 numFmt
    if (row.orderNo != null && row.orderNo !== '') {
      const ordAddr = XLSX.utils.encode_cell({ r, c: ordIdx });
      ws[ordAddr] = { t: 's', v: String(row.orderNo) };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '1405800876820465666');
  XLSX.writeFile(wb, filePath);
}

// C1 端到端：写一个 31 列 pending xlsx，金额列为数值 cell。
//   streaming-xlsx-reader 对 type='n' cell → String(parseFloat(<v>))（如 1234.50 → "1234.5"，与入库口径一致）。
//   返回 filePath；amounts = 每行金额（number），orderNos 同序（可空）
function writePendingXlsxNumericAmount(filePath, rows) {
  const headers = PENDING_COLUMNS.slice(); // 31 列
  const amtIdx = headers.indexOf('金额');
  const ordIdx = headers.indexOf('order_no');
  const aoa = [headers];
  for (const _ of rows) aoa.push(headers.map(() => ''));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  rows.forEach((row, i) => {
    const r = i + 1;
    const amtAddr = XLSX.utils.encode_cell({ r, c: amtIdx });
    ws[amtAddr] = { t: 'n', v: row.amount, z: '#,##0.00' };
    if (row.orderNo != null && row.orderNo !== '') {
      const ordAddr = XLSX.utils.encode_cell({ r, c: ordIdx });
      ws[ordAddr] = { t: 's', v: String(row.orderNo) };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'data'); // 第一个 sheet → 写成 sheet1.xml（streaming-reader 读 sheet1.xml）
  XLSX.writeFile(wb, filePath);
}

// 读回 xlsx → { sheetNames, sheets: { name: aoa } }
function readBackXlsx(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false, raw: false });
  }
  return { sheetNames: wb.SheetNames, sheets };
}

async function run() {
  console.log('==== Pending 移除核对 集成验证 ====');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-removal-'));
  const removedFile = path.join(tmpDir, '移除归档Pending账单.xlsx');
  const exportFile = path.join(tmpDir, 'export-single.xlsx');
  const exportNoRemovedFile = path.join(tmpDir, 'export-no-removed.xlsx');

  try {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    // ============================================================
    // Step 1: 插 pending 两月
    //   upper(2026-04): O1 O2 O3 ；lower(2026-05): O1
    //   → 配对 O1；missing = O2 O3（upper 未配对）；new = (无，lower 只有 O1 已配)
    // ============================================================
    insertPending(db, UPPER, 'O1');
    insertPending(db, UPPER, 'O2');
    insertPending(db, UPPER, 'O3');
    insertPending(db, LOWER, 'O1');
    const upperCount = db.prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?').get(UPPER).n;
    assertEq(upperCount, 3, 'Step1.upper 月 3 行');

    // ============================================================
    // Step 2: 写移除归档 xlsx → reader 解析 → 入库
    //   removed(2026-04): O2（匹配 missing O2）, O9（无 missing → 移除有_missing无）
    // ============================================================
    writeRemovedXlsx(removedFile, ['O2', 'O9']);
    const parsed = removedReader.readRemovedPendingFile(removedFile);
    assertEq(parsed.headerRow.length, 46, 'Step2.移除模板解析 46 列');
    assertEq(parsed.totalRows, 2, 'Step2.解析 2 数据行');
    assertEq(parsed.sourceSheetName, '1405800876820465666', 'Step2.取第一个数字 sheet 名（D-T2-4）');

    const repl = removedRepo.replaceByMonth(db, UPPER, parsed.rows, parsed.fileName);
    assertEq(repl.inserted, 2, 'Step2.入库 2 行');
    assertEq(removedRepo.countByMonth(db, UPPER), 2, 'Step2.countByMonth=2');

    // ============================================================
    // Step 3: 设规则 + 对账 → missing
    // ============================================================
    ruleRepo.upsertRule(db, { matchFields: ['order_no'], compareFields: [] });
    const rule = ruleRepo.getRule(db);
    const reconResult = reconcileEngine.runReconciliation(db, { upperMonth: UPPER, lowerMonth: LOWER, rule });
    assertEq(reconResult.statMissing, 2, 'Step3.missing = 2（O2 O3）');
    assertTrue(reconResult.runId > 0, 'Step3.runId 有效');
    const runId = reconResult.runId;

    // ============================================================
    // Step 4: matchRemoval（对账后匹配）
    //   O2 missing ↔ O2 removed 配上；O3 missing 无 removed；O9 removed 无 missing
    // ============================================================
    const mr = removalMatch.matchRemoval(db, runId, UPPER, rule.matchFields);
    assertEq(mr.matchedCount, 1, 'Step4.配上 1 对（O2）');
    assertEq(mr.missingUnmatched, 1, 'Step4.missing 未配 1（O3 = missing有_移除无）');
    assertEq(mr.removedUnmatched, 1, 'Step4.removed 未配 1（O9 = 移除有_missing无）');

    // ============================================================
    // Step 5: exportSingleRun → 读回校验 2 sheet
    // ============================================================
    const exp = exportWriter.exportSingleRun(db, runId, exportFile);
    assertEq(exp.status, 'success', 'Step5.导出成功');
    assertEq(exp.removalReconcileAppended, true, 'Step5.移除核对 sheet 已追加');
    assertEq(exp.missingReconRowCount, 2, 'Step5.sheetA missing 行数 = 2');
    assertEq(exp.removalOnlyRowCount, 1, 'Step5.sheetB 未匹配 removed 行数 = 1');

    assertTrue(fs.existsSync(exportFile), 'Step5.导出文件存在');
    const back = readBackXlsx(exportFile);

    // sheetA / sheetB 名（D-T2-7）
    const nameA = exportWriter.SHEET_MISSING_REMOVAL_NAME; // missing核对移除
    const nameB = exportWriter.SHEET_REMOVAL_ONLY_NAME;     // 移除有_missing无
    assertTrue(back.sheetNames.includes(nameA), `Step5.含 sheetA「${nameA}」`);
    assertTrue(back.sheetNames.includes(nameB), `Step5.含 sheetB「${nameB}」`);

    // sheet 顺序：移除核对 2 sheet 在原有 sheet 之后（最右）
    const idxA = back.sheetNames.indexOf(nameA);
    const idxB = back.sheetNames.indexOf(nameB);
    // 汇总 sheet 一定是第 0 个；A/B 在其后
    assertTrue(idxA > 0, 'Step5.sheetA 在原有 sheet 之后');
    assertTrue(idxB > idxA, 'Step5.sheetB 紧随 sheetA（最右）');
    assertEq(idxB, back.sheetNames.length - 1, 'Step5.sheetB 是最后一张（最右）');

    // ---- sheetA 列结构：末列 = 移除核对状态 ----
    const aoaA = back.sheets[nameA];
    const headerA = aoaA[0];
    assertEq(headerA[headerA.length - 1], exportWriter.REMOVAL_STATUS_COLUMN, 'Step5.sheetA 末列 = 移除核对状态');
    // 表头前 31 列 = PENDING_COLUMNS（diff_type 等 meta 列在中间）
    assertEq(headerA.slice(0, PENDING_COLUMNS.length), PENDING_COLUMNS.slice(), 'Step5.sheetA 前 31 列 = PENDING_COLUMNS');

    // ---- sheetA 状态列值（手测增强三态）：compareFields=[] → 配上即「核对无误」；未配上「missing有_移除无」 ----
    //   O2 配上且 compareFields 为空（无可比内容）→ 核对无误；O3 未配上 → missing有_移除无
    const orderColIdx = PENDING_COLUMNS.indexOf('order_no');
    const statusColIdx = headerA.length - 1;
    const dataA = aoaA.slice(1);
    assertEq(dataA.length, 2, 'Step5.sheetA 数据 2 行');
    const o2Row = dataA.find((r) => r[orderColIdx] === 'O2');
    const o3Row = dataA.find((r) => r[orderColIdx] === 'O3');
    assertTrue(!!o2Row && !!o3Row, 'Step5.sheetA 含 O2 / O3 行');
    assertEq(o2Row[statusColIdx], exportWriter.REMOVAL_STATUS_VERIFIED, 'Step5.O2 状态 = 核对无误（配上 + compareFields 空）');
    assertEq(o3Row[statusColIdx], exportWriter.REMOVAL_STATUS_MISSING_ONLY, 'Step5.O3 状态 = missing有_移除无');

    // ---- sheetB 结构：46 列；唯一行 order_no=O9 ----
    const aoaB = back.sheets[nameB];
    const headerB = aoaB[0];
    assertEq(headerB.length, 46, 'Step5.sheetB 46 列');
    assertEq(headerB, removedReader.REMOVED_PENDING_COLUMNS.slice(), 'Step5.sheetB 表头 = REMOVED_PENDING_COLUMNS');
    const dataB = aoaB.slice(1);
    assertEq(dataB.length, 1, 'Step5.sheetB 1 行');
    const bOrderIdx = removedReader.REMOVED_PENDING_COLUMNS.indexOf('order_no');
    assertEq(dataB[0][bOrderIdx], 'O9', 'Step5.sheetB 行 order_no = O9（未匹配 removed）');

    // ============================================================
    // Step 6: 幂等 — 重复 matchRemoval + 重新导出，结果不变（不累积）
    // ============================================================
    const mr2 = removalMatch.matchRemoval(db, runId, UPPER, rule.matchFields);
    assertEq(mr2.matchedCount, 1, 'Step6.重复 matchRemoval 仍 1 对（幂等）');
    const totalMatches = db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?').get(runId).n;
    assertEq(totalMatches, 1, 'Step6.匹配表不累积');

    // ============================================================
    // Step 7: 边界 — upperMonth 无移除数据时不追加 2 sheet（行为零变化）
    //   新建另一组月份对账（upper=2026-02 无 removed）
    // ============================================================
    const U2 = '2026-02';
    const L2 = '2026-03';
    insertPending(db, U2, 'A1');
    insertPending(db, U2, 'A2');
    insertPending(db, L2, 'A1');
    const recon2 = reconcileEngine.runReconciliation(db, { upperMonth: U2, lowerMonth: L2, rule });
    const exp2 = exportWriter.exportSingleRun(db, recon2.runId, exportNoRemovedFile);
    assertEq(exp2.removalReconcileAppended, false, 'Step7.无移除数据 → 不追加移除核对 sheet（零变化）');
    const back2 = readBackXlsx(exportNoRemovedFile);
    assertTrue(!back2.sheetNames.includes(nameA), 'Step7.无 sheetA');
    assertTrue(!back2.sheetNames.includes(nameB), 'Step7.无 sheetB');

    // ============================================================
    // Step 8 🔴 C1 端到端：金额数值格式归一化（真实双 reader 口径不一致仍能配对）
    //   pending 经真实 streaming-xlsx-reader（金额数值 cell → "1234.5"）；
    //   removed 经真实 removed-reader（金额 numFmt #,##0.00 → "1,234.50" 带千分位+尾零）；
    //   matchFields=['金额'] → 归一化前两侧串不等会双误报，归一化后应配上。
    // ============================================================
    const U3 = '2026-07';
    const L3 = '2026-08';
    const pendingNumFile = path.join(tmpDir, 'pending-numeric.xlsx');
    const removedNumFile = path.join(tmpDir, 'removed-numeric.xlsx');

    // pending upper(2026-07)：金额 1234.50 + 1000.00（无对应 lower → 全 missing）
    writePendingXlsxNumericAmount(pendingNumFile, [
      { amount: 1234.5, orderNo: '' },
      { amount: 1000, orderNo: '' }
    ]);
    // 真实流式 reader 解析 → 入 pending_rows（照搬入库：金额列写 reader 产出串）
    const pAmtIdx = PENDING_COLUMNS.indexOf('金额');
    let pendingRowSeq = 0;
    const insStmt = db.prepare('INSERT INTO pending_rows (year_month, row_hash, `金额`) VALUES (?, ?, ?)');
    await readXlsxStreamed(pendingNumFile, (cells, rowIdx) => {
      if (rowIdx === 1) return; // 表头
      pendingRowSeq += 1;
      insStmt.run(U3, `${U3}|num|${pendingRowSeq}`, cells[pAmtIdx]);
    }, { colCount: PENDING_COLUMNS.length });
    // 断言 pending 入库口径：金额被流式 reader 归一化为 String(parseFloat)（"1234.5" / "1000"）
    const pAmts = db.prepare('SELECT `金额` AS a FROM pending_rows WHERE year_month = ? ORDER BY id').all(U3).map((r) => r.a);
    assertEq(pAmts, ['1234.5', '1000'], 'Step8.pending 流式 reader 金额入库口径 = String(parseFloat)');
    // lower(2026-08) 留空（upper 全部 missing）

    // removed(2026-07)：金额 1234.50 + 1000.00（numFmt 显示格式）
    writeRemovedXlsxNumericAmount(removedNumFile, [
      { amount: 1234.5, orderNo: '' },
      { amount: 1000, orderNo: '' }
    ]);
    const parsedNum = removedReader.readRemovedPendingFile(removedNumFile);
    // 断言 removed reader 金额产出显示格式（带千分位/尾零）—— 与 pending 口径不一致
    assertEq(parsedNum.rows.map((r) => r['金额']), ['1,234.50', '1,000.00'],
      'Step8.removed reader 金额 = 显示格式串（千分位+尾零，与 pending 口径不同）');
    removedRepo.replaceByMonth(db, U3, parsedNum.rows, parsedNum.fileName);

    // 对账（金额做 matchField）→ missing；matchRemoval 金额归一化后应全配
    ruleRepo.upsertRule(db, { matchFields: ['金额'], compareFields: [] });
    const ruleNum = ruleRepo.getRule(db);
    const reconNum = reconcileEngine.runReconciliation(db, { upperMonth: U3, lowerMonth: L3, rule: ruleNum });
    assertEq(reconNum.statMissing, 2, 'Step8.upper 2 行全 missing');
    const mrNum = removalMatch.matchRemoval(db, reconNum.runId, U3, ruleNum.matchFields);
    assertEq(mrNum.matchedCount, 2, 'Step8.🔴 金额格式不一致仍配上 2 对（C1 归一化）');
    assertEq(mrNum.missingUnmatched, 0, 'Step8.无 missing有_移除无 误报');
    assertEq(mrNum.removedUnmatched, 0, 'Step8.无 移除有_missing无 误报');

    // ============================================================
    // Step 9 🔴 内容核对三态（compareFields 共用对账规则 + 真实双 reader）：
    //   用 order_no 配对（稳定），compareFields=['金额'] 做内容核对：
    //     - VOK：pending 金额 1234.50（streaming→"1234.5"）vs removed 1234.50（reader→"1,234.50"）
    //            → 数值相同 → 核对无误（验证复用 C1 归一化，格式不同不误报）
    //     - VDIFF：pending 金额 500（→"500"）vs removed 600.00（→"600.00"）→ 真不同 → 核对有差异：金额(500≠600.00)
    //   导出读回 sheetA 断言状态列三态文字 + 差异文字显示原始值。
    // ============================================================
    const U4 = '2026-09';
    const L4 = '2026-10';
    const pendingCmpFile = path.join(tmpDir, 'pending-compare.xlsx');
    const removedCmpFile = path.join(tmpDir, 'removed-compare.xlsx');
    const exportCmpFile = path.join(tmpDir, 'export-compare.xlsx');

    // pending upper(2026-09)：VOK(order=VOK, 金额 1234.50)、VDIFF(order=VDIFF, 金额 500)（无 lower → 全 missing）
    writePendingXlsxNumericAmount(pendingCmpFile, [
      { amount: 1234.5, orderNo: 'VOK' },
      { amount: 500, orderNo: 'VDIFF' }
    ]);
    const pOrdIdx = PENDING_COLUMNS.indexOf('order_no');
    let cmpSeq = 0;
    const insCmpStmt = db.prepare(
      'INSERT INTO pending_rows (year_month, row_hash, `order_no`, `金额`) VALUES (?, ?, ?, ?)'
    );
    await readXlsxStreamed(pendingCmpFile, (cells, rowIdx) => {
      if (rowIdx === 1) return; // 表头
      cmpSeq += 1;
      insCmpStmt.run(U4, `${U4}|cmp|${cmpSeq}`, cells[pOrdIdx], cells[pAmtIdx]);
    }, { colCount: PENDING_COLUMNS.length });
    // pending 入库金额口径：String(parseFloat) → "1234.5" / "500"
    const pCmpAmts = db.prepare('SELECT `金额` AS a FROM pending_rows WHERE year_month = ? ORDER BY id').all(U4).map((r) => r.a);
    assertEq(pCmpAmts, ['1234.5', '500'], 'Step9.pending 金额入库口径');

    // removed(2026-09)：VOK(order=VOK, 金额 1234.50)、VDIFF(order=VDIFF, 金额 600.00)
    writeRemovedXlsxNumericAmount(removedCmpFile, [
      { amount: 1234.5, orderNo: 'VOK' },
      { amount: 600, orderNo: 'VDIFF' }
    ]);
    const parsedCmp = removedReader.readRemovedPendingFile(removedCmpFile);
    // removed reader 金额显示格式：VOK="1,234.50"、VDIFF="600.00"
    assertEq(parsedCmp.rows.map((r) => r['金额']), ['1,234.50', '600.00'], 'Step9.removed 金额显示格式');
    removedRepo.replaceByMonth(db, U4, parsedCmp.rows, parsedCmp.fileName);

    // 规则：order_no 配对 + compareFields=['金额'] 内容核对
    ruleRepo.upsertRule(db, { matchFields: ['order_no'], compareFields: ['金额'] });
    const ruleCmp = ruleRepo.getRule(db);
    const reconCmp = reconcileEngine.runReconciliation(db, { upperMonth: U4, lowerMonth: L4, rule: ruleCmp });
    assertEq(reconCmp.statMissing, 2, 'Step9.upper 2 行全 missing');
    const mrCmp = removalMatch.matchRemoval(db, reconCmp.runId, U4, ruleCmp.matchFields);
    assertEq(mrCmp.matchedCount, 2, 'Step9.order_no 配上 2 对（VOK / VDIFF）');

    // 内容核对（compareMatchedContent 直测）：VOK 无误、VDIFF 有差异
    const contentMap = removalMatch.compareMatchedContent(db, reconCmp.runId, ruleCmp.compareFields);
    assertEq(contentMap.size, 2, 'Step9.内容核对覆盖 2 个配对行');

    // 导出读回 sheetA 校验状态列三态文字
    const expCmp = exportWriter.exportSingleRun(db, reconCmp.runId, exportCmpFile);
    assertEq(expCmp.status, 'success', 'Step9.导出成功');
    const backCmp = readBackXlsx(exportCmpFile);
    const aoaCmpA = backCmp.sheets[exportWriter.SHEET_MISSING_REMOVAL_NAME];
    const headerCmpA = aoaCmpA[0];
    const ordColCmp = PENDING_COLUMNS.indexOf('order_no');
    const statusColCmp = headerCmpA.length - 1;
    const dataCmpA = aoaCmpA.slice(1);
    const vokRow = dataCmpA.find((r) => r[ordColCmp] === 'VOK');
    const vdiffRow = dataCmpA.find((r) => r[ordColCmp] === 'VDIFF');
    assertTrue(!!vokRow && !!vdiffRow, 'Step9.sheetA 含 VOK / VDIFF 行');
    // 🔴 关键：金额格式不同（1234.5 vs 1,234.50）但数值相同 → 核对无误（不误报）
    assertEq(vokRow[statusColCmp], exportWriter.REMOVAL_STATUS_VERIFIED,
      'Step9.🔴 VOK 金额格式不同但数值相同 → 核对无误（复用 C1 归一化）');
    // 金额真不同 → 核对有差异，差异文字含字段名 + 原始值（500 / 600.00）
    assertEq(vdiffRow[statusColCmp], `${exportWriter.REMOVAL_STATUS_DIFF_PREFIX}金额(500≠600.00)`,
      'Step9.VDIFF 金额真不同 → 核对有差异：金额(500≠600.00)（展示原始值）');

    // ============================================================
    // Step 10 🔴 Codex PR #55 Finding 1（对账数据污染红线）：
    //   覆盖导入同月 pending（worker.js:84 → monthRepo.deleteMonth）必须清掉该月旧移除归档
    //   + 关联核对匹配。否则旧 removed_pending_rows 残留 → reconcile handler
    //   （main.js `pending:reconcile:run`：countByMonth(upperMonth)>0 即自动 matchRemoval）
    //   会用陈旧旧归档给新 missing 标错状态——即使用户点「否，跳过」也复用了旧归档。
    //
    //   构造：上月(2026-11) 先导入移除归档 + 对账产 missing + matchRemoval 落 matches，
    //   随后覆盖导入同月 pending（deleteMonth）→ 断言旧移除/匹配全清，新对账不复用。
    // ============================================================
    const U5 = '2026-11';
    const L5 = '2026-12';
    const removedF1File = path.join(tmpDir, 'finding1-removed.xlsx');

    // 上月 3 行（F1/F2/F3），下月配上 F1 → missing = F2 F3
    insertPending(db, U5, 'F1');
    insertPending(db, U5, 'F2');
    insertPending(db, U5, 'F3');
    insertPending(db, L5, 'F1');

    // 导入移除归档：F2 命中 missing F2
    writeRemovedXlsx(removedF1File, ['F2']);
    const parsedF1 = removedReader.readRemovedPendingFile(removedF1File);
    removedRepo.replaceByMonth(db, U5, parsedF1.rows, parsedF1.fileName);
    assertEq(removedRepo.countByMonth(db, U5), 1, 'Step10.移除归档入库 countByMonth=1');

    ruleRepo.upsertRule(db, { matchFields: ['order_no'], compareFields: [] });
    const ruleF1 = ruleRepo.getRule(db);
    const reconF1 = reconcileEngine.runReconciliation(db, { upperMonth: U5, lowerMonth: L5, rule: ruleF1 });
    assertEq(reconF1.statMissing, 2, 'Step10.missing = 2（F2 F3）');
    const mrF1 = removalMatch.matchRemoval(db, reconF1.runId, U5, ruleF1.matchFields);
    assertEq(mrF1.matchedCount, 1, 'Step10.matchRemoval 配上 1 对（F2）');

    // 前置：matches 表确有记录（覆盖导入前）
    const matchesBefore = db
      .prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?')
      .get(reconF1.runId).n;
    assertEq(matchesBefore, 1, 'Step10.覆盖导入前 pending_removal_matches = 1');

    // 🔴 覆盖导入同月 pending（worker.js 覆盖导入核心调用）
    monthRepo.deleteMonth(db, U5);

    // 断言：旧移除归档已清（reconcile handler countByMonth>0 判定失效 → 新对账不复用旧归档）
    assertEq(removedRepo.countByMonth(db, U5), 0,
      'Step10.🔴 覆盖导入同月 → removed_pending_rows 清空（countByMonth=0，旧归档不复用）');
    // 断言：该 run 关联的核对匹配清空（避免 run 删后留孤儿污染）
    //   注意：用 WHERE run_id 限定本 run —— 前面 step（U3/U4 等）也调过 matchRemoval，
    //   它们的 matches 属于各自月份，本次 deleteMonth(U5) 不应触及（隔离性见下条断言）。
    const matchesAfter = db
      .prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?')
      .get(reconF1.runId).n;
    assertEq(matchesAfter, 0, 'Step10.🔴 该 run 关联 pending_removal_matches 清空（无孤儿残留）');
    // 隔离：其它月（如 U4=2026-09）的核对匹配不受 deleteMonth(U5) 影响
    const u4RunId = db.prepare('SELECT id FROM diff_runs WHERE upper_month = ?').get('2026-09');
    if (u4RunId) {
      assertTrue(
        db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?').get(u4RunId.id).n > 0,
        'Step10.隔离：其它月（2026-09）的 pending_removal_matches 不受影响'
      );
    }
    // 回归：该月 pending / diff 链路同样清空（不破坏现有 deleteMonth 行为）
    assertEq(db.prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?').get(U5).n, 0,
      'Step10.回归：该月 pending_rows 清空');
    assertEq(db.prepare('SELECT COUNT(*) AS n FROM diff_rows WHERE run_id = ?').get(reconF1.runId).n, 0,
      'Step10.回归：该 run 的 diff_rows 清空');
    assertEq(db.prepare('SELECT COUNT(*) AS n FROM diff_runs WHERE id = ?').get(reconF1.runId).n, 0,
      'Step10.回归：该 run 的 diff_runs 清空');
    // 隔离：下月（L5，非覆盖目标）pending 行不受影响
    assertEq(db.prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?').get(L5).n, 1,
      'Step10.隔离：下月 pending_rows 不受影响');

    db.close();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
