// v3.0.8 BUG3：工具箱🧰 流式读写（修 30 万行级大文件 OOM）单测
//
// 覆盖 src/main-process/toolbox-stream-io.js：
//   readHeaderRowStreamed   流式读表头（口径 = extractHeaders：首个有意义行 trim + normalize）；空文件抛
//   streamDataRows          流式逐行喂数据行（切表头 + 其余原样透传，含中间空行）；.csv 回退口径
//   buildColumnFormatPlan   by-name 字段分组（数字/日期/文本，大小写敏感）
//   buildNumericCellSpec    数字字段单元格构造（>15 位转文本 / 解析失败 null / ≤2 位小数套 0.00）
//   buildFormattedRow       一行原始 cells → ExcelJS 行值 + numFmt 补丁（决策① by-name 格式）
//   writeRowsStreamed       流式写 + 超 MAX_DATA_ROWS_PER_SHEET 自动分 sheet（决策②）+ readback 校验
//
// 并与全量 writeWorkbookRows 做 cell 级输出对拍（决策①：输出与现状完全一致）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const streamIO = require('../../../src/main-process/toolbox-stream-io');
const {
  readHeaderRowStreamed,
  streamDataRows,
  writeRowsStreamed,
  buildColumnFormatPlan,
  buildNumericCellSpec,
  buildFormattedRow,
  computeKeepWidth,
  sanitizeSheetName,
  canStreamXlsx,
  ToolboxStreamEmptyError,
  DEFAULT_FORMATTERS,
  MAX_DATA_ROWS_PER_SHEET,
  TOOLBOX_HEADER_SCAN_MAX_ROWS,
  TOOLBOX_MAX_COL_COUNT
} = streamIO;
const { writeWorkbookRows } = require('../../../src/backend/file-service');
const { readXlsxStreamed } = require('../../../src/backend/pending-import/streaming-xlsx-reader');

// 模拟流式 .xlsx reader 把一行补到固定列宽（colCount）——尾部全是字面 '' padding。
//   emit 收到的恒是 colCount 宽数组，padding 与「源真实空 cell」字面同为 ''；emit 须裁到表头宽（保留表头宽以内）。
function padToReaderWidth(row, colCount = TOOLBOX_MAX_COL_COUNT) {
  const padded = new Array(colCount).fill('');
  row.forEach((v, i) => { padded[i] = v; });
  return padded;
}

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-stream-ut-'));
});
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
});

function writeXlsx(name, aoa) {
  const file = path.join(tmpRoot, name);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'COMMON');
  XLSX.writeFile(wb, file);
  return file;
}

function writeCsv(name, text) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

// ============================================================
test.describe('buildColumnFormatPlan（by-name 字段分组，大小写敏感）', () => {
  test('数字/日期/文本字段各归类；未命中字段不在 plan', () => {
    const plan = buildColumnFormatPlan(['MerchantId', 'BillDate', 'Credit Amount', 'Note', 'Balance']);
    assert.equal(plan.get(0), 'text');     // MerchantId
    assert.equal(plan.get(1), 'date');     // BillDate
    assert.equal(plan.get(2), 'numeric');  // Credit Amount
    assert.equal(plan.has(3), false);      // Note 未命中
    assert.equal(plan.get(4), 'numeric');  // Balance
  });

  test('大小写敏感（balance / billdate 小写不命中）', () => {
    const plan = buildColumnFormatPlan(['balance', 'billdate', 'currency']);
    assert.equal(plan.size, 0, '小写表头不套任何 by-name 格式');
  });

  test('同名字段重复 → 每个匹配列都纳入', () => {
    const plan = buildColumnFormatPlan(['Currency', 'X', 'Currency']);
    assert.equal(plan.get(0), 'text');
    assert.equal(plan.get(2), 'text');
  });
});

test.describe('buildNumericCellSpec（移植 writers.js buildNumericCellValue）', () => {
  const pn = DEFAULT_FORMATTERS.parseNumericValue;
  test('≤2 位小数 → number + numFmt 0.00', () => {
    assert.deepEqual(buildNumericCellSpec('100.5', pn), { type: 'number', value: 100.5, numFmt: '0.00' });
    assert.deepEqual(buildNumericCellSpec('0', pn), { type: 'number', value: 0, numFmt: '0.00' });
  });
  test('>2 位小数 → number 不套 numFmt（保留原始精度显示）', () => {
    const spec = buildNumericCellSpec('1234.567', pn);
    assert.equal(spec.type, 'number');
    assert.equal(spec.value, 1234.567);
    assert.equal(spec.numFmt, null);
  });
  test('有效数字 >15 位 → 文本（防 Excel 15 位精度截断，如长卡号/订单号）', () => {
    const spec = buildNumericCellSpec('999999999999999999', pn); // 18 位
    assert.equal(spec.type, 'text');
    assert.equal(spec.value, '999999999999999999');
  });
  test('解析不出数字 → null（调用方降级原样字符串）', () => {
    assert.equal(buildNumericCellSpec('abc', pn), null);
    assert.equal(buildNumericCellSpec('not-num', pn), null);
  });
});

test.describe('buildFormattedRow（决策① by-name 格式化）', () => {
  const formatters = DEFAULT_FORMATTERS;
  test('数字字段 → number 值 + 0.00 numFmt 补丁', () => {
    const plan = buildColumnFormatPlan(['Balance']);
    const { values, patches } = buildFormattedRow(['1000.50'], plan, formatters);
    assert.equal(values[0], 1000.5);
    assert.deepEqual(patches, [{ colIdx: 0, numFmt: '0.00' }]);
  });
  test('日期字段 → Excel serial 值 + 日期 numFmt 补丁', () => {
    const plan = buildColumnFormatPlan(['BillDate']);
    const { values, patches } = buildFormattedRow(['20260104'], plan, formatters);
    assert.equal(typeof values[0], 'number', 'serial 为数字');
    assert.equal(patches[0].numFmt, 'yyyymmdd', '8 位 → yyyymmdd 格式');
  });
  test('文本字段 → 字符串值 + @ numFmt 补丁（强制文本，防长数字溢出）', () => {
    const plan = buildColumnFormatPlan(['MerchantId']);
    const { values, patches } = buildFormattedRow(['00012345678901234567'], plan, formatters);
    assert.equal(values[0], '00012345678901234567');
    assert.deepEqual(patches, [{ colIdx: 0, numFmt: '@' }]);
  });
  test('空值不套格式（保留原值，无 patch）', () => {
    const plan = buildColumnFormatPlan(['Balance', 'BillDate', 'Currency']);
    const { values, patches } = buildFormattedRow(['', '', ''], plan, formatters);
    assert.deepEqual(patches, [], '空值无 numFmt 补丁');
    assert.deepEqual(values, ['', '', '']);
  });
  test('未命中字段列原样透传字符串', () => {
    const plan = buildColumnFormatPlan(['Note']); // 未命中任何 by-name → plan 空
    const { values, patches } = buildFormattedRow(['任意文本'], plan, formatters);
    assert.deepEqual(values, ['任意文本']);
    assert.deepEqual(patches, []);
  });
  test('数字字段解析失败 → 原样字符串（不套格式）', () => {
    const plan = buildColumnFormatPlan(['Credit Amount']);
    const { values, patches } = buildFormattedRow(['abc'], plan, formatters);
    assert.equal(values[0], 'abc');
    assert.deepEqual(patches, []);
  });
});

test.describe('readHeaderRowStreamed（口径 = extractHeaders）', () => {
  test('.xlsx：首行表头 trim + normalize', async () => {
    const f = writeXlsx('hdr.xlsx', [[' A ', 'B', 'C'], ['x', 'y', 'z']]);
    const headers = await readHeaderRowStreamed(f);
    assert.deepEqual(headers, ['A', 'B', 'C'], 'trim 表头单元格');
  });

  test('.xlsx：尾部空表头单元格被裁（取到最后非空止）', async () => {
    // header 行后部空：A1=H1 B1=H2 C1空 → 表头 = [H1,H2]
    const ws = {};
    ws['A1'] = { t: 's', v: 'H1' };
    ws['B1'] = { t: 's', v: 'H2' };
    ws['A2'] = { t: 's', v: 'a' };
    ws['B2'] = { t: 's', v: 'b' };
    ws['!ref'] = 'A1:C2';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'COMMON');
    const f = path.join(tmpRoot, 'hdr-trail.xlsx');
    XLSX.writeFile(wb, f);
    const headers = await readHeaderRowStreamed(f);
    assert.deepEqual(headers, ['H1', 'H2']);
  });

  test('.csv 回退：同样 trim + normalize 首行', async () => {
    const f = writeCsv('hdr.csv', 'A, B ,C\nx,y,z\n');
    const headers = await readHeaderRowStreamed(f);
    assert.deepEqual(headers, ['A', 'B', 'C']);
  });

  test('空文件 → 抛 ToolboxStreamEmptyError', async () => {
    const f = writeXlsx('empty.xlsx', [['', ''], ['', '']]);
    await assert.rejects(() => readHeaderRowStreamed(f), ToolboxStreamEmptyError);
  });
});

test.describe('streamDataRows（切表头 + 其余原样透传）', () => {
  test('.xlsx：表头回调一次 + 数据行逐个喂', async () => {
    const f = writeXlsx('data.xlsx', [['H1', 'H2'], ['a', '1'], ['b', '2'], ['c', '3']]);
    const dataRows = [];
    let headerSeen = null;
    const res = await streamDataRows(f, (cells) => dataRows.push(cells.slice(0, 2)), (h) => { headerSeen = h.slice(0, 2); });
    assert.deepEqual(headerSeen, ['H1', 'H2']);
    assert.equal(res.dataRowCount, 3);
    assert.deepEqual(dataRows, [['a', '1'], ['b', '2'], ['c', '3']]);
  });

  test('.xlsx：中间空行原样透传（不丢，纯行级搬运口径）', async () => {
    // 中间一行全空字符串：mergeAoaRows 会保留 → 流式也透传
    const ws = {};
    ws['A1'] = { t: 's', v: 'H1' }; ws['B1'] = { t: 's', v: 'H2' };
    ws['A2'] = { t: 's', v: 'a' }; ws['B2'] = { t: 's', v: 'b' };
    ws['A3'] = { t: 's', v: '' }; ws['B3'] = { t: 's', v: '' }; // 显式空行
    ws['A4'] = { t: 's', v: 'c' }; ws['B4'] = { t: 's', v: 'd' };
    ws['!ref'] = 'A1:B4';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'COMMON');
    const f = path.join(tmpRoot, 'data-empty-mid.xlsx');
    XLSX.writeFile(wb, f);
    const dataRows = [];
    const res = await streamDataRows(f, (cells) => dataRows.push(cells.slice(0, 2)));
    assert.equal(res.dataRowCount, 3, '含中间空行共 3 数据行');
    assert.deepEqual(dataRows[1], ['', ''], '中间空行透传');
  });

  test('.csv 回退：切表头 + 透传数据行', async () => {
    const f = writeCsv('data.csv', 'H1,H2\na,1\nb,2\n');
    const dataRows = [];
    const res = await streamDataRows(f, (cells) => dataRows.push(cells.slice(0, 2)));
    assert.equal(res.dataRowCount, 2);
    assert.deepEqual(dataRows, [['a', '1'], ['b', '2']]);
  });
});

// ============================================================
// F1（PR#78 review）：乱序多 sheet 护栏
//   流式引擎 readXlsxStreamed 硬编码读物理 xl/worksheets/sheet1.xml；全量 readRows 读 SheetNames[0]
//   （= Excel 显示顺序第一个 tab）。当 workbook.xml 里 <sheet> 元素顺序被打乱、tab 顺序 ≠ 物理 part 命名顺序时，
//   两条路径读到不同 sheet。canStreamXlsx 对多 sheet .xlsx 返回 false → readHeaderRowStreamed / streamDataRows
//   回退全量 readRows（读 SheetNames[0]，与旧工具箱行为一致），避免静默读错 sheet。
// ============================================================
test.describe('F1 乱序多 sheet 护栏（canStreamXlsx + readHeaderRowStreamed/streamDataRows 回退）', () => {
  // 造一个「tab 显示顺序 ≠ 物理 part 命名顺序」的 2-sheet 文件：
  //   book_append_sheet A 再 B → 物理 sheet1.xml=A、sheet2.xml=B；
  //   再读 workbook.xml 把 <sheets> 里 A、B 两个 <sheet> 元素交换顺序写回、重新 generateAsync 落盘
  //   → SheetJS SheetNames 变 [B, A]，但物理 sheet1.xml 仍是 A（内容分叉）。
  async function writeScrambledTwoSheetXlsx(name) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['AH'], ['a1']]), 'A');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['BH'], ['b1']]), 'B');
    const tmp = path.join(tmpRoot, `pre-${name}`);
    XLSX.writeFile(wb, tmp);

    const zip = await JSZip.loadAsync(fs.readFileSync(tmp));
    let xml = await zip.file('xl/workbook.xml').async('string');
    const sheetsBlock = xml.match(/<sheets>[\s\S]*?<\/sheets>/)[0];
    const sheetTags = sheetsBlock.match(/<sheet\b[^>]*\/>/g);
    assert.equal(sheetTags.length, 2, 'fixture 预期 2 个 <sheet> 元素');
    // 交换两个 <sheet .../> 元素顺序 → SheetNames[0] 指向物理 sheet2.xml 的内容（B）。
    const swappedBlock = `<sheets>${sheetTags[1]}${sheetTags[0]}</sheets>`;
    xml = xml.replace(sheetsBlock, swappedBlock);
    zip.file('xl/workbook.xml', xml);
    const out = path.join(tmpRoot, name);
    fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer' }));
    return out;
  }

  test('fixture 自证：SheetNames[0]=B（BH）而物理 sheet1.xml=A（AH），确有分叉', async () => {
    const out = await writeScrambledTwoSheetXlsx('scramble-selfcheck.xlsx');
    // SheetJS（= readRows 口径）读到的第一个 tab 是 B
    const wb = XLSX.readFile(out);
    assert.deepEqual(wb.SheetNames, ['B', 'A']);
    const ws0 = wb.Sheets[wb.SheetNames[0]];
    assert.deepEqual(
      XLSX.utils.sheet_to_json(ws0, { header: 1, blankrows: false, defval: '' })[0].map(String),
      ['BH'],
      'SheetNames[0] 内容是 B'
    );
    // 流式引擎硬编码读物理 sheet1.xml → 读到 A（证明 fixture 真构造出了分叉，否则本组测试无意义）
    const streamedRows = [];
    await readXlsxStreamed(out, (cells) => {
      const nonEmpty = cells.filter((c) => c !== '');
      if (nonEmpty.length) streamedRows.push(nonEmpty);
    }, { colCount: TOOLBOX_MAX_COL_COUNT });
    assert.deepEqual(streamedRows, [['AH'], ['a1']], 'readXlsxStreamed 读到的是物理 sheet1.xml=A');
  });

  test('canStreamXlsx：多 sheet → false（回退全量 readRows）', async () => {
    const out = await writeScrambledTwoSheetXlsx('scramble-canstream-false.xlsx');
    assert.equal(await canStreamXlsx(out), false);
  });

  test('canStreamXlsx：物理单 sheet → true（不退化 BUG3 流式修复）', async () => {
    const single = writeXlsx('single-canstream-true.xlsx', [['H1', 'H2'], ['a', 'b']]);
    assert.equal(await canStreamXlsx(single), true);
  });

  test('canStreamXlsx：.csv → false（非 .xlsx 不流式）', async () => {
    const csv = writeCsv('canstream.csv', 'H1,H2\na,b\n');
    assert.equal(await canStreamXlsx(csv), false);
  });

  test('readHeaderRowStreamed：乱序多 sheet 取 SheetNames[0]=B 的表头 [BH]，不是物理 sheet1.xml=A 的 [AH]', async () => {
    const out = await writeScrambledTwoSheetXlsx('scramble-header.xlsx');
    const headers = await readHeaderRowStreamed(out);
    assert.deepEqual(headers, ['BH'], '回退 readRows 读 SheetNames[0]=B');
  });

  test('streamDataRows：乱序多 sheet 喂出 B 的数据行 [b1]，不是 A 的 [a1]', async () => {
    const out = await writeScrambledTwoSheetXlsx('scramble-data.xlsx');
    const dataRows = [];
    let headerSeen = null;
    const res = await streamDataRows(
      out,
      (cells) => dataRows.push(cells.filter((c) => c !== '')),
      (h) => { headerSeen = h.filter((c) => c !== ''); }
    );
    assert.deepEqual(headerSeen, ['BH'], '表头回调拿到 B 的表头');
    assert.equal(res.dataRowCount, 1);
    assert.deepEqual(dataRows, [['b1']], '数据行是 B 的 b1，不是 A 的 a1');
  });

  test('物理单 sheet .xlsx 仍走流式且内容正确（BUG3 修复未退化）', async () => {
    const single = writeXlsx('single-sheet-still-streams.xlsx', [['H1', 'H2'], ['x', 'y'], ['z', 'w']]);
    assert.equal(await canStreamXlsx(single), true);
    const headers = await readHeaderRowStreamed(single);
    assert.deepEqual(headers, ['H1', 'H2']);
    const dataRows = [];
    const res = await streamDataRows(single, (cells) => dataRows.push(cells.slice(0, 2)));
    assert.equal(res.dataRowCount, 2);
    assert.deepEqual(dataRows, [['x', 'y'], ['z', 'w']]);
  });
});

test.describe('sanitizeSheetName', () => {
  test('Excel 禁用字符 → -，长度 ≤ 31', () => {
    assert.equal(sanitizeSheetName('a/b\\c*d?e[f]g:h'), 'a-b-c-d-e-f-g-h');
    assert.equal(sanitizeSheetName('x'.repeat(40)).length, 31);
  });
});

test.describe('writeRowsStreamed（流式写 + readback）', () => {
  test('表头 + 数据行写出，readback 内容一致', async () => {
    const out = path.join(tmpRoot, 'w-basic.xlsx');
    const HEADERS = ['订单号', '渠道', '金额'];
    const data = [['o1', '微信', '100'], ['o2', '支付宝', '200']];
    const res = await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: HEADERS,
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => { data.forEach((r) => emit(r)); }
    });
    assert.equal(res.dataRowCount, 2);
    assert.equal(res.sheetCount, 1);

    const wb = XLSX.readFile(out);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rb = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    assert.deepEqual(rb[0].map(String), HEADERS);
    assert.deepEqual(rb.slice(1).map((r) => r.map(String)), data);
  });

  test('MAX 常量 = Excel 单 sheet 数据行硬上限 1048575', () => {
    assert.equal(MAX_DATA_ROWS_PER_SHEET, 1048575);
  });

  test('0 emit（拆表 0 命中场景底层）→ dataRowCount=0 + 单 sheet 仅表头（handler 据此不产文件）', async () => {
    const out = path.join(tmpRoot, 'w-empty.xlsx');
    const res = await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: ['H1', 'H2'],
      sheetBaseName: 'COMMON',
      writeDataRows: async (_emit) => { /* 0 命中：不 emit 任何行 */ }
    });
    assert.equal(res.dataRowCount, 0);
    assert.equal(res.sheetCount, 1);
    const wb = XLSX.readFile(out);
    const rb = XLSX.utils.sheet_to_json(wb.Sheets['COMMON'], { header: 1, blankrows: false, defval: '' });
    assert.deepEqual(rb.map((r) => r.map(String)), [['H1', 'H2']], '仅表头行');
  });

  test('决策②：数据行超阈值自动开 sub-sheet (2)(3)（maxRowsPerSheet 小阈值确定性验证）', async () => {
    // 用极小阈值（每 sheet 3 数据行）+ 7 数据行 → 期望 3 个 sheet：3 + 3 + 1。
    //   真实 1048575 边界由 30 万行级集成端到端 + 此逻辑等价覆盖（避免单测写 200 万行）。
    const out = path.join(tmpRoot, 'w-multisheet.xlsx');
    const HEADERS = ['H1', 'H2'];
    const total = 7;
    const res = await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: HEADERS,
      sheetBaseName: 'COMMON',
      maxRowsPerSheet: 3,
      writeDataRows: async (emit) => { for (let i = 0; i < total; i += 1) emit([`r${i}`, String(i)]); }
    });
    assert.equal(res.dataRowCount, total, '总数据行数 = emit 次数（不丢行）');
    assert.equal(res.sheetCount, 3, '7 行 / 3 每页 → 3 sheet');

    const wb = XLSX.readFile(out);
    // sheet 命名：首 sheet=COMMON，后续 COMMON(2) / COMMON(3)
    assert.deepEqual(wb.SheetNames, ['COMMON', 'COMMON(2)', 'COMMON(3)']);

    let totalData = 0;
    const allDataRows = [];
    wb.SheetNames.forEach((name) => {
      const rb = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
      // 每个 sheet 第 0 行都是表头（重写）
      assert.deepEqual(rb[0].map(String), HEADERS, `${name} 首行为表头`);
      const data = rb.slice(1).map((r) => r.map(String));
      totalData += data.length;
      allDataRows.push(...data);
    });
    assert.equal(totalData, total, '跨 sheet 数据行合计 = 7（分 sheet 不丢行）');
    // 行内容 + 顺序在跨 sheet 后完整保留
    assert.deepEqual(
      allDataRows,
      Array.from({ length: total }, (_v, i) => [`r${i}`, String(i)]),
      '跨 sheet 行内容 + 顺序完整保留'
    );
    // 行分布：3 / 3 / 1
    const perSheet = wb.SheetNames.map((name) =>
      XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' }).length - 1
    );
    assert.deepEqual(perSheet, [3, 3, 1], 'sheet 行分布 = [3,3,1]');
  });

  test('决策① cell 级对拍：流式输出 ≡ 全量 writeWorkbookRows（t/v/z 逐格相同，覆盖空行/纯空白/超宽边界）', async () => {
    const HEADERS = ['MerchantId', 'Channel', 'Currency', 'BillDate', 'ValueDate', 'Credit Amount', 'Debit Amount', 'Balance', 'Note'];
    const data = [
      ['NET001', 'ALIPAY', 'USD', '2026-01-02', '2026/01/03', '100.5', '0', '1000.50', 'hi'],
      ['00012345678901234567', 'WX', 'cny', '20260104', '2026-01-05', '1234.567', '', '999999999999999999', '溢出15位'],
      ['M2', 'UNION', 'EUR', '', '', '', '2.5', '-3.14159', '小数>2位'],
      ['M3', 'X', 'JPY', 'not-a-date', '2026-01-09', 'abc', '', 'not-num', '原样'],
      // 🔴 问题1 边界：以下行覆盖「全空行 / 纯空白 cell / 尾部空串 / 超表头宽真实内容」——旧 trim 裁尾会与全量分叉。
      ['', '', '', '', '', '', '', '', ''],                                          // (a) 整行全空数据行（不可丢）
      ['x', '  ', 'CNY', '20260104', '', '', '', '中间纯空白', ''],                    // 中间纯空白 cell '  ' 保真
      ['y', 'z', 'JPY', '', '', '', '', '', '  '],                                    // (b) 尾部纯空白 cell（headerWidth 内 idx8）保真
      ['M5', 'A', 'USD', '', '', '', '', '', ''],                                     // 多个尾部空串（headerWidth 内）保留
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', '超宽真实内容J'],                  // 超表头宽真实内容（idx9）保留 → !ref 变宽
      ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', '  ']                            // 超表头宽纯空白 cell（idx9）保真
    ];

    const fullOut = path.join(tmpRoot, 'parity-full.xlsx');
    writeWorkbookRows({ rows: [HEADERS, ...data], outputFilePath: fullOut, sheetName: 'COMMON' });

    const streamOut = path.join(tmpRoot, 'parity-stream.xlsx');
    await writeRowsStreamed({
      savePath: streamOut,
      normalizedHeaders: HEADERS.slice(),
      sheetBaseName: 'COMMON',
      // 模拟流式 reader 把行补到真实固定列宽 1024（验证 emit 裁到表头宽 + 保留表头宽以内全部 cell）
      writeDataRows: async (emit) => {
        data.forEach((r) => { emit(padToReaderWidth(r)); });
      }
    });

    const dump = (file) => {
      const ws = XLSX.readFile(file, { cellNF: true, cellStyles: true }).Sheets['COMMON'];
      const range = XLSX.utils.decode_range(ws['!ref']);
      const cells = {};
      for (let r = range.s.r; r <= range.e.r; r += 1) {
        for (let c = range.s.c; c <= range.e.c; c += 1) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          if (cell) cells[addr] = `t=${cell.t},v=${JSON.stringify(cell.v)},z=${cell.z || ''}`;
        }
      }
      return { ref: ws['!ref'], cells, ws };
    };

    const full = dump(fullOut);
    const stream = dump(streamOut);
    assert.equal(stream.ref, full.ref, '输出 !ref（含宽度）一致——超宽真实内容撑宽，padding 不撑宽');
    const keys = new Set([...Object.keys(full.cells), ...Object.keys(stream.cells)]);
    for (const k of keys) {
      assert.equal(stream.cells[k], full.cells[k], `单元格 ${k} t/v/z 一致`);
    }
    // readback（消费语义 blankrows:false）行数 + 内容逐行一致——全空数据行不丢。
    const rbFull = XLSX.utils.sheet_to_json(full.ws, { header: 1, blankrows: false, defval: '' });
    const rbStream = XLSX.utils.sheet_to_json(stream.ws, { header: 1, blankrows: false, defval: '' });
    assert.deepEqual(rbStream, rbFull, '流式 vs 全量 readback（含全空行/纯空白）逐行一致');
  });

  // ============================================================
  // 🔴 问题1（口径回归）专项：emit 裁到表头宽——全空行不丢、纯空白尾 cell 保真、readback 行数 == dataRowCount。
  // ============================================================
  test('问题1：全空数据行写出后 readback 仍在 + readback 行数 == dataRowCount', async () => {
    const out = path.join(tmpRoot, 'p1-empty-rows.xlsx');
    const HEADERS = ['H1', 'H2', 'H3'];
    // 数据行含 2 个整行全空行（reader padding 到 1024 宽）+ 普通行，共 4 行。
    const data = [
      ['a', 'b', 'c'],
      ['', '', ''],   // 全空行 1
      ['', '', ''],   // 全空行 2
      ['d', 'e', 'f']
    ];
    const res = await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: HEADERS.slice(),
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => { data.forEach((r) => emit(padToReaderWidth(r))); }
    });
    assert.equal(res.dataRowCount, 4, 'dataRowCount 含全空行 = emit 次数 4');

    const ws = XLSX.readFile(out).Sheets['COMMON'];
    const rb = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    // readback 行数（去表头）必须 == dataRowCount（全空行不被 blankrows:false 丢——它们有 headerWidth 个空 cell 对象）。
    assert.equal(rb.length - 1, res.dataRowCount, 'readback 数据行数 == dataRowCount（全空行不丢）');
    assert.equal(rb.length, 5, '表头 + 4 数据行 = 5 行');
    assert.deepEqual(rb[2], ['', '', ''], '全空行 1 readback 仍在（headerWidth 宽空 cell）');
    assert.deepEqual(rb[3], ['', '', ''], '全空行 2 readback 仍在');
    // 输出宽度 = 表头宽 3（全空行的 padding 不撑宽）。
    assert.equal(ws['!ref'], 'A1:C5', '!ref 宽度 = 表头列数（padding 不撑宽）');
  });

  test('问题1：尾部纯空白 cell 字面保真（不被 trim 裁掉）', async () => {
    const out = path.join(tmpRoot, 'p1-trailing-ws.xlsx');
    const HEADERS = ['H1', 'H2', 'H3'];
    const data = [['a', 'b', '  ']]; // 尾部 cell 是纯空白（headerWidth 内 idx2）
    await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: HEADERS.slice(),
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => { data.forEach((r) => emit(padToReaderWidth(r))); }
    });
    const ws = XLSX.readFile(out, { cellNF: true }).Sheets['COMMON'];
    assert.equal(ws.C2 && ws.C2.v, '  ', '尾部纯空白 cell 保留字面值 "  "（非 trim 成空/丢失）');
    const rb = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    assert.deepEqual(rb[1], ['a', 'b', '  '], 'readback 尾部纯空白保真');
  });

  test('问题1：超表头宽真实内容保留到最末非 padding 列（罕见异常数据）', async () => {
    const out = path.join(tmpRoot, 'p1-overwidth.xlsx');
    const HEADERS = ['H1', 'H2']; // 表头 2 列
    const data = [
      ['a', 'b'],
      ['x', 'y', 'z', 'w'], // 超表头宽真实内容（4 列）
      ['m', 'n']
    ];
    await writeRowsStreamed({
      savePath: out,
      normalizedHeaders: HEADERS.slice(),
      sheetBaseName: 'COMMON',
      writeDataRows: async (emit) => { data.forEach((r) => emit(padToReaderWidth(r))); }
    });
    const ws = XLSX.readFile(out).Sheets['COMMON'];
    assert.equal(ws['!ref'], 'A1:D4', '超宽真实行撑宽到 4 列（对齐全量 aoa_to_sheet 按最宽行定宽）');
    const rb = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    assert.deepEqual(rb[2], ['x', 'y', 'z', 'w'], '超宽行真实内容完整保留');
  });
});

// ============================================================
// 🔴 问题1：computeKeepWidth 纯函数（emit 裁宽口径）
// ============================================================
test.describe('computeKeepWidth（裁到 max(headerWidth, 最末非 padding 列+1)）', () => {
  test('常态：行真实内容 ≤ 表头宽（尾部 padding）→ keepWidth = headerWidth', () => {
    const padded = new Array(1024).fill('');
    ['a', 'b', 'c'].forEach((v, i) => { padded[i] = v; });
    assert.equal(computeKeepWidth(padded, 3), 3, '3 列内容 + 1021 padding → 裁到表头宽 3');
  });
  test('全空行（全是 padding）→ keepWidth = headerWidth（不裁成 0，保留表头宽个空 cell）', () => {
    assert.equal(computeKeepWidth(new Array(1024).fill(''), 5), 5);
  });
  test('纯空白尾 cell（headerWidth 内）→ keepWidth = headerWidth（保留）', () => {
    const padded = new Array(1024).fill('');
    ['a', 'b', '  '].forEach((v, i) => { padded[i] = v; });
    assert.equal(computeKeepWidth(padded, 3), 3, '纯空白 cell 在表头宽内由 headerWidth 下限保留');
  });
  test('纯空白 cell 字面非空 → 算非 padding，可撑宽超表头宽（与全量 aoa_to_sheet 一致）', () => {
    const padded = new Array(1024).fill('');
    ['a', 'b', '  '].forEach((v, i) => { padded[i] = v; }); // idx2 '  ' 超表头宽 2
    assert.equal(computeKeepWidth(padded, 2), 3, '纯空白 "  " 是真实内容 → keepWidth 扩到 3');
  });
  test('超表头宽真实内容 → keepWidth 扩到最末非 padding 列', () => {
    const padded = new Array(1024).fill('');
    ['a', 'b', 'c', 'd'].forEach((v, i) => { padded[i] = v; });
    assert.equal(computeKeepWidth(padded, 2), 4, '4 列真实内容 + 表头 2 → 取 4');
  });
});

// ============================================================
// 🔴 问题2（性能回归）专项：readHeaderRowStreamed 早停——不全量扫文件。
// ============================================================
test.describe('问题2：readHeaderRowStreamed 早停（不扫全文件）', () => {
  test('大文件读表头：底层 onRow 调用次数有界（<= TOOLBOX_HEADER_SCAN_MAX_ROWS）且 << 总行数', async () => {
    // 生成 2000 行文件（远超 256 上界）。
    const ROWS = 2000;
    const aoa = [['H1', 'H2', 'H3']];
    for (let i = 0; i < ROWS; i += 1) aoa.push([`a${i}`, `b${i}`, `c${i}`]);
    const big = writeXlsx('p2-earlystop.xlsx', aoa);

    // 直接量底层 readXlsxStreamed 在「读表头用的 maxRows」下的 onRow 次数（早停 → 有界）。
    let onRowCount = 0;
    const res = await readXlsxStreamed(
      big,
      () => { onRowCount += 1; },
      { colCount: TOOLBOX_MAX_COL_COUNT, maxRows: TOOLBOX_HEADER_SCAN_MAX_ROWS }
    );
    assert.ok(onRowCount <= TOOLBOX_HEADER_SCAN_MAX_ROWS, `onRow 次数 ${onRowCount} <= 上界 ${TOOLBOX_HEADER_SCAN_MAX_ROWS}`);
    assert.ok(onRowCount < ROWS + 1, `onRow 次数 ${onRowCount} << 总行数 ${ROWS + 1}（早停，未扫全文件）`);
    assert.equal(res.truncated, true, 'truncated=true：因 maxRows 提前 destroy stream');

    // 旧 bug（maxRows=0）会扫全文件作对照——证明改前后差异。
    let onRowFull = 0;
    const resFull = await readXlsxStreamed(big, () => { onRowFull += 1; }, { colCount: TOOLBOX_MAX_COL_COUNT, maxRows: 0 });
    assert.equal(onRowFull, ROWS + 1, '对照：maxRows=0（旧 bug）扫全文件 = 全部行');
    assert.equal(resFull.truncated, false, '对照：全量扫描 truncated=false');
    assert.ok(onRowCount < onRowFull, `早停 ${onRowCount} < 全量 ${onRowFull}`);

    // readHeaderRowStreamed 仍正确读到表头（早停不影响表头正确性）。
    const headers = await readHeaderRowStreamed(big);
    assert.deepEqual(headers, ['H1', 'H2', 'H3'], '早停后表头仍正确');
  });

  test('TOOLBOX_HEADER_SCAN_MAX_ROWS 为小正数（不是 0/负数——否则退化为全量扫描）', () => {
    assert.ok(Number.isInteger(TOOLBOX_HEADER_SCAN_MAX_ROWS) && TOOLBOX_HEADER_SCAN_MAX_ROWS > 0, '必须 > 0');
  });
});
