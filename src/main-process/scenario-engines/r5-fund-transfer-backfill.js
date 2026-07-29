// v2.1.16-beta.2 R5 场景2「中台调拨订单对账ID回填」引擎（🔴 资金红线）
// PRD §四 需求 2（R2.1~R2.6） / TECH_DESIGN §5.3 / §4（跨表字段映射）
//
// 业务语义：
//   网关 TradeType=FundTransfer-out 行 ↔ 第四轮（R4）处理过的银行 FundType=FundTransfer-out 行；
//   FundTransfer-in 同逻辑（两方向各自独立跑，互不串池）。命中 → 把网关 reconciliationid
//   回填进银行 ReconciliationId（标黄 ReconciliationId 列）。
//
// 跨表字段（显式映射，绝不假设同名 —— TECH_DESIGN §4）：
//   网关（gateway-bill，真实表头）：
//     gw.TradeType            交易类型（用于按 direction 过滤）
//     gw.merchantid（小写）    商户 ID
//     gw.currency（小写）      币种
//     gw.amount（小写，单列）  金额（含正负方向，本场景取绝对值）
//     gw.Billdate            账单日期
//     gw.reconciliationid（小写） 对账 ID（回填的来源）
//   银行（bank statement，驼峰）：
//     bank.FundType                  资金性质（R4 后的当前值，用于按 direction 过滤）
//     bank.MerchantId（驼峰）        商户 ID
//     bank.Currency                  币种
//     bank['Credit Amount'] + bank['Debit Amount']（双列） 发生额
//     bank['Extra Fee']             有符号手续费（空值按 0）
//     bank.BillDate                  账单日期
//     bank.ReconciliationId          对账 ID（回填的目标）
//     bank._rowId                    行唯一键（上游注入，全局唯一）
//
// 金额比对口径（🔴 v3.0.26 Extra Fee）：
//   银行匹配金额     = |（Credit Amount || 0） − （Debit Amount || 0）| + signed Extra Fee
//   网关金额绝对值   = |amount|
//   amountEqual = 先加总，再 Math.round(金额*100) 精确到分比较，容差 0；合计后不再取绝对值。
//   Extra Fee 空值按 0；非空非法值使该银行行退出 R5，并产生一次可见 warning。
//   —— bankAmountAbs 保留旧口径，只供 DBS-Charge 等旧调用方继续复用，不得并入 Extra Fee。
//
// 日期两阶段（🔴 PRD R2.4「优先同日」是硬约束）：
//   Phase1：严格同日（sameDay）。先把所有 gw 跑完，消费掉同日命中的银行行。
//   Phase2：仅 Phase1 未命中的 gw，对未被消费的银行行用 ±dateToleranceDays（dayDiffWithin）再匹配。
//   日期解析复用 engine-date-utils 的 sameDay / dayDiffWithin（内部走 normalizeDateExportValue，勿自写解析）。
//
// 严格 1v1：usedBankRowId 单向消费（每个 direction 独立一份），一条银行行最多被一条网关行回填。
// 多候选 tie-break：同日优先（Phase 分离已保证）→ 银行行原序最前（cand 保持 bankPool 顺序，取 cand[0]）+ warning。
//
// ⚠️ 资金红线：金额归分错误或日期 ±1day 配错会写错 ReconciliationId（资金对账ID错配，下游影响大）。

const {
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber
} = require('./engine-utils');

const { sameDay, dayDiffWithin, toDate } = require('./engine-date-utils');
const { validateBankDirection } = require('./bank-direction-validator');
const {
  normalizeFundTransferDatePolicy,
  validateFundTransferDirections
} = require('./fund-transfer-engine-policy');

const MS_PER_DAY = 86400000;

const BANK_EXTRA_FEE_FIELD = 'Extra Fee';
const INVALID_EXTRA_FEE_WARNING_CODE = 'r5-invalid-extra-fee';
const INVALID_DIRECTIONS_WARNING_CODE = 'r5-fund-transfer-directions-invalid';
const DIRECTION_MISMATCH_WARNING_CODE = 'fund-transfer-direction-mismatch';
const DATE_MISMATCH_WARNING_CODE = 'fund-transfer-date-mismatch';

// 银行发生额绝对值 = |（Credit Amount || 0） − （Debit Amount || 0）|
//   credit / debit 任一非数值按 0 计（与 C3 getBankRowValueForC3 一致）；两者皆非数值 → 仍返回 0（非 null）
//   —— 与 amountEqual 配合：网关侧若非数值会先被判非有限数而整体不命中。
function bankAmountAbs(bankRow) {
  const credit = parseNumber(bankRow && bankRow['Credit Amount']) || 0;
  const debit = parseNumber(bankRow && bankRow['Debit Amount']) || 0;
  return Math.abs(credit - debit);
}

function isEmptyAmountValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// R5 银行匹配金额 = 旧发生额绝对值 + signed Extra Fee。
//   🔴 顺序固定：先加总，调用方再按现有分精度比较；合计后不得再次 Math.abs。
//   空 fee=0；非空非法 fee 返回 NaN，供 R5 两种来源和多对多审计统一 fail closed。
function bankAmountWithExtraFee(bankRow) {
  const rawExtraFee = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  if (isEmptyAmountValue(rawExtraFee)) return bankAmountAbs(bankRow);
  const extraFee = parseNumber(rawExtraFee);
  if (extraFee === null) return NaN;
  return bankAmountAbs(bankRow) + extraFee;
}

function hasInvalidExtraFee(bankRow) {
  const rawExtraFee = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  return !isEmptyAmountValue(rawExtraFee) && parseNumber(rawExtraFee) === null;
}

function createInvalidExtraFeeWarning(bankRow) {
  const rowId = bankRow && bankRow._rowId;
  const rawValue = bankRow && bankRow[BANK_EXTRA_FEE_FIELD];
  return {
    rowId,
    code: INVALID_EXTRA_FEE_WARNING_CODE,
    field: BANK_EXTRA_FEE_FIELD,
    rawValue,
    context: {
      rowId,
      field: BANK_EXTRA_FEE_FIELD,
      rawValue
    },
    message: `银行行 Extra Fee 原始值「${String(rawValue)}」不是合法金额，已退出 R5 调拨回填与多对多审计，请人工核对`
  };
}

// 非法 Extra Fee warning 去重：稳定 _rowId 优先；无有效 _rowId 时才按银行对象身份。
// 返回函数仅在首次看到该行时返回 true，供两条 R5 来源共享相同的“一行一次”口径。
function makeInvalidExtraFeeWarningDeduper() {
  const warnedRowIds = new Set();
  const warnedRowsWithoutId = new Set();
  return (bankRow) => {
    const rowId = normalizeCellValue(bankRow && bankRow._rowId);
    if (rowId !== '') {
      if (warnedRowIds.has(rowId)) return false;
      warnedRowIds.add(rowId);
      return true;
    }
    if (warnedRowsWithoutId.has(bankRow)) return false;
    warnedRowsWithoutId.add(bankRow);
    return true;
  };
}

// 网关金额绝对值 = |amount|；amount 非数值 → NaN（→ amountEqual 判非有限数 → 不命中）
function gwAmountAbs(gwRow) {
  const n = parseNumber(gwRow && gwRow.amount);
  return Math.abs(n ?? NaN);
}

// DBS-Charge 兼容口径：银行 |Credit-Debit| ↔ 网关 |amount|，精确到分；明确忽略 Extra Fee。
//   🔴 DBS step2 必须使用本函数，不能复用 R5 含手续费的 amountEqual。
function bankAmountEqualWithoutExtraFee(gwRow, bankRow) {
  const bankAbs = bankAmountAbs(bankRow);
  const gwAbs = gwAmountAbs(gwRow);
  if (!Number.isFinite(bankAbs) || !Number.isFinite(gwAbs)) return false;
  return Math.round(bankAbs * 100) === Math.round(gwAbs * 100);
}

// R5 银行匹配金额与网关金额精确到分比对（🔴 v3.0.26，容差 0）
//   两侧都必须是有限数；否则不命中（防 NaN 误判相等）
function amountEqual(gwRow, bankRow) {
  const bankAmount = bankAmountWithExtraFee(bankRow);
  const gwAbs = gwAmountAbs(gwRow);
  if (!Number.isFinite(bankAmount) || !Number.isFinite(gwAbs)) return false;
  return Math.round(bankAmount * 100) === Math.round(gwAbs * 100);
}

function dateMismatchReason(counterpartDateValue, bankDateValue) {
  if (!toDate(counterpartDateValue)) return 'counterpart-date-invalid';
  if (!toDate(bankDateValue)) return 'bank-date-invalid';
  return 'outside-tolerance';
}

/**
 * R5 场景2：FundTransfer 回填 ReconciliationId。
 *
 * @param {Array<Object>} gwRows   网关对账单行（链接表读回，真实小写表头）
 * @param {Array<Object>} bankRows R4 后的银行对账单行（带 _rowId，FundType/ReconciliationId 可能已被前序轮次改写）
 * @param {Object} [options]
 * @param {Array<{gwTradeType:string,bankFundType:string}>} [options.directions] 双方向定义（默认 out/in）
 * @param {number} [options.dateToleranceDays] Phase2 日期容差天数（默认 1）
 * @returns {{ modifications: Array, warnings: Array, usedBankRowIds: Set }}
 *   modifications：实际改写 ReconciliationId 的行（{ rowId, column:'ReconciliationId', oldValue, newValue }），用于标黄
 *   warnings：multi-bank-match-backfill / r5-invalid-extra-fee
 *   usedBankRowIds：引擎内 1v1 消费的全部 bank _rowId 集合（🔴 v3.0.4 块 F 新增 additive 字段）——
 *     **含「消费但未写」行**（nv 空 / 与原值相同 → 不 record 不标黄，但仍 usedBankRowId.add 占用）。
 *     用于编排器把已被 R5s2 消费的银行行经 excludeBankRowIds 传 R5s2b 剔除（网关回填优先互斥）。
 *     与 modifications 的区别：modifications 仅「实写过」行（同值未写行取不到），usedBankRowIds 是完整消费集。
 */
function runRound5FundTransferBackfill(gwRows, bankRows, options = {}) {
  const warningCollector = makeWarningCollector('r5-fund-transfer-backfill', '中台调拨订单对账ID回填');
  const modCollector = makeModificationCollector();
  // 🔴 v3.0.4 块 F：跨 direction 聚合的消费集合（含同值未写行），作为新返回字段供 R5s2b 剔除。
  const consumedBankRowIds = new Set();
  // v3.0.26：稳定 _rowId 优先去重；无 _rowId 才按对象身份，保证非法 fee 银行行只告警一次。
  const shouldEmitInvalidExtraFeeWarning = makeInvalidExtraFeeWarningDeduper();

  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];

  const directionsValidation = validateFundTransferDirections(options.directions, {
    allowDefault: !Object.prototype.hasOwnProperty.call(options, 'directions')
  });
  if (!directionsValidation.ok) {
    warningCollector.push({
      rowId: null,
      engine: 'r5-fund-transfer-backfill',
      code: INVALID_DIRECTIONS_WARNING_CODE,
      reason: directionsValidation.reason,
      message: `R5 调拨回填 directions 配置非法，整轮已失败关闭：${directionsValidation.reason}`
    });
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      usedBankRowIds: consumedBankRowIds
    };
  }
  const directions = directionsValidation.directions;
  const datePolicy = normalizeFundTransferDatePolicy(options);
  const dateToleranceDays = datePolicy.toleranceDays;

  // 无银行行 → 直接返回；无网关行时仍遍历方向银行池，以保证非法 Extra Fee warning 不被早退吞掉。
  if (safeBankRows.length === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      usedBankRowIds: consumedBankRowIds
    };
  }

  // 对账字段全等：非空 merchantid↔MerchantId、非空 currency↔Currency
  //   + (|Credit-Debit| + signed Extra Fee) 先加总后精确到分。
  const fieldEq = (gw, bank) => {
    const gwMerchantId = normalizeCellValue(gw && gw.merchantid);
    const bankMerchantId = normalizeCellValue(bank && bank.MerchantId);
    const gwCurrency = normalizeCellValue(gw && gw.currency);
    const bankCurrency = normalizeCellValue(bank && bank.Currency);
    return (
      gwMerchantId !== '' &&
      bankMerchantId !== '' &&
      gwMerchantId === bankMerchantId &&
      gwCurrency !== '' &&
      bankCurrency !== '' &&
      gwCurrency === bankCurrency &&
      amountEqual(gw, bank)
    );
  };

  const warnedCandidateFailures = new Set();
  const warnDirectionFailure = (bankRow, expectedDirection, result) => {
    const key = `direction\u0000${String(bankRow && bankRow._rowId)}\u0000${expectedDirection}\u0000${result.code}`;
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: DIRECTION_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason: result.code,
      message: `R5 网关调拨近似候选银行行(${bankRow && bankRow._rowId})未通过 ${expectedDirection} 方向校验（${result.code}），未进入可写候选`
    });
  };
  const warnDateFailure = (gw, bankRow, expectedDirection) => {
    const reason = dateMismatchReason(gw && gw.Billdate, bankRow && bankRow.BillDate);
    // 同账号/币种/金额密集组可能形成 N 来源 × M 银行的日期失败边；warning 不含来源身份，
    // 按 sourceIndex 保留只会制造 N×M 条不可区分的重复告警。每个具体银行行 / 方向 /
    // 原因只报一次；bankOriginalIndex 在 _rowId 缺失或重复时仍保持银行行级区分。
    const key = [
      'date',
      bankOriginalIndex.get(bankRow) ?? '',
      String(bankRow && bankRow._rowId),
      expectedDirection,
      reason
    ].join('\u0000');
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow._rowId,
      engine: 'r5-fund-transfer-backfill',
      code: DATE_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason,
      message: `R5 网关调拨近似候选银行行(${bankRow && bankRow._rowId})未通过日期策略（${reason}），未进入可写候选`
    });
  };
  const bankOriginalIndex = new Map();
  safeBankRows.forEach((row, index) => {
    if (!bankOriginalIndex.has(row)) bankOriginalIndex.set(row, index);
  });

  // 命中回填：把网关 reconciliationid 写入银行 ReconciliationId（命中即覆盖，含非空原值；reconid-overwrite-backfill 告警已移除，覆盖行为不变）
  //   cand 已保证非空且按 bankPool 顺序；tie-break 取 cand[0]（原序最前）
  const backfill = (gw, cand, phase, usedBankRowId) => {
    if (cand.length === 0) return; // 未命中，静默（编排器层面再统计未命中）
    if (cand.length > 1) {
      warningCollector.push({
        rowId: cand[0]._rowId,
        code: 'multi-bank-match-backfill',
        phase,
        message: `网关调拨单在银行对账单中匹配到 ${cand.length} 行可用候选（${phase}），取原序最前一条（数据脏）`
      });
    }

    const chosen = cand[0];
    usedBankRowId.add(chosen._rowId); // 严格 1v1 单向消费

    const nv = normalizeCellValue(gw && gw.reconciliationid);
    const old = normalizeCellValue(chosen.ReconciliationId);
    if (nv !== '' && old !== nv) {
      // 命中即覆盖（含非空原值）；按需求移除 reconid-overwrite-backfill 告警，覆盖行为不变。
      chosen.ReconciliationId = nv;
      modCollector.record(chosen._rowId, 'ReconciliationId', old, nv);
    }
    // nv 为空（网关无 reconid）或与原值相同 → 不写、不标黄，但仍已消费该银行行（1v1 红线不变）
  };

  // 每个 direction 独立跑：独立 gwPool / bankPool / usedBankRowId（两方向不串池）
  for (const dir of directions) {
    // F1（🔴 P1）：仅保留 reconciliationid 非空的网关行 —— 空 reconid 无可回填，
    //   若放进 gwPool 会在 backfill 里先 usedBankRowId.add 消费掉银行行（「不写但占用」），
    //   挡住后续有效网关行回填。空 reconid 不进池 → 不参与匹配、不消费 usedBankRowId。
    const gwPool = safeGwRows.filter(
      (g) =>
        normalizeCellValue(g && g.TradeType) === dir.gwTradeType &&
        normalizeCellValue(g && g.reconciliationid) !== ''
    );
    const bankPool = safeBankRows.filter((b) => {
      if (normalizeCellValue(b && b.FundType) !== dir.bankFundType) return false;
      if (!hasInvalidExtraFee(b)) return true;
      if (shouldEmitInvalidExtraFeeWarning(b)) {
        warningCollector.push(createInvalidExtraFeeWarning(b));
      }
      return false;
    });
    const usedBankRowId = new Set();
    const directionEligibleCandidates = (sourceRow) => {
      const nearCandidates = bankPool.filter(
        (b) => !usedBankRowId.has(b._rowId) && fieldEq(sourceRow, b)
      );
      const eligible = [];
      for (const bankRow of nearCandidates) {
        const directionResult = validateBankDirection(bankRow, dir.expectedBankDirection);
        if (directionResult.ok) {
          eligible.push(bankRow);
        } else {
          warnDirectionFailure(bankRow, dir.expectedBankDirection, directionResult);
        }
      }
      return eligible;
    };

    if (!datePolicy.enabled) {
      for (const gw of gwPool) {
        backfill(gw, directionEligibleCandidates(gw), 'date-disabled', usedBankRowId);
      }
      for (const consumedRowId of usedBankRowId) consumedBankRowIds.add(consumedRowId);
      continue;
    }

    // ===== Phase1：严格同日 —— 先把所有 gw 跑完，消费掉同日命中（保证「优先同日」硬约束）=====
    //   记录 Phase1 未命中的 gw（cand 为空），留给 Phase2 用 ±tolerance 再匹配。
    const unmatchedAfterPhase1 = [];
    for (const gw of gwPool) {
      const directionEligible = directionEligibleCandidates(gw);
      for (const bankRow of directionEligible) {
        if (!dayDiffWithin(gw && gw.Billdate, bankRow.BillDate, dateToleranceDays)) {
          warnDateFailure(gw, bankRow, dir.expectedBankDirection);
        }
      }
      const cand = directionEligible.filter(
        (b) => sameDay(gw && gw.Billdate, b.BillDate)
      );
      if (cand.length === 0) {
        unmatchedAfterPhase1.push(gw);
        continue;
      }
      backfill(gw, cand, 'same-day', usedBankRowId);
    }

    // ===== Phase2：仅 Phase1 未命中的 gw，对未被消费的银行行用 ±dateToleranceDays 再匹配 =====
    for (const gw of unmatchedAfterPhase1) {
      const directionEligible = directionEligibleCandidates(gw);
      const cand = [];
      for (const bankRow of directionEligible) {
        if (dayDiffWithin(gw && gw.Billdate, bankRow.BillDate, dateToleranceDays)) {
          cand.push(bankRow);
        } else {
          // near-candidate 的日期失败原因必须逐条可审计，即使同一来源另有合法候选最终成功。
          warnDateFailure(gw, bankRow, dir.expectedBankDirection);
        }
      }
      // F2（P2）：dateToleranceDays>1 时，按「与网关 Billdate 的绝对天数差」升序稳定排序，
      //   让差 1 天的优先于差 2 天（JS Array.sort 对相等键稳定 → 同天数差保持 bankPool 原序）。
      //   Phase1 严格同日不受影响。
      const gwDate = toDate(gw && gw.Billdate);
      const dayDiffAbs = (b) => {
        const bd = toDate(b && b.BillDate);
        if (!gwDate || !bd) return Number.POSITIVE_INFINITY;
        return Math.abs(Math.round((gwDate.getTime() - bd.getTime()) / MS_PER_DAY));
      };
      cand.sort(
        (a, b) =>
          dayDiffAbs(a) - dayDiffAbs(b) ||
          (bankOriginalIndex.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (bankOriginalIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
      );
      backfill(gw, cand, `±${dateToleranceDays}day`, usedBankRowId);
    }

    // 🔴 v3.0.4 块 F：把本 direction 消费的银行行（含同值未写行，1v1 单向消费集）并入跨方向聚合集。
    //   不改既有匹配/写值逻辑：仅在 direction 跑完后追加一次 union，纯 additive 收集。
    for (const consumedRowId of usedBankRowId) consumedBankRowIds.add(consumedRowId);
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    usedBankRowIds: consumedBankRowIds
  };
}

module.exports = {
  runRound5FundTransferBackfill,
  amountEqual,
  bankAmountAbs,
  bankAmountEqualWithoutExtraFee,
  bankAmountWithExtraFee,
  createInvalidExtraFeeWarning,
  gwAmountAbs,
  hasInvalidExtraFee,
  makeInvalidExtraFeeWarningDeduper
};
