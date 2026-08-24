# E03-B VCC SaveRun Receipt / Inspector — Implementation Notes

## Goal / Context / Constraints / Done when

- Goal：让真实 `vccOpCalc:run:save` 以稳定 Main Task owner、版本化 Compute Snapshot hash 和同事务 operation receipt 形成唯一可检查的提交证据。
- Context：VCC OP 业务数据实际位于 Main `tool-data.sqlite`；既有 `saveRun` 在同一 `DatabaseSync` 连接写 `vcc_op_calc_runs` 与 `vcc_op_calc_run_files`，save IPC 已由 `TaskLifecycle.runOperationOnly` 建立独立 TaskRun/operationKey。
- Constraints：不改 Renderer/public IPC、金额方向、月份、币种、begin/end OP、run/files SQL 口径；不信任 Renderer owner；不注册或启用尚未通过 C2/Windows/人工资金门禁的生产 recovery；不把 execution done 当作业务 success。
- Done when：migration、同事务 receipt、严格 replay、RecoveryInspectionResultV1 Inspector、崩溃窗口、重启/并发 exactly-one、资金行与金额守恒、旧保存 golden 均有真实 SQLite 正反证据。

## Decisions

1. Canonical action identity 固定为 `vcc-op:save-run`；`taskRunId/operationKey` 只取 Main `taskContext.operationContext`，session 缺 owner 时 fail closed。
2. Compute Snapshot hash 使用独立 version=1 canonical projection，覆盖完整冻结 snapshot；receipt 只存 SHA-256，不持久化文件路径、文件名或 snapshot 明文。
3. receipt 表名按 authority 使用 `vcc_op_operation_receipts`；物理 FK 指向仓库唯一真实 run 表 `vcc_op_calc_runs(id)`。authority 示例中的 `vcc_op_runs` 在当前产品 DB 不存在，创建该 FK 会使真实插入失败。
4. 新保存与 replay 都在 `BEGIN IMMEDIATE` 内先按 `(action_key, operation_key)` 查询 receipt。存在时逐项验证 Task/hash/month/fileCount 和 run/run_files/金额守恒；仅完整一致返回 `recovered-existing-commit`，其余统一 unknown/fail closed。
5. Inspector 复用 `RecoverySourceV1` 与 `normalizeRecoveryInspectionResult`，只读返回 exact `RecoveryInspectionResultV1`；不按月份或“最新 run”猜 operation evidence。
6. unknown result 保留为 typed `VccOpSaveRunContractError`（含 Main owner identity 与有界内部证据）；Main 仅返回无证据/无路径的 `recovery-required` DTO，并先把当前 save TaskRun CAS 为 `interrupted`。通用 failed terminal 的后续 CAS 只能冲突，不能覆盖 interrupted。
7. E03-B legacy seam 不创建假 Critical Intent/Recovery Hold。真实 Hold、startup source scan、Inspector 注册和同月持久 conflict gate 仍是 production enablement 前置。
8. PR #173 基线刷新只合入当前 `v3.2.0` 的已审查 Windows directory-fsync 修复；migration 测试改为在测试体 `try/finally` 中关闭 `AppDatabase` 后再由 fixture 清理目录，不以重试或忽略 `EBUSY` 掩盖句柄泄漏。

## Assumptions

- `committed_at` 使用 SQLite UTC `strftime('%Y-%m-%dT%H:%M:%fZ','now')`，避免本地时区歧义。
- fault injection 仅通过 session factory 依赖注入暴露给测试，不进入 IPC payload 或公共 Renderer 合同。
- Compute Snapshot canonical hash version 固定为 1；Inspector 对未知 source evidence version fail closed。

## Deviations

- 物理 FK 由 authority 示例的逻辑名 `vcc_op_runs` 对齐为现存真相 `vcc_op_calc_runs`；不新建别名表、不迁移旧 run、不制造第二真相。
- action 保持 `production.enabled=false/effectiveMode=legacy`。C2 真实业务 source/provider/hold-resolution 门禁未闭合，本 PR 不把 Inspector 注册到产品 startup registry，不宣称生产自动恢复完成。
- 当前 legacy action 在 COMMIT 后进程退出时虽然已留下可检查 receipt，但没有持久 Critical Intent/启动注册就不能自动重建原 operation owner；因此不得把本 PR 的模块级 crash/replay 证据表述为产品 startup 恢复闭环。

## Evidence

- Preflight：branch `codex/v3.2.0-e03-b-vcc-save-run-receipt`，HEAD `2fc80a17c3939f2c9e1117ecdb0a7a247b03e9a2`，tracked baseline clean。
- Authority：3.2.0 Spec §5.3–5.4/§6.1/AC-06、TechDoc §9–11；E00 Spec §7–9/§15、TechDoc §9.4/§10/§12–13。
- Existing seam：`src/main-process/vcc-op-calc-session.js:353`、`src/backend/vcc-op-calc-db/run-repository.js`、`src/main-process/archive-center/task-lifecycle.js:1278-1290`、`src/main.js:15013`。
- 真实旧库启动：以旧 `vcc_op_calc_runs/run_files` DB 连续执行两次 `AppDatabase.init()`；旧 run 保留，receipt DDL/FK 正确，`PRAGMA foreign_key_check=[]`。
- 原子性：receipt trigger abort、`after-begin`、`after-run-insert`、`before-receipt-insert`、`after-receipt-insert` 均验证 run/files/receipt 为 0；Worker 在 receipt insert 后硬退出，新连接为 `not-committed` 且三表均 0。
- 幂等/并发：重启同 operation 返回同 runId + `recovered-existing-commit`；双 Worker/双 SQLite 连接并发得到一份 `committed`、一份 recovered，最终 exactly-one run + receipt。
- 冲突/完整性：同 operation 的 snapshot hash/task/month/fileCount/opening balance 冲突，以及 orphan receipt、同 run 多 receipt、缺 run_file、金额破坏，全部 `unknown` 且不新增资金行。
- 崩溃后回包丢失：`after-commit` 抛错后关闭写连接；全新连接 Inspector 返回 `committed` 并给出同 runId，随后 replay 不新增。
- Inspector：`PRAGMA query_only=ON` 下 exact RecoveryInspectionResultV1 可归一化，`total_changes` 不变；同月 legacy run 无 receipt 时仍是 `not-committed`。
- Lifecycle：unknown 先写 `interrupted`，随后通用 failed CAS 保留 interrupted；Main DTO 精确验证不含 bounded evidence、snapshot hash、operation identity、文件名/路径。普通 validation 为 failed，committed/replay 为 succeeded。
- 定向 lint：`./node_modules/.bin/eslint` 对 9 个 E03-B production JS（database/migration/receipt/session/contract/Inspector/lifecycle/policy/Main）执行，exit 0、无输出。
- 定向 tests：`node --test` 执行 save receipt、VCC session/stream/parser pipeline、Archive TaskLifecycle/task policy 6 个文件，`164/164 PASS`。
- 独立 Reviewer：对 staged-only 快照 `3879796d2034df2dde4973407cf6b124d66ed537cd883865bd2c557d7fbd1d97` 完成 migration/receipt、Main owner/lifecycle、Inspector 与资金盲区复核；当前产品可达/材料性 `P0=P1=P2=P3=0`。
- 最终门禁：Reviewer 收敛后由 `/root` 仅执行一次 `npm run release-check`，exit 0；lint/smoke PASS，unit `5986/5987 PASS`（0 fail、1 skip），integration `51/51` scripts、`2455/2455 PASS`。
- Windows run `32724397845` 失败诊断：4 fail 中 3 项是 #170 修复前的 C2 directory-fsync 旧快照；唯一 E03-B failure 是 migration 测试 cleanup 在 SQLite 句柄关闭前 unlink 数据库文件而触发 `EBUSY`，不是 migration 或 receipt 业务断言失败。
- `git merge --no-edit origin/v3.2.0`：PASS、无冲突；分支已包含 `c3570437` 基线及 `e986132c` Windows directory-fsync 修复。
- 基线刷新后 recovery + SaveRun receipt 组合定向：`68/68 PASS`；VCC SaveRun/Parser/Session 与 Archive TaskLifecycle/policy 定向：`164/164 PASS`。
- 基线刷新后 `npm run release-check`：PASS；lint/smoke PASS，unit `5986/5987`（0 fail、1 existing skip），integration `51/51` scripts、`2455/2455` assertions；自动生成的集成耗时/时间戳噪声已还原。
- 本地 review：`git diff --check` 与测试文件 `node --check` 均通过；本次业务代码零新增修改，仅同步已合并基线并修正测试 SQLite 句柄关闭顺序。
- 按用户明确约束未运行 `check-vars` 或其等价命令。

## Reconciliation Blindspot / Human Review

- operationKey 与独立 save TaskRun 的唯一关联：`PENDING_HUMAN_REVIEW`。
- receipt/run/files 原子性、重复保存与资金行/金额守恒：`PENDING_HUMAN_REVIEW`。
- 真实流水方向、整数分、月份、币种、begin/end OP 抽样：`PENDING_HUMAN_REVIEW`。
- Windows packaged SQLite crash/durability 与 production enablement：`PENDING_HUMAN_REVIEW`。

## Remaining Unknowns

- BLOCK：无当前实现 BLOCK。
- PROBE：C2 真实业务 Critical Intent/source/provider/Recovery Hold resolution 与 recovery lock 尚未形成生产闭环；本 PR 只提供 registry-ready Inspector seam。
- PROBE：新 head 的 Windows smoke-test/build 尚待远端验证；通过前不得合并。
- ENABLEMENT BLOCK：E03-A JSZip whole-archive buffer、terminate rejection、分配前 byte budget；Windows packaged fault/durability；本 PR 资金人工复核。

## Blindspot / Reconciliation Pass

- 入口旁路：生产写入口唯一为 `src/main.js` 的 `vccOpCalc:run:save`，只传 `taskContext.operationContext`；session/direct contract 缺 exact owner fail closed。仓库 `rg` 未发现其它 `saveRun` 产品调用。
- 状态与失败：commit 前所有可达异常回滚；commit 后异常不回滚已提交证据；unknown 保留 snapshot cache 与 interrupted owner 供取证，不伪造 Hold 或自动 retry。
- 兼容性：blindspot 发现 partial explicit session seam 曾被收窄，已恢复“显式字段 + adopted snapshot 其余字段”的旧行为并新增回归；Renderer/preload IPC 参数不变。
- 金额/行数：发生额入/出方向、整数分、两位 TEXT、月份、币种、begin/end 公式未改；Inspector 逐文件解释金额并校验 `sum(files)=run totals`、`end=begin+total`、fileCount/rowCount 可解释。
- 可观测性/隐私：receipt 仅存 hash 与有界 identity metadata；Renderer recovery-required 不透出 bounded evidence、文件名/路径。UTC committed_at 可判定且无本地时区依赖。
- 基线刷新复核：merge 未产生冲突；新增差异只影响测试 cleanup 与证据文档，不改变 receipt/run/files 事务、Inspector result、Main owner、金额/币种/月份、replay 或 unknown/fail-closed 路径。未发现改变方案的新盲区。
- 残余真实风险：未注册的 production Inspector/Critical Intent/Hold 意味着产品 startup 暂不能自动处理 COMMIT 后回包丢失或阻断同月新 legacy save；policy 继续 `production.enabled=false/effectiveMode=legacy`，这是明确 enablement block，不是本 PR 已完成能力。
- 资金红线结论：自动证据覆盖原子性、幂等、金额/行数守恒，但不代签真实资金样本与 Windows packaged durability，保持 `PENDING_HUMAN_REVIEW`。
