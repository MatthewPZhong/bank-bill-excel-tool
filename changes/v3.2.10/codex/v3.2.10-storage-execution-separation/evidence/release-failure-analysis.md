# G6 完整本地门禁失败分析

记录时间：2026-09-20T12:33:21.252Z。分析人职责仅为只读核查并新增本记录；同一 worktree 中其他 Agent 继续工作，本次未改动他们的文件，未启动测试或修改生产/测试源码。

## 结论与边界

本次完整门禁自然退出 1，unit 阶段 **8158 项 = 8113 PASS + 41 FAIL + 4 SKIP**，cancelled=0、todo=0、suites=831；509 个 unit 文件，Node 测试耗时 836779.457667 ms，wrapper 总耗时 836869 ms。8113/8158 不是通过率排除 SKIP 后的分母，4 项 SKIP 仍在 tests 总数中。四项均为 Windows/PowerShell 真实宿主专项测试；日志行 9603、9743、10223、10224。

按最终 failing tests 区段逐块解析得到恰好 41 项，五个测试文件，无遗漏。**39 项具有明确的空间/容量不足错误证据；2 项 Supervisor 状态断言的底层原因仍未归因。** 不能把全部失败写成 ENOSPC，也不能把 39 项归为“已证明同一个磁盘消费者所致”：本记录没有各进程存储用量时间线。

- 原始日志：`release-check.txt`，汇总行 10226–10233，最终异常块从 10237 开始；本记录不修改其 FAIL。
- 日志 SHA-256：`e216c0887b4e8ffb8cc7654c1263a34076400cff90bd9a562e53551fc5cb2c9c`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-storage-execution-separation`；基线 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。
- 五个失败测试文件的当前字节均与 HEAD 精确相同。错误堆栈未指向 G6 修改函数；这是代码范围证据，不是环境恢复后的基线重跑结论，也不构成全门禁通过证据。

## 直接错误分类

| 直接错误 | 数量 | 涉及测试文件与失败阶段 | 可证实触发原因 |
|---|---:|---|---|
| ENOSPC / mkdtemp | 32 | archive-storage-root-migration 13；recovery-contract-c2 19 | 操作系统拒绝创建临时目录，未到本项业务验证 |
| ENOSPC / write | 1 | archive-storage-root-migration | fixture 写入 statement.xlsx 时空间不足 |
| ENOSPC / open | 1 | archive-storage-root-migration | fixture 创建 statement.xlsx 时空间不足 |
| position-import-disk-space-insufficient | 3 | position-reconciliation-maintenance-writer | 可用空间低于约 537 MB 的当前准入要求；主动拒绝，不是 SQLite 执行错误 |
| ERR_SQLITE_ERROR / errcode 13 | 1 | recovery-contract-c2 | 初始 archive metadata 建表事务报 database or disk is full；日志证明 SQLite 容量不足，未单独测定其底层文件系统/配额原因 |
| ERR_ASSERTION：Git clone status 128 ≠ 0 | 1 | manifest-coverage-e13-g | git stderr 明确 No space left on device；复制历史仓库 pack 失败，尚未运行 manifest gate |
| ERR_ASSERTION：failed ≠ cancelled | 2 | mature-action-adapters | 底层 result.error / terminalSource 未打印，原因未归因；不能仅凭其他文件 ENOSPC 归入磁盘不足 |
| **合计** | **41** | **5 个文件** | **39 容量错误有证据，2 底层原因未归因** |

按文件：position-reconciliation-maintenance-writer 3；archive-storage-root-migration 15；manifest-coverage-e13-g 1；mature-action-adapters 2；recovery-contract-c2 20。34 项原始 ENOSPC = 32 mkdtemp + 1 write + 1 open。

## Position 三项

`tests/unit/backend/position-reconciliation-maintenance-writer.test.js` 的声明行 128、273、337 分别在实际调用行 193、285、400（以日志堆栈为准）遇到 `src/backend/position-reconciliation-import/disk-space-gate.js:91` 的明确准入错误，经过 maintenance-writer.js 的 191、304、429 三个维护分支：

| 用例 | 最低需要（字节） | 当时可用（字节） | 异常日志起始行 |
|---|---:|---:|---:|
| 来源删除 | 537153536 | 495845376 | 10237 |
| 银行删除 | 537153536 | 489218048 | 10254 |
| FundTransfer 映射重建 | 537155584 | 483938304 | 10271 |

错误 code 均为 `position-import-disk-space-insufficient`，message 均为“平盘导入可用磁盘空间不足，未修改现有数据”。此前本文件单独执行 3/3 PASS、HEAD 隔离源树 3/3 PASS 的实际结果仍见 `release-position-maintenance-failure.txt`；它们与本轮并发完整门禁的可用空间不同，不能覆盖本轮 3 FAIL。最终日志已把此前“可能低磁盘”的判断提升为这三项的直接已证实错误。

## manifest 一项

`tests/unit/main-process/background-execution/manifest-coverage-e13-g.test.js:262` 创建临时历史目录后，在 266–271 执行 `git clone --quiet --no-checkout` 并断言 status=0。本轮日志 10557–10578 显示 git 复制 `.git/objects/pack/pack-86bf5c00e52a325b794183ba68065b98b9e33df6.pack` 失败，stderr 为 `copy-fd: write returned: No space left on device`，实际 status=128。

因此本次失败不证明 manifest 覆盖/策略快照漂移：代码中的历史 checkout（272）和独立 gate（278）尚未执行。该测试最终有 finally 清理历史目录；本记录未另建或删除目录。

## Supervisor 两项：保持未归因

两项定义在 `tests/unit/main-process/background-execution/mature-action-adapters.test.js:567` 与 588，实际失败断言分别为 578、598；日志起始行 10580、10600。它们都实际得到 `result.outcome === 'failed'`，预期 `'cancelled'`。日志只输出这两个字符串，不包含 `result.error`、`terminalSource` 或 shutdownReport 内容。

源码证据显示，两个 fixture 均已成功创建 SQLite/XLSX，且已经观察到 `delete-entered.marker`；第一项取消请求 accepted/cancelling 的断言（575）已通过。marker 在测试生成的 contract 的 `deleteParamsFromMonthKey`（173）处写入，不能把它理解为后续 DELETE/新增行已经成功提交。两个用例随后即在 outcome 断言失败，后面的错误类型、receipt 和事务回滚断言均未执行。

实际业务链是 Pending mature binding → `src/main-process/big-table-import-dispatch.js` → `src/backend/big-table-import/engine-worker-entry.js`；adapter 只在“已投递取消且 worker 实际返回 CancelError”时确认取消因果（big-table-import-dispatch.js:171–173）。其他失败与取消竞争的用例 610 在本轮 PASS，说明 `failed` 本身可以是合同内的另一路结果，仍需本次具体 error 证据才能判根因。

mature-action-adapters 会间接 require Acquiring session 和 G6 service/executor，但这两个失败用例选择的是 `pending:import`。当前 test、Supervisor、big-table-import-dispatch 与 HEAD 同源；现有信息既不能认定 G6 因果，也不能认定这两项必然是 ENOSPC/稳定基线缺陷。未按指令扩大执行或重跑测试。后续应在获授权且环境空间稳定的验证中保留 result.error/terminalSource/shutdownReport 后再归因，当前集成状态保持 FAIL。

补充独立重查证据：其他 Agent 按 root 指令在 2026-09-20T12:31:44Z 定向重跑这两项，结果 **2/2 PASS，exit 0**，重跑前磁盘可用约 1.9 GiB、之后约 1.8 GiB。已阅读 [release-pending-cancel-recheck.txt](release-pending-cancel-recheck.txt)，其中保存命令、原始输出及 test/adapter/Supervisor/dispatcher 与 HEAD 一致的 SHA-256。此证据表明两项在该次定向执行中未重现，仍未保留原失败的底层 error；**不确认原始 ENOSPC 因果，不覆盖完整门禁的两项 FAIL，也不升级为 release-check PASS。** 本分析 Agent 没有额外启动测试。

## 全部 41 项逐项索引

编号沿用最终异常输出顺序。表中测试路径相对 worktree；日志行是 `release-check.txt` 的实际一基行号。包含动态矩阵参数，避免把同一源码行的多个失败合并漏计。

| # | 测试位置 | 用例 | 直接错误 | 日志行 |
|---:|---|---|---|---:|
| 1 | `tests/unit/backend/position-reconciliation-maintenance-writer.test.js:128:1` | 来源删除按月份分批执行并依赖 FK cascade 清理链接行 | Position 空间准入拒绝 | 10237 |
| 2 | `tests/unit/backend/position-reconciliation-maintenance-writer.test.js:273:1` | 银行删除只提交实际命中 scope，空选择结果不推进 checkpoint | Position 空间准入拒绝 | 10254 |
| 3 | `tests/unit/backend/position-reconciliation-maintenance-writer.test.js:337:1` | FundTransfer 映射重建逐行派生 0/hidden/visible 双腿且取消整体回滚 | Position 空间准入拒绝 | 10271 |
| 4 | `tests/unit/main-process/archive-storage-root-migration.test.js:2700:5` | 迁移 wx close 元数据边界的 ctime-after-snapshot 仍拒绝认领并保留两根 | ENOSPC / write | 10288 |
| 5 | `tests/unit/main-process/archive-storage-root-migration.test.js:2700:5` | 迁移 wx close 元数据边界的 mode-without-chmod 仍拒绝认领并保留两根 | ENOSPC / mkdtemp | 10305 |
| 6 | `tests/unit/main-process/archive-storage-root-migration.test.js:2700:5` | 迁移 wx close 元数据边界的 ctime-without-link-or-chmod 仍拒绝认领并保留两根 | ENOSPC / mkdtemp | 10323 |
| 7 | `tests/unit/main-process/archive-storage-root-migration.test.js:2761:5` | 迁移 link 见证 fd 打开前 file 真实替换，拒绝登记且保留原恢复证据 | ENOSPC / open | 10341 |
| 8 | `tests/unit/main-process/archive-storage-root-migration.test.js:2761:5` | 迁移 link 见证 fd 打开前 parent 真实替换，拒绝登记且保留原恢复证据 | ENOSPC / mkdtemp | 10359 |
| 9 | `tests/unit/main-process/archive-storage-root-migration.test.js:2761:5` | 迁移 wx 见证 fd 打开前 file 真实替换，拒绝登记且保留原恢复证据 | ENOSPC / mkdtemp | 10377 |
| 10 | `tests/unit/main-process/archive-storage-root-migration.test.js:2761:5` | 迁移 wx 见证 fd 打开前 parent 真实替换，拒绝登记且保留原恢复证据 | ENOSPC / mkdtemp | 10395 |
| 11 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 canonical 经 link 发布，在 after-create 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10413 |
| 12 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 canonical 经 link 发布，在 before-first-capture 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10431 |
| 13 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 canonical 经 wx fd 发布，在 after-create 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10449 |
| 14 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 canonical 经 wx fd 发布，在 before-first-capture 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10467 |
| 15 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 materialized 经 link 发布，在 after-create 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10485 |
| 16 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 materialized 经 link 发布，在 before-first-capture 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10503 |
| 17 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 materialized 经 wx fd 发布，在 after-create 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10521 |
| 18 | `tests/unit/main-process/archive-storage-root-migration.test.js:2814:7` | 新 materialized 经 wx fd 发布，在 before-first-capture 换 inode 后不能首次认领 | ENOSPC / mkdtemp | 10539 |
| 19 | `tests/unit/main-process/background-execution/manifest-coverage-e13-g.test.js:262:1` | 已发布 E13-G 清单和策略快照由独立 gate 对当前模块导出复验 | Git clone 空间不足 → status 128 断言 | 10557 |
| 20 | `tests/unit/main-process/background-execution/mature-action-adapters.test.js:567:1` | Supervisor 经真实 Pending mature binding 取消 Worker 导入：以真实终止证据落 cancelled 并回滚覆盖事务 | 状态断言 failed ≠ cancelled；底层原因未归因 | 10580 |
| 21 | `tests/unit/main-process/background-execution/mature-action-adapters.test.js:588:1` | Supervisor shutdown 经真实 Pending mature binding 取消 Worker 导入并报告 cancelled job | 状态断言 failed ≠ cancelled；底层原因未归因 | 10600 |
| 22 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 succeeded / Hold=false / anchor 中断后原子重放保护并重新检查 | SQLITE_FULL / ERR_SQLITE_ERROR | 10620 |
| 23 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 succeeded / Hold=false / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10637 |
| 24 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 succeeded / Hold=true / anchor 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10655 |
| 25 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 succeeded / Hold=true / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10673 |
| 26 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 failed / Hold=false / anchor 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10691 |
| 27 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 failed / Hold=false / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10709 |
| 28 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 failed / Hold=true / anchor 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10727 |
| 29 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 failed / Hold=true / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10745 |
| 30 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 cancelled / Hold=false / anchor 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10763 |
| 31 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 cancelled / Hold=false / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10781 |
| 32 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 cancelled / Hold=true / anchor 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10799 |
| 33 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:286:7` | 终态 cancelled / Hold=true / bundle 中断后原子重放保护并重新检查 | ENOSPC / mkdtemp | 10817 |
| 34 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 仍在运行 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10835 |
| 35 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 其他 Task 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10853 |
| 36 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 其他操作 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10871 |
| 37 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 恢复模式 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10889 |
| 38 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 恢复 attempt 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10907 |
| 39 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 持久恢复模式 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10925 |
| 40 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:316:3` | 无 Hold 空计划不能绕过 持久恢复 attempt 的 exact 重放拒绝 | ENOSPC / mkdtemp | 10943 |
| 41 | `tests/unit/main-process/background-execution/recovery-contract-c2.test.js:462:1` | worker-durable canary 在 COMMIT 后回包前 crash，重启 inspector 以同事务 receipt 收口 Intent | ENOSPC / mkdtemp | 10961 |

## 验证方式与剩余事项

本记录只对现有日志作确定性解析与读源码核查：最终失败块数=41；分类相加=41；文件计数相加=41；总数 8113+41+4=8158；五个失败测试源文件与 HEAD 精确比较一致。未执行任何新测试、fixture、Worker、Git clone 或全门禁，未修改生产/测试源码和他人文件。

未归因项明确为 Supervisor 两项。容量不足各项保留原始失败，恢复可用空间后重跑才可形成新的验证结论。尚无证据认定谁造成磁盘耗尽；不存在“多数空间不足，因此所有失败皆环境原因”的授权性豁免。
