# Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec §3-§13；TechDoc §1-§12；E06-P0 Service resource framework + receipt probes。
- Exact base：`7577d5ae2f627619ba3f22597505c587be9867b6`（merged v3.2.1 / PR #183 merge commit）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：Service Client、两类 Side receipt schema/repository、阻断 probe、定向测试与自审通过；分支提交且 worktree clean。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 复用现有 ServiceHost/Supervisor，只新增 module-scoped client | Host 已覆盖 BaseLease/generation/busy/close；缺的是 action/job ownership facade | 第二套 service runtime；业务模块直接持有全局 Supervisor | E06-A/E07-A 可复用同一平台且不能跨 serviceKey 调度/取消 |
| Duplicate receipt 归 current-session month Side DB | import/run business rows 真值都在该 DB；TechDoc 要求 side mutation 同事务 receipt | main DB receipt；跨库事务模拟 | receipt 只证明 side commit；main mirror 仍需 E07-B identity |
| Duplicate receipt 唯一键为 `(action_key, operation_key)`，phase 冻结 import/run side commit | operationKey 是 Task 操作身份；phase 可让 inspector 不靠 nullable 字段猜提交点 | 仅 `side_run_id` 推断；覆盖已有 receipt | exact replay 可判定，冲突 fail closed，不复写历史证据 |
| BankBU receipt 原样采用 TechDoc §7 DDL | frozen TechDoc 已给完整字段与 PK | 加自增 id、额外 phase、主库 receipt | E08-A 可直接在 import/run Side transaction 写入 |
| 两类 receipt 都要求 active transaction | worker-durable 合同要求 mutation + receipt 同事务 | repository 自行 BEGIN；reply 后补写 | 防止 receipt 与业务提交形成新 crash window |
| P0 不接 live writer、startup 或 main mirror | E07-A/E07-B/E08-A 各自拥有 startup/identity recovery；当前仍有强制 BLOCK | 在 P0 顺手改 constructor/mirror | production flag 和业务行为保持不变，避免跨 PR 混责 |
| 所有新边界只接受 plain own-data payload | 平台 execute gate 已冻结 Proxy/getter 零副作用；Service Client 与 receipt repository 若提前读取 getter 会形成旁路 | 直接读取 `request.actionKey` / receipt 字段；把异常对象交给下游再拒绝 | action owner 与 receipt identity 在任何副作用前 fail closed，且不改变合法 payload shape |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 空加法 receipt table 不改变现有清理行为 | live path 未写 receipt，既有 SQL 不引用新表 | 某个 `SELECT * FROM sqlite_master` strict test 可能变化 | 跑 Side DB/schema/store 定向回归；若依赖精确表集则更新为有证据的新合同 |
| compensation 不复写原 operation receipt | receipt 是不可变 commit evidence；TechDoc 只要求 compensation receipt complete | E07-B 若要求同表多 phase，需要新增独立 compensation identity | E07-B 只能做加法 migration，不能 UPDATE/DELETE 原 receipt |
| receipt retention 需后续 action-specific ACK/hold 合同 | frozen v3.2.2 未定义 TTL，现有整库删除路径仍在 | 提前写 live receipt 会被清理 | 本 PR 禁止 live writer；E07-B/E08-A 接线前将 retention 作为 BLOCK |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 暂无 | 暂无 | — | — | 不需要 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / canonical checksum | HEAD `7577d5ae2f627619ba3f22597505c587be9867b6`；canonical 3.2.2 Spec/TechDoc SHA-256 `0cdf28e5...` / `9fd15a46...` | 防基线/合同漂移 |
| focused Service Client tests | 5/5 PASS | action/job/service ownership、request forwarding、Proxy/getter 零副作用 |
| focused receipt schema/repository tests | 5/5 PASS | schema/PK/check/no-FK、事务、replay、conflict、严格类型、旧库幂等升级 |
| affected Side DB/store/service tests | 150/150 PASS | 空表加法不改现有 BankBU/Duplicate 导入、run、镜像、清理、UI wiring 与旧库行为 |
| Policy/Supervisor/ServiceHost 回归 | 134/134 PASS | ServiceClient 只做 facade，不改变 Host generation、资源、取消、关闭与 Registry production gate |
| `bank-bu-recon-side-db-parity.js` | 17/17 PASS | 月侧库 DDL 加法不改变 Pending/Bank/run 内容、主库隔离与 frozen golden |
| affected ESLint + `node --check` + `git diff --check` | PASS | 生产 JS 静态质量、语法和 diff 结构 |

首次在隔离 worktree 运行两个依赖 `xlsx` 的既有用例时，因 worktree 不含独立 `node_modules` 报 `MODULE_NOT_FOUND`；以主仓库只读 `NODE_PATH` 重跑后 BankBU 9/9、Duplicate 17/17 均通过。该失败不是实现或业务断言失败。

## Blindspot Self-review

| 盲区 | 结论 | 证据/处置 |
| --- | --- | --- |
| 入口旁路 | ServiceClient 仅从 background-execution package 导出；receipt 仅加 Side DB DDL/repository，未接 IPC、handler、Worker、constructor、policy 或 feature flag | `rg` 只命中新模块、DDL、测试；production policy diff 为零 |
| 跨模块所有权 | client action 集从冻结 Registry 的同一 `serviceKey` 派生；foreign action/job 拒绝，close 固定绑定 serviceKey | focused client 5/5；合法 request 原样转发 |
| 异常输入副作用 | ServiceClient/receipt payload 均拒绝 Proxy、getter、symbol/非 own-data 字段；验证不触发 getter/proxy trap | 零副作用回归用例；严格 string/safe-id/hash/month 检查 |
| 部分失败与幂等 | receipt 只能在 active transaction 内写；exact replay noop；同 operation identity 不同 payload 显式冲突 | 两类 repository transaction/replay/conflict tests |
| 生命周期/清理 | 新表无业务 FK，避免把证据绑定到会被覆盖/删除的业务行；P0 无 live receipt，因此现有整库删除语义不变 | PRAGMA FK=0；旧库重复 open；现有 store/service 回归 |
| 兼容升级 | 既有 Side DB 通过 `CREATE TABLE IF NOT EXISTS` 幂等补表，不改原业务表/索引/行 | drop-table legacy probe + 重复 open；BankBU parity 17/17 |
| 可观测性 | transaction-required 与 identity-conflict 均有稳定模块错误码；receipt 包含 action/operation/Task/month/side identity/hash/time | repository API 与 exact mapper tests |

未发现需要扩大 E06-P0 范围的 Block/Critical 自动缺口。receipt retention/ACK、startup inspector 与 main mirror CAS 仍是后续明确 BLOCK，不能因本 PR 通过而启用 mutation production。

## Reconciliation Blindspot Self-review

- 主键血缘：两表唯一键均为 `(action_key, operation_key)`；同时保留 `producer_task_run_id`、月份、import bundle/side run、phase/kind 与输入 SHA-256，避免用主库镜像 id 冒充 Side run id。
- 金额/币种/匹配：未修改金额、币种、候选生成/消费、MPT snapshot、匹配顺序、算法或 Excel 输出；BankBU frozen parity 17/17，Duplicate 既有 service 17/17。
- 幂等/部分失败：repository 禁止事务外 receipt；exact replay 不新增行；冲突 fail closed。P0 未接 live writer，因此不制造新的 side/main 双写窗口，也不声称已经关闭旧窗口。
- 行数与审计去向：仅创建空 metadata table；未增删业务 row、未改变 clear/import/run/export SQL。receipt 无业务 FK 是为了后续 recovery evidence 不被业务行 CASCADE，但 retention 仍需 E07-B/E08-A 冻结后方可接线。
- ⚠️ 关联功能 review：`run-data-store.js` 命中“per-月侧库体系” Risk-sensitive 资金红线。已核对 DDL 单一真相、侧/主 runId 命名空间与 Duplicate 当前周期清理合同；完成 store/run-store/service 回归和 BankBU side-db parity，算法/镜像/清理实现零改动。
- 🔴 人工门禁：Reviewer 仍需复核 Side DB 所有权、复合唯一键、无业务 FK 和后续 retention/hold 设计。资金/恢复人工红线与 production enablement 均保持关闭，不由 E06-P0 自动结果替代。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| FundRecon service state adoption 与 RSS | PROBE | E06-A | 不阻断 E06-P0；阻断 FundRecon production enable |
| Duplicate inspector/constructor barrier | PROBE | E07-A | 不阻断 E06-P0；阻断 Duplicate 所有 mutation production enable |
| Duplicate main mirror + receipt recovery/retention | PROBE | E07-B | 不阻断 E06-P0；阻断 committed/partial 判定 |
| BankBU side/main CAS identity 与 retention | PROBE | E08-A | 不阻断 E06-P0；阻断 BankBU import/run production enable |
| 资金红线真实样本复核 | REVIEW | Release owner / business reviewer | 不阻断 P0 scaffolding；阻断 action production enable |
