// v2.0.0-beta.3 PR #32a：first-match-wins 调度引擎
// PRD §7.4 / spec.md F2
//
// 行为：
//   1. enabledScenarios 按 priority desc, id asc 排序
//   2. gwRows === null → 过滤掉 'gateway-recon-join' 类场景
//   3. 全局 rowLockSet
//   4. 每场景跑前过滤未锁行 → runScenario 拿 { lockedRowIds, modifications, warnings }
//   5. merge 到全局：rowLockSet ∪= lockedRowIds；modifications/warnings 注入 scenarioId/scenarioName
//   6. modifiedRows = bankRows.filter(r => rowLockSet.has(r._rowId))
//   7. 每行加 _modifiedColumns（Set） + _hitScenarioId + _hitScenarioName

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
//     stats: { totalRows, hitRowCount, scenarioHitCount, warningCount, skippedC3Count }
//   }
function runAllScenarios(bankRows, gwRows, scenarios) {
  if (!Array.isArray(bankRows)) {
    throw new Error('runAllScenarios: bankRows 必须是数组');
  }
  if (!Array.isArray(scenarios)) {
    throw new Error('runAllScenarios: scenarios 必须是数组');
  }

  const enabled = scenarios.filter((s) => s && s.enabled);
  const sorted = sortScenariosByPriority(enabled);
  const filtered = filterScenariosByGwAvailability(sorted, gwRows);
  const skippedC3Count = sorted.length - filtered.length;

  const rowLockSet = new Set();
  const allModifications = [];
  const allWarnings = [];
  const rowMeta = new Map(); // _rowId → { scenarioId, scenarioName, modifiedColumns: Set }

  let scenarioHitCount = 0;

  for (const scenario of filtered) {
    const unlocked = bankRows.filter((r) => !rowLockSet.has(r._rowId));
    if (unlocked.length === 0) break;

    const result = runScenario(scenario, unlocked, gwRows);
    const { lockedRowIds, modifications, warnings } = result;

    if (lockedRowIds && lockedRowIds.size > 0) {
      scenarioHitCount += 1;
      lockedRowIds.forEach((rowId) => {
        rowLockSet.add(rowId);
        if (!rowMeta.has(rowId)) {
          rowMeta.set(rowId, {
            scenarioId: scenario.id,
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
        scenarioName: null,
        modifiedColumns: new Set()
      };
      return {
        ...r,
        _hitScenarioId: meta.scenarioId,
        _hitScenarioName: meta.scenarioName,
        _modifiedColumns: meta.modifiedColumns
      };
    });

  return {
    modifiedRows,
    modifications: allModifications,
    errorReport: allWarnings,
    stats: {
      totalRows: bankRows.length,
      hitRowCount: modifiedRows.length,
      scenarioHitCount,
      warningCount: allWarnings.length,
      skippedC3Count
    }
  };
}

module.exports = {
  runAllScenarios,
  sortScenariosByPriority,
  filterScenariosByGwAvailability
};
