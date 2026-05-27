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

// v2.1.9 N5 Phase 4 T16（spec §2.1 / §2.4）：单行双维调度（first-match-wins 分阶段执行）
//   对单行 row 做两阶段调度：
//     阶段 A：matchedChannel（专属渠道）的 scenarios 子集 first-match-wins
//     阶段 B：阶段 A 未命中 → generalChannel（通用兜底）scenarios 子集 first-match-wins
//   入参：
//     row：bankRow
//     gwRows：网关对账行（C3 需要）
//     scenariosByChannelId：Map<channelId, Array<scenario>>（caller 预先按 channel_id 切片，
//       同 channel_id 内已经按 priority DESC + id ASC 排序 + filterOutReconIdFix + gwRows 可用性过滤）
//     deps：{ channelsRepo, db }（查渠道 hot path）
//   返回：{ hit, hitChannelId, matchedChannel, generalChannel }
//     - hit：命中场景对象；未命中 null
//     - hitChannelId：命中场景所属 channel_id；未命中 null
//     - matchedChannel：行匹配到的 channels 表对象（决定 _matchStatus）；null 表示「兜底」
//     - generalChannel：通用兜底渠道对象（恒非空）
//
// 关键不变量（spec §2.4）：
//   - 同一行最多命中 1 场景（每阶段内 break）
//   - 阶段 A 命中 → 不进 B；阶段 A 未命中 → 进 B
//   - 阶段内 first-match-wins：按 scenarios 子集排序顺序逐一尝试，命中即 break
function dispatchSingleRow(row, gwRows, scenariosByChannelId, deps) {
  const { channelsRepo, db } = deps;

  // Step 2 — 查渠道库
  const matchedChannel = channelsRepo.findByNameAndLocation(
    db,
    extractChannelName(row),
    extractChannelLocation(row)
  );
  const generalChannel = channelsRepo.getBuiltinGeneral(db);

  let hit = null;
  let hitChannelId = null;

  // 阶段 A — 专属渠道场景子集 first-match-wins
  //   (当 matchedChannel 就是「通用」时跳过 A，避免阶段 B 重复跑通用)
  if (matchedChannel && matchedChannel.id !== generalChannel.id) {
    const dedicatedScenarios = scenariosByChannelId.get(matchedChannel.id) || [];
    hit = firstMatchWinsForRow(dedicatedScenarios, row, gwRows);
    if (hit) hitChannelId = matchedChannel.id;
  }

  // 阶段 B — 通用渠道兜底
  if (!hit) {
    const generalScenarios = scenariosByChannelId.get(generalChannel.id) || [];
    hit = firstMatchWinsForRow(generalScenarios, row, gwRows);
    if (hit) hitChannelId = generalChannel.id;
  }

  return { hit, hitChannelId, matchedChannel, generalChannel };
}

// v2.1.9 N5 Phase 4 T16（spec §2.4）：在场景子集内 first-match-wins（单行视角）
//   - 子集已按 priority DESC + id ASC 排序（caller 保证）
//   - 对每个 scenario 单行调用 runScenario([row], gwRows) → 命中 → break
//   - 命中条件：runScenario 返回 lockedRowIds.has(row._rowId) === true
//   - 未命中返 null
function firstMatchWinsForRow(scenarios, row, gwRows) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
  if (!row || typeof row !== 'object' || row._rowId == null) return null;

  for (const scenario of scenarios) {
    const result = runScenario(scenario, [row], gwRows);
    if (result && result.lockedRowIds && result.lockedRowIds.has(row._rowId)) {
      // 单场景命中即 break — 资金红线 first-match-wins 不变量（spec §2.4）
      return { scenario, result };
    }
  }
  return null;
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
//          deps 非空 → 走 v2.1.9 双维 first-match-wins（spec §2.1 / §2.4）
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
// v2.1.9 N5 Phase 4 T16：dual-dimension first-match-wins（专属优先 + 通用兜底）
// ========================================================================
// 算法（spec §2.1 / §2.4）：
//   1. caller 入参 scenarios 已 enabled + sort + filtered C4/C3
//   2. dispatcher 按 channel_id 切片 scenarios → scenariosByChannelId
//   3. 遍历每行 row（保持 bankRows 顺序）：
//      a. 拼 channelKey 写 metadata _hitChannelKey（审计列）
//      b. 查 matchedChannel + generalChannel
//      c. dispatchSingleRow 跑双阶段 first-match-wins
//      d. 命中 → 行进 modifiedRows + 写 metadata；未命中 → 行进 unmatchedRows
//   4. modifiedRows + unmatchedRows = bankRows（资金红线不变量保留 — spec §2.4）
//
// 与 legacy single-dimension 行为差异：
//   - rowLockSet 改 per-row 决策（无全局 first-match-wins 跨行共享）
//   - 每行最多调用 N 次 runScenario（N = 子集大小）→ hot path 性能依赖
//     scenariosByChannelId 切片缩小搜索范围 + runScenario 自身 cost
//   - hitScenarios 数组按行序追加（v2.1.8 行为为按场景命中序追加，本版调整为按行命中序）
function runDualDimensionDispatch(bankRows, gwRows, filtered, deps, ctx) {
  const { skippedC3Count, skippedC4Count } = ctx;

  // Step 1 — caller 入参 scenarios 按 channel_id 切片（spec §2.1 Step 3 优化）
  const scenariosByChannelId = groupScenariosByChannelId(filtered);

  const allModifications = [];
  const allWarnings = [];
  const rowMeta = new Map(); // _rowId → metadata
  const hitScenarioIdSet = new Set();
  const hitScenarios = [];
  const modifiedRowsOrdered = [];
  const unmatchedRows = [];
  let scenarioHitCount = 0;

  for (const row of bankRows) {
    // Step 1 — 拼 channelKey（写 metadata，无论命中/未命中都需要）
    const channelKey = buildChannelKey(row);

    // Step 2-3 — 双阶段 first-match-wins
    const dispatched = dispatchSingleRow(row, gwRows, scenariosByChannelId, deps);
    const { hit, hitChannelId, matchedChannel, generalChannel } = dispatched;

    // Step 4 — 写 metadata（spec §2.2 4 行结果矩阵）
    //   _matchStatus = matchedChannel 存在即「命中」（即使 hit=null 也是「命中渠道 + 未命中场景」）
    //   _matchedChannelId = matchedChannel?.id（行匹配到的渠道）
    //   _fallbackChannelId = 当行匹配的是专属但命中了通用兜底，记录通用 id；否则 null
    const matchStatus = matchedChannel ? '命中' : '兜底';
    let fallbackChannelId = null;
    if (hit && matchedChannel && matchedChannel.id !== generalChannel.id && hitChannelId === generalChannel.id) {
      // 行匹配专属但命中通用 → 「fallback」
      fallbackChannelId = generalChannel.id;
    }

    if (hit) {
      const { scenario, result } = hit;
      const { lockedRowIds, modifications, warnings } = result;

      scenarioHitCount += 1;
      // 同一 scenario 跨行多次命中只入 hitScenarios 1 次（与 v2.1.8 N3-1 行为一致：unique）
      if (!hitScenarioIdSet.has(scenario.id)) {
        hitScenarioIdSet.add(scenario.id);
        hitScenarios.push({
          id: scenario.id,
          displayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
          name: scenario.name
        });
      }

      // runScenario 的 lockedRowIds 在单行 [row] 入参下必含 row._rowId
      const meta = {
        scenarioId: scenario.id,
        scenarioDisplayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
        scenarioName: scenario.name,
        modifiedColumns: new Set()
      };
      rowMeta.set(row._rowId, meta);

      if (Array.isArray(modifications)) {
        modifications.forEach((m) => {
          allModifications.push({
            ...m,
            scenarioId: scenario.id,
            scenarioName: scenario.name
          });
          if (m.rowId === row._rowId) meta.modifiedColumns.add(m.column);
        });
      }
      if (Array.isArray(warnings)) {
        warnings.forEach((w) => allWarnings.push({ ...w }));
      }

      // 找到 lockedRowIds 包含的行（即 row 自身）+ 应用算法层修改
      lockedRowIds.forEach((rowId) => {
        if (rowId !== row._rowId) {
          // 防御性：runScenario 返回的 lockedRowIds 在单行入参语义下不应跨 rowId
          // 若发生（如算法 bug）→ 仍记录但不污染 row metadata
          return;
        }
      });

      modifiedRowsOrdered.push({
        ...row,
        _hitScenarioId: meta.scenarioId,
        _hitScenarioDisplayIndex: meta.scenarioDisplayIndex,
        _hitScenarioName: meta.scenarioName,
        _modifiedColumns: meta.modifiedColumns,
        // v2.1.9 N5 metadata（独立报表「匹配渠道 / 匹配状态 / 命中场景」列依赖）
        _hitChannelKey: channelKey,
        _matchStatus: matchStatus,
        _matchedChannelId: matchedChannel ? matchedChannel.id : null,
        _fallbackChannelId: fallbackChannelId,
        // v2.1.9 D16=b（2026-05-27 用户拍板）：写入"实际命中场景所属渠道 id"
        //   writer 用 _hitChannelId 反查 channels.label 渲染「匹配渠道」列
        //   语义：命中专属 → 专属渠道 id；命中通用兜底 → 通用渠道 id（1）；未命中 → null
        _hitChannelId: hitChannelId
      });
    } else {
      // 未命中：进 unmatchedRows（保留原始字段；spec §9.8.2 不加诊断列约束）
      //   N5 新增 _hitChannelKey / _matchStatus / _matchedChannelId — 独立报表写入需要
      //   spec §9.8.2 资金红线不变量保护：原始字段不动 + 新增审计列以下划线前缀避免污染
      //   v2.1.9 D16=b：未命中 _hitChannelId=null（writer 兜底为空字符串，不写独立报表）
      const rowOut = {
        ...row,
        _hitChannelKey: channelKey,
        _matchStatus: matchStatus,
        _matchedChannelId: matchedChannel ? matchedChannel.id : null,
        _fallbackChannelId: null,
        _hitChannelId: null
      };
      unmatchedRows.push(rowOut);
    }
  }

  return {
    modifiedRows: modifiedRowsOrdered,
    unmatchedRows,
    modifications: allModifications,
    errorReport: allWarnings,
    stats: {
      totalRows: bankRows.length,
      hitRowCount: modifiedRowsOrdered.length,
      unmatchedRowCount: unmatchedRows.length,
      scenarioHitCount,
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
  dispatchSingleRow,
  firstMatchWinsForRow
};
