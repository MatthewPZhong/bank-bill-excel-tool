# E12-C VCC dual Writer Unknowns Preflight

## Task Brief

- Goal：在 E12-A one-shot single Writer 与 E12-B subject SQL query pushdown 之上，实现 dormant 的 deterministic 1/2-shard Writer graph，并由 Main 唯一 Join/Publisher。
- Context：final restack 精确 parent 是 E12-B `e6cb3a14fb837314162ba187ce4e6a61194d6047`，合并来源 `dc2caebeda3d7b34c9d86e33c10e01bc61f73a5a`；冻结 Spec §7.3/§8/§9、TechDoc §9～§13 将 second Writer、shard planner、artifact join 与 15%/Windows/RSS 证据归入 E12-C。
- Constraints：只做 E12-C；不接 live IPC/Renderer/Preload，不开启 production，不改变 legacy；`production.enabled=false`、`effectiveMode=legacy`、`effectiveWorkerCount=0` 保持不变；Main 继续持有 full A/B/Join/Publisher authority；不改变 FilePlan、金额、币种、Pending、revision、archive、lineage 或 publisher journal 语义；不得运行 `release-check`、`check-vars`、`scan:vars`。
- Done when：1/2 Writer 对 exact subjects 唯一覆盖且 deterministic merge 等价；每 child 仅打开 read-only DB 并查询 assigned subjects；任一 cancel/crash/timeout/stale/manifest/staging 失败均 Publisher 0；全部成功后 Publisher 恰好 1；late child message 不改变终态；cleanup/recovery 与 SafeError 有界；定向、回归、性能/RSS 探针完成，production 仍 false，并保留 Windows/资金人工门禁。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 graph 只允许 1 或 2 shard，subjectIndex 唯一覆盖，Writer 顺序生成本 shard，Join 按 subjectIndex 排序。 | `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/techdoc.md` §9～§10 | shard planner 与 reducer 必须拒绝重复、遗漏、越界和非确定顺序。 |
| 每 Writer 必须 read-only 且使用 subject query；禁止每 Writer 全量加载后丢弃。 | Spec §7.2～§7.3；E12-B `loadEffectiveRunDataForSubject` 与 read-count 测试 | child input 只含 assigned generation descriptors；writer-core 保留 `subjectQueryPushdown=true`。 |
| E12-A Main 已冻结 full authority、FilePlan、task-private staging identity，并在 Worker 完成后做 B/业务回读/Publisher。 | `src/main-process/vcc-financial-op-output/dispatch.js` | 不能把 full A/B、FilePlan freshness、Join 或 Publisher authority 下放给 parent/child Worker。 |
| 当前 `export-subjects` runtime topology binding 固定 `{effectiveChildCount:1}`，writer entry 实际只有一个 Writer。 | `src/main-process/background-execution/runtime.js`；`writer-worker-entry.js` | E12-C 需增加同步 topology planner，并让 admitted count 成为 graph 的唯一 child count authority。 |
| E12-A policy 把 full Writer vector 同时放在 phase 与 compound child；平台 CPU/IO budget 下，请求 2 child 会被 Governor 必然降级为 1。 | dual runtime admission probe；`policies.js`、`resource-governor.js` | E12-C parent coordinator 只占 base，实际 Writer 只计 compound child；phase 归零、childrenMax/requestedMax 收窄到 2；production 字段不变。 |
| 未发现现有 E12-C branch/worktree/提交或命名草稿。 | `git branch/worktree/log/reflog` 与路径搜索，2026-08-29 | 直接在 E12-B 精确父链实现，不机械搬运历史代码。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| admitted topology 如何传入 native parent Worker 并严格控制实际 child 数 | 已知未知 | 高 | 一般 | Supervisor 会把 frozen topology 交给 adapter，但 Job input 未携带它 | PROBE（已收口） | worker-thread adapter 增加 Main-owned reserved workerData；冲突 key 拒绝 | parent 只接受 reserved exact `{topologyKey,effectiveChildCount}`；caller input 无 worker count。 |
| shard 分配算法及 single/dual 阈值 | 合同细节 | 高 | 容易 | 冻结文档只要求 1/2、deterministic、unique coverage；policy 有 minUnitsPerWorker=2 | PROBE | 对照 platform policy 与 1～64 subject 测试 | 使用稳定 contiguous balanced partition；少于 4 subjects single，否则请求 two，低内存可由 Governor 降级 single。 |
| child crash/cancel/timeout/late message 的首错与清理 ownership | 状态盲区 | 高 | 一般 | 当前 worker-host 只有一个执行函数/AbortSignal | PROBE（已收口） | real/fake child crash、cancel timeout、duplicate terminal、sibling settle 注入 | parent coordinator 是 child transport 唯一 owner；首错 abort sibling，等待全组 terminal 后返回；Main 仍是 generation cleanup owner。 |
| child result 是否能沿用现有 full result validator | 数据契约 | 中 | 容易 | validator 要求 export-subjects artifact subjectIndex 从 0 连续，无法单独验证第二 shard | PROBE | 构造 shard-local result/reducer tests | 定义 internal exact shard result contract；只在 Main-visible deterministic merge 后使用现有 canonical validator。 |
| 15%/RSS/Windows 是否足以生产启用 | 外部门禁 | 高 | 困难 | Spec 明确要求 combined gate；本机 synthetic 5-run 已通过速度阈值并记录 RSS，但不等于真实样本/Windows | BLOCK（上线） | 真实大型样本五次中位数、small regression、Windows packaged、人工资金复核 | 本 PR 只交付 dormant capability/evidence，不改变 production；合并不代表上线。 |

## Reviewer Follow-up Unknowns（2026-08-29）

| reviewer finding | 分类 | 复现事实 | 收口合同 |
| --- | --- | --- | --- |
| non-opt-in entry 可自带 reserved topology key | BLOCK | reserved key 检查原本仅位于 opt-in merge 分支 | adapter 在任何 entry 创建 Worker 前无条件拒绝自带 reserved key；只有 opt-in 且 topology 校验后由 adapter 注入。 |
| allSettled 后按 shardIndex 选错可能覆盖真实首错 | BLOCK | shard1 先发 root、shard0 后发 non-cancel teardown 时旧逻辑会选 shard0 | 每个 shard Promise 的第一个 catch 按事件时间冻结 `firstFailure`，随后 abort sibling；allSettled 只等待/诊断，最终抛冻结首错。 |
| child error terminal decode 可在 EventEmitter callback 中 throw 并悬空 | BLOCK | malformed/oversized/private/invalid SafeError 会使 `fromProtocolError` 抛出 | decode 全程 catch，统一转换为有界 `VCC_EXPORT_SHARD_RESULT_INVALID` 并结算 shard Promise；group allSettled、Main cleanup、Publisher=0。 |

- Reviewer 已撤回默认 execution timeout 建议；冻结合同不要求，本轮明确不增加。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 固定 planner/shard/result contract | exact 1/2 ownership、零重复零遗漏 | 1～64 subject property/反例测试 | 推翻 coordinator 输入契约 | 保持 single Writer，不修改 production。 |
| 2 | 接入 admitted topology 与 parent coordinator | 实际 child 数等于 CompoundLease authority；caller 不可注入 | runtime real-worker 与 override 反例 | 推翻并行 graph | topology planner 固定 1。 |
| 3 | 实现 two child read-only execution 与 deterministic merge | 每 child 只读 assigned subjects；late/error 不污染终态 | query instrumentation、crash/cancel/timeout/late tests | 阻止 Main Join/Publisher | fail-closed，清理 task-private generations。 |
| 4 | 复用 Main B/Join/Publisher/cleanup | FilePlan/order/amount/currency/Pending/revision/archive/lineage 守恒 | 1/2 byte/business equivalence、Publisher 0/1、recovery tests | 禁止发布 | 保留现有 single path。 |
| 5 | 回归、性能/RSS、两类 blindspot 与直接资金 checklist | 不越界、无旁路、可观测且门禁诚实 | 定向到 integration/smoke/static 证据 | production 继续 blocked | 不改 production/legacy。 |

## BLOCK 问题

- 无实施阻断；本机 synthetic 证据不能解除真实大型样本、Windows packaged 与人工资金复核门禁，不在 E12-C 代码范围内解除。

## 保守假设

- contiguous balanced shard 比奇偶分片更便于顺序 query/write 与审计，且不改变最终 subjectIndex order；若真实性能样本推翻，将只替换纯 planner，不改变 child/merge/public contract。
