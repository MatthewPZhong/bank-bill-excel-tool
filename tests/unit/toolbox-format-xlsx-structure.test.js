'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  ToolboxXlsxFormatError,
  scanXlsxSheet
} = require('../../src/backend/toolbox-format/xlsx-sheet-scanner');
const {
  SourceStyleRegistry
} = require('../../src/backend/toolbox-format/style-registry');
const {
  createWarningCollector,
  projectOutputCell
} = require('../../src/backend/toolbox-format/model');

const TRANSITIONAL_SPREADSHEETML_NAMESPACE =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function createSourceRegistry() {
  const registry = new SourceStyleRegistry('worksheet-structure-test');
  registry.bindXf(0, {});
  return registry;
}

async function scanWorksheetXml(xml, options = {}) {
  const rows = [];
  const namespacedXml = String(xml).replace(
    /<worksheet\b([^>]*)>/,
    (tag, attributes) => (
      /\bxmlns(?:\s*=|:)/i.test(attributes)
        ? tag
        : `<worksheet xmlns="${TRANSITIONAL_SPREADSHEETML_NAMESPACE}"${attributes}>`
    )
  );
  const zip = {
    openReadStream(_entry, callback) {
      callback(null, Readable.from([Buffer.from(namespacedXml, 'utf8')]));
    }
  };
  const summary = await scanXlsxSheet({
    zip,
    sheetEntry: { fileName: 'xl/worksheets/sheet1.xml' },
    sheet: { name: 'Data', sheetIndex: 0, state: 'visible' },
    sourceFile: 'fixture.xlsx',
    sourceRegistry: createSourceRegistry(),
    onRow: (row) => rows.push(row),
    ...options
  });
  return { rows, summary };
}

async function assertStructureFailure(xml, messagePattern) {
  await assert.rejects(
    () => scanWorksheetXml(xml),
    (error) => {
      assert.ok(error instanceof ToolboxXlsxFormatError);
      assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
      assert.match(error.message, messagePattern);
      return true;
    }
  );
}

test('合法 worksheet：唯一根、唯一直接 sheetData，且只消费其直接 row', async () => {
  const { rows, summary } = await scanWorksheetXml(
    '<?xml version="1.0"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetFormatPr defaultColWidth="9" defaultRowHeight="15"/>'
    + '<sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row>'
    + '<row r="2"><c r="A2"><v>1</v></c></row>'
    + '</sheetData>'
    + '<ignoredExtension><payload/></ignoredExtension>'
    + '</worksheet>'
  );

  assert.equal(summary.rowCount, 2);
  assert.equal(summary.explicitCellCount, 2);
  assert.deepEqual(rows.map((row) => row.rowIndex), [1, 2]);
  assert.equal(rows[0].cells[0].decodedSemanticValue, 'header');
  assert.equal(rows[1].cells[0].decodedSemanticValue, 1);
});

test('worksheet 必须是唯一根：wrapper、嵌套 worksheet 和根外注入均 fail-closed', async () => {
  const cases = [
    {
      xml: '<wrapper><worksheet><sheetData/></worksheet></wrapper>',
      message: /根元素.*worksheet/
    },
    {
      xml: '<worksheet><worksheet><sheetData/></worksheet></worksheet>',
      message: /worksheet.*唯一根/
    },
    {
      xml: '<worksheet><sheetData/></worksheet><injected/>',
      message: /唯一.*worksheet|根元素.*worksheet/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('sheetData 必须是 worksheet 的唯一直接子元素', async () => {
  const cases = [
    {
      xml: '<worksheet><wrapper><sheetData/></wrapper></worksheet>',
      message: /sheetData.*直接子元素/
    },
    {
      xml: '<worksheet><sheetData/><sheetData/></worksheet>',
      message: /唯一.*sheetData/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('row 仅允许作为合法 sheetData 的直接子元素', async () => {
  const cases = [
    '<worksheet><row r="1"/><sheetData/></worksheet>',
    '<worksheet><sheetData><wrapper><row r="1"/></wrapper></sheetData></worksheet>',
    '<worksheet><sheetData/><row r="1"/></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /row.*sheetData.*直接子元素/);
  }
});

test('单元格和值节点必须位于合法直接父节点，禁止 wrapper 注入业务值', async () => {
  const cases = [
    {
      xml: '<worksheet><sheetData><row r="1"><wrapper><c r="A1"><v>1</v></c></wrapper></row></sheetData></worksheet>',
      message: /c.*row.*直接子元素/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1"><wrapper><v>123</v></wrapper></c></row></sheetData></worksheet>',
      message: /v.*c.*直接子元素/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1"><f><v>9</v></f><v>2</v></c></row></sheetData></worksheet>',
      message: /f.*只能包含文本|v.*c.*直接子元素/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><wrapper><t>INJECT</t></wrapper></is></c></row></sheetData></worksheet>',
      message: /富文本 t/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1"><v><wrapper>42</wrapper></v></c></row></sheetData></worksheet>',
      message: /v.*只能包含文本/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1"><f><wrapper>1\+1</wrapper></f><v>2</v></c></row></sheetData></worksheet>',
      message: /f.*只能包含文本/
    },
    {
      xml: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><wrapper>INJECT</wrapper></t></is></c></row></sheetData></worksheet>',
      message: /t.*只能包含文本/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('布局节点必须位于合法层级且容器唯一，禁止 wrapper 注入列宽', async () => {
  const cases = [
    {
      xml: '<worksheet><wrapper><sheetFormatPr defaultColWidth="99"/></wrapper><sheetData/></worksheet>',
      message: /sheetFormatPr.*唯一直接子元素/
    },
    {
      xml: '<worksheet><sheetFormatPr/><sheetFormatPr/><sheetData/></worksheet>',
      message: /sheetFormatPr.*唯一直接子元素/
    },
    {
      xml: '<worksheet><wrapper><cols><col min="1" max="1" width="77"/></cols></wrapper><sheetData/></worksheet>',
      message: /cols.*唯一直接子元素/
    },
    {
      xml: '<worksheet><cols><wrapper><col min="1" max="1" width="77"/></wrapper></cols><sheetData/></worksheet>',
      message: /col.*cols.*直接子元素/
    },
    {
      xml: '<worksheet><cols/><cols/><sheetData/></worksheet>',
      message: /cols.*唯一直接子元素/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('合法内联 rich text、公式缓存值和列布局保持可解析', async () => {
  const { rows, summary } = await scanWorksheetXml(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetFormatPr defaultColWidth="9" defaultRowHeight="15"/>'
    + '<cols><col min="1" max="2" width="18" customWidth="1"/></cols>'
    + '<sheetData><row r="1">'
    + '<c r="A1" t="inlineStr"><is><r><rPr><b/></rPr><t>Rich</t></r><t>Text</t></is></c>'
    + '<c r="B1"><f>1+1</f><v>2</v></c>'
    + '</row></sheetData></worksheet>'
  );

  assert.equal(summary.rowCount, 1);
  assert.equal(summary.sheetMeta.columns[0].width, 18);
  assert.equal(rows[0].cells[0].decodedSemanticValue, 'RichText');
  assert.equal(rows[0].cells[1].decodedSemanticValue, 2);
  assert.equal(rows[0].cells[1].formulaLexical, '1+1');
});

test('工作表整数、数值和布尔属性使用严格 OOXML 词法，不把损坏值当缺省值', async () => {
  const cases = [
    {
      xml: '<worksheet><sheetData><row r="1junk"/></sheetData></worksheet>',
      message: /整数属性/
    },
    {
      xml: '<worksheet><cols><col min="1junk" max="1"/></cols><sheetData/></worksheet>',
      message: /整数属性/
    },
    {
      xml: '<worksheet><sheetFormatPr defaultColWidth="NaN"/><sheetData/></worksheet>',
      message: /数值属性/
    },
    {
      xml: '<worksheet><sheetData><row r="1" hidden="maybe"/></sheetData></worksheet>',
      message: /布尔属性/
    },
    {
      xml: '<worksheet><sheetFormatPr zeroHeight="maybe"/><sheetData/></worksheet>',
      message: /布尔属性/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('SpreadsheetML 命名空间严格校验，外部命名空间不能注入业务单元格', async () => {
  await assertStructureFailure(
    '<worksheet xmlns="urn:invalid"><sheetData/></worksheet>',
    /SpreadsheetML 命名空间/
  );
  await assertStructureFailure(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:x="urn:invalid">'
      + '<sheetData><row r="1"><x:c r="A1"><x:v>99</x:v></x:c></row></sheetData>'
      + '</worksheet>',
    /元素 c.*SpreadsheetML 命名空间/
  );

  const strictNamespace = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
  const { rows } = await scanWorksheetXml(
    `<worksheet xmlns="${strictNamespace}">`
      + '<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>'
      + '</worksheet>'
  );
  assert.equal(rows[0].cells[0].decodedSemanticValue, 7);
});

test('SpreadsheetML 已知元素 local name 必须精确匹配规范大小写', async () => {
  const cases = [
    '<WORKSHEET><sheetData/></WORKSHEET>',
    '<worksheet><SHEETDATA/></worksheet>',
    '<worksheet><sheetData><ROW r="1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><C r="A1"><v>1</v></C></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1"><V>1</V></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr">'
      + '<is><R><t>value</t></R></is></c></row></sheetData></worksheet>',
    '<worksheet><SHEETFORMATPR defaultColWidth="9"/><sheetData/></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr">'
      + '<is><r><t>value</t></r><RPH><t>phonetic</t></RPH></is>'
      + '</c></row></sheetData></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /元素.*大小写.*规范名称/);
  }
});

test('worksheet 受消费属性必须按所在元素精确匹配规范大小写', async () => {
  const cases = [
    '<worksheet><sheetFormatPr defaultcolwidth="9"/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr DEFAULTROWHEIGHT="15"/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr customheight="1"/><sheetData/></worksheet>',
    '<worksheet><cols><col MIN="1" max="1"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" MAX="1"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" WIDTH="9"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" outlinelevel="1"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" customwidth="1"/></cols><sheetData/></worksheet>',
    '<worksheet><sheetData><row R="1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" HT="15"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" outlinelevel="1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" customformat="1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c R="A1"><v>1</v></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1" T="n"><v>1</v></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1" S="0"><v>1</v></c></row></sheetData></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /属性.*大小写.*规范名称/);
  }
});

test('合法 SpreadsheetML namespace 前缀保持可解析，真正未知扩展元素与属性继续忽略', async () => {
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const { rows, summary } = await scanWorksheetXml(
    `<x:worksheet xmlns:x="${namespace}" xmlns:ext="urn:future-extension">`
      + '<x:sheetFormatPr defaultColWidth="9" defaultRowHeight="15"'
      + ' customHeight="1" zeroHeight="1"/>'
      + '<ext:futureLayout DEFAULTCOLWIDTH="999"/>'
      + '<x:cols><x:col min="1" max="1" width="18" outlineLevel="7" customWidth="1"'
      + ' ext:R="ignored"/></x:cols>'
      + '<x:sheetData><x:row r="1" ht="20" outlineLevel="7" customFormat="1"'
      + ' futureFlag="1" ext:R="ignored">'
      + '<x:c r="A1" t="n" s="0" ext:T="ignored"><x:v>42</x:v></x:c>'
      + '</x:row></x:sheetData>'
      + '</x:worksheet>'
  );

  assert.equal(summary.sheetMeta.defaultColWidth, 9);
  assert.equal(summary.sheetMeta.defaultRowHeight, 15);
  assert.equal(summary.sheetMeta.defaultRowHidden, true);
  assert.equal(summary.sheetMeta.columns[0].outlineLevel, 7);
  assert.equal(rows[0].outlineLevel, 7);
  assert.equal(rows[0].cells[0].decodedSemanticValue, 42);
});

test('inlineStr 不拼接同一 plain 容器或同一 rich run 的重复 t', async () => {
  const cases = [
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr">'
      + '<is><t>A</t><t>B</t></is></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr">'
      + '<is><r><t>A</t><t>B</t></r></is></c></row></sheetData></worksheet>'
  ];
  for (const xml of cases) {
    await assertStructureFailure(xml, /只能声明一个直属.*t/);
  }
});

test('显式布尔词法和单元格类型必须可解释，不能静默改成 false 或文本', async () => {
  await assertStructureFailure(
    '<worksheet><sheetData><row r="1"><c r="A1" t="b"><v>2</v></c></row></sheetData></worksheet>',
    /布尔单元格缓存值/
  );
  await assertStructureFailure(
    '<worksheet><sheetData><row r="1"><c r="A1" t="mystery"><v>value</v></c></row></sheetData></worksheet>',
    /不支持的 OOXML 数据类型/
  );

  const { rows } = await scanWorksheetXml(
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="b"><v>true</v></c><c r="B1" t="b"><v>0</v></c>'
      + '</row></sheetData></worksheet>'
  );
  assert.equal(rows[0].cells[0].decodedSemanticValue, true);
  assert.equal(rows[0].cells[1].decodedSemanticValue, false);
});

test('错误单元格仅接受 Excel 合法错误码，缺值或未知错误 fail-closed', async () => {
  const validErrors = [
    '#NULL!',
    '#DIV/0!',
    '#VALUE!',
    '#REF!',
    '#NAME?',
    '#NUM!',
    '#N/A',
    '#GETTING_DATA'
  ];
  const cells = validErrors
    .map((value, index) => (
      `<c r="${String.fromCharCode(65 + index)}1" t="e"><v>${value}</v></c>`
    ))
    .join('');
  const { rows } = await scanWorksheetXml(
    `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`
  );
  assert.deepEqual(
    rows[0].cells.map((cell) => cell.decodedSemanticValue),
    validErrors
  );

  for (const payload of [
    '<c r="A1" t="e"/>',
    '<c r="A1" t="e"><v/></c>',
    '<c r="A1" t="e"><v>1</v></c>',
    '<c r="A1" t="e"><v>undefined</v></c>',
    '<c r="A1" t="e"><v>#FOO!</v></c>'
  ]) {
    await assertStructureFailure(
      `<worksheet><sheetData><row r="1">${payload}</row></sheetData></worksheet>`,
      /错误单元格缓存值.*错误码/
    );
  }
});

test('已消费整数、布尔和单元格坐标属性的显式空值不得按缺省值解释', async () => {
  const cases = [
    '<worksheet><sheetFormatPr customHeight=""/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr zeroHeight=""/><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" hidden=""/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" customWidth=""/></cols><sheetData/></worksheet>',
    '<worksheet><sheetData><row r=""/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" hidden=""/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" customFormat=""/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r=""><v>1</v></c></row></sheetData></worksheet>'
  ];
  for (const xml of cases) {
    await assertStructureFailure(
      xml,
      /boolean|有效整数|单元格坐标无效/
    );
  }
});

test('worksheet 对 v、f、inline t 的超长词法在累计阶段提前拒绝', async () => {
  const rawCellLimitOverflow = 'A'.repeat(32767 * 7 + 1);
  const cases = [
    {
      xml: '<worksheet><sheetData><row r="1">'
        + `<c r="A1" t="n"><v>${rawCellLimitOverflow}</v></c>`
        + '</row></sheetData></worksheet>',
      message: /缓存值词法长度.*上限/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + `<c r="A1" t="n"><f>${'A'.repeat(8193)}</f><v>1</v></c>`
        + '</row></sheetData></worksheet>',
      message: /公式词法长度.*上限/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + `<c r="A1" t="inlineStr"><is><t>${rawCellLimitOverflow}</t></is></c>`
        + '</row></sheetData></worksheet>',
      message: /内联字符串.*读取上限/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + `<c r="A1" t="str"><v>${'A'.repeat(32768)}</v></c>`
        + '</row></sheetData></worksheet>',
      message: /字符串缓存值.*超长|文本上限/
    }
  ];
  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('cell 类型与 v/f/is 载荷必须一致，禁止静默丢弃实际 payload', async () => {
  const cases = [
    {
      xml: '<worksheet><sheetData><row r="1">'
        + '<c r="A1" t="inlineStr"><v>INJECTED</v></c>'
        + '</row></sheetData></worksheet>',
      message: /inlineStr.*v|v.*inlineStr/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + '<c r="A1" t="str"><is><t>INJECTED</t></is></c>'
        + '</row></sheetData></worksheet>',
      message: /is.*inlineStr/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + '<c r="A1" t="n"><is><t>INJECTED</t></is></c>'
        + '</row></sheetData></worksheet>',
      message: /is.*inlineStr/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + '<c r="A1"><is><t>INJECTED</t></is></c>'
        + '</row></sheetData></worksheet>',
      message: /is.*inlineStr/
    },
    {
      xml: '<worksheet><sheetData><row r="1">'
        + '<c r="A1" t="inlineStr"><f>1+1</f></c>'
        + '</row></sheetData></worksheet>',
      message: /inlineStr.*f|f.*inlineStr/
    }
  ];

  for (const item of cases) {
    await assertStructureFailure(item.xml, item.message);
  }
});

test('合法 inline rich text 与字符串/数值公式缓存值保持可解析', async () => {
  const { rows } = await scanWorksheetXml(
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="inlineStr"><is>'
      + '<r><rPr><b/></rPr><t>Rich</t></r><r><t>Text</t></r>'
      + '</is></c>'
      + '<c r="B1" t="str"><f>CONCAT("A","B")</f><v>AB</v></c>'
      + '<c r="C1" t="n"><f>1+2</f><v>3</v></c>'
      + '</row></sheetData></worksheet>'
  );

  assert.equal(rows[0].cells[0].decodedSemanticValue, 'RichText');
  assert.equal(rows[0].cells[1].decodedSemanticValue, 'AB');
  assert.equal(rows[0].cells[1].formulaLexical, 'CONCAT("A","B")');
  assert.equal(rows[0].cells[2].decodedSemanticValue, 3);
  assert.equal(rows[0].cells[2].formulaLexical, '1+2');
});

test('数值与日期 v 必须符合声明类型，不能降级成文本', async () => {
  const cases = [
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="n"><v>not-a-number</v></c>'
      + '</row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1"><v>not-a-number</v></c>'
      + '</row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="d"><v>not-a-date</v></c>'
      + '</row></sheetData></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /缓存值.*声明类型|数值|日期/);
  }
});

test('worksheet 数值单元格快速拒绝会放大 canonical 文本的极端指数', async () => {
  const startedAt = performance.now();
  await assertStructureFailure(
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="n"><v>1e-1000000</v></c>'
      + '</row></sheetData></worksheet>',
    /数值单元格缓存值.*声明类型/
  );
  assert.ok(
    performance.now() - startedAt < 1000,
    '单个极端指数单元格应在 1 秒内拒绝，不能先展开百万字符'
  );

  const { rows } = await scanWorksheetXml(
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="n"><v>1e-300</v></c>'
      + '<c r="B1" t="n"><v>1e308</v></c>'
      + '</row></sheetData></worksheet>'
  );
  assert.equal(rows[0].cells[0].cellType, 'number');
  assert.equal(rows[0].cells[0].rawLexicalValue, '1e-300');
  assert.equal(rows[0].cells[1].cellType, 'number');
  assert.equal(rows[0].cells[1].rawLexicalValue, '1e308');
});

test('t=d 日历或时区词法损坏时 fail-closed，不能冒充范围外日期降级', async () => {
  const cases = [
    '1899-02-29',
    '2026-13-01',
    '2026-01-01T24:00:00',
    '2026-01-01T00:00:00+14:01'
  ];

  for (const rawValue of cases) {
    await assertStructureFailure(
      '<worksheet><sheetData><row r="1">'
        + `<c r="A1" t="d"><v>${rawValue}</v></c>`
        + '</row></sheetData></worksheet>',
      /日期单元格缓存值.*声明类型/
    );
  }
});

test('t=d 日历合法但超 Excel 范围时保留原词法并进入文本降级 warning 链路', async () => {
  const rawValues = [
    '1899-12-31',
    '0001-02-28T12:30:00Z',
    '10000-01-01T23:59:59+08:00'
  ];
  const cellsXml = rawValues
    .map((rawValue, index) => (
      `<c r="${String.fromCharCode(65 + index)}1" t="d"><v>${rawValue}</v></c>`
    ))
    .join('');
  const { rows } = await scanWorksheetXml(
    `<worksheet><sheetData><row r="1">${cellsXml}</row></sheetData></worksheet>`
  );
  const collector = createWarningCollector();

  assert.equal(rows[0].cells.length, rawValues.length);
  rows[0].cells.forEach((cell, index) => {
    assert.equal(cell.cellType, 'date');
    assert.equal(cell.rawLexicalValue, rawValues[index]);
    assert.equal(cell.decodedSemanticValue, rawValues[index]);
    const projected = projectOutputCell(cell, collector);
    assert.equal(projected.value, rawValues[index]);
    assert.equal(projected.numFmtOverride, '@');
  });

  const warningSummary = collector.summary();
  assert.equal(warningSummary.warningCount, rawValues.length);
  assert.deepEqual(
    warningSummary.warningSamples.map((warning) => warning.code),
    rawValues.map(() => 'toolbox-date-text-fallback')
  );
  assert.deepEqual(
    warningSummary.warningSamples.map((warning) => warning.cellRef),
    ['A1', 'B1', 'C1']
  );
});

test('带样式但没有 v 的 t=d 保持 explicit blank，输出不产生日期降级 warning', async () => {
  const { rows } = await scanWorksheetXml(
    '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="d" s="0"/>'
      + '</row></sheetData></worksheet>'
  );
  const cell = rows[0].cells[0];
  const collector = createWarningCollector();

  assert.equal(cell.cellType, 'blank');
  assert.equal(cell.isExplicitCell, true);
  assert.equal(cell.sourceStyleId, 0);
  assert.equal(cell.rawLexicalValue, '');
  assert.deepEqual(projectOutputCell(cell, collector), {
    value: null,
    numFmtOverride: null
  });
  assert.deepEqual(collector.summary(), {
    warningCount: 0,
    warningSamples: []
  });
});

test('布局宽高只接受可由 writer 保真的正有限十进制词法', async () => {
  const cases = [
    '<worksheet><sheetFormatPr defaultColWidth="0x10"/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr defaultRowHeight=" "/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr defaultColWidth="-1"/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr defaultRowHeight="0"/><sheetData/></worksheet>',
    '<worksheet><sheetFormatPr defaultColWidth="1.0000000000000001"/><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" width="0x10"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" width=" "/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" width="-1"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" width="0"/></cols><sheetData/></worksheet>',
    '<worksheet><sheetData><row r="1" ht="0x10"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" ht=" "/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" ht="-1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" ht="0"/></sheetData></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /布局.*数值|宽高|十进制|大于 0|保真/);
  }
});

test('row/col outlineLevel 仅允许 0..7 的整数', async () => {
  const cases = [
    '<worksheet><cols><col min="1" max="1" outlineLevel="-1"/></cols><sheetData/></worksheet>',
    '<worksheet><cols><col min="1" max="1" outlineLevel="8"/></cols><sheetData/></worksheet>',
    '<worksheet><sheetData><row r="1" outlineLevel="-1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" outlineLevel="8"/></sheetData></worksheet>'
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /outlineLevel.*0\.\.7/);
  }
});
