# Spec — v2.0.0-beta.3 PR #31：算法引擎（C1/C2/C3 纯函数）

> status: apply（实施中途切分：原"4+5+6 配置弹窗 + 算法"调整为"PR #31 算法引擎 + PR #32 UI/调度/IO"）
> owner: team-lead
> created: 2026-04-28
> updated: 2026-04-28（实施途中切分）
> 上游 PRD：`docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md` §十二（方案 B 微调）

## 1. 背景

- v2.0.0-beta.3 主体迭代第 3 个 PR（4 个中第 3 个）
- **修订后范围**：仅 C1 / C2 / C3 算法引擎纯函数 + 字段常量 + 18 个边界单测
- **不含**（移到 PR #32）：3 类配置弹窗 dialog factory、确认场景详情、接入 PR #30 占位、first-match-wins 调度、文件 IO、标黄输出、E2E、文档三件套
- **切分原因**：单 PR "算法 + 4 dialog factory" 体量到 3000+ 行风险高（一次会话内写 4 个相互关联 dialog 易出错）；算法引擎已有完整单测保障，可独立 ship；UI/调度/IO 是顺序拼装，归 PR #32 与"完整功能闭环"一起出

## 2. 代码现状（必须有出处）

- `src/renderer-dialogs.js`（PR #30）— `createScenariosManagerDialog` + `createScenarioCategorySelectDialog`
  - 占位 1：场景管理表"查看场景 / 修改场景"按钮 → alert "将在阶段 4-6 启用"
  - 占位 2：类别选择"继续"按钮 → alert "将在阶段 4-6 启用"
- `src/backend/database/scenarios-repository.js`（PR #29）— CRUD 已就绪，`getScenario(id)` 返回完整 config
- `src/preload.js`（PR #29）— `desktopApi.scenarios.{get, create, update}` 已就绪
- `docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md`：
  - §7.1 C1 提取 ReconId 配置 + 算法
  - §7.2 C2 冲销账单打标 配置 + 算法
  - §7.3 C3 资金对账 join 配置 + 算法
  - §7.6 3 内置场景 JSON 完整定义（PR #29 已 seed）

## 3. 目标（修订后，仅算法引擎部分）

- 必做：
  1. **C1 算法引擎** — 提取 ReconId（特征码 / 其他字段），含多字段值一致性校验 + 原值非空 warn
  2. **C2 算法引擎** — 冲销账单打标（笛卡尔配对 + 一对多 / 多对一报错）
  3. **C3 算法引擎** — 资金对账 join（4 字段 AND + 多行取首 + 孤儿丢弃 + 发生额绝对值计算）
  4. **算法入口 `runScenario(scenario, bankRows, gwRows?)`** — 按 category 分发
  5. **字段常量** — 银行对账单 44 列 + 网关账单 31 列（PRD D7：列结构固定）
  6. **18 个边界单测**（C1 8 + C2 4 + C3 5 + 入口 1）
- 可不做（移到 PR #32）：
  - C1/C2/C3 配置弹窗 dialog factory（4 个）
  - 确认场景详情弹窗
  - 接入 PR #30 占位（类别选择"继续" / 修改场景 / 查看场景）
  - first-match-wins 调度
  - 文件 IO 与标黄输出
  - E2E + 文档三件套 + 版本 bump
- 明确不做：
  - 不 bump 版本号
  - 不更新 CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE

## 4. 功能点

### F1 — 算法引擎（独立 module，不依赖 UI）

新增目录 `src/main-process/scenario-engines/`：

| 文件 | 职责 |
|---|---|
| `index.js` | 导出 `runScenario(scenario, bankRows, gwRows?)` 统一入口，按 category 分发 |
| `c1-extract-recon-id.js` | C1 算法：构造 regex + 多字段搜 + 值一致性校验 |
| `c2-offset-bill-mark.js` | C2 算法：账单类型分组 + 笛卡尔配对 + AND 比对 |
| `c3-gateway-recon-join.js` | C3 算法：4 字段 AND join + 多行取首 + 孤儿丢弃 |
| `engine-utils.js` | 共享工具：条件判定（等于/包含/空值等）、值规范化、warning 收集器 |

每个 engine 函数签名：
```js
runC1Scenario(scenario, bankRows) → {
  lockedRowIds: Set<rowId>,      // 参与场景命中的行（first-match-wins 锁定 + 仅导修改行依据）；C2 配对成功时双方都锁，即使 leftRow 未改字段
  modifications: [{ rowId, column, oldValue, newValue }],  // 修改记录（标黄依据）
  warnings: [{ scenarioId, scenarioName, rowId, code, message }]  // error-report 依据
}
```

C2 / C3 同型签名。

### F2 — C1 配置弹窗 (`createScenarioConfigDialogC1`)

> ⚠️ **已移到 PR #32**：以下内容是切分前的原计划，PR #31 已收口为算法引擎，F2-F6 全部归 PR #32。保留作为 PR #32 实施参考。

完全按 PRD §7.1：
- 5 行：场景名称 / 优先级 / 条件（多行）/ 根据特征提取 / 根据其他字段提取
- 行 4 / 行 5 互斥（点 row4 checkbox 自动取消 row5，反之亦然）
- 字段下拉枚举 = 银行对账单 44 列（`BANK_STATEMENT_FIELDS` 常量，新建 `src/constants/bank-statement-fields.js`）
- 优先级输入框右侧 tooltip：3=最高 / 0=最低
- 条件标题左侧 tooltip：满足任一条件即可进入提取
- 验证：
  - 场景名称非空
  - 优先级 0-3 整数
  - 条件 ≥ 1 行
  - 行 4 / 行 5 至少勾一个（不可都不勾）
  - 行 4：英文特征 `^[A-Z]+$`、数字位数 ≥ 1、总位数 ≥ 数字位数 + 英文特征长度
- 右下"取消" / "确认" → 确认进入"确认场景详情"弹窗

### F3 — C2 配置弹窗 (`createScenarioConfigDialogC2`)

完全按 PRD §7.2：
- 5 行：场景名称 / 优先级 / 账单类型（多行带序号）/ 对账字段（多行 vs 横向）/ 对账成立的打标值
- 行 3 序号自动从 1 起，"新增"加行序号 +1，删除后序号重排
- 行 4 列：序号 / 账单类型 1 下拉 / 字段 1 下拉 / vs / 账单类型 2 下拉 / 字段 2 下拉
  - 账单类型下拉枚举 = 行 3 当前所有序号
  - 字段下拉枚举 = 银行对账单 44 列
- 行 5 类似行 4 + 输入框（FundType 文案 + 写入值）
- 验证：
  - 场景名称 / 优先级 同 C1
  - 账单类型 ≥ 2 行
  - 对账字段 ≥ 1 行
  - 打标值的"账单类型"必须存在于行 3
  - 打标值的字段非空 + 输入值非空

### F4 — C3 配置弹窗 (`createScenarioConfigDialogC3`)

完全按 PRD §7.3：
- 4 行：场景名称 / 优先级 / 对账字段（多行 vs 横向）/ 对账成立后赋值
- 行 3 列：序号 / 网关账单字段 / vs / 银行对账单字段
  - 网关账单字段下拉 = 「网关账单」31 列（`GATEWAY_RECON_FIELDS` 常量）
  - 银行对账单字段下拉 = 银行对账单 44 列 + `'发生额绝对值'`（特殊计算字段）
- 行 4：网关账单字段下拉 + "赋值给" + 银行对账单字段下拉
- 验证：
  - 场景名称 / 优先级 同 C1
  - 对账字段 ≥ 1 行
  - 赋值字段两端都非空

### F5 — 确认场景详情弹窗 (`createScenarioConfirmDetailDialog`)

按 PRD §F3.5：
- 标题："确认场景详情"
- Body：上一级配置的"文本化预览"
  - C1：列出 conditions / extractByFeature 或 extractByOtherField
  - C2：列出 billTypes / reconFields / markValue
  - C3：列出 reconFields / assign
- 右下："完成"（落库）+ "返回"（回上级配置弹窗，保留输入）

落库逻辑：
- 新建模式：调 `desktopApi.scenarios.create({ category, name, priority, enabled: true, config })`
- 修改模式：调 `desktopApi.scenarios.update(id, { name, priority, config })`
- 成功后回到场景管理弹窗（重新打开 + 刷新列表）

### F6 — 接入 PR #30 占位

| 占位位置 | 替换为 |
|---|---|
| 类别选择"继续" | 进入对应类别配置弹窗（新建模式，无预填） |
| 场景管理"修改场景"（编辑模式下点击） | 调 `desktopApi.scenarios.get(id)` → 进入对应类别配置弹窗（修改模式，预填） |
| 场景管理"查看场景"（默认状态点击） | 同 modify 但 readonly（输入框 disabled，按钮换"返回"） |

## 5. 影响范围

### PR #31（本 PR，已收口）

- 后端：
  - 新目录 `src/main-process/scenario-engines/`（5 个新文件）
  - 新文件 `src/constants/bank-statement-fields.js`（44 列）
  - 新文件 `src/constants/gateway-recon-fields.js`（31 列）
- 测试：`scripts/smoke/scenario-engines.js`（接入 npm run smoke）
- 不动：renderer-dialogs.js、renderer.js、main.js、preload.js、styles*.css

### PR #32（已移出，参考用）

> ⚠️ 以下是切分前的原计划，归 PR #32

- 前端：
  - `src/renderer-dialogs.js` 加 4 个新 dialog factory（C1/C2/C3 配置 + 确认详情）
  - 修改 PR #30 的 `createScenariosManagerDialog` + `createScenarioCategorySelectDialog`：移除占位 alert，接入新 dialog
  - 新增 `state.scenarioDraft`（编辑/新建过程中的临时配置）
  - CSS：新增 dialog 表单布局（styles.css + styles-gemini-extra.css 双份）
- 兼容性：与 PR #29 / #30 完全兼容；scenarios 表 schema 不变
- 资金红线：算法实现期间高亮（第 7 段）

## 6. 技术决策

- **算法引擎独立 module**：不放在 main.js（避免那个 7500 行文件继续膨胀），不放在 dialog（dialog 是 renderer 进程，算法属 main 进程业务逻辑）
- **算法纯函数**：输入 `{scenario, bankRows, gwRows?}`，输出 `{lockedRowIds, modifications, warnings}` —— 易测试 + 易复用（实际签名见 §4 F1）
- **字段枚举常量化**：44 列 + 31 列写在 `src/constants/`，runtime 不从导入文件提取（PRD D7 列结构固定）
- **"修改场景" 与 "查看场景" 复用同一 dialog**：传 `mode: 'view' | 'edit'` 控制 readonly
- **行 4/行 5 互斥**：用 click handler 同步两个 checkbox 状态（不用 disabled，防止勾错）
- **dialog 内的"返回"按钮**：保留所有输入到 `state.scenarioDraft`，重新打开配置弹窗时预填
- **不直接接入 first-match-wins 调度**：算法函数返回的 lockedRowIds / modifications / warnings 暂时无消费方（PR #32 才接入），但接口已稳定

## 7. 数据 / 状态 / 安全影响

### ⚠️ 资金红线（必须高亮）

本 PR **写算法但不接 IO**，不影响生产数据。但算法实现是后续 PR #32 调度引擎的依赖：

- C2 笛卡尔配对算法：`mark r2's FundType = 'outbound Fail'` 直接改资金语义关键字段
- C3 join 算法：`bankRow.ReconciliationId = gwRow.reconciliationId` 直接改对账依赖字段
- 必须：每个内置场景的算法路径都有单元测试覆盖（PRD §13 P0 的 11 条手动测试用例对应）

### 无 schema 变更

- 不动 scenarios 表
- 算法纯函数无副作用（仅返回 modifications，PR #32 才落盘）

### 状态

- `state.scenarioDraft` 在 dialog 取消 / 关闭时清空
- 进程重启不持久化（与 `state.lastFileImportContext` 一致）

### 回滚

- 代码层：revert commit
- 数据层：无（无 schema 变更）

## 8. 待澄清问题

- [x] C1 多字段值一致性的"单字段内匹配多个不同值"判断 → 视为不一致 + 跳过（确认与 Q1 推荐一致）
- [x] C2 行 3"账单类型"语义：**每行 = 一种独立账单类型**（不是同一类型的 OR）。行 4 对账字段中"账单类型下拉"引用这些序号；一行 bankRow 可能同时匹配多种类型（例如 outbound Fail 行同时满足"FundType=outbound Fail"，仅归类型 1）
- [x] C3 银行对账单字段含"发生额绝对值" → 计算字段 `Math.abs(Credit Amount - Debit Amount)`，左右值类型对齐（都按 number 比较）
- [x] 修改内置场景后，name 是否仍可与 builtin 重复？→ 否，UNIQUE name 约束（DB 层兜底）
- [x] 配置弹窗的"返回"按钮：返回上一级保留状态如何实现？→ 用 `state.scenarioDraft` 保留所有 input，重新打开 dialog 时预填

## 9. 实施顺序

### PR #31（本 PR，已完成）

1. 落 spec 三件套 ✅
2. 写常量文件（`bank-statement-fields.js` / `gateway-recon-fields.js`）✅
3. 写算法引擎（5 个文件）+ smoke 用例（`scripts/smoke/scenario-engines.js`，23/23 PASS）✅
4. smoke + check-vars + 提 PR ✅

### PR #32（已移出）

> 以下步骤归 PR #32

5. 写 4 个 dialog factory（C1/C2/C3 配置 + 确认详情）
6. 改 PR #30 的 createScenariosManagerDialog / createScenarioCategorySelectDialog 接入新 dialog
7. CSS（dialog 表单样式，styles.css + styles-gemini-extra.css 双份）
8. preview state 补充（C1/C2/C3 配置 + 确认详情各 1 张）
9. first-match-wins 调度 + 文件 IO + 标黄输出
10. E2E + 文档三件套 + 版本 bump
11. smoke + preview + check-vars + 提 PR
