# E11-A ReconFix Service Preflight

## Task Brief

- Goal: 在不改变现有业务算法和线上入口的前提下，交付 `production.enabled=false` 的 ReconFix 长驻 Service capability，覆盖 import、standard 与 BOC 只读运行。
- Context: v3.2.4 冻结顺序中的首个 PR；E11-P0 的 JPM ID-aware reader/no-op/receipt 尚未交付。
- Constraints: 只实现 `recon-fix:import` 与 `recon-fix:run-readonly`；Main 不持有第二份大状态；大状态只在 Worker 内；所有公开 DTO 有界；复用既有 IO/engine/BOC 算法；live IPC 保持 legacy；不实现 JPM、export、VCC。
- Done when: 同一个 `service.recon-fix` 由 ServiceHost 单 owner 管理；busy/generation/revision/stale/close/crash 均 fail closed；import/run 的 state replacement 完成 PersistentReservation adoption 后才公布；standard/BOC 与 legacy golden 等价；场景或 BOC evidence 变化使旧 result 失效；规模/RSS probe 与定向测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E11-A 冻结在 E11-P0 之前 | `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/spec.md` §9 | E11-A 必须可独立合并，不能引用尚未交付的 JPM schema/API |
| JPM 的强制 BLOCK 不阻止只读 action | v3.2.4 spec §10；`platform-contract-v1.md` §16 明确“不阻止纯 Parser、只读 query” | 本 PR 保持 JPM legacy，standard/BOC 可继续 |
| standard 与 BOC 都可纯计算；只有 JPM 回写 ADM | `src/main-process/recon-id-fix-engine.js`；`scenario-engines/boc-dispatch-order-fix.js` 顶层契约；`src/main.js` ReconFix run 分流 | Worker 复用既有引擎，禁止新增金额、币种、匹配或 1:1 逻辑 |
| BOC evidence 可从主库只读取得 | `linked-table-repository.readBocFxLinkRows()` 是 `ORDER BY id ASC` 只读查询；本机 `DatabaseSync(path,{readOnly:true})` probe 拒绝写入 | command 只传 `dbPath`，Worker read-only 打开，避免把整表塞入 DTO |
| 平台已有 ServiceHost/Governor 原子 state replacement | `service-host.js` 校验 request matrix、owner revision、replacement reservation，并要求 adopt-ack 后 publication | 不另造 Service/Governor；Worker 实现 control/resource 协议并等待 adopt-ack |
| canonical policy 已冻结 import/run-readonly 为同一 Service | canonical `policy-registry.v3.2.x.json` 中两项均为 `thread-single/service/native/commit:none/production:false/service.recon-fix` | 生产 policy 必须逐字段服从 fixture；JPM/export policy 不在本 PR runtime 注册 |
| live ReconFix 大状态目前在 Main globals | `src/main.js` 的 `reconIdFixSession/reconIdFixResult` | capability 不接 live IPC，因此不新增或复制 Main 大 state；线上行为保持 legacy |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Service Worker 是否能只读打开 live 主库 | 已知未知 | 高 | 容易 | Node 25 `DatabaseSync(...,{readOnly:true})` 本机 probe 成功，写入得到 `ERR_SQLITE_ERROR` | PROBE | Worker integration 读取临时 WAL DB 并验证主库未变 | 采用只读 DB path；失败则仅收缩 BOC capability，不改为大 DTO |
| PersistentReservation 是否在 job terminal 前完成 adoption | 状态盲区 | 高 | 一般 | ServiceHost 只有 `resource:adopt-ack` 后才把 token publication 视为完成 | PROBE | 事件时序测试：grant→adopted→ack 前不得 job:done | Worker pending adoption 明确等待 ack |
| state footprint 是否能在 256 MiB 上限内保守估计 | 资源盲区 | 中 | 容易 | canonical policy 上限 268435456；session/result 为 JS 对象 | PROBE | 大 fixture 的 compact bytes、estimated bytes 与 RSS delta probe | 使用有上限的保守 estimator；超限不采用候选 |
| scenario/BOC evidence 变化是否会残留旧 result | 状态生命周期盲区 | 高 | 容易 | spec 要求变更失效；现有 live 通过主动清和 export 重读防守 | PROBE | 连续 run：改变 scenario snapshot/BOC DB，断言 revision 前进且旧 result handle 不再可见 | 每次 run 在 candidate 中只采用当前 evidence；不同 evidence 先失效旧 result |
| E11-A 是否依赖 E11-P0 | 公共合同未知 | 高 | 困难 | PR 顺序、BLOCK 文本及现有调用链均证明只读分支不调用 ADM reader/writeback | PROBE | 静态依赖扫描禁止 worker/service/policies import JPM engine、ADM reader、receipt | 无依赖；若扫描命中立即 BLOCK |

## BLOCK

无。当前证据证明 E11-A 可以在 E11-P0 之前独立交付。

## 保守假设

- production false capability 通过共享 background runtime 的非 production `execute()` 直接验收；不修改 live IPC 或 Renderer。
- E11-A 的 result 只需 Worker 私有保存与 bounded summary，不提供 export handle 的跨进程消费；export handle/Publisher 属于 E11-C。
- BOC evidence hash 只用于 state freshness/审计，不改变 BOC 业务判定；坏 JSON 继续服从既有 BOC reader 的 legacy 容错，本 PR 不借机修改数据语义。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 production policies/result contract | E11-A 不越入 JPM/export | policy registry exact fixture 对照、静态禁依赖测试 | 推翻 runtime 接入 | 仅保留纯 service core probe |
| 2 | 实现 Worker-owned state 与 Service control | 单 owner、busy、generation/revision、adoption 顺序 | protocol/state/close-crash tests | 推翻 Service capability | 不接 runtime |
| 3 | 接入 import 与 standard 最小闭环 | 复用既有 IO/engine，无业务漂移 | legacy 与 service golden deep-equal | standard 不可交付 | 删除 runtime policy |
| 4 | 接入 BOC read-only DB evidence | 不传大 DTO、不写 DB、不改变 BOC 1:1 | read-only DB hash + golden + DB hash before/after | BOC 收缩/阻断 | 保留 standard，报告 BOC BLOCK |
| 5 | state invalidation/close/crash/size/RSS | 生命周期与资源不泄漏 | generation/revision/stale/reservation/RSS probes | 不允许提交 | 修正状态机或收紧限额 |
| 6 | 盲区复核与定向回归 | 行数、金额、币种、审计与 legacy | targeted unit/golden/static checks | 保留 production false，不宣布完成 | 回滚 capability 接入 |
