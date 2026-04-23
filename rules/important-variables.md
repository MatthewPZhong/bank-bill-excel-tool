# 重要变量清单

> 手工维护的"关键变量"清单。**每次代码变动前必读**，命中条目要在改动完成后做关联功能 review。
>
> 全量自动统计在 `docs/analysis/var-reference-stats.md`（由 `npm run scan:vars` 生成）。
> 触发节点与 review 流程详见 `CLAUDE.md` § 重要变量变动 check。

## 元数据

| 字段 | 值 |
|---|---|
| 清单版本 | v1（对应 app v1.5.3） |
| 上次人工 review | 2026-04-23 |
| 基线数据 | `docs/analysis/var-reference-stats.md`（28 个 JS 文件 / 355 顶层声明） |
| 下次重扫时机 | 版本号 bump / 合并到 `main` 或 `v1.5.x` 前 |
| 分层定义 | Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor |

## 如何使用本表

1. 准备改代码前：搜本表，看改动文件 / 改动符号是否在表中出现
2. 改完代码后：对命中的每一条，按"变更 review 要点"列出的清单自查一遍
3. PR body 追加"⚠️ 关联功能 review"段落，列出命中变量与 review 结论
4. 新发现的跨度 ≥ 3 的符号（见自动统计报告），评估是否升格入本表
5. 版本号 bump 时：人工完整 review 一次本表，同步进展到 CHANGELOG

本表中跨度/次数数据为**人工 review 时刻的参考**，不精确追踪每次改动（精确数据看自动报告）。

---

## 1. Critical — 业务契约锚点

**这批常量 / 类承载业务协议。**一旦修改语义，会引起**跨层联动 + 历史数据失效**，属于高风险区。

### `FIXED_FIELD_VALUE_PREFIX`
- 定义：`src/backend/database/utils.js`
- 当前值：`__FIXED__:`
- 关联功能：模板固定字段（如 `__FIXED__:MerchantId=NET001`）的序列化/反序列化
- 变更 review 要点：
  - 改前缀字符串 → 所有历史模板 JSON 失效
  - 改解析逻辑 → 固定字段注入的行数据可能错列
  - 涉及文件：`main.js`、`database/utils.js`、`statement-session.js`、模板 repository
  - 必须跑一次：带固定字段的模板导入 + 导出端到端

### `ADVANCED_MAPPING_FIELDS`
- 定义：`src/main.js`
- 关联功能：决定哪些字段走"高级映射"分支（签名金额 / 字段拆分 / 账单拆分合并 / 字段拼接）
- 变更 review 要点：
  - 增删成员 → 渲染层映射对话框 UI / 模板持久化 schema 都要同步
  - 涉及 CLAUDE.md "Amount mapping modes (4-way)" 的边界

### 4-way 金额映射模式标识
- `SIGNED_AMOUNT_MAPPING_FIELD` — 签名金额拆分
- `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` / `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` — 按字段区分发生额
- `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` / `AMOUNT_BASED_NAME_MAPPING_FIELD` — 账号 / 户名按金额匹配
- `BILL_SPLIT_MERGE_MAPPING_FIELD` — 账单拆分合并
- 定义位置：均在 `src/main.js`
- 变更 review 要点：
  - 四种模式互斥（CLAUDE.md Key Business Rules），改任意一个都要验证其他三种未串味
  - 模板 JSON bundle 的 `bundleVersion` 可能需要同步升格
  - 必跑：四种模式各一个样例模板的导入/导出

### `CONCAT_FIELDS_MAPPING_FIELD`
- 定义：`src/main.js`
- 关联功能：字段拼接映射（如 Narrative = 摘要 + 备注）
- 变更 review 要点：拼接顺序 / 分隔符变化会直接改动输出内容

### `MERCHANT_ID_SELF_INPUT_OPTION`
- 定义：`src/main.js`
- 关联功能：大账号弹窗"自行输入 MerchantId"选项；CLAUDE.md Big Account Selection 的默认分支来源
- 变更 review 要点：自行输入值落盘到 `lastFileImportContext`，导出时复用——改了标识要同步改匹配逻辑

### `BALANCE_CALCULATED_OPTION` / `BALANCE_DISABLED_OPTION`
- 定义：`src/main.js`
- 关联功能：余额字段的三态（直列 / 发生额推算 / 停用），CLAUDE.md Key Business Rules § Balance calculation
- 变更 review 要点：
  - 改枚举值会让历史模板持久化记录错位
  - **资金相关**，必跑：余额工作表（单币种 + 混币种）导出对比

### `FILENAME_MAPPING_TEMPLATE_ID`
- 定义：`src/main.js`
- 关联功能：文件名映射模板的保留 ID；不能被普通模板占用
- 变更 review 要点：若改 ID，`database/template-repository.js` 里所有 `where id = FILENAME_MAPPING_TEMPLATE_ID` 分支要同步

### `ALL_BANKS_TEMPLATE_SCOPE`
- 定义：`src/main-process/monthly-balance.js`
- 关联功能：月度余额聚合时"全行"特殊 scope 标识
- 变更 review 要点：跨表聚合逻辑依赖它识别"不限银行"

### `SUPPORTED_EXTENSIONS`
- 定义：`src/backend/file-service/common.js`
- 关联功能：文件选择对话框过滤 + 拖入校验
- 变更 review 要点：增加新格式要同步 reader 实现与 UI 提示文案

### `FileValidationError`
- 定义：`src/backend/file-service/common.js`
- 关联功能：**项目唯一自定义错误类**；所有导入/导出的错误报告格式统一靠它
- 变更 review 要点：
  - 字段 (code / message / detail lines / context) 是对外 error-report 的 schema
  - 改字段要同步所有 catch 分支 + 错误报告 writer

---

## 2. Important-skeleton — 系统骨架

**跨层协作入口。**改函数签名/语义会让上下游解析错位，但不会让历史数据失效。

### `templateRepository`
- 定义：`src/backend/database.js`（门面）
- 关联功能：所有模板 CRUD 的唯一入口；`main.js` 里 33 次调用
- 变更 review 要点：增减方法要同步 preload IPC 暴露与 renderer 对应调用
- 子方法（均在 `database/template-repository.js`）：
  - `saveMappings` / `getTemplate` / `deleteTemplate` / `listTemplates`
  - `saveBillSplitAmountRules` / `saveBillSplitMeta` / `saveBillSplitMappings`
  - `saveBillSplitMergeGroup` / `clearBillSplitMergeGroups` / `saveBillSplitRow`
  - `saveBillSplitRowCount` / `deleteBillSplitRow` / `setChildParent` / `setParentStatus`
  - `saveAmountSplitRules` / `getAmountSplitRules` / `getTemplateBigAccounts`
- 变更 review 要点：增减方法时要同步 preload IPC 暴露与 renderer 对应调用

### `settingsRepository`
- 定义：`src/backend/database.js`
- 关联功能：全局设置读写（背景色、启动偏好等）
- 变更 review 要点：renderer 侧缓存与 main 侧持久化的 key 必须对齐

### 数据清洗基础设施
- `normalizeCell` — `file-service/common.js`（**跨 13 个文件**）
- `normalizeText` — `database/utils.js` + `database/migrations.js`
- `parseNumericValue` — `file-service/normalizers.js`
- `parseDateValue` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 变更 review 要点：
  - 任何改动都会放大到 reader/writer/migrations 三条链
  - 必跑：`npm run smoke`（会触发读写管线）
  - 必验证：多种源文件格式（Excel / CSV / PDF）输入下的规范化一致性

### 读/写管线入口
- `readRows` / `readRowsWithMetadata` — `file-service/readers.js`
- `extractHeaders` / `loadEnumValues` — `file-service/readers.js`
- `writeWorkbookRows` / `writeBalanceWorkbook` — `file-service.js`（经由 `backend/file-service.js` 门面）
- `loadCurrencyMappings` — `file-service.js`（加载 `assets/币种映射表.xlsx`）
- 变更 review 要点：
  - 签名变化要同步 `main.js` orchestration
  - 输出列变化要同步 `writers.js` 的格式化规则
  - 币种映射改动 → 混币种余额表可能出现分表错位

### `ipcRenderer`（preload）
- 定义：`src/preload.js`（61 次出现）
- 关联功能：主/渲染进程通讯唯一桥；整个 `window.desktopApi` 的底座
- 变更 review 要点：新增/删除 IPC channel 必须同步 main 端 `ipcMain.handle`

---

## 3. Runtime-state — 运行时全局状态

**运行时唯一实例。**改赋值/清理时机会让 UI 与数据不同步。

### `dialog`
- 定义：`src/main.js`（来自 `require('electron')`）
- 次数：230+
- 关联功能：所有原生对话框（文件选择 / 错误报告 / 覆盖确认）
- 变更 review 要点：改 dialog 调用必须考虑用户取消分支

### `state`
- 定义：`src/renderer.js` 顶层（单例）
- 次数：120+
- 关联功能：渲染层唯一状态对象；CLAUDE.md State Management § Renderer
- 变更 review 要点：
  - 任何子字段改动都可能引起 UI 重渲染失效
  - 特别注意：模板列表 / 当前模块 / 导出可用性 三组联动

### `elements`
- 定义：`src/renderer.js` 顶层
- 次数：100+
- 关联功能：DOM 引用缓存；初始化后不可变
- 变更 review 要点：增删 DOM 节点要同步 cache 初始化

### `setStatus`
- 定义：`src/renderer.js`
- 关联功能：状态栏唯一写入口；UI 反馈核心
- 变更 review 要点：改消息格式要同步所有调用点的语气一致性

### `lastGeneratedExports`
- 定义：`src/main.js`
- 关联功能：上次导出缓存；**CLAUDE.md State Management 明确列为"不持久化全局"**
- 变更 review 要点：
  - 改生命周期会让重复导出/打开导出目录的行为异常
  - 已知副作用：重启丢失，不要为它加持久化（与现有设计冲突）

### `statementImportSessions` / `lastFileImportContext`
- 定义：`src/main.js`
- 关联功能：会话级导入上下文（CLAUDE.md State Management 提及）
- 变更 review 要点：session key 生成逻辑变化会让导出阶段丢失上下文

### `MODULES` / `setCurrentModule`
- 定义：`src/renderer.js`
- 关联功能：模块切换状态机
- 变更 review 要点：增加模块枚举要同步 UI tab + 路由分发

### `refreshTemplates`
- 定义：`src/renderer.js`
- 关联功能：模板列表刷新唯一入口
- 变更 review 要点：模板增删改后必须调用此函数，否则列表不同步

### `app`
- 定义：`src/main.js`（来自 `require('electron')`）
- 关联功能：Electron app 生命周期
- 变更 review 要点：改启动 / 退出钩子要考虑未保存状态

---

## 4. Risk-sensitive — 资金 / 过滤 / 迁移红线

**CLAUDE.md 第 7 条"风险显式提醒"覆盖区。**错一次会直接变成业务事故。

### 金额计算
- `roundAmount` — `file-service/normalizers.js`
- `sanitizeAmountValue` — `file-service/normalizers.js`
- 关联功能：金额舍入 + 格式标准化
- 变更 review 要点：
  - **资金安全**：精度/舍入规则变化会直接改账单数值
  - 必须跑：带小数点精度的 Excel 样例 + 负数样例 + 货币别名样例
  - 必须高亮提醒人工复核

### 余额计算
- `calculateEndingBalanceFromAmounts` — `file-service/normalizers.js`
- `inferEndingBalance` — `file-service/normalizers.js`
- 关联功能：由发生额倒推期末余额（CLAUDE.md Balance calculation）
- 变更 review 要点：
  - 算法变化会让所有"通过发生额计算"模式的模板输出数值变化
  - 必跑：单币种 + 混币种余额表对比
  - **资金相关**，必须高亮

### 行过滤
- `isRowMeaningful` — `file-service/common.js`
- `hasEffectiveAmount` — `file-service/normalizers.js`
- 关联功能：CLAUDE.md "Rows with both Credit and Debit = 0/empty are silently skipped"——**静默跳过判定依据**
- 变更 review 要点：
  - 判定变宽 → 会引入无意义空行
  - 判定变严 → 会吞掉真实数据（**风险更高**）
  - 必跑：带零值样本 / 仅单边有值 / 两边都非零（应该 abort）的样例

### 账单合并
- `mergeMappedDetailRows` — `main-process/statement-session.js`
- `cloneRowsWithMetadata` — `main-process/statement-session.js`
- 关联功能：账单拆分合并模式的核心实现
- 变更 review 要点：合并键变化会让历史模板合并行为不一致

### 固定字段解析
- `resolveSinglePreparedFieldValue` — `main-process/statement-session.js`
- 关联功能：`FIXED_FIELD_VALUE_PREFIX` 的消费方
- 变更 review 要点：与 Critical § `FIXED_FIELD_VALUE_PREFIX` 一起改，不可单独改

### 数据库迁移
- `hasColumn` — `database/migrations.js`
- `ensureAccountMappingCurrencySupport` / `ensureAccountMappingTemplateSupport`
- `ensureAmountSplitRulesSupport`
- `ensureBillSplitMergeSupport` / `ensureBillSplitTargetSeqSupport`
- `ensureParentTemplateSupport`
- `ensureTemplateBigAccountNatureSupport`
- `ensureTemplateDateFormatSupport`
- `ensureTemplateFilenameFixedFieldSupport`
- 定义：全部在 `src/backend/database/migrations.js`
- 关联功能：幂等 schema 升级
- 变更 review 要点：
  - **数据库迁移**，CLAUDE.md 第 7 条明确红线
  - 新增迁移必须幂等（可重复运行不破坏）
  - 必跑：空库启动 + 老版本库启动（可用之前的 `tool-data.sqlite` 备份）
  - 不允许 DROP / 破坏性 ALTER

### 大账号数据迁移
- `splitTemplateName` — `database/own-accounts-migration.js` + `database.js`
- `appendMigrationLog` / `MIGRATION_FLAG_KEY` / `buildSanitizedBankNameIndex`
- 定义：`src/backend/database/own-accounts-migration.js`
- 关联功能：2026-04 之前大账号数据从 template-scoped 到 own-accounts-scoped 的迁移（详见 memory `workflow_multi_version`）
- 变更 review 要点：
  - 这是"一次性且不可回退"的迁移
  - MIGRATION_FLAG_KEY 的含义不可改（已落盘到用户机器）

### 路径归一化
- `normalizeInputFilePaths` — `main-process/statement-session.js`
- 关联功能：跨平台路径处理（Windows 反斜杠 / 网络路径）
- 变更 review 要点：必跑 Windows 环境 + 中文路径

---

## 5. Minor — 提示性（次要）

不在前四层、但跨 ≥3 文件、且命中频率高的符号。改动时**知会**即可，不强制全量 review。

- `sanitizeBankName` — 银行名规范化，3 文件跨度
- `compileRegexLiteral` / `isRegexLiteral` — 正则字面量识别，映射 UI 用
- `groupBigAccountRows` — 大账号行聚合工具
- `inferDateCellFormat` / `toExcelSerial` — 日期格式推断
- `getStatementSessionEntries` / `getStatementSessionKey` — session 查询
- `getSetting` / `setSetting` — settings 读写
- `loadEnumValues` / `loadCurrencyMappings` — 资源加载入口

这一层从自动扫描报告里可以随时捞出 top—N，不需要在本表硬编码。

---

## 如何维护本表

本表覆盖范围有意做窄（约 60 条），追求**高信噪比**而非全覆盖。表是活的，需要随代码演进升格/降级。

### 维护分工：agent 起草 + 用户审批

**默认由 agent 起草条目草稿，用户只做审批**。用户不需要自己写变量名、关联功能、review 要点——这些由 agent 从 `scan-vars` 数据 + 代码上下文推断填入。

| 环节 | 谁做 |
|---|---|
| 发现升格/降级候选 | 脚本 (`scan:vars`) + agent (`/check-vars`) 自动扫 |
| 起草条目（层级 / 定义位置 / 关联功能 / review 要点） | agent，按下文"双门槛"判断 |
| 起草降级/删除 diff | agent |
| 最终审批 / 层级拍板 | 用户（看 diff 后 yes / no / 改层级） |
| 元数据"上次人工 review"更新 | agent，在用户 yes 后自动更新 |

**典型交互**：agent 在 PR 前 / 版本 bump 时主动汇报候选 + diff → 用户看一眼说 yes 或微调层级 → agent 落盘。用户 90% 只需说 yes，除非有层级边界争议或业务语义判断。

如果 agent 该主动起草却没起草，提醒用户：**请 agent 重读本节的"维护分工"**。

### 会不会新增？

**会**。新增来源有四类：
1. 新功能引入的新常量 / 类 / 门面（最常见）
2. 现有符号跨度扩大（本来单文件私有 → 重构后跨多文件共享）
3. 首批漏收的既有符号（数据驱动发现）
4. 降级/移出后释放出的位置

### 升格标准（双门槛，两条都过才入表）

#### 门槛一：数据门槛（硬性，由 `scripts/scan-vars.js` 自动判断）

候选必须满足以下至少一条（阈值参考 `docs/analysis/var-reference-stats.md`）：

| 条件 | 阈值 |
|---|---|
| **A-share** | `fileSpan ≥ 3` |
| **A-pair 高频** | `fileSpan = 2` 且 `totalHits ≥ 15` |
| **单文件高位** | `fileSpan = 1` 且 `totalHits ≥ 60`（仅 Runtime-state 例外） |

数据门槛未过 → 留在自动报告，**不入本表**。

#### 门槛二：语义门槛（软性，人工判断决定层级）

过数据门槛后，按语义命中决定入哪层。必须**至少命中一条**才升格：

| 层级 | 语义判据 | 参考例子 |
|---|---|---|
| **Critical** | 承载跨进程/跨版本**协议**：字符串前缀、枚举值、保留 ID、bundle 版本号、错误类 schema | `FIXED_FIELD_VALUE_PREFIX`、4-way 映射标识、`FileValidationError` |
| **Important-skeleton** | 跨层**门面 / 入口**：Repository、IPC、读/写管线 | `templateRepository`、`normalizeCell`、`ipcRenderer` |
| **Runtime-state** | 运行时**唯一实例**：单例全局 / DOM 缓存 / 会话缓存 | `state`、`elements`、`lastGeneratedExports` |
| **Risk-sensitive** | 踩 CLAUDE.md 第 7 条**红线**：资金 / 行过滤 / 迁移 / 状态机 | `roundAmount`、`isRowMeaningful`、`hasColumn` |
| **Minor** | 过数据门槛但不命中以上四条的**公共工具** | `sanitizeBankName`、`pad` |

数据门槛过 + 语义门槛未过 → 只留在自动报告，不入本表（噪音过滤）。
语义门槛过 + 数据门槛未过 → 继续观察，跨度攒够再入。

### 明确排除（不升格）

- **技术性 require**：`fs`、`path`、`XLSX` 等（运行时底座，不是业务锚点）
- **测试/脚本专用符号**：`scripts/` 不在 `scan:vars` 扫描范围内
- **私有辅助函数**：大文件内部跨度高但无跨文件协作

### 降级 / 移出标准

为避免表膨胀失焦：

1. **跨度跌破**：连续两个版本 scan-vars 显示 `fileSpan < 2` 且非 Runtime-state 单例 → 降入 Minor 或移出
2. **改名/内联**：原名不存在 → 直接删除，不保留墓碑
3. **语义消失**：业务规则变更导致该符号不再承载契约 → 按新形态重评
4. **被更高抽象替代**：出现新的更高层门面取代它 → 移入 Minor 或删除

### 触发时机与责任人

| 节点 | 动作 | 责任方 |
|---|---|---|
| 提 PR 前 | `/check-vars` 输出「升格候选」段（自动报告里新出现的 A-share ∉ 本表） | team-lead agent 提示 |
| 版本号 bump | 完整过一遍本表 + scan-vars，评估升格/降级 | 用户 + Claude 协作 |
| 合并到受保护分支前 | 增量评估（不要求全量） | team-lead agent |
| 日常 Edit/Write | 不做升格判断（只做命中 review） | agent |

### 元数据维护

每次升格/降级后，更新本文件顶部元数据表的两项：

- `上次人工 review` → 当天日期
- `清单版本` → 若结构性变化（增删层级 / 大量条目变更），版本号小升

### 结语

本表是"给下一个改代码的人 / agent 看的 SOP 手册"，不是"全量索引"。宁可漏收 2 条边缘符号，也不要把表膨胀到没人愿意看的地步。
