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
// === PR #36 round 2 P2 修复（2026-04-30）：subset-sum DFS 全遍历维护全局 best ===
//
//   旧实现 `enumerateAmountSubsets(...) → tieBreakSubsets(...)` 二段式：DFS 找到 maxSolutions=64 解后停，
//   再排序选最优。当全局最优解排在第 N>64 位时被漏选 — user 复现：10 个 04-01 + 3 个 04-15 + target=300，
//   64 解里 0 个全 04-15（最优）。
//
//   修复方案 A：池子算法改用 `findBestAmountSubset` — DFS 不收集 solutions 数组，每找到一个 sum=target 解
//   立即与"当前 best"做 tieBreak 比较（spread → distToMain → size → firstIdxNum），更新 best；不预截断。
//   性能：升序剪枝 + 后缀总和剪枝 + maxSize=8 + hardCeiling 硬上限（DFS visit 次数防御，默认 5e6）。
//
//   `enumerateAmountSubsets` / `tieBreakSubsets` 保留（向后兼容 + 单测覆盖），但池子算法不再调用。
//
// === PR #36 round 3 P2 修复（2026-04-30）：移除"absolute optimal 早停"剪枝 ===
//
//   round 2 引入 `isBestAbsoluteOptimal()` 早停：best 满足 spread=0 + distToMain=0 + size=2 时
//   直接 break。bug（user 提）：tie-break 实际 4 阶（spread → distToMain → size → firstIdxNum），
//   早停只覆盖前 3 阶；firstIdxNum 仍可能在剩余分支中更优。
//   例：candidates [opp_10:1, opp_2:50, opp_3:50, opp_11:99] / target=100，DFS 升序遍历先找到
//   {opp_10, opp_11} 触发早停，漏掉 firstIdxNum 更小的全局最优 {opp_2, opp_3}。
//   修法：删除该剪枝；其他剪枝足够防爆炸（n=20 实测耗时仍 < 5ms 量级，见 P2-6/P2-7 用例）。
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
// v2.1.0-beta.3 T8：网关子模式输出列模板（14 列，无 SubBizType）
const { ORDER_REPAIR_FIELDS_GATEWAY } = require('../../constants/gateway-bill-recon-fields');
// v2.1.9 SR-log-1 (T32h)：替换 console.warn → appendModuleLog 双写
//   不用解构赋值（unit test spy 可改 logger.appendModuleLog 单点劫持）
const logger = require('../../backend/logger');

// ===== 工具函数 =====

// v2.1.8 F5 T08：BillDate 值规范化为 'YYYY-MM-DD' 字符串
//   gateway 子模式 createTime 列在 Excel 真日期格式下 sheetToObjects raw:true 读出 number 序列号
//   parseBillDateMs 正则只认字符串 → 需在 gateway 映射段先规范化
//   不动 recon-id-fix-io.js raw 模式（共用函数影响 8 sheet × N 字段，资金红线扩面）
//   spec.md F5-D4 v0.3 Reverse Sync 决策方案 C
function normalizeBillDateValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    // Infinity / NaN / -Infinity 不是有效 Excel 序列号，返回 '' 让 parseBillDateMs 拿到空也 fail（避免诡异字符串）
    if (!Number.isFinite(value)) return '';
    // Excel epoch = 1899-12-30（修正 1900 闰年 bug 后），1 serial = 1 day
    const ms = Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(value);
}

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
// v2.1.0-beta.3 T8/T10：兼容 gateway 子模式
//   business: 左 'Amount' / 右 'Amount'（与 v2.1.0-beta.1 一致）
//   gateway : 左 'Amount'（网关账单） / 右 'receiveAmount'（渠道账单 — fixture 实际字段名）
//   双重识别：locked === true 优先（保证 dialog 设置的 lock 标识有效），其次按字段名兼容补识
function findAmountLockedPair(fieldPairs) {
  if (!Array.isArray(fieldPairs)) return null;
  // 优先按 locked 标识识别
  for (const fp of fieldPairs) {
    if (fp && fp.locked === true) return fp;
  }
  // fallback：按字段名（兼容 v2.1.0-beta.1 老 draft 没有 locked 字段）
  for (const fp of fieldPairs) {
    if (!fp) continue;
    if (fp.leftField === 'Amount' && fp.rightField === 'Amount') return fp;
  }
  return null;
}

// Round 3：BillDate 比较
//   mode='strict' — 字符串 normalize 后严格相等
//   mode='±1day' — 启用容错；差 ≤ days 天命中（含 D-N … D+N）
// v2.1.1 T2-2：days 参数化（取代硬编码 1 day）；默认 1 兼容老调用方
//   语义：mode='strict' → 仅字符串相等；mode='±1day' → 字符串相等或差 ≤ days 天
//   mode 标识保留 '±1day' 字面（语义层是"启用容错"），具体窗口由 days 决定
function billDateMatches(leftRaw, rightRaw, mode, days = 1) {
  const L = normalizeCellValue(leftRaw);
  const R = normalizeCellValue(rightRaw);
  if (L === '' || R === '') return false;
  if (L === R) return true;
  if (mode !== '±1day') return false;
  const lDate = parseBillDateMs(L);
  const rDate = parseBillDateMs(R);
  if (lDate === null || rDate === null) return false;
  return Math.abs(lDate - rDate) <= days * 86400 * 1000;
}

// 解析 BillDate 字符串为 UTC ms
function parseBillDateMs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

// PR #36 round 1 P2 修复（2026-04-30）：解析 _rowIdx 字符串末尾数字部分
//   _rowIdx 格式：'main_<idx>' 或 'opp_<idx>'（由 classifyRows 生成，idx = 原数组下标）
//   原 tie-break 用 _rowIdx 字符串字典序，候选 ≥ 10 时 'opp_10' < 'opp_2' 排错；
//   解析数字部分比较即可恢复"原数组首个 row index"的文档约定。
//   非法格式（无 _<digits> 后缀）→ 返回 MAX_SAFE_INTEGER 让其排在最后。
function parseRowIdxNum(rowIdx) {
  if (rowIdx === null || rowIdx === undefined) return Number.MAX_SAFE_INTEGER;
  const m = String(rowIdx).match(/_(\d+)$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
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
//
// PR #36 round 2 P2 修复（2026-04-30）：本函数仍维持"枚举到 maxSolutions 即停"语义，
// 池子算法已迁移到 `findBestAmountSubset`（DFS 全遍历维护全局 best），保留本函数用于直接单测/向后兼容。
// 注意：本函数+`tieBreakSubsets` 二段式在 maxSolutions=64 截断 + 全局最优排在 ≥ 65 位时会漏选最优解，
// 不应再被池子算法直接使用；池子算法请用 `findBestAmountSubset`。
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

// PR #36 round 2 P2 修复（2026-04-30）：subset-sum DFS 全遍历 + 维护全局 best
//
// 背景（user 复现）：原 `enumerateAmountSubsets(...) → tieBreakSubsets(...)` 二段式
// 在 `maxSolutions=64` 处先截断、再排序，导致全局最优解排在 ≥ 65 位时被漏选。
// 例：10 个 04-01 候选 + 3 个 04-15 候选、target=300，64 个解里 0 个全 04-15（最优 spread=0+distToMain=0），
// 旧算法返回 04-01 子集（次优）。
//
// 修复方案 A：DFS 找到 sum=target 的解时，立即与"当前 best"做 tieBreak 比较（spread → distToMain → size → firstIdxNum），
// 更新 best；不收集 solutions 数组、不预截断。配合：
//   - 升序排序 + cents > remaining 剪枝（与旧实现一致）
//   - 后缀总和不足剪枝（remaining > 后缀和 → break；新增）
//   - maxSize=8（与旧实现一致；业务约束）
//   - 硬上限 hardCeiling（默认 5000000；DFS visit 次数防御；仅极端数据兜底）
//
// PR #36 round 3 P2 修复（2026-05-09）：删除"启发式提前终止"剪枝
//   原剪枝条件 spread=0 + distToMain=0 + size=2 只覆盖 tieBreak 前 3 阶，
//   firstIdxNum 第 4 阶仍可能改进（user 复现：[opp_10:1, opp_2:50, opp_3:50, opp_11:99] target=100
//   早停后选 [opp_10, opp_11]，删早停后选 [opp_2, opp_3]）。
//
// 返回 Array<row>（最优子集，按 row._origIdx 升序）；无解返回 null
//
// candidates 形如 [{row, cents}, ...]；mainBillDate 用于 distToMain 计算
function findBestAmountSubset(candidates, targetCents, mainBillDate, options = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  if (!Number.isFinite(targetCents) || targetCents <= 0) return null;
  // v2.1.8 F5 T09：maxSize 动态档位（spec.md F5-D1）+ 性能护栏（F5-D5）
  //   options.maxSize 显式传入 → 用它（向后兼容 + 测试可覆盖）
  //   未指定 → 按 candidates.length 自动决定：
  //     pool ≤ 12 → 全跑（不限）
  //     pool 13-20 → maxSize = 12
  //     pool 21-25 → maxSize = 10 + degraded
  //     pool > 25 → maxSize = 8 + degraded（性能护栏 F5-D5）
  //   解决 v2.1.7 §10.3 根因 #2：硬上限 maxSize=8 剪掉 16 行 / 11 行子集（TEST2.xlsx T54SWIC494447/506630）
  let maxSize;
  let degraded = null;
  if (Number.isFinite(options.maxSize)) {
    maxSize = options.maxSize;
  } else {
    const poolSize = candidates.length;
    if (poolSize <= 12) {
      maxSize = poolSize;
    } else if (poolSize <= 20) {
      maxSize = 12;
    } else if (poolSize <= 25) {
      maxSize = 10;
      degraded = 'reduced';
    } else {
      maxSize = 8;
      degraded = 'safety-floor';
    }
  }
  if (degraded && !options.silent) {
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    //   ⚠️ 必须 logger.appendModuleLog 而非解构 — 让 unit test 通过替换 logger.appendModuleLog 即可 spy
    logger.appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'c4-recon-id-fix',
      message: '[c4-recon-id-fix] findBestAmountSubset 性能护栏',
      details: [
        `candidates=${candidates.length}`,
        `maxSize=${maxSize}`,
        `degraded=${degraded}`
      ]
    });
  }
  const hardCeiling = Number.isFinite(options.hardCeiling) ? options.hardCeiling : 5000000;
  const mainMs = parseBillDateMs(normalizeCellValue(mainBillDate));
  // 按 cents 升序排序，保留原数组下标 _origIdx
  const indexed = candidates.map((c, originalIdx) => ({ ...c, _origIdx: originalIdx }));
  indexed.sort((a, b) => a.cents - b.cents);
  // 缓存每行 BillDate ms 与 _rowIdx 数字部分（避免 DFS 内重复解析）
  for (const c of indexed) {
    c._dateMs = parseBillDateMs(normalizeCellValue(c.row && c.row.BillDate));
    c._idxNum = parseRowIdxNum(c.row && c.row._rowIdx);
  }
  // 后缀总和（suffixSum[i] = indexed[i..end].cents 之和），用于剪枝"剩余总和不足"
  const suffixSum = new Array(indexed.length + 1).fill(0);
  for (let i = indexed.length - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + indexed[i].cents;
  }
  const path = [];
  let best = null;  // { rows, spread, distToMain, size, firstIdxNum }
  let visits = 0;
  let aborted = false;

  // path 是叶子节点（sum=target，size>=2）；计算 score 与 best 比较，决定是否更新 best
  function tryUpdateBest() {
    let minD = null, maxD = null, hasInvalidDate = false;
    let firstIdxNum = Number.MAX_SAFE_INTEGER;
    for (const c of path) {
      if (c._dateMs === null) hasInvalidDate = true;
      else {
        if (minD === null || c._dateMs < minD) minD = c._dateMs;
        if (maxD === null || c._dateMs > maxD) maxD = c._dateMs;
      }
      if (c._idxNum < firstIdxNum) firstIdxNum = c._idxNum;
    }
    const spread = (hasInvalidDate || minD === null || maxD === null)
      ? Number.POSITIVE_INFINITY
      : (maxD - minD);
    let distToMain = Number.POSITIVE_INFINITY;
    if (mainMs !== null) {
      // distToMain = min(|主 - 任意子集.BillDate|)，path 全扫保证语义与旧 tieBreakSubsets 一致
      for (const c of path) {
        if (c._dateMs !== null) {
          const d = Math.abs(mainMs - c._dateMs);
          if (d < distToMain) distToMain = d;
        }
      }
    }
    const size = path.length;
    if (best === null) {
      best = { rows: path.slice(), spread, distToMain, size, firstIdxNum };
      return;
    }
    // tieBreak 顺序：spread → distToMain → size → firstIdxNum
    if (spread !== best.spread) {
      if (spread < best.spread) best = { rows: path.slice(), spread, distToMain, size, firstIdxNum };
      return;
    }
    if (distToMain !== best.distToMain) {
      if (distToMain < best.distToMain) best = { rows: path.slice(), spread, distToMain, size, firstIdxNum };
      return;
    }
    if (size !== best.size) {
      if (size < best.size) best = { rows: path.slice(), spread, distToMain, size, firstIdxNum };
      return;
    }
    if (firstIdxNum < best.firstIdxNum) {
      best = { rows: path.slice(), spread, distToMain, size, firstIdxNum };
    }
  }

  // PR #36 round 3 P2 修复（2026-04-30）：移除"absolute optimal 早停"剪枝
  //
  // 修前（round 2 引入）：当 best 满足 `spread=0 + distToMain=0 + size=2` 时直接 break 当前 for 循环
  //   bug：tie-break 实际有 4 阶（spread → distToMain → size → firstIdxNum），早停只覆盖前 3 阶，
  //        firstIdxNum 仍可能改进。例：candidates [opp_10:1, opp_2:50, opp_3:50, opp_11:99] / target=100
  //        升序 cents 排序后 DFS 先找到 {opp_10, opp_11}（size=2 spread=0 dist=0）触发早停，
  //        漏掉 firstIdxNum 更小的全局最优 {opp_2, opp_3}。
  //
  // 修法：完全删除剪枝。其他剪枝（升序前缀剪枝 / 后缀总和 / top-k 后缀 / maxSize=8 / hardCeiling=5M）
  //      已足够防爆炸；n=20 大池子修后耗时仍 < 5ms 量级（见 P2-6/P2-7 性能测试）。
  //      资金红线层面：必须保证全局最优，性能稍降可接受。

  function dfs(startIdx, remaining, depth) {
    if (aborted) return;
    if (++visits > hardCeiling) { aborted = true; return; }
    if (remaining === 0 && depth >= 2) {
      tryUpdateBest();
      return;
    }
    if (depth >= maxSize) return;
    if (startIdx >= indexed.length) return;
    // 剪枝 1：剩余所有元素加起来都不够 remaining → 不可能凑出
    if (suffixSum[startIdx] < remaining) return;
    // 剪枝 2：剩余可选元素中最大的 (maxSize - depth) 个的和 < remaining 也剪
    //   （升序排序后，最大的 k 个 = 排序数组尾部 k 个；它们的和 = suffixSum[max(startIdx, n-k)]）
    const slotsLeft = maxSize - depth;
    if (slotsLeft > 0 && slotsLeft < indexed.length - startIdx) {
      const topKSum = suffixSum[indexed.length - slotsLeft];
      if (topKSum < remaining) return;
    }
    for (let i = startIdx; i < indexed.length; i++) {
      if (aborted) return;
      const c = indexed[i];
      if (c.cents > remaining) break;  // 升序剪枝
      path.push(c);
      dfs(i + 1, remaining - c.cents, depth + 1);
      path.pop();
    }
  }
  dfs(0, targetCents, 0);
  if (best === null) return null;
  // best.rows 按 _origIdx 升序输出 row（保证子集行顺序稳定）
  return best.rows
    .slice()
    .sort((a, b) => a._origIdx - b._origIdx)
    .map((c) => c.row);
}

// Round 4：tieBreak — 多个 subset 都 sum=主 Amount 时决出唯一最优
// 排序顺序：
//   1) 解内日期跨度最小（max(子集 BillDate) - min(子集 BillDate)）
//   2) 离主单 BillDate 最近（min(|主.BillDate - 子集.BillDate|)）
//   3) 子集元素数最少
//   4) 子集元素 _rowIdx 数字部分最小者（兜底；解析后比较，不用字典序，避免 'opp_10' < 'opp_2'）
//
// PR #36 round 1 P2 修复（2026-04-30）：原实现 `s.map(r => r._rowIdx).sort()[0]` 是字符串字典序，
// 当候选 ≥ 10 时 'opp_10' < 'opp_2' 排错；改成解析 `_rowIdx` 数字部分比较，恢复"原数组首个 row index"的文档约定。
//
// PR #36 round 2 P2 修复（2026-04-30）：本函数已不被池子算法直接调用（迁移到 `findBestAmountSubset` DFS 全遍历）。
// 仍保留供直接单测 + 向后兼容（极少数 1 解 / 解数 ≤ maxSolutions 的场景与新实现等价）。
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
    // firstIdxNum：解析子集每行 _rowIdx 数字部分取最小值（数字比较，不再字典序）
    // 同 subset 内同侧（main 或 opp 一致），_rowIdx 形如 'main_3' / 'opp_5' / 'opp_10'
    const firstIdxNum = Math.min(...s.map((r) => parseRowIdxNum(r._rowIdx)));
    return { subset: s, spread, distToMain, size, firstIdxNum };
  });
  scored.sort((a, b) => {
    if (a.spread !== b.spread) return a.spread - b.spread;
    if (a.distToMain !== b.distToMain) return a.distToMain - b.distToMain;
    if (a.size !== b.size) return a.size - b.size;
    return a.firstIdxNum - b.firstIdxNum;
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

// 从 srcRow 抽列，覆盖 overrides
// v2.1.0-beta.3 T8：列模板按 subMode 切换
//   - business（默认）：ORDER_REPAIR_FIELDS（15 列含 SubBizType）
//   - gateway          ：ORDER_REPAIR_FIELDS_GATEWAY（14 列不含 SubBizType）
function buildOutputRow(srcRow, overrides, subMode) {
  const fields = subMode === 'gateway' ? ORDER_REPAIR_FIELDS_GATEWAY : ORDER_REPAIR_FIELDS;
  const out = {};
  for (const col of fields) {
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

// v2.1.0-beta.3 T8：gateway 子模式 Reference 取值（spec §2.5.3）
// 取自 dialog "订单修复ID取值" 选项 + commonId.source + commonId.suffix（cfg.output 复用 schema）：
//   output.mode === 'main' → mainRow.reconciliationId（网关账单 ReconID，不拼 suffix）
//   output.mode === 'opp'  → oppRow.reconciliationId（渠道账单 ReconID，不拼 suffix）
//   output.mode === 'both' → 自取值，commonId.source 决定 + 拼 suffix（功能同 business 的 computeCommonId）
//     - source === 'main' → mainRow.reconciliationId + suffix
//     - source === 'opp'  → oppRow.reconciliationId + suffix
//     - source === ''     → 仅 suffix（用户主动选空白行；dialog 校验保证 suffix 非空）
// 注意：gateway 子模式 fixture 字段名是 reconciliationId（小写 c）；business 子模式是 reconId
// v2.1.0-beta.3 self-review P0-1/P0-2 修复：mode='both' 时拼接 suffix；source='' 时 base 为空（仅 suffix）
function computeReferenceGateway(mainRow, oppRow, cfg) {
  const out = cfg.output || {};
  const tgt = out.mode || 'main';
  const safeStr = (v) => (v === null || v === undefined) ? '' : String(v);
  if (tgt === 'main') {
    return safeStr(mainRow && mainRow.reconciliationId);
  }
  if (tgt === 'opp') {
    return safeStr(oppRow && oppRow.reconciliationId);
  }
  // tgt === 'both'（自取值）— 取 commonId.source 对应行的 reconciliationId + suffix
  const ci = out.commonId || {};
  let baseReconId = '';
  if (ci.source === 'main') {
    baseReconId = safeStr(mainRow && mainRow.reconciliationId);
  } else if (ci.source === 'opp') {
    baseReconId = safeStr(oppRow && oppRow.reconciliationId);
  }
  // ci.source === '' 或其他无效值 → baseReconId 保持 ''（仅用 suffix，dialog 校验保证 suffix 非空）
  const suffix = (ci.suffix === null || ci.suffix === undefined) ? '' : String(ci.suffix);
  return baseReconId + suffix;
}

// v3.0.2 需求3：网关子模式「修复订单字段取值」— 按 _types 分组过滤把"从边渠道字段值"赋给"主边网关字段"
//
// 🔴 资金红线（spec §六.2 / TechDoc R-2/R-3/D3）：
//   1. 只产出新建 overrides 对象，**绝不写 mainRow / oppRow**（classifyRows 浅克隆仍引用原值字段，
//      若直接写行对象会污染分类后的行 → 单测断言调用后行对象字段未变）。
//   2. mainTypeSeq / oppTypeSeq 全程 Number 归一（_types 是 Set<Number>，存字符串 / 误判类型会
//      导致 Set.has 恒 false → 规则静默失效，最隐蔽的资金 bug）。此处用 Number() 双保险，
//      与 UI 存盘归一 + 校验拦截构成三道防线。
//   3. 命中规则取值为 null/undefined → 赋 ''（空值不阻断，与 buildOutputRow 空值处理一致）。
//
// 返回 overrides（{} 或 { [mainField]: value, ... }）；调用方负责 Object.assign 合并到现有 overrides。
// idEnabled 与本 helper 正交：idEnabled 决定是否把 Reference 放进 overrides，本 helper 只处理 fieldValue 列。
function applyFieldValueOverrides(mainRow, oppRow, cfg) {
  const overrides = {};
  const fv = cfg && cfg.fieldValue;
  if (!fv || fv.enabled !== true || !Array.isArray(fv.rules)) return overrides;
  if (!mainRow || !oppRow || !mainRow._types || !oppRow._types) return overrides;
  for (const rule of fv.rules) {
    if (!rule) continue;
    // mainField / oppField 任一空 → 跳过（不抛错，容忍用户半填规则）
    if (!rule.mainField || !rule.oppField) continue;
    const mainSeq = Number(rule.mainTypeSeq); // 🔴 Number 归一，防 Set<Number>.has 恒 false
    const oppSeq = Number(rule.oppTypeSeq);
    if (!mainRow._types.has(mainSeq)) continue; // 主行不属于规则指定的主分组 → 跳过
    if (!oppRow._types.has(oppSeq)) continue;   // 从行不属于规则指定的从分组 → 跳过
    const v = oppRow[rule.oppField];
    overrides[rule.mainField] = (v === null || v === undefined) ? '' : v; // 空值→''，不阻断
  }
  return overrides;
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
//   排序顺序：BillDate 距离最近 → _rowIdx 数字部分最小（原数组首个 row index）
//
// PR #36 round 1 P2 修复（2026-04-30）：原实现用 `_rowIdx` 字符串字典序，
// 当候选 ≥ 10 时 'opp_10' < 'opp_2' 排错；改成解析数字部分比较，恢复"原数组首个 row index"语义。
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
    return { row: r, dist, idxNum: parseRowIdxNum(r._rowIdx) };
  });
  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.idxNum - b.idxNum;
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
    // v2.1.1 T2-2：days 参数化（cfg._billDateDays，由 runC4Scenario 入口注入；默认 1 与历史 ±1day 一致）
    const candidates = rightRows.filter((r) =>
      !pairedRight.has(r._rowIdx)
        && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode, cfg._billDateDays)
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
          && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode, cfg._billDateDays)
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
          && billDateMatches(l.BillDate, bestRight.BillDate, billDateMode, cfg._billDateDays)
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
  // v2.1.0-beta.3 T8/T10：取 amountPair 的实际字段名（business=Amount/Amount，gateway=Amount/receiveAmount）
  const leftAmountField = amountPair.leftField || 'Amount';
  const rightAmountField = amountPair.rightField || 'Amount';
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && fp !== amountPair && !(fp.locked === true)
  );
  for (const leftRow of leftRows) {
    if (pairedLeft.has(leftRow._rowIdx)) continue;
    lastStepByLeft.set(leftRow._rowIdx, stepLabel);
    // 候选过滤：BillDate + 其他对账字段 AND 全等（Amount 不参与 AND 过滤）
    // v2.1.1 T2-2：days 参数化
    // v2.1.8 F5 T11 spec.md F5-D3：加 currency 等值过滤（与 tryManyToOnePool 对称；仅 gateway 子模式生效）
    const candidates = rightRows.filter((r) =>
      !pairedRight.has(r._rowIdx)
        && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode, cfg._billDateDays)
        && rowsMatchOtherFieldPairs(leftRow, r, otherFieldPairs)
        && currencyMatches(leftRow, r, cfg)
    );
    if (candidates.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    // subset-sum 找子集 — 用 amountPair 字段名（非硬编码 'Amount'）
    const targetCents = toCents(leftRow[leftAmountField]);
    if (targetCents === null) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((r) => ({ row: r, cents: toCents(r[rightAmountField]) }))
      .filter((c) => c.cents !== null);
    // PR #36 round 2 P2 修复：DFS 全遍历维护全局 best（取代旧 enumerate→tieBreak 二段式）
    // v2.1.8 F5 T12 调试入口：cfg._maxSizeOverride 显式传 maxSize 覆盖 spec F5-D1 默认动态档位
    //   仅用于 T12 fixture smoke 调试 / spec 二次 Reverse Sync 评估
    const fbOptions = (cfg && Number.isFinite(cfg._maxSizeOverride))
      ? { maxSize: cfg._maxSizeOverride, silent: true } : undefined;
    const chosen = findBestAmountSubset(candidatesWithCents, targetCents, leftRow.BillDate, fbOptions);
    if (!chosen || chosen.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    pairedLeft.add(leftRow._rowIdx);
    chosen.forEach((r) => pairedRight.add(r._rowIdx));
    apply1vNAssignment(leftRow, chosen, scenario, cfg, reconResult, fixedRows, warningCollector);
  }
}

// v2.1.8 F5 T11（spec.md F5-D3）：currency 字段等值过滤
//
//   仅 gateway 子模式生效（cfg._subMode === 'gateway'）；其他子模式直通 true（影响面收敛）
//   字段名硬编码大小写差异（来自 gateway-bill-recon-fields.js）：
//     网关账单 GATEWAY_BILL_FIELDS:16 → 'Currency'（首字母大写）
//     渠道账单 CHANNEL_BILL_FIELDS:24 → 'currency'（小写）
//   任一为空 → 不过滤（数据质量兼容，避免空值场景比 v2.1.7 退步）
//   独立 export 供 unit case 测试
function currencyMatches(leftRow, rightRow, cfg) {
  if (!cfg || cfg._subMode !== 'gateway') return true;
  const left = normalizeCellValue(leftRow && leftRow.Currency);
  const right = normalizeCellValue(rightRow && rightRow.currency);
  if (left === '' || right === '') return true;
  return left === right;
}

// v2.1.8 F5 T10（spec.md F5-D2）：tryManyToOnePool 遍历顺序复合排序
//
//   v2.1.7 根因 #3：按 rightRows 原数组顺序遍历 → 大金额 right 排后面，
//                  对应大 left 子池被前面小渠道抢光（TEST2.xlsx T54SWIC470181 4M 被 1M 抢光）
//   修复：金额降序主键 → 大金额优先消费 left 池
//         同金额：candidates pool size 降序（spec F5-D2 "子集大小降序"代理 — right 行无法预知子集大小，
//                 用 candidates count 近似；子集必为 candidates 的子集，pool 大的更可能找到大子集）
//   性能优化：预 build rightCandidatesCount Map，避免 sort comparator 内 O(n) filter
//   注：count 是 sort 起始时的 snapshot（pairedLeft 在遍历中变化但排序已锁；可接受）
//   独立 export 供 unit case 测试
//   v2.1.8 F5 T11 集成：candidates count 计算同步纳入 currency 过滤（与 tryManyToOnePool 实际 candidates 一致）
function sortRightRowsForManyToOne({
  rightRows, leftRows, rightAmountField, otherFieldPairs,
  billDateMode, billDateDays, pairedLeft, pairedRight, cfg
}) {
  const rightCandidatesCount = new Map();
  for (const r of rightRows) {
    if (pairedRight.has(r._rowIdx)) {
      rightCandidatesCount.set(r._rowIdx, -1);
      continue;
    }
    let count = 0;
    for (const l of leftRows) {
      if (pairedLeft.has(l._rowIdx)) continue;
      if (!billDateMatches(l.BillDate, r.BillDate, billDateMode, billDateDays)) continue;
      if (!rowsMatchOtherFieldPairs(l, r, otherFieldPairs)) continue;
      if (!currencyMatches(l, r, cfg)) continue;
      count++;
    }
    rightCandidatesCount.set(r._rowIdx, count);
  }
  return rightRows.slice().sort((a, b) => {
    const aPaired = pairedRight.has(a._rowIdx) ? 1 : 0;
    const bPaired = pairedRight.has(b._rowIdx) ? 1 : 0;
    if (aPaired !== bPaired) return aPaired - bPaired; // 未配对优先
    const aCents = toCents(a[rightAmountField]) || 0;
    const bCents = toCents(b[rightAmountField]) || 0;
    if (aCents !== bCents) return bCents - aCents; // 金额降序（主键）
    const aPool = rightCandidatesCount.get(a._rowIdx) || 0;
    const bPool = rightCandidatesCount.get(b._rowIdx) || 0;
    return bPool - aPool; // candidates count 降序（子集大小代理）
  });
}

// Round 4：池子 多v1 — subset-sum(候选主.Amount) === 从.Amount
// 候选过滤：BillDate（按 mode）+ 除 Amount 外其他 fieldPairs AND 全等
function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  const amountPair = findAmountLockedPair(fieldPairs);
  if (!amountPair) return;
  // v2.1.0-beta.3 T8/T10：取 amountPair 的实际字段名（同 tryOneToManyPool）
  const leftAmountField = amountPair.leftField || 'Amount';
  const rightAmountField = amountPair.rightField || 'Amount';
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && fp !== amountPair && !(fp.locked === true)
  );

  // v2.1.8 F5 T10（spec.md F5-D2）：遍历顺序复合排序（金额降序 + candidates pool size 降序）
  // v2.1.8 F5 T11（spec.md F5-D3）：cfg 传入让 sort 的 candidates count 与下面 filter 一致（同步纳入 currency 过滤）
  const sortedRightRows = sortRightRowsForManyToOne({
    rightRows, leftRows, rightAmountField,
    otherFieldPairs, billDateMode, billDateDays: cfg._billDateDays,
    pairedLeft, pairedRight, cfg
  });

  for (const rightRow of sortedRightRows) {
    if (pairedRight.has(rightRow._rowIdx)) continue;
    lastStepByRight.set(rightRow._rowIdx, stepLabel);
    const candidates = leftRows.filter((l) =>
      !pairedLeft.has(l._rowIdx)
        && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode, cfg._billDateDays)
        && rowsMatchOtherFieldPairs(l, rightRow, otherFieldPairs)
        && currencyMatches(l, rightRow, cfg) // v2.1.8 F5 T11 spec.md F5-D3
    );
    if (candidates.length < 2) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const targetCents = toCents(rightRow[rightAmountField]);
    if (targetCents === null) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((l) => ({ row: l, cents: toCents(l[leftAmountField]) }))
      .filter((c) => c.cents !== null);
    // PR #36 round 2 P2 修复：DFS 全遍历维护全局 best（取代旧 enumerate→tieBreak 二段式）
    // v2.1.8 F5 T12 调试入口：cfg._maxSizeOverride 显式传 maxSize 覆盖 spec F5-D1 默认动态档位
    const fbOptions = (cfg && Number.isFinite(cfg._maxSizeOverride))
      ? { maxSize: cfg._maxSizeOverride, silent: true } : undefined;
    const chosen = findBestAmountSubset(candidatesWithCents, targetCents, rightRow.BillDate, fbOptions);
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
  // v2.1.0-beta.3 T8：gateway 子模式 1v1 写值 — 始终基于 mainRow（网关账单），输出 1 行 Type=0；
  //   Reference 按"订单修复ID取值"决定（main=网关 / opp=渠道 / both=自取值）；
  //   不消费 reconResult / SubBizType（gateway 输出列已无 SubBizType）
  if (cfg._subMode === 'gateway') {
    // v3.0.2 需求3：先 Type/Reference，再叠加 fieldValue overrides（1v1：oppRow=rightRow）
    const overrides = { Type: 0, _sourceSide: 'main' };
    // idEnabled !== false（兼容老配置无字段=启用）→ 写 Reference；
    // idEnabled === false → 不写 Reference，buildOutputRow 自动取 srcRow(网关账单) 原 Reference 值（不清空，资金 R-4）
    if ((cfg.output || {}).idEnabled !== false) {
      overrides.Reference = computeReferenceGateway(leftRow, rightRow, cfg);
    }
    Object.assign(overrides, applyFieldValueOverrides(leftRow, rightRow, cfg));
    fixedRows.push(buildOutputRow(leftRow, overrides, 'gateway'));
    return;
  }
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
  // v2.1.0-beta.3 T8：gateway 子模式 1v多 写值 — 1 笔网关 → n 笔渠道；输入 leftRow 丢弃 + 输出 n 笔
  //   每笔基于 leftRow 数据（网关字段）+ 覆盖 Type=1 / Amount=对应渠道.receiveAmount / Reference 按选项
  //   一一对应：matches[i] ↔ 第 i 笔输出（顺序按 subset-sum 算法返回 fixture 行序）
  //   全局约束（每笔渠道全局只用一次）由引擎骨架的 pairedRight 保证，此函数仅消费已配对集合
  if (cfg._subMode === 'gateway') {
    for (let i = 0; i < matches.length; i++) {
      const channelRow = matches[i];
      // v3.0.2 需求3：每笔逐笔取对应 channelRow 的字段值（oppRow=matches[i]，逐笔不同）
      //   顺序：先 Type/Amount/Reference，再叠加 fieldValue overrides
      //   ⚠️ R-5：若用户把 fieldValue 目标列配成 Amount，会覆盖上面拆出的 channelRow.receiveAmount
      //          （用户显式配置语义，tooltip 标注；Object.assign 在设 Amount 之后保证以 fieldValue 为准）
      const overrides = {
        Type: 1,
        Amount: channelRow.receiveAmount === null || channelRow.receiveAmount === undefined
          ? '' : channelRow.receiveAmount,
        _sourceSide: 'main'
      };
      if ((cfg.output || {}).idEnabled !== false) {
        overrides.Reference = computeReferenceGateway(leftRow, channelRow, cfg);
      }
      // v3.0.2 需求3（用户修订）：「修复订单字段取值」限定 1v1，1v多 不做字段取值（入口已强制 enabled=false）
      fixedRows.push(buildOutputRow(leftRow, overrides, 'gateway'));
    }
    // 注：原 leftRow 不入 fixedRows（拆出的 n 笔已覆盖该网关账单的修复语义，原行丢弃）
    return;
  }
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
  // v2.1.0-beta.3 T8：gateway 子模式 多v1 写值 — n 笔网关 → 1 笔渠道；输出 n 笔
  //   每笔基于对应 matches[i]（网关 mainRow）数据 + 覆盖 Type=2 / Reference 按选项 / Amount 保持原值
  if (cfg._subMode === 'gateway') {
    for (const mainRow of matches) {
      // v3.0.2 需求3：逐笔 mainRow（matches[i]）+ 共同 rightRow 取值；先 Type/Reference，再叠加 fieldValue
      const overrides = { Type: 2, _sourceSide: 'main' };
      if ((cfg.output || {}).idEnabled !== false) {
        overrides.Reference = computeReferenceGateway(mainRow, rightRow, cfg);
      }
      // v3.0.2 需求3（用户修订）：「修复订单字段取值」限定 1v1，多v1 不做字段取值（入口已强制 enabled=false）
      fixedRows.push(buildOutputRow(mainRow, overrides, 'gateway'));
    }
    return;
  }
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

function runC4Scenario(scenario, sheets, subMode) {
  if (!scenario) {
    throw new Error('runC4Scenario: scenario 不能为空');
  }
  // v2.1.0-beta.3 T8：subMode 来源优先级
  //   1. 函数参数 subMode（recon-id-fix-engine 顶层入口按 scenario.category 推导后传入）
  //   2. fallback 推导：scenario.category === 'gateway-recon-id-fix' → 'gateway'，否则 'business'
  //   subMode 通过 cfg._subMode 沿调用链传递到 apply* / buildOutputRow，不改函数签名
  const effectiveSubMode = subMode === 'gateway' ? 'gateway'
    : subMode === 'business' ? 'business'
    : (scenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business');
  // v2.1.1 T2-2：BillDate ±N 容错配置解析
  //   不勾选 → _billDateDays = 1（与历史 ±1day 行为一致，零回归）
  //   勾选 + days=N → _billDateDays = N（Step 2/3.2/3'.2 容错窗口替换为 ±N 天）
  //   注入 cfg._billDateDays（不写盘 scenario.config，仅本次运行用）
  // PR #41 review Finding 1（P2 资金红线）：UI 层 validateScenarioDraft 已 1-999 整数校验，
  //   但 DB 旧配置 / 导入配置 / 异常配置可能带非法值（10000 / Infinity / 小数 / NaN）→
  //   引擎入口必须再做一道防御性校验，异常值 fallback 1（与不勾选等价）+ warning，
  //   避免资金类匹配窗口被异常配置静默扩大。
  const billDateRange = (scenario.config && scenario.config.billDateRange) || null;
  let billDateAbnormalRaw = null; // 非 null 表示原始 days 异常，待 warningCollector 创建后 push
  const billDateDays = (() => {
    if (!billDateRange || !billDateRange.enabled) return 1;
    const n = Number(billDateRange.days);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      billDateAbnormalRaw = billDateRange.days;
      return 1;
    }
    return n;
  })();
  // 浅克隆 scenario.config 加 _subMode / _billDateDays 字段，避免污染原 scenario 对象
  const cfg = Object.assign({}, scenario.config || {}, {
    _subMode: effectiveSubMode,
    _billDateDays: billDateDays
  });
  const matchRules = cfg.matchRules || {};
  // v3.0.2 需求3（用户修订）：「修复订单字段取值」限定「网关1v1渠道」模式 —— 勾选 1v多/多v1 时禁用字段取值。
  //   防御：旧配置/导入配置即使 fieldValue.enabled=true，只要含池子模式（oneToMany/manyToOne）就强制关闭，
  //   与 UI 约束（勾 1v多/多v1 时禁用并清开关）一致；apply1vN/applyNv1 也已不调用 applyFieldValueOverrides。
  if (cfg.fieldValue && cfg.fieldValue.enabled === true && (matchRules.oneToMany || matchRules.manyToOne)) {
    cfg.fieldValue = Object.assign({}, cfg.fieldValue, { enabled: false });
  }
  const reconResult = (sheets && sheets.reconResult) || [];
  const businessBills = (sheets && sheets.businessBills) || [];
  let opponentBills = (sheets && sheets.opponentBills) || [];
  // v2.1.0-beta.3 T8：gateway 子模式字段映射
  //   算法骨架（billDateMatches / pickBestByTieBreak 等）硬编码 row.BillDate。
  //   渠道账单 sheet 字段是 createTime（不是 BillDate），引擎入口做字段映射 createTime → BillDate，
  //   避免改动算法骨架。映射后 oppRow 同时拥有 createTime（原值）和 BillDate（=createTime）。
  // v2.1.8 F5 T08：createTime 在 Excel 里若是"真日期"格式，sheetToObjects raw:true 读出来是 number 序列号；
  //   parseBillDateMs 正则只认 'YYYY-MM-DD' 字符串 → 直接赋 number 会 fail。
  //   方案 C（spec.md F5-D4 v0.3）：在此处把 number → ISO 字符串后再赋给 BillDate。
  //   不动 recon-id-fix-io.js raw 模式（共用函数影响 8 sheet × N 字段，资金红线扩面）。
  if (effectiveSubMode === 'gateway') {
    opponentBills = opponentBills.map((row) => {
      if (row && (row.BillDate === '' || row.BillDate === undefined || row.BillDate === null)) {
        return Object.assign({}, row, { BillDate: normalizeBillDateValue(row.createTime) });
      }
      return row;
    });
  }

  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const fixedRows = [];

  // v2.1.1 T2-2 / PR #41 review Finding 1：BillDate days 异常值 warning
  if (billDateAbnormalRaw !== null) {
    warningCollector.push({
      code: 'INVALID_BILL_DATE_RANGE_DAYS',
      message: `BillDate 日期范围天数配置异常（原值 ${JSON.stringify(billDateAbnormalRaw)}），引擎已回退到 ±1day。请到场景配置中修正为 1-999 整数。`
    });
  }

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
  // 内部工具（暴露给 smoke + unit）
  classifyRows,
  groupReconFields,
  findAmountLockedPair,
  billDateMatches,
  parseBillDateMs,
  parseRowIdxNum,
  rowsMatchFieldPairs,
  rowsMatchOtherFieldPairs,
  toCents,
  enumerateAmountSubsets,
  normalizeBillDateValue, // v2.1.8 F5 T08 暴露给 unit case
  findBestAmountSubset,
  tieBreakSubsets,
  pickBestByTieBreak,
  lookupReconId,
  resolveSubBizType,
  computeCommonId,
  buildOutputRow,
  collectUnmatchedRows,
  tryOneToOne,
  tryOneToManyPool,
  tryManyToOnePool,
  sortRightRowsForManyToOne, // v2.1.8 F5 T10 暴露给 unit case
  currencyMatches, // v2.1.8 F5 T11 暴露给 unit case
  applyFieldValueOverrides // v3.0.2 需求3：暴露给 unit case（修复订单字段取值）
};
