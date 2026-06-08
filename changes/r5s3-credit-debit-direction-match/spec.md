# Spec — R5 场景3「中台加款单脏数据处理」按 Credit Amount 方向匹配

> 状态：**已确认（待实施）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：v3.0.0（PR-6）
> 性质：🔴 **资金红线**（剔除清单错位 = 导出错误的财务清单）
> 缘起：用户提问「同 ReconciliationId 一行 Credit 一行 Debit，会匹配哪一行？」→ 查实现状为"无脑取 cand[0]，不看方向" → 决定补方向判据。
> 决策：用户 2026-06-08 已逐条拍板 O-1 ~ O-6（见 §二），spec 定稿可进入实施。

---

## 一、背景与现状（代码出处）

引擎：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` → `runRound5PlatformInboundCleanup()`
调用：`reconciliation-orchestrator.js:228`（R5 场景3，R4 之后运行）

**现状匹配逻辑**（`:84-106`）：

```js
for (const gw of gwPool) {                    // gwPool = TradeType === 'Inbound-VA' 的网关行
  const key = normalizeCellValue(gw.reconciliationid);
  if (key === '') continue;
  const cand = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
  if (cand.length === 0) continue;
  if (cand.length > 1) {
    warningCollector.push({ code: 'multi-bank-match-inbound', ... }); // ← 仅警告，不报错
  }
  const bankRow = cand[0];                     // ← 无脑取第一条（按 bankRows 数组顺序，不看 Credit/Debit）
  usedBankRowId.add(bankRow._rowId);
  if (normalizeCellValue(bankRow.FundType) !== excludeFundType) {   // 默认 != 'Inbound'
    cleanupRows.push(buildCleanupRow(gw, bankRow));
  }
}
```

**现状问题**：候选多行时取哪条完全取决于银行对账单行序（`bankRows` 数组顺序，编排器不重排 —— `orchestrator.js:15`），与金额方向无关，引擎从不读 `Credit Amount`/`Debit Amount`。同 reconid 一 Credit 一 Debit 时，结果不可控。

---

## 二、需求规则

### 已明确（用户 2026-06-08 确认 —— 权威 truth）

| 编号 | 规则 |
|------|------|
| **R-1** | 同 ReconciliationId 候选多行时，**取 `Credit Amount` 有值的那一行**（而非 `cand[0]`）。 |
| **R-2** | 若同 ReconciliationId 有 **≥2 行 `Credit Amount` 都有值** → **报错**（不再"取第一条 + 警告"）。 |

### 已固化决策（用户 2026-06-08 拍板 —— 权威 truth）

| 编号 | 问题 | **定稿** |
|------|------|----------|
| **O-1** | 「`Credit Amount` 有值」的判定口径 | `parseNumber(b['Credit Amount'])` **可解析（!== null）且 ≠ 0**。空、`0`、`0.00`、不可解析字符串 → 一律视为"无值"。复用 `parseNumber`（engine-utils:20）。即判据 = `v !== null && v !== 0`。 |
| **O-2** | 候选里 **0 行** Credit 有值（全是 Debit 行 / Credit 全空） | **跳过该 reconid 不产出剔除行 + 收集警告**（码 `no-credit-match`）；**不阻断导出**。 |
| **O-3** | 「报错」的语义 | **仅收集警告**（severity 取 warning 级，不阻断导出），进 `warnings` / `errorReport` 让用户在报告里看。**不 abort 导出**。 |
| **O-4** | 方向规则适用范围 | **多候选时做方向消歧**（按 R-1/R-2）。单候选维持现状（不强制单行 Debit 也筛/报）—— 方向筛选只在 `cand.length > 1` 路径生效。 |
| **O-5** | 与"多 gw + 多 bank"的交互 | 业务确认**不存在「多 gw + 多 bank」场景** → **不处理多 gw 抢同一批 bank**。现有单测 `:181-199`「2 gw 各配 1 bank」与该确认冲突，**须删除/改写**（见 §四）。 |
| **O-6** | 报错粒度与信息 | **按 reconid 收集警告**（沿用现有 `multi-bank-match-inbound` 的 `warningCollector.push` 模式），新增 `no-credit-match` / `multi-credit-match` 两个码；warning 带 `reconid` + 冲突的 N 行标识（`_rowId` / 金额）。 |

### 最终匹配规则定稿（据 O-1 ~ O-6）

候选选择按以下规则（替换现 `cand[0]` 无脑取）：

1. `cand = bankByReconId.get(key)` 过滤已用行后，`cand.length === 0` → `continue`（同现状）。
2. `cand.length > 1` 时做方向消歧：
   - `creditCand = cand.filter(b => { const v = parseNumber(b['Credit Amount']); return v !== null && v !== 0; })`（O-1）。
   - `creditCand.length === 1` → 取它为 `bankRow`。
   - `creditCand.length === 0` → **跳过 + 收集警告 `no-credit-match`**（O-2/O-3，不阻断）。
   - `creditCand.length >= 2` → **跳过 + 收集警告 `multi-credit-match`**（R-2/O-3，不阻断）。
3. `cand.length === 1`（单候选）→ 维持现状取 `cand[0]`（O-4，不强制 Credit 筛选）。
4. 选中 `bankRow` 后，仍按现逻辑 `FundType !== excludeFundType` 决定是否 `cleanupRows.push(buildCleanupRow(...))`（不变）。

> ⚠️ 与原 R-2「报错」措辞的差异：经 O-3 定稿，R-2/R-1 涉及的"报错"统一降级为**仅收集警告、不阻断导出**。资金红线下导出不被 abort，但异常 reconid 不产出剔除行并在报告中提示。

---

## 三、技术设计（最小改法）

**唯一改动文件**：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`

替换 `:88-104` 的候选选择块（定稿伪代码，据 O-1 ~ O-6）：

```js
const { parseNumber } = require('./engine-utils'); // 顶部补 import

// ... 循环内：
const cand = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
if (cand.length === 0) continue;

let bankRow;
if (cand.length === 1) {
  bankRow = cand[0];                      // O-4：单候选维持现状，不强制 Credit 筛选
} else {
  // 多候选 → 方向消歧（O-1：Credit 有值 = parseNumber !== null && !== 0）
  const creditCand = cand.filter((b) => {
    const v = parseNumber(b['Credit Amount']);
    return v !== null && v !== 0;         // ← O-1 定稿
  });
  if (creditCand.length === 1) {
    bankRow = creditCand[0];              // R-1：唯一 Credit 行
  } else if (creditCand.length === 0) {
    warningCollector.push({              // O-2/O-3：0 行 Credit → 跳过 + 警告，不阻断
      rowId: null,
      code: 'no-credit-match',
      severity: 'warning',
      message: `网关 reconciliationid=${key} 的 ${cand.length} 行候选均无 Credit Amount，跳过剔除（数据异常）`
    });
    continue;
  } else {
    warningCollector.push({              // R-2/O-3：≥2 行 Credit → 跳过 + 警告，不阻断
      rowId: null,
      code: 'multi-credit-match',
      severity: 'warning',
      message: `网关 reconciliationid=${key} 命中 ${creditCand.length} 行 Credit Amount 有值，无法唯一定位，跳过剔除（数据异常）`
    });
    continue;
  }
}

usedBankRowId.add(bankRow._rowId);
if (normalizeCellValue(bankRow.FundType) !== excludeFundType) {
  cleanupRows.push(buildCleanupRow(gw, bankRow));
}
```

**注意**：
- 方向筛选只替换「**选哪条候选行**」；选中后 `FundType !== excludeFundType` 的触发过滤（`:103`）保持不变，作用在选中的行上。
- 换行后 `buildCleanupRow` 的**附言 FundType、C~O 13 列拷贝都来自新选中的 Credit 行** —— 导出内容随之变化（资金红线，须人工复核样本）。
- **O-3 定稿**：所有异常分支只 push `severity:'warning'`，**不阻断导出**（不再溢出到 `orchestrator.js` + 导出链做 abort）。改动收敛回"单文件改"。
- 现 `multi-bank-match-inbound` 警告语义（"取第一条 + 警告"）被新的 `no-credit-match` / `multi-credit-match` 取代，旧码可保留兼容或一并清理（实施时定）。

---

## 四、⚠️ 与现有逻辑的冲突点（必须连带处理）

**现有单测 `tests/unit/.../r5-platform-inbound-cleanup.test.js:181-199`**：

> 「2 条 gw（同 reconid）+ 2 条同 reconid 的 bank → 各配一条，产 2 条剔除行」

此 case 的设计前提是"多 bank 各配一条"。在新规则 R-1/R-2 下：
- 若 2 条 bank 里只有 1 行 Credit 有值 → 只能配 1 条；第二条 gw 无 Credit 候选 → 落 O-2/O-5。
- 若 2 条 bank 都 Credit 有值 → 触发 R-2 报错。

**结论（O-5 已定稿）**：业务确认**不存在「多 gw + 多 bank」场景**，故不处理多 gw 抢同一批 bank。该单测 `:181-199`「2 gw 各配 1 bank」的设计前提与业务确认冲突 → **必须删除或改写**（不再保留"多 bank 各配一条"的期望）。改写方向：要么删该 case，要么改成"多候选 + 单 Credit 行 → 取 Credit 行"的新语义 case。这是实施时的硬动作（非待确认项）。

---

## 五、影响面 / 测试 / 回归

### 资金红线 & 重要变量
- 关联函数：`runRound5PlatformInboundCleanup`、`buildCleanupRow`（资金红线）。
- `rules/important-variables.md` 当前**无** R5 场景3 直接条目（已 grep 核对）；但实施前仍须按 CLAUDE.md 硬节点跑 `/check-vars`（提 PR / 版本 bump / 合并前）。

### 测试点（实施时补）
- 单测删/改：`:181-199` multi-bank case 删除或改写（O-5：不存在多 gw+多 bank）；`multi-bank-match-inbound` 语义迁移到新码。
- 单测增：
  - 2 行同 reconid（1 Credit 1 Debit）→ 取 Credit 行（断言加款单号/附言来自 Credit 行）
  - 2 行 Credit 都有值 → 跳过 + 警告（断言 `code:'multi-credit-match'` + `severity:'warning'`，且**导出未被阻断**）
  - 0 行 Credit 有值（全 Debit / Credit 全空）→ 跳过 + 警告（断言 `code:'no-credit-match'`，导出未阻断）
  - 单候选（cand.length===1）维持现状取它（不因 Debit 被筛掉）
  - `Credit Amount` = `0` / `''` / `'0.00'` / `'1,234.5'` → 按 O-1（`!== null && !== 0`）验证边界
- 集成 / 手测：🔴 资金红线，真实样本，记入 `manual-test-checklist`。

### 回归
- `multi-bank-match-inbound` warning 语义变化（"取第一条" → "多候选按 Credit 筛"）。
- O-3 定稿为**仅警告不阻断**：导出主链路不变，"正常无冲突"样本照常导出（无 abort 风险）。

---

## 六、待办（实施前置）

1. [x] 用户定 O-1 ~ O-6（2026-06-08 已拍板，见 §二已固化决策）
2. [x] 据此定稿本 spec 的伪代码（§三已更新为定稿）
3. [x] 确认目标版本号：v3.0.0（PR-6，见 PRD §5.7 / TechDoc §七C）
4. [ ] 实施 → 删/改单测 `:181-199` + 新增方向消歧 case → `/check-vars` → 手测样本 → PR
