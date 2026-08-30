# E07-A Duplicate Startup / Single Service Unknowns Preflight

## Task Brief

- Goal：在任何 Duplicate compensation、expiration、`clearAll()` 或 Service 构造前，先完成独立只读 inspector、持久 observation/Recovery Hold；同时交付共用 `service.duplicate` 的 production-false 单一长驻 Service capability。
- Context：精确基线为 E06-A commit `ce099b5446b6d18fa41ccf660bd6d55d32f595d4`；冻结合同为 `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/{spec,techdoc}.md`、Platform Contract v1 与 canonical policy fixture。
- Constraints：复用现有 InspectorRegistry、SettlementRecoveryProviderRegistry、StartupRecoveryCoordinator、RecoveryControlRepository 与 ServiceHost；不创建协议方言；live IPC 保持 legacy；production 固定 `false`；不接 E07-B receipt/mirror recovery 或 E07-C paired parser；不运行 `release-check`、`check-vars`、`scan:vars`。
- Done when：constructor 无 destructive startup side effect；startup gate awaited 且 inspector/observation/Hold 先于 Service；unknown/partial 不清理且 legacy fallback 不能绕 Hold；三张 canonical policy 共用一个真实 Service，busy/generation/revision/reservation/close/crash/status 合同有证据；import effective child count 固定 1。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 当前 constructor 会调用 `reconcilePersistedRunMirrors()`，最终无条件 `store.clearAll()` | `src/main-process/duplicate-inbound-match/service.js` | 必须把 startup reconciliation 从 constructor 移出；命令内新 import/new run 失效语义保留 |
| 当前 Main 用 `setImmediate` 触发 lazy getter 完成启动清理 | `src/main.js` 的 `scheduleDuplicateInboundMatchStartupCleanup()` | 不能证明 awaited 顺序；必须替换为 DB init 后、业务 owner/IPC 前的显式 gate |
| generic startup coordinator 只扫描 open Critical Intent 和 provider sources | `startup-recovery-coordinator.js#scanAndRecover` | Duplicate 必须提供 `module-recovery` source provider；不能期待平台自动枚举 side DB |
| Platform Contract 已冻结 `module-recovery`、只读 inspector、provider 与 Hold 原子审计 | `platform-contract-v1.md` §3、§7.6-§8.1 | 不新建 recovery schema/状态机，不伪造 Critical Intent |
| E06-P0 已加 Duplicate operation receipt schema/repository，但 live import/run 未写 receipt | `run-data-store.js`、`operation-receipt-repository.js` 及 E06-P0 notes | E07-A 只能把 receipt table/side family 的存在当 residue；不能宣称 side/main commit state 闭环 |
| main mirror 尚无 `operationKey/producerTaskRunId` | `duplicate-inbound-match-run-repository.js` | residue 不能唯一配对时只能 unknown + Hold；字段与补镜像留给 E07-B |
| canonical import policy 是 `thread-pool` + compound，三 action 共用 `service.duplicate` | v3.2.x policy fixture | 本 PR保留 canonical声明，但 topology planner 恒为 1，不启动 child parser |
| E06-A 已验证 ServiceHost generation、busy、PersistentReservation adopt ACK 与 close/crash | FundRecon service/host/runtime及 tests | Duplicate 复用同一 Host/Envelope，不复制平台生命周期 |
| frozen action table要求 production=false/effective legacy | v3.2.2 Spec §3、fixture | capability 可本地运行验证，但不得接管 live handler |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| startup source 如何稳定枚举并在 active Hold 后重现 | 恢复身份 | 高 | 一般 | `module-recovery` source必须稳定、Hold重扫必须重新枚举 | PROBE | clean/residue 下重复取得 provider source，并交给真实 coordinator 扫描 | provider 始终枚举固定 canonical source identity；变化中的 side/mirror snapshot 只进入 inspection evidence hash，不进入 source identity |
| 严格只读 side DB 如何打开 | 证据保全 | 高 | 一般 | 现有 `openExistingSideDb()` 会执行 PRAGMA；实测普通 `readOnly:true` 打开 WAL 库仍可创建 `-wal/-shm` | PROBE | WAL 模式 side DB + 文件 bytes/mtime/目录快照不变测试 | inspector 扫描整组 main/WAL/SHM 文件，主文件仅用 `file:?immutable=1` + readOnly 打开，只查询 schema 与 `EXISTS`，不调用 store/service/DDL |
| 无共同 operation identity 的历史 residue 如何处理 | partial/unknown | 高 | 困难 | E07-B尚未补 main identity | PROBE | side-only/mirror-only/receipt-present fixture | E07-A全部判 unknown + Hold，不清理、不补镜像、不重跑 |
| canonical `thread-pool` 如何不越过 E07-C | topology边界 | 高 | 容易 | Supervisor允许 conservative child count=1 | PROBE | topology/runtime test | planner恒1；不新增 parser/spool/reducer行为 |
| Worker如何复用现有真实 Duplicate command/state而不复制算法 | 所有权 | 高 | 一般 | 现有 Service已封装 import/run/export/status，完整状态在实例内 | PROBE | 真实 Worker import/run/status + dependency seam | Worker只持一个真实 service实例；Main live handler仍持legacy实例，二者不会同时接同一 live流量 |
| E07-B字段是否是完成E07-A的硬依赖 | PR边界 | 高 | 困难 | startup safety可通过unknown Hold完成，production保持false | PROBE | startup fault/hold tests | 已关闭：不是E07-A实现BLOCK；是Duplicate mutation production BLOCK |

## BLOCK 与保守边界

E07-A production-false capability 没有未解决的实现 BLOCK。以下条件继续阻断 Duplicate production enablement：

1. E07-B 尚未让 side receipt 与 main mirror共享 `operationKey/producerTaskRunId`，不能唯一判断 committed/partial。
2. E07-B 尚未实现补镜像 CAS、compensation/expiration receipt 与 crash-window fault matrix。
3. E07-C 尚未通过 paired parser 15% / RSS 门禁；本 PR effective child count只能是 1。
4. BizId/MPT/document lineage、candidate consumption 与 side/mirror恢复仍须真实样本人工资金复核。

## 保守假设

- 无任何 side DB、mirror、receipt residue 时 outcome=`not-committed`，可放行纯 constructor。
- 任一 residue 在 E07-A 都视为无法唯一归因，返回 `unknown` 并 Hold；不将旧 mirror status 或 side row猜成 commit proof。
- 新 import/new run 命令内既有失效顺序是业务合同，不因移除 constructor cleanup 而改变。
- live IPC 保持 legacy；managed capability 仅通过显式 runtime 测试入口验证，不暗切用户流量。
- Main 可以保存 bounded startup/service summary 与 generation/revision，但不保存 managed path完整 rows/result。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 只读 inspector + module provider | 证据不被 constructor/DDL清除，source可重扫 | fixed source、mtime/bytes/目录零变化、孤立WAL/SHM可见 | startup安全不成立 | 不构造Service，停止接线 |
| 2 | awaited coordinator + Hold gate | observation/Hold先于任何清理，legacy无旁路 | 顺序spy、unknown/inspector failure零破坏 | 资金证据可能丢失 | startup fail closed |
| 3 | constructor纯化 | 构造不修改 side/main | constructor clear/mirror写调用数0；命令内失效回归 | 旧行为误删或清理遗漏 | 仅移除startup调用，不动command方法 |
| 4 | canonical policy + single Service | 单owner、busy、generation/revision、资源adoption | fixture parity、真实Worker、reservation/close/crash | capability不完整 | 保持runtime未接live且production=false |
| 5 | topology=1 +回归/盲区复核 | 不越过E07-C，不改变候选/行数 | effective count=1、Duplicate golden/store/wiring | 顺序/资金语义漂移 | 删除新runtime接线，保留安全startup slice |
