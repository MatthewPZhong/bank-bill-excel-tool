# E12-C VCC dual Writer Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.4 Spec §7.2～§11、TechDoc §9～§14；精确 parent E12-B review-fix `fa71a2f65bd9540e8a000d4ff77e9a6ed8a812c1`。
- Initial plan：先冻结 exact ownership 与 1/2 shard contract，再接 admitted topology/child lifecycle，最后复用 Main full A/B/Join/Publisher 并完成故障注入、回归和性能/RSS probes。
- Done when：见同目录 `preflight.md`；production/legacy 不变，Windows 与资金人工门禁保留。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| Main 继续创建全量 generation descriptors/FilePlan 并做 full B/Join/Publisher；parent Writer 只负责分片调度与 shard result merge。 | E12-A 已冻结 Main authority；TechDoc §10 明确 Main Join。 | child 自己分配路径或发布；parent 代替 Main 读 full B。 | 并行只改变 staging generation 拓扑，不改变资金/发布合同。 |
| shard planner 输出稳定 contiguous balanced 1/2 partition，subjectIndex 是唯一 owner key。 | 冻结合同要求 deterministic unique coverage；连续分片减少审计歧义。 | round-robin；按 subject 名 hash；动态 work stealing。 | 完成顺序不影响 merge，planner 可纯函数完整测试。 |
| topology 只由 runtime 静态 binding + CompoundLease admission 决定，caller input 不拥有 worker count。 | Platform Contract 禁止运行期扩大拓扑；Supervisor 已冻结/admit topology。 | 从 export options/input 接受 `workerCount`。 | 防止绕过资源预算和 production gate。 |
| parent coordinator 只占 policy base；phase 归零，Writer 资源只按 exact compound children 计入，childrenMax/requestedMax 收窄为 2。 | 集成 probe 证明旧 `phase Writer + N children` 在平台 CPU/IO budget 下请求 2 必然被 Governor 降级为 1；真实拓扑是 parent + N child Writer。 | 扩大全局平台预算；让 parent 自行忽略 admitted count；保留虚构 phase Writer。 | dual CompoundLease 可真实 admission；single/low-memory 仍由同一 Governor 降级；production 字段不变。 |
| native worker-thread adapter 仅把 Supervisor admitted topology 的 exact key/count 合并进 reserved workerData。 | adapter.start 已接收 admission 后 topology；Job input 在 admission 前冻结，不能表达低内存 downgrade。 | caller input workerCount；全量 topology/资源向量传入 worker。 | child count authority 不可由业务 caller 注入，parent 看不到无关预算细节。 |
| child shard 使用 internal exact shard contract；parent 完整校验后按 subjectIndex merge 为现有 canonical result，Main 再做业务 Join。 | 现有 public validator要求全量 0..N-1；第二 shard 不能伪装 public result。 | 放宽 public validator；让 Main 接受多个 shard DTO。 | public result/Publisher合同零变化，internal重复/遗漏/错 owner fail closed。 |
| reserved topology key 对所有 entry 都是 adapter 私有命名空间；non-opt-in 也不得自带。 | Reviewer 发现原检查只覆盖 opt-in，non-opt-in 可预占 reserved key。 | 仅 merge 时检查；允许 entry 以同名 key 携带其它含义。 | Worker 创建前统一拒绝；正常 non-opt-in workerData 原样保留。 |
| first shard failure 在第一个 Promise catch 时按时间冻结，后续 abort/teardown failure 不覆盖。 | Reviewer 的 shard1 `ROOT_FIRST` / shard0 后发 teardown 反例证明按 allSettled 数组顺序选择不等于因果首错。 | 按 shardIndex 选第一个 non-cancel；allSettled 后重新推断 root。 | 继续等待全部 child terminal，但用户看到真实首错。 |
| child error terminal decode 是不可信协议边界，任何 SafeError validation throw 都转为 bounded result-invalid。 | `fromProtocolError` 会对 keys/大小/隐私/字段校验抛错；EventEmitter callback throw 会绕过 Promise settle。 | 让异常冒泡；接受部分字段再 sanitize。 | shard Promise 必然 settle，group/Main cleanup 可达，私密/超大文本不外泄。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| subjectCount < 4 时按 policy `minUnitsPerWorker=2` 使用 single，否则请求 two。 | 当前 policy 明示 minUnitsPerWorker=2；最多 two 为冻结合同。 | 小样本进程开销可能回退。 | 1～64 planner测试和 small benchmark；不达门禁仍 production=false，可把 planner 固定 1。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git show -s fa71a2f6` | parent=`962c364a...`，E12-B review-fix head 精确匹配 | 父链/范围。 |
| branch/worktree/log/reflog/path 搜索 | 无旧 E12-C 草稿 | 不依赖未审查历史实现。 |
| E12-C unit | 7/7 PASS | 1～64 planner、唯一覆盖/reducer 反例、真实 single/dual 语义等价、真实 CompoundLease dual、Publisher 0/1、child crash/cancel/duplicate terminal、首错等待 sibling。 |
| E12-C + E12-A + toolbox policy | 81/81 PASS | E12-A authority/staging/cleanup/recovery 与 policy 资源合同回归。 |
| platform/Publisher/recovery 定向 | 442/442 PASS | ResourceGovernor/Supervisor/adapter、FilePlan、原子发布、恢复、SafeError。 |
| 全 VCC unit | PASS（preview 契约 16/16 单独复核） | VCC DB/query/金额币种/Pending/archive/lineage/发布全域回归。 |
| `npm run test:unit`（复跑） | 6351/6354 PASS，0 fail，3 Windows skip | 全仓单测；首轮仅一个 E12-A `fs.realpathSync` monkey-patch 并发抖动，隔离 1/1 PASS，复跑全绿。 |
| `npm run test:integration` | 51 scripts、2455/2455 PASS | 全仓集成；自动刷新耗时清单已恢复，未纳入无关 diff。 |
| `npm run smoke` | PASS | Excel/对账/业务 smoke 回归。 |
| `npm run lint`、语法、`git diff --check` | PASS | 静态与格式检查。 |
| `scripts/perf/vcc-financial-op-dual-writer-e12-c.js` | 5-run synthetic：16 subjects median 709.45ms→349.16ms（+50.78%）；4 subjects 244.84ms→230.58ms（+5.82%）；dual peak RSS 324.45 MiB / delta 197.23 MiB | 本机进程隔离 speed/RSS evidence；速度过冻结阈值，但不替代真实样本/Windows/人工门禁。 |
| Reviewer finding 定向回归 | 27/27 PASS | non-opt-in reserved key、opt-in conflict、正常 non-opt-in；`ROOT_FIRST` 时序；四类非法 SafeError bounded settle；allSettled/cleanup/Publisher=0。 |
| Reviewer follow-up 全 VCC | 378 tests（dot reporter）PASS | E12-A/B/C 与 VCC 金额、币种、Pending、archive、lineage、recovery 全域。 |
| Reviewer follow-up platform/recovery | 365 tests（dot reporter）PASS | adapter、error codec、Supervisor、ResourceGovernor、recovery 与 output publication。 |
| Reviewer follow-up `npm run test:unit`（无并发复跑） | 6352/6355 PASS，0 fail，3 Windows skip | 首轮与 integration 并发时仅 PreFund symlink snapshot 探针抖动；隔离 1/1 PASS，无并发复跑全绿。 |
| Reviewer follow-up `npm run test:integration` | 51 scripts、2455/2455 PASS | 全仓集成；自动耗时清单恢复，未纳入无关 diff。 |
| Reviewer follow-up `npm run smoke` / lint / syntax / diff-check | PASS | smoke、生产源 lint、改动测试 lint、语法与格式。 |
| Reviewer follow-up performance/RSS | 5-run synthetic：16 subjects 691.75ms→345.28ms（+50.09%），dual peak/delta 322.86/198.33 MiB；4 subjects 239.93ms→224.12ms（+6.59%） | reviewer 修复未造成 success-path 性能回退；仍不替代真实样本/Windows 门禁。 |

## Blindspot Pass

| 边界 | 结论与证据 |
| --- | --- |
| 入口/旁路 | live IPC、Renderer、Preload、`src/main.js`、公开 Writer result、FilePlan/Publisher API 均零 diff；caller 不能传 worker count，reserved admitted topology key 冲突即拒绝。 |
| 所有权/生命周期 | Main 唯一 full A/B/Join/Publisher/cleanup；parent coordinator 唯一拥有 child group；child 只拥有 assigned generation paths 与 read-only subject query；首错 abort sibling 并等待 all-settled 后才向 Main 失败。 |
| 边界/失败模式 | 1～64 subject、1/2 topology、重复/遗漏/错 shard、child crash、cancel terminate timeout、duplicate late terminal、staging identity replacement、Publisher 0/1 均有定向测试。 |
| 兼容/可观测 | production=false、legacy、effectiveWorkerCount=0；错误通过 finance-safe-v1 有界协议；无 schema/migration/public DTO/version 变化。 |
| 剩余盲区 | Windows nested worker/文件锁/packaged、真实大型工作簿/RSS、真实资金逐笔复核只能人工完成，继续阻断 production enable。 |

## Reconciliation Checklist

| 检查项 | 结论与证据 |
| --- | --- |
| 主键/血缘 | `subjectIndex + subjectDigest + outputArtifactKey` 在 planner、child manifest、reducer 三层 exact 对照；重复、遗漏、错 owner fail closed。 |
| 金额/币种/Pending | writer 使用 E12-B 同一 subject loader/Excel writer；真实 single/dual 工作簿按金额、币种、Pending、style/order canonical digest 等价。 |
| 时间/revision/archive | 不改时间边界或 archive schema；每 child 在同一 read transaction 做 authority start/end，Main 仍做 full A/B 与 current task/FilePlan freshness。 |
| 并发/幂等/部分失败 | 每 generation path 唯一 owner；任一 shard 失败 Publisher=0，Main exact cleanup；全成功 deterministic merge 后 Publisher 恰好 1；迟到/重复 terminal 不改终态。 |
| 行数/输出守恒 | reducer 要求 artifacts 数量、subjectIndex 顺序、authority result/pending row counts 与全 generation set 一一对应；全量 VCC/Publisher/recovery 测试通过。 |
| 资损红线 | 自动化不替代真实资金逐笔核对；production gate 保持关闭并要求人工 review。 |

## 关联功能 Review

- `ADMITTED_TOPOLOGY_WORKER_DATA_KEY`：跨线程 topology authority；已复核 Supervisor admission 后 producer、adapter 冲突拒绝和 VCC parent consumer，未改变通用 job input/protocol。
- `VCC_EXPORT_SUBJECTS_POLICY` / runtime topology registry：影响 BackgroundExecution 资源 admission；已复核 base/phase/compound exact vector、low-memory downgrade、shutdown 零泄漏及其它 compound action 固定 single 行为。
- `executeVccExportWriter` / VCC output：影响资金 Excel generation；已复核 read-only DB、assigned subject pushdown、amount/currency/Pending/order、staging/cleanup/recovery/Publisher 0/1。
- 本次未运行项目禁止的 `check-vars` / `scan:vars`；直接对照 `rules/important-variables.md` 后，未修改既有 Critical 变量，新增 reserved topology key 按跨进程 Critical-like 合同完成 producer/consumer/反例 review。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实大型样本 15%/RSS、Windows packaged/nested worker、资金人工 gate | BLOCK（上线） | release owner 在真实样本和 Windows packaged 环境执行 | 不阻止 dormant capability commit，阻止 production enable；本机 synthetic 证据仅为方向性证据。 |
