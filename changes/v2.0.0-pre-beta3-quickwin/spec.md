# Spec — v2.0.0-pre-beta3-quickwin

> status: apply
> owner: team-lead
> created: 2026-04-28
> updated: 2026-04-28

## 1. 背景

- 为什么要做：v2.0.0-beta.3 大迭代（新增"银行对账单处理"模块）启动前，先把两个独立的小改动 ship 掉：① 主页面标题字体改黑、② 月度余额账单只导月末日（而非"最近交易日"）
- 用户 / 业务价值：
  - T1 标题改黑：去掉 Clear 风格的 4 色渐变标题，回到中性黑色（用户偏好简洁）
  - T3 月末日：用户实际财务流程要求"导月末余额表"必须用月末当日为账单日期，不能用 seed 的实际记录日（如 2026-02-25）
- 当前问题：
  - T1：标题用 `webkit-background-clip: text` 实现 4 色渐变（Google 风格），用户希望改回黑色
  - T3：`monthly-balance.js:197` 当前 `billDate: chosen.billDate` 直接用 seed 实际日期；这是 v1.5.3 R1 (T1.4) 引入的 **Q2 资金红线决策**，本次需要**反转**

## 2. 代码现状（必须有出处）

### T1 标题颜色

- `index.html:29` — `<h1 class="page-title"><span class="gemini-gradient">网银账单小助手</span></h1>`
- `src/styles-gemini.css:113-132` — Clear 风格（默认）：`.page-title` 字号 48px / weight 500；`.gemini-gradient` 用 4 色渐变 + `webkit-background-clip: text` + `color: transparent`
- `src/styles.css:2634-2639` — General 风格退化：`.gemini-gradient { background: none; color: inherit; }`
- 当前行为：Clear 风格显示 4 色渐变标题；General 风格继承父级 `.page-title` 颜色（项目当前 `.page-title` 没有显式 `color`，浏览器默认黑色）

### T3 月末日

- `src/main-process/monthly-balance.js:1-12` 头注释明确：
  > Q2：每个 (merchantId, currency) 的"最新余额"取 billDate ≤ 月末最后一日里 billDate 最大的一条；
  > 若存在 billDate === 月末最后一日 → 优先用该日；
  > 若全部 seeds 的 billDate > 月末 → 跳过该大账号
- `src/main-process/monthly-balance.js:58-87` `pickLatestSeedForAccount(...)` 返回 `{ chosen, reason }`，reason ∈ `'exact' | 'fallback' | 'no-candidates' | 'invalid-merchant-id'`
- `src/main-process/monthly-balance.js:191-201` —
  ```js
  // Q2 资金红线：billDate 用 seed 实际记录的那一天（可能是 2026-02-28），不是月末
  records.push({
    bankName, location, merchantId, currency,
    billDate: chosen.billDate,  // ← 关键：用 seed 实际日期
    endBalance: chosen.endBalance,
    templateName,
    pickReason: reason
  });
  ```
- 当前行为：导出表的"账单日期"列是 seed 的实际记录日；用户希望统一为目标月的月末最后一日

## 3. 目标

- 必做：
  1. **T1**：主页面标题"网银账单小助手"在 Clear / General 两种风格下都显示**纯黑色**，不再有渐变
  2. **T3**：月度余额账单导出时，"账单日期"列**统一为目标月最后一日**，不再用 seed 实际日期
- 可不做：
  - 不改 `endBalance` 取数逻辑（仍是"≤ 月末的最大 billDate 那条 seed 的余额"）
  - 不改 `pickReason`（'exact' / 'fallback' 用于 stats 报告，对外不变）
  - 不改 `missingAccounts`（仍按"全部 > 月末"判断"未来余额排除"）
- 明确不做：
  - 不 bump 版本号到 beta.3（T2 完成才 bump）
  - 不更新 CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE（按 `workflow_docs_update`：v2.0.0 系列发版前统一收口）
  - 不改 balance-seeds 落盘结构（seeds 仍记真实日期）

## 4. 功能点

### 功能点 T1 — 主页面标题改黑

- 说明：`.gemini-gradient` 在 Clear 风格下取消渐变，纯黑色
- 输入：CSS 文件
- 输出：标题视觉变化（从 4 色渐变 → 纯黑色）
- 边界：
  - 不影响 General 风格（已是 inherit，父级是黑）
  - 不动其他用 `gemini-gradient` 的地方（grep 确认仅 `index.html:29` 主标题用了；如有其他地方需要单独评估）
- 验收标准：
  - 跑 `npm run preview` 后 `docs/previews/main-page.png` 标题为黑色
  - 跑 `APP_PREVIEW_STYLE=general npm run preview`（如有）General 风格也是黑色

### 功能点 T3 — 月度余额"账单日期"统一为月末

- 说明：`assembleMonthlyBalance` 内构造 records 时，`billDate` 字段统一写 `targetLastDay`（即 `YYYY-MM-末日`），不再用 `chosen.billDate`
- 输入：`{ templateScope, year, month, db, storageRoot }`
- 输出：records 数组里每条记录的 `billDate` 字段值 = `buildTargetLastDay(year, month)`
- 边界：
  - `endBalance` 仍取 `chosen.endBalance`（seed 里的余额值）—— **余额值不变，只改日期字段**
  - `chosen` 为 null（no-candidates）时仍跳过该大账号（行为不变）
  - 闰年 2 月：`lastDayOfMonth(2024, 2) === 29`，`lastDayOfMonth(2025, 2) === 28`（已有逻辑）
- 验收标准：
  - 单元/集成测试：构造若干 seed（2026-02-15 / 2026-02-25 两条），调用 `assembleMonthlyBalance({ year: 2026, month: 2 })`
    - 期望 `records[0].billDate === '2026-02-28'`（月末日，不是 02-25）
    - 期望 `records[0].endBalance === <2026-02-25 那条 seed 的余额>`（仍是最近交易日的余额）
  - 跑 smoke 不退化（smoke 当前是否覆盖 monthly-balance 待确认）

## 5. 影响范围

- 前端：`src/styles-gemini.css`（T1）；`src/styles.css` 不动（已退化）
- 后端：`src/main-process/monthly-balance.js`（T3）
- 脚本 / 配置 / 数据：无 schema 变更
- 对外接口影响：
  - T1：纯视觉，无接口
  - T3：导出文件的"账单日期"列值变化（**对外可见**）；输出 records 的 `billDate` 字段语义变化
- 兼容性影响：
  - T3：用户已经导出过的旧月度余额账单文件不受影响（只影响新一次导出）
  - balance-seeds 文件结构不变（seed 仍记真实日期）

## 6. 技术决策

### T1
- 方案：在 `styles-gemini.css` 把 `.gemini-gradient` 内容直接换成 `color: #000`，删掉渐变三件套（`background: linear-gradient ...` / `webkit-background-clip` / `color: transparent`）
- 为什么不用其他方案：
  - 不在 `styles.css` 改：那个文件是 General 风格，已经是 `inherit`，没必要动
  - 不在 `index.html` 加 inline style：失去 CSS cascade 优势，且 General 风格也会受影响
- 可能风险：
  - 如果其他地方（dialog 标题等）也用 `.gemini-gradient` 期望渐变，会被波及。需要 grep 确认仅主标题用了

### T3
- 方案：单点改 `monthly-balance.js:197` `billDate: chosen.billDate` → `billDate: targetLastDay`
- 为什么不用其他方案：
  - 不在 `toBalanceRows` 里改：会让"records 内部数据"和"导出值"语义割裂，调试困难
  - 不在 `pickLatestSeedForAccount` 内改：那个函数职责是"从 seeds 选一条"，改 billDate 不属于它
- 可能风险：
  - **资金红线反转**：v1.5.3 R1 (T1.4) PRD §5.1.3 Q2 决策曾明确"用 seed 实际日期不是月末"，本次反转。需要在 PR body 显式提醒 reviewer

## 7. 数据 / 状态 / 安全影响

### ⚠️ T3 资金红线反转（必须高亮）

- 涉及 CLAUDE.md 第 7 条："资金、计费、订单"红线
- 反转决策：**v1.5.3 R1 (T1.4) PRD §5.1.3 Q2 → v2.0.0 反转**
  - 旧决策：billDate 用 seed 实际记录日（"忠实反映底层数据"）
  - 新决策：billDate 统一为月末日（"对外报表必须落在月末"）
- 数据正确性：
  - 余额值（endBalance）**不变**：仍是 seed 里"≤ 月末的最近交易日"那条的余额值
  - 日期字段（billDate）**变**：从 seed 实际日期 → 目标月末日
  - 用户业务理解："2026 年 2 月月末账单显示 2026-02-28，但其实际余额来自 2026-02-25 的最近交易日"
- 状态流转：无（一次性导出，不持久化）
- 权限 / 安全：无
- 回滚策略：
  - 代码层：revert commit
  - 数据层：用户重新导出即可（balance-seeds 文件结构未变，回滚后 billDate 字段恢复到 seed 实际日期）

### T1 无影响

- 纯 CSS 改动；不影响数据 / 状态 / 安全

## 8. 待澄清问题

- [x] T1 标题字号是否同步调整？→ **不调整**，仅改颜色
- [x] T1 是否影响其他 `.gemini-gradient` 使用点？→ **grep 确认仅主标题用**（如有其他用法另议）
- [x] T3 是否需要给 `pickReason: 'fallback'` 时显式警告"实际日期 ≠ 月末"？→ **不需要**（输出 billDate 已经是月末，用户感知统一）
- [x] T3 是否需要在 stats 里增加 `originalBillDate` 留痕？→ **不需要**（保留 `pickReason` 即可，'fallback' 含义就是"非月末日匹配"）
