# v3.2.5 E13-F Preflight — Position Utility-process Adapter

## Goal / Context / Constraints / Done when

- Goal：把 `position:import` 的既有 prepare/apply/grant/recovery dispatcher 注册为统一
  Protocol/Resource/Lifecycle capability，同时保持 FilePlan、pending、receipt、人工确认、资金与恢复语义零漂移。
- Context：Position import 已有 utility-process/child-process fallback dispatcher；bank prepare、bank/account
  confirmed apply 和 source prepare-and-apply 共享 side DB/checkpoint 协议，但其实际子进程拓扑、取消 ACK、
  prepared selector 与 durable grant authority 尚未由 Background Execution Runtime 机器约束。
- Constraints：不新增外层 process，不改默认 IPC，不绕过既有 dispatcher，不改 SQL、账号匹配、金额/币种、
  行序、事务、checkpoint、manifest、receipt 或 recovery；production 与资金/恢复人工门禁保持关闭；不运行
  `release-check`、`check-vars` 或 `scan:vars`。
- Done when：policy、adapter、topology、privacy-safe progress/result validator 进入真实 Runtime；定向与既有回归
  证明 Main-owned identity/selector/grant/checkpoint、真实 CANCEL_ACK、安全点和零额外 spawn；默认 IPC/production
  仍为 legacy/false。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| bank prepare 只启动原 root import process | `position-reconciliation/import-dispatch.js` 与 import worker command 分派 | `effectiveChildCount=0`；adapter 不得再包 process。 |
| bank/account confirmed apply 先运行 schema migration，再运行 apply，两个 process 不并发 | Main 现有 tracked apply 调用链、`dispatchPositionLargeImportSchemaMigration()` | root phase 覆盖当前 process；child=0，不能把顺序 process 当作 nested child。 |
| source prepare-and-apply 的 root 会等待 Main durable grant，authorizer 期间最多启动一个 schema migration process | import dispatcher `authorizeApply` 协议与 Main source apply authorizer | 该 intent 的 `effectiveChildCount=1`；current `childrenMax=1`，冻结 fixture 的 4 不可复用。 |
| Protocol policy 使用 exact-5 operation context，旧 File Task/worker mutation owner 使用 exact-7 batch context | `worker-operation-context.js`、`worker-batch-context.js`、Position tracked handlers | 两套 owner 的共有五字段必须一致；operation token 必须等于 `taskRunId`。 |
| confirmed apply 的 prepared preflight、side DB、checkpoint 与 operation token 都由 Main 持有 | Position Main tracked prepare/apply handlers与 side-db mutation contract | caller 只能给 selector + exact-7 owner；完整 manifest/kind/checkpoint 必须在 mutation 前 fail closed。 |
| source apply grant 是持久 mutation 权限边界 | import worker `authorizeApply`、archive manifest/schema/checkpoint contract | adapter 只能返回精确 allowlist；provider 附加字段不得跨边界。 |
| raw handle `cancel()` 的 true 只表示取消消息已投递 | dispatcher handle 与 `CANCEL_ACK accepted` / terminal error 协议 | 只有真实 ACK/terminal 可收口 cancelled；protected 阶段拒绝即时取消后仍需在下一安全点停止。 |
| 默认 IPC 还拥有 FilePlan staging、pending/receipt、人工确认与 route authority | Position Main handlers、TaskPolicy binding | E13-F 只注册 dormant capability；未注入完整 Main route authority 前不得切 production。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Position compound childrenMax 应为 4、1 还是 0 | 已知未知 | 高 | 容易 | 真实路径只有 source grant 等待期间并发一个 schema process | PROBE → CLOSED | 静态调用链 + 四 intent topology 单测 | current childrenMax=1；intent 级 child=0/1。 |
| sequential schema→apply 是否应计算为 child | 盲区 | 高 | 容易 | 两者从不与 root/彼此并发；phase 已计当前 root | PROBE → CLOSED | Governor/Supervisor 零 child 回归 | 不算 child，confirmed apply 为 0。 |
| caller 能否透传 prepared preflight/sideDb/checkpoint | 盲区 | 高 | 一般 | 旧 Main handler持有 selector map 与当前 side DB authority | PROBE → CLOSED | authority override/kind/checkpoint 反例 | 输入只接受 selector/files/owner；authority 全部由 Main 注入。 |
| `cancel()` 已投递能否立即映射 acknowledged | 已知未知 | 高 | 容易 | worker 可能在 committing 返回 `accepted=false` | PROBE → CLOSED | accepted true/false + safe-point 测试 | 等真实 ACK；job-level request 在 grant/schema 后安全点再次检查。 |
| source provider 返回的附加数据能否进入 grant | 盲区 | 高 | 容易 | grant 是跨进程持久 mutation 权限 | PROBE → CLOSED | allowlist 与 secret 反例 | 只返回六类权威字段，额外字段丢弃。 |
| `position-reconciliation:run:import-result` binding 是否由本 adapter 执行 | 入口旁路 | 中 | 容易 | 静态 action binding 含该 TaskPolicy，但实际 handler 不走 import utility dispatcher | PROBE → OPEN（E13-G） | AST/provenance 重建 | E13-F 不伪造 route；E13-G 必须按真实入口记录 provenance。 |
| dormant capability 是否可自动接管默认 IPC | 隐性偏好 | 高 | 困难 | 完整 route authority 与人工门禁未关闭 | BLOCK（production） | R3.2.5 route/Windows/人工证据 | 保持 `legacy/PENDING_HUMAN_REVIEW`。 |

## 保守假设

- E13-F 期间不会新增绕过 tracked handler 的 Position mutation 入口；若未来启用 managed route，必须在独立变更
  中注入 Main-owned userData/side DB/prepared selector/checkpoint/operation token/source authorizer，并把 FilePlan、
  pending、receipt 与人工确认收口一起重验。
- 既有 dispatcher 的 utility-process 不可用 fallback 仍由原实现负责；adapter 不感知或改变 fallback 选择。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 反向同步 current Spec/TechDoc | 0/1 topology、owner/grant/cancel/legacy route 有书面 authority | bootstrap 精确 transformer/hash 测试 | 文档与实现分叉会推翻后续验收 | 回退 E13-F current delta，冻结基线不动。 |
| 2 | 注册 false-gated policy/validator | capability 与 effective strategy 分离 | Registry/Runtime/privacy 单测 | policy 误启用或结果泄露则停止 | 删除 E13-F registry 项，默认 IPC 无影响。 |
| 3 | 绑定真实 dispatcher 与 Main authority | 不新增 spawn、selector/grant/checkpoint/owner fail closed | 四 intent、反例、取消 fault tests | 任一 authority/事务漂移则不提交 | 保持 capability dormant，回退本阶段 binding。 |
| 4 | 扩大回归与盲区扫描 | Supervisor 允许真实 zero child 且不放宽其他非法 topology；资金语义零漂移 | Position/background/full gates 与人工红线清单 | 回归失败则修复或回退 E13-F | E13-A～E 不受影响。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；不得把这些项目记录为 PASS。
