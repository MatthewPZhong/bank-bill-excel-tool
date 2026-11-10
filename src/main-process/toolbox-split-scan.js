'use strict';

const { FileValidationError } = require('../backend/file-service/common');
const { streamToolboxTables, TOOLBOX_SHEET_STRATEGIES } = require('./toolbox-format-io');
const { assertUniqueSplitHeaders, normalizeSplitEmptyError, ToolboxSplitFieldNotFoundError } = require('./toolbox-format-operations');

function validValueBudget(maxValues, maxValueBytes) {
  return Number.isSafeInteger(maxValues) && maxValues >= 1 &&
    Number.isSafeInteger(maxValueBytes) && maxValueBytes >= 1;
}

// 单值计费口径与 scanSplitFieldValues 相同（UTF-8 / UTF-16 取大 + 集合条目 64 字节）。
function valueCharge(value) {
  return Math.max(Buffer.byteLength(value, 'utf8'), value.length * 2) + 64;
}

// 元数据扫描时顺带收集各字段的可选值，口径与 scanSplitFieldValues 完全相同（matchValues、首次出现
// 顺序、单字段数量与字节上限）；另设所有字段合计的字节上限。任一上限超出的字段整列丢弃、不再收集，
// 之后选到它时仍按原方式单独扫描（届时超限照常报错）。只返回完整收集的字段。
function createFieldValuePrefetch(maxValues, maxValueBytes, maxTotalBytes) {
  let fields = [];
  let totalBytes = 0;
  return {
    setHeaders(headers) {
      fields = headers.map((field) => ({ field, values: new Set(), bytes: 0, dropped: false }));
    },
    addRow(matchValues) {
      for (let index = 0; index < fields.length; index += 1) {
        const entry = fields[index];
        if (entry.dropped) continue;
        const value = matchValues[index];
        if (!value || entry.values.has(value)) continue;
        const charge = valueCharge(value);
        if (entry.values.size >= maxValues || charge > maxValueBytes - entry.bytes ||
            charge > maxTotalBytes - totalBytes) {
          entry.dropped = true;
          totalBytes -= entry.bytes;
          entry.values = null;
          continue;
        }
        entry.bytes += charge;
        totalBytes += charge;
        entry.values.add(value);
      }
    },
    result() {
      return fields.filter((entry) => !entry.dropped).map((entry) => [entry.field, [...entry.values]]);
    }
  };
}

// 与实际拆分共用 SPLIT 策略，包含隐藏页、续页首行与空行规则。传入取值预算时顺带预取各字段可选值
// （prefetchedValues: [[字段, 值数组], ...]），供随后的字段取值请求免去第二次全量扫描。
async function scanSplitMetadata(filePath, { cancelToken, readerOptions, maxValues, maxValueBytes } = {}) {
  const prefetch = validValueBudget(maxValues, maxValueBytes)
    ? createFieldValuePrefetch(maxValues, maxValueBytes, maxValueBytes)
    : null;
  try {
    const summary = await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT, cancelToken, readerOptions,
      onHeader(info) {
        assertUniqueSplitHeaders(info.normalizedHeaders);
        if (prefetch) prefetch.setHeaders(info.normalizedHeaders);
      },
      ...(prefetch ? { onDataRow(_row, info) { prefetch.addRow(info.matchValues); } } : {})
    });
    return {
      headers: summary.normalizedHeaders,
      dataRowCount: summary.dataRowCount,
      ...(prefetch ? { prefetchedValues: prefetch.result() } : {})
    };
  } catch (error) { throw normalizeSplitEmptyError(error); }
}

// 只收集显式请求的一列。超过容量抛错，不能把截断数组冒充完整值列表。
async function scanSplitFieldValues(filePath, field, { cancelToken, readerOptions, maxValues, maxValueBytes } = {}) {
  if (typeof field !== 'string' || !validValueBudget(maxValues, maxValueBytes)) {
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
        const charge = valueCharge(value);
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
