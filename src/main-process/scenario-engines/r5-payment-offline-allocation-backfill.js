// v3.1.7 Payment 线下调拨回填引擎（资金红线）。
// 输入改为调拨对账单派生行；Payment 先消费 FundTransfer-in，R5s2-recon 再消费剩余派生行。

const {
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');
const { toDate } = require('./engine-date-utils');
const { weekTag, parseFtaDate } = require('./engine-week-utils');
const { PAYMENT_OFFLINE_FIELD_MAP: F } = require('../../constants/payment-offline-allocation-fields');
const {
  FUND_TRANSFER_RECON_USED,
  FUND_TRANSFER_RECON_UNUSED
} = require('../../constants/fund-transfer-recon-fields');
const { parsePaymentBigAccounts } = require('../../shared/payment-big-accounts');

const RECON = F.recon;
const MS_PER_DAY = 86400000;
const {
  txLagToleranceDays: TX_LAG_TOLERANCE_DAYS,
  relaxedWindowDays: RELAXED_WINDOW_DAYS
} = F.MATCH_RULES;

class PaymentOfflinePreflightError extends Error {
  constructor(code, message, detailLines = []) {
    super(message);
    this.name = 'PaymentOfflinePreflightError';
    this.code = code;
    this.detailLines = Array.isArray(detailLines) ? detailLines : [];
  }
}

function bankCreditAmount(bankRow) {
  return parseNumber(bankRow && bankRow[F.bank.creditAmount]);
}

function reconAmount(reconRow) {
  return parseNumber(reconRow && reconRow[RECON.amount]);
}

function amountEqual(reconRow, bankRow) {
  const bankAmount = bankCreditAmount(bankRow);
  const sourceAmount = reconAmount(reconRow);
  if (!Number.isFinite(bankAmount) || !Number.isFinite(sourceAmount)) return false;
  return Math.round(bankAmount * 100) === Math.round(sourceAmount * 100);
}

function amountCurrencyEqual(reconRow, bankRow) {
  return amountEqual(reconRow, bankRow)
    && valuesEqual(reconRow && reconRow[RECON.currency], bankRow && bankRow[F.bank.currency]);
}

function dayMs(value) {
  const date = toDate(value);
  return date ? date.getTime() : null;
}

function billDateNotEarlier(bankRow, reconRow) {
  const bankDate = dayMs(bankRow && bankRow[F.bank.billDate]);
  const txDate = dayMs(reconRow && reconRow[RECON.txTime]);
  return bankDate !== null && txDate !== null && bankDate >= txDate;
}

function billDateWithinLag(bankRow, reconRow, toleranceDays) {
  const bankDate = dayMs(bankRow && bankRow[F.bank.billDate]);
  const txDate = dayMs(reconRow && reconRow[RECON.txTime]);
  return bankDate !== null
    && txDate !== null
    && bankDate >= txDate - toleranceDays * MS_PER_DAY;
}

function billDateWithinWindow(bankRow, reconRow, windowDays) {
  const bankDate = dayMs(bankRow && bankRow[F.bank.billDate]);
  const txDate = dayMs(reconRow && reconRow[RECON.txTime]);
  return bankDate !== null
    && txDate !== null
    && Math.abs(bankDate - txDate) <= windowDays * MS_PER_DAY;
}

function dayDiffAbs(bankRow, reconRow) {
  const bankDate = dayMs(bankRow && bankRow[F.bank.billDate]);
  const txDate = dayMs(reconRow && reconRow[RECON.txTime]);
  if (bankDate === null || txDate === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bankDate - txDate) / MS_PER_DAY));
}

function dayDiffSigned(bankRow, reconRow) {
  const bankDate = dayMs(bankRow && bankRow[F.bank.billDate]);
  const txDate = dayMs(reconRow && reconRow[RECON.txTime]);
  if (bankDate === null || txDate === null) return null;
  return Math.round((bankDate - txDate) / MS_PER_DAY);
}

function startOfIsoWeek(value) {
  const date = toDate(value);
  if (!date) return null;
  const isoDay = date.getDay() === 0 ? 7 : date.getDay();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - (isoDay - 1));
}

function plusCalendarDays(value, days) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDateLabel(value) {
  const date = toDate(value);
  if (!date) return normalizeCellValue(value);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function validateReconSchema(reconRows) {
  const requiredFields = Object.values(RECON);
  const invalidRows = [];
  reconRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      invalidRows.push(`派生行 ${index + 1} 不是对象`);
      return;
    }
    const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(row, field));
    if (missing.length > 0) {
      invalidRows.push(`派生行 ${index + 1} 缺少字段：${missing.join('、')}`);
    }
  });
  if (invalidRows.length > 0) {
    throw new PaymentOfflinePreflightError(
      'payment-offline-recon-schema-invalid',
      '调拨对账单派生结构不完整，请重新导入中台调拨订单后再运行',
      invalidRows.slice(0, 20)
    );
  }
}

function buildOrderWeekGroups(entries) {
  const byWeek = new Map();
  for (const entry of entries) {
    const tag = weekTag(entry.ftaDate);
    const weekStart = startOfIsoWeek(entry.ftaDate);
    if (!tag || !weekStart) continue;
    if (!byWeek.has(tag)) {
      byWeek.set(tag, {
        weekTag: tag,
        weekStart,
        boundaryDate: entry.ftaDate,
        entries: []
      });
    }
    const group = byWeek.get(tag);
    group.entries.push(entry);
    if (entry.ftaDate.getTime() < group.boundaryDate.getTime()) {
      group.boundaryDate = entry.ftaDate;
    }
  }

  const groups = [...byWeek.values()].sort(
    (left, right) => left.weekStart.getTime() - right.weekStart.getTime()
  );

  for (let index = 1; index < groups.length; index += 1) {
    const expectedWeekStart = plusCalendarDays(groups[index - 1].weekStart, 7);
    if (!expectedWeekStart || weekTag(expectedWeekStart) !== groups[index].weekTag) {
      throw new PaymentOfflinePreflightError(
        'payment-offline-order-week-gap',
        'Payment线下调拨订单周存在断档，本次运行已阻断',
        [`${groups[index - 1].weekTag} 后紧接 ${groups[index].weekTag}，请补齐缺失订单周`]
      );
    }
  }

  groups.forEach((group, index) => {
    if (index === 0) {
      group.rangeStart = plusCalendarDays(group.weekStart, -7);
      group.rangeEndExclusive = group.weekStart;
      return;
    }
    group.rangeStart = groups[index - 1].boundaryDate;
    group.rangeEndExclusive = group.boundaryDate;
  });

  return groups;
}

function findGroupForBankDate(groups, value) {
  const timestamp = dayMs(value);
  if (timestamp === null) return null;
  return groups.find((group) => (
    timestamp >= group.rangeStart.getTime()
      && timestamp < group.rangeEndExclusive.getTime()
  )) || null;
}

function resetFundTransferReconUsage(reconRows) {
  const safeRows = Array.isArray(reconRows) ? reconRows : [];
  for (const row of safeRows) {
    if (row && typeof row === 'object') row[RECON.used] = FUND_TRANSFER_RECON_UNUSED;
  }
  return safeRows;
}

/**
 * @returns {{ modifications: Array, warnings: Array, matchedPairs: Array, usedBankRowIds: Set }}
 */
function runRound5PaymentOfflineAllocationBackfill(bankRows, reconRows, options = {}) {
  const warningCollector = makeWarningCollector(
    'r5-payment-offline-allocation-backfill',
    'Payment线下调拨订单回填处理'
  );
  const modCollector = makeModificationCollector();
  const matchedPairs = [];
  const usedBankRowIds = new Set();
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeReconRows = Array.isArray(reconRows) ? reconRows : [];

  const emptyResult = () => ({
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    matchedPairs,
    usedBankRowIds
  });

  const bankChannel = normalizeCellValue(options.bankChannel);
  const region = normalizeCellValue(options.region);
  const parsedBigAccounts = parsePaymentBigAccounts(options.bigAccount);
  if (!parsedBigAccounts.ok) {
    warningCollector.push({
      rowId: null,
      code: 'payment-offline-invalid-big-account-config',
      message: `Payment线下调拨大账号配置无效：${parsedBigAccounts.message}`
    });
    return emptyResult();
  }
  if (bankChannel === '' || region === '') {
    warningCollector.push({
      rowId: null,
      code: 'payment-offline-config-incomplete',
      message: 'Payment线下调拨配置缺少银行渠道或地区，本轮已安全跳过'
    });
    return emptyResult();
  }
  if (safeReconRows.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'payment-offline-no-eligible-recon-row',
      message: '调拨对账单为空，没有可供Payment匹配的FundTransfer-in派生行'
    });
    return emptyResult();
  }

  validateReconSchema(safeReconRows);
  const bigAccountSet = new Set(parsedBigAccounts.accounts);
  const preflightEntries = [];
  const invalidFtaRows = [];

  safeReconRows.forEach((reconRow, sourceIndex) => {
    if (normalizeCellValue(reconRow[RECON.used]) === FUND_TRANSFER_RECON_USED) return;
    if (normalizeCellValue(reconRow[RECON.fundType]) !== F.FUND_TYPE_IN) return;
    if (normalizeCellValue(reconRow[RECON.payMethod]) !== F.OFFLINE_PAY_METHOD) return;
    if (normalizeCellValue(reconRow[RECON.receiveChannel]) !== bankChannel) return;
    const account = normalizeCellValue(reconRow[RECON.bigAccount]);
    if (!bigAccountSet.has(account)) return;

    const ftaDate = parseFtaDate(reconRow[RECON.dispatchNo]);
    if (!ftaDate) {
      invalidFtaRows.push(
        `调拨单号=${normalizeCellValue(reconRow[RECON.dispatchNo]) || '(空)'} 无法解析 FTA 日期`
      );
      return;
    }
    preflightEntries.push({ reconRow, sourceIndex, account, ftaDate });
  });

  if (invalidFtaRows.length > 0) {
    throw new PaymentOfflinePreflightError(
      'payment-offline-invalid-fta',
      'Payment线下调拨候选存在非法调拨单号，本次运行已阻断',
      invalidFtaRows.slice(0, 20)
    );
  }
  if (preflightEntries.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'payment-offline-no-eligible-recon-row',
      message: '调拨对账单中没有满足Payment线下配置的FundTransfer-in派生行'
    });
    return emptyResult();
  }

  const weekGroups = buildOrderWeekGroups(preflightEntries);
  const matchableEntries = [];
  for (const entry of preflightEntries) {
    const reconId = normalizeCellValue(entry.reconRow[RECON.reconId]);
    if (reconId === '') {
      warningCollector.push({
        rowId: null,
        code: 'payment-offline-empty-recon-id',
        message: `调拨单号=${normalizeCellValue(entry.reconRow[RECON.dispatchNo])} 的ReconID为空，已跳过且未占用银行行`
      });
      continue;
    }
    const payAccount = normalizeCellValue(entry.reconRow[RECON.payAccount]);
    if (payAccount === '') {
      warningCollector.push({
        rowId: null,
        code: 'payment-offline-empty-pay-account',
        message: `调拨单号=${normalizeCellValue(entry.reconRow[RECON.dispatchNo])} 的付款账号为空，已跳过`
      });
      continue;
    }
    matchableEntries.push({ ...entry, payAccount });
  }
  if (matchableEntries.length === 0 || safeBankRows.length === 0) return emptyResult();

  const excludeSet = options.excludeBankRowIds instanceof Set
    ? options.excludeBankRowIds
    : new Set(Array.isArray(options.excludeBankRowIds) ? options.excludeBankRowIds : []);
  const bankOriginalIndex = new Map();
  safeBankRows.forEach((row, index) => bankOriginalIndex.set(row, index));

  const bankPool = safeBankRows.filter((bankRow) => {
    if (excludeSet.has(bankRow && bankRow._rowId)) return false;
    if (!bigAccountSet.has(normalizeCellValue(bankRow && bankRow[F.bank.merchantId]))) return false;
    if (normalizeCellValue(bankRow && bankRow[F.bank.fundType]) !== F.FUND_TYPE_IN) return false;
    return normalizeCellValue(bankRow && bankRow[F.bank.region]) === region;
  });

  const orderedBankRows = [...bankPool].sort((left, right) => {
    const leftDate = dayMs(left && left[F.bank.billDate]);
    const rightDate = dayMs(right && right[F.bank.billDate]);
    return (leftDate ?? Number.POSITIVE_INFINITY) - (rightDate ?? Number.POSITIVE_INFINITY)
      || (bankOriginalIndex.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (bankOriginalIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
  });

  const fieldsEqual = (entry, bankRow) => {
    const bankAccount = normalizeCellValue(bankRow && bankRow[F.bank.merchantId]);
    const draweeCardNo = normalizeCellValue(bankRow && bankRow[F.bank.draweeCardNo]);
    return entry.account !== ''
      && entry.account === bankAccount
      && entry.payAccount !== ''
      && draweeCardNo !== ''
      && entry.payAccount === draweeCardNo
      && amountCurrencyEqual(entry.reconRow, bankRow);
  };

  const backfill = (entry, bankRow, round, group) => {
    const bankRowOriginal = { ...bankRow };
    usedBankRowIds.add(bankRow._rowId);
    entry.reconRow[RECON.used] = FUND_TRANSFER_RECON_USED;
    const newValue = normalizeCellValue(entry.reconRow[RECON.reconId]);
    const oldValue = normalizeCellValue(bankRow[F.bank.reconciliationId]);
    if (oldValue !== newValue) {
      bankRow[F.bank.reconciliationId] = newValue;
      modCollector.record(bankRow._rowId, F.bank.reconciliationId, oldValue, newValue);
    }
    matchedPairs.push({
      bankRow,
      bankRowOriginal,
      reconRow: entry.reconRow,
      round,
      oldReconciliationId: oldValue,
      dayDiff: dayDiffSigned(bankRow, entry.reconRow),
      orderWeek: weekTag(entry.ftaDate),
      intervalStart: group ? group.rangeStart : null,
      intervalEndExclusive: group ? group.rangeEndExclusive : null
    });
  };

  const runRound = (round, candidateOf) => {
    for (const bankRow of orderedBankRows) {
      if (usedBankRowIds.has(bankRow._rowId)) continue;
      const candidates = candidateOf(bankRow)
        .filter((entry) => normalizeCellValue(entry.reconRow[RECON.used]) !== FUND_TRANSFER_RECON_USED)
        .sort((left, right) => (
          dayDiffAbs(bankRow, left.reconRow) - dayDiffAbs(bankRow, right.reconRow)
            || left.sourceIndex - right.sourceIndex
        ));
      if (candidates.length === 0) continue;
      if (candidates.length > 1) {
        warningCollector.push({
          rowId: bankRow._rowId,
          code: 'payment-offline-multi-candidate',
          phase: round,
          message: `银行行匹配到 ${candidates.length} 条可用调拨派生候选（${round}），按日期差和派生原序取第一条`
        });
      }
      const chosen = candidates[0];
      const group = round === 'relaxed-week'
        ? null
        : weekGroups.find((item) => item.weekTag === weekTag(chosen.ftaDate));
      backfill(chosen, bankRow, round, group);
    }
  };

  runRound('main', (bankRow) => {
    const group = findGroupForBankDate(weekGroups, bankRow[F.bank.billDate]);
    if (!group) return [];
    return matchableEntries.filter((entry) => (
      weekTag(entry.ftaDate) === group.weekTag
        && fieldsEqual(entry, bankRow)
        && billDateNotEarlier(bankRow, entry.reconRow)
    ));
  });

  runRound('date-tolerance', (bankRow) => {
    const group = findGroupForBankDate(weekGroups, bankRow[F.bank.billDate]);
    if (!group) return [];
    return matchableEntries.filter((entry) => (
      weekTag(entry.ftaDate) === group.weekTag
        && fieldsEqual(entry, bankRow)
        && billDateWithinLag(bankRow, entry.reconRow, TX_LAG_TOLERANCE_DAYS)
    ));
  });

  runRound('relaxed-week', (bankRow) => matchableEntries.filter((entry) => (
    fieldsEqual(entry, bankRow)
      && billDateWithinWindow(bankRow, entry.reconRow, RELAXED_WINDOW_DAYS)
  )));

  for (const bankRow of orderedBankRows) {
    if (usedBankRowIds.has(bankRow._rowId)) continue;
    warningCollector.push({
      rowId: bankRow._rowId,
      code: 'payment-offline-no-order-match',
      phase: 'relaxed-week',
      message: '银行行（Payment线下调拨）三轮后未匹配到符合账户、金额币种和日期规则的调拨派生行'
    });
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    matchedPairs,
    usedBankRowIds
  };
}

module.exports = {
  runRound5PaymentOfflineAllocationBackfill,
  PaymentOfflinePreflightError,
  resetFundTransferReconUsage,
  buildOrderWeekGroups,
  findGroupForBankDate,
  amountEqual,
  amountCurrencyEqual,
  billDateNotEarlier,
  billDateWithinLag,
  billDateWithinWindow,
  bankCreditAmount,
  reconAmount,
  localDateLabel
};
