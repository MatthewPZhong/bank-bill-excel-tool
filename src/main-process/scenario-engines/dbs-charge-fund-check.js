// v3.0.6 需求3「DBS-Charge 资金校验」引擎（🔴🔴 资金红线核心，最严）
// plan「需求3」全段 / 资金红线 review 点 1~3、7~8。
//
// 性质：5 轮对账编排器新增 R3.5（R3 后、R4 前）。整体替换原全渠道 charge→outbound（R4 子场景），
//       仅对 Channel=DBS 生效。采用【对称模型】（用户最终拍板）：
//         步骤1：用「调拨对账单」找出真正的 FundTransfer-in/out 行 —— 命中行 FundType 标为该调拨行的
//                fund_type（'FundTransfer-in' 或 '-out'，按调拨方向）并赋 ReconciliationId；同 ReconID 其他行归 Charge。
//         步骤2：只索引固定 TradeType 白名单内的「网关对账单」；同 ID 存在白名单候选时先检查 Credit Amount，
//                方向通过后再用 amount/currency 找出真正的 outbound 行；方向不符则保持原值并告警；同 ID 其他未命中行
//                （候选 Charge/outbound 内）归 Charge。只有非白名单网关行的桶完全不处理。
//       最终每个进入步骤2的 ReconID 桶 = FundTransfer-in/out（步1命中）+ 方向合规的 outbound（步2命中）+ 其余 Charge。
//       改写 ReconciliationId + FundType 两列 —— 每一改都 record 留痕标黄。
//
// ⚠️ 跨表字段名不同，必须显式映射，绝不假设同名（一律经常量取，绝不手敲）：
//   - 银行行（bankRows，全量，R3 透传，真实驼峰表头）：
//       渠道 = row.Channel；商户 = row.MerchantId；币种 = row.Currency；
//       发生额 = row['Credit Amount'] + row['Debit Amount']（双列，绝对值=|credit-debit|）；
//       资金性质 = row.FundType（🔴 改写目标列之一）；对账ID = row.ReconciliationId（🔴 改写目标列之一）；
//       行唯一键 = row._rowId（上游注入，全局唯一）。
//   - 网关行（gwRows，全量入参；步骤2 仅对白名单 TradeType 按 reconciliationid 自建索引，不复用 R1）：
//       对账ID = row.reconciliationid（小写）；金额 = row.amount（小写单列，绝对值）；币种 = row.currency（小写）；类型 = row.TradeType。
//   - 调拨对账单行（dispatchReconRows，需求1 派生表读回，字段经 FT_RECON_FIELD_MAP.recon.* 取）：
//       付款渠道 / 收款渠道 / big_account（D1 按方向固化的大账号）/ 币种 / 金额 / ReconID / fund_type（FundTransfer-in/out）。
//
// 步骤1（调拨对账单 ↔ DBS 银行，命中行标 FundTransfer-in/out + 赋 ReconciliationId + 归并 Charge）：
//   🔴 两阶段化（防覆盖关键交互）：一笔调拨单的 in 行和 out 行【ReconID 相同】（都=渠道流水号）。若边匹配边归并，
//      out 行的归并会把 in 行刚标的 FundTransfer-in 命中行覆盖成 Charge。故拆两阶段：
//   dbsBankRows = bankRows.filter(Channel===DBS)            // 门控+范围；空 → 整体 no-op 返回空
//   dispRows = dispatchReconRows.filter(方向感知门控 && big_account 非空)
//     方向感知门控（v3.0.6 codex-pr74-fix P1）：builder 按 D1 单向渠道固化（in 行只填收款渠道、out 行只填付款渠道，
//       另一列留空），故按 fund_type 判方向通道 —— in 判 收款渠道===DBS、out 判 付款渠道===DBS（另一列留空不判）。
//       语义：捕获任何含 DBS 腿的调拨腿（DBS→DBS 两腿都纳入 / DBS→外部仅出腿 / 外部→DBS 仅入腿）。
//   ── 阶段A（先匹配 + 标记，不归并）：用 Set 收集所有命中行（对象引用）──
//   for d in dispRows:                                       // 按 big_account+金额+币种 严格 1v1
//     cand = dbsBankRows.filter(!used && valuesEqual(MerchantId,d.big_account)
//                               && valuesEqual(Currency,d.币种) && dispatchBankAmountEqual(d,b))
//     chosen = cand[0]（多候选→原序首行+warning）；used.add(chosen)；matchedBankRows.add(chosen)
//     if normalize(d.ReconID) 非空 && !== chosen.ReconciliationId: 覆盖 + record('ReconciliationId')
//     // 命中行 FundType 标为该调拨行 fund_type（FundTransfer-in/out），旧值≠新值才 record('FundType')
//     if normalize(d.fund_type) 非空 && oldFundType !== d.fund_type: chosen.FundType=d.fund_type + record
//     记录归并键 d.ReconID（供阶段B）
//   ── 阶段B（再归并）：对每个被赋 ReconID 的键，把「同 ReconId + 不在 matchedBankRows + FundType≠Charge」的行置 Charge ──
//     遍历【全量 bankRows】（chargeSiblingsScope='dbs-only' 仅 DBS / 'all' 全渠道），
//     对 b∉matchedBankRows（所有 FundTransfer 命中行都被保护，不被归并）且 normalize(b.ReconciliationId)===键
//     且 normalize(b.FundType)!==Charge → b.FundType=Charge + record('FundType')。
//
// 步骤2（白名单网关 amount/currency 找真正 outbound 行；同 ID 未命中行归 Charge）：
//   gwByReconId = index(白名单 gwRows by normalize(reconciliationid)) // 用步骤1改后的新 ReconciliationId 关联
//   bankByReconId = index(DBS bankRows by normalize(ReconciliationId))
//   for [reconId, bucket] in bankByReconId:
//     gwForKey = gwByReconId.get(reconId); if 空 → continue
//     candidates = bucket.filter(normalize(FundType) ∈ {Charge, outbound})  // ⚠️ 两类「值」，非方向过滤
//       —— FundTransfer-in/out 命中行（步1标）不在内，不被步骤2 碰，保持 FundTransfer。
//     for b in candidates:
//       if (parseNumber(b.Credit Amount)||0)!==0: warning + 保持原值            // 出账方向守卫优先
//       else if gwForKey.some(bankAmountEqualWithoutExtraFee(g,b) && valuesEqual(g.currency,b.Currency)):
//         b.FundType='outbound'（old!==目标才 record）                          // 命中 → outbound
//       else:
//         b.FundType='Charge'（old!==Charge 才 record；已 Charge no-op）       // 未命中 → Charge（语义翻转）
//
// 🔴 护栏汇总（每条对应 plan 资金红线 review 点）：
//   - 步骤1 命中行标 FundTransfer-in/out（按调拨方向）；两阶段化保护所有命中行不被同 ReconID 归并覆盖。
//   - 步骤1 归并仅【同 reconId + 不在命中行 Set + 非 Charge】+ 每改 record（review 点1）。
//   - ReconciliationId 命中即覆盖（含非空原值，normalize 后非空才写）；usedBankRowIds 严格 1v1（review 点2）。
//   - 步骤2 仅索引固定 TradeType 白名单；非白名单-only 桶保持原值且不告警。
//   - 步骤2 候选 = FundType ∈ {Charge, outbound}；先要求 Credit Amount=0，非0保持原值并告警；方向通过后命中→outbound、未命中→Charge。
//   - 步骤2 用步骤1改后的新 ReconciliationId 自建网关索引（不复用 R1）。
//   - 全 config 化（bankChannel / dispatchChannelValue / setFundTypeCharge / setFundTypeOutbound /
//     chargeSiblingsScope）。chargeSiblingsScope='dbs-only'（默认，仅对 Channel=DBS 同 reconId 行置 Charge，
//     防跨渠道误伤；用户决策偏离原文字面）或 'all'（忠于原文全量银行单，经 config 切回）。

const {
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');

// 🔴 复用件（禁重写）：银行发生额绝对值 = |Credit-Debit| + 显式旧口径网关比较器（读 gw.amount 小写单列）。
//   bankAmountEqualWithoutExtraFee 仅用于【步骤2】网关行 × 银行行，明确忽略 Extra Fee。
//   步骤1 调拨行金额在「金额」列（FT_RECON_FIELD_MAP.recon.amount），不是 .amount —— 故步骤1
//   不能直接复用 r5 的 amountEqual（它读 gwRow.amount），改用 dispatchBankAmountEqual（复用 bankAmountAbs 处理银行侧）。
const {
  bankAmountEqualWithoutExtraFee,
  bankAmountAbs
} = require('./r5-fund-transfer-backfill');
const { sameDay, dayDiffWithin, toDate } = require('./engine-date-utils');
const { validateBankDirection } = require('./bank-direction-validator');
const { normalizeFundTransferDatePolicy } = require('./fund-transfer-engine-policy');

const { FT_RECON_FIELD_MAP } = require('../../constants/fund-transfer-recon-fields');

const MS_PER_DAY = 86400000;

// —— 银行行跨表字段名常量（显式映射，绝不假设同名）——
const BANK_CHANNEL_FIELD = 'Channel';
const BANK_MERCHANT_ID_FIELD = 'MerchantId';
const BANK_CURRENCY_FIELD = 'Currency';
const BANK_CREDIT_AMOUNT_FIELD = 'Credit Amount';
const BANK_FUND_TYPE_FIELD = 'FundType';        // 🔴 改写目标列
const BANK_RECON_ID_FIELD = 'ReconciliationId'; // 🔴 改写目标列
const BANK_ROW_ID_FIELD = '_rowId';

// —— 网关行字段名（真实小写表头）——
const GW_RECON_ID_FIELD = 'reconciliationid';
const GW_CURRENCY_FIELD = 'currency';
const GW_TRADE_TYPE_FIELD = 'TradeType';

// v3.0.21：步骤2 网关固定白名单。trim 后大小写敏感，非白名单行不进入 reconid 索引。
const STEP2_GW_TRADE_TYPE_WHITELIST = new Set([
  'AchReturn',
  'ACQ_WITHDRAW',
  'B2B_FLOW_GOLD',
  'B2B_FLOW_GOLD_SUPPLIER',
  'B2B_SUPPLIER',
  'B2B_WITHDRAW',
  'CUR_PAY',
  'FX_WITHDRAW',
  'HX_WITHDRAW',
  'MPT_SUPPLIER',
  'MPT_WITHDRAW',
  'PUBLIC_PAY'
]);

// —— 调拨对账单字段名（经 FT_RECON_FIELD_MAP.recon.* 取，绝不手敲）——
const DISP = FT_RECON_FIELD_MAP.recon;
const DISP_PAY_CHANNEL_FIELD = DISP.payChannel;     // '付款渠道'
const DISP_RECEIVE_CHANNEL_FIELD = DISP.receiveChannel; // '收款渠道'
const DISP_BIG_ACCOUNT_FIELD = DISP.bigAccount;     // 'big_account'
const DISP_CURRENCY_FIELD = DISP.currency;          // '币种'
const DISP_AMOUNT_FIELD = DISP.amount;              // '金额'
const DISP_RECON_ID_FIELD = DISP.reconId;           // 'ReconID'
const DISP_FUND_TYPE_FIELD = DISP.fundType;         // 'fund_type'（值=FundTransfer-in/out，步骤1 标命中行 FundType）
const DISP_BILL_DATE_FIELD = DISP.billDate;          // 'BillDate'（由中台调拨订单交易时间派生）

const DIRECTION_MISMATCH_WARNING_CODE = 'fund-transfer-direction-mismatch';
const DATE_MISMATCH_WARNING_CODE = 'fund-transfer-date-mismatch';

// 默认 config（全 config 化；plan「需求3」步骤1/2）。
//   bankChannel          银行 Channel 门控值（仅该渠道行参与）
//   dispatchChannelValue 调拨对账单方向通道门控值（方向感知：in 判收款渠道===此值、out 判付款渠道===此值）
//   setFundTypeCharge    步骤1末归并目标 FundType（同 reconId 非 Charge 行置为该值）
//   setFundTypeOutbound  步骤2 命中目标 FundType
//   chargeSiblingsScope  步骤1末批量置 Charge 的波及范围（'all' | 'dbs-only'）：
//     'dbs-only'（默认，用户决策偏离 plan 原文字面，防跨渠道误伤）—— 仅对 Channel===bankChannel
//       的同 reconId 行置 Charge，非 DBS 渠道同 reconId 行不波及；
//     'all'（经 config 切回，忠于 plan 原文「搜全量银行单」）—— 同 reconId 非 Charge 行不论渠道全部置 Charge。
const DEFAULT_CONFIG = Object.freeze({
  bankChannel: 'DBS',
  dispatchChannelValue: 'DBS',
  setFundTypeCharge: 'Charge',
  setFundTypeOutbound: 'outbound',
  chargeSiblingsScope: 'dbs-only'
});

// 调拨对账单金额绝对值 = |金额|（单列，读 FT_RECON_FIELD_MAP.recon.amount）；非数值 → NaN（→ 不命中）。
function dispatchAmountAbs(dispRow) {
  const n = parseNumber(dispRow && dispRow[DISP_AMOUNT_FIELD]);
  return Math.abs(n ?? NaN);
}

// 步骤1 金额相等：调拨行（单列 金额）↔ 银行行（双列 |Credit-Debit|），精确到分，容差 0。
//   银行侧复用 bankAmountAbs（禁重写）；两侧都必须有限数（防 NaN 误判相等）。
function dispatchBankAmountEqual(dispRow, bankRow) {
  const dispAbs = dispatchAmountAbs(dispRow);
  const bankAbs = bankAmountAbs(bankRow);
  if (!Number.isFinite(dispAbs) || !Number.isFinite(bankAbs)) return false;
  return Math.round(dispAbs * 100) === Math.round(bankAbs * 100);
}

/**
 * R3.5：DBS-Charge 资金校验（🔴🔴）。对称模型两步：
 *   步骤1：调拨对账单 ↔ DBS 银行行严格 1v1（两阶段，防 in/out 同 ReconID 互相覆盖）—— 命中行 FundType 标为该调拨行
 *          fund_type（FundTransfer-in/out）+ 赋 ReconciliationId；同 ReconID 非命中行归并为 Charge。
 *   步骤2：用步骤1改后的新 ReconciliationId 关联白名单网关行，对候选（FundType∈{Charge,outbound}）按 amount/currency 精确判定：
 *          命中且 Credit Amount=0 → outbound；方向不符保持原值并告警；未命中 → Charge。FundTransfer 命中行不参与。
 *
 * @param {Array<Object>} gwRows             网关对账单行（全量，原引用，含 reconciliationid / TradeType / amount / currency）。
 *                                            步骤2 仅索引固定 TradeType 白名单，不复用 R1 matchedGwRows。
 * @param {Array<Object>} bankRows           R3 透传：全量银行行（原引用，含 Channel / MerchantId / Currency /
 *                                            Credit Amount / Debit Amount / FundType / ReconciliationId / _rowId）。
 * @param {Array<Object>} dispatchReconRows  需求1 调拨对账单派生行（含 付款渠道/收款渠道/big_account/币种/金额/ReconID）。
 * @param {Object} [options]
 * @param {Object} [options.config] 见 DEFAULT_CONFIG（bankChannel/dispatchChannelValue/setFundTypeCharge/setFundTypeOutbound）。
 * @returns {{ modifications: Array<{rowId,column,oldValue,newValue}>, warnings: Array }}
 *   modifications：实际改写过的行（ReconciliationId 或 FundType 列），用于标黄。
 */
function runDbsChargeFundCheck(gwRows, bankRows, dispatchReconRows, options = {}) {
  const warningCollector = makeWarningCollector('dbs-charge-fund-check', 'DBS-Charge资金校验');
  const modCollector = makeModificationCollector();

  const config = { ...DEFAULT_CONFIG, ...(options && options.config ? options.config : {}) };
  const bankChannel = config.bankChannel;
  const dispatchChannelValue = config.dispatchChannelValue;
  const setFundTypeCharge = config.setFundTypeCharge;
  const setFundTypeOutbound = config.setFundTypeOutbound;
  // 'dbs-only'（默认）时步骤1末批量置 Charge 仅波及 Channel===bankChannel 的同 reconId 行；'all' 时全量。
  const chargeSiblingsDbsOnly = config.chargeSiblingsScope === 'dbs-only';
  const datePolicy = normalizeFundTransferDatePolicy(options);
  const dateToleranceDays = datePolicy.toleranceDays;

  const emptyResult = () => ({
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  });

  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeDispRows = Array.isArray(dispatchReconRows) ? dispatchReconRows : [];

  // ===== 门控：仅 Channel===bankChannel 的银行行参与（DBS 专属）=====
  //   dbsBankRows 空（无任何 DBS 行）→ 整体 no-op，返回空 modifications（步骤2 同样无桶可跑）。
  const dbsBankRows = safeBankRows.filter(
    (b) => valuesEqual(b && b[BANK_CHANNEL_FIELD], bankChannel)
  );
  if (dbsBankRows.length === 0) {
    return emptyResult();
  }

  // ============================================================
  // 步骤1（对称模型）：调拨对账单 ↔ DBS 银行行严格 1v1 —— 命中行标 FundTransfer-in/out + 赋 ReconciliationId + 归并 Charge
  // ============================================================
  //   dispRows：方向感知门控（v3.0.6 codex-pr74-fix P1，见下方块注释）—— in 判收款渠道、out 判付款渠道，
  //     另一列由 builder 按 D1 留空、不参与判定；且 big_account 非空（🔴 资金红线护栏：valuesEqual('','')===true，
  //     空 big_account 的调拨行会误命中 MerchantId 也为空的银行行并写错 ReconciliationId / 误触发归并；与
  //     r5-fund-transfer-recon line162 口径一致，空 big_account 不进 dispRows → 不匹配、不赋 ReconciliationId、不触发归并 Charge）。
  // v3.0.6 codex-pr74-fix P1（🔴 资金红线）：方向感知门控（用户决策）。
  //   builder 按 D1 单向渠道固化（in 行只填收款渠道、out 行只填付款渠道，另一列留空）；
  //   原 both=DBS 门控对派生行恒不成立 → 需求3 整体失效。改为按 fund_type 判方向通道：
  //     FundTransfer-in  → 收款渠道 === dispatchChannelValue（付款渠道留空不判）
  //     FundTransfer-out → 付款渠道 === dispatchChannelValue（收款渠道留空不判）
  //   空 big_account 护栏不变。语义：捕获任何含 DBS 腿的调拨腿。
  const dispRows = safeDispRows.filter((d) => {
    if (normalizeCellValue(d && d[DISP_BIG_ACCOUNT_FIELD]) === '') return false;
    const ft = normalizeCellValue(d && d[DISP_FUND_TYPE_FIELD]);
    if (ft === FT_RECON_FIELD_MAP.FUND_TYPE_IN) {
      return valuesEqual(d && d[DISP_RECEIVE_CHANNEL_FIELD], dispatchChannelValue);
    }
    if (ft === FT_RECON_FIELD_MAP.FUND_TYPE_OUT) {
      return valuesEqual(d && d[DISP_PAY_CHANNEL_FIELD], dispatchChannelValue);
    }
    return false; // 未知/空方向 → 不参与
  });

  // 严格 1v1：一条 DBS 银行行最多被一条调拨行赋值（防一行被多调拨行重复覆盖）。
  //   用 Set 存已被消费银行行的对象引用（_rowId 可能未注入时退化为对象引用，仍 1v1）。
  const usedBankRows = new Set();

  // 🔴 两阶段化（防 in/out 同 ReconID 互相覆盖）：一笔调拨单的 in 行和 out 行 ReconID 相同（都=渠道流水号）。
  //   若边匹配边归并，out 行的归并会把 in 行刚标的 FundTransfer-in 命中行覆盖成 Charge。
  //   阶段A 先把所有命中行收集进 matchedBankRows（对象引用），阶段B 归并时排除该 Set —— 所有 FundTransfer 命中行都被保护。
  const matchedBankRows = new Set(); // 阶段A 标记的所有命中行（对象引用，阶段B 归并护栏）
  const mergeReconKeys = new Set();  // 阶段A 实际赋到银行行的 ReconID 键集合（阶段B 据此归并）
  const warnedCandidateFailures = new Set();
  const bankOriginalIndex = new Map();
  safeBankRows.forEach((row, index) => {
    if (!bankOriginalIndex.has(row)) bankOriginalIndex.set(row, index);
  });

  const expectedDirectionForDispatch = (dispatchRow) =>
    normalizeCellValue(dispatchRow && dispatchRow[DISP_FUND_TYPE_FIELD]) === FT_RECON_FIELD_MAP.FUND_TYPE_OUT
      ? 'DEBIT'
      : 'CREDIT';

  const warnDirectionFailure = (bankRow, expectedDirection, result) => {
    const key = `direction\u0000${String(bankRow && bankRow[BANK_ROW_ID_FIELD])}\u0000${expectedDirection}\u0000${result.code}`;
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow[BANK_ROW_ID_FIELD],
      engine: 'dbs-charge-fund-check-step1',
      code: DIRECTION_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason: result.code,
      message: `DBS 调拨近似候选银行行(${bankRow && bankRow[BANK_ROW_ID_FIELD]})未通过 ${expectedDirection} 方向校验（${result.code}），未进入可写候选`
    });
  };

  const warnDateFailure = (dispatchRow, bankRow) => {
    const counterpartDate = toDate(dispatchRow && dispatchRow[DISP_BILL_DATE_FIELD]);
    const bankDate = toDate(bankRow && bankRow.BillDate);
    const reason = !counterpartDate
      ? 'counterpart-date-invalid'
      : !bankDate
        ? 'bank-date-invalid'
        : 'outside-tolerance';
    const expectedDirection = expectedDirectionForDispatch(dispatchRow);
    // 同账号/币种/金额密集组可能形成 N 来源 × M 银行的日期失败边；warning 本身不含来源身份，
    // 按 sourceIndex 去重只会产出 N×M 条用户不可区分的重复告警。收敛为每个具体银行行 /
    // 期望方向 / 失败原因一条；bankOriginalIndex 在 _rowId 缺失或重复时仍能区分真实银行行。
    const key = [
      'date',
      bankOriginalIndex.get(bankRow) ?? '',
      String(bankRow && bankRow[BANK_ROW_ID_FIELD]),
      expectedDirection,
      reason
    ].join('\u0000');
    if (warnedCandidateFailures.has(key)) return;
    warnedCandidateFailures.add(key);
    warningCollector.push({
      rowId: bankRow && bankRow[BANK_ROW_ID_FIELD],
      engine: 'dbs-charge-fund-check-step1',
      code: DATE_MISMATCH_WARNING_CODE,
      expectedDirection,
      reason,
      message: `DBS 调拨近似候选银行行(${bankRow && bankRow[BANK_ROW_ID_FIELD]})未通过日期策略（${reason}），未进入可写候选`
    });
  };

  const directionEligibleCandidates = (dispatchRow) => {
    const dispatchMerchantId = normalizeCellValue(dispatchRow && dispatchRow[DISP_BIG_ACCOUNT_FIELD]);
    const dispatchCurrency = normalizeCellValue(dispatchRow && dispatchRow[DISP_CURRENCY_FIELD]);
    const expectedDirection = expectedDirectionForDispatch(dispatchRow);
    const nearCandidates = dbsBankRows.filter((bankRow) => {
      const bankMerchantId = normalizeCellValue(bankRow && bankRow[BANK_MERCHANT_ID_FIELD]);
      const bankCurrency = normalizeCellValue(bankRow && bankRow[BANK_CURRENCY_FIELD]);
      return (
        !usedBankRows.has(bankRow) &&
        dispatchMerchantId !== '' &&
        bankMerchantId !== '' &&
        dispatchMerchantId === bankMerchantId &&
        dispatchCurrency !== '' &&
        bankCurrency !== '' &&
        dispatchCurrency === bankCurrency &&
        dispatchBankAmountEqual(dispatchRow, bankRow)
      );
    });
    const eligible = [];
    for (const bankRow of nearCandidates) {
      const directionResult = validateBankDirection(bankRow, expectedDirection);
      if (directionResult.ok) {
        eligible.push(bankRow);
      } else {
        warnDirectionFailure(bankRow, expectedDirection, directionResult);
      }
    }
    return eligible;
  };

  const applyDispatchMatch = (dispatchRow, candidates) => {
    if (candidates.length === 0) return false;

    if (candidates.length > 1) {
      // 多候选 → 取原序首行（dbsBankRows 顺序，即 bankRows 原序）+ warning（数据脏）。
      warningCollector.push({
        rowId: candidates[0][BANK_ROW_ID_FIELD],
        code: 'multi-bank-match-dispatch',
        message: `调拨对账单在 DBS 银行行中匹配到 ${candidates.length} 行可用候选，取原序最前一条（数据脏）`
      });
    }

    const chosen = candidates[0];
    usedBankRows.add(chosen);     // 🔴 严格 1v1 单向消费
    matchedBankRows.add(chosen);  // 🔴 命中行进保护集（阶段B 归并排除，防 in/out 互相覆盖）

    const newReconId = normalizeCellValue(dispatchRow && dispatchRow[DISP_RECON_ID_FIELD]);
    const oldReconId = normalizeCellValue(chosen[BANK_RECON_ID_FIELD]);
    // 命中即覆盖（含非空原值）；normalize 后非空且与原值不同才写、才 record（同 R5s2 语义）。
    if (newReconId !== '' && oldReconId !== newReconId) {
      chosen[BANK_RECON_ID_FIELD] = newReconId; // 🔴 原地改写银行行 ReconciliationId
      modCollector.record(chosen[BANK_ROW_ID_FIELD], BANK_RECON_ID_FIELD, oldReconId, newReconId);
    }

    // 🔴 命中行 FundType 标为该调拨行 fund_type（FundTransfer-in 或 -out，按调拨方向；经常量取，绝不手敲）。
    //   normalize 后非空且与原值不同才写、才 record（旧值===新值时 no-op，不留痕）。
    const newFundType = normalizeCellValue(dispatchRow && dispatchRow[DISP_FUND_TYPE_FIELD]);
    const oldChosenFundType = normalizeCellValue(chosen[BANK_FUND_TYPE_FIELD]);
    if (newFundType !== '' && oldChosenFundType !== newFundType) {
      chosen[BANK_FUND_TYPE_FIELD] = newFundType; // 🔴 命中行标 FundTransfer-in/out
      modCollector.record(chosen[BANK_ROW_ID_FIELD], BANK_FUND_TYPE_FIELD, oldChosenFundType, newFundType);
    }

    // 记录归并键（阶段B 据此把同 ReconID 非命中行归 Charge）；空键不可归并。
    if (newReconId !== '') mergeReconKeys.add(newReconId);
    return true;
  };

  // ===== 阶段A：匹配 + 赋 ReconciliationId + 标命中行 FundType=FundTransfer-in/out（不归并）=====
  // 日期关闭时完全跳过日期；日期开启时先让所有调拨行跑严格同日，再仅让未命中行跑 ±N。
  if (!datePolicy.enabled) {
    for (const dispatchRow of dispRows) {
      applyDispatchMatch(dispatchRow, directionEligibleCandidates(dispatchRow));
    }
  } else {
    const unmatchedAfterSameDay = [];
    for (const dispatchRow of dispRows) {
      const directionEligible = directionEligibleCandidates(dispatchRow);
      for (const bankRow of directionEligible) {
        if (
          !dayDiffWithin(
            dispatchRow && dispatchRow[DISP_BILL_DATE_FIELD],
            bankRow && bankRow.BillDate,
            dateToleranceDays
          )
        ) {
          warnDateFailure(dispatchRow, bankRow);
        }
      }
      const sameDayCandidates = directionEligible.filter(
        (bankRow) =>
          sameDay(
            dispatchRow && dispatchRow[DISP_BILL_DATE_FIELD],
            bankRow && bankRow.BillDate
          )
      );
      if (!applyDispatchMatch(dispatchRow, sameDayCandidates)) {
        unmatchedAfterSameDay.push(dispatchRow);
      }
    }

    for (const dispatchRow of unmatchedAfterSameDay) {
      const directionEligible = directionEligibleCandidates(dispatchRow);
      const withinTolerance = [];
      for (const bankRow of directionEligible) {
        if (
          dayDiffWithin(
            dispatchRow && dispatchRow[DISP_BILL_DATE_FIELD],
            bankRow && bankRow.BillDate,
            dateToleranceDays
          )
        ) {
          withinTolerance.push(bankRow);
        } else {
          // near-candidate 的日期失败原因必须逐条可审计，即使同一来源另有合法候选最终成功。
          warnDateFailure(dispatchRow, bankRow);
        }
      }
      const counterpartDate = toDate(dispatchRow && dispatchRow[DISP_BILL_DATE_FIELD]);
      const dayDiffAbs = (bankRow) => {
        const bankDate = toDate(bankRow && bankRow.BillDate);
        if (!counterpartDate || !bankDate) return Number.POSITIVE_INFINITY;
        return Math.abs(Math.round((counterpartDate.getTime() - bankDate.getTime()) / MS_PER_DAY));
      };
      withinTolerance.sort(
        (a, b) =>
          dayDiffAbs(a) - dayDiffAbs(b) ||
          (bankOriginalIndex.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (bankOriginalIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
      );
      applyDispatchMatch(dispatchRow, withinTolerance);
    }
  }

  // ===== 阶段B：归并（🔴 最大红线）—— 同 ReconId + 不在命中行 Set + 非 Charge → 置 Charge =====
  //   对阶段A 实际赋到银行行的每个 ReconID 键，遍历【全量 bankRows】（chargeSiblingsScope='dbs-only' 仅 DBS / 'all' 全渠道），对：
  //     - b ∉ matchedBankRows（所有 FundTransfer 命中行都被保护，不被归并；含本键 + 其他键的命中行）
  //     - normalize(b.ReconciliationId) === 键（同 reconId）
  //     - normalize(b.FundType) !== setFundTypeCharge（非 Charge 才改；已 Charge 跳过 no-op）
  //   → b.FundType = setFundTypeCharge + record('FundType')。
  for (const key of mergeReconKeys) {
    for (const b of safeBankRows) {
      if (matchedBankRows.has(b)) continue; // 🔴 所有命中行（含 in/out 同 ReconID 的对方）受保护，不被归并
      // chargeSiblingsScope='dbs-only'（默认）→ 仅 Channel===bankChannel 行参与归并；非 DBS 渠道行不波及。
      //   'all'（经 config 切回）不进此分支 → 忠于 plan 原文「搜全量银行单」全渠道波及。
      if (chargeSiblingsDbsOnly && !valuesEqual(b && b[BANK_CHANNEL_FIELD], bankChannel)) continue;
      if (normalizeCellValue(b && b[BANK_RECON_ID_FIELD]) !== key) continue; // 同 reconId
      if (!validateBankDirection(b, 'DEBIT').ok) continue; // Stage B 只允许真实严格出账 sibling 归 Charge
      const oldFundType = normalizeCellValue(b && b[BANK_FUND_TYPE_FIELD]);
      if (oldFundType === setFundTypeCharge) continue; // 已 Charge → no-op，不 record
      b[BANK_FUND_TYPE_FIELD] = setFundTypeCharge; // 🔴 原地归并为 Charge
      modCollector.record(b[BANK_ROW_ID_FIELD], BANK_FUND_TYPE_FIELD, oldFundType, setFundTypeCharge);
    }
  }

  // ============================================================
  // 步骤2（对称模型）：白名单网关 amount/currency 找真正 outbound 行；同 ID 未命中候选行归 Charge
  // ============================================================
  //   gwByReconId：仅固定 TradeType 白名单网关行按 normalize(reconciliationid) 分桶（空键跳过）。
  //   bankByReconId：DBS 银行行按 normalize(ReconciliationId)【步骤1改后的新值】分桶（空键跳过）。
  //   ⚠️ 用步骤1改后的新 ReconciliationId 自建网关索引（不复用 R1 matchedGwRows）。
  //   候选命中且 Credit Amount=0 → outbound；方向不符保持原值并告警；候选未命中 → Charge。
  //   FundTransfer-in/out 命中行（步骤1标）不在候选内（候选仅 {Charge,outbound}），不被步骤2 碰，保持 FundTransfer。
  const gwByReconId = new Map();
  for (const g of safeGwRows) {
    const tradeType = normalizeCellValue(g && g[GW_TRADE_TYPE_FIELD]);
    if (!STEP2_GW_TRADE_TYPE_WHITELIST.has(tradeType)) continue;
    const key = normalizeCellValue(g && g[GW_RECON_ID_FIELD]);
    if (key === '') continue; // 空键跳过
    if (!gwByReconId.has(key)) gwByReconId.set(key, []);
    gwByReconId.get(key).push(g);
  }

  const bankByReconId = new Map();
  for (const b of dbsBankRows) {
    const key = normalizeCellValue(b && b[BANK_RECON_ID_FIELD]); // 步骤1改后的新 ReconciliationId
    if (key === '') continue; // 空键跳过
    if (!bankByReconId.has(key)) bankByReconId.set(key, []);
    bankByReconId.get(key).push(b);
  }

  for (const [reconId, bucket] of bankByReconId) {
    const gwForKey = gwByReconId.get(reconId) || [];
    if (gwForKey.length === 0) continue; // 该 reconId 无白名单网关行 → 不动（保持步骤1 后的 FundType）

    // candidates = FundType ∈ {setFundTypeCharge, setFundTypeOutbound}（⚠️ 两类「值」，非方向过滤）。
    const candidates = bucket.filter((b) => {
      const ft = normalizeCellValue(b && b[BANK_FUND_TYPE_FIELD]);
      return ft === setFundTypeCharge || ft === setFundTypeOutbound;
    });

    for (const b of candidates) {
      const oldFundType = normalizeCellValue(b[BANK_FUND_TYPE_FIELD]);

      // v3.0.21：沿 R4 出账方向守卫口径，且先于金额/币种判定。
      // 空/非法 Credit Amount 按0；非0时保持进入步骤2前的原值，不允许后续 outbound→Charge 回落。
      if ((parseNumber(b[BANK_CREDIT_AMOUNT_FIELD]) || 0) !== 0) {
        warningCollector.push({
          rowId: b[BANK_ROW_ID_FIELD],
          code: 'dbs-charge-fund-direction-mismatch',
          message: `DBS 银行行(${b[BANK_ROW_ID_FIELD]}) 存在同对账ID白名单网关候选，但 ${BANK_CREDIT_AMOUNT_FIELD} 非0，方向不符，跳过步骤2 FundType 改写`
        });
        continue;
      }

      // 方向通过后再判命中：网关桶内存在某行 amount 精确到分相等且币种相等。
      const hit = gwForKey.some(
        (g) =>
          bankAmountEqualWithoutExtraFee(g, b) &&
          valuesEqual(g && g[GW_CURRENCY_FIELD], b && b[BANK_CURRENCY_FIELD])
      );

      if (hit) {
        // 命中 → outbound（old!==目标才 record；已 outbound → no-op，步骤2 多笔幂等）。
        if (oldFundType !== setFundTypeOutbound) {
          b[BANK_FUND_TYPE_FIELD] = setFundTypeOutbound; // 🔴 转 outbound
          modCollector.record(b[BANK_ROW_ID_FIELD], BANK_FUND_TYPE_FIELD, oldFundType, setFundTypeOutbound);
        }
      } else {
        // 🔴 未命中 → Charge（语义翻转）。候选 ∈ {Charge,outbound}：已 Charge → no-op；outbound（步骤1/2 误置或上游带入）回落 Charge。
        if (oldFundType !== setFundTypeCharge) {
          b[BANK_FUND_TYPE_FIELD] = setFundTypeCharge; // 🔴 未命中候选行置 Charge
          modCollector.record(b[BANK_ROW_ID_FIELD], BANK_FUND_TYPE_FIELD, oldFundType, setFundTypeCharge);
        }
      }
    }
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

module.exports = {
  runDbsChargeFundCheck,
  dispatchBankAmountEqual,
  dispatchAmountAbs
};
