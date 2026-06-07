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
//     bank['Credit Amount'] + bank['Debit Amount']（双列） 发生额（绝对值 = |credit - debit|）
//     bank.BillDate                  账单日期
//     bank.ReconciliationId          对账 ID（回填的目标）
//     bank._rowId                    行唯一键（上游注入，全局唯一）
//
// 金额比对口径（🔴 决策 D2，PRD R2.5）：
//   银行发生额绝对值 = |（Credit Amount || 0） − （Debit Amount || 0）|
//   网关金额绝对值   = |amount|
//   amountEqual = 两者都是有限数 且 Math.round(银行*100) === Math.round(网关*100)  // 精确到分，容差 0
//   —— 方向已由 FundType 过滤（out / in 分别匹配），此处只比绝对值。
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
  parseNumber,
  valuesEqual
} = require('./engine-utils');

const { sameDay, dayDiffWithin } = require('./engine-date-utils');

// 默认双方向（config 化，TECH_DESIGN §5.3 / options.directions）
const DEFAULT_DIRECTIONS = [
  { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
  { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
];

const DEFAULT_DATE_TOLERANCE_DAYS = 1;

// 银行发生额绝对值 = |（Credit Amount || 0） − （Debit Amount || 0）|
//   credit / debit 任一非数值按 0 计（与 C3 getBankRowValueForC3 一致）；两者皆非数值 → 仍返回 0（非 null）
//   —— 与 amountEqual 配合：网关侧若非数值会先被判非有限数而整体不命中。
function bankAmountAbs(bankRow) {
  const credit = parseNumber(bankRow && bankRow['Credit Amount']) || 0;
  const debit = parseNumber(bankRow && bankRow['Debit Amount']) || 0;
  return Math.abs(credit - debit);
}

// 网关金额绝对值 = |amount|；amount 非数值 → NaN（→ amountEqual 判非有限数 → 不命中）
function gwAmountAbs(gwRow) {
  const n = parseNumber(gwRow && gwRow.amount);
  return Math.abs(n ?? NaN);
}

// 金额发生额绝对值精确到分比对（🔴 D2，容差 0）
//   两侧都必须是有限数；否则不命中（防 NaN 误判相等）
function amountEqual(gwRow, bankRow) {
  const bankAbs = bankAmountAbs(bankRow);
  const gwAbs = gwAmountAbs(gwRow);
  if (!Number.isFinite(bankAbs) || !Number.isFinite(gwAbs)) return false;
  return Math.round(bankAbs * 100) === Math.round(gwAbs * 100);
}

/**
 * R5 场景2：FundTransfer 回填 ReconciliationId。
 *
 * @param {Array<Object>} gwRows   网关对账单行（链接表读回，真实小写表头）
 * @param {Array<Object>} bankRows R4 后的银行对账单行（带 _rowId，FundType/ReconciliationId 可能已被前序轮次改写）
 * @param {Object} [options]
 * @param {Array<{gwTradeType:string,bankFundType:string}>} [options.directions] 双方向定义（默认 out/in）
 * @param {number} [options.dateToleranceDays] Phase2 日期容差天数（默认 1）
 * @returns {{ modifications: Array, warnings: Array }}
 *   modifications：实际改写 ReconciliationId 的行（{ rowId, column:'ReconciliationId', oldValue, newValue }），用于标黄
 *   warnings：multi-bank-match-backfill / reconid-overwrite-backfill
 */
function runRound5FundTransferBackfill(gwRows, bankRows, options = {}) {
  const warningCollector = makeWarningCollector('r5-fund-transfer-backfill', '中台调拨订单对账ID回填');
  const modCollector = makeModificationCollector();

  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];

  const directions = Array.isArray(options.directions) && options.directions.length > 0
    ? options.directions
    : DEFAULT_DIRECTIONS;
  const dateToleranceDays = Number.isFinite(options.dateToleranceDays)
    ? options.dateToleranceDays
    : DEFAULT_DATE_TOLERANCE_DAYS;

  // 空入参防御：无网关行 / 无银行行 → 直接返回空结果（无需 warning，编排器自有空数据提示）
  if (safeGwRows.length === 0 || safeBankRows.length === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  // 对账字段全等：merchantid↔MerchantId、currency↔Currency（字符串 valuesEqual）+ 金额发生额绝对值精确到分
  const fieldEq = (gw, bank) =>
    valuesEqual(gw && gw.merchantid, bank && bank.MerchantId) &&
    valuesEqual(gw && gw.currency, bank && bank.Currency) &&
    amountEqual(gw, bank);

  // 命中回填：把网关 reconciliationid 写入银行 ReconciliationId（原值非空被覆盖发 warning 但仍写）
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
      if (old !== '') {
        // 原值非空被覆盖 —— 与 C1/C3 一致：发 warning 但仍执行覆盖
        warningCollector.push({
          rowId: chosen._rowId,
          code: 'reconid-overwrite-backfill',
          phase,
          message: `银行行 ReconciliationId 原值「${old}」非空，被网关回填值「${nv}」覆盖（${phase}）`
        });
      }
      chosen.ReconciliationId = nv;
      modCollector.record(chosen._rowId, 'ReconciliationId', old, nv);
    }
    // nv 为空（网关无 reconid）或与原值相同 → 不写、不标黄，但仍已消费该银行行（1v1 红线不变）
  };

  // 每个 direction 独立跑：独立 gwPool / bankPool / usedBankRowId（两方向不串池）
  for (const dir of directions) {
    const gwPool = safeGwRows.filter((g) => normalizeCellValue(g && g.TradeType) === dir.gwTradeType);
    const bankPool = safeBankRows.filter((b) => normalizeCellValue(b && b.FundType) === dir.bankFundType);
    const usedBankRowId = new Set();

    // ===== Phase1：严格同日 —— 先把所有 gw 跑完，消费掉同日命中（保证「优先同日」硬约束）=====
    //   记录 Phase1 未命中的 gw（cand 为空），留给 Phase2 用 ±tolerance 再匹配。
    const unmatchedAfterPhase1 = [];
    for (const gw of gwPool) {
      const cand = bankPool.filter(
        (b) => !usedBankRowId.has(b._rowId) && fieldEq(gw, b) && sameDay(gw && gw.Billdate, b.BillDate)
      );
      if (cand.length === 0) {
        unmatchedAfterPhase1.push(gw);
        continue;
      }
      backfill(gw, cand, 'same-day', usedBankRowId);
    }

    // ===== Phase2：仅 Phase1 未命中的 gw，对未被消费的银行行用 ±dateToleranceDays 再匹配 =====
    for (const gw of unmatchedAfterPhase1) {
      const cand = bankPool.filter(
        (b) =>
          !usedBankRowId.has(b._rowId) &&
          fieldEq(gw, b) &&
          dayDiffWithin(gw && gw.Billdate, b.BillDate, dateToleranceDays)
      );
      backfill(gw, cand, `±${dateToleranceDays}day`, usedBankRowId);
    }
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

module.exports = {
  runRound5FundTransferBackfill,
  amountEqual,
  bankAmountAbs,
  gwAmountAbs
};
