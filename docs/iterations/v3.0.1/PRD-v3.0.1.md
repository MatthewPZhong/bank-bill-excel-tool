# PRD - 网银账单小助手 v3.0.1

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.1 |
| 日期 | 2026-06-09 |
| 作者 | PM（team-lead 收口） |
| 状态 | 初稿（待评审） |
| 模块 | 资金对账数据处理（bank-statement-process）、链接表管理（linked-table）、对账引擎编排（reconciliation-orchestrator）、业务OP数据核对、ADM 派生 |
| 依赖 | v3.0.0 baseline（先发 3.0.0，再从其后开 3.0.1 分支）；本迭代不依赖未合并 PR |
| 风险等级 | 🔴 高（需求1 含资金红线：链接表落库语义「整表覆盖→跨次幂等累加」+ schema 迁移）。⚠️ 原「对账消费标记」方案 2026-06-09 已移除，对账漏匹配风险 re-opened（见 §十） |
| 范围来源 | 5 份 change spec 收口：`changes/linked-gateway-bill-batch-idempotent/`、`changes/biz-op-recon-left-buttons-shift/`、`changes/gateway-recon-scenario-picker-style-fix/`、`changes/adm-derive-popup-only-when-data/`、`changes/r52-remove-reconid-overwrite-warning/`（✅ 已实施） |

> **本 PRD 是 v3.0.1 迭代的需求索引 + 正文**。每条需求的逐字根因与完整决策过程见各自 `changes/<change>/spec.md`；本文件汇总范围、目标、AC 与测试，作为评审与实施的单一入口。技术实现见同目录 `TECH_DESIGN-v3.0.1.md`。

---

## 一、需求概述

本次包含 **5 项需求**（1 项资金红线功能 + 3 项前端修复 + 1 项资金红线告警移除）：

1. **网关对账单链接表「批量导入 + 幂等累加 + 按日期删除」**（🔴 资金红线）—— 同类型多文件不再互相覆盖，改按 `ReconBillBizId` 跨次幂等累加；新增按日期范围删除。⚠️ 原计划的「对账消费标记」已移除，对账读取维持现状全表（reconid 跨期复用漏匹配风险未解，见 §十）。
2. **业务OP数据核对模块「BU 下拉 + 导出差异按钮」整体右移**（🟢 纯 UI）—— 左列两元素向右平移 `D/2 + 12px`，右列不动。
3. **网关对账单修复「场景选择弹框」样式修复**（🟢 纯 UI）—— 修复标题字号过大、文本贴边、排版错乱。
4. **ADM 派生链接表仅「派生出数据」时才弹「已创建」提醒**（🟡 前端文案）—— 0 行派生时静默，不再误报「已创建」。
5. **R5-2 调拨回填「覆盖非空原值告警」移除**（🔴 资金红线引擎 / ✅ 已实施）—— 去掉 `reconid-overwrite-backfill` warning，命中覆盖行为不变。本项已于 `v3.0.0` 分支实施完成（代码 + 单测，30/30 pass），故不另设 §五正文 / §六 AC / §七测试章节；逐字根因与改动清单见 `changes/r52-remove-reconid-overwrite-warning/spec.md`。

> ⚠️ **版本定级说明**：需求1 实为「功能新增」级别（语义化版本通常计 MINOR），需求 2/3/4/5 为 PATCH 级修复。经用户 2026-06-09 决策，5 项一并收口为 **3.0.1** 发布。评审时若希望严格遵循语义化版本，可将需求1 单独提为 3.1.0、其余留 3.0.1（见 §十 待澄清 Q1）。

---

## 二、背景与目标

### 2.1 背景

| 需求 | 为什么做 | 当前问题 |
|------|---------|---------|
| 需求1 | 用户需对同一类型网关对账单做多文件 / 跨期批量导入并累加 | 现状「逐文件 + 整表覆盖」：同时多选 3 个网关对账单，库里**只剩最后 1 个**，但前端 3 个都报「成功」→ **静默丢数据**（资金数据完整性陷阱） |
| 需求2 | 用户视觉反馈：业务OP核对模块左列两元素离右列状态框太远 | 左列（BU 下拉 / 导出差异按钮）在 grid 左轨道内居中，与右列间距过大，观感松散 |
| 需求3 | 用户反馈该弹框「样式错乱、标题字体大、文本贴框」 | `createGatewayReconScenarioPickerDialog` 混用两套弹框范式 + 漏 `.alert-body` 包裹层 |
| 需求4 | 用户导入无 `Channel=ADM` 行的银行对账单表后，仍弹「ADM银行对账单链接表已创建。」但实际派生 0 行 | 前端 `buildAdmDeriveHtml` 成功分支无 `total` 守卫，0 行也报「已创建」→ 误导用户、且旧 ADM 数据被静默清空无提示 |

### 2.2 目标

- **需求1**：①同类型多文件 / 跨次导入按 `ReconBillBizId` 幂等累加，不互相覆盖；②发生覆盖时在导入完成框提醒「N 条被覆盖」；③空 `ReconBillBizId` 行拒绝入库并计入提醒；④新增《删除》按钮按数据日期范围删除。（⑤原「对账消费标记」已移除——见 §2.3 / §十。）
- **需求2**：业务OP核对模块左列两元素整体右移 `D/2 + 12px`（D = 导出差异按钮右缘↔状态框左缘间距），右列与其它 3 个共用 `.pending-board` 的模块**零影响**。
- **需求3**：场景选择弹框对齐项目窄弹框范式——标题 16px、内容左右 28px 内边距、去 header 分割线、选项加 hover；交互逻辑零改动。
- **需求4**：ADM 派生 0 行时**不弹**「已创建」；派生出 ≥1 行仍弹「已创建」；派生异常仍弹失败；部分未匹配仍弹明细。

### 2.3 明确不做

- **不改**其它 3 张链接表（中台调拨 / 外汇交割 / 银行入金）的落库语义——它们幂等键各不同、`bank-deposit` 还牵动 ADM 派生，另立 spec（需求1 OPEN-2 已定）。
- **不动**对账引擎与编排器：原「对账消费标记」方案（`matched_flag` + 只读未标记 + 命中回写）2026-06-09 **整体移除**，对账读取维持现状全表，本期完全不碰 R1/R4/R5/C1/C2/C3 与 `reconciliation-orchestrator`。
- ⚠️ **由此不解决** reconid 跨期复用导致的对账漏匹配——它从「需求1 范围内的待解问题」降级为「已知风险，待用户决策」（§十 OPEN-7）。
- **不改** ADM 派生**后端**「重建即清空 + 清 `reconIdFixResult`」的现状语义——需求4 仅前端少弹一个提示（需求4 OPEN-2=方案A）。
- 三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）在 3.0.1 **转正发布时**统一更新（本 PRD 不含其正文）。

---

## 三、代码现状（必须有出处）

| 需求 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 需求1·导入 | `src/main.js:11218` `linked-table:import` | 多选文件 `for (const filePath of res.filePaths)` 逐个独立落库 | 逐文件覆盖，后者删前者 |
| 需求1·落库 | `src/backend/database/linked-table-repository.js:256`（`replaceLinkedTable`）/ `:297`（`replaceLinkedTableStreaming`） | `DELETE FROM 表` → INSERT 本批（整表覆盖，4 表共用） | 无 upsert；无法按字段幂等 |
| 需求1·表结构 | `src/backend/database/migrations.js:2674` `linked_gateway_bill` | 仅 `reconciliation_id`（普通索引）/`bill_date`/`raw_json`/`imported_at` | 无 `recon_bill_biz_id` 列、无 UNIQUE 约束 |
| 需求1·幂等键口径 | `src/constants/table-signatures.js:117-123` `GATEWAY_RECON_SIGNATURE` | `ReconBillBizId` 在 idx 13，精确大小写 `ReconBillBizId` | ⚠️ 表头大小写极不规则，取值须逐字符精确匹配 `raw_json['ReconBillBizId']`；**勿用** `gateway-recon-fields.js`（v2.0.0 旧硬编码，列名不一致） |
| 需求1·对账读取 | `linked-table-repository.js:334` `readLinkedTableRows('gateway-bill')` | 读**全表**喂对账编排器 | 累加多期后全表跑 → reconid 跨期复用 → R1/R5 漏匹配 |
| 需求1·对账消费 | `r1-recon-id-match.js:81-102` / `r5-fund-transfer-backfill.js:161-206` / `r5-platform-inbound-cleanup.js:85-125`；编排器 `reconciliation-orchestrator.js:164` | 网关↔银行 1v1「先到先得」单向消费；编排器透传不去重 | 同 reconid 后续网关行抢不到银行行 → **静默漏处理**（不报错） |
| 需求2·DOM/CSS | `index.html:185-214`；`styles-gemini-extra.css:935`（grid 1fr:1.4fr）/`:937`（左列居中）；`styles-gemini.css:136`（workspace-shell max-width 960）；`main.js:2843-2846`（窗口 minWidth 1080） | 左列内容居中在左轨道；`.pending-board` 被 4 模块共用 | 960<1080 ⇒ D 恒定，可写死 px；改公共 class 会殃及其它 3 模块 |
| 需求3·弹框 | `src/renderer-dialogs.js:10155-10163` `createGatewayReconScenarioPickerDialog`；`styles-gemini-extra.css:40-42`（dialog-title 22px）/`:31`（alert-card 420px）/`:861-866`（alert-message 无 padding）/`:850-852`（alert-body padding 28px） | 容器用 `alert-card`，内部却用 `dialog-header/dialog-title` + `alert-message`，漏 `.alert-body` | 两套范式打架 → 标题偏大、文本贴边、排版错乱 |
| 需求4·后端 | `src/main.js:11336-11363` ADM 派生段 | 0 行也回 `admDerive.created=true, total=0` | 后端始终重建（含清空 + 清 `reconIdFixResult`） |
| 需求4·前端 | `src/renderer-dialogs.js:6309-6320` `buildAdmDeriveHtml` | 成功分支只看 `unmatched.length===0` 即弹「已创建」，无 `total` 守卫 | 0 行误报「已创建」 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 链接表 | 资金对账数据处理模块的导入底表（网关对账单 / 中台调拨 / 外汇交割 / 银行入金），表名 `linked_*`；本期仅涉及 `linked_gateway_bill` |
| 整表覆盖 | 现状落库语义：`DELETE FROM 表` 后 INSERT 本批，后导入覆盖先导入 |
| 幂等累加（upsert） | 目标落库语义：按 `ReconBillBizId` 判重，命中覆盖该行、未命中追加，跨次保留 |
| `ReconBillBizId` | 网关对账单幂等键（精确大小写），本期判重唯一依据 |
| `reconciliationid` | 网关↔银行对账 join key（小写），**允许重复 / 跨期复用**，不再假设唯一 |
| D | 业务OP核对模块「导出差异按钮右缘 ↔ 状态框左缘」的水平间距（恒定值） |
| ADM 派生 | 银行对账单表中 `Channel='ADM'` 行派生出的隐藏链接表 `linked_adm_bank_deposit` |

---

## 五、功能详细描述

### 5.1 需求 1：网关对账单链接表「批量导入 + 幂等累加 + 按日期删除 + 对账消费标记」

#### 5.1.1 说明

- **输入**：用户在链接表管理界面多选 / 跨次导入网关对账单 xlsx；或点击《删除》按钮选日期范围。
- **输出**：①网关行按 `ReconBillBizId` 幂等累加入库；②导入完成框提醒覆盖条数（若有）+ 空键拒入条数（若有）；③按日期删除结果。
- **边界条件**：
  - 空 `ReconBillBizId` 行：**拒绝入库**并计入导入提醒。
  - 同 `ReconBillBizId` 重导：覆盖 raw_json/reconciliation_id/bill_date/imported_at。
  - 大文件（655k 行级）走流式 upsert，须保留「单事务跨 await + 中途 throw 全 ROLLBACK」。

#### 5.1.2 影响范围

- **数据库**：`linked_gateway_bill` 新增 `recon_bill_biz_id TEXT`（+ UNIQUE 索引）；幂等加列 + 回填 + 存量去重/空键清洗（migration）。
- **后端**：新增 `upsertLinkedGatewayBill`（数组 + 流式两版）、`linked-table:delete-by-date-range` handler；`linked-table:import` 网关分支改走 upsert。**对账编排器与网关读取口径不改**（消费标记移除）。
- **前端**：链接表管理弹窗加《删除》按钮 + 日期范围弹框；导入完成框增「覆盖 N 条 / 拒入 M 条」提醒。
- **对外接口影响**：IPC `linked-table:import` 返回新增 `results[].overwriteCount` / `rejectedEmptyCount`；新增 IPC `linked-table:delete-by-date-range`。
- **兼容性影响**：🔴 「整表覆盖→累加」是**语义破坏性变更**——用户旧心智「重导=清空」失效，须 UI 文案明确告知，并提供《删除》按钮作为「换一批数据」的手段。

#### 5.1.3 UI Mockup

```
[链接表管理 - 网关对账单表库]
  来源：最近导入 gw_2026Q1.xlsx（累计 3 个文件来源）   行数：12,840
  [ 导入 ]  [ 删除 ▾ ]                                  ← 新增《删除》按钮

  ── 点击《删除》 ──────────────────────────────
  [ 按数据日期范围删除 ]
    起始日期 [ 2026-01-01 ]   结束日期 [ 2026-01-31 ]
    将删除该范围内约 N 行，删除后不可恢复。   [ 取消 ]  [ 确认删除 ]

  ── 导入完成框（发生覆盖 / 拒入时）────────────
    本次导入 3 个文件，新增 8,200 行；
    其中 1,240 行命中已有 ReconBillBizId 被覆盖（更新）；
    42 行 ReconBillBizId 为空，已拒绝入库。
```

---

### 5.2 需求 2：业务OP数据核对模块「BU 下拉 + 导出差异按钮」整体右移

#### 5.2.1 说明
- **输入**：无（纯静态布局）。
- **输出**：左列两元素（行1 BU 下拉、行2 导出差异按钮）整体右移 `D/2 + 12px`。
- **边界条件**：右列（导入文件 / 开始运行 / 状态框）不动；BU 行 absolute label「BU」跟随右移、相对位置不变；按钮不溢出 / 不截断。

#### 5.2.2 影响范围
- **前端**：仅 `src/styles-gemini-extra.css` 追加一条 `#bizOpReconModulePanel .cell.left > *` 专属规则（`transform: translateX`）。
- **对外接口 / 数据 / 兼容性**：无。
- 🔴 **关键约束**：`.pending-board` 被 4 模块共用，**严禁**改公共 class，必须用 `#bizOpReconModulePanel` ID 圈定。

#### 5.2.3 UI Mockup
```
行1   [BU ▾]        →右移→        [导入文件] [开始运行]
行2   [ 导出差异 ]  →右移→        [   状态框   ]
      └ 左列右移 D/2+12px ┘        └ 右列不动 ┘
```

---

### 5.3 需求 3：网关对账单修复「场景选择弹框」样式修复

#### 5.3.1 说明
- **输入**：网关子模式启用 ≥2 个 `gateway-recon-id-fix` 场景 → 导入不平表 → 开始运行 → 弹出单选场景框。
- **输出**：弹框对齐项目窄弹框范式（标题 16px、内容左右 28px、去 header 分割线、选项 hover 高亮）。
- **边界条件**：弹框**交互逻辑零改动**（escapeHtml / radioName / onPick / 取消确认事件不动）；不影响其它弹框。

#### 5.3.2 影响范围
- **前端**：`src/renderer-dialogs.js:10145-10163` DOM 换用 `gateway-recon-picker-card` 专属范式；`src/styles-gemini-extra.css` 追加专属 CSS（11 行，见需求3 spec §二改动2）。
- **对外接口 / 数据 / 兼容性**：无。专属 class，不碰 `alert-card`/`dialog-*` 公共规则。

#### 5.3.3 UI Mockup
```
修复前（错乱）              修复后（对齐范式）
┌───────────────┐         ┌─────────────────────────┐
│选择要运行的场景│大标题贴边 │  选择要运行的网关对账单   │ 16px 标题
│○场景A         │贴边      │  修复场景                 │
│○场景B         │          │                          │
└───────────────┘         │   ○ 场景 A（hover 高亮）  │ 28px 内边距
                          │   ○ 场景 B                │
                          │            [取消] [确认]  │
                          └─────────────────────────┘
```

---

### 5.4 需求 4：ADM 派生链接表仅「派生出数据」时才弹「已创建」提醒

#### 5.4.1 说明
- **输入**：导入银行对账单表 / 中台调拨订单表触发 ADM 派生。
- **输出**：派生出 ≥1 行 → 弹「ADM银行对账单链接表已创建。」；派生 0 行 → **不弹**；派生异常 → 弹失败；部分未匹配 → 弹明细。
- **边界条件**：仅改前端「是否提示」，**不改**后端「重建即清空 + 清 `reconIdFixResult`」的现状（方案 A，完全静默）。

#### 5.4.2 影响范围
- **前端**：`src/renderer-dialogs.js:6316-6320` `buildAdmDeriveHtml` 成功分支加 `if (!admDerive.total) return null;`。
- **后端 / 数据 / 兼容性**：无改动。
- 📌 已知副作用（沿用现状，不在本次处理）：导入无 ADM 行的银行表仍会静默清空旧 ADM 表 + 清 `reconIdFixResult`，现在连提示都不弹（用户已确认方案 A 可接受）。

#### 5.4.3 UI Mockup
```
导入无 Channel=ADM 行的银行表：
  现状：批量导入明细框 →（确认）→ 弹「ADM银行对账单链接表已创建。」  ❌ 误导
  改后：批量导入明细框 →（确认）→ 直接回链接表管理（无 ADM 框）       ✅
```

---

## 六、验收标准

> 本章节共 **22 条** AC。

### 6.1 需求 1：网关对账单批量导入 + 幂等累加 + 删除 + 消费标记 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 一次多选 3 个 `ReconBillBizId` 互不相同的网关对账单 → 3 个文件全部进库（行数累加），无静默丢失 |
| AC1-2 | 跨次导入（先导 A、再导 B，B 的 `ReconBillBizId` 与 A 不重叠）→ 库内为 A∪B（不清空 A） |
| AC1-3 | 导入含与库内相同 `ReconBillBizId` 的行 → 该行被覆盖（raw_json/reconciliation_id/bill_date/imported_at 更新为新值），库内该 `ReconBillBizId` 仍只 1 行 |
| AC1-4 | 本次发生 ≥1 行覆盖 → 导入完成框提醒「N 条被覆盖」；`overwriteCount=0` → 不提醒覆盖 |
| AC1-5 | 导入含空 `ReconBillBizId` 行 → 该行拒绝入库，并在导入完成框提醒「M 条因 ReconBillBizId 为空被拒绝」 |
| AC1-6 | migration 在含空值 / 重复 `ReconBillBizId` 的存量库上启动 → 不抛错（先清洗后建 UNIQUE 索引），资金模块正常启动 |
| AC1-7 | 大文件（数十万行）走流式 upsert，中途人为抛错 → 整批 ROLLBACK，表保持事务前状态（不留半批） |
| AC1-8 | 《删除》按钮按日期范围删除 → 仅删 `bill_date` 落区间的行；删除后 meta（行数 / 最早 / 最晚日期）重算正确 |
| AC1-9 | `npm run release-check` 全绿（unit / integration / smoke）；R-1 真实重复 reconid 样本用于**评估**累加多期下的对账漏匹配程度（消费标记已移除、漏匹配未解，见 §十 Q7） |

### 6.2 需求 2：业务OP按钮右移 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 业务OP核对模块左列两元素整体右移，导出差异按钮右缘落在「D/2+12px」目标位置（与效果图一致） |
| AC2-2 | 右列（导入文件 / 开始运行 / 状态框）位置不变 |
| AC2-3 | 其它 3 个共用 `.pending-board` 的模块（pending 主 / bank-bu-recon / vcc-op-calc）**无任何位移** |
| AC2-4 | BU absolute label「BU」跟随右移、相对位置不变；按钮无溢出 / 截断 |

### 6.3 需求 3：场景框样式修复 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 弹框标题字号为 16px（不再 22px 过大） |
| AC3-2 | 内容（提示 + 选项）有左右 28px 内边距，不贴卡片边 |
| AC3-3 | header 无 border-bottom 分割线，整体排版不再错乱 |
| AC3-4 | 选项 hover 有高亮、圆角；单选交互（onPick / 取消确认）行为与改前一致 |
| AC3-5 | 其它弹框（用 `alert-card`/`dialog-*` 公共范式）视觉无变化 |

### 6.4 需求 4：ADM 派生提醒 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | 导入无 `Channel=ADM` 行的银行表（派生 0 行）→ **不弹** ADM 框，确认后直接回链接表管理 |
| AC4-2 | 导入有 ADM 行且全匹配（派生 ≥1 行、unmatched=0）→ 仍弹「ADM银行对账单链接表已创建。」 |
| AC4-3 | 派生异常（`created=false`）→ 仍弹「ADM 银行对账单链接表派生失败」 |
| AC4-4 | 派生出数据但部分未匹配 → 仍弹未匹配明细（含「请先导入中台调拨订单表」等） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 多文件累加 | 多选 3 个 ReconBillBizId 不重的网关对账单 | 库内已有数据 | 3 个全进库、累加、无丢失（AC1-1） |
| 幂等覆盖 + 提醒 | 导入与库内重叠 ReconBillBizId 的文件 | 库内已有该 BizId | 覆盖为新值、提醒 N 条覆盖（AC1-3/4） |
| 空键拒入 | 导入含空 ReconBillBizId 行的文件 | — | 拒入 + 提醒 M 条（AC1-5） |
| migration 存量兼容 | 在含重复/空 BizId 的旧库上启动 app | 旧版 `linked_gateway_bill` | 不抛错、正常启动（AC1-6） |
| 流式 ROLLBACK | 超大文件导入中途抛错 | 655k 行级文件 | 整批回滚、无半批（AC1-7） |
| ADM 0 行不弹 | 导入无 Channel=ADM 的银行表 | — | 不弹 ADM 框（AC4-1） |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 按日期删除 | 选日期范围删除 | 库内跨多期数据 | 仅删区间行、meta 重算（AC1-8） |
| 按钮右移回归 | 打开业务OP核对模块 | — | 左列右移、右列与其它 3 模块不动（AC2-*） |
| 场景框样式 | 触发场景选择弹框 | ≥2 启用场景 | 标题/内边距/hover 正确、逻辑不变（AC3-*） |
| ADM 正常派生 | 导入有 ADM 行的银行表 | — | 仍弹「已创建」/ 明细（AC4-2/4） |

### 7.3 不测项与原因

- 其它 3 张链接表的累加：本期明确不做（OPEN-2），无需测。
- 对账引擎 R1/R4/R5 内部算法：本期不改算法（消费标记在外层），仅回归其输入/输出口径（R-1 样本对账）。
- 真实多 GB 性能压测：流式骨架沿用 v3.0.0 已验证的 657,757 行回滚路径，回归而非新测。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 🔴 `linked_gateway_bill` 新增 `recon_bill_biz_id TEXT`（+ UNIQUE 索引 `idx_linked_gateway_bill_biz`）；migration 幂等加列 + 回填 + 存量去重/空键清洗。~~`matched_flag`~~ 不再新增（消费标记移除）。需求 2/3/4 无数据变更。 |
| 状态流转变更 | 落库语义由「整表覆盖」→「跨次幂等累加」。~~网关行消费状态机（未标记→已匹配）~~ 随消费标记移除。 |
| 权限 / 安全 | 不涉及鉴权 / 敏感数据外发。属本地 SQLite 资金对账数据，红线在数据完整性与对账正确性（见 §需求1 spec §四 R-1~R-4）。 |
| 回滚策略 | 需求 2/3/4 为前端，回滚 = 还原对应 CSS/JS。需求1 含 schema 迁移：新增列为加列（向后兼容，旧版忽略新列仍可读 raw_json）；UNIQUE 索引回滚需 `DROP INDEX`；落库语义回滚 = 还原为 `replaceLinkedTable`。建议在 `docs/ROLLBACK.md` 补 3.0.1 段。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 新增列幂等加列，旧库自动迁移；迁移须先清洗存量重复/空值再建 UNIQUE，否则资金模块启动失败（R-2 红线）。 |
| 性能 | 流式 upsert 不得退化为逐行自动提交，保留单事务（655k 行级）。 |
| 鲁棒性 | upsert / 删除 均单事务，中途 throw 全 ROLLBACK。 |
| 可观测 | 导入完成框显式报「覆盖 N / 拒入 M」，不静默；《删除》前二次确认显示将删行数（OPEN-6）。 |

---

## 十、待澄清问题（2026-06-09 拍板更新）

- [x] **Q1（版本定级）✅ 维持 3.0.1**：4 项一起发 3.0.1（需求1 虽 feature 级，语义化版本上从宽，用户确认）。
- [ ] **Q2（需求1·OPEN-5）**：累加后 `source_file_name` 怎么显示？建议「最近一次导入文件名 + 累计 N 个来源」，待确认（沿用默认）。
- [x] **Q3（需求1·OPEN-6）✅ 闭区间 + 直接删（无二次确认）**：《删除》日期范围闭区间 [起,止]，点「删除」即删、**不再弹二次确认框**。
  - 🔄 **2026-06-09 后续 UI 迭代（用户要求，拍板修订）**：原「删除弹框内**必须显著提示**『删除后不可恢复 + 将删约 N 行』」的拍板**已撤销**——用户要求去掉红色警告框 + 「将删约 N 行」计数显示。删除弹框简化为「选起止日期 → 直接删」，仅保留**后台 count 成功才允许点删除**的防误删门控（计数不再在 UI 显示）。详见 §十一。
- [x] **Q4（原 D2 资金边界）🗑 已失效**：随「对账消费标记」整体移除（用户 2026-06-09「对账消费标记有关的完全去掉」），已无 `matched_flag` 可处理，问题消失。
- [x] **Q7（🔴 需求1·对账数据范围·re-opened）✅ 已定：A 接受漏匹配**（用户 2026-06-09）。批量累加定位为「导入 / 存档不丢文件」；对账维持现状读全表，**累加多期 + reconid 跨期复用导致的 R1/R5 漏匹配作为已知限制被接受**，本期不做任何规避。⚠️ 实施时在导入提醒 / 用户文档适当告知此限制。
- [x] **Q6（需求1·迁移·存量空键）✅ 直接删除**：建 UNIQUE 索引前，存量库里 `ReconBillBizId` 为空的历史行**直接删除**（与新导入「空键拒入」同口径）。🔴 不可逆删除，migration **必须记录删除行数**到迁移日志。
- [ ] **Q5（需求3）**：场景选择弹框是否需新增独立 preview 入口（`preview:gateway-recon-scenario-picker`）？现疑无，实施时确认。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-09 | 初稿：收口 4 份 change spec（linked-gateway 批量导入 / 业务OP按钮右移 / 场景框样式 / ADM 派生提醒）为 v3.0.1 迭代需求 |
| 2026-06-09 | 拍板：Q1=维持 3.0.1（全部一起发）；Q3=《删除》闭区间 + 直接删（无二次确认）；Q4=重导不改标记值（matched_flag 自然保留）；Q6=存量空键存量行直接删除。剩 Q2（source_file_name 显示）/ Q5（场景框 preview 入口）走默认，实施时确认 |
| 2026-06-09 | 🗑 **移除「对账消费标记」整套**（用户「对账消费标记有关的完全去掉」）：删 `matched_flag`、对账只读未标记、命中回写、编排器改动及相关 AC（AC1-9~12）/ task / 测试。需求1 收敛为「批量导入 + 幂等累加 + 按日期删除」。⚠️ 对账漏匹配风险 re-opened（Q4 失效、新增 Q7）。AC 总数 25→22 |
| 2026-06-09 | 拍板 **Q7=A（接受漏匹配）**：批量累加定位为导入/存档不丢文件，对账维持全表、reconid 跨期复用漏匹配作为已知限制接受，本期不规避。需求1 需求层面再无待决项 |
| 2026-06-09 | 🔄 **删除弹框 UI 迭代（用户连续调整，🔴 资金红线提示撤销）**：①去掉红色「不可恢复 + 将删约 N 行」警告框（含计数显示）——撤销 Q3/OPEN-6「必须显著提示」拍板，删除仅保留后台 count 门控防误删；②弹框宽度减半（940→470px）；③正文去「仅支持删除…」+ 标题去「（按日期范围）」；④body 内容右移对齐标题。另：场景管理「网关对账单修复 [管理]」入口右移 400px；场景名称列显示层去前缀「资金性质校验-」（不改 DB）。均纯前端、已 preview + release-check 验。 |
| 2026-06-09 | 收口**需求5（R5-2「覆盖非空原值告警」移除**，🔴 资金红线引擎）：用户拍板「只删告警，覆盖照旧」；代码 + 单测已实施，单测 30/30 pass。范围来源 4→5 份 change spec，需求总数 4→5 项。残留风险：覆盖已有对账 ID 改为静默无审计痕迹（用户已接受） |

---

## 十二、实施记录

> 由 PR merged + 归档后追加，PM 不需手动填写。

### 2026-06-09 实施进度（需求1-4，本工作流 team-lead 收口；PR 前快照，最终归档记录待 merge）

team-lead 拆 9 task 委托 dev 逐个实施、逐 task `release-check` 验收；每个 task 由 team-lead 自审 diff + 自跑测试兜底（不只听 dev 汇报）。**全程未 commit**（待用户手测后明确「提 PR」）。

| task | 内容 | 涉及文件 | 验证 |
|------|------|---------|------|
| 1 | migration：`recon_bill_biz_id` 列 + 回填 + UNIQUE + 存量清洗 | `migrations.js` | UT-GW-BIZ ×3。🔧 修复初版 `console.warn` 违反架构守护 Case 6 → 改 `appendModuleLog(warning)` |
| 2 | 网关专用 `upsertLinkedGatewayBill`（数组+流式）+ overwriteCount + 空键拒入 + meta 全表重算 | `linked-table-repository.js`、`database.js` | UT-UPSERT ×7（含 ROLLBACK） |
| 3 | `linked-table:import` 网关分支改 upsert + 回传计数 | `main.js` | 集成 `v3.0.1-linked-gateway-upsert` |
| 4 | `linked-table:delete-by-date-range` + `count-by-date-range` handler + DB + meta 重算 | `main.js`、`linked-table-repository.js`、`preload.js`、`database.js` | UT-DEL ×4 + 集成 Step7 |
| 5 | 链接表管理《删除》按钮 + 日期范围弹框（实时计数 + 不可恢复警告）+ 导入完成框覆盖/拒入提醒 | `renderer-dialogs.js`、`renderer-previews.js`、`renderer.js`、`package.json` | preview `linked-table-delete-range` + release-check |
| 6 | 业务OP左列右移（实测 D=147px → SHIFT=85.5px） | `styles-gemini-extra.css` | preview `biz-op-recon` ×4 + 像素级隔离证明（另 3 模块无变化） |
| 7 | 网关场景选择框 DOM + 专属 CSS | `renderer-dialogs.js`、`styles-gemini-extra.css`、preview 接线 | preview `gateway-recon-scenario-picker` |
| 8 | `buildAdmDeriveHtml` 加 `total` 守卫（需求4） | `renderer-dialogs.js` | 手测 3 路径 |
| 9 | 文档三件套 + 本实施记录 | CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE / 本 PRD | — |

- **质量门**：每 task `npm run release-check` 全绿；末态 **unit 2075 / integration 19 脚本（含新增 `v3.0.1-linked-gateway-upsert` 40 断言）/ smoke 全过**。
- **OPEN-5（Q2，`source_file_name` 累加显示）**：本期沿用默认（仓储 `recomputeGatewayMeta` 写入「最近一次来源名」），未做「N 个来源」拼接，评审如需再调。
- **Q5（场景框 preview 入口）**：已实施时新增 `preview:gateway-recon-scenario-picker`（原 spec 疑无，现已补）。
- **需求5（R5-2 覆盖告警移除）**：🔴 资金红线引擎，由另一资金对账工作流并行落地（见 §十一 2026-06-09 末条）；本工作流未实施、未触碰 `r5-fund-transfer-backfill.js`，其实施/归档记录由该线补充。
- 🔴 **提 PR / 版本 bump 前硬节点**：`npm run scan:vars` + `/check-vars` 尚未执行（留待两条工作流汇合、用户手测后定稿发版时统一跑）；`package.json.version` 仍为 3.0.0，未 bump。
