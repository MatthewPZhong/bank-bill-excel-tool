# v3.2.22 发布与集成记录

本文件记本轮范围、模块合入、遗留项处置与最终证据；模块内的决策、审查处置与验证细节见各 spec，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.22 |
| 操作范围 | 用户 2026-11-24 要求「除了 fix/statement-xlsx-io-boundary ，其他的分支未提交的提交一下，然后合并本地的release分支，最后执行发版流程」；追问后确认 `fix/statement-xlsx-io-boundary`「只合入已提交的部分」，随包余额模板「只留表头，并合成一个提交」 |
| 基线 | `v3.2.21` → `0e996340900916c3059a4422fbc197b2577f6c38`（PR #258 合并提交） |
| release 分支 | `release/v3.2.22`（工作树 `.claude/worktrees/release-v3.2.22`），从基线新建 |
| 远端 main | `4a60e1e2`（v3.2.21 发布记录），已于 `316a73bd` 合入 release |
| 未纳入 | `fix/statement-xlsx-io-boundary` 工作区的 8 个未提交改动（用户要求不动） |

## 纳入范围（清单 A4 / B5）

各分支先在各自 worktree 提交未提交的改动，再以 `--no-ff` 合入。`git merge-base --is-ancestor` 核对 9 个分支末端与 `origin/main` 都在 release 历史中。

| 内容 | 源分支 / 末端 | 合入提交 | 文档 |
| --- | --- | --- | --- |
| v3.2.21 发布记录（main 同步） | `origin/main` / `4a60e1e2` | `316a73bd` | [v3.2.21 记录](../v3.2.21/release.md) |
| backlog 低风险小修（关闭 B114、B19、B17、B5、B60） | `fix/backlog-low-risk-batch` / `6f4a4db3` | `d92f2f09` | [spec](fix/backlog-low-risk-batch/spec.md) |
| 映射关系管理「特征值设置」、新分隔符 | `feat/feature-value-settings` / `125d670c` | `13fb9dea` | [spec](feat/feature-value-settings/spec.md) |
| 资金对账网关对账单共用账户映射 | `feat/fund-recon-gateway-account-mapping` / `09a419a1` | `d96ae157` | [spec](feat/fund-recon-gateway-account-mapping/spec.md) |
| 网银账单 XLSX 读写边界（关闭 B133、B113、B132），只纳入已提交部分 | `fix/statement-xlsx-io-boundary` / `4bfe28a0` | `2c83254d` | [spec](fix/statement-xlsx-io-boundary/spec.md) |
| 平盘单遍导入 | `feat/position-single-pass-import` / `1602223f` | `e8183415` | [spec](feat/position-single-pass-import/spec.md) |
| 工具箱发布前核对（关闭 B57、B58） | `fix/toolbox-publication-freshness` / `c443ddf7` | `170dc3c2` | [spec](fix/toolbox-publication-freshness/spec.md) |
| 网银多模板写出回滚（关闭 B45） | `fix/statement-multi-template-rollback` / `d4a49772` | `b7be1d00` | [spec](fix/statement-multi-template-rollback/spec.md) |
| 跨 Sheet 回填（v3.2.21 顺延，关闭 B129） | `feat/cross-sheet-backfill` / `a36aafed` | `4fb4c0d2` | [spec](../v3.2.21/feat/cross-sheet-backfill/spec.md) |
| 导入余额文件改用银行原始日终余额信息、去掉账号顺序固定 | `feat/balance-eod-file-import` / `0d3dc8ee` | `3da95da9` | [spec](feat/balance-eod-file-import/spec.md) |

- 各模块分支合入前已分别完成 Codex 循环审查（见各 spec）。`feat/balance-eod-file-import` 第 29 轮的 1 个 P1、6 个 P2 都只有手工改写 XLSX 内部 XML 才能触发，用户 2026-11-24 决定不修、不登记 backlog；`feat/cross-sheet-backfill` 审查修复做到第二十九轮后提交。
- `feat/balance-eod-file-import` 提交前按用户要求把随包模板 `assets/银行原始日终余额信息.xlsx` 改为只有第 1 行表头，并与此前的修改合成单个提交 `0d3dc8ee`。

### backlog 编号改编

基线最大编号为 B133，多个分支各自从 B134 起登记。按合入顺序改编，并同步各分支 spec、代码注释与测试中的引用：

| 分支 | 分支内编号 | release 编号 |
| --- | --- | --- |
| `feat/fund-recon-gateway-account-mapping` | B134–B139 | 不变 |
| `fix/statement-xlsx-io-boundary` | B134、B135 | B140、B141 |
| `feat/position-single-pass-import` | B134–B139 | B142–B147 |
| `fix/toolbox-publication-freshness` | B138、B139 | B148、B149 |
| `fix/statement-multi-template-rollback` | B136、B137 | B150、B151 |
| `feat/cross-sheet-backfill` | B134–B139 | B152–B157 |
| `feat/balance-eod-file-import` | B134–B139 | B158–B163 |

`fix/statement-xlsx-io-boundary` 工作区未提交的改动若引用 B134、B135，下次合入时须改为 B140、B141。

### 合入冲突处理

- `src/backend/file-service/readers.js`：三个分支同改工作表定位。`findXlsxSheetXml` 先按 B133 的 `hasUnverifiableXmlMarkup` 拒绝不可核对的标记，再用跨 Sheet 回填的遮盖解析（`maskXmlMarkup` / `xmlStartTagPattern`）与表名解码，最后按余额分支移植的读取库口径（`readerWorksheetEntryKey`）核对实际读取的条目。样式表关系同样按遮盖后解析。读取选项同时保留跨 Sheet 回填各项与余额分支的 `markErrorValueRows`；余额分支的「表头以下行数」（`rowsBelowHeader`）并入跨 Sheet 回填重构后的共用 `finishMatch`。
- 合入后，workbook.xml 或关系文件含注释、制表符分隔或引号前换行的 XLSX，网银账单导入整份拒绝（跨 Sheet 回填 v3.2.21 第三十四轮起定位不到工作表原文时拒绝），不再只是不还原长数字；单测 `statement-long-number-source-text.test.js` ⑦⑧ 按此断言；跨 Sheet 回填的 4 个日期系统用例（`cross-sheet-backfill-mapping.test.js` 中 workbook.xml 注释含旧 `workbookPr`、扩展区局部命名空间加注释、`date1904` 值含制表符，`cross-sheet-backfill-writer.test.js` 中 xlsm 注释含旧 `date1904="1"`）改为预期整份拒绝，其余变体断言不变。工作表 XML 含注释时仍按「无法核对原值」提示、照常生成。已写入 B133 的进展说明。
- `src/main.js`：去掉账号顺序固定的自动套用整段（含其中 `fix/statement-xlsx-io-boundary` 为它加的 B113 报错判定 `shouldPropagateAutoMatchError` 及对应单测）。没有交易数据统一经 `createNoTransactionDataResult`：带跨 Sheet 回填逐行原因时按 v3.2.21 的方式报错（状态框可查看、导出逐行原因），否则按余额分支的口径在预检阶段带 `preservesSession`。
- 链接表 `_xHHHH_` 口径冲突（`release-check` 集成 `fund-transfer-recon-account-mapping.js` 失败时发现）：`feat/fund-recon-gateway-account-mapping` 按「单工作表流式导入保留转义原文」设计导出编码（其 spec D14、D21），`fix/statement-xlsx-io-boundary` D4b 却把流式导入改为还原 `_xHHHH_`。合入后源表字面对账ID `RID_x0041_` 按字面落库、导出却按原文编码，读回 `RIDA`（⚠️ 资金口径·标识血缘）。用户 2026-11-24 选择「本轮修复再发」：`exceljs-writer.js` 一律按已解码文本编码，`bank-statement-io.js` 去掉对账ID 的来源标记，相关单测与集成 Case K–O、R 改为合入后的口径（撤回修复时 M、O、R 共 6 个断言与独立报表单测失败，已验证）；资金对账 spec 补 D22，B134 更新为旧记录口径。
- 该修复经 Codex 只读审查 7 轮（各轮 P1 数 1、2、0、1、1、0、2），逐轮修复：剔除与退款回填文件同口径编码；按读回长度校验单格上限；附属报表写失败时主文件照常生成、原因带回界面，日志只记报表类型与错误码；导出期间离页时保存失败与未执行（busy）原因；存档结算对未写成功的输出（含抢锁失败时全部计划输出）声明未产出，业务失败且存档盘离线时随失败终态意图落盘、恢复时先重放结算；存档告警区分本次未生成、存档时找不到文件与其他存档失败，只提示重新执行业务。用户 2026-11-24 指示第 7 轮修完即提交、不再复审。
- `scripts/integration/statement-long-number-precision.js`：按 AST 抽取 `resolveDirectBigAccountRecognition` 时补注入余额分支新增的依赖 `isHeaderOnlyDetailRows`。
- 测试与夹具：B132 勾选序号用例去掉已删除的记住顺序接口，保留；记住顺序预填用例删除（功能已下线）；其余同位置新增的用例两侧都保留。
- `knowledge/backlog.md` 按条目三方合并；B133 保持「已完成」，并入余额分支的进展。`rules/integration-test-policy.md` 第七节与 E13-G 清单由检查重新生成。

## 遗留项处置（清单 B4）

- **关闭**：B129（跨 Sheet 回填已合入本轮；资金口径人工复核转由 B152 跟踪）。各分支关闭的 B5、B17、B19、B45、B57、B58、B60、B113、B114、B132、B133 见「已完成」。
- **改目标**：B152 改为「v3.2.22 发布后」（跨 Sheet 回填随本版首次发布）。
- **顺延到 v3.2.23（暂定）**：B47、B48、B52、B53、B54、B55、B56、B70、B75、B77、B79、B86、B92、B105、B120，本轮无修复纳入，已在原条目注明。
- **新增**：B134–B163（各分支登记，见上表），B164（网关账户映射的脱敏样本人工复核与界面点测）、B165（导入余额文件真实文件验收）、B166（多模板写出回滚 Windows 实机复现）。
- **关闭**：B152、B164、B165、B166（用户 2026-11-24 确认已验收）。
- **用户决定（2026-11-24）**：B147（平盘单遍导入 Windows 实机、真实大文件与人工点按验收）目标由「v3.2.22（发版前）」改为「v3.2.22 发布后」。

## 升版与发布文档（清单 C1–C2）

- `package.json` / `package-lock.json` 升为 3.2.22（`package.json` 只改版本行，保留原格式）。
- `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.22 条目；`src/main-process/release-notes/release-notes.json` 新增 5 条要点。
- `docs/USER_GUIDE.md`：版本与 v3.2.22 说明；「余额」导入余额文件 Q&A 改为新格式、选择余额与核对弹窗入口；第 11 条「记住大账号排序」与多对一 Q&A 改为已移除说明；第 36 条跨 Sheet 回填改为 v3.2.22 新增。各分支已写入的 USER_GUIDE 改动（特征值设置、网关账户映射、平盘、跨 Sheet 回填）随合入保留。

## 待人工复核（清单 C5）

本机只能做自动化测试与脚本驱动的界面实测；以下各项须人工或真实数据确认，均已登记 backlog。

**发版前须用户决定（2026-11-24 已决定）**

- B147：平盘单遍导入未在 Windows 实机上用真实 1.2GB 银行对账单与链接原始表实测耗时、内存与磁盘，没有人工点一遍导入、覆盖确认、取消、账户表确认与导出，techdoc §6 的资金红线项也没有逐项人工确认。用户决定改为「v3.2.22 发布后」（backlog 已更新目标版本）。
- B140 合并前确认：链接表源文件均由 Excel、WPS 或银行系统直接导出、未经手工改写 XML（流式读取对手工构造的结构可能与 SheetJS 读出不同，可能错取共享字符串或把不同 BizId 读成同一个键；⚠️ 资金口径）。用户已确认没有问题。
- 资金红线人工复核（合并前）：用户 2026-11-24 确认已通过；production-release 环境审批：用户 2026-11-24 同意授权。用户同时确认 B152、B164、B165、B166 已按关闭条件验收，已在 backlog 关闭；下文其余项仍按 backlog 条目跟踪。

**发布后人工复核（⚠️ 资金口径；B152、B164、B165、B166 已于 2026-11-24 由用户确认验收并关闭）**

- B152 跨 Sheet 回填：用含多笔换汇（至少一组同金额）的真实账单核对回填日期、币种、渠道与跳过行。
- B164 网关对账单共用账户映射：用脱敏的网关对账单、银行对账单与映射表跑一次资金对账，逐条核对映射命中行的回填对账ID、同渠道校验与争用告警，并点测入口与【返回】。
- 导入余额文件：用真实「银行原始日终余额信息」在普通补录与核对弹窗各导入一次，确认银行名 / 开户地匹配、同日多余额选择与写入的人工种子（B165，[spec](feat/balance-eod-file-import/spec.md) §5）。
- 多模板写出回滚：Windows 上按「打开某个导出文件后再覆盖导入」复现一次，确认余额种子与上一批导出已还原（B166，[spec](fix/statement-multi-template-rollback/spec.md) §5）；残余风险 B150、B151。
- XLSX 读写边界（[spec](fix/statement-xlsx-io-boundary/spec.md) §5）：此前用手工改写 XML 的 XLSX 或二进制 .xls、账号超过 15 位时的大账号归属，以及含 `_xHHHH_` 字面值的流水号；残余风险 B141（近似值参与账户映射与预处理过滤）、B140。
- 链接表旧记录（B134）：v3.2.22 之前经单工作表流式导入、按 `_xHHHH_` 转义原文落库的记录，导出读回显示为转义写法；检索含 `_x` 的 BizId、对账ID、账号与渠道，按源系统原始值核对。不删除旧记录，也不为改写法直接重导旧文件进生产库：入金表、网关表按键覆盖整行（含金额），同键记录若已被后续文件更新会被覆盖回旧值，键列含转义写法的单工作表文件整份不能导入（多工作表文件会导入但键可能被改写，B140）；中台调拨订单表整表替换，旧文件以外的现有记录会被删除（外汇交割表按交易编号覆盖，不受影响）。确需处理时先在数据库副本上核对（按键覆盖逐键核对，整表替换核对完整行集）。转义护栏只覆盖账户映射相关的匹配，没有告警不代表已确认（见 B134）。
- 链接表与资金对账的转义与长账号口径：B135、B136（既有问题，本轮只加护栏）。

## 验证（清单 C4）

## 合并、标签与发布（清单 E–F）

## 结论
