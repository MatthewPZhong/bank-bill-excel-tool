# v3.2.5 E13-C Acquiring copy/regenerate 分类预检

## Task Brief

### Goal

按实际代码把 Acquiring 的“复制既有差异文件”和“从稳定 run 数据重建差异工作簿”固化为两个静态 action；补齐 production-disabled 的 managed capability、输入证据、输出验证与 Publisher 边界，且不改变现有用户入口、资金对账 SQL、行序、Workbook、run/resume 或生产策略。

### Context

- 当前唯一用户入口 `acquiringBillCurrency:export` 的实际行为是读取最新成功 run 的 `diff_file_path` 并执行 `fs.copyFileSync`；它不查询 `diff_rows`，也不调用工作簿 writer。
- `acquiring-bill-currency-writer.writeDiffWorkbook()` 才是从 run DB 查询并重建 XLSX 的独立能力；当前没有单独的 IPC/button 调用该能力。
- 当前 action/task binding 错误地把上述同一 export handler 同时绑定给 `acquiring:copy-existing-diff` 与 `acquiring:export-diff-workbook`，与冻结 Spec/TechDoc 的静态分类要求冲突。
- 所有 E13-C 新能力在代码合并时仍保持 `production.enabled=false`；legacy 用户路径继续可用。

### Constraints

- 不新增或删除用户入口，不根据按钮文案、文件名、文件大小或运行时分支猜 action。
- Copy 只复制经过 Main 冻结且 Worker/inline executor 复核的普通单链接文件；复制目标必须是 task-owned staging，发布仍走现有 Publisher/journal。
- Regenerate 只读取唯一、完整、稳定的 run 数据源；数据库以 read-only 打开，拒绝 partial/interrupted/unknown run，不改 SQL、排序、金额、币种、Workbook writer 或 run 元数据。
- 不修改 frozen baseline package；行为澄清只 reverse-sync 到顶层 `changes/3.2.5`。
- 不启用 production，不删除 legacy seam，不运行 `check-vars`、`scan:vars` 或 `release-check`。

### Done when

- `acquiringBillCurrency:export` 只静态归属 `acquiring:copy-existing-diff`；regenerate action 不复用该 handler。
- 两个 action 的 policy、entry、result validator、source contract 与测试均可独立验证。
- Copy 证明 source identity/hash → async staging copy → copy evidence → Publisher。
- Regenerate 证明 stable completed run DB → module writer → staging → workbook evidence/business validator → Publisher。
- source/run 变化、symlink/alias、tamper、partial/unknown run、取消和 Publisher failure 均 fail closed；legacy 路径行为不变。

## Verified Facts

| Fact | Evidence | Consequence |
| --- | --- | --- |
| 现有 export handler 只执行既有文件复制 | `src/main.js` 的 `acquiringBillCurrency:export`；`src/main-process/acquiring-bill-currency-run-data.js` 文件头合同 | handler 只能绑定 copy action。 |
| 重建能力由 `writeDiffWorkbook({ db, runId, monthKey, savePath })` 提供 | `src/main-process/acquiring-bill-currency-writer.js` | regenerate 必须是独立 thread-single entry，不能伪装成 copy。 |
| 当前没有独立 regenerate IPC/button | 全树 IPC/action 检索 | regenerate 只能作为 production-disabled dormant capability；不能凭 spec 编造用户入口。 |
| run 可能来自主库 legacy 或 per-month 侧库 | `prepareRunExport()` 与 dual-source 注释/测试 | source authority 必须显式记录 main/side、dbPath、runId、monthKey，不能只传月份。 |
| runCheck 在输出发布完成后把 `chunk_progress.status` 置为 `complete` | `acquiring-bill-currency-session.js` stage 6 | regenerate 对 modern run 必须要求 exact `complete`；partial/in-progress/data-complete 均拒绝。 |
| 现有 production strategy 全部为 false/legacy | v3.2.5 Spec + runtime policies | E13-C 只增加 capability，不改变 Effective Production Strategy。 |

## Unknowns Register

| ID | Class | Unknown | Evidence/Probe | Resolution |
| --- | --- | --- | --- | --- |
| U1 | PROBE | regenerate 是否存在独立用户入口 | 全树检索 IPC、renderer API、writer caller | 已关闭：不存在；保持 unbound dormant capability，顶层 Spec/TechDoc 明确记录。 |
| U2 | PROBE | copy source 是否已有可复用稳定 identity/hash | `prepareRunExport()` 只有同步 stat/evidence，无 content hash | 需新增 E13-C source authority；production false 路径不让同步 legacy 行为承担新 hash 成本。 |
| U3 | PROBE | regenerate 如何证明 run 完整且数据稳定 | 检查 `runs.chunk_progress`、dual-source 镜像、read-only DB transaction | modern run 要求 `complete`；冻结 sourceKind/dbPath/runId/monthKey 以及 writer 实际读取的 run/progress/flow/bill/diff 语义摘要，Worker 在同一只读事务内重算。SQLite WAL/无关页不作为业务语义 authority；legacy unknown run 不进入 regenerate。 |
| U4 | PROBE | Workbook 等价验证范围 | 复用 module writer 与 common workbook evidence；对拍 legacy writer 输出 | 禁止重写 writer；业务 validator 比对 action/source/artifact manifest，并用 golden 语义摘要证明等价。 |
| U5 | ASSUME | 当前用户另存入口是否切 production path | feature flag 仍 false，现有模式默认 legacy | 接好 false-gated managed copy 分支但不启用；回滚仍为 legacy。 |

## Risk-first Plan

1. 先固化 action/task 唯一映射与顶层合同澄清，防止继续双绑定。
2. 建立 copy/regenerate 两套精确输入与结果 schema；先测非法交叉输入、source stale、partial/unknown run。
3. 实现 copy inline executor 与 regenerate Worker，均只写 task-owned staging。
4. 复用现有 module writer 和 Publisher；补 technical/business evidence 与发布失败测试。
5. 接入 runtime 与 production-false main 分支，验证 legacy 行为、拓扑、取消和 shutdown。
6. 做 reconciliation blindspot 复核并记录资金/恢复人工门禁与剩余未知。
