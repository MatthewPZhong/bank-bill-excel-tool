'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName
} = require('../backend/balance-seed-store');
const { readBalanceAdjustments, resolveBalanceAdjustment } = require('../backend/balance-adjustment-store');
const {
  buildDetailExportRows,
  calculateEndingBalanceFromAmounts,
  extractHeaders,
  FileValidationError,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  roundAmountHighPrecision,
  verifyStatementEndingBalance,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../backend/file-service');
const {
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  resolveSinglePreparedFieldValue
} = require('./statement-session');
const { createStatementGenerationHelpers, statementOutputName } = require('./statement-generation');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function today() {
  return formatDateLabel(new Date());
}

function buildDateRangeLabel(billDates) {
  const sorted = [...new Set(billDates)].sort();
  if (sorted.length === 0) return '';
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}~${sorted[sorted.length - 1]}`;
}

function buildFieldIndexMap(headerRow) {
  const result = new Map();
  headerRow.forEach((value, index) => {
    const key = normalizeCell(value);
    if (key && !result.has(key)) result.set(key, index);
  });
  return result;
}

function parseRequiredBillDates(detailRows) {
  const index = buildFieldIndexMap(detailRows[0] || []).get('BillDate');
  if (index === undefined) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  const dates = [];
  for (const row of detailRows.slice(1)) {
    const raw = row[index];
    if (!normalizeCell(raw)) continue;
    const parsed = parseDateValue(raw);
    if (!parsed) throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizeCell(raw)}`);
    dates.push(formatDateLabel(parsed));
  }
  if (!dates.length) throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
  return dates;
}

function numeric(raw, label, allowBlank) {
  if (!normalizeCell(raw)) return allowBlank ? null : 0;
  const value = parseNumericValue(raw);
  if (value === null) throw new FileValidationError('FILE_READ', `${label} 不是有效数字`);
  return value;
}

function balanceTemplateRow(fields, values) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [normalizeCell(key), value]));
  return fields.map((field) => {
    const normalizedField = normalizeCell(field);
    return normalized.has(normalizedField) ? normalized.get(normalizedField) : '';
  });
}

function balancePrompt(templateName, bankName, merchantId, currency, targetBillDate) {
  return { templateName, bankName, merchantId, currency, targetBillDate };
}

function resolveSeedRecord(resolver, prompt) {
  const seed = typeof resolver === 'function' ? resolver(prompt) : null;
  if (!seed || seed.endBalance === null || seed.endBalance === undefined) return null;
  return seed;
}

// 账单里的余额首日按种子推导多候选余额时取账单原值：生成的种子（账单里的余额 / 通过发生额计算）
// 是输出值，已含截至种子日的余额附加值，先扣回；人工录入的种子按账单原值（与发生额计算以人工种子为起点、叠加全部附加值同口径）。
function statementSeedOriginalBalance(seed, balanceAdjustments, { merchantId, currency }) {
  const generationMethod = normalizeCell(seed.generationMethod);
  const includesAdjustment = generationMethod === BALANCE_SEED_GENERATION_METHODS.statement
    || generationMethod === BALANCE_SEED_GENERATION_METHODS.calculated;
  if (!includesAdjustment) return seed.endBalance;
  const seedAdjustment = resolveBalanceAdjustment(balanceAdjustments, {
    merchantId, currency, dateLabel: normalizeCell(seed.billDate)
  });
  return seedAdjustment ? roundAmountHighPrecision(seed.endBalance - seedAdjustment) : seed.endBalance;
}

function requireSeedRecord(resolver, prompt) {
  const seed = resolveSeedRecord(resolver, prompt);
  if (seed) return seed;
  throw new FileValidationError('BALANCE_SEED_REQUIRED', '因首次导入余额，请导入上一个账单日余额用于余额校验', {
    context: prompt
  });
}

const BALANCE_SEED_MISMATCH_MESSAGE = '上一账单日余额与账单对不上，请核对后重新补录';

// 已有种子但首日多个候选余额都对不上（v3.2.16 D7）：仍走补录提示，附上种子与当日收支、候选余额，
// 让用户知道是已有余额填错了，而不是缺余额；补录弹窗据此说明原因并预填种子日期与金额。
function buildBalanceSeedMismatch({ seed, anchor, dateLabel, verification }) {
  return {
    seedDate: anchor.date,
    seedBalance: seed.endBalance,
    seedGenerationMethod: normalizeCell(seed.generationMethod) || BALANCE_SEED_GENERATION_METHODS.manual,
    anchorBalance: anchor.balance,
    billDate: dateLabel,
    creditAmount: verification.creditAmountSum,
    debitAmount: verification.debitAmountSum,
    expectedBalance: verification.expectedBalance,
    statementBalances: Array.isArray(verification.candidateBalances) ? verification.candidateBalances.slice() : []
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BALANCE_GAP_CONFIRM_MESSAGE = '账单日期不连续，请确认是否补录断档前一日的期末余额';

function dateLabelToUtcDay(dateLabel) {
  const [year, month, day] = String(dateLabel).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function utcDayToDateLabel(utcDay) {
  const date = new Date(utcDay * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function shiftDateLabel(dateLabel, days) {
  return utcDayToDateLabel(dateLabelToUtcDay(dateLabel) + days);
}

// 按自然日判断：锚点日期的下一天早于当前账单日即为断档。
function isBalanceDateGap(anchorDate, dateLabel) {
  return dateLabelToUtcDay(dateLabel) - dateLabelToUtcDay(anchorDate) > 1;
}

// 账单里的余额非首日多个余额都对不上（D7）：写明账号与币种；与上一账单日之间缺日期时写明缺的日期（D13）。
function buildStatementBalanceUnresolvedMessage({ merchantId, currency, dateLabel, anchorDate }) {
  const message = `银行账号 ${merchantId}${currency ? `（${currency}）` : ' '}${dateLabel} 的期末余额无法根据收支金额推导`;
  if (!anchorDate || !isBalanceDateGap(anchorDate, dateLabel)) return message;
  const missingFrom = shiftDateLabel(anchorDate, 1);
  const missingTo = shiftDateLabel(dateLabel, -1);
  const singleDay = missingFrom === missingTo;
  return `${message}：上一账单日是 ${anchorDate}，中间缺 ${singleDay ? missingFrom : `${missingFrom} ~ ${missingTo}`}，`
    + `请核对导入的账单是否漏了${singleDay ? '这天' : '这几天'}的交易`;
}

function balanceGapKey({ templateName, merchantId, currency, anchorDate, targetBillDate }) {
  return [templateName, merchantId, currency, anchorDate, targetBillDate]
    .map((value) => normalizeCell(value))
    .join('|');
}

const BALANCE_MISMATCH_CONFIRM_MESSAGE = '账单余额与上一日余额加当日收支不一致，请核查或确认按账单余额生成';
const BALANCE_MISMATCH_KEY_PREFIX = 'mismatch';

// 余额不一致确认键（按分）：上一日余额的日期与金额、当日收入与支出合计、账单余额任一变化需重新确认。
// 与断档键共用确认集合，以前缀区分。
function balanceMismatchKey({
  templateName,
  merchantId,
  currency,
  billDate,
  anchorDate,
  anchorBalance,
  creditAmount,
  debitAmount,
  statementBalance
}) {
  return [
    BALANCE_MISMATCH_KEY_PREFIX,
    templateName,
    merchantId,
    currency,
    billDate,
    anchorDate,
    Number(anchorBalance).toFixed(2),
    Number(creditAmount).toFixed(2),
    Number(debitAmount).toFixed(2),
    Number(statementBalance).toFixed(2)
  ].map((value) => normalizeCell(value)).join('|');
}

const BALANCE_SEED_REPLACE_CONFIRM_MESSAGE = '人工补录的期末余额与本次余额不一致，请核查或确认替换';
const BALANCE_SEED_REPLACE_KEY_PREFIX = 'seed-replace';

// 人工补录替换确认键（按分）：人工补录值或本次余额（原值）变化需重新确认。与断档、不一致键共用确认集合，以前缀区分。
function balanceSeedReplaceKey({ templateName, merchantId, currency, billDate, manualBalance, balance }) {
  return [
    BALANCE_SEED_REPLACE_KEY_PREFIX,
    templateName,
    merchantId,
    currency,
    billDate,
    Number(manualBalance).toFixed(2),
    Number(balance).toFixed(2)
  ].map((value) => normalizeCell(value)).join('|');
}

function balanceSeedRecordKey(record) {
  return [record.merchantId, record.currency, record.billDate].map((value) => normalizeCell(value)).join('@@');
}

// 同一账单日的人工补录种子：按 账号@@币种@@日期 索引（未写生成方式的旧记录按人工录入读取）。
// seenManualBalanceSeeds（可选，本次运行里见过的人工补录，key 同上）：先按当前种子同步——当前为人工补录的记下
// 最新值，已没有种子的日期去掉（用户删除）；某日当前为工具生成、而这里记着人工补录时，仍按该人工补录比对。
// 工具按同值回写把人工补录改成工具生成后，与该日余额不同的回写仍须确认替换（v3.2.16 Codex 审查 P1）。
function indexManualBalanceSeeds(existingBalanceSeeds, seenManualBalanceSeeds = null) {
  const currentRecords = (Array.isArray(existingBalanceSeeds) ? existingBalanceSeeds : []).filter(Boolean);
  const isManual = (record) => normalizeCell(record.generationMethod) === BALANCE_SEED_GENERATION_METHODS.manual &&
    record.endBalance !== null && record.endBalance !== undefined;
  const index = new Map();
  const generatedKeys = new Set();
  currentRecords.forEach((record) => {
    if (isManual(record)) index.set(balanceSeedRecordKey(record), record);
    else generatedKeys.add(balanceSeedRecordKey(record));
  });
  if (seenManualBalanceSeeds instanceof Map) {
    const currentKeys = new Set(currentRecords.map(balanceSeedRecordKey));
    [...seenManualBalanceSeeds.keys()].forEach((key) => {
      if (!currentKeys.has(key)) seenManualBalanceSeeds.delete(key);
    });
    index.forEach((record, key) => seenManualBalanceSeeds.set(key, { ...record }));
    generatedKeys.forEach((key) => {
      if (seenManualBalanceSeeds.has(key)) index.set(key, seenManualBalanceSeeds.get(key));
    });
  }
  return index;
}

function deriveBalanceRecords({
  detailRows,
  templateName,
  balanceTemplateFields,
  mode = 'statement',
  resolvePreviousBalanceSeed = null,
  balanceAdjustments = [],
  acknowledgedBalanceGapKeys = null,
  acknowledgedBalanceMismatchKeys = null,
  existingBalanceSeeds = [],
  seenManualBalanceSeeds = null,
  acknowledgedBalanceSeedReplaceKeys = null
}) {
  const indexes = buildFieldIndexMap(detailRows[0] || []);
  const balanceIndex = indexes.get('Balance');
  const dateIndex = indexes.get('BillDate');
  const merchantIndex = indexes.get('MerchantId');
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  if (mode === 'statement' && balanceIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板未配置 Balance 字段，无法生成余额账单');
  }
  if (dateIndex === undefined) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  if (merchantIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
  }
  const groups = new Map();
  const missingMerchantIdRows = [];
  detailRows.slice(1).forEach((row, rowIndex) => {
    const rawDate = row[dateIndex];
    if (!normalizeCell(rawDate)) return;
    const parsedDate = parseDateValue(rawDate);
    if (!parsedDate) throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizeCell(rawDate)}`);
    const merchantId = normalizeCell(row[merchantIndex]);
    if (!merchantId) {
      missingMerchantIdRows.push({
        sourceRowNumber: rowMetas[rowIndex]?.sourceRowNumber || rowIndex + 2,
        dateLabel: formatDateLabel(parsedDate)
      });
      return;
    }
    const dateLabel = formatDateLabel(parsedDate);
    const currency = normalizeCell(row[indexes.get('Currency')]);
    const key = `${merchantId}@@${currency}`;
    if (!groups.has(key)) groups.set(key, { merchantId, currency, dates: new Map() });
    const group = groups.get(key);
    if (!group.dates.has(dateLabel)) group.dates.set(dateLabel, []);
    group.dates.get(dateLabel).push({
      balanceValue: mode === 'statement' ? numeric(row[balanceIndex], `${dateLabel} 的 Balance`, true) : null,
      creditAmount: numeric(row[indexes.get('Credit Amount')], `${dateLabel} 的 Credit Amount`, false),
      debitAmount: numeric(row[indexes.get('Debit Amount')], `${dateLabel} 的 Debit Amount`, false)
    });
  });
  if (missingMerchantIdRows.length) {
    throw new FileValidationError(
      'FILE_READ',
      '当前模板启用 Balance 时，导入文件中的 MerchantId 不能为空',
      {
        detailLines: missingMerchantIdRows.map(
          (row) => `第${row.sourceRowNumber}行，账单日期：${row.dateLabel}`
        ),
        context: { templateName }
      }
    );
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    left.merchantId.localeCompare(right.merchantId, 'zh-Hans-CN') ||
    left.currency.localeCompare(right.currency, 'zh-Hans-CN'));
  if (!orderedGroups.length) {
    throw new FileValidationError('FILE_READ', '导入文件中未找到可用于余额账单的账单日期');
  }
  const bank = splitTemplateName(templateName);
  const records = [];
  const seedRecords = [];
  const billDates = new Set();
  const pendingBalanceGaps = [];
  const skippedBalanceGaps = [];
  const pendingBalanceMismatches = [];
  const confirmedBalanceMismatches = [];
  const manualSeedByDate = indexManualBalanceSeeds(existingBalanceSeeds, seenManualBalanceSeeds);
  const pendingBalanceSeedReplacements = [];
  const confirmedBalanceSeedReplacements = [];
  for (const group of orderedGroups) {
    let previousEndBalance = null;
    let previousStatementBalance = null;
    let previousDate = null;
    let lastAdjustment = 0;
    for (const dateLabel of [...group.dates.keys()].sort()) {
      const entries = group.dates.get(dateLabel);
      const prompt = balancePrompt(templateName, bank.bankName, group.merchantId, group.currency, dateLabel);
      let endBalance;
      if (mode === 'calculated') {
        let anchor = null;
        if (previousDate === null) {
          const seed = requireSeedRecord(resolvePreviousBalanceSeed, prompt);
          anchor = { date: normalizeCell(seed.billDate), endBalance: seed.endBalance, source: 'seed' };
        } else {
          anchor = { date: previousDate, endBalance: previousEndBalance, source: 'file' };
          // 断档中有人工录入的种子（用户补录的期末余额）时，改用该种子接着算。
          // 计算种子已含余额附加值，且可能来自另一条计算链，不作断档锚点。
          if (isBalanceDateGap(previousDate, dateLabel)) {
            const seed = resolveSeedRecord(resolvePreviousBalanceSeed, {
              ...prompt,
              generationMethod: BALANCE_SEED_GENERATION_METHODS.manual
            });
            if (seed && normalizeCell(seed.billDate) > previousDate) {
              anchor = { date: normalizeCell(seed.billDate), endBalance: seed.endBalance, source: 'seed' };
            }
          }
        }
        // 种子锚点沿用首日口径：余额附加值从 0 起累计。
        if (anchor.source === 'seed') lastAdjustment = 0;
        if (isBalanceDateGap(anchor.date, dateLabel)) {
          const gap = {
            templateName,
            bankName: bank.bankName,
            merchantId: group.merchantId,
            currency: group.currency,
            anchorDate: anchor.date,
            anchorSource: anchor.source,
            targetBillDate: dateLabel,
            missingFrom: shiftDateLabel(anchor.date, 1),
            missingTo: shiftDateLabel(dateLabel, -1),
            suggestedSeedDate: shiftDateLabel(dateLabel, -1)
          };
          gap.key = balanceGapKey(gap);
          if (acknowledgedBalanceGapKeys && acknowledgedBalanceGapKeys.has(gap.key)) {
            skippedBalanceGaps.push(gap);
          } else {
            pendingBalanceGaps.push(gap);
          }
        }
        endBalance = calculateEndingBalanceFromAmounts({
          previousEndBalance: anchor.endBalance,
          entries
        });
      } else {
        // 账单里的余额逐日校验（v3.2.16）：预期 = 上一日余额 + 当日收入 − 当日支出。
        // 每组首日的上一日余额取最新种子（生成的种子先扣回附加值），之后取上一日的账单原值（不含附加值）。
        if (!entries.some((entry) => entry.balanceValue !== null)) {
          throw new FileValidationError('FILE_READ', `${dateLabel} 未找到期末余额`);
        }
        let anchor;
        let anchorSeed = null;
        if (previousDate === null) {
          anchorSeed = requireSeedRecord(resolvePreviousBalanceSeed, prompt);
          anchor = {
            date: normalizeCell(anchorSeed.billDate),
            balance: statementSeedOriginalBalance(anchorSeed, balanceAdjustments, group),
            source: 'seed'
          };
        } else {
          anchor = { date: previousDate, balance: previousStatementBalance, source: 'statement' };
        }
        const verification = verifyStatementEndingBalance({ anchorBalance: anchor.balance, entries, dateLabel });
        if (verification.status === 'unresolved') {
          // 多个候选都不符：首日提示重新补录上一账单日余额并说明对不上的明细（D7），之后的日期不生成（不提供确认继续）。
          if (anchor.source === 'seed') {
            throw new FileValidationError('BALANCE_SEED_REQUIRED', BALANCE_SEED_MISMATCH_MESSAGE, {
              context: {
                ...prompt,
                seedMismatch: buildBalanceSeedMismatch({ seed: anchorSeed, anchor, dateLabel, verification })
              }
            });
          }
          throw new FileValidationError('FILE_READ', buildStatementBalanceUnresolvedMessage({
            merchantId: group.merchantId,
            currency: group.currency,
            dateLabel,
            anchorDate: anchor.date
          }));
        }
        if (verification.status === 'mismatch') {
          const mismatch = {
            templateName,
            bankName: bank.bankName,
            merchantId: group.merchantId,
            currency: group.currency,
            billDate: dateLabel,
            anchorDate: anchor.date,
            anchorSource: anchor.source,
            anchorBalance: anchor.balance,
            creditAmount: verification.creditAmountSum,
            debitAmount: verification.debitAmountSum,
            expectedBalance: verification.expectedBalance,
            statementBalance: verification.endBalance,
            difference: verification.difference,
            missingFrom: '',
            missingTo: ''
          };
          if (anchor.date && isBalanceDateGap(anchor.date, dateLabel)) {
            mismatch.missingFrom = shiftDateLabel(anchor.date, 1);
            mismatch.missingTo = shiftDateLabel(dateLabel, -1);
          }
          mismatch.key = balanceMismatchKey(mismatch);
          if (acknowledgedBalanceMismatchKeys && acknowledgedBalanceMismatchKeys.has(mismatch.key)) {
            confirmedBalanceMismatches.push(mismatch);
          } else {
            pendingBalanceMismatches.push(mismatch);
          }
        }
        // 不一致的一天无论是否确认都以账单余额为准，下一日从它接着校验，一次列全全部差异。
        endBalance = verification.endBalance;
        previousStatementBalance = endBalance;
      }
      const cumulative = resolveBalanceAdjustment(balanceAdjustments, {
        merchantId: group.merchantId, currency: group.currency, dateLabel
      });
      if (mode === 'calculated') {
        // 发生额计算沿用上一日已调整余额，只叠加附加值增量（跨导入口径见 backlog B32，未改）。
        const incrementalAdjustment = Math.round((cumulative - lastAdjustment) * 100) / 100;
        if (incrementalAdjustment && endBalance !== null) {
          endBalance = roundAmountHighPrecision(endBalance + incrementalAdjustment);
        }
      } else if (cumulative && endBalance !== null) {
        // 账单里的余额每天取账单原值，叠加截至当日的附加值累计额（PRD v1.4.6：当日及之后余额 = 原始余额 + 附加值）。
        endBalance = roundAmountHighPrecision(endBalance + cumulative);
      }
      // 同一账单日已有人工补录种子、且与本次余额（原值，不含附加值；人工种子同口径）不一致时，回写前须确认替换（v3.2.16）。
      const manualSeed = manualSeedByDate.get([group.merchantId, group.currency, dateLabel].join('@@'));
      if (manualSeed && endBalance !== null) {
        const originalBalance = roundAmountHighPrecision(endBalance - cumulative);
        const difference = roundAmountHighPrecision(originalBalance - manualSeed.endBalance);
        if (Math.abs(Number(originalBalance.toFixed(2)) - Number(Number(manualSeed.endBalance).toFixed(2))) >= 0.005) {
          const replacement = {
            templateName,
            bankName: bank.bankName,
            merchantId: group.merchantId,
            currency: group.currency,
            billDate: dateLabel,
            balanceSource: mode === 'calculated' ? 'calculated' : 'statement',
            manualBalance: manualSeed.endBalance,
            balance: originalBalance,
            difference,
            adjustment: cumulative,
            writtenBalance: endBalance
          };
          replacement.key = balanceSeedReplaceKey(replacement);
          if (acknowledgedBalanceSeedReplaceKeys && acknowledgedBalanceSeedReplaceKeys.has(replacement.key)) {
            confirmedBalanceSeedReplacements.push(replacement);
          } else {
            pendingBalanceSeedReplacements.push(replacement);
          }
        }
      }
      lastAdjustment = cumulative;
      previousEndBalance = endBalance;
      previousDate = dateLabel;
      billDates.add(dateLabel);
      records.push(balanceTemplateRow(balanceTemplateFields, {
        银行名称: bank.bankName, 所在地: bank.location, 币种: group.currency,
        银行账号: group.merchantId, 账单日期: dateLabel, 期初余额: '',
        期初可用余额: '', 期末余额: endBalance, 期末可用余额: ''
      }));
      seedRecords.push({
        merchantId: group.merchantId, currency: group.currency, billDate: dateLabel, endBalance,
        generationMethod: mode === 'calculated'
          ? BALANCE_SEED_GENERATION_METHODS.calculated
          : BALANCE_SEED_GENERATION_METHODS.statement
      });
    }
  }
  // 全部分组算完后统一询问；抛错发生在写余额表和计算种子之前。
  if (pendingBalanceGaps.length) {
    throw new FileValidationError('BALANCE_GAP_CONFIRM_REQUIRED', BALANCE_GAP_CONFIRM_MESSAGE, {
      context: { templateName, bankName: bank.bankName, gaps: pendingBalanceGaps }
    });
  }
  if (pendingBalanceMismatches.length) {
    throw new FileValidationError('BALANCE_MISMATCH_CONFIRM_REQUIRED', BALANCE_MISMATCH_CONFIRM_MESSAGE, {
      context: { templateName, bankName: bank.bankName, mismatches: pendingBalanceMismatches }
    });
  }
  // 替换人工补录放在最后：余额本身已确认（或相符）后，才问是否覆盖人工补录。
  if (pendingBalanceSeedReplacements.length) {
    throw new FileValidationError('BALANCE_SEED_REPLACE_CONFIRM_REQUIRED', BALANCE_SEED_REPLACE_CONFIRM_MESSAGE, {
      context: { templateName, bankName: bank.bankName, replacements: pendingBalanceSeedReplacements }
    });
  }
  return {
    records,
    billDates: [...billDates].sort(),
    seedRecords,
    skippedBalanceGaps,
    confirmedBalanceMismatches,
    confirmedBalanceSeedReplacements,
    // 已确认替换的种子键（账号@@币种@@日期）：调用方写入后从“见过的人工补录”中去掉。
    confirmedBalanceSeedReplacementKeys: confirmedBalanceSeedReplacements.map(balanceSeedRecordKey)
  };
}

function scanBalanceSeedStatus({ detailRows, templateName }, storageRoot) {
  const indexes = buildFieldIndexMap(detailRows[0] || []);
  const merchantIndex = indexes.get('MerchantId');
  const currencyIndex = indexes.get('Currency');
  const dateIndex = indexes.get('BillDate');
  if (merchantIndex === undefined || dateIndex === undefined) return { total: 0, missing: 0 };
  const earliest = new Map();
  for (const row of detailRows.slice(1)) {
    const merchantId = normalizeCell(row[merchantIndex]);
    const currency = currencyIndex === undefined ? '' : normalizeCell(row[currencyIndex]);
    const parsed = parseDateValue(row[dateIndex]);
    if (!merchantId || !parsed) continue;
    const dateLabel = formatDateLabel(parsed);
    const key = `${merchantId}@@${currency}`;
    if (!earliest.has(key) || dateLabel < earliest.get(key).dateLabel) {
      earliest.set(key, { merchantId, currency, dateLabel });
    }
  }
  const bankName = splitTemplateName(templateName).bankName;
  const missingIndexByKey = new Map();
  let missing = 0;
  for (const [key, account] of earliest) {
    if (!findPreviousBalanceSeed(storageRoot, { bankName, ...account, beforeBillDate: account.dateLabel })) {
      missing += 1;
      missingIndexByKey.set(key, missing);
    }
  }
  return { total: earliest.size, missing, missingIndexByKey };
}

function createGenerationHelpers(options) {
  const storageRoot = path.resolve(options.storageRoot);
  const balanceTemplatePath = path.resolve(options.balanceTemplatePath);
  const artifactPaths = options.artifactPaths;
  const usedKinds = new Set();
  fs.mkdirSync(storageRoot, { recursive: true });
  const helpers = createStatementGenerationHelpers({
    appendLog() { throw new Error('Statement generation system failure'); },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath({ kind, templateName, merchantId, outputTag, dateRangeLabel, internalSuffix }) {
      if (!artifactPaths[kind] || usedKinds.has(kind)) throw new Error(`Unplanned Statement artifact: ${kind}`);
      usedKinds.add(kind);
      const dateLabel = dateRangeLabel || today();
      const displayMerchantId = merchantId && merchantId.length > 4 ? merchantId.slice(-4) : merchantId;
      const fileName = displayMerchantId
        ? `${templateName}-${displayMerchantId}-${outputTag}-${dateLabel}.xlsx`
        : `${templateName}-${outputTag}-${dateLabel}.xlsx`;
      return {
        outputFilePath: artifactPaths[kind],
        outputFileName: fileName,
        internalSuffix
      };
    },
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot: () => storageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    readBalanceSeedRecords,
    getAcknowledgedBalanceGapKeys: options.getAcknowledgedBalanceGapKeys,
    getBalanceTemplatePath: () => balanceTemplatePath,
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    parseRequiredBillDates,
    readBalanceAdjustments,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanBalanceSeedStatus(input, storageRoot),
    splitTemplateName,
    // E09-C Worker is staging-only. Automatic seed persistence remains outside the dormant path
    // until it can join an explicit Main settlement boundary.
    storeGeneratedBalanceSeeds() {},
    writeBalanceWorkbook,
    writeWorkbookRows
  });

  function prepareBalanceGroup(config, preparedBatch, detailExportRows) {
    if (!preparedBatch.balanceRequested) {
      return { requested: false, failed: false, records: [], billDates: [], warnings: [] };
    }
    if (!config.mappingByTargetField.MerchantId) {
      throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
    }
    const effectiveDetailRows = Array.isArray(detailExportRows.sourceRows)
      ? detailExportRows.sourceRows
      : preparedBatch.detailRows;
    let balanceSeedStatus = { missing: 0, missingIndexByKey: new Map() };
    try {
      if (!fs.existsSync(balanceTemplatePath)) {
        throw new FileValidationError('FILE_READ', '未找到余额账单模板，请确认文件已放入 assets 目录');
      }
      const balanceTemplateFields = extractHeaders(balanceTemplatePath);
      if (!balanceTemplateFields.length) {
        throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
      }
      balanceSeedStatus = scanBalanceSeedStatus({
        detailRows: effectiveDetailRows,
        templateName: statementOutputName(config)
      }, storageRoot);
      const templateBankName = splitTemplateName(statementOutputName(config)).bankName;
      const balanceAdjustments = readBalanceAdjustments(storageRoot, templateBankName);
      // 断档“不补录”与余额不一致“确认继续”共用会话确认集合（键以类型前缀区分）。
      const acknowledgedBalanceKeys = typeof options.getAcknowledgedBalanceGapKeys === 'function'
        ? options.getAcknowledgedBalanceGapKeys()
        : null;
      const balanceResult = deriveBalanceRecords({
        detailRows: effectiveDetailRows,
        templateName: statementOutputName(config),
        balanceTemplateFields,
        mode: preparedBatch.balanceMode,
        balanceAdjustments,
        acknowledgedBalanceGapKeys: acknowledgedBalanceKeys,
        acknowledgedBalanceMismatchKeys: acknowledgedBalanceKeys,
        acknowledgedBalanceSeedReplaceKeys: acknowledgedBalanceKeys,
        existingBalanceSeeds: readBalanceSeedRecords(storageRoot, templateBankName),
        resolvePreviousBalanceSeed: ({ bankName, merchantId, currency, targetBillDate, generationMethod }) => (
          findPreviousBalanceSeed(storageRoot, {
            bankName,
            merchantId,
            currency,
            beforeBillDate: targetBillDate,
            generationMethod
          })
        )
      });
      return {
        requested: true,
        failed: false,
        records: balanceResult.records,
        billDates: balanceResult.billDates,
        warnings: [
          ...(balanceResult.skippedBalanceGaps.length
            ? [{ type: 'balance-gap-skipped', gaps: balanceResult.skippedBalanceGaps }]
            : []),
          ...(balanceResult.confirmedBalanceMismatches.length
            ? [{ type: 'balance-mismatch-confirmed', mismatches: balanceResult.confirmedBalanceMismatches }]
            : []),
          ...(balanceResult.confirmedBalanceSeedReplacements.length
            ? [{ type: 'balance-seed-replace-confirmed', replacements: balanceResult.confirmedBalanceSeedReplacements }]
            : [])
        ]
      };
    } catch (error) {
      if (!(error instanceof FileValidationError)) throw error;
      if (error.code === 'BALANCE_GAP_CONFIRM_REQUIRED') {
        return {
          requested: true,
          failed: true,
          records: [],
          billDates: [],
          warnings: [{
            type: 'balance-gap-confirm',
            message: error.message,
            gaps: Array.isArray(error.context?.gaps) ? error.context.gaps : []
          }]
        };
      }
      if (error.code === 'BALANCE_MISMATCH_CONFIRM_REQUIRED') {
        return {
          requested: true,
          failed: true,
          records: [],
          billDates: [],
          warnings: [{
            type: 'balance-mismatch-confirm',
            message: error.message,
            mismatches: Array.isArray(error.context?.mismatches) ? error.context.mismatches : []
          }]
        };
      }
      if (error.code === 'BALANCE_SEED_REPLACE_CONFIRM_REQUIRED') {
        return {
          requested: true,
          failed: true,
          records: [],
          billDates: [],
          warnings: [{
            type: 'balance-seed-replace-confirm',
            message: error.message,
            replacements: Array.isArray(error.context?.replacements) ? error.context.replacements : []
          }]
        };
      }
      if (error.code !== 'BALANCE_SEED_REQUIRED') {
        return {
          requested: true,
          failed: true,
          records: [],
          billDates: [],
          warnings: [{ type: 'balance-generate-failed', message: error.message }]
        };
      }
      const promptMerchantId = normalizeCell(error.context?.merchantId);
      const promptCurrency = normalizeCell(error.context?.currency);
      const promptKey = `${promptMerchantId}@@${promptCurrency}`;
      return {
        requested: true,
        failed: true,
        records: [],
        billDates: [],
        warnings: [{
          type: 'balance-seed-required',
          message: error.message,
          prompt: {
            templateName: statementOutputName(config),
            bankName: error.context?.bankName || splitTemplateName(statementOutputName(config)).bankName,
            merchantId: promptMerchantId,
            currency: promptCurrency,
            targetBillDate: normalizeCell(error.context?.targetBillDate),
            queueIndex: balanceSeedStatus.missingIndexByKey?.get(promptKey) || 1,
            queueTotal: balanceSeedStatus.missing || 1,
            ...(error.context?.seedMismatch
              ? {
                  seedMismatch: {
                    ...error.context.seedMismatch,
                    statementBalances: [...(error.context.seedMismatch.statementBalances || [])]
                  }
                }
              : {})
          }
        }]
      };
    }
  }

  function generateStatementFilesFromGroups({
    groups,
    scope = 'current',
    includeDetail = true,
    includeBalance = false
  }) {
    if (!Array.isArray(groups) || groups.length < 2) {
      throw new TypeError('Grouped Statement generation requires at least two template groups');
    }
    const preparedGroups = groups.map(({ config, fileEntries }) => {
      const preparedBatch = helpers.buildPreparedStatementBatchFromEntries({ config, fileEntries });
      const detailExportRows = buildDetailExportRows(cloneRowsWithMetadata(preparedBatch.detailRows));
      // Reuse the production helper once per template authority for amount rejection,
      // warnings and date validation, without writing an intermediate workbook.
      const baseline = helpers.generateStatementFiles({
        config,
        preparedBatch,
        scope,
        includeDetail: false,
        includeBalance: false
      });
      const balance = includeBalance
        ? prepareBalanceGroup(config, preparedBatch, detailExportRows)
        : { requested: false, failed: false, records: [], billDates: [], warnings: [] };
      return { config, preparedBatch, detailExportRows, baseline, balance };
    });

    const warnings = preparedGroups.flatMap(({ baseline, balance }) => [
      ...(baseline.warnings || []),
      ...balance.warnings
    ]);
    const result = {
      detail: null,
      balance: null,
      message: '',
      warnings,
      balanceRequested: preparedGroups.some(({ preparedBatch }) => preparedBatch.balanceRequested),
      unmatchedAmountSplitFiles: preparedGroups.flatMap(
        ({ baseline }) => baseline.unmatchedAmountSplitFiles || []
      ),
      unmatchedBillSplitFiles: preparedGroups.flatMap(
        ({ baseline }) => baseline.unmatchedBillSplitFiles || []
      )
    };

    if (includeDetail) {
      const header = preparedGroups[0].detailExportRows[0] || [];
      if (preparedGroups.some(({ detailExportRows }) =>
        JSON.stringify(detailExportRows[0] || []) !== JSON.stringify(header))) {
        throw new FileValidationError(
          'FILE_READ',
          '按文件名匹配的模板导出字段不一致，无法生成同一明细账单'
        );
      }
      const rows = [header.slice()];
      for (const { detailExportRows } of preparedGroups) {
        rows.push(...detailExportRows.slice(1).map((row) => row.slice()));
      }
      writeWorkbookRows({ rows, outputFilePath: artifactPaths.detail });
      result.detail = {
        filePath: artifactPaths.detail,
        fileName: path.basename(artifactPaths.detail),
        templateName: statementOutputName(preparedGroups[0].config)
      };
    }

    if (includeBalance) {
      const requestedGroups = preparedGroups.filter(({ balance }) => balance.requested);
      if (requestedGroups.length > 0 && requestedGroups.every(({ balance }) => !balance.failed)) {
        const records = requestedGroups.flatMap(({ balance }) => balance.records);
        const balanceTemplateFields = extractHeaders(balanceTemplatePath);
        writeBalanceWorkbook({
          templateFilePath: balanceTemplatePath,
          records,
          templateFields: balanceTemplateFields,
          outputFilePath: artifactPaths.balance
        });
        result.balance = {
          filePath: artifactPaths.balance,
          fileName: path.basename(artifactPaths.balance),
          templateName: statementOutputName(preparedGroups[0].config)
        };
      }
    }

    if (result.detail && result.balance) result.message = '明细账单可导出，余额账单可导出';
    else if (result.detail) result.message = '明细账单可导出';
    else if (result.balance) result.message = '余额账单可导出';
    return result;
  }

  return Object.freeze({ ...helpers, generateStatementFilesFromGroups });
}

module.exports = {
  buildDateRangeLabel,
  buildFieldIndexMap,
  createGenerationHelpers,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus
};
