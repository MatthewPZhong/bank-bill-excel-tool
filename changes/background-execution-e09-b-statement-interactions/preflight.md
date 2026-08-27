# E09-B Statement Interactions Unknowns Preflight

## Task Brief

- Goal：仅实现 frozen v3.2.3 E09-B 的 Statement pending-interaction reservation、opaque single-use token 与 waiting-user continuation 生命周期。
- Context：精确 base/初始 HEAD 为 `04b6ca3f1e87c0ddcda4d709fbc95d4a39eba6ad`；E09-A 已实现 dormant Statement Service import/session/revision 与真实 Service Control persistent adoption。
- Constraints：不接 live IPC，不实现 E09-C generation、E09-D manual seed settlement 或 E10；五个 Statement action 必须保持 `production=false / effectiveMode=legacy / effectiveWorkerCount=0`。Renderer 不得取得 rows、private context、reservationId 或 source path。资金、恢复与人工门禁不改写。
- Done when：token 严格按 estimate → request/grant → private insert → adopted/adopt-ack → bounded public DTO 发布；每 Service 单一重 token、TTL/总预算/single-use 与 mutation/expiry/cancel/crash/quit invalidate/release 可证明；waiting-user 保持同一 TaskRun running，释放 phase/lock、continuation 新 job 重取并精确重验全部 evidence；定向 tests/lint/check 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E09-A candidate session 仅在 matching adopt-ack 后替换，Main/协议不持业务行 | `src/main-process/statement-worker/service.js`、`statement-service-e09-a.test.js` | token 也必须复用同一真实 Service Control FSM，不得本地伪造 grant |
| ServiceHost 已在 adopt-ack 后标记 interaction reservation，并在成功 job detach 后保留，失败/cancel/crash/close 会 revoke/drain | `service-host.js#processAdopted/#routeJobMessage` 与 service-host token lifecycle tests | Worker 可在后续 continuation/expiry 用 exact reservation owner release；Host 是 Main-only reservation 真值 |
| E09-P0 已冻结 purpose-specific public DTO、240 KiB inner ceiling、15min TTL、maxOutstanding=1 与 deterministic private footprint estimator | `statement-worker/contracts.js`、`state-footprint.js`、E09-P0 tests | E09-B 必须直接复用，不放宽 status 1 MiB ceiling 到交互 DTO |
| Supervisor 每个新 job 重新获取并在 settle 后释放 PhaseLease | `background-execution/supervisor.js` admission/settle；Supervisor tests | waiting-user 不保留 Phase CPU/I/O；continuation 自然是同 Service 的新 job |
| frozen lifecycle 将 waiting-user 映射为 TaskRun running，而 crash/quit 未完成交互映射 interrupted | v3.2.3 Spec §5、TechDoc §4/§8、platform lifecycle §9/§12 | Main coordinator 只保存 bounded task/token handle；不能把 job:done 误当 Task terminal |
| 现有 E09-A 对大账号 mapping 明确 blocked，template evidence 尚未携带维护的大账号候选 | `session-state.js#assertImportDoesNotRequireInteraction`、E09-A preflight/notes/test | E09-B 需 additive 扩展 template evidence，并由 Worker 读源后构造 prompt/private draft；旧 evidence 必须兼容 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| token private insert 与 public publication 的最小 FSM | 状态/资源 | 高 | 一般 | TechDoc §3、Host adopted state | PROBE | 真实 Supervisor/Host trace，在 grant/adopt-ack 两点阻塞 | draft 仅 job 内；grant 后 registry private insert；adopt-ack 后 published，此前无 job:done |
| continuation 如何证明 choice/template/mapping/source 未变 | 公共契约/资金边界 | 高 | 一般 | frozen Spec 明确逐项重验；E09-A source/template evidence | PROBE | exact continuation validator + tamper/stale matrix | token 保存 canonical evidence/digest；新 job 重新提交 bounded evidence，Worker exact 比较并重新 stat/read |
| session mutation 与 token 同时存在时释放顺序 | 生命周期/竞态 | 高 | 一般 | maxOutstanding=1；mutation makes token stale | PROBE | delayed release-ack 与 import adoption race | 只有新 session adopt-ack 后 invalidate旧 token；新 interaction 在建 reservation 前先精确释放旧 token |
| waiting-user business lock 由何处持有 | ownership | 高 | 容易 | Main Control Plane 独占业务锁；E09-B 不接 live Main | PROBE | 独立 coordinator 注入 owner-aware acquire/release fakes | 新建 dormant Main coordinator，严格校验 taskRunId/jobId/token identity；不把锁实例传 Worker |
| 大账号多 block assignment 是否能复用现有金额 mapper | 资金语义 | 高 | 一般 | legacy 先用现有 mapper 产 provisional rows，再按 block 赋 Merchant/Currency | PROBE | 提取同等 block helper并做 legacy shape/row count tests | 继续唯一调用 `buildMappedRows`；只在 Worker 私有 draft 对映射后行赋账号/币种，不改金额/借贷算法 |

## BLOCK 问题

无新的用户选择 BLOCK。真实资金样本、Windows packaged、TaskLifecycle live wiring 与 production enable 仍是既有人工/后续门禁，本 PR 不关闭。

## 保守假设

- E09-B 只接通 `big-account` interaction；manual-balance 与 scope-generation 只保留已冻结 DTO/purpose，不提前实现 E09-C/D。
- dormant waiting-user coordinator 以注入的 Main-owned lock/phase owner API 验证合同；live handler 接线留给 action enable PR，避免改变当前用户路径。
- E09-A 老 template evidence 不含候选字段时继续非交互路径；只有明确 multi-big-account mapping 且携带合法维护候选时才发行 token，否则 fail closed。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 additive interaction/continuation exact contract 与 token registry | Renderer/Main bounded；choice/evidence不可篡改 | validator/hostile DTO/privacy tests | 公共边界不可信则不接 Service | 保留 E09-A blocked |
| 2 | 接真实 pending reservation FSM 与 TTL/release | grant/adopt-ack前不可见；single owner无泄漏 | 真实 Host/Governor trace、race/fake clock | 资源闭环不成立则停止 | 删除 Service issuance wiring |
| 3 | 接 big-account continuation重新读取/采用 | generation/revision/purpose/TTL/choice/template/source fail closed | stale/tamper/single-use/session revision tests | 资金输入边界不可信则不采用 | 保留 token 基础设施 dormant |
| 4 | 实现 Main waiting-user coordinator | 同 TaskRun/new job，phase/lock exact release/reacquire | ownership/late event/idempotency unit tests | 不接 live | 仅保留 contract tests |
| 5 | cancellation/crash/quit/invalidation与盲区复核 | 无 generalized stale ignore、无 lease/context泄漏 | fault/race/status/privacy tests | 保持 production false | 不扩大功能范围 |
