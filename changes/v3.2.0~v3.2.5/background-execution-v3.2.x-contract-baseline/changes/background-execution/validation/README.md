# Background Execution Contract Validation

> Contract Authority v1 revision 2：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`5c9ee53437d487a94ddb0f0d236dec7b07d4545452c9ebe3c6e98593de209ff2`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本次受控迁移相对 revision 1 精确提升到 revision 2，删除一条已被实际入口语义替代的 stale pair，并补登记两个冻结 Spec 明确要求的 PreFund deferred legacy action，以 61 条独立 provenance 重新锚定；固定 `genesis=false`、`approvalStatus=PENDING_HUMAN_REVIEW`。repo gate 必须从 merge-base 读取 previous，受控 payload 变化仍须 revision 精确 +1；same-revision flip 必须失败。`contractVersion=1` 保持不变，当前 revision 2 不等同于 Contract Authority v2。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

本目录提供可复跑的机器门禁，不以词汇扫描代替 Schema、状态机、跨文档合同和静态引用检查。

## 运行

从文档包根目录执行：

```bash
python3 -m pip install -r changes/background-execution/validation/requirements-validation.txt
PYTHON_BIN=python3 changes/background-execution/validation/run-validation.sh
```

默认 runner 显式注入 `--authority-mode repo`。validator 先清除 inherited `GIT_*` repository/object/config controls、设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel/gitDir/commonDir/HEAD OID 与当前包所处物理 `.git` marker、HEAD/ref bytes 逐项匹配；merge-base 使用该次捕获的 exact HEAD OID，而不是随后可漂移的 symbolic `HEAD`。普通 repo 要求 gitDir===commonDir；linked worktree 允许二者不同但必须各自与物理 marker/commondir exact 相等并同时进入报告。`--authority-mode genesis` 不是跳过 Git 的开关：在 Git worktree 中仍必须解析 `--base-ref`；merge-base 已有 authority 时稳定失败为 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`，仅实际缺失才记录 `repo-explicit-genesis-previous-absent`/`previousAbsenceVerified=true`。脱离 Git 历史校验首次引入包时必须主动声明 genesis，不能把 current anchor 当 previous；该模式只生成 `detached-genesis-non-merge-evidence`、`mergeEvidence=false` 的非合并证据：

```bash
PYTHON_BIN=python3 changes/background-execution/validation/run-validation.sh --authority-mode genesis --report /outside/current/package/detached-validation-report.json
PYTHON_BIN=python3 changes/background-execution/validation/run-validation.sh --authority-mode genesis --report /outside/current/package/detached-validation-report.json --no-write-report
```

detached/index-only 副本若以包内 published repo report 执行 `--no-write-report`，必须因 complete provenance / canonical command drift 拒绝，禁止沿用该报告冒充非 Git 环境证据。其正向证据必须先写到包外 report target，再用同一 genesis/base/report 参数追加 `--no-write-report` 复验；该 report 固定 `evidenceClass=non-merge-evidence`、`mergeEvidence=false`、`previousAbsenceVerified=false`。Git tree 查询只有 `git ls-tree` 成功且 exact path 确实无 entry 才算 previous absent；resolver/lookup/read 任一失败均为稳定错误，不得解释成 genesis。

后续 v1 revision 可用 `--previous-authority /outside/current/package/previous-authority.json --previous-authority-sha256 <lowercase-sha256> --report /outside/current/package/external-validation-report.json`；该路径位于当前合同包内、digest 不匹配或只给 digest 未给路径都会 fail closed。external 文件只 open/read 一次，同一份 bytes 同时用于 duplicate-safe parse、size 与 SHA-256；报告记录 resolved path、size、digest 与真实 external invocation。external 正向 no-write 必须选择该包外 report target 并复用完全相同的 previous path/expected digest/report 参数；published repo report 与 external report 双向不可复用。v1 只支持 revision 精确 +1，不自动推导 contractVersion 轮换。

也可直接执行：

```bash
python3 changes/background-execution/validation/validate_background_execution_baseline.py --authority-mode repo
```

repo/default 成功时会更新包根 `validation-report.json`；任何自定义 `--report` target 都必须位于当前合同包外，非 repo/default 模式禁止覆盖该 published report。report v17 的 canonical generation command 不包含复验专用 `--no-write-report`，但 exact 保留 authority mode/base 或 external path/digest 及自定义 report path；no-write 同时核对完整规范化 provenance、该 command、reportVersion、validationReadInputs 与 inputHashes，任一模式、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 漂移都失败。runner 与 Python validator 都锁定 `jsonschema==4.26.0`、`espree==10.4.0`；Espree 默认只从 repository `node_modules` 的 resolved module 读取，staged-only copy 必须通过 `BACKGROUND_EXECUTION_ESPREE_PATH=/absolute/verified/espree.cjs` 显式声明。找不到 Python/Node、依赖版本或解析路径不匹配、production Node probe 失败或任一门禁失败时均以稳定结构化 dependency/input code 立即 fail closed。

## 29 项实际检查

1. `schema-meta-validation`：Policy、Protocol、RecoverySource、RecoveryControl 四份 Draft 2020-12 Schema 自校验；
2. `validation-runtime-version`：锁定 `jsonschema==4.26.0` 与显式 resolved parser `espree==10.4.0`；
3. `machine-json-duplicate-and-authority-metadata-rejection`：authority、manifest、Schema、fixtures、report 等全部 machine JSON 走同一递归 duplicate-rejecting loader；root duplicate revision、nested digest/count 与 contractVersion/revision bool/float/非正数 mutants 均稳定结构化 fail closed；
4. `full-policy-registry-schema`：52 个 action 的完整 Registry fixture 通过 Schema；
5. `full-policy-registry-semantic`：entry/adapter/inspector/scope/settlement/publisher/validator/service/resource topology 等语义引用有效；
6. `action-manifest-registry-coverage`：Action Manifest 与 Registry 的 action 集合一致；
7. `canonical-action-legacy-task-binding`：执行生产 `ActionTaskBindingRegistry` 并注入真实 TaskPolicyRegistry 的 frozen exact plain host，单次 `list()` 后 descriptor-safe 复制 owned snapshot，校验 source/map digest、完整 122-key inventory digest、Action Manifest v3 审计 snapshot 与 61 条独立 provenance；18 个真实 Node hostile/reachability API case 覆盖 hidden/accessor/Proxy、Map/prototype host、throwing message accessor、non-string `assertPair` 零读取、caller/返回数组 mutation、taskKey mismatch、等数量 substitution、bound absent、duplicate、barrel，以及真实 production require。该 exact require 必须是 Main 除 directive 外第一个 Program.body statement，禁止任何前置可执行 statement/side effect/helper wrapper；CI 从 byte 0 编译执行至该 statement 结束的完整源码前缀，fresh-load exact resolved target并核对唯一 request/真实 export identity。21 类 initializer/run/import/loader mutation、真实 `app.whenReady()` success path、TaskPolicy→binding→DB→IPC success 与 binding failure continuation=0 均 fail closed；production probe 失败立即结构化终止，不降级为空 map，adapter missing/mismatch/empty/one-to-many fail closed；
8. `rfc8785-jcs-known-answer-vectors`：Python/Node 共用 RFC 8785/JCS KAT，冻结 UTF-16 排序、ECMAScript number/escaping、15 类 runtime rejection、9 项 raw duplicate/正负 unsafe-integer KAT、Proxy guard deletion、positive-only integer guard mutation、lowercase SHA-256 与 SHA-1 mutant rejection；
9. `protocol-valid-fixtures`：Job Envelope 与 Service Control Envelope 正例逐条通过 Protocol Schema；
10. `protocol-policy-contract-drift`：exact context/payload wrapper、UTF-8 protocol limits、resource/compound/canary 机器合同及多字节边界 mutation；
11. `recovery-source-valid-fixtures`：五类 RecoverySourceV1 正例通过 Schema 与 bounded evidence 门禁；
12. `recovery-source-invalid-fixtures-rejected`：legacy 字段、manual source 等 RecoverySource 反例必须拒绝；
13. `protocol-resource-lifecycle-continuity`：Job/Service 各 direction seq、unit terminal gate 与 resource request/adopt/revoke/release 的身份和状态连续；reply 仅按 control/resource identity 关联，不 echo 对向 seq；
14. `cross-document-recovery-contract`：Intent/receipt/Inspector/Provider/Startup/TaskRun/Batch/Statement 等恢复合同跨文档一致；
15. `recovery-result-contract`：Inspection/Settlement exact result、identity、JCS SHA-256、UTF-8 byte ceiling、outcome 条件和正负 fixtures；
16. `codex-input-contract-drift`：Codex Protocol 摘要、seq scope、Renderer 状态、Critical Intent 映射，以及四份规范文档中的恢复审计原子性一致；
17. `execution-result-contract-drift`：ExecutionResult terminalSource 穷尽枚举与 result validator 所有权跨文档一致；
18. `recovery-control-transaction-contract-drift`：结构化解析 Repository/Transaction、stable owner/observation attempt、20-field immutable result、5 个 marked Task/Batch physical SQL、command→event 与审计血缘；SQLite 实跑 attempt→owner→event、owner 五项与 attempt 三项 composite FK、transition/observation 逐字段 SELECT 和 changes=1，并运行 43 个文档 mutation self-tests；
19. `recovery-control-exact-schema-and-hash-sensitivity`：schema discriminant 硬断言 16 transition + 4 observation + 20 request + 2 result，exact unknown/missing-key、327 个 required deletion、8 个 inventory mutant、4 个实际 SHA-1 schema injection；独立 versioned 20-result/20-field KAT 固定 digest并有4个 version/count/field/digest mutant，20 baseline + 400 field + 60 wrong-owner 均经真实 mapper→SQLite DDL→immutable SELECT→KAT；另含 observation retry/Hold collision、cross-DTO 与每 branch 逐 leaf JCS sensitivity/optional lineage 门禁；
20. `contract-authority-anchor`：从独立、non-generated Contract Authority v1 revision 2 读取 binding/result/inventory digest、counts 与 source contract version；repo 模式使用 merge-base previous，显式 previous 必须位于当前包外。Git worktree 的显式 genesis 同样解析 merge-base，previous 存在稳定拒绝；真实首次引入才 PASS。detached/index-only genesis 明确是 non-merge-evidence。四个完整 authority transition KAT 与 12 个 genesis CLI/Git KAT 固定 post-merge unchanged genesis rev1 PASS、same-revision genesis flip FAIL、rev1→rev2 semantic change technical PASS/PENDING、unchanged revision bump FAIL、post-merge explicit genesis FAIL、repo same-revision coordinated change FAIL、true first-introduction PASS、detached evidence 分类、merge-evidence report masquerade FAIL、Git resolver error不得变成 genesis、ambient GIT_DIR/worktree/object/alternate/config 不得改源、nested other worktree 拒绝、exact physical identity/report、linked-worktree distinct gitDir/commonDir 与 clean-env policy；external loader 以单读 bytes 冻结 path/size/SHA-256 并生成实际 mode/path/digest command provenance；另有 5 个 complete report provenance/canonical-command KAT 固定 same-repo PASS、repo→external、external→repo、different base/merge-base 与 different HEAD/physical identity 全部 FAIL；source/local/unit/manifest/provenance/digest 与 mapper/KAT/local/manifest/report 两组协调 mutant 仍服从 anchor；
21. `negative-fixtures-rejected`：Policy、Protocol 与 sequence 的全部负例必须 fail closed；
22. `version-action-table-canonical-values`：v3.2.0～v3.2.5 action 表只使用 canonical enum；
23. `version-action-table-registry-alignment`：action 表的 disposition/mode/lifetime/adapter/commit 与 Registry 逐字段一致；
24. `document-contract-paths`：本地 Spec/TechDoc/Schema 链接都能解析；
25. `service-main-governor-boundary`：Worker 文档不得直接调用 Main-owned ResourceGovernor；
26. `required-baseline-files`：必需 Spec、TechDoc、Schema、fixture、runner、人工复核入口和 Codex 输入完整；
27. `package-hygiene`：发布包不得包含 `__pycache__` 或 `.pyc`；
28. `normative-text-invariants`：Service、resource handshake、Critical Intent、生命周期等最高层术语存在且一致；
29. `validation-input-hash-coverage`：校验器实际读取范围内的 JavaScript/Markdown/JSON/Python/Shell/requirements 输入全部进入报告 SHA-256 证据链；no-write 必须 exact 匹配 published/selected report 的完整输入清单与每项 SHA-256。

## 恢复审计原子性门禁

以下四份文档必须包含同一条规范句，且不得保留“事务或恢复顺序”的替代方案：

```text
changes/background-execution/platform-contract-v1.md
changes/background-execution/E00-platform-contract-v1-techdoc.md
CODEX-SPEC.md
CODEX-TECHDOC.md
```

规范要求是：TaskRun 的恢复相关迁移，以及 Batch overlay、Recovery Hold、Critical Intent 的状态迁移与对应 append-only recovery event，必须在同一个 Main-owned control DB transaction 内提交。E00 TechDoc 的顶层写入口只能是 `RecoveryControlRepository.runInControlTransaction()`；回调中的 `RecoveryControlTransactionV1` 才能调用 `transitionWithRecoveryEvent()` 和 `appendObservationEvent()`。

其中 `inspection-completed / inspection-failed-transient / settlement-resumed / settlement-failed-transient` 是严格的 observation-only event：不得更新控制状态，数据库 `previous_state / next_state` 必须为 `NULL`，sourceKind 不能是 `manual`。一次恢复动作更新多个控制对象时必须共用一个 transaction object，作用域内 writer 不得独立 BEGIN/COMMIT/ROLLBACK。

四个 Batch overlay command 必须以 exact keys 携带 canonical actionKey、legacy expectedTaskKey、operationKey、batchId、taskRunId 与 source pair，mark-interrupted 还显式携带 bounded failureCode/failureMessage；生产 binding source 固定 map JCS digest，单次真实 TaskPolicy snapshot 的 122-key JCS digest也固定，并由 Action Manifest v3 中 61 条独立 provenance 验证。20 个 requestKey namespace/tuple 使用 RFC8785-JCS array/RFC6901 pointer 并禁止 delimiter concatenation，排除 volatile leaf；Hold create-or-get 精确按持久 UNIQUE sourceKind/sourceRef 重算 key。owner/event 必须以 composite FK 持久相同 requestKey/writer/eventId/requestHash/createdAt；四类 observation 先持久 durable ordinal，attempt/event 再以 scope/id/requestKey composite FK 绑定。校验器以 43 个文档 mutations、19 类 fixture mutations + 8 个 inventory mutants（128 assertions）、327 个 required deletion、20 branch 共 295 个 full-envelope leaf assertions、16 个 optional-lineage 四态 assertions、独立20-result KAT/4 mutants与480次 SQLite result projection round trip冻结这些规则；289→291 来自 Batch mark 两个 failure leaf，291→295 来自四个 observation branch 的 required `observationAttemptId`。

## Fixtures

```text
fixtures/valid/
  policy-registry.v3.2.x.json
  static-key-manifest.v3.2.x.json
  action-manifest.v3.2.x.json
  canonical-json-jcs-v1.json
  protocol-messages.v1.json
  protocol-sequences.v1.json
  recovery-sources.v1.json
  recovery-results.v1.json
  recovery-control-requests.v1.json

fixtures/invalid/
  policy-*.json
  protocol-messages.invalid.v1.json
  protocol-sequences.invalid.v1.json
  recovery-sources.invalid.v1.json
  recovery-results.invalid.v1.json
  recovery-control-requests.invalid.v1.json
```

全量 Registry fixture 是实施基线，不代表所有 action 已生产启用；`production.enabled` 仍受各版本门禁控制。

## 运行环境

依赖版本固定为：

```text
jsonschema==4.26.0
```

脚本优先使用 `$PYTHON_BIN`，兼容旧的 `$PYTHON`，否则依次查找 `python3`、`python`。没有匹配依赖时会返回非零退出码，并给出安装命令。
