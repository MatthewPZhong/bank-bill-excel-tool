# E06-A FundRecon Service Unknowns Preflight

## Task Brief

- Goal：把银行账单对账的 import/run/export 迁入同一个 `thread-single` 长驻 Service，使 Worker 成为 bank/gateway/refund session 与 `processingResult` 的唯一完整内存所有者，并保持 R1→R5/M2M、候选消费、金额币种和输出语义不变。
- Context：精确基线为 E06-P0 commit `aa160cbf351afbe21932a8c9a536fedb25136141`；冻结合同为 `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/{spec,techdoc}.md`。
- Constraints：只复用 Platform Contract v1、ServiceHost、ServiceClient、ResourceGovernor 和 Job/ServiceControl Envelope；不创建协议方言；production flag 保持 `false`；不启用 production、不改 main、不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：三张静态 policy 注册且 production=false；Service 原子采用 state、busy reject、bounded status、generation/revision/token fail closed；run 全轮次 golden、失败不采用、失效矩阵、artifact staging 与 RSS 定向证据通过；主进程不保存 managed path 的第二份完整 rows/result。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| JobEnvelope 有 256 KiB 上限 | Platform Contract v1 schema / protocol validator | 完整银行 rows、gateway/refund rows 不能经 job payload 传输 |
| `ServiceHost` 已实现 generation、busy reject、BaseLease、PersistentReservation replace/adopt ACK 与 idle close | `src/main-process/background-execution/service-host.js` 及其单测 | 不造第二套生命周期；Worker 必须走既有 resource control handshake |
| 当前完整 FundRecon state 在 Main globals | `src/main.js` 的 `bankStatementSession`、`gatewayReconSession`、`refundOrderSession`、`processingResult` | managed path 启用时必须停止 Main 完整镜像；legacy path 在 production=false 时保持不变 |
| 既有 orchestrator 已冻结严格轮次与 working rows/candidate consumption | `src/main-process/reconciliation-orchestrator.js` | Worker 复用同一 orchestrator，不拆轮次、不并行 candidate bucket |
| linked/scenario 真值在 Main DB，`AppDatabase.init()` 会执行 migration/写配置 | database facade/migrations | Worker 不构造 AppDatabase；只用 `DatabaseSync(...,{readOnly:true})` + `query_only` + `BEGIN` 读取一致快照 |
| linked import/delete/account mapping 已受 `bankStatementOperationLock` 保护；scenario CRUD 当前可并发但会清结果 | `src/main.js` handlers | managed run/export 持锁；scenario 并发通过 Worker 保存的持久 signature 与 export 重算 fail closed，不依赖 invalidate ACK |
| export 当前可能产生多个业务文件 | `bank-statement:export` 的 error/main/scenario/refund FilePlan | Worker 返回一个 bounded artifact manifest bundle；Main 仍是 Publisher/settlement owner，不能把 staged 文件当已发布 |
| static registry 只有 import/run/export 三个 action | frozen policy fixture / action manifest | status/invalidate 是 Service 内部生命周期能力，不新增公开 actionKey，也不伪装成业务 action |
| v3.2.2 policy 明确 production=false | frozen Spec §3 与 fixture | 本 PR 可注册/验证 managed path，但不能接管 live handler 或启用 production |

## Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 完整 rows 如何进入 Worker 且不超 envelope | 数据所有权/容量 | 高 | PROBE | 对照 reader 输入、JobEnvelope 上限和 spool 现有模式 | import payload 只传文件引用/解析选项；Worker 内部读取并采用 session，禁止传 rows |
| scenario/link evidence 如何一致读取 | 快照/并发 | 高 | PROBE | 只读 SQLite transaction + concurrent scenario mutation test | Worker 用只读 DB snapshot 计算 run evidence；export 对当前 signature 再校验 |
| import candidate adoption 失败时旧 state 语义 | 状态生命周期 | 高 | PROBE | reservation reject fault test | candidate 私有构建；reservation/adopt ACK 前绝不 publish；失败保留旧 stable state |
| run 失败是否会污染 session/result | 金额/候选消费 | 高 | PROBE | 中轮 fault injection + golden | working rows 深拷贝；全轮次完成且 state reservation adopted 后才替换 stable result |
| invalidate ACK 丢失时是否可能导出旧结果 | stale/部分失败 | 高 | PROBE | 丢 ACK 后 export signature mismatch | export 永远重读当前 evidence signature；invalidate 只加速失效，不能作为唯一安全证明 |
| 多业务文件如何符合 `maxArtifacts=1` fixture | artifact 合同 | 高 | PROBE | manifest validator 与现有 Publisher 对照 | 一个 artifact-manifest result 表示一个 FilePlan bundle，bundle 内可列多个 staged entries；不提升 policy artifact 数 |
| status/invalidate 没有 actionKey 如何实现 | 协议边界 | 中 | PROBE | ServiceHost snapshot 与 worker core API seam test | core status/invalidate 已实现，action result 返回 bounded revision/summary；Platform v1 无远端独立 operation，显式 Main adapter 未闭合，靠 generation/evidence signature fail closed 且 production 继续 false |
| Worker 能否直接复用 Electron/SQLite reader | native/Windows | 高 | PROBE | worker thread focused import + Windows 留作 release gate | Worker entry 只 require Node/native-safe模块；Electron dialog/path选择仍在 Main；Windows packaged 是后续人工 gate |
| RSS 估算是否足以做 PersistentReservation | 资源 | 高 | PROBE | state footprint boundary + 连续十轮 RSS | 已完成共享引用去重、35% headroom、4 KiB 上取整和十轮当前-state 替换证明；真实进程 RSS/大退款入金表仍待 release evidence，继续阻断 production |
| live Main handler 是否应在本 PR 切换 | 入口/回滚 | 高 | ASSUME | production flag 与 action manifest | production=false 下保持 legacy handler；只添加显式 managed adapter seam，R3.2.2 gate 后才能切 flag |

## BLOCK 与保守边界

E06-A 实施本身没有需要用户选择的 BLOCK，但以下条件继续阻断 production enablement：

1. Windows packaged native SQLite / worker lifecycle 尚未完成。
2. 全轮次真实样本的 first-match、同值 no-op、回填/标黄需要人工资金复核。
3. production flag 必须继续为 `false`；本 PR 的自动测试不能替代人工红线。
4. 若一个 FilePlan bundle 无法在现有 artifact validator 下表达，必须收缩为 staging adapter seam，不能绕过 Main Publisher 或修改冻结 policy。
5. Platform Contract v1 没有独立 `status/invalidate` ServiceControl operation；远端 Main adapter 必须复用既有 generation/close 或后续冻结扩展，不能私造协议方言。

## 保守假设

- Legacy IPC 在 production=false 时行为完全不变；managed path 通过 runtime/adapter 的显式入口验证，不在本 PR 暗切 live traffic。
- Worker crash 丢失纯内存 session；不从导出文件、receipt 或 Main 镜像恢复，用户重新导入。
- Main 可保留 bounded stable summary、generation/revision/token 和 artifact manifest，但不能保留完整 managed rows/result。
- linked data 的派生写入发生在进入 managed job 前并受 operation lock 保护；Worker 对 Main DB 只读。
- 任何 state/result/evidence 超预算或无法 canonicalize 时 fail closed，不退回 legacy 重跑。

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败时收缩 |
| --- | --- | --- | --- | --- |
| 1 | 冻结三张 policy/validator/entry | static action、serviceKey、production false | registry fixture parity | 不注册 action，停止接线 |
| 2 | 实现纯 service state machine | 单一所有者、busy、revision、stale fail closed | adoption reject、run fault、invalidate tests | 保留 core，不接 Worker entry |
| 3 | 接 ServiceControl resource adoption | PersistentReservation 原子替换、release exactly once | worker protocol fault tests | 保持 production false，修复协议后再推进 |
| 4 | 接只读 evidence snapshot 与既有 orchestrator | 全轮次顺序、候选消费、日期/链接签名 | full-round golden + concurrent invalidation | 禁止 run/export managed |
| 5 | 接 staging artifact generator | Worker staging、Main publish/settle | manifest/path/traversal/all-or-none tests | 只验证 run，不开放 export adapter |
| 6 | RSS/连续轮次/盲区复核 | 资源不泄漏、资金语义不漂移 | focused RSS + blindspot/reconciliation review | production 继续 false，记录 Remaining unknowns |

## Preflight Outcome

- 步骤 1-5 的 production-false capability 已实现并有定向证据；真实 native Worker 还额外发现并修复了 generation-wide `controlId` 重用问题。
- 步骤 6 只完成 deterministic state footprint、真实 Service reservation/release 零泄漏与流式 artifact hash；未完成真实大样本 process RSS/Windows，因此不宣称 E06-A production gate 已通过。
- live Main handler、Publisher/marker settlement、显式 remote status/invalidate 与 source fingerprint 均未切换/未闭合；Draft PR 必须保持 production=false。
