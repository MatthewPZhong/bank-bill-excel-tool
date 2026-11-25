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
- 测试与夹具：B132 勾选序号用例去掉已删除的记住顺序接口，保留；记住顺序预填用例删除（功能已下线）；其余同位置新增的用例两侧都保留。
- `knowledge/backlog.md` 按条目三方合并；B133 保持「已完成」，并入余额分支的进展。`rules/integration-test-policy.md` 第七节与 E13-G 清单由检查重新生成。

## 遗留项处置（清单 B4）

- **关闭**：B129（跨 Sheet 回填已合入本轮；资金口径人工复核转由 B152 跟踪）。各分支关闭的 B5、B17、B19、B45、B57、B58、B60、B113、B114、B132、B133 见「已完成」。
- **改目标**：B152 改为「v3.2.22 发布后」（跨 Sheet 回填随本版首次发布）。
- **顺延到 v3.2.23（暂定）**：B47、B48、B52、B53、B54、B55、B56、B70、B75、B77、B79、B86、B92、B105、B120，本轮无修复纳入，已在原条目注明。
- **新增**：B134–B163（各分支登记，见上表），B164（网关账户映射的脱敏样本人工复核与界面点测）。
- **待用户决定**：B147（平盘单遍导入 Windows 实机、真实大文件与人工点按验收，目标写的是「v3.2.22（发版前）」）。

## 升版与发布文档（清单 C1–C2）

- `package.json` / `package-lock.json` 升为 3.2.22（`package.json` 只改版本行，保留原格式）。
- `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.22 条目；`src/main-process/release-notes/release-notes.json` 新增 5 条要点。
- `docs/USER_GUIDE.md`：版本与 v3.2.22 说明；「余额」导入余额文件 Q&A 改为新格式、选择余额与核对弹窗入口；第 11 条「记住大账号排序」与多对一 Q&A 改为已移除说明；第 36 条跨 Sheet 回填改为 v3.2.22 新增。各分支已写入的 USER_GUIDE 改动（特征值设置、网关账户映射、平盘、跨 Sheet 回填）随合入保留。

## 待人工复核（清单 C5）

## 验证（清单 C4）

## 合并、标签与发布（清单 E–F）

## 结论
