# v3.1.3 Implementation Notes

## Baseline

- 需求与契约：[spec.md](./spec.md)
- 基线：`main@db43294` / `3.1.2`
- 分支：按 PR 阶段从 `codex/v3.1.3-position-large-import` 递进；PR-C1 为
  `codex/v3.1.3-pr-c1-mutation-recovery`，PR-C2 为
  `codex/v3.1.3-pr-c2-gateway-outbound`，PR-D 为
  `codex/v3.1.3-pr-d-remaining-sources`，PR-E 为
  `codex/v3.1.3-pr-e-bank-account-ui-release`

## Decisions

| 决定 | 原因 | 影响 |
| --- | --- | --- |
| 目标版本定为 `3.1.3` | 用户明确指定 | PR-E 才执行版本 bump |
| 按 PR-A → PR-E 分阶段实施 | Spec 强制，避免资金链 mega PR | 每阶段独立门禁，生产 gate 逐步开启 |
| 最终附件纳入 `changes/3.1.3/spec.md` | 附件状态为 ready-for-implementation，且比旧草案完整 | 不覆盖原未跟踪草案 |
| 同业务主键不同内容全部保留，完全相同记录折叠 | 真实五文件证明业务单号并非记录级唯一；用户于 2026-07-30 明确确认 | `business_key` 降为业务字段，`row_hash` 成为内部 `sourceRecordKey`；链接与消费关系同步迁移 |
| schema-only 迁移在取得 `BEGIN IMMEDIATE` 写锁后重验 checkpoint | 避免磁盘门禁和写锁之间被另一写入推进 generation | schema 迁移不误认并发业务写入，也不推进业务 checkpoint |
| schema 迁移强制 `temp_store=FILE` | `row_hash` 排序和身份映射必须支持百万级有界内存 | 大型排序/临时映射由 SQLite 落盘，仍受迁移磁盘门禁保护 |
| bank/account 未实现专用 SQL 聚合恢复前一律 fail closed | 它们不是“每文件一事务”，不能套用普通来源的 proof 数量公式 | PR-E 接入 writer 时必须补齐专用恢复后才能开启生产 gate |
| row hash 另加 SHA-512 guard | 单一 SHA-256 不足以证明碰撞分支已 fail closed | ledger 和 apply TEMP 表同时核对规范内容的独立摘要及业务主键 |
| PR-C2 使用 sourceType 混合路由 | 单一全局 streaming 开关会误拦尚未迁移的普通来源 | gateway-outbound 走 worker；其余普通来源复用预检暂存文件走现代 schema 兼容旧路径 |
| PR-C2 流式来源使用代码级固定白名单 | 仅靠环境变量默认值仍可误开未验收 writer | 配置归一和 worker apply 双层只接受 gateway-outbound；PR-D 再显式扩容 |
| PR-C2 SQLite 连接固定 2 MiB page cache、关闭 mmap | 16 MiB cache 的试跑在第 3 份文件越过 1 GiB worker RSS 门槛 | 每文件提交后再执行 `shrink_memory`；最终真实回放峰值降至 832,225,280 B |
| PR-D 四类普通来源共用同一增量 writer | 规范化、来源身份、派生和文件级 checkpoint 契约一致 | 代码级允许集合一次扩展到四类；账户快照仍 fail closed |
| 删除和映射重建使用独立 maintenance utility job | 旧实现会构造全量行对象、ID 数组或派生数组 | 单事务分批删除/游标派生，每批 yield 并检查取消 |
| 普通来源存档后按 job root 清理 | 只返回成功文件目录会遗留拒绝文件和 sealed ledger | 存档失败时由 unresolved source path 继续保护整个 job root |
| 银行 BizId 跨 scope 冲突由正式表唯一约束在事务中裁决 | 预先复制 300 万 BizId 到 TEMP 表没有必要，且增加磁盘与静默时间 | 唯一约束失败后只查询冲突 BizId 的既有 scope，返回原结构化错误；整批事务回滚 |
| 账户快照物理行使用“完整行 + Excel 行号”身份 | 用户确认内容相同的账户行也必须独立保留 | 同内容账户行不会被唯一键折叠；整表替换后物理行号提供稳定批内身份 |
| 银行管理页和状态页复用一次 scope snapshot | 300 万行下重复执行全表 summary/status/scope 扫描超过同步查询门槛 | 新覆盖索引聚合 Channel、月份、状态和日期，renderer 契约不变 |
| 进度每 4,000 行上报，提交阶段服务端拒绝取消 | 真实 300 万回放需保持最长静默不超过 2 秒，且 COMMIT 后不能虚假取消 | 预检/写入/派生统一间隔；弹窗在服务端返回不可取消时保持提交状态 |
| dispatcher 每 750ms 重发最后真实进度并使用 monotonic clock | SQLite 汇总/提交和测试机墙上时间跳变期间仍需证明 UI 活着，且不能伪造行数 | heartbeat 只重复阶段和计数；worker 对 summarizing/committing 的竞态取消返回 `accepted=false`，dispatcher 不把拒绝回执记为已确认取消 |
| 普通来源管理摘要保存为事务内派生缓存 | 300 万 source/link 每次打开管理页执行全表聚合不满足同步查询门槛 | 导入、删除、账户替换和映射重建同事务刷新；缺失/损坏时回退事实表 |
| 导入及维护写事务统一执行保守磁盘门禁 | WAL、临时索引、派生和 schema 迁移会短时放大磁盘占用 | 无法确认空间或空间不足时在删除/替换旧数据、账户映射或链接派生前失败关闭 |
| 暂存清理动态合并 outbox、主库 pending 和活动 token/job 保护集 | 普通来源与账户快照可共享 job root，且授权、提交、存档分属不同持久化阶段 | 任何保护来源不可读时 fail closed；仅在提交/存档证据闭合后异步清理未保护目录 |

## Assumptions

| 假设 | 依据 | 验证/回滚 |
| --- | --- | --- |
| 3.1.2 未改变平盘导入业务契约 | 当前 diff 和版本历史 | PR-A 从当前 main 重建 characterization |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 |
| --- | --- | --- | --- |
| 同业务主键不同内容整文件拒绝，跨文件同业务主键后序拒绝 | 同 `row_hash` 完全重复折叠，同业务主键不同内容全部保留 | 真实文件 2-5 均含合法的同业务单号多内容记录，且用户明确取消拒绝规则 | PR-B ledger、PR-C1 侧库 schema、后续 writer/消费血缘及验收用例全部改用 `sourceRecordKey` |
| PR-C2 初始 apply 连接使用 16 MiB page cache | 改为 ledger/side DB 各 2 MiB、关闭 mmap，并在文件提交后回收 page cache | 初始真实试跑在第 3 份文件达到 1,085,390,848 B，超过 1 GiB；该轮停止且不计为通过 | 最终五文件峰值 832,225,280 B，资源门禁通过 |
| 银行 apply 原计划把 sealed ledger 的全部 BizId 复制到 side DB TEMP 表后再查冲突 | 删除全量 TEMP 键表；保留小型 scope 表，逐行仍向只读 ledger 精确验证物理归属，跨 scope 冲突交由正式唯一约束裁决 | TEMP 键表在冲突预扫描移除后已无消费者，继续保留会产生约 300 万次无效写入 | 业务错误码、事务回滚和逐行 ledger 一致性不变，银行 apply 更快且磁盘峰值更低 |
| benchmark 原使用 `Date.now()` 计算运行时长和进度间隔 | 改用 `process.hrtime.bigint()`；墙上时间只保留为审计时间戳 | macOS 测试期间系统墙上时间发生跳变，会污染 elapsed 和静默门槛 | 证据时长、采样和 P95 使用单调时钟，业务代码的用户时间语义不变 |

## Self-review Corrections

- 用户取消统一返回 `cancelled`，Renderer 不再显示为“导入失败”。
- 授权等待、授权拒绝、启动消息失败、重复 `PREFLIGHT_READY` 和 worker 零提交退出均会清理未受保护的 staging/ledger；终止后的迟到授权不再继续下发。
- 普通来源部分提交恢复会保留 side DB 已提交文件的顶层存档证据，并只清理未提交输入。
- 混合普通来源与账户快照时，账号确认取消或失败不会删除仍被 outbox/主库 pending 引用的共享 job root。
- 百万级暂存目录改用异步删除；零提交重启恢复会立即返回全部未提交输入作为清理候选，不再等待 7 天过期回收。

## Evidence

| 日期 | 证据 | 结果 |
| --- | --- | --- |
| 2026-07-30 | 旧 reader/derivation 定向测试 | 10/10 PASS |
| 2026-07-30 | PR-A parity characterization | 17 项：文件级 `-0` 明确规范为 `0`；其余 shared/inline/formula/rich/date/ID 类型已锁定 |
| 2026-07-30 | PR-A fault characterization | 8/8 PASS |
| 2026-07-30 | `npm run release-check` | lint、smoke、4386/4386 单测、44 个集成脚本 2051/2051 断言全部通过 |
| 2026-07-30 | `scan:vars` / `check:vars -- --include-minor` | 242 个 `src` 文件扫描完成；PR-A 未改 `src`，无关联变量命中 |
| 2026-07-30 | 真实五文件路径检查 | 5 文件齐全，共 1,339,185 行（按 Spec 记录） |
| 2026-07-30 | 正式侧库隔离副本检查 | `quick_check=ok`；590 links / 590 sources；0 个 source-leg 重复组 |
| 2026-07-30 | 真实第 2-5 份出账文件流式预检 | 均发现同业务单号不同内容；第 4 份 `PD260113144304369391944` 的两行分别为 `Yeepay_CN` 与 `Yeepay` |
| 2026-07-30 | 抽取真实冲突行回放旧 reader | 旧契约返回 `position-source-key-conflict`；用户明确批准改变该业务口径 |
| 2026-07-30 | 新口径回放真实五文件 | 5/5 `ok`；300,000 + 300,000 + 300,000 + 300,000 + 139,185 = 1,339,185 条候选，完全重复折叠 0 条 |
| 2026-07-30 | 真实五文件 PR-B 资源证据 | 332.5 秒；main RSS 峰值 60,162,048 B，worker RSS 峰值 368,689,152 B，ledger 380,256,256 B，run-data 峰值 769,547,229 B |
| 2026-07-30 | 严格 OOXML SST 复用后的真实五文件复验 | 5/5 `ok`，1,339,185 条候选、0 条完全重复；355.8 秒；main RSS 峰值 60,293,120 B，worker RSS 峰值 561,119,232 B，worker heap 峰值 76,296,960 B，ledger 380,256,256 B，run-data 峰值 769,600,477 B |
| 2026-07-30 | PR-B 定向回归 | 预检 16/16、parity 32/32、fault 23/23、scanner/OOXML 结构 106/106；lint PASS |
| 2026-07-30 | PR-B `npm run release-check` | smoke PASS；unit 4,402/4,402；44 个 integration 脚本 2,051/2,051 |
| 2026-07-30 | PR-B `scan:vars` / `check:vars -- --include-minor` | 251 个 `src` 文件；`state` 为 `sheet.state` 同名误报；`POSITION_BANK_HEADERS` 只读复用既有 49 列契约，未改表头 |
| 2026-07-30 | PR-C1 mutation/schema/recovery 定向测试 | 共享事务、archive grant、身份迁移、写锁 checkpoint、链接字段/腿集合冲突、普通来源恢复与 bank fail-closed 共 36/36 PASS |
| 2026-07-30 | PR-C1 `npm run release-check` | lint、smoke、4,414/4,414 单测、44 个 integration 脚本 2,051/2,051 全部通过 |
| 2026-07-30 | 正式侧库只读快照迁移 | 原库未写入；快照迁移前后 590 source / 590 link，generation=4 不变，现代身份各 590，`quick_check=ok` |
| 2026-07-31 | PR-C2 定向回归 | 88/88 PASS；覆盖生产 writer、部分提交恢复、现代 schema 旧路径、混合 sourceType gate、异步 mutation 和单记录派生；lint PASS |
| 2026-07-31 | 真实五文件 PR-C2 生产写入 | 5/5 `ok`；1,339,185 source / 1,339,185 link / 1,339,185 distinct sourceRecordKey；0 完全重复；5 input proof；generation=5；`quick_check=ok` |
| 2026-07-31 | PR-C2 真实资源证据 | 799,570 ms；main RSS 94,355,456 B；worker RSS 832,225,280 B；worker heap 80,569,272 B；run-data 峰值 4,662,632,245 B；ledger 562,221,056 B |
| 2026-07-31 | 真实重复业务主键落库复核 | `PD260113144304369391944` 共保留 3 个不同 row hash；第 4 份第 91/92 行的 `Yeepay_CN`、`Yeepay` 均独立保留 |
| 2026-07-31 | PR-C2 文件级故障注入 | 文件 A 提交、文件 B staged bytes 变化后，A 的业务行/input proof/generation 可恢复，B 整体回滚 |
| 2026-07-31 | PR-C2 专项 parity / fault | parity 38/38、fault 30/30，全部通过 |
| 2026-07-31 | PR-C2 最终 `npm run release-check` | lint、smoke、4,423/4,423 单测、44 个 integration 脚本 2,051/2,051 断言全部通过 |
| 2026-07-31 | PR-C2 `scan:vars` / `check:vars -- --include-minor` | 扫描 256 个 `src` 文件；14 个本次源码文件未命中重要变量清单 |
| 2026-07-31 | 同业务主键独立匹配与消费端到端测试 | service 定向测试 56/56 PASS；同一业务主键下两个不同 `sourceRecordKey` 分别匹配、导出、确认并写入两条消费关系 |
| 2026-07-31 | 新增消费守恒与来源白名单用例后的全量单测 | 4,423/4,423 PASS |
| 2026-07-31 | PR-C2 来源白名单自查修复 | 配置和真实 worker 双层门禁通过；请求 gateway-inbound 时 0 业务行、0 input proof、generation 不变；相关定向测试合计 78/78 PASS |
| 2026-07-31 | PR-D 四类普通来源 writer | preflight/worker 定向 23/23 PASS；覆盖四类来源及 0/hidden/visible/双腿派生 |
| 2026-07-31 | PR-D maintenance writer | 3/3 PASS；覆盖来源/银行分批删除、FK cascade、映射游标重建及中途取消整体回滚 |
| 2026-07-31 | PR-D service utility 接线 | service 定向 57/57 PASS；真实 child worker 删除来源并同步 checkpoint |
| 2026-07-31 | PR-D parity / fault / lint | parity 41/41、fault 33/33、lint PASS |
| 2026-07-31 | PR-D 最终 `npm run release-check` | lint、smoke、unit 和 44 个 integration 脚本全部通过；integration 2,051/2,051 |
| 2026-07-31 | PR-D `scan:vars` / `check:vars -- --include-minor` | 扫描 257 个 `src` 文件；6 个本次源码文件未命中重要变量清单 |
| 2026-07-31 | PR-E 定向 service/renderer/preflight 回归 | 银行/账户确认写入、管理摘要缓存、COMMIT 后恢复、真实进度和取消竞态均通过；取消竞态修复后 service 61/61 PASS |
| 2026-07-31 | 银行 300 万行最终基准 | 3,000,000 bank rows；3/3 input proof；`quick_check=ok`；main RSS 增量 8,323,072 B；worker 峰值 641,040,384 B；最长静默 1,419ms；status/data-manager P95 254.80/253.75ms |
| 2026-07-31 | 网关入账 300 万行最终基准 | 3,000,000 source + 3,000,000 link + 3,000,000 distinct sourceRecordKey；3/3 proof；`quick_check=ok`；main 增量 8,552,448 B；worker 峰值 870,514,688 B；最长静默 1,977ms；三类管理查询 P95 <1ms |
| 2026-07-31 | 网关出账 300 万行最终基准 | 3,000,000 source + 3,000,000 link + 3,000,000 distinct sourceRecordKey；3/3 proof；`quick_check=ok`；main 增量 8,388,608 B；worker 峰值 924,991,488 B；最长静默 1,481ms；三类管理查询 P95 <1ms |
| 2026-07-31 | 300 万证据路径 | `changes/3.1.3/evidence/bank-3m-macos.json`、`gateway-inbound-3m-macos.json`、`gateway-outbound-3m-macos.json` |
| 2026-07-31 | PR-E 最终定向回归 | 117/117 PASS；覆盖 worker 拒绝提交阶段取消、低磁盘时保留旧账户映射和链接数据、银行/账户写入及 Renderer 交互 |
| 2026-07-31 | PR-E 最终 `npm run release-check` | lint、smoke、4,439/4,439 单测、44 个 integration 脚本 2,051/2,051 断言全部通过 |
| 2026-07-31 | PR-E UI 与启动性能 | 12 个平盘 preview 生成成功；新增导入中、停止中、提交中页面人工复核通过；启动性能 process/ready-to-show/renderer/getInfo 中位数为 695/185.359/44.4/10.7ms |
| 2026-07-31 | PR-E `scan:vars` / `check:vars -- --include-minor` | 扫描 261 个 `src` 文件、3,277 个顶层名称；命中 Important-skeleton `ipcRenderer` 和 Runtime-state `dialog`，已复核 preload 白名单、监听解除、弹窗状态机及 smoke/UI 回归 |
| 2026-07-31 | PR-E self-review 定向回归 | 139/139 PASS；覆盖取消结果、授权拒绝、重复预检、消息通道失败、零/部分提交恢复、主库 pending/outbox/共享 job root 保护及异步清理 |
| 2026-07-31 | PR-E self-review parity / fault | parity 54/54、fault 50/50 PASS |
| 2026-07-31 | PR-E self-review 最终 `npm run release-check` | lint、smoke、4,454/4,454 单测、44 个 integration 脚本 2,051/2,051 断言全部通过 |
| 2026-07-31 | PR-E self-review `scan:vars` / `check:vars -- --include-minor` | 扫描 261 个 `src` 文件、3,283 个顶层名称；8 个本次源码文件未命中重要变量清单 |

## Remaining Unknowns

| 未知 | 分类 | 下一步 |
| --- | --- | --- |
| Windows 实机导入、取消和文件锁 | PROBE | 发布前 Windows 安装版手测；当前 macOS 自动化不能替代 |
| 真实资金逐笔正确性 | BLOCK（发布前） | 业务负责人复核 |
