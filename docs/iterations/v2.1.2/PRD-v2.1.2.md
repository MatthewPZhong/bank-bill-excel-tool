# PRD — v2.1.2 迭代：ReconID 修复文案变更 + 新增「月度银行对账单BU回填校验」模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.6（2026-05-13 OPEN ISSUE #5 重新拍板：BU 比较加大小写归一化（trim + toLowerCase）；对账单号匹配仍仅 trim 不归一化大小写） |
| 目标版本 | `v2.1.2` |
| 起始版本 | `v2.1.1`（PR #42 已合并 main，2026-05-12，commit `92ec7a8`） |
| 起草日期 | 2026-05-12 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft（待用户 review §六 OPEN ISSUE） |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | 对账单ReconID修复（C4 dialog 文案）/ 新增模块「月度银行对账单BU回填校验」 |
| 工作分支 | `v2.1.2`（基于 main `92ec7a8` 切出，PR 向 `v2.1.2 → main`） |
| 依赖 | v2.1.1（含 C4 dialog gateway 子模式 + BillDate ±N + 月度 Pending 数据核对模块完整流程） |

---

## 一、需求概述

v2.1.2 包含 2 块独立改动：

1. **T1 — 对账单 ReconID 修复模块文案变更**：仅 UI 可见文本，将 C4 dialog 内的「账单类型」→「对账字段」、「对账字段」→「对账内容」。内部变量名（`billTypes` / `reconFields` / `reconGroups`）全部保持不变。
2. **T2 — 新增模块「月度银行对账单BU回填校验」**：导入 T-1 月 Pending 数据管理文件 + 银行对账单文件，按**写死**的对账规则跑对账，导出 2-sheet 差异 Excel。前端 UI 复用月度 Pending 数据核对模块骨架（去掉「规则管理」按钮）。

---

## 二、背景与目标

### 2.1 业务背景

- **T1 文案变更**：v2.1.0 引入 ReconID 修复模块时，C4 dialog 沿用了"账单类型 / 对账字段"两个 label，但实际表达的语义更接近"对账时按哪些字段分组"+"用什么字段做对账映射"。用户希望命名更直观：「对账字段」（要对账的字段类别）+「对账内容」（具体内容映射）。
- **T2 新增模块**：每月做完 Pending 核对（v2.0.0 模块）后，业务还需要把 T-1 月银行对账单的 BU 回填情况与 Pending 系统记录的财务 BU 做一致性校验，找出"对账单号匹配上但 BU 标记不一致"的差异行。当前依赖人工核对。

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 命名清晰度 | ReconID 修复模块文案与用户业务表达更对齐 |
| 月度对账闭环 | Pending 核对 + 银行对账单 BU 回填校验 → 月度账务完整闭环自动化 |
| 差异定位 | 黄色高亮 BU 差异行，肉眼快速定位需要核实/订正的明细 |
| 学习成本 | 无规则管理 UI（规则写死），用户只需"导入→运行→导出"三步 |

### 2.3 目标（必做 / 不做对照）

| 必做 | 不做 |
|---|---|
| ✅ T1：C4 dialog label/按钮/确认弹窗/错误消息共 20 处文本替换 | ❌ T1：不改 `billTypes` / `reconFields` / `reconGroups` 等内部变量名 |
| ✅ T1：不改 SQLite schema、不改 config JSON 结构 | ❌ T1：不动 C1 / C2 / C3 dialog（仅 C4） |
| ✅ T1：preview 4 张 C4 dialog 截图重跑 | ❌ T1：不改算法逻辑（c4-recon-id-fix.js / recon-id-fix-engine.js） |
| ✅ T2：新模块独立入口（主菜单 + 主面板） | ❌ T2：不引入规则管理 UI（规则写死） |
| ✅ T2：主面板按钮 = `导入文件` + `开始运行` + `导出差异`（去掉「规则管理」） | ❌ T2：不引入 OCR / PDF / 远程 API |
| ✅ T2：复用 Pending 模块的"按月份导入 → 运行对账 → 导出差异"流程骨架 | ❌ T2：不引入"对账字段/对账内容"枚举/动态下拉等任何用户可配置项 |
| ✅ T2：对账规则写死 = `Pending.主对账单号 == 银行对账单.ReconciliationId` 匹配 + `Pending.财务BU vs 银行对账单.Remark-BU` 差异判定 | ❌ T2：不持久化"规则"（无可配置内容） |
| ✅ T2：差异表 2 sheet（Pending / 银行对账单），仅 BU 差异行整行黄色高亮 | ❌ T2：不导出"对账失败/未匹上对侧"侧数据（按用户原话：仅"对账成功"侧） |
| ✅ T2：模板文件 `assets/Pending数据管理.xlsx` + `assets/银行对账单.xlsx`（git 入库）| ❌ T2：不动 Pending 模块（v2.0.0 已有的 Pending.xlsx + 流程独立保留）|
| ✅ smoke：新增 2 用例（1 全 BU 一致无差异 / 1 部分 BU 差异） | ❌ T2：不引入 React/Vue（保持 vanilla JS） |
| ✅ version bump 2.1.1 → 2.1.2 + 三件套（CHANGELOG / VFH / USER_GUIDE） | — |
| ✅ 新模块 preview 入口（4 处：模块面板初始/导入中/差异结果/错误） | — |

### 2.4 明确不做

- **不动 C1/C2/C3 dialog**：「账单类型/对账字段」文本在 C2 dialog（renderer-dialogs.js:6494/6501）也出现，但 C2 是「抵消单据打标」场景，不属于 ReconID 修复模块。按用户决策"仅 UI 可见文本 + 仅 ReconID 修复"，C2 保持原样。
- **不改 v1.5.x / v2.0.0 / v3.0.0 分支**：v2.1.2 单独走 main → v2.1.2 → main。
- **不引入规则管理界面**：对账规则完全 hardcode 在引擎里，不暴露给用户。
- **新模块与 Pending 模块独立**：共享代码风格/UI 骨架，但 SQLite 表分开、状态对象分开、IPC 命名空间分开（`bankBuRecon:*` vs `pending:*`）。

---

## 三、需求拆解

### 3.1 T1 — ReconID 修复 C4 dialog 文案变更

#### 3.1.1 现状

`src/renderer-dialogs.js` 的 `createScenarioConfigDialogC4` (函数定义在 line 6711) 内，「账单类型」+「对账字段」共出现于：

| 行号区间 | 类型 | 出现内容 | 改动 |
|---|---|---|---|
| 6867 | dialog label | `账单类型` | → `对账字段` |
| 6870 | 按钮文案 | `+ 新增账单类型` | → `+ 新增对账字段` |
| 6874 | dialog label | `对账字段` | → `对账内容` |
| 6877 | 按钮文案 | `+ 新增对账分组` | → `+ 新增对账内容分组` |
| 5868 | 错误消息 | `账单类型至少需要 1 行` | → `对账字段至少需要 1 行` |
| 5872 | 错误消息 | `账单类型 #${n} 的"主/从"必填` | → `对账字段 #${n} 的"主/从"必填` |
| 5876 | 错误消息 | `账单类型 #${n} 至少需要 1 个条件` | → `对账字段 #${n} 至少需要 1 个条件` |
| 5878 | 错误消息 | `账单类型 #${n} 每行的字段不能为空...` | → `对账字段 #${n} 每行的字段不能为空...` |
| 5887 | 错误消息 | `账单类型必须至少包含 1 条"主边"账单类型` | → `对账字段必须至少包含 1 条"主边"对账字段` |
| 5888 | 错误消息 | `账单类型必须至少包含 1 条"从边"账单类型` | → `对账字段必须至少包含 1 条"从边"对账字段` |
| 5896 | 错误消息 | `对账字段至少需要 1 个分组` | → `对账内容至少需要 1 个分组` |
| 5899/5918 | 错误消息变量值 | `对账字段分组 #${n}` | → `对账内容分组 #${n}` |
| 5922 | 错误消息 | `... 左侧的账单类型序号 #${n} 不在账单类型列表中` | → `... 左侧的对账字段序号 #${n} 不在对账字段列表中` |
| 5924 | 错误消息 | `... 左侧必须指向"主边"账单类型` | → `... 左侧必须指向"主边"对账字段` |
| 5927 | 错误消息 | `... 右侧的账单类型序号 #${n} 不在账单类型列表中` | → `... 右侧的对账字段序号 #${n} 不在对账字段列表中` |
| 5929 | 错误消息 | `... 右侧必须指向"从边"账单类型` | → `... 右侧必须指向"从边"对账字段` |
| ~~7420~~ | ⚠️ Reverse Sync 修正：实际是 C2 (offset-bill-mark) 分支，**不在 T1 范围**，未改 | `账单类型：` | （保持原样） |
| ~~7421~~ | ⚠️ Reverse Sync 修正：实际是 C2 分支，**不在 T1 范围**，未改 | `对账字段：` | （保持原样） |
| ~~7425~~ | ⚠️ Reverse Sync 修正：实际是 C3 (gateway-recon-join) 分支，**不在 T1 范围**，未改 | `对账字段（AND）：` | （保持原样） |
| 7443 | 确认弹窗 label (C4 isReconIdFixCategory 分支) | `账单类型：` | → `对账字段：` |
| 7458 | 确认弹窗 label (C4 isReconIdFixCategory 分支) | `对账字段：` | → `对账内容：` |

**注意**：行号在实施时可能因 PR 时序漂移 ±5 行，以"符号名 / 函数块 / 上下文文案"为准。spec 阶段精确定位。

#### 3.1.2 不动的内容

- 内部变量名 `billTypes` / `reconFields` / `reconGroups` / `billTypeSeqs`（保持代码层不变）
- HTML data 属性 `data-c4-bill-types` / `data-c4-recon-groups` / `data-action="add-bill-type"` / `data-action="add-recon-field"` / `data-c4-action="add-recon-group"`（DOM 引用稳定）
- 代码注释 line 7138 `// 行 3：账单类型动态行` / 7237 `// 行 4：对账字段（reconGroups[]...）`：内部注释，建议在同一 commit 里顺手改成"对账字段动态行 / 对账内容（reconGroups[] - 每组 AND...）"以便代码层语义清晰
- C4 算法引擎 `src/main-process/scenario-engines/c4-recon-id-fix.js`、`src/main-process/recon-id-fix-engine.js`（纯算法层，无 UI 文本）
- 老 config 数据兼容（不需要迁移）

#### 3.1.3 验收

- 打开 ReconID 修复模块 → 新增场景 → C4 dialog：看到「对账字段」（旧"账单类型"位置）+「对账内容」（旧"对账字段"位置）
- 触发各种校验错误（空字段、缺主从边等）：看到错误消息全部用新文案
- 提交场景后弹出的"确认对话框"：看到 label 用新文案
- preview：4 张 C4 dialog 截图（business / gateway / 1vN / 主从都修复）重跑确认视觉无回归

### 3.2 T2 — 新增模块「月度银行对账单BU回填校验」

#### 3.2.1 模块定位

- **入口**：主导航/主菜单新增一项「月度银行对账单BU回填校验」（与「月度 Pending 数据核对」同级）
- **面板**：新增 `<section id="bankBuReconModulePanel" class="control-board module-panel bank-bu-recon-board" hidden>`（参照 `pendingModulePanel` 结构）
- **按钮**：3 个（去掉 Pending 模块的「规则管理」按钮）
  - `bankBuReconImportBtn` = `导入文件`（默认 disabled，选择月份+两个文件后可点）
  - `bankBuReconRunBtn` = `开始运行`（默认 disabled，导入完成后可点）
  - `bankBuReconExportBtn` = `导出差异`（默认 disabled，运行完成后可点）
- **状态栏**：`bankBuReconStatusBox`（参照 `pendingStatusBox`），含 spark + tone 错误高亮
- **数据持久化**：复用 Pending 模块的 SQLite 模式（按月份存导入数据 + 存运行记录），新建 2 张表（详见 spec.md）

#### 3.2.2 数据源 = 写死的模板表头

| 模板 | 路径 | Sheet 名 | 列数 | 关键列 |
|---|---|---|---|---|
| Pending 数据管理 | `assets/Pending数据管理.xlsx` | `sheet`（即第一个 sheet） | 20 | `主对账单号`（匹配 key）/ `财务BU`（差异字段） |
| 银行对账单 | `assets/银行对账单.xlsx` | `渠道对账单`（第一个 sheet） | 44 | `ReconciliationId`（匹配 key）/ `Remark-BU`（差异字段） |

读取约定：**按第一个 sheet 读取**（不 hardcode sheet 名），表头取第 1 行，数据从第 2 行起。

#### 3.2.3 对账规则（**完全写死**，不可配置）

1. **匹配 key**：
   - Pending.`主对账单号` (按 trim 后字符串相等比较) ↔ 银行对账单.`ReconciliationId`
2. **"对账成功"定义**（**1:1 / 1:N / N:1 都算成功**，详见 §6.2 v0.5 重写）：
   - **1:1 / 1:N / N:1** 匹配 → 算对账成功 → 进入 BU 差异比较
   - **N:M（双侧都 ≥2）** → 视为数据异常 → 跳过该组 BU 比较，但写入差异表第 3 个「异常」sheet（**不**中断运行）
3. **差异字段**：
   - Pending.`财务BU` vs 银行对账单.`Remark-BU`
4. **"差异行"定义**（标黄触发条件）：
   - 在对账成功的行对里：`trim(Pending.财务BU) !== trim(银行对账单.Remark-BU)` → 标记两侧的对应行为"差异行"
   - 字段值都 trim 后做字符串相等比较；空值（null / undefined / ''）归一化为空字符串
5. **未匹上对侧的行**：
   - **不输出**到差异表（按用户原话：仅"对账成功"侧的数据）
   - 但在状态栏统计里展示数量（"共 X 行对账成功 / Y 行 Pending 未匹上银行 / Z 行 银行未匹上 Pending / W 行 BU 有差异"）

#### 3.2.4 差异表导出

- **路径**：`Documents/网银账单生成小助手/exports/{date}/月度银行对账单BU回填校验_{YYYYMM}_{HHMMSS}.xlsx`
- **2 sheet**：
  - **Sheet 1 = `Pending`**：表头 = Pending数据管理.xlsx 全 20 列；行内容 = 所有对账成功的 Pending 行（去重）；BU 差异行整行背景色 `FFFF00` 黄色
  - **Sheet 2 = `银行对账单`**：表头 = 银行对账单.xlsx 全 44 列；行内容 = 所有对账成功的银行对账单行（去重）；BU 差异行整行背景色 `FFFF00` 黄色
- **样式实现**：项目已用 SheetJS（XLSX），背景色实现用 `s` 属性 + `xlsx-style` 或切换到 `exceljs`（spec 阶段确认 lib 选型；OPEN ISSUE-3）

#### 3.2.5 数据流

```
[用户点击「导入文件」]
   ↓
[弹月份选择对话框] → 选 YYYY-MM（参照 Pending 模块）
   ↓
[弹文件选择对话框] → 用户选 2 个文件:
   - Pending数据管理_YYYY-MM.xlsx (用户实际文件名)
   - 银行对账单_YYYY-MM.xlsx (用户实际文件名)
   (识别约定：按文件名关键字 "Pending" / "银行对账单" 区分；或弹两次选择，分别说明用途)
   ↓
[后台导入] → 解析两份表头是否匹配模板（关键列存在）→ 入 SQLite
   ↓ (导入完成，「开始运行」按钮亮起)
[用户点击「开始运行」]
   ↓
[后台对账]：
   构建 Pending.主对账单号 索引 → 遍历银行对账单.ReconciliationId 找匹配
   对账成功行对 → 比 财务BU vs Remark-BU
   ↓ (对账完成，「导出差异」按钮亮起)
[用户点击「导出差异」]
   ↓
[后台生成 XLSX] → 写盘到 exports/{date}/
   ↓
[弹"已生成 [文件名]，是否打开所在文件夹？" 对话框]
```

#### 3.2.6 验收

- 主面板入口可见，点击切换显示新模块
- 月份选择 + 文件选择流程顺畅；导入完成状态栏显示"已导入 YYYY-MM 数据 / Pending N 行 / 银行对账单 M 行"
- 运行对账：进度 spark 显示；完成后状态栏显示"对账完成 / 对账成功 X 笔 / BU 差异 Y 笔"
- 导出差异表：打开后 2 sheet 内容完整、表头完整、BU 差异行黄色背景肉眼可见
- smoke：新增 2 用例（1 全相等无差异 / 1 部分差异）
- preview：新增 4 张截图入口

---

## 四、风险与红线

⚠️ **资金红线区域**（资金 / 计费 / 对账 / 状态机）：
- T2 新模块的"对账成功 / BU 差异判定"逻辑属于资金对账类业务。**必须人工复核** smoke 用例 + 真实数据回放，**不能只看通过测试**。
- T2 差异判定的 false positive（误标差异） / false negative（漏标差异）都会误导财务/运营核账动作。spec 阶段需要明确"BU 比较"的语义（trim 范围 / 空值归一化 / 大小写是否敏感）。

⚠️ **破坏性变更**：
- T1 没有破坏性（仅文案）
- T2 不涉及现有 Pending 模块的 schema/逻辑（新模块独立）—— 无破坏性

⚠️ **关联功能 review**（按 `rules/important-variables.md` 软约束，spec 阶段精细对照）：
- T1 不动重要变量（仅文案）
- T2 新增表 schema + 新增 IPC 命名空间，需要做"重要变量升格评估"（spec 阶段确认是否进 important-variables.md）

⚠️ **数据隐私 / 文件落盘**：
- 差异表 + 模板表头都会落到 `Documents/网银账单生成小助手/`，无新增数据流出口

---

## 五、依赖与边界

| 依赖项 | 状态 |
|---|---|
| v2.1.1 (PR #42 合并 main) | ✅ 已就位 |
| `assets/Pending数据管理.xlsx` 模板 (20 列) | ✅ 用户已提供（May 12 23:17） |
| `assets/银行对账单.xlsx` 模板 (44 列) | ✅ 用户已提供（May 12 23:17，Apr 28 ctime） |
| C4 dialog gateway 子模式（v2.1.0-beta.3） | ✅ T1 文案变更要兼容覆盖 business + gateway 两个子模式 |
| Pending 模块完整流程（v2.0.0） | ✅ T2 复用其架构骨架 |

---

## 六、OPEN ISSUE 拍板记录

### 6.1 拍板状态总览

| # | 议题 | 拍板结果 | 拍板来源 |
|---|---|---|---|
| 1 | 主菜单/导航条目的中文标签 | ✅ **A**「月度银行对账单BU回填校验」 | 用户原话（PRD §一/§三命名） |
| 2 | SQLite 持久化方案 | ✅ **A** 新建 2 张表（`bank_bu_recon_imports` + `bank_bu_recon_runs`），按月份存导入数据 + 存运行记录 | 2026-05-12 用户拍板（"按月份储存数据和差异"） |
| 3 | 差异表黄色高亮实现 | ✅ **C** 优先查项目现有 lib；spec 阶段验证 SheetJS 是否可用，找不到再 fallback `xlsx-style`（A），慎重引入 `exceljs`（B） | 2026-05-12 用户拍板 |
| 4 | 文件导入识别方式 | ✅ **C** 一个「导入文件」按钮，点击后**按月份选择**对话框 → 顺序弹 2 次文件选择对话框（标题分别提示「Pending 数据管理文件」/「银行对账单文件」） | 2026-05-12 用户拍板 |
| 5 | BU 差异比较语义（**资金红线**） | ✅ **C** trim + toLowerCase + 空值归一（v0.6 重新拍板，原 A 因实际数据「Flowmore」vs「FlowMore」误报触发修订）：BU 字段两侧值各自 `String(v).trim().toLowerCase()`，空值（null/undefined/''）归一为 ""，再 `===` 比较；对账单号匹配仍仅 trim（不大小写归一） | 2026-05-12 → 2026-05-13 修订 |
| 6 | 对账失败侧是否输出 | ✅ **A** 不输出到差异表；状态栏统计展示数量 | 用户原话 |
| 7 | 差异表命名格式 | ✅ **A**「月度银行对账单BU回填校验_YYYYMM_HHMMSS.xlsx」 | 默认推荐通过（与 Pending 模块命名风格一致） |
| 8 | 版本号 | ✅ **A** v2.1.2（patch） | 用户原话 |
| 9 | T1 + T2 是否同一 PR | ✅ **A** 同一 PR（v2.1.2 → main） | 默认推荐通过 |
| 10 | 一对多/多对一/多对多匹配处理（**资金红线**） | ✅ **2026-05-13 重新拍板**（v0.5）：1:N + N:1 视为正常匹配；仅 **N:M（双侧都 ≥2）** 视为数据异常 → 跳过该组 BU 比较 + 写入差异表第 3 sheet「异常」+ 状态栏告警；**不**中断运行 | 2026-05-12 → 2026-05-13 修订 |

### 6.2 OPEN ISSUE #10 拍板详情（资金红线 — v0.5 重新拍板：1:N/N:1 正常 + N:M 异常 sheet）

**核心规则**（v0.5 修订）：
- **1:1 / 1:N / N:1** 匹配视为对账成功 → 进入 BU 差异比较
- **N:M（双侧都 ≥2）** 视为数据异常 → **跳过 BU 比较** + **写入差异表第 3 个「异常」sheet** + 状态栏告警
- **不再中断运行**（与 v0.4 的"严格 1:1"决定相反）

#### 6.2.1 匹配判定算法（伪码）

```
按 normalize(对账单号) 构建索引：pendingByKey, bankByKey

对每个对账单号 key（pendingByKey ∪ bankByKey 并集）:
  P_list = pendingByKey.get(key) || []
  B_list = bankByKey.get(key) || []
  
  case (len(P_list), len(B_list)):
    (0, _) / (_, 0): 单侧未匹上对面 → 不进入差异表（"对账失败"侧）
    (1, 1): 1:1 → 走 BU 比较（与 v0.4 一致）
    (1, N) where N≥2: 1:N → 走 BU 比较（v0.5 新增"正常"路径）
    (N, 1) where N≥2: N:1 → 走 BU 比较（v0.5 新增"正常"路径）
    (N, M) where N≥2 AND M≥2: N:M → 数据异常，跳过 BU 比较，加入 nmAnomalies 列表
```

#### 6.2.2 BU 差异判定（**精准标差异子对**，v0.5 新拍板 Q1=A）

```
对每个匹配组 (P_list, B_list)（已排除 N:M 异常）:
  case:
    1:1 (P1 vs B1):
      if normalizeBu(P1.财务BU) !== normalizeBu(B1.Remark-BU):
        标 P1 整行黄 + B1 整行黄
    
    1:N (P1 vs B1, B2, ..., BN):
      P1 整行**默认不标**
      对每个 Bi:
        if normalizeBu(P1.财务BU) !== normalizeBu(Bi.Remark-BU):
          标 Bi 整行黄  # 仅标不等的银行行
    
    N:1 (P1, P2, ..., PN vs B1):
      B1 整行**默认不标**
      对每个 Pi:
        if normalizeBu(Pi.财务BU) !== normalizeBu(B1.Remark-BU):
          标 Pi 整行黄  # 仅标不等的 Pending 行

normalizeBu(v):  # v0.6 修订 — 用于 BU 字段比较（OPEN ISSUE #5 改 C）
  v == null → ""
  否则 String(v).trim().toLowerCase()

normalizeKey(v):  # 用于对账单号匹配（不大小写归一，保留原行为）
  v == null → ""
  否则 String(v).trim()
```

**例**：1:N 场景 P1.BU=BU01 vs B1.BU=BU01 / B2.BU=BU02 / B3.BU=BU01
- Pending sheet: P1（不标）
- 银行 sheet: B1（不标）/ B2（黄）/ B3（不标）

#### 6.2.3 N:M 异常处理（v0.5 新拍板 Q2=C）

1. **不中断运行**：N:M 组跳过 BU 比较，但算法继续处理其他组
2. **跳过的 N:M 组不进入 Pending/银行 sheet**（不算"对账成功"侧）
3. **写入差异表第 3 个 sheet「异常」**：
   - 表头：`对账单号` / `Pending 匹配数量` / `银行匹配数量` / `Pending 行号` / `银行对账单行号`
   - 行内容：每个 N:M 异常组一行，行号用逗号拼接
4. **状态栏告警**：`{yearMonth} 对账完成：成功 X 行 / BU 差异 Y 行 / Pending 未匹上银行 Z 行 / 银行未匹上 Pending W 行 / N:M 异常 V 组`
5. **不再生成 .txt 错误报告**（v0.4 的 `error-reports/...txt` 文件不再产出）
6. **不再弹窗中断**：`createBankBuReconAnomalyDialog` factory 废弃
7. **状态机**：run.status 永远是 'success'；`bank_bu_recon_runs` 表 status 字段保留兼容性，但实际值不再用 'failed_anomaly'

### 6.3 spec 阶段还要确认的实施级议题（非用户决策）

- OPEN ISSUE #3 的「现有 lib 探查」结论（spec 阶段确认 SheetJS / 项目其它 dep 是否能写 cell fill）
- T1 文案变更的精确行号（PRD §三表格的行号"可能漂移 ±5"在 spec 阶段精确锁定）
- T2 SQLite schema 字段类型 / 索引 / 唯一约束
- T2 IPC 命名（建议 `bankBuRecon:import` / `bankBuRecon:run` / `bankBuRecon:export` / `bankBuRecon:status`）

---

## 七、实施记录（合并后回写）

_PR 合并后由 team-lead 补全 commit / PR 链接 / 验证结果。_
