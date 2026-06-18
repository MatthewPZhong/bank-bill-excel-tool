'use strict';
// v3.0.9 需求1 · T3：split-export-filter（exportFilter）单测
//
// 覆盖（TECHDOC §6 T3 / §4.2 / §九 9.1）：
//   1. 命中子集正确：按 field/values 过滤，产物只含命中行（多 sheet 源跨页过滤）；matchedCount 正确。
//   2. 命中 0 行：matchedCount=0、产物只有表头（无数据行）。
//   3. 字段不存在：抛 ToolboxSplitFieldNotFoundError（上层归一 failed）。
//   4. 传小 maxRowsPerSheet → 命中超阈值时确定性自动分 sheet（产物多 sheet）。
//   5. 产物可 readback 校验：用 T1 streamLogicalTableRows readback（多 sheet 输出按一张逻辑表读回，
//      验证 headers + 命中值），不走 SheetJS 全量读（避免大输出 OOM 路径）。
//
// readback 策略：exportFilter 产物可能是多 sheet（分 sheet 时 COMMON / COMMON(2)/...，每 sheet 重复表头），
//   用 T1 reader 读回正好把重复表头当续页跳过 → 得到纯数据行（与 emit 行一致）。
//
// 夹具：本文件内联 yazl inlineStr 多 sheet 构造器（与 T3 scan 测试 / T1 测试同款），exportFilter 走真实
//   T1 reader + createRowFilter + writeRowsStreamed（非打桩，端到端覆盖 T3 的真实复用链）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');

const {
  exportFilter,
  ToolboxSplitFieldNotFoundError
} = require('../../../../src/backend/toolbox-xlsx-stream/split-export-filter');
const { streamLogicalTableRows } = require('../../../../src/backend/toolbox-xlsx-stream/multi-sheet-reader');

// ---- tmp 管理 ----
const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  tmpDirs.length = 0;
});
function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// ---- XML / cell 工具（inlineStr 多 sheet 构造） ----
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
function rowToInlineStrCells(cells, rowNum) {
  let xml = '';
  cells.forEach((v, i) => {
    if (v === '' || v == null) return;
    xml += `<c r="${colLetter(i)}${rowNum}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  });
  return xml;
}
function rowsToSheetBody(rows, startR = 1) {
  let body = '';
  let r = startR;
  for (const row of rows) {
    if (row && row.selfClose) { body += `<row r="${r}"/>`; r += 1; continue; }
    body += `<row r="${r}">`;
    body += rowToInlineStrCells(Array.isArray(row) ? row : (row && row.cells) || [], r);
    body += '</row>';
    r += 1;
  }
  return body;
}
function writeMultiSheetXlsx({ sheets }) {
  const dir = mkTmpDir('tbx-export-');
  const fp = path.join(dir, 'fixture.xlsx');
  const entries = sheets.map((s, i) => ({
    name: s.name, rid: `rId${i + 1}`, target: s.target, body: s.body || ''
  }));
  const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + entries.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join('')
    + '</sheets></workbook>';
  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + entries.map((s) => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target}"/>`).join('')
    + '</Relationships>';
  const sheetXml = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + body + '</sheetData></worksheet>';
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(wbXml, 'utf8'), 'xl/workbook.xml');
    zf.addBuffer(Buffer.from(relsXml, 'utf8'), 'xl/_rels/workbook.xml.rels');
    for (const s of entries) {
      const physical = s.target.startsWith('xl/') ? s.target : `xl/${s.target}`;
      zf.addBuffer(Buffer.from(sheetXml(s.body), 'utf8'), physical);
    }
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

// readback：用 T1 reader 读回产物（多 sheet 输出按一张逻辑表读，重复表头跳过）→ { headers, dataRows, sheetCount }。
function trimRow(values) {
  let last = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i] == null ? '' : values[i]).trim() !== '') last = i;
  }
  return values.slice(0, last + 1).map((c) => String(c == null ? '' : c).trim());
}
async function readback(fp) {
  let headers = null;
  const dataRows = [];
  const summary = await streamLogicalTableRows(fp, {
    onHeaderRow: (h) => { if (headers === null) headers = h; },
    onDataRow: (v) => dataRows.push(trimRow(v))
  });
  return { headers, dataRows, sheetCount: summary.sheetCount };
}

function outPath() {
  return path.join(mkTmpDir('tbx-out-'), `out-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
}

test.describe('toolbox-xlsx-stream split-export-filter exportFilter', () => {

  test('命中子集正确（多 sheet 源跨页过滤）：matchedCount + 产物 readback 一致', async () => {
    // 表头 [渠道, 金额]；跨 3 sheet。按 渠道 ∈ {支付宝} 过滤。
    const fp = await writeMultiSheetXlsx({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([['渠道', '金额'], ['支付宝', '10'], ['微信', '20']])
        },
        {
          name: 'S2', target: 'worksheets/sheet2.xml',
          body: rowsToSheetBody([['渠道', '金额'], ['支付宝', '30'], ['银联', '40']])  // 重复表头页
        },
        {
          name: 'S3', target: 'worksheets/sheet3.xml',
          body: rowsToSheetBody([['支付宝', '50']])  // 无表头页：首行即数据（命中）
        }
      ]
    });
    const save = outPath();
    const { matchedCount } = await exportFilter({ filePath: fp, field: '渠道', values: ['支付宝'], savePath: save });
    assert.equal(matchedCount, 3, '命中 3 行支付宝（跨 3 sheet）');

    const back = await readback(save);
    assert.deepEqual(back.headers, ['渠道', '金额'], '产物表头 = 源逻辑表头');
    assert.deepEqual(back.dataRows, [['支付宝', '10'], ['支付宝', '30'], ['支付宝', '50']],
      '产物只含命中行，顺序按源显示序');
  });

  test('多选值：命中任一选中值的行（OR 语义）', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([['币种', 'v'], ['USD', '1'], ['EUR', '2'], ['CNY', '3'], ['JPY', '4']])
        }
      ]
    });
    const save = outPath();
    const { matchedCount } = await exportFilter({ filePath: fp, field: '币种', values: ['USD', 'CNY'], savePath: save });
    assert.equal(matchedCount, 2);
    const back = await readback(save);
    assert.deepEqual(back.dataRows, [['USD', '1'], ['CNY', '3']]);
  });

  test('命中 0 行：matchedCount=0、产物只有表头（无数据行）', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['渠道', 'v'], ['微信', '1'], ['银联', '2']]) }
      ]
    });
    const save = outPath();
    const { matchedCount } = await exportFilter({ filePath: fp, field: '渠道', values: ['不存在的值'], savePath: save });
    assert.equal(matchedCount, 0, 'matchedCount=0');
    const back = await readback(save);
    assert.deepEqual(back.headers, ['渠道', 'v'], '产物仍有表头');
    assert.deepEqual(back.dataRows, [], '产物无数据行');
  });

  test('字段不存在 → 抛 ToolboxSplitFieldNotFoundError（带 name + detailLines）', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['A', 'B'], ['1', '2']]) }
      ]
    });
    const save = outPath();
    let err = null;
    try {
      await exportFilter({ filePath: fp, field: '不存在字段', values: ['x'], savePath: save });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应抛错');
    assert.ok(err instanceof ToolboxSplitFieldNotFoundError, 'err instanceof ToolboxSplitFieldNotFoundError');
    assert.equal(err.name, 'ToolboxSplitFieldNotFoundError');
    assert.ok(Array.isArray(err.detailLines) && err.detailLines.length > 0, 'detailLines 非空（供前端 alert）');
  });

  test('传小 maxRowsPerSheet → 命中超阈值时确定性自动分 sheet；readback 行数 / 内容仍正确', async () => {
    // 注入 7 行命中（渠道全 = 支付宝）；maxRowsPerSheet=3 → 产物应分 sheet（ceil(7/3)=3 个 sheet）。
    const rows = [['渠道', 'idx']];
    for (let i = 0; i < 7; i += 1) rows.push(['支付宝', `r${i}`]);
    rows.push(['微信', 'skip']);  // 1 行不命中
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody(rows) }]
    });
    const save = outPath();
    const { matchedCount } = await exportFilter({
      filePath: fp, field: '渠道', values: ['支付宝'], savePath: save, maxRowsPerSheet: 3
    });
    assert.equal(matchedCount, 7, '命中 7 行');

    const back = await readback(save);
    assert.ok(back.sheetCount >= 3, `产物自动分 ≥3 个 sheet（实际 ${back.sheetCount}，ceil(7/3)=3）`);
    assert.deepEqual(back.headers, ['渠道', 'idx']);
    // readback 把每个 sub-sheet 的重复表头当续页跳过 → 得到 7 条命中数据行（顺序保持）。
    assert.equal(back.dataRows.length, 7, 'readback 跨 sub-sheet 得 7 行命中（重复表头跳过）');
    assert.deepEqual(back.dataRows.map((r) => r[1]), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'], '命中行内容/顺序正确');
    assert.ok(!back.dataRows.some((r) => r[1] === 'skip'), '不命中行未写入');
  });

  test('不传 maxRowsPerSheet（生产路径）：单 sheet 产物（命中远小于硬上限）', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['渠道', 'v'], ['支付宝', '1'], ['支付宝', '2']]) }]
    });
    const save = outPath();
    const { matchedCount } = await exportFilter({ filePath: fp, field: '渠道', values: ['支付宝'], savePath: save });
    assert.equal(matchedCount, 2);
    const back = await readback(save);
    assert.equal(back.sheetCount, 1, '生产路径默认硬上限 → 单 sheet');
    assert.deepEqual(back.dataRows, [['支付宝', '1'], ['支付宝', '2']]);
  });
});
