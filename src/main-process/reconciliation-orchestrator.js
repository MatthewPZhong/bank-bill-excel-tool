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
//   - R5 场景4（退款订单回填）   → Ach Return（未改写）行 × 退款订单 SUBMITTED 行唯一值分组 + 4基数×4策略匹配
//                                 → 产出独立双 sheet 回填模板（refundBackfillRows / refundUnmatchedRows，不改银行行）
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
// v3.0.6 需求2：R5s2 数据来源二选一 —— 勾选「对账数据来源为中台调拨单表」时改走本引擎（对手方=调拨对账单）。
const { runRound5FundTransferReconBackfill } = require('./scenario-engines/r5-fund-transfer-recon-backfill');
const { runRound5PlatformInboundCleanup } = require('./scenario-engines/r5-platform-inbound-cleanup');
const { runRound5RefundOrderBackfill } = require('./scenario-engines/r5-refund-order-backfill');
// v3.0.4 块 F：Payment线下调拨订单回填（R5 场景2b，R5s2 之后接线；🔴 网关回填优先互斥）
const { runRound5PaymentOfflineAllocationBackfill } = require('./scenario-engines/r5-payment-offline-allocation-backfill');
// v3.0.6 需求3：DBS-Charge 资金校验（R3.5，R3 后 R4 前；🔴 改 ReconciliationId + FundType；替换原全渠道 charge→outbound）
const { runDbsChargeFundCheck } = require('./scenario-engines/dbs-charge-fund-check');
const { runAllScenarios } = require('./scenario-dispatcher');

// 重建 modifiedRows 时需嫁接 R2 命中元数据，但要排除这两个（_rowId 是行键、_modifiedColumns 由编排器跨轮合并重算）
const META_EXCLUDE_KEYS = new Set(['_rowId', '_modifiedColumns']);

// v3.0.7 需求1a：_round（allMods 轮次标记）→ 中文轮次场景标签（钉死，禁臆造）。
//   仅用于 R4/R5 改写行——这些行无 R2 命中元数据（stats.hitScenarios / _hitScenarioName 仅由 R2 dispatcher 产出），
//   状态框「已处理」按 渠道-地区 分组展示场景名时，需用稳定的轮次中文标签兜底（来源 = allMods 该 rowId 的 _round）。
//   R2 不走此表（用 _hitScenarioName）；R5s3 cleanupRows / R5s4 backfillRows 不进 modifiedRows（mergeMods 恒空 / 不 mergeMods），
//   故几乎不会出现在 channelRegionHits（保留 R5s3 标签仅为完备，R5s4 永不出现无需标签）。
//   标签语义与各引擎对齐：R3.5=DBS-Charge 资金校验、R4=fund-nature-check 资金性质校验、
//   R5s2-recon=调拨对账单回填、R5s2=资金划转回填、R5s2b=Payment线下调拨回填、R5s3=平台Inbound剔除。
const ROUND_LABELS = {
  'R3.5': 'DBS-Charge资金校验',
  R4: '资金性质校验',
  'R5s2-recon': '调拨对账单回填',
  R5s2: '资金划转回填',
  R5s2b: 'Payment线下调拨回填',
  R5s3: '平台Inbound剔除'
};

/**
 * v3.0.7 需求1a：按「渠道-地区」聚合 modifiedRows，产出状态框「已处理」分支所需的命中明细。
 *
 * 🔴 红线：纯只读聚合——只对已产出的 modifiedRows 计行数 + 收集场景名，不改任何 bankRow 字段 /
 *   modifications / modColsByRowId / 行数守恒。属审计/展示增强，与 R1-R5 对账匹配值/派生口径完全解耦。
 *
 * channelRegion 单行口径【与 channel-enum-repository.js extractChannelRegionCombos 单行逻辑逐字一致（钉死同源）】：
 *   - Channel（trim 后）为空 → 跳过整行（不计入任何组合，与枚举/前缀口径一致）。
 *   - 地区（trim 后）为空 → channelRegion = Channel（不拼 'JPM-' 脏值）。
 *   - 地区非空 → channelRegion = `Channel-地区`。
 *   列键严格用 'Channel' 与中文 '地区' 字面量（与枚举仓储同源；内联实现以避免 main-process→backend 反向依赖，
 *   且 extractChannelRegionCombos 是「整批→去重数组」，无法直接复用于「单行→串 + 关联场景」）。
 *
 * 场景名来源（每行）：
 *   - R2 命中行：r._hitScenarioName（buildOutputRows 嫁接自 r2HitByRowId，源自 dispatcher）。
 *   - R4/R5-only 行（无 _hitScenarioName）：按 r._rowId 在 allMods 反查该行命中的 _round 集合，
 *     经 ROUND_LABELS 映射成稳定中文标签兜底（allMods 是 rowId→轮次的唯一可靠映射）。
 *
 * @param {Array<Object>} modifiedRows buildOutputRows 产出的命中行（已去重，每行只计一次）
 * @param {Array<Object>} allMods 汇总 modifications（每条带 _round 标记；行键 rowId）
 * @returns {Array<{ channelRegion: string, rowCount: number, scenarioNames: string[] }>}
 *   按 channelRegion 升序排序；scenarioNames 去重 + 升序排序；空集（无命中行 / 全部行 Channel 空）→ []。
 */
function buildChannelRegionHits(modifiedRows, allMods) {
  const rows = Array.isArray(modifiedRows) ? modifiedRows : [];
  // rowId → 该行命中的 _round 集合（O(allMods) 预构，供 R4/R5 行兜底反查轮次标签）
  const roundsByRowId = new Map();
  for (const m of Array.isArray(allMods) ? allMods : []) {
    if (!m || m.rowId === undefined || m.rowId === null || !m._round) continue;
    if (!roundsByRowId.has(m.rowId)) roundsByRowId.set(m.rowId, new Set());
    roundsByRowId.get(m.rowId).add(m._round);
  }

  // channelRegion → { rowCount, scenarioNameSet }
  const byCombo = new Map();
  for (const r of rows) {
    const obj = r && typeof r === 'object' ? r : {};
    const ch = obj.Channel === null || obj.Channel === undefined ? '' : String(obj.Channel).trim();
    if (ch === '') continue; // Channel 空 → 跳过整行（与枚举口径一致）
    const region = obj['地区'] === null || obj['地区'] === undefined ? '' : String(obj['地区']).trim();
    const channelRegion = region !== '' ? `${ch}-${region}` : ch;

    if (!byCombo.has(channelRegion)) {
      byCombo.set(channelRegion, { rowCount: 0, scenarioNameSet: new Set() });
    }
    const bucket = byCombo.get(channelRegion);
    bucket.rowCount += 1; // modifiedRows 已去重 → 每行只计一次

    // 场景名：R2 命中行用 _hitScenarioName；R4/R5-only 行用 allMods 轮次标签兜底。
    const hitName = obj._hitScenarioName;
    if (hitName !== null && hitName !== undefined && String(hitName) !== '') {
      bucket.scenarioNameSet.add(String(hitName));
    } else {
      const rounds = roundsByRowId.get(obj._rowId);
      if (rounds) {
        for (const rd of rounds) {
          const label = ROUND_LABELS[rd];
          if (label) bucket.scenarioNameSet.add(label);
        }
      }
    }
  }

  return Array.from(byCombo.entries())
    .map(([channelRegion, v]) => ({
      channelRegion,
      rowCount: v.rowCount,
      scenarioNames: Array.from(v.scenarioNameSet).sort()
    }))
    .sort((a, b) => (a.channelRegion < b.channelRegion ? -1 : a.channelRegion > b.channelRegion ? 1 : 0));
}

/**
 * 把 enabled 过的 scenarios 按轮次分桶。
 *
 * 分桶规则（TECH_DESIGN §1：funcCategory 入 config_json，不扩 scenarios.category 枚举）：
 *   - builtin-fixed + funcCategory==='dbs-charge-fund-check'                   → R3.5（v3.0.6 需求3）
 *   - builtin-fixed + funcCategory==='fund-nature-check'                       → R4
 *   - builtin-fixed + funcCategory==='platform-order' + subCategory==='fund-transfer-backfill'  → R5 场景2
 *   - builtin-fixed + funcCategory==='platform-order' + subCategory==='platform-inbound-cleanup' → R5 场景3
 *   - builtin-fixed + funcCategory==='platform-order' + subCategory==='refund-order-backfill'    → R5 场景4
 *   - 其余（含无 funcCategory 的 builtin-fixed=现有「提取调拨ID」+ 所有 C1/C2/C3）→ R2
 *
 * ⚠️ if/else 顺序：dbsChargeFundCheck 分支必须在最终 else（r2 兜底）之前命中，否则会漏进 R2 桶。
 *
 * 入参 scenarios 已是 caller 过滤后的「启用(enabled)」集合 → 某 bucket 为空 = 该功能未启用/未 seed → 该轮跳过（no-op）。
 *
 * @param {Array<Object>} scenarios 已 enabled 过的场景数组
 * @returns {{ dbsChargeFundCheck: Array, r2: Array, r4: Array, r5s2: Array, r5s3: Array, r5s4: Array }}
 */
function bucketScenarios(scenarios) {
  const dbsChargeFundCheck = []; // v3.0.6 需求3：R3.5 DBS-Charge 资金校验
  const r2 = [];
  const r4 = [];
  const r5s2 = [];
  const r5s3 = [];
  const r5s4 = [];

  const list = Array.isArray(scenarios) ? scenarios : [];
  for (const s of list) {
    if (!s) continue;
    const fc = s.config && s.config.funcCategory;
    const sub = s.config && s.config.subCategory;
    if (s.category === 'builtin-fixed' && fc === 'dbs-charge-fund-check') {
      dbsChargeFundCheck.push(s); // v3.0.6 需求3 → R3.5（注意：在 fund-nature-check / 兜底 else 之前命中，不漂 R4/R2）
    } else if (s.category === 'builtin-fixed' && fc === 'fund-nature-check') {
      r4.push(s);
    } else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'fund-transfer-backfill') {
      r5s2.push(s);
    } else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'platform-inbound-cleanup') {
      r5s3.push(s);
    } else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'refund-order-backfill') {
      r5s4.push(s);
    } else {
      r2.push(s); // 其余（含无 funcCategory 的 builtin-fixed + 所有 C1/C2/C3）→ R2
    }
  }

  return { dbsChargeFundCheck, r2, r4, r5s2, r5s3, r5s4 };
}

/**
 * 从「当前最新 bankRows」重建 modifiedRows / unmatchedRows（🔴 关键：不用 dispatcher 的过时浅拷贝）。
 *
 *   - modifiedRows：bankRows 中「被任一轮改过列 **或** 是 R2 命中行」的行，数据列取当前最新值（经全部轮次）。
 *     · R2 命中行：把 dispatcher 浅拷贝里的 `_` 前缀命中元数据嫁接过来（排除 _rowId/_modifiedColumns）。
 *     · R4/R5 改的非 R2 命中行：进 modifiedRows、标黄对应列，但不带 R2 命中元数据
 *       （符合「不进 N5 命中场景行报表」——N5 报表只认 R2 元数据行）。
 *     · _modifiedColumns：跨轮合并后的 Set（标黄来源；必须是 Set，见文件头说明）。
 *   - unmatchedRows：bankRows 中「既未被任何轮改列、又不是 R2 命中行」的行（保留原始顺序 + 原始字段）。
 *
 * 🔴 PR#62 P1 修复（保留 R2 锁定但未改值的命中行）：
 *   R2（dispatcher）first-match-wins 会「锁定一条银行行却不改任何值」——例如 C2 reconFields≥1
 *   配对成功后无条件锁定双方（scenario-engines/c2-offset-bill-mark.js:221-222），但 rightRow 的
 *   markValue.field 已等于目标值 → 不 record（同文件 :238 `if (oldValue===newValue) return;`），
 *   于是该行在 r2.modifiedRows 里（带 `_hitScenario*` 元数据、_modifiedColumns 为空 Set）却**无 modification 记录**
 *   → modColsByRowId 收不到它 → 旧逻辑只看 modColsByRowId.has 会把它误判进 unmatchedRows，
 *   导致它从主输出 sheet1 + 命中场景行报表消失（实际它已被 R2 消费）。
 *   修法：分区判定改为「有列改动 **或** 是 R2 命中行」（isHit）。R2 锁定未改值行 → 进 modifiedRows、
 *   带 R2 命中元数据、_modifiedColumns 为空 Set（不标黄但保留为命中）。
 *
 * 行数守恒：isHit 与 !isHit 互否且全覆盖 → modifiedRows.length + unmatchedRows.length === bankRows.length。
 *
 * @param {Array<Object>} bankRows 经全部轮次原地演化后的银行行
 * @param {Map<string|number, Set<string>>} modColsByRowId rowId → 被改列集合
 * @param {Map<string|number, Object>} r2HitByRowId rowId → R2 dispatcher 浅拷贝命中行（含 `_` 元数据）
 * @returns {{ modifiedRows: Array<Object>, unmatchedRows: Array<Object> }}
 */
function buildOutputRows(bankRows, modColsByRowId, r2HitByRowId) {
  // 命中判定：有列改动（任一轮 record）或 是 R2 锁定命中行（即使未改值也被 R2 消费）
  const isHit = (r) => modColsByRowId.has(r._rowId) || r2HitByRowId.has(r._rowId);

  const modifiedRows = bankRows
    .filter(isHit)
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
      // 跨轮合并后的标黄列：必须是 Set（exceljs-writer 标黄依赖 .size / .has；与 dispatcher 产出一致）。
      // R2 锁定但未改值的行 modColsByRowId 无记录 → 空 Set（不标黄，但仍作为命中行保留）。
      out._modifiedColumns = new Set(modColsByRowId.get(r._rowId) || []);
      return out;
    });

  const unmatchedRows = bankRows.filter((r) => !isHit(r));

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
 * @param {Object} [params.refundContext] R5 场景4 退款回填引擎入参（{ refundOrderRows, depositRows }）；
 *   本轮（Layer 1）上游恒注入空 refundOrderRows → 引擎空入参返回空，不影响 R1-R5 既有行为。
 * @param {Object} [params.midAllocationContext] v3.0.4 块 F：R5 场景2b Payment线下调拨回填引擎入参
 *   （{ midAllocationRows }）；仿 refundContext 范式。bank-statement:run 仅在勾选 gating 命中时注入真实
 *   中台调拨订单行；未勾选 / 缺省 → undefined，R5s2b 内部 gating（config.paymentOfflineBackfill）+ 空入参 no-op。
 * @param {Object} [params.fundTransferReconContext] v3.0.6 需求2：R5s2「数据来源=调拨对账单」引擎入参
 *   （{ reconRows }）；仿 midAllocationContext 范式。R5s2 二选一 gating（config.reconSourceMid !== false，
 *   默认勾选）命中「勾选路」时注入调拨对账单派生行（linked_fund_transfer_recon）；取消路（reconSourceMid:false）
 *   不读本 context，沿用现状网关回填。缺省 → 勾选路得空 reconRows → 新引擎空入参 no-op。
 * @param {Object} [params.dispatchReconContext] v3.0.6 需求3：R3.5「DBS-Charge 资金校验」引擎入参
 *   （{ dispatchReconRows }）；数据源同为调拨对账单派生表（linked_fund_transfer_recon），但语义独立于需求2 —
 *   DBS-Charge 总需调拨对账单，**不受**需求2 reconSourceMid 开关控制，故 bank-statement:run 单独 structuredClone
 *   注入。gating = dbsChargeFundCheck 桶非空（场景 enabled）。缺省 / 空 → R3.5 no-op（不抛、不改行）。
 * @returns {{
 *   modifiedRows: Array<Object>,
 *   unmatchedRows: Array<Object>,
 *   modifications: Array<Object>,
 *   errorReport: Array<Object>,
 *   stats: Object,
 *   platformCleanupRows: Array<Object>,
 *   refundBackfillRows: Array<Object>,
 *   refundUnmatchedRows: Array<Object>,
 *   rounds: Object
 * }}
 */
// v3.0.8 需求3（运行不阻塞，🔴 资金红线·只改控制流）：runReconciliation 改 async + 在「轮次边界」插
//   `await yieldTick(round)` 让出事件循环 + 上报进度。**轮次顺序、各引擎入参、数据匹配/派生逻辑零改动**——
//   仅在 R1→R2(dispatcher)→R3.5→R4→R5(s2/s2b/s3/s4) 各轮 *执行之后* 让出一次（结果 golden 字节不变）。
//   onProgress 为可选回调（main.js handler 注入 forwarder；测试/脚本不传 → yieldTick 仅 setImmediate 让出、不上报）。
async function runReconciliation({ bankRows, gwRows, scenarios, deps, refundContext, midAllocationContext, fundTransferReconContext, dispatchReconContext, onProgress } = {}) {
  if (!Array.isArray(bankRows)) {
    throw new Error('runReconciliation: bankRows 必须是数组');
  }
  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  // v3.0.8 需求3：轮次边界让出 + 进度上报。onProgress 异常吞掉（绝不影响对账结果）；
  //   只 await setImmediate（事件循环让出，使渲染进程消息循环得以处理 → 窗口不再「未响应」）。
  //   🔴 不在引擎内部调用、不在数据准备中途调用——只在「整轮完成」的安全点让出，无并发改写 bankRows 风险。
  const yieldTick = async (round) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ round }); } catch (_e) { /* swallow — 进度上报失败不影响对账 */ }
    }
    await new Promise((r) => setImmediate(r));
  };
  const {
    dbsChargeFundCheck: dbsChargeBucket,
    r2: r2Bucket, r4: r4Bucket, r5s2: r5s2Bucket, r5s3: r5s3Bucket, r5s4: r5s4Bucket
  } = bucketScenarios(scenarios);

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
  await yieldTick('R1'); // 轮次边界让出（R1 已完成，进 R2 前）

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
  await yieldTick('R2'); // 轮次边界让出（R2 dispatcher 已完成，进 R3.5 前）

  // ===== R3：占位 no-op（透传全量银行行）=====
  //   r3BankRows = bankRows（同一组引用）；R4/R5 直接对全量行操作。

  // ===== R3.5：DBS-Charge 资金校验（🔴 v3.0.6 需求3；R3 后 R4 前；改 ReconciliationId + FundType）=====
  //   先用调拨对账单给 DBS 银行行赋 ReconciliationId 并归并同组 FundType=Charge（步骤1），再用网关 amount/currency
  //   精确判定哪些转 outbound（步骤2）。落 R4 前的理由：DBS 行的 ReconciliationId/FundType 在进 R4 时已定稿，
  //   bankRows 同一引用原地演化 → R3.5 改完 R4 接着用（先改 ReconciliationId/FundType 再进 R4，叠加链跨轮保留：
  //   R3.5 置 outbound 的 DBS 行进 R4 后 hx-out 可续改 outbound→HX-out）。dispatchReconContext 不受需求2 开关控制。
  let dbsChargeChangedCount = 0;
  if (dbsChargeBucket.length) {
    const cfg = dbsChargeBucket[0].config || {};
    const dispRows = (dispatchReconContext && dispatchReconContext.dispatchReconRows) || [];
    const r35 = runDbsChargeFundCheck(safeGwRows, bankRows, dispRows, { config: cfg });
    mergeMods(r35.modifications);
    allWarnings.push(...(r35.warnings || []));
    for (const m of r35.modifications || []) allMods.push({ ...m, _round: 'R3.5' });
    dbsChargeChangedCount = (r35.modifications || []).length;
  }
  await yieldTick('R3.5'); // 轮次边界让出（R3.5 DBS-Charge 已完成，进 R4 前）

  // ===== R4：资金性质校验（🔴，matchedGwRows × 全量 bank 按 reconid 关联，改 FundType）=====
  let r4ChangedCount = 0;
  if (r4Bucket.length) {
    const r4 = runRound4FundNatureCheck(r1.matchedGwRows, bankRows, r4Bucket);
    mergeMods(r4.modifications);
    allWarnings.push(...(r4.warnings || []));
    for (const m of r4.modifications || []) allMods.push({ ...m, _round: 'R4' });
    r4ChangedCount = (r4.modifications || []).length;
  }
  await yieldTick('R4'); // 轮次边界让出（R4 资金性质校验已完成，进 R5 前）

  // ===== R5 场景2：回填 ReconciliationId =====
  let r5s2BackfilledCount = 0;
  // v3.0.4 块 F（🔴 Q3 网关回填优先）：收集 R5s2 已消费 bank _rowId 集合，供 R5s2b 剔除（两引擎零互相覆盖）。
  //   取径 = 引擎返回的 usedBankRowIds（引擎内 1v1 消费的完整集合，**含「消费但未写（nv 空/同值不 record）」行**）。
  //   为何 usedBankRowIds 即超集、无需再叠 modifications rowId：
  //     引擎 backfill 对命中行先无条件 usedBankRowId.add（占用 1v1），再判 nv 非空且异值才 record 进 modifications；
  //     每 direction 跑完把整份 usedBankRowId union 进返回集 —— 故凡进 modifications 的 rowId 必已在 usedBankRowIds 内，
  //     且引擎两个 return 出口（空入参早退 / 正常）均携带该字段。modifications 收集路是 usedBankRowIds 的真子集，纯冗余。
  //   闭合说明：旧实现仅取 modifications，「消费但未写」行取不到、可能被 R5s2b 二次匹配并覆盖网关已确认值；
  //   改取 usedBankRowIds 后该窄缺口闭合 —— 凡被 R5s2 消费（无论是否实写）的银行行一律不进 R5s2b 银行池，
  //   「网关回填优先」语义完整覆盖（不改 R5s2 既有匹配/写值逻辑）。
  const r5s2ConsumedBankRowIds = new Set();
  if (r5s2Bucket.length) {
    const opt = r5s2Bucket[0].config || {};
    // v3.0.6 需求2（决策 D4 默认勾选）：数据来源二选一 gating。
    //   reconSourceMid !== false → 勾选路（默认/缺省/老库无字段视为勾选）：对手方=调拨对账单（reconRows）。
    //   reconSourceMid === false → 取消路：沿用现状 runRound5FundTransferBackfill（对手方=网关 gwRows），逐字保留。
    const useMidReconTable = opt.reconSourceMid !== false;
    if (useMidReconTable) {
      // —— 勾选路：调拨对账单 ReconID 回填银行 ReconciliationId（新引擎，对手方换源；口径与 R5s2 一致）——
      const reconRows = (fundTransferReconContext && fundTransferReconContext.reconRows) || [];
      const rA = runRound5FundTransferReconBackfill(reconRows, bankRows, {
        dateToleranceDays: opt.dateToleranceDays
      });
      mergeMods(rA.modifications);
      allWarnings.push(...(rA.warnings || []));
      for (const m of rA.modifications || []) allMods.push({ ...m, _round: 'R5s2-recon' });
      // 🔴 资金红线点7：勾选路消费集同样并入 r5s2ConsumedBankRowIds（下游 R5s2b excludeBankRowIds 互斥不变量）。
      if (rA.usedBankRowIds) {
        for (const rid of rA.usedBankRowIds) {
          if (rid !== undefined && rid !== null) r5s2ConsumedBankRowIds.add(rid);
        }
      }
      r5s2BackfilledCount = (rA.modifications || []).length;
    } else {
      // —— 取消路：现状网关回填，逐字保留（R5s2 parity 不破）——
      const r5a = runRound5FundTransferBackfill(safeGwRows, bankRows, {
        directions: opt.directions,
        dateToleranceDays: opt.dateToleranceDays
      });
      mergeMods(r5a.modifications);
      allWarnings.push(...(r5a.warnings || []));
      for (const m of r5a.modifications || []) allMods.push({ ...m, _round: 'R5s2' });
      // 引擎完整消费集（含同值未写行，已是 modifications rowId 的超集）—— 闭合「消费但未写」窄缺口（资金红线）。
      if (r5a.usedBankRowIds) {
        for (const rid of r5a.usedBankRowIds) {
          if (rid !== undefined && rid !== null) r5s2ConsumedBankRowIds.add(rid);
        }
      }
      r5s2BackfilledCount = (r5a.modifications || []).length;
    }
  }
  await yieldTick('R5s2'); // 轮次边界让出（R5 场景2 回填已完成，进 R5s2b 前）

  // ===== R5 场景2b：Payment线下调拨订单回填（v3.0.4 块 F，🔴 资金红线）=====
  //   gating（三条件全真才跑）：r5s2Bucket 非空 ∧ config.paymentOfflineBackfill.enabled===true ∧ midRows 非空。
  //   显式传 { bigAccount, bankChannel, region, excludeBankRowIds } 进引擎（⚠️ config 加 key 不会自动流入引擎，
  //   须在编排器显式拣出，与 R5s2 拣 directions/dateToleranceDays 同范式）。
  //   excludeBankRowIds = R5s2 已回填 bank _rowId 集合 → 引擎构银行池时剔除（网关回填优先不变量）。
  let r5s2bBackfilledCount = 0;
  // v3.0.4 块 F 修订 R2 Q14：引擎匹配对（导出 3 核对 sheet 数据源），缺省 []（仿 platformCleanupRows 范式）。
  let paymentOfflineMatchedPairs = [];
  if (r5s2Bucket.length) {
    const opt = r5s2Bucket[0].config || {};
    const pob = opt.paymentOfflineBackfill;
    const midRows = (midAllocationContext && midAllocationContext.midAllocationRows) || [];
    if (pob && pob.enabled === true && Array.isArray(midRows) && midRows.length > 0) {
      const r5ab = runRound5PaymentOfflineAllocationBackfill(bankRows, midRows, {
        bigAccount: pob.bigAccount,
        bankChannel: pob.bankChannel,
        region: pob.region,
        excludeBankRowIds: r5s2ConsumedBankRowIds
      });
      mergeMods(r5ab.modifications);
      allWarnings.push(...(r5ab.warnings || []));
      for (const m of r5ab.modifications || []) allMods.push({ ...m, _round: 'R5s2b' });
      r5s2bBackfilledCount = (r5ab.modifications || []).length;
      // 修订 R2 Q14：透传匹配对供导出阶段追加 3 核对 sheet（缺省 []）。
      paymentOfflineMatchedPairs = r5ab.matchedPairs || [];
    }
  }
  await yieldTick('R5s2b'); // 轮次边界让出（R5 场景2b Payment线下调拨回填已完成，进 R5s3 前）

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
  await yieldTick('R5s3'); // 轮次边界让出（R5 场景3 剔除已完成，进 R5s4 前）

  // ===== R5 场景4：中台退款订单回填（🔴 数据隔离 —— 只读 bankRows，不改任何字段、不产 modifications）=====
  //   独立产出双 sheet 模板行集合（backfillRows / unmatchedRows），引擎内部维护独立的
  //   usedBankRowId / usedRefundId（与场景2/3 不串池）；本轮不并入 modColsByRowId、不 mergeMods
  //   → 行数守恒 modifiedRows + unmatchedRows === bankRows.length 不受影响。
  //   isFundTypeChanged：判定某银行行 FundType 是否已被 R4 改写（✅PRD Q2，被改写的 Ach Return 不再入回填池）。
  //     来源是跨轮累积的 modColsByRowId（R4 record('FundType') 后该行 rowId 的列集合含 'FundType'）。
  let refundBackfillRows = [];
  let refundUnmatchedRows = [];
  // OPEN-7（T5b-1）：R5 退款引擎冒泡的「以入金表为来源、回填成功」命中 BizId 去重数组（T5b-2 export 阶段消费）。
  let refundHitDepositBizIds = [];
  if (r5s4Bucket.length) {
    const isFundTypeChanged = (rowId) => {
      const cols = modColsByRowId.get(rowId);
      return !!(cols && cols.has('FundType'));
    };
    const r5d = runRound5RefundOrderBackfill(
      bankRows,
      (refundContext && refundContext.refundOrderRows) || [],
      (refundContext && refundContext.depositRows) || [],
      { isFundTypeChanged, gwRows: safeGwRows } // v3.0.10 需求2：传网关全量行，供退款引擎做 reconid 前置过滤（safeGwRows 在上文已就绪）
    );
    allWarnings.push(...(r5d.warnings || [])); // 不 mergeMods（场景4 不改 bankRows，modifications 恒空）
    refundBackfillRows = r5d.backfillRows || [];
    refundUnmatchedRows = r5d.unmatchedRows || [];
    refundHitDepositBizIds = r5d.hitDepositBizIds || []; // OPEN-7（T5b-1）透传
  }

  // ===== 构造输出：从「当前最新 bankRows」重建（不用 dispatcher 过时浅拷贝）=====
  const { modifiedRows, unmatchedRows } = buildOutputRows(bankRows, modColsByRowId, r2HitByRowId);

  // v3.0.7 需求1a：按「渠道-地区」聚合命中行（行数 + 去重场景名），供 renderer 状态框「已处理」分支展示。
  //   纯只读聚合（不改任何匹配/派生），口径与 channel-enum-repository.extractChannelRegionCombos 单行逻辑同源。
  const channelRegionHits = buildChannelRegionHits(modifiedRows, allMods);

  return {
    modifiedRows,
    unmatchedRows,
    modifications: allMods,
    errorReport: allWarnings,
    stats: {
      ...(r2.stats || {}),
      // self-review B：用最终分区计数覆盖 r2.stats 的 R2 作用域值（hitRowCount/unmatchedRowCount/warningCount/
      //   totalRows 原为 R2-only，不含 R4/R5）。状态框「已处理 N 行命中」(renderer pr.hitRowCount) 据此显示，
      //   须反映全部 5 轮的最终结果，否则会少计 R4/R5 改写行、多计 unmatched。
      totalRows: bankRows.length,
      hitRowCount: modifiedRows.length,
      // v3.0.7 需求1a：状态框「已处理」分支按 渠道-地区 分组展示命中行数与场景名（空集 → []，renderer 据此回退旧格式）
      channelRegionHits,
      unmatchedRowCount: unmatchedRows.length,
      warningCount: allWarnings.length,
      r1Matched: r1.matchedGwRows.length,
      // v3.0.6 需求3：R3.5 DBS-Charge 改写行数（ReconciliationId + FundType modifications 总数）
      dbsChargeChangedCount,
      r4ChangedCount,
      r5s2BackfilledCount,
      // v3.0.4 块 F：Payment线下调拨回填命中行数（进状态框可选展示）
      r5s2bBackfilledCount,
      r5s3CleanupCount: platformCleanupRows.length,
      r5s4BackfilledCount: refundBackfillRows.length,
      // v3.0.7 需求A：供 renderer 状态框判断是否显示该行（启用即显示，含 0 条）。
      //   bucket 非空 ⟺ 对应 builtin 场景启用（bucketScenarios 仅收已启用的 builtin-fixed 场景）。
      //   🔴 纯只读标志位，不参与任何对账/匹配/派生/金额判定。
      r5s3Enabled: r5s3Bucket.length > 0,
      r5s4Enabled: r5s4Bucket.length > 0
    },
    platformCleanupRows,
    refundBackfillRows,
    refundUnmatchedRows,
    // OPEN-7（T5b-1）：退款回填命中 BizId 去重数组（T5b-2 在 main.js export 阶段查命中标记 + 注入跨期提醒；无 R5s4 / 无桥接命中 → []）
    refundHitDepositBizIds,
    // v3.0.4 块 F 修订 R2 Q14：Payment线下调拨匹配对（导出 3 核对 sheet 数据源；未勾选/无命中时 []）
    paymentOfflineMatchedPairs,
    rounds: {
      r1: { matched: r1.matchedGwRows.length },
      r2: {
        hitRowCount: (r2.stats && r2.stats.hitRowCount) || 0,
        scenarioHitCount: (r2.stats && r2.stats.scenarioHitCount) || 0
      },
      // v3.0.6 需求3：R3.5 DBS-Charge 资金校验轮次统计
      r35: { changed: dbsChargeChangedCount },
      r4: { changed: r4ChangedCount },
      r5s2: { backfilled: r5s2BackfilledCount },
      // v3.0.4 块 F：Payment线下调拨回填轮次统计
      r5s2b: { backfilled: r5s2bBackfilledCount },
      r5s3: { cleanup: platformCleanupRows.length },
      r5s4: { backfilled: refundBackfillRows.length }
    }
  };
}

module.exports = {
  runReconciliation,
  bucketScenarios,
  buildOutputRows,
  // v3.0.7 需求1a：渠道-地区 命中聚合（供单测直接断言；状态框「已处理」分支数据源）
  buildChannelRegionHits
};
