# v3.2.4 E12-B Restack Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.4 Spec §7.2/§8/§9、TechDoc §9/§13 与 [preflight.md](./preflight.md)。
- Initial plan：先闭合 subject SQL/index 与资金 parity，再适配新 E12-A staging/authority，最后回放全链路证据。
- Restack parent：E12-A review-fix `962c364abefd28b6c740e8318ba19cbbe26e73cf`。
- Old evidence commits：`df71681d`、`55bfca4e`，只作为逐段审查 overlay，不机械视为新父链正确实现。
- Done when：dormant single Writer 仅 materialize assigned subject 资金事实；Main full Join/Publisher、E12-A staging/cleanup/recovery、资金语义与 production-false 边界不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| scoped query 仅由 dormant E12 Worker opt-in；legacy/live 默认 full loader。 | 本 PR 禁止接 live，且 live 没有本 capability 的生产门禁。 | 全局替换 writer loader。 | 用户可见路径和生产拓扑零变化。 |
| Main full authority继续唯一控制正式发布；Worker只使用global scalar/archive metadata + assigned subject business evidence。 | 避免Worker全量资金读取，同时不削弱E12-A Main A/B/Join。 | Worker继续full snapshot；只信 input。 | Worker read scale按目标主体；Publisher authority不变。 |
| 新父链 staging identity/before-subject/before-handoff/cleanup authority不可被旧patch覆盖。 | 这些是已审查E12-A后续修复并保护外部路径与恢复所有权。 | 直接cherry-pick后接受旧函数体。 | overlay冲突按当前父链手工适配并补回归。 |
| 为 run rows、adjustments、Pending summary 添加三个幂等 non-unique subject indexes；balances/totals 复用既有 PK。 | EXPLAIN 证明前三者原合同不能按 `(run_id, subject)` 收敛，后两者已经以 run/subject 开头。 | JS full-load/filter；重复 balances/totals index；改表/列/唯一键。 | 只改变查询可达计划，不改持久业务事实与唯一性。 |
| subject-local adjustment 只校验 run revision 标量与目标局部 sequence 严格递增；全局连续性继续由 Main full authority 验证。 | sequence 是 run-global；全 run aggregate 会让非目标 adjustment 继续线性访问。 | `COUNT/MIN/MAX` 全 run aggregate；把局部序列误当从 1 连续。 | 目标 materialization/VM steps 不随非目标 adjustment 增长，资金 revision authority不弱化。 |
| archive subject metadata 最多有界读取 65 条并用 Main 相同的 JS UTF-16 comparator 排序；NULL fingerprint 原样保留。 | 主体上限64；SQLite BINARY 与 JS 对 astral/full-width 字符顺序可不同；legacy-four 合法 fingerprint 为 SQL NULL。 | SQL OFFSET解释subjectIndex；`String(null)`；强制archive/run时间相等。 | 历史归档、非BMP主体与合法跨秒 archive 保持 E12-A 兼容。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| additive non-unique indexes不改变业务数据合同。 | 只加 `IF NOT EXISTS` index；冻结 TechDoc要求SQL WHERE/index。 | 旧库迁移或readonly schema失败。 | legacy fixture迁移与schema readiness；可移除index要求/API。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 旧 E12-B Writer overlay 使用 `cleanupOnFailure=true` 且没有新 staging hooks。 | 保留新父链 `cleanupOnFailure=false` 的 Main 单一 cleanup owner，并组合 `beforeSubjectWrite`/`beforeAtomicHandoff` identity hooks与scoped query。 | 新父链在旧提交后已审查并关闭双删、path replacement与committed-cleanup责任缺口。 | 不改变冻结E12-B行为；避免回退E12-A cleanup/recovery authority。 | 不适用（无Spec行为偏差；已反向同步本记录/preflight） |
| 旧 E12-B 端到端测试未携带 `stagingIdentity`。 | 测试创建独立task-private目录并使用生产 `createTaskStagingIdentity`。 | 新父链 Worker input exact contract已新增frozen root/parent identity。 | focused测试现在覆盖真实新父链入口，不放宽生产validator。 | 不适用（测试适配） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 冻结 scope取证 | Spec §7.2/§8/§9、TechDoc §9/§13、implementation sequence v3.2.4 gate均指向subject query pushdown | E12-B不包含dual Writer/live enable。 |
| 新旧父链 overlap取证 | 新父链相较旧E12-A在writer core/writer新增staging identity、raw OOXML、layout/cleanup修复 | overlay必须保留已审查E12-A不变量。 |
| E12-B focused | 9/9 PASS | 三类SQL plan、full/scoped parity、balance-only、scoped A/B、排序/历史兼容、read scaling与真实Worker。 |
| E12-A affected regression | 64/64 PASS | single Writer、FilePlan/Main Join、raw OOXML、staging identity、cancel、Publisher 0/1、committed cleanup/retry。 |
| 全 VCC unit matrix | 671/671 PASS | schema/migration、金额币种/adjustment/revision/archive、writer、storage/recovery与legacy UI/contract。 |
| 平台/Publisher/recovery unit matrix | 431/431 PASS | policy/protocol/Governor/Supervisor、Main-settlement、durable journal与VCC recovery。 |
| directed read/RSS benchmark | 非目标 adjustments 1→20,000 时目标readCounts不变；VM steps 19→19、fullscan 0→0；median 0.224→0.230ms；RSS delta 2.22→2.25MiB；maxRSS 108.98→107.88MiB；三类query均SEARCH subject index。 | 反证hidden full-run adjustment scan；确认query/RSS scale按目标主体。 |
| full integration | 51/51 scripts、2455/2455 assertions PASS；含VCC adjustment/archive 226、destructive 77、effective 19、historical export 29及platform recovery canaries。 | 跨模块迁移、归档、历史模板、恢复与输出链。 |
| smoke/static | `npm run smoke` PASS；`npm run lint` PASS；changed JS `node --check`、`git diff --check` PASS。 | 仓库smoke、源码语法/风格与diff卫生。 |
| production/non-goal静态复核 | `src/main.js`、runtime、dispatch、policies、staging identity、output recovery零diff；两action仍`production.enabled=false/effectiveWorkerCount=0`。 | 未接live Main，未做dual Writer/shard/merge，legacy/production边界不变。 |

## Blindspot Pass

### [Important/已覆盖] scoped authority 未替代 Main 正式发布 authority

- 事实：Worker scoped A/B 在同一 `BEGIN DEFERRED` 内读global run/dataset/archive metadata与assigned subject facts；Main仍在Worker前、Join后、Publisher前执行full snapshot，并深度回读所有workbook。
- 推断/未知：未分配主体资金事实若在Worker窗口漂移，Worker不全读它；Main post-Join full authority仍会在Publisher前拒绝。
- 影响：避免为了pushdown削弱全集TOCTOU或让错误主体/金额进入正式输出。
- 证据：E12-B scoped drift/poison与E12-A authority B/Join tamper回归；Publisher失败路径始终0次。
- 最便宜验证：现有focused + E12-A 64/64。
- 处置：已覆盖。

### [Important/已覆盖] 新父链 staging/cleanup/recovery 未被旧overlay回退

- 事实：Writer仍传递每主体与atomic handoff identity hook；`cleanupOnFailure=false`保留Main唯一owner；dispatch/staging/recovery源码零diff。
- 推断/未知：subject query失败、取消或目录替换仍由原owner按exact identity收口，不产生第二scanner/Publisher。
- 影响：防止误删外部同名路径、双删、committed后误重发或残留责任丢失。
- 证据：E12-A replacement/cancel/cleanup/pending-retry全64项与Publisher/recovery 431项PASS。
- 最便宜验证：同一两组回归。
- 处置：已覆盖。

### [Minor/已覆盖] legacy/live旁路与历史字符串排序

- 事实：只有dormant Worker显式传`subjectQueryPushdown=true`；live/legacy默认full loader；scoped metadata复用JS comparator并接受NULL fingerprint和合法archive跨秒。
- 推断/未知：不存在live调用方在本PR中静默改读取时点；非BMP主体不会被SQLite BINARY错配subjectIndex。
- 影响：用户可见路径和历史归档兼容不变。
- 证据：legacy fixture、astral/full-width、跨秒focused；全VCC/历史integration。
- 最便宜验证：已执行focused/integration。
- 处置：已覆盖。

会改变方案的存活问题：无。已反证候选：需要SQL OFFSET定位subjectIndex、需要全run adjustment aggregate、需要第二Writer才能验证pushdown，均被代码/benchmark/spec反证。剩余验证边界是Windows packaged SQLite计划/RSS、Excel/WPS与真实资金样本人工门禁。

## Reconciliation Blindspot Pass

### [Critical/人工门禁保留] 主体选择与资金输出血缘

- 场景：subject filter若错配subjectIndex/subject或漏读目标资金事实，可能把金额、币种、Pending归到错误主体或产生少记。
- 事实与证据：Main authority以subjectIndex/digest/businessDigest绑定全集；Worker用同一JS排序、有界archive metadata与assigned subject canonical evidence；full-vs-scoped deep parity、E12-A golden、全VCC 671与integration 2455均PASS。
- 推断/未知：自动fixture不能替代真实脱敏资金样本逐主体核对。
- 资损或审计影响：错主体、漏行或错误Pending属于资金红线。
- 最便宜验证：资金负责人抽取真实多主体/多币种/调整/Pending样本，比较legacy与managed每主体行数、金额、币种、差异和lineage。
- 处置：BLOCK production enablement；⚠️ 资金红线，请人工复核。dormant代码合并不打开production。

### [Important/已覆盖] 金额币种、revision与调整语义零漂移

- 场景：局部调整读取可能把global sequence/revision错误解释为目标主体连续序列，或改变decimal/余额逻辑。
- 事实与证据：full path未改；scoped只放宽为局部sequence严格递增并保留global resultRevision标量；金额/币种/余额继续复用同一canonical builder/writer；目标readCounts与20k非目标adjustments无关。
- 推断/未知：未发现汇率、舍入、借贷方向或九币种集合变化。
- 资损或审计影响：若revision authority弱化会遗漏调整；Main full authority仍验证全局连续性并在Publisher前fail closed。
- 最便宜验证：result-adjustments/full VCC与archive integration已覆盖。
- 处置：已覆盖。

### [Important/已覆盖] 幂等、部分失败与输出守恒

- 场景：逐主体query/write中途失败或重跑可能留下部分正式文件或重复发布。
- 事实与证据：新增路径只读；generation仍task-private；任一失败Publisher=0；全集Join后单Publisher；committed cleanup pending保留原成功事实且collision阻断重试。
- 推断/未知：没有新增DB mutation、receipt、自动fallback或第二Writer并发面。
- 资损或审计影响：避免部分主体成功被误报为全集成功，或重跑重复覆盖。
- 最便宜验证：E12-A 64/64、Publisher/recovery 431/431。
- 处置：已覆盖。

资金红线人工复核项：真实多主体资金样本逐主体金额/币种/Pending/差异/行数/lineage；Windows packaged SQLite query plan/RSS；Excel/WPS打开与样式。建议自动化已由focused query-plan/read-count、full/scoped parity、历史NULL/排序/metadata drift、E12-A cleanup/Publisher矩阵覆盖。冻结spec明确有意设计：production false、single Writer、Main full authority、legacy/live不切换。

## 关联功能 review

- VCC storage/read-only schema：仅添加三个幂等non-unique索引与read-schema readiness；未改表/列/PK/唯一性、`VCC_STORAGE_CONTRACT_VERSION`或write guard；旧fixture迁移、全VCC与integration通过。
- VCC adjustment/result/archive：full API行为不变，新增subject-only read；金额、币种、order、revision/archive仍由Main full authority与共享writer校验。
- E12-A FilePlan/Writer/Main Join/Publisher/cleanup/recovery：重叠处保留新父链hooks和Main cleanup owner；相关64+431项通过。
- `rules/important-variables.md` 未命中本次改动符号的直接条目；仍按上述VCC资金/存储关联面人工review。按任务禁止未运行`check-vars`或`scan:vars`。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged SQLite plan/RSS、Excel/WPS与真实资金样本逐主体等价 | BLOCK production enablement | Windows/资金负责人人工复核 | 不阻断 dormant E12-B；未完成不得production enable。 |
