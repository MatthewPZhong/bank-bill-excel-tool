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
- `npm run lint`、相关文件 `node --check`、`git diff --check` 均 PASS。
- `npm run check:vars -- --include-minor` PASS，脚本未命中重要变量；另已人工按 ArchiveRepository/ArchiveService 审计血缘条目完成关联 review。
- 完整 `npm run release-check` exit 0：lint PASS；smoke PASS；unit 4816/4816 PASS（304 个测试文件，Node 测试 15177.643ms、runner 15214ms）；integration 48/48 脚本、2459/2459 断言 PASS（386135ms）。
- team-lead 最终 review：无 P0/P1、无入口旁路、无过度防御；独立复跑两个相关文件 34/34 PASS，git diff/status 边界正确。
- 本轮无 UI、目录物化或真实业务 action 接线，无新增 GUI 手动项；人工代码 review 由 team-lead 在未提交检查点执行。
