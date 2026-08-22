# Background Execution Contract Validation

本目录提供可复跑的机器门禁，不以词汇扫描代替 Schema、状态机、跨文档合同和静态引用检查。

## 运行

从文档包根目录执行：

```bash
python3 -m pip install -r changes/background-execution/validation/requirements-validation.txt
PYTHON_BIN=python3 changes/background-execution/validation/run-validation.sh
```

也可直接执行：

```bash
python3 changes/background-execution/validation/validate_background_execution_baseline.py
```

成功时会更新根目录 `validation-report.json` 并返回退出码 `0`。找不到 Python、依赖版本不匹配或任一门禁失败时均 fail closed。

## 24 项实际检查

1. `schema-meta-validation`：Policy、Protocol、RecoverySource 三份 Draft 2020-12 Schema 自校验；
2. `validation-runtime-version`：锁定 `jsonschema==4.26.0`；
3. `full-policy-registry-schema`：52 个 action 的完整 Registry fixture 通过 Schema；
4. `full-policy-registry-semantic`：entry/adapter/inspector/scope/settlement/publisher/validator/service/resource topology 等语义引用有效；
5. `action-manifest-registry-coverage`：Action Manifest 与 Registry 的 action 集合一致；
6. `protocol-valid-fixtures`：Job Envelope 与 Service Control Envelope 正例逐条通过 Protocol Schema；
7. `protocol-policy-contract-drift`：exact context/payload wrapper、UTF-8 protocol limits、resource/compound/canary 机器合同及多字节边界 mutation；
8. `recovery-source-valid-fixtures`：五类 RecoverySourceV1 正例通过 Schema 与 bounded evidence 门禁；
9. `recovery-source-invalid-fixtures-rejected`：legacy 字段、manual source 等 RecoverySource 反例必须拒绝；
10. `protocol-resource-lifecycle-continuity`：Job/Service 各 direction seq、unit terminal gate 与 resource request/adopt/revoke/release 的身份和状态连续；reply 仅按 control/resource identity 关联，不 echo 对向 seq；
11. `cross-document-recovery-contract`：Intent/receipt/Inspector/Provider/Startup/TaskRun/Batch/Statement 等恢复合同跨文档一致；
12. `recovery-result-contract`：Inspection/Settlement exact result、identity、canonical SHA-256、UTF-8 byte ceiling、outcome 条件和正负 fixtures；
13. `codex-input-contract-drift`：Codex Protocol 摘要、seq scope、Renderer 状态、Critical Intent 映射，以及四份规范文档中的恢复审计原子性一致；
14. `execution-result-contract-drift`：ExecutionResult terminalSource 穷尽枚举与 result validator 所有权跨文档一致；
15. `recovery-control-transaction-contract-drift`：结构化解析 Repository/Transaction、command exact identity、bounded patch、command→event、审计血缘、Critical Intent/Hold 输入并运行 mutation self-tests；
16. `negative-fixtures-rejected`：Policy、Protocol 与 sequence 的全部负例必须 fail closed；
17. `version-action-table-canonical-values`：v3.2.0～v3.2.5 action 表只使用 canonical enum；
18. `version-action-table-registry-alignment`：action 表的 disposition/mode/lifetime/adapter/commit 与 Registry 逐字段一致；
19. `document-contract-paths`：本地 Spec/TechDoc/Schema 链接都能解析；
20. `service-main-governor-boundary`：Worker 文档不得直接调用 Main-owned ResourceGovernor；
21. `required-baseline-files`：必需 Spec、TechDoc、Schema、fixture、runner 和 Codex 输入完整；
22. `package-hygiene`：发布包不得包含 `__pycache__` 或 `.pyc`；
23. `normative-text-invariants`：Service、resource handshake、Critical Intent、生命周期等最高层术语存在且一致；
24. `validation-input-hash-coverage`：校验器实际读取范围内的 Markdown/JSON/Python/Shell/requirements 输入全部进入报告 SHA-256 证据链。

## 恢复审计原子性门禁

以下四份文档必须包含同一条规范句，且不得保留“事务或恢复顺序”的替代方案：

```text
changes/background-execution/platform-contract-v1.md
changes/background-execution/E00-platform-contract-v1-techdoc.md
CODEX-SPEC.md
CODEX-TECHDOC.md
```

规范要求是：TaskRun 的恢复相关迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的状态迁移与对应 append-only recovery event，必须在同一个 Main-owned control DB transaction 内提交。E00 TechDoc 的顶层写入口只能是 `RecoveryControlRepository.runInControlTransaction()`；回调中的 `RecoveryControlTransactionV1` 才能调用 `transitionWithRecoveryEvent()` 和 `appendObservationEvent()`。

其中 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 是严格的 observation-only event：不得更新控制状态，数据库 `previous_state / next_state` 必须为 `NULL`，sourceKind 不能是 `manual`。一次恢复动作更新多个控制对象时必须共用一个 transaction object，作用域内 writer 不得独立 BEGIN/COMMIT/ROLLBACK。校验器会通过结构解析和 mutation self-tests 拒绝缺失外层事务、顶层暴露 writer、扩宽 observation 类型、允许 manual observation source、command→event 映射漂移、`committed → recovered`、把正常 TaskRun command 塞入 recovery union，以及移除 observation NULL 约束等漂移。

## Fixtures

```text
fixtures/valid/
  policy-registry.v3.2.x.json
  static-key-manifest.v3.2.x.json
  action-manifest.v3.2.x.json
  protocol-messages.v1.json
  protocol-sequences.v1.json
  recovery-sources.v1.json
  recovery-results.v1.json

fixtures/invalid/
  policy-*.json
  protocol-messages.invalid.v1.json
  protocol-sequences.invalid.v1.json
  recovery-sources.invalid.v1.json
  recovery-results.invalid.v1.json
```

全量 Registry fixture 是实施基线，不代表所有 action 已生产启用；`production.enabled` 仍受各版本门禁控制。

## 运行环境

依赖版本固定为：

```text
jsonschema==4.26.0
```

脚本优先使用 `$PYTHON_BIN`，兼容旧的 `$PYTHON`，否则依次查找 `python3`、`python`。没有匹配依赖时会返回非零退出码，并给出安装命令。
