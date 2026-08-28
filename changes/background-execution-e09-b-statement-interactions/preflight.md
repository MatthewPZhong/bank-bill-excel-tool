# E09-B Statement Interactions Unknowns Preflight

## Task Brief

- Goal：仅实现 frozen v3.2.3 E09-B 的 Statement pending-interaction reservation、opaque single-use token 与 waiting-user continuation 生命周期。
- Context：本 restack 精确 base/初始 HEAD 为 `ddac924bba79fd920e85580bde9865b850ee9dff`；E09-A 已实现 dormant Statement Service import/session/revision、逐来源 template/source lineage 与真实 Service Control persistent adoption。旧 E09-B 三提交的历史 base 为 `04b6ca3f1e87c0ddcda4d709fbc95d4a39eba6ad`，只作为移植来源，不再是合同真值。
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
| 新 E09-A 对大账号 mapping 明确 blocked，但 import evidence 已冻结 `sessionOwner + templateCatalog + sources[].templateRef` 与逐来源 source identity | `import-contracts.js`、`source-identity.js`、E09-A parent/child/filename/duplicate tests | E09-B 只能 additive 扩展每个 catalog snapshot 的维护候选；draft/candidate/continuation 必须保留逐来源 lineage，不能退回单 template/sessionKey |

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

## E09-A Restack 适配（`ddac924b`）

| 发现 | 分类 | 旧 E09-B 风险 | 采用方案 | 验证 |
| --- | --- | --- | --- | --- |
| session owner 与 source template 不再等价 | PROBE | 用单一 `templateId/sessionKey` 构造 prompt/candidate 会覆盖 parent/child 与 filename mapping | prompt 使用 `sessionOwner`；每个 source 按 `templateRef` 取 catalog snapshot，entry 保存 exact ref/digest/matchedTemplateId | mixed direct + big-account parent session test |
| source identity 是 path + snapshot + layered identity 的组合 | PROBE | continuation 只比 path 可被 alias/TOCTOU/source mutation 绕过 | token private request保留完整 Worker-only identity；continuation token-first 校验 evidence 后重新解析并逐字段比较完整 identity，再重新映射/比 candidate digest | E09-A identity tests + E09-B token-first tamper/valid retry |
| future action wrong-action 必须在 payload/source I/O 前 fail fast | ASSUME（冻结合同） | 通用 import parser 会让 E09-C/D action误入 E09-B | 仅允许 import/resolve-big-account；其余 action在解析 payload、读文件、申请 resource 前拒绝 | E09-A unsupported-action test |

本次无新的用户选择 BLOCK。上述都是从 exact E09-A head 可直接取证的兼容修复；不改变 frozen E09-B public token、waiting-user 或资金合同。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 additive interaction/continuation exact contract 与 token registry | Renderer/Main bounded；choice/evidence不可篡改 | validator/hostile DTO/privacy tests | 公共边界不可信则不接 Service | 保留 E09-A blocked |
| 2 | 接真实 pending reservation FSM 与 TTL/release | grant/adopt-ack前不可见；single owner无泄漏 | 真实 Host/Governor trace、race/fake clock | 资源闭环不成立则停止 | 删除 Service issuance wiring |
| 3 | 接 big-account continuation重新读取/采用 | generation/revision/purpose/TTL/choice/template/source fail closed | stale/tamper/single-use/session revision tests | 资金输入边界不可信则不采用 | 保留 token 基础设施 dormant |
| 4 | 实现 Main waiting-user coordinator | 同 TaskRun/new job，phase/lock exact release/reacquire | ownership/late event/idempotency unit tests | 不接 live | 仅保留 contract tests |
| 5 | cancellation/crash/quit/invalidation与盲区复核 | 无 generalized stale ignore、无 lease/context泄漏 | fault/race/status/privacy tests | 保持 production false | 不扩大功能范围 |

## Ultra Review Repair Round (`88edf636`)

### Task Brief

- Goal：在同一 E09-B PR 内最小修复 Ultra Reviewer 已证明并由项目负责人接受的 `P1=5 / P2=1`。
- Context：repair base/parent 为 `88edf636306e8c1064cb5f0ad2885f1aff776df0`；六项均已有真实当前路径证据，不重开需求决策。
- Constraints：不泛化为未来 action，不接 Main/Renderer live、E09-C/D/E10，不修改 production gate、金额/币种/恢复语义；所有资源终态等待 exact release/release-ack。
- Done when：双 source safe-point cancel、oversize prompt pre-grant reject、token adoption-timeout、waiting-user cancel、零交易 repeated-header、phase cleanup-required 均有对应真实链路或精确 owner 测试，且旧证据无回归。

### Repair Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cancel 在 async draft/candidate 间隙如何禁止 post-terminal request | 状态/竞态 | 高 | 一般 | Reviewer 双 source trace；`beginJob` await 后缺统一终态检查 | PROBE | real Supervisor/Host/Worker cancel at source safe-point | consume 后立即绑定 owner；每个 await 与 request 前统一 assert active |
| public DTO ceiling 应在哪个原子点验证 | 资源/隐私 | 高 | 容易 | 最终 projection 仅在 adopt-ack 构造 | PROBE | 600 maintained accounts + temp XLSX | `prepare` 阶段用 draft token fields 构造最终 public projection，request 前拒绝 |
| token adoption-timeout completion 所有者 | 状态/资源 | 高 | 一般 | revoke path 给 inserted token 走 generic token branch，未保存 terminal completion | PROBE | real Host adoption timer + withholdAdopt | matching active inserted token 记录 timeout completion，release-ack 唯一 error |
| waiting-user cancel 是否可不关闭 generation | 公共契约/ownership | 高 | 一般 | 当前只有 job cancel 与 coordinator invalidate | PROBE | issued→waiting→duplicate cancel + retry | 新增 exact bounded token identity 的 cancel job；Worker 校验并 release/ack 后 done，coordinator ack 后 cancelled |
| repeated-header 零交易的最早拒绝点 | 资金/行数守恒 | 高 | 容易 | legacy `NO_TRANSACTION_DATA`；当前 draft 仍为 empty block 发 token | PROBE | real fixed-mode all-empty/all-zero Worker | provisional `rows.length===0` 时 resource/token/session mutation 前 fail closed |
| phase acquire 补偿失败如何恢复 | ownership/幂等 | 中 | 容易 | catch 无条件重置 waiting-user | PROBE | release 第一次失败、第二次成功 fake owner | 保留 cleanup-required + exact lock/job/首错；同 owner 仅先重试 cleanup |

### Repair 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | safe-point cancel 与 token owner 绑定 | terminal 后零 request、consuming token不泄漏 | initial/continuation双 source真实链路 | 若失败不得继续资源修复 | 保留旧同步路径并撤销异步改动 |
| 2 | prompt preflight 与 adoption-timeout terminal | grant 前有界；grant 后异常必回收且终结 | oversize/Host timer probes | 资源泄漏则不提交 | 将校验收缩至 E09-B big-account |
| 3 | cancel-interaction 原语 | 不以关闭 generation 代偿 token cancel | duplicate/retry/base+persistent保留 | Task cancel不可信 | 保持 dormant、不接 live |
| 4 | 零交易与 cleanup-required | 零输出可见；owner cleanup不盲重获 | repeated-header + fake owner tests | 资金/锁红线未关闭 | fail closed 保持旧 token 不采用 |
| 5 | 全量定向验证与两类 blindspot pass | production/资金/恢复边界不漂移 | unit/integration/lint/check | 不提交 | 回退本修复轮 commit |
