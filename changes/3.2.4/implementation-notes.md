# v3.2.4 Release Metadata Closeout — Implementation Notes

## Baseline

- Goal/spec：顶层 `changes/3.2.4/spec.md`、`techdoc.md` 逐字节同步冻结 v3.2.4 合同，并在最终版本分支收口元数据与发布文档。
- Exact local parent：R3.2.4 evidence `5f9ee049fc4a4daf7089fa99d98b769b3d69540f`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：版本、文档、历史 evidence、当前测试与人工边界均有可审计证据，且 main/tag/production 未修改。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 版本元数据只在最终 v3.2.4 分支收口为 `3.2.4` | 各版本必须保留自己的真实版本号 | 提前把 v3.2.2～v3.2.5 统一写成同一版本 | 后续 v3.2.5 独立 bump。 |
| 顶层 Spec/TechDoc 逐字节同步冻结来源 | 防止 metadata 节点静默改写资金、恢复或生产合同 | 在顶层副本润色或复用旧文档 | 合同 hash 可独立复验。 |
| R3.2.4 exact evidence 与当前 metadata authority 分层 | 原 evidence validator 锁定 exact parent/branch/worktree/package 事实 | 放宽旧 validator让任意后续 commit 伪装为原证据 | 历史 head 原样复验；当前版本由独立 closeout 测试证明。 |
| 文档只声明 capability，不声明 production ready | snapshot 明确 6 action 全部 production=false、legacy/0，Windows/资金/恢复仍 PENDING/NOT_RUN | 用自动测试或 synthetic benchmark 代偿人工门禁 | production enablement 继续关闭。 |

## Deviations / Evidence

| 项目 | 结果 | 影响 |
| --- | --- | --- |
| R3 branch authority 更正 | 本地临时 branch 名改为 PR #204 真实 head branch；exact `5f9ee049…` 在同名隔离 clone validator PASS、固定 8 文件 `241/241 PASS`、R3 suite `62/62 PASS` | 只修证据身份，不改业务或 gate。 |
| R3 全量 unit / integration / smoke | branch 身份更正前的同业务树为 unit `6823/6826 PASS`、`0 fail / 3 skip`，integration 53 脚本 `2488/2488 PASS`、smoke PASS；更正的两处 branch metadata 由 exact focused/validator 覆盖 | 不把 Windows skip 或人工项写成 PASS。 |
| 当前 closeout 定向与完整验证 | closeout/R3 历史隔离定向集 `17/17 PASS`；完整 unit `6763/6766 PASS`、`0 fail / 3 Windows-only skip`（421 files / 831 suites，日志 `logs/unit-tests/unit-20260830-181403.log`）；smoke PASS；`check:packaged-inputs` PASS | metadata/docs/tests-only closeout 未重跑父级完整 integration；沿用 exact R3 业务树 `2488/2488 PASS`，并由当前完整 unit/smoke 与定向 closeout 测试覆盖收口差异。 |

## Blindspot / Reconciliation

- 入口与状态：metadata commit 不接 runtime，不更改 selector；历史 R3 suite 只在 exact head/branch clone 中执行，后续 commit 不能自证为原 evidence。
- 金额/币种/行数：未修改业务源码、SQL、金额币种、方向、匹配、Workbook、样式或输出 disposition；三份文档只陈述 capability 与兼容边界。
- 幂等与恢复：JPM intent/receipt/Inspector/Recovery Hold、ReconFix/VCC Publisher 与 cleanup 合同不变；committed-result-lost 继续保留 interrupted/Hold。
- 人工红线：Windows packaged、真实 JPM/VCC 样本、Excel/WPS、RSS、资金与恢复处置仍为 `NOT_RUN/PENDING_HUMAN_REVIEW`，自动化不得关闭。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 最终远端 v3.2.4 tip/ancestry | PROBE | 业务 PR 完成后重放并核对 | 未完成前不得推 metadata tip。 |
| Windows packaged/Setup/portable、Excel/WPS、真实 JPM/VCC 文件与资金/恢复处置 | BLOCK（production） | release owner / Windows与资金人工门禁 | 不阻止 dormant capability，阻止 production/正式发布声明。 |

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
