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
  cellValueFromBody
} = require('../../../../src/backend/acquiring-bill-currency-import/reader-handrolled');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');

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

// 🔴 核心断言：两 reader 捕获逐行逐列 + monthKey + importedCount 全等
function assertByteForByte(label, both, expectedLen, expectedSaxRows) {
  const { sax, hand } = both;
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
    for (let c = 0; c < expectedLen; c++) {
      const av = a.values[c] == null ? '' : String(a.values[c]);
      const bv = b.values[c] == null ? '' : String(b.values[c]);
      assert.equal(bv, av, `${label}: 行 ${i}(rowIndex=${a.rowIndex}) 列 ${c}(${expectedLen === 48 ? FLOW_HEADERS[c] : BILL_HEADERS[c]}) 值一致（sax="${av}" hand="${bv}"）`);
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
    assert.equal(both.hand.cap[0].values[28], both.sax.cap[0].values[28], '#7: number 金额取值一致');
    assert.equal(both.hand.cap[0].values[47], both.sax.cap[0].values[47], '#7: number 负小数取值一致');
    assert.equal(both.hand.cap[0].values[48], both.sax.cap[0].values[48], '#7: number 大数取值一致');
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
    const values = parseAcquiringRowXml(rowXml, 48, ss, false);
    assert.equal(values[0], '1000.00', '#7b: 数字带尾零保留小数（非 parseFloat→"1000"）');
    assert.equal(values[1], '1.5e3', '#7b: 科学计数保留原文（非转 1500）');
    assert.equal(values[2], '1398765432109876543', '#7b: 大数保留原文');
    assert.equal(values[3], '1', '#7b: 布尔取原文 "1"（非 "TRUE"）');
    assert.equal(values[4], '#DIV/0!', '#7b: 错误类型取 <v> 原文');
    assert.equal(values[5], '123.45', '#7b: 公式 cell 忽略 <f> 取 <v>');
    assert.equal(values[6], '共享串0', '#7b: 共享串查表');
    assert.equal(values[7], 'Q', '#7b: inlineStr 多 <t> 取最后一个（对齐 sax，非拼接）');
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
});
