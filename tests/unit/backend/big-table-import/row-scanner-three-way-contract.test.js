'use strict';
// 引擎 row-scanner 三方 harness（🔴🔴 byte-for-byte 资金红线闸 · v3.0.3 PR-G1 四方 harness 的延续）
//
// 锁：三方解析器在同一 fixture 上逐行逐列 values / rowR(rowIndex) / hasAnyCellText / monthKey / 捕获行数全等：
//   B = 手写全列        —— duplicate-inbound-match/document-xlsx-stream.streamSheetRowsHandRolled（valueColumnWhitelist=null）
//   C = 手写白名单(P1b) —— 同上（WL）
//   D = 引擎字节层      —— big-table-import/row-scanner.scanSheetRows（白名单 + 全列两种模式）
//
// v3.2.20 收单单据币种校验下线：原 A=sax 基线（收单 importFlowFile）随之删除，B≡A 已在历史版本锁定，B 作全列真理源。
//   手写解析器逐字迁入重复入金匹配（document-xlsx-stream）；row-scanner 仍由 Position / VCC / Toolbox 读取使用。
//   原收单流水 48 列表头、白名单 {0,6,28,29} 与月份提取规则保留为本文件的固定测试契约，不再对应任何业务模块。
//
// 🔴 引擎 D 路径额外覆盖「跨 chunk 边界」：把 sheet entry 读成 buffer 后切成可配置小 chunk 序列重喂
//   （含 3/17 字节极端切碎，强制半行拼接 + 标签跨界），与 B 全等——证字节层流式拼接零漂移。
//
// 场景：inlineStr / sharedStrings(t=s) / number / 科学计数 / XML 实体 / 空行 / 稀疏行号 / 自闭合 row /
//   退化路径（仅白名单外列有值）/ SST 空串 / 大行号前缀碰撞（r="AC1" vs r="AC12"）。

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
  openZipWithEntries,
  loadSharedStrings,
  SHARED_STRINGS_ENTRY_NAME,
  streamSheetRowsHandRolled
} = require('../../../../src/main-process/duplicate-inbound-match/document-xlsx-stream');

// 引擎被测对象
const zipReader = require('../../../../src/backend/xlsx/zip-reader');
const rowScanner = require('../../../../src/backend/big-table-import/row-scanner');

const SHEET_ENTRY_NAME = 'xl/worksheets/sheet1.xml';
const FLOW_HEADERS = Object.freeze([
  '账单日期', 'originBizId', '主体大账号', '公司主体', '流水类型', '业务部门',
  '对账主Id', '出入方向', '流水单号', '用户编号', '账户编号', '拆分类型',
  '对账金额', '币种', '账户类型', '流水开始时间', '流水完成时间', '渠道',
  'MerchantId', 'valueDate', 'BankRef', 'Pending标识', '流水BizId', '穿透ID',
  '操作人', '系统创建时间', '系统修改时间', 'MID', '通道清算金额', '通道清算币种',
  '交易订单号', '关联渠道', '关联MID', '关联通道清算币种', '关联通道清算金额', '抵扣资金方向',
  '抵扣手续费合计', '抵扣金额', '抵扣本金', '本金-循环保证金', '交易手续费', '退款手续费',
  '拒付手续费', '提现手续费', '一次性费用', '其他手续费', '常规入账资金', '客资账户余额'
]);
const BILL_DATE_INDEX = 0;
const WL = new Set([0, 6, 28, 29]);
function headersMatch(values) {
  return values.length === FLOW_HEADERS.length
    && values.every((value, index) => String(value == null ? '' : value).trim() === FLOW_HEADERS[index]);
}
function extractMonthKey(raw) {
  const match = String(raw == null ? '' : raw).trim().match(/^(\d{4})[-/](\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}` : null;
}

const fx = require('./_fixtures');
const { row, writeFixtureExcelJS, writeRawSheetXlsx, buildSst, rowToInlineStrCells, colLetter } = fx;

test.after(() => fx.cleanupTmpDirs());

// 原收单 importFlowFile 的 onRow「成功 import 行」捕获逻辑（B/C/D 共用；只捕成功 import 行，
//   月份不可解析/跨月行跳过）。
function makeOnRow(captured, state) {
  return ({ rowR, values, hasAnyCellText }) => {
    if (rowR === 1) {
      if (!headersMatch(values)) { const e = new Error('hdr'); e.__stopParsing = true; throw e; }
      state.headerValidated = true;
      return;
    }
    if (!state.headerValidated) return;
    if (!hasAnyCellText) return;
    const monthKey = extractMonthKey(values[BILL_DATE_INDEX]);
    if (!monthKey) return;
    if (!state.detectedMonthKey) state.detectedMonthKey = monthKey;
    else if (monthKey !== state.detectedMonthKey) return;
    captured.push({ rowIndex: rowR, monthKey, values: values.slice(), hasAnyCellText });
  };
}

// B / C：手写解析器（全列 / 白名单）
async function runHand(fp, whitelist) {
  const sourceFile = require('node:path').basename(fp);
  const { zip, entries } = await openZipWithEntries(sourceFile, fp);
  const captured = [];
  const state = { headerValidated: false, detectedMonthKey: null };
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    let sharedStrings = [];
    try { sharedStrings = await loadSharedStrings(zip, entries.get(SHARED_STRINGS_ENTRY_NAME)); } catch (_e) { sharedStrings = []; }
    await streamSheetRowsHandRolled({
      zip, sheetEntry, expectedHeaders: FLOW_HEADERS, sharedStrings, valueColumnWhitelist: whitelist,
      onRow: makeOnRow(captured, state)
    });
  } finally {
    try { zip.close(); } catch (_e) {}
  }
  return captured;
}

// D：引擎字节层。chunkSize=null → 用 zip 真实 readStream（自然 chunk）；数字 → 读成 buffer 后切小 chunk 重喂。
async function runEngine(fp, whitelist, chunkSize) {
  const wb = await zipReader.openWorkbook(fp);
  const captured = [];
  const state = { headerValidated: false, detectedMonthKey: null };
  try {
    const sharedStrings = await zipReader.loadSharedStrings(wb.zip, wb.sharedStringsEntry);
    const onRow = makeOnRow(captured, state);

    if (chunkSize == null) {
      // 真实 readStream（自然 chunk）
      await new Promise((resolve, reject) => {
        wb.zip.openReadStream(wb.sheetEntry, (err, stream) => {
          if (err) return reject(err);
          rowScanner.scanSheetRows({
            stream, expectedHeaders: FLOW_HEADERS, sharedStrings, valueColumnWhitelist: whitelist, onRow
          }).then(resolve, reject);
        });
      });
    } else {
      // 先读成完整 buffer，再切成可配置小 chunk 序列重喂（强制半行拼接 / 标签跨界）。
      const sheetBuf = await new Promise((resolve, reject) => {
        wb.zip.openReadStream(wb.sheetEntry, (err, stream) => {
          if (err) return reject(err);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      });
      const chunks = [];
      for (let i = 0; i < sheetBuf.length; i += chunkSize) {
        chunks.push(sheetBuf.subarray(i, Math.min(i + chunkSize, sheetBuf.length)));
      }
      const stream = Readable.from(chunks, { objectMode: true });
      await rowScanner.scanSheetRows({
        stream, expectedHeaders: FLOW_HEADERS, sharedStrings, valueColumnWhitelist: whitelist, onRow
      });
    }
  } finally {
    wb.close();
  }
  return captured;
}

// 逐行逐列断言两组捕获相等（compareCols 指定比对列；whitelistEmptyCheck=true 时额外锁白名单外列在该组恒空）。
function assertRowsEqual(label, got, base, compareCols, whitelistEmptyCheckOnGot) {
  assert.equal(got.length, base.length, `${label}: import 行数一致（base=${base.length} got=${got.length}）`);
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    const b = got[i];
    assert.equal(b.rowIndex, a.rowIndex, `${label}: 行 ${i} rowIndex 一致（${a.rowIndex} vs ${b.rowIndex}）`);
    assert.equal(b.monthKey, a.monthKey, `${label}: 行 ${i} monthKey 一致`);
    assert.equal(b.hasAnyCellText, a.hasAnyCellText, `${label}: 行 ${i} hasAnyCellText 一致`);
    for (const c of compareCols) {
      const av = a.values[c] == null ? '' : String(a.values[c]);
      const bv = b.values[c] == null ? '' : String(b.values[c]);
      assert.equal(bv, av, `${label}: 行 ${i}(r=${a.rowIndex}) 列 ${c}(${FLOW_HEADERS[c]}) 值一致（base="${av}" got="${bv}"）`);
    }
    if (whitelistEmptyCheckOnGot) {
      for (let c = 0; c < 48; c++) {
        if (WL.has(c)) continue;
        const bv = b.values[c] == null ? '' : String(b.values[c]);
        assert.equal(bv, '', `${label}: 行 ${i} 白名单外列 ${c}(${FLOW_HEADERS[c]}) 裁剪后恒空（实际="${bv}"）`);
      }
    }
  }
}

const ALL_COLS = Array.from({ length: 48 }, (_, i) => i);
const WL_COLS = [...WL].sort((x, y) => x - y);

// 三方核心断言：B≡C≡D（含引擎 D 全列 + 白名单 + 跨 chunk）。
async function assertThreeWay(label, fp, expectedRows, { chunkSizes = [null, 64 * 1024, 100, 17, 3] } = {}) {
  const baseB = await runHand(fp, null);     // B：手写全列（真理源）
  assert.equal(baseB.length, expectedRows, `${label}: B(手写全列) 应 import ${expectedRows} 行（实际 ${baseB.length}）`);

  // C = 手写白名单（P1b）：白名单内列 ≡ B，白名单外列恒空，hasAnyCellText ≡ B。
  const capC = await runHand(fp, WL);
  assertRowsEqual(`${label} C(P1b白名单)`, capC, baseB, WL_COLS, true);

  // D = 引擎字节层（全列）：与 B 全 48 列全等（含 hasAnyCellText）。多 chunk 尺寸覆盖跨界。
  for (const cs of chunkSizes) {
    const capDfull = await runEngine(fp, null, cs);
    assertRowsEqual(`${label} D(引擎全列,chunk=${cs})`, capDfull, baseB, ALL_COLS, false);
  }
  // D = 引擎字节层（白名单）：白名单内列 ≡ B，白名单外列恒空，hasAnyCellText ≡ B。多 chunk 覆盖。
  for (const cs of chunkSizes) {
    const capDwl = await runEngine(fp, WL, cs);
    assertRowsEqual(`${label} D(引擎白名单,chunk=${cs})`, capDwl, baseB, WL_COLS, true);
  }
}

test.describe('big-table-import row-scanner 三方 harness（🔴🔴 B=手写全列 ≡ C=P1b白名单 ≡ D=引擎字节层）', () => {

  test('#1 flow 正常多行（ExcelJS → sharedStrings 路径）', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 8: '入', 28: '1000.00', 29: 'USD' }),
        row(48, { 0: '2026-03-11', 6: 'RM-2', 8: '出', 28: '2000.50', 29: 'CNY' }),
        row(48, { 0: '2026-03-12', 6: 'RM-3', 8: '入', 28: '-30.00', 29: 'EUR' })
      ]
    });
    await assertThreeWay('#1 正常多行', fp, 3);
  });

  test('#3 含全空数据行（三方都跳过）', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }),
        new Array(48).fill(''),
        row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' })
      ]
    });
    await assertThreeWay('#3 含空行', fp, 2);
  });

  test('#4 稀疏行号（r=2 / r=5 跳号，rowIndex 用真实行号）', async () => {
    const fp = await writeFixtureExcelJS({
      sparse: [
        { rowNum: 1, cells: FLOW_HEADERS.slice() },
        { rowNum: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { rowNum: 5, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    await assertThreeWay('#4 稀疏行号', fp, 2);
  });

  test('#5 中文 + XML 实体（inlineStr 手工 fixture）', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-中文&公司<A>', 8: '入', 24: '张三&李四', 28: '1000.00', 29: 'USD' }) }
      ]
    });
    await assertThreeWay('#5 中文实体', fp, 1);
  });

  test('#6 含 sharedStrings(t="s")（金额共享串保留小数 / 中文 / 重复引用）', async () => {
    const strings = FLOW_HEADERS.slice();
    strings.push('RM-共享');   // 48
    strings.push('1000.00');  // 49
    strings.push('USD');      // 50
    strings.push('入');        // 51
    const sst = buildSst(strings);
    let headerCells = '';
    for (let i = 0; i < 48; i++) headerCells += `<c r="${colLetter(i)}1" t="s"><v>${i}</v></c>`;
    const dataCells =
      `<c r="A2" t="inlineStr"><is><t>2026-03-10</t></is></c>` +
      `<c r="G2" t="s"><v>48</v></c>` +
      `<c r="I2" t="s"><v>51</v></c>` +
      `<c r="AC2" t="s"><v>49</v></c>` +
      `<c r="AD2" t="s"><v>50</v></c>`;
    const fp = await writeRawSheetXlsx({ sheetRows: [{ r: 1, raw: headerCells }, { r: 2, raw: dataCells }], sst });
    await assertThreeWay('#6 sharedStrings', fp, 1);
  });

  test('#7 number cell（取值保留原文，非 parseFloat 改写）', async () => {
    const ExcelJS = require('exceljs');
    const path = require('node:path');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(FLOW_HEADERS.slice());
    const r = ws.addRow(new Array(48).fill(''));
    r.getCell(1).value = '2026-03-10';
    r.getCell(7).value = 'RM-NUM';
    r.getCell(29).value = 1000.5;
    r.getCell(30).value = 'CNY';
    r.getCell(47).value = -30.25;
    r.getCell(48).value = 1398765432109876500;
    const fp = path.join(fx.mkTmpDir('btie-num-'), 'num.xlsx');
    await wb.xlsx.writeFile(fp);
    await assertThreeWay('#7 number cell', fp, 1);
  });

  test('#10b 白名单内外列都有值（白名单外列裁剪路径恒空）', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-A', 7: '收入', 24: '李四', 28: '500.00', 29: 'USD', 47: '9999.99' }) },
        { r: 3, cells: row(48, { 0: '2026-03-11', 6: 'RM-B', 28: '600.00', 29: 'CNY' }) }
      ]
    });
    await assertThreeWay('#10b 内外列都有值', fp, 2);
  });

  test('#11 SST 索引指向空串（ExcelJS 空 cell 形态）→ 该行作空行跳过', async () => {
    const strings = [''].concat(FLOW_HEADERS.slice());   // 0='' , 1..48=表头
    const sst = buildSst(strings);
    let headerCells = '';
    for (let i = 0; i < 48; i++) headerCells += `<c r="${colLetter(i)}1" t="s"><v>${i + 1}</v></c>`;
    let emptyDataCells = '';
    for (let i = 0; i < 48; i++) emptyDataCells += `<c r="${colLetter(i)}2" t="s"><v>0</v></c>`;
    const goodCells = rowToInlineStrCells(row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100.00', 29: 'USD' }), 3);
    const fp = await writeRawSheetXlsx({
      sheetRows: [{ r: 1, raw: headerCells }, { r: 2, raw: emptyDataCells }, { r: 3, raw: goodCells }],
      sst
    });
    await assertThreeWay('#11 SST空串', fp, 1);
  });

  test('#12 自闭合空 row（<row r=3/>）→ 三方跳过', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { r: 3, selfClose: true },
        { r: 4, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    await assertThreeWay('#12 自闭合row', fp, 2);
  });

  test('#14 大行号前缀碰撞（r="AC1" 不命中 r="AC12"）+ 同列重复取最后', async () => {
    // r=1 表头；r=12 数据行（AC12/AD12 金额币种）；故意在前面放 r=1..也含 AC1（表头），确保前缀 AC1 不串到 AC12。
    //   再放一行 r=2 含「同列 G2 出现两次」→ 取后者（对齐 sax 同列覆盖）。
    const dup =
      `<c r="A2" t="inlineStr"><is><t>2026-05-01</t></is></c>` +
      `<c r="G2" t="inlineStr"><is><t>RM-前</t></is></c>` +
      `<c r="G2" t="inlineStr"><is><t>RM-后</t></is></c>` +     // 同列重复 → 取后
      `<c r="AC2" t="inlineStr"><is><t>11.00</t></is></c>` +
      `<c r="AD2" t="inlineStr"><is><t>USD</t></is></c>`;
    const sheetRows = [{ r: 1, cells: FLOW_HEADERS.slice() }, { r: 2, raw: dup }];
    // 追加 r=12（行号 12，与潜在前缀 1 碰撞测试）
    sheetRows.push({ r: 12, cells: row(48, { 0: '2026-05-02', 6: 'RM-12', 28: '12.00', 29: 'CNY' }) });
    const fp = await writeRawSheetXlsx({ sheetRows });
    await assertThreeWay('#14 前缀碰撞+同列重复', fp, 2);
    // 显式锁同列重复取后者
    const capDwl = await runEngine(fp, WL, 17);
    assert.equal(capDwl[0].values[6], 'RM-后', '#14: 同列 G2 重复 → 引擎取后者（对齐 sax）');
  });
});
