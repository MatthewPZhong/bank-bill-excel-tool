'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const PrintOptionsXform = require('exceljs/lib/xlsx/xform/sheet/print-options-xform');
const WorkbookXform = require('exceljs/lib/xlsx/xform/book/workbook-xform');
const { withBoundedWorkbook } = require('./bounded-xlsx-writer');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');
const { loadEffectiveRunSubjectIndex, loadEffectiveRunDataForSubject, buildSubjectRowPlan,
  buildResultSheet, buildPendingSheet, canonicalMergeRanges } = require('./vcc-financial-op-writer');
const { RESULT_TEMPLATE_FILE_NAME, loadResultTemplateContract } = require('../backend/vcc-financial-op/result-template-contract');
const { createResultWorkbookSheetPlan, quoteSheetName } = require('../backend/vcc-financial-op/result-sheet-plan');
const { encodeAdjustmentLineageName } = require('../backend/vcc-financial-op/adjustment-lineage');
const { encodeExcelStXstring } = require('../backend/xlsx/excel-text');
const { validateResultWorkbook } = require('./vcc-financial-op-result-workbook-validator');

const DEFAULT_RESULT_RESOURCE_LIMITS = Object.freeze({ maxSheets: 4096, maxSubjectSourceRows: 50000,
  maxSubjectBytes: 64 * 1024 * 1024, maxWorkbookRows: 1000000, maxWorksheetXmlBytes: 256 * 1024 * 1024,
  maxSharedStringsXmlBytes: 256 * 1024 * 1024 });
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function resourceError(message) {
  return Object.assign(new Error(message), { code: 'vcc-result-export-resource-limit' });
}
function safePoint(signal) {
  if (signal?.aborted) throw Object.assign(new Error('VCC 正式结果导出已取消'), { code: 'VCC_EXPORT_CANCELLED' });
}
function resolveResultResourceLimits(overrides = {}) {
  const result = { ...DEFAULT_RESULT_RESOURCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Object.hasOwn(DEFAULT_RESULT_RESOURCE_LIMITS, name) || !Number.isSafeInteger(value) || value < 1
        || value > DEFAULT_RESULT_RESOURCE_LIMITS[name]) throw resourceError(`正式结果资源预算非法：${name}`);
  }
  return Object.freeze(result);
}

// 在调用主体 DTO 的 .all() 前检查物化边界，不把整个 run 的行加载到内存后才计数。
function assertSubjectBudget(db, runId, subject, limits) {
  const sources = [
    ['vcc_fin_op_run_rows', ['subject', 'row_kind', 'source_type', 'category_major', 'category_minor', 'currency', 'amount']],
    ['vcc_fin_op_run_adjustments', ['row_key', 'subject', 'source_type', 'category_major', 'category_minor', 'currency', 'adjustment_amount', 'reason']],
    ['vcc_fin_op_run_balances', ['subject', 'currency', 'opening_balance', 'period_amount', 'calculated_balance', 'system_balance', 'difference']],
    ['vcc_fin_op_pending_summary_rows', ['subject', 'channel_name', 'flow_currency', 'pending_currency', 'recon_type', 'flow_amount', 'pending_amount']],
    ['vcc_fin_op_pending_currency_totals', ['subject', 'currency', 'amount']]
  ];
  let rows = 0, bytes = 0;
  for (const [table, columns] of sources) {
    const sum = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ');
    const found = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${sum}), 0) bytes FROM ${table} WHERE run_id = ? AND subject = ?`).get(runId, subject);
    rows += Number(found.n); bytes += Number(found.bytes);
  }
  if (rows > limits.maxSubjectSourceRows || bytes > limits.maxSubjectBytes) {
    throw resourceError('单主体正式结果超过行数或文本内存预算，未生成部分结果');
  }
  return { rows, bytes };
}

async function loadResultWorkbookTemplates(assetsDir) {
  const resultContract = await loadResultTemplateContract({ templatePath: path.join(assetsDir, 'VCC财务OP校验', RESULT_TEMPLATE_FILE_NAME) });
  const pendingTemplate = new ExcelJS.Workbook();
  await pendingTemplate.xlsx.readFile(path.join(assetsDir, 'VCC财务OP校验', '移除归档Pending发生额计算表.xlsx'));
  if (!pendingTemplate.worksheets[0]) throw new Error('移除归档Pending发生额计算模板缺少工作表');
  return { resultContract, pendingTemplateSheet: pendingTemplate.worksheets[0] };
}

function loadExpectedResultSheet({ db, runId, descriptor, templates, limits }) {
  const budget = assertSubjectBudget(db, runId, descriptor.subject, limits);
  const data = loadEffectiveRunDataForSubject(db, runId, descriptor.subject);
  const workbook = new ExcelJS.Workbook();
  const encodedCells = new Set();
  let result;
  if (descriptor.kind === 'result-main') {
    const plan = buildSubjectRowPlan(data, descriptor.subject);
    result = { ...buildResultSheet(workbook, templates.resultContract, plan, { sheetName: descriptor.name }), plan };
    for (const row of result.renderedRows) if (row.rowType === 'adjustment') encodedCells.add(`N${row.rowNumber}`);
  } else {
    result = { sheet: buildPendingSheet(workbook, templates.pendingTemplateSheet, descriptor.subject, data, { sheetName: descriptor.name }) };
  }
  if (result.sheet.rowCount > 1048576) throw resourceError('正式结果工作表超过 Excel 行数限制');
  return { ...result, encodedCells, budget, resultContract: templates.resultContract };
}

function sheetOptions(sheet) {
  return { state: sheet.state, properties: clone(sheet.properties), pageSetup: clone(sheet.pageSetup),
    views: clone(sheet.views), headerFooter: clone(sheet.headerFooter) };
}

function createDiskSharedStrings(filePath, limitBytes) {
  const ownedPath = `${filePath}.sst-${randomUUID()}.xml`;
  const fd = fs.openSync(ownedPath, 'wx', 0o600), identity = fs.fstatSync(fd);
  let closed = false, count = 0, totalRefs = 0, byteCount = 0, bufferedBytes = 0, input = null;
  const cache = new Map(); let cacheBytes = 0;
  let chunks = [];
  const flush = () => {
    if (chunks.length) fs.writeFileSync(fd, chunks.join(''));
    chunks = []; bufferedBytes = 0;
  };
  const append = (xml) => {
    const bytes = Buffer.byteLength(xml);
    if (byteCount + bytes > limitBytes) throw resourceError('正式结果文本超过共享字符串磁盘预算');
    byteCount += bytes; bufferedBytes += bytes; chunks.push(xml);
    if (bufferedBytes >= 1024 * 1024) flush();
  };
  const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  try {
    append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  } catch (error) { fs.closeSync(fd); fs.unlinkSync(ownedPath); throw error; }
  return {
    bind(writer) {
      writer.sharedStrings = { get count() { return count; }, get totalRefs() { return totalRefs; },
        add(value) {
          totalRefs += 1;
          const cached = cache.get(value);
          if (cached) { cache.delete(value); cache.set(value, cached); return cached.index; }
          append(`<si><t xml:space="preserve">${escape(value)}</t></si>`);
          const index = count++, bytes = Buffer.byteLength(value) * 2 + 64;
          cache.set(value, { index, bytes }); cacheBytes += bytes;
          while (cache.size > 8192 || cacheBytes > 8 * 1024 * 1024) {
            const key = cache.keys().next().value;
            cacheBytes -= cache.get(key).bytes; cache.delete(key);
          }
          return index;
        } };
      writer.addSharedStrings = async () => {
        append('</sst>'); flush(); fs.closeSync(fd); closed = true;
        input = fs.createReadStream(ownedPath);
        input.on('error', (error) => writer.zip.emit('error', error));
        writer.zip.append(input, { name: '/xl/sharedStrings.xml' });
      };
    },
    async close() {
      try {
        if (!closed) { fs.closeSync(fd); closed = true; }
        if (input && !input.closed) {
          await new Promise((resolve) => { input.once('close', resolve); input.destroy(); });
        }
        const actual = fs.lstatSync(ownedPath);
        if (actual.dev !== identity.dev || actual.ino !== identity.ino || !actual.isFile()) {
          throw resourceError('正式结果临时字符串文件所有权发生变化，已保留文件');
        }
        fs.unlinkSync(ownedPath);
      } catch (error) {
        error.preserveTemporaryFiles = true;
        error.recoveryPaths = [...(error.recoveryPaths || []), ownedPath, filePath];
        throw error;
      }
    }
  };
}

function preserveQuotedPrintAreas(writer) {
  // ExcelJS 4.4.0 的 Print_Area 拼接未转义 Sheet 单引号；只修正本布局的最终序列化。
  writer.addWorkbook = async () => {
    const worksheets = writer._worksheets.filter(Boolean);
    const model = { worksheets, definedNames: writer.definedNames.model, views: writer.views, properties: {}, calcProperties: {} };
    const xform = new WorkbookXform();
    xform.prepare(model);
    for (const definedName of model.definedNames || []) if (definedName.name === '_xlnm.Print_Area') {
      const sheet = worksheets[definedName.localSheetId];
      definedName.ranges = [`${quoteSheetName(sheet.name)}!${sheet.pageSetup.printArea.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`];
    }
    writer.zip.append(xform.toXml(model), { name: '/xl/workbook.xml' });
  };
}

async function writeExpectedSheet(session, expected, descriptor) {
  const source = expected.sheet;
  const sheet = session.addWorksheet(descriptor.name, sheetOptions(source));
  sheet.useSharedStrings = true;
  // 保留原 Sheet 的已确定打印字段，避免流式构造器补入额外默认属性。
  sheet.pageSetup = clone(source.pageSetup);
  // ExcelJS 4.4.0 的流式实现不输出 printOptions；在本结果域补齐模板已有打印语义。
  const writePageMargins = sheet._writePageMargins.bind(sheet);
  sheet._writePageMargins = () => {
    sheet.stream.write(new PrintOptionsXform().toXml(source.pageSetup));
    writePageMargins();
  };
  sheet.columns = source.columns.map((column) => ({ width: column.width, hidden: column.hidden,
    outlineLevel: column.outlineLevel, style: clone(column.style) }));
  sheet.autoFilter = clone(source.autoFilter);
  for (const range of canonicalMergeRanges(source)) sheet.mergeCells(range);
  for (let rowNumber = 1; rowNumber <= source.rowCount; rowNumber += 1) {
    const original = source.getRow(rowNumber), row = sheet.getRow(rowNumber);
    row.height = original.height; row.hidden = original.hidden; row.outlineLevel = original.outlineLevel;
    for (let column = 1; column <= source.columnCount; column += 1) {
      const originalCell = original.getCell(column), target = row.getCell(column);
      // 合并从格不得再次写入主格值，否则会覆盖完整主体身份或分类。
      if (!originalCell.isMerged || originalCell.master.address === originalCell.address) {
        const value = originalCell.value;
        target.value = typeof value === 'string' && !expected.encodedCells.has(originalCell.address)
          ? encodeExcelStXstring(value) : value;
      }
      target.style = clone(originalCell.style);
    }
    // 空 Pending 行仍有模板样式；流式 Writer 默认跳过无值行，须保留其空白格式。
    if (!row.hasValues) Object.defineProperty(row, 'hasValues', { value: true });
    // eslint-disable-next-line no-await-in-loop
    await session.commitRow(row);
  }
  for (const row of expected.renderedRows || []) if (row.rowType === 'adjustment') {
    session.writer.definedNames.add(`${quoteSheetName(descriptor.name)}!$M$${row.rowNumber}`,
      encodeAdjustmentLineageName(row.rowKey, row.currency));
  }
  await session.commitSheet(sheet);
  // 已提交流式 Sheet 无业务行；释放闭包对源 Sheet 的引用。
  sheet._writePageMargins = writePageMargins;
}

async function writeResultWorkbook({ db, runId, outputPaths, assetsDir = path.resolve(__dirname, '../../assets'),
  publicationStagingDirectory = null, abortSignal = null, resourceLimits = {}, beforeValidate = null,
  beforeSubjectWrite = null, onProgress = null }) {
  const limits = resolveResultResourceLimits(resourceLimits);
  safePoint(abortSignal);
  if (!Array.isArray(outputPaths) || outputPaths.length !== 1 || typeof outputPaths[0] !== 'string'
      || path.extname(outputPaths[0]).toLowerCase() !== '.xlsx') throw new TypeError('正式结果必须且只能提供一个 .xlsx 输出目标');
  const targetPath = path.resolve(outputPaths[0]);
  const templates = await loadResultWorkbookTemplates(assetsDir);
  const transaction = `vcc_result_${randomUUID().replace(/-/g, '')}`;
  db.exec(`SAVEPOINT ${transaction}`);
  try {
    const subjectCount = Number(db.prepare('SELECT COUNT(DISTINCT subject) n FROM vcc_fin_op_run_balances WHERE run_id = ?').get(runId).n);
    if (subjectCount * 2 > limits.maxSheets) throw resourceError('正式结果工作表数量超过读取预算');
    const index = loadEffectiveRunSubjectIndex(db, runId);
    const adjustmentCount = Number(db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_run_adjustments WHERE run_id = ?').get(runId).n);
    if (index.run.resultRevision !== adjustmentCount) {
      throw Object.assign(new Error('正式结果 revision 与调整事实不一致'), { code: 'result-revision-inconsistent' });
    }
    for (const table of ['vcc_fin_op_run_rows', 'vcc_fin_op_run_adjustments', 'vcc_fin_op_pending_summary_rows', 'vcc_fin_op_pending_currency_totals']) {
      const orphan = db.prepare(`SELECT 1 FROM ${table} fact WHERE fact.run_id = ? AND NOT EXISTS
        (SELECT 1 FROM vcc_fin_op_run_balances balance WHERE balance.run_id = fact.run_id AND balance.subject = fact.subject) LIMIT 1`).get(runId);
      if (orphan) throw Object.assign(new Error('正式结果存在不属于有效主体集合的数据'), { code: 'vcc-result-export-validation-failed' });
    }
    const sheetPlan = createResultWorkbookSheetPlan({ subjects: index.subjects, runId: index.run.runId,
      resultRevision: index.run.resultRevision, inputFingerprint: index.run.inputFingerprint, maxSheets: limits.maxSheets });
    const loadExpectedSheet = (descriptor) => {
      safePoint(abortSignal);
      return loadExpectedResultSheet({ db, runId: index.run.runId, descriptor, templates, limits });
    };
    const generationPath = publicationStagingDirectory
      ? path.join(path.resolve(publicationStagingDirectory), `result-workbook-${randomUUID()}.xlsx`) : targetPath;
    let metrics, validation;
    const sheetMapping = [];
    await writeXlsxAtomically({ outputPath: generationPath,
      writeStaged: async (filePath) => {
        const strings = createDiskSharedStrings(filePath, limits.maxSharedStringsXmlBytes);
        try {
          metrics = await withBoundedWorkbook({ filePath, signal: abortSignal, safePoint: () => safePoint(abortSignal) }, async (session) => {
          strings.bind(session.writer);
          session.writer.creator = '网银账单生成小助手';
          preserveQuotedPrintAreas(session.writer);
          let rowCount = 0, maxSubjectSourceRows = 0, maxSubjectBytes = 0;
          for (const descriptor of sheetPlan.sheets) {
            safePoint(abortSignal);
            if (beforeSubjectWrite) {
              // eslint-disable-next-line no-await-in-loop
              await beforeSubjectWrite({ ...descriptor, outputPath: generationPath });
            }
            const expected = loadExpectedSheet(descriptor);
            rowCount += expected.sheet.rowCount;
            if (rowCount > limits.maxWorkbookRows) throw resourceError('正式结果工作簿超过总行数预算');
            maxSubjectSourceRows = Math.max(maxSubjectSourceRows, expected.budget.rows);
            maxSubjectBytes = Math.max(maxSubjectBytes, expected.budget.bytes);
            sheetMapping.push({ ...descriptor, rowCount: expected.sheet.rowCount });
            // eslint-disable-next-line no-await-in-loop
            await writeExpectedSheet(session, expected, descriptor);
            onProgress?.({ phase: 'writing', sheets: descriptor.ordinal + 1, sheetCount: sheetPlan.sheetCount, rowCount });
          }
          return { maxSubjectSourceRows, maxSubjectBytes };
          });
        } finally { await strings.close(); }
      },
      validateStaged: async (filePath) => {
        if (beforeValidate) await beforeValidate({ filePath, sheetPlan });
        validation = await validateResultWorkbook({ filePath, sheetPlan, loadExpectedSheet, signal: abortSignal, limits, onProgress });
      },
      beforePublish: () => safePoint(abortSignal)
    });
    return { runId: index.run.runId, targetMonth: index.run.targetMonth, resultRevision: index.run.resultRevision,
      inputFingerprint: index.run.inputFingerprint, subjects: [...index.subjects], filePaths: [targetPath],
      ...(publicationStagingDirectory ? { generationFilePaths: [generationPath] } : {}),
      layout: sheetPlan.layout, artifactCount: 1, subjectCount: sheetPlan.subjectCount, sheetCount: sheetPlan.sheetCount,
      sheetMapping, metrics, validation };
  } finally { db.exec(`ROLLBACK TO ${transaction}; RELEASE ${transaction}`); }
}

module.exports = { writeResultWorkbook, DEFAULT_RESULT_RESOURCE_LIMITS, resolveResultResourceLimits,
  loadResultWorkbookTemplates, loadExpectedResultSheet, assertSubjectBudget };
