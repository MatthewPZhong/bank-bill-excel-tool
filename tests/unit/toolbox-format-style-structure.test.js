'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ToolboxStyleParseError,
  applyTint,
  parseOoxmlStyles,
  parseThemeColors
} = require('../../src/backend/toolbox-format/style-registry');

const TRANSITIONAL_SPREADSHEETML =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const TRANSITIONAL_DRAWINGML =
  'http://schemas.openxmlformats.org/drawingml/2006/main';
const STRICT_DRAWINGML = 'http://purl.oclc.org/ooxml/drawingml/main';

const THEME_SLOTS = [
  ['dk1', '<a:sysClr val="windowText" lastClr="010203"/>'],
  ['lt1', '<a:srgbClr val="FAFBFC"/>'],
  ['dk2', '<a:srgbClr val="1F497D"/>'],
  ['lt2', '<a:srgbClr val="EEECE1"/>'],
  ['accent1', '<a:srgbClr val="112233"/>'],
  ['accent2', '<a:srgbClr val="C0504D"/>'],
  ['accent3', '<a:srgbClr val="9BBB59"/>'],
  ['accent4', '<a:srgbClr val="8064A2"/>'],
  ['accent5', '<a:srgbClr val="4BACC6"/>'],
  ['accent6', '<a:srgbClr val="F79646"/>'],
  ['hlink', '<a:srgbClr val="0000FF"/>'],
  ['folHlink', '<a:srgbClr val="654321"/>']
].map(([name, color]) => `<a:${name}>${color}</a:${name}>`).join('');

function styleSheet(body, namespace = TRANSITIONAL_SPREADSHEETML) {
  return `<styleSheet xmlns="${namespace}">`
    + body
    + '</styleSheet>';
}

function themeXml(
  themeElementsBody,
  extraBody = '',
  namespace = TRANSITIONAL_DRAWINGML
) {
  return `<a:theme xmlns:a="${namespace}">`
    + `<a:themeElements>${themeElementsBody}</a:themeElements>`
    + extraBody
    + '</a:theme>';
}

function primaryColorScheme(extraBody = '') {
  return `<a:clrScheme name="custom">${THEME_SLOTS}${extraBody}</a:clrScheme>`;
}

function assertStyleFailure(xml, messagePattern = null) {
  assert.throws(
    () => parseOoxmlStyles(xml),
    (error) => {
      assert.ok(error instanceof ToolboxStyleParseError);
      assert.equal(error.code, 'TOOLBOX_STYLE_PARSE_INVALID');
      if (messagePattern) assert.match(error.message, messagePattern);
      return true;
    }
  );
}

function assertThemeFailure(xml, messagePattern = null) {
  assert.throws(
    () => parseThemeColors(xml),
    (error) => {
      assert.ok(error instanceof ToolboxStyleParseError);
      assert.equal(error.code, 'TOOLBOX_STYLE_PARSE_INVALID');
      if (messagePattern) assert.match(error.message, messagePattern);
      return true;
    }
  );
}

test('合法 styles.xml：严格直属层级、缺省 count、常见扩展与 custom indexed palette 保持兼容', () => {
  const parsed = parseOoxmlStyles(styleSheet(
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
    + '<fonts count="1"><font><name val="Calibri"/><sz val="11"/><b/>'
    + '<family val="2"/><scheme val="minor"/><color indexed="0"/></font></fonts>'
    + '<fills><fill><patternFill patternType="solid">'
    + '<fgColor indexed="0"/><bgColor indexed="1"/></patternFill></fill>'
    + '<fill><gradientFill degree="45"><stop position="0"><color rgb="FFFFFFFF"/></stop>'
    + '</gradientFill></fill></fills>'
    + '<borders count="1"><border diagonalUp="1">'
    + '<left style="thin"><color rgb="FF445566"/></left>'
    + '<diagonal style="thin"><color rgb="FF778899"/></diagonal>'
    + '</border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0">'
    + '<alignment horizontal="right"/><protection locked="1"/></xf></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="1"><dxf><font><color rgb="FFABCDEF"/></font>'
    + '<alignment horizontal="left"/></dxf></dxfs>'
    + '<tableStyles count="0" defaultTableStyle="TableStyleMedium2"/>'
    + '<colors><indexedColors><rgbColor rgb="FF123456"/></indexedColors>'
    + '<mruColors><color rgb="FF654321"/></mruColors></colors>'
    + '<extLst/>'
  ));

  assert.equal(parsed.styles.length, 1);
  assert.equal(parsed.styles[0].font.color.argb, 'FF123456');
  assert.equal(parsed.styles[0].fill.fgColor.argb, 'FF123456');
  assert.equal(parsed.styles[0].border.left.color.argb, 'FF445566');
  assert.equal(parsed.indexedColors[0], 'FF123456');
  assert.equal(parsed.customNumFmts.get(164), 'yyyy-mm-dd');
});

test('styleSheet 根与直属 section：wrapper、重复和错层 recognized section 均 fail-closed', () => {
  const cases = [
    '<wrapper><styleSheet/></wrapper>',
    styleSheet('<wrapper><fonts count="0"/></wrapper>'),
    styleSheet('<fonts count="0"/><fonts count="0"/>'),
    styleSheet('<indexedColors><rgbColor rgb="FF123456"/></indexedColors>'),
    styleSheet('<colors/><wrapper><cellXfs count="0"/></wrapper>')
  ];

  for (const xml of cases) assertStyleFailure(xml);
});

test('style section 条目只能是对应 section 的直接子元素', () => {
  const cases = [
    styleSheet('<numFmts count="1"><wrapper>'
      + '<numFmt numFmtId="164" formatCode="0.00"/></wrapper></numFmts>'),
    styleSheet('<fonts count="1"><wrapper><font/></wrapper></fonts>'),
    styleSheet('<fills count="1"><wrapper><fill/></wrapper></fills>'),
    styleSheet('<borders count="1"><wrapper><border/></wrapper></borders>'),
    styleSheet('<cellStyleXfs count="1"><wrapper><xf/></wrapper></cellStyleXfs>'),
    styleSheet('<cellXfs count="1"><wrapper><xf/></wrapper></cellXfs>'),
    styleSheet('<colors><wrapper><indexedColors>'
      + '<rgbColor rgb="FF123456"/></indexedColors></wrapper></colors>'),
    styleSheet('<colors><indexedColors><wrapper>'
      + '<rgbColor rgb="FF123456"/></wrapper></indexedColors></colors>')
  ];

  for (const xml of cases) assertStyleFailure(xml, /直接子元素/);
});

test('font/fill/border/xf 的可消费属性必须位于合法直接父节点', () => {
  const cases = [
    styleSheet('<fonts count="1"><font><wrapper><name val="Injected"/></wrapper></font></fonts>'),
    styleSheet('<fills count="1"><fill><wrapper>'
      + '<patternFill patternType="solid"/></wrapper></fill></fills>'),
    styleSheet('<fills count="1"><fill><patternFill patternType="solid"><wrapper>'
      + '<fgColor rgb="FFFF0000"/></wrapper></patternFill></fill></fills>'),
    styleSheet('<borders count="1"><border><wrapper><left style="thin"/></wrapper></border></borders>'),
    styleSheet('<borders count="1"><border><left><wrapper>'
      + '<color rgb="FFFF0000"/></wrapper></left></border></borders>'),
    styleSheet('<cellXfs count="1"><xf><wrapper>'
      + '<alignment horizontal="right"/></wrapper></xf></cellXfs>')
  ];

  for (const xml of cases) assertStyleFailure(xml, /直接子元素/);
});

test('同一组件内重复的 recognised 单值元素 fail-closed', () => {
  const cases = [
    styleSheet('<fonts count="1"><font><name val="A"/><name val="B"/></font></fonts>'),
    styleSheet('<fills count="1"><fill><patternFill/><patternFill/></fill></fills>'),
    styleSheet('<fills count="1"><fill><patternFill>'
      + '<fgColor rgb="FFFF0000"/><fgColor rgb="FF00FF00"/>'
      + '</patternFill></fill></fills>'),
    styleSheet('<borders count="1"><border><left/><left/></border></borders>'),
    styleSheet('<borders count="1"><border><left>'
      + '<color rgb="FFFF0000"/><color rgb="FF00FF00"/>'
      + '</left></border></borders>'),
    styleSheet('<cellXfs count="1"><xf><alignment/><alignment/></xf></cellXfs>')
  ];

  for (const xml of cases) assertStyleFailure(xml, /重复/);
});

test('声明的 section count 必须是非负安全整数并等于直属条目数', () => {
  const invalidCounts = ['-1', '1.5', 'NaN', '9007199254740992'];
  for (const count of invalidCounts) {
    assertStyleFailure(styleSheet(`<fonts count="${count}"/>`), /count.*非负整数/);
  }

  const mismatches = [
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>',
    '<fonts count="0"><font/></fonts>',
    '<fills count="0"><fill/></fills>',
    '<borders count="0"><border/></borders>',
    '<cellStyleXfs count="0"><xf/></cellStyleXfs>',
    '<cellXfs count="0"><xf/></cellXfs>'
  ];
  for (const body of mismatches) {
    assertStyleFailure(styleSheet(body), /count.*实际直属/);
  }
});

test('低 numFmtId 仅接受 Excel 物理 FORMAT 区间，受保护 built-in 不得覆盖', () => {
  for (const id of [0, 4, 9, 14, 22, 27, 40, 45, 47, 49]) {
    assertStyleFailure(
      styleSheet(
        `<numFmts count="1"><numFmt numFmtId="${id}" formatCode="0"/></numFmts>`
      ),
      /numFmtId.*受保护 built-in/
    );
  }

  for (const id of [5, 8, 23, 26, 41, 44, 50, 56, 60, 163, 164]) {
    const formatCode = id === 60 ? 'yyyy-mm-dd hh:mm' : `physical-${id}`;
    const parsed = parseOoxmlStyles(styleSheet(
      `<numFmts count="1"><numFmt numFmtId="${id}" formatCode="${formatCode}"/></numFmts>`
      + `<cellXfs count="1"><xf numFmtId="${id}"/></cellXfs>`
    ));
    assert.equal(parsed.customNumFmts.get(id), formatCode);
    assert.equal(parsed.styles[0].numFmt, formatCode);
  }
});

test('styles.xml 已识别元素与已消费属性必须精确匹配规范 camelCase', () => {
  const elementCases = [
    '<StyleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    styleSheet('<NUMFMTS count="0"/>'),
    styleSheet('<numFmts count="1">'
      + '<NUMFMT numFmtId="164" formatCode="0.00"/></numFmts>'),
    styleSheet('<cellXfs count="1"><XF/></cellXfs>'),
    styleSheet('<fonts count="1"><font><VERTALIGN val="baseline"/></font></fonts>'),
    styleSheet('<fills count="1"><fill><PATTERNFILL/></fill></fills>')
  ];
  for (const xml of elementCases) assertStyleFailure(xml, /大小写无效.*规范名称/);

  const attributeCases = [
    styleSheet('<numFmts COUNT="0"/>'),
    styleSheet('<numFmts count="1">'
      + '<numFmt numfmtId="164" formatCode="0.00"/></numFmts>'),
    styleSheet('<numFmts count="1">'
      + '<numFmt numFmtId="164" formatcode="0.00"/></numFmts>'),
    styleSheet('<fonts count="1"><font><name VAL="A"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><color RGB="FF112233"/></font></fonts>'),
    styleSheet('<fills count="1"><fill><patternFill patterntype="solid"/></fill></fills>'),
    styleSheet('<cellXfs count="1"><xf fontid="0"/></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf applyfont="1"/></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment wraptext="1"/></xf></cellXfs>')
  ];
  for (const xml of attributeCases) assertStyleFailure(xml, /大小写无效.*规范名称/);
});

test('已解析 boolean 属性只接受 0/1/true/false 词法', () => {
  const cases = [
    styleSheet('<fonts count="1"><font><b val="yes"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><b val="TRUE"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><i val="2"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><strike val="-1"/></font></fonts>'),
    styleSheet('<cellXfs count="1"><xf applyFont="yes"/></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf applyFont="FALSE"/></cellXfs>'),
    styleSheet('<fonts count="1"><font><color auto="TRUE"/></font></fonts>'),
    styleSheet('<cellXfs count="1"><xf><alignment wrapText="enabled"/></xf></cellXfs>')
  ];

  for (const xml of cases) assertStyleFailure(xml, /0\/1\/true\/false/);

  const parsed = parseOoxmlStyles(styleSheet(
    '<fonts count="1"><font><b val="true"/><i val="false"/>'
    + '<color auto="false"/></font></fonts>'
    + '<cellXfs count="1"><xf fontId="0" applyFont="true">'
    + '<alignment wrapText="false"/></xf></cellXfs>'
  ));
  assert.equal(parsed.styles[0].font.bold, true);
  assert.equal(parsed.styles[0].font.italic, false);
  assert.equal(parsed.styles[0].alignment.wrapText, false);
});

test('styles/theme 接受 Transitional/Strict 任意合法 prefix 与真正未知扩展', () => {
  for (const [spreadsheetNamespace, drawingNamespace] of [
    [TRANSITIONAL_SPREADSHEETML, TRANSITIONAL_DRAWINGML],
    [STRICT_SPREADSHEETML, STRICT_DRAWINGML]
  ]) {
    const styles = parseOoxmlStyles(
      `<ss:styleSheet xmlns:ss="${spreadsheetNamespace}" ` +
        'xmlns:ext="urn:example:extension">'
        + '<ss:numFmts count="1">'
        + '<ss:numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></ss:numFmts>'
        + '<ss:fonts count="1"><ss:font>'
        + '<ss:color rgb="FF112233" ext:RGB="ignored"/></ss:font></ss:fonts>'
        + '<ext:metadata/><ss:cellXfs count="1">'
        + '<ss:xf numFmtId="164" fontId="0" ext:flag="1"/></ss:cellXfs>'
        + '</ss:styleSheet>'
    );
    assert.equal(styles.styles[0].numFmt, 'yyyy-mm-dd');
    assert.equal(styles.styles[0].font.color.argb, 'FF112233');

    const prefixedTheme = themeXml(
      primaryColorScheme().replace(
        '<a:accent1><a:srgbClr val="112233"/>',
        '<a:accent1><a:srgbClr val="112233" ext:VAL="ignored"/>'
      ),
      '<ext:metadata/>',
      drawingNamespace
    ).replace(
      `xmlns:a="${drawingNamespace}"`,
      `xmlns:a="${drawingNamespace}" xmlns:ext="urn:example:extension"`
    )
      .replace('xmlns:a=', 'xmlns:draw=')
      .replaceAll('<a:', '<draw:')
      .replaceAll('</a:', '</draw:');
    assert.equal(parseThemeColors(prefixedTheme).accent1, 'FF112233');
  }
});

test('strict SpreadsheetML/DrawingML 命名空间保持兼容，错误 URN 完整结构 fail-closed', () => {
  const strictStyles = parseOoxmlStyles(styleSheet(
    '<fonts count="1"><font><name val="Strict Font"/><sz val="10"/></font></fonts>'
    + '<cellXfs count="1"><xf fontId="0"/></cellXfs>',
    STRICT_SPREADSHEETML
  ));
  assert.equal(strictStyles.styles[0].font.name, 'Strict Font');

  const strictTheme = parseThemeColors(themeXml(
    primaryColorScheme(),
    '',
    STRICT_DRAWINGML
  ));
  assert.equal(strictTheme.accent1, 'FF112233');

  assertStyleFailure(
    styleSheet(
      '<fonts count="1"><font><name val="Injected"/></font></fonts>'
      + '<cellXfs count="1"><xf fontId="0"/></cellXfs>',
      'urn:example:wrong-spreadsheetml'
    ),
    /命名空间/
  );
  assertStyleFailure(
    styleSheet('<fonts xmlns:e="urn:example:wrong"><e:font/></fonts>'),
    /命名空间/
  );
  assertThemeFailure(
    themeXml(primaryColorScheme(), '', 'urn:example:wrong-drawingml'),
    /命名空间/
  );
  assertThemeFailure(
    `<a:theme xmlns:a="${TRANSITIONAL_DRAWINGML}" xmlns:e="urn:example:wrong">`
      + `<e:themeElements><e:clrScheme>${THEME_SLOTS}</e:clrScheme></e:themeElements>`
      + '</a:theme>',
    /命名空间/
  );
});

test('已消费数值与枚举接受常见合法值且拒绝显式无效值', () => {
  const parsed = parseOoxmlStyles(styleSheet(
    '<fonts count="1"><font><name val="Acme Custom"/><sz val="1.05E1"/>'
    + '<color rgb="FF112233" tint="1e-1"/>'
    + '<u val="doubleAccounting"/><vertAlign val="superscript"/></font></fonts>'
    + '<fills count="1"><fill><patternFill patternType="darkTrellis"/></fill></fills>'
    + '<borders count="1"><border><left style="slantDashDot"/></border></borders>'
    + '<cellXfs count="1"><xf fontId="0" fillId="0" borderId="0">'
    + '<alignment horizontal="centerContinuous" vertical="distributed" indent="3"/>'
    + '</xf></cellXfs>'
  ));
  assert.equal(parsed.styles[0].font.name, 'Acme Custom');
  assert.equal(parsed.styles[0].font.size, 10.5);
  assert.equal(parsed.styles[0].font.color.argb, applyTint('FF112233', 0.1));
  assert.equal(parsed.styles[0].font.underline, 'doubleAccounting');
  assert.equal(parsed.styles[0].font.vertAlign, 'superscript');
  assert.equal(parsed.styles[0].fill.pattern, 'darkTrellis');
  assert.equal(parsed.styles[0].border.left.style, 'slantDashDot');
  assert.equal(parsed.styles[0].alignment.horizontal, 'centerContinuous');
  assert.equal(parsed.styles[0].alignment.vertical, 'distributed');
  assert.equal(parsed.styles[0].alignment.indent, 3);

  const invalidCases = [
    styleSheet('<fonts count="1"><font><name val=" "/></font></fonts>'),
    styleSheet('<fonts count="1"><font><sz val="junk"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><sz val="0"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><u val="mystery"/></font></fonts>'),
    styleSheet('<fonts count="1"><font><vertAlign val="middle"/></font></fonts>'),
    styleSheet('<fills count="1"><fill><patternFill patternType="mystery"/></fill></fills>'),
    styleSheet('<borders count="1"><border><left style="mystery"/></border></borders>'),
    styleSheet('<cellXfs count="1"><xf><alignment horizontal="mystery"/></xf></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment vertical="middle"/></xf></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment textRotation="1e2"/></xf></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment textRotation=" "/></xf></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment indent="-1"/></xf></cellXfs>'),
    styleSheet('<cellXfs count="1"><xf><alignment indent="1.5"/></xf></cellXfs>')
  ];
  for (const xml of invalidCases) assertStyleFailure(xml);
});

test('已消费数值先校验 XML lexical，不接受 Number() 可解析的伪十进制或空白', () => {
  const cases = [
    [
      styleSheet('<fonts count="1"><font><sz val="0x10"/></font></fonts>'),
      /font\.sz\.val.*十进制/
    ],
    [
      styleSheet('<fonts count="1"><font><sz val=" "/></font></fonts>'),
      /font\.sz\.val.*十进制/
    ],
    [
      styleSheet('<cellXfs count="1"><xf>'
        + '<alignment textRotation="0x10"/></xf></cellXfs>'),
      /textRotation.*非负整数/
    ],
    [
      styleSheet('<fonts count="1"><font>'
        + '<color rgb="FF112233" tint=" "/></font></fonts>'),
      /tint.*十进制/
    ],
    [
      styleSheet('<fonts count="1"><font>'
        + '<color rgb="FF112233" tint="0x0"/></font></fonts>'),
      /tint.*十进制/
    ]
  ];

  for (const [xml, message] of cases) assertStyleFailure(xml, message);
});

test('合法 theme.xml：唯一直属 themeElements/clrScheme，并兼容根级扩展', () => {
  const parsed = parseThemeColors(themeXml(
    primaryColorScheme()
    + '<a:fontScheme name="Office"><a:majorFont/><a:minorFont/></a:fontScheme>'
    + '<a:fmtScheme name="Office"/>',
    '<a:objectDefaults/><a:extLst><a:ext uri="custom"/></a:extLst>'
  ));

  assert.equal(parsed.dk1, 'FF010203');
  assert.equal(parsed.accent1, 'FF112233');
  assert.equal(parsed.folHlink, 'FF654321');
});

test('srgbClr/sysClr 的未实现 DrawingML color transform 必须 fail-closed', () => {
  const cases = [
    primaryColorScheme().replace(
      '<a:accent1><a:srgbClr val="112233"/></a:accent1>',
      '<a:accent1><a:srgbClr val="112233">'
        + '<a:lumMod val="50000"/></a:srgbClr></a:accent1>'
    ),
    primaryColorScheme().replace(
      '<a:dk1><a:sysClr val="windowText" lastClr="010203"/></a:dk1>',
      '<a:dk1><a:sysClr val="windowText" lastClr="010203">'
        + '<a:alphaMod val="50000"/></a:sysClr></a:dk1>'
    )
  ];

  for (const [index, colorScheme] of cases.entries()) {
    assert.notEqual(colorScheme, primaryColorScheme(), `case ${index} 必须替换颜色节点`);
    assertThemeFailure(themeXml(colorScheme), /transform.*(?:lumMod|alphaMod)/i);
  }
});

test('theme.xml 已识别 DrawingML 元素与颜色属性必须精确匹配规范 camelCase', () => {
  const base = themeXml(primaryColorScheme());
  const cases = [
    base.replaceAll('a:themeElements', 'a:ThemeElements'),
    base.replaceAll('a:clrScheme', 'a:CLRScheme'),
    base.replace('<a:accent1><a:srgbClr', '<a:accent1><a:SRGBCLR'),
    base.replace('<a:accent1><a:srgbClr val="112233"/>',
      '<a:accent1><a:srgbClr VAL="112233"/>'),
    base.replace('<a:dk1><a:sysClr val="windowText" lastClr="010203"/>',
      '<a:dk1><a:sysClr val="windowText" LASTCLR="010203"/>'),
    base.replace(
      '<a:accent1><a:srgbClr val="112233"/>',
      '<a:accent1><a:srgbClr val="112233">'
        + '<a:LUMMOD val="50000"/></a:srgbClr>'
    )
  ];

  for (const xml of cases) assertThemeFailure(xml, /大小写无效.*规范名称/);
});

test('themeElements 与主 clrScheme 必须唯一且为合法直接子元素', () => {
  const cases = [
    '<a:wrapper xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + `<a:theme><a:themeElements>${primaryColorScheme()}</a:themeElements></a:theme>`
      + '</a:wrapper>',
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + `<a:wrapper><a:themeElements>${primaryColorScheme()}</a:themeElements></a:wrapper>`
      + '</a:theme>',
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + `<a:themeElements/><a:themeElements>${primaryColorScheme()}</a:themeElements>`
      + '</a:theme>',
    themeXml(`<a:wrapper>${primaryColorScheme()}</a:wrapper>`),
    themeXml(`${primaryColorScheme()}${primaryColorScheme()}`),
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + `<a:extLst><a:themeElements>${primaryColorScheme()}</a:themeElements></a:extLst>`
      + '</a:theme>',
    themeXml(`<a:extLst>${primaryColorScheme()}</a:extLst>`)
  ];

  for (const xml of cases) assertThemeFailure(xml);
});
