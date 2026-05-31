'use strict';
// v2.1.12-beta β.2-T1 contract test（🔴 数据完整性红线）
// 锁：bizOpRecon 流式 reader（reader-streamed.js）与现有 SheetJS reader（reader.js）byte-level 同输出。
//   背景：导入百万行 xlsx，SheetJS XLSX.readFile 撞 V8 512MB 上限静默返回空 → 改流式（仿 pending/VCC）。
//   本测试在同一 fixture 上跑两个 reader，断言 rows 数组逐行逐列 + _rowIndex + totalRows + sourceSheetName 全等；
//   错误用例断言两者抛同 errorCode 的 FileValidationError。
//
// 已知差异（reader-streamed.js 头部文档化）：SheetJS raw:false 对 number 类型 cell 套 Excel General 格式
//   （大数走科学计数法 + 精度丢失）；流式取原值字符串。真实 bizOp/flow 数据以文本存储 → 一致。
//   本测试「正常」用例全用字符串值（对齐真实数据），并单列一例显式覆盖 number cell 的已知差异。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const sheetjs = require('../../../../src/backend/biz-op-recon-import/reader');
const streamed = require('../../../../src/backend/biz-op-recon-import/reader-streamed');
const { BIZ_OP_HEADERS, BIZ_OP_DB_COLUMNS, FLOW_HEADERS, FLOW_DB_COLUMNS } = require('../../../../src/backend/biz-op-recon-db/columns');

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

// 写 fixture xlsx（可选多 sheet / 显式行号稀疏 / number 类型 cell）
async function writeFixture(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    if (s.sparse) {
      // sparse：用 getRow(n) 显式行号制造 <row r> 跳号（ExcelJS .values setter 0-based：直接映射 A,B,C...）
      for (const { rowNum, cells } of s.sparse) {
        ws.getRow(rowNum).values = cells;
      }
    } else {
      for (const row of s.rows) ws.addRow(row);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-stream-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, 'fixture.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

function dataRow(len, values) {
  const r = new Array(len).fill('');
  for (const k of Object.keys(values)) r[Number(k)] = values[k];
  return r;
}

// 🔴 核心断言：两 reader 输出逐项一致
function assertEquivalent(label, a, b, dbColumns) {
  assert.equal(a.totalRows, b.totalRows, `${label}: totalRows 一致（sheetjs=${a.totalRows} streamed=${b.totalRows}）`);
  assert.equal(a.sourceSheetName, b.sourceSheetName, `${label}: sourceSheetName 一致`);
  assert.equal(a.rows.length, b.rows.length, `${label}: rows 行数一致`);
  for (let i = 0; i < a.rows.length; i++) {
    const ra = a.rows[i];
    const rb = b.rows[i];
    assert.equal(ra._rowIndex, rb._rowIndex, `${label}: 行 ${i} _rowIndex 一致（${ra._rowIndex} vs ${rb._rowIndex}）`);
    for (const col of dbColumns) {
      assert.equal(ra[col], rb[col], `${label}: 行 ${i} 列 ${col} 值一致（"${ra[col]}" vs "${rb[col]}"）`);
    }
  }
}

async function assertBothThrowSameCode(label, fp, sheetjsFn, streamedFn) {
  let ea = null;
  let eb = null;
  try { sheetjsFn(fp); } catch (e) { ea = e; }
  // streamed 是 async
  try { await streamedFn(fp); } catch (e) { eb = e; }
  assert.ok(ea, `${label}: SheetJS reader 应抛错`);
  assert.ok(eb, `${label}: 流式 reader 应抛错`);
  assert.equal(ea.name, 'FileValidationError', `${label}: SheetJS 抛 FileValidationError`);
  assert.equal(eb.name, 'FileValidationError', `${label}: 流式抛 FileValidationError`);
  assert.equal(ea.code, eb.code, `${label}: errorCode 一致（${ea.code} vs ${eb.code}）`);
}

test.describe('β.2-T1 bizOpRecon 流式 reader contract（🔴 与 SheetJS reader byte-level 等价）', () => {
  test('bizOp 正常（文本数据多行）→ 两 reader 逐行一致', async () => {
    const fp = await writeFixture([{
      name: 'OP',
      rows: [
        BIZ_OP_HEADERS.slice(),
        dataRow(23, { 0: '2026-04-15', 1: 'BU-甲', 4: 'ACC-001', 7: '1000.00', 8: '50.00', 11: '1050.00' }),
        dataRow(23, { 0: '2026-04-15', 1: 'BU-乙', 4: 'ACC-002', 7: '2000.00', 8: '-30.50', 11: '1969.50' }),
        dataRow(23, { 0: '2026-04-15', 1: 'BU-甲', 4: 'ACC-003', 7: '0', 8: '0', 11: '0' })
      ]
    }]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    assert.equal(a.rows.length, 3, '基线应读到 3 数据行');
    assertEquivalent('bizOp正常', a, b, BIZ_OP_DB_COLUMNS);
  });

  test('bizOp 含空行（isRowMeaningful 跳过 + _rowIndex 对齐）→ 一致', async () => {
    const fp = await writeFixture([{
      name: 'OP',
      rows: [
        BIZ_OP_HEADERS.slice(),
        dataRow(23, { 0: '2026-04-15', 1: 'BU-甲', 4: 'ACC-001', 11: '100' }),
        new Array(23).fill(''),  // 全空数据行 → isRowMeaningful=false 跳过
        dataRow(23, { 0: '2026-04-15', 1: 'BU-乙', 4: 'ACC-002', 11: '200' })
      ]
    }]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    // 两 reader 都应跳过空行，且对齐 _rowIndex（核心：两者互相一致）
    assertEquivalent('bizOp含空行', a, b, BIZ_OP_DB_COLUMNS);
  });

  test('bizOp 稀疏行号（显式 r=2 / r=5，跳过 r3-4）→ _rowIndex 用真实行号、两 reader 一致', async () => {
    const fp = await writeFixture([{
      name: 'OP',
      sparse: [
        { rowNum: 1, cells: BIZ_OP_HEADERS.slice() },
        { rowNum: 2, cells: dataRow(23, { 0: '2026-04-15', 1: 'BU-甲', 4: 'ACC-001', 11: '100' }) },
        { rowNum: 5, cells: dataRow(23, { 0: '2026-04-15', 1: 'BU-乙', 4: 'ACC-002', 11: '200' }) }
      ]
    }]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    assertEquivalent('bizOp稀疏行号', a, b, BIZ_OP_DB_COLUMNS);
  });

  test('flow 正常（28 列文本）→ 两 reader 逐行一致', async () => {
    const fp = await writeFixture([{
      name: 'Flow',
      rows: [
        FLOW_HEADERS.slice(),
        dataRow(28, { 0: 'BIZ-1', 1: '2026-04-15', 7: 'RM-1', 8: '入', 13: '100.00', 14: 'CNY' }),
        dataRow(28, { 0: 'BIZ-2', 1: '2026-04-15', 7: 'RM-2', 8: '出', 13: '50.50', 14: 'USD' })
      ]
    }]);
    const a = sheetjs.readFlowFile(fp);
    const b = await streamed.readFlowFileStreamed(fp);
    assert.equal(a.rows.length, 2, '基线应读到 2 数据行');
    assertEquivalent('flow正常', a, b, FLOW_DB_COLUMNS);
  });

  test('中文 + 共享字符串 → 一致', async () => {
    const fp = await writeFixture([{
      name: '业务OP数据',
      rows: [
        BIZ_OP_HEADERS.slice(),
        dataRow(23, { 0: '2026-04-15', 1: '渠道事业部', 4: '账户-壹', 15: '微信支付', 18: '扩展：备注信息含逗号,与引号"' })
      ]
    }]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    assertEquivalent('中文共享串', a, b, BIZ_OP_DB_COLUMNS);
    assert.equal(b.sourceSheetName, '业务OP数据', 'sourceSheetName 取第一个 sheet 名');
  });

  test('多 sheet → 都读第一个 sheet → 一致', async () => {
    const fp = await writeFixture([
      {
        name: 'First',
        rows: [
          BIZ_OP_HEADERS.slice(),
          dataRow(23, { 0: '2026-04-15', 1: 'BU-甲', 4: 'ACC-1', 11: '100' })
        ]
      },
      {
        name: 'Second',
        rows: [['无关表头'], ['x']]
      }
    ]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    assertEquivalent('多sheet取第一个', a, b, BIZ_OP_DB_COLUMNS);
  });

  test('表头不匹配 → 两 reader 抛同 errorCode', async () => {
    const fp = await writeFixture([{
      name: 'OP',
      rows: [
        ['错的表头A', '错的表头B', '错的表头C'],
        ['x', 'y', 'z']
      ]
    }]);
    await assertBothThrowSameCode('表头不匹配', fp, sheetjs.readBizOpFile, streamed.readBizOpFileStreamed);
  });

  test('空 sheet（无任何行）→ 两 reader 抛同 errorCode', async () => {
    const fp = await writeFixture([{ name: 'OP', rows: [] }]);
    await assertBothThrowSameCode('空sheet', fp, sheetjs.readBizOpFile, streamed.readBizOpFileStreamed);
  });

  test('仅表头无数据行 → 两 reader 都返回 0 数据行（非错误）', async () => {
    const fp = await writeFixture([{ name: 'OP', rows: [BIZ_OP_HEADERS.slice()] }]);
    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    assert.equal(a.rows.length, 0, 'SheetJS 0 数据行');
    assertEquivalent('仅表头', a, b, BIZ_OP_DB_COLUMNS);
  });

  test('表头列数超出模板（尾部多列）→ 两 reader 抛同 errorCode', async () => {
    const fp = await writeFixture([{
      name: 'OP',
      rows: [
        [...BIZ_OP_HEADERS.slice(), '多余列A', '多余列B'],
        dataRow(25, { 0: '2026-04-15', 1: 'BU-甲' })
      ]
    }]);
    await assertBothThrowSameCode('表头超列', fp, sheetjs.readBizOpFile, streamed.readBizOpFileStreamed);
  });

  test('【已知差异·文档化】number 类型 cell 大数：SheetJS 科学计数法 vs 流式原值', async () => {
    // reader-streamed.js 头部文档化：SheetJS raw:false 对 number cell 套 General 格式 → 大数科学计数法+精度丢失；
    //   流式取原值。真实数据文本存储不触发；此处显式写 number 类型 cell 锁住「已知差异」，若行为变化测试会失败提醒。
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('OP');
    ws.addRow(BIZ_OP_HEADERS.slice());
    const row = ws.addRow(new Array(23).fill(''));
    row.getCell(1).value = '2026-04-15';        // 文本日期
    row.getCell(21).value = 1398765432109876500; // BizId 写成 number 类型大数（A21=BizId）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-numdiff-'));
    tmpDirs.push(dir);
    const fp = path.join(dir, 'numdiff.xlsx');
    await wb.xlsx.writeFile(fp);

    const a = sheetjs.readBizOpFile(fp);
    const b = await streamed.readBizOpFileStreamed(fp);
    // 文本列一致
    assert.equal(a.rows[0].bill_date_raw, b.rows[0].bill_date_raw, '文本列 bill_date_raw 仍一致');
    // biz_id（number 大数）：记录两者取值，验证「差异是已知的那种」（SheetJS 含 E / 流式不含 E，或两者就是不同）
    const aBiz = a.rows[0].biz_id;
    const bBiz = b.rows[0].biz_id;
    // 不强求相等（已知差异）；但 number 大数场景下二者应不同 —— 锁住「文档化的差异确实存在」
    // 若哪天 SheetJS/流式行为变得一致，此断言失败提醒复核文档
    assert.notEqual(aBiz, bBiz, `已知差异：number 大数 SheetJS="${aBiz}" vs 流式="${bBiz}" 应不同（文本存储则一致）`);
  });
});
