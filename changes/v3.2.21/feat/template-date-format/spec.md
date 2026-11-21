# Spec — 网银账单模板「日期格式」界面入口

> status: implemented
> created: 2026-11-20
> 目标版本：v3.2.21（暂定，发版时按 weekly-release 调整）
> 适用分支：`feat/template-date-format`
> 分支基线：正式标签 `v3.2.20`（`08d1fb41`）
> 依据：2026-11-20 用户需求（网银账单 · 映射关系管理）及同日确认的入口位置与交互
> 格式来源：`changes/v3.2.21/feat/mapping-logic-feature-layout/spec.md`（`release/v3.2.21`）

## 1. 背景

原始账单的日期写成 mm/dd/yyyy 文本时，日 ≤ 12 的日期（如 `09/10/2026`）被读成 10 月 9 日。

后台早已支持模板级日期顺序：`templates.date_format`（`auto` / `MDY`，v1.4.7 引入，迁移 `ensureTemplateDateFormatSupport`），解析在 `src/backend/file-service/normalizers.js` 的 `normalizeDateExportValue({ dateParseOrder })`。界面入口在 v1.4.7 因「非需求」移除（`4c75e979`、`03f84b55`、`36b24fd8`），只保留后台兼容，因此所有模板实际都停在 `auto`。

## 2. 现状核实（v3.2.20）

| 项 | 结论 |
| --- | --- |
| 映射弹窗保存 | 不传 `dateFormat`；`template-repository.js` `saveMappings` 遇空值保持原值，所以一直是 `auto` |
| IPC | `template:get-mappings` 回传 `dateFormat`；`template:save-mappings` 透传 `payload.dateFormat`，不校验取值 |
| 解析 | 只区分 `MDY`：其余值（含 `auto`、`DMY`）都按日在前，日在前不是有效日期时改按月在前；`MDY` 反之。只作用于 `a/b/yyyy`、`a-b-yyyy`、`a.b.yyyy`、`a/b/yy`（含 `年月日` 写法与时间后缀） |
| 解析调用点 | 原始日期只在 `file-service.js` 的 `BillDate`/`ValueDate` 映射与预处理过滤统计处解析，均带 `dateParseOrder`；下游只解析已规范化的 `yyyy-mm-dd` |
| 模板包 | `dateFormat` 自 v4 起随包导出、读包（`readTemplateBundleFile`）、导入（`saveMappings` 第 5 参） |
| 模板【更新】 | `updateTemplateHeaders` 只改表头与源文件名，`date_format` 保留 |
| 等待确认期间修改 | 导入配置指纹含模板记录与生成配置（含 `dateParseOrder`），改日期格式会按「配置已修改」要求重新导入 |
| 同版本口径 | `feat/cross-sheet-backfill` 的「来源日期格式」为 `auto/DMY/MDY`，文案「自动 / 日在前（dd/mm/yyyy）/ 月在前（mm/dd/yyyy）」；回填写出时 `MDY → mm/dd/yyyy`，其余 `dd/mm/yyyy` |

## 3. 已确认决策

| 编号 | 决策 | 来源 |
| --- | --- | --- |
| D1 | 存储仍为 `auto` / `DMY` / `MDY` 三档：不勾选 = `auto`；勾选后在弹窗选「日在前（dd/mm/yyyy）」或「月在前（mm/dd/yyyy）」 | 与跨 Sheet 回填、v1.4.7 原值域一致；旧库中可能存在的 `DMY` 原样回显 |
| D2 | 解析语义不变：`auto` 与 `DMY` 相同（日在前，无效时改按月在前），`MDY` 反之 | 现有口径；已存模板与兄弟分支结果不变 |
| D3 | 入口为映射关系管理「个性化映射设置」分组第一行「日期格式」勾选框；勾选即弹出「日期格式」弹窗，勾选期间右侧显示【设置】与当前选择；结果随映射【保存】提交，【返回】放弃 | 用户，2026-11-20（位置、勾选框、勾选后弹出）；【设置】与预览沿用 v3.2.19 勾选行惯例 |
| D4 | `template:save-mappings` 校验：未传 / `null` 保持原值；不在三档内报「日期格式无效，请重新选择」；取值变化时活动日志记「日期格式：旧 → 新」 | 契约收口；日期决定交易归属日，需可审计 |
| D5 | 模板包不升版本；导入模板包时不在三档内的值按 `auto`（在导入处理器规范化，`readTemplateBundleFile` 不变） | `dateFormat` 自 v4 起在包内，≥ v1.4.7 各版本对三档的解析一致，旧版导入结果相同；读包函数不新增依赖，免改各集成脚本按 AST 加载的函数清单 |

## 4. 规则

### 4.1 映射关系管理

- 「个性化映射设置」标题下第一行「日期格式」，勾选框在文字右侧（同「按字段区分发生额」）。不属于映射行（不写 `template_mappings`），存模板 `date_format`。
- 打开时：`dateFormat` 为 `DMY` / `MDY` 时勾选并显示【设置】与预览（如「月在前（mm/dd/yyyy）」）；`auto`、缺省或其他值不勾选。
- 勾选 → 立即弹出「日期格式」弹窗。弹窗【保存】暂存所选顺序并显示【设置】与预览；【取消】/ × 时，若勾选前为不勾选，则恢复不勾选。勾选状态下点【设置】再次打开，回显当前选择。
- 取消勾选 → 暂存回到 `auto`。
- 映射【保存】时随载荷提交 `dateFormat`；【返回】放弃。载荷没有「个性化映射设置」分组时（旧载荷）不显示该行、不提交 `dateFormat`。

### 4.2 「日期格式」弹窗

- 标题「日期格式」，一行「日期顺序」下拉框：日在前（dd/mm/yyyy）/ 月在前（mm/dd/yyyy）；首次勾选默认月在前；【保存】在【取消】左侧。
- 下拉框下方直接显示三条说明（不用悬停 Tips：弹窗只有一行，卡片 `overflow: hidden`，188px 高的气泡会被裁掉并让正文出现滚动条，真实应用实测发现）：
  1. 只影响写成文本的日期中日、月的先后（如 `09/10/2026`、`09-10-26`）；年在前的日期、英文月份、Excel 日期单元格不受影响。
  2. 日在前（不勾选时相同）按日/月/年读，这样读不是有效日期时（如 `09/13/2026`）按月/日/年读；月在前反之。
  3. 原始账单为 mm/dd/yyyy 时选月在前，否则日 ≤ 12 的日期会读成颠倒的月日。

### 4.3 主进程

- `TEMPLATE_DATE_FORMAT_LABELS`（`auto` / `DMY` / `MDY` → 显示名）与 `normalizeTemplateDateFormat(value)`（合法返回值，否则空串）。
- `template:save-mappings`：按 D4 校验后写入；`template:import-bundle` 写库时按 D5 规范化（`normalizeTemplateDateFormat(entry.dateFormat) || 'auto'`）。`resolveTemplateBundleVersion` 不变。

## 5. 非目标

- 8 位 `mmddyyyy` 在月在前下仍按 `ddmmyyyy`（只处理分隔符写法）。
- 不做「严格模式」（选定顺序无效时报错）与整列自动推断。
- 不改其他模块的日期解析。
- CHANGELOG、版本历史、升级说明留待发版。
- 改日期格式不作废本次会话已导入的文件，也不清理按旧日期生成的余额种子（与修改其他映射一致，见 6.1）。

## 6. 已知限制与自查

### 6.1 对账专项自查（reconciliation-blindspot-pass，时间边界 / 血缘 / 幂等 / 可观测 / 兼容）

| 级别 | 场景 | 事实与证据 | 处置 |
| --- | --- | --- | --- |
| Important | 以前按错误日期生成过余额，改为月在前后重新生成 | 余额种子按日存，重新生成只覆盖本次包含的日期（USER_GUIDE「余额管理」既有说明）；落在错误日期上的种子保留，后续可能被当作期初 | ASSUME：不自动清理（非目标）；USER_GUIDE 提示到「余额管理」核对删除。已用错误日期生成过余额的模板需人工复核 |
| Important | 本次运行已导入文件后改格式，再导入其他文件并导出全部 | 会话条目保存导入时映射好的明细（`statement-session.js` `buildStatementFileEntry`），不随模板修改重建；与修改其他映射相同 | ASSUME：USER_GUIDE 提示改格式后重新导入之前的文件并选【覆盖旧记录】（同路径 / 同名 / 同内容会替换会话中的旧条目） |
| Important | 网页表格格式的 .xls（HTML 伪 xls） | SheetJS 读取时把 `a/b/yyyy`、`a-b-yy`、`a.b.yyyy` 文本按月/日/年转成日期序号（`09/10/2026` → 2026-09-10；月份无效的 `13/09/2026` 保留文本），模板设置对这些单元格不起作用；v3.2.20 已是如此（既有行为） | 已知限制，写入 USER_GUIDE；dd/mm 的 HTML 伪 xls 需另立任务（读取时保留原文） |
| Minor | 等待确认期间改格式 | 配置指纹含 `generationConfig.dateParseOrder`，确认时提示重新导入 | 已覆盖 |
| Minor | 月在前模板遇到 dd/mm 账单 | 逐格回退：日 > 12 的读对，日 ≤ 12 的读成颠倒月日，不报错（D2 既有语义） | 有意设计；严格模式为非目标，弹窗说明写明回退规则 |
| Minor | 模板包含无效值 / 回滚旧版本 | 导入按 auto；只写三档值，≥ v1.4.7 均能读 | 已覆盖（集成 ④） |
| — | 可观测 | 取值变化记活动日志「日期格式：旧 → 新」；无效值拒绝保存 | 已覆盖（真实应用日志） |

资金红线：未改金额、币种、方向、账号识别与幂等键；不命中红线。日期归属日变化只在用户勾选后发生，默认 `auto` 与已存模板结果不变。

### 6.2 观察到的既有问题（不在本任务范围）

- 同一 HTML 伪 xls 读取路径下，文本 `2026-09-10` 在 UTC 以西时区被读成 46274.708（前一天）；UTC+8 下为 46275.333，日期正确。只在本机（PDT）观察到。

## 7. 验收

| 项 | 验证 |
| --- | --- |
| MDY 下 `09/10/2026` → `2026-09-10`，各分隔符、两位年、时间后缀；auto/DMY 不变；不受顺序影响的写法 | `tests/unit/backend/file-service/normalizers.test.js` |
| 取值校验、保存/保持、模板【更新】保留、生成结果、模板包版本与往返 | `scripts/integration/statement-template-date-format.js` |
| 勾选行位置、弹窗、预览、回显、提交与放弃 | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` |
| 真实应用界面与导入导出 | 2026-11-21 本机开发版（临时 userData，合成 xlsx 文本日期）：勾选「日期格式」→ 弹窗默认月在前 →【保存】→ 映射【保存】后库内 `MDY`，再次打开回显；导入合成账单后导出明细 `BillDate` 为 2026-09-10 / 2026-09-13 / 2026-10-01，文件名 `…2026-09-10~2026-10-01.xlsx`；活动日志「日期格式：自动 → 月在前（mm/dd/yyyy）」。Windows 实机未测 |

## 8. 合入 release 时的冲突点

- `src/main.js` `template:save-mappings`（`feat/bill-split-fee-field-mapping`、`feat/cross-sheet-backfill` 也改附近）与 `template:import-bundle` 的 `saveMappings` 第 5 参。
- `src/renderer/dialogs/configuration.js`：分组标题渲染（`release/v3.2.21` 上 `feat/mapping-logic-feature-layout` 改了相邻的「原始账单预处理」标题行、加「启用」列，合入后复核本行勾选框落在竖线之间）；保存载荷（`feat/cross-sheet-backfill` 加了 `crossSheetBackfillRule`）。
- lifecycle fixture、`docs/USER_GUIDE.md`。
- 本分支不动模板包版本，与两支的 v9 不冲突；`TEMPLATE_DATE_FORMAT_OPTIONS` 与跨 Sheet 回填的 `CROSS_SHEET_BACKFILL_DATE_ORDERS` 值域、文案相同，合入后可合并为一份。
