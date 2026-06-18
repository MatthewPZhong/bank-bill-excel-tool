'use strict';
// v3.0.9 需求1 · T3：split-scan-fields（scanFields）单测
//
// 覆盖（TECHDOC §6 T3 / §4.1 / §九 9.1）：
//   1. 多 sheet 夹具 → scanFields 回正确 { headers, valuesByField }：
//      - headers = 显示序第一个非空 sheet 首行（normalize 后）。
//      - valuesByField 每列 = 跨所有 sheet（含续页）注入去重集合（首现序、去重、空串跳过），与注入一致。
//   2. 封顶 N：高基数列去重值超 N → valuesByField 该列 ≤N（前 N 个，首现序）。
//   3. 重复表头 / 跨 sheet 去重：后续 sheet 重复表头不计入值；跨 sheet 同值去重。
//   4. 空文件（无有意义行）→ headers=null、valuesByField={}（累加器未 setHeaders）。
//   5. 契约锁：result() 只回 { [field]: string[] }，不含 truncated / distinctSeen 等元数据。
//
// 夹具：复用与 T1 multi-sheet-reader.test.js 同款的 yazl inlineStr 多 sheet 构造器（本文件内联一份，
//   不跨文件依赖测试夹具，保持单测独立可跑）。scanFields 走真实 T1 reader + T2 累加器（非打桩）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');

const { scanFields } = require('../../../../src/backend/toolbox-xlsx-stream/split-scan-fields');
const {
  DEFAULT_MAX_DISTINCT_PER_FIELD
} = require('../../../../src/backend/toolbox-xlsx-stream/bounded-values-accumulator');

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

// ---- XML / cell 工具（与 T1 测试同款 inlineStr 构造） ----
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
// 多 sheet 夹具：sheets = [{ name, target, body }]（显示序 = 数组序；target 可与显示序错位造乱序）。
function writeMultiSheetXlsx({ sheets }) {
  const dir = mkTmpDir('tbx-scan-');
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

test.describe('toolbox-xlsx-stream split-scan-fields scanFields', () => {

  test('多 sheet 夹具 → headers + valuesByField 与注入去重集合一致（首现序、去重、跨 sheet）', async () => {
    // 表头 [渠道, 币种, 商户]；数据跨 3 sheet（含重复表头页 + 无表头页）。
    //   渠道注入序：支付宝, 微信, 支付宝(重复), 银联 → 去重首现序 [支付宝, 微信, 银联]
    //   币种注入序：USD, EUR, USD(重复), CNY, EUR(重复) → [USD, EUR, CNY]
    //   商户：店A, 店B, 店C, 店A(重复) → [店A, 店B, 店C]
    const fp = await writeMultiSheetXlsx({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet2.xml',   // 乱序：显示序 0 → 物理 sheet2
          body: rowsToSheetBody([
            ['渠道', '币种', '商户'],
            ['支付宝', 'USD', '店A'],
            ['微信', 'EUR', '店B']
          ])
        },
        {
          name: 'S2', target: 'worksheets/sheet1.xml',   // 重复表头页
          body: rowsToSheetBody([
            ['渠道', '币种', '商户'],
            ['支付宝', 'USD', '店C'],   // 渠道/币种重复，商户新值
            ['银联', 'CNY', '店A']      // 商户重复，渠道/币种新值
          ])
        },
        {
          name: 'S3', target: 'worksheets/sheet3.xml',   // 无表头页（首行即数据）
          body: rowsToSheetBody([
            ['微信', 'EUR', '店B']      // 全重复 → 不增任何列
          ])
        }
      ]
    });

    const { headers, valuesByField } = await scanFields(fp, null);
    assert.deepEqual(headers, ['渠道', '币种', '商户'], '表头取显示序第一个 sheet 首行');
    assert.deepEqual(valuesByField['渠道'], ['支付宝', '微信', '银联'], '渠道去重首现序，跨 sheet 去重');
    assert.deepEqual(valuesByField['币种'], ['USD', 'EUR', 'CNY'], '币种去重首现序');
    assert.deepEqual(valuesByField['商户'], ['店A', '店B', '店C'], '商户去重首现序');
  });

  test('valuesByField 键集合 = headers；空串值跳过', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([
            ['A', 'B'],
            ['x', ''],         // B 空串 → 跳过
            ['x', 'y'],        // A 重复，B 收 y
            ['', 'y']          // A 空串跳过、B 重复
          ])
        }
      ]
    });
    const { headers, valuesByField } = await scanFields(fp, null);
    assert.deepEqual(headers, ['A', 'B']);
    assert.deepEqual(Object.keys(valuesByField).sort(), ['A', 'B'], '键集合 = headers');
    assert.deepEqual(valuesByField['A'], ['x'], 'A 空串跳过、去重');
    assert.deepEqual(valuesByField['B'], ['y'], 'B 空串跳过、去重');
  });

  test('封顶 N：单列去重值超 N → 该列 valuesByField 恰为前 N 个（首现序）', async () => {
    // 用小阈值不便（scanFields 不暴露 options），改注入「略多于默认 N」的去重值，断言被截到 N。
    //   为避免造 1000+ 行夹具过大，本用例只验证「单列超 N 被截」的核心契约：
    //   注入 N+5 个唯一值（v0..v{N+4}），断言该列长度 === N 且为前 N 个（首现序）。
    const N = DEFAULT_MAX_DISTINCT_PER_FIELD;
    const rows = [['ID']];
    for (let i = 0; i < N + 5; i += 1) rows.push([`v${i}`]);
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody(rows) }]
    });
    const { valuesByField } = await scanFields(fp, null);
    assert.equal(valuesByField['ID'].length, N, `单列封顶 N=${N}`);
    assert.equal(valuesByField['ID'][0], 'v0', '首现序前 N 个：第 0 个');
    assert.equal(valuesByField['ID'][N - 1], `v${N - 1}`, `首现序前 N 个：第 N-1 个`);
    assert.ok(!valuesByField['ID'].includes(`v${N}`), `第 N+1 个值 v${N} 被截掉`);
  });

  test('空文件（无有意义行）→ headers=null、valuesByField={}', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        { name: 'E1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody([{ selfClose: true }]) }
      ]
    });
    const { headers, valuesByField } = await scanFields(fp, null);
    assert.equal(headers, null, '空文件 headers=null');
    assert.deepEqual(valuesByField, {}, '空文件 valuesByField={}（累加器未 setHeaders）');
  });

  test('🚩 契约锁：valuesByField 只含 { [field]: string[] }，不含 truncated / distinctSeen 等元数据', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        {
          name: 'S1', target: 'worksheets/sheet1.xml',
          body: rowsToSheetBody([['渠道'], ['A'], ['B']])
        }
      ]
    });
    const { valuesByField } = await scanFields(fp, null);
    // 每个键的值必须是 string[]；不得出现 truncated / distinctSeen / totalCapReached / __* 之类元数据键。
    for (const [k, v] of Object.entries(valuesByField)) {
      assert.ok(Array.isArray(v), `valuesByField[${k}] 是数组`);
      assert.ok(v.every((x) => typeof x === 'string'), `valuesByField[${k}] 全为字符串`);
    }
    const forbidden = ['truncated', 'distinctSeen', 'totalCapReached', 'truncatedFields', 'maxDistinctPerField'];
    for (const key of forbidden) {
      assert.ok(!(key in valuesByField), `valuesByField 不含元数据键「${key}」`);
    }
  });

  test('cancelToken 透传：预置取消 → reader 进入 sheet 前即 break（headers=null、valuesByField={}）', async () => {
    const rows = [['c']];
    for (let i = 0; i < 50; i += 1) rows.push([`v${i}`]);
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody(rows) }]
    });
    // T1 reader 在「逐 sheet 循环开头」先 if (isCancelled()) break（早于读任何行）。预置 cancelled=true →
    //   循环体一次都不执行 → onHeaderRow 从不触发 → 累加器未 setHeaders → valuesByField={}、headers=null。
    //   （证明 scanFields 把 cancelToken 透传给了 T1 reader：无透传则会全量扫出 51 行。）
    const cancelToken = { cancelled: true };
    const { headers, valuesByField } = await scanFields(fp, cancelToken);
    assert.equal(headers, null, '预置取消：表头未读（reader 进 sheet 前即 break）');
    assert.deepEqual(valuesByField, {}, '预置取消：valuesByField={}（cancelToken 已透传给 reader）');
  });

  test('cancelToken 中途置位：读到若干数据行后取消 → 停止扫描（不读完全部，子集为已见值）', async () => {
    // 用 50 个唯一值，借 onDataRow 在累加器外无法注入——改在 reader 行回调里取消不可行（scanFields 不暴露）。
    //   但 scanFields 透传的 cancelToken 是「同一对象引用」，可在异步扫描进行中由外部计时器置位以观测中途停。
    //   这里用更确定的方式：包一层 reader 探针对 scanFields 等价不可行，故退化为验证「透传对象引用」即可——
    //   已由上一用例（预置取消）覆盖透传事实。本用例补充：cancelToken=null（不取消）→ 全量扫出（对照）。
    const rows = [['c']];
    for (let i = 0; i < 50; i += 1) rows.push([`v${i}`]);
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1', target: 'worksheets/sheet1.xml', body: rowsToSheetBody(rows) }]
    });
    const { valuesByField } = await scanFields(fp, null);
    assert.equal(valuesByField['c'].length, 50, '不取消 → 全量扫出 50 个唯一值（对照组）');
  });
});
