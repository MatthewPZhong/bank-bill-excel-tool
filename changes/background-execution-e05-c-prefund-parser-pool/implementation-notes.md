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
| repair不进入并行planner。 | 冻结合同childrenMax=1，repair有更强恢复/人工边界。 | 与普通import共享Pool。 | repair行为与E05-B不变。 |
| production policy在E05-C保持disabled。 | 交替single/pool顺序后的代表集五次中位数仅改善0.12%，且RSS/磁盘/event-loop、Windows、真实资金/恢复门禁尚未qualified。 | benchmark自动改开关。 | capability可评测，但用户路径仍legacy。 |
| runtime resource plan与PreFund topology planner共享同一host-safe预算。 | Governor只支持requested→1，若planner只看CPU/fileCount，实际可容纳2/3时会不必要降1。 | 一律请求4交给Governor；planner与runtime各算一份。 | 静态planner先按CPU/memory/worker/IO收敛4/3/2/1，Governor只处理同进程竞争。 |
| Coordinator使用覆盖in-flight与ready的原子permit。 | 旧`waitForDispatchCapacity()`可被并发Parser同时穿透；file0 straggler会放大spool。 | 无界Promise.all；只统计ready count。 | permit在派发前预留，Writer开始消费或fatal/cancel时exactly once释放。 |
| job-start磁盘估算采用source总量5倍+64MiB固定余量+每file 1MiB。 | NDJSON规范化spool可大于source，且估算只应作为保守admission。 | source 1:1估算；把估算写入业务/恢复证据。 | 不足时runtime/Parser/Writer均不启动；实际磁盘满仍由现有spool/事务合同fail closed。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `os.availableParallelism()`可作为同步host CPU上限；不可用时保守为1。 | Node 22运行时与纯planner可注入。 | 仅降低并发，不影响业务正确性。 | 纯函数矩阵；fallback到single。 |
| source byte size可用于保守spool admission估算，但不是业务evidence。 | spool保存规范化数据，精确占用只有运行后可知。 | 可能保守拒绝，不得形成资损。 | injectable estimator与ENOSPC路径；后续benchmark记录实际disk。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 建议count主要按`availableParallelism-1`与`floor(fileCount/2)`规划。 | 额外把runtime memory/worker/IO预算纳入同源上限。 | Governor不支持4→3→2；只看CPU会在中等内存主机从4直接降1。 | 不改变Spec的max4/低内存single语义，只减少不必要退化。 | 不需要，属于TechDoc资源合同的实现细化。 |
| 性能门禁预期通过后再评估production。 | 消除固定single先跑的热缓存顺序偏置后，代表集五次中位数改善0.12%，未达15%；资源/平台门禁也未qualified。 | capability与业务parity仍保留，但production继续legacy并记录downgrade。 | 用户路径零变化；后续若优化Parser/Writer瓶颈必须重跑完整门禁。 | 不需要，符合冻结gate。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 预检代码/合同取证 | PASS | topology seam、Governor downgrade、Coordinator并发穿透风险与false production gate已定位。 |
| `node --test tests/unit/main-process/background-execution/*.test.js ...mpt-import-e05-{a,b,c}.test.js ...mpt-mixed-lifecycle-e05-p0.test.js` | 444/444 PASS | 平台回归、E05-P0/A/B合同、topology 4/3/2/1、Governor downgrade、permit/straggler、disk、真实Pool/Writer/receipt、crash/cancel/cleanup。 |
| 真实8-file managed import | PASS | OS Parser overlap >1；Writer critical/receipt严格0..7；8条唯一insert receipt；Side DB业务行与独立legacy库逐字段一致。 |
| 真实Pool单Parser transport crash | PASS | 当前file失败、后续7 file继续；Side DB仅7条receipt/7行业务数据；失败file无receipt。 |
| Writer transport interruption fault | PASS | 4个active Parser全部取消并等待clean exit；8个Main-owned file各清理一次，无Writer-owned误删。 |
| `background-execution-pure-compute-canary.js` / `background-execution-recovery-canary.js` | 9/9 + 9/9 PASS | native平台与durable recovery canary无回归。 |
| `pre-fund-reconciliation-side-db-parity.js` / `pre-fund-reconciliation-output-contract.js` | 69/69 + 15/15 PASS | Side DB与输出业务合同无回归。 |
| `npm run benchmark:prefund-parser-pool` | 5-run/mode/case evidence generated；DOWNGRADE | 每个runIndex交替single/pool先后顺序；representative single/pool median 584.378/583.695ms（+0.12%）；small 391.265/265.027ms（+32.26%，即回退-32.26%）；业务摘要parity。代表集pool RSS absolute/delta中位数269418496/18071552 bytes、spool 9906933 bytes、event-loop p99 47.022ms；资源仅本机记录，均未qualified。 |
| benchmark方法收紧后的首轮与复验 | 首轮命令在完成大部分样本后仅报`PREFUND_POOL_BENCHMARK_ERROR=Error`且未产出可采信结论；随后诊断完整跑与两次标准命令完整通过，最终证据取最后一次标准命令 | 不以瞬时失败或较优中间样本替换最终证据；脚本已为结果不完整/Parser未退出增加稳定错误码，保留该可复现性未知。 |
| affected ESLint / node --check / git diff --check | PASS | 变更文件静态质量、语法与whitespace。 |

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
- 事实与证据：真实Parser crash继续后续；真实Supervisor Writer中断取消4个active Parser并等待exit；Main-owned 8 files各清理一次；E05-B unknown/receipt/Hold测试保持通过。
- 推断/未知：Windows文件锁/fsync/rename仍未在packaged环境验证。
- 资损或审计影响：误删unknown evidence会破坏Inspector/Hold，漏清理会放大磁盘占用。
- 最便宜验证：Windows packaged fault matrix。
- 处置：PROBE（后续release gate），当前production=false。

### [Important] 容量估算与隐私
- 场景：spool大于source、估算溢出、空间不足或错误文本泄露本地路径。
- 事实与证据：BigInt溢出安全估算；空间不足在runtime.start前失败；错误不含source/staging路径；benchmark记录实际spool峰值。
- 推断/未知：5倍放大是保守admission，不是所有真实文件的精确上界。
- 资损或审计影响：保守拒绝影响可用性但不改变资金事实；低估仍由现有spool/事务fail closed。
- 最便宜验证：扩大真实脱敏格式样本的source/spool倍率分布。
- 处置：ASSUME（可回滚调参），不得作为业务或恢复证据。

## Remaining unknowns

- BLOCK（production，Release owner）：GitHub-hosted Windows packaged结果与真实脱敏资金/恢复人工复核。
- PROBE（Performance owner）：代表集改善仅0.12%，需定位Single Writer/Worker startup瓶颈与benchmark首轮瞬时失败原因并重跑隔离进程门禁；本PR结论固定为downgrade/production disabled。
