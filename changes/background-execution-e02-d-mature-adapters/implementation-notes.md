# E02-D Implementation Notes

## Baseline

- Goal/spec: 为 Pending/BizOP 大表导入与 Toolbox large split/publication 的既有 dispatcher 提供 mature `existing-dispatch` adapter seam；平台只观察 Protocol v1、metrics、lifecycle 和资源，不重写业务 engine、事务或 Publisher/journal。
- Initial plan: 先取证真实 IPC→session→dispatcher 链；在现有 dispatch 模块旁增加 binding；让 Supervisor 只对 `existing-dispatch` 的外部自持 commit 做 lifecycle-only 观察；保持 4 个 action 的 production gate 关闭并以定向测试证明。
- Done when: 无 wrapper Worker；大表 root Worker 与 Parser children 同步冻结、CompoundLease 精确计费且 Governor 获批数是 engine 唯一并行度；Toolbox generation/publish/recover 不串层；默认 IPC、业务事务/error/output 合同零漂移；人工资金/发布红线仍为 `PENDING_HUMAN_REVIEW`。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| mature adapter 直接绑定现有三个 dispatcher | `pending:import:start` 与 `bizOpRecon:import:run-flow` 最终共用 `big-table-import-dispatch`；`toolbox:split:export` 已分成 large-split staging 与 publication dispatcher | 新建 wrapper Worker 或重写 engine | Worker/Parser/Publisher 数量与业务实现不变 |
| 大表 topology 用 `pipeline.computeMaxParallel` 同一纯函数同步检查 | 避免平台和 engine 两套 workerCount 算法；Supervisor 已保证 inspect→admit→dispatch 顺序 | 采用 policy 静态 workerCount 或 admission 后异步检查 | 文件数/CPU/内存闸仍沿用既有口径 |
| 获批 childCount 以 `parallelFrozen` 透传到 engine | Governor 可能 downgrade；engine 若再次按旧请求计算会导致计费与真实 Parser 数不一致 | engine 在 Worker 内重新选择并行度 | managed seam 下只使用获批数；legacy 未传该字段，行为不变 |
| non-none commit 只对 `adapterKind=existing-dispatch` 的 `existing-critical-protocol/main-settlement` 放行 | 既有 dispatcher 自持事务/journal；E02-D 不接管 settlement | 泛化放开所有 adapter/commit 或伪造平台 receipt | `receiptHint` 保持 null，execution terminal 不冒充 settlement success；native 继续 fail-closed |
| Toolbox publication binding 用显式 `lifecycleOperation=publish/recover` | recovery 必须只调用现有 journal recovery，禁止隐式重发 generation/publish | recovery 复用 publish 或重建第二 Publisher | recovery 测试可直接断言 generation/publish 调用为 0 |
| 默认 IPC 暂不切到 mature runtime | 4 个目标 action 按本 PR 边界必须 `production.enabled=false`，人工红线未签 | 绕过 production gate 让真实资金/发布路径执行 managed action | adapter seam production-reachable，但现有用户路径完全保持；未来只可在门禁完成后启用 |
| big-table cancel 用显式真实错误分类握手，不使用 void 即时证据 | `worker.postMessage(cancel)` 只证明命令已投递，不是 Worker ACK；handle 仅在本次 cancel 已成功投递且真实 dispatch promise 拒绝为 `CancelError` 时由私有 `isCancellationTerminalError` 建立证据 | 返回 `{acknowledged:true}` 伪造 ACK，或 void bridge 在 Worker 观察 cancel 前提前认定取消 | CancelError 经 Supervisor 落 `cancelled`；cancel 后的非取消 error/crash 仍为 `failed`；`receiptHint` 继续为 null |
| PR #171 通过 merge 同步当前 `v3.2.0` 基线后重跑 Windows CI | 失败 run `32715354244` 使用的 merge SHA `601d034c` 早于 #170 的 Windows directory-fsync 修复；当前基线 `961349f7` 已含真实 Windows 通过的 `e986132c` | 在 D 层复制 durability fallback、仅 rerun 旧 merge SHA、或用空提交掩盖 branch checkout 缺修复 | 分支自身包含已审查 C2 修复；E02-D 业务 diff 与 production gate 不变，新 head 可生成当前 merge 候选的 CI |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `production=false` 时“接入样板”指真实 dispatcher binding 与 Supervisor contract 落地，不切默认 IPC | E02-D 明确禁止启用真实资金生产路径；ActionTaskBinding 已将四个 action 映射到真实 taskKey | 若要求本 PR 直接运行 managed 路径，将与 production gate 冲突 | 机器测试同时锁定 binding 与 default IPC 未切换；由后续人工门禁 PR 改 policy/gate |
| root engine Worker 由 phase resource 计费，Parser Pool 是 CompoundLease children | TechDoc §7.1 与现有 Supervisor CompoundLease 模型 | 若 root 也计作 child 会多计一个 Worker | 定向测试在运行中断言 root 1 + children 3 = 4 workerThreadSlots |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 权威 fixture 中目标 action `production.enabled=true` | E02-D 代码 authority 明确固定为 false | 本 PR 用户边界明确要求全部关闭，且人工红线未签 | 更保守；不会启用生产资金/发布路径 | 否；记录为本 PR gate override |
| E02-A Supervisor 仅接受 `commit.kind=none` | 对 existing-dispatch 的两类外部自持 commit 做窄放行 | mature Pending/BizOP/Toolbox policy 均不是 `none` | 只观察 lifecycle；不执行 settlement，receipt 明确 external-unverified | 否；符合 TechDoc existing-dispatch ownership |
| 首轮 reviewer 修复采用 void legacy-cancel bridge | 改为 big-table handle 显式分类真实 `CancelError` 后才建立证据 | void bridge 在 cancel 仅投递后立即上报；Worker 随后若先崩溃/返回 SQL 或 parse error 会误标 `cancelled` | 消除反向竞态；generic adapter 的既有 void 兼容行为不变 | 不涉及公开合同；实现记录已反向同步 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git diff --check` + 定向 main-process tests（mature adapter、Supervisor、ActionTaskBinding、Toolbox split/publication/archive） | PASS（103 tests） | no wrapper、topology/admission、late/duplicate terminal、cancel/error、真实 task seam、发布 journal/recovery 层次 |
| `node --test tests/unit/backend/big-table-import/pipeline-unit.test.js` | PASS（8 tests） | nextWriteIndex/fileIndex 顺序、cancel、内存闸、frozen parallel 不二次降级 |
| `node --test tests/unit/backend/big-table-import/engine-unit.test.js tests/unit/backend/big-table-import/engine-extensions.test.js` | PASS（29 tests） | 单 DB writer、ROLLBACK、overwrite、空批、去重、事务内 finalize 合同 |
| `node scripts/integration/pending-engine-migration.js` | `57/57 PASS` | Pending row/error/transaction/零漂移 contract |
| `node scripts/integration/bizop-flow-engine-migration.js` | `73/73 PASS` | BizOP flow 行序、空批 rollback、事务/error contract |
| 源码 machine assertion | PASS | 4 action production=false；ActionTaskBinding 映射真实 IPC；main 默认未创建 mature bindings |
| blindspot/reconciliation pass | 修复 `parallelFrozen` 二次降级、legacy bypass 与非标准 receiptHint；其余资金/发布红线保留人工复核 | 入口旁路、资源账、失败/终态、行序/事务、Publisher/journal 所有权 |
| `node --test tests/unit/main-process/background-execution/mature-action-adapters.test.js` | PASS（10/10） | Supervisor→真实 mature binding→真实 engine Worker/SQLite：用户 cancel 与 shutdown 均以真实 CancelError 落 `cancelled`，覆盖 DELETE/INSERT 同事务回滚且旧行保留；cancel 已投递但 Worker 先返回 ContractValidationError 时仍 `failed`；三路均不生成 receipt/task success |
| `node --test --test-name-pattern='existing-dispatch' tests/unit/main-process/background-execution/adapters.test.js` | PASS（7/7） | generic existing-dispatch 的 Promise/handle、void legacy 私有桥、拒绝/永不 settle cancel 与 exactly-once cleanup 语义未被 big-table opt-in 分类握手改变 |
| `npm run release-check`（Reviewer findings 收敛后的最终快照，且仅运行一次） | PASS：lint、smoke；unit 5929/5930（0 fail、1 existing skip）；integration 51/51 scripts、2455/2455 assertions | 全仓回归、Pending/BizOP 大表、Toolbox large-file/publication、background recovery 与 lifecycle 兼容 |
| Windows run `32715354244` 失败诊断 | 3 fail 均为 C2 directory-fsync 旧快照：#1185/#1200 抛 `DURABILITY_DIRECTORY_FSYNC_FAILED`，#1194 因 Provider 未收口得到 `committed` 而非 `closed` | 反证 E02-D adapter 为直接根因；要求同步已修复基线而非改资金/发布业务逻辑 |
| `git merge --no-edit origin/v3.2.0` | PASS，无冲突；branch ancestry 已包含 `961349f7` 与 `e986132c` | 当前 PR head checkout 与 PR merge candidate 均具备 #170 Windows fsync 修复 |
| 基线刷新后定向组合测试 | PASS：recovery `35/35`、mature/existing adapters `28/28`、Pending migration `57/57`、BizOP migration `73/73` | directory-fsync、Supervisor lifecycle/cancel、生产关闭门禁、Pending/BizOP 行序与事务合同组合无回归 |
| 基线刷新后 `npm run release-check` | PASS：lint、smoke；unit `5929/5930`（0 fail、1 existing skip）；integration `51/51` scripts、`2455/2455` assertions | 全仓与资金/发布路径回归通过；自动生成的耗时/时间戳噪声已从工作区撤销 |
| 基线刷新 blindspot/reconciliation 复核 | 未发现会改变修复方案的新问题；C2 merge 未触及 E02-D big-table/Toolbox 业务文件，4 action 仍 `production=false` | 本次修复不改变主键、金额/币种、行数、事务、Publisher ownership 或默认 IPC；既有人工红线继续只阻塞 production enable |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Pending/BizOP 资金口径人工逐行/rowid/错误报告签字 | BLOCK / `PENDING_HUMAN_REVIEW` | 业务 owner 按红线清单人工复核 | 不阻塞 adapter 样板合并；阻塞 production enable |
| Toolbox 正式目标、journal crash matrix、Windows packaged 人工签字 | BLOCK / `PENDING_HUMAN_REVIEW` | 发布 owner + Windows 环境验证 | 不阻塞 adapter 样板合并；阻塞 production enable |
| managed seam 下低内存降级 warning 的最终 activity-log 呈现 | PROBE | 后续启用 PR 在真实 submission bridge 接入日志/metrics 时验证 | 当前默认 IPC 未切换，无用户行为影响 |
