# v3.2.1 E05-C Unknowns Preflight

## Task Brief

- Goal：在 E05-B 单 Writer 与每文件 durable receipt 之上，为普通 PreFund MPT import 增加最多 4 个 Parser 的有界 Pool；Parser 可乱序完成，但 Writer 仍按 fileIndex 单飞提交。
- Context：精确基线为已审查 E05-B `ed936addb7e97960a004ce739c35695afccbf01a`；E05-B 已具备 one-parent/one-Writer、per-file Critical Intent/receipt/Inspector/Hold，当前 Main 仍逐文件启动一个 Parser。
- Constraints：repair 必须 exactly 1 Parser；所有 Parser 与唯一 Writer 必须计入同一 CompoundLease；ready/in-flight spool 总量有界；job start 前估算 spool 空间；低内存降级 single；业务金额、币种、identity、sequence、replacement、batch.id、dataset version、repair token、候选顺序与 mixed-result mapping 不变；`production.enabled=false`；不运行 release-check/check-vars/scan:vars。
- Done when：原生 Supervisor 在 admission 前冻结真实 Parser topology，managed import 只按获批数量派发；低 fileIndex 慢、乱序结束、Parser crash、parent cancel、disk insufficient 与 Writer 中断均有有界、exactly-once cleanup 证据；结果与 single/legacy 等长同序且业务/receipt parity；五次 benchmark 产生可复现性能/RSS/磁盘/event-loop 报告，但不会自动启用 production。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 Spec 明确 Parser Pool → per-file spool → Ordered Coordinator → Single Writer，requested max 4，ready spool 高水位、job-start 空间估算、低内存降级 single。 | `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.1/spec.md` §5、§7-§9；TechDoc §12、§14。 | 不能用多 Writer、无界 Promise.all 或仅统计 ready 后的瞬时数量替代。 |
| import policy 已声明 `thread-pool`、max 4、minUnitsPerWorker 2、CompoundLease childrenMax 4；repair 声明 childrenMax 1。 | `mpt-import/policies.js`。 | import topology 必须由冻结 planner/topology binding得出；repair不能共享并行分支。 |
| policy registry 已把 `resources.compound.topologyKey` 作为静态 runtime binding 冻结，但 native Supervisor 当前只读取 existing-dispatch adapter inspector，否则回退 `production.effectiveWorkerCount || 1`。 | `execution-policy-registry.js`、`supervisor.js::freezeTopology()`。 | 补窄平台 seam：native 必须使用冻结 topology binding；不能改 production flag来偷传并发数。 |
| ResourceGovernor 只会按请求数获批，或在 `downgrade-to-single` 下直接降为 1，并把实际 count 写入 lease。 | `resource-governor.js::acquireCompoundLease()`。 | topology planner先计算 host/file-safe count；Governor处理内存/并发压力降级，Main必须消费获批后的实际 count。 |
| E05-B control snapshot 不暴露 topology/workerCount；runtime budget固定为2 CPU、3 Worker、2 IO，只能容纳 Writer + 1 Parser。 | `supervisor.js` control snapshot；`background-execution/runtime.js`。 | 获批 count 必须在 `ready` 后只读可见；runtime budget需与 Writer + planned Parser 真实拓扑一致，不能只改调度循环。 |
| Ordered Coordinator 的 `waitForDispatchCapacity()` 只观察 ready count，不预留并发 permit；多个 Parser 同时通过会超额。 | `ordered-coordinator.js`。 | E05-C必须对 in-flight + ready-but-not-consumed 建原子有界 permit，或等价reservation；Writer开始消费/Parser error时准确释放。 |
| `runParserWorker()` 已等待 Worker clean exit并支持 AbortSignal；E05-B只为当前 Parser建单个 controller。 | `managed-import.js`。 | Pool需父级 AbortController/active barrier；parent terminal 后取消全部 Parser并等待全部 exit，再清理Main-owned spool。 |
| source snapshot在创建每文件 descriptor时已冻结，spool与Writer有严格hash/count/source revalidation。 | E05-A spool contract与E05-B managed import。 | 空间估算只能决定 admission，不能成为业务真相或恢复状态；磁盘满仍由现有事务/receipt边界 fail closed。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| native immutable topology如何在admission前计算。 | 平台 seam | 高 | 一般 | topologyRegistry已冻结但Supervisor未消费。 | PROBE | 为native action注入纯同步planner，断言mutation-after-freeze无效。 | 复用`resources.compound.topologyKey` binding；exact返回`{ effectiveChildCount }`。 |
| host-safe requested count如何计算。 | 资源 | 高 | 容易 | policy max4/minUnitsPerWorker2；Writer占1 CPU；`os.availableParallelism()`可用；Governor只支持requested→1。 | PROBE | 1..N文件、1/2/4/8核与memory预算纯函数矩阵。 | runtime与planner共享host-safe CPU/memory/worker/IO预算，先收敛4/3/2/1；repair固定1。 |
| Governor降级后的实际count如何交给scheduler。 | 资源/状态 | 高 | 容易 | lease count已写入record.metrics/topology，但control不暴露。 | PROBE | request4但budget只容纳single，ready后snapshot=1且Parser max overlap=1。 | control snapshot只读暴露获批`topology.effectiveChildCount`；scheduler不再自行猜数或泛化为workerCount。 |
| high-water是否同时约束in-flight与ready spool。 | 磁盘/背压 | 高 | 一般 | 当前wait-only接口并发时可穿透。 | PROBE | file0阻塞、后续秒成，记录active+buffered最大值。 | 使用有界permit覆盖“已派发未开始Writer消费”的单位；release必须exactly once。 |
| parent终止时Pool是否无残留Worker/spool。 | 生命周期 | 高 | 一般 | 单Parser路径已有abort+clean exit。 | PROBE | 多Worker active时shutdown、Writer precritical/unknown终止与result-then-crash。 | 一个父AbortController取消全部active Parser，`allSettled`作为cleanup barrier；不清理Writer-owned或unknown evidence。 |
| job-start spool空间估算的口径和余量。 | 容量 | 高 | 容易 | 输入source size可读；`fs.statfsSync`提供free blocks。 | PROBE | injectable free-space/size纯函数与ENOSPC fault。 | 对所有source snapshot size做溢出安全求和并加固定/比例余量；不足时Parser/Writer均不启动，错误不含路径。 |
| Pool性能是否达到production门禁。 | 性能 | 高 | 容易 | 冻结门禁要求5-run median ≥15%、small regression ≤5%、RSS/磁盘合格。 | PROBE | 同机single/pool五次代表集+small报告。 | 只记录证据；任何缺项/不达标时production保持false，不以单次结果启用。 |
| Windows与真实资金样本是否通过。 | 外部人工门禁 | 高 | 容易 | 本地非Windows与合成fixture不能证明。 | BLOCK（production） | 后续packaged Windows与脱敏真实样本人工复核。 | 不阻断false-gated capability PR；明确阻断production enablement。 |

## BLOCK 问题

当前实现阶段无用户决策 BLOCK。Windows packaged、真实资金/恢复样本与production签字是后续启用门禁，不允许由本PR自动声称通过。

## 保守假设

- import Pool只使用获批count；fileCount小于4或host资源不足时自然收敛，绝不为了“看起来并行”超卖lease。
- ready/in-flight permit是资源上界，不改变输入顺序、结果顺序或Writer事务顺序。
- benchmark脚本/报告不写production policy；E05-C即使收益不足也保留可测试的false-gated capability与明确downgrade证据。
- E05-C不改receipt schema、Critical Intent、Inspector、Recovery Hold、TaskLifecycle或公开结果shape。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 实现纯topology planner、冻结registry binding与Supervisor只读admitted count。 | lease与真实Parser并发一致；repair=1。 | registry/Supervisor/Governor矩阵。 | 资源合同不成立，停止Pool接线。 | native默认1保持兼容，production仍false。 |
| 2 | 实现job-start磁盘估算与并发permit。 | 不在空间不足时半启动；in-flight+ready有界。 | ENOSPC、straggler、高水位exact计数。 | 磁盘放大或伪成功。 | admission前fail closed；回到single。 |
| 3 | 把managed import改为获批数量的Parser Pool。 | 乱序Parser、单Writer递增、结果同序。 | real Worker overlap、high/low sequence、single/pool parity。 | 资金顺序或mixed结果漂移。 | scheduler count锁1。 |
| 4 | 补parent cancel/crash/cleanup fault matrix。 | 全部Worker有界退出；Main/Writer ownership exactly once。 | active shutdown、Writer中断、Parser crash、cleanup injection。 | 泄漏或误删恢复证据。 | production保持legacy。 |
| 5 | 五次benchmark与盲区/资金复核。 | 性能/RSS/磁盘/event-loop证据，不伪启用。 | reproducible JSON/Markdown报告、定向tests、ESLint、syntax、diff-check。 | 不满足production门禁。 | 记录downgrade，保持false。 |
