# v2.0.0 现有模块全量回归测试计划

> **目标**：验证 v2.0.0 Pending 模块（T1-T11）改动对**所有现有业务场景**的回归验证，覆盖：
> 1. 网银账单生成（`制作网银账单` 模式）— USER_GUIDE §1.1
> 2. 月度余额账单生成（`导出月度余额账单` 模式）— USER_GUIDE §1.1（v1.5.3 新增）
> 3. 新开账户余额账单生成 — USER_GUIDE §1.2
> 4. UI 层交互（顶部模块切换器 / 状态栏 / 按钮可用矩阵）

> **触发背景**：v2.0.0 动了 `src/main.js`（15 IPC）/ `src/renderer.js`（state 扩 pending 子树 + MODULES 扩 3 选 + setCurrentModule 改写）/ `src/preload.js`（挂 `window.desktopApi.pending`）/ `index.html`（加第 3 个 module panel + 下拉第 3 项）。改动虽是"纯追加"，但必须端到端回归。

---

## 一、覆盖矩阵总览

| 层 | 执行方 | 断言 / 场景数 | 说明 |
|---|---|---|---|
| A. 自动化回归 | agent | ~130+ 断言 | 已有脚本端到端覆盖 |
| B. 静态一致性 | agent | 6 项 | 语法 / IPC / state / elements / 字段冲突 |
| C. 手工 UI 全量 | 用户 | 50+ 场景 | Electron 渲染 / 用户交互 |

---

## 二、A 自动化测试（agent 本轮执行）

### A1. smoke-test 综合（`npm run smoke`）

**覆盖 6 大 scenarios**（见 `scripts/smoke/scenarios.js`）：

| Scenario | 覆盖业务点 |
|---|---|
| `runDatabaseScenario` | 模板 CRUD / 映射持久化 / 大账号（client + own 双形态）/ accountNature / bundle v3 |
| `runAssetAndDateScenario` | 币种映射表读取 / 余额模板读取 / 日期格式推断 |
| `runMappingScenario` | 字段映射 4-way 模式（签名金额 / 字段拆分 / 账号按金额匹配 / 账单拆分合并）/ 字段拼接 |
| `runWorkbookScenario` | xlsx 读写 / 合并单元格 / 表头识别 |
| `runLoggingScenario` | 错误报告 xlsx 文件名 + schema / activity log |
| `runMonthlyBalanceScenario` | R1 月度余额装配 Q2 规则 + Q5 "普通模板" + Q6 自有账号 / pickLatestSeedForAccount exact/fallback |

### A2. v1.5.2 backend（`npm run test:v1.5.2`）

**18 个 test 覆盖**：

| 组 | 测试 | 场景 |
|---|---|---|
| T1 主/子模板名校验（4）| T1-1 ~ T1-4 | 子名包含主名 / 不包含 / 同名 / 空主名 |
| T2 大账号选择 state（3）| T2-1 ~ T2-3 | fileIndex / 只改 merchantId+currency / block 粒度 assignment |
| T3 按表头自动识别（8）| T3-1 ~ T3-8 | 表头匹配成功/失败 / 唯一命中 / 0 命中 / 多命中 / 整批截断 / DB 幂等 |
| T4 bundle v3（2）| T4-1 ~ T4-2 | bundleVersion=4 携带 filenameFixedField / 旧 bundle 兼容 |
| 其他 | 细节断言 | — |

### A3. v1.5.2 state machine（`npm run test:v1.5.2:sm`）

**M:1 映射状态机多场景**（左文件/右大账号勾选顺序、pendingGroup 处理、multiMode 切换、buildFinalAssignments 输出）。

### A4. v1.5.3 回归（`node scripts/test-v1.5.3-regression.js`）

**23 个 runCase 覆盖**：

| Section | 用例 | 覆盖业务点 |
|---|---|---|
| 1. R1 装配（7）| P0-4 ~ P0-7, P0-10, P0-11, P1-3 | 单模板命中 / 当月无更早有 / billDate 全过月末跳过 / 完全无 seeds 跳过 / 全部银行渠道合并 / 自有账号放行 / 多币种大账号 |
| 2. R1 IPC 校验（2）| P0-8, P0-9 | 模板查不到不抛 / year+month 非法抛异常 |
| 3. R2 迁移三态（3）| P0-13 ~ P0-15 | 迁移成功（多模板 + orphan 跳过）/ 幂等 / 冲突保留已有 |
| 4. R2 过滤 + bundle（15）| P1-4, P1-5, P0-F1 ~ P0-F13 | 不重插 / bundle accountNature / Finding 1-13 修复 |
| 5. R3 字体 XML（7）| P0-17 ~ P0-20, P1-6 ~ P1-8 | 明细 / 余额 / 月度余额 / 合并 / 新开账户 / 导出 xlsx styles.xml Courier New 级验证 |
| 6. R4 浮点精度（3）| P0-R4-1 ~ P0-R4-3 | 2377.49+178.31 / 65572.01+4917.90 / 0.1+0.2-0.3 精确值 |

### A5. v2.0.0 pending 4 件套（`npm run test:v2.0.0:pending-*`）

| 脚本 | 断言 / 场景 |
|---|---|
| pending-import | 21 / 7（多文件合并 / 表头 / 资金类型枚举 / 行级冲突 / 覆盖 / DB 一致性）|
| pending-session | 19 / 5（fresh / need-confirm / overwrite+archive / 报错缓存+xlsx / 成功后 errors 清理）|
| pending-reconcile | 23 / 7（new/missing/changed 4×4 样本 / 多 matchField / compare=[] / run 保留 / benchmark / 非法 field 抛错）|
| pending-export | 22 / 2（单月 34 列 / changed before/after / 按 fund_type 分 sheet / 汇总 2 sheet）|

---

## 三、B 静态一致性

### B1. 语法检查

对所有本版本修改过的文件：
```bash
node --check src/main.js
node --check src/preload.js
node --check src/renderer.js
node --check src/renderer-pending.js
node --check src/renderer-dialogs.js
node --check src/backend/pending-db.js
node --check src/backend/pending-db/*.js
node --check src/backend/pending-import/*.js
node --check src/backend/pending-reconcile/*.js
node --check src/backend/pending-export/*.js
node --check src/main-process/pending-session.js
```

### B2. IPC channel 唯一性

`pending:*` 全部是新 namespace，不与现有 `file:*` / `template:*` / `big-account:*` / `balance-adjustment:*` / `monthly-balance:*` / `account-mapping:*` / `window:*` / `app:*` / `error:*` / `new-account:*` / `background:*` 冲突。

验证：
```bash
# 列出所有 channel 名字，检查无重复
grep -oE "ipcMain\.handle\('[^']+'" src/main.js | sort | uniq -d
```

### B3. state 字段不冲突

`state.pending` 是新 key，和现有 `state.mode / selectedTemplateId / monthlyBalanceReady / selectedNewAccountCurrencies / backgroundPicker / ...` 等并列，无字段名冲突。

验证：
```bash
grep -oE "state\.[a-zA-Z_]+" src/renderer.js | sort -u
# 确认 pending 作为一级 key 独立出现
```

### B4. elements DOM 引用不冲突

新 DOM ref 全用 `pending` 前缀：`pendingRuleBtn / pendingImportBtn / pendingRunBtn / pendingExportBtn / pendingStatusBox / pendingModulePanel / pendingModuleSwitcherOption`。

### B5. preload 导出不覆盖

`window.desktopApi.pending` 是新 key；现有 `app / errors / background / accountMappings / window / templates / bigAccount / balanceAdjustment / files / monthlyBalance / newAccount` 全部保留。

### B6. DB schema 隔离

`tool-data-pending.sqlite` 独立文件；与 `tool-data.sqlite`（主 DB）无表名冲突风险（即使撞名也在不同文件）。主 DB 迁移序列（`database/migrations.js`）零改动。

---

## 四、C 手工 UI 全量业务场景（用户本机执行）

> 启动：`npm start`。本章按业务场景分区；优先级 `P0` 必测 / `P1` 应测 / `P2` 可选。

### §1 顶部模块切换（UI 骨架，P0）

- [ ] **C1-1** 顶部切换器下拉展开：应看到 3 项（`网银账单生成` / `新开账户余额账单生成` / `月度 Pending 数据核对`）
- [ ] **C1-2** 首次启动默认 `网银账单生成`；状态栏显示 v1.5.3 默认欢迎文案
- [ ] **C1-3** 切到 `Pending` → 切回 `网银账单生成` → 再切到 `新开账户`：每次切换只有对应 panel 显示，其它 hidden
- [ ] **C1-4** 关闭 app 重开：默认仍是 `网银账单生成`（OT-2 不持久化）
- [ ] **C1-5** 切换瞬间不弹任何提示 / 不需要"确认"按钮（AC1-3）

### §2 网银账单生成 — 模板管理（P0）

- [ ] **C2-1** 模板管理：点击"模板管理"打开对话框 → 显示所有模板 / 主模板 / 子模板层级正确
- [ ] **C2-2** 导入模板：.xlsx → 提示"填入银行 / 地区 / 模板名 / 字段固定值"正常
- [ ] **C2-3** 导出模板 bundle：选择模板 → 导出 JSON bundle（v3 版本）包含 bigAccounts[].accountNature 字段
- [ ] **C2-4** 导入模板 bundle：v3 新 bundle 正常 / v2 旧 bundle 自动升级 / v4+ 拒绝
- [ ] **C2-5** 模板重命名：能改；改后列表刷新
- [ ] **C2-6** 模板删除：能删；关联映射清理

### §3 网银账单生成 — 映射关系管理（P0）

- [ ] **C3-1** 打开映射管理对话框：显示当前模板的字段映射表
- [ ] **C3-2** 4-way 金额映射模式：
  - [ ] 直接 Credit / Debit 映射
  - [ ] 签名金额（`SIGNED_AMOUNT_MAPPING_FIELD`）
  - [ ] 按字段区分发生额（`AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD`）
  - [ ] 账单拆分合并（`BILL_SPLIT_MERGE_MAPPING_FIELD`）
- [ ] **C3-3** 四种模式互斥：切模式后之前的映射值自动清理
- [ ] **C3-4** 字段拼接（`CONCAT_FIELDS_MAPPING_FIELD`）：Narrative = 摘要+备注 拼接顺序 / 分隔符可配置
- [ ] **C3-5** 字段固定值：`__FIXED__:MerchantId=NET001` 格式保存 / 导出时注入行
- [ ] **C3-6** 账号/户名按金额匹配（Payee/Drawee）：根据发生额方向自动分配
- [ ] **C3-7** 余额字段三态：直列 / 发生额计算 / 停用 各一次切换
- [ ] **C3-8** 映射保存：重开对话框能看到之前的选择
- [ ] **C3-9** 主/子模板名校验：勾"设为子模板"选主模板后子名不包含主名 → 阻止保存 + 提示框

### §4 网银账单生成 — 大账号维护（P0）

- [ ] **C4-1** 维护大账号对话框：tbody 同时显示 client + own（own 行前缀 `[自有] `）
- [ ] **C4-2** 编辑态下勾选 block 位置不漂移
- [ ] **C4-3** 单账号匹多文件（M:1）：勾选"单个账号匹多个文件" → block 粒度勾选不同组
- [ ] **C4-4** 导入银行账号信息 Excel：按 sheet 识别 client / own 账户分类
- [ ] **C4-5** 保存大账号：accountNature 透传 DB；维护对话框关闭后能重开看到

### §5 网银账单生成 — 文件导入（P0）

- [ ] **C5-1** 支持扩展名：`.xlsx` / `.xls` / `.csv` / `.pdf` 都能选到
- [ ] **C5-2** 多文件批量导入：一次选 5 个文件
- [ ] **C5-3** 文件重复判重（v1.5.1）：路径 / 文件名 / 内容三维度；重复 → 提示跳过
- [ ] **C5-4** 按表头自动识别模板（`__FILENAME_MAPPING__`，v1.5.2 默认）：
  - [ ] 唯一命中 → 直接按该模板解析（不弹模板选择）
  - [ ] 0 命中 → `FILENAME_MAPPING_NO_MATCH` 整批截断
  - [ ] ≥2 命中 → `FILENAME_MAPPING_AMBIGUOUS` 整批截断
- [ ] **C5-5** 指定模板导入：下拉切到具体模板 → 导入文件
- [ ] **C5-6** 表头不匹配：报 `HEADER_MISMATCH`（仅在指定模板模式下，默认模式没这个错）
- [ ] **C5-7** 行过滤：Credit + Debit 都 0/空 → 静默跳过（`isRowMeaningful=false`）
- [ ] **C5-8** 异常：Credit 和 Debit 两边都非零 → 报错 + 导出错误报告

### §6 网银账单生成 — 大账号选择（P0）

- [ ] **C6-1** 导入后弹大账号选择对话框：显示 distinct (MerchantId, Currency) 组合
- [ ] **C6-2** 多文件 / 多 block：左侧文件列表 + 右侧大账号 + 字母排序
- [ ] **C6-3** M:1 模式切换：勾选后 block 粒度独立勾选
- [ ] **C6-4** 已映射 block 不参与"提取大账号顺序"（v1.5.2 新）
- [ ] **C6-5** 自行输入 MerchantId（`MERCHANT_ID_SELF_INPUT_OPTION`）：选该项后显示输入框；导出时复用该值

### §7 网银账单生成 — 账户映射（P0）

- [ ] **C7-1** 打开账户映射管理：按模板隔离（v1.5.1）
- [ ] **C7-2** 同一银行账号在不同模板下配置不同系统账号
- [ ] **C7-3** 保存后重开对话框数据保留
- [ ] **C7-4** 正则字面量：输入 `/regex/` 格式 → 识别为正则

### §8 网银账单生成 — 导出（P0）

- [ ] **C8-1** 导出明细（COMMON）：生成到 `Documents/网银账单生成小助手/exports/{date}/`
- [ ] **C8-2** 导出余额（BALANCE）：生成对应 balance 文件 / 按币种多 sheet（混币种）
- [ ] **C8-3** 多模板合并：`{模板数量}-COMMON-{日期范围}.xlsx` + 合并后保留各自银行 / 所在地
- [ ] **C8-4** 导出 xlsx **第 1 行表头字体为 Courier New**（v1.5.3 R3）
- [ ] **C8-5** 数据区字体保持默认
- [ ] **C8-6** 账单拆分合并：`net = credit - debit` 结果 2 位小数精确
- [ ] **C8-7** 签名金额拆分：导出后 Credit / Debit 方向正确
- [ ] **C8-8** 按币种 / 金额列拆分 + 按规则合并

### §9 模式下拉（`状态栏 "模式"`，P0）

- [ ] **C9-1** 模式下拉显示 2 项：`制作网银账单` / `导出月度余额账单`
- [ ] **C9-2** 切到 `导出月度余额账单` → 按钮矩阵：
  - [ ] 导入文件 / 导出明细 / 账户映射 **置灰禁用**
  - [ ] 导入模板 / 模板管理 / 导出余额 **可用**
- [ ] **C9-3** 切回 `制作网银账单` → 按钮状态恢复

### §10 导出月度余额账单模式（P0）

- [ ] **C10-1** 点 `导出余额` → 弹 `createMonthlyBalanceExportDialog`
- [ ] **C10-2** 对话框：
  - [ ] 标题"请选择需要导出月度余额账单的银行渠道"
  - [ ] 模板下拉 default=`全部银行渠道`（`ALL_BANKS_TEMPLATE_SCOPE`）+ 普通模板列表
  - [ ] 年份范围 = 近 10 年 ~ 今年+1
  - [ ] 月份下拉必须主动选（无默认值）
- [ ] **C10-3** E1/E2/E3 校验：模板空 / 时间空 / 两者都空 → `createAlertDialog` 弹提示
- [ ] **C10-4** E4 范围无余额：`所选模板在 {year}年{month}月的月末及更早均无余额记录...`
- [ ] **C10-5** 装配成功 → 再点 `导出余额` → 弹系统保存对话框另存
- [ ] **C10-6** 文件名：`月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`
- [ ] **C10-7** 单文件单 sheet 合并所有模板 / 大账号 / 币种
- [ ] **C10-8** 表头字体 Courier New
- [ ] **C10-9** Q2 最新余额定义：
  - [ ] billDate === 月末最后一日的 seed 优先
  - [ ] 无则 billDate ≤ 月末的最大 seed（fallback）
  - [ ] 全部 billDate > 月末 → 跳过该大账号不报错
- [ ] **C10-10** 含自有账号（own）参与装配（§3.1 隔离规则：仅本模式放行）

### §11 历史 own-accounts/*.json 迁移（启动时，P0）

- [ ] **C11-1** 首次启动新 2.0.0 版本：如用户机器有旧 `own-accounts/*.json`，启动日志写 `own-accounts-migration-v1.5.3.log`，迁移完成状态 `done`
- [ ] **C11-2** 第二次启动：`already-done`，不重复迁移（D15 幂等）
- [ ] **C11-3** orphan bankName（json 中 bankName 在数据库里无匹配模板）：整份跳过 + `[WARN]` 日志（D16）
- [ ] **C11-4** 迁移失败：`lastOwnAccountsMigrationError` 缓存 → 状态栏以 error tone 显示告警

### §12 自有账号隔离规则 §3.1（跨模块，P0）

以下场景**自有账号必须过滤**：
- [ ] **C12-1** 主页面`制作网银账单`模式 → 大账号选择对话框：不含 own
- [ ] **C12-2** 模板管理 → 映射关系管理：字段固定分配不含 own
- [ ] **C12-3** 明细账单生成：不映射 own 账号
- [ ] **C12-4** 账户映射对话框：不含 own
- [ ] **C12-5** 大账号排序（提取大账号顺序）：不含 own

以下场景**自有账号放行**：
- [ ] **C12-6** 维护大账号对话框：tbody 同时渲染 client + own（own 前缀 `[自有] `）
- [ ] **C12-7** 导出月度余额账单模式：装配时包含 own（`includeOwn: true`）

### §13 新开账户余额账单生成（P0）

- [ ] **C13-1** 切到 `新开账户余额账单生成` 模块
- [ ] **C13-2** 填写账户：银行名称 / 所在地 / 币种 / 银行账号 / 开户日期
- [ ] **C13-3** 单币种账户：币种下拉
- [ ] **C13-4** 多币种账户：勾选右侧 `多币种账户` 后 → 币种多选
- [ ] **C13-5** 单账户多银行账号：点 `+` 按钮添加行
- [ ] **C13-6** 多组账户：添加多个账户组 → 批量生成
- [ ] **C13-7** 点 `生成`：状态栏提示"新开账户余额账单已生成，可点击导出"
- [ ] **C13-8** 点 `导出`：另存 xlsx → 表头字体 Courier New / 数据正确 / 与余额模板一致

### §14 UI 交互细节（P1）

- [ ] **C14-1** 背景色选择器：打开 / 切色 / 保存 / 重置 正常
- [ ] **C14-2** 窗口最小化 / 最大化 / 关闭按钮正常
- [ ] **C14-3** app 启动信息：`appVersion` 显示 `2.0.0-beta.1`
- [ ] **C14-4** 使用手册保存：`保存使用手册` 按钮能导出 `docs/USER_GUIDE.md` 到用户选定位置

### §15 错误上报 / 日志（P1）

- [ ] **C15-1** 错误发生时产生 `Documents/网银账单生成小助手/error-reports/{date}/*.xlsx`
- [ ] **C15-2** 错误报告 xlsx 文件名：`YYYYMMDD-HHMMSS-template-*.txt`（文件名正则已在 smoke 验证）
- [ ] **C15-3** 点 `导出最后一次错误` → 能保存报告
- [ ] **C15-4** `Documents/网银账单生成小助手/app_activity_log.txt` 持续追加

### §16 Pending 模块基础自检（P0，新功能 sanity）

- [ ] **C16-1** 切到 `月度 Pending 数据核对` → 看到两行按钮 + 状态栏"初次使用请确认..."
- [ ] **C16-2** 规则管理：对账字段 + 对账内容 → 保存 → 状态栏变"请导入 Pending 数据"
- [ ] **C16-3** 导入 1 个 xlsx → 成功 → 状态栏变成功文案 + 绿边框
- [ ] **C16-4** 同月再导 → 弹覆盖确认 → 留底文件在 `pending-archives/`
- [ ] **C16-5** 导入 2 个不同月份 → 点 `开始运行` → 对账完成
- [ ] **C16-6** 点 `导出差异` → 弹单月/汇总选择 → 另存 xlsx

### §17 Pending 模块异常路径（P1）

- [ ] **C17-1** 表头不匹配的 xlsx → 状态栏 `表头字段不一致...`
- [ ] **C17-2** 资金类型非 {提现/退票/充值} → 状态栏 `导入失败，发现 N 条 pending资金类型 值不合法` + 红边框 + 鼠标手势
- [ ] **C17-3** 多文件重复行 → 状态栏 `导入失败，发现 N 条重复行`
- [ ] **C17-4** 点击状态栏（红色态）→ 保存报错 xlsx → 明细正确（schema = source_file/sheet_row/severity/message + 31 原列）
- [ ] **C17-5** 选 2 个非相邻月 → 弹 alert + 保留已选值重开对话框
- [ ] **C17-6** 少于 2 月时点"开始运行" → alert `至少需要 2 个月...`
- [ ] **C17-7** 对账完成后改规则 → 重跑 → 两条 run 都在；导出"汇总"取最新

### §18 Pending 模块导出细节（P1）

- [ ] **C18-1** 单月导出 xlsx：`Sheet1 汇总` 有 31 + 1 + 2n 列；Sheet2~N 按 fund_type 动态分 sheet
- [ ] **C18-2** 汇总导出 xlsx：`按月维度区别汇总` + `汇总` 两 sheet；compareFields 并集展开
- [ ] **C18-3** `changed` 行 31 原列用 lower；`_before`=upper / `_after`=lower
- [ ] **C18-4** `new` 行 31 原列用 lower；`_before`/`_after` 都空
- [ ] **C18-5** `missing` 行 31 原列用 upper；`_before`/`_after` 都空
- [ ] **C18-6** 表头字体 Courier New

### §19 跨模块并存稳定性（P1）

- [ ] **C19-1** 在网银账单模式下工作（导入 + 导出）→ 切到 Pending 模块 → 再切回 → v1.5.3 session 数据（`lastGeneratedExports` / `statementImportSessions`）无丢失
- [ ] **C19-2** Pending 模块运算中（对账跑着）→ 切到网银账单模式：不中断对账；切回来仍显示结果
- [ ] **C19-3** 两 DB 并存：`tool-data.sqlite` 和 `tool-data-pending.sqlite` 都存在；删任一不影响另一

### §20 启动时崩溃保护（P2）

- [ ] **C20-1** `tool-data-pending.sqlite` 文件损坏 / 锁定 → `openPendingDb` try-catch 失败，Pending 模块按钮置灰，但主 DB + 两个现有模块仍可用
- [ ] **C20-2** 主 DB 损坏 → 应用以错误状态启动；Pending 模块独立 DB 不受影响

---

## 五、通过标准

- **A 全部 PASS**（约 130+ 自动化断言）
- **B 静态检查全绿**（6 项）
- **C 手工测试**至少完成 P0 场景（§1~§13, §16）+ §17-18 关键异常路径

任一 A 或 B 失败 → 停止合并，先排查回退原因。
C 的 P0 有失败 → 必须修复后再合并；P1/P2 失败视情况决定是否阻断。

---

## 六、记录

| 时间 | 执行人 | 层次 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-04-24 | agent | A1 smoke | **PASS** | 6 scenarios 全过 |
| 2026-04-24 | agent | A2 v1.5.2-backend | **17/17** | T1-T4 全组 |
| 2026-04-24 | agent | A3 v1.5.2-sm | **25/25** | M:1 状态机全场景 |
| 2026-04-24 | agent | A4 v1.5.3-regression | **P0 31/31 + P1 5/6 (1 skipped)** | skipped 项为 txt 报告无字体可验，非失败 |
| 2026-04-24 | agent | A5 pending-import | **21/21** | — |
| 2026-04-24 | agent | A5 pending-session | **19/19** | — |
| 2026-04-24 | agent | A5 pending-reconcile | **23/23** | T10 tie-breaker 后稳定 |
| 2026-04-24 | agent | A5 pending-export | **22/22** | — |
| 2026-04-24 | agent | B1 语法 | **PASS** | 18 个文件全 OK |
| 2026-04-24 | agent | B2 IPC | **PASS** | 72 channel，0 重复 |
| 2026-04-24 | agent | B3 state | **PASS** | state.pending 12 字段独立子树 |
| 2026-04-24 | agent | B4 elements | **PASS** | 6 个 pending* DOM ref 全对应 HTML id |
| 2026-04-24 | agent | B5 preload | **PASS** | 14 个一级 API key 无冲突，pending 为新 key |
| 2026-04-24 | agent | B6 DB schema | **PASS** | 5 表 + 4 索引幂等，独立文件 |
| 待填 | 用户 | C | 未跑 | 本地 `npm start` 跑；§1~§13 + §16 为 P0 |

**A 层总计**：smoke + 17 + 25 + 31 + 5 + 21 + 19 + 23 + 22 = **~163 断言全绿**
**B 层总计**：6 项静态检查全过

**结论**：v2.0.0 改动对现有两个模块（网银账单生成 / 月度余额账单生成）以及新开账户余额账单生成**未引入任何可自动化发现的回退**。C 手工场景需用户启动 `npm start` 后按清单跑 P0。

---

## 七、失败排查

1. **A 退化**：`git log --oneline v1.5.3..v2.0.0` + `git bisect` 找到 v2.0.0 里的回退 commit
2. **B 退化**：通常是语法或 state/elements/IPC 字段冲突，对比 git diff 就能找到
3. **C 手工退化**：优先怀疑 renderer 层 — state.pending 扩展触及 `state.mode` 或 `state.currentModule` 切换路径；或顶部下拉改动影响现有模块 panel 显隐
