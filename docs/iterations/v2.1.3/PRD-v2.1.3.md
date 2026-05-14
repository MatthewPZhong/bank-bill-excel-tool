# PRD — v2.1.3 迭代：新增模块「业务OP数据核对」

| 字段 | 值 |
|---|---|
| 文档版本 | v0.9（2026-05-14 round 3 self-review 修订：Codex 自动 review 1 P1 ⚠️ 资金红线（流水重导清该 date 所有 BU 的 runs/diff_rows，新增 `clearRunsAndDiffsByDate` 函数 + smoke Case P）+ 2 P2（package-lock.json 同步 2.1.3 / usage-stats 接入 17 IPC trackedIpcHandle）+ 1 P3（preview:all 串入 biz-op-recon）；v0.8 = 2026-05-14 round 2 self-review 修订（0 critical + 3 important + 5 minor）；v0.7 = 2026-05-14 round 1 self-review 修订（1 critical C1 clearByDateBu LOWER+TRIM + 3 important I1/I2/I3 + 5 minor + 3 新 smoke Case L/M/N）；v0.6 = 2026-05-13 fix6：区间导出改单 sheet，原 #14 拍板回滚；v0.5 = fix5 PRD 拍板修订；v0.4 = fix4 资金红线 bug 修复；v0.3 = fix1+fix2 手动测试回归；v0.2 = 14 项 OPEN ISSUE 全部拍板；v0.1 = 2026-05-13 起草） |
| 目标版本 | `v2.1.3`（patch） |
| 起始版本 | `v2.1.2`（PR #43 已合并 main，2026-05-13，commit `50e0a0a` / merge `fc5d766`） |
| 起草日期 | 2026-05-13 |
| 起草人 | team-lead（PM 角色） |
| 状态 | OPEN ISSUE 全部拍板完成（v0.2）+ fix1+fix2 手动测试回归完成（v0.3 — #10 拍板回滚 + 5 条 UI 微调），Dev 收尾 self-review |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | 新增模块「业务OP数据核对」（独立第 5 个主模块） |
| 工作分支 | `v2.1.3`（基于 main `fc5d766` 切出，PR 向 `v2.1.3 → main`） |
| 依赖 | v2.1.2（含「月度银行对账单BU回填校验」模块完整骨架，本模块复用其架构） |

---

## 一、需求概述

v2.1.3 包含 1 块独立改动：

1. **T1 — 新增模块「业务OP数据核对」**：在主导航中新增第 5 个模块，独立面板。功能为导入 T-2 / T-1 两日的业务 OP 数据 + T-1 日的流水对账单数据，按"业务OP T-2 期末余额 + 流水对账单当日发生额 = 计算 T-1 OP"的逻辑跑对账，与 T-1 日实际业务 OP 表的「期末余额」做精准差异比对，导出差异行 Excel（v0.3 fix2.4 回滚：**无颜色高亮**，差异类型由新增 4 列 meta 字段表达）。前端 UI 骨架与 v2.1.2 的「月度银行对账单BU回填校验」一致，但新增一个 **BU 单选下拉框**（位于「导出差异」按钮上侧，左侧标 "BU"），BU 枚举来自已导入业务 OP 数据的 `业务方` 字段去重。

---

## 二、背景与目标

### 2.1 业务背景

- **业务现状**：运营/财务 每天需要做 T-1 业务 OP 表的核对动作。当前方式是手工把 T-2 期末余额加上 T-1 当天流水累加值，对照 T-1 业务 OP 表的期末余额，肉眼找差异。账户数量大时极易看错且无法批量处理。
- **数据特征**：
  - 业务 OP 表（"业务方"字段标识 BU，按账户号汇报每日期末余额、发生额等 23 列）每天落一份
  - 流水对账单（每条流水一行，含"出入方向"+"对账金额"+"业务部门"等 28 列）每天落一份
  - 一份业务 OP 表内**可能同账户号多条 OP 行**（业务上正常，但需要逐条比对算出"哪条是对的"）
- **历史依赖**：本模块前端骨架与 v2.1.2 的「月度银行对账单BU回填校验」高度相似，但
  - 业务 OP 是**按日**维度（非按月）
  - 增加 **BU 单选下拉框**（v2.1.2 没有）
  - 导出按钮**拆为两个**（"导出指定日期" + "导出指定日期区间"）
  - 对账规则**完全不同**：基于"期末余额计算式"而非"对账单号匹配"

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 对账闭环 | T-2/T-1 业务 OP + 流水对账单 → 自动算出"应该的 T-1 OP" → 与实际 T-1 OP 自动差异比对 |
| 多 OP 行精准定位 | 同账户号多条 OP 时，自动标记"哪条期末余额对得上计算值、哪条对不上" |
| 账户增减可见性 | T-1 表有但 T-2 表无 / T-2 表有但 T-1 表无 的账户行差异自动列出（账户新增/销户检测） |
| 灵活导出 | 单日导出 + 日期区间汇总导出（每日一 sheet 模型由 spec 拍板） |
| BU 隔离 | 单选 BU，结果按 BU 维度跑对账，不串数据 |

### 2.3 目标（必做 / 不做对照）

| 必做 | 不做 |
|---|---|
| ✅ 新增主导航第 5 个模块「业务OP数据核对」 | ❌ 不动 v2.1.2 既有 4 个模块的任何逻辑（独立模块，独立 SQLite 表，独立 IPC 命名空间 `bizOpRecon:*`） |
| ✅ 主面板按钮 = `导入文件` + `开始运行` + `导出差异`（导出差异点击后弹窗内**再拆**两个子按钮：指定日期 / 指定日期区间） | ❌ 不引入规则管理 UI（对账规则完全 hardcode） |
| ✅ **BU 单选下拉框**位于「导出差异」按钮上侧，左侧标 "BU"，枚举值动态来自业务 OP `业务方` 去重 | ❌ 不引入"自由输入 BU"（必须从已导入数据来） |
| ✅ 业务 OP 模板表头：`assets/业务OP账单.xlsx`（23 列，已就位）；落库表 = `biz_op_recon_imports`（按日期 + BU 分片） | ❌ 不引入 OCR / PDF / 远程 API |
| ✅ 流水对账单模板表头：`assets/流水对账单.xlsx`（28 列，已就位）；落库表 = `biz_op_recon_flow_imports`（按日期分片） | ❌ 不引入 React/Vue（保持 vanilla JS） |
| ✅ 业务 OP 导入时按行**双重校验**（#1 拍板 B）：`(1) 发生额 == 发生额（入） - 发生额（出）` AND `(2) 期末余额 == 期初余额 + 发生额`，epsilon=1e-2；任一行不过 → **整批拒绝**（事务回滚）+ 失败报告导出（#5 拍板）| ❌ 不主动修复源数据（仅校验+整批拒绝，由用户修源文件后重新导入） |
| ✅ 流水对账单导入时按 `业务部门` 落库（不做余额校验）；但「出入方向」枚举强校验：仅允许「入」/「出」，其他视为脏数据 → 整批拒绝（#3 拍板）| ❌ 不容错「业务部门 != 业务方」字面差异（仅 `normalizeBu` = trim+toLowerCase 归一，#7 拍板 C） |
| ✅ 对账规则**写死**（4 步流程，详见 §3.4） | ❌ 不引入"对账阈值"配置（绝对值差额，不放宽容差） |
| ✅ 差异表导出：一文件一 sheet，sheet 内容 = 当日业务 OP 数据原 23 列 + 新增 4 字段（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额） | ❌ 不导出"无差异"的行（#10 拍板 E **fix2 回滚**：进表条件仍为 `比对T-2日 非空 OR 比对测算金额 == 不相等`；但差异行**不再标黄**，保留纯数据风格） |
| ✅ smoke 测试新增 ≥ 3 用例覆盖资金红线（核心对账 + 多 OP 行 + T-2/T-1 账户差） | ❌ 不强制覆盖所有边界（边界由 manual test 兜底） |
| ✅ version bump 2.1.2 → 2.1.3 + 三件套（CHANGELOG / VFH / USER_GUIDE） | — |
| ✅ 新模块 preview 入口 4 张截图（初始 / 导入中 / 运行结果 / 差异导出对话框） | — |

### 2.4 明确不做

- **不动 v2.1.2 模块**：v2.1.2 的「月度银行对账单BU回填校验」+ ReconID 修复 C4 dialog 文案 + 其余 3 个老模块完全保留原状。
- **不动 v1.5.x / v2.0.0 / v3.0.0 分支**：v2.1.3 单独走 main → v2.1.3 → main。
- **不引入对账阈值/容差**：测算金额差额按"绝对值差 > 0 即视为不相等"严格判定；不引入分/角级别容忍。
- **不主动修复源数据**：业务 OP 行校验失败时仅标记并阻断该行落库（或落异常表）；不调整数值。
- **不引入"按月查询 / 按月导出"**：本模块 100% 按日维度，跨日仅由"导出指定日期区间"承载。

---

## 三、需求拆解

### 3.1 模块定位

| 项 | 设计 |
|---|---|
| 入口 | 主导航新增第 5 个 `nav-module-btn data-module="biz-op-recon"`，文案「业务OP数据核对」 |
| 面板 | 新增 `<section id="bizOpReconModulePanel" class="control-board module-panel">` |
| 按钮（3 个，参照 v2.1.2 月度银行对账单BU回填校验骨架） | `bizOpReconImportBtn` = `导入文件` / `bizOpReconRunBtn` = `开始运行`（默认 disabled）/ `bizOpReconExportBtn` = `导出差异`（默认 disabled） |
| **BU 单选下拉框**（v2.1.2 没有） | `bizOpReconBuSelect`，位于「导出差异」按钮的**上侧**；左侧 label `<span>BU</span>`；选项动态来自 SQLite 中 `biz_op_recon_imports.bu_name` 字段 `DISTINCT` 抽取。**buList 为空** → 单一空白 placeholder option（继承 fix1.2）+ 按钮 disabled；**buList 非空** → **移除空白 placeholder**，默认选中第一项；smart preserve（上次 selectedBu 仍在新 buList 时保留，否则重置为第一项）（fix2.3 拍板）。option label **仅显示 BU 名**，不附加行计数（fix2.2 拍板）。BU 行容器视觉宽度与"导出差异"按钮左右边界对齐（fix2.1 拍板；CSS 实施细节属 §6.3） |
| 状态栏 | `bizOpReconStatusBox`（参照 `bankBuReconStatusBox`），含 spark + tone 错误高亮；初始文案 = `欢迎使用小助手` |
| 数据持久化 | 4 张表落主 DB（`tool-data.sqlite`）：`biz_op_recon_imports` / `biz_op_recon_flow_imports` / `biz_op_recon_runs` / `biz_op_recon_diff_rows`（详见 spec.md §四） |
| IPC 命名空间 | `bizOpRecon:*`（与 `bankBuRecon:*` 完全独立） |

### 3.2 数据源（模板表头）

#### 3.2.1 业务 OP 表（`assets/业务OP账单.xlsx`，23 列，已就位）

按表头 ASCII 顺序（实际从 grep 出 sheet 名 = `sheet`）：

| # | 表头 | 用途 | 校验规则 |
|---|---|---|---|
| 1 | Billdate | 业务上的"账单日期"。导入时**不**以此列定日期，以用户在弹窗里选的"业务OP所属日期"为准 | — |
| 2 | **业务方** | **★ BU 字段**，落库为 `bu_name`，作为 BU 下拉框枚举来源 | 非空 |
| 3 | 客户编号 | — | — |
| 4 | 主体 | — | — |
| 5 | **账户号** | **★ 匹配 key**（与流水对账单的 `账户编号` 做关联） | 非空 |
| 6 | 账户类型 | — | — |
| 7 | 币种 | 仅记录，不参与对账 | — |
| 8 | **期初余额** | **★ 双重校验 expr (2) 左侧** | 数值（参与双重校验） |
| 9 | **发生额** | **★ 双重校验 expr (2) 中段、expr (1) 左侧** | 数值（参与双重校验） |
| 10 | 发生额（入） | **★ 双重校验 expr (1) 右侧加项**（#1 拍板 B） | 数值 |
| 11 | 发生额（出） | **★ 双重校验 expr (1) 右侧减项**（#1 拍板 B） | 数值 |
| 12 | **期末余额** | **★ 双重校验 expr (2) 右侧 + 对账目标字段** | 数值 |
| 13 | 期末可用余额 | — | — |
| 14 | 期末冻结余额 | — | — |
| 15 | 最近更新时间 | — | — |
| 16 | 通道 | — | — |
| 17 | ppCardId | — | — |
| 18 | 银行卡号 | — | — |
| 19 | 扩展信息 | — | — |
| 20 | 账户状态 | — | — |
| 21 | BizId | — | — |
| 22 | 清结算系统创建时间 | — | — |
| 23 | 清结算系统更新时间 | — | — |

#### 3.2.2 流水对账单（`assets/流水对账单.xlsx`，28 列，已就位）

| # | 表头 | 用途 |
|---|---|---|
| 1 | BizId | — |
| 2 | 账单日期 | 业务上的"账单日期"。导入时**不**以此列定日期，以用户弹窗里选的"流水对账单所属日期"为准 |
| 3 | originBizId | — |
| 4 | 主体大账号 | — |
| 5 | 公司主体 | — |
| 6 | 流水类型 | — |
| 7 | **业务部门** | **★ BU 关联字段**（运行对账时 = 用户选的 BU 即业务OP "业务方"；语义对齐 `normalizeBu` = trim+toLowerCase，#7 拍板 C） |
| 8 | 对账主Id | — |
| 9 | **出入方向** | **★ 发生额正负号判定**（#3 拍板：仅允许中文「入」/「出」，入=+ 出=-；其他值视为脏数据 → NaN → 整批拒绝 + 失败报告） |
| 10 | 流水单号 | — |
| 11 | 用户编号 | — |
| 12 | **账户编号** | **★ 匹配 key**（与业务 OP "账户号" 做关联；字段名不一致需 reader 层做映射） |
| 13 | 拆分类型 | — |
| 14 | **对账金额** | **★ 发生额数值**（与「出入方向」组合得到正/负发生额） |
| 15 | 币种 | 仅记录 |
| 16 | 账户类型 | — |
| 17 | 流水开始时间 | — |
| 18 | 流水完成时间 | — |
| 19 | 渠道 | — |
| 20 | MerchantId | — |
| 21 | valueDate | — |
| 22 | BankRef | — |
| 23 | Pending标识 | — |
| 24 | 流水BizId | — |
| 25 | 穿透ID | — |
| 26 | 操作人 | — |
| 27 | 系统创建时间 | — |
| 28 | 系统修改时间 | — |

### 3.3 三大流程

#### 3.3.1 导入流程

**用户视角**：点「导入文件」按钮 → 后续连串弹窗

```
[导入文件] 按钮点击
   ↓
[阶段一：业务OP 导入]
   ↓
[弹"选择业务OP所属日期"对话框] — 标题下三个独立下拉框（年/月/日；#8 拍板 A：年=currentYear±1 = 2025/2026/2027，月=1-12，日=1-31，不联动；**默认值 = 系统日期 - 1 天**，fix1.4 拍板）
   ↓ 点"完成"
[弹文件选择对话框] — 选 *.xlsx
   ↓
[后台读取] → 表头校验（23 列严格匹配）→ 逐行**双重校验**（#1 拍板 B，epsilon=1e-2）：
  (1) 发生额 == 发生额（入） - 发生额（出）
  (2) 期末余额 == 期初余额 + 发生额
   ↓
[任一行不过] → **整批拒绝**（#5 拍板）：
  - 主表事务回滚（落 0 行）
  - 失败报告 xlsx 落 `Documents/网银账单生成小助手/error-reports/{date}/业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`
  - **状态栏文字提示 + 失败报告路径**（fix2 拍板：不再弹独立报错对话框；用户可直接 cmd+点击路径打开）
   ↓
[全部通过] → 同事务内（#15 拍板 A）：
  - DELETE 同 (date, BU) 旧业务 OP 数据
  - DELETE 同 (date, BU) 旧 runs + diff_rows
  - INSERT 新业务 OP 行到 `biz_op_recon_imports`（每行打上 `data_date` + `bu_name`）
   ↓
[判定：库里 (data_date, bu_name) 维度只有一日数据]：
  - 仅有一日 → 弹"已导入第 1 日数据，是否立即导入第 2 日？"确认对话框（#11 拍板 B）；点"是"再走一轮；点"否"状态栏提示
  - 已有多日 → 进入阶段二
   ↓
[阶段二：流水对账单 导入]
   ↓
[弹"选择流水对账单所属日期"对话框] — 标题下三个独立下拉框（年/月/日）；**默认值 = 系统日期 - 1 天**（fix2.5 增补，与业务OP 日期对话框一致）
   ↓ 点"完成"
[弹文件选择对话框] — 选 *.xlsx
   ↓
[后台读取] → 表头校验（28 列严格匹配）→ 「出入方向」枚举校验（#3 拍板：仅允许「入」/「出」，其他视为脏数据）
   ↓
[任一行「出入方向」非「入」/「出」] → 整批拒绝 + 失败报告（与业务OP 一致，#5）
   ↓
[全部通过] → 同事务内：DELETE 同 date 旧流水 → **`clearRunsAndDiffsByDate(db, date)` 清该 date 所有 BU 的 runs/diff_rows**（round 3 P1 资金红线修订：与业务OP 重导仅清单 BU 不同，流水按 date 跨所有 BU 共用，重导后该 date 所有对账结果失效，必须强制重跑）→ INSERT 新流水到 `biz_op_recon_flow_imports`（每行保留 `业务部门` 原值，对账时按 `normalizeBu` 归一比较）
   ↓
[状态栏显示]「业务OP（YYYY-MM-DD / BU=X）已导入 N 行 / 流水对账单（YYYY-MM-DD）已导入 M 行」
```

**幂等性**：
- 业务 OP 同 `(data_date, bu_name)` 重复导入：#4 拍板 A 替换 + 原子事务（DELETE + INSERT 同事务，并联动清空 #15 的 runs + diff_rows，按 (date, BU) 单 BU 清，函数 `clearRunsAndDiffsByDateBu`）
- 流水对账单同 `data_date` 重复导入：同样替换（DELETE + INSERT 原子事务；**流水不分 BU，按 date 级清空 + 同事务内调用 `clearRunsAndDiffsByDate(db, date)` 清该 date 所有 BU 的 runs/diff_rows**，round 3 P1 资金红线修订）

#### 3.3.2 运行流程

**用户视角**：点「开始运行」按钮

```
[开始运行] 按钮点击
   ↓
[弹"选择需要对账的日期"对话框] — 下拉只列 **ready 日期列表**（保持现状，**不**做"默认 T-1"处理；fix2.5 明确不改）
   ↓ 点"完成"
[后台对账]（核心算法见 §3.4 对账规则）
   ↓
[状态栏显示]「{YYYY-MM-DD} {BU=X} 对账完成: 测算金额差异 X 笔 / T-1 有 T-2 无 Y 笔 / T-2 有 T-1 无 Z 笔 / 多 OP 账户 W 个」
```

**前置条件**（#12 拍板 A 前置 enable）：BU 下拉框已选；"选择需要对账的日期"对话框下拉**只列 ready 日期**（即 T-1 业务OP + T-2 业务OP + T-1 流水对账单该 BU 三者齐全的日期）：
- T-1 业务 OP 数据（同 BU）
- T-2 业务 OP 数据（同 BU）—— T-2 = T-1 减一日
- T-1 流水对账单数据（同日期，过滤 `normalizeBu(业务部门) == normalizeBu(BU)`）

ready 日期列表为空 → 下拉为空 + "完成"按钮 disabled，状态栏提示"无可对账日期，请先导入完整 T-2/T-1 业务OP + T-1 流水对账单"。

#### 3.3.3 导出流程

**用户视角**：点「导出差异」按钮

```
[导出差异] 按钮点击
   ↓
[弹"导出差异"对话框] — 两个 radio 按钮（上下排列）+ 日期 / 区间联动控件
  - radio 1: 「导出指定日期」（默认选中）+ 单个日期下拉（仅 success 日期，#12+#13 一致）
  - radio 2: 「导出指定日期区间」+ 起始日期下拉 + 结束日期下拉
   ↓ 选 radio + 日期 + 点"导出"
[弹另存为对话框] — 默认文件名（#9 拍板 A）：
  - 指定日期：`业务OP数据核对_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`
  - 区间：`业务OP数据核对_{BU}_{YYYYMMDD}-{YYYYMMDD}_{HHMMSS}.xlsx`
   ↓
[后台生成 XLSX]
  - 指定日期: 文件 1 个 / sheet 1 个（sheet 名 = `YYYY-MM-DD` ISO 格式，#14 拍板 A，例 `2026-05-13`）
  - 指定日期区间（**fix6 拍板回滚**）: 文件 1 个 / **sheet 1 个名为「差异」**，所有日期的差异行合并到该 sheet；行排序 = data_date 升序 + 同 data_date 内 source_account_key 升序；**不引入「数据日期」列**，区分日期依赖原 xlsx 第 1 列 Billdate（**已知风险**：xlsx 原作者填的 Billdate 可能 ≠ 用户导入时选的 data_date，写 `console.warn` 日志辅助 debug，不弹 UI）。原 v0.5 设计 = 区间 sheet N 个（每日 1 sheet，sheet 名 = ISO）已废弃。
   ↓
[状态栏显示]「差异表已生成: {filePath}」+ 弹"已生成 {文件名}，是否打开所在文件夹？"
```

### 3.4 对账规则（**完全写死**，资金红线 ⚠️）

#### 3.4.1 算法 4 步流程（与用户原话一致，编号对齐）

**步骤 4.1：流水累加** — 计算"基于流水对账单的当日 T-1 BU 发生额合计（按账户号汇总）"
```
设 BU = 用户选的 BU
设 D = 用户选的对账日期（即 T-1）
从 biz_op_recon_flow_imports 表查询 (data_date == D) 行
过滤 normalizeBu(业务部门) == normalizeBu(BU)            // #7 拍板 C: trim+toLowerCase
按 账户编号 汇总:
  对每行: 当行发生额 = parseSignedAmount(出入方向, 对账金额)
           // #3 拍板：「入」→ +对账金额；「出」→ -对账金额；其他 → NaN（已在导入时拦截，对账阶段保证无脏数据）
  按 账户编号 累加 → 得到 Map<账户编号, 当日发生额合计>
```

**步骤 4.2.a：计算 T-1 OP** — 把 T-2 业务 OP 期末余额 + 当日发生额 = 算出来的 T-1 期末余额
```
从 biz_op_recon_imports 表查询 (data_date == D-1, bu_name == BU) 行 = T-2 业务OP 行
对每行 r:
  当日发生额 = Map.get(r.账户号, 0)
  计算 T-1 期末余额 = r.期末余额 + 当日发生额
  → 得到「计算 T-1 OP 表」(按账户号: 计算期末余额)
```

**步骤 4.2.b：测算金额差额比对** — 计算 T-1 OP 与 实际 T-1 OP 按账户号匹配，比较期末余额
```
从 biz_op_recon_imports 表查询 (data_date == D, bu_name == BU) 行 = T-1 业务OP 行
对计算 T-1 OP 表的每个账户号 k:
  P_list = T-1 业务OP 表中 账户号 == k 的行（可能 1 条 / N 条）
  若 P_list 为空: 标记"账户号 k 在 T-1 表中缺失"（进入步骤 4.3 类型 2 "T-2 有 T-1 无"）
  否则: 对 P_list 中每条行 r **逐行独立比**（#6 拍板 A，与 v2.1.2 1:N 精准标差异一致）：
    |r.期末余额 - 计算 T-1 OP[k]| > epsilon → r 标"不相等"
                                            → r.测算金额差额 = |r.期末余额 - 计算 T-1 OP[k]|
                                            → 整行进 diff_rows（**不再标黄**，#10 拍板 E fix2 回滚）
    |r.期末余额 - 计算 T-1 OP[k]| <= epsilon → r 标"相等"：
      ├ 单 OP 行（即 P_list.length == 1，同账户号多 OP = 否）：r 不进 diff_rows（相等单 OP 不导出，原规则保留）
      └ 多 OP 行（即 P_list.length >= 2，同账户号多 OP = 是）：**r 仍进 diff_rows**（fix5 选项 B 拍板，2026-05-13）：
          - r.比对测算金额 = "相等"
          - r.测算金额差额 = "" (空)
          - r.同账户号多个OP = "是"
          目的：用户视角下业务OP 表 N 行 → 差异表也应有 N 行可逐行审计追溯
    // N 条 OP 行各自独立标，可能出现 P[1]=相等 / P[2]=不相等 / P[3]=不相等 的混合
    // 该账户号的「同账户号多个OP」字段填 "是"（N>1）或 "否"（N==1），对每条 P_list 行都填同值
```

> **注**：epsilon = 1e-2（即 1 分钱），与 #1 双重校验使用同一精度门槛。

**步骤 4.3：账户号增减差异** — T-1 表 vs T-2 表的账户号差集
```
T1AccSet = {账户号 ∈ T-1 业务OP 表 (D, BU)}
T2AccSet = {账户号 ∈ T-2 业务OP 表 (D-1, BU)}

T1_not_in_T2 = T1AccSet \ T2AccSet    → 标记"T-1 有 T-2 无"
T2_not_in_T1 = T2AccSet \ T1AccSet    → 标记"T-2 有 T-1 无"
```

#### 3.4.2 数据流图

```
[T-1 流水对账单]            [T-2 业务 OP]            [T-1 业务 OP]
   (按账户号汇总              (按账户号取期末余额)        (按账户号取期末余额)
    当日发生额)
        │                          │                          │
        └──加法──→ [计算 T-1 OP] ──────→ [测算金额差额比对] ←─── (按账户号)
                   (按账户号:                  比较期末余额是否相等
                    计算期末余额)              不等则标差异 + 测算金额差额

                              ┌──── T1 vs T2 账户号差集 ────┐
                              │  T-1 有 T-2 无 / T-2 有 T-1 无 │
                              └──────────────────────────────┘
                                            ↓
                              [差异行 = 测算金额差异 ∪ 账户号增减差异 ∪ 多 OP 行]
                                            ↓
                              [导出差异 Excel: 当日业务 OP 原 23 列 + 4 新增字段；无颜色高亮，#10 拍板 E fix2 回滚]
```

### 3.5 差异表字段定义（输出 sheet 内容）

#### 3.5.1 sheet 内容来源

| 差异类型 | 来源行 | "比对T-2日"列值 | "同账户号多个OP"列值 | "比对测算金额" / "测算金额差额" |
|---|---|---|---|---|
| 测算金额差异（含多 OP 行标"不相等"子行） | T-1 业务 OP 原行 | 空字符串 | 是 / 否 | 不相等 / 差额绝对值 |
| **多 OP 行标"相等"子行（fix5 选项 B 拍板，2026-05-13）** | T-1 业务 OP 原行 | 空字符串 | 是（必定 = "是"） | 相等 / 空 |
| T-1 有 T-2 无 | T-1 业务 OP 原行（账户号不在 T-2 表中） | `T-1有T-2无` | 是 / 否 | 空 / 空 |
| T-2 有 T-1 无（**拍板 C**：追加到同 sheet 末尾，来源行取 T-2 业务OP 表） | T-2 业务 OP 原行（账户号不在 T-1 表中） | `T-2有T-1无` | 否（不参与 T-1 表内多 OP 判定） | 空 / 空 |

**fix5 选项 B 关键不变量**：
- 多 OP 账户（即同账户号 T-1 行数 ≥ 2）的**所有** N 条行都进 diff_rows（不论相等/不相等）
- 单 OP 账户标"相等"的行**仍不进** diff_rows（原规则保留，避免相等行无差异行也全量导出污染差异表）
- summary 统计层面：`amountDiffCount` 仅累计"不相等"行（相等多 OP 行不计入测算金额差异计数）；`multiOpAccountCount` 仍按账户号去重统计（fix4 口径不变）

#### 3.5.2 sheet 表头（业务 OP 23 列 + 新增 4 列）

| 列号 | 列名 | 来源 |
|---|---|---|
| 1-23 | 业务 OP 原表头（详见 §3.2.1） | 业务 OP 原表 |
| 24 | **比对T-2日** | 算法标记：`T-1有T-2无` / `T-2有T-1无` / 空 |
| 25 | **同账户号多个OP** | 算法标记：`是` / `否`（基于来源 T-1 业务 OP 表的同账户号行数；T-2 有 T-1 无 行固定填 `否`） |
| 26 | **比对测算金额** | 算法标记：`相等` / `不相等`（#2/B 拍板：多 OP=否 仍参与测算金额比对；epsilon=1e-2） |
| 27 | **测算金额差额** | 算法计算：`比对测算金额=不相等` 时 = `|期末余额 - 计算T-1期末余额|`；`=相等` 时为空 |

> **fix6（v0.6 拍板回滚）**：区间导出 sheet 结构与单日导出**完全一致**（23 + 4 列 = 27 列）；**不引入「数据日期」列**。区间 sheet 名固定 `差异`（不再按日期分 sheet）。区分日期请用原表第 1 列 Billdate。

#### 3.5.3 差异表样式规则（#10 拍板 E — fix2 拍板回滚 + fix5 选项 B 进表条件扩展）

差异表所有行**保持白底**（即"无颜色高亮"）。**差异类型仅通过新增 4 列的取值表达**，不再用颜色辅助：

| 差异类型 | 数据列表现 |
|---|---|
| T-1 有 T-2 无 | `比对T-2日 = "T-1有T-2无"` |
| T-2 有 T-1 无 | `比对T-2日 = "T-2有T-1无"`（来源 T-2 表） |
| 测算金额差异（含多 OP 中标不相等子行） | `比对测算金额 = "不相等"` + `测算金额差额 > 0` |
| **同账户号多 OP 标相等子行（fix5 选项 B 拍板，2026-05-13）** | **仍进 diff_rows 并导出**；meta「比对测算金额」=「相等」、「测算金额差额」= 空、「同账户号多个OP」=「是」。用于资金审计逐行追溯。 |
| 同账户号单 OP 标相等 | 不进 diff_rows + 不导出（原规则保留） |

**进表条件**（fix5 选项 B 拍板修订）：
```
进 diff_rows  ⇔  比对T-2日 非空  OR  比对测算金额 == "不相等"  OR  同账户号多个OP == "是"
```

writer 阶段保持**无填充色**（移除整行黄底）。

**回滚 + 修订理由**：
- fix2.4（v0.3）：用户在手动测试阶段提出"简化样式 + 保持差异表纯数据风格，便于后续在 Excel 里用筛选器自由查询" → writer 不再标黄
- **fix5（v0.5）**：用户测试 0512 BU=B2B 发现"业务OP 表 102201051506418034111_RECEIVING_CNH 账户有 2 行，差异表只有 1 行"，提出**选项 B**：多 OP 账户 N 行**全部**进差异表（不论相等/不相等）。理由：业务OP 表 N 行 ↔ 差异表 N 行**视觉一致**，资金审计场景可逐行追溯（原规则下"相等行被静默过滤"导致用户怀疑系统漏导出）

#### 3.5.4 multi_op_account_count 统计语义（fix4 补丁）

**定义**：状态栏文案「多 OP 账户 N 个」与 DB 字段 `biz_op_recon_runs.multi_op_account_count` 的统计口径。

**算法**：对一次对账运行 (BU, target_date)：
1. 取该 BU 该日的 **T-1 业务OP 全集** t1OpRows
2. 按账户号 group，统计 `accountKey → rowCount`
3. `multi_op_account_count = count(accountKey where rowCount >= 2)`（去重计数）

**关键不变量**：
- **不论 T-2 表是否含该账户号**：只要 T-1 业务OP 有同账户号 ≥ 2 条，就计入 multi_op_account_count（包括 onlyInT1 路径的多 OP 账户）
- **与差异表 meta 列「同账户号多个OP」同口径**：差异表每行的「同账户号多个OP」= "是/否" 基于同样的 T-1 全集 `countAccountRows(t1OpRows, accountKey) >= 2` 判定
- **不重复累加**：同账户号 N 行只算 1 个账户（即统计的是"账户号"维度而非"行"维度）

**回归测试**：smoke `scripts/smoke/biz-op-recon.js` Case I（I-1/I-2/I-3）覆盖：
- I-2：onlyInT1 多 OP（T-2 无该账户号 + T-1 有该账户号 ≥ 2 条）→ multi_op_account_count 仍非零
- I-3：同账户号 N 行只算 1 个（防重复累加）

**历史数据兼容**：
- 修复前已落库的 run 记录（`multi_op_account_count` 可能偏小）→ 用户重新跑对账（INSERT 新 run）即可拿到正确数
- 不需要批量回刷历史 run 数据（用户场景每天滚动覆盖）

#### 3.5.5 t2AnomalyAccountCount 统计语义（round 1 I3 新增）

**定义**：状态栏文案「T-2 异常账户 N 个」与 IPC `bizOpRecon:run` 出参 `summary.t2AnomalyAccountCount` 字段的统计口径。

**算法**：对一次对账运行 (BU, target_date)：
1. 取该 BU 该日的 **T-2 业务OP 全集** t2OpRows
2. 在 `computeT1Op` 内逐行 `parseAmount(r.end_balance)`：若返回 NaN → 调用 `console.warn(...)` 输出账户号 / BU / 期末余额原值 + 计入 `t2AnomalySeen: Set<accountKey>`（去重）
3. `t2AnomalyAccountCount = t2AnomalySeen.size`

**关键不变量**：
- T-2 期末余额非数值的账户号 → 跳过 `computedT1Map` 写入（与原行为一致，不退化）→ 该账户号在 §3.4.2 步骤 4.2.b 会走"T-1 有 T-2 无"分支（cmp_t2='T-1有T-2无'）
- **同账户号多行情况（部分 NaN 容错路径，round 2 R2-I2 补充）**：仅当**所有行都 NaN** 才标 anomaly + 跳过 `computedT1Map` 写入；任一行 valid 则用第一个 valid 行的期末余额（实际是循环中最后一个 valid 行；多行同账户号同 BU 同日期末余额业务上应一致）+ 该账户号 flowSum 写入 map，**不计入 anomaly**。code 实现（`src/main-process/biz-op-recon-session.js:135-160`）通过 `validAccountSet` 与 `anomalyAccountSet` 在循环结束后做集合差（`for (const acc of validAccountSet) anomalyAccountSet.delete(acc)`）。该行为属于 round 1 fix 时的设计延伸，比第 1 条规则更宽松，便于真实数据中部分行被 Excel 转码异常时仍能跑通对账（不退化为 silent drop 整账户）
- console.warn 仅辅助 debug，**不弹 UI / 不阻断流程**
- `t2AnomalyAccountCount === 0` 表示 T-2 数据干净；> 0 提醒用户核查 T-2 文件是否有"#N/A"/空字符串/非法字符等
- 不影响 `amountDiffCount` / `multiOpAccountCount` / `t1NotT2Count` 等其它统计字段

**回归测试**：smoke `scripts/smoke/biz-op-recon.js` 新增 Case L 覆盖（详见 spec §九 Case L assertion 草稿）。

**历史数据兼容**：
- 修复前已落库的 run 记录无 `t2AnomalyAccountCount` 字段 → 默认 `null`/`0`，前端状态栏兼容显示
- DB schema 增加 `t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0` 字段（migration 幂等）

#### 3.5.6 关键不变量补丁（round 3 P1 资金红线 ⚠️）

> **流水重导清 runs 不变量**（fix round 3 / Codex P1）：`runFlowImportAsync` 事务必须包含 `clearRunsAndDiffsByDate(date)` 调用；该函数清该 date **所有 BU** 的 runs + diff_rows（与业务OP `clearRunsAndDiffsByDateBu(date, bu)` 单 BU 清不同）。
>
> **资金红线**：流水换了对账没重跑 → 导出旧差异 = 资金事故。流水按 date 跨所有 BU 共用（流水表 `biz_op_recon_flow_imports` 不分 BU），重新导入同日流水后，该日期所有 BU 的旧 run 和 diff_rows 都失效，必须强制清空，避免旧 runId 套到新流水数据上输出错误差异。
>
> **与业务OP 重导对照**：
> - 业务OP 重导：`clearRunsAndDiffsByDateBu(db, date, bu)` — 按 (date, BU) 二元组清单 BU；其他 BU 的 run 不动
> - 流水重导：`clearRunsAndDiffsByDate(db, date)` — 按 date 跨所有 BU 清；该 date 全部 BU 的 run 都清
>
> **回归测试**：smoke `scripts/smoke/biz-op-recon.js` 新增 Case P 覆盖（构造同 date 多 BU 已 success run，重导该日流水后断言所有 BU 的 runs/diff_rows 均被清；详见 spec §九 Case P assertion 草稿）。

### 3.6 验收

- 主导航第 5 个按钮可见，点击切换显示新模块（v2.1.2 4 个老模块不受影响）
- BU 下拉框枚举随业务 OP 导入动态变化（导入 1 个新 BU 后下拉里多 1 项）
- 业务 OP 导入：表头错位 / 校验公式失败 / `(date, BU)` 重复导入 — 状态栏正确报错
- 流水对账单导入：表头错位 — 状态栏正确报错
- 运行对账：3 类差异（测算金额 / 多 OP / 账户号增减）正确分类
- 导出差异：单日导出 = 1 文件 1 sheet；区间导出 = 1 文件 N sheet（区间内每个有 success run 的日期一 sheet）
- 差异表所有行**无颜色高亮**（fix2.4 拍板回滚）；4 列 meta 字段（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）取值正确
- BU 下拉框：buList 非空时默认选中第一项 + 无空白 placeholder + option label 不含行计数（fix2.2/fix2.3 拍板）
- 业务OP / 流水对账单日期对话框默认值 = 系统日期 - 1（fix1.4 / fix2.5 拍板）
- 校验失败：状态栏文字 + 失败报告路径，无独立报错对话框（fix2 拍板）
- smoke：3 个新用例（核心对账 / 多 OP / 账户号增减）全部通过

---

## 四、风险与红线

⚠️ **资金红线区域**（资金 / 计费 / 对账 / 状态机）：
- 本模块核心算法（§3.4）属于**资金对账类**，与 v2.1.2 月度BU回填校验同级红线。
- **必须人工复核** smoke 用例 + 真实数据回放，不能只看 `npm run smoke` 通过。

⚠️ **资金红线 OPEN ISSUE 拍板结果固化项**（v0.2，必读）：
- **#1 业务OP 行校验 — 双重校验（B）**：
  - `(1) 发生额 == 发生额（入） - 发生额（出）` AND `(2) 期末余额 == 期初余额 + 发生额`
  - 浮点对比 `epsilon = 1e-2`（即 ±1 分钱以内视为相等）
  - 任一不过 → 该行视为脏数据，触发 #5 "整批拒绝 + 失败报告"
- **#3 出入方向枚举 — 中文「入」/「出」，入=+ 出=-（资金红线 ⚠️）**：
  - `signedAmount = (出入方向 === '入') ? +对账金额 : (出入方向 === '出') ? -对账金额 : NaN`
  - 任何**非「入」/「出」**的值（含空、错别字、大小写不一致、英文 DEBIT/CREDIT 等）→ NaN → 整批拒绝（参考 #5）
  - 该字段的正负号直接决定"计算 T-1 OP"数值方向，**错一个枚举直接资金事故**
  - **必须 smoke 用例 D 单独覆盖**，且人工 review 真实流水样本是否有非「入/出」的脏值
- **#5 校验失败 — 整批拒绝 + 失败行汇总导出**：
  - 任意校验失败行（业务 OP 双重校验失败 / 流水出入方向非「入/出」）→ 整批事务回滚，主表落 0 行
  - 同步生成 `业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`（输出路径 `Documents/网银账单生成小助手/error-reports/{date}/`，单 sheet，原 23 列 + 末尾「失败行号」+「失败原因」共 25 列）
  - 状态栏弹"校验失败 N 行，已导出至 [文件名]，是否打开所在文件夹？"对话框
  - 避免脏数据污染对账（主表干净度优先于"部分落库"的用户便利）
- **#6 多 OP 行 1:N 精准标差异**：
  - 同账户号 N 条 T-1 OP 行各自比对**单一计算值**，逐行独立标"相等"/"不相等"
  - 每行独立 push 进 `biz_op_recon_diff_rows`（v0.3 fix2.4 回滚：差异表 writer 不再标黄；不做"N 条全等才标"的妥协）
  - 与 v2.1.2 1:N 精准标差异子对完全一致
- **#7 normalizeBu — trim + toLowerCase**：
  - 与 v2.1.2 `normalizeBu` 完全一致；统一处理大小写 + 首尾空白差异
  - 仅用于 BU 过滤比较（流水 `bu_dept` vs 业务OP `bu_name`），**不改写落库原值**
- **#15 重新导入清空旧 runs**：
  - 同 `(bu_name, data_date)` 重新导入业务 OP 时，同事务内一并清空：
    - `biz_op_recon_imports` 同 (date, BU) 行
    - `biz_op_recon_runs` 同 (date, BU) 行
    - `biz_op_recon_diff_rows`（按 run_id 级联清）
  - 避免"用旧 runId + 新数据导出"的资金红线（v2.1.2 P1 fix 同款修复）

⚠️ **破坏性变更**：
- 无（独立新模块，不动既有数据/逻辑）

⚠️ **关联功能 review**（按 `rules/important-variables.md` 软约束）：
- 新增 `runBizOpReconciliation` 函数 → 建议升格 `Risk-sensitive`
- 新增 `validateBizOpRow` / `parseSignedAmount` 等 helper → 建议升格 `Risk-sensitive`（资金红线核心）
- 新增 `normalizeAccountKey` / `normalizeBu` 等 helper → 建议 `Important-skeleton`
- 新增 4 张 SQLite 表 + 新 IPC 命名空间 → T10 self-review 阶段重跑 `npm run scan:vars` 评估升格

⚠️ **数据隐私 / 文件落盘**：
- 差异表落 `Documents/网银账单生成小助手/exports/{date}/`，失败报告落 `error-reports/{date}/`，无新增数据流出口
- 业务 OP / 流水对账单 SQLite 表保存在 `tool-data.sqlite`（用户机器本地）

---

## 五、依赖与边界

| 依赖项 | 状态 |
|---|---|
| v2.1.2 (PR #43 合并 main，commit `50e0a0a`) | ✅ 已就位 |
| `assets/业务OP账单.xlsx` 模板（23 列） | ✅ 用户已提供（May 13） |
| `assets/流水对账单.xlsx` 模板（28 列） | ✅ 用户已提供（May 13） |
| v2.1.2「月度银行对账单BU回填校验」骨架（文件结构 / IPC / dialog 风格 / SQLite 表设计风格） | ✅ 复用参照 |
| Pending 模块完整流程（v2.0.0） | ⚪ 不直接复用（按 v2.1.2 复用即可） |
| ExcelJS（v2.1.2 已引入） | ✅ 已在 `dependencies` |

**不依赖**：
- PDF / OCR 链路（v2.1.1 起已移除）
- 任何外部网络服务

---

## 六、OPEN ISSUE 拍板记录

### 6.1 已拍板（18 项 — 用户全部确认；#10 v0.3 回滚 + fix1/fix2 5 条 UI 微调）

> v0.2（2026-05-13）将原 §6.2 的 14 项全部上移至本节，与原 A-D 共计 18 项。列定义不变。
> v0.3（2026-05-13）：用户手动测试 fix1+fix2 回归 — #10 拍板由 A 回滚为 E（不标黄），并新增 fix1/fix2 共 5 条 UI 调整（见 §6.4）。

| # | 议题 | 拍板结果 | 拍板来源 |
|---|---|---|---|
| A | BU 下拉框枚举来源 | ✅ **动态从业务 OP `业务方` 字段去重**（每次导入后基于 SQLite 中所有业务 OP `业务方` distinct 抽取，无业务 OP 数据时下拉为空） | 用户原话 |
| B | 「同账户号多 OP = 否」（单 OP 行）是否仍做测算金额对账 | ✅ **仍对账**：单 OP 行也比测算金额，期末余额≠计算 T-1 时"比对测算金额"=不相等、"测算金额差额"=差额绝对值；与需求 §5.3 原话不同（原话只在多 OP=是 时才填），需求需修订为"多 OP=否 仍可填"。**spec 阶段把此修订写入差异表字段定义** | 用户原话 |
| C | 「T-2 有 T-1 无」的差异行如何承载（一文件一 sheet 约束下） | ✅ **追加到同 sheet 末尾，来源行取 T-2 业务 OP 表**；"比对T-2日"列填 "T-2有T-1无"；这些行不参与"同账户号多 OP"判定（因来源不同表，定义在 T-1 表内重复），"比对测算金额"+"测算金额差额"两列**留空** | 用户原话 |
| D | 模板字段表头来源 | ✅ **用户提供示例文件入 assets/**；`assets/业务OP账单.xlsx`（23 列）+ `assets/流水对账单.xlsx`（28 列）均已就位 | 用户原话 |
| 1 | **业务 OP 校验公式中"发生额"字段歧义**（资金红线 ⚠️） | ✅ **B 双重校验**：`(1) 发生额 == 发生额（入） - 发生额（出）` **AND** `(2) 期末余额 == 期初余额 + 发生额`；任一不过 → 校验失败。浮点对比 `epsilon = 1e-2`（即 1 分钱）。spec §5.3 落实 `validateBizOpRow(row) → { ok, reason? }` 函数签名 | 用户拍板 2026-05-13 |
| 3 | **流水对账单「出入方向」取值枚举**（资金红线 ⚠️） | ✅ **中文「入」/「出」**，**入 = +、出 = -**；`parseSignedAmount(direction, amount)`：`direction === '入' → +amount`，`direction === '出' → -amount`，其他值 → `NaN`（视为脏数据，**整批拒绝 + 失败报告**，与 #5 一致）| 用户拍板 2026-05-13 |
| 4 | **业务 OP 同 `(data_date, bu_name)` 重复导入处理** | ✅ **A 替换 + 原子事务**：先 `DELETE FROM biz_op_recon_imports WHERE data_date=? AND bu_name=?`，再 `INSERT`；同一事务（参照 v2.1.2 `importMonthAtomic` 设计）。**配合 #15**：同事务内额外清空 `biz_op_recon_runs` + `biz_op_recon_diff_rows` 同 (date, BU) 记录 | 用户拍板 2026-05-13 |
| 5 | **业务 OP 校验失败行落库行为**（资金红线 ⚠️） | ✅ **整批拒绝 + 失败行汇总导出**：任意行校验失败 → 主表**事务回滚**（落 0 行）；同步生成失败报告 `业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`（保存到 `Documents/网银账单生成小助手/error-reports/{date}/`，单 sheet，原 23 列 + 末尾 2 列「失败行号」「失败原因」，原因示例 `双重校验失败：期末余额 ≠ 期初+发生额，差额 0.05`）；状态栏额外弹"校验失败 N 行，已导出至 [文件名]，是否打开所在文件夹？"对话框 | 用户拍板 2026-05-13 |
| 6 | **多 OP 行精准标差异语义**（资金红线 ⚠️） | ✅ **A 逐行独立比**：同账户号 N 条 T-1 OP 行各自与"计算 T-1 OP"（按账户号汇总单行）的 `期末余额` 比较；每条独立标"相等"/"不相等"（v0.3 fix2.4：差异表无颜色高亮）。与 v2.1.2 1:N 精准标差异子对语义一致 | 用户拍板 2026-05-13 |
| 7 | **流水对账单 `业务部门` vs 业务 OP `业务方` 等价语义**（资金红线 ⚠️） | ✅ **C trim + toLowerCase**：`normalizeBu(v) = v == null ? "" : String(v).trim().toLowerCase()`，与 v2.1.2 `normalizeBu` 完全一致 | 用户拍板 2026-05-13 |
| 8 | **日期下拉框年/月/日范围** | ✅ **A**：年 = `currentYear ± 1`（当前 2026 → 2025/2026/2027 三选项），月 = 1-12，日 = 1-31（**三个下拉不联动**，错选日期如 2026-02-30 由后端拒绝） | 用户拍板 2026-05-13 |
| 9 | **导出文件名格式** | ✅ **A**：指定日期 = `业务OP数据核对_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`；区间 = `业务OP数据核对_{BU}_{YYYYMMDD}-{YYYYMMDD}_{HHMMSS}.xlsx` | 用户拍板 2026-05-13 |
| 10 | **差异行黄色高亮触发条件** | ✅ **E（fix2 拍板回滚）—— 不做标黄处理**：差异表所有行保持白底；差异类型仅通过新增 4 列（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）的取值表达，不再用颜色辅助。**进表条件保留**（`比对T-2日 非空 OR 比对测算金额 == 不相等`）；writer 仅移除整行 FFFF00 填充。理由：fix2.4 用户手动测试中提出，简化样式 + 保持差异表纯数据风格，便于 Excel 筛选器自由查询。v0.2 原拍板 = A 三类差异都标 `FFFF00` 黄底。 | 用户拍板 2026-05-13（fix2.4 回滚） |
| 11 | **"库里仅有一日数据时再次触发"语义** | ✅ **B 弹确认对话框**：第 1 日导入完成后弹「已导入第 1 日数据，是否立即导入第 2 日？」；点"是"再走一轮业务 OP 导入流程；点"否"状态栏提示用户"待手动再次点击导入" | 用户拍板 2026-05-13 |
| 12 | **运行对账时前置数据缺失的处理** | ✅ **A 前置 enable**：在"选择需要对账的日期"对话框下拉**只列 ready 日期**（T-1 业务OP + T-2 业务OP + T-1 流水对账单该 BU 三者齐全的日期）；空列表时禁用"完成"按钮 | 用户拍板 2026-05-13 |
| 13 | **复用 v2.1.2 list-ready / success 模式** | ✅ **A 完全复用**：IPC `bizOpRecon:run:list-ready-dates` + `bizOpRecon:export:list-success-dates`；repository `listReadyDates({bu})` + `listSuccessDates({bu})` 同 v2.1.2 命名风格 | 用户拍板 2026-05-13 |
| 14 | **导出指定日期区间的 sheet 命名 + sheet 结构** | ✅ **F（fix6 拍板回滚）** — 区间导出**单 sheet「差异」**，所有日期合并；不再按日期拆 sheet。Sheet 内行排序：data_date 升序 + 同日内 source_account_key 升序。Sheet 内容：23 列业务OP 原表 + 4 meta 列 = 27 列（**不加新列**）。日期区分依靠原 xlsx 第 1 列 Billdate（**已知风险**：Billdate ≠ data_date 时筛选会混淆，写 `console.warn` 日志辅助 debug）。原 v0.5 拍板 = A `{YYYY-MM-DD}`（多 sheet 按日期分），用户在 fix5 测试通过后提出"不要 sheet 存放数据，差异要放在一个 sheet 里"，故回滚为 F。 | 用户拍板 2026-05-13（fix6 回滚） |
| 15 | **业务 OP 重新导入同日数据后清空旧 runs** | ✅ **A 清空**：同 `(bu_name, data_date)` 重新导入时同事务内 `DELETE FROM biz_op_recon_runs` + `DELETE FROM biz_op_recon_diff_rows`（关联 #4，统一在 `import:run-biz-op` 入口的原子事务里完成；参照 v2.1.2 P1 fix 经验） | 用户拍板 2026-05-13 |

### 6.2 待用户拍板

> v0.2: 全部已上移至 §6.1，本节清空。

### 6.3 spec 阶段还要确认的实施级议题（非用户决策）

- 4 张 SQLite 表的精确 DDL 字段类型 + 索引 + 唯一约束（spec.md §四 拍板）
- IPC handler 完整入参/出参 schema（spec.md §三 拍板）
- 差异表 ExcelJS writer 的列宽 / 字体 / 表头加粗 等样式细节（spec.md §六 拍板）
- 4 张 preview 截图的具体场景与触发条件（spec.md §七 拍板）
- **BU 行 CSS 宽度对齐"导出差异"按钮**（fix2.1）— 视觉约束，实施细节归 §6.3，PRD 仅提及

### 6.4 fix1 + fix2 + fix4 + fix5 + fix6 + round1 + round2 + round3 增补（v0.3 / v0.4 / v0.5 / v0.6 / v0.7 / v0.8 / v0.9 — 2026-05-13 ~ 2026-05-14）

> 用户手动测试 fix1+fix2+fix4+fix5+fix6 多轮回归后增补；2026-05-14 PR #45 提 PR 后 round 1 self-review 增补 9 条修订；同日 round 2 self-review 再增补 8 条修订（0 critical + 3 important + 5 minor）；同日 round 3 self-review 由 Codex 自动 review 补 4 条修订（1 P1 资金红线 + 2 P2 + 1 P3）；下列条目作为 §6.1 已拍板表的补充扩展。

**round 3 self-review 修订（2026-05-14，Codex 自动 review）**：

- **P1 ⚠️ 资金红线**：流水重导清该 date 所有 BU 的 runs/diff_rows
  - 影响 §3.4.1 流水流程 + §3.5.6 关键不变量 + spec §五 算法 + §九 smoke Case P
  - Dev 修法：新增 `clearRunsAndDiffsByDate(db, date)` 函数（按 date 跨所有 BU 清）+ 流水重导事务内调用 + smoke Case P 覆盖
  - 与 `clearRunsAndDiffsByDateBu(db, date, bu)` 区分语义：流水按 date 共用 → 跨 BU 清；业务OP 按 (date, BU) 分片 → 单 BU 清
- **P2 lockfile 同步 2.1.3**：Dev 跑 `npm install --package-lock-only` 处理（PM 不动 lockfile）
- **P2 usage-stats 接入**：FUNCTION_REGISTRY 注册「业务OP数据核对」+ 17 IPC trackedIpcHandle 包装
  - 影响 spec §三 IPC 表 tracked 标注
- **P3 preview:all 接入 biz-op-recon**：Dev 改 `package.json:71`（PM 不动 lockfile）

**round 2 self-review 修订（2026-05-14，PR #45 round 1 修订完成后再次过 reviewer agent；用户拍板"全修"）**：

- **R2-I1（UX 半成品）**：状态栏文案补 `t2AnomalyAccountCount`（仅 > 0 时显示「T-2 异常 W 个」；= 0 时不显示，避免噪声）— Dev 侧实施 `src/renderer.js` 状态栏渲染分支
- **R2-I2（spec ↔ code 偏差）**：PRD §3.5.5 关键不变量补"部分 NaN"容错路径描述（同账户号多行：仅全 NaN 才标 anomaly；任一 valid 则用 valid 行的期末余额写 map，详见 §3.5.5 第 2 条）
- **R2-I3（smoke 编号 + I2 回归覆盖）**：smoke Case L↔M swap 编号（按依赖顺序：先 C1 大小写归一防回归 → 再 I3 NaN 防回归）+ 新 Case O（I2 BU trim 落库前归一防回归，扩展原 Case N 的边界场景）
- **R2-M1（spec §三 IPC 表删假 handler）**：spec 描述中的 `bizOpRecon:import:pick-biz-op-date` / `bizOpRecon:import:pick-flow-date` 两个 handler 在 main.js / preload.js 实际不存在（日期选择由前端 dialog factory `createBizOpReconDatePickerDialog` 直接处理，不走 IPC）→ spec §三 IPC 表删除这两行 + §7.6 dialog 段补一句"日期选择由前端 factory 直接处理（不走 IPC，参考 `src/renderer-dialogs.js:8067`）"
- **R2-M2（`computeT1Op` 函数签名 spec ↔ code 对齐）**：spec §5.0.1 + §5.1 + §5.2 当前签名 `computeT1Op(t2OpRows, flowAggMap, t2AnomalySeen, buName)`；code 实际签名 `computeT1Op(t2OpRows, flowAggMap)` 返回 `{ map, anomalyAccountSet }` → spec 全部改为 code 实际签名 + 返回结构 + caller 改为 `const { map: calcT1ByAccount, anomalyAccountSet: t2AnomalyAccounts } = computeT1Op(...)`
- **R2-M3（console.warn 文案 spec ↔ code 统一）**：code 实际文案 `[biz-op-recon] T-2 end_balance NaN silent drop date=${t2Date} bu=${buName} account=${acc} (该账户在 T-1 实际 OP 与差异表均不可见，请检查源文件期末余额字段)` → spec §5.2 改为 code 实际文案（采纳 code 为 source of truth）
- **R2-M4（`subOneDay` 双源说明）**：`subOneDay` 在 `src/main-process/biz-op-recon-session.js:83` + `src/backend/biz-op-recon-db/run-repository.js:155` 双源定义（实现完全一致 — UTC + setUTCDate -1，避免时区抢跑），保留双源符合工程偏好（避免 backend → main-process 反向依赖）；新增双源说明：spec §五 算法签名表 `subOneDay` 行加备注（双源：session.js + run-repository.js — 维护需双侧同步）；rules/important-variables.md 升格 Risk-sensitive（资金红线 — 时区错乱直接错日期）
- **R2-M5（`AMOUNT_EPSILON` 位置同步）**：spec §5.0 当前描述 "在 src/main-process/biz-op-recon-session.js 模块顶部常量"；M2 round1 提取后单一来源在 `src/backend/biz-op-recon-db/columns.js:146`，session.js + validator.js import 该常量 → spec §5.0 改为新位置说明 + 强调"避免 import-time vs runtime epsilon 不同步的资金红线偏差"

**round 1 self-review 修订（2026-05-14，PR #45 提 PR 后 reviewer agent 给 1 critical + 3 important + 5 minor + 3 测试遗漏建议；用户拍板"全修"）**：

- **C1（资金红线）**：`clearByDateBu` BU 比较未对齐 `getRowsByDateBu` 的 `LOWER(TRIM(?))`，存在大小写差异时清不掉旧数据 → 改 `clearByDateBu` SQL WHERE 改 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`，与 `getRowsByDateBu` 完全一致
- **I1**：13 个 v2.1.3 新符号升格 `rules/important-variables.md`（详见 spec §十二，分布：Critical 2 + Important-skeleton 4 + Risk-sensitive 7）
- **I2**：`runBizOpImportAsync` 落库前归一化 BU 名（trim 保留大小写）— 避免源文件首尾空格导致 BU 下拉枚举出现 "BU-A" / " BU-A " 两条
- **I3**：`computeT1Op` T-2 NaN end_balance 加 `console.warn(...)` + summary 新增字段 `t2AnomalyAccountCount`（详见 §3.5.5）+ DB schema `biz_op_recon_runs.t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0`
- **M1-M5**：详见 spec §十三 round 1 修订记录
- **新 smoke**：Case L（I3 t2AnomalyAccountCount 防回归）+ Case M（C1 大小写差异 clearByDateBu 防回归）+ Case N（I2 BU 名首尾空白归一防回归）
- **known issue（不在 round 1 修，留 PRD §6.5）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗），v2.1.3 业务OP 模块当前缺失同位置 dialog；建议下一 round 或 v2.1.4 补齐 UX 对齐


**fix6（2026-05-13，PRD #14 拍板回滚）**：区间导出由多 sheet（按日期分）改为**单 sheet「差异」**（所有日期合并）。
- **不加「数据日期」列**，依靠原 xlsx Billdate 列区分（**已知风险**：Billdate 可能与 data_date 不一致 → console.warn 日志告警，不弹 UI）
- **行序**：data_date 升序 + 同日 source_account_key 升序
- **sheet 名**：固定「差异」
- **文件名**（`业务OP数据核对_{BU}_{YYYYMMDD}-{YYYYMMDD}_{HHMMSS}.xlsx`）**不变**
- **diff_rows DB schema 不变**；仅 writer 渲染层改动（`writeDateRangeDiffWorkbook` 由"N sheet 循环 add"改为"1 sheet 合并 add"+ 排序）
- **单日导出行为不变**：仍是 1 sheet（sheet 名 = `YYYY-MM-DD` ISO），fix6 只动区间

**fix5（2026-05-13，PRD 拍板修订）**：多 OP 账户 N 行**全部进差异表**（不论相等/不相等），原"相等行不进表"规则回滚。理由：用户视角 — 业务OP 表 2 行 → 差异表 1 行不直观，便于审计逐行追溯。影响 §3.4.1 步 4.2.b + §3.5.1 meta 列填法 + §3.5.3 进表条件 + §3.5.4 multi_op_account_count 语义（**不变** — fix4 修复后口径仍正确）。

> **注**：本次为 **PRD 拍板修订**（非代码 bug），fix1-fix4 实施时严格遵循 v0.3/v0.4 PRD"相等行不进表"规则；用户在 v0.4 测试中提出多 OP 视角下该规则反直觉。Dev 实施仅需调整 `compareT1OpWithComputed` 函数 1 处分支（相等多 OP 行也 push diffRows）+ 补 smoke Case J 回归。

**fix4（2026-05-13，资金红线 bug 修复）**：multi_op_account_count 统计漏算 onlyInT1 路径 → 修复 + 新增 smoke Case I（I-1/I-2/I-3 共 15 个 assertion） + 本 PRD §3.5.4 新增统计语义说明。

| # | 来源 | 内容 |
|---|---|---|
| fix1.4 | fix1 | **业务OP 日期 dialog 默认值 = 系统日期 - 1**（落地为 `subOneDay(today)` 计算） |
| fix2.5 | fix2 | **流水对账单日期 dialog 默认值 = 系统日期 - 1**（与 fix1.4 一致；明确**不改**"选择需要对账的日期"对话框） |
| fix2.1 | fix2 | **BU 行视觉宽度对齐"导出差异"按钮**（CSS 视觉约束，实施细节归 §6.3） |
| fix2.2 | fix2 | **BU option label 仅显示 BU 名**（去除 `(N 行)` 行数量附加） |
| fix2.3 | fix2 | **BU 下拉空白 placeholder 行为**：buList 为空 → 保留单一空白 option（继承 fix1.2）；buList 非空 → 移除空白 option + 默认选中第一项 + smart preserve（上次 selectedBu 仍在新 buList 时保留） |
| fix2.4 | fix2 | **OPEN ISSUE #10 拍板回滚**：差异表不做标黄处理（详见 §6.1 #10 行 + §3.5.3） |
| fix1.5 | fix1（清理） | `createBizOpReconErrorReportDialog` factory 已无业务调用 → fix2 一并删除（spec §7.6 dialog 列表同步从 6 个减为 5 个） |
| fix2（共性） | fix2 | 校验失败提示由"独立报错对话框"改为**状态栏文字 + 失败报告路径**（与 fix1.5 死代码清理联动） |
| **fix5** | **fix5（v0.5 PRD 拍板修订）** | **多 OP 账户 N 行全进差异表**（相等行也进；§3.4.1 步 4.2.b + §3.5.1 + §3.5.3 联动修订；compareT1OpWithComputed 相等多 OP 分支 push diffRows，meta = 相等/空/是） |
| **fix6** | **fix6（v0.6 PRD #14 拍板回滚）** | **区间导出单 sheet「差异」**（原多 sheet 按日期分回滚为单 sheet 全合并；不加新列依赖原表 Billdate 区分；data_date+account_key 排序；console.warn 日志告警 Billdate ≠ data_date；详见 §3.3 + §6.1 #14 + 上方 fix6 段） |
| **round1 C1** | **round1（v0.7 — 2026-05-14）** | **资金红线 — `clearByDateBu` BU 比较 SQL 改 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`** 与 `getRowsByDateBu` 完全对齐；smoke Case M 防回归（构造 "BU-A" 与 " BU-A " 大小写差异） |
| **round1 I1** | **round1（v0.7）** | **13 个 v2.1.3 新符号升格 `rules/important-variables.md`**（Critical 2 + Important-skeleton 4 + Risk-sensitive 7）；详见 spec §十二 |
| **round1 I2** | **round1（v0.7）** | **`runBizOpImportAsync` 落库前归一化 BU 名（trim 保留大小写）**；smoke Case N 防回归 |
| **round1 I3** | **round1（v0.7）** | **`computeT1Op` T-2 NaN end_balance 加 `console.warn` + 新字段 `summary.t2AnomalyAccountCount`**；DB schema `biz_op_recon_runs.t2_anomaly_account_count`；详见 §3.5.5；smoke Case L 防回归 |
| **round1 M1-M5** | **round1（v0.7）** | **5 minor 修订**；详见 spec §十三 round 1 修订记录 |

---

### 6.5 已知问题（known issues — round 1 self-review 增补）

> 已识别但本 round（round 1）暂不修，留迭代后续 round 或下个 patch 处理。

| # | 问题 | 影响 | 修复建议 |
|---|---|---|---|
| KI-1 | v2.1.2 月度BU回填校验同位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗对齐 UX），v2.1.3 业务OP 模块当前缺失 | UX 不一致；用户从月度BU模块切到业务OP模块后体验差异 | 下一 round（round 2）或 v2.1.4 补 `createBizOpReconFileImportPromptDialog` 在「导入文件」点击后、弹文件选择对话框前插入提示弹窗 |

---

## 七、实施记录

> 待 Dev 完成 PR 合并后回填。占位结构参照 PRD-v2.1.2.md §七：
>
> ### 7.1 PR #N 合并完成
> ### 7.2 实施提交时间线（M commits）
> ### 7.3 关键设计变更（与原 PRD v0.1 对比，若 OPEN ISSUE 拍板后有调整）
> ### 7.4 实测发现并修复的真 bug
> ### 7.5 资金红线最终验证
