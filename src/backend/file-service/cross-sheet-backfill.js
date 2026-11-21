'use strict';

// v3.2.21：原始账单预处理「跨 Sheet 回填」（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md）。
//   主表（模板读取的第一个 sheet）中命中「待回填行条件」的行，按配对值与同一工作簿中来源 sheet 的行一对一配对，
//   把配置的字段从来源行回填到主表的空单元格；配不上的行跳过（不进入明细与余额）并记入 issues。
//   典型场景：换汇卖出行没有日期，用描述中的买入金额去买入 sheet 的入账金额里找，取其日期。
// 口径：
//   - 配对按主表物理顺序，每行取来源 sheet 中第一笔未使用、配对值相等的行；配上即消耗（之后该行因日期 / 币种被跳过也不归还），
//     保证同金额多笔时「第 k 笔 ↔ 第 k 笔」在追加新行后不变。「已使用」只在单次运行内有效，不落库。
//   - 只填空单元格，不覆盖银行原值；日期目标列写 yyyy-mm-dd（与模板日期顺序无关），其他列写来源单元格原值。
//   - 主表币种列（主映射 Currency 所用源列）为空时补成本 sheet 非待回填行该列唯一的非空值，不从来源行取。
// 本模块不读文件：来源 sheet 由调用方通过 readSourceSheet 提供，便于单测。

const { FileValidationError, normalizeCell } = require('./common');
const {
  normalizeRowFilterRules,
  validateRowFilterRules,
  collectRowFilterRuleFields,
  compileRowFilterRules,
  matchesRowFilterRules
} = require('./row-filter-rules');
const { normalizeDateExportValue } = require('./normalizers');

const CROSS_SHEET_BACKFILL_LABEL = '跨 Sheet 回填';
// 勾选了却没有有效规则时的报错（保存与生成共用）
const CROSS_SHEET_BACKFILL_MISSING_MESSAGE = `已勾选「${CROSS_SHEET_BACKFILL_LABEL}」，请在【规则设置】中完成设置`;
const CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE = `${CROSS_SHEET_BACKFILL_LABEL}：请至少设置一条待回填行条件`;
const CROSS_SHEET_BACKFILL_MATCH_MODES = Object.freeze(['amount', 'exact']);
const CROSS_SHEET_BACKFILL_DATE_ORDERS = Object.freeze(['auto', 'DMY', 'MDY']);
const MATCH_MODE_LABELS = Object.freeze({ amount: '按金额', exact: '按原值' });

const SKIP_REASONS = Object.freeze({
  'match-value-missing': '无法识别配对值',
  'no-source-row': '来源 Sheet 中没有可配对的行',
  'source-date-invalid': '来源日期无法识别',
  'currency-undetermined': '无法确定本表币种'
});

// 金额前后可出现的币种标记：常见符号或三字母代码（如 $65.45、USD 65.45、65.45 USD）
const CURRENCY_SYMBOL_PATTERN = /[$¥€£₦₹₩₱₫฿]\s*$/;
const CURRENCY_CODE_BEFORE_PATTERN = /(?:^|[^A-Za-z])[A-Z]{3}\s*$/;
const CURRENCY_CODE_AFTER_PATTERN = /^\s*[A-Z]{3}(?![A-Za-z])/;
const AMOUNT_TOKEN_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function fail(message) {
  throw new FileValidationError('FILE_READ', message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 接受对象或 JSON 字符串；不是对象时返回 null（未设置）。只做形状规范化，不做必填校验。
function normalizeCrossSheetBackfillRule(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      value = JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }
  if (!isPlainObject(value)) return null;
  const matchMode = normalizeCell(value.matchMode);
  const sourceDateOrder = normalizeCell(value.sourceDateOrder);
  const backfillFields = (Array.isArray(value.backfillFields) ? value.backfillFields : [])
    .filter(isPlainObject)
    .map((item) => ({
      targetField: normalizeCell(item.targetField),
      sourceField: normalizeCell(item.sourceField)
    }))
    .filter((item) => item.targetField !== '' || item.sourceField !== '');
  return {
    sourceSheetName: normalizeCell(value.sourceSheetName),
    rowRules: normalizeRowFilterRules(value.rowRules),
    matchMode: CROSS_SHEET_BACKFILL_MATCH_MODES.includes(matchMode) ? matchMode : 'amount',
    matchField: normalizeCell(value.matchField),
    sourceMatchField: normalizeCell(value.sourceMatchField),
    sourceDateOrder: CROSS_SHEET_BACKFILL_DATE_ORDERS.includes(sourceDateOrder) ? sourceDateOrder : 'auto',
    backfillFields
  };
}

// 是否存有任何设置（用于模板包版本判定、未勾选但存有设置时保留）
function hasCrossSheetBackfillSettings(raw) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  return Boolean(rule && (
    rule.sourceSheetName
    || rule.rowRules.length
    || rule.matchField
    || rule.sourceMatchField
    || rule.backfillFields.length
  ));
}

// 返回规范化后的规则。headers 为数组时校验本表字段在模板表头中；excludedTargetFields：不能作为回填目标的本表字段
//   （主映射金额、余额、币种、MerchantId 所用的源列）。渲染端 configuration.js 有同口径的保存前校验，改规则时两边一起改。
function validateCrossSheetBackfillRule(raw, headers, { excludedTargetFields = [] } = {}) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  if (!rule || !hasCrossSheetBackfillSettings(rule)) {
    fail(CROSS_SHEET_BACKFILL_MISSING_MESSAGE);
  }
  const headerSet = Array.isArray(headers)
    ? new Set(headers.map((header) => normalizeCell(header)).filter(Boolean))
    : null;
  const ensureMainField = (field) => {
    if (headerSet && !headerSet.has(field)) {
      fail(`映射字段不存在：${field}`);
    }
  };
  if (!rule.sourceSheetName) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请填写来源 Sheet 名`);
  }
  rule.rowRules = validateRowFilterRules(rule.rowRules, headers, {
    missingMessage: CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE,
    ruleLabel: `${CROSS_SHEET_BACKFILL_LABEL}：待回填行条件`
  });
  if (!rule.matchField) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请选择本表配对字段`);
  }
  ensureMainField(rule.matchField);
  if (!rule.sourceMatchField) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请填写来源配对字段`);
  }
  if (!rule.backfillFields.length) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：请至少设置一个回填字段`);
  }
  const excludedSet = new Set((excludedTargetFields || []).map((field) => normalizeCell(field)).filter(Boolean));
  const seenTargets = new Set();
  rule.backfillFields.forEach((item, index) => {
    const label = `${CROSS_SHEET_BACKFILL_LABEL}：回填字段第 ${index + 1} 行`;
    if (!item.targetField) {
      fail(`${label}请选择本表字段`);
    }
    if (!item.sourceField) {
      fail(`${label}请填写来源字段`);
    }
    ensureMainField(item.targetField);
    if (seenTargets.has(item.targetField)) {
      fail(`${CROSS_SHEET_BACKFILL_LABEL}：本表字段「${item.targetField}」重复设置`);
    }
    seenTargets.add(item.targetField);
    if (excludedSet.has(item.targetField)) {
      fail(`${CROSS_SHEET_BACKFILL_LABEL}：「${item.targetField}」用于发生额、余额、币种或账户映射，不能作为回填字段`);
    }
  });
  return rule;
}

// 规则用到的本表字段（模板【更新】失效引用用）：待回填行条件字段、本表配对字段、回填目标字段
function collectCrossSheetBackfillMainFields(raw) {
  const rule = normalizeCrossSheetBackfillRule(raw);
  if (!rule) return [];
  const fields = [];
  const push = (field) => {
    if (field && !fields.includes(field)) fields.push(field);
  };
  collectRowFilterRuleFields(rule.rowRules).forEach(push);
  push(rule.matchField);
  rule.backfillFields.forEach((item) => push(item.targetField));
  return fields;
}

function toCents(numberValue) {
  if (!Number.isFinite(numberValue)) return null;
  return Math.round(Number(Math.abs(numberValue).toFixed(2)) * 100);
}

// 从单元格中识别金额（返回分，取绝对值）；识别不出或有歧义时返回 null。
//   数值直接取；文本：只有一个数字就取它，多个数字时取紧跟币种符号或三字母代码的那一个，仍不唯一则 null。
function parseAmountCents(value) {
  if (typeof value === 'number') {
    return toCents(value);
  }
  const text = normalizeCell(value);
  if (!text) return null;
  const tokens = [];
  AMOUNT_TOKEN_PATTERN.lastIndex = 0;
  let match = AMOUNT_TOKEN_PATTERN.exec(text);
  while (match) {
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
    match = AMOUNT_TOKEN_PATTERN.exec(text);
  }
  if (!tokens.length) return null;
  let picked = tokens;
  if (tokens.length > 1) {
    picked = tokens.filter((token) => {
      const before = text.slice(0, token.start);
      const after = text.slice(token.end);
      return CURRENCY_SYMBOL_PATTERN.test(before)
        || CURRENCY_CODE_BEFORE_PATTERN.test(before)
        || CURRENCY_CODE_AFTER_PATTERN.test(after);
    });
  }
  if (picked.length !== 1) return null;
  return toCents(Number(picked[0].raw.replace(/,/g, '')));
}

function buildMatchKey(value, matchMode) {
  if (matchMode === 'exact') {
    const text = normalizeCell(value);
    return text === '' ? null : text;
  }
  const cents = parseAmountCents(value);
  return cents === null ? null : String(cents);
}

function formatMatchKey(key, matchMode) {
  if (matchMode === 'exact') return key;
  const cents = Number(key);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function resolveRequiredIndex(indexByField, field, sheetLabel) {
  const index = indexByField.get(field);
  if (index === undefined) {
    fail(sheetLabel ? `${CROSS_SHEET_BACKFILL_LABEL}：来源 Sheet「${sheetLabel}」中没有字段「${field}」` : `映射字段不存在：${field}`);
  }
  return index;
}

// 来源 sheet：第一行包含来源配对字段与全部来源回填字段的行为表头，之后的行为数据行。
function locateSourceTable(sourceRows, sourceRowNumbers, requiredFields, sheetName) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const headerIndex = rows.findIndex((row) => {
    const cells = new Set((Array.isArray(row) ? row : []).map((cell) => normalizeCell(cell)));
    return requiredFields.every((field) => cells.has(field));
  });
  if (headerIndex < 0) {
    fail(`${CROSS_SHEET_BACKFILL_LABEL}：来源 Sheet「${sheetName}」中没有同时包含「${requiredFields.join('」「')}」的表头行`);
  }
  const indexByField = new Map();
  rows[headerIndex].forEach((cell, index) => {
    const field = normalizeCell(cell);
    if (field && !indexByField.has(field)) indexByField.set(field, index);
  });
  const dataRows = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    dataRows.push({ row, rowNumber: (sourceRowNumbers && sourceRowNumbers[index]) || index + 1 });
  }
  return { indexByField, dataRows };
}

function isEmptyCell(value) {
  return normalizeCell(value) === '';
}

/**
 * 在映射前对主表源行执行跨 Sheet 回填。
 * @param {object} options
 * @param {Array<Array>} options.rows 主表行（rows[0] 为表头）
 * @param {Array<number>} options.rowNumbers 与 rows 平行的物理行号
 * @param {Map<string, number>} options.sourceIndexByField 主表字段 → 列下标
 * @param {object|null} options.rule 已规范化的规则；为空时不处理
 * @param {(sheetName: string) => {rows: Array<Array>, rowNumbers: Array<number>}} options.readSourceSheet
 * @param {Set<string>} [options.dateTargetFields] 按日期处理的本表字段（主映射 BillDate / ValueDate 所用源列）
 * @param {Set<string>} [options.billDateFields] 主映射 BillDate 所用源列（日期区间提示）
 * @param {string} [options.currencyField] 主映射 Currency 所用源列；为空时不补币种
 * @param {(row: Array) => string} [options.resolveRowBillDate] 返回该行账单日期 yyyy-mm-dd，无效为空串
 * @param {Array<string>} [options.excludedTargetFields] 不能作为回填目标的本表字段（生成时再校验一次）
 */
function applyCrossSheetBackfill({
  rows,
  rowNumbers,
  sourceIndexByField,
  rule,
  readSourceSheet,
  dateTargetFields = new Set(),
  billDateFields = new Set(),
  currencyField = '',
  resolveRowBillDate = null,
  excludedTargetFields = []
}) {
  const emptyStats = { targetRows: 0, backfilledRows: 0, skippedRows: 0 };
  if (!rule) {
    return { enabled: false, rows, rowNumbers, issues: [], patches: [], stats: emptyStats };
  }
  const validated = validateCrossSheetBackfillRule(rule, null, { excludedTargetFields });
  const compiledRowRules = compileRowFilterRules(validated.rowRules, sourceIndexByField, {
    missingMessage: CROSS_SHEET_BACKFILL_ROW_RULES_MISSING_MESSAGE
  });
  const matchIndex = resolveRequiredIndex(sourceIndexByField, validated.matchField);
  const targets = validated.backfillFields.map((item) => ({
    ...item,
    targetIndex: resolveRequiredIndex(sourceIndexByField, item.targetField),
    isDate: dateTargetFields.has(item.targetField),
    isBillDate: billDateFields.has(item.targetField)
  }));
  const currencyIndex = currencyField ? sourceIndexByField.get(currencyField) : undefined;

  const targetRowIndexes = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    if (matchesRowFilterRules(rows[index], compiledRowRules)) {
      targetRowIndexes.add(index);
    }
  }
  if (!targetRowIndexes.size) {
    return { enabled: true, rows, rowNumbers, issues: [], patches: [], stats: emptyStats };
  }

  // 来源 sheet：配对值 → 未使用行队列（按物理顺序）
  const source = readSourceSheet(validated.sourceSheetName) || {};
  const requiredSourceFields = [validated.sourceMatchField]
    .concat(validated.backfillFields.map((item) => item.sourceField))
    .filter((field, index, list) => list.indexOf(field) === index);
  const { indexByField: sourceFieldIndex, dataRows: sourceDataRows } = locateSourceTable(
    source.rows,
    source.rowNumbers,
    requiredSourceFields,
    validated.sourceSheetName
  );
  const sourceMatchIndex = resolveRequiredIndex(sourceFieldIndex, validated.sourceMatchField, validated.sourceSheetName);
  const sourceIndexes = targets.map((item) => resolveRequiredIndex(sourceFieldIndex, item.sourceField, validated.sourceSheetName));
  const queueByKey = new Map();
  sourceDataRows.forEach((entry) => {
    const key = buildMatchKey(entry.row[sourceMatchIndex], validated.matchMode);
    if (key === null) return;
    if (!queueByKey.has(key)) queueByKey.set(key, []);
    queueByKey.get(key).push(entry);
  });

  // 本 sheet 币种：非待回填行该列唯一的非空值
  let sheetCurrency = '';
  if (currencyIndex !== undefined) {
    const currencies = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      if (targetRowIndexes.has(index)) continue;
      const value = normalizeCell(rows[index][currencyIndex]);
      if (value) currencies.add(value);
    }
    sheetCurrency = currencies.size === 1 ? Array.from(currencies)[0] : '';
  }

  const issues = [];
  const patches = [];
  const nextRows = [rows[0]];
  const nextRowNumbers = [rowNumbers[0]];
  const billDateCheckRows = [];
  let backfilledRows = 0;
  let skippedRows = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = rowNumbers[index] || index + 1;
    if (!targetRowIndexes.has(index)) {
      nextRows.push(row);
      nextRowNumbers.push(rowNumber);
      continue;
    }
    const matchRaw = row[matchIndex];
    const skip = (reason, extra = {}) => {
      skippedRows += 1;
      issues.push({
        type: 'cross-sheet-backfill-skipped',
        rowNumber,
        reason,
        reasonText: SKIP_REASONS[reason],
        matchField: validated.matchField,
        matchValue: normalizeCell(matchRaw),
        sourceSheetName: validated.sourceSheetName,
        sourceMatchField: validated.sourceMatchField,
        ...extra
      });
    };
    const key = buildMatchKey(matchRaw, validated.matchMode);
    if (key === null) {
      skip('match-value-missing');
      continue;
    }
    const queue = queueByKey.get(key);
    const sourceEntry = queue && queue.length ? queue.shift() : null;
    if (!sourceEntry) {
      skip('no-source-row', { matchKey: formatMatchKey(key, validated.matchMode) });
      continue;
    }
    const nextRow = row.slice();
    const cells = [];
    let skipReason = '';
    if (currencyIndex !== undefined && isEmptyCell(nextRow[currencyIndex])) {
      if (!sheetCurrency) {
        skipReason = 'currency-undetermined';
      } else {
        nextRow[currencyIndex] = sheetCurrency;
        cells.push({ field: currencyField, columnIndex: currencyIndex, value: sheetCurrency, kind: 'value' });
      }
    }
    let filledBillDate = false;
    for (let targetIndex = 0; !skipReason && targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (!isEmptyCell(nextRow[target.targetIndex])) continue;
      const sourceValue = sourceEntry.row[sourceIndexes[targetIndex]];
      if (target.isDate) {
        const isoDate = normalizeDateExportValue(
          typeof sourceValue === 'number' ? sourceValue : normalizeCell(sourceValue),
          { dateParseOrder: validated.sourceDateOrder }
        ).value;
        if (!isoDate) {
          skipReason = 'source-date-invalid';
          break;
        }
        nextRow[target.targetIndex] = isoDate;
        cells.push({ field: target.targetField, columnIndex: target.targetIndex, value: isoDate, kind: 'date' });
        if (target.isBillDate) filledBillDate = true;
      } else if (!isEmptyCell(sourceValue)) {
        nextRow[target.targetIndex] = sourceValue;
        cells.push({ field: target.targetField, columnIndex: target.targetIndex, value: sourceValue, kind: 'value' });
      }
    }
    if (skipReason) {
      skip(skipReason, { sourceRowNumber: sourceEntry.rowNumber });
      continue;
    }
    nextRows.push(nextRow);
    nextRowNumbers.push(rowNumber);
    if (cells.length) {
      backfilledRows += 1;
      patches.push({ rowNumber, sourceRowNumber: sourceEntry.rowNumber, cells });
    }
    if (filledBillDate) {
      billDateCheckRows.push({ originalIndex: index, rowNumber, row: nextRow });
    }
  }

  // 日期区间提示：与该行之前、之后最近的、日期有效的非待回填行比较（含端点，正序倒序均可）。
  //   只有一侧时按本表日期的整体顺序（首个与最后一个有效日期）只比较这一侧；整体顺序无法判断时不提示。
  if (billDateCheckRows.length && typeof resolveRowBillDate === 'function') {
    const neighborDates = rows.map((row, index) => (
      index > 0 && !targetRowIndexes.has(index) ? normalizeCell(resolveRowBillDate(row)) : ''
    ));
    const validDates = neighborDates.filter(Boolean);
    const firstDate = validDates[0] || '';
    const lastDate = validDates[validDates.length - 1] || '';
    const direction = firstDate && lastDate && firstDate !== lastDate
      ? (firstDate < lastDate ? 'asc' : 'desc')
      : '';
    billDateCheckRows.forEach(({ originalIndex, rowNumber, row }) => {
      const date = normalizeCell(resolveRowBillDate(row));
      if (!date) return;
      let prevDate = '';
      for (let index = originalIndex - 1; index >= 1 && !prevDate; index -= 1) prevDate = neighborDates[index];
      let nextDate = '';
      for (let index = originalIndex + 1; index < rows.length && !nextDate; index += 1) nextDate = neighborDates[index];
      let outOfRange = false;
      if (prevDate && nextDate) {
        const [low, high] = [prevDate, nextDate].sort();
        outOfRange = date < low || date > high;
      } else if (prevDate) {
        outOfRange = (direction === 'asc' && date < prevDate) || (direction === 'desc' && date > prevDate);
      } else if (nextDate) {
        outOfRange = (direction === 'asc' && date > nextDate) || (direction === 'desc' && date < nextDate);
      }
      if (outOfRange) {
        issues.push({ type: 'cross-sheet-backfill-date-out-of-range', rowNumber, date, prevDate, nextDate });
      }
    });
  }

  return {
    enabled: true,
    rows: nextRows,
    rowNumbers: nextRowNumbers,
    issues,
    patches,
    stats: { targetRows: targetRowIndexes.size, backfilledRows, skippedRows },
    sourceSheetName: validated.sourceSheetName
  };
}

module.exports = {
  CROSS_SHEET_BACKFILL_LABEL,
  CROSS_SHEET_BACKFILL_MISSING_MESSAGE,
  CROSS_SHEET_BACKFILL_MATCH_MODES,
  CROSS_SHEET_BACKFILL_DATE_ORDERS,
  MATCH_MODE_LABELS,
  SKIP_REASONS,
  normalizeCrossSheetBackfillRule,
  hasCrossSheetBackfillSettings,
  validateCrossSheetBackfillRule,
  collectCrossSheetBackfillMainFields,
  parseAmountCents,
  applyCrossSheetBackfill
};
