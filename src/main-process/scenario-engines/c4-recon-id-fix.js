// v2.1.0-beta.1 PR-B Round 4：C4 单据对账 ReconID 修复算法引擎
// PRD §七.3 / spec §五.2
//
// === Round 4 算法语义（2026-05-09 用户决策回写）===
//
//   Step 1：同 BillDate 严格 + 全部 fieldPairs AND 全等 1v1（含反向校验）
//   Step 2：BillDate ±1day 容错（主 D vs 从 D-1/D/D+1 任一相等）+ 其他对账字段 AND 全等 1v1
//   Step 3.1：勾了 oneToMany 时，剩余主从池子内同 BillDate + 其他对账字段 AND 全等
//             用 subset-sum(从.Amount) === 主.Amount 找子集（size >= 2），多解走 tieBreak
//   Step 3.2：池子 BillDate ±1day + 其他对账字段 AND 全等 + subset-sum 1v多
//   Step 3'.1：勾了 manyToOne 时，剩余主从池子内同 BillDate + 其他对账字段 AND 全等
//              用 subset-sum(主.Amount) === 从.Amount 找子集（size >= 2），多解走 tieBreak
//   Step 3'.2：池子 BillDate ±1day + 其他对账字段 AND 全等 + subset-sum 多v1
//
//   跨 step / 跨 group 共享 pairedLeft / pairedRight 集合（每行最多被 1 次配对）
//   跑完后未配的主从行写入 unmatchedRows（含 reason 推断），供 unmatched.xlsx writer
//
// === Round 4 池子算法语义修订（替换 Round 3 单字段 Amount 全等过滤）===
//
//   Round 3 错误：池子里"逐行 Amount 全等"（每个候选从单 Amount === 主单 Amount）
//   Round 4 正解：subset-sum(候选.Amount) === 主.Amount，"多笔小金额拼出大金额"会计对账常见做法
//
//   - 候选过滤：BillDate（按 mode）+ 除 Amount 外其他 fieldPairs AND 全等
//   - subset-sum：候选 Amount 整数化（×100 转分）做 DFS + 剪枝，size <= 8（业务上限）
//   - 多解 tie-break：spread 最小 → 离主单最近 → size 最小 → firstIdx 最小（详 §tieBreakSubsets）
//   - subset 必须 size >= 2（1 v 1 已在 Step 1/2 处理过）
//
// === Round 3 Type 规则（Decision 1，Round 4 沿用）===
//
//   mode='both' RB4（1v多）：主从都 Type=0（修订前为主 0/从 2）
//   mode='both' RB2（多v1）：保持原规则（主 2/从 0）
//   mode='both' RB1（1v1）：保持双 Type=0
//   mode='main' / 'opp' R1-R7 完全不变
//
// === Round 3 commonId（Q2=a 沿用）===
//
//   computeCommonId 取 src.reconId + suffix（不是 OrderId）

const {
  evaluateCondition,
  makeWarningCollector,
  normalizeCellValue
} = require('./engine-utils');
const { ORDER_REPAIR_FIELDS } = require('../../constants/recon-id-fix-fields');

// ===== 工具函数 =====

// 把 row 按 billTypes 分类：row._types = Set<seq>
function classifyRows(rows, billTypes, side) {
  const sideTypes = (billTypes || []).filter((t) => t.side === side);
  const grouped = new Map(); // seq → conditions[]
  for (const t of sideTypes) {
    const conds = Array.isArray(t.conditions) ? t.conditions : [];
    if (!grouped.has(t.seq)) grouped.set(t.seq, []);
    for (const c of conds) grouped.get(t.seq).push(c);
  }
  return rows.map((row, idx) => {
    const types = new Set();
    for (const [seq, conds] of grouped.entries()) {
      const allMatch = conds.length > 0 && conds.every((c) => evaluateCondition(row, c));
      if (allMatch) types.add(seq);
    }
    return Object.assign({}, row, { _types: types, _rowIdx: `${side}_${idx}` });
  });
}

// 聚合 reconGroups（兼容老 reconFields[] 数据）
function groupReconFields(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg.reconGroups) && cfg.reconGroups.length > 0) {
    return cfg.reconGroups
      .filter((g) => g && typeof g === 'object')
      .map((g) => ({
        leftTypeSeq: g.leftTypeSeq,
        rightTypeSeq: g.rightTypeSeq,
        fieldPairs: Array.isArray(g.fieldPairs)
          ? g.fieldPairs.filter((fp) => fp && typeof fp === 'object').map((fp) => ({
              leftField: fp.leftField,
              rightField: fp.rightField,
              locked: fp.locked === true
            }))
          : []
      }));
  }
  // fallback：兼容老 reconFields[] 结构
  const reconFields = Array.isArray(cfg.reconFields) ? cfg.reconFields : [];
  const grouped = new Map();
  for (const rf of reconFields) {
    if (!rf || typeof rf !== 'object') continue;
    const seq = rf.seq;
    if (!grouped.has(seq)) {
      grouped.set(seq, {
        leftTypeSeq: rf.leftTypeSeq,
        rightTypeSeq: rf.rightTypeSeq,
        fieldPairs: []
      });
    }
    grouped.get(seq).fieldPairs.push({
      leftField: rf.leftField,
      rightField: rf.rightField,
      locked: rf.leftField === 'Amount' && rf.rightField === 'Amount'
    });
  }
  return Array.from(grouped.values());
}

// Round 3：找 group 里的"locked Amount/Amount" fieldPair
function findAmountLockedPair(fieldPairs) {
  if (!Array.isArray(fieldPairs)) return null;
  for (const fp of fieldPairs) {
    if (!fp) continue;
    if (fp.leftField === 'Amount' && fp.rightField === 'Amount') return fp;
  }
  return null;
}

// Round 3：BillDate 比较
//   mode='strict' — 字符串 normalize 后严格相等
//   mode='±1day' — 在严格的基础上允许差 1 天（D-1 / D / D+1 任一相等）
function billDateMatches(leftRaw, rightRaw, mode) {
  const L = normalizeCellValue(leftRaw);
  const R = normalizeCellValue(rightRaw);
  if (L === '' || R === '') return false;
  if (L === R) return true;
  if (mode !== '±1day') return false;
  const lDate = parseBillDateMs(L);
  const rDate = parseBillDateMs(R);
  if (lDate === null || rDate === null) return false;
  return Math.abs(lDate - rDate) === 86400 * 1000;
}

// 解析 BillDate 字符串为 UTC ms
function parseBillDateMs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

// 检查 leftRow 与 rightRow 在某组对账字段下是否全等（fieldPairs 全部参与 AND 全等）
// 用于 Step 1 / Step 2（含 Amount 锁定字段对在内全 AND）
function rowsMatchFieldPairs(leftRow, rightRow, fieldPairs) {
  if (!Array.isArray(fieldPairs) || fieldPairs.length === 0) return false;
  return fieldPairs.every((fp) => {
    const lv = normalizeCellValue(leftRow[fp.leftField]);
    const rv = normalizeCellValue(rightRow[fp.rightField]);
    if (lv === '' && rv === '') return false;
    return lv === rv;
  });
}

// Round 4：池子算法专用 — "除 Amount 外其他对账字段 AND 全等"
// otherFieldPairs 已在调用端过滤掉 Amount/Amount 锁定行；空数组 → 直接 true（仅 Amount 一对时无其他过滤约束）
function rowsMatchOtherFieldPairs(leftRow, rightRow, otherFieldPairs) {
  if (!Array.isArray(otherFieldPairs) || otherFieldPairs.length === 0) return true;
  return otherFieldPairs.every((fp) => {
    const lv = normalizeCellValue(leftRow[fp.leftField]);
    const rv = normalizeCellValue(rightRow[fp.rightField]);
    if (lv === '' && rv === '') return false;
    return lv === rv;
  });
}

// Round 4：金额转整数分（×100 四舍五入）— 避免浮点 0.1+0.2!=0.3 精度坑
function toCents(amount) {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (trimmed === '') return null; // 空串 → null（避免 Number('') === 0）
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);
  }
  return null;
}

// Round 4：subset-sum 枚举 — 在 candidates 数组中找所有 subset 使 sum(cents) === targetCents
// 限制 subset.length ∈ [2, maxSize]；DFS + 升序剪枝；上限超出立即返回避免组合爆炸
// candidates 形如 [{row, cents}, ...]；返回 Array<Array<row>>（每个解 = 命中的 row 数组）
function enumerateAmountSubsets(candidates, targetCents, maxSize = 8, maxSolutions = 64) {
  if (!Array.isArray(candidates) || candidates.length < 2) return [];
  if (!Number.isFinite(targetCents) || targetCents <= 0) return [];
  // 按 cents 升序排序（便于剪枝：若当前累加 + 当前 cents > target，后面更大也不必试）
  // 用 indexedCandidates 保留原"输入数组顺序"信息（tieBreak 第 4 步要用）
  const indexed = candidates.map((c, originalIdx) => ({ ...c, _origIdx: originalIdx }));
  indexed.sort((a, b) => a.cents - b.cents);
  const solutions = [];
  const path = [];
  function dfs(startIdx, remaining, depth) {
    if (solutions.length >= maxSolutions) return;
    if (remaining === 0 && depth >= 2) {
      solutions.push(path.slice());
      return;
    }
    if (depth >= maxSize) return;
    if (startIdx >= indexed.length) return;
    for (let i = startIdx; i < indexed.length; i++) {
      const c = indexed[i];
      if (c.cents > remaining) break; // 升序剪枝：后面更大，全部超目标
      // 跳过已在 path 里同 cents 的"等价分支"剪枝过激（会漏 [70k, 70k] 这种合法解）
      // 不做去重剪枝；改由原数组身份保证子集唯一
      path.push(c);
      dfs(i + 1, remaining - c.cents, depth + 1);
      path.pop();
      if (solutions.length >= maxSolutions) return;
    }
  }
  dfs(0, targetCents, 0);
  // 把每个解从 [{row, cents, _origIdx}, ...] → [row, ...]，并按 _origIdx 升序保证子集行内顺序稳定
  return solutions.map((s) => {
    return s
      .slice()
      .sort((a, b) => a._origIdx - b._origIdx)
      .map((c) => c.row);
  });
}

// Round 4：tieBreak — 多个 subset 都 sum=主 Amount 时决出唯一最优
// 排序顺序：
//   1) 解内日期跨度最小（max(子集 BillDate) - min(子集 BillDate)）
//   2) 离主单 BillDate 最近（min(|主.BillDate - 子集.BillDate|)）
//   3) 子集元素数最少
//   4) 子集元素在原数组顺序的首个 BillDate 最早（兜底）
function tieBreakSubsets(subsets, mainBillDate) {
  if (!Array.isArray(subsets) || subsets.length === 0) return null;
  if (subsets.length === 1) return subsets[0];
  const mainMs = parseBillDateMs(normalizeCellValue(mainBillDate));
  const scored = subsets.map((s) => {
    const dates = s.map((r) => parseBillDateMs(normalizeCellValue(r.BillDate))).filter((x) => x !== null);
    const spread = dates.length === 0 ? Number.POSITIVE_INFINITY : (Math.max(...dates) - Math.min(...dates));
    let distToMain = Number.POSITIVE_INFINITY;
    if (mainMs !== null && dates.length > 0) {
      distToMain = Math.min(...dates.map((d) => Math.abs(mainMs - d)));
    }
    const size = s.length;
    // firstIdx 用 _rowIdx 字符串（'main_3' / 'opp_5'）字典序作 fallback；同侧排序与原行顺序一致
    const firstIdx = s.map((r) => r._rowIdx).sort()[0] || '';
    return { subset: s, spread, distToMain, size, firstIdx };
  });
  scored.sort((a, b) => {
    if (a.spread !== b.spread) return a.spread - b.spread;
    if (a.distToMain !== b.distToMain) return a.distToMain - b.distToMain;
    if (a.size !== b.size) return a.size - b.size;
    if (a.firstIdx < b.firstIdx) return -1;
    if (a.firstIdx > b.firstIdx) return 1;
    return 0;
  });
  return scored[0].subset;
}

// lookupReconId（spec §五.2.3 + Q1=A 决策）
function lookupReconId(opCounterRow) {
  if (!opCounterRow) return '';
  const v = opCounterRow.reconId;
  return v === null || v === undefined ? '' : String(v).trim();
}

// resolveSubBizType（PRD §七.3.2 R5/R6 + Q2=A 决策）
function resolveSubBizType(side, row, subCfg, reconResult, warningCollector) {
  if (!subCfg || !subCfg.mode) return '';
  const mode = subCfg.mode;
  if (mode === 'manualMain') {
    return side === 'main' ? String(subCfg.mainValue || '') : '';
  }
  if (mode === 'manualOpp') {
    return side === 'opp' ? String(subCfg.oppValue || '') : '';
  }
  if (mode === 'manualBoth') {
    return side === 'main' ? String(subCfg.mainValue || '') : String(subCfg.oppValue || '');
  }
  if (mode === 'auto') {
    const bizType = normalizeCellValue(row.BizType);
    const orderId = normalizeCellValue(row.OrderId);
    if (!bizType && !orderId) {
      warningCollector.push({
        sourceSide: side,
        sourceRowOrderId: orderId,
        code: 'subBizType-not-found',
        message: '在对账结果 sheet 未匹配到 BizType+OrderId 行（源行 BizType+OrderId 都为空）'
      });
      return '';
    }
    const orderIdField = side === 'main' ? '业务部门单号' : '对手部门单号';
    const subTypeField = side === 'main' ? '业务部门单据子类型' : '对手部门单据子类型';
    const matched = (reconResult || []).filter((rr) => {
      return normalizeCellValue(rr['业务类型']) === bizType
        && normalizeCellValue(rr[orderIdField]) === orderId;
    });
    if (matched.length === 0) {
      warningCollector.push({
        sourceSide: side,
        sourceRowOrderId: orderId,
        code: 'subBizType-not-found',
        message: '在对账结果 sheet 未匹配到 BizType+OrderId 行'
      });
      return '';
    }
    return normalizeCellValue(matched[0][subTypeField]);
  }
  return '';
}

// 共同修复 ID（Q2=a 决策）：取 src.reconId + suffix
function computeCommonId(commonIdCfg, leftRow, rightRow) {
  if (!commonIdCfg) return '';
  const src = commonIdCfg.source === 'opp' ? rightRow : leftRow;
  const baseReconId = src ? normalizeCellValue(src.reconId) : '';
  const suffix = commonIdCfg.suffix === null || commonIdCfg.suffix === undefined
    ? ''
    : String(commonIdCfg.suffix);
  return baseReconId + suffix;
}

// 从 srcRow 抽 15 列，覆盖 overrides
function buildOutputRow(srcRow, overrides) {
  const out = {};
  for (const col of ORDER_REPAIR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides || {}, col)) {
      out[col] = overrides[col];
    } else {
      const v = srcRow[col];
      out[col] = v === null || v === undefined ? '' : v;
    }
  }
  Object.defineProperty(out, '_sourceSide', {
    value: overrides && overrides._sourceSide ? overrides._sourceSide : null,
    enumerable: false
  });
  return out;
}

// ===== Round 3 算法主路径 =====
//
// Round 5 微调（2026-05-09，Q1=a 决策）：Step 2（billDateMode='±1day'）多候选时改 tie-break 挑 1 个 1v1 命中
//   tie-break 顺序：
//     1) |主.BillDate - 从.BillDate| 最小（距离最近）
//     2) 从单 _rowIdx 字符串字典序最小（原数组顺序首个）
//   双向一致性：所选 bestRight 反查 leftRows 用同样 tie-break 选回主单；不是当前 leftRow 则放弃（避免主从抢配冲突）
//   Step 1（billDateMode='strict'）保持现状：必须恰好 1 个候选 + reverse 恰好 1 才命中

// Round 5：tie-break 多候选挑 1 个最优
//   排序顺序：BillDate 距离最近 → _rowIdx 字典序最小
function pickBestByTieBreak(referenceRow, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const refMs = parseBillDateMs(normalizeCellValue(referenceRow.BillDate));
  const scored = candidates.map((r) => {
    const rMs = parseBillDateMs(normalizeCellValue(r.BillDate));
    let dist;
    if (refMs === null || rMs === null) {
      dist = Number.POSITIVE_INFINITY;
    } else {
      dist = Math.abs(refMs - rMs);
    }
    return { row: r, dist, idx: r._rowIdx || '' };
  });
  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.idx < b.idx) return -1;
    if (a.idx > b.idx) return 1;
    return 0;
  });
  return scored[0].row;
}

// Step 1 / Step 2：1v1 严格 / ±1day 容错（共用同函数，billDateMode 切换日期比较）
//   Round 5 微调：billDateMode='±1day' 多候选时按 tie-break 挑 1 个最优 + 双向一致性校验
function tryOneToOne(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  for (const leftRow of leftRows) {
    if (pairedLeft.has(leftRow._rowIdx)) continue;
    lastStepByLeft.set(leftRow._rowIdx, stepLabel);
    // 候选：BillDate 按 mode 比较 + 全部 fieldPairs AND 全等
    const candidates = rightRows.filter((r) =>
      !pairedRight.has(r._rowIdx)
        && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
        && rowsMatchFieldPairs(leftRow, r, fieldPairs)
    );
    if (billDateMode === 'strict') {
      // Step 1：保持原行为，必须恰好 1 个候选
      if (candidates.length !== 1) {
        candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
        continue;
      }
      const rightRow = candidates[0];
      // 反向校验：右行回看左侧空闲行的匹配数 == 1，确保 1v1
      const reverse = leftRows.filter((l) =>
        !pairedLeft.has(l._rowIdx)
          && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode)
          && rowsMatchFieldPairs(l, rightRow, fieldPairs)
      );
      if (reverse.length !== 1) {
        lastStepByRight.set(rightRow._rowIdx, stepLabel);
        continue;
      }
      pairedLeft.add(leftRow._rowIdx);
      pairedRight.add(rightRow._rowIdx);
      apply1v1Assignment(leftRow, rightRow, scenario, cfg, reconResult, fixedRows, warningCollector);
    } else {
      // Step 2：±1day 容错，多候选 tie-break + 双向一致性校验
      if (candidates.length === 0) continue;
      const bestRight = pickBestByTieBreak(leftRow, candidates);
      if (!bestRight) continue;
      // 标记所有候选最后到达 step（以便 unmatched reason 推断）
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      // 双向一致性：bestRight 反查 leftRows，按同 tie-break 选最优主单；不是当前 leftRow 则让位
      const reverseCandidates = leftRows.filter((l) =>
        !pairedLeft.has(l._rowIdx)
          && billDateMatches(l.BillDate, bestRight.BillDate, billDateMode)
          && rowsMatchFieldPairs(l, bestRight, fieldPairs)
      );
      if (reverseCandidates.length === 0) continue;
      const bestLeftFromReverse = pickBestByTieBreak(bestRight, reverseCandidates);
      if (!bestLeftFromReverse || bestLeftFromReverse._rowIdx !== leftRow._rowIdx) continue;
      pairedLeft.add(leftRow._rowIdx);
      pairedRight.add(bestRight._rowIdx);
      apply1v1Assignment(leftRow, bestRight, scenario, cfg, reconResult, fixedRows, warningCollector);
    }
  }
}

// Round 4：池子 1v多 — subset-sum(候选从.Amount) === 主.Amount
// 候选过滤：BillDate（按 mode）+ 除 Amount 外其他 fieldPairs AND 全等
// 找到唯一/最优子集（size >= 2）→ 锁定主+子集；多解 tieBreak 决出唯一最优解
function tryOneToManyPool(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  // 拆出 amountPair（必有，dialog 强制锁定 + migration 保证）+ 其他 fieldPairs
  const amountPair = findAmountLockedPair(fieldPairs);
  if (!amountPair) return;
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && !(fp.leftField === 'Amount' && fp.rightField === 'Amount')
  );
  for (const leftRow of leftRows) {
    if (pairedLeft.has(leftRow._rowIdx)) continue;
    lastStepByLeft.set(leftRow._rowIdx, stepLabel);
    // 候选过滤：BillDate + 其他对账字段 AND 全等（Amount 不参与 AND 过滤）
    const candidates = rightRows.filter((r) =>
      !pairedRight.has(r._rowIdx)
        && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
        && rowsMatchOtherFieldPairs(leftRow, r, otherFieldPairs)
    );
    if (candidates.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    // subset-sum 找子集
    const targetCents = toCents(leftRow.Amount);
    if (targetCents === null) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((r) => ({ row: r, cents: toCents(r.Amount) }))
      .filter((c) => c.cents !== null);
    const subsets = enumerateAmountSubsets(candidatesWithCents, targetCents);
    if (subsets.length === 0) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    const chosen = subsets.length === 1
      ? subsets[0]
      : tieBreakSubsets(subsets, leftRow.BillDate);
    if (!chosen || chosen.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    pairedLeft.add(leftRow._rowIdx);
    chosen.forEach((r) => pairedRight.add(r._rowIdx));
    apply1vNAssignment(leftRow, chosen, scenario, cfg, reconResult, fixedRows, warningCollector);
  }
}

// Round 4：池子 多v1 — subset-sum(候选主.Amount) === 从.Amount
// 候选过滤：BillDate（按 mode）+ 除 Amount 外其他 fieldPairs AND 全等
function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  const amountPair = findAmountLockedPair(fieldPairs);
  if (!amountPair) return;
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && !(fp.leftField === 'Amount' && fp.rightField === 'Amount')
  );
  for (const rightRow of rightRows) {
    if (pairedRight.has(rightRow._rowIdx)) continue;
    lastStepByRight.set(rightRow._rowIdx, stepLabel);
    const candidates = leftRows.filter((l) =>
      !pairedLeft.has(l._rowIdx)
        && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode)
        && rowsMatchOtherFieldPairs(l, rightRow, otherFieldPairs)
    );
    if (candidates.length < 2) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const targetCents = toCents(rightRow.Amount);
    if (targetCents === null) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((l) => ({ row: l, cents: toCents(l.Amount) }))
      .filter((c) => c.cents !== null);
    const subsets = enumerateAmountSubsets(candidatesWithCents, targetCents);
    if (subsets.length === 0) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const chosen = subsets.length === 1
      ? subsets[0]
      : tieBreakSubsets(subsets, rightRow.BillDate);
    if (!chosen || chosen.length < 2) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    pairedRight.add(rightRow._rowIdx);
    chosen.forEach((l) => pairedLeft.add(l._rowIdx));
    applyNv1Assignment(chosen, rightRow, scenario, cfg, reconResult, fixedRows, warningCollector);
  }
}

// ===== 7 + 5 规则赋值（按 cfg.output.mode 分支）=====

function apply1v1Assignment(leftRow, rightRow, scenario, cfg, reconResult, fixedRows, warningCollector) {
  const mode = (cfg.output || {}).mode;
  const subCfg = (cfg.output || {}).subBizType || { mode: 'auto' };
  if (mode === 'main') {
    const reference = lookupReconId(rightRow);
    const subBizType = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(leftRow, {
      Type: 0,
      Reference: reference,
      SubBizType: subBizType,
      _sourceSide: 'main'
    }));
  } else if (mode === 'opp') {
    const reference = lookupReconId(leftRow);
    const subBizType = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(rightRow, {
      Type: 0,
      Reference: reference,
      SubBizType: subBizType,
      _sourceSide: 'opp'
    }));
  } else if (mode === 'both') {
    // RB1：双 Type=0
    const commonId = computeCommonId((cfg.output || {}).commonId, leftRow, rightRow);
    const leftSub = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
    const rightSub = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(leftRow, {
      Type: 0,
      Reference: commonId,
      SubBizType: leftSub,
      _sourceSide: 'main'
    }));
    fixedRows.push(buildOutputRow(rightRow, {
      Type: 0,
      Reference: commonId,
      SubBizType: rightSub,
      _sourceSide: 'opp'
    }));
  }
}

// 1v多（leftRow → matches[N]）
//   mode='main'：业务少见；按"主单笔修复"语义把首个 right 当 1v1
//   mode='opp'：R4 — 多个 right Type=0 / Reference=leftRow.reconId
//   mode='both'：RB4 — left Type=0 / **right Type=0**（Round 3 修订；原 right Type=2）
function apply1vNAssignment(leftRow, matches, scenario, cfg, reconResult, fixedRows, warningCollector) {
  const mode = (cfg.output || {}).mode;
  const subCfg = (cfg.output || {}).subBizType || { mode: 'auto' };
  if (mode === 'main') {
    const reference = lookupReconId(matches[0]);
    const subBizType = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(leftRow, {
      Type: 0,
      Reference: reference,
      SubBizType: subBizType,
      _sourceSide: 'main'
    }));
  } else if (mode === 'opp') {
    const reference = lookupReconId(leftRow);
    for (const rightRow of matches) {
      const subBizType = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
      fixedRows.push(buildOutputRow(rightRow, {
        Type: 0,
        Reference: reference,
        SubBizType: subBizType,
        _sourceSide: 'opp'
      }));
    }
  } else if (mode === 'both') {
    // Round 3 修订（Decision 1）：right Type 由 2 改为 0
    const commonId = computeCommonId((cfg.output || {}).commonId, leftRow, matches[0]);
    const leftSub = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(leftRow, {
      Type: 0,
      Reference: commonId,
      SubBizType: leftSub,
      _sourceSide: 'main'
    }));
    for (const rightRow of matches) {
      const rightSub = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
      fixedRows.push(buildOutputRow(rightRow, {
        Type: 0,                                         // Round 3：原 2 → 改 0
        Reference: commonId,
        SubBizType: rightSub,
        _sourceSide: 'opp'
      }));
    }
  }
}

// 多v1（matches[N] left → rightRow）
//   mode='main'：R2 — 多个 left Type=2 / Reference=rightRow.reconId
//   mode='opp'：业务少见，按对称取首个 left 的 reconId
//   mode='both'：RB2 — left Type=2 / right Type=0；commonId 共享
function applyNv1Assignment(matches, rightRow, scenario, cfg, reconResult, fixedRows, warningCollector) {
  const mode = (cfg.output || {}).mode;
  const subCfg = (cfg.output || {}).subBizType || { mode: 'auto' };
  if (mode === 'main') {
    const reference = lookupReconId(rightRow);
    for (const leftRow of matches) {
      const subBizType = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
      fixedRows.push(buildOutputRow(leftRow, {
        Type: 2,
        Reference: reference,
        SubBizType: subBizType,
        _sourceSide: 'main'
      }));
    }
  } else if (mode === 'opp') {
    const reference = lookupReconId(matches[0]);
    const subBizType = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(rightRow, {
      Type: 0,
      Reference: reference,
      SubBizType: subBizType,
      _sourceSide: 'opp'
    }));
  } else if (mode === 'both') {
    // RB2：left Type=2 / right Type=0
    const commonId = computeCommonId((cfg.output || {}).commonId, matches[0], rightRow);
    for (const leftRow of matches) {
      const leftSub = resolveSubBizType('main', leftRow, subCfg, reconResult, warningCollector);
      fixedRows.push(buildOutputRow(leftRow, {
        Type: 2,
        Reference: commonId,
        SubBizType: leftSub,
        _sourceSide: 'main'
      }));
    }
    const rightSub = resolveSubBizType('opp', rightRow, subCfg, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(rightRow, {
      Type: 0,
      Reference: commonId,
      SubBizType: rightSub,
      _sourceSide: 'opp'
    }));
  }
}

// ===== Round 3 unmatched 收集 =====

function collectUnmatchedRows(mainTyped, oppTyped, pairedLeft, pairedRight,
  lastStepByLeft, lastStepByRight, matchRules, scenarioName, groups) {
  const out = [];
  const usePool = matchRules && (matchRules.oneToMany || matchRules.manyToOne);
  // 收集本场景所有 group 涉及的 leftTypeSeq / rightTypeSeq；未涉及的行不进 unmatched（业务上"非本场景行"不算未配）
  const leftSeqs = new Set();
  const rightSeqs = new Set();
  (groups || []).forEach((g) => {
    if (g.leftTypeSeq !== undefined) leftSeqs.add(g.leftTypeSeq);
    if (g.rightTypeSeq !== undefined) rightSeqs.add(g.rightTypeSeq);
  });
  function rowBelongsToAnyLeftGroup(r) {
    for (const s of leftSeqs) if (r._types.has(s)) return true;
    return false;
  }
  function rowBelongsToAnyRightGroup(r) {
    for (const s of rightSeqs) if (r._types.has(s)) return true;
    return false;
  }
  function deriveReason(rowIdx, lastStepMap) {
    const last = lastStepMap.get(rowIdx);
    if (last === 'step3.2' || last === "step3'.2") return '池子内 BillDate ±1day 未匹配';
    if (last === 'step3.1' || last === "step3'.1") return '池子内 BillDate 未匹配';
    if (last === 'step2') return '1v1 BillDate ±1day 未匹配';
    if (last === 'step1') return '1v1 严格 BillDate 未匹配';
    // last 为 undefined：行属于本场景但所有 step 都没遍历到该行（即没有任何主/从作为候选时遇到它）
    // → 推断"算法跑到的最后阶段"
    if (!matchRules) return '未勾 1v多/多v1，跳过';
    if (matchRules.oneToMany || matchRules.manyToOne) {
      // 池子也跑了，最后到 step3.2 / step3'.2，但行未被遍历到
      return '池子内 BillDate ±1day 未匹配';
    }
    if (matchRules.oneToOne) {
      return '1v1 BillDate ±1day 未匹配';
    }
    return '未勾 1v多/多v1，跳过';
  }
  for (const r of mainTyped) {
    if (pairedLeft.has(r._rowIdx)) continue;
    if (!rowBelongsToAnyLeftGroup(r)) continue;     // 不属于本场景的行不算 unmatched
    out.push({
      场景名: scenarioName || '',
      单据来源: '主',
      OrderId: r.OrderId,
      BillDate: r.BillDate,
      Amount: r.Amount,
      未配原因: deriveReason(r._rowIdx, lastStepByLeft)
    });
  }
  for (const r of oppTyped) {
    if (pairedRight.has(r._rowIdx)) continue;
    if (!rowBelongsToAnyRightGroup(r)) continue;
    out.push({
      场景名: scenarioName || '',
      单据来源: '从',
      OrderId: r.OrderId,
      BillDate: r.BillDate,
      Amount: r.Amount,
      未配原因: deriveReason(r._rowIdx, lastStepByRight)
    });
  }
  return out;
}

// ===== 主入口 =====

function runC4Scenario(scenario, sheets) {
  if (!scenario) {
    throw new Error('runC4Scenario: scenario 不能为空');
  }
  const cfg = scenario.config || {};
  const matchRules = cfg.matchRules || {};
  const reconResult = (sheets && sheets.reconResult) || [];
  const businessBills = (sheets && sheets.businessBills) || [];
  const opponentBills = (sheets && sheets.opponentBills) || [];

  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const fixedRows = [];

  // 1. 给主从边账单分类
  const mainTyped = classifyRows(businessBills, cfg.billTypes, 'main');
  const oppTyped = classifyRows(opponentBills, cfg.billTypes, 'opp');

  // 2. 直接读 cfg.reconGroups
  const groups = groupReconFields(cfg);

  // 3. 跨 group 共享配对集合
  const pairedLeft = new Set();
  const pairedRight = new Set();
  // 跟踪每行最后一次到达的 step
  const lastStepByLeft = new Map();
  const lastStepByRight = new Map();

  // 4. Round 4 5 阶段算法（按 group 顺序，跨 group 共享 paired 集合）
  for (const grp of groups) {
    const leftRows = mainTyped.filter((r) => r._types.has(grp.leftTypeSeq));
    const rightRows = oppTyped.filter((r) => r._types.has(grp.rightTypeSeq));
    const amountPair = findAmountLockedPair(grp.fieldPairs);

    // Step 1：同 BillDate 严格 1v1
    if (matchRules.oneToOne) {
      tryOneToOne(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step1');
    }
    // Step 2：BillDate ±1day 1v1
    if (matchRules.oneToOne) {
      tryOneToOne(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step2');
    }
    // Step 3.1+3.2：池子 1v多（subset-sum + tieBreak）
    if (matchRules.oneToMany && amountPair) {
      tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step3.1');
      tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step3.2');
    }
    // Step 3'.1+3'.2：池子 多v1（subset-sum + tieBreak）
    if (matchRules.manyToOne && amountPair) {
      tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, "step3'.1");
      tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, "step3'.2");
    }
  }

  // 5. unmatched 收集（跑完所有 group 后；只收集属于某 group 的 leftRows/rightRows 的未配行）
  const unmatchedRows = collectUnmatchedRows(
    mainTyped, oppTyped, pairedLeft, pairedRight,
    lastStepByLeft, lastStepByRight, matchRules, scenario.name, groups
  );

  const mainTouched = fixedRows.filter((r) => r._sourceSide === 'main').length;
  const oppTouched = fixedRows.filter((r) => r._sourceSide === 'opp').length;

  return {
    fixedRows,
    warnings: warningCollector.list(),
    unmatchedRows,
    stats: {
      fixedRowCount: fixedRows.length,
      warningCount: warningCollector.list().length,
      unmatchedRowCount: unmatchedRows.length,
      mainRowsTouched: mainTouched,
      oppRowsTouched: oppTouched
    }
  };
}

module.exports = {
  runC4Scenario,
  // 内部工具（暴露给 smoke）
  classifyRows,
  groupReconFields,
  findAmountLockedPair,
  billDateMatches,
  parseBillDateMs,
  rowsMatchFieldPairs,
  rowsMatchOtherFieldPairs,
  toCents,
  enumerateAmountSubsets,
  tieBreakSubsets,
  pickBestByTieBreak,
  lookupReconId,
  resolveSubBizType,
  computeCommonId,
  buildOutputRow,
  collectUnmatchedRows,
  tryOneToOne,
  tryOneToManyPool,
  tryManyToOnePool
};
