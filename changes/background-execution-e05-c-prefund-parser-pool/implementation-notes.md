# v3.2.1 E05-C Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.1 Spec §5-§11、TechDoc §5-§15 与 E05-B durable single-Writer 合同。
- Exact base：`ed936addb7e97960a004ce739c35695afccbf01a`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：普通 import 的 Parser Pool、CompoundLease、背压、磁盘 admission、取消/清理与 single/legacy parity 都有可复现证据；repair仍exactly one；production保持false。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 通过冻结`topologyRegistry` binding为native Supervisor提供同步topology。 | policy已声明静态topologyKey，当前缺口只是Supervisor未消费binding。 | 改production.effectiveWorkerCount；把count放进可变request。 | topology在admission前不可变并可被CompoundLease审计。 |
| scheduler只使用Governor实际获批count。 | low-memory可从requested降到single。 | scheduler重复计算或仍按requested派发。 | lease与真实Worker overlap严格一致。 |
| 全局Governor预算恢复E00统一platform factory。 | E00冻结`cpu=max(1,min(4,p-2))`、`worker=cpu+1`、`utility=1`、`io=2`以及`freemem-reserve`内存公式；真实Writer/Parser各占1 IO。 | PreFund按期望Pool反向构造更大runtime预算；把真实IO资源伪报0。 | native requested4当前诚实降级为实际1；Pool能力只通过显式non-production runtime注入隔离Governor，标准factory拒绝override、barrel不导出harness、`production:true`在admission前拒绝，因此不构成或绕过production资源证据。 |
| repair不进入并行planner。 | 冻结合同childrenMax=1，repair有更强恢复/人工边界。 | 与普通import共享Pool。 | repair行为与E05-B不变。 |
| production policy在E05-C保持disabled。 | 显式隔离Governor、交替single/pool顺序后的代表集五次中位数仅改善0.57%；native资源、RSS/磁盘/event-loop、Windows、真实资金/恢复门禁均未qualified。 | benchmark自动改开关；把隔离Governor结果冒充native资源通过。 | capability可评测，但用户路径仍legacy，resource gate明确FAIL。 |
| `control.ready`后先验证权威`state==='running'`与合法topology。 | Supervisor的pre-running cancel/timeout/spawn/init failure也会resolve ready，但parent cleanup/lease release在后续settle链；running snapshot若暴露非法Parser count也不能绕过同一terminal barrier。 | ready一开就构造Parser；从requested metrics猜count；非法topology直接throw并遗留parent lease。 | 非running先await parent authoritative terminal；running但非法topology先以明确原因cancel再await同一barrier，之后才抛原稳定错误。admission cancel/Writer spawn/非法topology均为Parser constructor 0、无spool。 |
| Coordinator使用覆盖in-flight与ready的原子permit。 | 旧`waitForDispatchCapacity()`可被并发Parser同时穿透；file0 straggler会放大spool。 | 无界Promise.all；只统计ready count。 | permit在派发前预留，Writer开始消费或fatal/cancel时exactly once释放。 |
| job-start磁盘估算采用regular source总量5倍+64MiB固定余量+每file 1MiB；null snapshot贡献0。 | NDJSON规范化spool可大于source；symlink/非普通文件的`lstat` snapshot为null且不能裸解引用；估算只应作为保守admission。 | source 1:1估算；整批TypeError；把估算写入业务/恢复证据。 | 不足时runtime/Parser/Writer均不启动；valid+symlink+valid仍由Parser逐file形成ok/failed/ok且不解引用/泄路径；实际磁盘满仍由现有spool/事务合同fail closed。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `os.availableParallelism()`可作为同步host CPU上限；不可用时保守为1。 | Node 22运行时与纯planner可注入。 | 仅降低并发，不影响业务正确性。 | 纯函数矩阵；fallback到single。 |
| source byte size可用于保守spool admission估算，但不是业务evidence。 | spool保存规范化数据，精确占用只有运行后可知。 | 可能保守拒绝，不得形成资损。 | injectable estimator与ENOSPC路径；后续benchmark记录实际disk。 |
| E00 release尚未冻结memory hard ceiling/system reserve数值，统一factory暂沿用既有兼容值。 | hard ceiling复用E05-B基线`max(768MiB,totalmem/4)`；reserve复用`src/main.js`与big-table pipeline既有2GiB freemem gate；E00/E02-B仍把release数值列为PROBE。 | 兼容值可能过保守，只影响admission/可用性，不改变业务或恢复事实；没有引入新的4GiB/1GiB猜测阈值。 | factory支持显式注入并覆盖0/ceiling/reserve矩阵；production enable前由Release owner冻结配置。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 初版把PreFund host-safe topology与runtime budget同源扩到Writer+4 Parser。 | 终审后恢复E00全局platform factory；planner只形成requested topology，native Governor按真实Writer/Parser IO预算把requested4降1；受信control获批>1的scheduler能力改用显式隔离Governor。 | action不能为自身并发目标扩大全局平台预算；E00 IO=2无法同时容纳Writer+多个Parser。 | 删除host-safe4/native4 claim；当前native有效Parser=1，Pool仍false-gated可测，resource gate FAIL。 | 不需要，纠正实现回到E00冻结合同。 |
| 性能门禁预期通过后再评估production。 | 消除固定single先跑的热缓存顺序偏置并显式隔离资源harness后，代表集五次中位数改善0.57%，未达15%；native资源/平台门禁也未qualified。 | capability与业务parity仍保留，但production继续legacy并记录downgrade。 | 用户路径零变化；后续若优化Parser/Writer瓶颈必须重跑完整native资源与性能门禁。 | 不需要，符合冻结gate。 |
| 初版Writer interruption测试在`job:start`后退出并把8个file都视为Main-owned。 | 终审确认它没有进入`unit:start`，不能证明dispatch ownership；替换为file0真实spool→实际`unit:start`/dispatchAccepted→pre-critical transport exit，其余4个active Parser取消并等待barrier。 | 保留全hanging用例并声称覆盖Writer-owned；重复E05-B critical/unknown完整恢复case。 | E05-C精确证明Supervisor把已dispatch但未critical的file0明确交还Main且8个Main-owned各清一次；critical/unknown Writer-owned边界继续由E05-B恢复/Hold合同覆盖。 | 不需要，修正测试证据范围，不改变产品合同。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 预检代码/合同取证 | PASS | topology seam、Governor downgrade、Coordinator并发穿透风险与false production gate已定位。 |
| E05-C专属：`node --test .../mpt-import-e05-c.test.js` | 15/15 PASS | E00 factory 4/3/2/1与memory边界/兼容默认、requested topology、native实际1、隔离Governor production拒绝与Pool/downgrade/repair1、permit/straggler、disk/symlink、admission cancel、spawn failure、running+invalid topology cancel/terminal barrier、Pool/Writer/cancel/cleanup。 |
| E05-B：`node --test .../mpt-import-e05-b.test.js` | 38/38 PASS | 真实OS Parser Pool+Single Writer/Side DB receipt parity、Parser transport crash继续、Writer critical/receipt/Inspector/Hold与cleanup合同。 |
| E05-A + mixed lifecycle | 46/46 PASS | spool/source fail-closed、Coordinator既有P0 permit迁移、legacy/managed repair token与mixed-result合同。 |
| policy registry + ResourceGovernor + Supervisor + packaged runner/request | 127/127 PASS | registry receiver冻结、native admission/lease释放、queued cancel、spawn/transport cleanup与packaged canary相邻平台合同。 |
| 全background-execution + E05-A/B/C/mixed + Toolbox组合矩阵 | 697/697 PASS | 全局E00 budget factory对既有平台/Toolbox合同无回归；E05-C fault matrix与E05-B资金边界在同一进程组合执行稳定。 |
| 真实8-file managed import | PASS | OS Parser overlap >1；Writer critical/receipt严格0..7；8条唯一insert receipt；Side DB业务行与独立legacy库逐字段一致。 |
| 真实Pool单Parser transport crash | PASS | 当前file失败、后续7 file继续；Side DB仅7条receipt/7行业务数据；失败file无receipt。 |
| Writer transport interruption mixed-ownership fault | PASS | file0先形成真实ready spool并实际发送`unit:start`，dispatchAccepted后pre-critical transport exit由Supervisor以`cleanupOwnership=main`明确交回；其余4个active Parser全部取消并等待clean exit barrier，随后8个权威Main-owned file各清理一次。critical/unknown Writer-owned保留由E05-B既有恢复/Hold合同覆盖，本用例不重复声称直接证明。 |
| E05-C mixed-ownership fault稳定性复跑 | 连续5轮均10/10 PASS | 触发序列不依赖固定延时：Writer退出只在file0实际dispatch且4个其余Parser active时安排，锁定dispatchAccepted/pre-critical/clean barrier边界。 |
| `background-execution-pure-compute-canary.js` / `background-execution-recovery-canary.js` | 9/9 + 9/9 PASS | native平台与durable recovery canary无回归。 |
| `background-execution-recovery-control.js` | 27/27 PASS | RecoveryControl transition/ownership集成合同无回归。 |
| `pre-fund-reconciliation-side-db-parity.js` / `pre-fund-reconciliation-output-contract.js` | 69/69 + 15/15 PASS | Side DB与输出业务合同无回归。 |
| `node scripts/benchmark-prefund-parser-pool.js` | 5-run/mode/case evidence generated；DOWNGRADE / resource gate FAIL | single/pool同一真实端到端数据集，每个runIndex交替先后；显式隔离Governor预算为CPU5/Worker6/Utility1/IO5/2GiB，使single实际1、pool实际4，但不冒充native admission。representative median 591.665/588.272ms（+0.57%，未达15%）；small 402.967/269.813ms（+33.04%，无回退）；业务摘要parity。代表集pool RSS absolute/delta中位数249069568/13795328 bytes、spool 9906933 bytes、event-loop p99 43.778ms；native resource、RSS/disk/event-loop均未qualified。 |
| affected ESLint / node --check / git diff --check | PASS | 9个changed/new JS的静态质量与语法、完整diff whitespace均通过。 |

## Reconciliation Blindspot Pass

### [Critical] 并行解析不得改变业务identity、顺序、金额币种或幂等范围
- 场景：Parser乱序完成或单个transport crash后，Writer仍需按fileIndex唯一提交。
- 事实与证据：Parser Core/Writer业务代码未改；真实8-file Pool与独立legacy Side DB逐字段parity；critical/receipt顺序0..7且每file唯一；crash file无receipt、后续7条继续。
- 推断/未知：合成样本覆盖USD/EUR与稳定identity，但不能替代真实脱敏资金样本人工核对。
- 资损或审计影响：若顺序或receipt漂移会导致replacement/batch/dataset错误或重复/漏记。
- 最便宜验证：已完成自动化；production enable前对真实脱敏insert/noop/replacement/mixed-result样本人工复核。
- 处置：自动化已覆盖；⚠️ 资金红线，请人工复核 production enablement。

### [Important] 部分失败、取消与cleanup ownership
- 场景：Parser crash、Writer中断或parent shutdown时可能误删Writer evidence或遗留Main spool。
- 事实与证据：真实Parser crash继续后续；E05-C file0真实spool实际dispatch后在pre-critical退出，Supervisor明确交回Main，另4个active Parser取消并等待barrier，8个权威Main-owned各清一次；running但非法topology会先cancel并等待parent terminal/CompoundLease barrier，且Parser constructor与spool均为0；critical/unknown Writer-owned evidence由E05-B既有unknown/receipt/Hold合同保护，本E05-C用例不直接重复该边界。
- 推断/未知：Windows文件锁/fsync/rename仍未在packaged环境验证。
- 资损或审计影响：误删unknown evidence会破坏Inspector/Hold，漏清理会放大磁盘占用。
- 最便宜验证：Windows packaged fault matrix。
- 处置：PROBE（后续release gate），当前production=false。

### [Important] 容量估算与隐私
- 场景：spool大于source、估算溢出、空间不足或错误文本泄露本地路径。
- 事实与证据：BigInt溢出安全估算；空间不足在runtime.start前失败；null snapshot计0且valid+symlink+valid形成ok/failed/ok；错误不含source/staging/target路径；benchmark记录实际spool峰值。
- 推断/未知：5倍放大是保守admission，不是所有真实文件的精确上界。
- 资损或审计影响：保守拒绝影响可用性但不改变资金事实；低估仍由现有spool/事务fail closed。
- 最便宜验证：扩大真实脱敏格式样本的source/spool倍率分布。
- 处置：ASSUME（可回滚调参），不得作为业务或恢复证据。

## Remaining unknowns

- BLOCK（production，Release owner）：GitHub-hosted Windows packaged结果与真实脱敏资金/恢复人工复核。
- PROBE（Release owner）：E00 memory hard ceiling/system reserve的release数值仍未冻结；当前沿用E05-B hard ceiling与既有2GiB freemem gate只为兼容，production enable前必须由release benchmark配置化并复核。
- PROBE（Performance owner）：隔离Governor代表集改善仅0.57%，需定位Single Writer/Worker startup瓶颈并重跑native资源/隔离进程完整门禁；本PR结论固定为downgrade/resource gate FAIL/production disabled。
