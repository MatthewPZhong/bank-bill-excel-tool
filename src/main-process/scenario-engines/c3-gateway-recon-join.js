// v2.0.0-beta.3：C3 资金对账不平 join 算法引擎
// PRD §7.3 / §10 决策 D4
// v2.1.7 F2 ⚠️ 资金红线：bank → gw 多笔等额改 1v1（方案 A）
//   - 主循环加 usedGwRowIdx Set 标记已用网关行（first-match-wins 风格）
//   - 同金额组 bank > gw 数量时，多余 bank 行 unmatched（不抛错、不警告）
//   - PRD §七 / spec §三 / §3.2 边界场景
//
// 行为：
//   1. 对 bankRow 遍历 gwRows，按 reconFields AND 比对（gw 已用行自动排除）
//   2. 多行满足 → 取第一条未用 + warn（数据脏）
//   3. 没匹配 / gw 池子被抢空 → 该场景对该行不命中（first-match-wins 不锁定）
//   4. 配对成功 → 写 assign.bankField = chosen[assign.gwField]，标记 gwRow 已用
//   5. 写入前若 bankRow[assign.bankField] 原值非空 → warn（仍执行覆盖）

const {
  ensureRowId,
  evaluateCondition,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');

const { BANK_STATEMENT_VIRTUAL_AMOUNT_ABS } = require('../../constants/bank-statement-fields');

// C3 银行对账单字段含特殊"发生额绝对值"，从 Credit Amount + Debit Amount 计算
function getBankRowValueForC3(bankRow, fieldName) {
  if (fieldName === BANK_STATEMENT_VIRTUAL_AMOUNT_ABS) {
    const credit = parseNumber(bankRow['Credit Amount']);
    const debit = parseNumber(bankRow['Debit Amount']);
    if (credit === null && debit === null) return null;
    return Math.abs((credit || 0) - (debit || 0));
  }
  return bankRow[fieldName];
}

// v2.1.5 N3：包装 evaluateCondition 以支持银行侧虚拟字段「发生额绝对值」
//   - useC3BankValueGetter: false → 网关侧，直接调 evaluateCondition(row, cd)
//   - useC3BankValueGetter: true  → 银行侧，先用 getBankRowValueForC3(row, cd.field) 取值再代入临时 row 调 evaluateCondition
function evalCondition(row, cd, { useC3BankValueGetter = false } = {}) {
  if (!cd || !cd.field) return true; // 防御：未配置 field 视为通过
  if (!useC3BankValueGetter) {
    return evaluateCondition(row, cd);
  }
  // 银行侧：包装一层把虚拟字段计算结果注入临时 row
  const value = getBankRowValueForC3(row, cd.field);
  // value 可能是 number（虚拟字段）/ 字符串 / undefined；evaluateCondition 内部 normalizeCellValue 会兜底
  const wrappedRow = { [cd.field]: value };
  return evaluateCondition(wrappedRow, cd);
}

// 数值字段启发式（与 C2 保持一致）
function isNumericFieldName(fieldName) {
  const name = String(fieldName || '');
  return /Amount|Fee|金额|数额|发生额/.test(name);
}

function gwMatchesBank(gwRow, bankRow, reconFields, fee = null) {
  // v2.1.12 需求5：extra fee 匹配（🔴资金红线 · spec-alpha-req5-extrafee §2.2/§2.4）
  //   - undefined→null 归一防御：旧调用方不传 fee → 默认 null + Number.isFinite 双保险，绝不误入 fee 分支（防 NaN 大面积回归）
  //   - effectiveFee=null（未勾选/缺字段/非有限数）→ 全字段对走原 valuesEqual，与 v2.1.11 byte-for-byte 一致（零回归）
  //   - effectiveFee 为有限数 → 仅对「银行侧=发生额绝对值」字段对（A1）做 gw值+fee 后比 bank值；其余字段对不变
  const effectiveFee = Number.isFinite(fee) ? fee : null;
  return reconFields.every((rf) => {
    const numeric = isNumericFieldName(rf.gwField) || isNumericFieldName(rf.bankField);
    const bankValue = getBankRowValueForC3(bankRow, rf.bankField);
    if (effectiveFee !== null && rf.bankField === BANK_STATEMENT_VIRTUAL_AMOUNT_ABS) {
      const gwNum = parseNumber(gwRow[rf.gwField]);
      if (gwNum === null) return valuesEqual(gwRow[rf.gwField], bankValue, { numeric }); // gw 非数值 → 回退原逻辑
      const bankNum = parseNumber(bankValue);
      if (bankNum === null) return false;
      // Q7：归一到分比较，避免浮点漂移（0.1 + 0.2 !== 0.3）
      return Math.round((gwNum + effectiveFee) * 100) === Math.round(bankNum * 100);
    }
    return valuesEqual(gwRow[rf.gwField], bankValue, { numeric });
  });
}

function runC3Scenario(scenario, bankRows, gwRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  const reconFields = config.reconFields || [];
  const assign = config.assign || {};
  // v2.1.12 需求5：extra fee（🔴资金红线）— 勾选且 amount 为有限数 → fee 参与「发生额绝对值」字段对匹配；
  //   否则 null（gwMatchesBank 走原 valuesEqual，与 v2.1.11 byte-for-byte 一致，零回归）
  const fee = (config.extraFee && config.extraFee.enabled === true) ? parseNumber(config.extraFee.amount) : null;

  if (!Array.isArray(gwRows) || gwRows.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'no-gateway-rows',
      message: '资金对账不平结果（网关账单）数据为空，C3 场景无法运行'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }
  if (reconFields.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '对账字段至少需要 1 行'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }
  if (!assign.gwField || !assign.bankField) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '对账成立后赋值必须指定网关账单字段 + 银行对账单字段'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  // ===== v2.1.5 N3：Step 0 — 按 conditions 拆分两侧 + 行级过滤（AND 关系）=====
  //   - 兜底：cfg.conditions 缺失 / 空数组 → gwConditions/bankConditions 各为空 → 不过滤（向下兼容 v2.1.4）
  //   - 网关侧条件用 evalCondition(row, cd, { useC3BankValueGetter: false })
  //   - 银行侧条件用 evalCondition(row, cd, { useC3BankValueGetter: true })（支持虚拟字段「发生额绝对值」）
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  const gwConditions = conditions.filter((c) => c && c.side === '网关' && c.field);
  const bankConditions = conditions.filter((c) => c && c.side === '银行' && c.field);

  const gwRowsFiltered = gwConditions.length === 0
    ? gwRows
    : gwRows.filter((row) => gwConditions.every((c) => evalCondition(row, c, { useC3BankValueGetter: false })));
  const bankRowsFiltered = bankConditions.length === 0
    ? bankRows
    : bankRows.filter((row) => bankConditions.every((c) => evalCondition(row, c, { useC3BankValueGetter: true })));

  // v2.1.7 F2 ⚠️ 资金红线：网关候选池标记已用（spec §3.1 方案 A）
  //   - usedGwRowIdx：已被前面 bank 行消费的 gw 行索引集合
  //   - 候选 filter 时排除已用 gw 行 → 保证 bank 单向消费 gw 单，不再多 bank 抢同 1 条 gw
  //   - gwRowsFiltered 顺序稳定（来自 reader）→ usedGwRowIdx 索引确定
  //   - bankRowsFiltered 顺序稳定（forEach）→ deterministic 同输入同输出
  const usedGwRowIdx = new Set();

  // v2.1.8 N2：mode='custom' 时 newValue 来自 assign.customValue 静态字符串
  //   - gwField='__CUSTOM__' sentinel，不从 gw 字段取值 → candidates 过滤跳过 gw 非空检查
  //   - 仍走 reconFields 匹配（决定是否锁定 bank 行）+ usedGwRowIdx 单向消费（红线不变）
  const isCustom = assign.mode === 'custom';

  bankRowsFiltered.forEach((bankRow, index) => {
    const rowId = ensureRowId(bankRow, index);
    // v2.1.8 N2：mode='custom' && customValue 空 → 防御性 skip（dialog 校验已拦截，此为 bundle import / 手改 DB 兜底）
    if (isCustom && String(assign.customValue || '').trim() === '') {
      warningCollector.push({
        rowId,
        code: 'invalid-custom-value',
        message: 'assign.mode=custom 但 customValue 为空，跳过此行（请检查 scenario 配置）'
      });
      return;
    }
    // candidates 三层过滤（v2.1.7 round 9 F2 fix，PR #51 reviewer round 3 Finding 1）：
    //   1. 未被前面 bank 行消费（!usedGwRowIdx.has）
    //   2. reconFields AND 匹配
    //   3. **gw 字段非空**（方案 A：不可写的 gw 不进候选，避免"空 gw 反复被选 → 永远轮不到有效 gw"）
    //   v2.1.8 N2：mode='custom' 时跳过第 3 层过滤（newValue 不依赖 gw 字段，gwField='__CUSTOM__' 永远空）
    //   v2.1.8 v2.1.7-minor M-1：拆 2 步 filter，warning 区分"可用 gw 数"+"空 gw 跳过数"，
    //     数据质量监控视角能看到原始匹配数（不被"非空过滤"掩盖）
    const rawMatched = gwRowsFiltered
      .map((g, gIdx) => ({ row: g, gIdx }))
      .filter((x) => !usedGwRowIdx.has(x.gIdx) && gwMatchesBank(x.row, bankRow, reconFields, fee));
    const matched = rawMatched.filter((x) =>
      isCustom || normalizeCellValue(x.row[assign.gwField]) !== ''
    );
    if (matched.length === 0) return;

    if (matched.length > 1) {
      const skippedEmpty = rawMatched.length - matched.length;
      const skippedNote = skippedEmpty > 0 ? `（另有 ${skippedEmpty} 行空 gw 已跳过）` : '';
      warningCollector.push({
        rowId,
        code: 'multi-gateway-match',
        message: `bankRow 在网关账单中匹配到 ${matched.length} 行可用 gw${skippedNote}，取第一条（数据脏）`
      });
    }
    const chosen = matched[0];

    // v2.1.8 N2：mode='custom' → newValue 来自 customValue；mode='direct' / 缺失 → 走原逻辑
    const newValue = isCustom
      ? String(assign.customValue || '')
      : normalizeCellValue(chosen.row[assign.gwField]);

    const oldValue = normalizeCellValue(bankRow[assign.bankField]);
    if (oldValue === newValue) {
      // v2.1.7 round 9 F2 fix（PR #51 reviewer round 3 Finding 1）方案 B：
      //   bank 已经等于 gw 的值（无需 record 修改），但**仍要 lock + 消费 gw**：
      //   - lock 防其它场景误改这条 bank（first-match-wins 红线）
      //   - 消费 gw 让后续 bank 不再选中同一条 gw（严格 1v1 红线）
      modCollector.lock(rowId);
      usedGwRowIdx.add(chosen.gIdx);
      return;
    }

    bankRow[assign.bankField] = newValue;
    modCollector.record(rowId, assign.bankField, oldValue, newValue);
    // gw 标记已用（round 7 fix：在确认能写值 + record 之后；round 9 fix：oldValue==newValue 分支已上方提前 add）
    usedGwRowIdx.add(chosen.gIdx);
  });

  return {
    lockedRowIds: modCollector.listLockedRowIds(),
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

// v2.1.12 需求6：只读 helper — 统计 bankRows 中满足某 C3(gateway-recon-join) 场景「银行侧 conditions」的候选行数。
//   语义与 runC3Scenario 的 bankRowsFiltered（本文件 :116-125）完全一致：同样提取 side==='银行' 且有 field 的 conditions，
//   再用 evalCondition(row, c, { useC3BankValueGetter: true }) AND 过滤（支持虚拟字段「发生额绝对值」）。
//   ⚠️ 仅只读统计，不触碰 runC3Scenario 的资金匹配逻辑（usedGwRowIdx / 1v1 单向消费 / assign 赋值均不涉及）。
//   兜底：bankConditions 为空 → 与引擎一致视为不过滤（所有行皆候选）。供 main 进程「资金对账不平跳过提示」数据侧预检。
function countC3BankCandidates(config, bankRows) {
  if (!Array.isArray(bankRows) || bankRows.length === 0) return 0;
  const cfg = config || {};
  const conditions = Array.isArray(cfg.conditions) ? cfg.conditions : [];
  const bankConditions = conditions.filter((c) => c && c.side === '银行' && c.field);
  if (bankConditions.length === 0) return bankRows.length;
  return bankRows.filter((row) => bankConditions.every((c) => evalCondition(row, c, { useC3BankValueGetter: true }))).length;
}

module.exports = {
  evalCondition, // v2.1.5 N3 新增（暴露给 smoke）
  getBankRowValueForC3,
  gwMatchesBank,
  runC3Scenario,
  countC3BankCandidates // v2.1.12 需求6：数据侧预检只读 helper
};
