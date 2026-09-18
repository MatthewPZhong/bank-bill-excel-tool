'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fromProtocolError } = require('../background-execution/error-codec');
const { operationContextFromBatch } = require('../toolbox-background/generation-validator');
const { normalizeWarningSummary } = require('../toolbox-background/generation-contract');
const { sha256File } = require('../toolbox-output-writer');
const { normalizeFilePlanV1, assertFilePlanFresh } = require('../archive-center/file-plan');
const { sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const {
  ROWS_ACTION, ROWS_BUDGETS, assert, exactKeys, rowsError, planRowCounts,
  buildRowTargets, assertResultBudget, assertSourceBudget, jsonBytes, assertDiskSpace, publicResult,
  validatePlan, writePrivateJson, readPrivateJson, validateRowsResult
} = require('./contracts');

async function prepareRows(payload, readContext, { chooseDirectory, confirmOverwrite, metadataDirectory }) {
  exactKeys(payload, ['sourceFilePath', 'splitReadToken', 'mode', 'rowsPerFile']);
  assert(payload.mode === 'rows', '按行拆分模式非法');
  // 计数检查先于路径数组、对话框、FilePlan 和任务创建。
  const counts = planRowCounts(readContext.dataRowCount, payload.rowsPerFile);
  assert(sourceSnapshotMatchesStat(readContext.snapshot, fs.statSync(readContext.sourceFilePath, { bigint: true })),
    '拆分源文件在读取后已变化，请重新选择', 'TOOLBOX_SPLIT_READ_CONTEXT_STALE');
  assertSourceBudget(readContext.sourceFilePath);
  const directory = await chooseDirectory();
  if (!directory) return null;
  const outputDirectory = fs.realpathSync(directory);
  const targets = buildRowTargets(readContext.sourceFilePath, outputDirectory, counts);
  assertResultBudget(counts, targets);
  // generationPath 也重复完整目录，长路径不能按每份固定 1 KiB 估算。
  // 主进程生成的 taskRunId 是 UUID；额外预留 256 字节，不接受 renderer 指定身份。
  const estimatedPrivateDirectory = path.join(outputDirectory, '.toolbox-rows-XXXXXX');
  jsonBytes({ version: 1, action: ROWS_ACTION, attemptId: '0'.repeat(36), taskRunId: '0'.repeat(256),
    source: { filePath: readContext.sourceFilePath, sourceSnapshot: readContext.snapshot },
    ...counts, privateDirectory: estimatedPrivateDirectory,
    parts: targets.map((target, index) => ({ ...target, artifactKey: 'output-' + '0'.repeat(64),
      generationPath: path.join(estimatedPrivateDirectory, String(index + 1).padStart(4, '0') + '.xlsx') }))
  }, ROWS_BUDGETS.maxPlanBytes, '目标计划');
  assertDiskSpace(outputDirectory);
  if (metadataDirectory) assertDiskSpace(metadataDirectory);
  // 覆盖许可绑定确认前的全部目标（包括尚不存在的目标），后续入口不得重新采集。
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: readContext.sourceFilePath, role: 'input', sourceOperation: 'toolbox:split:export',
      sourceSnapshot: readContext.snapshot,
      freshnessFailure: { code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE', message: '拆分源文件在读取后已变化，请重新选择' } }],
    outputs: targets.map((target) => ({ filePath: target.filePath, role: 'output', sourceOperation: 'toolbox:split:export' })) });
  const conflicts = targets.filter((_target, index) => filePlan.outputs[index].targetSnapshot.exists);
  if (conflicts.length && !await confirmOverwrite(conflicts)) return null;
  assertFilePlanFresh(filePlan);
  return Object.freeze({ counts, targets, outputDirectory, filePlan, actionKey: ROWS_ACTION });
}

function aggregateWarnings(files) {
  const result = { warningCount: 0, warningSamples: [] };
  for (const file of files) {
    const summary = normalizeWarningSummary(file.warningSummary);
    result.warningCount += summary.warningCount;
    assert(Number.isSafeInteger(result.warningCount), '格式警告数量超出安全范围');
    result.warningSamples.push(...summary.warningSamples.slice(0, 20 - result.warningSamples.length));
  }
  jsonBytes(result, ROWS_BUDGETS.maxWarningBytes, '格式警告');
  return result;
}

async function validateRowsManifest(plan, input, result) {
  assert(validateRowsResult(result) && result.tokenId === plan.attemptId &&
    result.outputPlanHash === input.planDescriptor.sha256, '按行拆分返回身份非法');
  const manifest = readPrivateJson(path.join(plan.privateDirectory, 'outputs.json'),
    result.manifest, ROWS_BUDGETS.maxManifestBytes);
  exactKeys(manifest, ['version', 'actionKey', 'attemptId', 'taskRunId', 'outputPlanHash',
    'rowCount', 'rowsPerFile', 'fileCount', 'files', 'metrics']);
  assert(manifest.version === 1 && manifest.actionKey === ROWS_ACTION &&
    manifest.attemptId === plan.attemptId && manifest.taskRunId === plan.taskRunId &&
    manifest.outputPlanHash === input.planDescriptor.sha256 &&
    manifest.rowCount === plan.rowCount && manifest.rowsPerFile === plan.rowsPerFile &&
    manifest.fileCount === plan.fileCount && Array.isArray(manifest.files) &&
    manifest.files.length === plan.fileCount, '按行拆分产物清单与计划不一致');
  let total = 0;
  let generatedBytes = 0;
  const artifacts = [];
  for (const [index, part] of plan.parts.entries()) {
    const file = manifest.files[index];
    exactKeys(file, [...Object.keys(part), 'dataRowCount', 'byteSize', 'sha256', 'sheetCount', 'warningSummary', 'styleStats']);
    assert(Object.keys(part).every((key) => file[key] === part[key]), '按行拆分输出归属或范围不一致');
    assert(file.dataRowCount === part.endRowSeq - part.startRowSeq &&
      Number.isSafeInteger(file.byteSize) && file.byteSize > 0 &&
      Number.isSafeInteger(file.sheetCount) && file.sheetCount > 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256), '按行拆分产物计数或摘要非法');
    const stat = await fs.promises.lstat(part.generationPath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === file.byteSize &&
      await sha256File(part.generationPath) === file.sha256, '按行拆分产物已变化');
    normalizeWarningSummary(file.warningSummary);
    total += file.dataRowCount;
    generatedBytes += file.byteSize;
    artifacts.push(Object.freeze({ sourcePath: part.generationPath, generationPath: part.generationPath,
      outputId: part.outputId, fileName: part.fileName, matchedCount: file.dataRowCount,
      dataRowCount: file.dataRowCount, byteSize: file.byteSize, sha256: file.sha256,
      sheetCount: file.sheetCount, warningSummary: file.warningSummary, styleStats: file.styleStats }));
  }
  assert(total === plan.rowCount, '按行拆分输出总行数不一致');
  assert(generatedBytes <= ROWS_BUDGETS.maxGeneratedBytes, '按行拆分产物超出磁盘预算');
  const warningSummary = aggregateWarnings(artifacts);
  jsonBytes(publicResult(plan, plan.parts.map((part, index) => ({ ...part,
    dataRowCount: artifacts[index].dataRowCount })), warningSummary),
  ROWS_BUDGETS.maxPublicResultBytes - ROWS_BUDGETS.maxWarningBytes, '公开结果');
  // Publisher staging 与旧文件备份也计入临时预算；正式发布前全部完成检查。
  const cacheBytes = fs.statSync(path.join(plan.privateDirectory, 'rows.sqlite')).size;
  let backupBytes = 0;
  for (const part of plan.parts) {
    try { backupBytes += fs.lstatSync(part.filePath).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(cacheBytes + 2 * generatedBytes + backupBytes + 2 * ROWS_BUDGETS.maxManifestBytes <= ROWS_BUDGETS.maxTaskTemporaryBytes,
    '发布暂存与备份超出任务磁盘预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
  assertDiskSpace(plan.privateDirectory, generatedBytes + backupBytes);
  return { artifacts: Object.freeze(artifacts), warningSummary, metrics: manifest.metrics };
}

async function generateValidateAndPublishRows({
  runtime, filePlan, batchContext, counts, privateDirectory, metadataDirectory, publisher
}) {
  assert(runtime && typeof runtime.execute === 'function' && typeof publisher === 'function',
    '按行拆分后台执行环境不可用');
  const checked = planRowCounts(counts.rowCount, counts.rowsPerFile);
  assert(filePlan && filePlan.allocation === 'eager' && filePlan.inputs.length === 1 &&
    filePlan.outputs.length === checked.fileCount, '按行拆分 FilePlan 非法');
  const context = operationContextFromBatch(batchContext);
  const source = filePlan.inputs[0];
  const targets = buildRowTargets(source.filePath, path.dirname(filePlan.outputs[0].filePath), checked);
  const plan = validatePlan({ version: 1, action: ROWS_ACTION, attemptId: randomUUID(),
    taskRunId: context.taskRunId, source: { filePath: source.filePath, sourceSnapshot: source.sourceSnapshot },
    ...checked, privateDirectory: fs.realpathSync(privateDirectory),
    parts: targets.map((target, index) => {
      assert(target.filePath === filePlan.outputs[index].filePath, '输出路径与冻结计划不一致');
      return { ...target, artifactKey: filePlan.outputs[index].artifactKey,
        generationPath: path.join(fs.realpathSync(privateDirectory), String(index + 1).padStart(4, '0') + '.xlsx') };
    }) });
  const planPath = path.join(plan.privateDirectory, 'plan.json');
  const input = { version: 1, planPath, tokenId: plan.attemptId,
    planDescriptor: writePrivateJson(planPath, plan, ROWS_BUDGETS.maxPlanBytes) };
  const execution = await runtime.execute({ actionKey: ROWS_ACTION, operationKey: context.operationKey,
    production: true, context: { kind: 'operation', value: context }, input });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw rowsError('TOOLBOX_ROWS_GENERATION_FAILED', '按行拆分后台生成未完成');
  }
  const validated = await validateRowsManifest(plan, input, execution.result);
  assert(sourceSnapshotMatchesStat(source.sourceSnapshot, fs.statSync(source.filePath, { bigint: true })),
    '拆分源文件在生成后已变化，请重新选择', 'TOOLBOX_SPLIT_READ_CONTEXT_STALE');
  if (metadataDirectory) assertDiskSpace(metadataDirectory, ROWS_BUDGETS.maxManifestBytes);
  const publication = await publisher(validated.artifacts);
  return { ...validated, publication };
}

module.exports = { prepareRows, aggregateWarnings, validateRowsManifest, generateValidateAndPublishRows };
