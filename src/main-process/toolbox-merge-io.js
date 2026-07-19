'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  FileValidationError,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
} = require('../backend/file-service/common');
const {
  ensureSupportedFile,
  isMemoryLimitError,
  readRows
} = require('../backend/file-service/readers');
const {
  streamStrictWorkbookSheetTables,
  ToolboxSheetReadError
} = require('../backend/toolbox-xlsx-stream/multi-sheet-reader');
const { ToolboxHeaderMismatchError } = require('./toolbox');
const { createRowsStreamWriter } = require('./toolbox-stream-io');

class ToolboxMergePublishError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxMergePublishError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

function readFileMagic(filePath) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function detectMergeInputKind(filePath) {
  ensureSupportedFile(filePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const magic = readFileMagic(filePath);
  const isOle2 = magic.length >= 4
    && magic[0] === 0xd0 && magic[1] === 0xcf && magic[2] === 0x11 && magic[3] === 0xe0;
  const isZip = magic.length >= 4
    && magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
  if (isZip) return 'xlsx';
  if (isOle2) return 'xls';

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv') return 'csv';
  return extension === '.xlsx' ? 'xlsx' : 'xls';
}

function normalizeHeaderRow(row) {
  return trimTrailingEmptyCells(Array.isArray(row) ? row : [])
    .map((cell) => normalizeCell(cell));
}

function sheetSourceLabel({ sourceFile, sheetName }) {
  return `文件「${sourceFile}」/ sheet「${sheetName}」`;
}

function assertMergeHeadersIdentical(base, current) {
  const baseHeaders = Array.isArray(base && base.headers) ? base.headers : [];
  const currentHeaders = Array.isArray(current && current.headers) ? current.headers : [];
  if (JSON.stringify(baseHeaders) === JSON.stringify(currentHeaders)) return;

  const baseLabel = sheetSourceLabel(base);
  const currentLabel = sheetSourceLabel(current);
  throw new ToolboxHeaderMismatchError(
    `${currentLabel} 的表头与 ${baseLabel} 不一致，无法合并`,
    [
      `基准 ${baseLabel}：${baseHeaders.join(' | ') || '（空）'}`,
      `异常 ${currentLabel}：${currentHeaders.join(' | ') || '（空）'}`,
      '合并要求每个可见非空 sheet 的表头完全一致（列名 + 列序 + 大小写），请确认后重试。'
    ]
  );
}

function workbookSheetHidden(workbook, sheetIndex) {
  const sheetsMeta = workbook && workbook.Workbook && Array.isArray(workbook.Workbook.Sheets)
    ? workbook.Workbook.Sheets
    : [];
  const hidden = sheetsMeta[sheetIndex] && sheetsMeta[sheetIndex].Hidden;
  return Number(hidden || 0) !== 0;
}

function streamLegacyWorkbookSheetTables(filePath, options = {}) {
  const onSheetHeader = typeof options.onSheetHeader === 'function' ? options.onSheetHeader : null;
  const onDataRow = typeof options.onDataRow === 'function' ? options.onDataRow : null;
  const sourceFile = path.basename(filePath);
  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: false, dense: true, raw: false });
  } catch (error) {
    if (isMemoryLimitError(error)) {
      throw new FileValidationError('FILE_READ', '文件过大，超出处理能力，请拆分后再试');
    }
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  let visibleSheetCount = 0;
  let hiddenSheetCount = 0;
  let nonEmptySheetCount = 0;
  let emptySheetCount = 0;
  let dataRowCount = 0;

  for (let s = 0; s < sheetNames.length; s += 1) {
    const sheetName = sheetNames[s] || `(未命名 sheet ${s + 1})`;
    if (workbookSheetHidden(workbook, s)) {
      hiddenSheetCount += 1;
      continue;
    }
    visibleSheetCount += 1;

    const sheet = workbook.Sheets[sheetNames[s]];
    if (!sheet) {
      throw new ToolboxSheetReadError(
        `文件「${sourceFile}」的工作表「${sheetName}」无法读取`,
        [`文件：${sourceFile}`, `工作表：${sheetName}`, '工作簿中的工作表内容缺失，请修复文件后重试。']
      );
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    const headerIndex = rows.findIndex((row) => isRowMeaningful(row));
    if (headerIndex < 0) {
      emptySheetCount += 1;
      continue;
    }

    nonEmptySheetCount += 1;
    if (onSheetHeader) {
      onSheetHeader({
        headers: normalizeHeaderRow(rows[headerIndex]),
        sourceFile,
        sheetName,
        sheetIndex: s,
        rowNumber: headerIndex + 1
      });
    }
    for (let r = headerIndex + 1; r < rows.length; r += 1) {
      dataRowCount += 1;
      if (onDataRow) {
        onDataRow(Array.isArray(rows[r]) ? rows[r] : [], {
          sourceFile,
          sheetName,
          sheetIndex: s,
          rowNumber: r + 1
        });
      }
    }
  }

  return {
    physicalSheetCount: sheetNames.length,
    visibleSheetCount,
    hiddenSheetCount,
    nonEmptySheetCount,
    emptySheetCount,
    dataRowCount,
    cancelled: false
  };
}

function streamCsvTable(filePath, options = {}) {
  const onSheetHeader = typeof options.onSheetHeader === 'function' ? options.onSheetHeader : null;
  const onDataRow = typeof options.onDataRow === 'function' ? options.onDataRow : null;
  const sourceFile = path.basename(filePath);
  const rows = readRows(filePath);
  const headerIndex = rows.findIndex((row) => isRowMeaningful(row));
  if (headerIndex < 0) {
    return {
      physicalSheetCount: 1,
      visibleSheetCount: 1,
      hiddenSheetCount: 0,
      nonEmptySheetCount: 0,
      emptySheetCount: 1,
      dataRowCount: 0,
      cancelled: false
    };
  }

  if (onSheetHeader) {
    onSheetHeader({
      headers: normalizeHeaderRow(rows[headerIndex]),
      sourceFile,
      sheetName: 'CSV',
      sheetIndex: 0,
      rowNumber: headerIndex + 1
    });
  }
  let dataRowCount = 0;
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    dataRowCount += 1;
    if (onDataRow) {
      onDataRow(Array.isArray(rows[r]) ? rows[r] : [], {
        sourceFile,
        sheetName: 'CSV',
        sheetIndex: 0,
        rowNumber: r + 1
      });
    }
  }
  return {
    physicalSheetCount: 1,
    visibleSheetCount: 1,
    hiddenSheetCount: 0,
    nonEmptySheetCount: 1,
    emptySheetCount: 0,
    dataRowCount,
    cancelled: false
  };
}

async function streamMergeInputFile(filePath, options = {}) {
  const kind = detectMergeInputKind(filePath);
  if (kind === 'xlsx') {
    return streamStrictWorkbookSheetTables(filePath, options);
  }
  if (kind === 'xls') {
    return streamLegacyWorkbookSheetTables(filePath, options);
  }
  return streamCsvTable(filePath, options);
}

async function mergeToolboxFilesToXlsx({
  filePaths,
  savePath,
  sheetBaseName = 'COMMON',
  maxRowsPerSheet,
  writerFactory = createRowsStreamWriter
}) {
  const sources = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (sources.length === 0) {
    throw new FileValidationError('TOOLBOX_MERGE_INPUT', '未选择任何文件，无法合并');
  }
  if (!savePath) {
    throw new FileValidationError('TOOLBOX_MERGE_OUTPUT', '未提供合并文件保存路径');
  }

  let baseHeader = null;
  let streamWriter = null;
  let inputSheetCount = 0;
  let skippedHiddenSheetCount = 0;
  let skippedEmptySheetCount = 0;
  const fileSummaries = [];

  const onSheetHeader = (headerInfo) => {
    if (baseHeader === null) {
      baseHeader = { ...headerInfo, headers: headerInfo.headers.slice() };
      streamWriter = writerFactory({
        savePath,
        normalizedHeaders: baseHeader.headers,
        sheetBaseName,
        maxRowsPerSheet
      });
    } else {
      assertMergeHeadersIdentical(baseHeader, headerInfo);
    }
    inputSheetCount += 1;
  };

  const onDataRow = (cells) => {
    if (!streamWriter) {
      throw new Error('工具箱合并输出尚未初始化');
    }
    streamWriter.emit(cells);
  };

  try {
    for (const filePath of sources) {
      // eslint-disable-next-line no-await-in-loop
      const summary = await streamMergeInputFile(filePath, { onSheetHeader, onDataRow });
      if (!summary || summary.nonEmptySheetCount === 0) {
        const sourceFile = path.basename(filePath);
        throw new FileValidationError(
          'TOOLBOX_MERGE_NO_VISIBLE_SHEET',
          `文件「${sourceFile}」没有可合并的可见非空工作表`,
          {
            detailLines: [
              `文件：${sourceFile}`,
              '隐藏、深度隐藏和完全空白的工作表不会参与合并，请确认文件内容后重试。'
            ]
          }
        );
      }
      skippedHiddenSheetCount += summary.hiddenSheetCount || 0;
      skippedEmptySheetCount += summary.emptySheetCount || 0;
      fileSummaries.push({ filePath, ...summary });
    }

    if (!streamWriter || baseHeader === null) {
      throw new FileValidationError('TOOLBOX_MERGE_EMPTY', '没有找到可合并的数据，请重新选择文件');
    }
    const result = await streamWriter.commit();
    return {
      ...result,
      fileCount: sources.length,
      inputSheetCount,
      skippedHiddenSheetCount,
      skippedEmptySheetCount,
      baseHeaders: baseHeader.headers.slice(),
      fileSummaries
    };
  } catch (error) {
    if (streamWriter) {
      try {
        await streamWriter.abort();
      } catch (cleanupError) {
        const finalError = error && typeof error === 'object' ? error : new Error(String(error));
        finalError.detailLines = [
          ...(Array.isArray(finalError.detailLines) ? finalError.detailLines : []),
          cleanupError.message || String(cleanupError)
        ];
        throw finalError;
      }
    }
    throw error;
  }
}

function publishMergedWorkbook(sourcePath, targetPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const nonce = options.nonce || `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const targetDir = path.dirname(targetPath);
  const stagedPath = path.join(targetDir, `.toolbox-merge-${nonce}.tmp`);
  const backupPath = path.join(targetDir, `.toolbox-merge-${nonce}.bak`);
  const cleanupErrors = [];
  let backupCreated = false;

  try {
    if (!sourcePath || !fsImpl.existsSync(sourcePath) || !fsImpl.lstatSync(sourcePath).isFile()) {
      throw new Error('合并临时产物不存在或不是普通文件');
    }
    if (fsImpl.existsSync(targetPath) && !fsImpl.lstatSync(targetPath).isFile()) {
      throw new Error('目标路径不是可覆盖的普通文件');
    }

    fsImpl.copyFileSync(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
    if (fsImpl.existsSync(targetPath)) {
      fsImpl.renameSync(targetPath, backupPath);
      backupCreated = true;
    }
    fsImpl.renameSync(stagedPath, targetPath);
  } catch (error) {
    try {
      if (fsImpl.existsSync(stagedPath)) fsImpl.rmSync(stagedPath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(`删除发布暂存文件失败：${stagedPath}（${cleanupError.message || cleanupError}）`);
    }

    if (backupCreated) {
      try {
        if (fsImpl.existsSync(targetPath)) fsImpl.rmSync(targetPath, { force: true });
        if (fsImpl.existsSync(backupPath)) fsImpl.renameSync(backupPath, targetPath);
      } catch (restoreError) {
        cleanupErrors.push(`恢复原文件失败：${targetPath}（${restoreError.message || restoreError}）`);
        if (fsImpl.existsSync(backupPath)) {
          cleanupErrors.push(`原文件备份保留于：${backupPath}`);
        }
      }
    }

    throw new ToolboxMergePublishError(
      cleanupErrors.length === 0 ? '合并文件发布失败，未修改原文件' : '合并文件发布失败，清理或恢复不完整',
      [`原始错误：${error && error.message ? error.message : String(error)}`, ...cleanupErrors]
    );
  }

  const warnings = [];
  if (backupCreated) {
    try {
      fsImpl.rmSync(backupPath, { force: true });
    } catch (error) {
      warnings.push(`新文件已导出，但旧文件备份未能删除：${backupPath}（${error.message || error}）`);
    }
  }
  return { filePath: targetPath, warnings };
}

module.exports = {
  assertMergeHeadersIdentical,
  detectMergeInputKind,
  mergeToolboxFilesToXlsx,
  normalizeHeaderRow,
  publishMergedWorkbook,
  streamCsvTable,
  streamLegacyWorkbookSheetTables,
  streamMergeInputFile,
  workbookSheetHidden,
  ToolboxMergePublishError
};
