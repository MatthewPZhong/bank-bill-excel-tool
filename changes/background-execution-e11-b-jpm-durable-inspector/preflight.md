# E11-B JPM Worker-durable / Inspector Preflight

## Task Brief

- Goal：复用 E11-P0 的 ID-aware reader、writeback plan 与同事务 receipt 原语，把 `recon-fix:run-jpm` 接入 ReconFix Service worker-durable 协议，并交付 receipt-first Inspector、startup recovery 与 ADM conflict Hold。
- Context：精确基线为已复核的 E11-P0 restack `888688afdeea9a32b8ac0277a027533308a277bb`；其包含最终 E11-A 的两段式 phase admission/streaming evidence，以及 E11-P0 的可信 plan/no-op/transaction/receipt 基础。旧 E11-B 五个独有提交按原序重叠后必须重新证明这两层合同共存。
- Constraints：JPM production 继续 `enabled=false / legacy / workerCount=0`；不实现 E11-C export/Publisher、VCC、结果跨 crash 重建或自动 mutation retry；不改变 standard/BOC/legacy 业务语义；不运行 release-check/check-vars/scan:vars。
- Done when：JPM full candidate 只存在 Service 私有 pending map；exact no-op 在 critical/事务前采用；mutation 按 persisted ACK → exact-id transaction+receipt → receipt verification → adopt 收口；Inspector 对 receipt/pre/post/坏 JSON/ID 变化矩阵 fail closed；unknown 建 ADM Hold 并阻断 legacy JPM mutation；startup 幂等、WAL 可见且不复制/切换 DB family；protected phase 不被 cancel/terminate 冒充取消；定向 crash/fault/static 回归通过。

## 已确认事实

| 事实 | 证据 | 约束 |
| --- | --- | --- |
| canonical `recon-fix:run-jpm` 是 native Service + worker-durable，Inspector key 为 `inspector.recon-fix:run-jpm`，production false | frozen policy fixture；v3.2.4 Spec §3 | 注册 byte-for-byte policy capability，但不打开 live managed routing |
| worker-durable Supervisor 以 unit 为 critical ownership 单元 | `background-execution/supervisor.js` critical state machine | JPM 使用一个内部固定 unit；调用方不能伪造 unit identity |
| operation context 含 taskRunId，但 Supervisor 目前只把 file-batch taskRunId 交给 coordinator | protocol exact-5；Supervisor `prepareAndAck/observeReceipt/...` | 本 PR 必须按两种 context 统一读取 taskRunId，否则 receipt/Intent 无法绑定 TaskRun |
| Service protocol 没有独立 receipt ACK；Main 对 Worker event 以 event chain 顺序处理 | Supervisor `processMessage` / event chain | Worker 发送 receipt 后只发送后续有序事件；Main 在接受 `unit:done` 前必须已验证 receipt，adoption 仍只发生在本地 exact receipt 返回之后 |
| E11-P0 receipt 与 ADM 位于同一 `tool-data.sqlite`，reader image 覆盖 exact id + 完整 parsed row | P0 notes/transaction/reader | Inspector 直接以只读连接观察同一 WAL family，禁止裸文件 copy |
| 最终 E11-A 要求任何整表读取/解析前先以有界证据取得唯一 `phase-extension` | E11-A `service.js`/`worker-entry.js` 与 14 项 Service 测试 | JPM 只能先在同一只读事务统计 ADM row/raw bytes，获得 ServiceHost/Governor grant 后才执行 strict `.all()`、engine、plan、transaction；不得自建第二 resource authority |
| JPM legacy 与 readonly action 共用 `recon-id-fix:run` TaskPolicy | action-task binding registry | ADM Hold 必须延迟到确认 JPM 场景后精确 gate，不能误阻 standard/BOC |

## Unknowns Register

| 未知 | 分类 | 结论 |
| --- | --- | --- |
| receipt 后 adoption 如何证明 Main 已观察 | PROBE | 不新增冻结 protocol operation；ServiceHost 对 `persistent-state-replace` 增加 Main adoption gate。mutation 必须等 Inspector 同快照验证 receipt/current post 并把 Intent 标为 committed 后才 grant；no-op/失效候选在采用前检查同 operation 不存在 receipt/Intent，`unit:done` 再校验 exact bounded noop |
| 单次 JPM operation 如何映射 unit | PROBE | runtime 内部为该 action 注入一个固定 unit；Worker 拒绝其它 unit identity，避免让 public caller 决定 critical ownership |
| conflict scope 粒度 | PROBE | legacy writer/新 transaction 都覆盖同一整张 ADM image，故使用单一模块级 ADM mutation scope；比按 scenario/row 缩小更符合实际写集合 |
| 已有 receipt/open intent 的 replay | PROBE | prepare 前和 no-op candidate adoption 前都检查同 operation receipt/Intent；acked/committed/closed 或跨 task/job identity 一律拒绝，不重新 ACK mutation，也不先采用 replay candidate |
| committed 但内存 result 丢失 | ASSUME | Inspector 标记 committed、Intent 收口、Task interrupted；不重建 candidate，不自动重跑 mutation。unknown 才创建 ADM conflict Hold |
| 旧 E11-B 的同步 ADM `.all()` 是否绕过最终 E11-A phase admission | PROBE | 是；restack 将 JPM 改为 `prepareAdmReadSnapshot()` 的 bounded aggregate → phase grant/adopt-ack → strict reader/engine/plan，写事务仍由同一 phase 覆盖并由 P0 在事务内重读 exact evidence |

## BLOCK

无。冻结合同与现有 Platform critical/recovery primitives 足以实现；production enable、Windows packaged lock 验证与真实 JPM 样本资金复核继续作为人工 gate。

## 风险优先计划

1. 注册 exact policy、单 unit 与 operation taskRunId lineage，保持 production false。
2. 以同一只读 SQLite snapshot 取得 bounded ADM size evidence，先获 canonical phase lease，再在 Service 私有 pending map 构造 JPM candidate/plan；先锁 noop，再接 critical/receipt/adoption。
3. 实现 exact coordinator、receipt authority 与 receipt-first read-only Inspector。
4. 接 startup registry/recovery plan/ADM Hold，并在 legacy JPM mutation 前后二次 gate。
5. 跑真实 SQLite/WAL、fault/crash/cancel/legacy/standard/BOC 定向测试，完成资金盲区复核。

## Review remediation：prepared threshold bundle

- Goal：关闭 `INSPECTOR_UNAVAILABLE` threshold 已 reserve Task/Hold/observation owner、但 control transaction 尚未提交时的重启窗口。
- Context：reviewed head `615cf64992917221be0890a7270518c98fe57ffd` 会按 transition requestKey 直接恢复任意 prepared body；该 key 只覆盖实体 identity，不覆盖 Task failure/message/metadata patch。
- Constraints：普通 reserve 的 changed-body conflict 不变；只允许已持久化的 committed Intent `mark-committed` / `close` exact replay；不得在不兼容 Task/Hold bundle 下关闭 Intent。
- Done when：真实磁盘 committed/not-committed 两路都先原子完成旧 threshold bundle，再经现有 Hold recovery 收敛；Task reason、Hold、Intent、owner、attempt 一致，第三次 startup 零动作。

| 未知 | 处理 | 证据与决定 |
| --- | --- | --- |
| prepared Task owner 能否仅凭 requestKey 当成新 definitive body | PROBE | 不能；`transitionIdentityTuple()` 的 `task-run.mark-interrupted` 不含 failureCode/message/metadataPatch，默认恢复 exact reserve/conflict |
| 如何在新 inspection 前识别旧 threshold bundle | PROBE | `inspection-failed-transient` + deterministic holdId 的 prepared observation attempt/owner 是持久 anchor；严格回验 source/attempt/threshold payload 后，重建当前 exact Task/Hold request 并在一个 control transaction 提交 |
| 是否需要泛化所有 prepared transition replay | PROBE | 不需要；body-divergent resume 只保留给 Main 已 reserve 的 committed Intent `mark-committed` / `close`，Task/Hold 继续 exact compare |

BLOCK：无。Reviewer 已给出冻结边界内的唯一真实触发窗口；production enable、Windows packaged WAL 与真实 JPM 样本仍保留人工 gate。

## Review remediation：atomic threshold anchor / 71c1 legacy gap

- Goal：确保任何 Task/Hold prepared owner 之前已有完整、可 exact resume 的 threshold observation anchor，并让 `71c1ac1066613f2009b4dfcd5e43dc1d2a735b65` 可能留下的 incomplete gap 在新 Inspector 前确定性收口。
- Context：第三轮无 Hold 顺序为 Task owner → Hold owner → attempt → observation owner → control transaction；已有 Hold + running Task 也先 reserve Task；任一早期独立提交后 crash 都可能留下 owner-without-anchor 或 unbound attempt。
- Constraints：普通 changed-body requestKey conflict 不变；body-divergent resume 仍只允许 committed Intent `mark-committed` / `close`；不得猜旧 observation payload、不得在 gap 未处理时运行 Inspector、不得错误关闭 ACKed Intent。
- Done when：新路径以单事务持久化 attempt + bound requestKey + observation owner，再 reserve Task/Hold；旧 Task-only、Task+Hold、Task+Hold+unbound-attempt 只在 exact transition body 可证明时同事务清理；committed/not-committed 均二启收敛、三启零动作。

| 未知 | 分类 | 证据与决定 |
| --- | --- | --- |
| attempt 与 observation owner 能否复用旧两段 API 达到原子性 | PROBE | 不能；旧 attempt repository 会先独立提交。新增 Main-internal `reserveObservationAnchor`，在一个短 `BEGIN IMMEDIATE` 内分配 ordinal、写已绑定 attempt 与 owner，owner 故障整体 rollback |
| 无 anchor 的旧 owner 是否能恢复原 threshold observation | PROBE | 不能；safePayload/event identity 不存在权威持久来源，禁止重建或猜测。只删除 exact 可证明的 incomplete Task/Hold owner 与 unbound attempt，再运行新 Inspector |
| 哪些残留形状属于当前版本可达迁移集合 | PROBE | 无 active Hold 严格限定 Task-only、Task+Hold、Task+Hold+unbound-attempt；已有 Hold 限定 Task-only、Task+unbound-attempt（以及无 Task 的 unbound attempt）；Hold-without-Task、多条 owner/attempt、body 不兼容均 fail closed，不扩成通用修复器 |
| cleanup 会否提前改变资金 authority | PROBE | cleanup 只删 `status=prepared` 的 incomplete control owners/attempt，不改 Task/Hold/Intent/ADM/receipt；Inspector 入口测试断言 Task running、Hold 0、Intent acked 且旧 gap 已清零 |

BLOCK：无。真实临时 SQLite 的 17 个新增 crash/migration case 已覆盖无/已有 Hold 与两种 definitive outcome；production/live/export/VCC 与资金人工门禁保持不变。
