'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FileValidationError } = require('../file-service/common');
const { readRows } = require('../file-service/readers');
const {
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta
} = require('./model');
const { SourceStyleRegistry } = require('./style-registry');

const CSV_SHEET_NAME = 'CSV';
const FILE_READ_MESSAGE = '文件为空或不可读，请重新导入';

class ToolboxCsvCancelledError extends Error {
  constructor(message = '工具箱 CSV 读取已取消') {
    super(message);
    this.name = 'ToolboxCsvCancelledError';
    this.code = 'TOOLBOX_CSV_CANCELLED';
  }
}

function hasExcelContainerMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return (
    buffer[0] === 0xD0 &&
    buffer[1] === 0xCF &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xE0
  ) || (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4B &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

function readLegacyCsvRowsAllowEmpty(filePath) {
  try {
    return readRows(filePath);
  } catch (error) {
    const isLegacyEmptyError = error instanceof FileValidationError &&
      error.code === 'FILE_READ' &&
      error.message === FILE_READ_MESSAGE;
    if (!isLegacyEmptyError) throw error;

    let raw;
    try {
      raw = fs.readFileSync(filePath);
    } catch (_readError) {
      // 文件缺失、目录或权限错误继续保持 readers.js 的既有对外错误。
      throw error;
    }
    if (hasExcelContainerMagic(raw)) {
      // 伪装扩展名由上层 magic 路由处理；损坏容器不能被误报成空 CSV。
      throw error;
    }

    // 既有 CSV parser 对可读纯文本没有格式拒绝分支；此处唯一差异是允许无有意义行的表进入统一策略层。
    return [];
  }
}

function assertNotCancelled(cancelToken) {
  if (cancelToken && cancelToken.cancelled) {
    throw new ToolboxCsvCancelledError();
  }
}

function assertSynchronousCallback(result, callbackName) {
  if (result && typeof result.then === 'function') {
    throw new TypeError(`ToolboxCsvPass 的 ${callbackName} 必须是同步回调`);
  }
}

class ToolboxCsvPass {
  constructor({ filePath, rows, sourceRegistry }) {
    this.filePath = filePath;
    this.sourceFile = path.basename(filePath);
    this.format = 'csv';
    this.rows = rows;
    this.sourceRegistry = sourceRegistry;
    this.sourceRegistryId = sourceRegistry.sourceRegistryId;
    this.closed = false;
    this.scanActive = false;
    this.sheets = Object.freeze([
      Object.freeze({
        name: CSV_SHEET_NAME,
        state: 'visible',
        sheetIndex: 0,
        type: 'worksheet'
      })
    ]);
  }

  getSourceRegistry(sourceRegistryId = this.sourceRegistryId) {
    return sourceRegistryId === this.sourceRegistryId ? this.sourceRegistry : null;
  }

  _resolveSheet(sheetOrIndex) {
    if (Number.isInteger(sheetOrIndex)) return this.sheets[sheetOrIndex] || null;
    if (sheetOrIndex && this.sheets.includes(sheetOrIndex)) return sheetOrIndex;
    if (sheetOrIndex && Number.isInteger(sheetOrIndex.sheetIndex)) {
      return this.sheets[sheetOrIndex.sheetIndex] || null;
    }
    return null;
  }

  async scanSheet(sheetOrIndex, options = {}) {
    if (this.closed) throw new Error('ToolboxCsvPass 已关闭');
    if (this.scanActive) throw new Error('同一 ToolboxCsvPass 不允许并发扫描多个 Sheet');
    const sheet = this._resolveSheet(sheetOrIndex);
    if (!sheet) throw new RangeError('未找到指定 CSV Sheet');
    assertNotCancelled(options.cancelToken);

    this.scanActive = true;
    try {
      const defaultStyleRef = this.sourceRegistry.compoundRef(
        this.sourceRegistry.defaultStyleRef
      );
      const sheetMeta = createToolboxSheetMeta({
        name: sheet.name,
        sheetIndex: sheet.sheetIndex,
        state: sheet.state,
        date1904: false,
        columns: [],
        sourceRegistryId: this.sourceRegistryId,
        sourceFile: this.filePath,
        themeColors: {}
      });
      if (typeof options.onSheetMeta === 'function') {
        const result = options.onSheetMeta(sheetMeta);
        assertSynchronousCallback(result, 'onSheetMeta');
      }
      assertNotCancelled(options.cancelToken);

      let explicitCellCount = 0;
      let maxColumnIndex = -1;
      for (let rowOffset = 0; rowOffset < this.rows.length; rowOffset += 1) {
        assertNotCancelled(options.cancelToken);
        const legacyRow = Array.isArray(this.rows[rowOffset]) ? this.rows[rowOffset] : [];
        const cells = legacyRow.map((value, columnIndex) => {
          const lexicalValue = value == null ? '' : String(value);
          explicitCellCount += 1;
          maxColumnIndex = Math.max(maxColumnIndex, columnIndex);
          return createToolboxCell({
            rawLexicalValue: lexicalValue,
            cachedValue: lexicalValue,
            cellType: 'text',
            decodedSemanticValue: lexicalValue,
            matchProjectionValue: lexicalValue,
            sourceStyleId: null,
            effectiveStyleRef: defaultStyleRef,
            isExplicitCell: true,
            sourceDateSystem: 1900,
            sourceFormat: 'General',
            sourceFile: this.filePath,
            sourceSheet: sheet.name,
            rowIndex: rowOffset + 1,
            columnIndex
          });
        });
        const row = createToolboxRow({
          cells,
          rowIndex: rowOffset + 1,
          height: null,
          hidden: false,
          outlineLevel: 0,
          sourceStyleId: null,
          effectiveStyleRef: defaultStyleRef,
          customFormat: false,
          sourceFile: this.filePath,
          sourceSheet: sheet.name
        });
        if (typeof options.onRow === 'function') {
          const result = options.onRow(row, sheetMeta);
          assertSynchronousCallback(result, 'onRow');
        }
        assertNotCancelled(options.cancelToken);
      }

      return {
        sheetMeta,
        rowCount: this.rows.length,
        explicitCellCount,
        maxColumnIndex,
        cancelled: false
      };
    } finally {
      this.scanActive = false;
    }
  }

  async scanSheets(options = {}) {
    const includeSheet = typeof options.includeSheet === 'function'
      ? options.includeSheet
      : () => true;
    const summaries = [];
    for (const sheet of this.sheets) {
      assertNotCancelled(options.cancelToken);
      if (!includeSheet(sheet)) continue;
      // eslint-disable-next-line no-await-in-loop
      const summary = await this.scanSheet(sheet, {
        cancelToken: options.cancelToken,
        onSheetMeta: options.onSheetMeta
          ? (meta) => options.onSheetMeta(meta, sheet)
          : null,
        onRow: options.onRow
          ? (row, meta) => options.onRow(row, meta, sheet)
          : null
      });
      assertNotCancelled(options.cancelToken);
      summaries.push(summary);
    }
    return summaries;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rows = null;
  }
}

async function openToolboxCsvPass(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const rows = readLegacyCsvRowsAllowEmpty(absolutePath);
  const sourceRegistryId = options.sourceRegistryId ||
    `csv-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
  const sourceRegistry = new SourceStyleRegistry(sourceRegistryId);
  return new ToolboxCsvPass({
    filePath: absolutePath,
    rows,
    sourceRegistry
  });
}

module.exports = {
  CSV_SHEET_NAME,
  ToolboxCsvCancelledError,
  ToolboxCsvPass,
  hasExcelContainerMagic,
  openToolboxCsvPass,
  readLegacyCsvRowsAllowEmpty
};
