# v2.1.12 α — 需求6 + 收尾批 Spec

> 范围：需求6（资金对账不平跳过提示条件修正）+ 收尾批（SR-log-1 / I6 / I7）
> 立项已由用户拍板，本 spec 不改范围。
> 现状描述均带 `文件:行` 出处。
> 状态：draft v0.1（2026-05-30，team-lead 接手补全 — 原 PM agent socket 中断仅落骨架）

## 0 概述

| 块 | 性质 | 风险 | 现状结论 |
|---|---|---|---|
| 需求6 | 提示触发条件修正 | 🟢 | ⚠️ **字面逻辑现状已实现，需用户澄清真实问题（见 §1.4 / Q-r6-1）** |
| SR-log-1 | 删 `app_activity_log.txt` 旧双写 | 🟢（破坏性·需迁移提示）| 双写点已定位，可实施 |
| I6 | bundle 旧结构 C2 端到端测试 | 🟢 | 测试文件已定位，补 case |
| I7 | important-variables 升格 C2 schema | 🟢 | 现状盲区已确认 |

## 1 需求6：资金对账不平跳过提示条件修正

### 1.1 现状（两处提示，均已 gate）

银行对账单模块有**两个** C3 相关提示弹窗：

| # | 触发时机 | 函数 | gate 判断 | 提示文案位置 |
|---|---|---|---|---|
| dialog#1 | **导入**银行对账单成功后 | `maybePromptGatewayReconImport` `renderer.js:3416` | `renderer.js:3420-3421` `hasC3Enabled = scenarios.some(s.category==='gateway-recon-join' && enabled)`；`if(!hasC3Enabled) return` | `renderer.js:3424` |
| dialog#2 | 点击**开始运行**时 | `shouldPromptGatewayReconAtRun` `renderer.js:3496` → `handleBankStatementRun` `renderer.js:3461` | `renderer.js:3502` `scenarios.some(s.category==='gateway-recon-join' && enabled)` | `renderer.js:3472` |

**两处都已经按 `gateway-recon-join`（提取ReconId-From 网关）是否启用来判断**——未启用该类场景时，dialog#1 直接 `return`、dialog#2 返回 `false`，均不弹提示。来源：v2.0.0-beta.3 PR #32b（dialog#1）+ PR #33 Codex Finding 1（dialog#2 防静默跳过），注释见 `renderer.js:3408,3466`。

### 1.2 术语映射（已确认）

`gateway-recon-join`（category 值）= UI 标签「**提取ReconId-From 网关**」（`renderer-dialogs.js:5536`）= 弹框文案「**资金对账不平**」类场景（`renderer.js:3424/3472`）= **C3**（引擎 `c3-gateway-recon-join.js`，注释 `renderer.js:3408`）。四个名字指同一事物。

### 1.3 「资金对账不平结果表」对应导入

dialog 引导导入的是 `bankStatement.importGatewayRecon()`（`renderer.js:3439`），即 C3 所需的"资金对账不平结果表 / 网关账单"；未导入则 `state.gatewayReconSession` 为空，运行时 C3 被跳过（`skippedC3`，`renderer.js:3517` 注释）。

### 1.4 ✅ 已确认真实需求（Q-r6-1 = b · 2026-05-30 用户拍板）

需求6 字面逻辑（"未启用 `gateway-recon-join` 不弹"）现状 `renderer.js:3420-3421/3502` **已实现**。用户拍板真实需求是**数据维度**：

> **即使启用了 C3（`gateway-recon-join`）类场景，但本次导入的银行对账单数据里没有任何能命中该类场景的行时，也不应弹「将跳过」提示 / 要求导入资金对账不平结果表。**

现状两处 gate 只判断"是否启用 C3 场景"（场景维度），不判断"本次数据是否真有 C3 候选行"（数据维度）。

### 1.5 精确改点（数据侧预检）

在 dialog#1 `maybePromptGatewayReconImport`（`renderer.js:3416`）和 dialog#2 `shouldPromptGatewayReconAtRun`（`renderer.js:3496`）现有"启用判断"之后，**追加"数据侧候选行存在性"判断**——仅当（启用 C3 场景 **AND** 本次导入数据存在 ≥1 条能命中任一启用的 `gateway-recon-join` 场景 `conditions` 的行）时才弹。

实现要点：
- **候选行定义**：满足某启用 C3 场景 `config.conditions` 筛选的银行对账单行（须与 C3 引擎 `c3-gateway-recon-join.js` 的 conditions 匹配语义**完全一致**，否则预检与实际运行不符 → 该弹没弹/不该弹却弹）。
- **改点**：renderer 两个 gate 函数 + 新增 1 个 IPC（main 进程查当前 `bankStatement` session 的 C3 候选行数，避免把全部行传 renderer）。
- ⚠️ 边界：预检"无候选行"≠"不运行 C3"，只是"不提示跳过"；实际运行仍按引擎逻辑跑（无候选行自然 0 命中）。预检仅影响**提示 UX**，不改 C3 匹配结果（不碰资金红线，但须保证不误导用户）。

**工期**：原 ~0.5 天（仅场景 gate）→ **~1.5 天**（含数据侧预检 + 与引擎 conditions 对齐 + 测试）。

## 2 SR-log-1：删 app_activity_log.txt 旧双写

### 2.1 现状（双写两路径）

双写集中在 `src/backend/logger.js:108` `appendActivityRecord(filePath, payload)`：

| 路径 | 代码 | 产物 |
|---|---|---|
| **旧（待删）** | `logger.js:109-132`：`ensureActivityLogFile(118)` → `readFileSync(119)` → 拼 `[date]/[time][level]` → `appendFileSync(132)` | `<storageRoot>/app_activity_log.txt` |
| **新（保留）** | `logger.js:139-148`：`appendStructuredLog(storageRoot, payload, now)`（定义 `186-205`，写 `getLogFilePath` `158-167`）| `<storageRoot>/logs/{YYYY-MM}/{MM-DD}/{level}.log`（JSON Lines）|

相关旧路径附属代码：
- 旧文件路径 `getActivityLogFallbackFilePath` → `main.js:540`（`app_activity_log.txt`）
- `ensureActivityLogFile`（`logger.js:101-105` 建空文件）
- `initializeActivityLog` `main.js:548`（启动时建旧文件 + 写两条启动日志 `main.js:553/559`）
- `appendActivityRecord` 返回值 = **旧 txt 路径**（`logger.js:150` `return logFilePath`），`appendActivityLogEntry`（`main.js:594`）也回传

### 2.2 删旧保新方案

1. `appendActivityRecord`：移除 `109-132` 旧 txt 写入，仅保留 `appendStructuredLog`（含其 try/catch 兜底，且兜底语义由"新路径失败不影响旧"改为"写日志失败 graceful"）。
2. 返回值：`appendActivityRecord` 改返回新 jsonl 路径（`appendStructuredLog` 已 `return filePath`）；**先 grep 全部 caller 是否依赖该返回值**（初判仅日志记录用，风险低，但须确认）。
3. `initializeActivityLog`（`main.js:548`）：不再建/写 `app_activity_log.txt`；启动日志改走 `appendStructuredLog`。
4. 清理 `getActivityLogFallbackFilePath` / `ensureActivityLogFile` 中仅服务旧 txt 的部分（注意 `ensureActivityLogFile` 是否被新路径间接复用 → 不可误删）。
5. ⚠️ `logger.js:215` 资金红线注释（storageRoot 同源）逻辑保留。

### 2.3 一次性迁移提示 + USER_GUIDE

- **破坏性**：老用户/脚本可能直接读 `app_activity_log.txt`。建议：**停止新写入但不删除历史文件**；首次启动检测到旧文件存在 → 一次性提示「操作日志已迁移到 `logs/` 目录（JSON Lines），旧 `app_activity_log.txt` 不再更新」。
- **USER_GUIDE.md**：更新「活动日志」位置说明（旧 txt → `logs/{YYYY-MM}/{MM-DD}/{level}.log`）。
- 文档三件套：CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE 同步（发版时）。

## 3 I6：bundle 导入旧结构 C2 场景 e2e 测试

### 3.1 背景

来源 v2.1.11 PR #55 self-review follow-up：bundle 导入旧结构（v2/v3）含 **C2 场景**（`config.billTypes` / `conditions` / `reconFields`）的端到端覆盖不足。现有 bundle 测试：
- `tests/unit/backend/scenarios-bundle-io.test.js`（`detectBundleType` 等版本检测，`252-269`）
- `tests/unit/main-process/scenarios-bundle-ipc.test.js`（IPC 路径）

### 3.2 补在哪 + 断言

- 文件：`tests/unit/backend/scenarios-bundle-io.test.js`（io 层）+ 视需要 `scenarios-bundle-ipc.test.js`（端到端 IPC）。
- case：构造旧结构 bundle（v2/v3，含 C2 场景 `category` + `config.billTypes≥1` + `conditions` + `reconFields`）→ 导入/升级 → 断言升级后 C2 `config` 字段完整（billTypes/conditions/reconFields/conditionsLogic 不丢、默认值正确）+ 能正常被 `runC2Scenario` 消费。
- 关联 PR #55（C2 字段赋值增强 + 覆盖导入清同月）。

## 4 I7：important-variables.md 升格 C2 billTypes/conditions schema

### 4.1 现状（盲区）

`rules/important-variables.md` 已有 `runC2Scenario`（`791`，Risk-sensitive 资金红线）+ `conditionsLogic`（`194`，Critical 资金红线）条目，但 **C2 的 `config.billTypes` / `config.conditions` 作为独立 config schema 字段未单独登记**——grep 显示 `billTypes` 仅出现在 `runC2Scenario` 描述行内（`798`），无独立条目 → `check:vars` 符号匹配扫不到这两个字段名。

### 4.2 升格条目内容

新增条目（建议归 **Risk-sensitive ⚠️ 资金红线**，与 `runC2Scenario` 同层）：
- `config.billTypes`（C2 场景命中筛选数组，≥1，v2.1.7 F4 放宽）— review 要点：改 schema/校验需同步 dialog（`renderer-dialogs.js` C2 `>=1` 门槛）+ 引擎（`c2-offset-bill-mark.js:57`）+ bundle 升级；命中行集合直接影响赋值，资金红线。
- `config.conditions`（C2 条件数组）+ 配套 `conditionsLogic`（已登记，加交叉引用）。
- 同步：`docs/analysis/var-reference-stats.md` 重跑 `npm run scan:vars`。

## 5 验收标准

| 块 | 验收 |
|---|---|
| 需求6 | 取决于 Q-r6-1：(a) 回归用例固化"未启用不弹/启用弹"；(b) 新增"启用但无候选行不弹"用例 + 手测；smoke 银行对账单相关绿 |
| SR-log-1 | 旧 `app_activity_log.txt` 不再新增写入；新 jsonl 正常；首次迁移提示出现一次；caller 返回值无回归；`npm run release-check` 绿 |
| I6 | 新 e2e case 通过（旧 bundle C2 导入升级 config 完整性断言）；`npm run test:unit` 计数 +N |
| I7 | `npm run scan:vars` 后 billTypes/conditions 可被识别；`/check-vars` 命中 C2 schema |

## 6 开放问题

| ID | 问题 | 推荐 |
|---|---|---|
| **Q-r6-1**（关键）| 需求6 字面逻辑现状已实现（`renderer.js:3420/3502`），你实际遇到的问题是？(a) 已实现可关闭；(b) 数据维度：启用了 C3 但本次导入账单无命中行时也不该弹/提示跳过；(c) 其他未 gate 的入口 | 先确认。倾向 (b)（最常见困扰场景），若 (b) 工期 +~1 天且涉及运行判定需复核 |
| Q-cleanup-1 | SR-log-1 旧 `app_activity_log.txt` 处理 | 推荐：停止新写入 + **保留历史文件不删** + 首次一次性迁移提示（避免删用户既有日志，符合删数据红线）|
| Q-cleanup-2 | I7 升格层级 | 推荐 Risk-sensitive（与 runC2Scenario 同层，资金红线）|

## 7 任务拆分建议（供 team-lead 拆 dev 任务）

| 任务 | 内容 | 依赖 | 工期 |
|---|---|---|---|
| T-r6-1 | 需求6（按 Q-r6-1 结果实施 / 或仅补回归用例）| Q-r6-1 拍板 | 0.5~1.5 天 |
| T-cl-1 | SR-log-1 删旧双写 + 迁移提示 + 文档三件套 | Q-cleanup-1 | 0.5~1 天 |
| T-cl-2 | I6 bundle 旧结构 C2 e2e | — | 0.5 天 |
| T-cl-3 | I7 important-variables 升格 + scan:vars | — | 0.5 天 |
