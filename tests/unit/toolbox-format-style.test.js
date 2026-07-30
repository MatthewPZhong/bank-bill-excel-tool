'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  OutputStyleRegistry,
  SourceStyleRegistry,
  ToolboxStyleBudgetError,
  ToolboxStyleParseError,
  applyTint,
  createSourceStyleRegistryFromOoxml,
  parseThemeColors,
  resolveColorSpec
} = require('../../src/backend/toolbox-format/style-registry');
const {
  createToolboxCell,
  projectOutputCell
} = require('../../src/backend/toolbox-format/model');

const THEME_XML = '<?xml version="1.0"?>'
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
  + '<a:themeElements><a:clrScheme name="custom">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="010203"/></a:dk1>'
  + '<a:lt1><a:srgbClr val="FAFBFC"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="1F497D"/></a:dk2>'
  + '<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="112233"/></a:accent1>'
  + '<a:accent2><a:srgbClr val="C0504D"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>'
  + '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>'
  + '<a:accent6><a:srgbClr val="F79646"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0000FF"/></a:hlink>'
  + '<a:folHlink><a:srgbClr val="654321"/></a:folHlink>'
  + '</a:clrScheme></a:themeElements></a:theme>';

const STYLES_XML = '<?xml version="1.0"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Calibri"/><color theme="1"/></font>'
  + '<font><b/><i/><u val="double"/><strike/><vertAlign val="superscript"/>'
  + '<sz val="12"/><name val="Arial"/><color theme="4" tint="0.4"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor indexed="2"/><bgColor indexed="1"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="2"><border/><border>'
  + '<left style="thin"><color theme="4"/></left><right/><top/><bottom/>'
  + '</border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0"'
  + ' applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
  + '<alignment horizontal="right" vertical="center" wrapText="1" textRotation="45" indent="2"/>'
  + '</xf>'
  + '<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="0"/>'
  + '</cellXfs></styleSheet>';

test.describe('toolbox-format style registry', () => {
  test('theme/indexed/tint 先解析为明确 ARGB', () => {
    const theme = parseThemeColors(THEME_XML);
    assert.equal(theme.dk1, 'FF010203');
    assert.equal(theme.lt1, 'FFFAFBFC');
    assert.equal(theme.accent1, 'FF112233');
    assert.equal(theme.folHlink, 'FF654321');
    assert.equal(resolveColorSpec({ theme: 1 }, { themeColors: theme }), 'FF010203');
    assert.equal(resolveColorSpec({ theme: 4 }, { themeColors: theme }), 'FF112233');
    assert.equal(resolveColorSpec({ indexed: 2 }), 'FFFF0000');
    assert.equal(resolveColorSpec({ indexed: 64 }), 'FF000000', 'system foreground 必须是黑色');
    assert.equal(resolveColorSpec({ indexed: 65 }), 'FFFFFFFF', 'system background 必须是白色');
    assert.equal(applyTint('FF000000', 0.5), 'FF808080');
  });

  test('OOXML XF 按 xfId/apply* 解析完整有效样式并去重', () => {
    const result = createSourceStyleRegistryFromOoxml({
      sourceRegistryId: 'source-a',
      stylesXml: STYLES_XML,
      themeXml: THEME_XML
    });
    const style1 = result.registry.get(result.registry.styleRefForXf(1));
    assert.equal(style1.numFmt, 'yyyy-mm-dd');
    assert.equal(style1.font.name, 'Arial');
    assert.equal(style1.font.bold, true);
    assert.equal(style1.font.underline, 'double');
    assert.equal(style1.font.color.argb, applyTint('FF112233', 0.4));
    assert.equal(style1.fill.pattern, 'solid');
    assert.equal(style1.fill.fgColor.argb, 'FFFF0000');
    assert.equal(style1.border.left.style, 'thin');
    assert.equal(style1.border.left.color.argb, 'FF112233');
    assert.equal(style1.alignment.wrapText, true);
    assert.equal(style1.alignment.vertical, 'middle', 'OOXML center 必须转成 ExcelJS middle');
    assert.equal(style1.alignment.textRotation, 45);
    assert.equal(style1.alignment.indent, 2);

    const style2 = result.registry.get(result.registry.styleRefForXf(2));
    assert.equal(style2.numFmt, 'mm-dd-yy');
    assert.equal(style2.font.name, 'Calibri', 'applyFont=0 必须继承 parent');
    const projectedDate = projectOutputCell(createToolboxCell({
      rawLexicalValue: '45292',
      cachedValue: 45292,
      cellType: 'number',
      decodedSemanticValue: 45292,
      sourceFormat: style2.numFmt,
      sourceDateSystem: 1900,
      rowIndex: 1,
      columnIndex: 0
    }));
    assert.equal(projectedDate.value, 45292);
    assert.equal(projectedDate.numFmtOverride, null);
    assert.equal(
      projectedDate.numFmtOverride || style2.numFmt,
      'mm-dd-yy',
      'built-in 日期格式必须随数值 serial 输出，不能降成裸 serial'
    );

    const duplicate = result.registry.register(style1);
    assert.equal(duplicate, result.registry.styleRefForXf(1));
  });

  test('OOXML textRotation 135/255 转成 ExcelJS 的 -45/vertical，非法值 fail-closed', () => {
    const parseRotation = (rotation) => {
      const stylesXml = STYLES_XML.replace('textRotation="45"', `textRotation="${rotation}"`);
      const result = createSourceStyleRegistryFromOoxml({
        sourceRegistryId: `rotation-${rotation}`,
        stylesXml,
        themeXml: THEME_XML
      });
      return result.registry.get(result.registry.styleRefForXf(1)).alignment.textRotation;
    };
    assert.equal(parseRotation(135), -45);
    assert.equal(parseRotation(255), 'vertical');
    assert.throws(() => parseRotation(181), ToolboxStyleParseError);
  });

  test('截断 styles/theme 必须 fail-closed，日期 XF 不得因 styles 截断退回 General', () => {
    const truncatedStyles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"';
    assert.throws(
      () => createSourceStyleRegistryFromOoxml({
        sourceRegistryId: 'truncated-styles',
        stylesXml: truncatedStyles,
        themeXml: THEME_XML
      }),
      (error) => {
        assert.ok(error instanceof ToolboxStyleParseError);
        assert.match(error.message, /styles\.xml/);
        return true;
      }
    );

    const truncatedTheme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:themeElements><a:clrScheme><a:accent1><a:srgbClr val="112233"/>';
    assert.throws(
      () => createSourceStyleRegistryFromOoxml({
        sourceRegistryId: 'truncated-theme',
        stylesXml: STYLES_XML,
        themeXml: truncatedTheme
      }),
      (error) => {
        assert.ok(error instanceof ToolboxStyleParseError);
        assert.match(error.message, /theme\.xml/);
        return true;
      }
    );
  });

  test('theme 颜色槽不允许嵌套串色、重复声明或无法固化的系统色', () => {
    const invalidThemes = [
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:themeElements><a:clrScheme>'
        + '<a:accent1><a:accent2><a:srgbClr val="445566"/></a:accent2></a:accent1>'
        + '</a:clrScheme></a:themeElements></a:theme>',
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:themeElements><a:clrScheme>'
        + '<a:accent1><a:srgbClr val="112233"/></a:accent1>'
        + '<a:accent1><a:srgbClr val="445566"/></a:accent1>'
        + '</a:clrScheme></a:themeElements></a:theme>',
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        + '<a:themeElements><a:clrScheme>'
        + '<a:dk1><a:sysClr val="windowText"/></a:dk1>'
        + '</a:clrScheme></a:themeElements></a:theme>'
    ];
    for (const [index, themeXml] of invalidThemes.entries()) {
      assert.throws(
        () => parseThemeColors(themeXml),
        (error) => {
          assert.ok(error instanceof ToolboxStyleParseError, `case ${index}`);
          return true;
        }
      );
    }
  });

  test('存在的 theme.xml 必须完整声明全部必需颜色槽，不得用默认主题色混补', () => {
    const incompleteTheme = THEME_XML.replace(
      '<a:accent6><a:srgbClr val="F79646"/></a:accent6>',
      ''
    );
    assert.throws(
      () => parseThemeColors(incompleteTheme),
      (error) => {
        assert.ok(error instanceof ToolboxStyleParseError);
        assert.match(error.message, /缺少必需颜色槽.*accent6/);
        assert.deepEqual(error.context.missingThemeKeys, ['accent6']);
        return true;
      }
    );
  });

  test('font/fill/border 的显式 OOXML 颜色严格校验来源、范围、冲突和未知属性', () => {
    const replacements = [
      ['<color theme="1"/>', '<color rgb="12345"/>', /rgb.*6 或 8/],
      ['<color theme="1"/>', '<color theme="12"/>', /theme.*0\.\.11/],
      ['<color theme="1"/>', '<color indexed="66"/>', /indexed.*0\.\.65/],
      ['<color theme="1"/>', '<color theme="1" rgb="FF000000"/>', /多个颜色来源/],
      ['<color theme="1"/>', '<color theme="1" tint="1.1"/>', /tint.*-1\.\.1/],
      ['<color theme="1"/>', '<color theme="1" mystery="x"/>', /无法解释的属性/],
      ['<color theme="1"/>', '<color/>', /缺少 rgb\/theme\/indexed\/auto/],
      ['<fgColor indexed="2"/>', '<fgColor auto="maybe"/>', /auto.*0\/1/],
      ['<fgColor indexed="2"/>', '<fgColor tint="0.2"/>', /缺少 rgb\/theme\/indexed\/auto/],
      ['<color theme="4"/>', '<color indexed="-1"/>', /indexed 必须是整数/]
    ];
    for (const [index, [from, to, message]] of replacements.entries()) {
      const stylesXml = STYLES_XML.replace(from, to);
      assert.notEqual(stylesXml, STYLES_XML, `case ${index} 必须实际替换 fixture`);
      assert.throws(
        () => createSourceStyleRegistryFromOoxml({
          sourceRegistryId: `bad-color-${index}`,
          stylesXml,
          themeXml: THEME_XML
        }),
        (error) => {
          assert.ok(error instanceof ToolboxStyleParseError);
          assert.match(error.message, message);
          return true;
        }
      );
    }
  });

  test('来源样式优先级固定为 cell → custom row → column → default', () => {
    const registry = new SourceStyleRegistry('source-b');
    registry.bindXf(1, { numFmt: '0.00' });
    registry.bindXf(2, { numFmt: '@' });
    assert.equal(registry.effectiveStyleRef({ cellStyleId: 1, rowStyleId: 2, rowCustomFormat: true }), registry.styleRefForXf(1));
    assert.equal(registry.effectiveStyleRef({ rowStyleId: 2, rowCustomFormat: true, columnStyleId: 1 }), registry.styleRefForXf(2));
    assert.equal(registry.effectiveStyleRef({ rowStyleId: 2, rowCustomFormat: false, columnStyleId: 1 }), registry.styleRefForXf(1));
    assert.equal(registry.effectiveStyleRef({}), registry.defaultStyleRef);
  });

  test('损坏的 XF component/parent 引用 fail-closed，不静默套默认样式', () => {
    const corrupt = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="1"><font><name val="Calibri"/></font></fonts>'
      + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="99" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '</styleSheet>';
    assert.throws(
      () => createSourceStyleRegistryFromOoxml({
        sourceRegistryId: 'corrupt',
        stylesXml: corrupt,
        themeXml: THEME_XML
      }),
      (error) => {
        assert.ok(error instanceof ToolboxStyleParseError);
        assert.equal(error.code, 'TOOLBOX_STYLE_PARSE_INVALID');
        assert.equal(error.context.key, 'fontId');
        return true;
      }
    );
  });

  test('locale-dependent built-in numFmt 保留日期语义，未知 built-in id fail-closed', () => {
    const stylesWith56 = STYLES_XML.replace(
      '<xf numFmtId="14" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="0"/>',
      '<xf numFmtId="56" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="0"/>'
    );
    const parsed = createSourceStyleRegistryFromOoxml({
      sourceRegistryId: 'builtin-56',
      stylesXml: stylesWith56,
      themeXml: THEME_XML
    });
    const style = parsed.registry.get(parsed.registry.styleRefForXf(2));
    assert.match(style.numFmt, /h/);

    const stylesWithUnknown = stylesWith56.replace('numFmtId="56"', 'numFmtId="23"');
    assert.throws(
      () => createSourceStyleRegistryFromOoxml({
        sourceRegistryId: 'builtin-unknown',
        stylesXml: stylesWithUnknown,
        themeXml: THEME_XML
      }),
      (error) => {
        assert.ok(error instanceof ToolboxStyleParseError);
        assert.equal(error.context.numFmtId, 23);
        return true;
      }
    );
  });

  test('OutputStyleRegistry 按最终 component/XF 签名去重并在变更前执行预算', () => {
    const output = new OutputStyleRegistry({
      budgets: { cellXfs: 2, fonts: 2, fills: 2, borders: 1, customNumFmts: 0 }
    });
    const before = output.stats();
    assert.equal(before.counts.cellXfs, 1, '先计 ExcelJS writer base XF');
    assert.equal(before.counts.fonts, 1, '先计 ExcelJS writer theme font');
    const first = output.register({});
    assert.equal(first.styleRef, 0);
    const afterFirst = output.stats();
    assert.equal(afterFirst.counts.cellXfs, 2);
    assert.equal(afterFirst.counts.fonts, 2, '来源 ARGB 默认字体与 writer theme font 分开计数');
    const same = output.register({});
    assert.equal(same.styleRef, first.styleRef);
    assert.deepEqual(output.stats(), afterFirst);

    const limited = new OutputStyleRegistry({
      budgets: { cellXfs: 2, fonts: 1, fills: 2, borders: 1, customNumFmts: 0 }
    });
    const limitedBefore = limited.stats();
    assert.throws(
      () => limited.register({ font: { name: 'Arial', size: 12 } }, { sourceFile: 'a.xlsx', cellRef: 'A2' }),
      (error) => {
        assert.ok(error instanceof ToolboxStyleBudgetError);
        assert.equal(error.component, 'fonts');
        assert.equal(error.projectedCount, 2);
        assert.equal(error.budget, 1);
        assert.deepEqual(error.source, { sourceFile: 'a.xlsx', cellRef: 'A2' });
        return true;
      }
    );
    assert.deepEqual(limited.stats(), limitedBefore, '预算失败不得部分注册 component');
  });
});
