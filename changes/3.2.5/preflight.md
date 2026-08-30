# v3.2.5 Contract Bootstrap — Preflight

## Task Brief

- Goal：把冻结 v3.2.5 Spec/TechDoc 与严格实施序列同步到顶层 authority，并在编码前显式核对合同包 checksum/validation evidence。
- Context：本分支精确基于本地 v3.2.4 最终候选 `dd412ea8141e0786132b31868a3006adde62f9d4`；v3.2.3/v3.2.4 仍须完成远端顺序合并，当前文档 bootstrap 不代替该 ancestry/CI 门禁。
- Constraints：不提前实现 E13-A～G；不改业务 SQL、排序、金额/币种、Workbook、事务、幂等、取消、恢复或进程拓扑；不启用 production、不合并 main、不创建 tag；资金/恢复继续人工复核；按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：顶层 Spec/TechDoc 与冻结来源逐字节一致；E13-A→G→R3.2.5 顺序和零漂移边界明确；历史 evidence 与当前树 evidence 分开记录；E13-G 明确接管当前 binding/AST authority 漂移，旧 PASS 不得代偿。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 Spec/TechDoc SHA-256 分别为 `13410e4e…98f2`、`3fb18459…e64f` | 冻结来源与顶层副本逐字节 `cmp` | 顶层副本不能自行润色或改合同。 |
| 冻结包当前 checksum 为 `61/69`，8 项漂移都可追溯到已提交的 E09/E10 合同修订 | `shasum -a 256 -c PACKAGE-SHA256SUMS.txt` 与逐 path `git log` | 禁止把旧 `69/69` 当作当前包证据，也不能只重算 checksum 掩盖语义漂移。 |
| 包内 published report 是 2026-08-24 的历史 `29/29 PASS`、68 inputs | `validation-report.json` | 只保留为历史证据，不证明当前源码/合同树。 |
| 在 v3.2.4 最终候选上重跑锁定校验器为 `28/29`，唯一失败是 `canonical-action-legacy-task-binding`，73 inputs / 122 errors | [preflight-baseline-validation.json](./preflight-baseline-validation.json) | 当前 TaskPolicy source hash、Main bootstrap proof 与 60 条 call-site provenance 必须由 E13-G 重新冻结和验证。 |
| 其余 28 个 Schema、Protocol、recovery、transaction、result、路径与文本 gate 通过 | 同次 current-tree validation | 不扩大为平台合同重写；优先修 binding/AST snapshot authority。 |
| production 仍关闭，资金/恢复人工项仍 `PENDING_HUMAN_REVIEW` | 冻结 Spec/TechDoc 与当前策略约束 | 自动门禁不能改写人工红线。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- |
| v3.2.4 最终远端 tip 是否等于本地候选 ancestry | 已知未知 | 高 | 本地 13 个 PR target 均可 fast-forward；尚未做本轮远端复核/写入 | PROBE | 按 PR exact head/base/checks 顺序核验和合并 | v3.2.5 仅本地 bootstrap，禁止越过远端前序。 |
| 当前完整 action/task inventory 与 60 条历史 provenance 的差异集合 | 已知未知 | 高 | current-tree validator 只给出集中 binding/AST drift | PROBE | E13-G 从真实 TaskPolicy/Main/注册入口重建 manifest 和 negative mutants | 不在文档 bootstrap 猜数或放宽 validator。 |
| E13-A/B 每个只读导出的真实入口、golden 与 legacy authority | 已知未知 | 高 | 冻结 Spec 给出 actionKey/门禁，代码尚未逐入口盘点 | PROBE | 逐 action 做 entrypoint→SQL→Workbook→Publisher 数据血缘表 | 在各 PR 先做 unknowns-first，再改源码。 |
| Windows packaged、真实文件、Excel/WPS、RSS 与资金/恢复处置 | 业务/发布盲区 | 高 | 当前均未由本 bootstrap 运行 | BLOCK（production） | release owner、Windows 与资金人工复核 | 不阻止 dormant capability，实现后仍阻止 production 声明。 |

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败处理 |
| --- | --- | --- | --- | --- |
| 1 | 同步权威文档与机器 preflight | 防止按旧副本实施 | exact hashes、bootstrap unit | 不进入源码实现。 |
| 2 | E13-A/B/C 先做只读输出与分类 | SQL/排序/金额币种/Workbook/输入 authority 零漂移 | legacy-vs-managed golden、DB/Workbook 等价 | action 保持 legacy。 |
| 3 | E13-D/E/F 逐 adapter 接入 | spawn/事务/幂等/取消/恢复零漂移 | topology、cancel/recovery、receipt 定向门禁 | 只回退单 action，不泛化 transport。 |
| 4 | E13-G 重建 manifest/AST authority | 关闭本 preflight 的唯一 29 项机器失败 | current-tree 29/29、checksum 69/69、coverage 100% | 不进入 R3.2.5。 |
| 5 | R3.2.5 最终证据与版本收口 | capability/effective strategy 分离，保留人工门禁 | 适当完整 unit/integration/smoke、Windows/观察/人工状态如实记录 | 不声明正式 production。 |

`release-check`、`check-vars` 与 `scan:vars` 按用户明确要求跳过，不能记录为 PASS；应分别运行允许的组成门禁并逐项记录结果。
