'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const {
  countStyleComponents,
  createToolboxOutputWriter,
  validateGeneratedWorkbook,
  writeToolboxRows
} = require('../../../src/main-process/toolbox-output-writer');
const { openToolboxXlsxPass } = require('../../../src/backend/toolbox-format');

function tempOutput(name = 'out.xlsx') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-output-writer-'));
  return {
    dir,
    filePath: path.join(dir, name),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function makeResolver() {
  const styles = new Map([
    [0, Object.freeze({})],
    [1, Object.freeze({
      font: { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFF0000' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }
    })],
    [2, Object.freeze({
      numFmt: '000000',
      border: { bottom: { style: 'thin', color: { argb: 'FF0000FF' } } }
    })],
    [3, Object.freeze({ alignment: { textRotation: -45 } })],
    [4, Object.freeze({ alignment: { textRotation: 'vertical' } })]
  ]);
  return new Map([['fixture', { get: (ref) => styles.get(ref) }]]);
}

function cell(columnIndex, outputValue, styleRef, extra = {}) {
  return {
    isExplicitCell: true,
    columnIndex,
    outputValue,
    effectiveStyleRef: { sourceRegistryId: 'fixture', styleRef },
    sourceFile: '/tmp/input.xlsx',
    sourceSheet: 'Data',
    cellRef: `${String.fromCharCode(65 + columnIndex)}2`,
    ...extra
  };
}

function plainCell(columnIndex, outputValue) {
  return {
    isExplicitCell: true,
    columnIndex,
    outputValue
  };
}

function expectedStructure(result, normalizedHeaders) {
  return {
    sheetCount: result.sheetCount,
    dataRowCount: result.dataRowCount,
    normalizedHeaders: normalizedHeaders.slice()
  };
}

async function rewriteWorkbookEntry(sourcePath, targetPath, entryName, rewrite) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const entry = zip.file(entryName);
  assert.ok(entry, `测试夹具缺少 ZIP entry：${entryName}`);
  const original = await entry.async('string');
  const changed = rewrite(original, zip);
  assert.notEqual(changed, original, `测试故障注入未改变 ZIP entry：${entryName}`);
  zip.file(entryName, changed);
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function removeWorkbookEntry(sourcePath, targetPath, entryName) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  assert.ok(zip.file(entryName), `测试夹具缺少 ZIP entry：${entryName}`);
  zip.remove(entryName);
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function assertValidationDetail(error, messagePattern, detailPattern) {
  assert.equal(error && error.name, 'ToolboxOutputValidationError');
  assert.match(error.message, messagePattern);
  assert.ok(
    Array.isArray(error.detailLines)
      && error.detailLines.some((line) => detailPattern.test(line)),
    `错误明细未命中 ${detailPattern}：${JSON.stringify(error.detailLines)}`
  );
  return true;
}

test('唯一 writer 保留表头/数据样式、值类型与行列布局', async () => {
  const output = tempOutput();
  try {
    const headerCells = [cell(0, ' raw ', 1), cell(1, 'ID', 2)];
    const row = {
      rowIndex: 2,
      height: 23,
      hidden: true,
      outlineLevel: 2,
      cells: [cell(0, true, 1), cell(1, '001234', 2)]
    };
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['Flag', 'ID'],
      rawHeaderCells: headerCells,
      headerRow: { height: 31 },
      layoutBaseline: {
        defaultRowHeight: 18,
        defaultColWidth: 11,
        customHeight: true,
        columnRanges: [
          { min: 1, max: 1, width: 17, hidden: false, outlineLevel: 1 },
          { min: 2, max: 2, width: 22, hidden: true, outlineLevel: 0 }
        ]
      },
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => emit(row)
    });

    assert.equal(result.dataRowCount, 1);
    assert.equal(result.sheetCount, 1);
    assert.equal(result.warningSummary.warningCount, 0);
    assert.equal(result.sha256.length, 64);
    assert.ok(result.styleStats.actualCounts.cellXfs >= 2);
    assert.deepEqual(
      result.styleStats.actualCounts,
      result.styleStats.projectedFinalCounts,
      'writer 预计样式组件数必须与临时产物实际节点数完全一致'
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('A1').value, 'Flag');
    assert.equal(sheet.getCell('A1').font.bold, true);
    assert.equal(sheet.getCell('A1').font.color.argb, 'FFFF0000');
    assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FFFFFF00');
    assert.equal(sheet.getCell('B1').numFmt, '000000');
    assert.equal(sheet.getCell('A2').value, true);
    assert.equal(sheet.getCell('B2').value, '001234');
    assert.equal(sheet.getCell('B2').numFmt, '000000');
    assert.equal(sheet.getRow(1).height, 31);
    assert.equal(sheet.getRow(2).height, 23);
    assert.equal(sheet.getRow(2).hidden, true);
    assert.equal(sheet.getRow(2).outlineLevel, 2);
    assert.equal(sheet.getColumn(1).width, 17);
    assert.equal(sheet.getColumn(2).hidden, true);
    assert.equal(sheet.properties.defaultRowHeight, 18);
    assert.equal(sheet.properties.defaultColWidth, 11);
    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bdefaultRowHeight="18"/);
    assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bdefaultColWidth="11"/);
    assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bcustomHeight="1"/);
  } finally {
    output.cleanup();
  }
});

test('唯一 writer 将 BIFF8 零默认高度与零宽列保留为不可见布局', async () => {
  const output = tempOutput('zero-layout.xlsx');
  try {
    await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['ID'],
      rawHeaderCells: [cell(0, 'ID', 1)],
      headerRow: { rowIndex: 1, hidden: true },
      layoutBaseline: {
        defaultRowHeight: 0,
        defaultRowHidden: true,
        defaultColWidth: 0,
        customHeight: true,
        columns: [
          {
            minColumnIndex: 0,
            maxColumnIndex: 255,
            width: null,
            hidden: true,
            outlineLevel: 0
          },
          {
            minColumnIndex: 0,
            maxColumnIndex: 0,
            width: 0,
            hidden: true,
            outlineLevel: 0
          }
        ]
      },
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => {
        emit({
          rowIndex: 2,
          hidden: true,
          cells: [cell(0, '001234567890123456789', 2)]
        });
        emit({
          rowIndex: 3,
          hidden: false,
          cells: [cell(0, '显式可见行', 2)]
        });
      }
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.properties.defaultRowHeight, 15);
    assert.equal(sheet.getRow(1).hidden, true);
    assert.equal(sheet.getRow(2).hidden, true);
    assert.equal(sheet.getRow(3).hidden, false);
    assert.equal(sheet.getColumn(1).hidden, true);

    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bdefaultRowHeight="15"/);
    assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bzeroHeight="1"/);
    assert.doesNotMatch(sheetXml, /\bdefaultRowHeight="0"/);
    const columnTags = [...sheetXml.matchAll(/<col\b[^>]*>/g)].map((match) => match[0]);
    assert.ok(columnTags.some((tag) => /\bhidden="1"/.test(tag)));
    assert.ok(columnTags.every((tag) => {
      const match = tag.match(/\bmax="(\d+)"/);
      return !match || Number(match[1]) <= 256;
    }));

    const strictPass = await openToolboxXlsxPass(output.filePath);
    try {
      let meta = null;
      const rows = [];
      await strictPass.scanSheet(0, {
        onSheetMeta: (value) => {
          meta = value;
        },
        onRow: (row) => rows.push(row)
      });
      assert.equal(meta.defaultRowHeight, 15);
      assert.equal(meta.defaultRowHidden, true);
      assert.deepEqual(rows.map((row) => row.hidden), [true, true, false]);
    } finally {
      strictPass.close();
    }
  } finally {
    output.cleanup();
  }
});

test('唯一 writer 不把缺失默认行高误写为零，并允许同版工具再次读取', async () => {
  const output = tempOutput('missing-default-height.xlsx');
  try {
    await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['ID'],
      rawHeaderCells: [cell(0, 'ID', 1)],
      headerRow: { rowIndex: 1 },
      layoutBaseline: {
        defaultRowHeight: null,
        defaultRowHidden: false
      },
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => emit({
        rowIndex: 2,
        cells: [cell(0, '001234567890123456789', 2)]
      })
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.doesNotMatch(sheetXml, /\bdefaultRowHeight="0"/);
    assert.doesNotMatch(sheetXml, /\bzeroHeight="1"/);

    const strictPass = await openToolboxXlsxPass(output.filePath);
    try {
      let meta = null;
      const summary = await strictPass.scanSheet(0, {
        onSheetMeta: (value) => {
          meta = value;
        }
      });
      assert.equal(summary.rowCount, 2);
      assert.equal(meta.defaultRowHeight, 15);
      assert.equal(meta.defaultRowHidden, false);
    } finally {
      strictPass.close();
    }
  } finally {
    output.cleanup();
  }
});

test('自动分页重放基准表头与列布局', async () => {
  const output = tempOutput();
  try {
    const writer = createToolboxOutputWriter({
      savePath: output.filePath,
      normalizedHeaders: ['ID'],
      rawHeaderCells: [cell(0, 'ID', 1)],
      layoutBaseline: {
        defaultRowHeight: 18,
        defaultColWidth: 11,
        customHeight: true,
        columnRanges: [{ min: 1, max: 1, width: 24 }]
      },
      sourceRegistryResolver: makeResolver(),
      maxRowsPerSheet: 1
    });
    writer.emitRow({ cells: [cell(0, 'A', 2)] });
    writer.emitRow({ cells: [cell(0, 'B', 2)] });
    const result = await writer.commitAndValidate();
    assert.equal(result.sheetCount, 2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['COMMON', 'COMMON(2)']);
    for (const sheet of workbook.worksheets) {
      assert.equal(sheet.getCell('A1').value, 'ID');
      assert.equal(sheet.getCell('A1').font.bold, true);
      assert.equal(sheet.getColumn(1).width, 24);
      assert.equal(sheet.properties.defaultRowHeight, 18);
      assert.equal(sheet.properties.defaultColWidth, 11);
    }
    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    for (const sheetNumber of [1, 2]) {
      const sheetXml = await zip.file(`xl/worksheets/sheet${sheetNumber}.xml`).async('string');
      assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bdefaultRowHeight="18"/);
      assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bdefaultColWidth="11"/);
      assert.match(sheetXml, /<sheetFormatPr\b[^>]*\bcustomHeight="1"/);
    }
    assert.equal(workbook.worksheets[0].getCell('A2').value, 'A');
    assert.equal(workbook.worksheets[1].getCell('A2').value, 'B');
  } finally {
    output.cleanup();
  }
});

test('重叠列范围按来源声明顺序应用，后声明范围覆盖前声明范围', async () => {
  const output = tempOutput();
  try {
    const writer = createToolboxOutputWriter({
      savePath: output.filePath,
      normalizedHeaders: ['A', 'B', 'C'],
      layoutBaseline: {
        columns: [
          { minColumnIndex: 1, maxColumnIndex: 2, width: 20, hidden: true, outlineLevel: 2 },
          { minColumnIndex: 0, maxColumnIndex: 1, width: 10, hidden: false, outlineLevel: 0 }
        ]
      },
      sourceRegistryResolver: makeResolver()
    });
    await writer.commitAndValidate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getColumn(1).width, 10);
    assert.equal(sheet.getColumn(2).width, 10);
    assert.equal(sheet.getColumn(3).width, 20);
    assert.equal(sheet.getColumn(2).hidden, false);
    assert.equal(sheet.getColumn(2).outlineLevel, 0);
    assert.equal(sheet.getColumn(3).hidden, true);
    assert.equal(sheet.getColumn(3).outlineLevel, 2);
  } finally {
    output.cleanup();
  }
});

test('负角度和竖排文字旋转写入后仍可回读', async () => {
  const output = tempOutput();
  try {
    const writer = createToolboxOutputWriter({
      savePath: output.filePath,
      normalizedHeaders: ['A', 'B'],
      sourceRegistryResolver: makeResolver()
    });
    writer.emitRow({
      cells: [cell(0, 'left', 3), cell(1, 'vertical', 4)]
    });
    await writer.commitAndValidate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('A2').alignment.textRotation, -45);
    assert.equal(sheet.getCell('B2').alignment.textRotation, 'vertical');
  } finally {
    output.cleanup();
  }
});

test('稀疏表头的隐式空白单元格继承表头行 customFormat 样式', async () => {
  const output = tempOutput();
  try {
    const writer = createToolboxOutputWriter({
      savePath: output.filePath,
      normalizedHeaders: ['A', '', 'C'],
      rawHeaderCells: [cell(0, 'A', 2), cell(2, 'C', 2)],
      headerRow: {
        rowIndex: 1,
        customFormat: true,
        effectiveStyleRef: { sourceRegistryId: 'fixture', styleRef: 1 }
      },
      sourceRegistryResolver: makeResolver()
    });
    await writer.commitAndValidate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('B1').fill.fgColor.argb, 'FFFFFF00');
    assert.equal(sheet.getCell('B1').font.bold, true);
  } finally {
    output.cleanup();
  }
});

test('日期文本安全降级返回有界 warning summary', async () => {
  const output = tempOutput();
  try {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      cells: [{
        isExplicitCell: true,
        columnIndex: 0,
        effectiveStyleRef: { sourceRegistryId: 'fixture', styleRef: 0 },
        sourceFile: '/tmp/input.xlsx',
        sourceSheet: 'Data',
        cellRef: `A${index + 2}`,
        decodedSemanticValue: { kind: 'iso-date', lexical: `12000-01-${String(index + 1).padStart(2, '0')}` }
      }]
    }));
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['Date'],
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => rows.forEach(emit)
    });
    assert.equal(result.warningSummary.warningCount, 25);
    assert.equal(result.warningSummary.warningSamples.length, 20);
  } finally {
    output.cleanup();
  }
});

test('极端数值日期不得写出 Infinity，固定降级 canonical 文本并提示', async () => {
  const output = tempOutput('extreme-date.xlsx');
  try {
    const extremeCell = {
      isExplicitCell: true,
      columnIndex: 0,
      rawLexicalValue: '1e309',
      decodedSemanticValue: `1${'0'.repeat(309)}`,
      cellType: 'number',
      sourceDateSystem: 1900,
      sourceFormat: 'yyyy-mm-dd',
      effectiveStyleRef: { sourceRegistryId: 'fixture', styleRef: 0 },
      sourceFile: '/tmp/extreme-date.xlsx',
      sourceSheet: 'Data',
      rowIndex: 2,
      cellRef: 'A2'
    };
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['Date'],
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => emit({ rowIndex: 2, cells: [extremeCell] })
    });
    assert.equal(result.warningSummary.warningCount, 1);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output.filePath);
    assert.equal(workbook.worksheets[0].getCell('A2').value, `1${'0'.repeat(309)}`);
    assert.equal(workbook.worksheets[0].getCell('A2').numFmt, '@');

    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.doesNotMatch(worksheetXml, /(?:NaN|Infinity)/);
  } finally {
    output.cleanup();
  }
});

test('writer 统一 ST_Xstring 编码，保留控制字符和 escape 字面量', async () => {
  const output = tempOutput('st-xstring.xlsx');
  const semanticControlText = 'A\u0000B\u0001C\u000BD\r\nE\u007FF';
  try {
    await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['_x0041_', 'Control'],
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => emit({
        rowIndex: 2,
        cells: [
          cell(0, '_X0042_', 0),
          cell(1, semanticControlText, 0)
        ]
      })
    });

    const workbook = XLSX.readFile(output.filePath, { raw: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
      raw: true
    });
    assert.equal(rows[0][0], '_x0041_');
    assert.equal(rows[1][0], '_X0042_');
    assert.equal(rows[1][1], semanticControlText);

    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(worksheetXml, /_x005F_x0041_/);
    assert.match(worksheetXml, /_x005F_X0042_/);
    assert.match(worksheetXml, /_x0000_/);
    assert.match(worksheetXml, /_x000D_/);
    assert.match(worksheetXml, /_x007F_/);
  } finally {
    output.cleanup();
  }
});

test('超过 Excel 32767 UTF-16 code unit 的表头或数据文本整批失败并清理', async () => {
  const headerOutput = tempOutput('long-header.xlsx');
  try {
    assert.throws(
      () => createToolboxOutputWriter({
        savePath: headerOutput.filePath,
        normalizedHeaders: ['A'.repeat(32768)],
        sourceRegistryResolver: makeResolver()
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /文本超出 Excel 可保真范围/);
        assert.match(error.detailLines.join('\n'), /32767.*UTF-16/);
        return true;
      }
    );
    assert.equal(fs.existsSync(headerOutput.filePath), false);
  } finally {
    headerOutput.cleanup();
  }

  const dataOutput = tempOutput('long-data.xlsx');
  try {
    await assert.rejects(
      () => writeToolboxRows({
        savePath: dataOutput.filePath,
        normalizedHeaders: ['Text'],
        sourceRegistryResolver: makeResolver(),
        writeRows: async (emit) => emit({
          rowIndex: 2,
          cells: [cell(0, '😀'.repeat(16384), 0)]
        })
      }),
      (error) => {
        assert.match(error.message, /文本超出 Excel 可保真范围/);
        assert.match(error.detailLines.join('\n'), /input\\.xlsx|Data|A2/);
        return true;
      }
    );
    assert.equal(fs.existsSync(dataOutput.filePath), false);
  } finally {
    dataOutput.cleanup();
  }
});

test('组件预算超限在 commit 前失败并清理生成文件', async () => {
  const output = tempOutput();
  try {
    assert.throws(
      () => createToolboxOutputWriter({
        savePath: output.filePath,
        normalizedHeaders: ['A'],
        rawHeaderCells: [cell(0, 'A', 1)],
        sourceRegistryResolver: makeResolver(),
        budgets: { fills: 2 }
      }),
      /fills/
    );
    // 构造阶段在目标 writer 提交任何行之前失败；打开的空 generation stream 由进程结束前关闭。
    // 生产 orchestrator 会在同一 task finally 中统一 dispose generation path。
    if (fs.existsSync(output.filePath)) fs.rmSync(output.filePath, { force: true });
  } finally {
    output.cleanup();
  }
});

test('表头行 customFormat 预算失败发生在创建 generation stream 之前', () => {
  const output = tempOutput('header-row-budget.xlsx');
  try {
    assert.throws(
      () => createToolboxOutputWriter({
        savePath: output.filePath,
        normalizedHeaders: ['A'],
        headerRow: {
          rowIndex: 1,
          customFormat: true,
          effectiveStyleRef: { sourceRegistryId: 'fixture', styleRef: 1 }
        },
        sourceRegistryResolver: makeResolver(),
        budgets: { cellXfs: 1 }
      }),
      /cellXfs|单元格样式/
    );
    assert.equal(
      fs.existsSync(output.filePath),
      false,
      '调用方尚未拿到 writer 时，预算失败不得留下 generation 文件'
    );
  } finally {
    output.cleanup();
  }
});

test('临时产物样式计数以实际子节点为准，并拒绝伪造 count 或损坏 XML', () => {
  const valid = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>',
    '<fonts count="2"><font/><font/></fonts>',
    '<fills count="1"><fill/></fills>',
    '<borders count="1"><border/></borders>',
    '<cellXfs count="2"><xf/><xf/></cellXfs>',
    '</styleSheet>'
  ].join('');
  assert.deepEqual(countStyleComponents(valid), {
    cellXfs: 2,
    fonts: 2,
    fills: 1,
    borders: 1,
    customNumFmts: 1
  });

  assert.throws(
    () => countStyleComponents(valid.replace(
      '<cellXfs count="2"><xf/><xf/></cellXfs>',
      '<cellXfs count="1"><xf/><xf/></cellXfs>'
    )),
    /count 与实际节点数不一致/
  );
  assert.throws(
    () => countStyleComponents(valid.replace('</styleSheet>', '')),
    /不是完整有效的 XML|未完整闭合/
  );
  assert.throws(
    () => countStyleComponents(valid.replace('<fonts count="2"><font/><font/></fonts>', '')),
    /缺少 fonts/
  );
  assert.throws(
    () => countStyleComponents(valid.replace(
      '<fonts count="2"><font/><font/></fonts>',
      '<fonts count="0"><wrapper><font/></wrapper></fonts>'
    )),
    /font 必须是 fonts 的直接子元素/
  );
  assert.throws(
    () => countStyleComponents(valid.replace(
      'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      'xmlns="urn:invalid"'
    )),
    /命名空间无效/
  );
  assert.throws(
    () => countStyleComponents(valid.replace('<cellXfs ', '<CELLXFS ')),
    /大小写无效/
  );
  assert.throws(
    () => countStyleComponents(valid.replace('<fonts count=', '<fonts COUNT=')),
    /大小写无效/
  );
});

test('写后复核拒绝 registry 预计数量与 writer 实际数量漂移', async () => {
  const output = tempOutput('projected-drift.xlsx');
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: ['ID'],
      sourceRegistryResolver: makeResolver(),
      writeRows: async (emit) => emit({ cells: [cell(0, '001', 2)] })
    });
    const wrongProjected = {
      ...result.styleStats.projectedFinalCounts,
      cellXfs: result.styleStats.projectedFinalCounts.cellXfs + 1
    };
    await assert.rejects(
      validateGeneratedWorkbook(output.filePath, undefined, wrongProjected),
      /样式组件数量与预计不一致：cellXfs/
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核严格拒绝截断的 workbook 与 worksheet XML', async () => {
  const output = tempOutput('strict-structure.xlsx');
  const headers = ['OrderId', 'Amount'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({
        cells: [plainCell(0, 'O-1'), plainCell(1, 100)]
      })
    });
    const expected = expectedStructure(result, headers);
    const projected = result.styleStats.projectedFinalCounts;

    const truncatedWorkbookPath = path.join(output.dir, 'truncated-workbook.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      truncatedWorkbookPath,
      'xl/workbook.xml',
      (xml) => xml.slice(0, Math.floor(xml.length / 2))
    );
    await assert.rejects(
      validateGeneratedWorkbook(truncatedWorkbookPath, undefined, projected, expected),
      (error) => assertValidationDetail(error, /结构复核失败/, /workbook\.xml/)
    );

    const truncatedWorksheetPath = path.join(output.dir, 'truncated-worksheet.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      truncatedWorksheetPath,
      'xl/worksheets/sheet1.xml',
      (xml) => xml.slice(0, Math.floor(xml.length / 2))
    );
    await assert.rejects(
      validateGeneratedWorkbook(truncatedWorksheetPath, undefined, projected, expected),
      (error) => assertValidationDetail(error, /结构复核失败/, /工作表 XML/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核严格拒绝截断的 Content_Types XML', async () => {
  const output = tempOutput('strict-content-types.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'truncated-content-types.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      '[Content_Types].xml',
      (xml) => xml.slice(0, Math.floor(xml.length / 2))
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => {
        assert.equal(error && error.name, 'ToolboxOutputValidationError');
        assert.match(error.message, /\[Content_Types\]\.xml/);
        return true;
      }
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝缺少 package root relationships 的工作簿', async () => {
  const output = tempOutput('missing-package-root-relationships.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'missing-package-root-relationships-mutated.xlsx');
    await removeWorkbookEntry(
      output.filePath,
      corruptedPath,
      '_rels/.rels'
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /结构不完整/, /_rels\/\.rels/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核要求唯一 package root officeDocument 关系指向 workbook', async () => {
  const output = tempOutput('wrong-package-root-office-document.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'wrong-package-root-office-document-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      '_rels/.rels',
      (xml) => xml.replace('Target="xl/workbook.xml"', 'Target="xl/styles.xml"')
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(
        error,
        /必须唯一指向 xl\/workbook\.xml/,
        /xl\/styles\.xml/
      )
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝 Content_Types 缺少 rels Default', async () => {
  const output = tempOutput('missing-rels-default.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'missing-rels-default-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      '[Content_Types].xml',
      (xml) => xml.replace(
        /<Default\b[^>]*\bExtension="rels"[^>]*\/>/,
        ''
      )
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /缺少有效的 rels Default/, /实际类型：/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝 Content_Types 中指向不存在 Part 的 worksheet Override', async () => {
  const output = tempOutput('dangling-content-type.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'dangling-content-type-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      '[Content_Types].xml',
      (xml) => xml.replace(
        '</Types>',
        '<Override PartName="/xl/worksheets/missing.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.' +
          'spreadsheetml.worksheet+xml"/></Types>'
      )
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /悬空或不一致声明/, /missing\.xml/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝 workbook relationships 中悬空的内部关系', async () => {
  const output = tempOutput('dangling-workbook-relationship.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'dangling-workbook-relationship-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      'xl/_rels/workbook.xml.rels',
      (xml) => xml.replace(
        '</Relationships>',
        '<Relationship Id="rDangling" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
          'relationships/calcChain" Target="calcChain-missing.xml"/>' +
          '</Relationships>'
      )
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(
        error,
        /workbook relationships 包含悬空内部关系/,
        /rDangling.*calcChain-missing\.xml/
      )
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝未被 workbook Sheet 使用的 worksheet relationship', async () => {
  const output = tempOutput('dangling-relationship.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const corruptedPath = path.join(output.dir, 'dangling-relationship-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      corruptedPath,
      'xl/_rels/workbook.xml.rels',
      (xml) => xml.replace(
        '</Relationships>',
        '<Relationship Id="rExtra" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
          'relationships/worksheet" Target="worksheets/missing.xml"/>' +
          '</Relationships>'
      )
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        corruptedPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(
        error,
        /未被 workbook Sheet 使用的 worksheet relationship/,
        /rExtra/
      )
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝 ZIP 中未被 workbook 声明的孤立 worksheet', async () => {
  const output = tempOutput('orphan-worksheet.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const orphanPath = path.join(output.dir, 'orphan-worksheet-mutated.xlsx');
    const zip = await JSZip.loadAsync(fs.readFileSync(output.filePath));
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const contentTypesXml = await zip.file('[Content_Types].xml').async('string');
    zip.file('xl/worksheets/orphan.xml', worksheetXml);
    zip.file(
      '[Content_Types].xml',
      contentTypesXml.replace(
        '</Types>',
        '<Override PartName="/xl/worksheets/orphan.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.' +
          'spreadsheetml.worksheet+xml"/></Types>'
      )
    );
    fs.writeFileSync(orphanPath, await zip.generateAsync({ type: 'nodebuffer' }));

    await assert.rejects(
      validateGeneratedWorkbook(
        orphanPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /未声明的 worksheet/, /orphan\.xml/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后复核前后文件身份不一致时拒绝为替换后的 bytes 背书', async () => {
  const output = tempOutput('validation-snapshot-drift.xlsx');
  const headers = ['OrderId'];
  const originalCreateReadStream = fs.createReadStream;
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({ cells: [plainCell(0, 'O-1')] })
    });
    const expected = expectedStructure(result, headers);
    const projected = result.styleStats.projectedFinalCounts;
    const originalSize = fs.statSync(output.filePath).size;
    let targetHashStreamCount = 0;
    fs.createReadStream = function createMutatingReadStream(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(output.filePath)) {
        if (targetHashStreamCount === 1) {
          fs.writeFileSync(output.filePath, Buffer.alloc(originalSize, 0x5a));
        }
        targetHashStreamCount += 1;
      }
      return originalCreateReadStream.call(this, filePath, ...args);
    };

    await assert.rejects(
      validateGeneratedWorkbook(output.filePath, undefined, projected, expected),
      /写后复核期间发生变化/
    );
    assert.equal(targetHashStreamCount, 2);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    output.cleanup();
  }
});

test('写后结构复核拒绝 workbook 声明但实际缺失的分页 Sheet', async () => {
  const output = tempOutput('missing-page.xlsx');
  const headers = ['OrderId'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      maxRowsPerSheet: 1,
      writeRows: async (emit) => {
        emit({ cells: [plainCell(0, 'O-1')] });
        emit({ cells: [plainCell(0, 'O-2')] });
      }
    });
    assert.equal(result.sheetCount, 2);
    const missingSheetPath = path.join(output.dir, 'missing-sheet2.xlsx');
    await removeWorkbookEntry(
      output.filePath,
      missingSheetPath,
      'xl/worksheets/sheet2.xml'
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        missingSheetPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(
        error,
        /悬空或不一致声明|结构复核失败/,
        /sheet2\.xml|worksheet entry 不存在/
      )
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝任一分页表头与 normalizedHeaders 不一致', async () => {
  const output = tempOutput('wrong-header.xlsx');
  const headers = ['OrderId', 'Amount'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => emit({
        cells: [plainCell(0, 'O-1'), plainCell(1, 100)]
      })
    });
    const wrongHeaderPath = path.join(output.dir, 'wrong-header-mutated.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      wrongHeaderPath,
      'xl/worksheets/sheet1.xml',
      (xml) => xml.replace('OrderId', 'WrongHeader')
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        wrongHeaderPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /表头与预计不一致/, /WrongHeader/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核拒绝物理数据行少于 writer emit 计数', async () => {
  const output = tempOutput('missing-data-row.xlsx');
  const headers = ['OrderId', 'Amount'];
  try {
    const result = await writeToolboxRows({
      savePath: output.filePath,
      normalizedHeaders: headers,
      writeRows: async (emit) => {
        emit({ cells: [plainCell(0, 'O-1'), plainCell(1, 100)] });
        emit({ cells: [plainCell(0, 'O-2'), plainCell(1, 200)] });
      }
    });
    assert.equal(result.dataRowCount, 2);
    const missingRowPath = path.join(output.dir, 'missing-row3.xlsx');
    await rewriteWorkbookEntry(
      output.filePath,
      missingRowPath,
      'xl/worksheets/sheet1.xml',
      (xml) => xml.replace(
        /<row\b[^>]*\br="3"[^>]*>[\s\S]*?<\/row>/,
        ''
      )
    );

    await assert.rejects(
      validateGeneratedWorkbook(
        missingRowPath,
        undefined,
        result.styleStats.projectedFinalCounts,
        expectedStructure(result, headers)
      ),
      (error) => assertValidationDetail(error, /数据行数与预计不一致/, /实际数据行数：1/)
    );
  } finally {
    output.cleanup();
  }
});

test('写后结构复核允许 0 数据行，并精确核对自动分页的表头与物理行守恒', async () => {
  const zeroOutput = tempOutput('zero-row.xlsx');
  const pagedOutput = tempOutput('paged-row.xlsx');
  try {
    const zeroHeaders = ['OrderId'];
    const zeroResult = await writeToolboxRows({
      savePath: zeroOutput.filePath,
      normalizedHeaders: zeroHeaders,
      writeRows: async () => {}
    });
    assert.equal(zeroResult.dataRowCount, 0);
    assert.equal(zeroResult.sheetCount, 1);
    const zeroValidation = await validateGeneratedWorkbook(
      zeroOutput.filePath,
      undefined,
      zeroResult.styleStats.projectedFinalCounts,
      expectedStructure(zeroResult, zeroHeaders)
    );
    assert.equal(zeroValidation.actualSheetCount, 1);
    assert.equal(zeroValidation.actualDataRowCount, 0);
    assert.equal(zeroValidation.actualPhysicalRowCount, 1);

    const pagedHeaders = ['OrderId', 'Amount'];
    const pagedResult = await writeToolboxRows({
      savePath: pagedOutput.filePath,
      normalizedHeaders: pagedHeaders,
      maxRowsPerSheet: 1,
      writeRows: async (emit) => {
        emit({ cells: [plainCell(0, 'O-1'), plainCell(1, 100)] });
        emit({ cells: [plainCell(0, 'O-2'), plainCell(1, 200)] });
      }
    });
    assert.equal(pagedResult.dataRowCount, 2);
    assert.equal(pagedResult.sheetCount, 2);
    const pagedValidation = await validateGeneratedWorkbook(
      pagedOutput.filePath,
      undefined,
      pagedResult.styleStats.projectedFinalCounts,
      expectedStructure(pagedResult, pagedHeaders)
    );
    assert.equal(pagedValidation.actualSheetCount, 2);
    assert.equal(pagedValidation.actualDataRowCount, 2);
    assert.equal(pagedValidation.actualPhysicalRowCount, 4);
  } finally {
    zeroOutput.cleanup();
    pagedOutput.cleanup();
  }
});
