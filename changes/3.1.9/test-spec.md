# v3.1.9 PR1 Test Spec

## 1. 范围

本文件只覆盖确认 Spec §15.1 中 PR1 可承担的批次身份、数据库迁移、状态 DTO 和查询基础。业务 action 接线、策略注册、文件物化、存储迁移、UI 和发布门禁由后续 PR 补充。

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

## 4. 本 PR 明确不测

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
