'use strict';
// v2.1.12-beta 收单导入提速 contract test（🔴🔴 byte-for-byte 资金红线闸）
//
// 锁：reader-handrolled.js（yauzl + 手写字节扫描）与 reader.js（yauzl + sax）byte-for-byte 同输出。
//   背景：收单导入是 raw_json / 对账金额 / 币种的入库真理源；换解析器（sax→手写）提速 5.6x，
//   必须证「不算错账」——同一批 fixture 上两 reader 解析出的每行每列值、monthKey、importedCount、
//   抛出的 ImportValidationError.message 全等。
//
// 测法（参考 POC parser-compare.js equal mode 的 monkeypatch 手法）：
//   monkeypatch import-repository 的 prepareFlowInsert/prepareBillInsert → 假 stmt，
//   insertFlowRow/insertBillRow → 捕获 payload.row.values（不进 DB，只抓 reader 解析结果）。
//   reader.js 与 reader-handrolled.js require 同一 importRepo 单例，patch 后两者共用同一捕获逻辑。
//   每跑一个 reader 前重新 patch + 新建捕获容器，逐行逐列比对。
//   peekMonthKeyFromFile 直接调用比对返回值；错误用例比对抛出的 ImportValidationError.message。
//
// fixture 两种来源：
//   - writeFixtureExcelJS：ExcelJS（默认用 sharedStrings t="s" 存所有字符串）→ 天然覆盖 #6 共享串路径
//     + 稀疏行号（getRow 显式行号）。
//   - writeRawSheetXlsx：yazl 手工拼 sheet1.xml（精确控制 cell 形态）→ 覆盖 inlineStr（真实 prod 数据形态）
//     + 边缘 cell（多 <t> / 公式 <f>+<v> / 科学计数 number / 布尔 / 错误类型 / XML 实体）。
//     reader 仅读 xl/worksheets/sheet1.xml(+xl/sharedStrings.xml)，不经 SheetJS/ExcelJS 打开 →
//     最小 zip（仅这两个 entry）即可被两 reader 解析。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const yazl = require('yazl');

const importRepo = require('../../../../src/backend/acquiring-bill-currency-db/import-repository');
const saxReader = require('../../../../src/backend/acquiring-bill-currency-import/reader');
const handReader = require('../../../../src/backend/acquiring-bill-currency-import/reader-handrolled');
const {
  parseAcquiringRowXml,
  cellValueFromBody,
  cellHasText,
  FLOW_VALUE_COLUMN_WHITELIST,
  streamSheetRowsHandRolled
} = require('../../../../src/backend/acquiring-bill-currency-import/reader-handrolled');
const { FLOW_HEADERS, BILL_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const { extractMonthKey, validateFlowHeaders } = require('../../../../src/backend/acquiring-bill-currency-import/validator');
// reader.js 内部 helper（contract 三方对比的「手写全列」B 路径直接驱动 streamSheetRowsHandRolled 需要）
const {
  openZipWithEntries,
  loadSharedStrings,
  SHEET_ENTRY_NAME,
  SHARED_STRINGS_ENTRY_NAME
} = require('../../../../src/backend/acquiring-bill-currency-import/reader');

// v3.0.3 PR-P1 文件头说明（追加，不改既有头注释意图）：
//   本 contract 升级为「三方 byte-for-byte 对比」——证收单 flow 解析列裁剪等价：
//     A = sax importFlowFile（全列基线）
//     B = 手写解析器「全列模式」（streamSheetRowsHandRolled + valueColumnWhitelist=null，复刻 onRow 逻辑捕获每行）
//     C = 手写解析器「白名单模式」= 真实 importFlowFile（已注入 FLOW_VALUE_COLUMN_WHITELIST，仅解码 4/48 列）
//   断言闭环：
//     A≡B（全 48 列 + monthKey + importedCount + rowIndex）  —— 证手写算法 == sax（与裁剪无关）
//     B≡C（白名单内列全等 + 白名单外列 C 恒空 + hasAnyCellText 逐行全等 + 行集合全等）—— 证裁剪等价
//     A≡C（importedCount + monthKey + 白名单内列；白名单外列下游不消费故不比）—— 证端到端 DB 维度安全
//   bill 路径仍走既有「A=sax vs C=手写」二方（bill 本 PR 传 null 不裁剪，全列必须全等）。

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

// ---- fixture helpers ----

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// 行数组工具：长度 len，o 是 {colIndex: value}
function row(len, o) {
  const r = new Array(len).fill('');
  for (const k of Object.keys(o)) r[Number(k)] = o[k];
  return r;
}

// ExcelJS fixture（默认 sharedStrings t="s"）。rows 为二维数组；sparse 为 [{rowNum, cells}]。
async function writeFixtureExcelJS({ name = 'Sheet1', rows, sparse }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  if (sparse) {
    for (const { rowNum, cells } of sparse) ws.getRow(rowNum).values = cells;
  } else {
    for (const r of rows) ws.addRow(r);
  }
  const fp = path.join(mkTmpDir('hr-xlsx-'), 'fixture.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 把一行 cells（string[]）渲染为 inlineStr <c> 序列（空串跳过 → 与 ExcelJS 稀疏写一致）
function rowToInlineStrCells(cells, rowNum) {
  let xml = '';
  cells.forEach((v, i) => {
    if (v === '' || v == null) return;
    xml += `<c r="${colLetter(i)}${rowNum}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  });
  return xml;
}

// yazl 手工 xlsx：sheetRows 为 [{ r:行号, raw?:string(原始<c>序列), cells?:string[](inlineStr) }]
//   raw 优先（精确控制 cell 形态）；否则 cells 渲染为 inlineStr。sst 可选（sharedStrings.xml 内容）。
function writeRawSheetXlsx({ sheetRows, sst = null }) {
  let body = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  for (const sr of sheetRows) {
    if (sr.selfClose) { body += `<row r="${sr.r}"/>`; continue; }
    body += `<row r="${sr.r}">`;
    body += sr.raw !== undefined ? sr.raw : rowToInlineStrCells(sr.cells, sr.r);
    body += '</row>';
  }
  body += '</sheetData></worksheet>';

  const fp = path.join(mkTmpDir('hr-raw-'), 'fixture.xlsx');
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(body, 'utf8'), 'xl/worksheets/sheet1.xml');
    if (sst) zf.addBuffer(Buffer.from(sst, 'utf8'), 'xl/sharedStrings.xml');
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

// 构造 sharedStrings.xml（strings: string[]）
function buildSst(strings) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`;
  for (const s of strings) xml += `<si><t>${escXml(s)}</t></si>`;
  xml += '</sst>';
  return xml;
}

// ---- monkeypatch 捕获：跑某个 reader 抓每行 values ----

// 重新 patch importRepo（两 reader 共用单例），返回新捕获容器。
function installCapture(kind) {
  const captured = [];
  if (kind === 'flow') {
    importRepo.prepareFlowInsert = () => ({ run: () => {} });
    importRepo.insertFlowRow = (_stmt, payload) => {
      captured.push({ rowIndex: payload.row.rowIndex, monthKey: payload.monthKey, values: payload.row.values.slice() });
    };
  } else {
    importRepo.prepareBillInsert = () => ({ run: () => {} });
    importRepo.insertBillRow = (_stmt, payload) => {
      captured.push({ rowIndex: payload.row.rowIndex, monthKey: payload.monthKey, values: payload.row.values.slice() });
    };
  }
  return captured;
}

// 对同一 fixture 分别跑 sax / hand reader，捕获结果 + 返回值。kind: 'flow'|'bill'。
async function runImportBoth(kind, fp) {
  const importFn = kind === 'flow' ? 'importFlowFile' : 'importBillFile';
  const saxCap = installCapture(kind);
  const saxResult = await saxReader[importFn]({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} });
  const handCap = installCapture(kind);
  const handResult = await handReader[importFn]({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} });
  return { sax: { cap: saxCap, result: saxResult }, hand: { cap: handCap, result: handResult } };
}

// 🔴 核心断言（A≡C，端到端 DB 消费维度）：sax importFlowFile vs 真实 importFlowFile（hand 已裁剪）
//   逐行 rowIndex + monthKey + importedCount 全等。
//   v3.0.3 PR-P1：flow 路径 hand 已裁剪 → 白名单外列在 hand cap 恒 ''（下游 insertFlowRow 不消费），
//     故 flow 仅比对「白名单内列 0/6/28/29」（DB 实际取值列）；bill 不裁剪，全 26 列对比。
//   全列正确性由三方对比的 A≡B（assertThreeWayFlow）单独锁死，不在此函数。
function assertByteForByte(label, both, expectedLen, expectedSaxRows) {
  const { sax, hand } = both;
  const isFlow = expectedLen === 48;
  // flow：只比白名单内列；bill：比全列。
  const compareCols = isFlow
    ? [...FLOW_VALUE_COLUMN_WHITELIST].sort((a, b) => a - b)
    : Array.from({ length: expectedLen }, (_, i) => i);
  if (typeof expectedSaxRows === 'number') {
    assert.equal(sax.cap.length, expectedSaxRows, `${label}: sax 基线应捕获 ${expectedSaxRows} 数据行（实际 ${sax.cap.length}）`);
  }
  assert.equal(hand.result.importedCount, sax.result.importedCount, `${label}: importedCount 一致（sax=${sax.result.importedCount} hand=${hand.result.importedCount}）`);
  assert.equal(hand.result.monthKey, sax.result.monthKey, `${label}: monthKey 一致（sax=${sax.result.monthKey} hand=${hand.result.monthKey}）`);
  assert.equal(hand.cap.length, sax.cap.length, `${label}: 捕获行数一致（sax=${sax.cap.length} hand=${hand.cap.length}）`);
  for (let i = 0; i < sax.cap.length; i++) {
    const a = sax.cap[i];
    const b = hand.cap[i];
    assert.equal(b.rowIndex, a.rowIndex, `${label}: 行 ${i} rowIndex 一致（${a.rowIndex} vs ${b.rowIndex}）`);
    assert.equal(b.monthKey, a.monthKey, `${label}: 行 ${i} monthKey 一致`);
    for (const c of compareCols) {
      const av = a.values[c] == null ? '' : String(a.values[c]);
      const bv = b.values[c] == null ? '' : String(b.values[c]);
      assert.equal(bv, av, `${label}: 行 ${i}(rowIndex=${a.rowIndex}) 列 ${c}(${isFlow ? FLOW_HEADERS[c] : BILL_HEADERS[c]}) 值一致（sax="${av}" hand="${bv}"）`);
    }
    // flow：额外锁白名单外列在 hand（裁剪路径）恒空（证「不取值即 ''」契约，且下游不读这些列）
    if (isFlow) {
      for (let c = 0; c < expectedLen; c++) {
        if (FLOW_VALUE_COLUMN_WHITELIST.has(c)) continue;
        const bv = b.values[c] == null ? '' : String(b.values[c]);
        assert.equal(bv, '', `${label}: 行 ${i} 白名单外列 ${c}(${FLOW_HEADERS[c]}) 裁剪后恒空（实际 hand="${bv}"）`);
      }
    }
  }
}

// ---- v3.0.3 PR-P1 三方对比：手写「全列模式」B 路径驱动器 ----
// 直接用导出的 streamSheetRowsHandRolled（valueColumnWhitelist=null → 全列解码），复刻 importFlowFile 的
//   onRow 逻辑（表头校验 + allEmpty=!hasAnyCellText + extractMonthKey + 跨月/月份错误累积），捕获每条
//   「被 import 的数据行」的 { rowIndex, monthKey, values(全列), hasAnyCellText }。
//   仅 flow 用（B 路径）；与真实 importFlowFile（C，裁剪）逐行对比证裁剪等价。
async function runHandWholeColumnFlow(fp) {
  const sourceFile = require('node:path').basename(fp);
  const keyIndices = FLOW_KEY_COLUMN_INDICES;
  const { zip, entries } = await openZipWithEntries(sourceFile, fp);
  const captured = [];
  let detectedMonthKey = null;
  let headerValidated = false;
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    const sstEntry = entries.get(SHARED_STRINGS_ENTRY_NAME);
    let sharedStrings = [];
    try { sharedStrings = await loadSharedStrings(zip, sstEntry); } catch (_e) { sharedStrings = []; }
    await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders: FLOW_HEADERS,
      sharedStrings,
      valueColumnWhitelist: null,          // 🔴 B 路径：全列解码（手写解析器无裁剪基线）
      onRow: ({ rowR, values, hasAnyCellText }) => {
        if (rowR === 1) {
          const headerResult = validateFlowHeaders(values.map((v) => v == null ? '' : String(v)));
          if (!headerResult.ok) { const e = new Error('hdr'); e.__stopParsing = true; throw e; }
          headerValidated = true;
          return;
        }
        if (!headerValidated) return;
        if (!hasAnyCellText) return;        // allEmpty 等价判定（与 prod 同）
        const monthKey = extractMonthKey(values[keyIndices.billDate]);
        if (!monthKey) return;              // 月份不可解析行：prod 累积错误，这里 B 只捕成功 import 行 → 跳过
        if (!detectedMonthKey) detectedMonthKey = monthKey;
        else if (monthKey !== detectedMonthKey) return;  // 跨月行：prod 累积错误 → 这里跳过（只捕成功 import 行）
        captured.push({ rowIndex: rowR, monthKey, values: values.slice(), hasAnyCellText });
      }
    });
  } finally {
    try { zip.close(); } catch (_e) {}
  }
  return captured;
}

// 三方 A≡B≡C 完整断言（flow 专用）。expectedSaxRows 为期望成功 import 行数。
async function assertThreeWayFlow(label, fp, expectedSaxRows) {
  // A = sax importFlowFile（全列基线）
  const saxCap = installCapture('flow');
  const saxResult = await saxReader.importFlowFile({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} });
  // C = 真实 importFlowFile（hand，已裁剪）
  const handCap = installCapture('flow');
  const handResult = await handReader.importFlowFile({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} });
  // B = 手写全列模式（streamSheetRowsHandRolled + null 白名单）
  const wholeCap = await runHandWholeColumnFlow(fp);

  if (typeof expectedSaxRows === 'number') {
    assert.equal(saxCap.length, expectedSaxRows, `${label}: A(sax) 应 import ${expectedSaxRows} 行（实际 ${saxCap.length}）`);
  }
  // 行数三方一致
  assert.equal(handCap.length, saxCap.length, `${label}: A vs C import 行数一致（sax=${saxCap.length} hand=${handCap.length}）`);
  assert.equal(wholeCap.length, saxCap.length, `${label}: A vs B import 行数一致（sax=${saxCap.length} 手写全列=${wholeCap.length}）`);
  assert.equal(handResult.importedCount, saxResult.importedCount, `${label}: importedCount A≡C（sax=${saxResult.importedCount} hand=${handResult.importedCount}）`);
  assert.equal(handResult.monthKey, saxResult.monthKey, `${label}: monthKey A≡C（sax=${saxResult.monthKey} hand=${handResult.monthKey}）`);

  const wlSorted = [...FLOW_VALUE_COLUMN_WHITELIST].sort((a, b) => a - b);
  for (let i = 0; i < saxCap.length; i++) {
    const a = saxCap[i];   // sax 全列
    const b = wholeCap[i]; // 手写全列
    const c = handCap[i];  // 手写白名单（裁剪）
    // rowIndex / monthKey 三方一致
    assert.equal(b.rowIndex, a.rowIndex, `${label}: 行 ${i} rowIndex A≡B（${a.rowIndex} vs ${b.rowIndex}）`);
    assert.equal(c.rowIndex, a.rowIndex, `${label}: 行 ${i} rowIndex A≡C（${a.rowIndex} vs ${c.rowIndex}）`);
    assert.equal(b.monthKey, a.monthKey, `${label}: 行 ${i} monthKey A≡B`);
    assert.equal(c.monthKey, a.monthKey, `${label}: 行 ${i} monthKey A≡C`);
    // A≡B：全 48 列逐列相等（证手写解析器 == sax，与裁剪无关）
    for (let col = 0; col < 48; col++) {
      const av = a.values[col] == null ? '' : String(a.values[col]);
      const bv = b.values[col] == null ? '' : String(b.values[col]);
      assert.equal(bv, av, `${label}: 行 ${i}(r=${a.rowIndex}) 列 ${col}(${FLOW_HEADERS[col]}) A≡B（sax="${av}" 手写全列="${bv}"）`);
    }
    // B≡C：白名单内列相等
    for (const col of wlSorted) {
      const bv = b.values[col] == null ? '' : String(b.values[col]);
      const cv = c.values[col] == null ? '' : String(c.values[col]);
      assert.equal(cv, bv, `${label}: 行 ${i} 白名单内列 ${col}(${FLOW_HEADERS[col]}) B≡C（全列="${bv}" 白名单="${cv}"）`);
    }
    // B≡C：白名单外列在 C（裁剪）恒空
    for (let col = 0; col < 48; col++) {
      if (FLOW_VALUE_COLUMN_WHITELIST.has(col)) continue;
      const cv = c.values[col] == null ? '' : String(c.values[col]);
      assert.equal(cv, '', `${label}: 行 ${i} 白名单外列 ${col}(${FLOW_HEADERS[col]}) C(裁剪)恒空（实际="${cv}"）`);
    }
  }
}

// 错误用例：两 reader 都抛 ImportValidationError，message 相等
async function assertSameImportError(label, kind, fp) {
  const importFn = kind === 'flow' ? 'importFlowFile' : 'importBillFile';
  let ea = null;
  let eb = null;
  installCapture(kind);
  try { await saxReader[importFn]({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} }); } catch (e) { ea = e; }
  installCapture(kind);
  try { await handReader[importFn]({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} }); } catch (e) { eb = e; }
  assert.ok(ea, `${label}: sax reader 应抛错`);
  assert.ok(eb, `${label}: hand reader 应抛错`);
  assert.equal(ea.name, 'ImportValidationError', `${label}: sax 抛 ImportValidationError`);
  assert.equal(eb.name, 'ImportValidationError', `${label}: hand 抛 ImportValidationError`);
  assert.equal(eb.message, ea.message, `${label}: message 一致\n  sax="${ea.message}"\n  hand="${eb.message}"`);
  assert.deepEqual(eb.detailLines, ea.detailLines, `${label}: detailLines 一致`);
}

test.describe('v2.1.12-beta reader-handrolled contract（🔴🔴 与 sax reader byte-for-byte 等价）', () => {

  // ---------- #1 flow 正常多行（文本数据，ExcelJS → sharedStrings 路径）----------
  test('#1 flow 正常多行 → sax vs 手写 byte-for-byte', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 8: '入', 28: '1000.00', 29: 'USD' }),
        row(48, { 0: '2026-03-11', 6: 'RM-2', 8: '出', 28: '2000.50', 29: 'CNY' }),
        row(48, { 0: '2026-03-12', 6: 'RM-3', 8: '入', 28: '-30.00', 29: 'EUR' })
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#1 flow正常', both, 48, 3);
    // v3.0.3 PR-P1：三方 A≡B≡C（全列正确性 + 裁剪等价 + 白名单外列恒空）
    await assertThreeWayFlow('#1 flow正常三方', fp, 3);
  });

  // ---------- #2 bill 正常多行 ----------
  test('#2 bill 正常多行 → sax vs 手写 byte-for-byte', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        BILL_HEADERS.slice(),
        row(26, { 0: '2026-03-10', 14: 'RM-1', 18: '100.00', 19: 'USD' }),
        row(26, { 0: '2026-03-11', 14: 'RM-2', 18: '200.50', 19: 'CNY' })
      ]
    });
    const both = await runImportBoth('bill', fp);
    assertByteForByte('#2 bill正常', both, 26, 2);
  });

  // ---------- #3 含全空数据行（跳过）----------
  test('#3 flow 含全空数据行（两 reader 都跳过）→ byte-for-byte', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }),
        new Array(48).fill(''),                       // 全空数据行 → allEmpty 跳过
        row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' })
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#3 含空行', both, 48, 2);
  });

  // ---------- #4 稀疏行号（<row r> 跳号，rowIndex 用真实行号）----------
  test('#4 flow 稀疏行号（r=2 / r=5 跳过 r3-4）→ rowIndex 用真实行号、byte-for-byte', async () => {
    const fp = await writeFixtureExcelJS({
      sparse: [
        { rowNum: 1, cells: FLOW_HEADERS.slice() },
        { rowNum: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { rowNum: 5, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#4 稀疏行号', both, 48, 2);
    // 额外锁：rowIndex 必须是真实 Excel 行号 2 / 5（非计数 2 / 3）
    assert.equal(both.sax.cap[0].rowIndex, 2, '#4: 首数据行 rowIndex=2');
    assert.equal(both.sax.cap[1].rowIndex, 5, '#4: 次数据行 rowIndex=5（真实行号，非计数 3）');
    assert.equal(both.hand.cap[1].rowIndex, 5, '#4: hand 次数据行 rowIndex=5');
  });

  // ---------- #5 中文 + XML 实体（&amp; &lt; 等，证实体解码一致）----------
  test('#5 中文 + XML 实体（inlineStr 手工 fixture）→ 实体解码一致、byte-for-byte', async () => {
    // 手工 inlineStr，cell 文本含需转义的实体字符 & < >，escXml 序列化后两 reader 都应解码回原文
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-中文&公司<A>', 8: '入', 24: '张三&李四', 28: '1000.00', 29: 'USD' }) }
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#5 中文实体', both, 48, 1);
    // 额外锁：实体确实被解码（含原始 & < >）
    assert.equal(both.sax.cap[0].values[6], 'RM-中文&公司<A>', '#5: sax 实体解码正确');
    assert.equal(both.hand.cap[0].values[6], 'RM-中文&公司<A>', '#5: hand 实体解码正确');
  });

  // ---------- #6 🔴🔴 含 sharedStrings（t="s"）的 fixture（POC 未覆盖路径）----------
  test('#6 含 sharedStrings(t="s") fixture → sax vs 手写共享串解析一致、byte-for-byte', async () => {
    // 方案 A：手工构造 sharedStrings.xml + sheet 用 t="s" 引用索引（精确控制共享串路径）。
    //   表头 48 串 + 数据值串，验证两 reader 都按索引正确查表（含中文 / 重复引用 / 数字形态字符串）。
    const strings = FLOW_HEADERS.slice();           // 索引 0..47 = 表头
    strings.push('RM-共享');                          // 48
    strings.push('1000.00');                         // 49（金额以共享串存——证不被当数字 parseFloat）
    strings.push('USD');                             // 50
    strings.push('入');                               // 51
    const sst = buildSst(strings);
    // 表头行：A1..AV1 引用 0..47
    let headerCells = '';
    for (let i = 0; i < 48; i++) headerCells += `<c r="${colLetter(i)}1" t="s"><v>${i}</v></c>`;
    // 数据行：账单日期用 inlineStr（日期不入共享串），对账主Id/金额/币种/方向用 t="s"
    const dataCells =
      `<c r="A2" t="inlineStr"><is><t>2026-03-10</t></is></c>` +
      `<c r="G2" t="s"><v>48</v></c>` +        // 对账主Id = RM-共享（idx 6 列 = G）
      `<c r="I2" t="s"><v>51</v></c>` +        // 出入方向 = 入（idx 8 列 = I）
      `<c r="AC2" t="s"><v>49</v></c>` +       // 通道清算金额 = 1000.00（idx 28 列 = AC）
      `<c r="AD2" t="s"><v>50</v></c>`;        // 通道清算币种 = USD（idx 29 列 = AD）
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, raw: headerCells },
        { r: 2, raw: dataCells }
      ],
      sst
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#6 sharedStrings', both, 48, 1);
    // 额外锁：共享串确实被查表解析（值 = sharedStrings 内容，非索引数字），且金额共享串保留小数
    assert.equal(both.sax.cap[0].values[6], 'RM-共享', '#6: sax 对账主Id 查共享串');
    assert.equal(both.hand.cap[0].values[6], 'RM-共享', '#6: hand 对账主Id 查共享串');
    assert.equal(both.sax.cap[0].values[28], '1000.00', '#6: sax 金额共享串保留小数');
    assert.equal(both.hand.cap[0].values[28], '1000.00', '#6: hand 金额共享串保留小数（非 parseFloat 改写）');
  });

  // ---------- #7 🔴🔴 含 number 型 cell（取值语义对齐 sax，非 parseFloat 改写）----------
  test('#7 ExcelJS number cell → sax vs 手写取值一致、byte-for-byte', async () => {
    // ExcelJS 写 number 值时产 t 缺省的 <c><v>...</v></c>（实测 1000.00 被 ExcelJS 归一为 <v>1000</v>，
    //   小数 / 大数 / 负数原样）。两 reader 都从 <v> 取原文，必一致。
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(FLOW_HEADERS.slice());
    const r = ws.addRow(new Array(48).fill(''));
    r.getCell(1).value = '2026-03-10';                 // 账单日期文本（A=col1）
    r.getCell(7).value = 'RM-NUM';                     // 对账主Id（G=col7）
    r.getCell(29).value = 1000.5;                      // 通道清算金额 number 小数（AC=col29）
    r.getCell(30).value = 'CNY';                       // 通道清算币种（AD=col30）
    r.getCell(47).value = -30.25;                      // 交易手续费 number 负小数（col47）
    r.getCell(48).value = 1398765432109876500;         // 客资账户余额 number 大数（col48）
    const fp = path.join(mkTmpDir('hr-num-'), 'num.xlsx');
    await wb.xlsx.writeFile(fp);

    const both = await runImportBoth('flow', fp);
    assertByteForByte('#7 number cell', both, 48, 1);
    // 显式锁：number cell 两 reader 取值完全相同（若手写用了 parseFloat 会与 sax 发散 → 这里失败）
    //   v3.0.3 PR-P1 适配：该锁由白名单内的金额列（index 28，number 小数）承担；
    //   col47/col48（index 46/47）是白名单外列——hand 路径按裁剪语义恒 ''（不解码），sax 基线保留原值。
    //   「number 取 <v> 原文本、绝不 parseFloat」的全形态锁定见 #7b 单元级用例（不受白名单影响）。
    assert.equal(both.hand.cap[0].values[28], both.sax.cap[0].values[28], '#7: number 金额取值一致（白名单内）');
    assert.equal(both.sax.cap[0].values[46], '-30.25', '#7: sax 基线白名单外负小数保留原值');
    assert.equal(both.hand.cap[0].values[46], '', '#7: 白名单外 number 列 hand 路径裁剪为空');
    assert.equal(both.hand.cap[0].values[47], '', '#7: 白名单外大数列 hand 路径裁剪为空');
  });

  // ---------- #7b 🔴🔴 单元级锁：parseAcquiringRowXml 数字分支取原文本（直接喂手工 number XML）----------
  // ExcelJS 自己会把 1000.00 归一为 1000，无法用 ExcelJS 造出 <v>1000.00</v>；故单元级直接喂手工 XML，
  // 锁死「数字分支取 <v> 原始文本，绝不 parseFloat/String(Number)」——这正是不能复用
  // streaming-xlsx-reader.parseRowXml（parseFloat→"1000.00"→"1000" 丢小数改写金额）的核心红线。
  test('#7b parseAcquiringRowXml 数字 cell 取原文本（不丢小数 / 不转科学计数 / 不转布尔）', () => {
    const ss = ['共享串0'];
    // 一行手工 XML：数字带尾零小数 / 科学计数 / 大数 / 布尔 / 错误类型 / 公式 f+v / 共享串
    const rowXml = '<row r="2">'
      + '<c r="A2"><v>1000.00</v></c>'                   // 0: 无 t 数字带尾零 → "1000.00"（非 "1000"）
      + '<c r="B2" t="n"><v>1.5e3</v></c>'               // 1: 科学计数 → "1.5e3"（非 1500）
      + '<c r="C2" t="n"><v>1398765432109876543</v></c>' // 2: 大数 → 原文（非精度丢失）
      + '<c r="D2" t="b"><v>1</v></c>'                   // 3: 布尔 → "1"（非 "TRUE"）
      + '<c r="E2" t="e"><v>#DIV/0!</v></c>'             // 4: 错误 → "#DIV/0!"
      + '<c r="F2" t="n"><f>SUM(A:A)</f><v>123.45</v></c>' // 5: 公式 f 忽略，取 v → "123.45"
      + '<c r="G2" t="s"><v>0</v></c>'                   // 6: 共享串 → "共享串0"
      + '<c r="H2" t="inlineStr"><is><t>P</t><t>Q</t></is></c>' // 7: inlineStr 多 t → "Q"（取最后，非拼接 "PQ"）
      + '</row>';
    // v3.0.3 PR-P1：返回形状改 { values, hasAnyCellText }；此处全列（whitelist 省略 → null）。
    const { values, hasAnyCellText } = parseAcquiringRowXml(rowXml, 48, ss, false);
    assert.equal(values[0], '1000.00', '#7b: 数字带尾零保留小数（非 parseFloat→"1000"）');
    assert.equal(values[1], '1.5e3', '#7b: 科学计数保留原文（非转 1500）');
    assert.equal(values[2], '1398765432109876543', '#7b: 大数保留原文');
    assert.equal(values[3], '1', '#7b: 布尔取原文 "1"（非 "TRUE"）');
    assert.equal(values[4], '#DIV/0!', '#7b: 错误类型取 <v> 原文');
    assert.equal(values[5], '123.45', '#7b: 公式 cell 忽略 <f> 取 <v>');
    assert.equal(values[6], '共享串0', '#7b: 共享串查表');
    assert.equal(values[7], 'Q', '#7b: inlineStr 多 <t> 取最后一个（对齐 sax，非拼接）');
    assert.equal(hasAnyCellText, true, '#7b: 行内有非空 cell → hasAnyCellText=true');

    // v3.0.3 PR-P1：同一行喂白名单 {0,6} → 仅列 0/6 取值，列 1-5/7 跳过解码恒 ''；hasAnyCellText 不变。
    const wl = parseAcquiringRowXml(rowXml, 48, ss, false, new Set([0, 6]));
    assert.equal(wl.values[0], '1000.00', '#7b 白名单: 列 0 在白名单内 → 取值');
    assert.equal(wl.values[6], '共享串0', '#7b 白名单: 列 6 在白名单内 → 查共享串');
    assert.equal(wl.values[1], '', '#7b 白名单: 列 1 不在白名单 → 跳过解码恒空');
    assert.equal(wl.values[3], '', '#7b 白名单: 列 3 不在白名单 → 跳过解码恒空');
    assert.equal(wl.values[7], '', '#7b 白名单: 列 7 不在白名单 → 跳过解码恒空');
    assert.equal(wl.hasAnyCellText, true, '#7b 白名单: hasAnyCellText 与全列一致（探测覆盖白名单外列）');
  });

  // ---------- #8 表头错误（列少 / 列多 / 内容错）→ 两 reader 抛同 message ----------
  test('#8a flow 表头列少 → 两 reader 抛同 ImportValidationError', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(0, 47),                    // 少一列（47 列）
        row(47, { 0: '2026-03-10' })
      ]
    });
    await assertSameImportError('#8a 列少', 'flow', fp);
  });

  test('#8b flow 表头列多 → 两 reader 抛同 ImportValidationError', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        [...FLOW_HEADERS.slice(), '多余列A', '多余列B'], // 多两列（50 列）
        row(50, { 0: '2026-03-10' })
      ]
    });
    await assertSameImportError('#8b 列多', 'flow', fp);
  });

  test('#8c flow 表头内容错 → 两 reader 抛同 ImportValidationError', async () => {
    const wrong = FLOW_HEADERS.slice();
    wrong[6] = '错误的对账主Id列名';
    const fp = await writeFixtureExcelJS({
      rows: [wrong, row(48, { 0: '2026-03-10' })]
    });
    await assertSameImportError('#8c 内容错', 'flow', fp);
  });

  test('#8d bill 表头内容错 → 两 reader 抛同 ImportValidationError', async () => {
    const wrong = BILL_HEADERS.slice();
    wrong[0] = '不是账单日期';
    const fp = await writeFixtureExcelJS({
      rows: [wrong, row(26, { 14: 'RM-1' })]
    });
    await assertSameImportError('#8d bill内容错', 'bill', fp);
  });

  // ---------- #8e 月份解析错 / 跨月份混杂（数据行错误累积）→ 同 message ----------
  test('#8e flow 账单日期无法解析为月份 → 两 reader 抛同累积错误', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '非法日期xyz', 6: 'RM-1', 28: '100', 29: 'USD' })
      ]
    });
    await assertSameImportError('#8e 月份不可解析', 'flow', fp);
  });

  test('#8f flow 跨月份混杂 → 两 reader 抛同累积错误', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }),
        row(48, { 0: '2026-04-10', 6: 'RM-2', 28: '200', 29: 'CNY' })   // 跨月
      ]
    });
    await assertSameImportError('#8f 跨月份', 'flow', fp);
  });

  // ---------- #9 peekMonthKeyFromFile：正常 / 表头错 / 无数据行 ----------
  test('#9a peekMonthKeyFromFile 正常 → 两 reader 返回值一致', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-15', 6: 'RM-1', 28: '100', 29: 'USD' }),
        row(48, { 0: '2026-03-16', 6: 'RM-2', 28: '200', 29: 'CNY' })
      ]
    });
    const a = await saxReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp });
    const b = await handReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp });
    assert.deepEqual(b, a, `#9a: peek 返回一致（sax=${JSON.stringify(a)} hand=${JSON.stringify(b)}）`);
    assert.equal(b.monthKey, '2026-03', '#9a: monthKey=2026-03');
  });

  test('#9b peekMonthKeyFromFile 表头错 → 两 reader 抛同 message', async () => {
    const wrong = FLOW_HEADERS.slice();
    wrong[0] = 'X';
    const fp = await writeFixtureExcelJS({ rows: [wrong, row(48, { 0: '2026-03-15' })] });
    let ea = null;
    let eb = null;
    try { await saxReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp }); } catch (e) { ea = e; }
    try { await handReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp }); } catch (e) { eb = e; }
    assert.ok(ea && eb, '#9b: 两 reader 都抛错');
    assert.equal(eb.message, ea.message, `#9b: message 一致\n  sax="${ea.message}"\n  hand="${eb.message}"`);
    assert.deepEqual(eb.detailLines, ea.detailLines, '#9b: detailLines 一致');
  });

  test('#9c peekMonthKeyFromFile 无数据行（仅表头）→ 两 reader 抛同 message', async () => {
    const fp = await writeFixtureExcelJS({ rows: [FLOW_HEADERS.slice()] });
    let ea = null;
    let eb = null;
    try { await saxReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp }); } catch (e) { ea = e; }
    try { await handReader.peekMonthKeyFromFile({ kind: 'flow', filePath: fp }); } catch (e) { eb = e; }
    assert.ok(ea && eb, '#9c: 两 reader 都抛错');
    assert.equal(eb.message, ea.message, `#9c: message 一致\n  sax="${ea.message}"\n  hand="${eb.message}"`);
  });

  // ---------- 补充：cellValueFromBody 直接单测（边缘形态对齐 sax）----------
  test('#extra cellValueFromBody 边缘形态（越界/NaN 共享串 / 空 / 自闭合语义）', () => {
    const ss = ['A', 'B'];
    assert.equal(cellValueFromBody('<v>5</v>', 's', ss), '', 'extra: 共享串越界 → 空');
    assert.equal(cellValueFromBody('<v>abc</v>', 's', ss), '', 'extra: 共享串 NaN → 空');
    assert.equal(cellValueFromBody('<v>1</v>', 's', ss), 'B', 'extra: 共享串 idx=1 → B');
    assert.equal(cellValueFromBody('', 'n', ss), '', 'extra: 空 body number → 空');
    assert.equal(cellValueFromBody('<is><t></t></is>', 'inlineStr', ss), '', 'extra: inlineStr 空 t → 空');
    assert.equal(cellValueFromBody('<v>amp&amp;lt&lt;gt&gt;</v>', 'n', ss), 'amp&lt<gt>', 'extra: 数字位实体解码');
  });

  // ==================== v3.0.3 PR-P1 列裁剪等价性专项 ====================

  // ---------- #10 🔴 仅白名单外列有值的行（不得被误判空行）----------
  // 核心反例：裁剪后白名单外列恒 ''，若仍用 values.every(==='') 判空 → 该行被误判空行静默跳过（漂移）。
  //   改用 hasAnyCellText 后：该行 hasAnyCellText=true → 不跳过 → 进 extractMonthKey；因账单日期(列0)空 →
  //   月份不可解析 → 三方都累积「账单日期无法解析」错误（而非静默跳过）。这正是 allEmpty 等价的存在理由。
  test('#10 仅白名单外列有值的行 → 不被误判空行（三方都报月份不可解析，非静默跳过）', async () => {
    // 列 24（操作人，白名单外）有值；白名单内列 0/6/28/29 全空 → 该行非空但账单日期缺失。
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 24: '张三' }) }   // 仅白名单外列有值
      ]
    });
    // A(sax) vs C(hand 裁剪) 抛同 ImportValidationError（账单日期无法解析为月份）——证不被当空行跳过（端到端）。
    //   单元级锁见 #11c（仅白名单外列有真实值 → 三方 hasAnyCellText=true）。
    await assertSameImportError('#10 仅白名单外列有值', 'flow', fp);
  });

  // ---------- #10b 白名单外列有值 + 账单日期合法 → 三方正常 import（该行 hasAnyCellText 由白名单内列触发也可）----------
  // 与 #10 互补：白名单内列(账单日期/对账主Id/金额/币种)齐全 + 白名单外列也有值 → 正常 import，
  //   三方白名单内列全等、白名单外列在裁剪路径恒空、import 行数一致。
  test('#10b 白名单内外列都有值 → 三方 import 一致（白名单外列裁剪路径恒空）', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        // 白名单内 0/6/28/29 齐 + 白名单外 7/24/47 也有值
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-A', 7: '收入', 24: '李四', 28: '500.00', 29: 'USD', 47: '9999.99' }) },
        { r: 3, cells: row(48, { 0: '2026-03-11', 6: 'RM-B', 28: '600.00', 29: 'CNY' }) }   // 仅白名单内
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#10b', both, 48, 2);
    await assertThreeWayFlow('#10b 三方', fp, 2);
  });

  // ---------- #11 🔴 SST 索引指向空串（ExcelJS / 真实 Excel 全空 cell 形态）→ cellHasText 必须查表判空 ----------
  // 这是 contract #3 暴露的真实坑：ExcelJS 把空字符串 cell 存成 <c t="s"><v>K</v></c>，K 指向 SST 空串。
  //   若 cellHasText 只看 <v> body 文本（"K" 非空）会误判该 cell 非空 → 全空行不被跳过 → 漂移。
  //   本用例锁定：一行所有 cell 都是「SST 索引指向空串」→ hasAnyCellText=false → 该行被当空行跳过（三方一致）。
  test('#11 SST 索引指向空串（ExcelJS 空 cell 形态）→ cellHasText 查表判空、该行作空行跳过', async () => {
    // SST: 索引 0 = 空串（模拟 ExcelJS 把 "" 存为指向空 si 的 t="s"）；索引 1..48 = 表头。
    const strings = [''].concat(FLOW_HEADERS.slice());   // 0='' , 1..48=表头
    const sst = buildSst(strings);
    // 表头行：A1..AV1 引用 1..48
    let headerCells = '';
    for (let i = 0; i < 48; i++) headerCells += `<c r="${colLetter(i)}1" t="s"><v>${i + 1}</v></c>`;
    // 数据行 r=2：所有 48 列都 t="s" 指向索引 0（空串）→ 全空行
    let emptyDataCells = '';
    for (let i = 0; i < 48; i++) emptyDataCells += `<c r="${colLetter(i)}2" t="s"><v>0</v></c>`;
    // 数据行 r=3：正常一行（inlineStr）→ 应正常 import
    const goodCells = rowToInlineStrCells(row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100.00', 29: 'USD' }), 3);
    const fp = await writeRawSheetXlsx({
      sheetRows: [{ r: 1, raw: headerCells }, { r: 2, raw: emptyDataCells }, { r: 3, raw: goodCells }],
      sst
    });

    // 单元级锁：cellHasText 对「SST 索引指向空串」必须判 false（查表，非看 body 文本）。
    assert.equal(cellHasText('<v>0</v>', 's', ['']), false, '#11: SST 索引指向空串 → cellHasText=false（查表判空）');
    assert.equal(cellHasText('<v>0</v>', 's', ['有内容']), true, '#11: SST 索引指向非空串 → cellHasText=true');

    // 单元级锁：全空行（全 SST 空串）parseAcquiringRowXml → hasAnyCellText=false（全列 & 白名单路径一致）
    const emptyRowXml = '<row r="2">' + emptyDataCells + '</row>';
    assert.equal(parseAcquiringRowXml(emptyRowXml, 48, [''], false, null).hasAnyCellText, false, '#11: 全空行(SST空串) 全列路径 hasAnyCellText=false');
    assert.equal(parseAcquiringRowXml(emptyRowXml, 48, [''], false, FLOW_VALUE_COLUMN_WHITELIST).hasAnyCellText, false, '#11: 全空行(SST空串) 白名单路径 hasAnyCellText=false');

    // 端到端三方：r=2 全空行三方都跳过；r=3 正常 import → importedCount=1，三方全等。
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#11 SST空串', both, 48, 1);
    await assertThreeWayFlow('#11 SST空串 三方', fp, 1);
  });

  // ---------- #11b 畸形 SST 索引（NaN/越界）→ cellHasText 与 cellValueFromBody 同判空（连畸形都不再是差异）----------
  // 形态：t="s" 但 <v>bad</v>（idx NaN）或越界。cellValueFromBody 取值 ''；cellHasText 查表同样判 false。
  //   故畸形 SST 在「全列 vs 白名单」两路径下 hasAnyCellText 一致（都不因畸形 SST 误判非空）。
  test('#11b 畸形 SST 索引（NaN/越界）→ cellHasText 与取值同判空（不误判非空）', () => {
    // cellHasText 与 cellValueFromBody 判空严格对齐
    assert.equal(cellHasText('<v>bad</v>', 's', ['x']), false, '#11b: NaN 索引 → cellHasText=false（同取值空）');
    assert.equal(cellValueFromBody('<v>bad</v>', 's', ['x']), '', '#11b: NaN 索引 → 取值空');
    assert.equal(cellHasText('<v>99</v>', 's', ['x']), false, '#11b: 越界索引 → cellHasText=false（同取值空）');
    assert.equal(cellValueFromBody('<v>99</v>', 's', ['x']), '', '#11b: 越界索引 → 取值空');

    // 行级：一行仅含畸形 SST cell（无其它有值列）→ hasAnyCellText=false → 该行将被当空行跳过（不漂移）
    const rowXml = '<row r="2"><c r="Y2" t="s"><v>bad</v></c></row>';   // 列 24（白名单外）畸形 SST，别无有值列
    const whole = parseAcquiringRowXml(rowXml, 48, ['x'], false, null);
    const wl = parseAcquiringRowXml(rowXml, 48, ['x'], false, FLOW_VALUE_COLUMN_WHITELIST);
    assert.equal(whole.hasAnyCellText, false, '#11b: 全列路径 仅畸形SST → hasAnyCellText=false');
    assert.equal(wl.hasAnyCellText, false, '#11b: 白名单路径 仅畸形SST → hasAnyCellText=false（一致，不漂移）');
  });

  // ---------- #11c 🔴 仅白名单外列「有真实值」的行（不被误判空行；区别于 SST 空串）----------
  // 与 #11 互补：白名单外列 24 有真实 inlineStr 值（非 SST 空串）→ hasAnyCellText=true → 不跳过。
  //   裁剪路径列 24 不解码（取值 ''），但 cellHasText 探测到其非空 → 行不被误判空。证「裁剪不丢空行判定」。
  test('#11c 仅白名单外列有真实值 → 不被误判空行（裁剪路径 cellHasText 探测覆盖白名单外列）', () => {
    const rowXml = '<row r="2">' + rowToInlineStrCells(row(48, { 24: '张三' }), 2) + '</row>';
    const whole = parseAcquiringRowXml(rowXml, 48, [], false, null);
    const wl = parseAcquiringRowXml(rowXml, 48, [], false, FLOW_VALUE_COLUMN_WHITELIST);
    assert.equal(whole.values[24], '张三', '#11c: 全列路径列24 取值');
    assert.equal(wl.values[24], '', '#11c: 白名单路径列24 跳过解码恒空');
    assert.equal(whole.hasAnyCellText, true, '#11c: 全列路径 hasAnyCellText=true');
    assert.equal(wl.hasAnyCellText, true, '#11c: 白名单路径 hasAnyCellText=true（探测覆盖白名单外列 → 不误判空）');
    assert.equal(wl.values.every((v) => v === ''), true, '#11c: 白名单路径 values 全空（故必须用 hasAnyCellText 判空而非 values.every）');
  });

  // ---------- #12 自闭合 row（<row r=N/>）→ 三方都跳过 ----------
  test('#12 自闭合空 row（<row r=3/>）→ 三方跳过、byte-for-byte', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { r: 3, selfClose: true },                                  // 自闭合空行 → 跳过
        { r: 4, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    const both = await runImportBoth('flow', fp);
    assertByteForByte('#12 自闭合row', both, 48, 2);
    await assertThreeWayFlow('#12 自闭合row 三方', fp, 2);
    // 锁：自闭合 row 不进 import（rowIndex 2/4，跳过 r3）
    assert.equal(both.hand.cap[0].rowIndex, 2, '#12: 首行 r=2');
    assert.equal(both.hand.cap[1].rowIndex, 4, '#12: 次行 r=4（跳过自闭合 r=3）');
  });

  // ---------- #13 cellHasText 语义单测（🔴 与 cellValueFromBody 判空严格一致）----------
  // cellHasText ≡ (cellValueFromBody(...) !== '')，对所有 cell 形态成立。逐形态既测 cellHasText 又对照取值。
  test('#13 cellHasText：与 cellValueFromBody 判空严格一致（含 s 查表 / 末尾空 run / 公式）', () => {
    const ss = ['有内容', '', 'USD'];   // idx0 非空 / idx1 空串 / idx2 非空
    const cases = [
      ['<is><t>X</t></is>', 'inlineStr'],
      ['<v>123</v>', 'n'],
      ['<is><t></t></is>', 'inlineStr'],
      ['<v></v>', 'n'],
      ['', 'n'],
      ['<f>SUM(A:A)</f>', 'n'],
      ['<f>SUM(A:A)</f><v>5</v>', 'n'],
      ['<v>&amp;</v>', 'n'],
      ['<v>0</v>', 's'],                // s 索引0 → 非空串 → 取值非空
      ['<v>1</v>', 's'],                // 🔴 s 索引1 → 空串 → 取值空（body "1" 文本非空但取值 ''）
      ['<v>2</v>', 's'],                // s 索引2 → USD
      ['<v>bad</v>', 's'],              // 畸形索引 → 取值空
      ['<v>99</v>', 's'],              // 越界索引 → 取值空
      ['<is><t>P</t><t></t></is>', 'inlineStr']  // 🔴 末尾空 run → 取值取最后='' → 探测也须判空
    ];
    for (const [body, type] of cases) {
      const v = cellValueFromBody(body, type, ss);
      const has = cellHasText(body, type, ss);
      assert.equal(has, v !== '', `#13: cellHasText 与取值判空一致（type=${type} body="${body}" 取值="${v}" has=${has}）`);
    }
    // 显式钉死反直觉关键点
    assert.equal(cellHasText('<v>1</v>', 's', ss), false, '#13: s 索引指向空串 → cellHasText=false（ExcelJS 空 cell 形态）');
    assert.equal(cellHasText('<is><t>P</t><t></t></is>', 'inlineStr', ss), false, '#13: inlineStr 末尾空 run → cellHasText=false（取最后空 run，与取值一致）');
    assert.equal(cellHasText('<v>0</v>', 's', ss), true, '#13: s 索引指向非空串 → cellHasText=true');
  });
});
