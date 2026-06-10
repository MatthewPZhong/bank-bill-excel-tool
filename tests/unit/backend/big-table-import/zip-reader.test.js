'use strict';
// 大表导入引擎 zip-reader 单测（v3.0.3 PR-G1）
//   - 多 sheet 显式报错（防御项，杜绝硬编码 sheet1 静默丢数据）
//   - 单 sheet 经 rels 正解定位（不硬编码 sheet1.xml）

const { test } = require('node:test');
const assert = require('node:assert');

const zipReader = require('../../../../src/backend/big-table-import/zip-reader');
const fx = require('./_fixtures');
const { writeMultiSheetXlsx, writeRawSheetXlsx, colLetter } = fx;

test.after(() => fx.cleanupTmpDirs());

test.describe('big-table-import zip-reader', () => {

  test('多 sheet → openWorkbook 显式报错，message 含全部 sheet 名 + 单 sheet 口径', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [
        { name: '数据A', body: `<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>` },
        { name: '数据B', body: '' }
      ]
    });
    let err = null;
    try {
      await zipReader.openWorkbook(fp);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '多 sheet 应抛错');
    assert.equal(err.name, 'BigTableImportError', '错误类型为 BigTableImportError');
    assert.match(err.message, /2 个 sheet/, 'message 含 sheet 数量');
    assert.match(err.message, /仅支持单 sheet/, 'message 含「仅支持单 sheet」口径');
    const joined = err.message + (err.detailLines || []).join('');
    assert.ok(joined.includes('数据A') && joined.includes('数据B'), '错误信息列出全部 sheet 名');
  });

  test('三 sheet → 报错列出 3 个 sheet 名', async () => {
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: 'S1' }, { name: 'S2' }, { name: 'S3' }]
    });
    let err = null;
    try { await zipReader.openWorkbook(fp); } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '三 sheet 应抛 BigTableImportError');
    assert.match(err.message, /3 个 sheet/, 'message 含 sheet 数量 3');
    const joined = err.message + (err.detailLines || []).join('');
    assert.ok(['S1', 'S2', 'S3'].every((n) => joined.includes(n)), '列出全部 3 个 sheet 名');
  });

  test('单 sheet → openWorkbook 正常定位 sheetEntry（rels 正解，非硬编码）', async () => {
    // writeMultiSheetXlsx 单 sheet：Target=worksheets/sheet1.xml，rels 正解应能定位。
    const fp = await writeMultiSheetXlsx({
      sheets: [{ name: '唯一表', body: `<row r="1"><c r="A1" t="inlineStr"><is><t>头</t></is></c></row>` }]
    });
    const wb = await zipReader.openWorkbook(fp);
    try {
      assert.ok(wb.sheetEntry, '应定位到 sheetEntry');
      assert.equal(wb.sheetName, '唯一表', 'sheetName 来自 workbook.xml 的 <sheet name>');
    } finally {
      wb.close();
    }
  });

  test('单 sheet（无 workbook.xml，仅 sheet1.xml）→ 兜底定位 sheet1.xml', async () => {
    // writeRawSheetXlsx 只产 xl/worksheets/sheet1.xml（无 workbook.xml）→ 走兜底分支。
    const fp = await writeRawSheetXlsx({
      sheetRows: [{ r: 1, raw: `<c r="A1" t="inlineStr"><is><t>头</t></is></c>` }]
    });
    const wb = await zipReader.openWorkbook(fp);
    try {
      assert.ok(wb.sheetEntry, '无 workbook.xml 时兜底定位 sheet1.xml');
    } finally {
      wb.close();
    }
  });

  test('loadSharedStrings：无 SST entry → 空数组；有 SST → 解析出串表', async () => {
    const { buildSst } = fx;
    const sst = buildSst(['甲', '乙', '丙']);
    let headerCells = '';
    for (let i = 0; i < 3; i++) headerCells += `<c r="${colLetter(i)}1" t="s"><v>${i}</v></c>`;
    const fp = await writeRawSheetXlsx({ sheetRows: [{ r: 1, raw: headerCells }], sst });
    const wb = await zipReader.openWorkbook(fp);
    try {
      const ss = await zipReader.loadSharedStrings(wb.zip, wb.sharedStringsEntry);
      assert.deepEqual(ss, ['甲', '乙', '丙'], 'SST 解析出 3 个串');
    } finally {
      wb.close();
    }

    // 无 SST entry
    const fp2 = await writeRawSheetXlsx({ sheetRows: [{ r: 1, cells: ['头'] }] });
    const wb2 = await zipReader.openWorkbook(fp2);
    try {
      assert.equal(wb2.sharedStringsEntry, null, '无 sharedStrings.xml → entry 为 null');
      const ss2 = await zipReader.loadSharedStrings(wb2.zip, wb2.sharedStringsEntry);
      assert.deepEqual(ss2, [], '无 SST → 空数组');
    } finally {
      wb2.close();
    }
  });
});
