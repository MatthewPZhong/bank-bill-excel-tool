'use strict';

const path = require('node:path');
const {
  TOOLBOX_PROJECTION_PROFILES,
  normalizeCell,
  openToolboxBiff8Pass,
  openToolboxCsvPass,
  openToolboxXlsxPass,
  projectToolboxRowValues,
  toMatchValue
} = require('../backend/toolbox-format');
const { FileValidationError } = require('../backend/file-service/common');
const { ToolboxHeaderMismatchError } = require('./toolbox');
const { detectToolboxInputKind } = require('./toolbox-input-kind');

const TOOLBOX_SHEET_STRATEGIES = Object.freeze({
  MERGE: 'merge',
  SPLIT: 'split'
});

function isHiddenSheet(sheet) {
  const state = String(sheet && sheet.state ? sheet.state : 'visible').toLowerCase();
  return state === 'hidden' || state === 'veryhidden';
}

function toolboxRowWidth(row) {
  const cells = row && Array.isArray(row.cells) ? row.cells : [];
  if (cells.length === 0) return 0;
  return cells.reduce((max, cell) => (
    cell && Number.isInteger(cell.columnIndex)
      ? Math.max(max, cell.columnIndex + 1)
      : max
  ), 0);
}

function projectToolboxMatchValues(
  row,
  projectionProfile = TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY,
  width = null
) {
  const outputWidth = Number.isInteger(width) && width >= 0 ? width : toolboxRowWidth(row);
  const values = projectToolboxRowValues(row, projectionProfile, outputWidth);
  return values.map((value) => normalizeCell(value));
}

function trimTrailingEmptyMatchValues(values) {
  const result = Array.isArray(values) ? values.slice() : [];
  while (result.length > 0 && normalizeCell(result[result.length - 1]) === '') result.pop();
  return result;
}

function normalizeToolboxHeaderRow(
  row,
  projectionProfile = TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY
) {
  return trimTrailingEmptyMatchValues(projectToolboxMatchValues(row, projectionProfile));
}

function isToolboxRowMeaningful(
  row,
  projectionProfile = TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY
) {
  const cells = row && Array.isArray(row.cells) ? row.cells : [];
  return cells.some((cell) => toMatchValue(cell, projectionProfile) !== '');
}

function createHeaderInfo({ pass, row, sheetMeta, sheet, projectionProfile }) {
  return {
    normalizedHeaders: normalizeToolboxHeaderRow(row, projectionProfile),
    rawHeaderCells: row.cells.slice(),
    headerRow: row,
    sheetMeta,
    sourceRegistry: pass.sourceRegistry,
    sourceRegistryId: pass.sourceRegistryId,
    sourceFile: pass.sourceFile,
    sourceFilePath: pass.filePath,
    sourceSheet: sheet.name,
    sheetIndex: sheet.sheetIndex
  };
}

function assertSplitContinuationWidth(baseHeaderInfo, row, sheet, projectionProfile) {
  const rowHeaders = normalizeToolboxHeaderRow(row, projectionProfile);
  if (rowHeaders.length <= baseHeaderInfo.normalizedHeaders.length) return;
  throw new ToolboxHeaderMismatchError(
    `${baseHeaderInfo.sourceFile}：sheet「${sheet.name}」首行列数（${rowHeaders.length}）多于逻辑表头（${baseHeaderInfo.normalizedHeaders.length}），出现表头之外的额外列，无法作为同一逻辑表的续页`,
    [
      `逻辑表头（${baseHeaderInfo.normalizedHeaders.length} 列）：${baseHeaderInfo.normalizedHeaders.join(' | ') || '（空）'}`,
      `该 sheet 首行（${rowHeaders.length} 列）：${rowHeaders.join(' | ') || '（空）'}`,
      '多 sheet 续页要求每个 sheet 的列结构不超过首个非空 sheet 的表头（不做按列名重排），请确认后重试。'
    ]
  );
}

/**
 * 工具箱工作簿的唯一 Sheet/表头策略层。
 *
 * - merge：跳过 hidden/veryHidden；每个可见非空 Sheet 的首个有意义行独立作为表头。
 * - split：隐藏 Sheet 继续参与；首个非空 Sheet 提供逻辑表头，后续 Sheet 的重复表头跳过，
 *   非重复首行按既有规则作为数据行。
 */
async function streamToolboxPassTables(pass, options = {}) {
  const strategy = options.strategy || TOOLBOX_SHEET_STRATEGIES.SPLIT;
  const projectionProfile = options.projectionProfile || (
    pass && pass.format === 'biff8'
      ? TOOLBOX_PROJECTION_PROFILES.XLS_LEGACY
      : (pass && pass.format === 'csv'
        ? TOOLBOX_PROJECTION_PROFILES.CSV_LEGACY
      : TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY
      )
  );
  const onHeader = typeof options.onHeader === 'function' ? options.onHeader : null;
  const onDataRow = typeof options.onDataRow === 'function' ? options.onDataRow : null;
  const sourceRegistryResolver = options.sourceRegistryResolver || new Map();
  sourceRegistryResolver.set(pass.sourceRegistryId, pass.sourceRegistry);

  let baseHeaderInfo = null;
  let participatingSheetCount = 0;
  let hiddenSheetCount = 0;
  let emptySheetCount = 0;
  let dataRowCount = 0;
  const sheetSummaries = [];

  try {
    for (const sheet of pass.sheets) {
      if (options.cancelToken && options.cancelToken.cancelled) {
        // scanSheet 会抛统一取消错误；在 Sheet 边界也不能把已扫部分当成功。
        const formatLabel = pass.format === 'biff8'
          ? 'BIFF8'
          : (pass.format === 'csv' ? 'CSV' : 'XLSX');
        const error = new Error(`工具箱 ${formatLabel} 处理已取消`);
        error.name = pass.format === 'biff8'
          ? 'ToolboxBiff8CancelledError'
          : (pass.format === 'csv'
            ? 'ToolboxCsvCancelledError'
            : 'ToolboxXlsxCancelledError');
        error.code = pass.format === 'biff8'
          ? 'TOOLBOX_BIFF8_CANCELLED'
          : (pass.format === 'csv'
            ? 'TOOLBOX_CSV_CANCELLED'
            : 'TOOLBOX_XLSX_CANCELLED');
        throw error;
      }
      if (strategy === TOOLBOX_SHEET_STRATEGIES.MERGE && isHiddenSheet(sheet)) {
        hiddenSheetCount += 1;
        continue;
      }

      let sheetHeaderInfo = null;
      let firstMeaningfulSeen = false;
      let meaningfulRowCount = 0;
      let currentSheetMeta = null;
      // eslint-disable-next-line no-await-in-loop
      const physicalSummary = await pass.scanSheet(sheet, {
        cancelToken: options.cancelToken || null,
        onSheetMeta: (sheetMeta) => {
          currentSheetMeta = sheetMeta;
        },
        onRow: (row, sheetMeta) => {
          currentSheetMeta = sheetMeta;
          if (!isToolboxRowMeaningful(row, projectionProfile)) return;
          meaningfulRowCount += 1;

          if (!firstMeaningfulSeen) {
            firstMeaningfulSeen = true;
            const candidate = createHeaderInfo({
              pass,
              row,
              sheetMeta,
              sheet,
              projectionProfile
            });

            if (strategy === TOOLBOX_SHEET_STRATEGIES.MERGE) {
              sheetHeaderInfo = candidate;
              participatingSheetCount += 1;
              if (!baseHeaderInfo) baseHeaderInfo = candidate;
              if (onHeader) onHeader(candidate);
              return;
            }

            if (!baseHeaderInfo) {
              baseHeaderInfo = candidate;
              sheetHeaderInfo = candidate;
              participatingSheetCount += 1;
              if (onHeader) onHeader(candidate);
              return;
            }

            participatingSheetCount += 1;
            const candidateKey = JSON.stringify(candidate.normalizedHeaders);
            const baseKey = JSON.stringify(baseHeaderInfo.normalizedHeaders);
            if (candidateKey === baseKey) {
              sheetHeaderInfo = baseHeaderInfo;
              return;
            }
            assertSplitContinuationWidth(baseHeaderInfo, row, sheet, projectionProfile);
            dataRowCount += 1;
            if (onDataRow) {
              onDataRow(row, {
                headerInfo: baseHeaderInfo,
                sheetMeta,
                sheet,
                matchValues: projectToolboxMatchValues(
                  row,
                  projectionProfile,
                  baseHeaderInfo.normalizedHeaders.length
                )
              });
            }
            return;
          }

          dataRowCount += 1;
          if (onDataRow) {
            onDataRow(row, {
              headerInfo: strategy === TOOLBOX_SHEET_STRATEGIES.MERGE
                ? sheetHeaderInfo
                : baseHeaderInfo,
              sheetMeta,
              sheet,
              matchValues: projectToolboxMatchValues(
                row,
                projectionProfile,
                (strategy === TOOLBOX_SHEET_STRATEGIES.MERGE
                  ? sheetHeaderInfo
                  : baseHeaderInfo).normalizedHeaders.length
              )
            });
          }
        }
      });

      if (!firstMeaningfulSeen) emptySheetCount += 1;
      sheetSummaries.push({
        sheetName: sheet.name,
        sheetIndex: sheet.sheetIndex,
        sheetMeta: currentSheetMeta,
        meaningfulRowCount,
        ...physicalSummary
      });
    }
  } finally {
    pass.close();
  }

  if (!baseHeaderInfo) {
    const sourceFile = path.basename(pass.filePath);
    const message = strategy === TOOLBOX_SHEET_STRATEGIES.MERGE
      ? `文件「${sourceFile}」没有可合并的可见非空工作表`
      : '文件为空或不可读，请重新导入';
    throw new FileValidationError(
      strategy === TOOLBOX_SHEET_STRATEGIES.MERGE
        ? 'TOOLBOX_MERGE_NO_VISIBLE_SHEET'
        : 'TOOLBOX_SPLIT_EMPTY',
      message,
      {
        detailLines: strategy === TOOLBOX_SHEET_STRATEGIES.MERGE
          ? [`文件：${sourceFile}`, '隐藏、深度隐藏和完全空白的工作表不会参与合并，请确认文件内容后重试。']
          : []
      }
    );
  }

  return {
    strategy,
    baseHeaderInfo,
    normalizedHeaders: baseHeaderInfo.normalizedHeaders.slice(),
    sourceRegistryResolver,
    participatingSheetCount,
    hiddenSheetCount,
    emptySheetCount,
    dataRowCount,
    sheetSummaries
  };
}

async function streamToolboxXlsxTables(filePath, options = {}) {
  const pass = await openToolboxXlsxPass(filePath);
  return streamToolboxPassTables(pass, {
    ...options,
    projectionProfile: options.projectionProfile || TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY
  });
}

async function streamToolboxBiff8Tables(filePath, options = {}) {
  const pass = await openToolboxBiff8Pass(filePath);
  return streamToolboxPassTables(pass, {
    ...options,
    projectionProfile: options.projectionProfile || TOOLBOX_PROJECTION_PROFILES.XLS_LEGACY
  });
}

async function streamToolboxCsvTables(filePath, options = {}) {
  const pass = await openToolboxCsvPass(filePath);
  return streamToolboxPassTables(pass, {
    ...options,
    projectionProfile: options.projectionProfile || TOOLBOX_PROJECTION_PROFILES.CSV_LEGACY
  });
}

async function streamToolboxTables(filePath, options = {}) {
  const kind = detectToolboxInputKind(filePath);
  if (kind === 'xlsx') return streamToolboxXlsxTables(filePath, options);
  if (kind === 'xls') return streamToolboxBiff8Tables(filePath, options);
  return streamToolboxCsvTables(filePath, options);
}

module.exports = {
  TOOLBOX_SHEET_STRATEGIES,
  assertSplitContinuationWidth,
  createHeaderInfo,
  isHiddenSheet,
  isToolboxRowMeaningful,
  normalizeToolboxHeaderRow,
  projectToolboxMatchValues,
  streamToolboxBiff8Tables,
  streamToolboxCsvTables,
  streamToolboxPassTables,
  streamToolboxTables,
  streamToolboxXlsxTables,
  toolboxRowWidth,
  trimTrailingEmptyMatchValues
};
