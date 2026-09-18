
# Background Execution v3.2.x Codex Implementation-Ready Baseline

> Contract Authority v1 revision 2：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`5c9ee53437d487a94ddb0f0d236dec7b07d4545452c9ebe3c6e98593de209ff2`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本次受控迁移相对 revision 1 精确提升到 revision 2，删除一条已被实际入口语义替代的 stale pair，并补登记两个冻结 Spec 明确要求的 PreFund deferred legacy action，以 61 条独立 provenance 重新锚定；固定 `genesis=false`、`approvalStatus=PENDING_HUMAN_REVIEW`。repo gate 必须从 merge-base 读取 previous，受控 payload 变化仍须 revision 精确 +1；same-revision flip 必须失败。`contractVersion=1` 保持不变，当前 revision 2 不等同于 Contract Authority v2。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

本包将 E00 Platform Contract v1 与 v3.2.0～v3.2.5 文档整合为可分 PR 实施的唯一基线，并附可复跑的 Policy/Protocol/RecoverySource/RecoveryControl Schema、semantic validator、fixtures，以及可直接交给 Codex 的实施 Spec/TechDoc。

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
changes/background-execution/recovery-contract-authority.v1.json
                                独立非生成 binding/result/inventory digest/count/version 权威
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
P0-recovery-control-identity-replay-contract-errata-report.md
                                Batch canonical identity 与 eventId 跨重启重放合同勘误
P0-recovery-control-redline-human-review-checklist.md
                                recovery 幂等/血缘资损红线人工复核入口（PENDING）
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

本轮勘误在合同包外只新增生产 action/task binding registry、Main 启动 fail-fast 接线与对应 unit test；不改变 TaskPolicy get/list/require shape、IPC、业务数据库、production action enablement 或发布资产。

规范成功形态固定为 `29/29 PASS`；实际机器门禁状态以本次生成的 `validation-report.json` 为准。

最新机器门禁以本次生成的 `validation-report.json` 为准；published report v17 只由 repo/default 生成，并以 5 个对称 provenance KAT 与 no-write exact gate 锁定 complete normalized authority provenance、canonical generation command、input hashes、repo/external/detached mode、base/merge-base、HEAD/Git physical identity 及 external path/size/SHA-256。其余覆盖包括明确 `genesis=false`/PENDING trust disposition 的独立 Contract Authority v1 revision 2、external previous 单调 revision gate、Git explicit-genesis previous-absence gate、clean-environment physical-workspace identity 与 linked-worktree 分类、detached non-merge-evidence 分类、递归 duplicate-safe machine JSON loader、两组协调同步 mutation、52 个 action policy、真实 owned 122-key TaskPolicy inventory（JCS digest `95381024…b368`）、61 个 canonical/legacy binding pair及61条独立 provenance、18 个 production Node hostile/reachability API case、21 个 startup AST/CommonJS loader mutants、23 个协议消息、5 组 Job/Service sequence、5 类 RecoverySource 与 59 行 action 表。门禁同时冻结 RFC 8785/JCS（15类 runtime reject + 9项 raw KAT）、20 个 recovery request、2 个 immutable 20-field result DTO、独立 20×20 full-result KAT（digest `1ced39a5…c039`）、20 个 requestKey namespace/tuple、owner/event 五项 FK、observation durable ordinal/attempt FK、跨重启 A→B→replay A、5 段物理 SQL、20 baseline + 460 mutation SQLite result round trips 与 295 个逐 leaf hash sensitivity assertions；详见 `validation-report.json`。external/detached 正向证据只写包外临时 report 后同 provenance 复验，使用 published repo report 必须失败。人工资损红线 checklist 保持 `PENDING_HUMAN_REVIEW`，不得把机器 PASS 解释为人工已批准、merge-ready 或 production enablement。

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
- Batch overlay command exact identity 显式携带 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair；Repository 同事务 CAS Task/Batch identity 后写 canonical event lineage；
- public canonical/legacy binding digest/count/version 的单一机器权威为独立 `recovery-contract-authority.v1.json`；生产 `ActionTaskBindingRegistry` 的不可注入模块常量提供 runtime pair，Action Manifest v3 只作审计 snapshot。factory 单次读取 frozen exact plain host 的真实 TaskPolicy list 并持有 descriptor-safe owned snapshot/private Sets，冻结完整 inventory digest；Main freeze 严格早于 DB/IPC，hidden/accessor/Proxy/Map/prototype/hostile cause、后改、等数量替换、bound 缺失、duplicate、taskKey/channel mismatch 与 empty/missing/mismatch pair 均 fail closed，返回数组不泄漏内部 state；
- canonical JSON 固定 RFC 8785/JCS 与 lowercase SHA-256；共享 Python/Node KAT 覆盖 UTF-16 ordering、ECMAScript number/escaping，raw duplicate/unsafe integer 与 runtime-domain rejection；
- Main-owned persistent request owner 固定 20-branch requestKey/eventId/createdAt/完整 request_jcs/hash；recovery event 由 composite FK 持久相同五项 identity，transition/observation writer 分域；
- observation 在 owner 前持久分配 durable `observationAttemptId`；同 ordinal restart exact replay，下一 ordinal 才追加 event，attempt/event composite FK fail closed；
- `platform-recovery-control-v1.schema.json` exact 约束 event、全部 command branch 与 writer-specific immutable result；20 个独立 full-result KAT 不由 mapper 生成，mapper/request/CAS mutants 必须经实际 SQLite event projection 后逐字段比较。A→B→restart→replay A 逐项返回首次 20-field projection，不二次 CAS/event；
- `archive_batches.id === batchId`，overlay 才使用 `overlay.batch_id`；Task/Batch/overlay/event/owner 完整 predicate 与 `changes() === 1` fail closed；
- 一次恢复动作涉及多个控制对象时共用一个 transaction object；TaskRun 常规生命周期不迁移所有权；Critical Intent 禁止 `committed → recovered`。
