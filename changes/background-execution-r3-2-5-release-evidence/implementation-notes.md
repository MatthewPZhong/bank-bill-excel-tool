# v3.2.5 R3.2.5 Implementation Notes

## Baseline

- Exact base：最终传播后的 E13-G `7f9644922fde2f521c8e09fb3f856046ff9a3f1d`。
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
| checksum 由目录实际文件集合驱动 | 复核发现旧 validator 写死 `69/69`，而包中除 checksum 自身外已有 74 个普通文件；5 个既存 notes/checklist 未被列入仍可 PASS | 固定计数；只验证清单中已有路径 | 校验器现在拒绝漏列、额外、重复、乱序、逃逸路径、非普通文件和 hash 漂移；snapshot 计数来自真实验证结果。 |

## Evidence

| 证据 | 当前结果 | 覆盖范围 |
| --- | --- | --- |
| E13-G current-tree authority | 29/29 contract validation、74/74 checksum、324/324 surfaces、54 actions、61 pairs、production enabled=0 | Registry/Manifest/Inventory/Strategy 与冻结 package 完整性；旧 69 条清单因漏项作废。 |
| E13-G 最终回归 | 定向 27/27；unit 6857/6860（0 FAIL、3 SKIP）；integration 53 scripts / 2488/2488；smoke PASS | R3 开始前的精确 base 回归。 |
| R3.2.5 deterministic validator | 最终 restack 精确 head：54 actions、production enabled=0、legacy effective=54、29/29 contract checks、74/74 checksum entries；checksum 漏列、额外、重复、乱序、逃逸、非普通文件与 byte tamper 负向用例均 fail closed | action assignment、metadata/docs、安全 gate、checksum 全目录覆盖与 mutants。 |
| R3.2.5 最终本地回归 | lint PASS；E13-A～G + R3 定向 118/118 PASS；unit 6887/6890（0 FAIL、3 SKIP，`logs/unit-tests/unit-20260831-120210.log`）；integration 53 scripts / 2488/2488（315093 ms）；smoke、语法、diff PASS | 新 validator/tests、历史 evidence 复验和版本收口后的允许门禁。首次全量 unit 受宿主低内存影响，把 E13-E 测试的资源 gate 合法降为 1 child，导致测试期望 2 的 `1 FAIL`；测试改为注入其正在验证的 admitted topology 后，E13-E 精确 12/12、生产资源 gate 19/19、最终全量 0 FAIL，未改 production gate。 |

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
