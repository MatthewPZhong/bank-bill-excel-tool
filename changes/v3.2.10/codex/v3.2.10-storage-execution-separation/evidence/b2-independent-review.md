# G6 B2/B3 职责迁移独立审查

当前被审查的 repository/service/session 迁移未发现新增缺陷。早期机械替换误删仓储函数的中间错误已修复；本报告和差分 PASS 均针对修复后的实际文件。B3 已记录的 Main 锁归属问题不在本次复现范围，仍见[补充方案](../b3-lock-fix-proposal.md)。本审查不将局部迁移通过表述为 B3 全部验收通过。

## 范围与代码状态

- 依据：[G6 Spec](../spec.md)、[G6 TechDoc](../techdoc.md) 的 B2/B3 及 G6-AC-04～08。
- 分支：`codex/v3.2.10-storage-execution-separation`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-storage-execution-separation`。
- HEAD/基线：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`；当前实现为未提交工作区差异，未执行提交、推送或集成。
- 实测时间：`2026-09-20T12:07:49.615Z`；Node `v25.8.0`，`darwin/arm64`。
- 源文件 SHA-256 由[实际结果](b2-differential-probe.txt)记录，覆盖 HEAD 仓储、当前仓储、service、session。源文件若继续修改，须按影响复核此证据。

## 检查结果

| 检查对象 | 实证结果及合同 |
| --- | --- |
| 仓储保留函数 | 当前与 HEAD 共保留 25 个公开函数，其 `function.toString()` 全部精确一致；`changedRetainedFunctions=[]`。包括单 worker SQL/事务、run CRUD、checkpoint、partial/resume 相关仓储方法。 |
| SQL 与列顺序 | `buildSelectOnlyChunkSql()` 返回文本与 HEAD 精确一致；partColumns、targetColumns 与 HEAD 精确一致。业务 CASE、JOIN body、币种不等谓词未改。 |
| 导出变化 | 只删除 `insertDiffRowsByJoinMultiWorker`；只新增 `buildMultiworkerPlan`、`cleanupFailedMultiworkerRun`。 |
| 计划职责 | [run-repository.js:394](../../../../../src/backend/acquiring-bill-currency-db/run-repository.js) 仅 COUNT、构造 `[monthKey,chunkSize,offset]` 和受控表/列/SQL；无 worker 宿主 import/call，不创建 run 或写 checkpoint。 |
| 清理事务 | [run-repository.js:414](../../../../../src/backend/acquiring-bill-currency-db/run-repository.js) 按当前 runId 执行独立 BEGIN/DELETE/COMMIT，内部失败 ROLLBACK 后抛出；service 保留原执行异常。BEGIN 失败不额外 ROLLBACK，与基线序列相同。 |
| service 参数 | [service](../../../../../src/main-process/acquiring-bill-currency-multiworker-service.js) 保留旧验证顺序及错误文案：runId、monthKey、Number(chunkSize)、dbPath、workerCount、tempDir，全部成功才 COUNT；不增加 trim 或隐式默认值。 |
| service 执行与进度 | 0 行不调用 executor；其他情况计划/执行各一次。reader progress 仍为旧五字段，回调异常吞吐保持；进度不写持久 checkpoint、不表示 merge 已提交。 |
| service 失败 | COUNT/计划失败先于执行，不误清 run；执行器 await 拒绝后才清当前 run；cleanup 任意阶段失败不覆盖原错误对象/name/message/code，无 retry 或额外超时竞争。 |
| session 迁移 | [session](../../../../../src/main-process/acquiring-bill-currency-session.js) 仅新增装配、切换调用及私有 temp helper 来源。既有 MW gate、资源选择、partial/data-complete、resume 单 worker、从 chunk 0 清残留及 ownedTempDir 清理结构保持。 |
| 调用方与兼容 | session 唯一直接生产调用已迁移；[contract tests](../../../../../tests/unit/main-process/acquiring-multiworker-contract.test.js) 原 8 处直接调用改为测试层显式 service 装配。仓储不保留反向执行兼容 wrapper；旧名称的 service 错误文案按合同保留。 |

仓储现有 `main-process/archive-center/worker-batch-context` 引用继续承担持久 exact-7 冻结合同，不属于本切片禁止的 worker 宿主依赖，没有顺带迁移。

## 独立差分证据

运行命令（工作目录为上列 worktree）：

```sh
node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b2-differential-probe.cjs
```

[可重放脚本](b2-differential-probe.cjs)从 `git show HEAD:.../run-repository.js` 加载旧 wrapper，当前版本加载实际 service/repository。两路只替换相同的 executor 和 DB 观察对象；未重新实现旧 wrapper 或新计划函数，未改生产代码。

矩阵为 `2 × 8 × 14 = 224` 组：0/5 行；成功、progress 回调异常、执行异常、COUNT 异常及 BEGIN/DELETE/COMMIT/ROLLBACK 清理失败；正常值、数值字符串 chunkSize、负/Infinity runId、truthy 非字符串 monthKey、空格路径、复合非法输入优先级、Symbol chunkSize 转换错误等参数。

逐组比较参数错误、DB 调用次序、完整 executor 参数、progress、返回摘要及主错误对象身份，实际结果 **224/224 PASS，退出码 0**。结构比较同时证明 25 个保留函数正文、SELECT SQL 和列序精确相同。结果见 [b2-differential-probe.txt](b2-differential-probe.txt)。

这些是受控 executor/DB 的差分证据，不能替代真实 SQLite/worker/XLSX、B0 真实退出、Main operation lock、平台 GUI 或完整交付门禁；相关最终测试由[实施记录](../implementation-notes.md)统一关联，本审查没有重复执行正在收口的测试。

## 已修复的中间错误

独立检查早期在实现尚未收口时发现一次机械替换边界错误：替换起点匹配到了前部同名注释，从 HEAD 的约 70 行起误删 `buildSelectOnlyChunkSql`、run CRUD 和单 worker 方法，导致模块加载报 `ReferenceError: insertRun is not defined`。随后已从 HEAD 恢复仓储原有正文，以旧 MW wrapper 前的精确边界替换。当前重新加载成功，上述 25 函数/SQL 精确比较及 224 组差分均在修复之后运行。中间加载失败不属于最终状态，也未被保留成通过证据。

## 五项要求与验收边界

- 职责与边界、调用方与兼容、保持业务行为已按上表核对。
- 验证证据保留可重放脚本、实际输出和源文件指纹；完整真实集成与其他切片状态以实施记录为准。
- 当前规则入口由[Acquiring README](../../../../../src/backend/acquiring-bill-currency-db/README.md)与[实施记录](../implementation-notes.md)统一收口；run 级存储仍引用[既有规则](../../../../../rules/run-scoped-data-policy.md)。本次未改变 DDL、侧库路径、历史 part 权限或 G8 激活状态。
- Main 锁归属及顺序复用前提属于另行保存的 B3 事项；未重复运行其探针，未修改 Main/pool 文件，本报告不解除该验收阻断。
