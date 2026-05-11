# PRD — v2.1.0-beta.3 ReconID 模块改造：新增网关对账单子模式 + 主面板账单类别筛选

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft，待用户 review） |
| 目标版本 | `v2.1.0-beta.3` |
| 起始版本 | `v2.1.0-beta.2`（已 merge：PR #38，2026-05-11） |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft |
| 关联文档 | `spec.md` / `tasks.md` / `log.md`（同目录） |
| 涉及模块 | 对账单ReconID修复模块（含单据/网关两个子模式） |
| 工作分支 | `v2.1.0-beta.3`（从 `v2.1.0` 切出，PR 向 `v2.1.0 → main`） |
| 依赖 | v2.1.0-beta.2 已落地的 C4 单据对账 ReconID 修复 + 场景管理白名单隔离 |

---

## 一、需求概述

v2.1.0-beta.1/beta.2 落地"单据对账 ReconID 修复"模块（C4）后，用户提出 **将该模块扩展为"对账单ReconID修复"通用模块**，下挂两个子模式：

1. **单据对账单 ReconID 修复**（已有 C4，保持现状）
2. **网关对账单 ReconID 修复**（新增，与单据模式互相独立但共用前端结构与匹配算法骨架）

主面板新增"账单类别"下拉框作为一级筛选，"场景"下拉作为二级筛选，按账单类别过滤展示。

---

## 二、背景与目标

### 2.1 业务背景

- 单据对账（业务部门 vs 对手部门）的 ReconID 修复已稳定上线
- 网关对账（网关账单 vs 渠道账单）业务场景同样需要 ReconID 修复能力
- 两种对账场景的数据结构（sheet 列、字段语义）不同，但匹配算法骨架一致（1v1 / 1v多 / 多v1 subset-sum + Type/Reference 写值）

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 业务覆盖 | ReconID 修复能力覆盖两种对账场景（单据 + 网关），减少线下手工修单 |
| 操作体感 | 主面板一级筛选"账单类别" + 二级"场景"，定位场景更快；持久化记忆上次选择 |
| 代码复用 | 共用 dialog 框架 + 引擎骨架，减少代码冗余 |
| 隔离保护 | 单据模式（已稳定）零回归风险 — 通过 mode 参数路由，不污染原路径 |

### 2.3 目标

| 必做 | 不做 |
|---|---|
| ✅ 主面板新增"账单类别"下拉（枚举：网关对账单 / 单据对账单），初始空 | ❌ 改 scenarios 表 schema / 加 module 列 |
| ✅ "场景"下拉位置下移至与"导出文件"按钮平行 | ❌ 改主面板模块下拉 module.id（保留 `recon-id-fix`） |
| ✅ 主面板模块下拉项文本：单据对账 ReconID 修复 → **对账单ReconID修复** | ❌ 改单据模式现有行为（C4 引擎 / 输出 sheet / dialog 默认行为） |
| ✅ 新增 scenario.category = `gateway-recon-id-fix`（与现有 `recon-id-fix` 并列） | ❌ 改 C1/C2/C3 dialog 与对应业务流 |
| ✅ C4 dialog 加 `mode` 参数（`business` / `gateway`），按 mode 切换枚举/文案/禁用/输出 | ❌ 改 BrowserWindow 配置 / 文件读取链路 |
| ✅ 新增 `gateway-bill-recon-fields.js`（网关账单 31 / 渠道账单 16 / 订单修复 14 / 对账结果 19 列） | ❌ 改单据模式 `recon-id-fix-fields.js`（订单修复仍含 SubBizType） |
| ✅ 引擎扩展：复用 C4 subset-sum 骨架，新增网关模式分支（Type/Reference/拆账逻辑） | ❌ 兼容性破坏（v2.1.0-beta.2 已合并行为全部保留） |
| ✅ 账单类别下拉持久化（SQLite `app_settings.recon_id_fix_bill_category`） | ❌ 升级 bundleVersion / 改模板格式 |
| ✅ preview 全量重跑 + smoke 全绿 | ❌ 改 v1.5.x / v2.0.0 / v3.0.0 分支 |
| ✅ 版本号 bump 2.1.0-beta.2 → 2.1.0-beta.3 + 三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE） | — |

### 2.4 明确不做

- **不加 scenarios 表新列**（如 module/mode），不调整列结构、UNIQUE 约束、默认值；**仅扩 CHECK 约束 1 个枚举值** + 配套一个幂等迁移函数（沿用 v2.1.0-beta.1 PR-A 模板，2026-05-11 reverse sync）
- 不动 C1/C2/C3 dialog 与对应业务流（C3 网关对账 join 与本次"网关对账ReconID修复"是 **完全不同的模块**，仅字段常量共享）
- 不动单据模式现有 C4 引擎默认路径（mode='business' 即原行为）
- 不调整模块切换下拉的 module.id（保留 `recon-id-fix`）
- 主面板"账单类别"下拉初始为空时，**所有按钮仍显示**（保持 beta.2 完整布局），仅按钮 disabled；行 2 wrapper 不再 hidden（2026-05-11 reverse sync — 用户反馈"账单类别为空值的情况也要将其他按钮全部显示出来 + 其他前端结构同 beta.2 版本"）

> ⚠️ 2026-05-11 Reverse Sync：原 §2.4 第 1 条"不写迁移"与代码现状冲突 — `scenarios.category` 有 SQLite CHECK 约束（migrations.js:500），新增枚举值必须重建表 + 幂等迁移。本次沿用 v2.1.0-beta.1 PR-A 已验证模板（`ensureScenariosCategoryReconIdFix`），新增 `ensureScenariosCategoryGatewayReconIdFix` 函数，结构、风险等同已有迁移。

---

## 三、需求拆解

### 3.1 R1：模块文本重命名

**现状**（renderer.js:59 / index.html:45）：
- `MODULES.reconIdFix.name` = `'单据对账 ReconID 修复'`
- `<button class="module-option" data-module="recon-id-fix">单据对账 ReconID 修复</button>`

**期望**：
- `MODULES.reconIdFix.name` = `'对账单ReconID修复'`
- `<button class="module-option" data-module="recon-id-fix">对账单ReconID修复</button>`
- **module.id `recon-id-fix` 保留不动**（数十处引用，改 id 牵动太大）
- 单据模式 scenario.category 保留 `recon-id-fix`（与 module.id 字面相同，spec/注释中明确"module=模块，category=sub-mode"歧义说明）

### 3.2 R2：主面板新增"账单类别"下拉 + 场景下拉下移

**现状**（index.html:218-235）：
```
行 1: [场景下拉 + 场景管理按钮]
行 2: [导入文件 + 开始运行]
行 3: [导出文件]
行 4: [状态]
```

**期望**：
```
行 1: [账单类别下拉]                            ← 新增（位置 = 原"场景"位置）
行 2: [导入文件 + 开始运行]                      ← 不变
行 3: [场景下拉 + 场景管理按钮 + 导出文件]        ← "场景"下移，与"导出文件"同行
行 4: [状态]                                    ← 不变
```

**账单类别下拉**：
- HTML `<select id="reconIdFixBillCategorySelect">`
- 枚举值：`<option value="">请选择账单类别</option>` / `<option value="business">单据对账单</option>` / `<option value="gateway">网关对账单</option>`
- 初始为空（首次启动 OR DB 无记录）
- 用户选择后立即持久化到 `app_settings.recon_id_fix_bill_category`（`gateway` / `business`）
- 启动时从 DB 读取，恢复上次选择

**联动**：
- 账单类别下拉初始为空时 → "场景"下拉、"场景管理"按钮、"导入文件"、"开始运行"、"导出文件" 全部隐藏或禁用（具体待 spec 时定，倾向 **场景下拉/场景管理隐藏；导入/开始运行/导出禁用**）
- 选了账单类别后 → "场景"下拉过滤显示该 category 下的场景，"场景管理"按钮 enabled
- 切换账单类别时 → 清空已选场景 + 清空当前 import session（避免数据串位）

### 3.3 R3：scenario.category 枚举扩展 + 场景管理隔离

**现状**：
- `scenarios.category` 已有：`extract-recon-id` / `offset-bill-mark` / `gateway-recon-join` / `recon-id-fix`
- ReconID 模块场景管理 allowedCategories = `['recon-id-fix']`（v2.1.0-beta.2 落地）

**期望**：
- 新增 category 值：`gateway-recon-id-fix`
- ReconID 模块场景管理 allowedCategories 根据 **当前主面板"账单类别"** 动态传：
  - 账单类别 = `business` → `['recon-id-fix']`
  - 账单类别 = `gateway` → `['gateway-recon-id-fix']`
  - 账单类别为空 → 不允许打开场景管理（按钮 disabled）
- 场景管理 dialog 列表仅展示该 category 下的场景；新增场景直接进入对应 dialog（mode=business → 现有 C4 dialog；mode=gateway → C4 dialog with mode='gateway'）

### 3.4 R4：C4 dialog 参数化（mode = business | gateway）

**现状**：`createScenarioReconIdFixDialog`（renderer-dialogs.js，具体行号待 spec 阶段确认）支持单据对账，字段/文案/输出固定。

**期望签名**：
```js
function createScenarioReconIdFixDialog(scenario = null, mode = 'business') { /* ... */ }
```

**mode-switch 差异表**：

| 项 | mode='business'（现状） | mode='gateway'（新增） |
|---|---|---|
| dialog 标题 | `新增/修改场景` | `新增/修改场景`（不变） |
| **匹配规则勾选框** | 1对1 / 1对多 / 多对1（现状文案） | **网关 1 v 1 渠道** / **网关 1 v 多 渠道** / **网关 多 v 1 渠道** |
| 勾选框互斥 | 1对多 与 多对1 互斥 | 网关 1v多 与 网关 多v1 互斥（同) |
| 勾选框排版 | 同一行（beta.2 落地） | 同一行（同) |
| **账单类型下拉枚举源** | `BUSINESS_BILL_FIELDS` / `OPPONENT_BILL_FIELDS` | **`GATEWAY_BILL_FIELDS`**(网关账单 31 列) / **`CHANNEL_BILL_FIELDS`**(渠道账单 16 列) |
| **SubBizType 取值栏** | 显示（现状） | **去掉**（不渲染） |
| **"修复结果输出" 标签** | `修复结果输出` | **`订单修复ID取值`** |
| **"主边单据" 选项文本** | `主边单据` | **`网关账单`** |
| **"从边单据" 选项文本** | `从边单据` | **`渠道账单`** |
| **"主从边都修复" 选项文本** | `主从边都修复` | **`自取值`** |
| **"网关账单" 选项的可选性** | n/a | 仅在勾选 `网关 1 v 1 渠道` 时可选；勾选 `1v多` 或 `多v1` 时 **禁用** |
| **"自取值"下拉枚举源** | `主边单据 reconId` / `从边单据 reconId`（commonId 取值） | **`网关账单ReconID`**（取 `网关账单.reconciliationId`） / **`渠道账单ReconID`**（取 `渠道账单.reconciliationId`） |
| **"自取值" 内容文本** | `... 主从边共同的 ...` | **去掉"主从边共同的"** |
| **输出 sheet 名 / 列** | `订单修复`（15 列含 SubBizType） | `订单修复`（**14 列不含 SubBizType**） |

### 3.5 R5：引擎扩展（网关模式匹配算法）

**现状**：`c4-recon-id-fix.js`（`runC4Scenario`）实现 1v1 / 1v多 / 多v1 subset-sum + BillDate 容错 + Type 规则（双 0 / 主 2 从 0 等）+ commonId（src.reconId + suffix）。

**期望**：
- `runC4Scenario(scenario, sheets, mode = 'business')` 加 `mode` 参数（默认 `'business'` 保持向后兼容）
- `recon-id-fix-engine.js::runReconIdFix(scenario, sheets)` 内部按 `scenario.category` 自动决定 mode

**网关模式匹配语义**（与单据模式的差异）：

| 项 | mode='business' | mode='gateway' |
|---|---|---|
| 匹配字段来源 | 业务部门账单 / 对手部门账单 | 网关账单 / 渠道账单 |
| BillDate 容错 | ±1day（已落地） | **沿用 ±1day**（需求未禁，按一致性默认开） |
| subset-sum 主目标 | `主.Amount` ↔ `从.Amount` | `网关.Amount` ↔ `渠道.receiveAmount` |
| **1v1 写值** | 双 Type=0；reference/commonId 按 mode 决定 | 双 Type=0；Reference 按 "订单修复ID取值" 选项决定 |
| **1v多 写值** | 双 Type=0（RB4） | **拆出的 n 笔网关账单 Type=1**；Amount 取对应渠道 receiveAmount；Reference 按取值规则；**输入的那 1 笔原始网关账单丢弃** |
| **多v1 写值** | 主 Type=2 / 从 Type=0（RB2） | **n 笔网关账单 Type=2**；Amount **保持原值**；Reference 按取值规则 |
| **Reference 取值规则** | 沿用 commonId（src.reconId + suffix） | **按 dialog 选项决定**：网关账单 → 取该行 `网关账单.reconciliationId`；渠道账单 → 取该行 `渠道账单.reconciliationId`；自取值-网关ReconID → 取对应行 `网关账单.reconciliationId`；自取值-渠道ReconID → 取对应行 `渠道账单.reconciliationId` |
| **每笔渠道账单仅取一次** | n/a | **全局约束**：一笔渠道账单全局只能被一次匹配组使用；**单组内一一对应**：1v多 拆出的 n 笔网关 ↔ n 笔渠道账单（按 fixture 行序对应） |
| 输出 sheet 列 | 15 列（含 SubBizType） | 14 列（不含 SubBizType） |

⚠️ **风险点**（详见 §五）：1v多 拆账逻辑是 **创建新行**（输入 1 输出 n）的写值，是网关模式独有，需新加 helper。多v1 仅改 Type 字段，复用现有算法骨架更简单。

### 3.6 R6：字段常量与 fixture

**新增文件**：`src/constants/gateway-bill-recon-fields.js`
- `GATEWAY_BILL_FIELDS`（31 列，与现有 `GATEWAY_RECON_FIELDS` 一致，建议直接复用 export 重命名 OR 二者 union）
- `CHANNEL_BILL_FIELDS`（16 列，新增）
- `ORDER_REPAIR_FIELDS_GATEWAY`（14 列，无 SubBizType，新增）
- `RECON_RESULT_FIELDS_GATEWAY`（19 列，对账结果，仅 sheet 名常量需要；当前需求暂未消费此 sheet 数据，预留）
- sheet 名常量：`GATEWAY_BILL_SHEET_NAME = '网关账单'` / `CHANNEL_BILL_SHEET_NAME = '渠道账单'` / `ORDER_REPAIR_SHEET_NAME_GATEWAY = '订单修复'` / `RECON_RESULT_SHEET_NAME_GATEWAY = '对账结果'`

**preload.js 同步**：sandbox 限制，preload 顶部需 inline 一份副本（参考现有 `recon-id-fix-fields.js` 的同步注释）

**fixture 文件**：`资金对账导出不平.xlsx`（根目录已存在，4 个 sheet 实测齐全）

**两模式 fixture 来源对照**（含输出 sheet 模板归属）：

| 模式 | fixture 路径 | 输入 sheet（消费） | 输出 sheet 模板（写出） | 代码常量文件 | 列模板常量 |
|---|---|---|---|---|---|
| **business**（现有） | `samples/单据对账导出不平.xlsx` | `对账结果` (18) / `业务部门账单` (23) / `对手部门账单` (22) | 「订单修复」**15 列**（含 SubBizType） | `src/constants/recon-id-fix-fields.js`（v2.1.0-beta.1 已落地） | `ORDER_REPAIR_FIELDS` |
| **gateway**（新增） | `资金对账导出不平.xlsx`（根目录） | `对账结果` (19) / `网关账单` (31) / `渠道账单` (16) | 「订单修复」**14 列**（不含 SubBizType） | `src/constants/gateway-bill-recon-fields.js`（**待新增**） | `ORDER_REPAIR_FIELDS_GATEWAY` |

**澄清要点**：
1. **两份 fixture 完全独立，不混用**。business 模式 IO writer 取 `ORDER_REPAIR_FIELDS`；gateway 模式新增独立 writer 取 `ORDER_REPAIR_FIELDS_GATEWAY`，各自互不影响。
2. 列名是 **设计期硬编码常量**（commit 进代码库），**不是运行时动态读 fixture**。fixture 文件只是"模板来源依据"——决定常量数组应该怎么定义。fixture 文件未来若变更，必须同步改对应常量（属于 schema 变更，需走 PR review）。
3. business 模式的运行时写出逻辑见 `src/main-process/recon-id-fix-io.js:198` —— `const aoa = [ORDER_REPAIR_FIELDS.slice()]` 把列名作为输出文件第一行表头，后续按列名取值。gateway 模式的 IO writer 结构同构，仅常量名替换。
4. gateway 模式的 `RECON_RESULT_FIELDS_GATEWAY`（19 列）目前 **仅作 sheet 名/列序常量预留**，本次需求未消费"对账结果" sheet 的数据；如未来加入消费需求，再扩 IO 与引擎。

### 3.7 R7：账单类别持久化

**新增 settings key**：`recon_id_fix_bill_category`
- 写入：用户切换主面板"账单类别"下拉时立即写
- 读取：renderer.js 启动时从 IPC `desktopApi.settings.get('recon_id_fix_bill_category')` 取，恢复 UI 状态
- 取值：`'business'` / `'gateway'` / `null`（初次或显式清除）

**IPC 接口**：
- 已有 `app_settings` 通用 K-V 接口（database/settings-repository.js）→ 复用，无需新增 channel
- 注意：`recon_id_fix_export` 等 ReconID 模块状态变量已在 v2.1.0-beta.2 落地；新增的 `recon_id_fix_bill_category` 与之独立

### 3.8 R8：版本号 bump + 文档三件套

- `package.json` / `package-lock.json`：`2.1.0-beta.2` → `2.1.0-beta.3`
- `CHANGELOG.md`：新增 v2.1.0-beta.3 条目
- `docs/VERSION_FEATURE_HISTORY.md`：补 v2.1.0-beta.3 特性章节
- `docs/USER_GUIDE.md`：补"对账单ReconID修复 — 网关对账单子模式"使用流程

---

## 四、模式对比总览

| 维度 | 单据对账单模式（mode='business'） | 网关对账单模式（mode='gateway'） |
|---|---|---|
| scenario.category | `recon-id-fix`（已有） | `gateway-recon-id-fix`（新增） |
| 主面板"账单类别"选择 | `business` | `gateway` |
| 输入 sheet（fixture） | `业务部门账单` / `对手部门账单` / `对账结果` | `网关账单` / `渠道账单` / `对账结果`（fixture 同文件） |
| dialog 文案 | 主边单据 / 从边单据 / 主从边都修复 | 网关账单 / 渠道账单 / 自取值 |
| 匹配规则勾选 | 1对1 / 1对多 / 多对1 | 网关 1v1 / 网关 1v多 / 网关 多v1 |
| SubBizType 取值栏 | 显示 | 隐藏 |
| Reference 取值 | commonId (src.reconId + suffix) | 按"订单修复ID取值"选项 |
| 1v多 Type 规则 | 双 0 | 拆出 n 笔均为 1 |
| 多v1 Type 规则 | 主 2 从 0 | n 笔网关均为 2 |
| 输出 sheet 列 | 15 列（含 SubBizType） | 14 列（无 SubBizType） |

---

## 五、风险点与依赖

### 5.1 风险

1. **业务规则（高优）** — 1v多 拆账逻辑（输入 1 输出 n）是网关模式独有，引擎需新增 helper。Type/Amount/Reference 写值口径必须 case-by-case 测试。
2. **状态机（中）** — 主面板"账单类别"切换时的级联清空逻辑：场景下拉 / import session / 导出态 / 错误报告（参考 v2.1.0-beta.2 PR #38 review round 3 的 scenariosChanged 教训，避免误清）。
3. **对外接口（中）** — 订单修复 sheet 列数从 15 → 14（仅网关模式）；下游消费方（如有）需确认。⚠️ **网关模式 fixture 已只有 14 列，下游消费方天然不期望 SubBizType**，风险较低。
4. **持久化（低）** — `recon_id_fix_bill_category` 新增 settings key；启动时若读到 `gateway` 但 scenarios 表无任何 `gateway-recon-id-fix` 场景，UI 表现为"场景下拉空"，需 UX 明确。
5. **代码膨胀（低）** — `renderer-dialogs.js` 已 ~5000 行；C4 dialog 加 mode 分支约新增 ~150 行。引擎 `c4-recon-id-fix.js` 加 mode 分支约新增 ~120 行。
6. **场景管理 dialog 行为（低）** — 账单类别为空时禁止打开场景管理（按钮 disabled），需 UX 提示。

### 5.2 风险显式提醒（按 CLAUDE.md 规则 7）

⚠️ 本次涉及：
- **状态机**：主面板下拉级联、场景管理白名单动态化
- **对外接口/数据契约**：订单修复 sheet 列数变更（仅网关模式）、新增 settings key
- **业务规则**：拆账写值、Type 规则、Reference 取值规则

⚠️ **建议人工复核重点**：
1. 1v多 拆账逻辑（Amount/Type/Reference/每笔渠道仅取一次）的引擎单测
2. 主面板切换账单类别时的状态清空合理性（不误清正在导出的另一个类别的状态）
3. 输出 14 列 vs 15 列的兼容性（若下游脚本硬编码列序）

### 5.3 依赖

- v2.1.0-beta.1 / beta.2 已落地的 C4 dialog / 场景管理白名单 / 引擎骨架 / 字段常量
- `资金对账导出不平.xlsx` fixture（根目录已存在）
- 现有 `GATEWAY_RECON_FIELDS`（v2.0.0-beta.3 引入，C3 模块用）— 字段列与网关账单一致，可复用

---

## 六、验收标准

### 6.1 功能验收

| 项 | 验收点 |
|---|---|
| 模块下拉文本 | `对账单ReconID修复` 在主面板模块下拉项可见 |
| 账单类别下拉 | 初始为空 + 两选项 + 持久化（关闭重开保留） |
| 场景下拉位置 | 与"导出文件"按钮同行 |
| 场景管理隔离 | 类别=business 仅看 C4-business 场景；类别=gateway 仅看 C4-gateway 场景；切换不串位 |
| 新增场景跳过类别选择窗 | 账单类别选定后点"新增场景"直接进入对应 C4 dialog |
| dialog 文案（business） | 与 v2.1.0-beta.2 一致（无回归） |
| dialog 文案（gateway） | 网关账单 / 渠道账单 / 自取值；SubBizType 取值栏不显示 |
| 引擎 1v1（gateway） | 1 笔网关 ↔ 1 笔渠道 → 双 Type=0；Reference 按选项 |
| 引擎 1v多（gateway） | 1 笔网关 + n 笔渠道 → 拆 n 笔网关 Type=1；Amount=对应渠道 receiveAmount；输入原行丢弃 |
| 引擎 多v1（gateway） | n 笔网关 + 1 笔渠道 → n 笔网关 Type=2；Amount 保持；Reference 按选项 |
| 输出 sheet 列数 | business=15 列含 SubBizType；gateway=14 列不含 SubBizType |
| 单据模式无回归 | 现有 C4 business 场景全部跑通（preview + smoke + 手工） |

### 6.2 工程验收

- `npm run smoke` 全绿
- **新增 fixture 化引擎单元测试** `scripts/smoke/recon-id-fix-engine-gateway.js`（参考 `scripts/smoke/recon-id-fix-engine.js` 结构）
  - 输入 fixture：`资金对账导出不平.xlsx`（网关账单 + 渠道账单 sheet）
  - 覆盖用例（最少 6 组）：
    1. `网关 1v1` × Reference 取 `网关账单`：双 Type=0；Reference=网关行的 reconciliationId
    2. `网关 1v1` × Reference 取 `渠道账单`：双 Type=0；Reference=渠道行的 reconciliationId
    3. `网关 1v1` × Reference 取 `自取值-网关ReconID`：取网关行 reconciliationId
    4. `网关 1v多`（sum=300，3 笔渠道 100/100/100）：输入 1 笔丢弃 + 输出 3 笔；每笔 Type=1；Amount=对应渠道.receiveAmount；Reference 按选项；三笔渠道分别消费一次
    5. `网关 多v1`（3 笔网关 100/100/100，sum=300 ↔ 1 笔渠道 300）：输出 3 笔保持原 Amount；Type=2；Reference 按选项
    6. 全局约束验证：同一笔渠道账单不能被两组匹配复用（构造冲突 fixture 验证报错或正确路由）
  - 验收：`node scripts/smoke/recon-id-fix-engine-gateway.js` 退出码 0，console 输出 6/6 PASS
- **回归验证**：`node scripts/smoke/recon-id-fix-engine.js`（business 模式现有单测）全绿，确认无回归
- `npm run preview:account` 等 4 个 preview 全量重跑无差异（除新增 panel）
- 新增 ReconID 主面板（含账单类别下拉）preview 截图
- 新增 C4 dialog mode=gateway preview 截图（含 "网关 1v多" 勾选下的 "网关账单" 禁用态）
- `package.json.version` = `2.1.0-beta.3`
- CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 三件套同步
- `npm run scan:vars` 重跑（版本号 bump 触发硬节点）
- `/check-vars` skill 输出 PR body 的"⚠️ 关联功能 review"段落

---

## 七、实施记录

> 留空，PR 合并后由 team-lead 补充（参考 v2.1.0-beta.2 PRD §七）

---

## 八、PR 计划

**分支策略**：
- 工作分支：`v2.1.0-beta.3`（从 `v2.1.0` 切出）
- PR 目标：`v2.1.0-beta.3 → v2.1.0`，合 v2.1.0 后再开 PR `v2.1.0 → main`

**拆 PR**：根据复杂度，倾向 **单 PR 完成**（业务上是一个完整子模式上线，拆开 review 不易看全貌）。如 review 反馈过大再拆。

**预计工作量**：
- PM（spec + tasks 完整化）：0.5 天
- Dev：2-3 天（dialog 改造 + 引擎扩展 + 主面板布局 + 持久化 + 三件套）
- 手工自测：0.5 天
- PR + review 循环：1-2 天

合计：约 4-6 天

---

> **下一步**：用户 review 本 PRD → 起草 spec.md（文件级/符号级/行号级） + tasks.md（按 task 拆分） → 启动 Dev。
