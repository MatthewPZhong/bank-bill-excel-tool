# v3.2.5 R3.2.5 Implementation Notes

## Baseline

- Exact base：E13-G `0a07cca0261baebe6c664f51e2271126fd639d8a`。
- Authority：[v3.2.5 Spec](../3.2.5/spec.md) §9～§12、[TechDoc](../3.2.5/techdoc.md) §9～§11、[implementation sequence](../3.2.5/implementation-sequence.md)。
- Preflight：[preflight.md](./preflight.md)。
- Done when：54-action 逐项 evidence、版本元数据、三份发布文档、允许的本地回归和安全边界全部可审计；production/main/tag 保持不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 用 deterministic authority model 生成并复验 snapshot | 手写 54 行容易遗漏、复制错 capability/effective strategy，且无法证明与 E13-G current tree 一致 | 手工维护独立表；只在 Markdown 写模块 PASS | validator 从四份 E13-G JSON、四代历史 R3 evidence 和固定 E13-A～F action set 重建期望，snapshot 任何漂移均失败。 |
| 每个 action 独立记录九类证据 | TechDoc §10 禁止用模块级“通过”覆盖 blocked action | 只保留全量 unit/integration 计数 | 每项都有唯一 baseline fixture、action-specific refs 和单独 external/production gate。 |
| 历史 action 引用历史 exact R3 evidence，新 action 引用 E13-A～F notes/tests | v3.2.5 未改历史业务算法，但 current-tree 仍需全量回归 | 把历史结果改写成 v3.2.5 新 PASS；重复生成无来源的 golden | 区分 `HISTORICAL_RELEASE_EVIDENCE`、`LOCAL_AUTOMATED_PASS`、`LEGACY_UNCHANGED` 与 canary 不适用。 |
| 所有 action 保持 KEEP_LEGACY | Windows、真实样本、RSS、观察窗口和资金/恢复人工门禁未关闭 | 因 36 capability implemented 或本地测试绿色就启用 production | 54/54 effective legacy、worker=0、featureFlag=false；legacy seam 保留。 |
| 被禁止聚合命令只记 skipped | 用户明确禁止 `release-check`、`check-vars`、`scan:vars` | 偷跑或把未运行写 PASS | 允许的 lint/unit/integration/smoke 与专用 validator 分别取证。 |

## Evidence

| 证据 | 当前结果 | 覆盖范围 |
| --- | --- | --- |
| E13-G current-tree authority | 29/29 contract validation、69/69 checksum、324/324 surfaces、54 actions、61 pairs、production enabled=0 | Registry/Manifest/Inventory/Strategy 与冻结 package 完整性。 |
| E13-G 最终回归 | 定向 27/27；unit 6857/6860（0 FAIL、3 SKIP）；integration 53 scripts / 2488/2488；smoke PASS | R3 开始前的精确 base 回归。 |
| R3.2.5 deterministic validator | CLI PASS：54 actions、production enabled=0、legacy effective=54、29 contract checks、69 checksum entries；R3 专用测试 20/20 PASS | action assignment、metadata/docs、安全 gate 与 mutants。 |
| R3.2.5 最终本地回归 | lint PASS；E13-A～G + R3 定向 113/113 PASS；unit 6877/6880（0 FAIL、3 SKIP）；integration 53 scripts / 2488/2488；smoke PASS | 新 validator/tests、历史 evidence 复验和版本收口后的允许门禁。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| R3.2.5 门禁原文包含 `release-check` 与 Windows/人工通过 | 按用户永久约束跳过聚合命令；Windows/人工以 `NOT_RUN` / `PENDING_HUMAN_REVIEW` 入证据并保持 production 关闭 | 当前无授权和环境，且用户明确禁止命令 | dormant capability 可审计合并；不得声称 production-ready 或人工 PASS | 不改冻结合同；implementation sequence 已记录命令约束和状态语义。 |

## Remaining Unknowns

| 未知 | 状态 | 下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows Setup/portable 与真实 worker/process 生命周期 | `NOT_RUN` | 后续专用 Windows release environment | 阻止 production，不阻止 dormant merge。 |
| 真实业务样本、Excel/WPS、金额/币种/Workbook 人工抽查 | `PENDING_HUMAN_REVIEW` / `NOT_RUN` | release owner + 资金负责人 | 阻止 production。 |
| RSS、event-loop 与稳定观察窗口 | `NOT_RUN` / `NOT_STARTED` | production 候选前独立观察 | 阻止 production 和 legacy seam 删除。 |
| 资金/恢复红线签字 | `PENDING_HUMAN_REVIEW` | 逐 action 核对 receipt/inspector/Hold 与真实输出 | 自动测试不能代偿。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目必须保持 `SKIPPED_USER_INSTRUCTION`，不得记录为 PASS。
