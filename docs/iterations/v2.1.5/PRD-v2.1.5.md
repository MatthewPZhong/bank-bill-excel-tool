# PRD — v2.1.5 迭代：对账单 ReconID 修复模块名空格化 + 场景下拉空状态优化 + C3「提取ReconId-From 网关」场景新增「条件」栏

| 字段 | 值 |
|---|---|
| 文档版本 | v0.3（2026-05-15 fix1：用户测试反馈追加 fix1.1 C3 条件 row 列宽固定 + fix1.2 场景下拉自动选第 1 个）<br>v0.2（2026-05-15 重写：N3 由 C4/gateway-recon-id-fix 修正为 C3/gateway-recon-join） |
| 目标版本 | `v2.1.5`（patch） |
| 起始版本 | `v2.1.4`（PR #47 已合并 main，2026-05-14，merge commit `f7358ec`） |
| 起草日期 | 2026-05-15 |
| 起草人 | team-lead（PM 角色） |
| 状态 | 起草中，等待用户拍板待澄清问题 |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | 对账单 ReconID 修复（N1 + N2 — UI/IPC/usage-stats）+ 银行对账单处理（N3 — C3 场景配置 dialog + 引擎） |
| 工作分支 | `v2.1.5`（基于 main 切出，PR 向 `v2.1.5 → main`） |
| 依赖 | v2.1.4（含 7 个主模块 + enabled_modules 收纳 + ReconID 主面板默认 gateway） |

---

## 一、需求概述

v2.1.5 包含 3 块独立改动：

1. **N1 — 对账单 ReconID 修复模块名加空格**：`对账单ReconID修复` → `对账单 ReconID 修复`（ReconID 前后各加一个空格）。同步修复 `usage-stats.js` 的 `FUNCTION_REGISTRY` long-standing bug（旧 key `'单据对账ReconID修复'` 与 `trackedIpcHandle` 第 2 参 `'对账单ReconID修复'` 不匹配，导致该模块计数 v2.1.0-beta.1 起从未成功落盘）。
2. **N2 — 对账单 ReconID 修复主面板「场景」下拉空状态优化**：`renderReconIdFixScenarioSelect` 三档展示统一为「无可选项时真空白下拉，有可选项时直接列场景且无『请选择场景』占位」。
3. **N3 — 「提取ReconId-From 网关」(C3 / `gateway-recon-join`) 场景配置 dialog 新增「条件」栏**：`createScenarioConfigDialogC3` 在「优先级」行下、「对账字段」行上插入新「条件」栏，支持「网关 / 银行」侧的选择 + 字段下拉 + 操作下拉 + 值输入；**多条件 AND 关系**（区别于 C1 的 OR）；**柔性校验**（条件可 0 行 = 不过滤）；运行时引擎在比对前对 `gwRows` / `bankRows` 分别按 side 做行级过滤。

> ⚠️ **范围更正声明**：本 PRD v0.1 起草时误把 N3 定位到「对账单 ReconID 修复」模块的 gateway 子模式（C4 / `gateway-recon-id-fix`）。v0.2 起更正为「银行对账单处理」模块的 C3 场景类型（`gateway-recon-join`，label 「提取ReconId-From 网关」）。N1 / N2 仍归属对账单 ReconID 修复模块，定位不变。

---

## 二、背景与目标

### 2.1 业务背景

**N1 背景**：
- 模块名 `对账单ReconID修复` 当前是中文与拉丁字母无空格紧贴书写，UI 阅读体验不佳。用户提出在 ReconID 前后各加一个空格，改为 `对账单 ReconID 修复`。
- 同时 `src/backend/usage-stats.js:31` 的 `FUNCTION_REGISTRY` 注册了 `'单据对账ReconID修复'`（多了"单据"两字），与 `src/main.js:3136 / 3187 / 3238` 三处 `trackedIpcHandle` 第 2 参实际传的 `'对账单ReconID修复'` 不匹配。`usage-stats.js` 对未注册 moduleKey 静默丢弃计数（防御性设计），导致 ReconID 模块从 v2.1.0-beta.1 起统计数据全部丢失（用户无感知）。本次改名顺手把 registry key 也改成新模块名 `'对账单 ReconID 修复'`，一并修了这个 long-standing bug。
- ⚠️ 用户已明确撤回原提案中的「业务OP数据核对」改名（保留为现状不动）。

**N2 背景**：
- v2.1.0-beta.3 T11 起场景下拉的空状态出现 3 档差异：
  - 账单类别为空 → `<option value=""></option>`（v2.1.0-beta.3 修订时已改成真空白）
  - 账单类别有值但 scenarios 数组为空 → `<option value="">请先在场景管理中创建场景</option>`（带提示文案）
  - 有 scenarios → 第一项 `<option value="">请选择场景</option>` + 后续场景列表
- 用户反馈：3 档显示风格不一致；scenarios 为空时的提示文案、有 scenarios 时的"请选择场景"占位项均为冗余。统一为"无可选项时真空白；有可选项时直接列出"，体感更整洁。

**N3 背景**：
- 「银行对账单处理」模块的 C3 场景类型（`gateway-recon-join`，label 「提取ReconId-From 网关」）业务语义是「网关账单 ↔ 银行对账单 join」：对每个 bankRow 在 gwRows 中按 reconFields 全字段 AND 比对找匹配，命中后把 `chosen[assign.gwField]` 写到 `bankRow[assign.bankField]`。
- 当前 dialog 4 行（场景名称 / 优先级 / 对账字段 多行 网关 vs 银行 / 对账成立后赋值 网关 → 银行），**没有「条件」栏**，无法在 join 之前对源数据做行级预过滤。
- 用户反馈：实际数据中网关账单与银行对账单可能含跨币种、跨业务线、跨日期范围的混合记录，希望在 join 之前能配条件预先过滤掉无关行（如 "只 join 美元的"、"只 join BillDate 在某区间的"），减少误匹配 + 提升性能。
- 用户已选 **柔性校验**：「条件」栏可为 0 行（空 = 不过滤），保证旧场景免迁移。
- 字段枚举源完全沿用 C3 既有的两套常量：`GATEWAY_RECON_FIELDS`（31 列）+ `BANK_STATEMENT_FIELDS_FOR_C3`（45 项 = 44 + 虚拟「发生额绝对值」）。**字段语义清晰，无歧义**（区别于 v0.1 误判的 C4 模块）。

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 阅读体验 | 模块名 ReconID 前后加空格，CJK + 拉丁字母混排更舒适 |
| 数据正确性 | usage-stats ReconID 模块计数恢复有效（修复 long-standing bug） |
| UI 一致性 | 场景下拉 3 档空状态统一，无冗余占位文案 |
| 配置能力 | C3 场景支持先按条件筛行再 join，提高匹配精准度 + 减少无效命中 + 性能提升 |

### 2.3 目标（必做 / 不做对照）

| 必做 | 不做 |
|---|---|
| ✅ N1：`MODULE_REGISTRY.reconIdFix.name` 改为 `'对账单 ReconID 修复'` | ❌ 不改 `module.id = 'recon-id-fix'`（数十处 IPC 引用 + DB schema CHECK 约束依赖） |
| ✅ N1：`src/main.js:3136 / 3187 / 3238` 三处 `trackedIpcHandle` 第二参 moduleKey 同步加空格 | ❌ 不改 `scenario.category = 'recon-id-fix' / 'gateway-recon-id-fix'`（数据库字段值，向下兼容） |
| ✅ N1：`src/main.js:3202` error message 字符串同步加空格 | ❌ 不改 IPC channel name `'recon-id-fix:xxx'`（preload 暴露 + DB 历史持久化依赖） |
| ✅ N1：`src/backend/usage-stats.js:31` `FUNCTION_REGISTRY` key 改为 `'对账单 ReconID 修复'`（与新模块名一致 + 修 long-standing 不匹配 bug） | ❌ 不做 `.usage-stats.txt` 历史数据迁移；旧 `[单据对账ReconID修复]` section parse 时保留但 `writeStatsFile` 按 FUNCTION_REGISTRY 顺序输出，自动不出现，无需额外清理 |
| ✅ N1：业务OP数据核对**不改名**（用户已明确撤回） | ❌ 不强制同步 src 中所有"对账单ReconID修复"历史注释（仅修代码字面值；注释属历史痕迹，不强制刷） |
| ✅ N2：账单类别空 → 真空白下拉（沿用现状） | ❌ 不动 `select.disabled` 在空状态时为 true 的行为（沿用） |
| ✅ N2：scenarios 为空 → 真空白下拉（**改**，去掉"请先在场景管理中创建场景"提示） | ❌ 不引入新的 placeholder 文案 |
| ✅ N2：有 scenarios → 直接列场景，第一项 `<option value="">…</option>` 占位项删除 | ❌ 不自动选中第一个 scenario（保持 select 显示空白，用户主动选） |
| ✅ N3：C3 dialog（`createScenarioConfigDialogC3`）在「优先级」行下、「对账字段」行上新增「条件」栏（AND 语义） | ❌ 不动 C1（`extract-recon-id`）的「条件」栏（语义仍为 OR） |
| ✅ N3：条件行结构 `[侧↓ 网关/银行][字段↓][操作↓][值] [×]`，操作沿用 `SCENARIO_CONDITION_OPS`（7 项） | ❌ 不引入新的操作枚举 |
| ✅ N3：左一「网关/银行」切换时左二字段下拉重渲并清空当前值 | ❌ 不引入跨字段的语义校验（如「条件 field 与 reconFields gwField 不能重叠」） |
| ✅ N3：**柔性校验** — 「条件」栏可 0 行（空 = 不过滤）；≥ 1 行时 side / field 必填 + 非空值/非空值 op 的 value 必填；side 与 field 一致性校验（侧选错时报错） | ❌ 不引入"必须 ≥ 1 行"硬约束（与 C1 不同） |
| ✅ N3：DB 兼容：旧 v2.1.4 scenario 读出时 `config.conditions` 缺失 → 引擎兜底 `[]`（不过滤，全通过） | ❌ 不做 DB schema 变更（scenarios.config 是 JSON blob 列） |
| ✅ N3：运行时引擎 `runC3Scenario`（`src/main-process/scenario-engines/c3-gateway-recon-join.js`）在 `bankRows.forEach` 之前新增 Step 0：拆分 conditions 到两侧 + 过滤 `gwRows` / `bankRows` 后传入既有循环 | ❌ 不动 `gwMatchesBank` / assign 字段映射 / `getBankRowValueForC3` 核心写值逻辑（资金红线零修改） |
| ✅ N3：scenario confirm 预览段（`src/renderer-dialogs.js:7424` `gateway-recon-join` 分支）追加 conditions 文案（仅当 conditions ≥ 1 行时渲染） | ❌ 不动其他 category 的 confirm 预览 |

---

## 三、代码现状（必须有出处）

| 需求 | 相关文件 / 行号 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| N1 | `src/renderer.js:63` `MODULE_REGISTRY.reconIdFix.name` | 字面 `'对账单ReconID修复'` | UI 显示无空格 |
| N1 | `src/main.js:3136 / 3187 / 3238` 三处 `trackedIpcHandle(channel, moduleKey, ...)` 的 moduleKey | 字面 `'对账单ReconID修复'`（无空格） | usage-stats 写盘 key 无空格 |
| N1 | `src/main.js:3202` error message | `场景 "${name}" 不是对账单ReconID修复类，无法运行` | 同步加空格 |
| N1 | `src/backend/usage-stats.js:31` `FUNCTION_REGISTRY['单据对账ReconID修复']` | 注册 key 是 `'单据对账ReconID修复'`（多了"单据"） | 与 main.js trackedIpcHandle 第 2 参 `'对账单ReconID修复'` 不匹配 → 该模块所有 increment 静默丢弃（v2.1.0-beta.1 起 long-standing bug） |
| N2 | `src/renderer.js:3570-3608` `renderReconIdFixScenarioSelect` | 3 档 select.innerHTML 不一致：空白 / 提示文案 / 占位+列表 | 用户感知"显示风格不统一"，且占位/提示均冗余 |
| N3 | `src/renderer-dialogs.js:5980-6122` `createScenarioConfigDialogC3` | 4 行 dialog（场景名称 / 优先级 / 对账字段 / 对账成立后赋值），**无「条件」栏** | C3 场景无法在 join 之前做行级预过滤 |
| N3 | `src/renderer-dialogs.js:5719-5724` `createDefaultScenarioConfig('gateway-recon-join')` | 默认 config 仅 `{ reconFields, assign }`，**无 conditions 字段** | 新建 C3 场景默认不含 conditions |
| N3 | `src/renderer-dialogs.js:5841-5846` `validateScenarioDraft` 的 `gateway-recon-join` 分支 | 仅校验 reconFields + assign | 不校验 conditions |
| N3 | `src/renderer-dialogs.js:7424-7427` `buildScenarioConfirmDetailHtml` 的 `gateway-recon-join` 分支 | 仅渲染对账字段 + 赋值 | 不渲染 conditions |
| N3 | `src/main-process/scenario-engines/c3-gateway-recon-join.js:48-114` `runC3Scenario` | 直接对 `bankRows` forEach + `gwRows.filter`，**不读 config.conditions** | C3 模式下不能预过滤无关行 |
| N3 | `src/main-process/scenario-engines/c3-gateway-recon-join.js:24-32` `getBankRowValueForC3` | 已存在虚拟字段 helper（`发生额绝对值` = `\|Credit - Debit\|`） | 引擎接入需复用此 helper 处理银行侧条件值 |
| N3 | `src/main-process/scenario-engines/engine-utils.js:33-52` `evaluateCondition(row, cd)` | 已存在共享条件求值函数（支持 7 op；通过 `row[condition.field]` 取值） | C3 引擎复用：网关侧直接传 `gwRow`；**银行侧需要包装** — 因为 evaluateCondition 取 `row[field]` 不会走虚拟字段计算，对银行侧 `field='发生额绝对值'` 会取到 undefined |
| N3 | `src/constants/gateway-recon-fields.js` `GATEWAY_RECON_FIELDS`（31 列） | 已存在；C3 dialog 行 3/4 网关侧已用 | 「条件」栏左一=网关 时左二字段源 |
| N3 | `src/constants/bank-statement-fields.js` `BANK_STATEMENT_FIELDS_FOR_C3`（45 项 = 44 + 虚拟「发生额绝对值」） | 已存在；C3 dialog 行 3/4 银行侧已用 | 「条件」栏左一=银行 时左二字段源 |
| N3 | `src/renderer-dialogs.js:36` `SCENARIO_CONDITION_OPS = ['等于','不等于','包含','不包含','空值','非空值','开头为']` | 7 个操作 | 直接复用 |
| N3 | `src/renderer-dialogs.js:39` `opNeedsValue(op)` | `'空值' / '非空值'` 返回 false（值输入框 hidden） | 直接复用 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 对账单 ReconID 修复（v2.1.5 起） | 模块名（`module.id = 'recon-id-fix'`，数据库 category = `'recon-id-fix'` / `'gateway-recon-id-fix'`） |
| 提取ReconId-From 网关 / C3 / `gateway-recon-join` | 「银行对账单处理」模块下的场景类型之一；业务：网关账单 ↔ 银行对账单 join |
| C3 dialog | `createScenarioConfigDialogC3`（`src/renderer-dialogs.js:5980-6122`），仅 `category === 'gateway-recon-join'` 使用 |
| C3 引擎 | `runC3Scenario`（`src/main-process/scenario-engines/c3-gateway-recon-join.js`），由 dispatcher 按 `case 'gateway-recon-join'` 调用 |
| 条件（v2.1.5 N3） | C3 dialog 中新增的行级预过滤栏；多条件 AND 语义；柔性校验；运行时引擎在 join 之前对 gwRows / bankRows 分别求值 |
| 虚拟字段「发生额绝对值」 | `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS`，仅银行侧；`= \|Credit Amount - Debit Amount\|`；由 `getBankRowValueForC3` 计算 |
| moduleKey | `usage-stats.js` 中 `FUNCTION_REGISTRY` 的字面 key；与 `trackedIpcHandle(channel, moduleKey, fnKey, ...)` 第 2 参对齐 |

---

## 五、功能详细描述

### 5.1 N1：模块名加空格

#### 5.1.1 说明

- **输入**：当前 `MODULE_REGISTRY.reconIdFix.name = '对账单ReconID修复'`（无空格）
- **输出**：`'对账单 ReconID 修复'`（ReconID 前后各加一个空格）
- **边界条件**：
  - `module.id = 'recon-id-fix'` 不变（数十处 IPC 引用 + DB schema CHECK 约束）
  - `scenario.category` 字符串值 `'recon-id-fix'` / `'gateway-recon-id-fix'` 不变
  - IPC channel name `'recon-id-fix:xxx'` 不变
  - 注释里的 `// 对账单ReconID修复模块` 历史注释不强制同步刷（仅改字面 UI / moduleKey / error message）
  - `.usage-stats.txt` 旧 `[单据对账ReconID修复]` section 在下次 flush 时不再被写入（`writeStatsFile` 按 `FUNCTION_REGISTRY` 顺序输出，新 key 不在历史 section）；事实上 ReconID 模块从未成功计数过，旧 section 字段值全为 0

#### 5.1.2 影响范围

- 前端：`src/renderer.js:63`（UI 显示）
- 后端：`src/main.js:3136 / 3187 / 3238`（trackedIpcHandle moduleKey）+ `src/main.js:3202`（error message）+ `src/backend/usage-stats.js:31`（FUNCTION_REGISTRY key）
- 数据库：无（不动 schema、不动 category 字段值）
- 配置：无
- 对外接口：无（IPC channel 不变）
- 兼容性：旧 `.usage-stats.txt` 中 `[单据对账ReconID修复]` section 在 v2.1.5 启动后不再增量写入；新统计落到 `[对账单 ReconID 修复]` section（首次写盘时由 `defaultStats` seed 0 值）

#### 5.1.3 UI Mockup

主页面左上角模块切换菜单：

```
v2.1.4：    [对账单ReconID修复]
v2.1.5：    [对账单 ReconID 修复]
```

### 5.2 N2：场景下拉空状态优化

#### 5.2.1 说明

- **输入**：用户在主面板「账单类别」选择 `business` / `gateway` / 或为空
- **输出**：`#reconIdFixScenarioSelect` 的 innerHTML 与 disabled 状态
- **3 档行为对照**：

| 档 | 触发条件 | v2.1.4 行为 | v2.1.5 行为 |
|---|---|---|---|
| 档 1 | 账单类别为空 | `<option value=""></option>` + disabled=true | **不变**（沿用真空白） |
| 档 2 | 账单类别非空 + scenarios.length === 0 | `<option value="">请先在场景管理中创建场景</option>` + disabled=true | **改**：`<option value=""></option>` + disabled=true（去掉提示文案） |
| 档 3 | 账单类别非空 + scenarios.length > 0 | `<option value="">请选择场景</option>` + scenarios 列表 + disabled=false + select.value="" | **改**：直接列 scenarios（无占位项）+ disabled=false + **fix1.2 修订（v0.3）：自动选第 1 个枚举值**（`reloadReconIdFixScenarios` 中检测 `state.reconIdFixSelectedScenarioId === null && scenarios.length > 0` → `state.xxx = scenarios[0].id`） |

> **v0.3 fix1.2 修订**（2026-05-15 用户测试反馈）：
> - **问题**：v0.2 档 3 设计为 `select.selectedIndex = -1`（显式未选），用户必须主动点开下拉才能选场景
> - **修复**：scenarios 加载完成后，如果当前未选 → 自动设 `state.reconIdFixSelectedScenarioId = scenarios[0].id`；下游 `refreshReconIdFixStatus` 在 `reloadReconIdFixScenarios` 末尾统一触发
> - **状态副作用**：与用户手动选场景一致（状态栏显示该场景对应的 ready/idle 状态）
> - **`renderReconIdFixScenarioSelect` 末尾的 `selectedIndex = -1` 兜底分支可删**（reloadReconIdFixScenarios 已保证 scenarios 非空时 state 必有值）

#### 5.2.2 影响范围

- 前端：`src/renderer.js:3570-3608` `renderReconIdFixScenarioSelect`
- 后端：无
- 数据库：无
- 兼容性：纯 UI 行为变更，无 state / 持久化变更
- 风险：档 3 改后用户进模块默认 select 无可见选中项（与 v2.1.4 占位项可见但 value="" 的体感等价）；下游 enable 按钮逻辑（`updateReconIdFixUi` 等）依赖 `state.reconIdFixSelectedScenarioId !== null` 判断，**未选场景时按钮 disabled 行为不变**

#### 5.2.3 UI Mockup

```
档 1（账单类别空）：       [▼ ]
档 2（无 scenarios）：      [▼ ]
档 3（有 scenarios）：      [▼ 场景A | 场景B | 场景C ...]   ← 默认选中第 1 个 (fix1.2)
```

### 5.3 N3：「提取ReconId-From 网关」场景 dialog 新增「条件」栏

#### 5.3.1 说明

- **入口**：「银行对账单处理」模块 → 场景管理 → 新增/修改场景 → 选择类别「提取ReconId-From 网关」（`gateway-recon-join`）→ 进入 `createScenarioConfigDialogC3`
- **位置**：在「优先级」行（dialog 行 2）下侧、「对账字段」行（dialog 行 3）上侧
- **输出**：dialog 4 行 → 5 行；点保存时校验 + 持久化 `config.conditions`；运行时引擎 `runC3Scenario` 按 conditions 过滤 gwRows/bankRows 再走原比对逻辑
- **边界条件**：
  - 默认进 dialog 时若旧 scenario 无 `config.conditions` 字段 → 初始化为空数组 `[]`（不强制添加默认行；与 C1 不同）
  - 用户点「+ 新增条件」加行时，新行默认 `{ side: '网关', field: '', op: '等于', value: '' }`
  - 「网关 / 银行」侧切换时，字段下拉枚举源切换 + 当前 field 值清空
  - 多条件 **AND** 关系（区别于 C1 的 OR）
  - **柔性校验**：conditions.length === 0 合法（视为不过滤）；≥ 1 行时每行 side / field 必填 + 非「空值/非空值」op 的 value 必填；side 与 field 一致性校验（如 side='网关' 但 field 不在 GATEWAY_RECON_FIELDS → 报错）

#### 5.3.2 影响范围

- 前端：`src/renderer-dialogs.js`
  - `createScenarioConfigDialogC3` 新增「条件」栏 DOM + 渲染 / 事件
  - `createDefaultScenarioConfig('gateway-recon-join')` 新增 `conditions: []` 字段
  - `validateScenarioDraft` 中 `'gateway-recon-join'` 分支补 conditions 校验
  - `buildScenarioConfirmDetailHtml` 中 `'gateway-recon-join'` 分支追加 conditions 段
- 后端：
  - `src/main-process/scenario-engines/c3-gateway-recon-join.js` 新增 `evalCondition(row, cd, { useC3BankValueGetter })` helper（包装 `evaluateCondition` 以支持银行侧虚拟字段）+ `runC3Scenario` 入口新增 Step 0 拆分 conditions / 过滤 gwRows+bankRows
- 数据库：无 schema 变更（`scenarios.config` 是 JSON blob 列；scenarios-repository 已 JSON.stringify/parse 透传）
- 兼容性：v2.1.4 及之前的 C3 场景 DB 数据无需迁移，引擎兜底 `cfg.conditions ?? []` 即可
- 对外接口：无变更

#### 5.3.3 UI Mockup（C3 dialog）

```
┌───────────────────────────────────────────────────────────────────────┐
│ 新增场景 — 提取ReconId-From 网关                              [ × ]    │
├───────────────────────────────────────────────────────────────────────┤
│ 场景名称       [______________________________]                        │
│ 优先级 ⓘ      [0]                                                       │
│ ─────────────────────────────────────────────────────────────────────  │
│ 条件 ⓘ        ┌─────────────────────────────────────────────────┐    │
│               │ [网关▼] [BillDate     ▼] [等于▼] [2026-04-01__]  ×  │
│               │ [银行▼] [Currency     ▼] [包含▼] [USD_________]   × │
│               │ [+ 新增条件]                                          │
│               └─────────────────────────────────────────────────┘    │
│   ⓘ tooltip: 同时满足全部条件才进入提取（AND）                        │
│ ─────────────────────────────────────────────────────────────────────  │
│ 对账字段       [...](网关字段 vs 银行字段，多行 AND；既有逻辑保留)     │
│ 对账成立后赋值 [...](网关字段 → 银行字段；既有逻辑保留)                │
└───────────────────────────────────────────────────────────────────────┘
```

字段说明：
- 左一下拉「网关 / 银行」：默认「网关」
- 左二下拉：左一 = 网关 → `GATEWAY_RECON_FIELDS`（31 列）；左一 = 银行 → `BANK_STATEMENT_FIELDS_FOR_C3`（45 项 = 44 + 虚拟「发生额绝对值」）。**左一切换时左二重渲染并清空当前值**
- 左三下拉：`SCENARIO_CONDITION_OPS = ['等于','不等于','包含','不包含','空值','非空值','开头为']`，默认「等于」
- 输入框：左三 = 「空值」/「非空值」时 `style="visibility:hidden"`（参考 `src/renderer-dialogs.js:6226 opNeedsValue`）
- 行末 ×：始终显示（柔性校验下，删完最后一行也合法 = 不过滤；点 × 后显示 0 行 + 「+ 新增条件」按钮可继续加）
- 「+ 新增条件」按钮：始终显示（除 readonly 模式）
- conditions 为空时，dialog 显示「条件」label + 空容器 + 「+ 新增条件」按钮（无任何条件行）

> **v0.3 fix1.1 修订**（2026-05-15 用户测试反馈）：
> - **问题**：v0.2 实现复用 `.scenario-config-multi-row` flex 布局；左一切「网关」时左二字段 select 因 `GATEWAY_RECON_FIELDS` 含 30+ 字符的字段名（`'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)'`）撑大 select 宽度，导致整行宽度比左一切「银行」时（最长 23 字符 `Transaction Description`）更宽
> - **修复**：给 C3 条件 row 加专属 class `scenario-config-c3-cond-row`（grid 布局，列宽固定 `100px / 240px / 100px / 1fr / 22px`）；左二字段 select 加专属 class `scenario-config-c3-cond-field`（`flex: 0 0 240px; width: 240px;` + `text-overflow: ellipsis; overflow: hidden;`）
> - **不复用** `.scenario-config-multi-row` — 避免影响 reconFields / billTypes 行的既有 flex 布局
> - **下拉打开时** option 完整可见（HTML `<select>` 默认行为），仅闭合状态被截断
> - **CSS 改动文件**：`src/styles.css` + `src/styles-gemini-extra.css`（项目维护两套主题，按既有 scenario-config-* 模式同步加规则）

---

## 六、验收标准

> 本章节共 **17 条** AC。

### 6.1 N1：模块名加空格 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 启动应用 → 主页面左上角模块切换菜单的「对账单 ReconID 修复」按钮显示空格（与 v2.1.4 无空格对比） |
| AC1-2 | 进对账单 ReconID 修复模块 → 跑 `导入文件` / `开始运行` / `导出文件` 各一次 → 关闭应用 → 检查 `<storageRoot>/.usage-stats.txt`，应有 `[对账单 ReconID 修复]` section + 3 个 fnKey 均 ≥ 1 |
| AC1-3 | 旧用户 `.usage-stats.txt` 中已有 `[单据对账ReconID修复]` section（v2.1.0-beta.1 起 seed 全为 0）→ v2.1.5 启动 + 跑一次 + 关闭后，文件中 `[单据对账ReconID修复]` section 不再出现（writeStatsFile 按 FUNCTION_REGISTRY 顺序输出新 key），新 section `[对账单 ReconID 修复]` 出现 |
| AC1-4 | 在 gateway 场景中跑「开始运行」选择不匹配的 category（如把 business 场景选给 gateway session，或反之）→ error message 字符串显示 `场景 "xxx" 不是对账单 ReconID 修复类，无法运行`（含空格） |
| AC1-5 | grep `'对账单ReconID修复'`（无空格）在 `src/main.js` / `src/renderer.js` / `src/backend/usage-stats.js` 三个文件代码字面应 0 命中（注释不计） |

### 6.2 N2：场景下拉空状态 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 进对账单 ReconID 修复模块 + 主面板「账单类别」select 设为空（开发者工具手动模拟）→ 场景下拉显示真空白 + disabled |
| AC2-2 | 主面板「账单类别」选 `gateway`（默认）+ DB 该类别下无任何场景 → 场景下拉显示真空白 + disabled（**不再显示「请先在场景管理中创建场景」**） |
| AC2-3 | 主面板「账单类别」选 `gateway` + DB 有 ≥ 1 个场景 → 场景下拉直接列 scenarios（**无「请选择场景」占位项**），select 显示空白（selectedIndex = -1） |
| AC2-4 | AC2-3 状态下用户未主动选场景 → 主面板「开始运行」按钮 disabled（沿用既有「未选 scenarioId 不能跑」行为）|

### 6.3 N3：C3「条件」栏 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 银行对账单处理 → 场景管理 → 新增「提取ReconId-From 网关」场景 → dialog 在「优先级」与「对账字段」之间显示「条件」label + 空容器 + 「+ 新增条件」按钮（**默认 0 条条件**） |
| AC3-2 | 点「+ 新增条件」→ 出现 1 条 `[网关 ▼][字段 ▼][等于 ▼][_____] [×]`，左一默认「网关」，左二字段下拉枚举为 `GATEWAY_RECON_FIELDS`（31 列） |
| AC3-3 | 左一切到「银行」时，左二字段下拉枚举重渲染为 `BANK_STATEMENT_FIELDS_FOR_C3`（45 项），且当前选中字段值清空 |
| AC3-4 | 左三选「空值」或「非空值」时，右侧值输入框 `visibility: hidden`；切回其他操作时显示 |
| AC3-5 | 行末「×」始终显示（柔性校验，可删完）；点击删除该行；删完后回到 0 行状态 |
| AC3-6 | **柔性校验**：保存场景时若 `conditions.length === 0` → 通过（视为不过滤）；≥ 1 行时若任一行 side/field 为空 / 非「空值/非空值」操作的 value 为空 → alert 校验错误 |
| AC3-7 | side 与 field 一致性校验：保存时若 side='网关' 但 field 不在 GATEWAY_RECON_FIELDS（或 side='银行' 但 field 不在 BANK_STATEMENT_FIELDS_FOR_C3）→ alert 校验错误 |
| AC3-8 | 保存成功后再次打开同场景，「条件」栏正确回显（数量、各行字段值） |
| AC3-9 | 旧 v2.1.4 创建的 C3 场景在 v2.1.5 打开 dialog 时，「条件」栏显示 0 条条件（`config.conditions` 缺失 → 视为空数组），不强制要求加条件即可保存 |
| AC3-10 | scenario confirm 预览段在 conditions ≥ 1 行时显示「条件（AND）：网关 BillDate 等于 2026-04-01；银行 Currency 包含 USD」类似列表；conditions 为空时该段不渲染 |
| AC3-11 | 运行时：网关账单 2 行（HKD/USD），配置条件 `[网关, Currency, 等于, HKD]` → 引擎过滤后 gwRows 仅留 HKD 行进入比对；USD 行被过滤（不参与 join） |
| AC3-12 | 运行时：银行对账单 conditions 含 `[银行, 发生额绝对值, 等于, 100]` → 引擎走 `getBankRowValueForC3` 计算虚拟字段后比较，命中 \|Credit-Debit\|=100 的行 |
| AC3-13 | 运行时：旧 DB scenario `config.conditions` 缺失 → 引擎兜底 `[]`，gwRows / bankRows 不过滤，行为与 v2.1.4 完全一致（零回归） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 模块名空格 UI | 启动应用 → 看主页面左上角模块切换 | enabled_modules 含 `recon-id-fix` | 按钮文字显示「对账单 ReconID 修复」（含 2 空格） |
| usage-stats 计数 | 进对账单 ReconID 修复模块跑导入/运行/导出各 1 次 → 关闭应用 → cat `.usage-stats.txt` | 旧 DB（无该 key）或新 DB | 文件中存在 `[对账单 ReconID 修复]` section + 3 个 fnKey 各 ≥ 1 |
| 场景下拉空状态 | 主面板切「账单类别」为 gateway，DB 该类别下无场景 | 新 DB 或手动 DELETE | 场景下拉真空白，无任何文案 |
| C3 dialog 新增「条件」栏 | 场景管理 → 新增「提取ReconId-From 网关」场景 → 配置 dialog | 旧 DB（无该 category 场景）或新 DB | dialog 行 3 显示「条件」label + 空容器 + 「+ 新增条件」按钮 |
| C3「条件」AND 过滤生效 | 配置 1 条网关侧 + 1 条银行侧 AND 条件，跑实际数据 | C3 场景 + 网关账单 + 银行对账单 fixture | gwRows / bankRows 行级过滤生效；assign 写入只发生在过滤后命中的 bankRow |
| 旧 DB 兼容 | 进 v2.1.4 已创建的 C3 场景，跑「开始运行」 | DB 该场景 config.conditions 缺失 | 行为与 v2.1.4 完全一致（零回归），不过滤 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 跨「网关 / 银行」切换 | dialog 中条件行左一切换 | 任意 C3 场景 | 左二字段下拉重渲染 + 当前值清空 |
| 「空值/非空值」操作 | 左三选「空值」 | dialog 中任意条件行 | 值输入框 `visibility:hidden`；保存校验通过 |
| 银行侧虚拟字段 | 左一=银行 + 左二='发生额绝对值' + 左三=等于 + 值=100 | 银行对账单含 \|Credit-Debit\|=100 行 | 引擎走 `getBankRowValueForC3` 算虚拟字段，过滤后命中 |
| side / field 一致性 | dialog 中手动构造 side='网关' field='Currency'（Currency 不在 GATEWAY_RECON_FIELDS） | 修改场景 | 保存时 alert 校验错误 |
| 删完所有条件保存 | dialog 中加 1 条 → 删除 → 保存 | C3 场景 | conditions 持久化为 `[]`，校验通过；下次打开 dialog 显示 0 条 |
| confirm 预览 conditions 段 | 配置 ≥ 1 条条件 → 保存前 confirm 弹窗 | C3 场景 | 预览段显示「条件（AND）：...」列表 |
| 模块名 grep | grep `'对账单ReconID修复'`（无空格）于 src/ 代码字面 | 应用代码全量 | 0 命中（注释不计） |

### 7.3 不测项与原因

- 不测 `.usage-stats.txt` 历史数据迁移 — 用户已明确不做 migration
- 不测注释中"对账单ReconID修复"是否同步加空格 — 注释属历史痕迹，不强制刷
- 不测 IPC channel `'recon-id-fix:xxx'` 是否改名 — 显式不改（preload + DB schema 依赖）
- 不测 v2.1.4 业务OP数据核对模块名 — 用户撤回该项
- 不测 C1 / C2 / C4 dialog 是否新增「条件」栏 — 显式不做（仅 C3）
- 不测 dialog 中「条件」与「对账字段」是否冲突（同字段先 conditions 过滤后 reconFields 比对）— 引擎语义清晰，用户自行配置

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | `scenarios.config` JSON blob 列内（仅 `category === 'gateway-recon-join'` 时）新增 `conditions` 字段（`Array<{side:'网关'\|'银行', field:string, op:string, value:string}>`）。无 schema 变更（`config` 已是 JSON blob，scenarios-repository 已 JSON.stringify/parse 透传） |
| 状态流转变更 | 无（不动主面板按钮 disabled / session 状态机 / scenario 持久化协议） |
| 权限 / 安全 | 无 |
| 资金 / 计费 | ⚠️ **N3 在 C3 引擎运行时引入行级过滤，属资金对账链路**；过滤错误（如条件配置不当）会导致 join 命中率下降 / assign 写入数减少，但**不会改变已命中行的写入语义**（`gwMatchesBank` / assign 写值逻辑零修改）。配置层面影响，非算法层面回归。⚠️ **PR 必须人工复核** |
| 计数数据 | usage-stats `[单据对账ReconID修复]` section 在下次 flush 时不再被写入；新 key `[对账单 ReconID 修复]` 由 `defaultStats` seed 0 值后开始累加 |
| 回滚策略 | N1：revert 4 个文件（`renderer.js` + `main.js` 4 处 + `usage-stats.js`）；N2：revert `renderer.js:3570-3608`；N3：revert `renderer-dialogs.js`（dialog DOM + default config + 校验 + confirm 预览）+ `c3-gateway-recon-join.js`（Step 0 + evalCondition helper）；DB 中已写入的 `config.conditions` 字段在回滚后会被 v2.1.4 引擎忽略，无需 migration |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 旧 v2.1.4 创建的 C3 场景 DB 数据无需 migration，引擎兜底 `cfg.conditions ?? []` 表示无条件全通过 |
| 性能 | C3 引擎新增的 Step 0 行级过滤 ≤ O((N + M) × K)（N=网关行数、M=银行行数、K=条件总数）；按业务量级（数千行 + 条件 ≤ 5）影响 < 10ms，且**反而降低后续 O(N × M) 比对的输入规模**，整体性能持平或提升 |
| 鲁棒性 | conditions 中 field 字段拼写错误（已被 dialog 校验拦截）→ 不进入引擎；运行时若仍遇异常字段（如手动改 DB） → `evaluateCondition` 取 `row[field] = undefined` → `normalizeCellValue` 返回 `''` → 等于 / 包含均 false → 该行被过滤。**无 throw**，但用户感知 join 命中率异常下降 |

---

## 十、待澄清问题

- [x] N1 业务OP数据核对是否一并改名？ — **用户已撤回，不改**
- [x] N1 是否做 `.usage-stats.txt` 历史数据 migration？ — **用户已确认不做**（旧 key 历史从未成功累计；writeStatsFile 按 FUNCTION_REGISTRY 顺序输出，新 key 自动不出现旧 key） 
- [x] N1 IPC channel name 是否改名？ — **不改**（preload + DB schema 依赖）
- [x] N2 scenarios 为空时 select.disabled 是否保留 true？ — **保留**（沿用现状）
- [x] N2 有 scenarios 但用户未选时 select 默认显示？ — **selectedIndex = -1**（HTML 标准未选状态，无可见占位项）
- [x] N3 v2.1.5 范围是否包含运行时实现？ — **包含**（用户已选 A）
- [x] N3 校验严格程度？ — **柔性**（用户已选 a：conditions 可 0 行）
- [x] N3 字段枚举源歧义？ — **无歧义**（C3 既有的 GATEWAY_RECON_FIELDS / BANK_STATEMENT_FIELDS_FOR_C3 已与运行时字段名 byte-for-byte 对齐；区别于 v0.1 误判的 C4 模块）
- [x] Q1 — ✅ 用户已确认按 dev 方案：N3 银行侧虚拟字段「发生额绝对值」走 `getBankRowValueForC3`（spec §4.5.1）
- [x] Q2 — ✅ 用户已确认按 dev 方案：side / field 不一致时弹 alert 拦住保存（spec §4.3）

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-15 | 初稿 v0.1（N3 误定位 C4 模块） |
| 2026-05-15 | v0.2 重写 — N3 修正定位到 C3（`gateway-recon-join` / `createScenarioConfigDialogC3` / `c3-gateway-recon-join.js`）；N1 / N2 不变 |
| 2026-05-15 | v0.3 — fix1.1 C3 条件 row 列宽固定（spec §4.8）+ fix1.2 场景下拉默认选第 1 个（spec §3.5）+ Q9/Q10 拍板（用户已确认走 / 弹） |

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
