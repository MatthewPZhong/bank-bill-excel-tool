# Recovery control 资损红线人工复核清单

> Contract Authority v1 revision 1：独立、非生成机器权威为 `changes/background-execution/recovery-contract-authority.v1.json`；binding=`c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，TaskPolicy inventory=`9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`，result KAT=`1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`。本 PR 是该 authority 首次引入，固定 `genesis=true`、`approvalStatus=PENDING_HUMAN_REVIEW`；repo gate 只从 merge-base 读取 previous，base 无该文件时才接受 revision 1 genesis。`genesis` 属于受控 payload；合并后完整 authority 不变可保留 genesis rev1，same-revision flip 必须失败。此 v1 authority 只承诺 `contractVersion=1` 内 revision 精确 +1；未来 v2 需独立 versioned authority 与人工 redline，不由本合同自动推导。机器技术 PASS 不改变人工红线 `PENDING_HUMAN_REVIEW`，也不表示 merge-ready 或 production enablement。

> Genesis evidence gate：即使显式传入 `--authority-mode genesis`，Git worktree 也必须先解析声明的 merge-base；只要 previous authority 已存在就稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`。所有 Git subprocess 清除 inherited `GIT_*` repository/object/config 控制并设置 `GIT_NO_REPLACE_OBJECTS=1`，再把 Git 返回的 toplevel、gitDir、commonDir、HEAD OID 与物理 `.git` marker/ref 逐项核对；linked worktree 允许 gitDir 与 commonDir 不同，但两者都必须 exact 记录。仅 detached/index-only 的非 Git 副本可降级运行，但报告必须标为 `detached-genesis-non-merge-evidence`、`mergeEvidence=false`，不得冒充 merge evidence。

> Validation report provenance gate：包内 published `validation-report.json` 只允许 repo/default 模式生成；`--no-write-report` 必须把所选 report target 的 complete normalized authority provenance、canonical generation command 与 exact input hashes 同本次实际 authority 解析结果逐项 exact 比较。repo、external、detached、base/merge-base、HEAD/Git physical identity 或 external resolved path/size/SHA-256 任一不同都必须 fail closed；external/detached 正向证据只能写入包外临时 report 后以相同 provenance 复验，不得复用 published repo report。

- 状态：`PENDING_HUMAN_REVIEW`
- 适用合同：background-execution v3.2.x recovery-control v1 errata
- 环境：只允许脱敏、可丢弃的 control DB；禁止使用真实账号、原始业务行或生产数据库
- Reviewer / 日期 / evidence 路径：待人工填写

本文件是 merge 前人工复核入口，不代表任何项目已完成。自动 validator 只验证合同、fixture 与 mutation gate；下面每项必须由授权 reviewer 在实现 PR 上执行并留下脱敏 evidence。

## 前置记录

- [ ] 记录实现 commit、SQLite 版本、Node 版本和测试 DB schema hash。
- [ ] 核对独立 `recovery-contract-authority.v1.json` 的 `contractVersion=1`/revision、`genesis=true`、`approvalStatus=PENDING_HUMAN_REVIEW`、三项 digest 与 hard counts；确认 merge-base 确实无 previous authority，机器 genesis PASS 没有被记录为人工批准、merge-ready 或 production enablement。Git worktree 的 explicit genesis 必须仍解析 merge-base，previous 已存在时稳定拒绝 `AUTHORITY_GENESIS_PREVIOUS_EXISTS`；只有成功 tree lookup 且 exact path 缺失才能证明 genesis，resolver/lookup/read error 不得当成 absent。核对 validator 已清除 inherited `GIT_*` repository/object/config controls并设置 `GIT_NO_REPLACE_OBJECTS=1`，报告中的 toplevel/gitDir/commonDir/HEAD OID 与物理 workspace exact 相等；linked worktree 的 distinct gitDir/commonDir 必须分别保留。detached/index-only 输出必须明确 `non-merge-evidence`，不得沿用 merge-evidence 报告或用于合并批准。v1 任一受控 value（含 genesis）变化必须相对 external/merge-base previous 精确提升 revision +1 并重新执行本清单；完整 authority 不变允许合并后继续保留 genesis rev1，same-revision flip 与 unchanged bump 必须失败。source/unit/manifest/report 同步变化不能替代该人工复核，未来 v2 需独立 versioned authority/redline。
- [ ] 核对 published report v17 的 command 是 repo/default canonical generation command，authorityTrust 完整保留 mode/evidenceClass/mergeEvidence/previousAbsenceVerified/previousPresent/semanticPayloadChanged/revisionRule/baseRef/mergeBase/headOid 与 toplevel/gitDir/commonDir；验证 repo report→external、external report→repo、不同 base/merge-base 与不同 HEAD/physical identity 均 no-write fail closed。external/detached 正向测试必须使用包外临时 report 并以同 provenance 复验，不能把 published repo report 的预期失败记为门禁失败或批准证据。
- [ ] 证明 Main 用真实 TaskPolicyRegistry 构造并保留生产 `ActionTaskBindingRegistry`；registry 仅一次读取并拥有完整 policy snapshot，source map JCS digest 为 `c217253cea4ccc377f030ff5119191a98e8e9c965853c9d9419fdedef9eef0ba`，122-key recoverable inventory JCS digest 为 `9538102480f1a714f3839547f294fbe6fd1c19384734addd89dc0ca6e1dbb368`；Action Manifest v3 snapshot、60 条 pair provenance、TaskPolicy/call-site source hash 与 JCS KAT digest 均与本基线一致。
- [ ] 证明 Main 对真实 production binding module 的 exact CommonJS `require` 是除 directive 外第一个 Program.body statement，之前没有任何可执行 statement、module side effect 或 helper wrapper，import/run identifier 无 shadow/reassign/local fake；以从 byte 0 执行至该 statement 结束的完整 Main 源码前缀证明 fresh-loaded exact request/export identity。TaskPolicy、frozen host 与 `initializeActionTaskBindingStartup` declaration/call 均为 Program.body direct exact 唯一入口。唯一 awaited `run()` 位于真实 `app.whenReady()` success callback 的 rethrowing try block，禁止额外 conditional/loop/nested function/吞错 try/前置 early return，并严格执行 TaskPolicy→binding→DB→IPC 后才建窗。以 binding failure 注入证明 DB/IPC call count 均为 0，并证明 21 类 coordinated AST mutant、Map/prototype host 与 throwing message getter 只产生稳定 fail-closed evidence。
- [ ] 证明 raw 入口分别拒绝 `±9007199254740992` 与 `±9007199254740993`，nested/escaped-equivalent duplicate key fail closed，且不经过 `JSON.parse` last-wins 或 unsafe-number rounding；authority、manifest、Schema、fixtures、report 的 root/nested duplicate 也必须由统一 machine JSON loader 稳定拒绝。
- [ ] 证明测试数据只含 synthetic IDs / safePayload，日志不含账号、路径、原始 Excel 行或其他敏感字段。

## HR-1 exact replay 不二次 CAS / event

- [ ] 以 stable `requestKey` reserve 请求 A，记录 owner 的 eventId、createdAt、request_jcs 与 request_hash。
- [ ] 对 Hold `create-or-get` 证明 requestKey 只按 Hold 表 UNIQUE `(sourceKind, sourceRef)` 重算；重启/重扫复用首次 holdId/eventId/createdAt，改用新 holdId 时同 key exact-hash conflict。
- [ ] 首次提交 A，记录 Task/Batch/overlay/Intent/Hold row version（或等价快照）、event 行数与 exact 20-field result projection。
- [ ] 提交请求 B 推进同一实体，重启 Main，再提交 A。
- [ ] 证明 replay A 逐字段等于首次 immutable result A，而不是 B 后的 current state；没有 `replayed`/`currentState` 扩展字段。
- [ ] 证明 replay 前后业务 CAS row count 增量为 0、recovery event 增量为 0，owner/event 始终各一行。
- [ ] 逐项核对 owner/event 的 requestKey、writer、eventId、requestHash、createdAt 完全相等，并证明任一项不等时 DDL 阻断 event INSERT。
- [ ] 对每种 observation 证明 owner reserve 前已原子持久 `(observationScopeKey, observationAttemptId)` prepared row；同 ordinal 重启返回同一 requestKey/result 且 event 增量 0，下一 ordinal event 增量 1，attempt/event 任一三字段不等时 DDL 阻断。
- Evidence：待人工填写。

## HR-2 任一 request leaf 变化必须 conflict

- [ ] 针对每个 Task/Batch/CriticalIntent/Hold transition branch 与四个 observation eventType，固定 eventId 后逐 leaf 改变完整 exact request。
- [ ] 显式覆盖 eventId、createdAt、safePayload、actionKey、expectedTaskKey、operationKey、batchId、taskRunId、expectedState、recoveryAttemptId、sourceKind/sourceRef、finalOutcome、Batch mark failureCode/failureMessage、observationAttemptId，以及 observation optional lineage 的 present / null / absent / changed。
- [ ] 证明每个变化均返回 conflict，且不发生 CAS、owner overwrite 或 event append；lowercase SHA-256 与 shared JCS KAT 一致。
- Evidence：待人工填写。

## HR-3 canonical / legacy binding mismatch fail closed

- [ ] 验证 adapter 注入并调用生产 `ActionTaskBindingRegistry.assertPair`，只接受 source authority 中列出的 exact `actionKey → allowedLegacyTaskKeys` pair；manifest snapshot 不得自授权，empty binding、missing action、missing task key 和真实但不属于该 action 的 task key 均拒绝。
- [ ] 证明 factory 不接受 caller binding replacement，module 不导出内部 map/array；hidden/accessor/Proxy/non-enumerable/symbol/sparse 输入、TaskPolicy taskKey/channel mismatch、duplicate、等数量 unbound substitution 与 bound-key absent 均给稳定结构化拒绝。
- [ ] 证明构造后修改 caller policy object/list、`bindingSnapshot()` 或 `allowedTaskKeys()` 返回数组都不能改变 registry authority；后两者每次返回新的 frozen copy。
- [ ] 对至少一个合法 one-to-many action，证明两个列出的 legacy task key 分别可接受，第三个未列出的真实 task key 被拒绝。
- [ ] 交换 bank-bu aggregate/single pair、删除 acquiring import 的第二 pair，证明 provenance/digest gate 阻断且不能由 forward map 自行重建“证据”。
- [ ] 证明 binding rejection 发生在 Repository CAS 前，control DB 无任何写入。
- [ ] 用带 `Symbol.toPrimitive` 与 Proxy read trap 的 non-string actionKey/expectedTaskKey 调用 `assertPair`，证明 trap/read count 为 0，且只返回稳定 `ActionTaskBindingRegistryError.code/message`。
- Evidence：待人工填写。

## HR-4 `archive_batches.id` CAS 与 `changes() === 1`

- [ ] 用 synthetic Batch 证明 `batchId` 只匹配 `archive_batches` 表的 `id`；`overlay.batch_id` 引用该 id，SQL 不读取基础 Batch 表中不存在的同名 child 列。
- [ ] 证明 identity join 同时匹配 Batch 与 Task 的 taskRunId、expectedTaskKey、operationKey，且必须恰好一行。
- [ ] 分别对 Task、Batch 基础行、overlay、event INSERT、owner commit 制造 0-row 与多候选/冲突条件，证明 `changes() !== 1` 时 outer transaction 整体 rollback。
- [ ] 证明 Batch resolve 仍保留基础历史 `task_status='failed'`，effective outcome 只来自 overlay。
- Evidence：待人工填写。

## HR-5 最终 audit lineage 一致

- [ ] 对成功、失败、再次中断和 Hold resolution 各取一个完整流程，逐项核对 20-field event projection 的 actionKey、operationKey、taskRunId、source pair、batchId/intentId/holdId/recoveryAttemptId/observationAttemptId 与 exact request、同次 CAS persisted values一致，并与独立 20-branch full-result KAT（digest `1ced39a559f93c787da4d520e37dc0a4513c27dd9b60a4c229509e741b5ec039`）对应 branch 比较。
- [ ] 证明 transition event 的 previousState/nextState 来自 Repository；observation event 两者均为 null，且 observation writer 不修改控制状态。
- [ ] 证明 finalOutcome 与 command discriminant 一致，safePayload 仅为脱敏摘要，不能反向覆盖 identity/state。
- [ ] 导出脱敏 event timeline，人工确认 request owner、immutable result 与最终 lineage 可解释且无重复/孤儿事件。
- Evidence：待人工填写。

## HR-6 Hold source collision 不得误选 first row

- [ ] 对同一 `(sourceKind, sourceRef)` 的完全相同 actionKey/operationKey/taskRunId 重复行，证明只调用 Inspector/Provider 一次。
- [ ] 对同一 source pair 但 actionKey、operationKey 或 taskRunId 任一不同的 collision，证明结果为 unknown + Hold，Inspector/Provider 调用均为 0，control DB 不发生推测性 settlement。
- [ ] 将去重逻辑人为改成 first-row continue，证明测试稳定失败并输出可定位 evidence。
- Evidence：待人工填写。

## 人工结论

- [ ] `APPROVED`：全部项目完成，evidence 可复核，无未解释差异。
- [ ] `REJECTED`：任一红线失败；记录 finding 并阻断 merge。
- Reviewer 签名 / 日期 / 结论：待人工填写。
