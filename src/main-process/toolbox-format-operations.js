'use strict';

const path = require('node:path');
const { createBoundedValuesAccumulator } = require(
  '../backend/toolbox-xlsx-stream/bounded-values-accumulator'
);
const {
  createRowFilter,
  createValuesByFieldAccumulator
} = require('./toolbox');
const {
  TOOLBOX_SHEET_STRATEGIES,
  streamToolboxTables
} = require('./toolbox-format-io');
const { createToolboxOutputWriter } = require('./toolbox-output-writer');

class ToolboxStreamEmptyError extends Error {
  constructor(message = '文件为空或不可读，请重新导入') {
    super(message);
    this.name = 'ToolboxStreamEmptyError';
  }
}

class ToolboxSplitFieldNotFoundError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxSplitFieldNotFoundError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

class ToolboxSplitDuplicateHeaderError extends Error {
  constructor(duplicates) {
    const safeDuplicates = Array.isArray(duplicates) ? duplicates : [];
    super('源文件存在重复表头，无法安全按字段拆分');
    this.name = 'ToolboxSplitDuplicateHeaderError';
    this.detailLines = [
      `重复字段：${safeDuplicates.map((field) => `「${field || '（空字段）'}」`).join('、')}`,
      '字段扫描和导出必须定位到同一列；请先把重复列名改成唯一名称后重试。'
    ];
  }
}

function assertUniqueSplitHeaders(normalizedHeaders) {
  const headers = Array.isArray(normalizedHeaders) ? normalizedHeaders : [];
  const seen = new Set();
  const duplicates = [];
  const duplicateSet = new Set();
  for (const header of headers) {
    if (seen.has(header) && !duplicateSet.has(header)) {
      duplicateSet.add(header);
      duplicates.push(header);
    }
    seen.add(header);
  }
  if (duplicates.length > 0) throw new ToolboxSplitDuplicateHeaderError(duplicates);
  return headers;
}

function normalizeSplitEmptyError(error) {
  if (error && error.code === 'TOOLBOX_SPLIT_EMPTY') {
    return new ToolboxStreamEmptyError();
  }
  return error;
}

function createSplitFilter(normalizedHeaders, field, values, detailPrefix = []) {
  const filter = createRowFilter(normalizedHeaders, field, values);
  if (filter.fieldFound) return filter;
  throw new ToolboxSplitFieldNotFoundError(
    `源文件中找不到字段「${field}」`,
    [
      ...detailPrefix,
      `表头（${normalizedHeaders.length} 列）：${normalizedHeaders.join(' | ') || '（空）'}`,
      `请求拆分字段：${field}`,
      '请确认字段名后重试。'
    ]
  );
}

async function abortWriters(writers, originalError) {
  const cleanupErrors = [];
  for (const writer of writers) {
    if (!writer || typeof writer.abort !== 'function') continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await writer.abort();
    } catch (error) {
      cleanupErrors.push(error && error.message ? error.message : String(error));
    }
  }
  if (cleanupErrors.length === 0) throw originalError;
  const finalError = originalError && typeof originalError === 'object'
    ? originalError
    : new Error(String(originalError));
  finalError.detailLines = [
    ...(Array.isArray(finalError.detailLines) ? finalError.detailLines : []),
    ...cleanupErrors.map((message) => `清理工具箱临时产物失败：${message}`)
  ];
  finalError.preserveTemporaryFiles = true;
  throw finalError;
}

async function scanToolboxSplitFields(filePath, cancelToken = null, options = {}) {
  let accumulator = null;
  let headers = null;
  try {
    await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      cancelToken,
      onHeader: (headerInfo) => {
        headers = headerInfo.normalizedHeaders.slice();
        assertUniqueSplitHeaders(headers);
        if (options.boundedValues === true) {
          accumulator = createBoundedValuesAccumulator(options.accumulatorOptions);
          accumulator.setHeaders(headers);
        } else {
          // 普通路径保持 3.1.1 既有无界下拉值契约；仅隔离 Worker 使用有界累加器。
          accumulator = createValuesByFieldAccumulator(headers);
        }
      },
      onDataRow: (_row, rowInfo) => {
        accumulator.addRow(rowInfo.matchValues);
      }
    });
  } catch (error) {
    throw normalizeSplitEmptyError(error);
  }
  return {
    headers,
    valuesByField: accumulator.result()
  };
}

async function peekToolboxSplitHeaders(filePath, cancelToken = null) {
  const stop = new Error('__toolbox_format_header_ready__');
  stop.__toolboxHeaderReady = true;
  let headers = null;
  try {
    await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      cancelToken,
      onHeader: (headerInfo) => {
        headers = headerInfo.normalizedHeaders.slice();
        assertUniqueSplitHeaders(headers);
        throw stop;
      }
    });
  } catch (error) {
    if (error !== stop && !error.__toolboxHeaderReady) {
      throw normalizeSplitEmptyError(error);
    }
  }
  if (!headers) throw new ToolboxStreamEmptyError();
  return headers;
}

function createWriterFromHeader({
  headerInfo,
  savePath,
  outputId,
  sourceRegistryResolver,
  maxRowsPerSheet,
  budgets,
  sheetBaseName = 'COMMON'
}) {
  return createToolboxOutputWriter({
    savePath,
    outputId,
    normalizedHeaders: headerInfo.normalizedHeaders,
    rawHeaderCells: headerInfo.rawHeaderCells,
    headerRow: headerInfo.headerRow,
    layoutBaseline: headerInfo.sheetMeta,
    sourceRegistryResolver,
    sheetBaseName,
    ...(budgets ? { budgets } : {}),
    ...(typeof maxRowsPerSheet === 'number' ? { maxRowsPerSheet } : {})
  });
}

async function exportToolboxFilter({
  filePath,
  field,
  values,
  savePath,
  cancelToken = null,
  maxRowsPerSheet,
  budgets,
  outputId = 'split-1'
}) {
  const sourceRegistryResolver = new Map();
  let writer = null;
  let filter = null;
  let streamSummary = null;
  try {
    streamSummary = await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      cancelToken,
      sourceRegistryResolver,
      onHeader: (headerInfo) => {
        assertUniqueSplitHeaders(headerInfo.normalizedHeaders);
        filter = createSplitFilter(headerInfo.normalizedHeaders, field, values);
        writer = createWriterFromHeader({
          headerInfo,
          savePath,
          outputId,
          sourceRegistryResolver,
          maxRowsPerSheet,
          budgets
        });
      },
      onDataRow: (row, rowInfo) => {
        if (filter.matches(rowInfo.matchValues)) writer.emitRow(row);
      }
    });
    if (!writer) throw new ToolboxStreamEmptyError();
    const artifact = await writer.commitAndValidate();
    return {
      ...artifact,
      savePath,
      matchedCount: artifact.dataRowCount,
      inputDataRowCount: Number(streamSummary && streamSummary.dataRowCount) || 0
    };
  } catch (error) {
    const normalizedError = normalizeSplitEmptyError(error);
    if (writer) await abortWriters([writer], normalizedError);
    throw normalizedError;
  }
}

async function exportToolboxMultiFilters({
  filePath,
  groups,
  cancelToken = null,
  maxRowsPerSheet,
  budgets
}) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  if (safeGroups.length === 0) throw new Error('未提供多文件拆分分组');

  const sourceRegistryResolver = new Map();
  const writers = [];
  let outputs = null;
  let streamSummary = null;
  try {
    streamSummary = await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      cancelToken,
      sourceRegistryResolver,
      onHeader: (headerInfo) => {
        assertUniqueSplitHeaders(headerInfo.normalizedHeaders);
        outputs = safeGroups.map((group, index) => {
          const outputId = group.outputId || `split-${index + 1}`;
          const filter = createSplitFilter(
            headerInfo.normalizedHeaders,
            group.field,
            group.values,
            [`文件${index + 1}：${group.fileName || path.basename(group.savePath || '')}`]
          );
          const writer = createWriterFromHeader({
            headerInfo,
            savePath: group.savePath,
            outputId,
            sourceRegistryResolver,
            maxRowsPerSheet,
            budgets
          });
          writers.push(writer);
          return { group, filter, writer, outputId };
        });
      },
      onDataRow: (row, rowInfo) => {
        for (const output of outputs) {
          if (output.filter.matches(rowInfo.matchValues)) output.writer.emitRow(row);
        }
      }
    });
    if (!outputs) throw new ToolboxStreamEmptyError();

    const files = [];
    for (const output of outputs) {
      // 顺序提交；任一 validate 失败后，下方 abort 会删除此前已提交的 generation 文件。
      // eslint-disable-next-line no-await-in-loop
      const artifact = await output.writer.commitAndValidate();
      files.push({
        ...artifact,
        outputId: output.outputId,
        savePath: output.group.savePath,
        fileName: output.group.fileName || path.basename(output.group.savePath || ''),
        matchedCount: artifact.dataRowCount
      });
    }
    return {
      files,
      inputDataRowCount: Number(streamSummary && streamSummary.dataRowCount) || 0
    };
  } catch (error) {
    const normalizedError = normalizeSplitEmptyError(error);
    if (writers.length > 0) await abortWriters(writers, normalizedError);
    throw normalizedError;
  }
}

module.exports = {
  ToolboxSplitDuplicateHeaderError,
  ToolboxSplitFieldNotFoundError,
  ToolboxStreamEmptyError,
  abortWriters,
  assertUniqueSplitHeaders,
  createSplitFilter,
  exportToolboxFilter,
  exportToolboxMultiFilters,
  normalizeSplitEmptyError,
  peekToolboxSplitHeaders,
  scanToolboxSplitFields
};
