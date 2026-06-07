// v2.1.16-beta.2：R4 资金性质校验引擎（🔴 资金红线）
// TECH_DESIGN §5.2 / §10（五子场景判定表）/ §4（跨表字段映射）；PRD §五 / 需求5 R5.1~R5.4
//
// 性质：5 轮对账编排器的第 4 轮，且是**唯一允许二次改写银行 FundType 的轮次**。
//       按 reconciliationid 关联「R1 匹配成功的网关行 × 全量银行行」，跑可插拔 handler 改写 FundType。
//       改错直接改资金性质 —— 五子场景判定条件 / 叠加链顺序须人工复核（见结尾「关联功能 review」）。
//
// ⚠️ 跨表字段名不同，必须显式映射，绝不假设同名（TECH_DESIGN §4）：
//   - 网关行（matchedGwRows，来自 R1 产出 = 网关行原引用，真实表头小写）：
//       对账ID = row.reconciliationid（小写）；交易类型 = row.TradeType
//   - 银行行（bankRows，全量，R3 透传）：
//       对账ID = row.ReconciliationId（驼峰）；资金性质 = row.FundType；行唯一键 = row._rowId（上游注入）
//
// 关联口径（TECH_DESIGN §11 Q6 默认 + 本任务点3 确认）：
//   - R4 **重新**按 reconciliationid 关联，不直接复用 R1 的 pairs（R1 只给 matchedGwRows）。
//   - reconciliationid === ReconciliationId，大小写敏感（沿用 normalizeCellValue 仅 trim，不改大小写）。
//   - 空键（reconid 为空）→ 跳过不参与关联。
//
// 改写规则（与 C1/C3 一致）：
//   - 旧值 !== 目标值 才改、才 record（no-op 不产 modification、不标黄）。
//   - record 后**不 break** —— 允许后续 handler 在已改值基础上再次改写（叠加链，R4 唯一）。
//
// 可插拔 handler（判定全部 config 化，存 seed config_json）：
//   config = { subCategory, gwTradeType?, requireBankFundType?, setFundType }
//     - gwTradeType        在 → 需 normalizeCellValue(gw.TradeType) === gwTradeType，否则不命中
//     - requireBankFundType 在 → 需 normalizeCellValue(bank.FundType) === requireBankFundType，否则不命中
//     - 两者都不在 → 仅凭「有 R1 匹配（即进入本关联）」即命中（如 Charge→outbound 仅看 FundType=Charge）
//   命中 → 返回 setFundType；不命中 → 返回 null。

const {
  normalizeCellValue,
  makeModificationCollector,
  makeWarningCollector
} = require('./engine-utils');

// R4 跨表字段名常量（显式映射，绝不假设同名 —— TECH_DESIGN §4）
const GW_RECON_ID_FIELD = 'reconciliationid'; // 网关行：真实表头小写
const GW_TRADE_TYPE_FIELD = 'TradeType';       // 网关行：交易类型
const BANK_RECON_ID_FIELD = 'ReconciliationId'; // 银行行：驼峰
const BANK_FUND_TYPE_FIELD = 'FundType';        // 银行行：资金性质（🔴 改写目标列）

/**
 * 可插拔 handler：依 config 判定一条「网关行 × 银行行」是否命中本子场景。
 *
 * @param {Object} gwRow   网关行（含 reconciliationid / TradeType）
 * @param {Object} bankRow 银行行（含 FundType）
 * @param {{ subCategory?:string, gwTradeType?:string, requireBankFundType?:string, setFundType:string }} config
 * @returns {string|null} 命中 → config.setFundType（要改成的 FundType）；不命中 → null
 */
function applyHandler(gwRow, bankRow, config) {
  if (!config) return null;

  // 条件 1：网关 TradeType 过滤（config.gwTradeType 存在才校验）
  if (config.gwTradeType !== undefined && config.gwTradeType !== null && config.gwTradeType !== '') {
    if (normalizeCellValue(gwRow && gwRow[GW_TRADE_TYPE_FIELD]) !== config.gwTradeType) {
      return null;
    }
  }

  // 条件 2：银行 FundType（改写前）过滤（config.requireBankFundType 存在才校验）
  if (
    config.requireBankFundType !== undefined &&
    config.requireBankFundType !== null &&
    config.requireBankFundType !== ''
  ) {
    if (normalizeCellValue(bankRow && bankRow[BANK_FUND_TYPE_FIELD]) !== config.requireBankFundType) {
      return null;
    }
  }

  // 命中 → 返回要改成的 FundType（叠加链由主循环驱动）
  return config.setFundType;
}

/**
 * R4：资金性质校验（🔴）。按 reconciliationid 关联 matchedGwRows × 全量 bankRows，
 * 跑可插拔 handler（按 priority 降序、同 priority 保持数组原序）改写银行 FundType，允许多次改。
 *
 * @param {Array<Object>} matchedGwRows R1 产出：reconid 1v1 命中的网关行（原引用，含 reconciliationid / TradeType）
 * @param {Array<Object>} bankRows      R3 透传：全量银行行（原引用，含 ReconciliationId / FundType / _rowId）
 * @param {Array<{ priority?:number, config:{ subCategory?:string, gwTradeType?:string, requireBankFundType?:string, setFundType:string } }>} r4Scenarios
 *        R4 五子场景配置；引擎内按 priority 降序排序后执行（同 priority 保持数组原序，deterministic）
 * @returns {{ modifications: Array<{rowId,column,oldValue,newValue}>, warnings: Array }}
 */
function runRound4FundNatureCheck(matchedGwRows, bankRows, r4Scenarios) {
  const warningCollector = makeWarningCollector('R4', '资金性质校验');
  const modCollector = makeModificationCollector();

  // ===== Step 0：空入参防御（任一为空/非数组 → 无可改写，返回空 modifications）=====
  const safeGwRows = Array.isArray(matchedGwRows) ? matchedGwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeScenarios = Array.isArray(r4Scenarios) ? r4Scenarios : [];
  if (safeGwRows.length === 0 || safeBankRows.length === 0 || safeScenarios.length === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  // ===== Step 1：场景排序 —— priority 降序，同 priority 保持数组原序（稳定排序，deterministic）=====
  // 用 (originalIndex) 作为同 priority 的次序键，避免 Array.sort 在部分引擎下不稳定的问题。
  const scenariosSorted = safeScenarios
    .map((scenario, originalIndex) => ({ scenario, originalIndex }))
    .filter((x) => x.scenario && x.scenario.config) // 无 config 的条目跳过（防御）
    .sort((a, b) => {
      const pa = Number.isFinite(a.scenario.priority) ? a.scenario.priority : 0;
      const pb = Number.isFinite(b.scenario.priority) ? b.scenario.priority : 0;
      if (pb !== pa) return pb - pa;        // priority 降序（高优先级先跑）
      return a.originalIndex - b.originalIndex; // 同 priority → 数组原序
    })
    .map((x) => x.scenario);

  // ===== Step 2：建银行索引 bankByReconId: Map<key, bankRow[]> =====
  //   - key = normalizeCellValue(bank.ReconciliationId)（仅 trim，大小写敏感）
  //   - key === '' 的银行行不入索引（空 reconid 不参与关联）
  //   - 同 key 多条银行行 → 同一桶按原序追加（一个 reconid 关联多条银行行时逐条都跑 handler）
  const bankByReconId = new Map();
  for (const bankRow of safeBankRows) {
    const key = normalizeCellValue(bankRow && bankRow[BANK_RECON_ID_FIELD]);
    if (key === '') continue;
    if (!bankByReconId.has(key)) bankByReconId.set(key, []);
    bankByReconId.get(key).push(bankRow);
  }

  // ===== Step 3：按 matchedGwRows 原序关联并改写（deterministic）=====
  for (const gwRow of safeGwRows) {
    const key = normalizeCellValue(gwRow && gwRow[GW_RECON_ID_FIELD]);
    if (key === '') continue; // 网关行空 reconid → 不参与关联

    const relatedBankRows = bankByReconId.get(key) || [];
    if (relatedBankRows.length === 0) continue; // 该网关行在银行侧无对应 → 跳过无改动

    for (const bankRow of relatedBankRows) {
      // 同一银行行逐 handler 跑：允许多次改 FundType（叠加链），故**不 break**
      for (const scenario of scenariosSorted) {
        const decision = applyHandler(gwRow, bankRow, scenario.config); // 命中 → 目标 FundType；否则 null
        if (decision === null || decision === undefined) continue;

        const oldValue = normalizeCellValue(bankRow[BANK_FUND_TYPE_FIELD]);
        // 旧 !== 新 才改、才 record（no-op 不产 modification、不标黄；与 C1/C3 一致）
        if (oldValue !== decision) {
          bankRow[BANK_FUND_TYPE_FIELD] = decision; // 🔴 原地改写银行行 FundType
          modCollector.record(bankRow._rowId, BANK_FUND_TYPE_FIELD, oldValue, decision);
        }
        // 不 break —— 后续 handler 可在已改值基础上再改（R4 唯一允许二次改 FundType）
      }
    }
  }

  // ===== Step 4：返回（本引擎只取 modifications，不喂 first-match-wins 锁集）=====
  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

module.exports = {
  runRound4FundNatureCheck,
  applyHandler,
  GW_RECON_ID_FIELD,
  GW_TRADE_TYPE_FIELD,
  BANK_RECON_ID_FIELD,
  BANK_FUND_TYPE_FIELD
};
