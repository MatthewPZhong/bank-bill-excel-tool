# v3.1.9 Test Spec

## 1. 范围

本文件覆盖确认 Spec §15.1 的 PR1 批次身份/迁移，以及 §15.2/§15.3 中 PR2 可承担的任务生命周期、策略注册、worker context 和 12 个既有 archive scope 接线。VCC 财务 OP、工具箱、文件物化、存储迁移和 archive UI 仍由 PR3—PR6 补充。

## 2. P0 自动化矩阵

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| P0-01 | 新库 schema | 新表/新列/索引齐全；重复 ensure 幂等 |
| P0-02 | v1 旧库迁移 | 历史 batch number、daily sequence、operation key、archiveStatus 不变；v2 字段默认正确；parent 为空 |
| P0-03 | 历史游标 seed | 每个 local date 的全局 seed 等于各 module cursor 之和，包含已删除批次留下的游标 |
| P0-04 | 同日连续预留 | v2 号为 `YYYY-MM-DD-001/002`，且 `dailySequence===globalDailySequence` |
| P0-05 | 跨模块交错 | 模块代码不进入号码；共享全局流水无重复/丢号 |
| P0-06 | 多连接并发 | 临时文件 DB 上多个 DatabaseSync 连接/worker 共预留 100 次，号码集合连续且唯一 |
| P0-07 | operation key 幂等 | 同 `(moduleId, operationKey)` 返回原 batch，不递增游标 |
| P0-08 | 新 task run | 新 operation/taskRun identity 即使参数相同也分配新批次 |
| P0-09 | 中途失败回滚 | 游标递增后的 INSERT 被真实 SQLite trigger 拒绝时，游标和 batch 同时回滚 |
| P0-10 | 删除不复用 | 发放 001/002/003 后删 003，latest 仍为 003，下一号 004 |
| P0-11 | 跨日与四位数 | 新日从 001；999/1000/1001 不截断 |
| P0-12 | 重启继续 | 关闭并重开 DB 后从持久游标继续 |
| P0-13 | 调用方不能传号 | `reserveTaskBatch({batchNumber})` 明确拒绝，且无写入 |
| P0-14 | latest 只读 | 重复查询不改变游标或批次数 |
| P0-15 | archive/task 状态分离 | `taskStatus=failed/cancelled` 可写；`archiveStatus='failed'` 仍被旧 CHECK 拒绝 |
| P0-16 | task 时间与失败 DTO | reserved/running/succeeded/failed/cancelled 映射及 started/finished/failure 字段正确 |
| P0-17 | parent/related 查询 | 同 parent 跨日按日期/全局序号排序；无 parent 的 v1 不关联；删除后查询只剩可见批次 |
| P0-18 | artifact layout migration | 历史 artifact 内容和 Blob 引用不变，新 layout 字段默认兼容 |
| P0-19 | terminal CAS 竞态 | cancelled 后 late success、succeeded 后 late cancel 均冲突不覆盖；相同 terminal 重放幂等 |
| P0-20 | 跨重启业务身份锚点 | 稳定 businessRunId 幂等绑定/查询；不同 parent 或跨 module source batch 均 fail-closed；删除 source 不删除 anchor |
| P0-21 | terminal 存档状态收敛 | succeeded/failed/cancelled 的真实无文件任务均为 archive complete；全 ready complete、pending staging、存在 failed 且无 pending incomplete；`recordBatchFailure -> terminal` 保持 incomplete，真实 artifact 重试完成后可清错转 complete；task 终态不写入 archiveStatus |

## 3. P1 回归

- 既有 `archive-repository.test.js` 全绿。
- 既有 `archive-service.test.js` 全绿。
- 既有 `archive-center-controller.test.js` 全绿。
- 现有 `createBatch` 继续生成模块前缀 v1 批次并保留原幂等、保留期、artifact、Blob、删除和重试行为。
- `archiveStatus` 的 list filter、状态刷新和修复流程不读取 taskStatus 代替。

## 4. PR1 阶段明确不测（历史边界）

- TaskPolicyRegistry/action inventory（PR2）。
- VCC 财务 OP、工具箱与 13+1 接线（PR3）。
- 目录物化、hardlink/copy、retention 目录清理（PR4）。
- 存储根 marker/journal/迁移（PR5）。
- UI、预览、设置 latest-intent（PR6）。
- 版本 bump、Windows 构建、Excel/WPS 人工验收（PR7）。

## 5. PR1 执行证据

- archive 定向（repository/service/controller + allocator）：55/55 PASS。
- 全量 unit：4813/4813 PASS（304 个测试文件，C04 修正后复跑）。
- 全量 integration：48/48 脚本、2459/2459 PASS。
- smoke：PASS。
- `check-vars -- --include-minor`：PASS，未命中重要变量。
- 本 PR 无 UI、业务 action 或文件目录接线，Spec 第七章对应人工操作项留待 PR2—PR7；PR1 的数据库 P0/P1 均已由真实 SQLite 自动化覆盖。

## 6. PR #132 P1 评论增量矩阵

| ID | 优先级 | 场景 | 最小关键断言 |
| --- | --- | --- | --- |
| R1 | P0 | active 删除授权 | reserved/running 表驱动拒绝且原批次仍可转 terminal；转 terminal 后可正常删除；service 手工删除与 cleanup 同映射 `ARCHIVE_BATCH_ACTIVE` |
| R2 | P0 | seed 首迁与重启幂等 | 同模块多条 v1 首迁只取 module max；跨模块 v2 预留后重复 ensure 不推进 module/global cursor；已有 global cursor 不倒退 |
| R3 | P0 | flow source 血缘 | null/空 parent 的 source batch 以现有冲突码拒绝；既有 exact-parent 成功保持 |
| R4 | P0 | task 权威日期 | 显式伪造 `localDate` 拒绝且无写入；跨午夜 fake clock 只采样一次，localDate、batchNumber、reservedAt、默认 retention 同源 |
| R5 | P1 | legacy/现有行为回归 | legacy `createBatch` 仍接受显式 localDate；v1/v2 迁移窗口交错、locked 删除、terminal CAS、artifact/Blob 删除回归不变 |

执行结果在实现完成后增量回填，不用重复排列全部 terminal、force、时区或日期组合。

### 6.1 执行结果

- P0 定向：allocator/repository/service 共 40/40 PASS。
- P1 archive 回归：allocator、UI contract、repository、controller、operation tracker、outbox、service、source snapshot 共 110/110 PASS。
- `npm run lint`、相关文件 `node --check` PASS；当时的 `git diff --check` 只覆盖工作区/末次补丁，不能证明 base→PR 全量通过，已由第二轮门禁取代。
- `npm run check:vars -- --include-minor` PASS，脚本未命中重要变量；另已人工按 ArchiveRepository/ArchiveService 审计血缘条目完成关联 review。
- 完整 `npm run release-check` exit 0：lint PASS；smoke PASS；unit 4816/4816 PASS（304 个测试文件，Node 测试 15177.643ms、runner 15214ms）；integration 48/48 脚本、2459/2459 断言 PASS（386135ms）。
- team-lead 最终 review：无 P0/P1、无入口旁路、无过度防御；独立复跑两个相关文件 34/34 PASS，git diff/status 边界正确。
- 本轮无 UI、目录物化或真实业务 action 接线，无新增 GUI 手动项；人工代码 review 由 team-lead 在未提交检查点执行。

## 7. PR #132 第二轮评论增量矩阵

| ID | 优先级 | 场景 | 最小关键断言 |
| --- | --- | --- | --- |
| R6 | P0 | artifact 登记完整性 | A ready、B 登记失败会留下带 id 的 failed artifact；task terminal 仍 incomplete 且保留 B 错误；同一 B 重试成功后才 complete |
| R7 | P0 | operation 删除幂等 | v2 terminal→delete→restart→replay 返回 `ARCHIVE_OPERATION_DELETED` 且不推进 cursor；legacy outbox 在删除/重启后 discarded、告警、释放源路径且不复活批次/自旋 |
| R8 | P1 | task retention undefined | 表驱动证明 undefined 使用 retentionDays/default；显式 null 或 retentionDays permanent 才永久，显式日期语义不变 |
| R9 | P1 | terminal API 契约 | 真实 PR1/PR2 调用均保持 positional；Spec §5.2 反向同步，不增加 object overload |
| R10 | P1 | 全 PR diff gate | 修复 Spec Markdown 行尾空白；以 base `63c1ce46357587643e506768f712352cbb6c7127` 对完整 PR 等价范围执行 `git diff --check` |

执行结果在实现门禁完成后增量回填；不重复排列不可达状态、terminal/force 组合、日期或时区组合。

### 7.1 执行结果

- 定向 allocator/repository/service/controller：61/61 PASS；首次扩大到 repository 时仅发现 schema inventory 陈旧，补入 `archive_operation_issuances` 后同范围复跑全绿。
- 相关 3 个生产与 4 个测试文件 `node --check` PASS；`npm run lint` PASS。
- base→working tree 完整 PR 等价范围 `git diff --check 63c1ce46357587643e506768f712352cbb6c7127` PASS；覆盖 12 个 PR 文件，并非仅检查本轮工作区或末次提交。
- blindspot pass 未发现会改变方案的存活问题；issuance read/replay 共用 per-record 失败边界，失败时 outbox 与源路径保持；非法 expected hash/size 不进入 failed-placeholder 恢复语义。
- 负责人独立 archive 8 文件 113/113 PASS、base→working-tree diff-check PASS；review 无 P0/P1、无过度防御或重复/不可达防御。
- 完整 `npm run release-check` exit 0：lint PASS、smoke PASS；unit 4819/4819 PASS（304 files，Node 测试 15377.901125ms、runner 15415ms）；integration 48/48 scripts、2459/2459 assertions PASS（394086ms）。runner-only policy timestamp/耗时 diff 已按 HEAD 精确撤回。
- 负责人独立 `npm run check:vars -- --include-minor` exit 0（3 个生产文件，自动无命中）；人工软复核 ArchiveRepository/ArchiveService/Controller 的 schema 幂等、序号不复用、Blob 删除顺序、业务/存档隔离，以及 controller IPC/retention/skipArchive/部分删除语义，未发现漂移。
- ⚠️ reconciliation 审计红线仍待人工：真实 terminal delete→restart→同 operation 被拒且不分新号；真实 outbox warning 可见并释放源路径；A/B artifact 的首次结果集合、模块归属与 ready SHA 在失败/恢复前后一致。以上不得以自动化 PASS 代替人工结论。

## 8. PR #132 第三轮评论增量矩阵

| ID | 优先级 | 场景 | 最小关键断言 |
| --- | --- | --- | --- |
| R11 | P0 | Position tombstone 后登记恢复 intent | 真实 repository/service/controller 在 terminal→delete→restart 后调用 `persistOperationIntent`，返回原 batch 的 `ARCHIVE_OPERATION_DELETED` 且 `persisted=false`；outbox 仍空，issuance/cursor 不变 |
| R12 | P0 | tombstone 查询时 DB 不可读 | 复用既有 DB unavailable→outbox→restart 场景；issuance read 抛错时 warning 可见并继续追加同一 outbox，DB 恢复后正常重放和释放源路径 |

### 8.1 明确反证与非目标

- 非法 artifact hash/size/role：Position 生产文件证据由主进程 pending parser、manifest 与文件快照生成，renderer/IPC 不暴露 raw archive sink；不增加 direct/internal 输入防御或测试。
- 显式 artifactKey 碰撞：生产 artifactKey 来自主进程生成的 Position descriptor，业务 IPC 不接受调用方直传 sink payload；不增加人为碰撞分支或测试。
- `retentionUntil:''`：Position intent 的 controller payload 固定读取已解析的 retentionDays 设置，不传 retentionUntil；不扩大既有字段语义。
- flush/delete 竞态：当前 `flushOutbox()` 只在 controller 启动初始化调用，运行期删除 IPC 不与其形成真实并发入口；与 R11 的实际 persist 旁路分开记录，本轮不修、不测。

### 8.2 执行结果

- R11 单项真实 SQLite：1/1 PASS。
- R11 + R12 最小失败边界：2/2 PASS。
- controller + Position lifecycle/UI 接线相关回归：81/81 PASS。
- archive 相关 8 文件回归：113/113 PASS。
- 中途修正 issuance read 错误边界后，相关 10 文件最终合并复跑：157/157 PASS。
- 保留原 outbox append 断言的最终 test-only 整理后，controller 复跑：19/19 PASS。
- 负责人最终 review：无 P0/P1、无过度防御；独立复跑 controller、Position lifecycle、renderer Position 三个文件 63/63 PASS。
- 相关生产/测试 `node --check`、`npm run lint`、base→working tree/当前增量 diff-check PASS；`npm run check:vars -- --include-minor` 自动无命中，另按 controller Important-skeleton 定义位置人工复核 IPC/preload、retention、skipArchive、重试及部分删除语义未漂移。

## 9. PR #132 第四轮评论增量矩阵

| ID | 优先级 | 场景 | 最小关键断言 |
| --- | --- | --- | --- |
| R13 | P3 | intent-recorded/durable crash pending 对应 archive tombstone 后 Position lazy recovery | 既有真实 repository/controller 删除返回 deleted；单一 helper 断言证明 deleted 返回全部 pending input，静态接线证明 durable 分支传入同一 deleted 结果；main 先清 pending 再交给既有 containment/protection cleanup |

### 9.1 执行结果

- R13 不新增重复端到端 case：复用既有真实 tombstone controller 用例，并在既有部分提交 fixture 增量断言 deleted cleanup candidates。
- durable crash 窗口复用同一 helper：最小 UI contract + lifecycle 35/35 PASS；含 controller、renderer Position 的相关回归 81/81 PASS；DB tombstone 读取失败不把 committed staging 纳入本次清理候选，不新增重复状态或重试排列。
- 既有 containment/protection 定向回归继续覆盖用户路径边界与受保护 staging，不重复物理删除排列。
- tombstone + cleanup candidate 定向：2/2 PASS；controller、Position lifecycle、renderer Position、archive UI 相关回归：81/81 PASS；既有 protection 定向：2/2 PASS。
- 相关 4 文件 `node --check`、`npm run lint`、base→working tree/current diff-check PASS；`npm run check:vars -- --include-minor` 自动无命中，人工复核 Position checkpoint/pending 与存档失败隔离边界未漂移。
## 6. PR2 范围

PR2 只覆盖 Spec §14 的任务生命周期、策略注册表、业务流程解析、worker context、12 个既有 archive primary scope 与现有业务 action 接线。VCC 财务 OP、工具箱、13+1、目录物化、存储迁移和 UI 仍由 PR3—PR6 负责。

## 7. PR2 P0 自动化矩阵

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| P0-PR2-01 | prepare 取消 | picker / 危险确认取消不调用 BOR、不预留批次、不执行业务 |
| P0-PR2-02 | 顺序与预留失败 | 严格 `BOR.begin → reserve → started → execute`；reserve/started 失败均不执行 handler/worker，BOR 必释放 |
| P0-PR2-03 | terminal CAS | success / failed / cancelled 只终结原批次；late success/cancel 不覆盖先到终态 |
| P0-PR2-04 | policy inventory | 每个 literal IPC 精确落入 reserve、带枚举原因的 exclude 或锁定的 PR3 exact handoff；未知、新增裸 action、wildcard 均失败 |
| P0-PR2-05 | registry 执行一致性 | reserve policy 只能走受控 lifecycle wrapper；exclude policy 不触发 reserve；query/picker/preview/cancel 原因准确 |
| P0-PR2-06 | 12 scope | 12 个 primary scope ID/code 唯一；`LINKED/PREFUNDTEMP/POSITIONLINK` 只作 alias，不增加可见 scope；不提前加入 VCC/toolbox |
| P0-PR2-07 | BusinessFlowResolver 新流程 | 无可证明 identity 时生成新 parent；相同月份/源文件也不复用；显式重新执行生成新 task/operation key |
| P0-PR2-08 | BusinessFlowResolver 继承 | 显式 parent 或已绑定稳定 businessRunId/operationToken 跨 resolver 重建后继承；跨 module/冲突 fail-closed |
| P0-PR2-08a | 历史 identity 首次接入 | 稳定业务 identity 查询成功但无 anchor 时建立并立即绑定新 parent；后续跨重启继承；查询失败仍 fail-closed |
| P0-PR2-09 | 结果后绑定 | runId 仅在业务成功结果后绑定到本次 parent/source batch；失败结果不伪造 anchor |
| P0-PR2-10 | worker context | context 可 structured-clone/JSON 序列化、冻结且只含 batch/task/module/parent/operation identity；worker 不 reserve |
| P0-PR2-11 | tracker 退化 | 只解析并追加当前 batch 文件；无 `createBatch`、pendingInputs、activeBatches、latest fallback 或跨 action 内存续接 |
| P0-PR2-12 | 业务成功、存档失败 | task 保持 succeeded，业务原结果原样返回，archive incomplete/持久重试告警独立记录 |
| P0-PR2-13 | 业务异常/返回失败 | thrown error 与失败结果均终结为 failed；输入/已产出文件按可得证据追加；批次不删除 |
| P0-PR2-14 | 取消 | active action 取消只 CAS 当前 batch 为 cancelled，不创建取消批次；无 active batch 时不猜 latest |
| P0-PR2-15 | 12 模块接线 | 每个现有 primary scope 至少一个真实 mutating action 在业务副作用前取得 batch context；文件 action 追加到本批次 |
| P0-PR2-16 | 平盘 operation token | 持久 pending / worker 恢复沿用同一 operationKey、batchId、parentRunId；checkpoint 与业务算法不变 |
| P0-PR2-17 | 大账号交互批次边界 | import preview / validation / cancel / 顺序提取均不 reserve；main 返回 opaque contextId；complete 消费一次真实 context 且只 reserve 一次 |
| P0-PR2-18 | 大账号源上下文边界 | renderer DTO 不含 filePath/fileRows；extract/complete 只回传 contextId + rowIndexes/assignments；fixed 从服务端 rowsWithEmptyBlocks 过滤；complete 保留数量、账号、币种校验并按 rowIndex 排序 |
| P0-PR2-19 | prepare 真只读与解析复用 | 收单缺失侧库不建目录/DB，既有侧库用 read-only handle 且不跑 DDL；网银 preview 缓存映射行，execute 不二次完整解析并在 reserve 前校验源新鲜度 |
| P0-PR2-20 | statement result classifier | execute 仅额外接受 `manual-balance-required`；`needs-selection`、`remember-order-mismatch`、`select-big-account`、`select-export-scope` 穿透时必须拒绝 |
| P0-PR2-21 | position run 危险替换确认 | selection 校验、已有 pending run 替换确认在 prepare 完成；prepare 只用 channels/months/status COUNT，禁止调用 `getBankRows` 全量解析；首调/取消 0 BOR/reserve/service.run；renderer 二次只提交 opaque `contextId + confirmReplace`；确认后 1 BOR/1 reserve/1 execute，execute 恰好一次全量读取且 classifier 不接受 `needs-replace-confirmation` |
| P0-PR2-22 | position source 两阶段边界 | picker cancel 与 account-only 预检/取消 0 BOR/reserve/DB apply；legacy ordinary 只生成 plan，streaming ordinary 停在既有授权屏障，均在 reserve/started 且 position outer operation 实际放行后恰好 apply 一次；mixed ordinary 成功不因账户取消回滚，账户确认沿用独立 `source:apply-import` batch；reserve/started 或 position outer callback 前失败清 worker/staging且 0 DB apply |
| P0-PR2-23 | 真实 worker 拓扑继承 | Pending 留底/default engine/legacy utility、BizOp utility/flow engine/legacy utility、Acquiring import engine/run-check/nested multiworker、Position bank/account/schema/maintenance worker 均继承同一父任务 context；Position ordinary source 的 `START_JOB` 不携带伪 context，只在既有 `APPLY_GRANTED` 屏障后注入；每个 worker 入口重建并冻结恰好 7 字段 DTO，禁止携带 `settleArtifacts` 或自行 reserve |
| P0-PR2-24 | Acquiring 崩溃恢复身份 | side 存在只读 side，否则读 legacy main；identity 精确包含 `source + monthKey + runId`；新格式 reopen 原 batch 且序号不增，legacy side/main 首次稳定 reserve/backfill、后续 reuse；busy 在 worker/reopen 前返回；worker 使用持久 context/chunkSize/offset/dbPath；side 成功才 upsert main mirror，main 不伪造 side |
| P0-PR2-25 | Position pending 恢复清理 | direct/outbox 共享 finalizer；archive durable/原 task terminal 后先同步 checkpoint/bootstrap，再精确 clear 当前 operation pending，最后按当前 pending files + committed operation inputs 重算并 best-effort 清未提交输入；失败或 ownership 改变不清理 |

## 8. PR2 P1 回归与人工检查

- 既有 archive repository/service/controller/operation-tracker 单测全绿。
- business operation registry、position operation lifecycle、worker pool/dispatch 契约全绿。
- 12 个模块原有 unit/integration/smoke 与 `npm run release-check` 全绿。
- P0 手工：取消至少一个文件选择和一个危险确认，存档中心运行次数不增加；执行一个成功和一个失败任务，均只出现一个预留批次且状态正确。
- P1 手工：抽查一个 worker 模块退出/取消路径和一个无文件状态动作；业务结果、原业务状态和输出文件内容不因 lifecycle wrapper 改变。
- 本 PR 不做 VCC 财务 OP/工具箱、目录浏览、存储地址、UI 布局和 Windows hardlink 验收。

## 9. PR2 执行证据

以下记录 PR2 自动化收口证据；GUI、真实 Electron 崩溃/重启及资金结果人工复核未执行：

- position interactive handler/lifecycle：7/7 PASS；TaskPolicyRegistry：13/13 PASS；覆盖 position outer 拒绝时一次 abandon、实际进入 callback 时正常执行且不 abandon。
- position service：66/66 PASS，覆盖 run prepare 轻量 COUNT/execute 单次全量读取，以及 legacy/streaming account-only、ordinary-only、mixed、账户取消/确认和 reserve 失败资源清理。
- position operation lifecycle + legacy import characterization + streaming import preflight：75/75 PASS。
- position side-DB integration：38/38 PASS。
- position renderer 既有契约：27/27 PASS；恢复必须使用 pending 原 `batchContext` 调用 `persistAppendIntent`，禁止 create/guess batch；旧 `persistOperationIntent` 字面量契约已退役。
- worker context + lifecycle/position 聚焦单测：175/175 PASS；覆盖 7 字段 structured clone/refreeze、Pending 真实留底 utility、BizOp 真实 utility、Acquiring run-check 与 nested M=1/2/4、Position source `START_JOB` 无 context / `APPLY_GRANTED` 有父 context，以及 bank/source/account/schema/maintenance 真实 dispatcher 链。
- TaskPolicyRegistry / main literal 接线：13/13 PASS；把 scoped direct handler 改为 lifecycle object handler 后，reserve/exclude/PR3 exact handoff inventory 仍精确一致。
- worker 引擎迁移集成：Pending 57/57 PASS、BizOp flow 65/65 PASS、Acquiring 45/45 PASS；default engine 与可达 legacy utility 均收到相同父 context，既有导入结果 parity 不变。
- Acquiring crash/resume P0-D + reviewer P1 聚焦单测：164/164 PASS（10 suites），其中直接受影响 lifecycle/policy 41/41 PASS；覆盖 side new-format 精确 batch identity/reopen、恢复不增全局序号、side 成功后 main mirror、legacy side/main 首次稳定 reserve/backfill 与第二次 reuse、busy 0 worker/0 reopen、worker 使用持久 7 字段 context 且 `dbPath/chunk offset` 不变；同时锁定 stale legacy existing 在 freshness 失败时 0 recover/0 fail，以及同 runId 跨月、legacy main/side result identity 与 flowPlan 一致。
- Acquiring 恢复集成回归：engine migration 45/45 PASS；side-DB parity 19/19 PASS；side 存在只恢复 side，否则恢复 legacy main，main source 不伪造 side mirror；runCheck SQL/算法/checkpoint/事务与金额币种语义未改。
- 静态边界：`npm run lint` PASS；相关生产/测试文件 `node --check` PASS；`git diff --check` PASS；受测 worker 入口中无 `reserveTaskBatch` / `reserveBatch` / `createBatch`，消息/job metadata 中无 `settleArtifacts`。同步 main-thread fallback 不是 worker 边界，不人为增加消息协议；Acquiring compatibility identity 明确包含 `source + monthKey + runId`，不使用月份/hash fallback。
- Position P0-E 六文件聚焦回归：169/169 PASS；archive center UI contract 18/18、renderer 27/27 均全绿，覆盖 `settleArtifacts → settlePositionArchiveResult → return` barrier、direct/outbox 复用同一 finalizer，以及 `settle original task → checkpoint/bootstrap → clear current pending → cleanup uncommitted inputs` 顺序。
- Position P0-E 行为回归：streaming preflight、interactive admission、legacy import characterization、TaskLifecycle 合计 87/87 PASS；side-DB parity 38/38 PASS；pending/提交凭证损坏或 ownership 改变继续 fail-closed，cleanup best-effort 不覆盖已完成恢复。
- Position P0-E inventory/静态门禁：TaskPolicyRegistry + module scope 17/17 PASS；`npm run lint`、相关 `node --check`、`git diff --check` PASS。12 primary scope、literal IPC 与 reserve/exclude/PR3 exact handoff inventory 无旁路。
- PR2 完整 unit 首轮：4906/4908；仅两项陈旧测试失败。修复后原失败文件 13/13 PASS、直接相关 9 文件 90/90 PASS：Position result-import 生产已走统一锁，仅静态断言未容忍换行；DuplicateInbound 生产注册正常，仅抽取 harness 缺少 `ipcMain` 且仍按旧函数 handler 执行。测试现复用真实 prepare/execute contract，picker 取消保持 0 execute/0 lock；本收口未改生产。
- 完整自动门禁：`npm run release-check` exit 0；unit 4908/4908；48 个 integration 脚本 2459/2459；smoke、lint PASS。integration runner 只在全绿时自动更新 `rules/integration-test-policy.md` §七，本次生成清单作为证据保留。
- 提交前变量检查：`npm run check:vars -- --include-minor` exit 2（命中需 review）；Critical 5、Important-skeleton 8、Runtime-state 9、Risk-sensitive 3、Minor 4 已逐项对照 `rules/important-variables.md`。资金算法、金额/币种、行过滤、输出列、模板保留 ID/前缀、错误 schema 和一次性迁移未改；真实变化为 TaskLifecycle、opaque context、worker batch context、freshness 和精确恢复接线。
- Windows CI runner follow-up：run `31360364725` 的 smoke 已 PASS，unit 在启动测试前因 314 个绝对路径参数触发 `spawn ENAMETOOLONG`；runner 现只把同一文件列表按原顺序转为仓库相对参数，并以仓库根为 child cwd，仍只执行一次 `node --test`。直接测试 11/11 PASS；独立完整 `npm run release-check` exit 0：lint/smoke PASS、unit 4909/4909、48 个 integration 脚本 2459/2459（总耗时 399674ms）；语法和 diff check PASS。
- 未完成人工验收：真实 Excel/WPS bill-split 币种/合并结果、Position account-only/mixed/替换 pending GUI 路径、worker 退出/取消抽查，以及 Acquiring side/legacy 的真实 Electron 崩溃重启、offset/main mirror/序号核对。自动门禁通过不替代这些人工项目。

## 10. PR #133 九条 P1 评论计划矩阵

以下是 review 修复的最小计划与执行矩阵；当前自动证据见 §10.3。每项对应真实入口或明确持久状态，不排列不可达组合。

| ID | 优先级 | 真实场景 | 最小关键断言 |
| --- | --- | --- | --- |
| R14 | P1 | terminal CAS 首次非 benign DB write failure | repository.getBatch/settings getSetting 同时不可用时，业务只执行一次且 terminal-only intent 仍写入 filesystem outbox；重启 flush 不建新 batch，原 batch 达到目标终态、outbox 移除 |
| R15 | P1 | fresh acquiring invalid admission / 月锁争用 | 两个代表场景均在 BOR/reserve/worker 前返回，issuance/cursor 不增；正常执行的锁由 execute finally 释放，abandon 路径释放一次 |
| R16 | P1 | acquiring run → export → 重启 → 重复 export | side 与 legacy main 各以 prepared exact evidence 取得同一 run identity/parent；重复 export 不产生 flow-bind conflict；side 证据不唯一或不匹配时 0 copy/0 reserve |
| R17 | P1 | Position recovered terminal conflict | wanted/actual 相同幂等成功；选一个不相同代表直接 fail-closed，checkpoint/pending 均保留且不清 staging |
| R18 | P1 | Position worker 写命令缺 batchContext | 表驱动覆盖 BANK_APPLY、ACCOUNT_APPLY、DELETE_BANK、DELETE_SOURCE、REBUILD_FUND_TRANSFER_MAPPING，均在打开/修改 side DB 前 fatal；普通来源缺 context 的 mutating APPLY_GRANTED 零提交；BANK_PREPARE/schema-only/preflight-only 既有豁免保持 |
| R19 | P1 | scenario bundle 在 read/parse 窗口替换 | read 前 evidence 属于 A，parse 后文件变为 B 时 context create 拒绝；未替换时 apply 仍归档/应用同一路径证据 |
| R20 | P1 | 大账号 assignments `[0,0]` 对服务端 expected `[0,1]` | 返回 `BIG_ACCOUNT_SELECTION_INVALID`，不进入生成/Map；既有乱序 `[1,0]` 仍排序为 `[0,1]` |
| R21 | P1 | statement duplicate/hash 选择窗口替换选中文件 | picker paths guard 每次确认返回先 recheck、再处理 response/replacePaths；resolver 返回后再 recheck 以覆盖无 modal 的 hash 窗口；final paths guard 供 preview/beforeStart，已移除输入不再影响 execute |
| R22 | P1 | acquiring side worker 成功、main mirror 前崩溃后 resume | 预置上一轮 stale main mirror；真实 side complete context/outputs 恢复 0 worker、0 新 issuance，以 canonical upsert 替换 stale mirror，原输出登记到原 batch并终结 succeeded；第二次 exact no-op |

### 10.1 聚焦与综合门禁

- Phase A：archive lifecycle/controller/repository、task policy/flow resolver、acquiring run-data/worker-pool 与 main handler contract。
- Phase B：Position operation lifecycle/worker child boundary、scenario context store、statement preview/duplicate selection。
- Phase C：大账号/statement generation pipeline、Acquiring side-DB parity、Position side-DB parity，以及完整 unit/integration/smoke/lint。
- 静态门禁：所有涉及生产/测试文件 `node --check`、`git diff --check`、ESLint；生产 worker 继续无 reserve API，runCheck SQL/offset/checkpoint/事务与 Position checkpoint 不变。

### 10.2 人工门禁（自动测试不替代）

- ⚠️ 资金红线：用两个 statement block 的真实 Excel/WPS 文件确认 `[0,0]` 被拒后没有生成错误 MerchantId/Currency 输出，正常 `[0,1]` 输出行数、金额与币种不变。
- Acquiring Electron：在 worker 成功写出两份文件后、main mirror/archive terminal 前强制退出；重启后从原 run 恢复，核对原批次号、parent、输出 SHA/行数与 main mirror，不出现第二 run/batch。
- Position GUI：恢复目标终态与现有终态冲突时保留 pending 和可见失败；正确同终态重放后才清 pending/checkpoint bootstrap。

### 10.3 当前自动证据（2026-08-11）

- R14：TaskLifecycle/controller/outbox 聚焦覆盖同 operation files+terminal merge、DB read failure 下 terminal-only filesystem persistence、Position route token、同/异终态 replay，以及 artifact→CAS→finalizer→remove 顺序。
- R15/R16/R22：completed side 组合用例使用真实 repository/service/controller/tracker/lifecycle，断言 0 worker、stale mirror 被 canonical upsert 替换、第二次 exact no-op、原 batch succeeded、两份 output artifacts ready、issuance 不增。
- R17-R19/R21：Position worker/operation/service、scenario context、statement selection 聚焦 151/151 PASS；首轮唯一失败为绕过 lifecycle 的陈旧 service 夹具，改走真实 prepare/execute + batchContext 后全绿，未放宽生产约束。
- R20：statement big-account 11/11 PASS，唯一重复 index 反例与正常乱序共用同一行为测试。
- Final review follow-up：R14/R21/R22 直接三文件 49/49 PASS，相关 outbox/lifecycle/policy/run-worker 四文件 66/66 PASS；`node --check`、lint、diff check 全绿。
- Final gate check-vars：exit 2，仅 Critical `FileValidationError` / `unmatchedRows`；自动证据锁定 assignment 错误 code、Acquiring summary/mirror/原 batch，完整 release-check 的 smoke 用于清单必跑，真实 statement 资金输出仍按 §10.2 人工复核。
- 最终 12 个实际改动测试文件合跑 273/273 PASS。完整门禁首轮 lint/smoke PASS、unit 4921/4922；唯一失败是静态契约仍按旧 Position finalizer 函数名截取源码，最小对齐现行 `finalizePositionTerminalIntent` 后未改变生产行为。
- 修正后单一 session `npm run release-check` exit 0：lint/smoke PASS；unit 4922/4922（314 files，0 fail/skip）；integration 48/48 scripts、2459/2459 assertions PASS（304260ms）。runner 自动刷新 `rules/integration-test-policy.md` §七 timestamp/timings，脚本与断言数未变，按全绿生成证据保留。
- Windows Actions run `31416514064` 首轮 smoke PASS、unit 4920/4922（fail 1、expected platform skip 1）；唯一失败是本文件的静态顺序测试以 LF 字面量查找 final accepted-path guard，在 CRLF checkout 下索引为 `-1`，属于测试可移植性问题而非生产回归。改为行尾/缩进无关 regex 后，仍锁定 resolver → selection freshness → status → `createPreviewSourceFreshnessGuard(selectionResult.filePaths)` 的同一顺序；未改生产或增加平台分支。
- CI follow-up 本地证据：单文件 11/11、12 个改动测试文件 273/273、lint/node/diff check PASS；单一 session `npm run release-check` exit 0，unit 4922/4922（314 files，0 fail/skip），integration 48/48 scripts、2459/2459 assertions PASS（283436ms）。runner 生成清单仅刷新 timestamp/timings，48/2459 不变并继续保留。
- 相关生产文件 `node --check`、`git diff --check` PASS。§10.2 人工门禁仍待执行，不以自动证据替代。

## 11. PR2.5-0 合同冻结验证

### 11.1 计划矩阵

| ID | 类型 | 场景 | 关键断言 |
| --- | --- | --- | --- |
| DOC-01 | P0 | raw source 身份 | Spec/TechDoc raw SHA 与权威值一致；document version/date/source filename 完整记录 |
| DOC-02 | P0 | 仓库化 normalization | 只把两份文档各 6 个 metadata hard-break 改为 `<br>`；应用同一只读 normalization 后与仓库副本完全一致 |
| DOC-03 | P0 | 双合同关系 | erratum 索引、v3.1.8 PRD 和 v3.1.9 erratum 链接均存在；Spec 与 TechDoc 明确配套 |
| DOC-04 | P0 | 历史发布不被追溯改写 | `changes/3.1.8/spec.md` 仍为冻结 SHA `1f5f0663...`，release-docs 定向测试保持全绿；v3.1.8 `6/6 PASS` 只作为历史事实 |
| DOC-05 | P0 | v3.1.9 窄 erratum | 仅 VCC 归档兼容、操作保护、性能路径被补遗取代；C01—C14、PR1/PR2、金额币种和五表计算保持不变 |
| DOC-06 | P0 | 严格串行顺序 | normative schedule 与 tasks 均为 `PR2 → PR2.5-0 → PR2.5-A → PR2.5-B → PR2.5-C1 → PR2.5-C2 → PR3-VCC → PR3-Toolbox → PR4 → PR5 → PR6 → PR7`；当前规范计划不再保留合并 PR3 条目，历史/来源事实不重写 |
| DOC-07 | P1 | 历史证据增量维护 | preflight/notes/test-spec/tasks 的 PR1/PR2 证据仍保留；PR2 manual pending 仍未勾选 |
| DOC-08 | P0 | 发布 PROBE | 真实 fixture、目标旧库/trigger、Windows runtime、16 GB 和财务人工均明确未完成；失败不得放宽 classifier/guard 或引入 fallback |
| DOC-09 | P1 | docs-only 边界 | `src/`、`tests/`、`CHANGELOG.md`、`docs/USER_GUIDE.md`、`docs/VERSION_FEATURE_HISTORY.md` 零 diff |

### 11.2 本 PR 已执行证据

- DOC-01/DOC-02：raw SHA、repository copy SHA 与冻结 Spec SHA 均与索引一致；两份 raw source 各检出 6 处 metadata hard-break，只读应用 `两个空格+换行 → <br>+换行` 后与仓库副本 2/2 无差异，仓库副本无行尾空白。
- DOC-03：九个范围内文档的本地 Markdown 链接 17/17 可解析；索引、PRD 和 v3.1.9 Spec 均可到达配套 Spec/TechDoc。
- DOC-04：`node --test tests/unit/vcc-financial-op-release-docs.test.js` 5/5 PASS；冻结 `changes/3.1.8/spec.md` 零 diff。
- DOC-05—DOC-08：精确文本与人工 diff review 确认窄 erratum、严格顺序、PR2 manual pending 和 fail-closed PROBE 均保留；blindspot/reconciliation pass 未发现需新增防御、兼容矩阵或资金自动化结论。
- DOC-09：tracked 与三个新文档分别通过 Markdown diff-check；`src/`、`tests/` 和三份发布用户文档零 diff。本 PR 未运行完整 `release-check`，不得把历史 PR1/PR2 的完整门禁证据当作本 PR 新执行结果。
- 提交前 `npm run check:vars -- --include-minor`：负责人执行 exit 0；因 HEAD+working tree 的 `src/` 无改动而 skip，零变量命中，无需关联功能 review。

以下项目仍是计划/发布 PROBE，不得因上述文档检查而标记完成：PR2 人工验收、A/B/C1/C2 实现、真实 v3.1.7 fixture、目标生产库 legacy-four/trigger inspect、约 16 GB 性能、Windows packaged runtime `createSession/readOnly/query_only/UPDATE FROM` 和财务人工复核。

## 12. PR2.5-A 兼容合同测试矩阵

### 12.1 最小自动矩阵

计划固定 10 个 top-level `node:test`；不同资金/血缘不变量使用一个 table-driven block，各一个代表，不建立组合矩阵或在 validator/classifier/SQLite 三层重复同一错误。

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| A-01 | P0 | result evidence | 合法 current 调整 | rowKey/metadata/sequence/revision/base formula/九币种全有效，effective balance 加入调整 |
| A-02 | P0 | result evidence | 独立 violation table | revision/count、sequence 断裂、rowKey 缺失、基础行 metadata 缺失、调整 metadata、currency、base formula、九币种各一个代表 |
| A-03 | P1 | result evidence | 稳定输入 | 数组稳定排序、同 evidence 结果确定 |
| A-04 | P0 | classifier | current-five + adjustment | archive 按 effectiveCalculatedBalance 通过 |
| A-05 | P0 | fixture/classifier | 真实 tag fixture → current migration | exact four、SQL NULL fingerprint、revision/adjustment/Pending 0、九币种一致，分类 legacy |
| A-06 | P0 | fixture/classifier | 真实 fixture 副本单一 Pending fact 残留 | inconsistent/fail-closed，不改 tracked fixture |
| A-07 | P1 | classifier | revisions JSON key order | 语义对象键序不影响 current/legacy 分类 |
| A-08 | P0 | classifier | legacy NULL 与 empty fingerprint | NULL 通过；空字符串 inconsistent；通用 validator violation 只做一条 inconsistent 断言；base archive 反例只在 current effective 用例断言一次 |
| A-09 | P0 | gate | 固定优先级 | inconsistent → active → unresolved → later → allowed |
| A-10 | P0 | orthogonality | 同一 legacy contract + gate state | classifier 不变；active/unresolved/later 只改变 gate code/canUnarchive |

### 12.2 Phase 0 原型证据

- 首次 tag importer 三明细失败：测试工作簿方向使用中文“入/出”，真实合同只接受 `in/out`；分类为测试设计错误，修正输入后重建 temp DB 通过，生产代码未改。
- 成功链：tag migration → inspect/import 四类 → opening balances → calculateMonth → archiveRun → close/reopen；current VCC migration → close/reopen。
- 依赖：tag/current lock 除根版本号外等价；实际解析 xlsx 0.18.5、sax 1.6.0、yauzl 3.3.0、buffer-crc32 0.2.13、pend 1.2.0。
- ⚠️ 本机自动证据只证明合同实现和 fixture provenance，不替代真实生产 legacy 副本、主体×九币种、跨月血缘、Windows packaged runtime、16 GB 或财务人工复核。

### 12.3 执行顺序

先运行三个新增测试文件的聚焦门禁并分类所有失败；收敛设计后再运行相关 `node --check`、`npm run lint`、聚焦回归、`git diff --check` 和 `check-vars`。负责人 diff review 前不运行完整 `release-check`；若后续运行导致 integration policy 自动变化，先报告并等待裁决。

### 12.4 当前自动证据

- 首次聚焦：10 个 top-level、含 A-02 七个 table-driven 子项，共 17/17 PASS，0 fail/skip/cancel；本轮无生产回归、陈旧测试或测试设计错误。Phase 0 首次中文方向失败已单独归类为测试设计错误。
- sequence DTO 复核后改为从全部 raw adjustments 独立计算 `adjustmentSequenceMax/sequenceContinuous`，避免 rowKey/metadata 失败提前影响 sequence 摘要；修正后聚焦仍 17/17 PASS。
- manifest 的 tag/commit、SQLite、依赖、schema/counts、run/revisions、主体九币种、DB SHA 与 current migration shape 均在真实 fixture 正例内校验；SQLite 变异只保留一个 Pending effective fact 反例。
- `node --check` 覆盖四个生产模块、生成器、helper 和三个测试文件；`npm run lint`、`git diff --check`、聚焦回归均 PASS。
- `npm run check:vars -- --include-minor` exit 2，仅 Runtime-state `state` 一项；人工核实只命中两个 reason/code 字符串，renderer 全局 `state` 定义、子字段和重渲染链零改动，无真实关联功能变化。
- Root diff review P1 修复后，A-02 增加一个物理 NULL `source_type` 的基础行 metadata 代表，断言 builder 不抛且 validator 记录 `invalid-run-row-metadata`；A-08 同一通用 violation 断言确认 classifier 结构化归 `inconsistent`，不增加 SQLite/第二层独立用例。A-05 现有正例增加当前 generator SHA 与 manifest provenance 对比。
- Review 修复首次聚焦 17/18；唯一失败为新增 classifier 断言错误地要求单一 reason，而基础行缺失还会真实触发 archive 金额 mismatch，属于测试设计错误。改为只断言 review 所需的 `inconsistent` 与包含 `effective-run-result-invalid`；生产分类逻辑未变。
- 修正后聚焦 18/18 PASS，top-level 仍为 10 个；相关 `node --check`、lint、diff check 均 PASS。check-vars 结果与修复前一致，仅有 reason/code 的 Runtime-state `state` 同词命中，无代码变量变化。
- 手工错配 `run.targetMonth` 的反例在 B loader 接线前无真实生产调用链；不增加 A 层 guard/test，B 按 `target_month/run_id` 分组时复核。
- 完整门禁首轮 lint/smoke PASS、unit 4940/4940，integration 47/48；唯一失败是既有大文件拆分 RSS 绝对上限样本 `[150,135,135]MB` 中首项恰等于严格 `<150MB`。独立原脚本复跑 31/31，tier2 `[137,133,137]MB`；分类为环境边界采样，未修改阈值、测试或生产代码。
- 第二轮单一 session `npm run release-check` exit 0：lint/smoke PASS；unit 4940/4940（317 files，0 fail/skip）；integration 48/48 scripts、2459/2459 assertions（311123ms）。runner 仅在全绿后自动刷新 `rules/integration-test-policy.md` §七 timestamp/timings，48/2459 不变并保留生成证据。
- ⚠️ 自动门禁不替代真实生产 legacy 副本、主体×九币种、跨月血缘、Windows packaged runtime、16 GB 和财务人工验收。

## 13. PR2.5-B 读取性能测试矩阵

### 13.1 最小自动矩阵

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| B-01 | P0 | schema/read DB | schema 缺失与 current-ready；readOnly 代表 DML | 缺表/列返回 `vcc-schema-not-ready`；现有 PK/index 通过；query_only/foreign_keys/busy_timeout 生效；DML readonly 拒绝 |
| B-02 | P0 | set loader | current + active + inconsistent | current 可枚举/token v2；active batch 只改变 gate；破坏 archive 后月份排除并返回结构化 diagnostic |
| B-03 | P0 | token v2 | canonical 顺序与 generation | 集合重排 token 不变；generation 变化 token 必变；不含 taskActive/opening/source facts |
| B-04 | P0 | SQL shape | archive 0/1/100 候选 | 均固定 10 SQL；零 import rows/opening；Pending facts 从 candidate 走现有 month/source covering index、禁止 fact scan |
| B-05 | P0 | active visibility | opening/orphan effective/importing/unresolved | 月份全部可见且倒序；effective 使用现有 covering index |
| B-06 | P0 | delete evidence | 一次 target set 与单 target refresh | 完整 targets 固定 9 SQL；同 evidence+target token 一致；有效 facts 分组不建临时 B-tree |
| B-07 | P0 | worker allowlist | unknown action + 不存在 DB path | 开库前返回 `invalid-vcc-read-action` |
| B-08 | P0 | real worker | migrated v3.1.7 fixture | legacy 可枚举/preview；10/13 SQL；DB SHA 不变；小 fixture worker <500ms、main lag <100ms |
| B-09 | P0 | service cache | active month generation cache | 同 generation 复用；任一写任务 release 后失效重读 |
| B-10 | P0 | freshness | read 返回期间 active identity 改变 | Main 返回 `state-changed`，不消费陈旧 DTO |
| B-11 | P0 | export wiring | 初次读取 + runDirectTask 内重查 | 两次均使用 `list-archive-months`，第二次绑定既有 active task identity |
| B-12 | P0 | real legacy export | migrated v3.1.7 fixture → service → writer | 初读与租约内重查都得到 legacy contract，runId 精确传给既有 writer |

补充合同证据：renderer 静态/函数级测试锁定 shell 在 backend await 前挂载、月份/归档 loading 和 skeleton、inline retry、target change 零 preview IPC，1000 次七目标 cache 切换 <50ms。生产 v2 preview → 旧 v1 write 只保留一条真实 delete 链，断言 `state-changed`、三张业务表不变且无 success evidence；旧 v1 write 成功/取消/保护测试显式调用 legacy helper，不再代表生产入口。

### 13.2 性能证据口径

- `scripts/perf/vcc-financial-op-read-performance.js` 只接受现存数据库路径，以同一 read worker 输出首次/后续样本、worker/main P50/P95、main lag、SQL trace/query count 与 WAL 前后字节；不运行 migration、不写报告文件、不产生业务 DML。
- migrated tracked legacy 小 fixture 本机观测：archive 10 SQL、active 1、unarchive 13、delete 9；worker P95 分别约 2ms、0.2ms、3ms、1ms，main max lag约 2ms，WAL 0 增长。该数值只作 gross regression，不是约 16 GB 或 Windows packaged 验收。
- 硬门禁保持 archive/preview 500ms、delete 2s、main lag <100ms；真实约 16 GB Windows installer/portable 的冷/热 P95、WAL 和 UI shell 仍是发布 PROBE，失败不得加 retry、放宽阈值或回退 Main 同步读取。

### 13.3 人工门禁（自动测试不替代）

- ⚠️ 财务人工必须复核真实主体 × 九币种、调整后有效余额、current/legacy 导出、跨月尾月依赖和备份恢复；本 PR 未改变金额/币种算法，也不据此关闭资金门禁。
- Windows installer/portable 必须验证 read worker 路径、`readOnly/query_only/BEGIN DEFERRED` 和关闭行为。
- 目标生产库副本必须只读检查 legacy/trigger shape；非 exact current/legacy 保持 inconsistent，不增加 fallback。
- B/C1 intermediate non-release；C2 在 `BEGIN IMMEDIATE` 内同源重算 v2 前，生产解归档/删除保持 fail-closed，不作为最终用户行为。

## 14. PR2.5-C1 写保护测试矩阵

### 14.1 最小自动矩阵

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| C1-01 | P0 | runtime/guard | createSession、空 changeset、trigger 间接写、total、close | 能力一致；不可信统一 `mutation-guard-unavailable` |
| C1-02 | P0 | schema/policy | exact 19 表、PK、trigger、四张大表 | 未知表 `vcc-schema-not-ready`；未批准 trigger `vcc-trigger-policy-violation`；大表不建 session |
| C1-03 | P0 | registry/budget | 七个 registered step table-driven mismatch | 每个 `.changes` 不符立即失败；未登记 step/大表 step/额外写失败关闭 |
| C1-04 | P0 | adjustment | current locked plan | 只写 adjustment+run，固定 total=2，revision/provenance/唯一 adjustment 精确 |
| C1-05 | P0 | archive | current locked plan | N+7；五 dataset、run、N archives、success audit；A effective balance/九币种精确 |
| C1-06 | P0 | legacy | 真实 legacy fixture 变异 calculated，两 action table-driven | token 重算后、plan 前 `result-recalculation-required`；业务/audit 0 DML |
| C1-07 | P0 | audit | safe failure + audit-only fault | 原事务先回滚；成功只写 1 audit；audit 失败仍抛原错误且零 fallback |
| C1-08 | P0 | unsafe | trigger 与业务连接 createSession 代表 | 精确错误码；业务/success/failure audit 全 0 |
| C1-09 | P0 | worker | unknown/cancel/schema/context | unknown 开库前拒绝；critical 前可取消；ACK 后零 migration；七字段缺失/精确 refreeze |
| C1-10 | P0 | service claim | action/generation/identity/critical/release | protected 先于 ACK；进入后不 terminate；重复 terminal 只 release/推进一次 |
| C1-11 | P0 | production chain | read preview → adjustment → refetch → archive | 两次均 dedicated worker+claim；token/generation 更新；provenance/success audit 精确 |
| C1-12 | P1 | renderer/IPC | payload/progress/refetch/legacy | action token+generation；listener finally 退订；成功 refetch；legacy 明确提示 |

相同 rollback/audit 语义只保留一个代表；不建立 step×故障笛卡尔积，不为 renderer/IPC 不可达 payload 增加反例，也不把旧 helper 测试误写成 production C1 证据。

### 14.2 性能证据口径

- `scripts/perf/vcc-financial-op-result-write-performance.js` 只接受离线数据库副本和 calculated run ID；输入存在非空 WAL 时失败关闭。每个样本先复制副本，再由 read worker 取 archive token、dedicated write worker 执行，报告 worker P50/P95、main event-loop lag、WAL 和 progress phase；输入 SHA 必须不变。
- 脚本静态断言 C1 result-write 不引用旧 `snapshotResultMutationState/assertResultMutationStateUnchanged`，Service 不调用 `archiveRun/addRunAdjustmentToDb`。本机 current 小 fixture 五次 archive：worker P95 `75.549ms`，main lag P95/max `2.077ms`，WAL `0→0`。
- 硬门禁保持 adjustment/archive P95 ≤2s、main lag P95 <100ms。上述小 fixture 只作 gross regression；真实约 16 GB Windows installer/portable 冷热 P95、WAL 和 UI 响应仍为发布 PROBE，失败不得加 retry、放宽阈值或回退 Main 同步写。

### 14.3 当前执行证据与人工门禁

- guard/result-write/write-worker/claim/service 聚焦最终 36/36 PASS；renderer/preview/usage 44/44 PASS；B read 相关 47/47 PASS；A/B/C1 与 renderer 扩大聚焦 110/110 PASS。首次失败分类只有两个 test design（同步 fail-closed 误用 async 断言）和一个 stale test（`getRunResult` 改 async 后仍同步读取），无 production regression。
- 当前 production 调用图只允许 `renderer → preload/main → Service claim → vcc-financial-op-write-worker → result-write → registry → SQLite`；旧 calculator/result-adjustments DML 仅作 legacy/offline helper 保留。
- C2 不在本矩阵：unarchive/delete 仍是 v2 preview → 旧 v1 write fail-closed；不做 bridge、plan 或生产接线。
- 首次完整门禁 lint/smoke、unit 4972/4972 通过，integration 46/48；两项失败精确分类为陈旧集成测试合同，未改生产、阈值或 retry。机械迁移 async review、真实 preview token/generation、写后 refetch 与 v2 digest audit 后，调整归档链 209/209、历史模板导出链 29/29 PASS；renderer/IPC 不可达的 archived direct-Service write 重复断言按冻结 non-goal 删除，未固化额外 Service 错误码。调整链 297→209 来自完整 effectiveRun audit 被 TechDoc 冻结 digest 摘要替代后移除九币种×多字段重复 audit 断言，资金金额仍由 refetch/archive DB/Excel 三层覆盖；历史链 28→29 增加写后 refetch，故总数 2459→2372，不是门禁弱化。
- 第二次且最终单一 session `npm run release-check` 全绿：lint/smoke PASS，unit 4972/4972（324 files），integration 48/48 scripts、2372/2372 assertions；runner 只在全绿后自动同步 policy。
- ⚠️ Windows packaged runtime session/changeset/total/close、目标生产 legacy/trigger、约 16 GB 冷热性能，以及真实主体×九币种、调整后 effective balance、跨月期初、审计和备份恢复仍须人工完成；自动测试不替代资金红线。

## 十五、PR2.5-C2 解归档/删除测试矩阵

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| C2-01 | P0 | policy/guard | C2 large-table scope | operation+registered step+scopeId+preCount/budget exact；四大表无 session；C1 仍零大表 step |
| C2-02 | P0 | unarchive | current/real legacy production entry | 锁内 B v2 exact compare；current `N+7`、legacy `N+6`；legacy 不造 Pending |
| C2-03 | P0 | result/opening | 五 child 独立删除 | `1+R+ΣC` / `1+R+ΣC+O`；不依赖 cascade；`first_month` 只读 |
| C2-04 | P0 | detail | Q/E/D/M 固定 scope | `2+R+ΣC+2Q+E+D+M`；先逐字段物化再清 FK/删事实；D=0 不造 dataset；非目标行保留 |
| C2-05 | P0 | system | B/A/S/D/M 固定 scope | `2+R+ΣC+B+2A+S+D+M`；缺 accepted 精确补 B；物化 A 后 FK 为 NULL；最终语义 accepted 恰好一条 |
| C2-06 | P0 | source invariant | M=0 / deletionId | M=0 整事务回滚+单一 safe audit；deletionId 只用 boundary/returned ID 后置核对 |
| C2-07 | P0 | failure | stale / 中途 fault / unsafe trigger | state-changed 零业务删除；唯一中途 fault 恢复五 child/run；unsafe 零 DB failure audit |
| C2-08 | P0 | worker/service | dedicated route/claim/context | generic worker 无 destructive action/migration；同一 claim/protected/cancel/release；context 为 null 或 exact 7-field refreeze |
| C2-09 | P1 | renderer/IPC | 既有 progress channel | main 转发 unarchive/delete；renderer 按 action 过滤、复用现有状态文案、finally 退订 |
| C2-10 | P0 | integration | 真实 v2 preview→Service→worker | current 跨月 gate/unarchive/result/opening/detail/system；detail Q=1，system B=1/A=1，审计血缘不丢 |

代表性故障不扩展为 step×failure 笛卡尔积；不为 direct Service 伪造、renderer/IPC 生产不可达 payload 增加 guard/test。本机聚焦 195/195、destructive integration 77/77 只是功能/gross evidence。约 16 GB P50/P95/WAL/main lag、Windows packaged `UPDATE ... FROM`/session runtime、目标生产 trigger/legacy 和资金人工复核仍是 PROBE，不得由局部 PASS 关闭。

- 首次完整门禁 lint/smoke、unit 4984/4984 通过，最后一条 historical integration 因 legacy helper 生成 v1 token 而失败，分类 stale integration test；仅机械迁移到真实 `service.previewUnarchive` v2 token/taskGeneration → `service.unarchiveMonth` → 写后 refetch，单脚本 29/29 PASS，未改生产或重试首次 full。
- 第二次且最终单一 session `npm run release-check` exit 0：lint/smoke PASS；unit 4984/4984（325 files，0 fail/skip）；integration 48/48 scripts、2385/2385 assertions（295658ms），其中 destructive 77/77、historical 29/29。runner 仅在全绿终态自动同步 policy §七。

## 十六、PR3-VCC TaskLifecycle 测试矩阵

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| VCC-L01 | P0 | policy/scope | literal inventory | 独立 `vcc-financial-op/VCCFINOP`；既有 VCCOP 不变；11 reserve、15 exclude、toolbox 3 handoff exact |
| VCC-L02 | P0 | lifecycle | reserve/start failure | BOR 后 reserve；reserve/started 失败均 0 execute/0 worker，原序号保留 |
| VCC-L03 | P0 | context | generic/dedicated worker | 生产 reserve 链 required exact7；Service freeze、worker refreeze；read worker 无 context |
| VCC-L04 | P0 | flow | run/import/record/delete | calculate/import 新 parent；run/record 稳定 identity 续接；result delete 仅 prepared 唯一 runId 续接 |
| VCC-L05 | P0 | artifact | 五类 import | 只登记 success/success_with_skips/all_skipped 对应实际源文件，失败组不登记 |
| VCC-L06 | P0 | artifact | result/data/audit export | 保存对话框在 prepare；取消 0 BOR/reserve；登记 writer 返回的全部输出 |
| VCC-L07 | P0 | metadata | opening/adjust/archive/unarchive/delete | 建批并写终态/metadata，不强制空物理目录 |
| VCC-L08 | P0 | cancel | pre-critical/protected/late | pre-critical CAS 原 batch cancelled；protected 等业务终态；late cancel 不覆盖 |
| VCC-L09 | P0 | terminal | crash/CAS | worker crash failed；first-terminal-wins；取消不建第二批次 |
| VCC-L10 | P0 | outbox | artifact/terminal persistence fault | 业务终态与 archiveStatus 分离；intent 复用原 batch/parent/operation key，reserve 仍一次 |
| VCC-L11 | P1 | renderer/archive UI | module filter | VCC 财务OP作为 primary 出现在存档筛选，业务 UI/路由不变 |
| VCC-L12 | P1 | funds regression | 九币种/revision/跨月/审计/export | 既有 C1/C2 guard、金额币种、adjustment、归档/解归档/delete 和 Excel 合同不变 |

当前自动证据：VCC/Archive 扩大聚焦 unit 460/460 PASS；四条真实 VCC integration 19/19、209/209、77/77、29/29，共 334/334 PASS；lint、changed JS `node --check`、diff check PASS。首次失败分类包含一个 operation-tracker production regression（局部 payload 引用，已修）及若干 required exact7/旧 UI exclusion 的 stale tests/integration fixtures；生产 required 合同未放宽，未增加 renderer/IPC 不可达防御。`check-vars -- --include-minor` exit 2 仅 Runtime-state `MODULES/app/dialog`，无 Critical/Risk-sensitive；逐项 review 结论记录于 implementation notes。最终且唯一一次 `npm run release-check` exit 0：lint/smoke PASS，unit 4990/4990（326 files，0 fail/skip），integration 48/48 scripts、2385/2385 assertions（384212ms）；runner 只在全绿后自动同步 policy §七，无 retry 或阈值放宽。

P0/P1 人工检查仍待用户：取消一个真实保存对话框确认运行次数不变；分别观察 pre-critical 与 protected cancel；在存档中心核对一个 metadata-only 和一个多文件结果导出批次。⚠️ 真实主体×九币种、调整后余额、跨月期初、归档/解归档/delete 审计及全部导出文件必须由财务人工复核；Windows packaged、约 16 GB 与目标生产 legacy/trigger 仍为 PROBE。完整自动门禁不能替代上述真实环境和资金人工验收。

## 十七、PR3-Toolbox TaskLifecycle 测试矩阵

| ID | 优先级 | 层级 | 场景 | 最小断言 |
| --- | --- | --- | --- | --- |
| TB-L01 | P0 | scope/policy | utility + literal inventory | primary=13、visible=14；toolbox 不进主模块列表；merge/export reserve、read preview exclude exact |
| TB-L02 | P0 | merge prepare | input/save cancel、reserve failure | 全部 dialog 在 prepare；任一取消 0 BOR/reserve；reserve failure 0 algorithm/output |
| TB-L03 | P0 | merge artifact | N input + final outputs | beforeStart 捕获全部输入；同一 batch 登记 writer 全部最终输出；tmp 不登记 |
| TB-L04 | P0 | split read | preview token | raw IPC、0 batch/parent；新读覆盖；opaque token+path+stat；不把 read stat 当可信字节摘要 |
| TB-L05 | P0 | split freshness | cancel/missing/changed/success/failure | 输出 dialog 取消保留；missing/changed 清 token且原 batch failed、0 output；成功清；普通失败可重试 |
| TB-L06 | P0 | split branches | normal/large/multi-sheet/multi-output | 一个 export 一个 batch/parent/context；全部最终 outputs；worker 不 reserve/reopen |
| TB-L07 | P0 | context | large/publication worker | 副作用 dispatch required exact7；Main freeze、worker refreeze；scanFields/restart recovery 不伪造 context |
| TB-L08 | P0 | artifact/outbox | append/publication/terminal failure | 业务成功不被 archive 失败覆盖；outbox/terminal intent 复用原 batch/parent/operation key |
| TB-L09 | P1 | renderer/archive UI | token + utility filter | renderer 透传 splitReadToken；archive 筛选显示工具箱；业务模块启用/切换菜单不变 |
| TB-L10 | P1 | regression | roundtrip/large/multi-sheet/rows/style | 既有格式、sheet、日期、命名、资金与行数守恒回归不变；相同 terminal matrix 不按 worker 分支复制 |

自动证据：扩大聚焦 131/131、archive filter/scope/policy 38/38；五条 toolbox integration 分别 30/30、17/17、16/16、50/50、31/31 PASS。首次 focused 失败分类为两个 stale test 和一个 test design，无 production regression/environment。最终且唯一一次 `release-check` 全绿：lint/smoke PASS，unit 4999/4999（327 files），integration 48/48 scripts、2385/2385 assertions（381885ms）；首次 full 无失败、retry 或阈值放宽，runner 只在全绿后自动同步 policy。Windows packaged、Excel/WPS、约16GB/700万行、真实文件/sheet/行数/资金输出血缘仍是 PROBE/人工门禁，自动 PASS 不关闭。
