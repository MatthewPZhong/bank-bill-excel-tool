'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const {
  RECORD,
  Biff8RecordError,
  readLogicalRecord,
  msoCrc32Compute,
  scanBiff8WorkbookStream
} = require('../../src/backend/toolbox-format/biff8-records');
const {
  Biff8OverlayError,
  readBiff8Overlay,
  createBiff8GridResolver,
  assertBiff8OverlayMatchesProjection
} = require('../../src/backend/toolbox-format/biff8-overlay');
function record(type, payload = Buffer.alloc(0)) {
  const output = Buffer.alloc(4 + payload.length);
  output.writeUInt16LE(type, 0);
  output.writeUInt16LE(payload.length, 2);
  payload.copy(output, 4);
  return output;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function bof(substreamType, version = 0x0600) {
  const payload = Buffer.alloc(16);
  payload.writeUInt16LE(version, 0);
  payload.writeUInt16LE(substreamType, 2);
  return record(RECORD.BOF, payload);
}

function unicodeString(value) {
  const text = String(value);
  const output = Buffer.alloc(3 + text.length * 2);
  output.writeUInt16LE(text.length, 0);
  output[2] = 1;
  output.write(text, 3, 'utf16le');
  return output;
}

function shortUnicodeString(value, compressed = false) {
  const text = String(value);
  const output = Buffer.alloc(2 + text.length * (compressed ? 1 : 2));
  output[0] = text.length;
  output[1] = compressed ? 0 : 1;
  output.write(text, 2, compressed ? 'latin1' : 'utf16le');
  return output;
}

function font({
  name = 'Arial',
  heightTwips = 200,
  flags = 0,
  colorIndex = 0x7fff,
  weight = 400,
  escapement = 0,
  underline = 0,
  family = 0,
  charset = 0,
  compressedName = false
} = {}) {
  const namePayload = shortUnicodeString(name, compressedName);
  const payload = Buffer.alloc(14 + namePayload.length);
  payload.writeUInt16LE(heightTwips, 0);
  payload.writeUInt16LE(flags, 2);
  payload.writeUInt16LE(colorIndex, 4);
  payload.writeUInt16LE(weight, 6);
  payload.writeUInt16LE(escapement, 8);
  payload[10] = underline;
  payload[11] = family;
  payload[12] = charset;
  payload[13] = 0;
  namePayload.copy(payload, 14);
  return record(RECORD.FONT, payload);
}

function xf({
  fontIndex = 0,
  numFmtId = 0,
  style = false,
  parent = style ? 0x0fff : 0,
  horizontal = 0,
  wrap = false,
  vertical = 2,
  rotation = 0,
  indent = 0,
  shrink = false,
  readOrder = 0,
  usedAttributes = style ? 0 : 0x3f,
  leftStyle = 0,
  rightStyle = 0,
  topStyle = 0,
  bottomStyle = 0,
  borderColor = 0,
  diagonalFlags = 0,
  diagonalStyle = 0,
  fillPattern = 0,
  fillForeground = 0x40,
  fillBackground = 0x41,
  extensionBit = false
} = {}) {
  const payload = Buffer.alloc(20);
  payload.writeUInt16LE(fontIndex, 0);
  payload.writeUInt16LE(numFmtId, 2);
  payload.writeUInt16LE(1 | (style ? 4 : 0) | (parent << 4), 4);
  let a = horizontal | (wrap ? 1 << 3 : 0) | (vertical << 4) | (rotation << 8)
    | (indent << 16) | (shrink ? 1 << 20 : 0) | (readOrder << 22)
    | (usedAttributes << 26);
  let b = leftStyle | (rightStyle << 4) | (topStyle << 8) | (bottomStyle << 12)
    | (borderColor << 16) | (borderColor << 23) | (diagonalFlags << 30);
  let c = borderColor | (borderColor << 7) | (borderColor << 14)
    | (diagonalStyle << 21) | (extensionBit ? 1 << 25 : 0) | (fillPattern << 26);
  const d = fillForeground | (fillBackground << 7);
  payload.writeUInt32LE(a >>> 0, 6);
  payload.writeUInt32LE(b >>> 0, 10);
  payload.writeUInt32LE(c >>> 0, 14);
  payload.writeUInt16LE(d, 18);
  return record(RECORD.XF, payload);
}

function frtHeader(type) {
  const output = Buffer.alloc(12);
  output.writeUInt16LE(type, 0);
  return output;
}

function fullColorTheme(themeIndex, tintRaw = 0) {
  const output = Buffer.alloc(16);
  output.writeUInt16LE(3, 0);
  output.writeInt16LE(tintRaw, 2);
  output.writeUInt32LE(themeIndex, 4);
  return output;
}

function xfExt(xfIndex, { unknown = false, unknownColorType = false } = {}) {
  const color = fullColorTheme(4, 16384);
  if (unknownColorType) color.writeUInt16LE(9, 0);
  const fontColorProp = Buffer.alloc(4 + color.length);
  fontColorProp.writeUInt16LE(unknown ? 0x10 : 0x0d, 0);
  fontColorProp.writeUInt16LE(fontColorProp.length, 2);
  color.copy(fontColorProp, 4);
  const indentProp = Buffer.alloc(5);
  indentProp.writeUInt16LE(0x0f, 0);
  indentProp.writeUInt16LE(5, 2);
  indentProp[4] = 7;
  const payload = Buffer.concat([
    frtHeader(RECORD.XF_EXT),
    uint16(0),
    uint16(xfIndex),
    uint16(0),
    uint16(2),
    fontColorProp,
    indentProp
  ]);
  return record(RECORD.XF_EXT, payload);
}

function xfCrc(xfRecords, { count = xfRecords.length, crc = null } = {}) {
  let computedCrc = 0;
  xfRecords.forEach((xfRecord) => {
    computedCrc = msoCrc32Compute(computedCrc, xfRecord.subarray(4));
  });
  const payload = Buffer.alloc(20);
  frtHeader(RECORD.XF_CRC).copy(payload, 0);
  payload.writeUInt16LE(count, 14);
  payload.writeUInt32LE(crc == null ? computedCrc : crc, 16);
  return record(RECORD.XF_CRC, payload);
}

function boundSheet(streamOffset, name = 'Data', state = 0, sheetType = 0) {
  const namePayload = shortUnicodeString(name);
  const payload = Buffer.alloc(6 + namePayload.length);
  payload.writeUInt32LE(streamOffset, 0);
  payload[4] = state;
  payload[5] = sheetType;
  namePayload.copy(payload, 6);
  return record(RECORD.BOUND_SHEET_8, payload);
}

function palette() {
  const payload = Buffer.alloc(6);
  payload.writeUInt16LE(1, 0);
  payload[2] = 0x12;
  payload[3] = 0x34;
  payload[4] = 0x56;
  return record(RECORD.PALETTE, payload);
}

function cellHeader(row, column, xfIndex) {
  const output = Buffer.alloc(6);
  output.writeUInt16LE(row, 0);
  output.writeUInt16LE(column, 2);
  output.writeUInt16LE(xfIndex, 4);
  return output;
}

function rowRecord(rowIndex, { formatted = false, xfIndex = 0, hidden = false } = {}) {
  const payload = Buffer.alloc(16);
  payload.writeUInt16LE(rowIndex, 0);
  payload.writeUInt16LE(0, 2);
  payload.writeUInt16LE(12, 4);
  payload.writeUInt16LE(formatted ? 400 : 300, 6);
  payload[12] = (rowIndex === 0 ? 0x11 : 0)
    | (hidden ? 0x20 : 0)
    | 0x40
    | (formatted ? 0x80 : 0);
  payload[13] = 1;
  payload.writeUInt16LE(formatted ? xfIndex : 0, 14);
  return record(RECORD.ROW, payload);
}

function colInfo(first, last, xfIndex) {
  const payload = Buffer.alloc(12);
  payload.writeUInt16LE(first, 0);
  payload.writeUInt16LE(last, 2);
  payload.writeUInt16LE(12 * 256, 4);
  payload.writeUInt16LE(xfIndex, 6);
  payload.writeUInt16LE(0x1207, 8);
  return record(RECORD.COL_INFO, payload);
}

function blank(row, column, xfIndex) {
  return record(RECORD.BLANK, cellHeader(row, column, xfIndex));
}

function number(row, column, xfIndex) {
  const payload = Buffer.alloc(14);
  cellHeader(row, column, xfIndex).copy(payload);
  payload.writeDoubleLE(42.5, 6);
  return record(RECORD.NUMBER, payload);
}

function rk(row, column, xfIndex) {
  const payload = Buffer.alloc(10);
  cellHeader(row, column, xfIndex).copy(payload);
  payload.writeUInt32LE((42 << 2) | 2, 6);
  return record(RECORD.RK, payload);
}

function mulBlank(row, firstColumn, xfIndexes) {
  const payload = Buffer.alloc(6 + xfIndexes.length * 2);
  payload.writeUInt16LE(row, 0);
  payload.writeUInt16LE(firstColumn, 2);
  xfIndexes.forEach((value, index) => payload.writeUInt16LE(value, 4 + index * 2));
  payload.writeUInt16LE(firstColumn + xfIndexes.length - 1, payload.length - 2);
  return record(RECORD.MUL_BLANK, payload);
}

function mulRk(row, firstColumn, xfIndexes) {
  const payload = Buffer.alloc(6 + xfIndexes.length * 6);
  payload.writeUInt16LE(row, 0);
  payload.writeUInt16LE(firstColumn, 2);
  xfIndexes.forEach((value, index) => {
    payload.writeUInt16LE(value, 4 + index * 6);
    payload.writeUInt32LE(((index + 1) << 2) | 2, 6 + index * 6);
  });
  payload.writeUInt16LE(firstColumn + xfIndexes.length - 1, payload.length - 2);
  return record(RECORD.MUL_RK, payload);
}

function label(type, row, column, xfIndex, value) {
  return record(type, Buffer.concat([cellHeader(row, column, xfIndex), unicodeString(value)]));
}

function labelSst(row, column, xfIndex) {
  const payload = Buffer.alloc(10);
  cellHeader(row, column, xfIndex).copy(payload);
  payload.writeUInt32LE(0, 6);
  return record(RECORD.LABEL_SST, payload);
}

function boolErr(row, column, xfIndex) {
  const payload = Buffer.alloc(8);
  cellHeader(row, column, xfIndex).copy(payload);
  payload[6] = 1;
  payload[7] = 0;
  return record(RECORD.BOOL_ERR, payload);
}

function formula(row, column, xfIndex, cachedString = false) {
  const payload = Buffer.alloc(22);
  cellHeader(row, column, xfIndex).copy(payload);
  if (cachedString) {
    payload[6] = 0;
    payload.writeUInt16LE(0xffff, 12);
  } else {
    payload.writeDoubleLE(9, 6);
  }
  payload.writeUInt16LE(0, 20);
  return record(RECORD.FORMULA, payload);
}

function continuedString(value) {
  const payload = unicodeString(value);
  const splitAt = 5;
  return Buffer.concat([
    record(RECORD.STRING, payload.subarray(0, splitAt)),
    record(RECORD.CONTINUE, Buffer.concat([Buffer.from([1]), payload.subarray(splitAt)]))
  ]);
}

async function themeRecord() {
  const themeXml = `<?xml version="1.0" encoding="UTF-8"?>
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements><a:clrScheme name="Fixture">
        <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
        <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
        <a:dk2><a:srgbClr val="111111"/></a:dk2>
        <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
        <a:accent1><a:srgbClr val="336699"/></a:accent1>
        <a:accent2><a:srgbClr val="993333"/></a:accent2>
        <a:accent3><a:srgbClr val="339933"/></a:accent3>
        <a:accent4><a:srgbClr val="663399"/></a:accent4>
        <a:accent5><a:srgbClr val="339999"/></a:accent5>
        <a:accent6><a:srgbClr val="CC6600"/></a:accent6>
        <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
        <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
      </a:clrScheme></a:themeElements>
    </a:theme>`;
  const zip = new JSZip();
  zip.file('theme/theme/theme1.xml', themeXml);
  const packageBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const payload = Buffer.concat([frtHeader(RECORD.THEME), Buffer.alloc(4), packageBytes]);
  const splitAt = Math.min(60, payload.length - 1);
  return Buffer.concat([
    record(RECORD.THEME, payload.subarray(0, splitAt)),
    record(RECORD.CONTINUE, payload.subarray(splitAt))
  ]);
}

function makeSheet() {
  const defaultRow = Buffer.alloc(4);
  defaultRow.writeUInt16LE(1, 0);
  defaultRow.writeInt16LE(300, 2);
  return Buffer.concat([
    bof(0x0010),
    record(RECORD.DEFAULT_ROW_HEIGHT, defaultRow),
    record(RECORD.DEF_COL_WIDTH, uint16(10)),
    record(RECORD.STANDARD_WIDTH, uint16(12 * 256)),
    colInfo(0, 1, 3),
    rowRecord(0, { formatted: true, xfIndex: 2, hidden: true }),
    blank(0, 0, 1),
    mulBlank(0, 1, [1, 1]),
    rowRecord(1),
    number(1, 0, 1),
    rk(1, 1, 1),
    mulRk(1, 2, [1, 1]),
    rowRecord(2),
    label(RECORD.LABEL, 2, 0, 1, 'Label'),
    labelSst(2, 1, 1),
    label(RECORD.RSTRING, 2, 2, 1, 'Rich'),
    boolErr(2, 3, 1),
    rowRecord(3),
    formula(3, 0, 1),
    formula(3, 1, 1, true),
    continuedString('缓存'),
    record(RECORD.EOF)
  ]);
}

async function makeWorkbookStream(options = {}) {
  const {
    filePass = false,
    unknownExt = false,
    unknownColorType = false,
    badBoundSheetOffset = false,
    version = 0x0600,
    includeXfCrc = true,
    includeXfExt = true,
    corruptXfCrc = false,
    xfCrcCount = null,
    xfExtIndex = 1,
    duplicateXfExt = false,
    styleExtensionBit = false,
    customFormatId = 164,
    customFormatCode = 'yyyy-mm-dd',
    includeCustomFormat = true,
    additionalFormats = [],
    primaryCellNumFmtId = customFormatId,
    compressedBaseFont = false
  } = options;
  const cellXfExtFlag = options.cellXfExtFlag == null
    ? (includeXfExt && xfExtIndex === 1)
    : options.cellXfExtFlag;
  const theme = await themeRecord();
  const customFormat = record(RECORD.FORMAT, Buffer.concat([
    uint16(customFormatId),
    unicodeString(customFormatCode)
  ]));
  const additionalFormatRecords = additionalFormats.map((format) => (
    record(RECORD.FORMAT, Buffer.concat([
      uint16(format.id),
      unicodeString(format.code)
    ]))
  ));
  const xfRecords = [
    xf({ style: true, extensionBit: styleExtensionBit }),
    xf({
      fontIndex: 1,
      numFmtId: primaryCellNumFmtId,
      horizontal: 2,
      wrap: true,
      vertical: 1,
      rotation: 45,
      indent: 3,
      shrink: true,
      readOrder: 2,
      leftStyle: 1,
      rightStyle: 2,
      topStyle: 3,
      bottomStyle: 4,
      borderColor: 8,
      diagonalFlags: 3,
      diagonalStyle: 5,
      fillPattern: 1,
      fillForeground: 8,
      extensionBit: cellXfExtFlag
    }),
    xf({ horizontal: 1 }),
    xf({ horizontal: 3 }),
    ...Array.from({ length: 12 }, () => xf())
  ];
  let computedCrc = 0;
  xfRecords.forEach((xfRecord) => {
    computedCrc = msoCrc32Compute(computedCrc, xfRecord.subarray(4));
  });
  const extensionRecord = xfExt(xfExtIndex, { unknown: unknownExt, unknownColorType });
  const fixedGlobals = [
    bof(0x0005, version),
    record(RECORD.CODE_PAGE, uint16(1200)),
    record(RECORD.DATE_1904, uint16(1)),
    ...(filePass ? [record(RECORD.FILE_PASS, uint16(0))] : []),
    font({ compressedName: compressedBaseFont }),
    font({
      name: '微软雅黑',
      heightTwips: 280,
      flags: 0x000a,
      colorIndex: 8,
      weight: 700,
      escapement: 1,
      underline: 1,
      family: 2,
      charset: 0x86
    }),
    ...(includeCustomFormat ? [customFormat] : []),
    ...additionalFormatRecords,
    palette(),
    ...xfRecords,
    ...(includeXfCrc
      ? [xfCrc(xfRecords, {
          count: xfCrcCount == null ? xfRecords.length : xfCrcCount,
          crc: corruptXfCrc ? (computedCrc ^ 1) >>> 0 : computedCrc
        })]
      : []),
    ...(includeXfExt ? [extensionRecord] : []),
    ...(includeXfExt && duplicateXfExt ? [extensionRecord] : []),
    theme
  ];
  const placeholderGlobal = Buffer.concat([...fixedGlobals, boundSheet(0), record(RECORD.EOF)]);
  const sheet = makeSheet();
  const sheetOffset = badBoundSheetOffset ? placeholderGlobal.length + 1 : placeholderGlobal.length;
  const globals = Buffer.concat([...fixedGlobals, boundSheet(sheetOffset), record(RECORD.EOF)]);
  return Buffer.concat([globals, sheet]);
}

function mutateLogicalRecord(stream, type, occurrence, mutate) {
  const output = Buffer.from(stream);
  let offset = 0;
  let seen = 0;
  while (offset < output.length) {
    const logical = readLogicalRecord(output, offset);
    offset = logical.nextOffset;
    if (logical.type !== type) continue;
    if (seen === occurrence) {
      mutate(logical.payload, logical);
      return output;
    }
    seen += 1;
  }
  throw new Error(`找不到第 ${occurrence + 1} 个 BIFF8 record 0x${type.toString(16)}`);
}

function wrapCfb(workbookStream) {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, 'Workbook', workbookStream);
  return XLSX.CFB.write(cfb, { type: 'buffer' });
}

test('BIFF8 logical record scanner 拼接 Continue 并保留物理边界', () => {
  const bytes = Buffer.concat([
    record(0x1234, Buffer.from('abc')),
    record(RECORD.CONTINUE, Buffer.from('def')),
    record(RECORD.EOF)
  ]);
  const logical = readLogicalRecord(bytes, 0);
  assert.equal(logical.type, 0x1234);
  assert.equal(logical.payload.toString(), 'abcdef');
  assert.deepEqual(logical.physical.map((entry) => entry.type), [0x1234, RECORD.CONTINUE]);
  assert.equal(logical.nextOffset, 14);
});

test('MsoCrc32Compute 使用 0 初值、0xAF 多项式和 MSB-first 顺序', () => {
  const bytes = Buffer.from('123456789', 'ascii');
  assert.equal(msoCrc32Compute(0, bytes), 0xbd0be338);
  const first = msoCrc32Compute(0, bytes.subarray(0, 4));
  assert.equal(msoCrc32Compute(first, bytes.subarray(4)), 0xbd0be338);
});

test('BIFF8 record scanner 覆盖 globals、布局和全部带 XF cell records', async () => {
  const stream = await makeWorkbookStream();
  const scanned = scanBiff8WorkbookStream(stream);
  assert.equal(scanned.codePage, 1200);
  assert.equal(scanned.date1904, true);
  assert.equal(scanned.fonts.length, 2);
  assert.equal(scanned.xfs.length, 16);
  assert.equal(scanned.xfCrc.xfCount, 16);
  assert.equal(scanned.xfCrc.crc, scanned.computedXfCrc);
  assert.equal(scanned.theme.packageBytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.deepEqual(scanned.customFormats, [{ id: 164, code: 'yyyy-mm-dd' }]);
  assert.deepEqual(scanned.palette, ['123456']);
  assert.equal(scanned.sheets.length, 1);
  const sheet = scanned.sheets[0];
  assert.equal(sheet.defaultRow.heightPoints, 15);
  assert.equal(sheet.defaultRow.customHeight, true);
  assert.equal(sheet.defaultColumnWidth, 12);
  assert.equal(sheet.columns[0].hidden, true);
  assert.equal(sheet.columns[0].outlineLevel, 2);
  assert.equal(sheet.rows[0].hidden, true);
  assert.equal(sheet.rows[0].formatted, true);
  assert.equal(sheet.rows[0].xfIndex, 2);
  assert.deepEqual(
    Array.from(new Set(sheet.cells.map((cell) => cell.recordType))).sort(),
    ['Blank', 'BoolErr', 'Formula', 'Label', 'LabelSst', 'MulBlank', 'MulRK', 'Number', 'RK', 'RString']
  );
  assert.equal(sheet.cells.length, 13);
  assert.equal(sheet.cells.filter((cell) => cell.explicitBlank).length, 3);
});

test('BIFF8 Format 以物理记录覆盖允许的低位范围，保护 canonical built-in，id 164 保持可用', async () => {
  const customScan = scanBiff8WorkbookStream(await makeWorkbookStream());
  assert.equal(customScan.formats.get(164), 'yyyy-mm-dd');
  assert.deepEqual(customScan.customFormats, [{ id: 164, code: 'yyyy-mm-dd' }]);

  const lowCustomScan = scanBiff8WorkbookStream(await makeWorkbookStream({
    customFormatId: 60,
    customFormatCode: 'yyyy-mm-dd hh:mm',
    primaryCellNumFmtId: 60
  }));
  assert.equal(lowCustomScan.formats.get(60), 'yyyy-mm-dd hh:mm');
  assert.deepEqual(lowCustomScan.customFormats, [{ id: 60, code: 'yyyy-mm-dd hh:mm' }]);

  const localeScan = scanBiff8WorkbookStream(await makeWorkbookStream({
    customFormatId: 5,
    customFormatCode: '"￥"#,##0;"￥"\\-#,##0',
    primaryCellNumFmtId: 5
  }));
  assert.equal(localeScan.formats.get(5), '"￥"#,##0;"￥"\\-#,##0');

  for (const { id, expected } of [
    { id: 14, expected: 'mm-dd-yy' },
    { id: 22, expected: 'm/d/yy h:mm' }
  ]) {
    const matchingDeclaration = await makeWorkbookStream({
      customFormatId: id,
      customFormatCode: expected,
      primaryCellNumFmtId: id
    });
    const builtinScan = scanBiff8WorkbookStream(matchingDeclaration);
    assert.equal(builtinScan.formats.get(id), expected);
    assert.deepEqual(builtinScan.customFormats, []);

    const conflictingDeclaration = await makeWorkbookStream({
      customFormatId: id,
      customFormatCode: 'General',
      primaryCellNumFmtId: id
    });
    assert.throws(
      () => scanBiff8WorkbookStream(conflictingDeclaration),
      (error) => (
        error instanceof Biff8RecordError
        && error.code === 'BIFF8_PROTECTED_FORMAT_OVERRIDE'
        && error.detail.id === id
      )
    );
  }

  const duplicateLowId = await makeWorkbookStream({
    customFormatId: 60,
    customFormatCode: 'yyyy-mm-dd hh:mm',
    additionalFormats: [{ id: 60, code: '0.00' }],
    primaryCellNumFmtId: 60
  });
  assert.throws(
    () => scanBiff8WorkbookStream(duplicateLowId),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_DUPLICATE_FORMAT_ID'
  );
});

test('BIFF8 Font ShortXLUnicodeString 接受压缩 ASCII 字体名', async () => {
  const scanned = scanBiff8WorkbookStream(await makeWorkbookStream({
    compressedBaseFont: true
  }));
  assert.equal(scanned.fonts[0].name, 'Arial');
});

test('BIFF8 Number、Formula、RK 与 MulRK 的非有限数值一律 fail-closed', async () => {
  const base = await makeWorkbookStream();
  const cases = [];
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    cases.push({
      label: `Number ${String(value)}`,
      stream: mutateLogicalRecord(base, RECORD.NUMBER, 0, (payload) => {
        payload.writeDoubleLE(value, 6);
      })
    });
    cases.push({
      label: `Formula ${String(value)}`,
      stream: mutateLogicalRecord(base, RECORD.FORMULA, 0, (payload) => {
        payload.writeDoubleLE(value, 6);
      })
    });
  }
  for (const raw of [0x7ff00000, 0x7ff80000, 0xfff00000]) {
    cases.push({
      label: `RK 0x${raw.toString(16)}`,
      stream: mutateLogicalRecord(base, RECORD.RK, 0, (payload) => {
        payload.writeUInt32LE(raw, 6);
      })
    });
    cases.push({
      label: `MulRK 0x${raw.toString(16)}`,
      stream: mutateLogicalRecord(base, RECORD.MUL_RK, 0, (payload) => {
        payload.writeUInt32LE(raw, 6);
      })
    });
  }

  for (const entry of cases) {
    assert.throws(
      () => scanBiff8WorkbookStream(entry.stream),
      (error) => (
        error instanceof Biff8RecordError
        && error.code === 'BIFF8_NON_FINITE_CELL_VALUE'
      ),
      entry.label
    );
  }
});

test('BIFF8 Formula special cached value 严格校验类型、reserved bytes 和值域', async () => {
  const base = await makeWorkbookStream();
  const invalidCases = [
    {
      label: '未知 type',
      mutate(payload) {
        payload[6] = 9;
      }
    },
    {
      label: 'reserved byte',
      mutate(payload) {
        payload[7] = 1;
      }
    },
    {
      label: '非法 boolean',
      mutate(payload) {
        payload[6] = 1;
        payload[8] = 2;
      }
    },
    {
      label: '非法 error code',
      mutate(payload) {
        payload[6] = 2;
        payload[8] = 1;
      }
    },
    {
      label: 'blank 的 value byte 非零',
      mutate(payload) {
        payload[6] = 3;
        payload[8] = 1;
      }
    }
  ];
  for (const entry of invalidCases) {
    const stream = mutateLogicalRecord(base, RECORD.FORMULA, 1, entry.mutate);
    assert.throws(
      () => scanBiff8WorkbookStream(stream),
      (error) => (
        error instanceof Biff8RecordError
        && error.code === 'BIFF8_INVALID_FORMULA_CACHED_VALUE'
      ),
      entry.label
    );
  }

  for (const { type, value } of [
    { type: 1, value: 1 },
    { type: 2, value: 0x07 },
    { type: 3, value: 0 }
  ]) {
    const stream = mutateLogicalRecord(base, RECORD.FORMULA, 0, (payload) => {
      payload.fill(0, 6, 14);
      payload[6] = type;
      payload[8] = value;
      payload.writeUInt16LE(0xffff, 12);
    });
    assert.doesNotThrow(() => scanBiff8WorkbookStream(stream));
  }
});

test('BIFF8 BoolErr 严格区分 boolean/error 并校验各自值域', async () => {
  const base = await makeWorkbookStream();
  for (const { value, flag } of [
    { value: 2, flag: 0 },
    { value: 1, flag: 1 },
    { value: 1, flag: 2 }
  ]) {
    const stream = mutateLogicalRecord(base, RECORD.BOOL_ERR, 0, (payload) => {
      payload[6] = value;
      payload[7] = flag;
    });
    assert.throws(
      () => scanBiff8WorkbookStream(stream),
      (error) => (
        error instanceof Biff8RecordError
        && error.code === 'BIFF8_INVALID_BOOLERR_VALUE'
      )
    );
  }

  for (const { value, flag } of [
    { value: 0, flag: 0 },
    { value: 1, flag: 0 },
    { value: 0x07, flag: 1 },
    { value: 0x2a, flag: 1 }
  ]) {
    const stream = mutateLogicalRecord(base, RECORD.BOOL_ERR, 0, (payload) => {
      payload[6] = value;
      payload[7] = flag;
    });
    assert.doesNotThrow(() => scanBiff8WorkbookStream(stream));
  }
});

test('BIFF8 overlay 从 CFB 解析完整样式、Theme/XFExt 颜色和 whole-XF precedence', async () => {
  const stream = await makeWorkbookStream();
  const overlay = await readBiff8Overlay(wrapCfb(stream));
  assert.equal(overlay.streamName, 'Workbook');
  assert.equal(overlay.date1904, true);
  assert.equal(overlay.themeColorsArgb[4], 'FF336699');
  assert.equal(overlay.paletteArgb[8], 'FF123456');

  const style = overlay.styles[1];
  assert.equal(style.numFmt, 'yyyy-mm-dd');
  assert.equal(style.font.name, '微软雅黑');
  assert.equal(style.font.size, 14);
  assert.equal(style.font.bold, true);
  assert.equal(style.font.italic, true);
  assert.equal(style.font.underline, 'single');
  assert.equal(style.font.strike, true);
  assert.equal(style.font.vertAlign, 'superscript');
  assert.notEqual(style.font.colorArgb, 'FF336699');
  assert.equal(style.fill.pattern, 'solid');
  assert.equal(style.fill.foregroundArgb, 'FF123456');
  assert.equal(style.border.left.style, 'thin');
  assert.equal(style.border.right.style, 'medium');
  assert.equal(style.border.top.style, 'dashed');
  assert.equal(style.border.bottom.style, 'dotted');
  assert.deepEqual(
    { up: style.border.diagonal.up, down: style.border.diagonal.down },
    { up: true, down: true }
  );
  assert.equal(style.alignment.horizontal, 'center');
  assert.equal(style.alignment.vertical, 'center');
  assert.equal(style.alignment.wrapText, true);
  assert.equal(style.alignment.textRotation, 45);
  assert.equal(style.alignment.indent, 7);
  assert.equal(style.alignment.shrinkToFit, true);
  assert.equal(style.alignment.readingOrder, 'rightToLeft');
  assert.equal(style.lineageOnly, true);
  assert.equal(style.staticStyle.font.color.argb, style.font.colorArgb);
  assert.equal(style.staticStyle.fill.fgColor.argb, 'FF123456');
  assert.equal(style.staticStyle.border.left.color.argb, 'FF123456');

  const resolver = createBiff8GridResolver(overlay);
  assert.equal(resolver.resolve('Data', 0, 0).source, 'cell');
  assert.equal(resolver.resolve('Data', 0, 5).source, 'row');
  assert.equal(resolver.resolve('Data', 5, 1).source, 'column');
  assert.equal(resolver.resolve('Data', 5, 5).source, 'workbookDefault');
  assert.equal(resolver.resolve('Data', 0, 5).xfIndex, 2);
  assert.equal(resolver.resolve('Data', 5, 1).xfIndex, 3);
  assert.equal(resolver.resolve('Data', 5, 5).xfIndex, 1);
});

test('BIFF8 overlay projection 对 sheet、坐标和 XF 均严格 fail-closed', async () => {
  const overlay = await readBiff8Overlay(wrapCfb(await makeWorkbookStream()));
  const projection = {
    sheets: overlay.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.cells.map((cell) => ({
        row: cell.row,
        column: cell.column,
        xfIndex: cell.xfIndex
      }))
    }))
  };
  assert.equal(assertBiff8OverlayMatchesProjection(overlay, projection), true);

  const missing = structuredClone(projection);
  missing.sheets[0].cells.pop();
  assert.throws(
    () => assertBiff8OverlayMatchesProjection(overlay, missing),
    (error) => error instanceof Biff8OverlayError && error.code === 'BIFF8_OVERLAY_COORDINATE_MISMATCH'
  );
  const wrongXf = structuredClone(projection);
  wrongXf.sheets[0].cells[0].xfIndex = 3;
  assert.throws(
    () => assertBiff8OverlayMatchesProjection(overlay, wrongXf),
    (error) => error instanceof Biff8OverlayError && error.code === 'BIFF8_OVERLAY_XF_MISMATCH'
  );
});

test('BIFF8 非 0x0600、FilePass、损坏 BoundSheet offset 和未知 XFExt 均 fail-closed', async () => {
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ version: 0x0500 })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_UNSUPPORTED_VERSION'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ filePass: true })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_ENCRYPTED_FILE'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ badBoundSheetOffset: true })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_BOUND_SHEET_OFFSET_MISMATCH'
  );
  await assert.rejects(
    async () => readBiff8Overlay(wrapCfb(await makeWorkbookStream({ unknownExt: true }))),
    (error) => error instanceof Biff8OverlayError && error.code === 'BIFF8_UNKNOWN_REQUIRED_XFEXT'
  );
  await assert.rejects(
    async () => readBiff8Overlay(wrapCfb(await makeWorkbookStream({ unknownColorType: true }))),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_UNKNOWN_XCOLOR_TYPE'
  );
  assert.throws(
    () => scanBiff8WorkbookStream(Buffer.from([0x09, 0x08, 0x10, 0x00, 0, 0, 0, 0])),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_TRUNCATED_RECORD'
  );
});

test('BIFF8 XFCRC 的 presence、count 和 MsoCrc32 checksum 均严格校验', async () => {
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ includeXfCrc: false })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_MISSING_XFCRC'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({
      includeXfExt: false,
      cellXfExtFlag: false
    })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_ORPHAN_XFCRC'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ xfCrcCount: 17 })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_XFCRC_COUNT_MISMATCH'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ corruptXfCrc: true })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_XFCRC_MISMATCH'
  );
});

test('BIFF8 CellXF fHasXFExt 双向一致，StyleXF reserved2 与 XFExt 独立', async () => {
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ cellXfExtFlag: false })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_XFEXT_FLAG_MISMATCH'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({
      includeXfCrc: false,
      includeXfExt: false,
      cellXfExtFlag: true
    })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_XFEXT_FLAG_MISMATCH'
  );
  const styleExtension = scanBiff8WorkbookStream(await makeWorkbookStream({
    xfExtIndex: 0,
    cellXfExtFlag: false
  }));
  assert.equal(styleExtension.xfExts[0].xfIndex, 0);
  assert.equal(styleExtension.xfs[0].isStyle, true);
  assert.equal(styleExtension.xfs[0].styleReserved2, false);
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({
      xfExtIndex: 0,
      cellXfExtFlag: false,
      styleExtensionBit: true
    })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_INVALID_STYLE_XF_RESERVED'
  );
});

test('BIFF8 XFExt 重复和越界继续 fail-closed', async () => {
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({ duplicateXfExt: true })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_DUPLICATE_XFEXT'
  );
  await assert.rejects(
    async () => scanBiff8WorkbookStream(await makeWorkbookStream({
      xfExtIndex: 16,
      cellXfExtFlag: false
    })),
    (error) => error instanceof Biff8RecordError && error.code === 'BIFF8_XFEXT_INDEX_OUT_OF_RANGE'
  );
});

test('真实 BIFF8 资产能解析 Theme、XFExt 和全部 cell/style XF', async () => {
  const fixture = path.join(__dirname, '..', '..', 'assets', '外汇交割表.xls');
  const overlay = await readBiff8Overlay(fixture);
  assert.equal(overlay.format, 'biff8');
  assert.equal(overlay.codePage, 1200);
  assert.equal(overlay.themeColorsArgb.length, 12);
  assert.equal(overlay.styles.length, 66);
  assert.equal(overlay.sheets.length, 1);
  assert.ok(overlay.sheets[0].cells.length > 0);
  const workbook = XLSX.readFile(fixture, {
    raw: true,
    cellDates: false,
    cellNF: true,
    cellText: true,
    sheetStubs: true
  });
  const projection = {
    sheets: workbook.SheetNames.map((name) => ({
      name,
      cells: Object.keys(workbook.Sheets[name])
        .filter((address) => !address.startsWith('!'))
        .map((address) => {
          const coordinate = XLSX.utils.decode_cell(address);
          return { row: coordinate.r, column: coordinate.c };
        })
    }))
  };
  assert.equal(assertBiff8OverlayMatchesProjection(overlay, projection), true);
});
