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

const { runScenario } = require('./scenario-engines');

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

// runAllScenarios(bankRows, gwRows | null, scenarios)
//   bankRows: Array<{ _rowId, ...44 columns }>
//   gwRows: Array<{ ...31 columns }> | null
//   scenarios: Array<{ id, category, name, priority, enabled, config }>（已 enabled=true 过滤）
//
// 返回:
//   {
//     modifiedRows: Array,                // 命中场景的行（lockedRowIds 全部）
//                                          // 每行加 _modifiedColumns: Set + _hitScenarioId + _hitScenarioName
//     modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }>,
//     errorReport: Array<{ scenarioId, scenarioName, rowId, code, message }>,
//     stats: { totalRows, hitRowCount, unmatchedRowCount, scenarioHitCount, hitScenarios, warningCount, skippedC3Count, skippedC4Count }
//     hitScenarios: v2.1.8 N3-1 取代 hitScenarioIds — Array<{id, displayIndex, name}>（按命中顺序，priority desc + id asc）
//   }
function runAllScenarios(bankRows, gwRows, scenarios) {
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

  const rowLockSet = new Set();
  const allModifications = [];
  const allWarnings = [];
  const rowMeta = new Map(); // _rowId → { scenarioId, scenarioName, modifiedColumns: Set }

  let scenarioHitCount = 0;
  // v2.1.8 N3-1：hitScenarioIds (number[]) → hitScenarios ({id, displayIndex, name}[])
  //   spec.md §五：状态框命中场景号显示与场景管理 UI 序号一致 — 改用 displayIndex 替代 DB id
  //   displayIndex 来源：scenario.displayIndex（scenarios-repository.listScenarios 已附）
  //   fallback：未带 displayIndex 时回退 scenario.id（兼容旧调用方 / smoke 直接构造 scenario）
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

module.exports = {
  runAllScenarios,
  sortScenariosByPriority,
  filterScenariosByGwAvailability,
  filterOutReconIdFix,
  C4_CATEGORIES
};
