# v3.2.1 E05-B Unknowns Preflight

## Task Brief

- Goal：把 E05-A 的严格 spool 与 Ordered Coordinator 接到一个 parent job 下的单一 PreFund Writer Worker，并按每文件 Critical Intent + 同事务 operation receipt 支持唯一恢复。
- Context：精确基线为已审查 E05-P0 `aef27d36a985b13ff745b21625ae24105c6952f4`；生产 import/repair 仍走旧 service，generic Supervisor 尚拒绝 native `worker-durable`。
- Constraints：复用旧 filename/hash、source identity/sequence、insert/replace/noop、strict/repair、dataset/version 与候选顺序；一个 parent transport、一个 Writer 实例、fileIndex 严格递增；production.enabled 保持 false；不实现 Parser Pool >1；不运行 release-check/check-vars/scan:vars。
- Done when：prepared→acked 后才 ACK；每 unit mutation/noop + receipt 同一 `BEGIN IMMEDIATE`；COMMIT 后丢回包可由 canonical RecoverySourceV1 inspector 判定且不重复 mutation；unknown/partial/result-lost 进入 interrupted/Hold；import/repair legacy fallback 不能绕过；mixed result 与 E05-P0 fixture 不漂移。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| generic Supervisor 对 native worker-durable 显式抛 `E02A_DURABLE_COMMIT_UNSUPPORTED`，并拒绝 `critical:ready/commit:receipt`。 | `src/main-process/background-execution/supervisor.js` start gate 与 `onMessage`。 | E05-B 必须先补 generic 能力，不能用测试 seam 假装 production capability。 |
| Supervisor 已有单 transport、多 unit、Protocol v1 sequence、资源 lease、shutdown 与 protected state骨架。 | 同文件 job/unit state、adapter、shutdown。 | 复用该 owner；增加 deferred ordered unit dispatch 与 per-unit critical state，不另造 transport 协议。 |
| 旧 service 每文件异常继续，父 `status=ok`，结果等长同序且 Task succeeded。 | E05-P0 fixture/tests/implementation notes。 | parser error、writer business error均是 file result；只有恢复未决才打断普通终态。 |
| 旧 store 在完整文件 `BEGIN IMMEDIATE` 内完成 identity/sequence、保留 replacement batch.id、行写入、strict rollback、dataset/version。 | `src/backend/pre-fund-reconciliation-store.js::_importFileUnlocked`。 | 抽取共享 transaction core供 legacy parser与 spool writer复用，避免复制资金语义。 |
| E05-A Reader 先完整验证 spool，再二次流式 callback；source只做快照/hash/header锚定。 | `mpt-import/spool-reader.js`。 | Writer不调用 MPT parser；事务只能在首遍严格验证完成后开始，并在二遍校验结束后提交。 |
| receipt 位于 source-month Side DB，`(action_key,operation_key)` 唯一且 insert 要求 active transaction。 | E05-P0 repository/DDL/tests。 | Writer receipt 与业务 mutation/noop天然同事务；exact replay/冲突必须复用 repository。 |
| Startup Recovery 已有 canonical source、InspectorRegistry、RecoveryControl transaction 与 Hold gate，但产品启动未注册业务 inspector/provider。 | `initializeBackgroundExecutionRecovery()`。 | 只注册 PreFund inspector/resolvePolicy；不定义第二套 source/inspect。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 一个 parent job 如何在 parser ready 顺序产生后才派发 unit。 | 平台 gap | 高 | 一般 | Supervisor 当前启动时立即发送全部 unit:start。 | PROBE | 增加 deferred unit control并用现有 Protocol validator/sequence测试。 | parent job预注册 unit；Ordered Coordinator调用 `startUnit`，一次只等待一个 terminal。 |
| protected 是否能按每文件独立收口。 | 状态盲区 | 高 | 一般 | job当前只有单 state。 | PROBE | ACK/receipt/unit done/cancel/shutdown fault matrix。 | per-unit critical state；任一 acked/committed 未 unit terminal时 job=protected。 |
| COMMIT后回包丢失如何重建旧 result。 | 恢复未知 | 高 | 一般 | receipt含 outcome/batch/dataset/source，Inspector可读业务 batch。 | PROBE | kill after COMMIT并 inspector/replay。 | inspector committed返回 bounded receipt identity；managed reducer重建成功 item，不重写业务。 |
| receipt-only DB 中业务 evidence已删除。 | 规范明确 | 高 | 容易 | E05-P0故意保留receipt且无batch FK；冻结规范要求 unknown。 | PROBE | 删除batch后 inspect。 | receipt-only 必须 unknown + Hold，不自行修复。 |
| conflict scope粒度。 | 数据合同 | 高 | 一般 | replacement identity是 `(sourceType, sourceBatch)`；Side DB月份只是存储边界。 | PROBE（已收口） | 同批 import/repair与同月不同批测试。 | scope为 exact identity的稳定不透明SHA-256；同批互阻，同月不同批不互阻。 |

## BLOCK 问题

无。parent 单 Writer topology、source-month transaction、恢复 authority与父 mixed golden均由冻结规范和现有代码唯一收口。

## 保守假设

- E05-B capability parser count固定1（production仍false/effectiveWorkerCount=0）；import与repair都以parent CompoundLease真实计入Writer phase + Parser child，Pool >1与性能资源门禁留给 E05-C。
- production.enabled=false 时真实 handler继续旧业务实现，但同一 Recovery Hold gate始终在 managed/legacy选择之前执行。
- PreFund不复用按 taskKey 全局循环 Hold 的 generic gate；picker/header或repair failure只读解析身份后精确gate。delete按batch gate，date-range按受影响batch gate，clear在任一active PreFund Hold时拒绝。
- closed receipt永久保留沿用 E05-P0；本任务不新增 TTL。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 补 Supervisor worker-durable + deferred unit。 | Main ACK持久性、single transport、protected shutdown。 | generic protocol/fault tests。 | 平台合同不成立，停止业务接线。 | 保留现有 none/main/existing路径零变化。 |
| 2 | 抽取旧 store transaction core并接 spool。 | 资金身份、顺序、金额币种、batch/version零漂移。 | legacy/spool parity与行数守恒。 | 资金语义漂移，回退抽取。 | 旧 `importFile`保留同一 core。 |
| 3 | 实现单 Writer Worker与parent coordinator。 | fileIndex递增、无并发writer、parser-error继续。 | real Worker多unit/乱序 ready测试。 | parent mixed合同漂移。 | production仍false。 |
| 4 | 实现 inspector/RecoveryControl/hold。 | crash唯一判定、unknown fail closed。 | canonical/read-only/idempotent/fault matrix。 | 不允许接 handler。 | 保持业务 action legacy。 |
| 5 | false-gated接入 import/repair并回归。 | lock全生命周期、legacy不能绕hold、golden不漂移。 | handler seam + task lifecycle tests。 | 回退 managed flag分支，保留安全gate。 | production.enabled仍false。 |
