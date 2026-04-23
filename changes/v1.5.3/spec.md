# Spec — v1.5.3

> status: ready（v1 定稿，13 个决策点已拍板）
> owner: PM
> created: 2026-04-19
> updated: 2026-04-20

## 1. 背景

- 为什么要做：
  - R1：用户需要独立的"月度余额账单"导出入口，当前只能走"制作网银账单→导入→生成"这条长链路，而实际数据来源已经在 balance-seeds 里。
  - R2：自有账号当前在独立 json 文件，无法统一管理；需要合并到大账号表供后续"余额管理"类需求复用。**且自有账户仅用于月度余额导出场景，不参与"制作网银账单"任何流程**（跨需求一致性约束）。
  - R3：用户反馈导出 xlsx 的表头字体（跟模板走的宋体/系统默认）不适合阅读数字，要求**表头行**改为 Courier New 等宽字体；数据区字体不变。
- 用户 / 业务价值：
  - R1：月末给财务团队交余额报告的操作成本从"多步导入流程"降到"点两下"。
  - R2：自有账号纳入大账号表，后续"余额管理 / 对账差异提醒"等需求不用再维护两套存储；同时隔离客资/自有业务语义。
  - R3：等宽字体让数字/英文表头对齐，便于审计。
- 当前问题：详见 PRD §二 2.1。

## 2. 代码现状（必须有出处）

- 相关文件：
  - `src/renderer.js:1617-1655 updateTemplateSelect()`（主页面模板下拉的构造逻辑，v1.5.2 新增 `__FILENAME_MAPPING__` 默认项）
  - `index.html:47-48 <select id="templateSelect">`（下拉 DOM）
  - `index.html:44 importFileBtn / :52 exportDetailBtn / :53 exportBalanceBtn / :60 importTemplateBtn / :64 manageTemplateBtn / :65 accountMappingBtn`（顶部按钮 id 集合）
  - `src/renderer.js:2730-2750 handleExportBalance()` + `src/preload.js:77` + `src/main.js:8155 file:export-balance`（现余额另存链路）
  - `src/backend/balance-seed-store.js`（`readBalanceSeedRecords / findPreviousBalanceSeed / splitTemplateName` 等）
  - `src/backend/file-service/writers.js:193 writeWorkbookRows / :205 writeBalanceWorkbook`（两条导出写入链）
  - `src/backend/bank-account-import.js:44-72 parseBankAccountExcel`（客资/自有分流）
  - `src/renderer-dialogs.js:2020-2043 import-bank-info handler`（导入后的前端分流）
  - `src/main.js:6207-6225 big-account:save-own-accounts`（自有账号写 own-accounts/*.json 的 IPC）
  - `src/backend/database.js:53-63 template_big_accounts`（大账号表 schema，无 account_nature 字段）
  - `src/backend/database/template-repository.js:240-257 getTemplateBigAccounts`（大账号查询，无 nature 过滤）
  - `src/main.js:1456-1459 getBalanceTemplatePath` + `assets/余额账单模版.xlsx`（余额模板字段来源）
  - `package.json:67 "xlsx": "^0.18.5"`（SheetJS 社区版，不支持写入样式）
- 当前行为：
  - 主页面下拉第一项是 `__FILENAME_MAPPING__`（按文件名映射模板），默认选中；其后是全部非子模板。label 文本是"模板"。
  - 导出余额走 `lastGeneratedExports.balance`（内存 session），没有"从 balance-seeds 直接装配"的独立路径。
  - 自有账号解析后存入 `{storageRoot}/own-accounts/{bankName}.json`，与大账号表分离。
  - 明细/余额 writer 不主动设置字体。明细是 `aoa_to_sheet`（无样式），余额读模板 xlsx 保留模板样式；但因社区版 `xlsx` 不写入 `s` 字段，样式实际无法保留到导出文件。
- 已知限制：
  - 跨模板遍历 balance-seeds 没有现成 helper，需新增按 bankName 枚举目录的函数。
  - `template_big_accounts` 无账号性质字段，合并后无法区分客资/自有。
  - `xlsx` 社区版不支持写入 `s.font.name`，R3 需引入 `xlsx-js-style`。
- 事实依据：以上文件路径 + 行号均在 `v1.5.x` 分支 commit `6e5df3a` 基线真实存在。

## 3. 目标

- 必做：见 PRD §2.2（R1/R2/R3 三条）。
- 可不做：已在 PRD §2.3 列举。
- 明确不做：见 PRD §2.3（字号/颜色不改；数据区字体不改；新开账户模块不改；报错 xlsx 不改；不删除 own-accounts/*.json；不改 bank-account-import excel 列格式）。

## 4. 功能点

> 详述在 PRD §5。此处给出 v1 定稿摘要。

### 功能点 1 — R1 模式切换 + 月度余额账单导出

- 说明：主页面下拉改为"模式"（值：`statement` / `monthly-balance`）；`__FILENAME_MAPPING__` + 具体模板**从主页面下拉消失**，前者作为"制作网银账单"模式的内部默认。月度余额模式下点「导出余额」弹窗（标题 + 模板下拉含"全部银行渠道" + 年月选择器 + 完成按钮）；从 balance-seeds 装配 records → 另存为单 xlsx 单 sheet。
- 输入：模式选择、模板下拉值（含 `__ALL_BANKS__`）、年份（近 10 年 ~ 今年+1）、月份。
- 输出：月度余额 xlsx 文件名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`；单 sheet 合并。
- 边界：模板空/时间空/无 seeds 记录分别报错（E1~E4，复用 `createAlertDialog`）；多币种大账号拆多行；"全部银行渠道"遍历所有"普通模板"（不含主、不含子、不含虚拟 ID）；Q2 最新余额 = `billDate ≤ 月末最后一日` 里最大的一条；billDate 全部大于月末 → 该账号不出现；自有账号**参与 R1 导出**（§3.1 唯一放行点）。
- 验收标准：PRD AC1-1 ~ AC1-14。

### 功能点 2 — R2 自有账号合并入大账号表

- 说明：导入 Excel 后客资 + 自有都进 tbody（UI 不区分颜色/标识）；`template_big_accounts` 加 `account_nature TEXT NOT NULL DEFAULT 'client'`；历史 `own-accounts/*.json` 启动时一次性迁移。**跨需求约束**：除 R1 月度余额外所有读大账号的位置都要过滤 `account_nature='client'`。
- 输入：银行账号信息 Excel（含客资 + 自有）；启动时的 `own-accounts/*.json`。
- 输出：`template_big_accounts` 新增记录（带 nature）+ 迁移标记 `app_settings.own_accounts_migration_v1.5.3_done`；`own-accounts-migration-v1.5.3.log`（迁移明细日志）。
- 边界：UNIQUE 约束冲突 → 保留已存在记录（客资优先）；幂等迁移；原 json 文件保留（不删、不重命名）；一个 bankName 对多个模板 → 全部写入；bankName 在数据库找不到模板 → 跳过整个 json 并记录 orphan 日志。
- 验收标准：PRD AC2-1 ~ AC2-7。

### 功能点 3 — R3 导出表头字体 Courier New

- 说明：明细 + 余额 + 月度余额（R1）+ 多模板合并 xlsx 的**第 1 行表头**字体统一为 Courier New；数据区字体不动；不加中文回退链。
- 输入：现有导出流程。
- 输出：xlsx 文件第 1 行每个 cell 的 `s.font.name = 'Courier New'`。
- 边界：报错文件不改；新开账户模块**按原话不改**（见 TechDoc §十一 OT-5 的 Open Question）；字号/颜色/粗体保持原样；CJK 渲染依赖系统字体替换（风险由用户承担）。
- 验收标准：PRD AC3-1 ~ AC3-6。

### 功能点 4 — R4 账单拆分合并浮点精度修复（hotfix，2026-04-22 引入）

- 背景：用户 2026-04-22 回归 Pay-ins-NGN-0316-0323.csv + Payouts-NGN-0316-0323.csv 导出时发现 3 条合并账单的 Debit Amount 带浮点尾巴（如 `2555.7999999999997`，应为 `2555.80`）。
- 根因：`src/backend/file-service.js:437-439` 账单拆分合并求和使用纯 JS 浮点 `+` / `-`，未调用 `roundAmountHighPrecision`。`sanitizeAmountValue`（normalizers.js:95）只清理非数字字符不做 round。这是 v1.5.2 已有 bug（v1.5.0 引入 `roundAmountHighPrecision` 时未覆盖此路径）。
- 影响面：所有"账单拆分合并"（`billSplitMerge` enabled）模式下 ≥2 行且金额含多位小数的合并组都受影响。
- 说明：在 `src/backend/file-service.js:437-439` 的 `net = sumCredit - sumDebit` 后加 `roundAmount(...)`（`Number(value.toFixed(2))`），吃掉浮点噪声，使 `net === 0` 判定与 `netString` 输出均精确。
  - **2026-04-22 更正**：初稿指定 `roundAmountHighPrecision`（12 位），Dev 实施时发现对 `65572.01 + 4917.90 = 70489.90999999999` 样本**无效**（该浮点在 IEEE 754 的 12 位精度表示仍保留噪声）。改为 `roundAmount`（2 位）覆盖全部 3 条用户样本。
- 输入：账单拆分合并模式下的多行 credit/debit 组。
- 输出：合并后的 `creditAmount` / `debitAmount` 数值在浮点 12 位精度内等于数学真值；2 位小数场景下完全等于期望值（如 `2377.49 + 178.31 === 2555.8`）。
- 边界：不改其它金额处理路径（direct mapping / signed-amount split / field-conditional split 都已走 `roundAmountHighPrecision` 或不涉及累加）；强制 2 位小数 round（`roundAmount`），与既有其它金额处理路径一致；项目模板库实际未使用 3 位小数货币（KWD / BHD 等），暂不考虑。
- 验收标准（新增 AC4-1 ~ AC4-3）：
  - AC4-1：固定样本 `[2377.49, 178.31]` 合并为 Debit 时输出 `2555.8`
  - AC4-2：固定样本 `[65572.01, 4917.90]` 合并为 Debit 时输出 `70489.91`
  - AC4-3：`net === 0` 判定在多行正负抵消（如 `[1.1, -1.1]`）时正确返回 true，静默跳过
- 风险：**资金字段**，必须通过固定精度回归用例验证

## 5. 影响范围

- 前端：`src/renderer.js`（state 扩展 + updateTemplateSelect 重写 + applyStatementModeSideEffects + handleExportBalance 分流）/ `src/renderer-dialogs.js`（新增 createMonthlyBalanceExportDialog + 维护大账号对话框 tbody 合并 + 收集 nature）/ `index.html`（label 文本 + options 结构）
- 后端：`src/main.js`（新增 IPC + 文件命名扩展 + 启动序列加 runOwnAccountsMigration + 废弃 saveOwnAccounts）/ `src/backend/balance-seed-store.js`（新增 listBalanceSeedBankNames）/ `src/backend/database.js`（init 调用新增）/ `src/backend/database/migrations.js`（新增 ensureTemplateBigAccountNatureSupport）/ `src/backend/database/template-repository.js`（getTemplateBigAccounts 加参数 + listTemplates/getTemplate SQL 加过滤 + saveMappings 带 nature + bundleEntries 带 nature）/ `src/backend/bank-account-import.js`（返回值兼容）/ `src/backend/file-service/writers.js`（依赖切换 + 表头字体注入）
- 新增文件：`src/main-process/monthly-balance.js`、`src/backend/database/own-accounts-migration.js`
- 废弃保留：`src/backend/own-account-store.js`、`src/main.js:6207 big-account:save-own-accounts` handler
- 配置：`package.json` 新增 `xlsx-js-style@^1.2.0`
- 数据：
  - R2 `template_big_accounts` 加列 `account_nature`
  - R2 `app_settings` 加 `own_accounts_migration_v1.5.3_done` 记录
  - R2 `own-accounts/*.json` 原地保留（不删除）
- 对外接口影响：
  - IPC `big-account:save-own-accounts` 废弃（保留源码，日志标记 deprecated）
  - IPC 新增 `monthly-balance:assemble` / `monthly-balance:export` / `template:get-big-accounts-with-own`
  - IPC `template:save-mappings` payload 新增 `bigAccounts[].accountNature`（向后兼容，缺省 `'client'`）
  - IPC `template:get-mappings` 返回的 `bigAccounts[]` 默认不含自有（UI 需要时改用新 IPC）
- 兼容性影响：
  - v1.5.2 的 `__FILENAME_MAPPING__` 主页面下拉行为被重构（模式下拉取代，`__FILENAME_MAPPING__` 作为"制作网银账单"的隐式默认）
  - bundle v3 格式：`bigAccounts[]` 新增可选 `accountNature` 字段；旧版 bundle 导入默认 `'client'`（bundleVersion 保持 v3，不升级）

## 6. 技术决策

- 方案：见 PRD §5 + TechDoc §4/5/6 完整展开。
- 关键技术决策：
  1. `xlsx-js-style` 仅在 `writers.js` 局部替换 `xlsx`（其它文件保持 `xlsx`），减少打包体积增长
  2. `getTemplateBigAccounts` 加入参 `{ includeOwn = false }`，实现 SQL 层软过滤 + 调用方显式放行（§3.1 规则的实现基础）
  3. own-accounts 数据迁移放在 `src/main.js` 启动序列（非 `database.init()`），因为需要 Electron 的 `storageRoot`
  4. 新增 IPC `template:get-big-accounts-with-own` 专供"维护大账号"对话框初始化（UI 展示两类但业务流程只用客资）
  5. bundleVersion 保持 v3 向后兼容（`accountNature` 字段可选）
- 可能风险：见 PRD §九 + TechDoc §一.2。

## 7. 数据 / 状态 / 安全影响

- 数据结构：见 PRD §八 + TechDoc §三。
- 状态流转：R1 新增 `state.currentStatementMode`、`state.monthlyBalanceReady`、`state.monthlyBalancePreview`；R1 新增 `lastGeneratedExports.monthlyBalance`；R2 新增 `app_settings.own_accounts_migration_v1.5.3_done`
- 权限 / 安全：无鉴权改动，但触及资金字段（balance-seeds 的 endBalance、大账号表的 merchant_id）。需要人工复核（PRD §九.1-2）。
- 回滚策略：见 TechDoc §八。R1 纯前端 + 新增后端读路径可代码回滚；R2 SQLite 列不可撤但兼容旧版本（own-accounts/*.json 保留为 fallback）；R3 writers 可代码回滚（xlsx-js-style 依赖可保留）。

## 8. 决策结果（PM v1 定稿）⭐

> 13 个待确认点已由用户逐条拍板（2026-04-20）。完整详见 PRD §十；此处为 Spec 层 checklist：

- [x] **Q1** 主页面下拉是否完全被"模式"取代 → **自定义**：下拉仅两值；`__FILENAME_MAPPING__` 退到"制作网银账单"内部；模板管理按钮两模式都保留在主页面
- [x] **Q2** "最新余额"定义 → **A**：取 `billDate ≤ 月末最后一日` 最大的一条；全部大于月末 → 该大账号不出现
- [x] **Q3** 模式下不可用按钮禁用置灰 → **是**（PM 推荐）
- [x] **Q4** "全部银行渠道"导出形态 → **自定义**：单文件单 sheet，所有模板/大账号/币种合并到同一 sheet
- [x] **Q5** "普通模板"定义 → **按 PM 推荐**：不含子模板 + 不含主模板 + 不含 `__FILENAME_MAPPING__`
- [x] **Q6** own-accounts/*.json 是否保留 → **自定义**：保留（不删不改名）；**同时升级为强约束**：自有账户仅在 R1 导出余额场景参与，其它场景一律过滤（PRD §3.1）
- [x] **Q7** 是否加 `account_nature` 字段 → **A**：加 `TEXT NOT NULL DEFAULT 'client'`；迁移时一个 bankName 写入所有匹配模板；冲突保留已有
- [x] **Q8** R1 余额表头 → **按 PM 推荐**：使用 `assets/余额账单模版.xlsx` 的字段，所有模板共享
- [x] **Q9** R1 文件名 + 默认选中 → **按 PM 推荐**：`月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`；弹窗模板默认 `全部银行渠道`
- [x] **Q10** R3 字体策略 → **自定义**：仅 Courier New，不加中文回退链；CJK 渲染风险由用户承担
- [x] **Q11** R3 字体范围 → **自定义**：仅表头（第 1 行）；数据区不动；新开账户模块不改；报错 xlsx 不改
- [x] **Q12** R1 报错弹框 → **按 PM 推荐**：复用项目内置 `createAlertDialog`
- [x] **Q13** R1 时间选择器年份范围 → **按 PM 推荐**：近 10 年 ~ 今年+1
- [x] **D14**（2026-04-20）OT-5 收敛 → **B（直接写死 Courier New）**：`writeBalanceWorkbook` / `writeDetailWorkbook` / `writeWorkbookRows` 内部写死字体名，不加 `applyHeaderFont` 等可选参数；新开账户模块导出表头一并变 Courier New，用户已知情并接受
- [x] **D15**（2026-04-20）R2 迁移失败策略 → **不阻塞启动**：整体 try/catch，失败后仍正常加载主窗口；失败明细写 `own-accounts-migration-v1.5.3.log`；主窗口加载完成后在状态栏以 error/warning tone 显示 `自有账号迁移失败，请查看迁移日志后联系技术支持`，保留到用户手动关闭或下一次 setStatus 覆盖
- [x] **D16**（2026-04-20）R2 迁移遇 orphan bankName → **跳过 + 写日志**：json 对应 bankName 在数据库找不到模板时跳过该 json、不中断整体迁移、不触发 D15 告警；迁移日志追加 `[WARN] orphan bankName: {bankName}, skipped ({N} accounts)`
- [x] **D17**（2026-04-22）账单拆分合并浮点精度 bug 是否在 1.5.3 内修 → **A（1.5.3 顺手修）**：用户回归测试中发现 v1.5.2 已有 bug（`file-service.js:439` 合并求和未 round），改动极小（2 行 + 1 个回归用例），不拆单独 1.5.4 hotfix 发版

## 9. 新发现的 Open Question（TechDoc 阶段引入）

- **OT-5**：已由 D14 收敛为"直接写死 Courier New"（2026-04-20），不再开放。

详细列表见 TechDoc §十一 OT-1 ~ OT-5。

---

## 10. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-04-19 | v0 骨架 |
| 2026-04-20 | v1 定稿：13 决策 checkbox 全勾；新增 §9 OT-5 |
| 2026-04-20 | D14/D15/D16 回写：§8 追加三条决策 checkbox；§9 OT-5 标记已关闭（由 D14 收敛） |
| 2026-04-22 | 用户回归发现账单拆分合并浮点精度 bug；D17 决策在 1.5.3 内顺手修；§4 新增功能点 4（R4）含 AC4-1~3 |
| 2026-04-22 | R4 实施中修正：`roundAmountHighPrecision`（12 位）对样本 2 无效，改为 `roundAmount`（2 位）；§4 边界声明同步更新 |
