# VCC 财务OP v3.2.11 两项 P2 修复复审

日期：2026-09-29。两项审查问题已修复，新增回归已先复现失败再通过；本轮完整 `release-check` 已通过（exit 0），未发现新的确定阻断问题。本记录覆盖本轮修复，不替代未完成的平台及业务规模验收。

## 范围与证据基线

- 原始审查：[2026-09-29 review.md](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/reviews/2026-09-29/review.md)，原文和原复现证据未修改。
- 分支：`codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui`；worktree：`/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool`。
- HEAD/起点：`18b82b4328cf5e00c1b2549d373a5b2f2677215c`。修复基于该 worktree 的已有未提交实现；未切换、重置或覆盖其他分支。
- 对照首轮门禁的 1776 个输入，本轮变化为 2 个生产文件和 4 个测试/集成文件；输入总数仍为 1776。新冻结清单：[review-fix-gate-inputs.json](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-review-fix-gate-inputs.json)。
- Spec 未修改，SHA256：`c4e20640566e9b309b65010668888c0d19aa75e2bdc4979a5e0adcdf63ee3db3`；范围、功能分支、D1—D7、19 项 AC 不变。TechDoc 已补充实现细节与本轮记录。

## 修复结论

### P2-1：接管 Promise rejection 经外围生命周期误报导出失败 — 已修复

修复位于 [TaskLifecycle.runFileTask](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/src/main-process/archive-center/task-lifecycle.js:538)，即 VCC 实际使用的 eager File Task。外围 await 只在业务成功、无业务异常时将接管 rejection 转为非耐久结算，再进入现有成功终态意图持久化分支。首个业务回调仍收到原 rejection，缓存 Promise 和首次 output `artifactKey + SHA256 + byteSize` 未被替换。

该改动不清空缓存、不立即重试、不提前 finish 或 ACK。提交未知的 `beforeTerminalSettlement` 仍先于新 catch 执行；失败/取消保持原拒绝语义。恢复意图写入自身抛错或返回 `persisted:false` 仍拒绝收口，不能虚报持久化成功。未修改 deferred 通路。

[实际导出集成](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/scripts/integration/vcc-financial-op-result-workbook.js:80) 已由内部 handler 调用升级为真实 Main wrapper → TaskLifecycle → Main 登记的 handler → service → readonly Worker → Publisher → SQLite/receipt。系统对话框、BOR/flow 装配使用合成夹具；不等同真实 Electron 启动。已验证：

1. 注入一次 `settleManifestArtifacts` Promise rejection 后，最外层返回 `success + pendingArchiveHandoff + warnings`，保留唯一正式文件。
2. 结算调用次数为 1，Task Run/Batch 保持 running；原 receipt 保留，`afterTerminal`/ACK 未执行。
3. 成功终态 outbox 保留原 exact owner、SHA256、字节大小和 `_archiveAfterTerminalPending`。
4. 故障解除后由原恢复入口完成接管，只保留一个 artifact，正式文件 SHA256 不变；receipt 和 outbox 最终清空，重复恢复不新增产物。
5. 原提交状态未知、旧 receipt preflight 拒绝等回归继续通过。

独立只读复审确认该修复满足 R1，未发现新增确定问题。结论针对 rejection；生产归档服务通常将其捕获的存储异常返回为 `{ok:false}`，不能据此声称原实现的所有归档失败都会误报导出失败。

### P2-2：Sheet 名 Unicode 判重与读取器不一致 — 已修复

[名称计划](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/src/backend/vcc-financial-op/result-sheet-plan.js:25) 现在同时维护 `occupied.upper` 和 `occupied.lower`。前者与公共 XLSX reader 的 `toUpperCase()` 规则一致，后者保留 ExcelJS 回读所需的 `toLowerCase()` 兼容。命中任一集合时，使用原有稳定摘要后缀消歧；完整主体身份和调整 rowKey 保持独立。

四组真实导出覆盖 `Straße/STRASSE`、`σ/ς`、`ﬀ/FF`、`ß/ẞ`。每组均为一个 XLSX、两个主体、四张 Sheet，通过生产 Writer/Validator 后再由 ExcelJS 回读；核对主体全名、主表及 Pending 金额、调整值、原因和定义名称指向，并重复导出验证名称稳定。既有非法字符、截断、单引号/逗号和旧多文件 Writer 回归继续通过。

仅改用 upper 会导致 `ß/ẞ` 在 ExcelJS 回读时报重名，该兼容回归也已实际复现并由双集合方案修复。没有合并主体、跳过主体或退回多个结果文件。

## 自动化证据

全部新增业务测试使用临时合成数据库/工作簿，没有访问真实用户账单。

| 检查 | 本轮结果 | 证据 |
| --- | --- | --- |
| R1 修复前真实外围集成 | FAIL，`INJECTED_REC02` | [red](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r1-integration-red.log) |
| R1 修复前新单测 | 2 FAIL、2 PASS | [unit red](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r1-unit-red.log) |
| R1 生命周期与原提交未知回归 | 65/65 PASS | [unit green](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r1-unit-green.log) |
| R1 实际 Main wrapper、接管与恢复集成 | 9/9 PASS | [integration green](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r1-integration-green.log) |
| R2 原始 Unicode 回归 | 4/4 FAIL | [before](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r2-before-20260929T134115429518Z.log) |
| R2 仅用 upper 的回读兼容回归 | 1/1 FAIL | [lower before](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r2-lower-before-20260929T134401516182Z.log) |
| R2 计划 / 新 Writer / 旧 Writer | 43/43 PASS（4 + 23 + 16） | [final](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-r2-final-20260929T134500181602Z.log) |
| 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` | **PASS，exit 0**；lint、架构 772/772、smoke；单测 9483 通过、0 失败、4 跳过；69/69 个集成脚本、2910/2910 项检查 | [新完整门禁日志](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-review-fix-release-check.log) |
| `git diff --check` / Spec hash | PASS / 原样一致 | 交付前已再次核对 |

本轮重新执行完整门禁；在完成后核对 1776 个冻结输入、输入集合、HEAD 和日志哈希，全部匹配，无新增或遗漏输入。日志 SHA256：`a69d82236f85581bf97b2f19cd174409dc0e48dc7d2b5da78c50e78000b81061`。4 项跳过均为 Windows 条件用例，未计为通过。`rules/integration-test-policy.md` §七由原集成 runner 自动刷新统计。详细变更指纹和 UI 哈希记录见 [review-fix-delta.json](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/outputs/vcc-financial-op-review-fix-delta.json)。原首轮 9473 通过、4 跳过、69 个集成脚本通过的结果保留为历史证据，不用于覆盖这次修改。

## 文档与剩余验收

[Spec](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/spec.md) 原样复用；[TechDoc](/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool/changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/techdoc.md) §3.3、§5.5.2、§7 和 §13 已同步修复细节。没有新增需求或验收项。

Renderer/CSS 本轮未改，既有 GUI 证据仅在文件哈希匹配后复用，不记为重新运行 GUI。Windows、Excel/WPS 实际打开与打印、原生下拉菜单方向键/Enter、实际应用退出重启及真实业务规模性能仍未完成；不能据自动化通过宣称 19 项 AC 全部完成。

本轮没有提交、推送、开 PR、合并、升版或发布。
