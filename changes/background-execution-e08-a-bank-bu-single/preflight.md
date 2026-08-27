# E08-A BankBU Single One-shot Jobs Unknowns Preflight

## Task Brief

- Goal：为 `bank-bu:import-month`、`bank-bu:run`、`bank-bu:export-single`、`bank-bu:export-aggregate` 建立 production-false 的 one-shot Worker capability，并完成 side/main identity 与恢复合同。
- Context：exact base `29dc9741f60acb1dba30cada1ce58bdaf5068731`；权威合同为 v3.2.2 Spec/TechDoc、Platform Contract v1、Lifecycle Mapping 与 implementation sequence。
- Constraints：仅 E08-A single Worker；不实现 E08-B dual parser；不接 live IPC/production；不改变 BankBU 1:1/1:N/N:1/N:M、BU/账号归一、月份、对外 runId 或 Excel sheet 语义；禁止 release-check/check-vars/scan-vars、依赖变更和远端操作。
- Done when：import 两 reader 全成功后才以固定 Pending→Bank 顺序在单事务覆盖 side 数据并写 dataset evidence/receipt；run 在 critical ACK 前持久化旧 mirror pre-image，side run/receipt 先提交，Main mirror 以同 operationKey+sideRunId CAS 提交；Inspector 唯一判定四态，partial 仅 complete-mirror；export staging/Publisher 边界与 dual-source 语义可验证；定向崩溃、重启、CAS、顺序和资金守恒测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| BankBU 既有 inline import 已先读 Pending、再读 Bank，随后调用月侧库原子覆盖 | `src/main.js` BankBU import handler；`bank-bu-recon-run-data.js#importMonth` | Worker single 路径复用两个 reader；任一 reader失败时不得打开写事务 |
| 既有 `importMonthAtomic` 的事务顺序固定为 clear pending/bank/runs → insert pending → insert bank | `src/backend/bank-bu-recon-db/month-repository.js` | E08-A 只扩展 dataset evidence/receipt，不改变角色与物理行顺序 |
| BankBU side receipt schema/repository 已由 E06-P0 建立，但 live writer 未调用 | `run-data-store.js#SIDE_DB_DDL_BANK_BU`；`bank-bu-worker/operation-receipt-repository.js` | 复用冻结 receipt 字段；receipt 必须进入真实 side mutation事务 |
| 既有 run 在 side insertRun 后无条件 delete+insert Main mirror，且两侧没有共同 identity | `bank-bu-recon-run-data.js#runViaSideDb/#upsertMainRunMirror` | 新 managed 路径必须独立实现 side-first 与 bounded pre-image CAS；legacy 路径保留 |
| 对外 runId 是 Main mirror id，sideRunId 只属于月侧库命名空间 | `rules/important-variables.md` per-月侧库条目；`bank-bu-recon-run-data.js` | Worker result和mirror必须同时保留 sideRunId；公开结果只返回 mirrorId |
| 既有 export 是 dual-source 重算，aggregate 按月升序并返回 included/skipped | `bank-bu-recon-run-data.js#loadExportDataByRun/#aggregateExportData` | Worker staging生成必须复用这些读语义，不从 receipt 猜业务结果 |
| Platform 对 partial/unknown 禁止算法重跑，并要求 interrupted/Hold | Platform Contract §7、Lifecycle Mapping §3/§10 | complete-mirror只能读取已提交 side run/receipt，CAS冲突返回 unknown |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 旧 side DB 缺 dataset/identity 列如何升级 | schema兼容 | 高 | 一般 | `openSideDb` 对 BankBU 只执行 `CREATE IF NOT EXISTS` | PROBE | 用旧DDL真实临时SQLite再次open并检查列/数据 | 增加幂等 additive ensure；历史业务行不回填伪identity |
| import/run input evidence如何稳定 | identity | 高 | 一般 | reader保留 `_rowIndex` 和完整规范行；平台有RFC8785 canonicalizer | PROBE | 同输入重放hash相同、行序/月/角色变化hash不同 | import hash绑定月份、角色、文件SHA、行数与行canonical hash；run hash绑定当前 dataset evidence |
| Main 当前 mirror 存在多个同月行时如何处理 | 并发/兼容 | 高 | 一般 | managed旧路径通常delete后insert，但历史主库可能保留多run | PROBE | 合成0/1/2行镜像捕获与CAS | 多行不是唯一pre-image，fail closed为 identity conflict/unknown，不静默择最新 |
| complete-mirror如何避免重跑算法 | 恢复 | 高 | 困难 | side run只持久summary，足够构造Main轻量mirror | PROBE | 注入matching spy并在partial恢复断言0调用 | 从 receipt+side run读取post-image；不调用`runReconciliation` |
| export如何满足Main Publisher但不接live | artifact | 中 | 容易 | writer现可写指定路径，平台artifact result有staging manifest范式 | ASSUME | 临时staging生成、hash/readback、目标目录保持未写 | capability只生成staging manifest；Publisher接线留给后续production gate |
| Operation lock由谁持有 | 并发 | 高 | 一般 | Platform规定Main持有业务锁；本PR不接live IPC | ASSUME | coordinator要求caller注入`withOperationLock`，无锁拒绝 | E08-A提供Main coordinator seam并强制锁内capture/CAS；不创建第二套全局锁 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 建立 additive side/main schema 与 canonical identity helper | 旧库兼容、月份/行序/operation identity | 旧库升级探针、hash反例 | 推翻后续持久合同 | 保持production false，撤回新writer接入 |
| 2 | 实现 import/run 单事务与Main pre-image CAS | 原子覆盖、side-first、唯一mirror | transaction rollback、crash window、CAS测试 | 直接阻断E08-A mutation | 仅保留只读export capability |
| 3 | 实现只读Inspector与complete-mirror | partial不重跑、unknown Hold边界 | 四态矩阵、matching spy=0、并发冲突 | 阻断run capability | 保持legacy/production false |
| 4 | 实现one-shot host/policies/export staging | 协议、Task settle、artifact全有或全不发布 | protocol/worker/staging readback | 不影响既有live路径 | 不注册到live runtime |
| 5 | blindspot与资金盲区复核、定向验证 | shutdown/kill/row-count/金额币种/审计 | unit+integration+SQLite crash/restart+lint/check | 未关闭项留人工红线 | 不启用production |

## Unknowns Closure

| 原未知 | 结论 | 证据 |
| --- | --- | --- |
| 旧side DB升级 | 已关闭：additive ensure补列/表/partial unique index，不伪造历史identity | 旧DDL带业务run再次open测试 |
| import/run evidence | 已关闭：month+role+file SHA+完整行/row index/order canonical hash；run复用当前dataset hash | identity lineage单测与真实reader集成 |
| Main多mirror | 已关闭为fail-closed合同：不选择MAX，不删除历史 | capture 2行抛identity conflict；Inspector映射unknown |
| complete-mirror重跑风险 | 已关闭：恢复模块只读取side receipt/run summary并CAS，未导入算法 | partial/old/concurrent CAS测试 |
| export Publisher边界 | capability侧已关闭：stagingRoot内生成manifest、无正式路径/Publisher；live Main settle仍为production BLOCK | staging escape与XLSX readback测试 |
| operation lock归属 | 已关闭：Main注入唯一锁，coordinator单callback覆盖prepare→side→CAS | coordinator端到端锁测试 |

唯一保留BLOCK是Windows packaged/真实财务样本/人工恢复以及live FilePlan validator、Publisher journal、Task settle门禁；因此四个policy继续固定`production=false / legacy / 0`。

## Reviewer P1 Remediation Preflight

### Task Brief

- Goal：修复 mutation Worker 与现有 Supervisor 的 registered-unit 协议断层，以及 export managed identity 校验与业务读取之间的 WAL TOCTOU。
- Context：Reviewer 真实 Supervisor/worker_threads/SQLite 与双连接 WAL 复现分别得到 `PROTOCOL_UNKNOWN_UNIT` 和“旧 runId + 新 dataset Excel”。
- Constraints：只做 E08-A 最小修复；复用现有 singleton unit / worker-durable，不新造 job-level durable 平台；不接 live、不扩 E08-B、不改变 frozen policy 或资金算法。
- Done when：真实 Supervisor 能按 `job:start → unit:start → critical → side receipt → Main CAS settle → unit:done → job:done` 收口；single/aggregate 的 managed identity 与完整数据来自同一 side read snapshot，artifact 返回前身份变化会删 staging 并失败关闭。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| Supervisor 的 durable critical/receipt/unit done 都先按 `unitId` 查 registered unit | `background-execution/supervisor.js#unitForMessage/processMessage` | mutation host必须等待唯一`unit:start`并在所有unit事件携带同一unitId |
| Supervisor ACK body是`intentId + fileOperationKey`，不是yearMonth | `supervisor.js` critical ready分支 | Worker ACK校验必须绑定unit/operation key，不能要求私有yearMonth字段 |
| operation context已有taskRunId，但Supervisor durable callback只给file-batch传taskRunId | `supervisor.js`四个coordinator调用 | 最小修正共享取值，operation/file-batch均沿context taskRunId，不从Worker payload猜 |
| 现Main coordinator锁只存在于单次callback，尚无Supervisor四方法adapter | `bank-bu-worker/main-coordinator.js` | adapter须让同一个锁跨prepare/ACK、side COMMIT、Main CAS，并在失败检查后有界释放 |
| managed export身份检查和`loadExportDataByRun`各自open side DB | `bank-bu-worker/export-operation.js`、`bank-bu-recon-run-data.js` | 不能只做artifact后复核；算法读取本身必须与首次identity处于同一SQLite snapshot |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| singleton unit如何兼容未来role units | 协议边界 | 高 | 容易 | E08-A明确single，E08-B另PR | PROBE | 真实Supervisor只注册一个`operation:000000`，断言无role child | 当前只认唯一operation unit；不实现role planner/parser |
| 锁如何跨Supervisor分段callback | 生命周期 | 高 | 一般 | Supervisor依次await prepare/observe/settle | PROBE | deferred release gate +真实Worker端到端 | Main coordinator维护有界in-flight session，settle/inspection终态释放 |
| WAL snapshot后并发import如何处理 | 资金一致性 | 高 | 一般 | 同连接read transaction可固定旧视图，但artifact期间状态仍可变 | PROBE | 两连接在snapshot内提交新import | identity校验+算法同snapshot；artifact后fresh revalidation，不一致删artifact并失败 |
| aggregate是否需要跨月大锁 | 并发范围 | 高 | 困难 | 用户明确禁止跨月/全模块扩锁 | ASSUME | 每月独立snapshot+最终全选择集复核 | 不加锁；任一included identity或Main latest集合变化即整artifact失败 |

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | mutation host改singleton unit并补Supervisor operation taskRunId透传 | 平台unit ownership与task identity | 真Supervisor不再unknown unit且prepare=1 | 阻断mutation修复 | 保持production false，撤回host改动 |
| 2 | Main coordinator增加Supervisor adapter与跨阶段锁session | preimage/intent/side/Main/dual identity顺序 | 真实side/main DB与callback次序断言 | partial/Hold不可判 | 仅保留Inspector、不启用mutation |
| 3 | export改同连接read snapshot及artifact后fresh复核 | runId/dataset/Excel一致 | single/aggregate两连接WAL并发测试 | 资金输出可能错配 | staging失败关闭、零发布 |
| 4 | kill/reply-loss/Hold与全套回归 | 恢复/取消/旧路径不漂移 | Supervisor+SQLite、parity、smoke、lint/check | 保留人工BLOCK | 不改live/production |

## Reviewer Round2 P1 Remediation Preflight

### Task Brief

- Goal：使 BankBU run 严格满足 TechDoc §8.2 的 `side COMMIT → Main CAS → commit receipt with both identities`，不再等到 `unit:done` 才首次写 Main mirror。
- Context：Round2 真实时序证明 `observeReceipt` 仅持久 side receipt，`settleCommitted` 才调用 `settleRun()`；权威合同要求 receipt 被 Main 接受为 committed 前已有 matching side/Main 双身份。
- Constraints：只改 BankBU run coordinator 与定向测试；保持 Worker raw side receipt、Platform envelope/schema、import `main:null`、production=false/live/E08-B 边界不变。
- Done when：`observeReceipt` 在既有同月 locked session 内权威回读 side、幂等 CAS Main、构造并持久 `{side,main}`；`unit:done` 仅验证并 close/release；CAS 前丢回复可 partial 补 mirror，CAS 后任意丢失由 Inspector 判 committed 且 Hold=0。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| TechDoc冻结顺序是 side COMMIT → Main CAS → 双identity receipt | `changes/.../3.2.2/techdoc.md` §8.2 lines 237-248 | run 的 `markCriticalCommitted` 前必须完成Main CAS并携带mirrorId/operationKey/sideRunId/stableHash |
| Supervisor串行await `observeReceipt`，成功后才把unit标`committed`并处理后续`unit:done` | `background-execution/supervisor.js#processMessage` | CAS可安全前移到`observeReceipt`；无需修改协议或Worker event格式 |
| 当前locked session从prepare持续到settle/inspection | `bank-bu-worker/main-coordinator.js#openLockedSession/releaseSession` | 前移CAS仍在同一个同月operation lock内，不新增锁或扩大作用域 |
| `settleRun()` 的 CAS 对目标post-image幂等 | `mirror-repository.js#commitMirrorCas`与现有old/absent/replay测试 | CAS后callback失败可由Inspector按matching post-image判committed，不得再次运行算法 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CAS后`markCriticalCommitted`抛错时Supervisor是否进入Inspector | 生命周期 | 高 | 容易 | durable event chain将callback异常交给`failProtocol/finish`，acked unit会inspect | PROBE | callback在确认mirror存在后故意抛错，跑真实Supervisor | Inspector应判committed、close combined receipt、Hold=0 |
| `unit:done`如何证明不再首次CAS | 顺序/幂等 | 高 | 容易 | 当前CAS位于`settleSession` | PROBE | 在mark callback内断言mirror=1，并在close callback再次断言同一mirror identity | session缓存mirror/combined receipt；settle只校验result并close |
| import是否被combined receipt重构误伤 | 兼容 | 高 | 容易 | import无Main mirror且现有close receipt已为`main:null` | PROBE | direct import coordinator在mark与close两处断言`main:null` | observe import直接构造`{side,main:null}`，不调用settleRun |

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 先把正常run与import的mark callback断言收紧到combined receipt | 双identity持久边界、import兼容 | mark时mirror/receipt实时断言 | 阻断代码修改 | 保留旧测试并缩小到run coordinator |
| 2 | 将run CAS移入`observeReceipt`，session缓存mirror/combined receipt | TechDoc提交顺序、同锁CAS | intent→mark(mirror=1)→close(mirror=1)→done | 直接阻断Round2 | 撤回单函数改动，production仍false |
| 3 | 注入CAS前reply-loss、CAS后mark/response/unit-done loss | 四态Inspector、幂等与Hold边界 | partial补mirror；post-CAS committed/close/Hold=0；算法零重跑 | 阻断合并 | 不启用capability |
| 4 | focused/Supervisor/integration/parity/smoke与blindspot收口 | 旧协议、资金输出、生命周期不漂移 | 全部定向回归与static/diff check | 保留人工BLOCK | 不改live/production |

### Unknowns Closure

| 原未知 | 结论 | 证据 |
| --- | --- | --- |
| CAS后mark callback异常 | 已关闭：Supervisor进入Inspector，side+Main matching时判committed并以combined receipt关闭Intent，Hold=0 | 真实worker_threads中mark持久后抛错测试，side run保持1行 |
| `unit:done`是否仍承担首次CAS | 已关闭：CAS唯一发生在`observeReceipt`；settle只校验result/receipt/mirror后close/release | mark callback内mirror=1，close callback仍为同一mirror；unit-done丢失Inspector committed |
| import兼容 | 已关闭：import observe/mark/close始终为`{side,main:null}`，Main mirror保持0行 | import singleton coordinator定向测试 |
