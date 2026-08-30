# E06-P0 Unknowns Preflight

## Task Brief

- Goal：在不接入任何业务 handler 的前提下，补齐模块级 Service Client，并冻结 Duplicate / BankBU side operation receipt 的最小 schema、幂等写入合同和已知启动/镜像阻断事实。
- Context：精确基线为已合并 `v3.2.1` commit `7577d5ae2f627619ba3f22597505c587be9867b6`；v3.2.2 冻结 Spec/TechDoc 位于 `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/`。
- Constraints：不接 live handler、Worker、startup coordinator 或 main mirror；不改变金额、币种、候选顺序、匹配算法、文件发布、production enablement；不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：Service Client 只能路由同一 `serviceKey` 的 action/job；两类 side receipt 在既有 Side DB 幂等建表、只能在业务事务内写入、exact replay 幂等、identity 冲突 fail closed；Duplicate startup 与 BankBU mirror 的现存阻断被可执行 probe 和文档明确记录；定向测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| v3.2.2 唯一冻结基线已在 v3.2.1 跟踪 | canonical Spec/TechDoc SHA-256 分别为 `0cdf28e5...` / `9fd15a46...`；根工作区另有未跟踪 proposed 草稿 | 只以 tracked canonical package 为合同，不改根工作区草稿 |
| 平台已有成熟 `ServiceHost` | `service-host.js` 已覆盖 BaseLease、generation、busy reject、job route、close/shutdown/status bound | 不再造第二套 host；只补 module-scoped client facade |
| Supervisor 公共 API 可执行任意已注册 action，也可按任意 jobId cancel/inspect | `supervisor.js` 公共 facade | Service Client 必须限制 action 集、foreign job cancel/inspect 和 close serviceKey |
| Duplicate constructor 当前会立即 reconcile 并最终 `clearAll()` | `duplicate-inbound-match/service.js` constructor / `reconcilePersistedRunMirrors` | E07-A 必须先完成独立只读 inspector；E06-P0 不得把现状误标为可上线 |
| Duplicate side mutation 与 main mirror 是两个提交点 | `duplicate-inbound-match-store.js` 与 main mirror repository 分离 | side receipt 只能证明 side commit；不能代替 main mirror identity/inspector |
| BankBU import 的业务原子边界在月 Side DB | `bank-bu-recon-db/month-repository.js#importMonthAtomic` | import receipt 属于同一月 Side DB，未来 E08-A 必须与 overwrite 同事务 |
| BankBU run 当前先写 Side run，关闭后再写 Main mirror | `bank-bu-recon-run-data.js#runViaSideDb` | 当前存在 side/main crash window；P0 receipt 不等于 E08-A CAS mirror 完成 |
| BankBU main mirror 尚无 `operation_key` / `side_run_id` | main migration + run repository | E08-A 仍为 production BLOCK，本 PR 不补 main mirror |
| v3.2.2 所有目标 action 的 production flag 冻结为 false | canonical policy fixture / Spec action table | 本 PR 不改 registry/runtime/feature flag |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 是否需要新 ServiceHost | 已知未知 | 高 | 困难 | 现有 host 已覆盖完整 service lifecycle | PROBE | 核对 host/supervisor tests 与公共 facade | 已关闭：不新建 host，只加 action/serviceKey 收口 client |
| Service Client 如何防跨服务 cancel/inspect | 状态所有权盲区 | 高 | 一般 | Supervisor job snapshot 带 actionKey | PROBE | fake supervisor 注入 foreign job | 已关闭：inspect 后验证 action owner；foreign job 显式拒绝 |
| Duplicate receipt 最小 side identity | 数据契约未知 | 高 | 一般 | TechDoc §5 要求 action/operation/task/import-or-run identity/phase/evidence/time | PROBE | 对照 import/run 表与 inspector 判定表 | 已关闭：冻结 importBundleId；run 额外 sideRunId；按 phase 区分 import/run side commit |
| BankBU receipt 字段是否可直接采用 TechDoc DDL | 数据契约未知 | 高 | 一般 | TechDoc §7 给出完整 DDL | PROBE | 与当前 month key、run row 对照 | 已关闭：原样采用字段与复合主键；run 要求 sideRunId，import 必须为 null |
| receipt 是否允许脱离业务 transaction 单独写 | 幂等/部分提交盲区 | 高 | 困难 | `worker-durable` 要求 mutation + receipt 同事务 | PROBE | repository 在 `db.isTransaction !== true` 时执行 | 已关闭：显式抛 transaction-required |
| exact replay 与冲突如何区分 | 幂等盲区 | 高 | 一般 | canonical operationKey 是本次 Task 身份 | PROBE | 同 key 同 payload / 不同 payload 两次插入 | 已关闭：exact replay 返回 `created:false`；任一 identity 不同显式冲突 |
| Duplicate startup inspector 是否可在 P0 接线 | 启动顺序未知 | 高 | 困难 | 当前 constructor 自带 destructive reconciliation；E07-A 明确拥有 coordinator | PROBE | constructor/source seam + implementation sequence | 已关闭：P0 只记录 BLOCK，不改 live startup |
| committed receipt 的清理/ACK 生命周期 | 生命周期盲区 | 高 | 一般 | v3.2.2 未冻结 TTL/ACK，现有 Duplicate/BankBU 仍有整库删除路径 | ASSUME | 搜索 delete/clear/orphan 路径 | P0 不猜 TTL；repository/DDL 无业务 FK。E07-B/E08-A 接线前必须先定义 retention/hold |

## BLOCK 问题

E06-P0 自身无 BLOCK。以下 BLOCK 被刻意保留给后续已冻结 PR，且继续阻断对应 action 的 production enablement：

1. Duplicate 独立只读 inspector 尚未先于 constructor / compensation 执行（E07-A）。
2. Duplicate main mirror 尚未共享 operationKey + side identity，receipt retention 仍未接线（E07-B）。
3. BankBU main mirror 尚未保存 operationKey + sideRunId，也无 captured pre-image CAS（E08-A）。
4. 资金/恢复人工门禁尚未完成；partial / unknown 禁止自动重跑。

## 已执行 PROBE

1. 精确基线：`v3.2.2` 本地版本分支从远端 `v3.2.1` merge commit `7577d5ae...` 建立，远端尚无 v3.2.2 feature 分支。
2. Service lifecycle：核对 `ServiceHost.openJob/closeService/shutdown/snapshot` 及现有 unit，确认 BaseLease、generation、busy reject、资源 drain 已有实现。
3. Duplicate startup：核对 constructor → `reconcilePersistedRunMirrors()` → `store.clearAll()`；当前顺序不满足 frozen startup inspector gate。
4. BankBU identity：核对 Side run insert 与 Main mirror upsert 为两个事务，且镜像 schema 无 operationKey/sideRunId。
5. Side DB ownership：Duplicate 与 BankBU 都由 `run-data-store.openSideDb` 幂等 ensure，适合加法 schema；当前 live mutation 不传 operation identity。

## 保守假设

- P0 新表为空且不接 live writer，因此现有业务行为、清理结果和用户 UI 不变。
- 不定义 receipt TTL、ACK 或 compensation 写法；表无业务 FK，避免先把 committed evidence 与会被覆盖/删除的业务行绑定。
- Duplicate `phase` 仅冻结本次 side commit 类型：`import-side-committed` / `run-side-committed`。compensation receipt 的独立身份由 E07-B 在 inspector/recovery 合同中补齐，不复写原 receipt。
- BankBU TechDoc 已给完整 DDL，因此不额外增加 `id`、phase 或 main mirror 字段。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 加 module-scoped Service Client | 防 action/job/serviceKey 跨模块旁路 | allowed action、foreign action/job、close binding tests | E06-A/E07-A 无安全 facade | 只保留现有 Supervisor，停止后续接线 |
| 2 | 幂等新增两类 Side DB receipt schema | 冻结 DB owner、identity 与唯一范围 | 新旧库重复 open、columns/PK/check/FK assertions | receipt 所有权不成立 | 回退加法 DDL（未写 live 数据） |
| 3 | 建 exact repository contract | 保护同事务、幂等 replay、冲突 fail closed | transaction/replay/conflict/type tests | 后续 writer 无稳定提交合同 | 保留只读 schema probe，不接 writer |
| 4 | startup/mirror blocker probe | 防 P0 被误解为 mutation production ready | source/schema evidence 与 notes | 后续错误启用 production | 保持 flag false，停止合并 |
| 5 | blindspot + reconciliation review | 检查旁路、部分失败、retention、资金身份 | 无存活 P0 Critical 自动缺口 | 不提交 | 补测试或收缩范围 |
