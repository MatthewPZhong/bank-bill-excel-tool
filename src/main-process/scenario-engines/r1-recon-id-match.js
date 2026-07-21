// v2.1.16-beta.2：R1 对账ID匹配引擎
// TECH_DESIGN §5.1 / §3（轮间状态）/ §4（跨表字段映射）
//
// 性质：5 轮对账编排器的第 1 轮。仅建立网关行 ↔ 银行行的 1v1 配对关系（供退款过滤等既有流程使用），
//       **不改任何字段、不产 modification（不标黄）、不参与 R2 的 first-match-wins 锁集**。
//
// ⚠️ 跨表字段名不同，必须显式映射，绝不假设同名（TECH_DESIGN §4）：
//   - 网关行（gwRows，来自 linked_gateway_bill 的 raw_json，真实表头小写）：对账ID = row.reconciliationid
//   - 银行行（bankRows）：对账ID = row.ReconciliationId；行唯一键 = row._rowId（已由上游注入，全局唯一）
//
// 匹配口径：reconciliationid === ReconciliationId，大小写敏感（沿用 normalizeCellValue 仅 trim，不改大小写——Q6 默认）。
//
// 算法（仿 C3 的 1v1 单向消费，但键是单字段精确匹配 → 用 Map 提速）：
//   1. 空值防御：gwRows 非数组 / 为空 → warning('no-gateway-rows') + 返回空结果
//   2. 建银行索引 bankByReconId: Map<key, bankRow[]>，key = normalizeCellValue(bank.ReconciliationId)；
//      key === '' 的银行行跳过（空 reconid 不参与匹配）
//   3. usedBankRowId Set 保证严格 1v1（一条银行行只能被一条网关行命中）；
//      按 gwRows 原顺序遍历（deterministic）：
//        - key === '' → 跳过该网关行
//        - candidates = 同 key 银行行中未被消费的；为空 → 该网关行未命中
//        - candidates > 1 → warning('multi-bank-match-r1')，取第一条
//        - 命中 → usedBankRowId.add(chosen._rowId)，记 matchedGwRows / pairs
//   4. modifications = []（R1 不改字段、不标黄）；lockedRowIds = new Set()（R1 不参与 first-match-wins 锁）

const { normalizeCellValue, makeWarningCollector } = require('./engine-utils');

// R1 跨表字段名常量（显式映射，绝不假设同名 —— TECH_DESIGN §4）
const GW_RECON_ID_FIELD = 'reconciliationid'; // 网关行：真实表头小写
const BANK_RECON_ID_FIELD = 'ReconciliationId'; // 银行行：驼峰

/**
 * R1：对账ID 1v1 精确匹配。
 *
 * @param {Array<Object>} bankRows 银行对账单行（含 _rowId 全局唯一键 + ReconciliationId）
 * @param {Array<Object>} gwRows   网关对账单行（含 reconciliationid，真实表头小写）
 * @returns {{
 *   matchedGwRows: Array<Object>,                 // reconid 1v1 命中的网关行（原序，原引用）
 *   pairs: Array<{ gwRow: Object, bankRow: Object }>, // 配对（网关行 ↔ 银行行，均为原引用）
 *   modifications: Array,                         // R1 恒为 []（不改字段、不标黄）
 *   warnings: Array,                              // 收集器产出（no-gateway-rows / multi-bank-match-r1）
 *   lockedRowIds: Set                             // R1 恒为空 Set（不参与 first-match-wins 锁）
 * }}
 */
function runRound1ReconIdMatch(bankRows, gwRows) {
  const warningCollector = makeWarningCollector('R1', '对账ID匹配');

  // ===== Step 1：空值防御 —— gwRows 非数组 / 为空 → warning + 空结果 =====
  if (!Array.isArray(gwRows) || gwRows.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'no-gateway-rows',
      message: 'R1 对账ID匹配：网关对账单数据为空，无法建立配对'
    });
    return {
      matchedGwRows: [],
      pairs: [],
      modifications: [],
      warnings: warningCollector.list(),
      lockedRowIds: new Set()
    };
  }

  // ===== Step 2：建银行索引 bankByReconId: Map<key, bankRow[]> =====
  //   - key = normalizeCellValue(bank.ReconciliationId)（仅 trim，大小写敏感）
  //   - key === '' 的银行行不入索引（空 reconid 不参与匹配）
  //   - 同 key 多条银行行 → 同一桶按原序追加（保证 Step 3 取「第一条」= 银行原序最前，deterministic）
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const bankByReconId = new Map();
  for (const bankRow of safeBankRows) {
    const key = normalizeCellValue(bankRow && bankRow[BANK_RECON_ID_FIELD]);
    if (key === '') continue;
    if (!bankByReconId.has(key)) bankByReconId.set(key, []);
    bankByReconId.get(key).push(bankRow);
  }

  // ===== Step 3：严格 1v1 单向消费 —— 按 gwRows 原顺序遍历（deterministic）=====
  const usedBankRowId = new Set(); // 已被某条网关行命中的银行行 _rowId（一条银行行只能被命中一次）
  const matchedGwRows = [];
  const pairs = [];

  for (const gwRow of gwRows) {
    const key = normalizeCellValue(gwRow && gwRow[GW_RECON_ID_FIELD]);
    if (key === '') continue; // 网关行空 reconid → 不参与匹配

    const bucket = bankByReconId.get(key) || [];
    const candidates = bucket.filter((b) => !usedBankRowId.has(b._rowId));
    if (candidates.length === 0) continue; // 该网关行未命中（无同 key 银行行 / 已被抢空）

    if (candidates.length > 1) {
      warningCollector.push({
        rowId: null,
        code: 'multi-bank-match-r1',
        reconId: key,
        message: `R1 对账ID匹配：reconId「${key}」在银行对账单中匹配到 ${candidates.length} 行，取第一条（数据脏）`
      });
    }

    const chosen = candidates[0];
    usedBankRowId.add(chosen._rowId); // 单向消费：后续网关行不再命中这条银行行
    matchedGwRows.push(gwRow);
    pairs.push({ gwRow, bankRow: chosen });
  }

  // ===== Step 4：返回 —— R1 不改字段（modifications=[]）、不参与 first-match-wins 锁（lockedRowIds 空 Set）=====
  return {
    matchedGwRows,
    pairs,
    modifications: [],
    warnings: warningCollector.list(),
    lockedRowIds: new Set()
  };
}

module.exports = {
  runRound1ReconIdMatch,
  GW_RECON_ID_FIELD,
  BANK_RECON_ID_FIELD
};
