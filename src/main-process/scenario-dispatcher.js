// v2.0.0-beta.3 PR #32a：first-match-wins 调度引擎
// PRD §7.4 / spec.md F2
// v2.1.7 round 3 F8 (spec §9.8 🚨 资金红线)：
//   - 反向 filter：unmatchedRows = bankRows.filter(r => !rowLockSet.has(r._rowId))
//   - 不动 modifiedRows filter（资金红线护栏；rowLockSet.has 条件完全保留）
//   - return 加 unmatchedRows + stats.unmatchedRowCount
//
// 行为：
//   1. enabledScenarios 按 priority desc, id asc 排序
//   2. gwRows === null → 过滤掉 'gateway-recon-join' 类场景
//   3. 全局 rowLockSet
//   4. 每场景跑前过滤未锁行 → runScenario 拿 { lockedRowIds, modifications, warnings }
//   5. merge 到全局：rowLockSet ∪= lockedRowIds；modifications/warnings 注入 scenarioId/scenarioName
//   6. modifiedRows = bankRows.filter(r => rowLockSet.has(r._rowId))
//   7. 每行加 _modifiedColumns（Set） + _hitScenarioId + _hitScenarioName
//   8. unmatchedRows = bankRows.filter(r => !rowLockSet.has(r._rowId))（保留原始顺序 + 原始字段）
//
// 关键不变量（spec §9.8.3）：
//   - modifiedRows + unmatchedRows = bankRows（无遗漏 + 互斥；first-match-wins 保证）
//   - C4 走独立流水线（不进 dispatcher）→ 不影响 unmatchedRows
//
// v2.1.9 N5 Phase 4 T16（spec §2.1-2.4 🔴 资金红线）：双维调度
//   - 入口 runAllScenarios 新增可选 4th 参数 deps = { channelsRepo, scenariosRepo, db }
//   - deps 提供 → 双维 first-match-wins（阶段 A 专属渠道 → 未命中再阶段 B 通用渠道兜底）
//   - deps 未提供 → 回退 v2.1.8 单维 first-match-wins（向后兼容 smoke / dryrun / integration）
//   - first-match-wins 不变量保留（spec §2.4）：同一行最多命中 1 个场景
//   - 行元数据扩展：_hitChannelKey / _matchStatus / _matchedChannelId / _fallbackChannelId
//   - v2.1.8 N3-1 hitScenarios displayIndex 输出格式不变（renderer.js:3345 状态框依赖）
//
// v3.0.3 PR-E（状态框「银行渠道枚举值:场景序号」换行明细）：
//   - 仅双维路径：hitScenarios 元素附带 channelId（number）+ channelName（string，channels.name；通用渠道为「通用」）
//     → renderer 状态框按 channelName 分组展示「渠道名:序号」（legacy 路径无此二字段，状态框回退原格式）
//   - 仅双维路径：去重键由 scenario.id 改为模板串 `${channelId}:${scenario.id}`
//     （场景与渠道多对多 → 同场景在多个渠道各命中应各记一条 hitScenarios）
//   - legacy 单维路径完全不动（结构 {id, displayIndex, name} + 去重键 = scenario.id 保持现状）
//
// v2.1.9 SR-FIX-1 (spec §16.2 🔴 资金红线 / PR #53 self-review SR1 #1/#2 修复)：
//   - 删除原 dispatchSingleRow / firstMatchWinsForRow（per-row 路径打破 C3 1v1 不变量 + 让 C2 笛卡尔配对失效）
//   - 新增 runChannelBatch helper（per-channel 子作用域 first-match-wins 批量调度，等同 v2.1.8 legacy 单维行为）
//   - runDualDimensionDispatch 重写：阶段 A 每专属 channel 批量 + 阶段 B 通用 channel 批量
//     · 候选行通过 rowMatchedChannelMap 在 dispatcher 入口预查 1 次
//     · runScenario 单次入参为「未锁定候选行完整集」→ C3 usedGwRowIdx 在 runScenario scope 内 1v1 严格保留
//     · C2 leftRows + rightRows 都有完整未锁定行集 → 笛卡尔配对正常
//   - 验收：spec §16.7 6 不变量 unit case 全绿；smoke 全跑 0 regression

const { runScenario } = require('./scenario-engines');

// v2.1.9 N5 spec §2.1 D7=b：row.Channel + row['地区'] 是 column mapping 后的逻辑字段
//   定义见 src/constants/bank-statement-fields.js:15-16（标准 44 列字段中的 Channel / 地区）
const CHANNEL_FIELD_NAME = 'Channel';
const LOCATION_FIELD_NAME = '地区';

function sortScenariosByPriority(scenarios) {
  return [...scenarios].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

function filterScenariosByGwAvailability(scenarios, gwRows) {
  // 只在用户未导入资金对账文件时（gwRows === null/undefined）过滤掉 C3 类。
  // 已导入但为空数组（gwRows = []）→ 不过滤，让 C3 正常跑并产 'no-gateway-rows' warning
  // （Codex Round 3 F1 P2 修复：避免空文件场景下 PR #31 已实现的 warning 被吞掉）
  if (gwRows === null || gwRows === undefined) {
    return scenarios.filter((s) => s.category !== 'gateway-recon-join');
  }
  return scenarios;
}

// v2.1.0-beta.1 PR-A round 2 P1（资金红线 + 阻断）：
// C4 (`recon-id-fix`) 走 `recon-id-fix:run` 独立流水线，dispatcher 入参不应含 C4。
// 入口处再防一手：即使上游 IPC handler 漏了 filter，dispatcher 也拒绝喂给 runScenario
// （runScenario 的 default 分支会 throw "未知 category"，会让 bank-statement:run 整体失败）。
// v2.1.0-beta.3 PR #39 Finding 1（P1）：扩展到所有 C4 category（含 'gateway-recon-id-fix'）
// 否则用户启用 gateway 子模式场景 + 跑银行对账单处理 → scenario 进入 C1/C2/C3 dispatcher → runScenario 抛"未知 category"
const C4_CATEGORIES = ['recon-id-fix', 'gateway-recon-id-fix'];
function filterOutReconIdFix(scenarios) {
  return scenarios.filter((s) => s && !C4_CATEGORIES.includes(s.category));
}

// v2.1.9 N5 Phase 4 T16（spec §2.1 Step 1）：拼渠道 key 用于审计列
//   row.Channel + row['地区'] → "工商-上海"
//   空字段统一兜底 ''；纯 trim 保留原始大小写（D16=a 独立报表「匹配渠道」列保留原始值）
function buildChannelKey(row) {
  if (!row || typeof row !== 'object') return '-';
  const channel = String(row[CHANNEL_FIELD_NAME] ?? '').trim();
  const location = String(row[LOCATION_FIELD_NAME] ?? '').trim();
  return `${channel}-${location}`;
}

function extractChannelName(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row[CHANNEL_FIELD_NAME] ?? '').trim();
}

function extractChannelLocation(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row[LOCATION_FIELD_NAME] ?? '').trim();
}

// v2.1.9 N5 Phase 4 T16（spec §2.1 Step 3 优化）：caller 入参 scenarios 按 channel_id 切片
//   - 输入 scenarios：已 enabled / 已过滤 C4 / 已 sort（priority DESC + id ASC）
//   - 输出：Map<channelId, scenarios[]>
//   - 老 scenarios 无 channelId 字段 → 落到「通用」(1) 兜底（spec §3.2 backfill 已迁移老数据，
//     但调用方 mock / smoke 可能直接构造 scenario 不带 channelId → fallback 1 保护）
function groupScenariosByChannelId(scenarios) {
  const map = new Map();
  for (const scenario of scenarios) {
    const channelId = Number.isFinite(scenario.channelId)
      ? scenario.channelId
      : (Number.isFinite(scenario.channel_id) ? scenario.channel_id : 1);
    if (!map.has(channelId)) map.set(channelId, []);
    map.get(channelId).push(scenario);
  }
  return map;
}

// runAllScenarios(bankRows, gwRows | null, scenarios, deps?)
//   bankRows: Array<{ _rowId, ...44 columns }>
//   gwRows: Array<{ ...31 columns }> | null
//   scenarios: Array<{ id, category, name, priority, enabled, config, channelId? }>（已 enabled=true 过滤）
//   deps:   v2.1.9 N5 双维调度可选依赖（spec §2.1 Step 2）
//             { channelsRepo, db }（必填，提供查渠道 hot path）
//             { scenariosRepo } 暂未使用（caller 已传完整 scenarios + channelId；本字段
//               保留为依赖契约文档化，便于未来按需切换 DB 直查模式）
//          deps 为 null/undefined → 走 v2.1.8 单维 first-match-wins 路径（向后兼容；
//             保留 21+ smoke / dryrun / integration 测试 0 regression）
//          deps 非空 → 走 v2.1.9 双维 first-match-wins（spec §2.1 / §2.4 / §16.2）
//
// 返回:
//   {
//     modifiedRows: Array,                // 命中场景的行（lockedRowIds 全部）
//                                          // 每行加 _modifiedColumns: Set + _hitScenarioId + _hitScenarioName
//                                          // v2.1.9 N5 新增：_hitChannelKey / _matchStatus / _matchedChannelId / _fallbackChannelId
//     unmatchedRows: Array,
//     modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }>,
//     errorReport: Array<{ scenarioId, scenarioName, rowId, code, message }>,
//     stats: { totalRows, hitRowCount, unmatchedRowCount, scenarioHitCount, hitScenarios, warningCount, skippedC3Count, skippedC4Count }
//     hitScenarios: v2.1.8 N3-1 — Array<{id, displayIndex, name}>（按命中顺序，priority desc + id asc）
//       v3.0.3 PR-E：双维路径每元素附带 channelId（number）+ channelName（string）；
//         去重键 = `${channelId}:${scenario.id}`（同场景跨渠道命中各记一条）。
//         legacy 单维路径不附带此二字段，去重键仍为 scenario.id。
//   }
function runAllScenarios(bankRows, gwRows, scenarios, deps) {
  if (!Array.isArray(bankRows)) {
    throw new Error('runAllScenarios: bankRows 必须是数组');
  }
  if (!Array.isArray(scenarios)) {
    throw new Error('runAllScenarios: scenarios 必须是数组');
  }

  const enabled = scenarios.filter((s) => s && s.enabled);
  // v2.1.0-beta.1 PR-A round 2 P1：先剔 C4（不属于本 dispatcher）
  const c4Stripped = filterOutReconIdFix(enabled);
  const skippedC4Count = enabled.length - c4Stripped.length;
  const sorted = sortScenariosByPriority(c4Stripped);
  const filtered = filterScenariosByGwAvailability(sorted, gwRows);
  const skippedC3Count = sorted.length - filtered.length;

  // v2.1.9 N5 Phase 4 T16：deps 提供 → 双维路径；否则保留 v2.1.8 单维路径
  if (deps && deps.channelsRepo && deps.db) {
    return runDualDimensionDispatch(bankRows, gwRows, filtered, deps, {
      skippedC3Count,
      skippedC4Count
    });
  }
  return runLegacySingleDimensionDispatch(bankRows, gwRows, filtered, {
    skippedC3Count,
    skippedC4Count
  });
}

// ========================================================================
// v2.1.8 single-dimension first-match-wins（保留为向后兼容默认路径）
// ========================================================================
function runLegacySingleDimensionDispatch(bankRows, gwRows, filtered, ctx) {
  const { skippedC3Count, skippedC4Count } = ctx;

  const rowLockSet = new Set();
  const allModifications = [];
  const allWarnings = [];
  const rowMeta = new Map(); // _rowId → { scenarioId, scenarioName, modifiedColumns: Set }

  let scenarioHitCount = 0;
  // v2.1.8 N3-1：hitScenarioIds (number[]) → hitScenarios ({id, displayIndex, name}[])
  //   spec.md §五：状态框命中场景号显示与场景管理 UI 序号一致 — 改用 displayIndex 替代 DB id
  //   displayIndex 来源：scenario.displayIndex（scenarios-repository.listScenarios 已附）
  //   fallback：未带 displayIndex 时回退 scenario.id（兼容旧调用方 / smoke 直接构造 scenario）
  //
  // ⚠️ 语义差警告（v2.1.8 self-review SR4）：
  //   生产路径 dispatcher 入参经 scenarios-repository.listScenarios 必带 displayIndex（按 priority DESC + id ASC 1-based）
  //   smoke / unit 直接构造 scenario 不带 displayIndex → 走 fallback 得 displayIndex == scenario.id
  //   → smoke 看到的 "[id]" 与生产 "[列表序号]" 数字可能相同但语义不同
  //   → 验证"删一条 scenario 后 displayIndex 重新分配 1-based"必须走真实 listScenarios 路径（如集成测试 bank-statement-hit-scenario-sheet.js）
  const hitScenarios = [];

  for (const scenario of filtered) {
    const unlocked = bankRows.filter((r) => !rowLockSet.has(r._rowId));
    if (unlocked.length === 0) break;

    const result = runScenario(scenario, unlocked, gwRows);
    const { lockedRowIds, modifications, warnings } = result;

    if (lockedRowIds && lockedRowIds.size > 0) {
      scenarioHitCount += 1;
      hitScenarios.push({
        id: scenario.id,
        displayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
        name: scenario.name
      });
      lockedRowIds.forEach((rowId) => {
        rowLockSet.add(rowId);
        if (!rowMeta.has(rowId)) {
          rowMeta.set(rowId, {
            scenarioId: scenario.id,
            scenarioDisplayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
            scenarioName: scenario.name,
            modifiedColumns: new Set()
          });
        }
      });
    }

    if (Array.isArray(modifications)) {
      modifications.forEach((m) => {
        allModifications.push({
          ...m,
          scenarioId: scenario.id,
          scenarioName: scenario.name
        });
        const meta = rowMeta.get(m.rowId);
        if (meta) meta.modifiedColumns.add(m.column);
      });
    }

    if (Array.isArray(warnings)) {
      // PR #31 algo 层 makeWarningCollector(scenario.id, scenario.name) 已在内部
      // push 时注入 scenarioId/scenarioName；dispatcher 不再重复 inject（self-review #1 修订）
      warnings.forEach((w) => allWarnings.push({ ...w }));
    }
  }

  const modifiedRows = bankRows
    .filter((r) => rowLockSet.has(r._rowId))
    .map((r) => {
      const meta = rowMeta.get(r._rowId) ?? {
        scenarioId: null,
        scenarioDisplayIndex: null,
        scenarioName: null,
        modifiedColumns: new Set()
      };
      return {
        ...r,
        _hitScenarioId: meta.scenarioId,
        // v2.1.8 N3-2：N3 Sheet 3「命中场景行」末尾「命中场景」列拼接 `[displayIndex] name`
        _hitScenarioDisplayIndex: meta.scenarioDisplayIndex,
        _hitScenarioName: meta.scenarioName,
        _modifiedColumns: meta.modifiedColumns
      };
    });

  // v2.1.7 round 3 F8 (spec §9.8.2 🚨 资金红线)：反向 filter 得未命中 dispatcher 任何 scenario 的行
  //   - 保留原始 bankRows 顺序（forEach 顺序稳定）
  //   - 不做 .map 转换（用户期望"原始行"；诊断列 _hitScenarioId 等不加）
  //   - 互斥保证：bankRows 同一行不可能同时进 modifiedRows 和 unmatchedRows（filter 条件互否）
  //   - 完整性保证：modifiedRows.length + unmatchedRows.length === bankRows.length
  const unmatchedRows = bankRows.filter((r) => !rowLockSet.has(r._rowId));

  return {
    modifiedRows,
    unmatchedRows,                                  // ⭐ F8 round 3 新增
    modifications: allModifications,
    errorReport: allWarnings,
    stats: {
      totalRows: bankRows.length,
      hitRowCount: modifiedRows.length,
      unmatchedRowCount: unmatchedRows.length,      // ⭐ F8 round 3 新增
      scenarioHitCount,
      // v2.1.8 N3-1：hitScenarioIds (number[]) → hitScenarios ({id, displayIndex, name}[])
      //   spec.md §五 N3-D2 强制重命名，caller 同步更新（grep hitScenarioIds 零命中）
      hitScenarios,
      warningCount: allWarnings.length,
      skippedC3Count,
      skippedC4Count
    }
  };
}

// ========================================================================
// v2.1.9 SR-FIX-1（spec §16.2 🔴 资金红线）：per-channel batch first-match-wins helper
// ========================================================================
//
// runChannelBatch(args)：在单 channel 子作用域内对场景子集做 first-match-wins 批量调度。
//   - 接收完整 unlocked 候选行集（不再 per-row 拆分）→ C3 usedGwRowIdx 1v1 / C2 笛卡尔配对自然成立
//   - rowLockSet 跨 channel 共享 → 全局 first-match-wins 不变量（spec §2.4 / §16.2 §16.6）
//   - 跨 channel 跨 scenario gw 多次消费是已知边界（spec §16.2 / USER_GUIDE 文档化）
//
// args 字段：
//   scenarios: 当前 channel 的场景子集（已按 priority DESC + id ASC 排序）
//   bankRows: 候选 unlocked rows（caller 已 filter）
//   gwRows: 网关账单行
//   rowLockSet: 跨 channel 共享的锁集合（in/out）
//   rowMeta: 跨 channel 共享的行 metadata Map（in/out）
//   allModifications / allWarnings: 跨 channel 共享的输出累加器
//   hitScenarioIdSet / hitScenarios: 跨 channel 共享的 hitScenarios 去重 + 列表
//     v3.0.3 PR-E：去重键 = `${hitChannelId}:${scenario.id}`（场景与渠道多对多 →
//       同场景在不同 channel 批次各命中应各记一条 hitScenarios）
//   scenarioHitCountRef: { value }（ref 包装；同步回外层 totals）
//   hitChannelId: 本批属于哪个 channel id（写入命中行 metadata + hitScenarios.channelId）
//   hitChannelName: v3.0.3 PR-E — 本批 channel 的 name（channels.name；通用渠道为「通用」），
//     写入 hitScenarios.channelName 供 renderer 状态框按渠道分组展示
//   matchedChannelMap: rowId → matchedChannel（用于命中行 metadata，但 channel 阶段判定由外层完成）
function runChannelBatch(args) {
  const {
    scenarios, bankRows, gwRows,
    rowLockSet, rowMeta,
    allModifications, allWarnings,
    hitScenarioIdSet, hitScenarios,
    scenarioHitCountRef,
    hitChannelId,
    // v3.0.3 PR-E：本批 channel 的 name（写入 hitScenarios.channelName）
    hitChannelName,
    // v2.1.13 D-3：行→matchedChannel 映射（builtin-fixed 适用渠道逐行过滤用；阶段 A/B 都传）
    rowMatchedChannelMap
  } = args;

  if (!Array.isArray(scenarios) || scenarios.length === 0) return;
  if (!Array.isArray(bankRows) || bankRows.length === 0) return;

  for (const scenario of scenarios) {
    // 每场景跑前过滤未锁定候选行（跨 channel rowLockSet 共享）
    const unlocked = bankRows.filter((r) => !rowLockSet.has(r._rowId));
    if (unlocked.length === 0) break;

    // v2.1.13 D-3：自带写死场景（builtin-fixed）「适用银行渠道」限定 —
    //   仅对「行 matchedChannel 在适用列表内」的未锁定行生效（_applicableChannelIds 空/缺 = 适用全部，不过滤）。
    //   保持 builtin-fixed 在通用阶段（priority 0 兜底）语义不变，只缩小候选行集。
    //   candidates 为空 → 跳过本场景（continue，非 break；后续不限定场景仍需处理剩余 unlocked 行）。
    let candidates = unlocked;
    if (Array.isArray(scenario._applicableChannelIds) && scenario._applicableChannelIds.length > 0) {
      const applicable = new Set(scenario._applicableChannelIds.map(Number));
      candidates = unlocked.filter((r) => {
        const matched = rowMatchedChannelMap ? rowMatchedChannelMap.get(r._rowId) : null;
        return matched && applicable.has(Number(matched.id));
      });
      if (candidates.length === 0) continue;
    }

    // 关键：candidates 是整组未锁定候选行（非单行）
    //   → C3 内 usedGwRowIdx 在此次 runScenario 调用 scope 内严格 1v1（spec §16.2 不变量 #1）
    //   → C2 leftRows + rightRows 都收到完整候选集 → 笛卡尔配对正常（spec §16.2 不变量 #2）
    const result = runScenario(scenario, candidates, gwRows);
    const { lockedRowIds, modifications, warnings } = result;

    if (lockedRowIds && lockedRowIds.size > 0) {
      scenarioHitCountRef.value += 1;
      // v3.0.3 PR-E：去重键由 scenario.id → `${hitChannelId}:${scenario.id}`。
      //   场景与渠道多对多 — 同一场景在多个 channel 批次命中应各记一条（状态框按渠道分组展示需要）。
      const hitKey = `${hitChannelId}:${scenario.id}`;
      if (!hitScenarioIdSet.has(hitKey)) {
        hitScenarioIdSet.add(hitKey);
        hitScenarios.push({
          id: scenario.id,
          displayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
          name: scenario.name,
          // v3.0.3 PR-E：附带命中渠道 id/name（renderer 状态框按 channelName 分组「渠道名:序号」）
          channelId: hitChannelId,
          channelName: hitChannelName
        });
      }
      lockedRowIds.forEach((rowId) => {
        rowLockSet.add(rowId);
        if (!rowMeta.has(rowId)) {
          rowMeta.set(rowId, {
            scenarioId: scenario.id,
            scenarioDisplayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
            scenarioName: scenario.name,
            modifiedColumns: new Set(),
            hitChannelId
          });
        }
      });
    }

    if (Array.isArray(modifications)) {
      modifications.forEach((m) => {
        allModifications.push({
          ...m,
          scenarioId: scenario.id,
          scenarioName: scenario.name
        });
        const meta = rowMeta.get(m.rowId);
        if (meta) meta.modifiedColumns.add(m.column);
      });
    }
    if (Array.isArray(warnings)) {
      // PR #31 algo 层 makeWarningCollector(scenario.id, scenario.name) 已在内部 push 时注入；
      // dispatcher 不再重复 inject（与 legacy 路径行为一致）
      warnings.forEach((w) => allWarnings.push({ ...w }));
    }
  }
}

// ========================================================================
// v2.1.9 N5 Phase 4 T16 + v2.1.9 SR-FIX-1 (spec §16.2)：dual-dimension first-match-wins
// ========================================================================
// 算法（spec §2.1 / §2.4 + §16.2 重写）：
//   1. caller 入参 scenarios 已 enabled + sort + filtered C4/C3
//   2. dispatcher 按 channel_id 切片 scenarios → scenariosByChannelId
//   3. 为每行预查 matchedChannel（1 行 1 次 DB 查询，缓存 rowMatchedChannelMap）
//   4. 阶段 A：遍历专属 channels，每 channel 的候选行 = matchedChannel==该 channel ∩ 未锁定
//      → runChannelBatch 批量调度（保留 C3 1v1 + C2 笛卡尔不变量）
//   5. 阶段 B：通用 channel 的候选行 = 全部未锁定行（含「匹配专属未命中」+「未匹配渠道」）
//      → runChannelBatch 批量调度
//   6. modifiedRows + unmatchedRows = bankRows（保留 bankRows 原始顺序）
//   7. 每行写 N5 metadata：_hitChannelKey / _matchStatus / _matchedChannelId / _fallbackChannelId / _hitChannelId
//
// 与 v2.1.8 legacy single-dimension 行为差异：
//   - rowLockSet 按 channel 分阶段累积（阶段 A 内 channel 内 first-match-wins + 阶段 B 通用兜底）
//   - 同一行最多调用 N 次 runScenario（N = 子集大小）→ 但每次 runScenario 入参是 unlocked 候选行整组
//   - hitScenarios 数组按场景命中序追加（与 legacy 行为一致）
//
// SR-FIX-1 资金红线护栏：
//   - C3 usedGwRowIdx 1v1 严格保留（unit case 2 / 3）
//   - C2 笛卡尔配对正常工作（unit case 7 / 11）
function runDualDimensionDispatch(bankRows, gwRows, filtered, deps, ctx) {
  const { skippedC3Count, skippedC4Count } = ctx;
  const { channelsRepo, db } = deps;

  // Step 1 — caller 入参 scenarios 按 channel_id 切片（spec §2.1 Step 3）
  const scenariosByChannelId = groupScenariosByChannelId(filtered);
  const generalChannel = channelsRepo.getBuiltinGeneral(db);

  // Step 2 — 为每行预查 matchedChannel（1 行 1 次 DB 查询）
  const rowMatchedChannelMap = new Map(); // _rowId → matchedChannel | null
  for (const row of bankRows) {
    if (row && row._rowId != null) {
      const matched = channelsRepo.findByNameAndLocation(
        db,
        extractChannelName(row),
        extractChannelLocation(row)
      );
      rowMatchedChannelMap.set(row._rowId, matched || null);
    }
  }

  // 跨阶段共享状态（保证 first-match-wins 不变量「同行最多 1 命中」）
  const rowLockSet = new Set();
  const rowMeta = new Map(); // _rowId → { scenarioId, scenarioDisplayIndex, scenarioName, modifiedColumns, hitChannelId }
  const allModifications = [];
  const allWarnings = [];
  const hitScenarioIdSet = new Set();
  const hitScenarios = [];
  const scenarioHitCountRef = { value: 0 };

  // Step 3 — 阶段 A：每个专属渠道独立批量 first-match-wins
  //   不变量：channel 内 scenarios 按 priority DESC + id ASC 排序（caller 已 sort），rowLockSet 跨 channel 累积
  //   候选行 = matchedChannel == 该 channel ∩ !rowLockSet
  for (const [channelId, channelScenarios] of scenariosByChannelId) {
    if (channelId === generalChannel.id) continue; // 通用留给阶段 B
    const candidateRows = bankRows.filter((r) =>
      r && r._rowId != null
      && !rowLockSet.has(r._rowId)
      && rowMatchedChannelMap.get(r._rowId)
      && rowMatchedChannelMap.get(r._rowId).id === channelId
    );
    if (candidateRows.length === 0) continue;

    // v3.0.3 PR-E：解析专属 channel name（hitScenarios.channelName 用；仅有候选行时查 1 次）。
    //   场景子集已属同一 channelId，channel 缺失（理论不应发生）兜底空串 → renderer 回退原格式。
    const channelRow = channelsRepo.getChannelById(db, channelId);
    const channelName = channelRow ? channelRow.name : '';

    runChannelBatch({
      scenarios: channelScenarios,
      bankRows: candidateRows,
      gwRows,
      rowLockSet, rowMeta,
      allModifications, allWarnings,
      hitScenarioIdSet, hitScenarios,
      scenarioHitCountRef,
      hitChannelId: channelId,
      hitChannelName: channelName,
      rowMatchedChannelMap
    });
  }

  // Step 4 — 阶段 B：通用渠道批量（候选 = 全部未锁定行：含「matched 专属未命中」+「未 matched」）
  const generalScenarios = scenariosByChannelId.get(generalChannel.id) || [];
  if (generalScenarios.length > 0) {
    const candidateRows = bankRows.filter((r) =>
      r && r._rowId != null && !rowLockSet.has(r._rowId)
    );
    if (candidateRows.length > 0) {
      runChannelBatch({
        scenarios: generalScenarios,
        bankRows: candidateRows,
        gwRows,
        rowLockSet, rowMeta,
        allModifications, allWarnings,
        hitScenarioIdSet, hitScenarios,
        scenarioHitCountRef,
        hitChannelId: generalChannel.id,
        // v3.0.3 PR-E：通用渠道 name（channels-repository GENERAL_NAME = '通用'）
        hitChannelName: generalChannel.name,
        rowMatchedChannelMap
      });
    }
  }

  // Step 5 — 构造 modifiedRows + unmatchedRows + 写 N5 metadata
  //   行序：保持 bankRows 原始顺序（filter 顺序稳定）
  //   _matchStatus 语义（spec §2.2 4 行结果矩阵）：
  //     matched 存在（含通用本身）→ '命中'（即使 hit=null 也是「命中渠道 + 未命中场景」）
  //     matched 不存在 → '兜底'
  //   _fallbackChannelId 语义：
  //     行匹配专属 + 实际命中通用 → 通用 channel id
  //     其他场景 → null
  const modifiedRows = bankRows
    .filter((r) => r && r._rowId != null && rowLockSet.has(r._rowId))
    .map((r) => {
      const meta = rowMeta.get(r._rowId);
      const matched = rowMatchedChannelMap.get(r._rowId);
      const hitChannelId = meta ? meta.hitChannelId : null;
      const matchStatus = matched ? '命中' : '兜底';
      let fallbackChannelId = null;
      if (matched && matched.id !== generalChannel.id && hitChannelId === generalChannel.id) {
        fallbackChannelId = generalChannel.id;
      }
      return {
        ...r,
        _hitScenarioId: meta ? meta.scenarioId : null,
        _hitScenarioDisplayIndex: meta ? meta.scenarioDisplayIndex : null,
        _hitScenarioName: meta ? meta.scenarioName : null,
        _modifiedColumns: meta ? meta.modifiedColumns : new Set(),
        // v2.1.9 N5 metadata（独立报表「匹配渠道 / 匹配状态 / 命中场景」列依赖）
        _hitChannelKey: buildChannelKey(r),
        _matchStatus: matchStatus,
        _matchedChannelId: matched ? matched.id : null,
        _fallbackChannelId: fallbackChannelId,
        // v2.1.9 D16=b：实际命中场景所属渠道 id（writer 反查 channels.label 渲染「匹配渠道」列）
        //   命中专属 → 专属 id；命中通用兜底 → 通用 id；未命中 → null（在 unmatchedRows 分支）
        _hitChannelId: hitChannelId
      };
    });

  const unmatchedRows = bankRows
    .filter((r) => r && r._rowId != null && !rowLockSet.has(r._rowId))
    .map((r) => {
      const matched = rowMatchedChannelMap.get(r._rowId);
      const matchStatus = matched ? '命中' : '兜底';
      return {
        ...r,
        _hitChannelKey: buildChannelKey(r),
        _matchStatus: matchStatus,
        _matchedChannelId: matched ? matched.id : null,
        _fallbackChannelId: null,
        // v2.1.9 D16=b：未命中行 _hitChannelId=null（writer 兜底为空字符串，不写独立报表）
        _hitChannelId: null
      };
    });

  return {
    modifiedRows,
    unmatchedRows,
    modifications: allModifications,
    errorReport: allWarnings,
    stats: {
      totalRows: bankRows.length,
      hitRowCount: modifiedRows.length,
      unmatchedRowCount: unmatchedRows.length,
      scenarioHitCount: scenarioHitCountRef.value,
      hitScenarios,
      warningCount: allWarnings.length,
      skippedC3Count,
      skippedC4Count
    }
  };
}

module.exports = {
  runAllScenarios,
  sortScenariosByPriority,
  filterScenariosByGwAvailability,
  filterOutReconIdFix,
  C4_CATEGORIES,
  // v2.1.9 N5 Phase 4 T16：双维调度辅助函数（unit test 直查）
  buildChannelKey,
  extractChannelName,
  extractChannelLocation,
  groupScenariosByChannelId,
  // v2.1.9 SR-FIX-1 (spec §16.2)：per-channel batch helper（unit test 直查 + 内部使用）
  runChannelBatch
};
