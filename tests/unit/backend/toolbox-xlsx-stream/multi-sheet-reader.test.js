'use strict';
// v3.0.9 需求1 · T1：multi-sheet-reader 单测
//
// 覆盖（TECHDOC §三③ / PRD §5.1.4 多 sheet 续页语义）：
//   1. 乱序多 sheet：workbook.xml <sheet> 显示序 ≠ 物理 sheetN.xml 编号序 → 按显示序读对（表头 + 数据顺序）。
//   2. 重复表头跳过：后续 sheet 首个有意义行 = 表头（归一化全等）→ 跳过、不当数据行。
//   3. 仅首页有表头：后续 sheet 无重复表头行（首行即数据）→ 首行也当数据行、不丢。
//   4. 列序冲突：某后续 sheet 首行列数 ≠ 表头列数 → 抛 ToolboxHeaderMismatchError。
//   5. 空 sheet 跳过：第一个 sheet 为空（无任何有意义行）→ 表头取下一个非空 sheet 首行。
//   6. 跨 sheet rowR 重置：每个 sheet 各自 <row r="1"> 起编号 → 表头判定按「每 sheet 首个有意义行」而非全局 rowR===1。
//   7. 数据行恰等表头被当重复表头跳过（已知边界，显式记录）。
//   + 归一化口径：normalizeCell trim（表头/值带空格被 trim）、前导空行跳过、纯空格行视为空行跳过。
//   + cancelToken：中途取消停读后续行 / 后续 sheet。
//
// 夹具：本文件自建 yazl 构造器（参考 tests/unit/backend/big-table-import/_fixtures.js writeMultiSheetXlsx，
//   增强为可独立指定每个 <sheet> 的显示顺序 + 物理 target，以造「乱序」；不改动 _fixtures.js）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');

const {
  streamLogicalTableRows,
  streamStrictWorkbookSheetTables,
  ToolboxSheetReadError
} = require('../../../../src/backend/toolbox-xlsx-stream/multi-sheet-reader');
const { ToolboxHeaderMismatchError } = require('../../../../src/main-process/toolbox');

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

// ---- XML / cell 工具 ----
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
// 把一行 cells（string[]）渲染为 inlineStr <c> 序列（空串/ null 跳过 → 稀疏写）。
function rowToInlineStrCells(cells, rowNum) {
  let xml = '';
  cells.forEach((v, i) => {
    if (v === '' || v == null) return;
    xml += `<c r="${colLetter(i)}${rowNum}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  });
  return xml;
}
// 把若干「逻辑行」（每行 cells 数组）渲染为 sheetData body，行号从 startR 起递增。
//   row 可为 { cells } 或 { raw }（raw 直接是 <c> 序列）或 { selfClose:true }（空行 <row r/>）。
function rowsToSheetBody(rows, startR = 1) {
  let body = '';
  let r = startR;
  for (const row of rows) {
    if (row && row.selfClose) { body += `<row r="${r}"/>`; r += 1; continue; }
    body += `<row r="${r}">`;
    if (row && row.raw !== undefined) body += row.raw;
    else body += rowToInlineStrCells(Array.isArray(row) ? row : (row && row.cells) || [], r);
    body += '</row>';
    r += 1;
  }
  return body;
}

// 增强版多 sheet 夹具：sheets = [{ name, target, body }]（显示序 = 数组序）。
//   target = 物理 worksheet entry 名（如 'worksheets/sheet3.xml'），可与显示序错位以造「乱序」。
//   body = 已由 rowsToSheetBody 渲染好的 sheetData 内 <row> 序列字符串（含各行行号）。
//   显示序由 workbook.xml <sheet> 元素顺序决定；r:id → rels → target 完成正解映射。
function writeMultiSheetXlsxAdvanced({ sheets }) {
  const dir = mkTmpDir('tbx-msr-');
  const fp = path.join(dir, 'fixture.xlsx');
  const entries = sheets.map((s, i) => ({
    name: s.name,
    rid: `rId${i + 1}`,
    target: s.target,                 // 显式物理 target（可乱序）
    body: s.body || '',               // 已渲染的 <row> 序列
    state: s.state || 'visible',
    omitEntry: !!s.omitEntry
  }));
  const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + entries.map((s, i) => {
      const stateAttr = s.state === 'visible' ? '' : ` state="${s.state}"`;
      return `<sheet name="${escXml(s.name)}" sheetId="${i + 1}"${stateAttr} r:id="${s.rid}"/>`;
    }).join('')
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
    // 物理 entry 名归一为 xl/ 前缀（与 normalizeWorksheetTarget 一致）。body 已是渲染好的 <row> 序列。
    for (const s of entries) {
      if (s.omitEntry) continue;
      const physical = s.target.startsWith('xl/') ? s.target : `xl/${s.target}`;
      zf.addBuffer(Buffer.from(sheetXml(s.body), 'utf8'), physical);
    }
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

// 收集回调：返回 { headers, headerCalls, dataRows, summary }。dataRows 为原样透传的数组（trim 尾部空后比对）。
async function collect(fp, opts = {}) {
  const headerCalls = [];
  const dataRows = [];
  const summary = await streamLogicalTableRows(fp, {
    onHeaderRow: (h) => headerCalls.push(h),
    onDataRow: (v) => dataRows.push(v),
    cancelToken: opts.cancelToken || null
  });
  return {
    headers: headerCalls.length ? headerCalls[0] : null,
    headerCallCount: headerCalls.length,
    dataRows,
    summary
  };
}

// 把透传的数据行（定长数组，尾部 ''）切到「最后一个非空 cell」止再 trim，便于断言（与归一化口径一致）。
function trimRow(values) {
  let last = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i] == null ? '' : values[i]).trim() !== '') last = i;
  }
  return values.slice(0, last + 1).map((c) => String(c == null ? '' : c).trim());
}

test.describe('toolbox-xlsx-stream multi-sheet-reader', () => {

  test('乱序多 sheet：workbook <sheet> 显示序 ≠ 物理 sheetN.xml 编号 → 按显示序读对（表头 + 数据顺序）', async () => {
    // 显示序：A(物理 sheet3) → B(物理 sheet1) → C(物理 sheet2)。
    //   表头应取显示序第一个 = A 的首行；数据顺序按显示序 A→B→C。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        // 显示序 0：物理 sheet3.xml，表头 + 1 数据行
        {
          name: 'A', target: 'worksheets/sheet3.xml',
          body: rowsToSheetBody([['名称', '币种'], ['苹果', 'USD']])
        },
        // 显示序 1：物理 sheet1.xml，重复表头 + 1 数据行
        {
          name: 'B', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([['名称', '币种'], ['香蕉', 'EUR']])
        },
        // 显示序 2：物理 sheet2.xml，无重复表头，首行即数据 + 1 数据行
        {
          name: 'C', target: 'worksheets/sheet2.xml',
          body: rowsToSheetBody([['橙子', 'CNY'], ['葡萄', 'JPY']])
        }
      ]
    });
    const { headers, headerCallCount, dataRows } = await collect(fp);
    assert.equal(headerCallCount, 1, 'onHeaderRow 恰回调一次');
    assert.deepEqual(headers, ['名称', '币种'], '表头取显示序第一个 sheet（A）首行');
    // 数据顺序：A 的「苹果」→ B 的「香蕉」(重复表头跳过) → C 的「橙子」「葡萄」(无重复表头)。
    const got = dataRows.map(trimRow);
    assert.deepEqual(got, [
      ['苹果', 'USD'],
      ['香蕉', 'EUR'],
      ['橙子', 'CNY'],
      ['葡萄', 'JPY']
    ], '数据按显示序 A→B→C 透传，重复表头不进数据，无表头页首行进数据');
  });

  test('重复表头跳过：每个后续 sheet 首行 = 表头 → 仅一次表头回调，数据不含表头', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['col1', 'col2'], ['a', '1']]) },
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['col1', 'col2'], ['b', '2']]) },
        { name: 'S3', target: 'worksheets/sheet3.xml', body: rowsToSheetBody([['col1', 'col2'], ['c', '3']]) }
      ]
    });
    const { headers, headerCallCount, dataRows } = await collect(fp);
    assert.equal(headerCallCount, 1, '表头只回调一次（后续 sheet 重复表头跳过）');
    assert.deepEqual(headers, ['col1', 'col2']);
    assert.deepEqual(dataRows.map(trimRow), [['a', '1'], ['b', '2'], ['c', '3']]);
  });

  test('仅首页有表头：后续 sheet 无重复表头行，首行即数据 → 首行也当数据不丢', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['k', 'v'], ['r1', 'x']]) },
        // S2 无表头行，所有行都是数据
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['r2', 'y'], ['r3', 'z']]) }
      ]
    });
    const { headers, dataRows } = await collect(fp);
    assert.deepEqual(headers, ['k', 'v']);
    assert.deepEqual(dataRows.map(trimRow), [['r1', 'x'], ['r2', 'y'], ['r3', 'z']], 'S2 首行 r2 未被当表头跳过');
  });

  test('列序冲突：后续 sheet 首行列数「多于」表头 → 抛 ToolboxHeaderMismatchError（带 name + detailLines）', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['a', 'b', 'c'], ['1', '2', '3']]) },
        // S2 首行 4 列（> 表头 3 列）且 ≠ 表头 → 出现表头之外的额外列 → 列序冲突
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['x', 'y', 'z', 'w']]) }
      ]
    });
    let err = null;
    try {
      await collect(fp);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应抛错');
    assert.ok(err instanceof ToolboxHeaderMismatchError, 'err instanceof ToolboxHeaderMismatchError');
    assert.equal(err.name, 'ToolboxHeaderMismatchError');
    assert.ok(Array.isArray(err.detailLines) && err.detailLines.length > 0, 'detailLines 非空（供前端 alert）');
    assert.match(err.message, /多于逻辑表头|额外列/, 'message 含「多出列」语义');
  });

  test('续页参差短行不误报：后续 sheet 无重复表头、首行比表头短（尾部空列）→ 当数据行不丢、不报错', async () => {
    // 表头 3 列 [A,B,C]；S2 无重复表头，首行只有前 2 列有值（C 列空 → trim 后 len 2 < 3）。
    //   旧 `!==` 判据会把它误判为列序冲突；新 `>` 判据应当数据行透传。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['A', 'B', 'C'], ['1', '2', '3']]) },
        // S2 首行 [x, y, <C空>]（参差短行）+ 第 2 行 [p, q, r]（满列）
        {
          name: 'S2', target: 'worksheets/sheet2.xml',
          body: rowsToSheetBody([
            { raw: '<c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="B1" t="inlineStr"><is><t>y</t></is></c>' },  // r=1：仅 A/B 有值，C 空
            ['p', 'q', 'r']   // r=2：满 3 列
          ], 1)
        }
      ]
    });
    let err = null;
    let result = null;
    try {
      result = await collect(fp);
    } catch (e) {
      err = e;
    }
    assert.equal(err, null, '参差短行不应报错');
    assert.deepEqual(result.headers, ['A', 'B', 'C'], '表头仍取 S1 首行');
    // S1 数据 [1,2,3] + S2 首行 [x,y]（参差短行，当数据行不丢）+ S2 第 2 行 [p,q,r]。
    assert.deepEqual(result.dataRows.map(trimRow), [['1', '2', '3'], ['x', 'y'], ['p', 'q', 'r']],
      'S2 参差首行 [x,y] 被当数据行透传、未丢，且与第 2 行口径一致');
    assert.equal(result.summary.dataRowCount, 3, 'dataRowCount 含参差首行');
  });

  test('续页首行 = 表头列数（内容不同）仍当数据行（边界：列数相等非冲突）', async () => {
    // 表头 [A,B,C]；S2 无重复表头，首行 [x,y,z]（满 3 列、内容 ≠ 表头）→ 当数据行（列数相等不报错）。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['A', 'B', 'C'], ['1', '2', '3']]) },
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['x', 'y', 'z'], ['p', 'q', 'r']]) }
      ]
    });
    const { dataRows, summary } = await collect(fp);
    assert.deepEqual(dataRows.map(trimRow), [['1', '2', '3'], ['x', 'y', 'z'], ['p', 'q', 'r']],
      'S2 满列首行 [x,y,z] 当数据行（列数相等不报错）');
    assert.equal(summary.dataRowCount, 3);
  });

  test('空 sheet 跳过：第一个 sheet 完全为空（无有意义行）→ 表头取下一个非空 sheet 首行', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        // S1 完全空（仅一个自闭合空行）
        { name: 'S1空', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([{ selfClose: true }]) },
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['h1', 'h2'], ['d1', 'd2']]) }
      ]
    });
    const { headers, headerCallCount, dataRows, summary } = await collect(fp);
    assert.equal(headerCallCount, 1);
    assert.deepEqual(headers, ['h1', 'h2'], '表头跳过空 S1，取 S2 首行');
    assert.deepEqual(dataRows.map(trimRow), [['d1', 'd2']]);
    assert.equal(summary.sheetCount, 2, 'summary.sheetCount = 物理 sheet 总数（含空 sheet）');
  });

  test('完全无 sheetData 的空 sheet（<sheetData/>）也跳过', async () => {
    // 用 raw 直接给空 body（rowsToSheetBody 输出空串 → <sheetData></sheetData>，row-scanner SEEK_ROW 找不到 <row 即结束）
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'E1', target: 'worksheets/sheet1.xml', body: '' },
        { name: 'D1', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['a'], ['v1']]) }
      ]
    });
    const { headers, dataRows } = await collect(fp);
    assert.deepEqual(headers, ['a']);
    assert.deepEqual(dataRows.map(trimRow), [['v1']]);
  });

  test('跨 sheet rowR 重置：每个 sheet 各自 <row r="1"> 起 → 表头判定按「每 sheet 首个有意义行」而非全局 rowR===1', async () => {
    // 两个 sheet 都从 r=1 起。若误用全局 rowR===1 判表头，第二个 sheet 的 r=1（重复表头）会被当「另一个表头」
    //   而非「续页重复表头」，或其数据行 r 计数错乱。本用例锁：第二 sheet r=1 是重复表头被跳过、r=2 数据进。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'P1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['日期', '金额'], ['2026-01-01', '100']], 1) },
        // P2 同样从 r=1 起：r=1 重复表头、r=2 数据
        { name: 'P2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['日期', '金额'], ['2026-02-02', '200']], 1) }
      ]
    });
    const { headers, headerCallCount, dataRows } = await collect(fp);
    assert.equal(headerCallCount, 1, '跨 sheet 只一次表头（P2 的 r=1 重复表头未被当新表头）');
    assert.deepEqual(headers, ['日期', '金额']);
    assert.deepEqual(dataRows.map(trimRow), [['2026-01-01', '100'], ['2026-02-02', '200']]);
  });

  test('跨 sheet rowR 重置（数据从非 r=1 起）：后续 sheet 首个有意义行在 r=5 也能被识别', async () => {
    // P2 前 4 行自闭合空行，首个有意义行在 r=5（重复表头），r=6 数据。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'P1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['c1', 'c2'], ['a', 'b']], 1) },
        {
          name: 'P2', target: 'worksheets/sheet2.xml',
          body: rowsToSheetBody([
            { selfClose: true }, { selfClose: true }, { selfClose: true }, { selfClose: true },
            ['c1', 'c2'],   // r=5 重复表头
            ['e', 'f']      // r=6 数据
          ], 1)
        }
      ]
    });
    const { headers, dataRows } = await collect(fp);
    assert.deepEqual(headers, ['c1', 'c2']);
    assert.deepEqual(dataRows.map(trimRow), [['a', 'b'], ['e', 'f']], 'P2 r=5 重复表头跳过、r=6 数据进');
  });

  test('已知边界：数据行恰等于表头 → 被当重复表头跳过（显式记录、不视为 bug）', async () => {
    // 单 sheet 内，一条「数据行」内容恰好等于表头时不会出现（表头是首行）；
    //   续页场景：后续 sheet 首行恰等表头一律视作重复表头。本用例锁「内容恰等表头的行」被跳过的边界语义。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['类型', '值'], ['正常', '1']]) },
        // S2 首行 = 表头（恰等），即便它本意是「一条恰好等于表头的数据」，也按续页语义被当重复表头跳过；
        //   S2 第二行才是真正数据。
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['类型', '值'], ['真数据', '2']]) }
      ]
    });
    const { dataRows } = await collect(fp);
    const got = dataRows.map(trimRow);
    // 「类型/值」这条恰等表头的行不出现在数据里（边界代价）。
    assert.deepEqual(got, [['正常', '1'], ['真数据', '2']]);
    assert.ok(!got.some((r) => r[0] === '类型' && r[1] === '值'), '恰等表头的行被当重复表头跳过');
  });

  test('归一化口径：表头 / 值带前后空格被 trim；前导全空行 + 纯空格行视为空行跳过', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([
            { selfClose: true },              // r=1 前导空行 → 跳过
            ['  字段A  ', ' 字段B '],          // r=2 表头（带空格 → trim）
            ['  v1 ', 'x'],                   // r=3 数据（值 trim）
            ['   ', '   ']                    // r=4 纯空格行 → isRowMeaningful=false 跳过
          ], 1)
        }
      ]
    });
    const { headers, dataRows } = await collect(fp);
    assert.deepEqual(headers, ['字段A', '字段B'], '表头 trim');
    // 数据行原样透传（不归一化），但 trim 后比对：纯空格行被跳过、不进数据。
    assert.deepEqual(dataRows.map(trimRow), [['v1', 'x']], '纯空格行 r=4 跳过、值已可 trim');
  });

  test('cancelToken：中途取消 → 停止读后续行 / 后续 sheet（不读完全部）', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([['c'], ['1'], ['2'], ['3'], ['4'], ['5']])
        },
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['c'], ['6'], ['7']]) }
      ]
    });
    const cancelToken = { cancelled: false };
    const dataRows = [];
    const summary = await streamLogicalTableRows(fp, {
      onHeaderRow: () => {},
      onDataRow: (v) => {
        dataRows.push(v);
        if (dataRows.length === 2) cancelToken.cancelled = true;   // 读到第 2 行后取消
      },
      cancelToken
    });
    assert.ok(summary.cancelled, 'summary.cancelled=true');
    assert.ok(dataRows.length >= 2 && dataRows.length < 8, `中途停（读了 ${dataRows.length} 行，未读完全部 7 行）`);
  });

  test('cancelToken 在 onHeaderRow 内置位 → 当前 sheet 立即停 + 后续 sheet 不读（peek 提前停机制，codex P2）', async () => {
    // peekNormalizedHeaders 的底层机制：拿到表头即置 cancelToken → 主循环 sheet 边界 break，不读后续 sheet。
    //   夹具：S2 首行列数「多于」表头（若被扫到会抛 ToolboxHeaderMismatchError）。置位后 S2 绝不应被读 →
    //   不抛错、0 数据行（证明 peek 真 O(1)，不退化为近全量扫）。
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['A', 'B'], ['1', '2'], ['3', '4']]) },
        // S2 首行 4 列 > 表头 2 列：若 peek 误扫 S2 会抛 ToolboxHeaderMismatchError（用作「是否误扫」的探针）
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['w', 'x', 'y', 'z']]) }
      ]
    });
    const cancelToken = { cancelled: false };
    const dataRows = [];
    let err = null;
    let summary = null;
    try {
      summary = await streamLogicalTableRows(fp, {
        onHeaderRow: () => { cancelToken.cancelled = true; },   // 拿到表头即置位（模拟 peek）
        onDataRow: (v) => dataRows.push(v),
        cancelToken
      });
    } catch (e) { err = e; }
    assert.equal(err, null, '置位后不读后续行 / sheet → 不触发 S2 列冲突报错（证明 S2 未被扫）');
    assert.equal(dataRows.length, 0, '表头后立即停：S1 数据行 + 整个 S2 都未读（0 数据行）');
    assert.ok(summary && summary.cancelled, 'summary.cancelled=true');
  });

  test('返回 summary：sheetCount / dataRowCount / headerFound 正确', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['h'], ['a'], ['b']]) },
        { name: 'S2', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['h'], ['c']]) }
      ]
    });
    const { summary, dataRows } = await collect(fp);
    assert.equal(summary.sheetCount, 2, 'sheetCount=2');
    assert.equal(summary.dataRowCount, 3, 'dataRowCount=3（a/b/c，重复表头不计）');
    assert.equal(summary.dataRowCount, dataRows.length, 'dataRowCount = onDataRow 次数');
    assert.equal(summary.headerFound, true);
  });

  test('数据行 values 是「按列索引的数组」（非对象）原样透传给 onDataRow', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['c1', 'c2'], ['v1', 'v2']]) }
      ]
    });
    let captured = null;
    await streamLogicalTableRows(fp, {
      onHeaderRow: () => {},
      onDataRow: (v) => { captured = v; },
      cancelToken: null
    });
    assert.ok(Array.isArray(captured), 'onDataRow values 是数组');
    assert.equal(captured[0], 'v1', '按列索引 [0]');
    assert.equal(captured[1], 'v2', '按列索引 [1]');
  });

  test('sharedStrings（t="s"）跨 sheet 共享一次加载：值正确解码', async () => {
    // 手工拼带 sharedStrings 的多 sheet。两个 sheet 都用 t="s" 引用同一 SST。
    const dir = mkTmpDir('tbx-msr-sst-');
    const fp = path.join(dir, 'fixture.xlsx');
    const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">'
      + '<si><t>名称</t></si><si><t>渠道</t></si><si><t>支付宝</t></si><si><t>微信</t></si></sst>';
    const sheetXml = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
    // sheet1：表头 名称/渠道 (s=0,1) + 数据 行(名称给 inlineStr「店A」, 渠道 s=2「支付宝」)
    const s1 = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>店A</t></is></c><c r="B2" t="s"><v>2</v></c></row>';
    // sheet2：重复表头 + 数据（渠道 s=3「微信」）
    const s2 = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>店B</t></is></c><c r="B2" t="s"><v>3</v></c></row>';
    const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + '<sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '</Relationships>';
    await new Promise((resolve, reject) => {
      const zf = new yazl.ZipFile();
      zf.addBuffer(Buffer.from(wbXml, 'utf8'), 'xl/workbook.xml');
      zf.addBuffer(Buffer.from(relsXml, 'utf8'), 'xl/_rels/workbook.xml.rels');
      zf.addBuffer(Buffer.from(sst, 'utf8'), 'xl/sharedStrings.xml');
      zf.addBuffer(Buffer.from(sheetXml(s1), 'utf8'), 'xl/worksheets/sheet1.xml');
      zf.addBuffer(Buffer.from(sheetXml(s2), 'utf8'), 'xl/worksheets/sheet2.xml');
      zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', resolve).on('error', reject);
      zf.end();
    });

    const { headers, dataRows } = await collect(fp);
    assert.deepEqual(headers, ['名称', '渠道'], 'SST 表头解码');
    assert.deepEqual(dataRows.map(trimRow), [['店A', '支付宝'], ['店B', '微信']], 'SST 跨 sheet 值解码正确');
  });
});

test.describe('toolbox-xlsx-stream strict workbook sheet tables', () => {
  test('每张可见非空 sheet 都回调独立表头，数据按 workbook 显示序透传', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: '显示一', target: 'worksheets/sheet3.xml', body: rowsToSheetBody([['H1', 'H2'], ['a', '1']]) },
        { name: '显示二', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['H1', 'H2'], ['b', '2']]) },
        { name: '显示三', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['H1', 'H2'], ['c', '3']]) }
      ]
    });
    const headers = [];
    const rows = [];
    const summary = await streamStrictWorkbookSheetTables(fp, {
      onSheetHeader: (info) => headers.push({ name: info.sheetName, headers: info.headers }),
      onDataRow: (values, info) => rows.push({ name: info.sheetName, values: trimRow(values) })
    });

    assert.deepEqual(headers, [
      { name: '显示一', headers: ['H1', 'H2'] },
      { name: '显示二', headers: ['H1', 'H2'] },
      { name: '显示三', headers: ['H1', 'H2'] }
    ]);
    assert.deepEqual(rows, [
      { name: '显示一', values: ['a', '1'] },
      { name: '显示二', values: ['b', '2'] },
      { name: '显示三', values: ['c', '3'] }
    ]);
    assert.equal(summary.nonEmptySheetCount, 3);
    assert.equal(summary.dataRowCount, 3);
  });

  test('隐藏、深度隐藏和空 sheet 跳过；前导空行忽略；仅表头 sheet 仍参与', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: '隐藏', state: 'hidden', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([['H'], ['secret']]) },
        { name: '深藏', state: 'veryHidden', target: 'worksheets/sheet2.xml', body: rowsToSheetBody([['H'], ['secret2']]) },
        { name: '空白', target: 'worksheets/sheet3.xml', body: rowsToSheetBody([{ selfClose: true }, ['   ']]) },
        { name: '只有表头', target: 'worksheets/sheet4.xml', body: rowsToSheetBody([{ selfClose: true }, [' H ']]) },
        { name: '数据', target: 'worksheets/sheet5.xml', body: rowsToSheetBody([['H'], ['H'], ['v']]) }
      ]
    });
    const headers = [];
    const rows = [];
    const summary = await streamStrictWorkbookSheetTables(fp, {
      onSheetHeader: (info) => headers.push([info.sheetName, info.headers]),
      onDataRow: (values, info) => rows.push([info.sheetName, trimRow(values)])
    });

    assert.deepEqual(headers, [['只有表头', ['H']], ['数据', ['H']]]);
    assert.deepEqual(rows, [['数据', ['H']], ['数据', ['v']]], '数据区再次出现表头内容仍保留');
    assert.equal(summary.hiddenSheetCount, 2);
    assert.equal(summary.emptySheetCount, 1);
    assert.equal(summary.nonEmptySheetCount, 2);
    assert.equal(summary.dataRowCount, 2);
  });

  test('可见 sheet 关系缺失时 fail closed，不静默跳过', async () => {
    const fp = await writeMultiSheetXlsxAdvanced({
      sheets: [
        { name: '损坏页', target: 'worksheets/sheet7.xml', body: '', omitEntry: true }
      ]
    });
    await assert.rejects(
      () => streamStrictWorkbookSheetTables(fp),
      (error) => {
        assert.ok(error instanceof ToolboxSheetReadError);
        assert.match(error.message, /损坏页/);
        assert.ok(error.detailLines.some((line) => line.includes('关系缺失')));
        return true;
      }
    );
  });
});
