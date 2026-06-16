// v3.0.6 需求2「中台调拨订单对账ID回填（数据来源=调拨对账单）」引擎（🔴 资金红线）
// plan「需求2」/ 资金红线 review 点 2、7。
//
// 业务语义（与 R5s2 现状 r5-fund-transfer-backfill.js 同口径，唯一差异：对手方换源）：
//   原 R5s2：网关 TradeType=FundTransfer-out/in 行 ↔ R4 后银行 FundType=FundTransfer-out/in 行。
//   本引擎：把「网关对账单」对手方换成「调拨对账单」(reconRows)——
//     调拨对账单 fund_type=FundTransfer-out/in 行 ↔ R4 后银行 FundType 同值行。
//   命中 → 把调拨对账单 ReconID 回填进银行 ReconciliationId（标黄 ReconciliationId 列）。
//   两方向（in/out）各自独立跑，互不串池（与 R5s2 一致）。
//
// 跨表字段（显式映射，绝不假设同名 —— 全部经 FT_RECON_FIELD_MAP.recon 常量取，禁手敲）：
//   调拨对账单（linked_fund_transfer_recon 派生行，字段名见 fund-transfer-recon-fields.js）：
//     rc[recon.bigAccount]   大账号（D1 已按方向固化：in=收款卡号 / out=付款卡号），与银行 MerchantId 比
//     rc[recon.currency]     币种
//     rc[recon.amount]       金额（单列，含正负方向，本场景取绝对值）
//     rc[recon.billDate]     账单日期
//     rc[recon.reconId]      对账 ID（回填的来源）
//     rc[recon.fundType]     方向标记（FundTransfer-in/out，用于按 direction 过滤 + 必须非空进池）
//   银行（bank statement，驼峰，与 R5s2 完全一致）：
//     bank.FundType / bank.MerchantId / bank.Currency
//     bank['Credit Amount'] + bank['Debit Amount']（双列，绝对值 = |credit - debit|，复用 bankAmountAbs）
//     bank.BillDate / bank.ReconciliationId / bank._rowId
//
// 金额比对口径（🔴 与 R5s2 同口径，容差 0，精确到分）：
//   银行发生额绝对值 = bankAmountAbs(bank)（复用 r5-fund-transfer-backfill，禁重写）
//   调拨金额绝对值   = |rc[recon.amount]|
//   amountEqual = 两侧都有限数 且 Math.round(银行*100) === Math.round(调拨*100)
//
// 日期两阶段（🔴 「优先同日」硬约束，照搬 R5s2）：
//   Phase1：严格同日（sameDay）。先把所有 recon 跑完，消费掉同日命中的银行行。
//   Phase2：仅 Phase1 未命中的 recon，对未被消费的银行行用 ±dateToleranceDays（dayDiffWithin）再匹配，
//           按「与调拨 BillDate 的绝对天数差」升序稳定排序（差小优先）。
//
// 严格 1v1：usedBankRowId 单向消费（每个 direction 独立一份），一条银行行最多被一条调拨行回填。
//   含「消费但未写」行（nv 空 / 与原值相同 → 不 record 不标黄，但仍 usedBankRowId.add 占用）。
// 多候选 tie-break：同日优先（Phase 分离已保证）→ 银行行原序最前（cand[0]）+ multi-bank-match-backfill warning。
//
// ⚠️ 资金红线：金额归分错误 / 日期 ±1day 配错 / 大账号方向取反 → 写错 ReconciliationId（下游影响大）。

const {
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');

const { sameDay, dayDiffWithin, toDate } = require('./engine-date-utils');

// 🔴 复用 R5s2 的银行发生额绝对值（|Credit-Debit|）——禁重写（plan 复用件清单）。
const { bankAmountAbs } = require('./r5-fund-transfer-backfill');

const { FT_RECON_FIELD_MAP } = require('../../constants/fund-transfer-recon-fields');

const RECON = FT_RECON_FIELD_MAP.recon;

const MS_PER_DAY = 86400000;

// 双方向（与 R5s2 DEFAULT_DIRECTIONS 同值；调拨对账单 fund_type 与银行 FundType 同枚举值）。
//   两方向独立池：bankPool=bank.FundType===dir.fundType；reconPool=rc[recon.fundType]===dir.fundType。
const DIRECTIONS = [
  { fundType: FT_RECON_FIELD_MAP.FUND_TYPE_IN },
  { fundType: FT_RECON_FIELD_MAP.FUND_TYPE_OUT }
];

const DEFAULT_DATE_TOLERANCE_DAYS = 1;

// 调拨对账单金额绝对值 = |rc[recon.amount]|；非数值 → NaN（→ amountEqual 判非有限数 → 不命中）。
function reconAmountAbs(reconRow) {
  const n = parseNumber(reconRow && reconRow[RECON.amount]);
  return Math.abs(n ?? NaN);
}

// 金额发生额绝对值精确到分比对（🔴 容差 0，与 R5s2 amountEqual 同口径）。
//   两侧都必须是有限数；否则不命中（防 NaN 误判相等）。
function amountEqual(reconRow, bankRow) {
  const bankAbs = bankAmountAbs(bankRow);
  const reconAbs = reconAmountAbs(reconRow);
  if (!Number.isFinite(bankAbs) || !Number.isFinite(reconAbs)) return false;
  return Math.round(bankAbs * 100) === Math.round(reconAbs * 100);
}

/**
 * R5 场景2（数据来源=调拨对账单）：调拨对账单 ReconID 回填银行 ReconciliationId。
 *
 * @param {Array<Object>} reconRows 调拨对账单派生行（linked_fund_transfer_recon，字段见 RECON 常量）
 * @param {Array<Object>} bankRows  R4 后的银行对账单行（带 _rowId，FundType/ReconciliationId 可能已被前序轮次改写）
 * @param {Object} [options]
 * @param {number} [options.dateToleranceDays] Phase2 日期容差天数（默认 1）
 * @returns {{ modifications: Array, warnings: Array, usedBankRowIds: Set }}
 *   modifications：实际改写 ReconciliationId 的行（{ rowId, column:'ReconciliationId', oldValue, newValue }）
 *   warnings：multi-bank-match-backfill
 *   usedBankRowIds：引擎内 1v1 消费的全部 bank _rowId 集合（含「消费但未写」行）——
 *     与 R5s2 同语义，供编排器并入 r5s2ConsumedBankRowIds 传 R5s2b 剔除（互斥防二次覆盖）。
 */
function runRound5FundTransferReconBackfill(reconRows, bankRows, options = {}) {
  const warningCollector = makeWarningCollector(
    'r5-fund-transfer-recon-backfill',
    '中台调拨订单对账ID回填（调拨对账单）'
  );
  const modCollector = makeModificationCollector();
  // 跨 direction 聚合的消费集合（含同值未写行），作为返回字段供 R5s2b 剔除。
  const consumedBankRowIds = new Set();

  const safeReconRows = Array.isArray(reconRows) ? reconRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];

  const dateToleranceDays = Number.isFinite(options.dateToleranceDays)
    ? options.dateToleranceDays
    : DEFAULT_DATE_TOLERANCE_DAYS;

  // 空入参防御：无调拨对账单行 / 无银行行 → 直接返回空结果（no-op）。
  if (safeReconRows.length === 0 || safeBankRows.length === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      usedBankRowIds: consumedBankRowIds
    };
  }

  // 对账字段全等：big_account↔MerchantId、币种↔Currency（valuesEqual）+ 金额发生额绝对值精确到分。
  //   ⚠️ 大账号方向已在派生固化（D1），引擎零方向分支——此处不区分收/付，直接 big_account 比 MerchantId。
  const fieldEq = (rc, bank) =>
    valuesEqual(rc && rc[RECON.bigAccount], bank && bank.MerchantId) &&
    valuesEqual(rc && rc[RECON.currency], bank && bank.Currency) &&
    amountEqual(rc, bank);

  // 命中回填：把调拨对账单 ReconID 写入银行 ReconciliationId（命中即覆盖，含非空原值；与 R5s2 同语义）。
  //   cand 已保证按 bankPool 顺序；tie-break 取 cand[0]（原序最前）。
  const backfill = (rc, cand, phase, usedBankRowId) => {
    if (cand.length === 0) return; // 未命中，静默
    if (cand.length > 1) {
      warningCollector.push({
        rowId: cand[0]._rowId,
        code: 'multi-bank-match-backfill',
        phase,
        message: `调拨对账单在银行对账单中匹配到 ${cand.length} 行可用候选（${phase}），取原序最前一条（数据脏）`
      });
    }

    const chosen = cand[0];
    usedBankRowId.add(chosen._rowId); // 严格 1v1 单向消费（命中先 add 再判写）

    const nv = normalizeCellValue(rc && rc[RECON.reconId]);
    const old = normalizeCellValue(chosen.ReconciliationId);
    if (nv !== '' && old !== nv) {
      chosen.ReconciliationId = nv;
      modCollector.record(chosen._rowId, 'ReconciliationId', old, nv);
    }
    // nv 为空（调拨无 ReconID）或与原值相同 → 不写、不标黄，但仍已消费该银行行（1v1 红线不变）。
  };

  // 每个 direction 独立跑：独立 reconPool / bankPool / usedBankRowId（两方向不串池）。
  for (const dir of DIRECTIONS) {
    // reconPool：fund_type 同方向 且 ReconID 非空（空 ReconID 无可回填，进池只会空占银行候选）
    //   且 big_account 非空（🔴 资金红线护栏：valuesEqual('','')===true，空 big_account 的调拨行会误命中
    //   空 MerchantId 的银行行并写错 ReconciliationId；与现有 reconId 非空护栏并列，空 big_account 不进池）。
    const reconPool = safeReconRows.filter(
      (rc) =>
        normalizeCellValue(rc && rc[RECON.fundType]) === dir.fundType &&
        normalizeCellValue(rc && rc[RECON.reconId]) !== '' &&
        normalizeCellValue(rc && rc[RECON.bigAccount]) !== ''
    );
    const bankPool = safeBankRows.filter(
      (b) => normalizeCellValue(b && b.FundType) === dir.fundType
    );
    const usedBankRowId = new Set();

    // ===== Phase1：严格同日 —— 先把所有 recon 跑完，消费掉同日命中（保证「优先同日」硬约束）=====
    const unmatchedAfterPhase1 = [];
    for (const rc of reconPool) {
      const cand = bankPool.filter(
        (b) =>
          !usedBankRowId.has(b._rowId) &&
          fieldEq(rc, b) &&
          sameDay(rc && rc[RECON.billDate], b.BillDate)
      );
      if (cand.length === 0) {
        unmatchedAfterPhase1.push(rc);
        continue;
      }
      backfill(rc, cand, 'same-day', usedBankRowId);
    }

    // ===== Phase2：仅 Phase1 未命中的 recon，对未被消费的银行行用 ±dateToleranceDays 再匹配 =====
    for (const rc of unmatchedAfterPhase1) {
      const cand = bankPool.filter(
        (b) =>
          !usedBankRowId.has(b._rowId) &&
          fieldEq(rc, b) &&
          dayDiffWithin(rc && rc[RECON.billDate], b.BillDate, dateToleranceDays)
      );
      // 按「与调拨 BillDate 的绝对天数差」升序稳定排序（差小优先；同天数差保持 bankPool 原序）。
      const reconDate = toDate(rc && rc[RECON.billDate]);
      const dayDiffAbs = (b) => {
        const bd = toDate(b && b.BillDate);
        if (!reconDate || !bd) return Number.POSITIVE_INFINITY;
        return Math.abs(Math.round((reconDate.getTime() - bd.getTime()) / MS_PER_DAY));
      };
      cand.sort((a, b) => dayDiffAbs(a) - dayDiffAbs(b));
      backfill(rc, cand, `±${dateToleranceDays}day`, usedBankRowId);
    }

    // 把本 direction 消费的银行行（含同值未写行，1v1 单向消费集）并入跨方向聚合集。
    for (const consumedRowId of usedBankRowId) consumedBankRowIds.add(consumedRowId);
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    usedBankRowIds: consumedBankRowIds
  };
}

module.exports = {
  runRound5FundTransferReconBackfill,
  amountEqual,
  reconAmountAbs
};
