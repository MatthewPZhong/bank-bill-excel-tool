// v2.0.0-beta.3：C2 冲销账单打标 算法引擎（v2.1.7 F4 UI 展示名 → 银行对账单字段赋值）
// PRD §7.2 / §10 决策 D3
// v2.1.7 F4：UI 改名「账单打标」→「银行对账单字段赋值」（DB category 'offset-bill-mark' 不变）
//   引擎校验放宽：billTypes < 2 → < 1；reconFields = 0 不再 return，走「衍生方案 A 无条件赋值」
//   PRD §5 / spec §5.7 / §9.5
// v2.1.11 T3（spec §四 / PRD §2.3 D-T3-1a=AND）：账单类型从单条件 → 多条件 AND
//   billTypes 行结构 `{seq, field, op, value}` → `{seq, conditions:[{field,op,value},…]}`
//   一种账单类型 = 多条件全满足（AND）才命中；空 conditions → 不命中任何行
//   引擎入口 + classify 均做归一化兜底（防御老内存对象 / 跳过 repository 读取的调用方）
//
// 行为：
//   1. 行 3 billTypes：每行 = 一种独立账单类型（带序号 seq + conditions 数组）
//      给每行 bankRow 计算 row._c2Types = [seq] 集合（一行可属多种类型）
//      命中判定：该类型 conditions.every(c => evaluateCondition(row, c))（AND 全满足）
//   2. 行 4 reconFields：
//      - **v2.1.7 衍生方案 A**：reconFields = 0 时不走配对，凡命中 markValue.type 的行直接写赋值
//      - reconFields ≥ 1 时定义对账字段：{seq, leftType, leftField, rightType, rightField}
//   3. 笛卡尔配对（reconFields ≥ 1 时）：leftType 类型的所有行 × rightType 类型的所有行
//      AND 比对所有 reconFields 是否相等
//   4. 配对成功后：
//      - 一对一：给 rightType 那行的 markValue.field 写 markValue.value
//      - 一对多（一个 leftRow 匹配多个 rightRow）→ 报错 + 终止该 leftRow（其它 leftRow 继续）
//      - 多对一（一个 rightRow 被多个 leftRow 匹配上）→ 报错 + 终止该配对
//   5. 修改记录：仅 rightRow 的 markValue.field 被改算修改

const {
  ensureRowId,
  evaluateCondition,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  valuesEqual
} = require('./engine-utils');

// v2.1.11 T3（spec §4.2 D-T3-mig=a）：把单个 billType 行归一化为多条件结构
//   - 旧结构 `{seq, field, op, value}` → `{seq, conditions:[{field,op,value}]}`
//   - 已是新结构（含 conditions 数组）→ 原样保留（幂等）
//   - 防御：缺失字段补默认（op 缺省 '等于'，其余空串）
//   归一化是「读取/执行侧兜底」，与 scenarios-repository.normalizeC2Config / dialog 三处对齐，
//   保证任意一处遗漏都不会让引擎拿到未归一化的老结构而误分类（资金红线）。
function normalizeBillTypeRow(bt) {
  if (!bt || typeof bt !== 'object') {
    return { seq: undefined, conditions: [] };
  }
  if (Array.isArray(bt.conditions)) {
    // 已是新结构：仅保证每条 condition 字段齐全（防御部分缺字段）
    const conditions = bt.conditions.map((c) => ({
      field: (c && c.field) || '',
      op: (c && c.op) || '等于',
      value: c && c.value !== undefined && c.value !== null ? c.value : ''
    }));
    return { ...bt, conditions };
  }
  // 旧结构：单条件 {field,op,value} → conditions:[{...}]
  const { field, op, value, ...rest } = bt;
  return {
    ...rest,
    conditions: [{
      field: field || '',
      op: op || '等于',
      value: value !== undefined && value !== null ? value : ''
    }]
  };
}

// v2.1.11 T3：把整个 billTypes 数组归一化为多条件结构（引擎入口兜底用）
function normalizeBillTypes(billTypes) {
  if (!Array.isArray(billTypes)) return [];
  return billTypes.map(normalizeBillTypeRow);
}

function classifyRowsByBillTypes(bankRows, billTypes) {
  // v2.1.11 T3：入参兜底归一化（兼容老 `{seq,field,op,value}` 行 / 防御直接调用方未走 repository 归一化）
  const normalizedTypes = normalizeBillTypes(billTypes);
  // 给每行 bankRow 算它属于哪些 type seq
  bankRows.forEach((row, index) => {
    ensureRowId(row, index);
    const types = [];
    normalizedTypes.forEach((typeRow) => {
      const conditions = Array.isArray(typeRow.conditions) ? typeRow.conditions : [];
      // v2.1.11 T3 D-T3-1a=AND：该类型全部 conditions 满足（AND）才命中
      //   空 conditions → every 对空数组返 true，但语义上「未配置任何条件」应视为不命中（spec §4.3）
      //   → 显式拦截：conditions.length === 0 不命中
      if (conditions.length === 0) return;
      if (conditions.every((c) => evaluateCondition(row, c))) {
        types.push(typeRow.seq);
      }
    });
    row._c2Types = types;
  });
}

// 数值字段（基于字段名启发式）：含 Amount / Fee / 数额 / 金额 等关键词，按 number 比较
function isNumericFieldName(fieldName) {
  const name = String(fieldName || '');
  return /Amount|Fee|金额|数额/.test(name);
}

function pairsMatch(leftRow, rightRow, reconFields) {
  return reconFields.every((rf) => {
    const numeric = isNumericFieldName(rf.leftField) || isNumericFieldName(rf.rightField);
    return valuesEqual(leftRow[rf.leftField], rightRow[rf.rightField], { numeric });
  });
}

function runC2Scenario(scenario, bankRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  // v2.1.11 T3（spec §4.2）：引擎入口兜底归一化 billTypes（防御老内存对象 / repository 未归一化的调用方）
  //   classifyRowsByBillTypes 内部也会归一化一次（幂等），这里先归一化保证 billTypes.length / seq 判定一致
  const billTypes = normalizeBillTypes(config.billTypes || []);
  const reconFields = config.reconFields || [];
  const markValue = config.markValue || {};

  // v2.1.7 F4：billTypes 校验从 < 2 改 < 1（dialog 校验放宽同步）
  if (billTypes.length < 1) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '账单类型至少需要 1 行'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }
  // v2.1.7 F4：reconFields = 0 不再 return，走「无条件赋值」分支（衍生方案 A，详 spec §5.7）
  //   原校验保留 markValue.type / .field 必填（reconFields=0 走无条件赋值时仍需要 markValue 完整）
  if (!markValue.type || !markValue.field) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '赋值必须指定账单类型 + 字段'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  classifyRowsByBillTypes(bankRows, billTypes);

  // v2.1.7 F4 衍生方案 A：reconFields = 0 → 无条件赋值
  //   凡命中 markValue.type（billType seq）的行直接写 markValue.field = markValue.value
  //   不走笛卡尔配对，不锁定双方（仅锁定被写值的行）
  //   spec §5.7 改动点 2 / PRD §9.5
  if (reconFields.length === 0) {
    bankRows.forEach((row) => {
      const types = Array.isArray(row._c2Types) ? row._c2Types : [];
      if (!types.includes(Number(markValue.type))) return;
      const oldValue = normalizeCellValue(row[markValue.field]);
      const newValue = String(markValue.value || '');
      if (oldValue === newValue) return; // 值未变，不算修改
      modCollector.lock(row._rowId);
      row[markValue.field] = newValue;
      modCollector.record(row._rowId, markValue.field, oldValue, newValue);
    });
    bankRows.forEach((r) => { delete r._c2Types; });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  // reconFields 中所有的 leftType / rightType 应一致（PRD 自带场景所有 reconFields 都是 1 vs 2）
  // 我们以第一条 reconFields 的 leftType / rightType 为准（PRD 没明确多对类型混合）
  const primaryReconField = reconFields[0];
  const leftType = primaryReconField.leftType;
  const rightType = primaryReconField.rightType;

  const leftRows = bankRows.filter((r) => Array.isArray(r._c2Types) && r._c2Types.includes(leftType));
  const rightRows = bankRows.filter((r) => Array.isArray(r._c2Types) && r._c2Types.includes(rightType));

  // 反向索引：rightRow → 已被哪些 leftRow 匹配（用于多对一检测）
  const rightRowMatchCount = new Map();
  // 实际配对结果：rightRow → leftRow
  const successfulPairs = [];

  for (const leftRow of leftRows) {
    const matched = rightRows.filter((rightRow) => pairsMatch(leftRow, rightRow, reconFields));
    if (matched.length === 0) continue;
    if (matched.length > 1) {
      warningCollector.push({
        rowId: leftRow._rowId,
        code: 'one-to-many',
        message: `账单类型 ${leftType} 行匹配到账单类型 ${rightType} 的多行（共 ${matched.length} 行）`,
        matchedRowIds: matched.map((r) => r._rowId)
      });
      continue; // 终止该 leftRow，但其它 leftRow 继续
    }

    const rightRow = matched[0];
    successfulPairs.push({ leftRow, rightRow });
    rightRowMatchCount.set(rightRow._rowId, (rightRowMatchCount.get(rightRow._rowId) || 0) + 1);
  }

  // 多对一检测（rightRow 被多个 leftRow 匹配）
  const blockedRightRowIds = new Set();
  rightRowMatchCount.forEach((count, rightRowId) => {
    if (count > 1) {
      warningCollector.push({
        rowId: rightRowId,
        code: 'many-to-one',
        message: `账单类型 ${rightType} 行被账单类型 ${leftType} 的多行（${count} 行）匹配`
      });
      blockedRightRowIds.add(rightRowId);
    }
  });

  // 写赋值（跳过被 blocked 的 rightRow）— v2.1.7 F4 注释术语更新
  // PRD §7.2：配对成功后 r1 + matched[0] 都被场景命中（→ first-match-wins 锁定），
  // 不论实际改字段的是哪一侧（Codex PR #31 F2 P1 修复）
  successfulPairs.forEach(({ leftRow, rightRow }) => {
    if (blockedRightRowIds.has(rightRow._rowId)) return;

    // 锁定双方（参与配对即命中，下一场景不可再处理）
    modCollector.lock(leftRow._rowId);
    modCollector.lock(rightRow._rowId);

    if (markValue.type !== rightType) {
      // 用户 markValue 类型不是 rightType（可能是 leftType）—— 那就改 leftRow
      if (markValue.type === leftType) {
        const oldValue = normalizeCellValue(leftRow[markValue.field]);
        const newValue = String(markValue.value || '');
        if (oldValue !== newValue) {
          leftRow[markValue.field] = newValue;
          modCollector.record(leftRow._rowId, markValue.field, oldValue, newValue);
        }
      }
      return;
    }
    const oldValue = normalizeCellValue(rightRow[markValue.field]);
    const newValue = String(markValue.value || '');
    if (oldValue === newValue) return;
    rightRow[markValue.field] = newValue;
    modCollector.record(rightRow._rowId, markValue.field, oldValue, newValue);
  });

  // 清理临时字段
  bankRows.forEach((r) => { delete r._c2Types; });

  return {
    lockedRowIds: modCollector.listLockedRowIds(),
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

module.exports = {
  classifyRowsByBillTypes,
  isNumericFieldName,
  // v2.1.11 T3：归一化 helper（unit test + repository / dialog 复用兜底）
  normalizeBillTypeRow,
  normalizeBillTypes,
  pairsMatch,
  runC2Scenario
};
