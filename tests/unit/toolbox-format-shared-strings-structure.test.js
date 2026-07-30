'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  ToolboxXlsxFormatError
} = require('../../src/backend/toolbox-format/xlsx-sheet-scanner');
const {
  loadToolboxSharedStrings
} = require('../../src/backend/toolbox-format/xlsx-pass');

const TRANSITIONAL_SPREADSHEETML_NAMESPACE =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML_NAMESPACE =
  'http://purl.oclc.org/ooxml/spreadsheetml/main';

function sstXml(contents, namespace = TRANSITIONAL_SPREADSHEETML_NAMESPACE) {
  return `<?xml version="1.0"?><sst xmlns="${namespace}">${contents}</sst>`;
}

function loadSharedStrings(xml) {
  const contents = Buffer.from(xml, 'utf8');
  const zip = {
    openReadStream(_entry, callback) {
      callback(null, Readable.from([contents]));
    }
  };
  return loadToolboxSharedStrings(zip, {
    uncompressedSize: contents.length
  }, 'shared-strings-structure.xlsx');
}

async function assertStructureFailure(xml, messagePattern) {
  await assert.rejects(
    () => loadSharedStrings(xml),
    (error) => {
      assert.ok(error instanceof ToolboxXlsxFormatError);
      assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
      assert.match(error.message, messagePattern);
      return true;
    }
  );
}

test('sharedStrings 接受 Transitional/Strict，保留合法文本并忽略 phonetic 节点', async () => {
  for (const namespace of [
    TRANSITIONAL_SPREADSHEETML_NAMESPACE,
    STRICT_SPREADSHEETML_NAMESPACE
  ]) {
    const values = await loadSharedStrings(sstXml(
      '<si><t xml:space="preserve"> plain </t></si>'
      + '<si>'
      + '<r><rPr><b/><color rgb="FFFF0000"/></rPr><t>A</t></r>'
      + '<r><t>B</t></r>'
      + '<rPh sb="0" eb="1"><t>PHONETIC</t></rPh>'
      + '<phoneticPr fontId="1"/>'
      + '</si>',
      namespace
    ));

    assert.deepEqual(values, [' plain ', 'AB']);
  }
});

test('sharedStrings 接受任意合法 prefix，并继续忽略真正未知的空扩展节点/属性', async () => {
  for (const namespace of [
    TRANSITIONAL_SPREADSHEETML_NAMESPACE,
    STRICT_SPREADSHEETML_NAMESPACE
  ]) {
    const values = await loadSharedStrings(
      `<ss:sst xmlns:ss="${namespace}" xmlns:ext="urn:example:extension">`
        + '<ext:metadata/><ss:si ext:flag="1"><ext:meta/>'
        + '<ss:r><ss:t>A</ss:t></ss:r><ss:r><ss:t>B</ss:t></ss:r>'
        + '</ss:si></ss:sst>'
    );
    assert.deepEqual(values, ['AB']);
  }
});

test('sharedStrings 按每个 t 单次解码 ST_Xstring，不跨 rich run 拼接 escape', async () => {
  const values = await loadSharedStrings(sstXml(
    '<si><t>_x0041_</t></si>'
    + '<si><t>_x005F_x0041_</t></si>'
    + '<si><r><t>_x00</t></r><r><t>41_</t></r></si>'
    + '<si><r><t>_X0042_</t></r><r><t>_x000D_</t></r></si>'
  ));
  assert.deepEqual(values, ['A', '_x0041_', '_x0041_', 'B\r']);
});

test('sharedStrings 对单个 t 原始词法和 rich run 累计语义长度均提前限流', async () => {
  await assertStructureFailure(
    sstXml(`<si><t>${'A'.repeat(32767 * 7 + 1)}</t></si>`),
    /读取上限/
  );
  await assertStructureFailure(
    sstXml(`<si><r><t>${'A'.repeat(20000)}</t></r>`
      + `<r><t>${'B'.repeat(12768)}</t></r></si>`),
    /超长|32767|上限/
  );
});

test('sharedStrings 已识别元素必须精确匹配 SpreadsheetML 规范大小写', async () => {
  const cases = [
    `<?xml version="1.0"?><SST xmlns="${TRANSITIONAL_SPREADSHEETML_NAMESPACE}">`
      + '<si><t>A</t></si></SST>',
    sstXml('<SI><t>A</t></SI>'),
    sstXml('<si><R><t>A</t></R></si>'),
    sstXml('<si><r><RPR/><t>A</t></r></si>'),
    sstXml('<si><T>A</T></si>'),
    sstXml('<si><rPH><t>A</t></rPH></si>'),
    sstXml('<si><phoneticPR/></si>')
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /大小写无效.*规范名称/);
  }
});

test('si 必须是 sst 直属且不可嵌套', async () => {
  const cases = [
    sstXml('<wrapper><si><t>wrapped</t></si></wrapper>'),
    sstXml('<si><si><t>nested</t></si></si>')
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /si.*sst.*直接子元素|嵌套.*si/);
  }
});

test('只采集 si/t 或 si/r/t，wrapper、rPr 和错层 r 中的 t 均 fail-closed', async () => {
  const cases = [
    sstXml('<si><wrapper><t>injected</t></wrapper></si>'),
    sstXml('<si><t><wrapper>injected</wrapper></t></si>'),
    sstXml('<si><r><rPr><t>injected</t></rPr><t>safe</t></r></si>'),
    sstXml('<si><r><wrapper><t>injected</t></wrapper></r></si>'),
    sstXml('<si><r><t><wrapper>injected</wrapper></t></r></si>'),
    sstXml('<si><wrapper><r><t>injected</t></r></wrapper></si>')
  ];

  for (const xml of cases) {
    await assertStructureFailure(
      xml,
      /t.*si\/t.*si\/r\/t|t.*只包含文本|r.*si.*直接子元素/
    );
  }
});

test('合法 t 之外的非空文本值不得注入 shared string', async () => {
  await assertStructureFailure(
    sstXml('<si><v>injected</v></si>'),
    /合法 t.*文本/
  );
});

test('plain si 与每个 rich r 最多一个直属 t，重复 t 不得拼接', async () => {
  const cases = [
    sstXml('<si><t>A</t><t>B</t></si>'),
    sstXml('<si><r><t>A</t><t>B</t></r></si>')
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /最多只能有一个直属 t/);
  }
});

test('sharedStrings 的识别节点遇到缺失或未知 namespace 时 fail-closed', async () => {
  const cases = [
    '<sst><si><t>A</t></si></sst>',
    sstXml('<si><t>A</t></si>', 'urn:invalid:spreadsheetml'),
    sstXml('<x:si xmlns:x="urn:invalid:spreadsheetml"><x:t>A</x:t></x:si>'),
    sstXml('<si><x:t xmlns:x="urn:invalid:spreadsheetml">A</x:t></si>')
  ];

  for (const xml of cases) {
    await assertStructureFailure(xml, /namespace.*无效或缺失/);
  }
});
