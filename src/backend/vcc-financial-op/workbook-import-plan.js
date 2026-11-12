'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { openRichWorkbook } = require('../xlsx/rich-workbook');
const {
  SOURCE_TYPES, SOURCE_LABELS, SOURCE_DEFINITIONS, SYSTEM_OP_HEADERS,
  PENDING_RAW_CONTRACT_V2, headersEqual, isLegacyPendingHeaders, normalizeHeaderRow
} = require('./definitions');
const { describeHeaderMismatch } = require('../file-service/header-structure-diff');
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

// 设置 → 模板文件：sourceStructures = { [sourceType]: { headers, versionLabel } }（仅启用了用户版本的原表）。
//   该原表的识别规则改为当前版本表头（逐列一致），命中时 Sheet 记录 sourceHeaders；其余原表按内置结构。
function headerRulesFor(sourceStructures) {
  if (!sourceStructures) return HEADER_RULES;
  return Object.freeze(HEADER_RULES.map((rule) => {
    const structure = sourceStructures[rule.sourceType];
    if (!structure || !Array.isArray(structure.headers) || !structure.headers.length) return rule;
    const headers = Object.freeze([...structure.headers]);
    return Object.freeze({ ...rule, headers, headerSet: new Set(headers), sourceHeaders: headers,
      versionLabel: String(structure.versionLabel || '') });
  }));
}

// 表头不符时的逐列差异（与各原表当前结构中最接近的一个比较），附模板文件指引。
function headerMismatchLines(actual, rules) {
  return describeHeaderMismatch({
    sheets: [{ name: '', headers: actual }],
    candidates: rules.map((rule) => ({ name: SOURCE_LABELS[rule.sourceType], headers: rule.headers, versionLabel: rule.versionLabel || '' }))
  });
}

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

// 多张原表的当前结构与该行完全相同（v3.2.15 B42）：拒绝并列出候选，不按规则顺序静默取第一项，避免进入错误的计算分支。
function ambiguousHeaderEvidence(matches) {
  const names = matches.map((rule) => `「${SOURCE_LABELS[rule.sourceType]}」`);
  return { status: 'invalid', code: 'vcc-sheet-header-ambiguous',
    message: `表头与${names.join('、')}的当前结构完全相同，无法确定来源；请在 设置 → 模板文件 调整其中一张表的当前版本`,
    candidates: matches.map((rule) => ({ sourceType: rule.sourceType, overlap: rule.headers.length, uncertain: false,
      order: rule.order, positionMatches: rule.headers.length, mismatches: [] })),
    detailLines: matches.map((rule) => `${SOURCE_LABELS[rule.sourceType]}：${rule.versionLabel ? `当前版本 ${rule.versionLabel}` : '内置结构'}`) };
}

function classifyHeaderRow(values, rules = HEADER_RULES) {
  const actual = normalizeHeaderRow(values);
  const matches = rules.filter((rule) => headersEqual(actual, rule.headers));
  if (matches.length > 1) return ambiguousHeaderEvidence(matches);
  const exact = matches[0];
  if (exact) {
    return { status: 'ready', sourceType: exact.sourceType, candidates: [],
      ...(exact.sourceHeaders ? { sourceHeaders: exact.sourceHeaders } : {}) };
  }
  if (isLegacyPendingHeaders(actual)) {
    return { status: 'invalid', sourceType: SOURCE_TYPES.PENDING, code: 'pending-template-contract-mismatch',
      message: '旧 48 列 Pending 模板不能重新导入，请使用当前 46 列模板', candidates: [] };
  }
  const actualSet = new Set(actual.filter(Boolean));
  const candidates = rules.map((rule) => {
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
    message: uncertain ? '疑似业务表头，不能作为说明页排除' : '业务表头缺列、错序或含额外列', candidates,
    detailLines: headerMismatchLines(actual, rules) };
}

function inputFileIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(stat[key])]));
}
async function inspectWorkbook(filePath, {
  physicalFileId = randomUUID(), onProgress, shouldCancel, sourceStructures = null, targetMonth = null
} = {}) {
  const rules = headerRulesFor(sourceStructures);
  const fileIdentity = inputFileIdentity(filePath);
  const before = await hashSourceFile(filePath);
  const workbook = await openRichWorkbook(before.filePath, {
    memoryBudgetBytes: 64 * 1024 * 1024, lruMaxEntries: 8192,
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
        const evidence = classifyHeaderRow(rowValues(row), rules);
        if (evidence) {
          headerCount++;
          if (!firstHeader) firstHeader = { ...evidence, headerRow: row.rowIndex };
          if (evidence.status !== 'ready' || headerCount > 1 || row.cells.some((cell) => cell.hasFormula)) {
            const code = headerCount > 1 ? 'vcc-sheet-ambiguous' : (evidence.code || 'vcc-sheet-header-invalid');
            if (diagnostics.length < 20) diagnostics.push({ code, row: row.rowIndex,
              message: `${sheet.name} 第 ${row.rowIndex} 行：${headerCount > 1 ? '存在第二个独立业务表头' : evidence.message || '表头不能含公式'}`,
              candidates: evidence.candidates,
              ...(headerCount === 1 && evidence.detailLines ? { detailLines: evidence.detailLines } : {}) });
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
        ...(firstHeader?.status === 'ready' && firstHeader.sourceHeaders ? { sourceHeaders: [...firstHeader.sourceHeaders] } : {}),
        requiresSubject: firstHeader?.sourceType === SOURCE_TYPES.CHANNEL, meaningfulRows, diagnostics });
    }
  } finally { await workbook.close(); }
  if (targetMonth) {
    await detectChannelCorrections(before, sources, { targetMonth, onProgress, shouldCancel });
  }
  const after = await hashSourceFile(before.filePath);
  if (after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes
      || JSON.stringify(inputFileIdentity(filePath)) !== JSON.stringify(fileIdentity)) {
    throw planError('vcc-import-plan-stale', `${before.fileName}：预检期间文件发生变化，请重新选择`);
  }
  return { ...before, fileIdentity, physicalFileId, sheetCount: sources.length, sources };
}

// v3.2.17 通道明细补录：用正式导入同一读取与映射链路逐行判定，列出业务键与账单日期有效、
// 仅参与计算的字段为空或不合规的行，供预检弹窗补录。每个 Sheet 最多保留 MAX 条明细。
const CHANNEL_CORRECTION_CANDIDATE_LIMIT = 2000;

async function detectChannelCorrections(file, sources, { targetMonth, onProgress, shouldCancel }) {
  const channelSources = sources.filter((source) => (
    source.sourceType === SOURCE_TYPES.CHANNEL && source.status === 'ready'
  ));
  if (channelSources.length === 0) return;
  const { openWorkbookSheets, streamDetailRows } = require('./workbook-reader');
  const { inspectChannelCorrectionCandidate } = require('./row-mapper');
  const workbook = await openWorkbookSheets(file.filePath);
  try {
    for (const source of channelSources) {
      const candidates = [];
      let total = 0;
      let scanned = 0;
      await streamDetailRows(file.filePath, SOURCE_TYPES.CHANNEL, {
        workbook,
        sheetName: source.sheetName,
        sheetIndex: source.sheetIndex,
        headerRow: source.headerRow,
        sourceHeaders: source.sourceHeaders,
        onDataRow: ({ rowR, values, keyCellType }) => {
          if (shouldCancel && shouldCancel()) throw planError('vcc-import-cancelled', '已取消预检');
          scanned += 1;
          if (scanned % 10000 === 0) {
            onProgress?.({ phase: 'preflight', fileName: file.fileName, sheetName: source.sheetName, rows: scanned });
          }
          const candidate = inspectChannelCorrectionCandidate({
            values, targetMonth, keyCellType, sourceRow: rowR
          });
          if (!candidate) return;
          total += 1;
          if (candidates.length < CHANNEL_CORRECTION_CANDIDATE_LIMIT) candidates.push(candidate);
        }
      });
      source.channelCorrectionCandidates = Object.freeze({
        total,
        truncated: total > candidates.length,
        candidates: Object.freeze(candidates)
      });
    }
  } finally {
    await workbook.close();
  }
}

async function inspectWorkbookImportPlan(filePaths, options = {}) {
  const paths = [...new Set((filePaths || []).map((filePath) => path.resolve(filePath)))];
  if (!paths.length) throw planError('vcc-import-plan-empty', '请选择至少一个 XLSX 文件');
  const physicalFiles = [];
  for (const filePath of paths) {
    options.onProgress?.({ phase: 'preflight', fileName: path.basename(filePath), rows: 0 });
    physicalFiles.push(await inspectWorkbook(filePath, options));
  }
  // 本次预检所用的当前结构冻结在计划中：重新预检沿用它，预检后切换模板版本不影响本次导入。
  return { planId: randomUUID(), sourceStructures: options.sourceStructures || null,
    targetMonth: options.targetMonth || null,
    physicalFiles: physicalFiles.map(({ sources: _sources, ...file }) => file),
    sources: physicalFiles.flatMap((file) => file.sources) };
}

function publicImportPlan(plan) {
  return { planId: plan.planId, targetMonth: plan.targetMonth || null,
    physicalFiles: plan.physicalFiles.map(({ physicalFileId, fileName, sheetCount }) => ({ physicalFileId, fileName, sheetCount })),
    sources: plan.sources.map(({ entryPath: _entryPath, ...source }) => source) };
}

const MAX_CORRECTION_VALUE_LENGTH = 200;

// 校验预检弹窗提交的通道明细补录：只能改预检列出的行与可改字段，改后须满足通道发生额计算规则。
function resolveChannelCorrections(plan, request, readySourceIds) {
  const { CHANNEL_CORRECTABLE_FIELDS, channelCorrectionProblems } = require('./row-mapper');
  const editable = new Set(CHANNEL_CORRECTABLE_FIELDS);
  const raw = request.channelCorrections === undefined ? [] : request.channelCorrections;
  if (!Array.isArray(raw)) throw planError('vcc-import-plan-invalid', '通道明细补录参数格式无效');
  const sources = new Map(plan.sources.map((source) => [source.sourceId, source]));
  const bySource = new Map();
  const seen = new Set();
  const errors = [];
  for (const item of raw) {
    const source = item && sources.get(item.sourceId);
    if (!source || !readySourceIds.has(source.sourceId) || source.sourceType !== SOURCE_TYPES.CHANNEL) {
      throw planError('vcc-import-plan-invalid', '补录只能针对当前计划中的通道明细 Sheet');
    }
    const sourceRow = Number(item.sourceRow);
    const candidate = (source.channelCorrectionCandidates?.candidates || [])
      .find((entry) => entry.sourceRow === sourceRow);
    if (!candidate) throw planError('vcc-import-plan-invalid', `${source.sheetName} 第 ${item.sourceRow} 行不在待补录清单中`);
    const identity = `${source.sourceId}\u0000${sourceRow}`;
    if (seen.has(identity)) throw planError('vcc-import-plan-invalid', `${source.sheetName} 第 ${sourceRow} 行重复提交`);
    seen.add(identity);
    const fields = item.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw planError('vcc-import-plan-invalid', '通道明细补录字段格式无效');
    }
    const corrected = {};
    for (const [field, value] of Object.entries(fields)) {
      if (!editable.has(field)) throw planError('vcc-import-plan-invalid', `字段“${field}”不允许补录`);
      if (typeof value !== 'string' || value.length > MAX_CORRECTION_VALUE_LENGTH) {
        throw planError('vcc-import-plan-invalid', `字段“${field}”的补录值无效`);
      }
      const normalized = value.trim();
      if (normalized !== candidate.fields[field]) corrected[field] = normalized;
    }
    if (Object.keys(corrected).length === 0) continue;
    const merged = { ...candidate.fields, ...corrected };
    const problems = channelCorrectionProblems((field) => merged[field], plan.targetMonth);
    if (problems.length > 0) {
      errors.push(`${source.fileName} / ${source.sheetName} 第 ${sourceRow} 行：${problems.map((problem) => problem.message).join('；')}`);
      continue;
    }
    if (!bySource.has(source.sourceId)) bySource.set(source.sourceId, []);
    bySource.get(source.sourceId).push(Object.freeze({
      sourceRow,
      idempotencyKey: candidate.idempotencyKey,
      original: Object.freeze(Object.fromEntries(Object.keys(corrected).map((field) => [field, candidate.fields[field]]))),
      corrected: Object.freeze(corrected)
    }));
  }
  if (errors.length > 0) {
    throw planError('vcc-channel-correction-invalid', '补录内容仍不合规，请修改后再导入', errors.slice(0, 50));
  }
  return bySource;
}

// 汇总已解析计划中各 Sheet 的补录，供导入 worker 按 物理文件 + Sheet 序号 + 行号 应用。
function collectChannelCorrections(inspectedFiles) {
  return Object.freeze((inspectedFiles || []).flatMap((file) => (file.sheets || [])
    .flatMap((sheet) => (sheet.channelCorrections || []).map((correction) => Object.freeze({
      physicalFileId: file.physicalFileId,
      sheetIndex: sheet.sheetIndex,
      ...correction
    })))));
}

function resolveImportPlan(plan, request = {}) {
  if (!plan || request.planId !== plan.planId) throw planError('vcc-import-plan-stale', '导入计划已失效，请重新预检');
  if (plan.targetMonth && request.targetMonth !== undefined && request.targetMonth !== plan.targetMonth) {
    throw planError('vcc-import-plan-stale', '导入账期与预检账期不一致，请重新预检');
  }
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
    '原表结构错误，整个导入计划未提交', bad.flatMap((source) => source.diagnostics.flatMap((d) => [
      `${source.fileName} / ${d.message}`, ...(Array.isArray(d.detailLines) ? d.detailLines : [])
    ])));
  const unknown = plan.sources.filter((source) => source.status === 'unrecognized' && !excluded.has(source.sourceId));
  if (unknown.length) throw planError('vcc-sheet-unrecognized', '请明确排除说明页或更换输入', unknown.map((s) => `${s.fileName} / ${s.sheetName}`));
  const ready = plan.sources.filter((source) => source.status === 'ready');
  if (!ready.length) throw planError('vcc-import-plan-empty', '没有可导入的业务 Sheet');
  for (const source of ready) {
    if (source.requiresSubject && !subjects[source.sourceId]?.trim()) {
      throw planError('vcc-sheet-subject-required', `${source.fileName} / ${source.sheetName}：请补充公司主体`);
    }
  }
  const corrections = resolveChannelCorrections(plan, request, new Set(ready.map((source) => source.sourceId)));
  return plan.physicalFiles.map((file) => ({ ...file, sheets: ready
    .filter((source) => source.physicalFileId === file.physicalFileId)
    .map(({ channelCorrectionCandidates: _candidates, ...source }) => ({
      ...source,
      ...(source.requiresSubject ? { subject: subjects[source.sourceId].trim() } : {}),
      ...(corrections.has(source.sourceId) ? { channelCorrections: corrections.get(source.sourceId) } : {})
    }))
  })).filter((file) => file.sheets.length);
}

// 提交前复核在 prepare 阶段运行，尚未进入存档任务生命周期：取消只能靠 worker 的 shouldCancel，
//   每个文件哈希前、哈希中与返回前都检查，取消时抛 vcc-import-cancelled，不让已取消的导入继续写入。
async function revalidateImportPlan(plan, options = {}) {
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const assertNotCancelled = () => {
    if (shouldCancel && shouldCancel()) throw planError('vcc-import-cancelled', '已取消导入');
  };
  for (const file of plan.physicalFiles) {
    assertNotCancelled();
    let fingerprint;
    try {
      fingerprint = await hashSourceFile(file.filePath, { shouldCancel });
    } catch (error) {
      if (error && error.code === 'vcc-import-cancelled') throw planError('vcc-import-cancelled', '已取消导入');
      throw planError('vcc-import-plan-stale', `${file.fileName}：预检后的文件已不可读取，请重新预检`, [error.message]);
    }
    assertNotCancelled();
    if (fingerprint.sha256 !== file.sha256 || fingerprint.sizeBytes !== file.sizeBytes
        || JSON.stringify(inputFileIdentity(file.filePath)) !== JSON.stringify(file.fileIdentity)) {
      throw planError('vcc-import-plan-stale', `${file.fileName}：文件已变化，请重新预检`);
    }
    // 字节与文件身份未变、识别结构已冻结在计划中，重新解析只会得到同一份 Sheet 计划，
    // 因此不再整本重扫（v3.2.17）。
  }
  assertNotCancelled();
}

module.exports = { CHANNEL_CORRECTION_CANDIDATE_LIMIT, collectChannelCorrections,
  HEADER_RULES, headerRulesFor, classifyHeaderRow, cellValue, rowValues, inspectWorkbook,
  inspectWorkbookImportPlan, publicImportPlan, resolveImportPlan, revalidateImportPlan, planError, inputFileIdentity };
