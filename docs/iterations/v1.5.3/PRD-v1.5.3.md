# PRD - 网银账单小助手 v1.5.3

> **版本：v1（定稿）**
> v0 的 13 个待确认点已全部收到用户答案；本版本为 PM v1 定稿，所有规则改为直述表达。决策记录见 §十。

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.3（v1 定稿） |
| 日期 | 2026-04-20 |
| 作者 | PM |
| 状态 | 定稿（v1） |
| 模块 | 主页面「模式」下拉 / 月度余额账单导出 / 银行账号信息导入（自有账号合并）/ Excel 导出表头字体 |
| 依赖 | v1.5.2 已 merged 到 v1.5.x；v1.5.3 从 v1.5.x 分支继续开发 |
| 基版本 | 1.5.2（commit `6e5df3a` 基线） |

---

## 一、需求概述

本次包含 **3 项需求**：

1. **R1 — 主页面「模板」→「模式」+ 月度余额账单导出**：顶栏"模板"下拉改名为"模式"，枚举值仅两条：
   - 「制作网银账单」= 现 v1.5.2 的网银账单生成流程（保留不变，内部强制使用"按文件名映射模板"）
   - 「导出月度余额账单」= **新增模式**，用于按模板 + 按月直接从 balance-seeds 导出月度余额账单
2. **R2 — 银行账号导入合并「自有账号」到大账号表**：导入银行账号信息 Excel 时，`ownAccounts`（自有）与 `clientAccounts`（客资）一起进入大账号表 `template_big_accounts`；新增字段 `account_nature` 区分两类。历史 `own-accounts/{bankName}.json` 启动时一次性迁移。
3. **R3 — 导出 Excel 表头字体改为 Courier New**：明细账单（COMMON）与余额账单（BALANCE）两类导出 xlsx 的**表头行**（第 1 行）使用 Courier New 字体。数据区字体不变。

---

## 二、背景与目标

### 2.1 背景

**R1 — 模式切换**
- 当前主页面顶栏"模板"下拉的值域是"全部已配置的真实模板 + v1.5.2 新增的 `__FILENAME_MAPPING__`（按文件名映射模板）"（`src/renderer.js:1617 updateTemplateSelect`、`index.html:47-48`）。这个下拉同时承担了两个语义：选择**要解析哪家银行的账单** + 间接决定要不要走按表头自动识别。
- 用户反馈：月度余额账单的导出需求（比如月末给财务团队交"全部银行大账号 3 月最后一日余额"）目前**没有对应入口**；若要导出就得**走"制作网银账单"→导入→生成**这一整条流程，但月度余额账单的数据来源其实是 **balance-seeds 本地文件**，不需要新的账单文件导入。
- 目标：把主页面顶栏下拉改成真正的"**模式**"语义，模式值只有两条；月度余额账单作为独立模式，共享"导入模板 / 模板管理 / 导出余额"三条按钮，屏蔽"导入文件 / 导出明细 / 账户映射"。

> 注意：当前应用顶部已经存在一个"模块切换器"`moduleSwitcherBtn`，可以在 `网银账单生成 / 新开账户余额账单生成` 两个顶层模块之间切换（`index.html:30-39`、`src/renderer.js:31-40`）。本次 R1 是在 `网银账单生成` 这个顶层模块内部把"模板"下拉改为"模式"下拉，**不触碰顶部的模块切换器**——两层是不同粒度的切换。

**R2 — 自有账号合并**
- 当前代码：`parseBankAccountExcel`（`src/backend/bank-account-import.js:44-72`）按 `账户性质` 字段把行分为 `clientAccounts` 和 `ownAccounts`。`clientAccounts` 随 `bigAccount.importBankInfo` 返回给前端、后续作为"维护大账号"对话框的初始行；`ownAccounts` 通过 `big-account:save-own-accounts` IPC（`src/main.js:6207-6225`）写到 `{storageRoot}/own-accounts/{bankName}.json`（`src/backend/own-account-store.js`）。
- 用户反馈：自有账号也需要进入大账号表（原话："导入银行账号信息时，自有账户也需被导入进维护大账号的大账号表里"），以便后续统一在"维护大账号"对话框里管理，并且能被 R1 月度余额导出链路读取到。
- 目标：取消自有/客资的 UI/存储分叉，两类统一进 `template_big_accounts` 表，并用 `account_nature` 字段区分。

**R3 — 导出字体统一 Courier New（仅表头）**
- 当前导出：明细走 `writeWorkbookRows`（`src/backend/file-service/writers.js:193`），余额走 `writeBalanceWorkbook`（`src/backend/file-service/writers.js:205`）。明细是 `aoa_to_sheet` 新建 worksheet（无字体设置）；余额是读模板 xlsx 并保留样式（`cellStyles: true`，`writers.js:213`），因此字体跟模板走——模板字体是什么用户看到的就是什么。
- 用户反馈：希望两类导出 xlsx 的**表头**字体统一为 **Courier New**（数据区字体不动）。
- 目标：明细 + 余额两类导出文件**第 1 行**（表头）字体强制为 Courier New；字号、颜色、粗体与合并单元格属性保持现状。

### 2.2 目标

- **R1**：主页面顶栏下拉改名 "模板" → "模式"；模式值 = `{制作网银账单, 导出月度余额账单}`；两种模式下按钮可用/禁用状态按 §三 总体规则 + §五 详述。
- **R2**：导入银行账号信息 Excel 时，客资 + 自有账号合并入库到 `template_big_accounts`；新增 `account_nature` 字段；历史 `own-accounts/*.json` 一次性迁移并保留为只读备份。
- **R3**：明细 + 余额两类导出 xlsx 的**第 1 行表头**字体强制为 "Courier New"（仅字体族，不加回退链）。

### 2.3 明确不做

- **R1**：
  - 不新增 balance-seeds 的手动编辑入口（本次仅做"只读取、组装、导出"）。
  - 不改 balance-seeds 文件格式（`{bankName}.json` + `{merchantId, currency, billDate, endBalance, templateName, 生成方式, updatedAt}`）。
  - 不支持"跨年选月"以外的日期粒度（比如按季、按周等）。
  - 不改"制作网银账单"模式下的导入 / 导出流程（保留 v1.5.2 行为）。
- **R2**：
  - 不改"导入银行账号信息 Excel 格式"（`账户性质` 列仍是"客资/自有"二选一）。
  - 不删除 `src/backend/own-account-store.js` 源文件；`writeOwnAccounts` 调用链也保留（见决策 Q6：自有账号仅用于 R1 导出余额）。
  - 不在"维护大账号"对话框里新增 UI 区分客资/自有（DOM 层不显示 nature 列；仅后端带字段）。
- **R3**：
  - 不改数据区字体（数据区保留模板原样 / SheetJS 默认行为）。
  - 不改字号、不改颜色、不改粗体/斜体。
  - 不改"导入文件"时读取到的用户源 Excel（只管导出方向）。
  - 不改"新开账户余额账单生成"模块（顶部第二个模块）下的 xlsx 字体（按决策 Q11 = 仅"明细 + 余额"原话所指两类）。
  - 不改报错 xlsx / error-reports（是诊断文件，保持系统默认字体）。

---

## 三、总体规则（跨需求约束）⭐

> 以下是本次迭代的**全局一致性规则**，所有具体功能点必须遵守。

### 3.1 自有账户（`account_nature = 'own'`）的隔离

**强约束**（决策 Q6）：自有账户**仅在「导出月度余额账单」模式下（R1）参与**。在所有其他场景下，自有账户都被过滤掉。

具体地：

| 场景 | 是否参与 | 实现方式 |
|------|----------|----------|
| R1 月度余额账单导出（`assembleMonthlyBalance`） | ✅ 参与 | 不过滤 nature，两类都读 |
| "制作网银账单"模式下的大账号排序提取 | ❌ 不参与 | 查 `template_big_accounts` 时加 `account_nature='client'` |
| 导入文件后的"大账号选择"弹框 | ❌ 不参与 | 同上 |
| 明细账单生成的分组、大账号检测、字段固定分配 | ❌ 不参与 | 同上 |
| 账单生成过程中的任何大账号查询 | ❌ 不参与 | 同上 |
| "维护大账号"对话框的初始行（tbody） | ✅ 参与但不区分 | tbody 渲染两类，行级无 nature 标识 |
| 余额管理对话框 / 账户映射对话框 | ❌ 不参与 | 保持 v1.5.2 行为 |

**实施要点**：所有现在直接调用 `getTemplateBigAccounts(templateId)` 的位置都要改成接收"是否过滤 nature"的参数；默认口径为 `'client'` only，R1 导出链路显式传 `includeOwn=true`。详细清单见 TechDoc §3 影响面矩阵。

### 3.2 主页面下拉的双层语义分离

- 顶层：顶栏的 `<select id="templateSelect">` → 仅表达**模式**（`制作网银账单` / `导出月度余额账单`）；不再暴露具体模板。
- 内层：`制作网银账单` 模式下，内部固定用 `__FILENAME_MAPPING__` 虚拟模板（v1.5.2 默认行为），不再由用户手选具体模板。
- 内层：`导出月度余额账单` 模式下，模板选择发生在**弹窗内**（见 §5.1.2），并额外提供 `全部银行渠道` 选项。

### 3.3 模板管理按钮的可见性

"模板管理"按钮（`manageTemplateBtn`）在两种模式下**都保留在主页面顶部**且可用（即使用户原话"该模式下，导入模板、模板管理、导出余额按钮可用"已暗示）。

### 3.4 内置默认余额模板

R1 的月度余额账单以及 R3 的表头字体覆盖都以 `assets/余额账单模版.xlsx`（`getBalanceTemplatePath`，`src/main.js:1456-1459`）为唯一 balance 表头来源。余额表头字段通过 `extractHeaders(balanceTemplatePath)`（`src/backend/file-service/readers.js:330`）抽取，所有模板共用同一份。

### 3.5 R3 字体覆盖范围（D14 决策）

**决策 D14（2026-04-20）**：所有调用 `writeBalanceWorkbook` / `writeDetailWorkbook`（及现有明细 writer `writeWorkbookRows`）的场景，表头字体均直接写死为 `Courier New`，不加可选参数切换。**包括新开账户模块导出**——用户已知情并接受该副作用（OT-5 收敛为 B 方案）。

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 模式（Mode） | 主页面顶栏下拉的两条枚举值：`制作网银账单 / 导出月度余额账单`；R1 新定义 |
| 制作网银账单（模式） | 现 v1.5.2 流程：导入账单 → 列映射 → 大账号确认 → 导出明细/余额。保留不变；内部模板固定 `__FILENAME_MAPPING__` |
| 导出月度余额账单（模式） | R1 新增流程：选模板 + 选年月 → 从 balance-seeds 组装记录 → 可点"导出余额"另存为 |
| 月度余额账单 | 按 `{模板/全部银行渠道} × {年月} × balance-seeds` 组装的一份余额 xlsx；表结构沿用 `assets/余额账单模版.xlsx` |
| 月末最后一日 | 目标月份的最后一个自然日，按闰年规则自动计算（例：2026-03 = 2026-03-31、2026-02 = 2026-02-28） |
| 最新余额（Q2 定义） | 在目标月末当日无 seeds 时的兜底策略：取 `billDate ≤ 月末最后一日` 且 `billDate` 最大的一条；若 `billDate` 全部 > 月末最后一日，则该大账号**不纳入**本次导出（排除未来余额） |
| 全部银行渠道 | R1 弹窗模板下拉的枚举值（类似 v1.5.2 的虚拟 ID）；选中时遍历所有"普通模板"（不含主模板、不含子模板、不含 `__FILENAME_MAPPING__` 虚拟 ID）|
| 普通模板（Q5 定义） | `listTemplates()` 返回的**真实模板**，排除：主模板（`is_parent=1`）、子模板（`parent_template_id` 非空）、`__FILENAME_MAPPING__` 虚拟 ID。注：当前 v1.5.2 代码中主页面下拉保留了主模板，本次 R1 收紧为"既不是主也不是子的真实模板" |
| 账号性质（account_nature） | `template_big_accounts` 新字段：`'client'`（客资）/ `'own'`（自有）。老库默认 `'client'` |
| 导出字体 | R3 目标值固定为 `Courier New`（字符串字面量，区分大小写），不加回退链 |
| 表头行 | 导出 xlsx 的第 1 行（row index 0）；多行表头场景按"位于第 1 行的所有单元格"处理 |

---

## 五、功能详细描述

> 本节按需求号展开。每条 R 下分 `说明 / 交互流 / 边界条件 / 错误处理 / 对现有功能的影响`。

### 5.1 R1 — 主页面「模板」→「模式」+ 月度余额账单导出

#### 5.1.1 UI 变更（静态）

**顶栏下拉**：`<select id="templateSelect">` 的 label 文本由"模板"改为"**模式**"（TechDoc 决定是否同时 rename DOM id 以减少歧义；PRD 层不强制）。

**下拉值域仅两条**：
1. `制作网银账单`（默认选中 → 向后兼容）
2. `导出月度余额账单`

**不再出现**：
- v1.5.2 的 `__FILENAME_MAPPING__` 虚拟 ID（退居幕后，作为"制作网银账单"模式的隐式默认）
- 所有真实模板（用户自己配置的银行模板），它们只在「导出月度余额账单」模式的弹窗下拉里出现

**按钮可用/禁用矩阵**（决策 Q3 = 按 PM 推荐，不可用按钮禁用置灰）：

| 按钮 | id | 模式：制作网银账单 | 模式：导出月度余额账单 |
|------|----|--------------------|------------------------|
| 导入文件 | `importFileBtn` | 可用（v1.5.2 行为不变） | **禁用（灰态）** |
| 导出明细 | `exportDetailBtn` | 按 `state.canExportDetail` 控制 | **禁用（灰态）** |
| 导出余额 | `exportBalanceBtn` | 按 `state.canExportBalance` 控制 | **可用**（点击后的交互见 5.1.2）|
| 导入模板 | `importTemplateBtn` | 可用 | 可用 |
| 模板管理 | `manageTemplateBtn` | 可用 | 可用 |
| 账户映射 | `accountMappingBtn` | 可用 | **禁用（灰态）** |
| 状态栏 | `statusBox` | 保持原逻辑 | 保持原逻辑；月度余额账单准备好时用状态文案提示"月度余额账单已准备好，点击导出余额另存" |

#### 5.1.2 「导出月度余额账单」模式下的「导出余额」点击流

**弹窗结构**：
```
+-------------------------------------------------+
| 请选择需要导出月度余额账单的银行渠道            |
+-------------------------------------------------+
|                                                 |
|  模板 [下拉框 ▾]     时间 [年月选择器 ▾]        |
|                                                 |
|                                                 |
|                               [完成]            |
+-------------------------------------------------+
```

**控件清单**：

| 位置 | 控件 | 内容来源 | 默认值 | 备注 |
|------|------|----------|--------|------|
| 左上（标题） | 静态文本 | `请选择需要导出月度余额账单的银行渠道` | — | 字面量 |
| 中左 | 标签文本 | `模板` | — | 字面量 |
| 中左右 | 下拉框 | "普通模板" 列表 + `全部银行渠道` | **`全部银行渠道`** | 决策 Q9 |
| 中右 | 标签文本 | `时间` | — | 字面量 |
| 中右右 | 日期选择器 | 年份 + 月份（先选年后选月） | **无默认**（未选时触发报错） | 年份范围 = 近 10 年 ~ 今年+1（决策 Q13）|
| 右下 | 按钮 | `完成` | — | 点击触发校验与余额装配 |

**交互流**（Happy Path）：
1. 用户在主页面选「模式 = 导出月度余额账单」→ 主页面按钮按 §5.1.1 矩阵重置可用状态。
2. 用户点击「导出余额」→ 弹出 5.1.2 对话框。
3. 用户在「模板」下拉选择某个具体模板或「全部银行渠道」。
4. 用户在「时间」选择年 + 月（例：2026 年 3 月；年份可选范围 2016-2027）。
5. 用户点「完成」按钮 →
   - 前端校验模板非空、时间非空；
   - 后端装配：按 {模板 → 银行名} + {年月 → 月末最后一日} 从 balance-seeds 读取记录（规则见 5.1.3）；
   - 若无任何记录 → 报错（见 5.1.4）；
   - 若有记录 → 记入 session（对应主页面"月度余额账单可导出"状态），**关闭弹窗**返回主页面，状态栏提示"月度余额账单已准备好，点击「导出余额」另存为文件"。
6. 用户点主页面的「导出余额」→ 弹系统"保存为"对话框 → 用户选路径 → 写入 xlsx（单文件单 sheet，见 5.1.3）。

**错误/空值分支**（5.1.4 展开）：
- 模板为空 / 时间为空 / 两者都空 → 报错后返回弹窗等用户修改。
- 模板选中但模板/范围内没有任何 balance-seeds 记录 → 报错后返回弹窗。

#### 5.1.3 月度余额数据装配规则

**核心函数**（概念层，实现在 TechDoc）：`assembleMonthlyBalance({ templateScope, year, month })` → 返回 `{records, dateRangeLabel, bankCount, accountCount}`。

**入参语义**：
- `templateScope` = 一个具体模板名（如 `中行-北京`）或 `__ALL_BANKS__`（虚拟值，表示"全部银行渠道"）。
- `year` / `month` = 用户选的年月，组装出 `targetLastDay = ${year}-${pad2(month)}-${lastDayOfMonth(year, month)}`，格式化为 `YYYY-MM-DD`。

**遍历规则**：
1. 用 `templateScope` 确定要处理哪些"普通模板"：
   - 单模板 → `[templateScope]`；
   - 全部银行渠道 → `listTemplates()` 全量 + 过滤"普通模板"（§四 术语：`!isParent && !parentTemplateId`）。
2. 对每个模板：拿 `bankName = splitTemplateName(templateName).bankName`；同时查该模板的全部大账号（**包含 `account_nature='own'`**，R1 是唯一放行自有账户的场景）。
3. 读 `{storageRoot}/balance-seeds/{bankName}.json` → 得到这家银行下所有 seeds 记录。
4. 过滤出本模板涉及的大账号（通过 `template_big_accounts`，`{merchantId, currency}` 列表）。
5. 对每个大账号（`merchantId` + `currency` 组合）：
   - **优先**：在该 bankName 的 seeds 里查 `billDate === targetLastDay && merchantId 匹配 && currency 匹配` 的记录 → 找到直接用；
   - **兜底（最新余额，Q2 定义）**：按 `billDate ≤ targetLastDay` 过滤，取 `billDate` 最大的一条；
   - **未来余额排除**：若该大账号的所有 seeds `billDate > targetLastDay` → **跳过该大账号**（不写入导出文件，不报错）；
   - 完全无 seeds → **跳过该大账号**。
6. 把命中的记录按 `{银行名, 所在地, 大账号, 币种, billDate, endBalance}` 拼成一行，对齐 `assets/余额账单模版.xlsx` 的表头字段（`balanceTemplateFields = extractHeaders(balanceTemplatePath)`）。

**多币种大账号**：按现有业务"一大账号多币种 → 每币种独立一行"的先例，不合并。

**输出形态**（决策 Q4 = 自定义，单文件单 sheet）：
- 不分 sheet、不分文件；
- 所有模板、所有大账号、所有币种的余额条目**合并写入同一个 sheet**；
- 表头按 `balanceTemplateFields` 统一。
- **风险**：单 sheet 时不同模板若字段定义不一致，需要统一到最小公约数字段集（即 `balanceTemplateFields`）。超出该字段集的内容在写入时被丢弃；缺失字段以空串补位。

#### 5.1.4 错误处理

弹框形式：**复用项目内置 `createAlertDialog` modal**（决策 Q12，与 `src/renderer-dialogs.js:67` 现有实现一致）。

| 错误场景 | 触发条件 | 弹框文案 | 点确认后行为 |
|---------|----------|-----------|---------|
| E1 模板为空 | 用户没选模板就点"完成" | `请选择模板` | 回到弹窗，保留"时间"已选值 |
| E2 时间为空 | 用户没选年月就点"完成" | `请选择时间` | 回到弹窗，保留"模板"已选值 |
| E3 两者都空 | 同上，两个都没选 | `请选择模板和时间` | 回到弹窗 |
| E4 模板+范围内无余额 | 装配结果为空（0 条记录） | `所选模板在 {年}年{月}月的月末及更早均无余额记录，无法生成月度余额账单` | 回到弹窗让用户改模板/月份 |

#### 5.1.5 导出文件命名

**文件名格式**（决策 Q9）：
```
月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx
```

示例：
- `月度余额账单-中行-北京-2026-03.xlsx`
- `月度余额账单-全部银行渠道-2026-03.xlsx`

文件名安全化：沿用现有 `sanitizeFileName` helper；非法字符替换为 `-`。

**临时路径 / 另存为**：
- 装配成功后先写到 `{storageRoot}/exports/{YYYY-MM-DD}/balance/` 目录（复用 `buildOutputFilePath`，`src/main.js:1865`）；
- 用户点"导出余额"时通过 `dialog.showSaveDialog` 另存为（沿用 v1.5.2 的 `lastGeneratedExports.balance` + `exportStatementByScope` 链路，或新增独立 IPC；TechDoc 给方案选择）。

#### 5.1.6 对现有功能的影响

- **主页面下拉语义巨变**：
  - v1.5.2 的 `__FILENAME_MAPPING__` 虚拟 ID 不再出现在下拉，但仍保留为"制作网银账单"模式的**隐式默认**值（`state.selectedTemplateId` 在该模式下固定为 `__FILENAME_MAPPING__`）；
  - 现有真实模板不再出现在下拉里（下拉仅两条模式值）；
  - 影响 `src/renderer.js:1617 updateTemplateSelect()`、`src/renderer.js:2869-2875 templateSelect change listener`、`src/renderer-dialogs.js` 多处从 `state.selectedTemplateId` 取值的代码；
  - v1.5.2 的 `isFilenameMappingMode(templateId)` 助手仍保留，供"制作网银账单"模式内部使用。
- **导入文件**：在「制作网银账单」模式下保持 v1.5.2 行为——即按文件名映射模板 → 按表头自动识别（决策 Q5 = 按 PM 推荐，排除子模板，内部隐式用 `__FILENAME_MAPPING__`）。
- **balance-seeds**：新增**只读**的"跨模板遍历"函数（按 bankName 读 json，按 `template_big_accounts` 过滤）。不改写格式。
- **`template_big_accounts` 表**：R1 仅**读取**，但 R2 会**写入**自有账号（含 `account_nature='own'`）。因此 R1 必须等 R2 schema 迁移完成后才能正确工作（实施顺序见 tasks.md）。

### 5.2 R2 — 银行账号导入合并"自有账号"

#### 5.2.1 UI 与存储变更

- 后端 `parseBankAccountExcel` 的返回值：保留 `clientAccounts` + `ownAccounts` 两个数组（仅为了保留"账号性质"信息供前端/后端区分 nature）。
- 前端 `src/renderer-dialogs.js:2020-2043 import-bank-info handler`：客资 + 自有都放进"维护大账号"tbody 的初始行；不再保留 `pendingOwnAccounts` 单独存储。
- 前端"完成"按钮提交时：把两类都作为 big accounts 提交，但带上 `nature` 字段（详见 5.2.2）。
- IPC `big-account:save-own-accounts`：**废弃**（前端不再调用），保留源文件 `src/backend/own-account-store.js` 作过渡兼容。
- `writeOwnAccounts` 调用点（`src/main.js:6214`）保留源码但标记 deprecated。

#### 5.2.2 `template_big_accounts` Schema 变更

**决策 Q7 = A**：新增字段
```
account_nature TEXT NOT NULL DEFAULT 'client'    -- 取值 'client' | 'own'
```

**既有约束保持不变**：`UNIQUE(template_id, merchant_id, currency)`。

#### 5.2.3 历史数据迁移

启动时执行一次性迁移（幂等）：

1. 检查 `app_settings` 表中的 `own_accounts_migration_v1.5.3_done` flag；若 = `'true'` → 跳过。
2. 枚举 `{storageRoot}/own-accounts/` 目录下所有 `{bankName}.json`。
3. 对每个 `bankName`：
   - 调 `listTemplates()` 查询所有模板；
   - 找出 `splitTemplateName(t.name).bankName === bankName` 的所有模板；
   - **迁移策略（决策 Q7 补充）**：把 json 中每条 `{merchantId, currencies}` 展平成 `(merchantId, currency)` 并写入所有 bankName 匹配的模板的 `template_big_accounts`，`account_nature = 'own'`；一个 bankName 对多个模板的情况**全部写入**。
   - 写入策略：`INSERT OR IGNORE` —— 若 `(template_id, merchant_id, currency)` 已存在（无论是 `'client'` 还是 `'own'`），**保留已存在记录的 nature，新迁移失败条目写 log 警告**（冲突时客资/已有优先）。
4. 所有模板处理完后，把 `app_settings.own_accounts_migration_v1.5.3_done` 设为 `'true'`。
5. **保留** `own-accounts/*.json` 文件本体，不删除、不加 `.migrated` 后缀（决策 Q6 修订：用户明确要求保留 json 但仅作历史兼容/回退过渡）。

**冲突处理细节**：
- 若迁移时发现 `(template_id, merchant_id, currency)` 已有 `'client'` 记录：跳过，记录 warn 日志 `"迁移跳过：{templateName}/{merchantId}/{currency} 已存在客资记录"`。
- 若某 bankName 在数据库中找不到任何对应模板：整个 json 跳过，记录 warn 日志 `"迁移跳过：bankName={bankName} 在模板库中找不到匹配项"`。

#### 5.2.4 对现有功能的影响

- **维护大账号对话框 tbody**：客资 + 自有都渲染（不在 UI 层显示 nature 标识，保持 v1.5.2 行为；nature 字段仅后端带）。
- **大账号选择弹框 / 大账号排序 / 明细账单生成链路**：按 §3.1 过滤规则只读取 `account_nature='client'` 的记录（R1 月度余额除外）。
- **余额管理、账户映射等对话框**：现状不直接依赖 own-accounts 文件，但它们读取 `template_big_accounts`——需要按 §3.1 的表格判定是否过滤 nature。
- **模板 bundle 导入/导出** (`listTemplateBundleEntries`, `template-repository.js:837`)：v1.5.3 开始 bundle 里的 `bigAccounts` 字段需要带 `accountNature`。bundle 导出时把 nature 写进去；导入时回写（老 bundle 缺字段时默认 `'client'`）。TechDoc 决定 bundleVersion 是否 +1。
  - **兼容风险**：若 bundleVersion 保持 v3，老版本（v1.5.2）读取本版导出的 bundle 时会忽略 nature 字段（向后兼容无损）；v2 自动升级到 v3 逻辑不变（决策点：TechDoc 可选择保持 v3 或升到 v4，两者都可行）。

### 5.3 R3 — 导出 Excel 表头字体改为 Courier New

#### 5.3.1 说明

**改动范围**（决策 Q10 + Q11 双重约束）：
- 仅改**字体族名**为 `Courier New`，不加回退链。
- 仅改**表头行**（第 1 行，row index 0）；数据区字体不动。
- 对 `writeWorkbookRows`（明细）：给第 1 行每个 cell 的 `s.font.name = 'Courier New'`。
- 对 `writeBalanceWorkbook`（余额）：基于模板 xlsx 生成后，遍历第 1 行每个 cell，overwrite `s.font.name = 'Courier New'`；保留其他字体属性（字号、颜色、粗体）。
- 对 `mergeGeneratedXlsxFiles`（v1.5.2 多模板合并）：合并后再遍历第 1 行字体。
- 对 R1 新增的月度余额链路：沿用 `writeBalanceWorkbook` → 字体自动生效。

#### 5.3.2 技术约束（关键风险）

**SheetJS 社区版（`xlsx@0.18.5`）不支持写入 cell 样式**。见 `package.json:67`。当前 `writeBalanceWorkbook` 之所以能保留模板字体，是因为 `cellStyles: true` **读取**模板样式；但写入时社区版 `xlsx.writeFile` 会丢失 `s` 字段。

TechDoc 必须给出方案选择：
- 方案 A：引入 `xlsx-js-style`（第三方 fork，API 兼容，支持样式写入）作为新增依赖；
- 方案 B：用 `@sheetjs/xlsx-pro`（商业版，不可接受）；
- 方案 C：在已有 `xlsx` 之外的其它技术路径（如直接写 xml）；

**PM 倾向方案 A**（改动小、社区验证充分），TechDoc 验证后拍板。

#### 5.3.3 覆盖范围

| 导出类型 | 文件来源 | 是否覆盖表头字体 |
|---------|---------|--------------|
| 明细（COMMON） | 单文件导出（`writeWorkbookRows`） | ✅ |
| 明细（COMMON 合并） | v1.5.2 多模板合并（`mergeGeneratedXlsxFiles`） | ✅（合并后再遍历一次） |
| 余额（BALANCE） | 单文件导出（`writeBalanceWorkbook`） | ✅ |
| 余额（BALANCE 合并） | v1.5.2 多模板合并 | ✅ |
| R1 月度余额账单 | 新增路径（复用 `writeBalanceWorkbook`） | ✅ |
| 报错 xlsx / 错误报告 | `error-reports/` | **不改** |
| 新开账户模块导出 | `new-account:generate` | ✅（决策 D14 = B：writer 写死 Courier New，副作用接受） |

#### 5.3.4 风险提示（PRD 级）⚠️

- **Courier New 对 CJK 字符无字形**（决策 Q10 = 仅 Courier New，不加中文回退链）：Excel/WPS 打开导出的 xlsx 时，表头中的中文字符依赖**系统级字体替换**（Windows / Mac / Linux / WPS 各自实现不同）。不同系统/应用版本显示效果可能不一致（中文字宽、行距微差）。
- **用户已知情此风险**：通过决策点 Q10 明示确认。
- **仅表头受影响**：数据区保留原字体，即使表头回退失败，数据可读性不受影响（决策 Q11）。

#### 5.3.5 对现有功能的影响

- **视觉变化**：所有用户导出的 xlsx 表头字体从"系统默认/宋体"变为"Courier New"；等宽字体会让英文/数字表头对齐更好，中文表头字宽表现依赖系统字体替换。
- **依赖变动**：若方案 A 落地，`package.json` 新增 `xlsx-js-style` 依赖（TechDoc 给具体版本号）。

---

## 六、验收标准

### 6.1 R1 — 模式切换 + 月度余额导出

| AC 编号 | 验收条件 |
|---------|------------------|
| AC1-1 | 主页面顶栏 label 显示"模式"；下拉仅两条：`制作网银账单` / `导出月度余额账单`；默认选中前者 |
| AC1-2 | 选中「制作网银账单」时，按钮可用状态与 v1.5.2 行为一致；内部 `state.selectedTemplateId === '__FILENAME_MAPPING__'` |
| AC1-3 | 选中「导出月度余额账单」时，导入文件/导出明细/账户映射按钮置灰禁用；导入模板/模板管理/导出余额可用 |
| AC1-4 | 在「导出月度余额账单」模式点「导出余额」，弹出 5.1.2 对话框，含标题、模板下拉、时间选择器、完成按钮 |
| AC1-5 | 模板下拉值域 = 普通模板列表（§四术语定义）+ `全部银行渠道`；默认选中 `全部银行渠道` |
| AC1-6 | 时间选择器支持年份范围 = 近 10 年 ~ 今年+1（例：2026-04 当下可选年份 = 2016~2027），先选年后选月 |
| AC1-7 | 点完成前，模板/时间未选 → 触发 E1/E2/E3 报错；确认后回弹窗保留已填值 |
| AC1-8 | 装配成功 → 弹窗关闭 + 主页面状态栏提示"月度余额账单已准备好"，此时点「导出余额」弹系统另存为 |
| AC1-9 | 装配无任何记录 → 触发 E4 报错，停留在弹窗 |
| AC1-10 | 多币种大账号按币种拆多行 |
| AC1-11 | 所选模板在目标月末有 seeds → 取该日 seeds；无当日 seeds 但有更早 → 取 billDate ≤ 月末且最大的一条；全部 billDate 都 > 月末 → 跳过该大账号；完全无 seeds → 跳过 |
| AC1-12 | 「全部银行渠道」合成**单个 xlsx 单个 sheet**，所有模板/大账号/币种的余额条目合并；表头 = `assets/余额账单模版.xlsx` 的字段 |
| AC1-13 | 导出文件名 = `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx` |
| AC1-14 | R1 月度余额导出只读取大账号表，**包含** `account_nature='own'` 的记录（全局规则 §3.1 的唯一放行点）|

### 6.2 R2 — 自有账号合并入大账号表

| AC 编号 | 验收条件 |
|---------|------------------|
| AC2-1 | 导入银行账号信息 Excel 后，"维护大账号"tbody 中同时出现客资 + 自有账号行；UI 不区分颜色/标识 |
| AC2-2 | 点击"维护大账号"对话框「完成」后，`template_big_accounts` 表中能查到全部客资（`account_nature='client'`）+ 自有（`account_nature='own'`）账号 |
| AC2-3 | 旧库里已有的 `own-accounts/{bankName}.json` 被一次性迁移到大账号表；迁移幂等（多次启动不重复插入）；`app_settings.own_accounts_migration_v1.5.3_done='true'` |
| AC2-4 | 迁移后原 `own-accounts/{bankName}.json` 文件保留（不删除、不重命名）|
| AC2-5 | 重复导入同一批 excel 数据不会重复插入（受 `UNIQUE(template_id, merchant_id, currency)` 约束；冲突时保留已有记录的 nature）|
| AC2-6 | 大账号表 schema 迁移幂等：`ensureTemplateBigAccountNatureSupport` 在已有字段时跳过，无错误 |
| AC2-7 | 全局规则 §3.1 生效：除 R1 月度余额导出外，所有读 `template_big_accounts` 的链路均过滤掉 `account_nature='own'` |

### 6.3 R3 — 导出表头字体 Courier New

| AC 编号 | 验收条件 |
|---------|------------------|
| AC3-1 | 明细 xlsx（单文件）打开后，**第 1 行**所有单元格字体为 Courier New；第 2 行及以下字体不变 |
| AC3-2 | 余额 xlsx（单文件）打开后，**第 1 行**所有单元格字体为 Courier New；第 2 行及以下字体不变 |
| AC3-3 | 多模板合并后的 COMMON / BALANCE 文件第 1 行字体为 Courier New |
| AC3-4 | R1 新增的月度余额 xlsx 第 1 行字体为 Courier New |
| AC3-5 | 字号、颜色、粗体、合并单元格属性保持 v1.5.2 样式，不被覆盖 |
| AC3-6 | 报错 xlsx / 新开账户模块导出 xlsx 的字体**不变** |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 编号 | 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|------|----------|---------|
| P0-1 | 模式切换：默认态 | 启动应用 | 全新用户 | 下拉显示"模式"label，默认选中「制作网银账单」；所有 v1.5.2 按钮表现不变 |
| P0-2 | 模式切换：切到月度余额 | 下拉选「导出月度余额账单」 | — | 导入文件/导出明细/账户映射置灰禁用；导出余额可用 |
| P0-3 | 月度余额弹窗控件 | 点击「导出余额」 | 模式 = 导出月度余额账单 | 弹窗标题、模板下拉（默认"全部银行渠道"）、时间选择器、完成按钮按 5.1.2 呈现；年份范围 2016~2027 |
| P0-4 | 月度余额：单模板某月命中 | 模板 = `中行-北京`，时间 = 2026-03 | balance-seeds 下该 bankName 的 json 里有 `billDate=2026-03-31` 的记录 | 弹窗关闭 → 状态栏提示 → 点导出余额 → xlsx 含该大账号记录，文件名 `月度余额账单-中行-北京-2026-03.xlsx` |
| P0-5 | 月度余额：当月无 seeds 但有更早 | 模板 = `中行-北京`，时间 = 2026-03 | 仅有 `billDate=2026-02-28` 的记录 | xlsx 含该条 2026-02-28 的余额（兜底取 billDate ≤ 月末最大的一条）|
| P0-6 | 月度余额：billDate 全部 > 月末 | 模板 = `中行-北京`，时间 = 2026-03 | 仅有 `billDate=2026-04-30` 的记录 | 该大账号**不出现**在导出文件里；若所有账号都落空 → E4 报错 |
| P0-7 | 月度余额：模板完全无 seeds | 模板 = `建行-上海`，时间 = 2026-03 | 该 bankName 无任何 seeds 记录 | 弹 E4 报错"所选模板在 2026年3月的月末及更早均无余额记录..." |
| P0-8 | 月度余额：模板为空报错 | 只选了时间，未选模板 | — | 弹 E1 报错"请选择模板" |
| P0-9 | 月度余额：时间为空报错 | 只选了模板，未选时间 | — | 弹 E2 报错"请选择时间" |
| P0-10 | 月度余额：全部银行渠道 | 模板 = 全部银行渠道，时间 = 2026-03 | 有 3 个普通模板，各自有 seeds | 合成**单文件单 sheet**，文件名 `月度余额账单-全部银行渠道-2026-03.xlsx`，所有大账号/币种堆叠在同一 sheet |
| P0-11 | 月度余额：包含自有账户 | 模板 = `中行-北京`，时间 = 2026-03 | 该模板下有 2 个客资 + 1 个自有账号，自有账号在 seeds 里有记录 | xlsx 里包含 3 条余额（自有账号也出现），验证 §3.1 唯一放行 |
| P0-12 | R2：导入 Excel 客资+自有 | 导入银行账号 Excel（10 条客资 + 5 条自有） | 模板 A 已保存 | 维护大账号对话框 tbody 显示 15 条（无颜色区分）；点完成后数据库 `template_big_accounts` 新增 15 条记录，其中 5 条 `account_nature='own'` |
| P0-13 | R2：迁移旧 own-accounts | 升级后首次启动 | 旧库有 3 份 own-accounts/*.json（每份含 2 条记录） | 自动迁移到 `template_big_accounts`（总计 6 条，`account_nature='own'`）；原 json 文件保留；`app_settings.own_accounts_migration_v1.5.3_done='true'` |
| P0-14 | R2：迁移幂等 | 重启 3 次 | P0-13 已执行 | 数据库记录数不变；迁移函数 short-circuit，log 里有"已迁移跳过"条目 |
| P0-15 | R2：迁移冲突 | 老 json 里 merchantId=X/CNY，老 DB 里已有 X/CNY 的客资记录 | — | 迁移跳过该条，log 警告"已存在客资记录"；DB 中 X/CNY 保持 `account_nature='client'` |
| P0-16 | R2：§3.1 过滤验证 | 模式 = 制作网银账单，导入账单 | 模板 A 下客资 + 自有都已导入 | "大账号选择"弹框只显示客资账号；明细账单生成只按客资分组 |
| P0-17 | R3：明细表头字体 | 导入账单 → 导出明细 | — | xlsx 第 1 行所有单元格字体 = Courier New；第 2 行及以下字体不变 |
| P0-18 | R3：余额表头字体 | 同上导出余额 | — | xlsx 第 1 行所有单元格字体 = Courier New |
| P0-19 | R3：月度余额表头字体 | 走 R1 流程导出 | — | xlsx 第 1 行字体 = Courier New |
| P0-20 | R3：合并文件表头字体 | 触发多模板合并导出（v1.5.2 已有路径）| — | 合并后的 xlsx 第 1 行字体 = Courier New |
| P0-21 | R3：CJK 表头抽查 | 打开导出 xlsx 在 Excel for Windows / Excel for Mac / WPS | — | 中文字符可正常显示（依赖系统字体替换），样式无明显断字/方框 |

### 7.2 P1 应测场景

| 编号 | 场景 | 预期结果 |
|------|------|---------|
| P1-1 | 模式切换不丢状态 | 在「制作网银账单」导了一半账单（`statementImportSessions` 非空）→ 切到「导出月度余额账单」→ 切回「制作网银账单」→ 原 session 仍保留，主页面状态栏恢复 |
| P1-2 | R1 跨年选月 | 选 2025-12 → 2026-01，切换年份时月份选项刷新 |
| P1-3 | R1 多币种大账号 | 大账号 MerchantId=X 的 CNY + USD 都有 seeds → 导出 xlsx 里该大账号出两行 |
| P1-4 | R2 重复导入不重插 | 同一份 Excel 导入两次，`template_big_accounts` 不重复 |
| P1-5 | R2 bundle 导出 / 导入 | bundle 导出包含 nature 字段；导入老 bundle（缺 nature）→ 默认 `'client'` |
| P1-6 | R3 数据区字体不变 | 导出 xlsx 数据区字体保持 v1.5.2 行为（宋体/系统默认/模板字体）|
| P1-7 | R3 报错文件不改 | 触发导出错误报告，xlsx 第 1 行字体保持系统默认 |
| P1-8 | R3 新开账户模块不改 | 顶部切到"新开账户余额账单生成"模块 → 生成 xlsx → 字体不变 |

### 7.3 不测项与原因

- 顶部"模块切换器"（`网银账单生成 / 新开账户余额账单生成`）层级的切换行为：R1 不影响该层级。
- R1 月度余额的"导出后再次点导出余额是否重新另存为"：沿用 `lastGeneratedExports.balance` 现有行为（v1.5.2 未改）。
- R3 非导出路径（report、日志、config json）字体：不在需求范围。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更（R1） | 无 schema 变化；新增**只读**跨模板遍历 balance-seeds 目录的 helper |
| 数据结构变更（R2） | `template_big_accounts` 加 `account_nature TEXT NOT NULL DEFAULT 'client'` 列（幂等迁移）；`app_settings` 加 `own_accounts_migration_v1.5.3_done` 标记 |
| 数据结构变更（R3） | 无 schema 变化 |
| 状态流转变更（R1） | 前端新增"模式"状态 `state.currentStatementMode ∈ {'statement', 'monthly-balance'}`；月度余额 session 独立于现有 `statementImportSessions`（新增 `lastMonthlyBalanceExport` 内存对象）|
| 权限/安全 | **无鉴权改动**。**但 R1/R2 都触及资金字段**（balance-seeds 的 endBalance、大账号表的 merchant_id），属于资金/状态机场景，需人工复核（见 §九） |
| 回滚策略 | R1 纯前端逻辑 + 新增后端读路径，回滚代码即回滚；R2 schema 列加了无法撤，但旧版本忽略该列可正常运行（own-accounts/*.json 保留为回退 fallback）；R3 改 writers 可代码回滚 |

---

## 九、风险提醒（必须人工复核）⚠️

> 触发全局规则 7 的"资金、状态机、数据迁移"红线。

1. **资金字段读取（R1）**：月度余额账单的 `endBalance` 直接给财务团队使用。必须人工抽查：
   - 某大账号在目标月末有 seeds → 数值与 json 一致；
   - 某大账号走 Q2 兜底 → 确认取的是"billDate ≤ 月末最后一日且最大"的那条、数值正确；
   - 多币种大账号 → 币种不串；
   - 「全部银行渠道」单 sheet 场景下不漏/不重大账号；
   - **未来余额排除**：确认某账号全部 seeds `billDate > 目标月末` 时**不出现**在导出文件里。

2. **数据迁移（R2）**：自有账号从 json 文件迁到 SQLite 表。风险点：
   - 迁移失败是否有 rollback（建议：每个 bankName 单独事务，失败的 bankName 跳过 + 警告 log）；
   - 迁移后原 json 仍可读（保留不删除，防数据丢失）；
   - 多次启动是否重复迁移（`own_accounts_migration_v1.5.3_done` flag 幂等性）；
   - 一个 bankName 对应多个模板时是否漏写（决策：写入所有 bankName 匹配的模板，TechDoc 给确切 SQL）。

3. **全局规则 §3.1 的过滤约束（R2）**：所有读 `template_big_accounts` 的位置都要按 §3.1 表格补过滤。漏改一处就可能导致"制作网银账单"流程里自有账号也被纳入，破坏业务隔离。TechDoc §3 必须给出逐位置清单。

4. **主页面下拉语义巨变（R1）**：v1.5.2 刚稳定的"下拉 = 模板 + 按文件名映射"被 R1 大幅收窄。任何"按 `state.selectedTemplateId` 查 `state.templates`"的代码调用点都可能踩坑（v1.5.2 已经因为 `__FILENAME_MAPPING__` 改了一大圈）。TechDoc 阶段需再做一轮 grep 审查。

5. **状态机交互（R1）**：在「制作网银账单」模式导了一半账单（`statementImportSessions` 非空）时切到「导出月度余额账单」模式，再切回去 —— session 应该保留（决策 Q13 = 按 PM 推荐：不清）。TechDoc 须验证 tab 切换不会误触发 `clearGeneratedExports()` 等副作用。

6. **字体覆盖（R3）**：SheetJS 社区版（`xlsx@0.18.5`）不支持写入样式，需引入 `xlsx-js-style` 或等价方案。TechDoc 必须验证：
   - 新依赖与现有 `xlsx` API 兼容性；
   - Electron 打包后样式能正确写入（`electron-builder` 下 native 模块处理）；
   - Courier New 对 CJK 的渲染行为（已通过 §5.3.4 风险告知用户）。

7. **单 sheet 合并字段差异（R1）**：决策 Q4 = 所有银行渠道合并到单 sheet。若未来某模板自定义了 balance 表头（当前不支持，但 v1.5.x 其它 fix 可能开这个口子），会导致字段不对齐。TechDoc 在实现时必须**硬编码使用 `assets/余额账单模版.xlsx` 的字段集**，不信任"模板自带余额表头"。

8. **R2 迁移失败不阻塞启动（D15 决策）**⚠️：资金相关的 own-accounts 迁移在启动时执行，**失败不阻塞启动**，但必须让用户感知：
   - 整体 try/catch，失败后主窗口仍正常加载；
   - 失败明细写 `{storageRoot}/own-accounts-migration-v1.5.3.log`；
   - 主窗口加载完成后通过 `setStatus` 在状态栏显示显著告警（error/warning tone），文案例：`自有账号迁移失败，请查看迁移日志后联系技术支持`；
   - 告警保留在状态栏直到用户手动关闭或下一次 `setStatus` 覆盖。
   - 注：遇到 orphan bankName（json 对应的 bankName 在数据库里找不到模板）仅跳过并写日志，**不算迁移失败**，不触发此状态栏告警（详见 TechDoc §三）。

---

## 十、决策记录（Decision Record）✅

v0 的 13 个待确认点已由用户逐条拍板，结果如下：

| # | 问题 | 最终决策 | 理由/落地 |
|---|------|----------|-----------|
| Q1 | 主页面顶栏下拉是否完全用"模式"取代，`__FILENAME_MAPPING__` 和真实模板从下拉消失？ | **自定义**（见下）| 下拉仅"模式"两值；"模板管理"按钮仍在主页面且两模式都可见；`__FILENAME_MAPPING__` 作为"制作网银账单"模式的内部默认；具体模板仅在 R1 弹窗出现。详见 §3.2、§3.3、§5.1.1 |
| Q2 | "最新余额"的定义 | **A** | 取 `billDate ≤ 月末最后一日` 里 `billDate` 最大的一条；若该大账号全部 seeds `billDate > 月末` → **跳过该大账号**，不纳入导出（§5.1.3） |
| Q3 | R1 模式下不可用按钮是否禁用置灰 | **是**（PM 推荐）| 明确灰态，避免用户误点（§5.1.1）|
| Q4 | "全部银行渠道"场景下的导出形态 | **自定义**（单文件单 sheet）| 不分 sheet、不分文件；所有模板/大账号/币种合并到同一 sheet；表头统一为 `balanceTemplateFields`（§5.1.3、§九.7）|
| Q5 | "普通模板"定义 | **按 PM 推荐** | 不含子模板；同时不含主模板与 `__FILENAME_MAPPING__` 虚拟 ID；仅真实的"普通模板"（§四、§5.1.3）|
| Q6 | 迁移后 own-accounts/*.json 是否保留 | **自定义**（保留，仅作过渡）| 保留 json，不删不加后缀；R2 迁移后数据库为权威数据源。**同时升级为强约束**：自有账户仅在 R1 导出余额场景出现，见 §3.1 |
| Q7 | 是否给 `template_big_accounts` 加 `account_nature` 字段 | **A** | 加 `account_nature TEXT NOT NULL DEFAULT 'client'`；迁移把 own-accounts json 写入所有 bankName 匹配的模板；冲突时保留已有记录（§5.2.2、§5.2.3）|
| Q8 | R1 余额表头 | **按 PM 推荐（但绑定 Q4）** | 使用项目内置默认余额模板 `assets/余额账单模版.xlsx` 的 `templateFields`；若该文件不存在 → fallback 到第一个模板的 `balanceTemplateFields`（TechDoc 给实现）；共享一份表头（§3.4）|
| Q9 | R1 文件命名 / 默认选中值 | **按 PM 推荐** | 文件名：`月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`；弹窗模板下拉默认 = `全部银行渠道`（§5.1.2、§5.1.5）|
| Q10 | R3 字体策略 | **自定义**（仅 Courier New）| 字体族只写 `Courier New`，不加中文回退链；CJK 渲染依赖系统字体替换，风险由用户承担（§5.3.4）|
| Q11 | R3 字体范围 | **自定义**（仅表头）| 仅表头行（第 1 行）；数据区字体不变；不覆盖"新开账户余额账单"模块；不覆盖报错 xlsx（§5.3.1、§5.3.3）|
| Q12 | R1 错误弹框形式 | **按 PM 推荐** | 复用项目内置 `createAlertDialog` modal（§5.1.4）|
| Q13 | R1 时间选择器年份范围 | **按 PM 推荐** | 近 10 年 ~ 今年+1（2026 当下可选 2016~2027）（§5.1.2）|

**关联决策**：
- 模式切换时是否清 `statementImportSessions` / `lastGeneratedExports` → 按 v0 的 Q13 原问改为 P1 级验证（P1-1），默认**不清**。
- bundleVersion 是否因 `account_nature` 字段升到 v4：v1 定稿**不决策**，交由 TechDoc 阶段技术评估（见 §5.2.4）。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-19 | v0 初稿（3 项需求，13 个待确认点，骨架 AC，骨架 P0/P1 测试清单） |
| 2026-04-20 | v1 定稿：13 决策落地，AC 扩展至 27 条（R1×14、R2×7、R3×6），P0 扩展至 21 条（含 §3.1 过滤验证、Q2 未来余额排除、R2 迁移幂等与冲突、R3 CJK 抽查）；新增 §三 总体规则章节（自有账户隔离、模板管理按钮可见性、内置默认余额模板）；§九 风险扩展 R1 未来余额、§3.1 过滤一致性、SheetJS 社区版样式写入、单 sheet 合并字段差异 4 项 |
| 2026-04-20 | D14/D15 回写（变更最小）：§3.5 新增 R3 字体覆盖范围声明（D14 写死 Courier New）；§5.3.3 覆盖表"新开账户模块"由"不改"改为 ✅（D14 接受副作用）；§九 新增第 8 条风险（D15 R2 迁移失败不阻塞启动但必须状态栏告警） |

---

## 十二、实施记录

### PR #22 — feat(v1.5.3)（2026-04-22 归档）

**对应分支**：`v1.5.x → main`
**归档文件**：`docs/prs/PR22-v1.5.3.md`

**改动清单**：

- 代码（19 个 M + 3 个新增）
  - 前端：`index.html` / `src/renderer.js` / `src/renderer-dialogs.js` / `src/styles.css`
  - 后端：`src/main.js` / `src/preload.js` / `src/backend/database.js` / `src/backend/database/migrations.js` / `src/backend/database/template-repository.js` / `src/backend/database/utils.js` / `src/backend/balance-seed-store.js` / `src/backend/file-service.js` / `src/backend/file-service/writers.js`
  - 新增：`src/main-process/monthly-balance.js` / `src/backend/database/own-accounts-migration.js`
- 测试：`scripts/smoke/scenarios.js` 新增 T1.9 月度余额 7 场景；新增 `scripts/test-v1.5.3-regression.js`（20 自动回归 + 3 R4 精度用例）
- 依赖：`package.json` 新增 `xlsx-js-style@^1.2.0`，版本号 `1.5.2 → 1.5.3`
- 文档：`CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` 三件套同步
- 迭代：`docs/iterations/v1.5.3/{PRD,TechDoc}.md` / `changes/v1.5.3/{spec,tasks,log}.md`

**自测结果**：
- `npm run smoke` 全绿
- `node scripts/test-v1.5.3-regression.js`：P0 18/18 + P1 5/6（P1-7 skipped：错误报告为 txt 非 xlsx）
- 用户手动回归 29 条（21 P0 + 8 P1）全部通过

**关键决策**（完整决策记录见 §十）：
- D14 = B（Courier New 写死，新开账户模块副作用接受）
- D15（迁移失败不阻塞启动，状态栏告警）
- D16（orphan bankName 跳过 + `[WARN]` 日志）
- D17 = A（R4 浮点精度在 1.5.3 内 hotfix；`roundAmount` 2 位小数，`roundAmountHighPrecision` 12 位对样本 2 不收敛）

### PR #23 — 协作基建 + preview 链路扩充（2026-04-23 归档）

**对应分支**：`v1.5.x → main`
**归档文件**：`docs/prs/PR23-v1.5.3.md`

**改动清单**（56 文件 / +12627 / -9）：

- 协作基建（变更 A）
  - 新增：`rules/`（5 文件：project-context / coding-style / important-variables / domain-rules / security）
  - 新增：`knowledge/index.md` / `.claude/agents/{dev,pm}.md` / `.claude/skills/check-vars/SKILL.md`
  - 新增：`docs/templates/{PRD,TechDoc}-template.md` / `changes/templates/{spec,tasks,log,test-spec}.md`
  - 新增：`docs/analysis/var-reference-stats.{md,json}` / `scripts/{scan-vars,check-vars}.js`
  - 新增：`CLAUDE.md`（项目协作约定）
  - 修改：`package.json`（`scan:vars` / `check:vars` scripts）/ `.gitignore`（忽略 `.claude/settings.local.json`）
  - 补归档：`changes/v1.5.2/`
- preview 链路扩充（变更 B）
  - 修改：`src/renderer-previews.js`（+190：9 个 `apply*PreviewState`）/ `src/renderer.js`（+65：destructure + `info.previewModal` 路由 9 case）/ `src/renderer-dialogs.js`（+7：preview 启动路径）
  - 修改：`scripts/render-*.js`（输出路径迁移到 `docs/previews/`）/ `package.json`（10 条 `preview:*` + `preview:all`）
  - 产出：`docs/previews/` 20 张图（11 重命名 + 9 新增）+ `README.md`

**自测结果**：
- `npm run smoke` ✅
- `npm run preview:all` ✅（串联 20 条 `preview:*`，20 张图全部生成）
- `/check-vars` 跑通：Critical 2 (`ADVANCED_MAPPING_FIELDS` / `BALANCE_CALCULATED_OPTION`) + Runtime-state 3 (`MODULES` / `dialog` / `state`)，全部为 preview 链路 mock 消费，无实质语义变动

**Self-review 修复轨迹**：
- round 1（`7cbffc9`）— I-1：`check-vars.js` 默认模式 diff 三重采集，简化为单次 `git diff HEAD`
- round 2（`f31b035`）— M-1/M-2/M-3：`templateRepository` 重复 review 要点去重；`dialog` 条目加 check-vars 命中说明；PR body "20 张图" 加 `preview:all` 串联 20 条交叉引用
