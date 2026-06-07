// v2.1.16-beta.2：5 轮对账编排器（🔴 资金红线集成核心）
// TECH_DESIGN §1（架构）/ §2（数据流）/ §3（5 轮模型与轮间状态）/ §5（各引擎）
//
// 性质：把 5 个已就绪并通过单测的引擎串成「R1 → R2 → R3 → R4 → R5」一条流水线。
//   - R1 reconid 1v1 匹配      → 得 matchedGwRows（不改字段、不标黄、不参与 first-match-wins 锁）
//   - R2 现有 dispatcher       → C1/C2/C3 + 现有「提取调拨ID」builtin-fixed，first-match-wins
//   - R3 占位 no-op            → 透传全量银行行（r3BankRows = 全量 bankRows）
//   - R4 资金性质校验（🔴）     → matchedGwRows × 全量 bank 按 reconid 关联，改写 FundType（唯一允许二次改）
//   - R5 场景2（FundTransfer）  → 同日/±1day 金额绝对值匹配 → 回填 ReconciliationId
//   - R5 场景3（Inbound-VA）    → reconid 1v1 → FundType≠Inbound 生成剔除行
//
// ⚠️ 跨轮状态与不变量（TECH_DESIGN §3）：
//   - bankRows 同一组对象引用贯穿 R1→R5：各引擎原地改字段，编排器**不**克隆 bankRows。
//   - modColsByRowId: Map<rowId, Set<column>> —— 跨 5 轮累积每行被改的列（标黄来源）。
//   - 行数守恒：modifiedRows.length + unmatchedRows.length === bankRows.length（filter 条件互否 + 全覆盖）。
//
// ⚠️ 与 prompt 伪代码的一处必要修正（资金红线 / 标黄正确性）：
//   重建 modifiedRows 时 out._modifiedColumns 必须是 **Set**（非 Array）。
//   依据：exceljs-writer.js writeBankStatementOutput 标黄走 `modifiedColumns.size` / `modifiedColumns.has(header)`
//        （src/main-process/exceljs-writer.js:91,93），Array 无 `.has` → 标黄会全部失效；
//        dispatcher 原生产出的 _modifiedColumns 同样是 Set（scenario-dispatcher.js:248）。
//        故此处保持 Set，与 writer 契约 + dispatcher 行为一致（见结尾报告说明）。
//
// R2 取值约定（TECH_DESIGN §3）：R2 仅取 dispatcher 的 modifications / errorReport / stats + modifiedRows 的
//   `_` 前缀命中元数据；其 modifiedRows 数据列是 R2 当时浅拷贝，R4/R5 之后已过时 → 不直接用，
//   改从「当前最新 bankRows」重建（见 buildOutputRows）。

const { runRound1ReconIdMatch } = require('./scenario-engines/r1-recon-id-match');
const { runRound4FundNatureCheck } = require('./scenario-engines/r4-fund-nature-check');
const { runRound5FundTransferBackfill } = require('./scenario-engines/r5-fund-transfer-backfill');
const { runRound5PlatformInboundCleanup } = require('./scenario-engines/r5-platform-inbound-cleanup');
const { runAllScenarios } = require('./scenario-dispatcher');

// 重建 modifiedRows 时需嫁接 R2 命中元数据，但要排除这两个（_rowId 是行键、_modifiedColumns 由编排器跨轮合并重算）
const META_EXCLUDE_KEYS = new Set(['_rowId', '_modifiedColumns']);

/**
 * 把 enabled 过的 scenarios 按轮次分桶。
 *
 * 分桶规则（TECH_DESIGN §1：funcCategory 入 config_json，不扩 scenarios.category 枚举）：
 *   - builtin-fixed + funcCategory==='fund-nature-check'                       → R4
 *   - builtin-fixed + funcCategory==='platform-order' + subCategory==='fund-transfer-backfill'  → R5 场景2
 *   - builtin-fixed + funcCategory==='platform-order' + subCategory==='platform-inbound-cleanup' → R5 场景3
 *   - 其余（含无 funcCategory 的 builtin-fixed=现有「提取调拨ID」+ 所有 C1/C2/C3）→ R2
 *
 * 入参 scenarios 已是 caller 过滤后的「启用(enabled)」集合 → 某 bucket 为空 = 该功能未启用/未 seed → 该轮跳过（no-op）。
 *
 * @param {Array<Object>} scenarios 已 enabled 过的场景数组
 * @returns {{ r2: Array, r4: Array, r5s2: Array, r5s3: Array }}
 */
function bucketScenarios(scenarios) {
  const r2 = [];
  const r4 = [];
  const r5s2 = [];
  const r5s3 = [];

  const list = Array.isArray(scenarios) ? scenarios : [];
  for (const s of list) {
    if (!s) continue;
    const fc = s.config && s.config.funcCategory;
    const sub = s.config && s.config.subCategory;
    if (s.category === 'builtin-fixed' && fc === 'fund-nature-check') {
      r4.push(s);
    } else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'fund-transfer-backfill') {
      r5s2.push(s);
    } else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'platform-inbound-cleanup') {
      r5s3.push(s);
    } else {
      r2.push(s); // 其余（含无 funcCategory 的 builtin-fixed + 所有 C1/C2/C3）→ R2
    }
  }

  return { r2, r4, r5s2, r5s3 };
}

/**
 * 从「当前最新 bankRows」重建 modifiedRows / unmatchedRows（🔴 关键：不用 dispatcher 的过时浅拷贝）。
 *
 *   - modifiedRows：bankRows 中「被任一轮改过列」的行（modColsByRowId 命中），数据列取当前最新值（经全部轮次）。
 *     · R2 命中行：把 dispatcher 浅拷贝里的 `_` 前缀命中元数据嫁接过来（排除 _rowId/_modifiedColumns）。
 *     · R4/R5 改的非 R2 命中行：进 modifiedRows、标黄对应列，但不带 R2 命中元数据
 *       （符合「不进 N5 命中场景行报表」——N5 报表只认 R2 元数据行）。
 *     · _modifiedColumns：跨轮合并后的 Set（标黄来源；必须是 Set，见文件头说明）。
 *   - unmatchedRows：bankRows 中「未被任何轮改列」的行（保留原始顺序 + 原始字段）。
 *
 * 行数守恒：filter(命中) 与 filter(!命中) 互否且全覆盖 → modifiedRows.length + unmatchedRows.length === bankRows.length。
 *
 * @param {Array<Object>} bankRows 经全部轮次原地演化后的银行行
 * @param {Map<string|number, Set<string>>} modColsByRowId rowId → 被改列集合
 * @param {Map<string|number, Object>} r2HitByRowId rowId → R2 dispatcher 浅拷贝命中行（含 `_` 元数据）
 * @returns {{ modifiedRows: Array<Object>, unmatchedRows: Array<Object> }}
 */
function buildOutputRows(bankRows, modColsByRowId, r2HitByRowId) {
  const modifiedRows = bankRows
    .filter((r) => modColsByRowId.has(r._rowId))
    .map((r) => {
      const out = { ...r }; // 当前最新行数据（经全部轮次）
      const r2hit = r2HitByRowId.get(r._rowId);
      if (r2hit) {
        // 把 R2 命中元数据嫁接过来（仅 `_` 前缀；排除 _rowId / _modifiedColumns）
        for (const k of Object.keys(r2hit)) {
          if (k.startsWith('_') && !META_EXCLUDE_KEYS.has(k)) {
            out[k] = r2hit[k];
          }
        }
      }
      // 跨轮合并后的标黄列：必须是 Set（exceljs-writer 标黄依赖 .size / .has；与 dispatcher 产出一致）
      out._modifiedColumns = new Set(modColsByRowId.get(r._rowId));
      return out;
    });

  const unmatchedRows = bankRows.filter((r) => !modColsByRowId.has(r._rowId));

  return { modifiedRows, unmatchedRows };
}

/**
 * 5 轮对账编排器：顺序 R1 → R2 → R3 → R4 → R5（bankRows 同一组引用原地演化）。
 *
 * @param {Object} params
 * @param {Array<Object>} params.bankRows 银行对账单行（含 _rowId 全局唯一键；R1→R5 原地演化）
 * @param {Array<Object>} params.gwRows   网关对账单行（链接表读回，真实小写表头）
 * @param {Array<Object>} params.scenarios 已 enabled 过的场景集合（caller 过滤）
 * @param {Object} [params.deps] dispatcher 双维调度可选依赖（{ channelsRepo, db }）；不传 → R2 走单维 first-match-wins
 * @returns {{
 *   modifiedRows: Array<Object>,
 *   unmatchedRows: Array<Object>,
 *   modifications: Array<Object>,
 *   errorReport: Array<Object>,
 *   stats: Object,
 *   platformCleanupRows: Array<Object>,
 *   rounds: Object
 * }}
 */
function runReconciliation({ bankRows, gwRows, scenarios, deps } = {}) {
  if (!Array.isArray(bankRows)) {
    throw new Error('runReconciliation: bankRows 必须是数组');
  }
  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const { r2: r2Bucket, r4: r4Bucket, r5s2: r5s2Bucket, r5s3: r5s3Bucket } = bucketScenarios(scenarios);

  // ===== 跨轮累积器 =====
  const modColsByRowId = new Map(); // rowId -> Set<column>（标黄来源，跨 5 轮合并）
  const mergeMods = (mods) => {
    for (const m of mods || []) {
      if (!m || m.rowId === undefined || m.rowId === null) continue;
      if (!modColsByRowId.has(m.rowId)) modColsByRowId.set(m.rowId, new Set());
      modColsByRowId.get(m.rowId).add(m.column);
    }
  };
  const allWarnings = []; // 汇总 errorReport
  const allMods = [];     // 汇总 modifications（带 _round 标记便于审计）

  // ===== R1：reconid 1v1 匹配（不改字段，仅得 matchedGwRows）=====
  const r1 = runRound1ReconIdMatch(bankRows, safeGwRows);
  allWarnings.push(...(r1.warnings || [])); // r1.modifications 恒空，不并入 allMods

  // ===== R2：现有 dispatcher（原地改 bankRows）=====
  //   只取它的 modifications / errorReport / stats + modifiedRows 的命中元数据；忽略其数据列浅拷贝（R4/R5 后会过时）。
  let r2 = { modifiedRows: [], unmatchedRows: [], modifications: [], errorReport: [], stats: {} };
  if (r2Bucket.length) {
    r2 = runAllScenarios(bankRows, safeGwRows, r2Bucket, deps);
  }
  mergeMods(r2.modifications);
  allWarnings.push(...(r2.errorReport || []));
  for (const m of r2.modifications || []) allMods.push({ ...m, _round: 'R2' });
  // 留 R2 命中元数据：rowId -> dispatcher 浅拷贝行（含 _hitScenarioId / _hitScenarioName / _modifiedColumns 等）
  const r2HitByRowId = new Map((r2.modifiedRows || []).map((r) => [r._rowId, r]));

  // ===== R3：占位 no-op（透传全量银行行）=====
  //   r3BankRows = bankRows（同一组引用）；R4/R5 直接对全量行操作。

  // ===== R4：资金性质校验（🔴，matchedGwRows × 全量 bank 按 reconid 关联，改 FundType）=====
  let r4ChangedCount = 0;
  if (r4Bucket.length) {
    const r4 = runRound4FundNatureCheck(r1.matchedGwRows, bankRows, r4Bucket);
    mergeMods(r4.modifications);
    allWarnings.push(...(r4.warnings || []));
    for (const m of r4.modifications || []) allMods.push({ ...m, _round: 'R4' });
    r4ChangedCount = (r4.modifications || []).length;
  }

  // ===== R5 场景2：回填 ReconciliationId =====
  let r5s2BackfilledCount = 0;
  if (r5s2Bucket.length) {
    const opt = r5s2Bucket[0].config || {};
    const r5a = runRound5FundTransferBackfill(safeGwRows, bankRows, {
      directions: opt.directions,
      dateToleranceDays: opt.dateToleranceDays
    });
    mergeMods(r5a.modifications);
    allWarnings.push(...(r5a.warnings || []));
    for (const m of r5a.modifications || []) allMods.push({ ...m, _round: 'R5s2' });
    r5s2BackfilledCount = (r5a.modifications || []).length;
  }

  // ===== R5 场景3：生成剔除行（一般不改银行行）=====
  let platformCleanupRows = [];
  if (r5s3Bucket.length) {
    const opt = r5s3Bucket[0].config || {};
    const r5b = runRound5PlatformInboundCleanup(safeGwRows, bankRows, {
      gwTradeType: opt.gwTradeType,
      excludeFundType: opt.excludeFundType
    });
    mergeMods(r5b.modifications); // 恒空，保留对称性
    allWarnings.push(...(r5b.warnings || []));
    for (const m of r5b.modifications || []) allMods.push({ ...m, _round: 'R5s3' });
    platformCleanupRows = r5b.cleanupRows || [];
  }

  // ===== 构造输出：从「当前最新 bankRows」重建（不用 dispatcher 过时浅拷贝）=====
  const { modifiedRows, unmatchedRows } = buildOutputRows(bankRows, modColsByRowId, r2HitByRowId);

  return {
    modifiedRows,
    unmatchedRows,
    modifications: allMods,
    errorReport: allWarnings,
    stats: {
      ...(r2.stats || {}),
      r1Matched: r1.matchedGwRows.length,
      r4ChangedCount,
      r5s2BackfilledCount,
      r5s3CleanupCount: platformCleanupRows.length
    },
    platformCleanupRows,
    rounds: {
      r1: { matched: r1.matchedGwRows.length },
      r2: {
        hitRowCount: (r2.stats && r2.stats.hitRowCount) || 0,
        scenarioHitCount: (r2.stats && r2.stats.scenarioHitCount) || 0
      },
      r4: { changed: r4ChangedCount },
      r5s2: { backfilled: r5s2BackfilledCount },
      r5s3: { cleanup: platformCleanupRows.length }
    }
  };
}

module.exports = {
  runReconciliation,
  bucketScenarios,
  buildOutputRows
};
