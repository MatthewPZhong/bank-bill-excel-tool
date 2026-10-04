'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createToolboxOutputWriter } = require('../toolbox-output-writer');
const { ROWS_ACTION, ROWS_BUDGETS, assert, exactKeys, validatePlan, readPrivateJson, writePrivateJson, jsonBytes } = require('./contracts');
const { createSealedCache, openSealedCache, checkCancelled, checkResources } = require('./cache');
const { validateExecutionMemoryConfig } = require('../background-execution/execution-memory-config');

async function executeRowsGeneration(input, signal, options = {}) {
  const memoryConfig = options.memoryConfig ? validateExecutionMemoryConfig(options.memoryConfig) : null;
  exactKeys(input, ['version', 'planPath', 'planDescriptor', 'tokenId']);
  exactKeys(input.planDescriptor, ['byteSize', 'sha256']);
  assert(input.version === 1 && path.isAbsolute(input.planPath), '按行拆分任务消息非法');
  const plan = validatePlan(readPrivateJson(input.planPath, input.planDescriptor, ROWS_BUDGETS.maxPlanBytes));
  assert(plan.attemptId === input.tokenId && input.planPath === path.join(plan.privateDirectory, 'plan.json'), '按行拆分任务归属非法');
  checkCancelled(signal);
  let peakWorkerMemoryBytes = 0;
  const observeMemory = (memory) => {
    peakWorkerMemoryBytes = Math.max(peakWorkerMemoryBytes, memory.heapUsed + memory.external);
  };
  const observeResources = (cacheBytes, generatedBytes) => {
    observeMemory(checkResources(plan.privateDirectory, cacheBytes, generatedBytes, memoryConfig));
  };
  const cached = await createSealedCache(plan, signal, observeMemory, options.pollCommands, memoryConfig);
  if (options.afterCache) await options.afterCache(plan, cached);
  const { seal, reader } = openSealedCache(plan, cached.descriptor, memoryConfig);
  let active = null;
  const files = [];
  let generatedBytes = 0;
  const startedAt = Date.now();
  try {
    for (const part of plan.parts) {
      checkCancelled(signal);
      observeResources(seal.byteSize, generatedBytes);
      assert(!fs.existsSync(part.generationPath), '生成路径已存在');
      if (options.onWriterEvent) options.onWriterEvent('create', part.partIndex);
      active = (options.writerFactory || createToolboxOutputWriter)({
        savePath: part.generationPath, outputId: part.outputId,
        normalizedHeaders: reader.header.normalizedHeaders,
        rawHeaderCells: reader.header.rawHeaderCells, headerRow: reader.header.headerRow,
        layoutBaseline: reader.header.sheetMeta, sourceRegistryResolver: reader.resolver,
        memoryConfig, privateDirectory: plan.privateDirectory, boundedOutput: true,
        ...(options.maxRowsPerSheet ? { maxRowsPerSheet: options.maxRowsPerSheet } : {})
      });
      let rowsWritten = 0;
      let pendingBytes = 0;
      for (const row of reader.readRange(part.startRowSeq, part.endRowSeq, (size) => { pendingBytes += size; })) {
        checkCancelled(signal);
        // 真正等待 worksheet → ZIP → 输出流的消费边界；同步测试 writer 显式兼容。
        // eslint-disable-next-line no-await-in-loop
        if (active.emitRowAsync) await active.emitRowAsync(row); else active.emitRow(row);
        rowsWritten += 1;
        if (rowsWritten % 128 === 0 || pendingBytes >= 1024 ** 2) {
          if (options.pollCommands) options.pollCommands();
          pendingBytes = 0;
          const currentBytes = fs.existsSync(part.generationPath) ? fs.statSync(part.generationPath).size : 0;
          observeResources(seal.byteSize, generatedBytes + currentBytes);
        }
      }
      if (options.onWriterEvent) options.onWriterEvent('commit', part.partIndex);
      // eslint-disable-next-line no-await-in-loop
      const artifact = await active.commitAndValidate();
      assert(artifact.dataRowCount === part.endRowSeq - part.startRowSeq, '分块数据行数不一致');
      // eslint-disable-next-line no-await-in-loop
      await active.release();
      active = null;
      if (options.onWriterEvent) options.onWriterEvent('release', part.partIndex);
      generatedBytes += artifact.byteSize;
      observeResources(seal.byteSize, generatedBytes);
      files.push({ ...part, dataRowCount: artifact.dataRowCount, byteSize: artifact.byteSize,
        sha256: artifact.sha256, sheetCount: artifact.sheetCount,
        warningSummary: artifact.warningSummary, styleStats: artifact.styleStats });
      jsonBytes(files, ROWS_BUDGETS.maxManifestBytes - ROWS_BUDGETS.maxPlanBytes / 4, '产物清单');
    }
    checkCancelled(signal);
    assert(files.length === plan.fileCount && files.reduce((n, file) => n + file.dataRowCount, 0) === plan.rowCount, '输出汇总行数不一致');
    const manifest = { version: 1, actionKey: ROWS_ACTION, attemptId: plan.attemptId,
      taskRunId: plan.taskRunId, outputPlanHash: input.planDescriptor.sha256,
      rowCount: plan.rowCount, rowsPerFile: plan.rowsPerFile, fileCount: plan.fileCount,
      files, metrics: { cacheBytes: seal.byteSize, generatedBytes, maxActiveWriters: 1,
        peakWorkerMemoryBytes, generationMs: Date.now() - startedAt } };
    const descriptor = writePrivateJson(path.join(plan.privateDirectory, 'outputs.json'), manifest, ROWS_BUDGETS.maxManifestBytes);
    return { version: 1, actionKey: ROWS_ACTION, tokenId: plan.attemptId,
      outputPlanHash: input.planDescriptor.sha256, manifest: descriptor };
  } catch (error) {
    if (active) {
      try { await active.abort(); } catch (cleanupError) {
        error.detailLines = [...(error.detailLines || []), `清理失败：${cleanupError.message}`];
        error.preserveTemporaryFiles = true;
      }
    }
    throw error;
  } finally { reader.close(); }
}

module.exports = { executeRowsGeneration };
