'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSourceSnapshot } = require('../archive-center/source-snapshot');
const { normalizeSplitOutputFileName } = require('../toolbox-multi-split');
const { detectToolboxInputKind } = require('../toolbox-input-kind');

const ROWS_ACTION = 'toolbox:split-rows';
const MAX_ROW_SPLIT_FILES = 1000;
const MIB = 1024 ** 2;
// 产品保护预算；容量结论以版本目录内的实际验收记录为准。
const ROWS_BUDGETS = Object.freeze({
  maxOutputFiles: MAX_ROW_SPLIT_FILES,
  maxCacheRecordBytes: 8 * MIB,
  maxMaterializedSourceBytes: 64 * MIB,
  maxRegistryBytes: 64 * MIB,
  maxCacheBytes: 8 * 1024 * MIB,
  maxGeneratedBytes: 16 * 1024 * MIB,
  maxTaskTemporaryBytes: 32 * 1024 * MIB,
  minFreeBytes: 128 * MIB,
  maxPlanBytes: 8 * MIB,
  maxManifestBytes: 8 * MIB,
  maxPublicResultBytes: 8 * MIB,
  maxWarningBytes: 256 * 1024,
  maxMemoryBytes: 768 * MIB
});

function rowsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assert(condition, message, code = 'TOOLBOX_ROWS_CONTRACT_INVALID') {
  if (!condition) throw rowsError(code, message);
}

function exactKeys(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value), '按行拆分参数格式非法');
  assert(Object.keys(value).sort().join('|') === keys.slice().sort().join('|'), '按行拆分参数字段非法');
}

function planRowCounts(rowCount, rowsPerFile) {
  assert(Number.isSafeInteger(rowCount) && rowCount >= 0, '拆分数据行数已失效，请重新导入');
  assert(Number.isSafeInteger(rowsPerFile) && rowsPerFile > 0, '请输入大于 0 的整数');
  assert(rowCount > 0, '文件中没有可拆分的数据行', 'TOOLBOX_ROWS_EMPTY');
  const r = BigInt(rowCount);
  const n = BigInt(rowsPerFile);
  const count = (r - 1n) / n + 1n;
  if (count > BigInt(MAX_ROW_SPLIT_FILES)) {
    const minimum = (r - 1n) / BigInt(MAX_ROW_SPLIT_FILES) + 1n;
    throw rowsError('TOOLBOX_ROWS_TOO_MANY_FILES',
      `预计生成 ${count} 个文件，最多支持 ${MAX_ROW_SPLIT_FILES} 个，请将每份行数调整为至少 ${minimum} 行。`);
  }
  return Object.freeze({ rowCount, rowsPerFile, fileCount: Number(count) });
}

function partRange(counts, partIndex) {
  assert(Number.isInteger(partIndex) && partIndex >= 0 && partIndex < counts.fileCount, '拆分序号非法');
  const start = BigInt(partIndex) * BigInt(counts.rowsPerFile);
  const end = start + BigInt(counts.rowsPerFile);
  return { startRowSeq: Number(start), endRowSeq: Number(end < BigInt(counts.rowCount) ? end : BigInt(counts.rowCount)) };
}

function buildRowTargets(sourceFilePath, directory, counts) {
  const checked = planRowCounts(counts.rowCount, counts.rowsPerFile);
  const stem = path.parse(sourceFilePath).name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
  return Array.from({ length: checked.fileCount }, (_, partIndex) => {
    const suffix = String(partIndex + 1).padStart(4, '0');
    const fileName = normalizeSplitOutputFileName(`${stem}_按行拆分_${suffix}.xlsx`);
    assert(Buffer.byteLength(fileName, 'utf8') <= 255, '原文件名过长，请缩短名称后重新导入', 'TOOLBOX_ROWS_PATH_TOO_LONG');
    return Object.freeze({ partIndex, outputId: `row-split-${suffix}`, fileName,
      filePath: path.join(directory, fileName), ...partRange(checked, partIndex) });
  });
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value, limit, label) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  assert(bytes.length <= limit, `${label}超出大小预算`, 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
  return bytes;
}

function assertDiskSpace(directory, reserve = 0) {
  const stat = fs.statfsSync(directory, { bigint: true });
  const available = stat.bavail * stat.bsize;
  assert(available >= BigInt(ROWS_BUDGETS.minFreeBytes) + BigInt(reserve),
    '磁盘可用空间不足，未继续按行拆分', 'TOOLBOX_ROWS_DISK_BUDGET');
}

function assertSourceBudget(filePath) {
  // 既有 CSV/BIFF reader 会物化原始表；XLSX 使用流式 reader。
  // 在 reader 分配前限制外部 Buffer，Worker 自身另有 V8 堆硬上限。
  if (detectToolboxInputKind(filePath) !== 'xlsx') {
    assert(fs.statSync(filePath).size <= ROWS_BUDGETS.maxMaterializedSourceBytes,
      'CSV/XLS 文件超过按行拆分的 64 MiB 读取预算，请先转换为 XLSX 后重试',
      'TOOLBOX_ROWS_SOURCE_BUDGET');
  }
}

function publicResult(counts, files, warningSummary = { warningCount: 0, warningSamples: [] }, warnings = []) {
  return { status: 'success', mode: 'rows', rowsPerFile: counts.rowsPerFile,
    inputDataRowCount: counts.rowCount, outputDataRowCount: counts.rowCount,
    fileCount: counts.fileCount,
    files: files.map((file, partIndex) => ({ partIndex, outputId: file.outputId,
      fileName: file.fileName, filePath: file.filePath, dataRowCount: file.dataRowCount })),
    warningSummary, warnings };
}

function assertResultBudget(counts, targets) {
  const result = publicResult(counts, targets.map((file) => ({ ...file, dataRowCount: counts.rowsPerFile })));
  const bytes = jsonBytes(result, ROWS_BUDGETS.maxPublicResultBytes, '结果');
  assert(bytes.length + 2 * ROWS_BUDGETS.maxWarningBytes <= ROWS_BUDGETS.maxPublicResultBytes,
    '结果及警告超出消息预算，请缩短目录或文件名', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
}

function validatePlan(plan) {
  exactKeys(plan, ['version', 'action', 'attemptId', 'taskRunId', 'source', 'rowCount', 'rowsPerFile', 'fileCount', 'privateDirectory', 'parts']);
  assert(plan.version === 1 && plan.action === ROWS_ACTION, '按行拆分合同版本非法');
  assert(typeof plan.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(plan.attemptId), '任务尝试身份非法');
  assert(typeof plan.taskRunId === 'string' && plan.taskRunId.length > 0, '缺少任务身份');
  const counts = planRowCounts(plan.rowCount, plan.rowsPerFile);
  assert(plan.fileCount === counts.fileCount && Array.isArray(plan.parts) && plan.parts.length === counts.fileCount, '输出数量与计划不一致');
  exactKeys(plan.source, ['filePath', 'sourceSnapshot']);
  assert(path.isAbsolute(plan.source.filePath) && normalizeSourceSnapshot(plan.source.sourceSnapshot), '源文件快照非法');
  assert(path.isAbsolute(plan.privateDirectory) && fs.realpathSync(plan.privateDirectory) === plan.privateDirectory, '任务临时目录非法');
  const seen = new Set();
  plan.parts.forEach((part, index) => {
    exactKeys(part, ['partIndex', 'outputId', 'fileName', 'filePath', 'startRowSeq', 'endRowSeq', 'artifactKey', 'generationPath']);
    const range = partRange(counts, index);
    assert(part.partIndex === index && part.outputId === `row-split-${String(index + 1).padStart(4, '0')}` &&
      part.startRowSeq === range.startRowSeq && part.endRowSeq === range.endRowSeq, '输出范围与计划不一致');
    assert(part.generationPath === path.join(plan.privateDirectory, `${String(index + 1).padStart(4, '0')}.xlsx`), '生成路径不属于任务');
    assert(path.isAbsolute(part.filePath) && part.fileName === path.basename(part.filePath) &&
      typeof part.artifactKey === 'string' && part.artifactKey && !seen.has(part.artifactKey), '输出身份非法');
    seen.add(part.artifactKey);
  });
  jsonBytes(plan, ROWS_BUDGETS.maxPlanBytes, '计划');
  assertResultBudget(counts, plan.parts);
  return plan;
}

function writePrivateJson(filePath, value, limit) {
  const bytes = jsonBytes(value, limit, '任务清单');
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { byteSize: bytes.length, sha256: sha256(bytes) };
}

function readPrivateJson(filePath, descriptor, limit) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size > 0 && stat.size <= limit && stat.size === descriptor.byteSize, '任务清单大小或身份非法');
    const bytes = fs.readFileSync(fd);
    assert(sha256(bytes) === descriptor.sha256, '任务清单摘要不一致');
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function validateRowsResult(result) {
  try {
    exactKeys(result, ['version', 'actionKey', 'tokenId', 'outputPlanHash', 'manifest']);
    exactKeys(result.manifest, ['byteSize', 'sha256']);
    return result.version === 1 && result.actionKey === ROWS_ACTION &&
      typeof result.tokenId === 'string' && /^[a-f0-9-]{36}$/.test(result.tokenId) &&
      /^[a-f0-9]{64}$/.test(result.outputPlanHash) && /^[a-f0-9]{64}$/.test(result.manifest.sha256) &&
      Number.isSafeInteger(result.manifest.byteSize) && result.manifest.byteSize > 0 &&
      result.manifest.byteSize <= ROWS_BUDGETS.maxManifestBytes;
  } catch (_error) { return false; }
}

module.exports = { ROWS_ACTION, ROWS_BUDGETS, MAX_ROW_SPLIT_FILES, rowsError, assert, exactKeys,
  planRowCounts, partRange, buildRowTargets, sha256, jsonBytes, assertDiskSpace, publicResult,
  assertResultBudget, assertSourceBudget, validatePlan, writePrivateJson, readPrivateJson, validateRowsResult };
