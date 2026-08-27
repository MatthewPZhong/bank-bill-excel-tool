# E11-B JPM Worker-durable / Inspector Preflight

## Task Brief

- Goal：复用 E11-P0 的 ID-aware reader、writeback plan 与同事务 receipt 原语，把 `recon-fix:run-jpm` 接入 ReconFix Service worker-durable 协议，并交付 receipt-first Inspector、startup recovery 与 ADM conflict Hold。
- Context：精确基线 `1d9588a7e5303e9b8a5621095c445d7a9c1c6005`；E11-A 已有 production-false Service import/standard/BOC，E11-P0 已有可信 plan/no-op/transaction/receipt 基础。
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
| JPM legacy 与 readonly action 共用 `recon-id-fix:run` TaskPolicy | action-task binding registry | ADM Hold 必须延迟到确认 JPM 场景后精确 gate，不能误阻 standard/BOC |

## Unknowns Register

| 未知 | 分类 | 结论 |
| --- | --- | --- |
| receipt 后 adoption 如何证明 Main 已观察 | PROBE | 不新增冻结 protocol operation；ServiceHost 对 `persistent-state-replace` 增加 Main adoption gate。mutation 必须等 Inspector 同快照验证 receipt/current post 并把 Intent 标为 committed 后才 grant；no-op/失效候选在采用前检查同 operation 不存在 receipt/Intent，`unit:done` 再校验 exact bounded noop |
| 单次 JPM operation 如何映射 unit | PROBE | runtime 内部为该 action 注入一个固定 unit；Worker 拒绝其它 unit identity，避免让 public caller 决定 critical ownership |
| conflict scope 粒度 | PROBE | legacy writer/新 transaction 都覆盖同一整张 ADM image，故使用单一模块级 ADM mutation scope；比按 scenario/row 缩小更符合实际写集合 |
| 已有 receipt/open intent 的 replay | PROBE | prepare 前和 no-op candidate adoption 前都检查同 operation receipt/Intent；acked/committed/closed 或跨 task/job identity 一律拒绝，不重新 ACK mutation，也不先采用 replay candidate |
| committed 但内存 result 丢失 | ASSUME | Inspector 标记 committed、Intent 收口、Task interrupted；不重建 candidate，不自动重跑 mutation。unknown 才创建 ADM conflict Hold |

## BLOCK

无。冻结合同与现有 Platform critical/recovery primitives 足以实现；production enable、Windows packaged lock 验证与真实 JPM 样本资金复核继续作为人工 gate。

## 风险优先计划

1. 注册 exact policy、单 unit 与 operation taskRunId lineage，保持 production false。
2. 在 Service 私有 pending map 构造 JPM candidate/plan，先锁 noop，再接 critical/receipt/adoption。
3. 实现 exact coordinator、receipt authority 与 receipt-first read-only Inspector。
4. 接 startup registry/recovery plan/ADM Hold，并在 legacy JPM mutation 前后二次 gate。
5. 跑真实 SQLite/WAL、fault/crash/cancel/legacy/standard/BOC 定向测试，完成资金盲区复核。
