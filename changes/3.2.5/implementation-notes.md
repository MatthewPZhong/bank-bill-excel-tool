# v3.2.5 Implementation Notes

## Baseline

- Goal：完成 v3.2.5 E13-A～G、R3.2.5、版本元数据/发布文档与最终审计收口。
- Exact local parent：v3.2.4 最终本地候选 `dd412ea8141e0786132b31868a3006adde62f9d4`。
- Authority：[spec.md](./spec.md)、[techdoc.md](./techdoc.md)、[implementation-sequence.md](./implementation-sequence.md)。
- Preflight：[preflight.md](./preflight.md)、[preflight-baseline-validation.json](./preflight-baseline-validation.json)。
- Done when：8 PR 严格顺序实施/传播/合并到 v3.2.5；当前树 validation/checksum、版本/三份发布文档、适当完整测试与人工状态均可审计；main/tag/production 不修改。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 顶层 Spec/TechDoc 逐字节同步冻结来源 | 防止按老 changes 副本或编号猜范围 | 在顶层副本润色合同 | 后续行为变更必须先反向同步冻结 authority。 |
| 旧 `29/29` 与 `69/69` 只作历史证据 | 当前独立复验为 checksum `61/69`、validation `28/29` | 重算 checksum 伪造一致 | E13-G 必须修真实 binding/AST authority 后再生成最终证据。 |
| 文档 bootstrap 不新增功能 PR | 冻结 Spec 已明确 8 PR 序列 | 增加第 9 个纯文档 PR | bootstrap 作为 v3.2.5 base/E13-A 祖先。 |
| Capability 与 Effective Production Strategy 分开 | 所有 action 初始 production disabled，人工/观察门禁未关闭 | 用实现完成自动启用 production | 每 action 可独立保持 legacy/blocked。 |
| 不运行用户禁止的三个聚合/变量命令 | 用户明确禁止 `release-check`、`check-vars`、`scan:vars` | 把未运行项写为 PASS | 用允许的 unit/integration/smoke/定向验证逐项记录，禁止虚报。 |
| E13-A 先以真实入口冻结 action 与 source authority | Pending summary 当前绑定错误、错误报告是 Main 内存状态、BizOP 为 side/legacy 双源 | 直接照 action 名猜 worker 输入 | 详细决策和证据见 [e13-a-preflight.md](./e13-a-preflight.md) 与 [e13-a-implementation-notes.md](./e13-a-implementation-notes.md)。 |

## Evidence / Deviations

| 项目 | 当前结果 | 影响/后续 |
| --- | --- | --- |
| Frozen document hashes | Spec `13410e4e…98f2`；TechDoc `3fb18459…e64f`；split plan `27bbdde9…174a` | 顶层副本可逐字节复验。 |
| Package checksum | `61/69`，8 项漂移均有提交来源 | E13-G 前不得宣称 package integrity PASS。 |
| Published/current validation | published historical `29/29`（68 inputs）；current tree `28/29`（73 inputs，binding/AST authority 一项失败） | 旧 report 不代偿当前树；E13-G 负责真实修复。 |
| Production/human gate | production=false；资金/恢复 `PENDING_HUMAN_REVIEW` | 本 bootstrap 不改变。 |
| E13-A unknowns-first | summary=aggregate；Pending errors 需 managed source；Pending/BizOP stable gate 必须在 Worker read snapshot 内复核 | 进入模块专用 worker 实施；不改 legacy effective strategy。 |
| E13-A capability validation | 定向 `18/18 PASS`；重点既有回归 `181/181 PASS`；完整单测 `6784/6787 PASS`（`0 FAIL`、`3 SKIP`）；相关集成 `179/179 PASS`；smoke PASS；Main freeze 为紧凑 run/dataset/revision 证据，Pending 大错误源采用版本 authority + 异步流式 staging | 本地 capability 已收口；production 仍为 false，Windows/真实样本/资金恢复人工门禁留到 R3.2.5。 |

## Blindspot / Reconciliation

- E13-A 已增加 dormant `src` capability，但 production 仍关闭；复用既有 SQL、排序、金额币种、Workbook 与 Publisher，不改变业务结果或持久化语义。
- E13-A/B/C 必须先建立入口到输入 authority、SQL、排序、Workbook、Publisher 的数据血缘，再实施。
- E13-D/E/F 必须证明不新增额外 spawn、事务边界/receipt/cancel/recovery 零漂移。
- E13-G 不能通过放宽 AST/provenance gate 或仅刷新 hash 关闭 finding；必须以真实生产入口重建 coverage。
- 资金、恢复、Windows、真实样本和 production enablement 保持人工门禁。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 最终 v3.2.4 远端 ancestry/CI | PROBE | 完成 #199～#207 与 #194～#204 顺序合并后建立 v3.2.5 | 未完成前不推 v3.2.5。 |
| 真实 action/task inventory 与 provenance 差异 | PROBE | E13-G 重建 manifest/AST snapshot 和 mutants | 未 29/29、69/69 前不进 R3.2.5。 |
| Windows、真实文件、Excel/WPS、RSS、资金/恢复人工复核 | BLOCK（production） | release owner / Windows / 资金负责人 | 阻止 production/正式发布声明，不阻止 dormant implementation。 |

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
