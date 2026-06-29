// v3.0.6 需求1：调拨对账单派生纯函数（🔴 资金红线）
// 一行中台调拨订单（mid-allocation）→ 两行调拨对账单（FundTransfer-in + FundTransfer-out）。
// plan「需求1」字段映射表 / 决策 D1（大账号按方向固化 big_account）。
//
// 纯函数（不读 DB / 不碰 FS）：midRows 由调用侧 readLinkedTableRows('mid-allocation') 注入，便于单测。
//   仿 adm-bank-deposit-builder.js，但**派生阶段不做任何跨表匹配**（纯字段重排 + 方向展开），
//   匹配推迟到需求2（r5-fund-transfer-recon-backfill）/ 需求3（dbs-charge-fund-check）。
// 字段名一律经 FT_RECON_FIELD_MAP 常量取，绝不手敲（全角括号漂移 = 大账号全空，资金红线）。

const { FT_RECON_FIELD_MAP } = require('../constants/fund-transfer-recon-fields');
const { normalizeCellValue } = require('./scenario-engines/engine-utils');

const M = FT_RECON_FIELD_MAP.mid;
const R = FT_RECON_FIELD_MAP.recon;

/**
 * 一行中台调拨订单 → in + out 两行调拨对账单。
 *
 * @param {Array<Object>} midRows 中台调拨订单整行（中文真实表头，readLinkedTableRows('mid-allocation') 产物）
 * @param {Object} [options]
 * @param {Map<string,string>} [options.accountMappingMap] 全局账户映射「中台调拨账户号 → 清结算银行账号」
 *   （v3.0.12 功能2，🔴 资金红线）。**仅作用于 big_account**：命中 → 替换为清结算账号；未命中 → 原样保留。
 *   键值口径须与本函数一致（均经 normalizeCellValue；map 由 database.getFundTransferAccountMappingMap 提供，
 *   与 R5s2-recon / DBS-Charge R3.5 引擎读的派生表同一真值源）。缺省 / 非 Map → 空 Map（全 passthrough，
 *   映射表为空＝字节级零变化）。
 * @returns {{ rows: Array<Object>, total: number }} rows 按「每单 in 行后接 out 行」顺序展开（total = 行数×2）
 */
function buildFundTransferReconRows(midRows, options = {}) {
  const src = Array.isArray(midRows) ? midRows : [];
  // v3.0.12 功能2（批B，🔴 资金红线）：账户映射 map（中台调拨账户号 → 清结算银行账号），仅 big_account 套用。
  //   缺省 / 非 Map → 空 Map（全 passthrough）。⚠️ map 键已归一化、下方 payAccount/payeeAccount 也已 normalizeCellValue
  //   → map.get 口径一致，**不再二次归一化**（口径漂移＝写错对账ID，资金红线）。
  const accountMappingMap =
    options && options.accountMappingMap instanceof Map ? options.accountMappingMap : new Map();
  const rows = [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;

    // 公共字段（in / out 两行共用；normalizeCellValue 统一 trim + String 化）
    const payAccount = normalizeCellValue(m[M.payCard]); // 付款账户（卡号）
    const payeeAccount = normalizeCellValue(m[M.payeeCard]); // 收款账户（卡号）
    const base = {
      [R.allocationNo]: normalizeCellValue(m[M.allocationNo]),
      [R.billDate]: normalizeCellValue(m[M.txTime]), // 交易时间 → BillDate
      [R.reconId]: normalizeCellValue(m[M.channelSerial]), // 渠道流水号 → ReconID
      [R.payAccount]: payAccount,
      [R.payeeAccount]: payeeAccount
    };

    // FundTransfer-in 行：渠道 / 金额 / 币种取收款侧；big_account = 收款卡号（D1）
    rows.push({
      ...base,
      [R.payChannel]: '', // in 行付款渠道留空（需求3 步骤1 仅按收款渠道判 DBS）
      [R.receiveChannel]: normalizeCellValue(m[M.receiveChannel]),
      [R.amount]: normalizeCellValue(m[M.receiveAmount]),
      [R.currency]: normalizeCellValue(m[M.receiveCurrency]),
      [R.fundType]: FT_RECON_FIELD_MAP.FUND_TYPE_IN,
      // D1：in = 收款账户（卡号）；🔴 套用账户映射：命中→清结算账号、未命中→原样保留（payeeAccount 展示字段不动）。
      [R.bigAccount]: accountMappingMap.get(payeeAccount) ?? payeeAccount
    });

    // FundTransfer-out 行：渠道 / 金额 / 币种取付款侧；big_account = 付款卡号（D1）
    rows.push({
      ...base,
      [R.payChannel]: normalizeCellValue(m[M.payChannel]),
      [R.receiveChannel]: '', // out 行收款渠道留空
      [R.amount]: normalizeCellValue(m[M.payAmount]),
      [R.currency]: normalizeCellValue(m[M.payCurrency]), // out 币种取付款币种（纠原文笔误）
      [R.fundType]: FT_RECON_FIELD_MAP.FUND_TYPE_OUT,
      // D1：out = 付款账户（卡号）；🔴 套用账户映射：命中→清结算账号、未命中→原样保留（payAccount 展示字段不动）。
      [R.bigAccount]: accountMappingMap.get(payAccount) ?? payAccount
    });
  }
  return { rows, total: rows.length };
}

module.exports = {
  buildFundTransferReconRows
};
