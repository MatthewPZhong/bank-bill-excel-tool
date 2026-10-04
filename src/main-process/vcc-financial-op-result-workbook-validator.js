'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sax = require('sax');
const { Readable } = require('node:stream');
const { openRichWorkbook } = require('../backend/xlsx/rich-workbook');
const { openZipWithEntries } = require('../backend/xlsx/zip-reader');
const { TOOLBOX_XLSX_METADATA_LIMITS, readToolboxMetadataEntryAsString, parseWorkbookRelationships, findRelationshipEntry } = require('../backend/xlsx/workbook-parts');
const { decodeExcelStXstring } = require('../backend/xlsx/excel-text');
const { decimalComparable } = require('../backend/xlsx/number-date');
const { SPREADSHEETML_NAMESPACES, namespaceAllowed, normalizedSaxAttributes } = require('../backend/xlsx/ooxml-namespaces');
const { normalizeStaticStyle, stableSignature, resolveColorSpec } = require('../backend/xlsx/style-registry');
const { encodeAdjustmentLineageName } = require('../backend/vcc-financial-op/adjustment-lineage');
const { quoteSheetName } = require('../backend/vcc-financial-op/result-sheet-plan');
const { hashClosedFile } = require('./biz-op-v327/export-validator');
const { canonicalMergeRanges, createResultWorksheetRawParser } = require('./vcc-financial-op-writer');
const StylesXform = require('exceljs/lib/xlsx/xform/style/styles-xform');
const ListXform = require('exceljs/lib/xlsx/xform/list-xform');
const SheetPropertiesXform = require('exceljs/lib/xlsx/xform/sheet/sheet-properties-xform');
const SheetFormatPropertiesXform = require('exceljs/lib/xlsx/xform/sheet/sheet-format-properties-xform');
const SheetViewXform = require('exceljs/lib/xlsx/xform/sheet/sheet-view-xform');
const PageMarginsXform = require('exceljs/lib/xlsx/xform/sheet/page-margins-xform');
const PageSetupXform = require('exceljs/lib/xlsx/xform/sheet/page-setup-xform');
const PrintOptionsXform = require('exceljs/lib/xlsx/xform/sheet/print-options-xform');
const AutoFilterXform = require('exceljs/lib/xlsx/xform/sheet/auto-filter-xform');
const HeaderFooterXform = require('exceljs/lib/xlsx/xform/sheet/header-footer-xform');

const METADATA_ROOTS = new Set(['sheetPr', 'sheetViews', 'sheetFormatPr', 'autoFilter', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter']);
function failure(message) { return Object.assign(new Error(message), { code: 'vcc-result-export-validation-failed' }); }
function closeZip(zip) {
  if (zip.reader.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off('close', done); zip.off('error', failed); };
    const done = () => { cleanup(); resolve(); }, failed = (error) => { cleanup(); reject(error); };
    zip.once('close', done); zip.once('error', failed);
    try { zip.close(); } catch (error) { failed(error); }
  });
}
function check(signal) {
  if (signal?.aborted) throw Object.assign(new Error('VCC 正式结果校验已取消'), { code: 'VCC_EXPORT_CANCELLED' });
}
function equal(actual, expected, message) {
  if (stableSignature(actual) !== stableSignature(expected)) throw failure(message);
}

// 仅缓存小型布局树；sheetData 保持流式，原始合并从格由旧严格 parser 同步核验。
function metadataParser({ expected, signal } = {}) {
  const metadata = {}, merges = [], stack = [];
  let layoutNodes = 0, layoutTextBytes = 0;
  let active = null, depth = 0, inCell = false;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    check(signal); depth += 1;
    const name = node.local || node.name, attributes = normalizedSaxAttributes(node.attributes);
    if (name === 'c') inCell = true;
    if (inCell && !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) throw failure('正式结果单元格包含非预期命名空间');
    if (['f', 'hyperlink', 'externalLink', 'r', 'rPh', 'phoneticPr', 'sheetProtection', 'conditionalFormatting', 'dataValidation', 'drawing', 'oleObject'].includes(name)) {
      throw failure('正式结果存在非预期公式、链接或附加内容');
    }
    if (active && ++layoutNodes > 4096) throw failure('正式结果布局元数据超过预算');
    if (METADATA_ROOTS.has(name) && depth === 2) {
      if (metadata[name]) throw failure(`正式结果布局元素重复：${name}`);
      active = { name, attributes, text: '', children: [] }; metadata[name] = active; stack.push(active);
    } else if (active) {
      const child = { name, attributes, text: '', children: [] };
      stack[stack.length - 1].children.push(child); stack.push(child);
    }
    if (name === 'mergeCell') merges.push(attributes.ref);
  };
  parser.ontext = (text) => {
    if (active) {
      layoutTextBytes += Buffer.byteLength(text);
      if (layoutTextBytes > 1024 * 1024) throw failure('正式结果布局文本超过预算');
      stack[stack.length - 1].text += text;
    }
  };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (rawName) => {
    const name = String(rawName).replace(/^.*:/, '');
    if (active) { stack.pop(); if (stack.length === 0) active = null; }
    if (name === 'c') inCell = false;
    depth -= 1;
  };
  return { parser, finish() {
    if (expected) {
      equal(metadata, expectedSheetMetadata(expected.sheet), `${expected.sheet.name} 打印、冻结或筛选布局不符`);
      equal(merges.slice().sort(), canonicalMergeRanges(expected.sheet), `${expected.sheet.name} 合并区域不符`);
    }
    return metadata;
  } };
}

function expectedSheetMetadata(sheet) {
  const properties = sheet.properties, pageSetup = sheet.pageSetup;
  const parts = [
    new SheetPropertiesXform().toXml({ outlineProperties: properties.outlineProperties, tabColor: properties.tabColor,
      pageSetup: pageSetup.fitToPage ? { fitToPage: pageSetup.fitToPage } : undefined }),
    new ListXform({ tag: 'sheetViews', length: false, childXform: new SheetViewXform() }).toXml(sheet.views),
    new SheetFormatPropertiesXform().toXml(properties),
    new AutoFilterXform().toXml(sheet.autoFilter),
    new PrintOptionsXform().toXml(pageSetup),
    new PageMarginsXform().toXml(pageSetup.margins),
    new PageSetupXform().toXml(pageSetup),
    new HeaderFooterXform().toXml(sheet.headerFooter)
  ];
  const parsed = metadataParser();
  parsed.parser.write(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">${parts.join('')}</worksheet>`).close();
  return parsed.finish();
}

async function scanXml(opened, entryPath, parsers, signal, maxBytes) {
  const entry = opened.entries.get(entryPath);
  if (!entry || entry.uncompressedSize > maxBytes) throw failure(`XLSX 部件缺失或超过读取预算：${entryPath}`);
  const stream = await new Promise((resolve, reject) => opened.zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
  stream.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    let settled = false, bytes = 0;
    const finish = (error) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', aborted);
      stream.destroy(); error ? reject(error) : resolve();
    };
    const aborted = () => { try { check(signal); } catch (error) { finish(error); } };
    stream.on('error', finish);
    stream.on('close', () => { if (!settled) finish(failure(`${entryPath} 原始 XML 提前关闭`)); });
    stream.on('data', (chunk) => {
      try {
        check(signal); bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) throw failure(`${entryPath} 超过读取预算`);
        parsers.forEach((parser) => parser.write(chunk));
      } catch (error) { finish(error); }
    });
    stream.on('end', () => {
      try { parsers.forEach((parser) => parser.close()); finish(); } catch (error) { finish(error); }
    });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function splitRanges(value) {
  const ranges = []; let current = '', quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      if (quoted && value[index + 1] === "'") { current += "''"; index += 1; continue; }
      quoted = !quoted;
    }
    if (char === ',' && !quoted) { ranges.push(current); current = ''; } else current += char;
  }
  if (quoted) throw failure('定义名称 Sheet 引号不完整');
  ranges.push(current);
  return ranges;
}
function normalizeRange(value) {
  const match = /^(?:'((?:[^']|'')*)'|([^'!]+))!\$?([A-Z]+)\$?([1-9]\d*)(?::\$?([A-Z]+)\$?([1-9]\d*))?$/.exec(value);
  if (!match) throw failure('定义名称范围无效');
  const sheet = match[1] == null ? match[2] : match[1].replace(/''/g, "'");
  return `${quoteSheetName(sheet)}!${match[3]}${match[4]}${match[5] ? `:${match[5]}${match[6]}` : ''}`;
}
function readDefinedNames(xml) {
  const names = [], sheetIds = new Set(); let current = null;
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    if ((node.local || node.name) === 'sheet') {
      const id = Number(normalizedSaxAttributes(node.attributes).sheetid);
      if (!Number.isSafeInteger(id) || id < 1 || sheetIds.has(id)) throw failure('工作表 sheetId 无效或重复');
      sheetIds.add(id);
    }
    if ((node.local || node.name) === 'definedName') {
      if (current || !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) throw failure('定义名称声明无效');
      const attributes = normalizedSaxAttributes(node.attributes);
      current = { ...attributes, localSheetId: attributes.localsheetid, value: '' };
    }
  };
  parser.ontext = (value) => { if (current) current.value += value; };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (name) => { if (String(name).replace(/^.*:/, '') === 'definedName') { names.push(current); current = null; } };
  parser.write(xml).close();
  return names;
}
function validateDefinedNames(actual, expectedNames, printAreas) {
  const seen = new Set();
  for (const item of actual) {
    if (item.name === '_xlnm.Print_Area') {
      const key = Number(item.localSheetId);
      if (!Number.isSafeInteger(key) || !printAreas.has(key) || normalizeRange(item.value) !== normalizeRange(printAreas.get(key))) throw failure('主体打印范围或作用域不符');
      printAreas.delete(key); continue;
    }
    if (item.localSheetId != null || seen.has(String(item.name).toLocaleLowerCase('en-US'))) throw failure('调整定义名称重复或作用域不符');
    seen.add(String(item.name).toLocaleLowerCase('en-US'));
    const expected = expectedNames.get(item.name);
    if (!expected) throw failure('工作簿存在孤儿或非预期定义名称');
    const ranges = splitRanges(item.value).map(normalizeRange).sort();
    equal(ranges, expected.map(normalizeRange).sort(), '调整血缘引用与主体、币种或局部行号不符');
    expectedNames.delete(item.name);
  }
  if (expectedNames.size || printAreas.size) throw failure('调整血缘或主体打印范围缺失');
}

function templateStyle(style) {
  const clone = JSON.parse(JSON.stringify(style || {}));
  for (const container of [clone.font, clone.fill, ...Object.values(clone.border || {})]) {
    if (!container || typeof container !== 'object') continue;
    for (const key of ['color', 'fgColor', 'bgColor']) if (container[key]) {
      const color = container[key]; container[key] = { argb: resolveColorSpec(color.argb ? { rgb: color.argb } : color) };
    }
  }
  return normalizeStaticStyle(clone);
}
function extraStyle(style) {
  // 中性样式模型不保留 protection/部分字体属性；单独核对，避免静态样式归一化漏检。
  const font = style.font || { family: 2, scheme: 'minor' }, alignment = style.alignment || {};
  return { protection: { locked: style.protection?.locked !== false, hidden: !!style.protection?.hidden },
    font: { family: font.family ?? null, charset: font.charset ?? null, scheme: font.scheme ?? null,
      outline: !!font.outline, shadow: !!font.shadow, condense: !!font.condense, extend: !!font.extend, vertAlign: font.vertAlign ?? null },
    alignment: { shrinkToFit: !!alignment.shrinkToFit, readingOrder: alignment.readingOrder ?? 0,
      justifyLastLine: !!alignment.justifyLastLine, relativeIndent: alignment.relativeIndent ?? 0 } };
}
function assertCell(actual, original, encoded, workbook, styles, label, styleCache) {
  const follower = original.isMerged && original.master.address !== original.address;
  let wanted = follower ? null : original.value;
  if (encoded && typeof wanted === 'string') wanted = decodeExcelStXstring(wanted);
  if (!actual) {
    if (wanted == null && stableSignature(templateStyle(original.style)) === stableSignature(templateStyle({}))
        && stableSignature(extraStyle(original.style)) === stableSignature(extraStyle({}))) return;
    throw failure(`${label} 缺少单元格或样式`);
  }
  if (actual.hasFormula || !['text', 'blank', 'number', 'boolean'].includes(actual.cellType)) throw failure(`${label} 含非预期公式或单元格类型`);
  if (wanted == null ? actual.cellType !== 'blank'
    : typeof wanted === 'number' ? actual.cellType !== 'number' || decimalComparable(actual.rawLexicalValue) !== decimalComparable(wanted)
      : actual.cellType !== (typeof wanted === 'boolean' ? 'boolean' : 'text') || actual.decodedSemanticValue !== wanted) {
    throw failure(`${label} 主体、金额或内容不符`);
  }
  const expectedStyleKey = stableSignature(original.style);
  const actualStyleKey = `${actual.sourceStyleId ?? ''}:${actual.effectiveStyleRef.styleRef}`;
  const accepted = styleCache.get(expectedStyleKey);
  if (accepted?.has(actualStyleKey)) return;
  equal(workbook.getCellStyle(actual), templateStyle(original.style), `${label} 格式、差异色或样式不符`);
  equal(extraStyle(styles.getStyleModel(actual.sourceStyleId || 0) || {}), extraStyle(original.style), `${label} 保护或字体样式不符`);
  if (accepted) accepted.add(actualStyleKey); else styleCache.set(expectedStyleKey, new Set([actualStyleKey]));
}

async function validateResultWorkbook({ filePath, sheetPlan, loadExpectedSheet, signal, limits, onProgress }) {
  let workbook, opened, operationError;
  const sstTempRoot = path.join(path.dirname(filePath), `result-sst-validation-${randomUUID()}`);
  try {
    check(signal);
    workbook = await openRichWorkbook(filePath, { maxSheets: limits.maxSheets,
      sstTempRoot, memoryBudgetBytes: 64 * 1024 * 1024,
      cacheMaxBytes: 64 * 1024 * 1024, lruMaxEntries: 8192, cancelToken: { get cancelled() { return !!signal?.aborted; } } });
    equal(workbook.sheets.map((sheet) => sheet.name), sheetPlan.sheets.map((sheet) => sheet.name), '正式结果主体 Sheet 集合或顺序不符');
    if (workbook.date1904 || workbook.sheets.some((sheet) => sheet.state !== 'visible')) throw failure('正式结果日期系统或 Sheet 可见性不符');
    opened = await openZipWithEntries(path.basename(filePath), filePath, { rejectDuplicateEntries: true });
    const readMetadata = (entryPath, limitBytes) => readToolboxMetadataEntryAsString(opened.zip, opened.entries.get(entryPath),
      { sourceFile: path.basename(filePath), partName: entryPath, limitBytes });
    const definedNames = readDefinedNames(await readMetadata('xl/workbook.xml', TOOLBOX_XLSX_METADATA_LIMITS.workbook));
    const relationships = parseWorkbookRelationships(await readMetadata('xl/_rels/workbook.xml.rels', TOOLBOX_XLSX_METADATA_LIMITS.relationships));
    const stylesEntry = findRelationshipEntry(opened.entries, relationships, 'styles', 'xl/styles.xml', { sourceFile: path.basename(filePath), relationshipLabel: 'styles' });
    if (!stylesEntry) throw failure('正式结果缺少样式部件');
    const styles = new StylesXform();
    await styles.parseStream(Readable.from([await readMetadata(stylesEntry.fileName, TOOLBOX_XLSX_METADATA_LIMITS.styles)]));
    const stringsEntry = findRelationshipEntry(opened.entries, relationships, 'sharedStrings', 'xl/sharedStrings.xml', { sourceFile: path.basename(filePath), relationshipLabel: 'sharedStrings' });
    if (stringsEntry) {
      const stringsParser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
      stringsParser.onopentag = (node) => {
        if (!namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES) || !['sst', 'si', 't'].includes(node.local || node.name)) {
          throw failure('正式结果共享字符串含非预期富文本或原始 payload');
        }
      };
      await scanXml(opened, stringsEntry.fileName, [stringsParser], signal, limits.maxSharedStringsXmlBytes);
    }
    const expectedNames = new Map(), printAreas = new Map(), styleCache = new Map();
    let rowCount = 0;
    for (const descriptor of sheetPlan.sheets) {
      check(signal);
      const expected = loadExpectedSheet(descriptor), source = expected.sheet;
      const actualSheet = workbook.sheets[descriptor.ordinal];
      const raw = metadataParser({ expected, signal });
      const parsers = [raw.parser];
      if (descriptor.kind === 'result-main') parsers.push(createResultWorksheetRawParser(expected.resultContract, expected.renderedRows, expected.lastRow));
      // eslint-disable-next-line no-await-in-loop
      await scanXml(opened, actualSheet.entryPath, parsers, signal, limits.maxWorksheetXmlBytes);
      raw.finish();
      let count = 0;
      // eslint-disable-next-line no-await-in-loop
      await workbook.scanSheet(descriptor.ordinal, (row) => {
        check(signal); count += 1; rowCount += 1;
        if (rowCount > limits.maxWorkbookRows || row.rowIndex !== count || row.rowIndex > source.rowCount
            || row.cells.some((cell) => cell.columnIndex >= source.columnCount)) throw failure(`${source.name} 行列边界不符`);
        const original = source.getRow(row.rowIndex);
        equal([row.height, row.hidden, row.outlineLevel], [original.height ?? null, !!original.hidden, original.outlineLevel || 0], `${source.name} 行高或行布局不符`);
        const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
        for (let column = 1; column <= source.columnCount; column += 1) {
          const cell = original.getCell(column);
          assertCell(cells.get(column - 1), cell, expected.encodedCells.has(cell.address), workbook, styles, `${source.name}!${cell.address}`, styleCache);
        }
      }, (meta) => {
        if (meta.defaultRowHidden || meta.columns.some((column) => column.maxColumnIndex >= source.columnCount)) throw failure(`${source.name} 存在额外列或默认隐藏行`);
        for (let column = 1; column <= source.columnCount; column += 1) {
          const actual = meta.columns.find((entry) => entry.minColumnIndex <= column - 1 && entry.maxColumnIndex >= column - 1);
          const wanted = source.getColumn(column);
          equal([actual?.width ?? null, !!actual?.hidden, actual?.outlineLevel || 0],
            [wanted.width ?? null, !!wanted.hidden, wanted.outlineLevel || 0], `${source.name} 列布局不符`);
        }
      });
      if (count !== source.rowCount) throw failure(`${source.name} 缺少主体结果行`);
      printAreas.set(descriptor.ordinal, `${quoteSheetName(descriptor.name)}!${source.pageSetup.printArea.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`);
      for (const row of expected.renderedRows || []) if (row.rowType === 'adjustment') {
        const name = encodeAdjustmentLineageName(row.rowKey, row.currency);
        if (!expectedNames.has(name)) expectedNames.set(name, []);
        expectedNames.get(name).push(`${quoteSheetName(descriptor.name)}!$M$${row.rowNumber}`);
      }
      onProgress?.({ phase: 'validating', sheets: descriptor.ordinal + 1, sheetCount: sheetPlan.sheetCount, rowCount });
    }
    validateDefinedNames(definedNames, expectedNames, printAreas);
    const used = new Set(workbook.sheets.map((sheet) => sheet.entryPath));
    for (const entryPath of opened.entries.keys()) {
      if ((/^xl\/worksheets\/[^/]+\.xml$/i.test(entryPath) && !used.has(entryPath))
          || /^xl\/(?:externalLinks|embeddings|vba|comments)/i.test(entryPath)) throw failure('正式结果包含未声明工作表或外部内容');
      if (entryPath.endsWith('.rels')) {
        const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
        parser.onopentag = (node) => {
          if ((node.local || node.name) !== 'Relationship') return;
          const a = normalizedSaxAttributes(node.attributes);
          if (a.targetmode === 'External' || /(?:hyperlink|externalLink|comments|oleObject)/i.test(a.type || '')) throw failure('正式结果包含非预期外部关系');
        };
        // eslint-disable-next-line no-await-in-loop
        await scanXml(opened, entryPath, [parser], signal, TOOLBOX_XLSX_METADATA_LIMITS.relationships);
      }
    }
    await workbook.close(); workbook = null;
    await closeZip(opened.zip); opened = null;
    return { ...await hashClosedFile(filePath, () => check(signal)), rowCount, subjectCount: sheetPlan.subjectCount,
      sheetCount: sheetPlan.sheetCount, resultRevision: sheetPlan.resultRevision };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const errors = [];
    try { if (workbook) await workbook.close(); } catch (error) { errors.push(error); }
    try { if (opened) await closeZip(opened.zip); } catch (error) { errors.push(error); }
    // strictClose 已按 inode 核验并清理自己的 spill；父 Worker owner 不可绕过失败的所有权检查。
    const cleanupError = errors.length ? new AggregateError(errors, '正式结果校验资源关闭未确认', { cause: operationError || errors[0] }) : null;
    const failure = cleanupError || operationError;
    if (failure && (cleanupError || fs.existsSync(sstTempRoot))) {
      failure.preserveTemporaryFiles = true;
      failure.recoveryPaths = [...(failure.recoveryPaths || []), filePath, sstTempRoot];
    }
    if (cleanupError) throw cleanupError;
  }
}

module.exports = { validateResultWorkbook, expectedSheetMetadata, splitRanges, normalizeRange };
