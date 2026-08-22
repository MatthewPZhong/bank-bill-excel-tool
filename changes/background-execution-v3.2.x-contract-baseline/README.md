
# Background Execution v3.2.x Codex Implementation-Ready Baseline

本包将 E00 Platform Contract v1 与 v3.2.0～v3.2.5 文档整合为可分 PR 实施的唯一基线，并附可复跑的 Policy/Protocol/RecoverySource Schema、semantic validator、fixtures，以及可直接交给 Codex 的实施 Spec/TechDoc。

## 目录

```text
changes/background-execution/   E00规范性合同
changes/3.2.0/                  平台核心、VCC OP
changes/3.2.1/                  Toolbox、PreFund
changes/3.2.2/                  FundRecon、Duplicate、BankBU
changes/3.2.3/                  Statement、NewAccount
changes/3.2.4/                  ReconFix、VCC Financial OP
changes/3.2.5/                  只读导出、成熟adapter、全量收口
E00-F-migration-matrix.md        术语与范围迁移
implementation-sequence.md      版本顺序
changes/background-execution/validation/
                                可复跑 Schema/semantic/link/action-table 校验
P0-targeted-closure-report.md   上一轮六项P0与P1关闭记录
P0-final-recovery-contract-closure-report.md
                                前一轮恢复来源合同关闭记录
P0-recovery-source-contract-final-alignment-report.md
                                RecoverySource/Intent/Inspector/Provider 最终对齐
P0-codex-entry-contract-final-closure-report.md
                                Codex Protocol/原子性/Renderer/Validator 回修
P0-recovery-audit-atomicity-final-closure-report.md
                                恢复状态与审计事件原子性最终关闭
P0-recovery-control-transaction-observation-final-closure-report.md
                                外层事务、纯观察事件与状态边界最终关闭
implementation-notes.md         本轮决定、假设、证据与剩余未知
CODEX-SPEC.md / CODEX-TECHDOC.md
                                Codex 实施输入
validation-report.json          最新可复跑校验结果
codex-ready-revision-manifest.json
                                本轮最终回修与 Codex 输入清单
```

## 评审状态

```text
Codex Implementation Ready at documentation/contract level
Action Production Enablement remains gated
```

公共平台合同可开始编码，包括 E02-C2 的 Startup Recovery；`main-settlement` 的 publisher-journal 与 target-post-image 恢复来源已经闭环。每个资金 mutation action 仍按独立 receipt/inspector/fault-injection/人工门禁启用，未通过时保持 legacy/blocked。

本包只修改文档、JSON Schema、validation fixtures 与校验脚本；没有修改 `src/`、业务数据库或发布资产。

最新机器门禁：`24/24 PASS`；覆盖 52 个 action policy、23 个协议消息、5 组 Job/Service sequence、5 类 RecoverySource、Inspection/Settlement exact result fixtures 与 59 行 action 表。`protocol-policy-contract-drift` 冻结 exact context/wrapper、UTF-8 protocol ceiling、seq/unit gate、resource/compound/canary；`recovery-result-contract` 冻结 identity、canonical SHA-256、byte ceiling 与 conditional outcome；`recovery-control-transaction-contract-drift` 结构化校验事务入口、exact command identity、bounded patch、command→event、审计血缘及 mutation self-tests。报告哈希覆盖 60 个实际规范/fixture/validator/evidence 输入，详见 `validation-report.json`。

## 重要说明

- 本包是完整替代版，不应与旧v3.2.x草案混合引用；
- 公共术语只以`changes/background-execution/platform-contract-v1.md`为准；
- Action-level BLOCK不能因后续版本发布而自动解除；
- Capability Inventory与Effective Production Strategy Snapshot必须分开。

## 恢复合同最终规则

- `platform-recovery-source-v1.schema.json` 是 RecoverySourceV1 唯一字段定义；
- worker-durable 和 target-post-image 使用 Intent；publisher-journal 和 existing-critical-protocol 不使用平台 Intent；
- InspectorRegistry 唯一负责判定；SettlementRecoveryProvider 只枚举与恢复；
- manual hold 不进入自动 Inspector；
- Codex Protocol 摘要由 Schema 派生并接受机器漂移检查；
- TaskRun 恢复相关迁移，以及 Batch overlay、Recovery Hold、Critical Intent 迁移与对应 recovery event 必须在同一个 Main-owned control DB transaction 内提交；
- Main 只能通过 `RecoveryControlRepository.runInControlTransaction()` 开启写事务，`transitionWithRecoveryEvent()` 与 `appendObservationEvent()` 只存在于回调收到的 `RecoveryControlTransactionV1`；
- `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 只记观察事实，不修改状态，event 的 previous/next state 均为 `NULL`，sourceKind 不含 `manual`；
- 一次恢复动作涉及多个控制对象时共用一个 transaction object；TaskRun 常规生命周期不迁移所有权；Critical Intent 禁止 `committed → recovered`。
