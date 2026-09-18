'use strict';
const path = require('node:path');
const sax = require('sax');
const { DatabaseSync } = require('node:sqlite');
const { openRichWorkbook } = require('../backend/xlsx-rich-reader');
const { openZipWithEntries } = require('../backend/big-table-import/zip-reader');
const { decodeExcelStXstring } = require('../backend/toolbox-format/excel-text');
const { decimalComparable } = require('../backend/toolbox-format/number-date');
const { hashClosedFile } = require('./biz-op-v327/export-validator');
const { normalizeStaticStyle, stableSignature, resolveColorSpec } = require('../backend/toolbox-format/style-registry');
const { loadResultTemplateContract, RESULT_TEMPLATE_FILE_NAME } = require('../backend/vcc-financial-op/result-template-contract');
const { getMeta, pageRows, safePoint } = require('../backend/vcc-financial-op/review-export-plan');
const { outputProjectionCells, expectedDefinedNames, noteForPage } = require('./vcc-financial-op-review-writer');
const { framedDigest, comparableCell, textCell, reviewError } = require('../backend/vcc-financial-op/review-export-contract');

const failure = (message) => reviewError('vcc-review-validation-failed', message);
function normalizedTemplateStyle(style) {
  const fill = { ...(style.fill || {}) };
  for (const key of ['fgColor', 'bgColor']) if (fill[key]) {
    const color = fill[key];
    fill[key] = { argb: resolveColorSpec(color.argb ? { rgb: color.argb } : color) };
  }
  return normalizeStaticStyle({ ...style, fill });
}
function actualCell(cell) {
  if (!cell) return { t: 'null', v: null, f: 'General' };
  if (cell.hasFormula || !['text', 'blank', 'number', 'boolean'].includes(cell.cellType)) throw failure('工作簿存在非预期公式或单元格类型');
  return { t: cell.cellType === 'blank' ? 'null' : cell.cellType,
    v: cell.cellType === 'blank' ? null : cell.cellType === 'number' ? cell.rawLexicalValue : cell.decodedSemanticValue,
    f: cell.sourceFormat || 'General' };
}
function assertCells(actual, expected, label) {
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index], found = actual[index];
    if (found.t !== wanted.t || (wanted.t === 'number' ? decimalComparable(found.v) !== decimalComparable(wanted.v) : found.v !== wanted.v)
        || (wanted.t !== 'null' && found.f !== wanted.f)) throw failure(`${label} 第 ${index + 1} 列类型、值或显示格式不符`);
  }
}
async function xml(opened, name, handlers, signal, maxBytes = Infinity) {
  const entry = opened.entries.get(name);
  if (!entry) throw failure(`XLSX 缺少 ${name}`);
  const stream = await new Promise((resolve, reject) => opened.zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => handlers.open?.(node.local || node.name, Object.fromEntries(Object.values(node.attributes).map((a) => [a.local || a.name, a.value])));
  parser.onclosetag = (name) => handlers.close?.(String(name).replace(/^.*:/, ''));
  parser.ontext = (text) => handlers.text?.(text); parser.oncdata = parser.ontext;
  // yauzl also returns legacy fd-slicer streams for STORE entries. Their async
  // iterator can stall; use the event contract shared by the production Reader.
  stream.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    let bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', aborted);
      stream.destroy(); error ? reject(error) : resolve();
    };
    const aborted = () => finish(signal.reason || failure('校验已取消'));
    stream.on('error', finish);
    stream.on('close', () => { if (!settled) finish(failure(`${name} 读取提前关闭`)); });
    stream.on('data', (chunk) => {
      if (settled) return;
      try {
        safePoint(signal); bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) throw failure(`${name} 超过元数据预算`);
        parser.write(chunk);
      } catch (error) { finish(error); }
    });
    stream.on('end', () => { if (!settled) { try { parser.close(); finish(); } catch (error) { finish(error); } } });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
function normalizeRange(value) { return value.replace(/^'待确认表'!/, '待确认表!').replace(/\$/g, ''); }
function expandLineage(value) {
  return value.split(',').flatMap((part) => {
    const match = /^待确认表!M([1-9]\d*)(?::M([1-9]\d*))?$/.exec(normalizeRange(part));
    if (!match) throw failure(`调整引用越界或引用错误 Sheet：${value}`);
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (last < first || last > 1048576) throw failure('调整引用行号非法');
    return Array.from({ length: last - first + 1 }, (_, index) => `待确认表!M${first + index}`);
  });
}
async function validateMetadata(filePath, sheets, projection, provenance, pages, signal) {
  const opened = await openZipWithEntries(path.basename(filePath), filePath, { rejectDuplicateEntries: true });
  try {
    const names = []; let currentName = null;
    await xml(opened, 'xl/workbook.xml', { open(name, attributes) {
      if (name === 'definedName') currentName = { ...attributes, value: '' };
    }, text(value) { if (currentName) currentName.value += value; }, close(name) {
      if (name === 'definedName') { names.push(currentName); currentName = null; }
    } }, signal, 16 * 1024 * 1024);
    const expectedNames = expectedDefinedNames(projection); let printAreas = 0;
    for (const name of names) {
      if (name.name === '_xlnm.Print_Area') {
        if (String(name.localSheetId) !== '0' || normalizeRange(name.value) !== `待确认表!A1:N${projection.rowCount}` || ++printAreas > 1) throw failure('待确认表打印范围不完整');
      } else {
        const expected = expectedNames.get(name.name);
        const ranges = expandLineage(name.value);
        if (!expected || JSON.stringify(ranges.sort()) !== JSON.stringify(expected.map(normalizeRange).sort()) || new Set(ranges).size !== ranges.length) throw failure('调整名称重复、错位或不符合血缘清单');
        expectedNames.delete(name.name);
      }
    }
    if (printAreas !== 1 || expectedNames.size) throw failure('打印范围或调整血缘引用缺失');
    const commentsUsed = new Set();
    for (let index = 0; index < sheets.length; index += 1) {
      const sheet = sheets[index]; const merges = [];
      await xml(opened, sheet.entryPath, { open(name, a) {
        if (name === 'mergeCell') merges.push(a.ref);
        if (['f', 'hyperlink', 'externalLink'].includes(name)) throw failure(`${sheet.name} 包含非预期公式或链接`);
      } }, signal);
      const expectedMerges = index === 0 ? projection.rows.filter((r) => ['title', 'summary'].includes(r.kind)).map((r) =>
        r.kind === 'title' ? `A${r.rowNumber}:N${r.rowNumber}` : `B${r.rowNumber}:C${r.rowNumber}`) : [];
      if (JSON.stringify(merges.sort()) !== JSON.stringify(expectedMerges.sort())) throw failure(`${sheet.name} 合并区域不符`);
      const relPath = path.posix.join(path.posix.dirname(sheet.entryPath), '_rels', `${path.posix.basename(sheet.entryPath)}.rels`);
      let commentPath = null;
      await xml(opened, relPath, { open(name, a) {
        if (name !== 'Relationship') return;
        if (a.TargetMode === 'External' || /(?:hyperlink|externalLink)/i.test(a.Type || '')) throw failure('工作簿包含非预期外链');
        if (a.Type?.endsWith('/comments')) {
          if (commentPath) throw failure('批注关系重复');
          commentPath = path.posix.normalize(path.posix.join(path.posix.dirname(sheet.entryPath), a.Target));
        }
      } }, signal, 1024 * 1024);
      if (!commentPath || commentsUsed.has(commentPath)) throw failure('版本/附页批注缺失或被错误共享');
      commentsUsed.add(commentPath);
      const comments = []; let current = null, collecting = false;
      await xml(opened, commentPath, { open(name, a) {
        if (name === 'comment') current = { ref: a.ref, text: '' };
        if (name === 't' && current) collecting = true;
      }, text(value) { if (current && collecting) current.text += value; }, close(name) {
        if (name === 't') collecting = false;
        if (name === 'comment') { comments.push(current); current = null; }
      } }, signal, 16 * 1024 * 1024);
      const wanted = index === 0 ? `VCC Review Export\n${JSON.stringify(provenance)}` : noteForPage(pages[index - 1], JSON.parse(pages[index - 1].descriptor));
      if (comments.length !== 1 || comments[0].ref !== 'A1' || decodeExcelStXstring(comments[0].text) !== wanted) throw failure(`${sheet.name} 批注与冻结版本不符`);
    }
    for (const name of opened.entries.keys()) {
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name) && !sheets.some((sheet) => sheet.entryPath === name)) throw failure('工作簿存在未声明数据 Sheet');
      if (/^xl\/(?:externalLinks|embeddings|vba)/i.test(name)) throw failure('工作簿存在非预期外部内容');
      if (/^xl\/comments[^/]*\.xml$/i.test(name) && !commentsUsed.has(name)) throw failure('工作簿存在未声明批注');
      if (name.endsWith('.rels') && !/^xl\/worksheets\/_rels\//.test(name)) {
        await xml(opened, name, { open(tag, a) { if (tag === 'Relationship' && a.TargetMode === 'External') throw failure('工作簿存在外部关系'); } }, signal, 16 * 1024 * 1024);
      }
    }
  } finally { opened.zip.close(); }
}

async function validateReviewWorkbook({ filePath, manifestPath, assetsDir = path.resolve(__dirname, '../../assets'), signal, onProgress }) {
  const template = await loadResultTemplateContract({ templatePath: path.join(assetsDir, 'VCC财务OP校验', RESULT_TEMPLATE_FILE_NAME) });
  const db = new DatabaseSync(manifestPath, { readOnly: true }); let workbook;
  try {
    const projection = getMeta(db, 'projection'), provenance = getMeta(db, 'provenance');
    const pages = db.prepare('SELECT p.*,g.descriptor,a.content_digest FROM pages p JOIN groups g USING(group_key) JOIN page_actual a ON a.page_id=p.id ORDER BY p.id').all();
    workbook = await openRichWorkbook(filePath, { memoryBudgetBytes: 64 * 1024 * 1024, cancelToken: { get cancelled() { return !!signal?.aborted; } } });
    if (workbook.date1904 || workbook.sheets.length !== pages.length + 1
        || JSON.stringify(workbook.sheets.map((s) => s.name)) !== JSON.stringify(['待确认表', ...pages.map((p) => p.name)])
        || workbook.sheets.some((s) => s.state !== 'visible')) throw failure('工作簿 Sheet 名称、顺序、可见性或日期系统不符');
    const expectedRows = projection.rows.filter((row) => row.kind !== 'spacer'); let current = 0;
    await workbook.scanSheet(0, (row) => {
      safePoint(signal); const expected = expectedRows[current++];
      if (!expected || row.rowIndex !== expected.rowNumber || row.hidden || row.cells.some((c) => c.columnIndex >= 14)) throw failure('待确认表行序、主体或十四列结构不符');
      const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
      assertCells(Array.from({ length: 14 }, (_, index) => actualCell(cells.get(index))), outputProjectionCells(expected), `待确认表第 ${row.rowIndex} 行`);
      const summaryAnchor = { openingBalance: 'opening', effectiveCalculatedBalance: 'calculated', systemBalance: 'system', effectiveDifference: 'difference' }[expected.summaryKey];
      if (expected.kind === 'header' || summaryAnchor) {
        for (let column = 3; column < 12; column += 1) {
          const style = workbook.getCellStyle(cells.get(column));
          const wanted = expected.kind === 'header'
            ? { fill: expected.balanced[column - 3] ? template.normalFill : template.abnormalFill }
            : template.anchors[summaryAnchor].cells[column].style;
          if (stableSignature(style.fill) !== stableSignature(normalizedTemplateStyle(wanted).fill)
              || (summaryAnchor && style.font.bold !== normalizedTemplateStyle(wanted).font.bold)) throw failure(`待确认表第 ${row.rowIndex} 行币种提示或汇总样式不符`);
        }
      }
    }, (meta) => { if (meta.defaultRowHidden || meta.columns.some((c) => c.hidden)) throw failure('待确认表存在隐藏行列'); });
    if (current !== expectedRows.length) throw failure('待确认表主体或行缺失');
    let sourceRowCount = 0;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index], group = JSON.parse(page.descriptor), iterator = pageRows(db, page);
      const digest = framedDigest(); let count = 0, headerSeen = false;
      try {
        await workbook.scanSheet(index + 1, (row) => {
          safePoint(signal);
          if (row.hidden || row.cells.some((cell) => cell.columnIndex >= group.headers.length)) throw failure(`${page.name} 出现隐藏行或额外列`);
          const byColumn = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
          const actual = group.headers.map((_header, column) => actualCell(byColumn.get(column)));
          if (row.rowIndex === 1) { assertCells(actual, group.headers.map(textCell), `${page.name} 表头`); headerSeen = true; return; }
          const expected = iterator.next();
          if (!headerSeen || expected.done || row.rowIndex !== count + 2) throw failure(`${page.name} 原始行缺失、重复或顺序不符`);
          assertCells(actual, JSON.parse(expected.value.cells), `${page.name} 第 ${row.rowIndex} 行`);
          digest.add([page.group_key, expected.value.ordinal, actual.map(comparableCell)]); count += 1;
        }, (meta) => { if (meta.defaultRowHidden || meta.columns.some((c) => c.hidden)) throw failure(`${page.name} 存在隐藏行列`); });
        if (!iterator.next().done || count !== page.row_count || digest.finish() !== page.content_digest) throw failure(`${page.name} 行数或内容摘要不符`);
      } finally { iterator.return?.(); }
      sourceRowCount += count; onProgress?.({ phase: 'validating', sheets: index + 2, sourceRowCount });
    }
    const sheets = workbook.sheets;
    await workbook.close(); workbook = null;
    await validateMetadata(filePath, sheets, projection, provenance, pages, signal);
    const evidence = await hashClosedFile(filePath, () => safePoint(signal));
    return { ...evidence, sourceRowCount, sheetCount: pages.length + 1, subjectCount: projection.blocks.length,
      resultRevision: provenance.resultRevision };
  } finally { if (workbook) await workbook.close(); db.close(); }
}
module.exports = { validateReviewWorkbook, validateMetadata, actualCell, assertCells };
