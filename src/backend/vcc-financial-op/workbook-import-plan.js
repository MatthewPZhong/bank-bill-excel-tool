'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { openRichWorkbook } = require('../xlsx-rich-reader');
const {
  SOURCE_TYPES, SOURCE_DEFINITIONS, SYSTEM_OP_HEADERS,
  PENDING_RAW_CONTRACT_V2, headersEqual, isLegacyPendingHeaders, normalizeHeaderRow
} = require('./definitions');
const { hashSourceFile } = require('./source-lineage');

const HEADER_RULES = Object.freeze([
  [SOURCE_TYPES.RECHARGE, ['穿透节点ID', '订单号', '我方金额']],
  [SOURCE_TYPES.FEE_FX, ['穿透节点ID', '订单号', '我方金额']],
  [SOURCE_TYPES.CHANNEL, ['通道名称', '渠道订单号', '清算净金额']],
  [SOURCE_TYPES.PENDING, ['pending类型', 'PendingBizId', '流水_对账金额']],
  [SOURCE_TYPES.SYSTEM_OP, ['OP发生额', '财务余额', '财务主体余额']]
].map(([sourceType, features], order) => {
  const headers = sourceType === SOURCE_TYPES.SYSTEM_OP ? SYSTEM_OP_HEADERS : SOURCE_DEFINITIONS[sourceType].headers;
  return Object.freeze({ sourceType, features, order, headers, headerSet: new Set(headers) });
}));

function planError(code, message, detailLines = []) {
  return Object.assign(new Error(message), { code, detailLines });
}

function cellValue(cell) {
  if (!cell || cell.cellType === 'blank') return '';
  return cell.cellType === 'number' || cell.cellType === 'date'
    ? cell.rawLexicalValue : String(cell.decodedSemanticValue ?? '');
}

function rowValues(row) {
  const values = [];
  for (const cell of row.cells) values[cell.columnIndex] = cellValue(cell);
  return values;
}

function classifyHeaderRow(values) {
  const actual = normalizeHeaderRow(values);
  const exact = HEADER_RULES.find((rule) => headersEqual(actual, rule.headers));
  if (exact) return { status: 'ready', sourceType: exact.sourceType, candidates: [] };
  if (isLegacyPendingHeaders(actual)) {
    return { status: 'invalid', sourceType: SOURCE_TYPES.PENDING, code: 'pending-template-contract-mismatch',
      message: '旧 48 列 Pending 模板不能重新导入，请使用当前 46 列模板', candidates: [] };
  }
  const actualSet = new Set(actual.filter(Boolean));
  const candidates = HEADER_RULES.map((rule) => {
    const overlap = [...actualSet].filter((value) => rule.headerSet.has(value)).length;
    const features = rule.features.filter((value) => actualSet.has(value)).length;
    const strong = overlap >= Math.ceil(rule.headers.length / 2) || features >= 2;
    const uncertain = !strong && features === 1 && overlap >= 2;
    if (!strong && !uncertain) return null;
    return { sourceType: rule.sourceType, overlap, uncertain, order: rule.order,
      positionMatches: rule.headers.filter((value, index) => actual[index] === value).length,
      mismatches: Array.from({ length: Math.max(actual.length, rule.headers.length) }, (_, index) => ({
        column: index + 1, expected: rule.headers[index] ?? '（无此列）', actual: actual[index] ?? '（缺失）'
      })).filter((item) => item.expected !== item.actual).slice(0, 8) };
  }).filter(Boolean).sort((a, b) => b.overlap - a.overlap || b.positionMatches - a.positionMatches || a.order - b.order);
  if (!candidates.length) return null;
  const uncertain = candidates.every((candidate) => candidate.uncertain);
  return { status: 'invalid', code: uncertain ? 'vcc-sheet-header-uncertain' : 'vcc-sheet-header-invalid',
    message: uncertain ? '疑似业务表头，不能作为说明页排除' : '业务表头缺列、错序或含额外列', candidates };
}

function inputFileIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(stat[key])]));
}
async function inspectWorkbook(filePath, { physicalFileId = randomUUID(), onProgress, shouldCancel } = {}) {
  const fileIdentity = inputFileIdentity(filePath);
  const before = await hashSourceFile(filePath);
  const workbook = await openRichWorkbook(before.filePath, {
    memoryBudgetBytes: 64 * 1024 * 1024,
    cancelToken: { get cancelled() { return Boolean(shouldCancel && shouldCancel()); } }
  });
  const sources = [];
  try {
    if (workbook.date1904) throw planError('vcc-workbook-invalid', `${before.fileName}：暂不支持 1904 日期系统`);
    for (const sheet of workbook.sheets) {
      onProgress?.({ phase: 'preflight', fileName: before.fileName, sheetName: sheet.name, rows: 0 });
      let meaningfulRows = 0;
      let headerCount = 0;
      let firstHeader = null;
      const diagnostics = [];
      await workbook.scanSheet(sheet.sheetIndex, (row) => {
        if (!row.cells.some((cell) => cell.hasFormula || cell.cellType === 'error' || cellValue(cell) !== '')) return;
        meaningfulRows++;
        const evidence = classifyHeaderRow(rowValues(row));
        if (evidence) {
          headerCount++;
          if (!firstHeader) firstHeader = { ...evidence, headerRow: row.rowIndex };
          if (evidence.status !== 'ready' || headerCount > 1 || row.cells.some((cell) => cell.hasFormula)) {
            const code = headerCount > 1 ? 'vcc-sheet-ambiguous' : (evidence.code || 'vcc-sheet-header-invalid');
            if (diagnostics.length < 20) diagnostics.push({ code, row: row.rowIndex,
              message: `${sheet.name} 第 ${row.rowIndex} 行：${headerCount > 1 ? '存在第二个独立业务表头' : evidence.message || '表头不能含公式'}`,
              candidates: evidence.candidates });
          }
        }
        if (meaningfulRows % 10000 === 0 && onProgress) onProgress({ phase: 'preflight',
          fileName: before.fileName, sheetName: sheet.name, rows: meaningfulRows });
      });
      const status = diagnostics.length || (firstHeader && firstHeader.status !== 'ready') ? 'invalid'
        : firstHeader ? 'ready' : meaningfulRows ? 'unrecognized' : 'empty';
      onProgress?.({ phase: 'preflight', fileName: before.fileName, sheetName: sheet.name, rows: meaningfulRows });
      if (status === 'unrecognized') diagnostics.push({ code: 'vcc-sheet-unrecognized', message: '非空且无法识别；如为说明页，需明确排除' });
      sources.push({ sourceId: randomUUID(), physicalFileId, fileName: before.fileName,
        sheetName: sheet.name, sheetIndex: sheet.sheetIndex, visibility: sheet.state,
        entryPath: sheet.entryPath, status, sourceType: firstHeader?.sourceType,
        headerRow: firstHeader?.headerRow,
        rawContractVersion: firstHeader?.sourceType === SOURCE_TYPES.PENDING ? PENDING_RAW_CONTRACT_V2 : 1,
        requiresSubject: firstHeader?.sourceType === SOURCE_TYPES.CHANNEL, meaningfulRows, diagnostics });
    }
  } finally { await workbook.close(); }
  const after = await hashSourceFile(before.filePath);
  if (after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes
      || JSON.stringify(inputFileIdentity(filePath)) !== JSON.stringify(fileIdentity)) {
    throw planError('vcc-import-plan-stale', `${before.fileName}：预检期间文件发生变化，请重新选择`);
  }
  return { ...before, fileIdentity, physicalFileId, sheetCount: sources.length, sources };
}

async function inspectWorkbookImportPlan(filePaths, options = {}) {
  const paths = [...new Set((filePaths || []).map((filePath) => path.resolve(filePath)))];
  if (!paths.length) throw planError('vcc-import-plan-empty', '请选择至少一个 XLSX 文件');
  const physicalFiles = [];
  for (const filePath of paths) {
    options.onProgress?.({ phase: 'preflight', fileName: path.basename(filePath), rows: 0 });
    physicalFiles.push(await inspectWorkbook(filePath, options));
  }
  return { planId: randomUUID(), physicalFiles: physicalFiles.map(({ sources: _sources, ...file }) => file),
    sources: physicalFiles.flatMap((file) => file.sources) };
}

function publicImportPlan(plan) {
  return { planId: plan.planId,
    physicalFiles: plan.physicalFiles.map(({ physicalFileId, fileName, sheetCount }) => ({ physicalFileId, fileName, sheetCount })),
    sources: plan.sources.map(({ entryPath: _entryPath, ...source }) => source) };
}

function resolveImportPlan(plan, request = {}) {
  if (!plan || request.planId !== plan.planId) throw planError('vcc-import-plan-stale', '导入计划已失效，请重新预检');
  const subjects = request.subjectBySourceId;
  if (!subjects || typeof subjects !== 'object' || Array.isArray(subjects) || !Array.isArray(request.excludedSheetIds)) {
    throw planError('vcc-import-plan-invalid', '主体和说明页排除参数格式无效');
  }
  const sources = new Map(plan.sources.map((source) => [source.sourceId, source]));
  for (const id of Object.keys(subjects)) {
    if (!sources.has(id) || !sources.get(id).requiresSubject || typeof subjects[id] !== 'string') {
      throw planError('vcc-import-plan-invalid', '补充主体只能指定当前计划中的通道 Sheet');
    }
  }
  const excluded = new Set(request.excludedSheetIds);
  if (excluded.size !== request.excludedSheetIds.length) throw planError('vcc-import-plan-invalid', '排除 Sheet 重复');
  for (const id of excluded) {
    if (!sources.has(id) || sources.get(id).status !== 'unrecognized') {
      throw planError('vcc-import-plan-invalid', '只能排除当前计划中的无法识别说明页');
    }
  }
  const bad = plan.sources.filter((source) => source.status === 'invalid');
  if (bad.length) throw planError(bad[0].diagnostics[0]?.code || 'vcc-sheet-header-invalid',
    '原表结构错误，整个导入计划未提交', bad.flatMap((source) => source.diagnostics.map((d) => `${source.fileName} / ${d.message}`)));
  const unknown = plan.sources.filter((source) => source.status === 'unrecognized' && !excluded.has(source.sourceId));
  if (unknown.length) throw planError('vcc-sheet-unrecognized', '请明确排除说明页或更换输入', unknown.map((s) => `${s.fileName} / ${s.sheetName}`));
  const ready = plan.sources.filter((source) => source.status === 'ready');
  if (!ready.length) throw planError('vcc-import-plan-empty', '没有可导入的业务 Sheet');
  for (const source of ready) {
    if (source.requiresSubject && !subjects[source.sourceId]?.trim()) {
      throw planError('vcc-sheet-subject-required', `${source.fileName} / ${source.sheetName}：请补充公司主体`);
    }
  }
  return plan.physicalFiles.map((file) => ({ ...file, sheets: ready
    .filter((source) => source.physicalFileId === file.physicalFileId)
    .map((source) => ({ ...source, ...(source.requiresSubject ? { subject: subjects[source.sourceId].trim() } : {}) }))
  })).filter((file) => file.sheets.length);
}

function sheetPlanDigest(sources) {
  return createHash('sha256').update(JSON.stringify(sources.map(({ sourceId: _id, physicalFileId: _fileId, ...source }) => source))).digest('hex');
}

async function revalidateImportPlan(plan, options = {}) {
  for (const file of plan.physicalFiles) {
    let fingerprint;
    try {
      fingerprint = await hashSourceFile(file.filePath);
    } catch (error) {
      throw planError('vcc-import-plan-stale', `${file.fileName}：预检后的文件已不可读取，请重新预检`, [error.message]);
    }
    if (fingerprint.sha256 !== file.sha256 || fingerprint.sizeBytes !== file.sizeBytes
        || JSON.stringify(inputFileIdentity(file.filePath)) !== JSON.stringify(file.fileIdentity)) {
      throw planError('vcc-import-plan-stale', `${file.fileName}：文件已变化，请重新预检`);
    }
    const current = await inspectWorkbook(file.filePath, { ...options, physicalFileId: file.physicalFileId });
    const previous = plan.sources.filter((source) => source.physicalFileId === file.physicalFileId);
    if (current.sha256 !== file.sha256 || current.sizeBytes !== file.sizeBytes
        || sheetPlanDigest(previous) !== sheetPlanDigest(current.sources)) {
      throw planError('vcc-import-plan-stale', `${file.fileName}：文件或 Sheet 计划已变化，请重新预检`);
    }
  }
}

module.exports = { HEADER_RULES, classifyHeaderRow, cellValue, rowValues, inspectWorkbook,
  inspectWorkbookImportPlan, publicImportPlan, resolveImportPlan, revalidateImportPlan, planError, inputFileIdentity };
