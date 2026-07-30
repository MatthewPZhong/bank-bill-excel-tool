'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const yazl = require('yazl');

const {
  TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES,
  TOOLBOX_XLSX_METADATA_LIMITS,
  ToolboxXlsxCancelledError,
  assertToolboxSharedStringsSize,
  openToolboxXlsxPass,
  parseWorkbookRelationships,
  parseWorkbookXml,
  projectOutputCell,
  readToolboxMetadataEntryAsString,
  toMatchValue
} = require('../../src/backend/toolbox-format');

const TRANSITIONAL_SPREADSHEETML_NAMESPACE =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const TRANSITIONAL_PACKAGE_RELATIONSHIP_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_SPREADSHEETML_NAMESPACE =
  'http://purl.oclc.org/ooxml/spreadsheetml/main';
const STRICT_PACKAGE_RELATIONSHIP_NAMESPACE =
  'http://purl.oclc.org/ooxml/package/relationships';
const STRICT_OFFICE_RELATIONSHIP_NAMESPACE =
  'http://purl.oclc.org/ooxml/officeDocument/relationships';

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-xlsx-'));
  tmpDirs.push(dir);
  return dir;
}

function addBuffer(zip, name, contents) {
  zip.addBuffer(Buffer.from(contents, 'utf8'), name);
}

function writeFixture(overrides = {}) {
  const outputPath = path.join(makeTempDir(), 'fixture.xlsx');
  const workbook = overrides.workbook || ('<?xml version="1.0"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<workbookPr date1904="1"/><sheets>'
    + '<sheet name="Visible" sheetId="1" r:id="rId1"/>'
    + '<sheet name="Hidden" sheetId="2" state="veryHidden" r:id="rId2"/>'
    + '</sheets></workbook>');
  const rels = overrides.rels || ('<?xml version="1.0"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
    + '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + '</Relationships>');
  const theme = overrides.theme || ('<?xml version="1.0"?>'
    + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:themeElements><a:clrScheme name="custom">'
    + '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
    + '<a:dk2><a:srgbClr val="111111"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>'
    + '<a:accent1><a:srgbClr val="123456"/></a:accent1>'
    + '<a:accent2><a:srgbClr val="C0504D"/></a:accent2>'
    + '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>'
    + '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>'
    + '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>'
    + '<a:accent6><a:srgbClr val="F79646"/></a:accent6>'
    + '<a:hlink><a:srgbClr val="0000FF"/></a:hlink>'
    + '<a:folHlink><a:srgbClr val="800080"/></a:folHlink>'
    + '</a:clrScheme></a:themeElements></a:theme>');
  const styles = overrides.styles || ('<?xml version="1.0"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><color theme="1"/></font>'
    + '<font><b/><sz val="12"/><name val="Arial"/><color theme="4"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFCC00"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '</cellXfs></styleSheet>');
  const sharedStrings = overrides.sharedStrings || ('<?xml version="1.0"?>'
    + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">'
    + '<si><t> Header </t></si></sst>');
  const visibleSheet = overrides.visibleSheet || ('<?xml version="1.0"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetFormatPr defaultColWidth="9" defaultRowHeight="15" customHeight="1"/>'
    + '<cols><col min="2" max="3" width="22" customWidth="1" hidden="1" outlineLevel="2" style="1"/></cols>'
    + '<sheetData>'
    + '<row r="1" ht="30" customHeight="1" hidden="1" outlineLevel="1" s="1" customFormat="1">'
    + '<c r="A1" t="s"><v>0</v></c>'
    + '<c r="XFD1" t="inlineStr" s="1"><is><t>Tail</t></is></c>'
    + '</row>'
    + '<row r="2">'
    + '<c r="A2" s="1"><v>001.2300</v></c>'
    + '<c r="B2" t="b"><v>1</v></c>'
    + '<c r="C2" s="2"><f>1+1</f><v>2</v></c>'
    + '<c r="D2" s="1"/>'
    + '<c r="E2" t="d"><v>2026-07-29T08:30:00-04:00</v></c>'
    + '<c r="F2" t="e"><v>#DIV/0!</v></c>'
    + '</row>'
    + '<row><c t="inlineStr"><is><t>A</t><r><t>B</t></r></is></c></row>'
    + '</sheetData></worksheet>');
  const hiddenSheet = '<?xml version="1.0"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData>'
    + '</worksheet>';

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    addBuffer(zip, 'xl/workbook.xml', workbook);
    if (overrides.includeRels !== false) addBuffer(zip, 'xl/_rels/workbook.xml.rels', rels);
    if (overrides.includeTheme !== false) addBuffer(zip, 'xl/theme/theme1.xml', theme);
    if (overrides.includeStyles !== false) addBuffer(zip, 'xl/styles.xml', styles);
    if (overrides.includeSharedStrings !== false) addBuffer(zip, 'xl/sharedStrings.xml', sharedStrings);
    addBuffer(zip, 'xl/worksheets/sheet2.xml', visibleSheet);
    addBuffer(zip, 'xl/worksheets/sheet1.xml', hiddenSheet);
    zip.outputStream.pipe(fs.createWriteStream(outputPath))
      .on('close', () => resolve(outputPath))
      .on('error', reject);
    zip.end();
  });
}

test.describe('toolbox-format xlsx pass/scanner', () => {
  test('一次 pass 解析 workbook/styles/theme/SST，并按显示顺序流式产出稀疏 ToolboxRow', async () => {
    const fixture = await writeFixture();
    const pass = await openToolboxXlsxPass(fixture, { sourceRegistryId: 'fixture-registry' });
    try {
      assert.equal(pass.date1904, true);
      assert.deepEqual(pass.sheets.map((sheet) => [sheet.name, sheet.state, sheet.entryPath]), [
        ['Visible', 'visible', 'xl/worksheets/sheet2.xml'],
        ['Hidden', 'veryHidden', 'xl/worksheets/sheet1.xml']
      ]);
      assert.equal(pass.sharedStrings[0], ' Header ');
      assert.equal(pass.themeColors.accent1, 'FF123456');

      const metas = [];
      const rows = [];
      const summary = await pass.scanSheet(0, {
        onSheetMeta: (meta) => metas.push(meta),
        onRow: (row) => rows.push(row)
      });
      assert.equal(metas.length, 1);
      assert.equal(summary.rowCount, 3);
      assert.equal(summary.explicitCellCount, 9);
      assert.equal(summary.maxColumnIndex, 16383);
      assert.equal(rows.length, 3);
      assert.equal(rows[0].cells.length, 2, 'XFD 不得导致中间 16k 隐式空白物化');
      assert.deepEqual(rows[0].cells.map((cell) => cell.columnIndex), [0, 16383]);

      const meta = metas[0];
      assert.equal(meta.defaultColWidth, 9);
      assert.equal(meta.defaultRowHeight, 15);
      assert.equal(meta.customHeight, true);
      assert.equal(meta.columns.length, 1);
      assert.deepEqual(
        [meta.columns[0].minColumnIndex, meta.columns[0].maxColumnIndex, meta.columns[0].width],
        [1, 2, 22]
      );
      assert.equal(meta.columns[0].hidden, true);
      assert.equal(meta.columns[0].outlineLevel, 2);

      assert.equal(rows[0].height, 30);
      assert.equal(rows[0].hidden, true);
      assert.equal(rows[0].outlineLevel, 1);
      assert.equal(rows[0].customFormat, true);
      assert.equal(toMatchValue(rows[0].cells[0]), 'Header');
      assert.equal(toMatchValue(rows[0].cells[1]), 'Tail');

      const [numeric, bool, formulaDate, blank, wallClock, error] = rows[1].cells;
      assert.equal(toMatchValue(numeric), '1.23', '匹配值对齐普通 XLSX 旧路径 String(parseFloat)');
      assert.equal(numeric.rawLexicalValue, '001.2300');
      assert.equal(numeric.sourceFormat, 'General');
      assert.equal(numeric.effectiveStyleRef.sourceRegistryId, 'fixture-registry');
      assert.equal(toMatchValue(bool), 'TRUE');
      assert.equal(bool.decodedSemanticValue, true);
      assert.equal(formulaDate.hasFormula, true);
      assert.equal(formulaDate.formulaLexical, '1+1');
      assert.equal(formulaDate.sourceFormat, 'mm-dd-yy');
      assert.equal(projectOutputCell(formulaDate).canonicalValue, '1464');
      assert.equal(blank.cellType, 'blank');
      assert.equal(blank.isExplicitCell, true);
      const wallClockOutput = projectOutputCell(wallClock);
      assert.equal(wallClockOutput.numFmtOverride, 'yyyy-mm-dd hh:mm:ss');
      assert.equal(wallClockOutput.value, projectOutputCell({
        ...wallClock,
        rawLexicalValue: '2026-07-29T08:30:00Z'
      }).value, 't=d 忽略 offset，按 wall-clock 转换');
      assert.deepEqual(projectOutputCell(error).value, { error: '#DIV/0!' });
      assert.equal(rows[2].rowIndex, 3, '缺 row r 时按上一行递增');
      assert.equal(toMatchValue(rows[2].cells[0]), 'AB', 'inline rich text 拼接全部 t run');
    } finally {
      pass.close();
    }
  });

  test('workbook、Relationships 与 SST 接受 Strict OOXML namespace', async () => {
    const workbook = '<?xml version="1.0"?>'
      + `<workbook xmlns="${STRICT_SPREADSHEETML_NAMESPACE}"`
      + ` xmlns:rel="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}">`
      + '<workbookPr date1904="false"/><sheets>'
      + '<sheet xmlns:id="urn:extension" name="Visible" sheetId="1" rel:id="rId1"/>'
      + '<sheet name="Hidden" sheetId="2" state="hidden" rel:id="rId2"/>'
      + '</sheets></workbook>';
    const rels = '<?xml version="1.0"?>'
      + `<Relationships xmlns="${STRICT_PACKAGE_RELATIONSHIP_NAMESPACE}">`
      + `<Relationship Id="rId1" Type="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}/worksheet" Target="worksheets/sheet2.xml" TargetMode="Internal"/>`
      + `<Relationship Id="rId2" Type="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId3" Type="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId4" Type="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}/theme" Target="theme/theme1.xml"/>`
      + `<Relationship Id="rId5" Type="${STRICT_OFFICE_RELATIONSHIP_NAMESPACE}/sharedStrings" Target="sharedStrings.xml"/>`
      + '</Relationships>';
    const sharedStrings = '<?xml version="1.0"?>'
      + `<sst xmlns="${STRICT_SPREADSHEETML_NAMESPACE}"><si><t>Strict</t></si></sst>`;
    const fixture = await writeFixture({ workbook, rels, sharedStrings });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      assert.equal(pass.date1904, false);
      assert.deepEqual(pass.sheets.map((sheet) => sheet.name), ['Visible', 'Hidden']);
      assert.deepEqual(pass.sharedStrings, ['Strict']);
    } finally {
      pass.close();
    }
  });

  test('workbook 与 Relationships 接受 Transitional/Strict 的任意合法 namespace prefix', () => {
    for (const namespaces of [
      {
        spreadsheet: TRANSITIONAL_SPREADSHEETML_NAMESPACE,
        packageRelationship: TRANSITIONAL_PACKAGE_RELATIONSHIP_NAMESPACE,
        officeRelationship: TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE
      },
      {
        spreadsheet: STRICT_SPREADSHEETML_NAMESPACE,
        packageRelationship: STRICT_PACKAGE_RELATIONSHIP_NAMESPACE,
        officeRelationship: STRICT_OFFICE_RELATIONSHIP_NAMESPACE
      }
    ]) {
      const workbook = parseWorkbookXml(
        `<ss:workbook xmlns:ss="${namespaces.spreadsheet}" ` +
          `xmlns:link="${namespaces.officeRelationship}" xmlns:ext="urn:example:extension">`
          + '<ss:workbookPr date1904="1"/><ext:metadata/><ss:sheets>'
          + '<ss:sheet name="Prefixed" state="hidden" link:id="rId1" '
          + 'ext:id="ignored" ext:Id="also-ignored" ext:flag="1"/>'
          + '</ss:sheets></ss:workbook>'
      );
      assert.equal(workbook.date1904, true);
      assert.deepEqual(workbook.sheets, [{
        name: 'Prefixed',
        relationshipId: 'rId1',
        state: 'hidden'
      }]);

      const relationships = parseWorkbookRelationships(
        `<pkg:Relationships xmlns:pkg="${namespaces.packageRelationship}" ` +
          'xmlns:ext="urn:example:extension"><ext:metadata/>'
          + `<pkg:Relationship Id="rId1" Type="${namespaces.officeRelationship}/worksheet" `
          + 'Target="worksheets/sheet1.xml" TargetMode="Internal" ext:flag="1"/>'
          + '</pkg:Relationships>'
      );
      assert.deepEqual(relationships.get('rId1'), {
        id: 'rId1',
        type: `${namespaces.officeRelationship}/worksheet`,
        target: 'xl/worksheets/sheet1.xml',
        targetMode: 'Internal'
      });
    }
  });

  test('同一 pass 禁止并发扫描，关闭后不能继续读取', async () => {
    const fixture = await writeFixture();
    const pass = await openToolboxXlsxPass(fixture, { sourceRegistryId: 'fixture-registry-2' });
    pass.close();
    await assert.rejects(() => pass.scanSheet(0), /已关闭/);
  });

  test('专用 SST/inline rich parser 拼正常 t run，并忽略 rPh/phoneticPr', async () => {
    const sharedStrings = '<?xml version="1.0"?>'
      + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<si><r><t>A</t></r><r><t>B</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh>'
      + '<phoneticPr fontId="1"/></si></sst>';
    const visibleSheet = '<?xml version="1.0"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c>'
      + '<c r="B1" t="inlineStr"><is><t>X</t><rPh sb="0" eb="1"><t>IGNORE</t></rPh>'
      + '<r><t>Y</t></r><phoneticPr fontId="1"/></is></c></row>'
      + '</sheetData></worksheet>';
    const fixture = await writeFixture({ sharedStrings, visibleSheet });
    const pass = await openToolboxXlsxPass(fixture, { sourceRegistryId: 'rich-registry' });
    try {
      assert.deepEqual(pass.sharedStrings, ['AB']);
      const rows = [];
      await pass.scanSheet(0, { onRow: (row) => rows.push(row) });
      assert.equal(toMatchValue(rows[0].cells[0]), 'AB');
      assert.equal(toMatchValue(rows[0].cells[1]), 'XY');
    } finally {
      pass.close();
    }
  });

  test('inline/str 文本按独立 t/v 单次解码 ST_Xstring，不跨 rich run 合并 escape', async () => {
    const visibleSheet = '<?xml version="1.0"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1">'
      + '<c r="A1" t="inlineStr"><is><r><t>_x00</t></r><r><t>41_</t></r></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>_x0042_</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>_x005F_x0043_</t></is></c>'
      + '<c r="D1" t="str"><f>TEXT()</f><v>_X0044_</v></c>'
      + '</row></sheetData></worksheet>';
    const fixture = await writeFixture({ visibleSheet });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      const rows = [];
      await pass.scanSheet(0, { onRow: (row) => rows.push(row) });
      assert.deepEqual(
        rows[0].cells.map((cell) => cell.decodedSemanticValue),
        ['_x0041_', 'B', '_x0043_', 'D']
      );
    } finally {
      pass.close();
    }
  });

  test('重叠 col 范围保留 XML 声明顺序，后声明范围继续覆盖前声明范围', async () => {
    const visibleSheet = '<?xml version="1.0"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<cols><col min="2" max="3" width="20" customWidth="1"/>'
      + '<col min="1" max="2" width="10" customWidth="1"/></cols>'
      + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>B</t></is></c></row></sheetData></worksheet>';
    const fixture = await writeFixture({ visibleSheet });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      let meta;
      await pass.scanSheet(0, { onSheetMeta: (value) => { meta = value; } });
      assert.deepEqual(
        meta.columns.map((column) => [
          column.minColumnIndex,
          column.maxColumnIndex,
          column.width
        ]),
        [[1, 2, 20], [0, 1, 10]]
      );
    } finally {
      pass.close();
    }
  });

  test('共享字符串索引越界 fail-closed，不静默变空串', async () => {
    const visibleSheet = '<?xml version="1.0"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>9</v></c></row>'
      + '</sheetData></worksheet>';
    const fixture = await writeFixture({ visibleSheet });
    const pass = await openToolboxXlsxPass(fixture, { sourceRegistryId: 'bad-sst-registry' });
    try {
      await assert.rejects(
        () => pass.scanSheet(0),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
          assert.match(error.message, /共享字符串索引越界/);
          assert.equal(error.context.sharedStringIndex, '9');
          return true;
        }
      );
    } finally {
      pass.close();
    }
  });

  test('row r 非严格递增、同 row 重复 cell 坐标均 fail-closed', async () => {
    const cases = [
      {
        fragment: '<row r="2"><c r="A2"><v>1</v></c></row><row r="1"><c r="A1"><v>2</v></c></row>',
        message: /row r 必须严格递增/
      },
      {
        fragment: '<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
        message: /重复单元格坐标/
      }
    ];
    for (const item of cases) {
      const visibleSheet = '<?xml version="1.0"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        + item.fragment
        + '</sheetData></worksheet>';
      const fixture = await writeFixture({ visibleSheet });
      const pass = await openToolboxXlsxPass(fixture);
      try {
        await assert.rejects(() => pass.scanSheet(0), item.message);
      } finally {
        pass.close();
      }
    }
  });

  test('截断 worksheet/cell/row XML 必须 fail-closed，不得把已解析前缀当成功', async () => {
    const visibleSheet = '<?xml version="1.0"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>123';
    const fixture = await writeFixture({ visibleSheet });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      await assert.rejects(
        () => pass.scanSheet(0),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
          assert.match(error.message, /XML|截断|损坏|闭合/);
          return true;
        }
      );
    } finally {
      pass.close();
    }
  });

  test('截断 workbook.xml 必须在打开阶段失败，不得只处理已解析的工作表前缀', async () => {
    const workbook = '<?xml version="1.0"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
      + '<sheet name="Hidden" sheetId="2" r:id="rId2"/>';
    const fixture = await writeFixture({ workbook });
    await assert.rejects(
      () => openToolboxXlsxPass(fixture),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
        assert.match(error.message, /workbook\.xml.*完整|XML|闭合/);
        return true;
      }
    );
  });

  test('sheet 只能是唯一 sheets 容器直属，wrapper 中的额外 Sheet 不得被静默漏读', async () => {
    const workbook = '<?xml version="1.0"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
      + '<wrapper><sheet name="Hidden" sheetId="2" r:id="rId2"/></wrapper>'
      + '</sheets></workbook>';
    const fixture = await writeFixture({ workbook });
    await assert.rejects(
      () => openToolboxXlsxPass(fixture),
      /sheet.*sheets.*直接子元素/
    );
  });

  test('workbookPr 必须是 workbook 直属且最多一个，错层或重复均 fail-closed', async () => {
    const cases = [
      '<wrapper><workbookPr date1904="1"/></wrapper>',
      '<workbookPr date1904="1"/><workbookPr date1904="0"/>'
    ];
    for (const workbookPrXml of cases) {
      const workbook = '<?xml version="1.0"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + workbookPrXml
        + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
        + '<sheet name="Hidden" sheetId="2" r:id="rId2"/></sheets></workbook>';
      const fixture = await writeFixture({ workbook });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        /workbookPr.*直接子元素|重复.*workbookPr/
      );
    }
  });

  test('workbookPr.date1904 若存在仅接受 OOXML boolean 词法', async () => {
    for (const [lexical, expected] of [
      ['0', false],
      ['1', true],
      ['false', false],
      ['true', true]
    ]) {
      const workbook = '<?xml version="1.0"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<workbookPr date1904="${lexical}"/>`
        + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
        + '<sheet name="Hidden" sheetId="2" r:id="rId2"/></sheets></workbook>';
      const fixture = await writeFixture({ workbook });
      const pass = await openToolboxXlsxPass(fixture);
      try {
        assert.equal(pass.date1904, expected);
      } finally {
        pass.close();
      }
    }

    for (const lexical of ['yes', '2', 'TRUE', '']) {
      const workbook = '<?xml version="1.0"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<workbookPr date1904="${lexical}"/>`
        + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
        + '<sheet name="Hidden" sheetId="2" r:id="rId2"/></sheets></workbook>';
      const fixture = await writeFixture({ workbook });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        /date1904.*0\/1\/true\/false/
      );
    }
  });

  test('workbook extLst/ext 内允许 foreign namespace 扩展同名元素', () => {
    const workbook = `<workbook xmlns="${TRANSITIONAL_SPREADSHEETML_NAMESPACE}"`
      + ` xmlns:r="${TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE}"`
      + ' xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">'
      + '<workbookPr date1904="1"/>'
      + '<sheets><sheet name="A" r:id="rId1"/></sheets>'
      + '<extLst><ext uri="{fixture}"><x15:workbookPr DATE1904="bad"/>'
      + '</ext></extLst></workbook>';
    assert.deepEqual(parseWorkbookXml(workbook), {
      date1904: true,
      sheets: [{ name: 'A', relationshipId: 'rId1', state: 'visible' }]
    });
  });

  test('foreign namespace 扩展仅能位于 workbook 直属 extLst/ext 内', () => {
    const prefix = `<workbook xmlns="${TRANSITIONAL_SPREADSHEETML_NAMESPACE}"`
      + ` xmlns:r="${TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE}"`
      + ' xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">';
    const sheet = '<sheet name="A" r:id="rId1"/>';
    const suffix = '</workbook>';
    const misplaced = [
      prefix + '<sheets>' + sheet + '</sheets><wrapper><extLst><ext uri="{fixture}">'
        + '<x15:workbookPr/></ext></extLst></wrapper>' + suffix,
      prefix + '<sheets>' + sheet + '<extLst><ext uri="{fixture}">'
        + '<x15:sheet/></ext></extLst></sheets>' + suffix
    ];
    for (const workbook of misplaced) {
      assert.throws(() => parseWorkbookXml(workbook), /namespace 无效或缺失/);
    }

    const invalidCorePayload = [
      '<workbookPR/>',
      '<workbookPr/>'
    ];
    for (const payload of invalidCorePayload) {
      const workbook = prefix + '<sheets>' + sheet + '</sheets>'
        + `<extLst><ext uri="{fixture}">${payload}</ext></extLst>` + suffix;
      assert.throws(
        () => parseWorkbookXml(workbook),
        /大小写无效.*规范名称|workbookPr 必须是 workbook 的直接子元素/
      );
    }
  });

  test('sheet state 缺省为 visible，三种 OOXML 枚举值均保持原值', () => {
    const workbook = '<?xml version="1.0"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>'
      + '<sheet name="Default" sheetId="1" r:id="rId1"/>'
      + '<sheet name="Visible" sheetId="2" state="visible" r:id="rId2"/>'
      + '<sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>'
      + '<sheet name="VeryHidden" sheetId="4" state="veryHidden" r:id="rId4"/>'
      + '</sheets></workbook>';

    assert.deepEqual(
      parseWorkbookXml(workbook).sheets.map((sheet) => [sheet.name, sheet.state]),
      [
        ['Default', 'visible'],
        ['Visible', 'visible'],
        ['Hidden', 'hidden'],
        ['VeryHidden', 'veryHidden']
      ]
    );
  });

  test('sheet state 显式非法值在打开阶段 fail-closed，不按 visible 兜底', async () => {
    for (const state of ['mystery', 'Visible', 'veryhidden', '', ' hidden ']) {
      const workbook = '<?xml version="1.0"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets><sheet name="Visible" sheetId="1" state="${state}" r:id="rId1"/>`
        + '<sheet name="Hidden" sheetId="2" r:id="rId2"/></sheets></workbook>';
      const fixture = await writeFixture({ workbook });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
          assert.match(error.message, /state.*visible\/hidden\/veryHidden/);
          assert.equal(error.context.sheetName, 'Visible');
          assert.equal(error.context.state, state);
          return true;
        }
      );
    }
  });

  test('workbook 识别节点与关系 id 遇到缺失或未知 namespace 时 fail-closed', () => {
    const validSpreadsheetNamespace =
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const validOfficeRelationshipNamespace =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const cases = [
      [
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + '<sheets><sheet name="Visible" r:id="rId1"/></sheets></workbook>',
        /workbook\.xml.*namespace.*无效或缺失/
      ],
      [
        '<workbook xmlns="urn:invalid:spreadsheetml"'
          + ` xmlns:r="${validOfficeRelationshipNamespace}">`
          + '<sheets><sheet name="Visible" r:id="rId1"/></sheets></workbook>',
        /workbook\.xml.*namespace.*无效或缺失/
      ],
      [
        `<workbook xmlns="${validSpreadsheetNamespace}"`
          + ` xmlns:r="${validOfficeRelationshipNamespace}" xmlns:x="urn:invalid:sheet">`
          + '<sheets><x:sheet name="Visible" r:id="rId1"/></sheets></workbook>',
        /x:sheet.*namespace.*无效或缺失/
      ],
      [
        `<workbook xmlns="${validSpreadsheetNamespace}" xmlns:r="urn:invalid:relationship">`
          + '<sheets><sheet name="Visible" r:id="rId1"/></sheets></workbook>',
        /r:id namespace.*无效或缺失/
      ],
      [
        `<workbook xmlns="${validSpreadsheetNamespace}">`
          + '<sheets><sheet name="Visible" id="rId1"/></sheets></workbook>',
        /r:id namespace.*无效或缺失/
      ]
    ];

    for (const [workbook, message] of cases) {
      assert.throws(() => parseWorkbookXml(workbook), message);
    }
  });

  test('workbook 业务元素与已消费属性必须精确匹配规范大小写', () => {
    const spreadsheetNamespace = TRANSITIONAL_SPREADSHEETML_NAMESPACE;
    const officeRelationshipNamespace = TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE;
    const cases = [
      `<Workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<sheets><sheet name="A" r:id="rId1"/></sheets></Workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<workbookPR date1904="1"/><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<Sheets><sheet name="A" r:id="rId1"/></Sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<sheets><Sheet name="A" r:id="rId1"/></sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<sheets><sheet NAME="A" r:id="rId1"/></sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<sheets><sheet name="A" STATE="hidden" r:id="rId1"/></sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<sheets><sheet name="A" r:ID="rId1"/></sheets></workbook>',
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}">`
        + '<workbookPr DATE1904="1"/><sheets>'
        + '<sheet name="A" r:id="rId1"/></sheets></workbook>'
    ];

    for (const workbook of cases) {
      assert.throws(() => parseWorkbookXml(workbook), /大小写无效.*规范名称/);
    }
  });

  test('Relationships 元素与 Id/Type/Target/TargetMode 必须精确匹配规范大小写', () => {
    const packageNamespace = TRANSITIONAL_PACKAGE_RELATIONSHIP_NAMESPACE;
    const officeNamespace = TRANSITIONAL_OFFICE_RELATIONSHIP_NAMESPACE;
    const canonicalAttributes =
      `Id="rId1" Type="${officeNamespace}/worksheet" ` +
      'Target="worksheets/sheet1.xml" TargetMode="Internal"';
    const cases = [
      `<relationships xmlns="${packageNamespace}">`
        + `<Relationship ${canonicalAttributes}/></relationships>`,
      `<Relationships xmlns="${packageNamespace}">`
        + `<relationship ${canonicalAttributes}/></Relationships>`,
      `<Relationships xmlns="${packageNamespace}">`
        + `<Relationship id="rId1" Type="${officeNamespace}/worksheet" `
        + 'Target="worksheets/sheet1.xml"/></Relationships>',
      `<Relationships xmlns="${packageNamespace}">`
        + `<Relationship Id="rId1" type="${officeNamespace}/worksheet" `
        + 'Target="worksheets/sheet1.xml"/></Relationships>',
      `<Relationships xmlns="${packageNamespace}">`
        + `<Relationship Id="rId1" Type="${officeNamespace}/worksheet" `
        + 'target="worksheets/sheet1.xml"/></Relationships>',
      `<Relationships xmlns="${packageNamespace}">`
        + `<Relationship Id="rId1" Type="${officeNamespace}/worksheet" `
        + 'Target="worksheets/sheet1.xml" targetMode="Internal"/></Relationships>'
    ];

    for (const relationships of cases) {
      assert.throws(
        () => parseWorkbookRelationships(relationships),
        /大小写无效.*规范名称/
      );
    }
  });

  test('Relationships 识别节点 namespace 与 TargetMode 枚举非法时 fail-closed', () => {
    const validPackageNamespace =
      'http://schemas.openxmlformats.org/package/2006/relationships';
    const relationship =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>';
    const cases = [
      [
        `<Relationships>${relationship}</Relationships>`,
        /Relationships.*namespace.*无效或缺失/
      ],
      [
        `<Relationships xmlns="urn:invalid:relationships">${relationship}</Relationships>`,
        /Relationships.*namespace.*无效或缺失/
      ],
      [
        `<Relationships xmlns="${validPackageNamespace}" xmlns:x="urn:invalid:relationship">`
          + '<x:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>',
        /x:Relationship.*namespace.*无效或缺失/
      ],
      [
        `<Relationships xmlns="${validPackageNamespace}">`
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
          + ' Target="worksheets/sheet1.xml" TargetMode="Bogus"/>'
          + '</Relationships>',
        /TargetMode.*Bogus/
      ],
      [
        `<Relationships xmlns="${validPackageNamespace}">`
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
          + ' Target="worksheets/sheet1.xml" TargetMode=""/>'
          + '</Relationships>',
        /无效 TargetMode/
      ],
      [
        `<Relationships xmlns="${validPackageNamespace}">`
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
          + ' Target="worksheets/sheet1.xml" TargetMode="   "/>'
          + '</Relationships>',
        /无效 TargetMode/
      ]
    ];

    for (const [rels, message] of cases) {
      assert.throws(() => parseWorkbookRelationships(rels), message);
    }
  });

  test('重复 relationship Id、工作表 r:id 和 worksheet entry path 均 fail-closed', async () => {
    const duplicateRel = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>';
    const duplicateRidWorkbook = '<?xml version="1.0"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
      + '<sheet name="Hidden" sheetId="2" r:id="rId1"/></sheets></workbook>';
    const duplicatePathRels = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '</Relationships>';

    for (const [overrides, message] of [
      [{ rels: duplicateRel }, /重复.*关系 Id/],
      [{ workbook: duplicateRidWorkbook }, /重复.*r:id/],
      [{ rels: duplicatePathRels }, /同一 worksheet entry/]
    ]) {
      const fixture = await writeFixture(overrides);
      await assert.rejects(() => openToolboxXlsxPass(fixture), message);
    }
  });

  test('工作表名称按 Excel 语义大小写不敏感唯一，冲突时在打开阶段失败', async () => {
    const workbook = '<?xml version="1.0"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>'
      + '<sheet name="visible" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const fixture = await writeFixture({ workbook });
    await assert.rejects(
      () => openToolboxXlsxPass(fixture),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
        assert.match(error.message, /大小写不敏感的重复工作表名/);
        assert.equal(error.context.sheetName, 'visible');
        assert.equal(error.context.conflictingSheetName, 'Visible');
        return true;
      }
    );
  });

  test('工作表关系缺失、类型错误、外部关系或 entry 不存在均在打开阶段失败', async () => {
    const relationCases = [
      [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>',
        /缺少对应/
      ],
      [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="worksheets/sheet2.xml"/>'
          + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>',
        /不是有效 worksheet/
      ],
      [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="https://example.invalid/sheet.xml" TargetMode="External"/>'
          + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>',
        /不是有效 worksheet/
      ],
      [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/missing.xml"/>'
          + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>',
        /entry 不存在/
      ]
    ];
    for (const [rels, message] of relationCases) {
      const fixture = await writeFixture({ rels });
      await assert.rejects(() => openToolboxXlsxPass(fixture), message);
    }
  });

  test('Relationship Type 必须精确命中 Office URI，同后缀恶意 URI 四类均 fail-closed', async () => {
    const officeRelationshipNamespace =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const validWorksheetRelationships =
      `<Relationship Id="rId1" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/>`
      + `<Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/>`;
    const cases = [
      {
        kind: 'worksheet',
        target: 'worksheets/sheet2.xml',
        relationships:
          '<Relationship Id="rId1" Type="urn:evil/worksheet" Target="worksheets/sheet2.xml"/>'
          + `<Relationship Id="rId2" Type="${officeRelationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/>`,
        message: /不是有效 worksheet/
      },
      {
        kind: 'styles',
        target: 'styles.xml',
        relationships: validWorksheetRelationships
          + '<Relationship Id="rId3" Type="urn:evil/styles" Target="styles.xml"/>',
        message: /错误 Type.*styles/
      },
      {
        kind: 'theme',
        target: 'theme/theme1.xml',
        relationships: validWorksheetRelationships
          + '<Relationship Id="rId3" Type="urn:evil/theme" Target="theme/theme1.xml"/>',
        message: /错误 Type.*theme/
      },
      {
        kind: 'sharedStrings',
        target: 'sharedStrings.xml',
        relationships: validWorksheetRelationships
          + '<Relationship Id="rId3" Type="urn:evil/sharedStrings" Target="sharedStrings.xml"/>',
        message: /错误 Type.*sharedStrings/i
      }
    ];

    for (const item of cases) {
      const rels = '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + item.relationships
        + '</Relationships>';
      const fixture = await writeFixture({ rels });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
          assert.match(error.message, item.message);
          const observedType = error.context.relationshipType ||
            (error.context.conflictingRelationships &&
              error.context.conflictingRelationships[0] &&
              error.context.conflictingRelationships[0].relationshipType);
          assert.equal(observedType, `urn:evil/${item.kind}`);
          return true;
        },
        `应拒绝 ${item.kind} 的同后缀恶意 Type（target=${item.target}）`
      );
    }
  });

  test('已声明的 sharedStrings/styles/theme 关系异常时不得回退固定路径', async () => {
    const worksheetRelationships =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>';
    const metadataRelationships = [
      {
        label: 'styles',
        type: 'styles',
        target: 'styles.xml',
        missingTarget: 'missing-styles.xml'
      },
      {
        label: 'theme',
        type: 'theme',
        target: 'theme/theme1.xml',
        missingTarget: 'theme/missing.xml'
      },
      {
        label: 'sharedStrings',
        type: 'sharedStrings',
        target: 'sharedStrings.xml',
        missingTarget: 'missing-sharedStrings.xml'
      }
    ];
    const relationshipCases = [
      {
        message: /目标 entry 不存在/,
        build: (metadata) =>
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${metadata.type}" Target="${metadata.missingTarget}"/>`
      },
      {
        message: /不得指向外部目标/,
        build: (metadata) =>
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${metadata.type} " Target="https://example.invalid/${metadata.label}.xml" TargetMode=" External "/>`
      },
      {
        message: /重复声明/,
        build: (metadata) =>
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${metadata.type}" Target="${metadata.target}"/>`
          + `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${metadata.type}" Target="${metadata.target}"/>`
      }
    ];

    for (const metadata of metadataRelationships) {
      for (const relationCase of relationshipCases) {
        const rels = '<?xml version="1.0"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + worksheetRelationships
          + relationCase.build(metadata)
          + '</Relationships>';
        const fixture = await writeFixture({ rels });
        await assert.rejects(
          () => openToolboxXlsxPass(fixture),
          (error) => {
            assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
            assert.match(error.message, new RegExp(metadata.label, 'i'));
            assert.match(error.message, relationCase.message);
            return true;
          }
        );
      }
    }
  });

  test('wrapper 中的 sharedStrings/styles/theme Relationship 不得被忽略后固定路径回退', async () => {
    const metadataTypes = ['sharedStrings', 'styles', 'theme'];
    for (const metadataType of metadataTypes) {
      const rels = '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '<wrapper>'
        + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${metadataType}" Target="missing.xml"/>`
        + '</wrapper></Relationships>';
      const fixture = await writeFixture({ rels });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        /Relationship.*Relationships.*直接子元素/
      );
    }
  });

  test('错误 Type 的 Relationship 占用标准 metadata 路径时不得 fallback', async () => {
    const metadataTargets = [
      ['sharedStrings', 'sharedStrings.xml'],
      ['styles', 'styles.xml'],
      ['theme', 'theme/theme1.xml']
    ];
    for (const [metadataType, target] of metadataTargets) {
      const rels = '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + `<Relationship Id="rId3" Type="urn:example:wrong-${metadataType}" Target="${target}"/>`
        + '</Relationships>';
      const fixture = await writeFixture({ rels });
      await assert.rejects(
        () => openToolboxXlsxPass(fixture),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
          assert.match(error.message, new RegExp(`错误 Type.*${metadataType}`, 'i'));
          assert.equal(error.context.fallbackPath, `xl/${target}`);
          return true;
        }
      );
    }
  });

  test('sharedStrings/styles/theme 关系完全不存在时兼容规范固定 entry', async () => {
    const rels = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>';
    const fixture = await writeFixture({ rels });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      assert.deepEqual(pass.sharedStrings, [' Header ']);
      assert.equal(pass.themeColors.accent1, 'FF123456');
      const sourceStyle = pass.sourceRegistry.get(pass.sourceRegistry.styleRefForXf(1));
      assert.equal(sourceStyle.font.name, 'Arial');
      assert.equal(sourceStyle.font.bold, true);
    } finally {
      pass.close();
    }
  });

  test('存在但截断的 SST/styles/theme 均 fail-closed，缺少可选 entry 仍使用默认语义', async () => {
    const invalidCases = [
      [{ sharedStrings: '<sst><si><t>A</t>' }, /sharedStrings\.xml/],
      [{
        styles: '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
          + '<cellXfs><xf numFmtId="14"'
      }, /styles\.xml/],
      [{
        theme: '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
          + '<a:themeElements><a:clrScheme><a:accent1><a:srgbClr val="123456"/>'
      }, /theme\.xml/],
      [{
        theme: '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
          + '<a:themeElements><a:clrScheme>'
          + '<a:dk1><a:srgbClr val="000000"/></a:dk1>'
          + '</a:clrScheme></a:themeElements></a:theme>'
      }, /缺少必需颜色槽/]
    ];
    for (const [overrides, message] of invalidCases) {
      const fixture = await writeFixture(overrides);
      await assert.rejects(() => openToolboxXlsxPass(fixture), message);
    }

    const relsWithoutOptionalMetadata = '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>';
    const fixture = await writeFixture({
      rels: relsWithoutOptionalMetadata,
      includeTheme: false,
      includeStyles: false,
      includeSharedStrings: false
    });
    const pass = await openToolboxXlsxPass(fixture);
    try {
      assert.equal(pass.sharedStrings.length, 0);
      assert.equal(pass.themeColors.accent1, 'FF4F81BD');
      assert.equal(pass.sourceRegistry.get(pass.sourceRegistry.defaultStyleRef).numFmt, 'General');
    } finally {
      pass.close();
    }
  });

  test('取消抛专用错误，不返回 partial success；SST >=1.2GB 在打开流前拒绝', async () => {
    const fixture = await writeFixture();
    const pass = await openToolboxXlsxPass(fixture);
    try {
      await assert.rejects(
        () => pass.scanSheets({ cancelToken: { cancelled: true } }),
        (error) => error instanceof ToolboxXlsxCancelledError &&
          error.code === 'TOOLBOX_XLSX_CANCELLED'
      );
      const token = { cancelled: false };
      await assert.rejects(
        () => pass.scanSheet(0, {
          cancelToken: token,
          onRow: () => { token.cancelled = true; }
        }),
        (error) => error instanceof ToolboxXlsxCancelledError
      );
    } finally {
      pass.close();
    }

    assert.throws(
      () => assertToolboxSharedStringsSize({
        uncompressedSize: TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES
      }, 'large.xlsx'),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_XLSX_SHARED_STRINGS_TOO_LARGE');
        assert.match(error.message, /共享字符串表过大/);
        assert.equal(
          error.context.limitBytes,
          TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES
        );
        return true;
      }
    );
  });

  test('workbook/rels/styles/theme metadata part 均有中央目录与运行时双重上限', async () => {
    assert.deepEqual(TOOLBOX_XLSX_METADATA_LIMITS, {
      workbook: 16 * 1024 * 1024,
      relationships: 16 * 1024 * 1024,
      styles: 32 * 1024 * 1024,
      theme: 8 * 1024 * 1024
    });

    for (const [partName, limitBytes] of Object.entries(TOOLBOX_XLSX_METADATA_LIMITS)) {
      let opened = false;
      await assert.rejects(
        () => readToolboxMetadataEntryAsString(
          {
            openReadStream() {
              opened = true;
            }
          },
          { uncompressedSize: limitBytes + 1 },
          { sourceFile: 'oversized.xlsx', partName, limitBytes }
        ),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_XLSX_METADATA_TOO_LARGE');
          assert.equal(error.context.partName, partName);
          return true;
        }
      );
      assert.equal(opened, false, `${partName} 必须在 inflate 前拒绝`);
    }

    const runtimeZip = {
      openReadStream(_entry, callback) {
        callback(null, Readable.from([Buffer.alloc(6), Buffer.alloc(6)]));
      }
    };
    await assert.rejects(
      () => readToolboxMetadataEntryAsString(
        runtimeZip,
        { uncompressedSize: 8 },
        { sourceFile: 'runtime.xlsx', partName: 'styles.xml', limitBytes: 8 }
      ),
      (error) => error.code === 'TOOLBOX_XLSX_METADATA_TOO_LARGE' &&
        error.context.actualBytes > 8
    );
  });

  test('高压缩超限 styles.xml 在解压前 fail-closed', async () => {
    const styles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
      + ' '.repeat(TOOLBOX_XLSX_METADATA_LIMITS.styles);
    const fixture = await writeFixture({ styles });
    await assert.rejects(
      () => openToolboxXlsxPass(fixture),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_XLSX_METADATA_TOO_LARGE');
        assert.equal(error.context.partName, 'styles.xml');
        return true;
      }
    );
  });
});
