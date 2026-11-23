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
| D4 | `template:save-mappings` 校验：未传 / `null` 保持原值；不在三档内（含非字符串）报「日期格式无效，请重新选择」；取值变化时在落库后、同步模板库文件前单独记活动日志「模板日期格式已修改」（「日期格式：旧 → 新」），同步失败也已留痕；库内三档以外的旧值按原值比较，记为「无效值「…」（按自动解析）」（旧值是任意文字，其中连续 4 位以上的数字只写位数；模板名同样，且模板维护的大账号（含库里保留的自有账号）、固定赋值与仅有币种时的大账号原样出现时整体只写位数，同次保存的「保存模板映射成功」日志共用脱敏的模板名、渠道名，release 审查） | 契约收口；日期决定交易归属日，需可审计 |
| D5 | 模板包不升版本；导入模板包时不在三档内的值按 `auto`（在导入处理器规范化；`readTemplateBundleFile` 只把非字符串按 `auto`，不新增依赖） | `dateFormat` 自 v4 起在包内，≥ v1.4.7 各版本对三档的解析一致，旧版导入结果相同；读包函数不新增依赖，免改各集成脚本按 AST 加载的函数清单 |

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
  1. 只影响带分隔符（`/ - .`）的文本日期中日、月的先后（如 `09/10/2026`、`09-10-26`）；不带分隔符的 8 位数字（`20260910` 按年/月/日、`09102026` 按日/月/年读取，见非目标）、四位年份在前的日期、英文月份、Excel 日期单元格不受影响（两位年份在前的 `yy/mm/dd` 按末段为年读取，指南提示先改成四位年份）。
  2. 日在前（不勾选时相同）按日/月/年读，这样读不是有效日期时（如 `09/13/2026`）按月/日/年读；月在前反之。
  3. 原始账单为 mm/dd/yyyy 时选月在前，否则日 ≤ 12 的日期会读成颠倒的月日。

### 4.3 主进程

- `TEMPLATE_DATE_FORMAT_LABELS`（`auto` / `DMY` / `MDY` → 显示名）与 `normalizeTemplateDateFormat(value)`（合法字符串返回值，否则空串；非字符串如 `['MDY']` 不字符串化）。
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
| Important | 以前按错误日期生成过余额，改为月在前后重新生成 | 余额种子按日存，重新生成只覆盖本次包含的日期（USER_GUIDE「余额管理」既有说明）；落在错误日期上的种子保留，后续可能被当作期初 | ASSUME：不自动清理（非目标）；USER_GUIDE 只写明不会自动修正、历史余额种子须由业务人工复核后处理、不要直接重导覆盖。逐步恢复流程不写入指南（用户 2026-11-21 决定：Codex 第四～七轮对逐步流程连续发现既有余额种子边界），风险点见 6.3 待登记项。已用错误日期生成过余额的模板需人工复核 |
| Important | 本次运行已导入文件后改格式，再导入其他文件并导出全部 | 会话条目保存导入时映射好的明细（`statement-session.js` `buildStatementFileEntry`），不随模板修改重建；与修改其他映射相同 | ASSUME：USER_GUIDE 提示把同一个文件重新导入并选【覆盖旧记录】（同路径 / 同名 / 同内容会替换会话中的旧条目；不同账单恰好同名时也会被替换，故只写「同一个文件」） |
| Important | 网页表格或分隔符文本格式的 .xls（HTML 伪 xls；逗号 / 制表符分隔的文本冒充 .xls，Codex 第三轮审查实测） | SheetJS 读取时把 `a/b/yyyy`、`a-b-yy`、`a.b.yyyy` 文本按月/日/年转成日期序号（`09/10/2026` → 2026-09-10；月份无效的 `13/09/2026` 保留文本），模板设置对这些单元格不起作用；v3.2.20 已是如此（既有行为） | 已知限制，写入 USER_GUIDE（建议改用 CSV 或标准 .xlsx）；dd/mm 的这类文件需另立任务（读取时保留原文） |
| Minor | 等待确认期间改格式 | 配置指纹含 `generationConfig.dateParseOrder`，确认时提示重新导入 | 已覆盖 |
| Minor | 月在前模板遇到 dd/mm 账单 | 逐格回退：日 > 12 的读对，日 ≤ 12 的读成颠倒月日，不报错（D2 既有语义） | 有意设计；严格模式为非目标，弹窗说明写明回退规则 |
| Minor | 模板包含无效值 / 回滚旧版本 | 导入按 auto；只写三档值，≥ v1.4.7 均能读 | 已覆盖（集成 ④） |
| — | 可观测 | 取值变化记活动日志「日期格式：旧 → 新」；无效值拒绝保存 | 已覆盖（真实应用日志） |

资金红线：未改金额、币种、方向、账号识别与幂等键；不命中红线。日期归属日变化只在用户勾选后发生，默认 `auto` 与已存模板结果不变。

### 6.2 观察到的既有问题（不在本任务范围）

- 同一 HTML 伪 xls 读取路径下，文本 `2026-09-10` 在 UTC 以西时区被读成 46274.708（前一天）；UTC+8 下为 46275.333，日期正确。只在本机（PDT）观察到。

### 6.3 待登记 backlog（合入 `release/v3.2.21` 时按 `knowledge/backlog.md` 统一编号）

| 标题 | 来源 / 等级 | 影响 | 关闭条件 | 目标版本 |
| --- | --- | --- | --- | --- |
| （P3 · 已知问题）网页 / 分隔符文本格式的 .xls 的文本日期读取时按月/日/年转换，模板日期格式不起作用 | 本分支自查（6.1）、Codex 第三轮审查 / P3 | dd/mm 的这类文件中日 ≤ 12 的日期读成颠倒的月日（既有行为） | 读取时保留原文后按模板日期格式解析，配回归 | 未定 |
| （P3 · 已知问题）HTML 伪 xls 的 ISO 文本日期在 UTC 以西时区偏移一天 | 本分支观察（6.2）/ P3 | `2026-09-10` 在 PDT 下读成前一天；UTC+8 未复现 | 确认时区来源并修复，配跨时区回归 | 未定 |
| （P3 · 已知问题）活动日志写入失败时，已落库的业务变更没有可补记的审计记录 | v3.2.21 Codex 第二轮审查 P2（本分支）；用户 2026-11-21 决定不在本分支修 / P3 | `appendActivityLogEntry` 失败只写 stderr（全局设计）；如日期格式已落库而日志未写入，重试时旧值已等于新值，不再补记。日志（`logs/`）与模板库文件（`templates/`）同在存储根目录下，需子目录权限不一致才会出现 | 设计库内审计或日志失败的补记 / 提示机制（覆盖各类审计项，不只日期格式），配回归 | 未定 |
| （P2 · 已知问题）模板日期格式变更后，按错误日期生成的历史余额缺少安全的恢复流程（资金口径 · 须人工复核） | v3.2.21 Codex 第四～七轮审查（本分支）；用户 2026-11-21 决定 USER_GUIDE 收窄为人工复核 / P2 | 自行重导重算可能写错或漏恢复余额：① 重新生成不清理错日种子，先重导后处理种子会从错日种子算起；② 种子按银行、账号、币种、日期保存，不区分模板（B35 同类），错日与正确日期上都可能与其他模板 / 渠道的种子同键，重算以 `overwrite: true` 覆盖且不触发确认；③ 一批只按本批明细算余额，渠道子模板须整批；④ 有余额附加值时分批重复叠加（B32）；⑤ 不同账单恰好同名时选「覆盖旧记录」会从本批移除先选的文件或替换会话中的同名条目 | 设计恢复流程或工具（识别受影响种子、同键冲突作为停止条件、整批重算、附加值口径随 B32），配回归后再写入用户指南 | 未定 |

## 7. 验收

| 项 | 验证 |
| --- | --- |
| MDY 下 `09/10/2026` → `2026-09-10`，各分隔符、两位年、时间后缀；auto/DMY 不变；不受顺序影响的写法 | `tests/unit/backend/file-service/normalizers.test.js` |
| 取值校验、保存/保持、模板【更新】保留、生成结果、模板包版本与往返（经真实的 `template:save-mappings` / `template:import-bundle` 处理器；含非字符串取值、模板库文件同步失败时的留痕） | `scripts/integration/statement-template-date-format.js` |
| 勾选行位置、弹窗、预览、回显、提交与放弃 | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` |
| 真实应用界面与导入导出 | 2026-11-21 本机开发版（临时 userData，合成 xlsx 文本日期）：勾选「日期格式」→ 弹窗默认月在前 →【保存】→ 映射【保存】后库内 `MDY`，再次打开回显；导入合成账单后导出明细 `BillDate` 为 2026-09-10 / 2026-09-13 / 2026-10-01，文件名 `…2026-09-10~2026-10-01.xlsx`；活动日志「日期格式：自动 → 月在前（mm/dd/yyyy）」。Windows 实机未测 |

## 8. 合入 release 时的冲突点

- `src/main.js` `template:save-mappings`（`feat/bill-split-fee-field-mapping`、`feat/cross-sheet-backfill` 也改附近）与 `template:import-bundle` 的 `saveMappings` 第 5 参。
- `src/renderer/dialogs/configuration.js`：分组标题渲染（`release/v3.2.21` 上 `feat/mapping-logic-feature-layout` 改了相邻的「原始账单预处理」标题行、加「启用」列，合入后复核本行勾选框落在竖线之间）；保存载荷（`feat/cross-sheet-backfill` 加了 `crossSheetBackfillRule`）。
- lifecycle fixture、`docs/USER_GUIDE.md`。
- 本分支不动模板包版本，与两支的 v9 不冲突；`TEMPLATE_DATE_FORMAT_OPTIONS` 与跨 Sheet 回填的 `CROSS_SHEET_BACKFILL_DATE_ORDERS` 值域、文案相同，合入后可合并为一份。
