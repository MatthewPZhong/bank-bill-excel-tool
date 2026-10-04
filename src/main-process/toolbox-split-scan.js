'use strict';

const { FileValidationError } = require('../backend/file-service/common');
const { streamToolboxTables, TOOLBOX_SHEET_STRATEGIES } = require('./toolbox-format-io');
const { assertUniqueSplitHeaders, normalizeSplitEmptyError, ToolboxSplitFieldNotFoundError } = require('./toolbox-format-operations');

// 与实际拆分共用 SPLIT 策略，包含隐藏页、续页首行与空行规则；准确扫描但不保留字段值。
async function scanSplitMetadata(filePath, { cancelToken, readerOptions } = {}) {
  try {
    const summary = await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT, cancelToken, readerOptions,
      onHeader(info) { assertUniqueSplitHeaders(info.normalizedHeaders); }
    });
    return { headers: summary.normalizedHeaders, dataRowCount: summary.dataRowCount };
  } catch (error) { throw normalizeSplitEmptyError(error); }
}

// 只收集显式请求的一列。超过容量抛错，不能把截断数组冒充完整值列表。
async function scanSplitFieldValues(filePath, field, { cancelToken, readerOptions, maxValues, maxValueBytes } = {}) {
  if (typeof field !== 'string' || !Number.isSafeInteger(maxValues) || maxValues < 1 ||
      !Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1) {
    throw new TypeError('字段值扫描需要明确字段、数量及字节预算');
  }
  const values = new Set();
  let bytes = 0;
  let index = -1;
  try {
    await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT, cancelToken, readerOptions,
      onHeader(info) {
        assertUniqueSplitHeaders(info.normalizedHeaders);
        index = info.normalizedHeaders.indexOf(field);
        if (index < 0) throw new ToolboxSplitFieldNotFoundError(`源文件中找不到字段「${field}」`);
      },
      onDataRow(_row, info) {
        const value = info.matchValues[index];
        if (!value || values.has(value)) return;
        // 覆盖 UTF-8/UTF-16 文本及集合条目；完整工作集仍须由阶段容量证据覆盖。
        const charge = Math.max(Buffer.byteLength(value, 'utf8'), value.length * 2) + 64;
        if (values.size >= maxValues || charge > maxValueBytes - bytes) {
          throw new FileValidationError('TOOLBOX_SPLIT_VALUES_BUDGET_EXCEEDED',
            '该字段的可选值超出本次读取预算，请减少字段值范围后重试');
        }
        bytes += charge;
        values.add(value);
      }
    });
    return { field, values: [...values], valuesState: 'complete' };
  } catch (error) { throw normalizeSplitEmptyError(error); }
}

module.exports = { scanSplitMetadata, scanSplitFieldValues };
