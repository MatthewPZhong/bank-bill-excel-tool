# Spec — bank-recon-output-fixes 银行对账单输出三点修复（Extra Fee 取反 / 目录互换 / 对账ID列）

> status: implemented（v3.0.4 分支，2026-06-11，commit 934148f..a3d7658；块 D F1/F2/F3 已入库，收尾文档批已落 CHANGELOG/USER_GUIDE/important-variables/backlog）
> owner: pzhong
> created: 2026-06-11
> updated: 2026-06-11
> 目标版本：**v3.0.4**（✅ 2026-06-11 用户拍板：纳入 v3.0.4 迭代作为块 D、同迭代先行落地——payment 块 F 的 error-report 终态依赖本 change；迭代入口 `changes/v3.0.4/spec.md`）
> 性质：🔴 **资金红线**（F1 输出金额符号翻转）+ 对外路径契约变更（F2）+ 报表列契约变更（F3）。每个功能 commit 一提交；提 PR 前必跑 `/check-vars`（并集命中清单见 §9.4）。
> 来源：2026-06-10 用户提出三点需求；调研方式：3 深查 agent + 3 对抗验证 agent + 1 交叉影响 agent（共实读核对 128 处 file:line 证据，三个方案均未被推翻，验证轮全部修正已并入本文）。

---

## 1. 背景

用户提出三个修复点，全部位于「资金对账数据处理」（银行对账单生成）模块：

- **F1（需求点2）**：C3 场景「金额不一致」输入框的值，写入输出 Extra Fee 列时应取**相反数**（匹配语义不变）。
- **F2（需求点3）**：错误报告与命中场景行报表的存放目录**名实错位**——`{ts}-error-report.xlsx` 落在业务目录 `bank-statement-process/{date}/`，而业务审计产物 `命中场景行-*.xlsx` 落在 `error-reports/{date}/`，需互换。
- **F3（需求点4）**：error report 的「行号」列写的是引擎内部 `_rowId`（形如 `row_37`，多文件合并后全局重编号，与任何 Excel 行号无关），对用户无意义，应换成银行行 ReconciliationId。

## 2. 代码现状（出处，全部经两轮实读核验）

### 2.1 F1 — Extra Fee 写盘链

- fee 解析：`runC3Scenario` 主循环外一次性 `fee = config.extraFee.enabled===true ? parseNumber(config.extraFee.amount) : null`（`src/main-process/scenario-engines/c3-gateway-recon-join.js:89`；`parseNumber` 见 `engine-utils.js:20-29`）。
- 匹配语义：fee 仅作用于「银行侧字段=发生额绝对值」的字段对，`Math.round((gwNum+fee)*100) === Math.round(bankNum*100)`（`c3-gateway-recon-join.js:69-75`）；fee=null 时与 v2.1.11 byte-for-byte（v2.1.12 需求5 零回归断言，`docs/iterations/v2.1.12/spec-alpha-req5-extrafee.md:175`）。
- 写盘点（**全 src/ 唯一程序写入点**，grep -a 全量核验）：匹配成功且 fee!==null 时 `const newFee = normalizeCellValue(fee)`，`oldFee!==newFee` 才写 `bankRow['Extra Fee']` + record 标黄（`c3-gateway-recon-join.js:210-221`，写盘格式约定来自 v2.1.15 W2，`docs/iterations/v2.1.15/spec.md:51-59,109`）。
- `normalizeCellValue`：number 有限 → `String(v)`；`String(-0)==='0'`，-0 边界安全（`engine-utils.js:6-12`）。
- 标黄按 `_modifiedColumns` 列名 Set，与值无关（`exceljs-writer.js:151-165`）；「命中明细」审计文本如实拼 newValue（`exceljs-writer.js:96-102`，src/ 内无其他消费）。
- 取反值的第三个出口（验证轮补充）：**命中场景行报表**按 BANK_STATEMENT_FIELDS 透写行对象（`scenario-hit-rows-writer.js:186`），取反值会同步出现，无需改代码但人工核对范围须包含。
- 其余 'Extra Fee' 命中均非写入点：`preload.js:13`（字段枚举）、`constants/bank-statement-fields.js:33`（44 列契约第 24 列）、`backend/bank-bu-recon-db/columns.js:86`（链接表导入 passthrough）。

### 2.2 F2 — 两类产物落位链

- 错误报告：`exportRootDir = path.join(ensureStorageRoot(), 'bank-statement-process')`（`src/main.js:3675`）→ warnings 非空时在 saveDialog **之前**无条件落盘（`main.js:3683-3697`）→ `writeErrorReportOutput` 内 ensureDateDir 拼 `{date}`（`bank-statement-io.js:246-254,213-219`）。
- ⚠️ **不变量**：`main.js:3675` 的 `exportRootDir` 还被 R5 场景3/4 落位兜底使用（`main.js:3782`、`:3807`），**绝不能改其本体**，只能为错误报告另引新根。
- 命中场景行报表：`writeScenarioHitRows(rows, originalFilePath, { exportRoot: ensureStorageRoot(), channels })`（`main.js:3753-3764`）→ writer 内 `DEFAULT_REPORT_SUBDIR = 'error-reports'`（`scenario-hit-rows-writer.js:43`），写失败 graceful 不阻塞导出（`main.js:3765-3773`）。
- 溯源：两次独立设计形成错位（命中场景行 = v2.1.9 N5 T26 D14=a；错误报告 = v2.0.0-beta.3 PR#32a，`CHANGELOG.md:1542`），非改错。
- `error-reports/` 现有 3 类写入方，文件名模式互不冲突（逐一核对）：生成网银账单 .txt（`logger.js:48-63`）、业务OP失败报告 .xlsx（`biz-op-recon-session.js:450,543`，其 {date} 为用户选的对账日期）、命中场景行（本次移走）。
- renderer 消费：状态框只显示**文件名**不显示路径（`renderer.js:3971-3994`）；`hitRowsReportPath/Name` 返回但 renderer 零消费；cancelled 分支直接 return，UI 无任何 error-report 提示（`renderer.js:3968`；`main.js:3710` 注释为 stale）→ **互换零 renderer 改动**。
- 测试现状：unit 落位断言以 `DEFAULT_REPORT_SUBDIR` symbol 引用（`tests/unit/main-process/scenario-hit-rows-writer.test.js:285-288`），常量改值自动跟随；integration/smoke 均传自定义 root 或走 `opts.reportDir` 旁路，零硬编码断言。**覆盖缺口：`main.js:3695` 传参无任何自动化断言（IPC handler），只能靠手测**。

### 2.3 F3 — error report「行号」列

- writer：固定 5 列表头 `['时间戳','场景名','行号','原因','可能原因']`，第 3 列写 `w.rowId ?? ''`（`src/main-process/exceljs-writer.js:179,189`）。
- `_rowId` 注入：单文件按 0-based 数据行序 `row_N`（`bank-statement-io.js:88-90`）；**多文件合并后全局重编号**（`main.js:11481-11484,11566-11571`）→ row_N 本就不对应任何 Excel 行号。
- warning 生产点全集核验（10 个 makeWarningCollector 创建点，进本 error report 的 8 个，经 `reconciliation-orchestrator.js:183-257` 汇入）：**rowId 只有「银行行 _rowId」和「null」两种，不存在指向网关行的 warning**（C2 'one-to-many' 的 rowId=银行侧 leftRow，`c2-offset-bill-mark.js:187-192`）。R1 'multi-bank-match-r1' rowId=null 但自带 `reconId` 专用字段（`r1-recon-id-match.js:90-95`）。C4 及 jpm-dispatch-order-fix 的 warnings 走独立流水线不进本报告（`main.js:3599-3604,4041,4192`）。
- F8 行数守恒契约成立：`modifiedRows + unmatchedRows = 全量 bankRows`（互斥分区，`reconciliation-orchestrator.js:103-136,263-269`）→ 导出点可全覆盖构建 `Map(_rowId → ReconciliationId)`。**注意 R5s4 的 warning 行多在 unmatchedRows（不产 modifications），Map 必须含 unmatchedRows 才能覆盖**。
- ReconciliationId 为 44 列固定表头之一（`constants/bank-statement-fields.js:21`），可能是 number 类型（`bank-statement-io.js:61-67`）→ 判空须 `String(v).trim()`。空值典型场景：导入即空且 C1 提取失败/多值不一致、未被 R5s2 回填。
- 既有断言：仅 smoke scenario-dispatcher I2 块断言第 3 列表头='行号' + 取值（`scripts/smoke/scenario-dispatcher.js:570-575`）；unit 无 writeErrorReport 测试（exceljs-writer-dual-sheet.test.js 不含）。
- 同名函数注意：`src/backend/logger.js:48` 另有 `writeErrorReport`（.txt，主模块用），与 exceljs 版同名不同物，全局操作须区分。
- NUL 字节实测：`src/main.js` 仅 `:3401/:3406` 两处，与本 change 全部编辑行不重叠，Edit 工具可直接用；但 git diff 显示 binary，review 须 `git diff --text` / `grep -a`。

## 3. 目标

- **必做**：F1 写盘取反（语义见 §4.1）；F2 目录互换（错误报告 → `error-reports/{date}/`，命中场景行 → `bank-statement-process/{date}/`）；F3 第 3 列换「对账ID」+ 空值回退链；三者的测试同步与发版三件套。
- **可不做（记 backlog，见 §9.5）**：error-causes CAUSE_MAP 补 R1/R5/C3 新 code；命中场景行报表路径的状态框展示；C3 extraFee smoke 端到端。
- **明确不做**：不动匹配语义（`c3-gateway-recon-join.js:69-75`）；不动 `config.extraFee` schema（无 DB migration）；不改任何引擎 warning push 点；不迁移历史产物文件；不动 `main.js:3675` exportRootDir 本体。

## 4. 功能点

### F1 — Extra Fee 写盘取相反数（🔴 资金红线）

- **改动（1 行代码 + 注释）**：`c3-gateway-recon-join.js:216` `normalizeCellValue(fee)` → `normalizeCellValue(-fee)`；同步改写 `:210-213` 注释块（现文案「-5→'-5'」与新行为矛盾，**必改非追加**）：写明匹配语义不变、写盘=输入框相反数、-0 边界、负输入对称取反。
- **边界**：fee=0 → `String(-0)='0'` 不出 '-0'；负输入对称（输入 -3 → 写 '3'）；「原值=newFee 不标黄」语义自动平移；enabled 但 amount 非数 → fee=null 整段跳过（不引入新路径）；老 bundle 导入的 C3 场景同样受影响（`scenarios-bundle-import.js:148-162` config 整体透传，需在 CHANGELOG 提示）。
- **风险声明**：存量已配置 extraFee 的场景升级后同一输入产出符号相反的文件；取反值同时出现在主输出、命中明细文本、命中场景行报表（落位见 F2 终态）三个出口；链接表 `extra_fee` 列新旧符号数据混存（仅 passthrough 无计算消费）。
- **验收**：unit 全矩阵通过（§9.1）；DS1-DS9 匹配语义断言**一行不改**全过（作为语义不变的回归证明）；人工核对一份真实样本三个出口的符号。

### F2 — 存放目录互换

- **改动（2 文件 3 处功能行 + 注释）**：
  1. `scenario-hit-rows-writer.js:43` `DEFAULT_REPORT_SUBDIR = 'error-reports'` → `'bank-statement-process'`（决策见 §7；头注释 `:5/:10`、`:128` reportDir 注释同步）。
  2. `main.js` `:3675` 之后新增 `const errorReportRootDir = path.join(ensureStorageRoot(), 'error-reports');`，`:3695` 实参改 `exportRootDir: errorReportRootDir`。**严禁动 `:3675` 本体**（`:3782/:3807` R5 兜底依赖）。
  3. 注释同步：`main.js:151/:3742` 文案改 bank-statement-process；顺带修正两处 stale 注释 `main.js:3710`（cancel 时 renderer 并不显示路径）与 `:3830`（hitRowsReport 状态框提示从未实现）。
- **终态路径**：错误报告 `Documents/网银账单生成小助手/error-reports/{YYYY-MM-DD}/{14位ts}-error-report.xlsx`（与生成网银账单 .txt、业务OP失败报告共目录，文件名零冲突）；命中场景行 `…/bank-statement-process/{YYYY-MM-DD}/命中场景行-{basename}-{ts}.xlsx`。
- **边界**：cancel 路径（saveDialog 前已落盘）同样落新目录，且 UI 无提示，**验收只能查文件系统**；empty 分支同落新目录；跨午夜两产物可能落不同日期目录（既有行为）；writer 自带 mkdirSync recursive，新目录首写自动创建；历史文件原地保留，按旧文档索引会找错目录 → CHANGELOG 显式说明。
- **验收**：unit 落位断言自动跟随 + 新增常量保护断言；integration 新增子目录断言（§9.2）；手测两产物落新目录（含 cancel 路径）。

### F3 — 「行号」列换「对账ID」

- **改动（3 文件）**：
  1. `exceljs-writer.js:179` 表头 `'行号'` → `'对账ID'`；`:189` 取值改三级回退链：`reconciliationId`（String+trim 非空）→ `w.reconId`（R1 专用字段，1 行顺手收益）→ `w.rowId` → `''`。旧 shape 调用方（smoke 直调 `scenario-dispatcher.js:564`、`scripts/dryrun-user-sample.js:185`）自动回退 rowId，向后兼容。`:173/:9` 注释同步（注明引擎额外字段 fields/matchedRowIds/phase/severity 等透传不写盘）。
  2. `bank-statement-io.js:246` `writeErrorReportOutput` 签名加**可选** `bankRows`；写前 enrich：`Map(_rowId → ReconciliationId)`，命中则 `{...w, reconciliationId}`。enrich 放 io 层（可被 unit/smoke 直接覆盖，main.js 难单测）。
  3. `main.js:3693-3696` 调用点加一行入参 `bankRows: [...modifiedRows, ...unmatchedRows]`（F8 契约保证全覆盖；**unmatchedRows 必含**，R5s4 warning 行依赖它）。
- **语义说明（spec 固化）**：展示值=导出时**最终** ReconciliationId（warning 产生后可能被 C1/R5s2 改写），与主输出文件可交叉定位，有意为之；rowId=null 的 config 类 warning 列值仍 `''`；同一 reconid 多行（R1 multi-bank-match）无法唯一定位行——审计如需行级唯一键再升级并列两列（writer 改动点相同，成本低）。
- **验收**：新增 writer 三态 unit（reconid 非空/空回退 rowId/全空 ''）；smoke I2/W3/E4 断言改造（§9.2）；人工打开一份样本确认列名与回退显示。

## 5. 交叉影响（实施约束，违反必出错）

1. **同 hunk 串行**：F2 与 F3 都改 `main.js:3693-3696` 同一调用表达式 → 两 commit 必须串行（顺序见 §8），后做方以先做方落地后的实际行号为准（F2 插常量行会使后续行号 +1）。
2. **双重契约变更合并提示**：error report 一个 change 内同时换目录（F2）+ 换列名（F3）；命中场景行报表同时换目录（F2）+ 含取反值（F1）→ CHANGELOG 必须合并成一段适配提示，不写三条孤立条目。
3. **smoke `bank-statement-io.js` W3 块单一归属**：由 F3 一次重写（传 bankRows + 第 3 列断言 + 新增 W3b 回退用例）；F2 放弃在该块补可选断言，杜绝同块二次编辑。
4. **docs 共享行终态一次编辑**（归 commit 4）：`USER_GUIDE.md:687`（F2 路径 + F3 列说明同一行）、`:1916`（F2 路径表 + F3 列说明 + 命中场景行新位置）、`:796`（「负数写 '-5'」与 F1 直接矛盾，**必须改写**）。
5. F1 与 F2/F3 零代码文件交叉（F1 仅动 c3 引擎 + 其单测），可独立 review。

## 6. 影响范围

- **生产代码**：`src/main-process/scenario-engines/c3-gateway-recon-join.js`、`src/main-process/scenario-hit-rows-writer.js`、`src/main-process/exceljs-writer.js`、`src/main-process/bank-statement-io.js`、`src/main.js`（5 文件，全部小改）。
- **对外契约变更（🔴 需 CHANGELOG 显式标注）**：① Extra Fee 列数值符号翻转；② 两类产物路径互换（外部 VBA/pandas 脚本按旧路径读取需适配，v2.1.9 同级别提示）；③ error report 第 3 列「行号」→「对账ID」（按列名解析需适配）。
- **零改动面**：renderer / preload / IPC 字段、DB schema（无 migration）、引擎匹配与 warning 逻辑、44 列表头契约（列名 Extra Fee 不变只变值）。
- **README.md:138**（error-reports 目录描述）互换后仍成立可不改；可顺带补 bank-statement-process 一行（可选）。

## 7. 技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| F1 负输入处理 | 对称取反（`-fee` 无特判） | 规则单一可解释；匹配语义天然不变 |
| F2 子目录改法 | 直接改 `DEFAULT_REPORT_SUBDIR` 常量值（非参数化） | 全仓唯一生产 caller；unit/integration 以 symbol 引用自动跟随零改写；参数化保留旧默认值=永久回退隐患；`opts.reportDir` 旁路已是逃生口 |
| F2 错误报告落位 | 共用 `error-reports/{date}/` 不另设子目录 | 文件名零冲突；「出错统一去 error-reports 找」正是本次语义统一目标 |
| F3 空值回退 | 单列替换 + 三级回退链（不并列两列） | row_N 常态无用户价值；回退仅兜底唯一定位；升级两列成本低可后补 |
| F3 表头命名 | 「对账ID」 | 与模块 UI/内置场景名既有用户语言一致（USER_GUIDE.md:723-724） |
| F3 enrich 落点 | `writeErrorReportOutput` 内（可选 bankRows 参数） | io 层纯函数可直接单测；main.js 只加一行 |
| 文档时序 | 全部 docs 按合并终态在 commit 4 一次落 | 任何中间态文档要么写旧路径要么写旧符号都是错的 |

## 8. 实施顺序（4 commits）

1. **commit 1 = F1**（extra-fee 取反）：与另两点零文件交叉，diff 最纯净；唯一资金数值语义变更，review 火力集中。
2. **commit 2 = F3**（对账ID列）：先确立 `writeErrorReportOutput` 新签名与 `main.js:3693-3696` 调用点终态；自动化覆盖齐全（自带 tmp root，与目录互换无关），可在旧目录形态独立验证全绿。
3. **commit 3 = F2**（目录互换）：只剩改一行实参 + 插一行常量，叠加 diff 最小；其唯一覆盖缺口（main.js:3695 无自动化断言）靠收口手测，放最后使一次 `/verify` 即覆盖三点终态，避免二次手测。
4. **commit 4 = docs/spec/守卫收口**：发版三件套（含合并适配提示）、`rules/important-variables.md` 注记 + 陈旧行号顺带修复（`:867` c3 定义行实际 `:81`；`:878` writeBankStatementOutput 实际 `exceljs-writer.js:104` 5 参；`:597-598` processingResult 结构补 unmatchedRows 等字段）、backlog 三条沉淀（§9.5）。
- 之后跑 `npm run scan:vars` + `/check-vars` + `npm run release-check` 全量 → 提 PR（草稿按惯例落 `docs/prs/待merge-PR #N.md`；PR 描述注明 main.js binary diff，review 用 `git diff --text`）。

## 9. 测试与验收

### 9.1 unit

- `c3-gateway-recon-join.test.js`：改期望值约 15 处断言/fixture 行（W2-1 `:164,168`；W2-2 `:176,179,183`；W2-4 `:232,233`；W2-5 `:263,264`；W2-V2 `:445,446`（负输入对称核心断言）；W2-V3 `:453`；W2-V4 `:460`；W2-V5 `:469,470`）；W2-V1 期望 '0' 不变但补 -0 显式锁定；新增 2 条迁移边界用例（旧正值 '5' 被覆盖为 '-5' 标黄；原值已 '-5' 仅 lock）；**DS1-DS9 与 W2-3 一行不改**。
- 新增 `tests/unit/main-process/exceljs-writer-error-report.test.js`：三态回退链 + 5 列表头断言。
- `scenario-hit-rows-writer.test.js`：新增常量保护断言 `DEFAULT_REPORT_SUBDIR === 'bank-statement-process'`（防互换被无意回退）。

### 9.2 integration / smoke

- `scripts/integration/bank-statement-hit-scenario-report.js`：`:6` 注释 + 新增 `filePath.includes('bank-statement-process')` 断言。
- `scripts/smoke/scenario-dispatcher.js` I2（`:570-575`）：表头第 3 列 '行号'→'对账ID'；样本加 reconciliationId 断言 + 回退断言。
- `scripts/smoke/bank-statement-io.js` W3 重写（传 bankRows 断言第 3 列=ReconciliationId）+ 新增 W3b（缺省/空 → 回退 rowId）。
- `scripts/smoke/scenario-end-to-end.js` E4：C1 多值不一致样本断言空 reconid 回退链路端到端。
- 收口 `npm run release-check` 全量（unit + integration + smoke 三层）。

### 9.3 合并手测（一次 `/verify` 覆盖三点终态）

样例同时产生 warnings + C3 extraFee 命中，验收：
- [ ] `error-reports/{date}/{ts}-error-report.xlsx` 存在，第 3 列=对账ID，空值行回退显示 row_N
- [ ] `bank-statement-process/{date}/命中场景行-*.xlsx` 存在且 Extra Fee=取反值
- [ ] 主输出 Extra Fee 取反 + 标黄 + 命中明细文本含负值记录
- [ ] cancel 路径：**查文件系统**确认 error report 落新目录（UI 无任何提示，`renderer.js:3968` 直接 return）

### 9.4 check-vars 并集命中（PR body「⚠️ 关联功能 review」段，去重后）

`runC3Scenario`（:866 Risk-sensitive 🔴）/ `writeBankStatementOutput`（:877）/ `processingResult`（:596-603）/ `bankStatementSession`（:576-585）/ `runAllScenarios`+`unmatchedRows` 反向 filter 契约（:184-205 Critical 🔴，F3 的 Map 全覆盖性直接依赖）/ `INTERNAL_FIELDS`（:461-463 同文件关联）。

### 9.5 backlog 沉淀（commit 4 统一追加 `knowledge/backlog.md`）

1. `error-causes.js` CAUSE_MAP 缺 R1/R5/C3 新 code → 「可能原因」列显示「未知错误」（`error-causes.js:48-49`）。
2. 命中场景行报表路径的状态框展示（`hitRowsReportPath` 零消费 + `main.js:3830` stale 注释）。
3. 可选：C3 extraFee smoke 端到端真实账单用例。

## 10. 待拍板

- [x] **D1 目标版本**：✅ 已拍板（2026-06-11）= **v3.0.4**（方案 A；纳入 v3.0.4 迭代块 D，分支已切出；PR #70 已合 main）
- [ ] **D2 负输入对称取反**：输入 -3 → 写 '3'（推荐对称，无特判）
- [ ] **D3 表头命名**：「对账ID」（推荐）/「ReconciliationId」/ 两者并写
- [ ] **D4 空 reconid 回退**：单列 + 三级回退链（推荐）/ 并列两列
- [ ] **D5 writer 顺手认 `w.reconId`**（R1 多匹配警告对账ID不再为空，1 行）：推荐做
- [ ] **D6 USER_GUIDE 历史章节**（:623/:2433 v2.1.9 特性记载）：加「v3.0.x 起改为…」注记不改史（推荐）/ 直接改
