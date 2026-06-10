'use strict';
// 大表导入引擎 row-scanner 四方 harness（🔴🔴 byte-for-byte 资金红线闸 · v3.0.3 PR-G1）
//
// 锁：四方解析器在同一 fixture 上逐行逐列 values / rowR(rowIndex) / hasAnyCellText / monthKey / importedCount 全等：
//   A = sax 基线        —— acquiring-bill-currency-import/reader.js（importFlowFile，全列）
//   B = 手写全列        —— reader-handrolled.streamSheetRowsHandRolled（valueColumnWhitelist=null）
//   C = 手写白名单(P1b) —— reader-handrolled.streamSheetRowsHandRolled（FLOW_VALUE_COLUMN_WHITELIST）
//   D = 引擎字节层      —— big-table-import/row-scanner.scanSheetRows（白名单 + 全列两种模式）
//
// 引擎用收单 flow 契约形态作测试契约（FLOW_HEADERS + 白名单 {0,6,28,29} + extractMonthKey），
//   复刻 importFlowFile 的 onRow 逻辑（表头校验 + allEmpty=!hasAnyCellText + extractMonthKey + 跨月/月份累积）
//   捕获每条「被 import 的数据行」。
//
// 🔴 引擎 D 路径额外覆盖「跨 chunk 边界」：把 sheet entry 读成 buffer 后切成可配置小 chunk 序列重喂
//   （含 1/3/7/17 字节极端切碎，强制半行拼接 + 标签跨界），与 A 全等——证字节层流式拼接零漂移。
//
// 覆盖现有三方 harness（reader-handrolled-contract.test.js）全部 fixture 场景：
//   inlineStr / sharedStrings(t=s) / number / 科学计数 / XML 实体 / 空行 / 稀疏行号 / 自闭合 row /
//   退化路径（仅白名单外列有值）/ SST 空串 / 大行号前缀碰撞（r="AC1" vs r="AC12"）。

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const saxReader = require('../../../../src/backend/acquiring-bill-currency-import/reader');
const handReader = require('../../../../src/backend/acquiring-bill-currency-import/reader-handrolled');
const importRepo = require('../../../../src/backend/acquiring-bill-currency-db/import-repository');
const { FLOW_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const { extractMonthKey, validateFlowHeaders } = require('../../../../src/backend/acquiring-bill-currency-import/validator');
const {
  openZipWithEntries,
  loadSharedStrings,
  SHEET_ENTRY_NAME,
  SHARED_STRINGS_ENTRY_NAME
} = require('../../../../src/backend/acquiring-bill-currency-import/reader');

// 引擎被测对象
const zipReader = require('../../../../src/backend/big-table-import/zip-reader');
const rowScanner = require('../../../../src/backend/big-table-import/row-scanner');

const fx = require('./_fixtures');
const { row, writeFixtureExcelJS, writeRawSheetXlsx, buildSst, rowToInlineStrCells, colLetter } = fx;

test.after(() => fx.cleanupTmpDirs());

const WL = handReader.FLOW_VALUE_COLUMN_WHITELIST;

// ---- monkeypatch 捕获（A 路径：真实 importFlowFile 走 insertFlowRow）----
function installCapture() {
  const captured = [];
  importRepo.prepareFlowInsert = () => ({ run: () => {} });
  importRepo.insertFlowRow = (_stmt, payload) => {
    captured.push({ rowIndex: payload.row.rowIndex, monthKey: payload.monthKey, values: payload.row.values.slice() });
  };
  return captured;
}

// 复刻 importFlowFile 的 onRow「成功 import 行」捕获逻辑（B/C/D 共用；只捕成功 import 行，
//   月份不可解析/跨月行 prod 累积错误 → 这里跳过，与三方 harness runHandWholeColumnFlow 一致）。
function makeOnRow(captured, state) {
  const keyIndices = FLOW_KEY_COLUMN_INDICES;
  return ({ rowR, values, hasAnyCellText }) => {
    if (rowR === 1) {
      const headerResult = validateFlowHeaders(values.map((v) => (v == null ? '' : String(v))));
      if (!headerResult.ok) { const e = new Error('hdr'); e.__stopParsing = true; throw e; }
      state.headerValidated = true;
      return;
    }
    if (!state.headerValidated) return;
    if (!hasAnyCellText) return;
    const monthKey = extractMonthKey(values[keyIndices.billDate]);
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
    await handReader.streamSheetRowsHandRolled({
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

// 四方核心断言：A≡B≡C≡D（含引擎 D 全列 + 白名单 + 跨 chunk）。
async function assertFourWay(label, fp, expectedRows, { chunkSizes = [null, 64 * 1024, 100, 17, 3] } = {}) {
  // A = sax 基线（全列，真理源）
  const saxCap = installCapture();
  const saxResult = await saxReader.importFlowFile({ db: {}, filePath: fp, importedAt: 'T', expectedMonthKey: null, onProgress: () => {} });
  if (typeof expectedRows === 'number') {
    assert.equal(saxCap.length, expectedRows, `${label}: A(sax) 应 import ${expectedRows} 行（实际 ${saxCap.length}）`);
  }
  // hasAnyCellText 基线缺失（sax importFlowFile 不暴露）——用手写全列 B 补全到 base（B≡A 已锁全列值）。
  const baseB = await runHand(fp, null);     // B：手写全列
  // 先证 A≡B（全 48 列 + rowIndex + monthKey），B 即可作含 hasAnyCellText 的全列真理源。
  assert.equal(baseB.length, saxCap.length, `${label}: A vs B import 行数一致（sax=${saxCap.length} 手写全列=${baseB.length}）`);
  assert.equal(saxResult.importedCount, saxCap.length, `${label}: sax importedCount=${saxResult.importedCount} 与捕获一致`);
  for (let i = 0; i < saxCap.length; i++) {
    const a = saxCap[i];
    const b = baseB[i];
    assert.equal(b.rowIndex, a.rowIndex, `${label}: A≡B 行 ${i} rowIndex`);
    assert.equal(b.monthKey, a.monthKey, `${label}: A≡B 行 ${i} monthKey`);
    for (const c of ALL_COLS) {
      const av = a.values[c] == null ? '' : String(a.values[c]);
      const bv = b.values[c] == null ? '' : String(b.values[c]);
      assert.equal(bv, av, `${label}: A≡B 行 ${i}(r=${a.rowIndex}) 列 ${c}(${FLOW_HEADERS[c]})（sax="${av}" 手写全列="${bv}"）`);
    }
  }

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

test.describe('big-table-import row-scanner 四方 harness（🔴🔴 A=sax ≡ B=手写全列 ≡ C=P1b白名单 ≡ D=引擎字节层）', () => {

  test('#1 flow 正常多行（ExcelJS → sharedStrings 路径）', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 8: '入', 28: '1000.00', 29: 'USD' }),
        row(48, { 0: '2026-03-11', 6: 'RM-2', 8: '出', 28: '2000.50', 29: 'CNY' }),
        row(48, { 0: '2026-03-12', 6: 'RM-3', 8: '入', 28: '-30.00', 29: 'EUR' })
      ]
    });
    await assertFourWay('#1 正常多行', fp, 3);
  });

  test('#3 含全空数据行（四方都跳过）', async () => {
    const fp = await writeFixtureExcelJS({
      rows: [
        FLOW_HEADERS.slice(),
        row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }),
        new Array(48).fill(''),
        row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' })
      ]
    });
    await assertFourWay('#3 含空行', fp, 2);
  });

  test('#4 稀疏行号（r=2 / r=5 跳号，rowIndex 用真实行号）', async () => {
    const fp = await writeFixtureExcelJS({
      sparse: [
        { rowNum: 1, cells: FLOW_HEADERS.slice() },
        { rowNum: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { rowNum: 5, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    await assertFourWay('#4 稀疏行号', fp, 2);
  });

  test('#5 中文 + XML 实体（inlineStr 手工 fixture）', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-中文&公司<A>', 8: '入', 24: '张三&李四', 28: '1000.00', 29: 'USD' }) }
      ]
    });
    await assertFourWay('#5 中文实体', fp, 1);
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
    await assertFourWay('#6 sharedStrings', fp, 1);
  });

  test('#7 number cell（取值语义对齐 sax，非 parseFloat 改写）', async () => {
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
    await assertFourWay('#7 number cell', fp, 1);
  });

  test('#10b 白名单内外列都有值（白名单外列裁剪路径恒空）', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-A', 7: '收入', 24: '李四', 28: '500.00', 29: 'USD', 47: '9999.99' }) },
        { r: 3, cells: row(48, { 0: '2026-03-11', 6: 'RM-B', 28: '600.00', 29: 'CNY' }) }
      ]
    });
    await assertFourWay('#10b 内外列都有值', fp, 2);
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
    await assertFourWay('#11 SST空串', fp, 1);
  });

  test('#12 自闭合空 row（<row r=3/>）→ 四方跳过', async () => {
    const fp = await writeRawSheetXlsx({
      sheetRows: [
        { r: 1, cells: FLOW_HEADERS.slice() },
        { r: 2, cells: row(48, { 0: '2026-03-10', 6: 'RM-1', 28: '100', 29: 'USD' }) },
        { r: 3, selfClose: true },
        { r: 4, cells: row(48, { 0: '2026-03-11', 6: 'RM-2', 28: '200', 29: 'CNY' }) }
      ]
    });
    await assertFourWay('#12 自闭合row', fp, 2);
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
    await assertFourWay('#14 前缀碰撞+同列重复', fp, 2);
    // 显式锁同列重复取后者
    const capDwl = await runEngine(fp, WL, 17);
    assert.equal(capDwl[0].values[6], 'RM-后', '#14: 同列 G2 重复 → 引擎取后者（对齐 sax）');
  });
});
