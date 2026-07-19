'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { ToolboxHeaderMismatchError } = require('../../../src/main-process/toolbox');
const {
  assertMergeHeadersIdentical,
  detectMergeInputKind,
  mergeToolboxFilesToXlsx,
  normalizeHeaderRow,
  publishMergedWorkbook,
  ToolboxMergePublishError
} = require('../../../src/main-process/toolbox-merge-io');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-merge-io-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeXlsx(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, { state: spec.state || 'visible' });
    for (const row of spec.rows || []) sheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

function writeXls(filePath, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const spec of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(spec.rows || []), spec.name);
  }
  workbook.Workbook = {
    Sheets: sheets.map((spec) => ({
      name: spec.name,
      Hidden: spec.state === 'veryHidden' ? 2 : spec.state === 'hidden' ? 1 : 0
    }))
  };
  XLSX.writeFile(workbook, filePath, { bookType: 'biff8' });
  return filePath;
}

function readWorkbookAoa(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  return {
    names: workbook.SheetNames.slice(),
    sheets: workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: ''
    }))
  };
}

test.describe('toolbox merge io', () => {
  test('表头去首尾空格和末尾空列；列序、大小写和列数仍严格区分', () => {
    assert.deepEqual(normalizeHeaderRow([' H1 ', ' H2 ', ' ', '']), ['H1', 'H2']);
    const base = { sourceFile: 'base.xlsx', sheetName: 'S1', headers: ['H1', 'H2'] };
    for (const headers of [
      ['H2', 'H1'],
      ['h1', 'H2'],
      ['H1'],
      ['H1', 'H2', 'H3']
    ]) {
      assert.throws(
        () => assertMergeHeadersIdentical(base, {
          sourceFile: 'current.xlsx',
          sheetName: 'S2',
          headers
        }),
        ToolboxHeaderMismatchError
      );
    }
  });

  test('单个 XLSX 的多个 sheet 合并为一个 COMMON，保留 tab 与行顺序', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'single.xlsx'), [
      { name: '一月', rows: [['编号', '金额'], ['A', '1'], ['B', '2']] },
      { name: '二月', rows: [['编号', '金额'], ['C', '3']] }
    ]);
    const output = path.join(dir, 'merged.xlsx');

    const result = await mergeToolboxFilesToXlsx({ filePaths: [input], savePath: output });
    const readback = readWorkbookAoa(output);
    assert.equal(result.fileCount, 1);
    assert.equal(result.inputSheetCount, 2);
    assert.equal(result.dataRowCount, 3);
    assert.deepEqual(readback.names, ['COMMON']);
    assert.deepEqual(readback.sheets[0], [
      ['编号', '金额'],
      ['A', '1'],
      ['B', '2'],
      ['C', '3']
    ]);
  });

  test('XLSX + XLS + CSV 混合输入，隐藏 sheet 跳过并按文件选择顺序合并', async () => {
    const dir = makeTempDir();
    const xlsx = await writeXlsx(path.join(dir, 'a.xlsx'), [
      { name: '可见A', rows: [['H1', 'H2'], ['xlsx-a', '1']] },
      { name: '隐藏A', state: 'hidden', rows: [['H1', 'H2'], ['hidden-xlsx', 'x']] },
      { name: '空白A', rows: [] }
    ]);
    const xls = writeXls(path.join(dir, 'b.xls'), [
      { name: '可见B', rows: [['H1', 'H2'], ['xls-b', '2']] },
      { name: '深藏B', state: 'veryHidden', rows: [['H1', 'H2'], ['hidden-xls', 'x']] }
    ]);
    const csv = path.join(dir, 'c.csv');
    fs.writeFileSync(csv, 'H1,H2\ncsv-c,3\n', 'utf8');
    const output = path.join(dir, 'mixed.xlsx');

    const result = await mergeToolboxFilesToXlsx({ filePaths: [xlsx, xls, csv], savePath: output });
    const rows = readWorkbookAoa(output).sheets[0];
    assert.equal(result.fileCount, 3);
    assert.equal(result.inputSheetCount, 3);
    assert.equal(result.skippedHiddenSheetCount, 2);
    assert.equal(result.skippedEmptySheetCount, 1);
    assert.deepEqual(rows, [
      ['H1', 'H2'],
      ['xlsx-a', '1'],
      ['xls-b', '2'],
      ['csv-c', '3']
    ]);
  });

  test('任一 sheet 表头不一致时携带文件/sheet血缘并删除临时输出', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'mismatch.xlsx'), [
      { name: '基准', rows: [['编号', '金额'], ['A', '1']] },
      { name: '异常页', rows: [['编号', '币种'], ['B', 'CNY']] }
    ]);
    const output = path.join(dir, 'must-not-exist.xlsx');

    await assert.rejects(
      () => mergeToolboxFilesToXlsx({ filePaths: [input], savePath: output }),
      (error) => {
        assert.ok(error instanceof ToolboxHeaderMismatchError);
        assert.match(error.message, /异常页/);
        assert.ok(error.detailLines.some((line) => line.includes('基准')));
        assert.ok(error.detailLines.some((line) => line.includes('异常页')));
        return true;
      }
    );
    assert.equal(fs.existsSync(output), false);
  });

  test('选中文件没有可见非空 sheet 时失败且不产文件', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'none.xlsx'), [
      { name: '隐藏', state: 'hidden', rows: [['H'], ['secret']] },
      { name: '空白', rows: [] }
    ]);
    const output = path.join(dir, 'none-output.xlsx');

    await assert.rejects(
      () => mergeToolboxFilesToXlsx({ filePaths: [input], savePath: output }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_MERGE_NO_VISIBLE_SHEET');
        assert.match(error.message, /none\.xlsx/);
        return true;
      }
    );
    assert.equal(fs.existsSync(output), false);
  });

  test('数据区与表头相同的行不折叠，只有表头的 sheet 贡献 0 行', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'repeat.xlsx'), [
      { name: '只有表头', rows: [['H1', 'H2']] },
      { name: '数据', rows: [['H1', 'H2'], ['H1', 'H2'], ['v', '1'], ['v', '1']] }
    ]);
    const output = path.join(dir, 'repeat-output.xlsx');

    const result = await mergeToolboxFilesToXlsx({ filePaths: [input], savePath: output });
    assert.equal(result.inputSheetCount, 2);
    assert.equal(result.dataRowCount, 3);
    assert.deepEqual(readWorkbookAoa(output).sheets[0], [
      ['H1', 'H2'],
      ['H1', 'H2'],
      ['v', '1'],
      ['v', '1']
    ]);
  });

  test('超过单页阈值自动分页且跨页顺序守恒', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'pages.xlsx'), [
      { name: 'S1', rows: [['H'], ['1'], ['2'], ['3']] },
      { name: 'S2', rows: [['H'], ['4'], ['5']] }
    ]);
    const output = path.join(dir, 'pages-output.xlsx');

    const result = await mergeToolboxFilesToXlsx({
      filePaths: [input],
      savePath: output,
      maxRowsPerSheet: 2
    });
    const readback = readWorkbookAoa(output);
    assert.equal(result.sheetCount, 3);
    assert.deepEqual(readback.names, ['COMMON', 'COMMON(2)', 'COMMON(3)']);
    assert.deepEqual(readback.sheets.map((rows) => rows.slice(1).flat()), [['1', '2'], ['3', '4'], ['5']]);
  });

  test('扩展名为 CSV 但实际为 XLSX 时按工作簿读取全部可见 sheet', async () => {
    const dir = makeTempDir();
    const actual = await writeXlsx(path.join(dir, 'actual.xlsx'), [
      { name: 'S1', rows: [['H'], ['a']] },
      { name: 'S2', rows: [['H'], ['b']] }
    ]);
    const disguised = path.join(dir, 'disguised.csv');
    fs.copyFileSync(actual, disguised);
    const output = path.join(dir, 'disguised-output.xlsx');

    assert.equal(detectMergeInputKind(disguised), 'xlsx');
    const result = await mergeToolboxFilesToXlsx({ filePaths: [disguised], savePath: output });
    assert.equal(result.inputSheetCount, 2);
    assert.deepEqual(readWorkbookAoa(output).sheets[0], [['H'], ['a'], ['b']]);
  });

  test('扩展名为 CSV 但实际为 OLE2 XLS 时按工作簿读取全部可见 sheet', async () => {
    const dir = makeTempDir();
    const actual = writeXls(path.join(dir, 'actual.xls'), [
      { name: 'S1', rows: [['H'], ['a']] },
      { name: 'S2', rows: [['H'], ['b']] }
    ]);
    const disguised = path.join(dir, 'disguised-legacy.csv');
    fs.copyFileSync(actual, disguised);
    const output = path.join(dir, 'disguised-legacy-output.xlsx');

    assert.equal(detectMergeInputKind(disguised), 'xls');
    const result = await mergeToolboxFilesToXlsx({ filePaths: [disguised], savePath: output });
    assert.equal(result.inputSheetCount, 2);
    assert.deepEqual(readWorkbookAoa(output).sheets[0], [['H'], ['a'], ['b']]);
  });

  test('writer commit 失败会调用 abort，不保留可导出结果', async () => {
    const dir = makeTempDir();
    const input = await writeXlsx(path.join(dir, 'writer-failure.xlsx'), [
      { name: 'S1', rows: [['H'], ['a']] }
    ]);
    const output = path.join(dir, 'writer-failure-output.xlsx');
    let aborted = false;

    await assert.rejects(
      () => mergeToolboxFilesToXlsx({
        filePaths: [input],
        savePath: output,
        writerFactory: () => ({
          emit() {},
          async commit() { throw new Error('injected commit failure'); },
          async abort() { aborted = true; }
        })
      }),
      /injected commit failure/
    );
    assert.equal(aborted, true);
    assert.equal(fs.existsSync(output), false);
  });

  test('目标文件采用同目录暂存和原子替换，成功后不留备份', () => {
    const dir = makeTempDir();
    const source = path.join(dir, 'source.bin');
    const target = path.join(dir, 'target.xlsx');
    fs.writeFileSync(source, 'new-content');
    fs.writeFileSync(target, 'old-content');

    const result = publishMergedWorkbook(source, target, { nonce: 'success' });
    assert.equal(result.filePath, target);
    assert.deepEqual(result.warnings, []);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new-content');
    assert.equal(fs.existsSync(path.join(dir, '.toolbox-merge-success.tmp')), false);
    assert.equal(fs.existsSync(path.join(dir, '.toolbox-merge-success.bak')), false);
  });

  test('原子替换失败时恢复同名旧文件并清理发布暂存文件', () => {
    const dir = makeTempDir();
    const source = path.join(dir, 'source.bin');
    const target = path.join(dir, 'target.xlsx');
    fs.writeFileSync(source, 'new-content');
    fs.writeFileSync(target, 'old-content');
    const fsImpl = Object.create(fs);
    let renameCount = 0;
    fsImpl.renameSync = (from, to) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('injected publish failure');
      return fs.renameSync(from, to);
    };

    assert.throws(
      () => publishMergedWorkbook(source, target, { fsImpl, nonce: 'rollback' }),
      (error) => {
        assert.ok(error instanceof ToolboxMergePublishError);
        assert.match(error.detailLines.join('\n'), /injected publish failure/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'old-content');
    assert.equal(fs.existsSync(path.join(dir, '.toolbox-merge-rollback.tmp')), false);
    assert.equal(fs.existsSync(path.join(dir, '.toolbox-merge-rollback.bak')), false);
  });
});
