// v3.0.6 需求1：调拨对账单派生纯函数（🔴 资金红线）
// 一行中台调拨订单（mid-allocation）→ 两行调拨对账单（FundTransfer-in + FundTransfer-out）。
// plan「需求1」字段映射表 / 决策 D1（大账号按方向固化 big_account）。
//
// 纯函数（不读 DB / 不碰 FS）：midRows 由调用侧 readLinkedTableRows('mid-allocation') 注入，便于单测。
//   仿 adm-bank-deposit-builder.js，但**派生阶段不做任何跨表匹配**（纯字段重排 + 方向展开），
//   匹配推迟到需求2（r5-fund-transfer-recon-backfill）/ 需求3（dbs-charge-fund-check）。
// 字段名一律经 FT_RECON_FIELD_MAP 常量取，绝不手敲（全角括号漂移 = 大账号全空，资金红线）。

const {
  FT_RECON_FIELD_MAP,
  MID_ALLOCATION_SUCCESS_STATUS,
  FUND_TRANSFER_RECON_UNUSED
} = require('../constants/fund-transfer-recon-fields');
const { isAmbiguousMappedAccount, normalizeCellValue, resolveMappedAccount } = require('./scenario-engines/engine-utils');

const M = FT_RECON_FIELD_MAP.mid;
// v3.2.22：派生提示与运行告警共用的歧义原因说明（engine-utils.mappedAccountAmbiguity 的两种原因）。
const AMBIGUOUS_ACCOUNT_REASON = '的账户号含 Excel 转义写法（_xHHHH_ 形式），或是按数值读入、可能已丢失前导零或精度的数字' +
  '（Excel 数值不保留前导零、只保留 15 位有效数字，大于 9007199254740991 的还会被舍入）且与账户映射里的链接表账户号对得上';
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
 * @returns {{ rows: Array<Object>, total: number, sourceTotal: number, skippedStatusCount: number,
 *   ambiguousMappedAccountCount: number }}
 *   rows 按「每单 in 行后接 out 行」顺序展开（total = 付款成功行数×2）。
 *   ambiguousMappedAccountCount（v3.2.22）：映射非空且账号无法确定真实值（含 `_xHHHH_` 转义写法，或是按数值读入、
 *   与映射键对得上的数字——前导 0 已丢或可能已丢失精度）而 big_account 留空（不参与 R5s2-recon / DBS-Charge 匹配）的派生行数，见 engine-utils.resolveMappedAccount。
 */
function buildFundTransferReconRows(midRows, options = {}) {
  const src = Array.isArray(midRows) ? midRows : [];
  // v3.0.12 功能2（批B，🔴 资金红线）：账户映射 map（链接表账户号 → 清结算银行账号），仅 big_account 套用。
  //   v3.2.22：取值统一走 engine-utils.resolveMappedAccount（与 R5s2 网关 merchantid 共用同一口径）；
  //   缺省 / 非 Map → 原值 passthrough。payAccount/payeeAccount 已 normalizeCellValue，helper 内再归一化为幂等，口径不变。
  const accountMappingMap = options ? options.accountMappingMap : undefined;
  const rows = [];
  let skippedStatusCount = 0;
  let ambiguousMappedAccountCount = 0;
  const mapBigAccount = (account) => {
    if (isAmbiguousMappedAccount(accountMappingMap, account)) ambiguousMappedAccountCount += 1;
    return resolveMappedAccount(accountMappingMap, account);
  };
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;

    const status = normalizeCellValue(m[M.status]);
    if (status !== MID_ALLOCATION_SUCCESS_STATUS) {
      skippedStatusCount += 1;
      continue;
    }

    // 公共字段（in / out 两行共用；normalizeCellValue 统一 trim + String 化）
    const payAccount = normalizeCellValue(m[M.payCard]); // 付款账户（卡号）
    const payeeAccount = normalizeCellValue(m[M.payeeCard]); // 收款账户（卡号）
    const base = {
      [R.allocationNo]: normalizeCellValue(m[M.allocationNo]),
      [R.billDate]: normalizeCellValue(m[M.txTime]), // 交易时间 → BillDate
      [R.reconId]: normalizeCellValue(m[M.channelSerial]), // 渠道流水号 → ReconID
      [R.payMethod]: normalizeCellValue(m[M.payMethod]),
      [R.payAccount]: payAccount,
      [R.payeeAccount]: payeeAccount,
      [R.used]: FUND_TRANSFER_RECON_UNUSED
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
      [R.bigAccount]: mapBigAccount(payeeAccount)
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
      [R.bigAccount]: mapBigAccount(payAccount)
    });
  }
  return {
    rows,
    total: rows.length,
    sourceTotal: src.length,
    skippedStatusCount,
    ambiguousMappedAccountCount
  };
}

// v3.2.22（🔴 资金红线·可观测）：调拨对账单有账户号无法确定真实值、大账号留空的行时，主路径（run 入口）与 G7 worker
//   并入运行结果错误报告的同一条结构化告警（rowId 为空，排在日期策略配置告警之后）。
function createFundTransferReconAmbiguityWarning(count) {
  return {
    scenarioId: null,
    scenarioName: '调拨对账单',
    rowId: null,
    engine: 'fund-transfer-recon-derive',
    code: 'fund-transfer-recon-mapped-account-ambiguous',
    message: `调拨对账单有 ${count} 行${AMBIGUOUS_ACCOUNT_REASON}，无法确定真实账户号，` +
      '这些行的大账号已留空，本轮不参与调拨来源回填与 DBS-Charge 资金校验，请人工核对账户号与账户映射'
  };
}

// v3.2.22（🔴 资金红线）：核对已落库的调拨对账单行与本轮账户映射是否一致（run 入口重派生失败、按历史口径降级读现有
//   持久表前调用）。按方向取原始收付款账号（in = 收款账号、out = 付款账号）以本轮映射重算 big_account，与落库值逐行比较：
//   staleCount = 不一致行数（旧版本派生时没有歧义护栏、或映射改过但表没重建）；ambiguousMappedAccountCount = 本轮
//   映射下账户号无法确定真实值的行数。方向标记不是 in / out 的行不比较（引擎按方向取行，不会用到）。
function checkFundTransferReconRowsAgainstMapping(reconRows, accountMappingMap) {
  let staleCount = 0;
  let ambiguousMappedAccountCount = 0;
  for (const row of Array.isArray(reconRows) ? reconRows : []) {
    if (!row || typeof row !== 'object') continue;
    const fundType = normalizeCellValue(row[R.fundType]);
    let rawAccount;
    if (fundType === FT_RECON_FIELD_MAP.FUND_TYPE_IN) rawAccount = normalizeCellValue(row[R.payeeAccount]);
    else if (fundType === FT_RECON_FIELD_MAP.FUND_TYPE_OUT) rawAccount = normalizeCellValue(row[R.payAccount]);
    else continue;
    if (isAmbiguousMappedAccount(accountMappingMap, rawAccount)) ambiguousMappedAccountCount += 1;
    if (normalizeCellValue(row[R.bigAccount]) !== resolveMappedAccount(accountMappingMap, rawAccount)) staleCount += 1;
  }
  return { staleCount, ambiguousMappedAccountCount };
}

module.exports = {
  AMBIGUOUS_ACCOUNT_REASON,
  checkFundTransferReconRowsAgainstMapping,
  createFundTransferReconAmbiguityWarning,
  buildFundTransferReconRows
};
