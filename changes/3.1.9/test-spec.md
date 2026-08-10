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
- 相关生产文件 `node --check`、`git diff --check` PASS。§10.2 人工门禁仍待执行，不以自动证据替代。
