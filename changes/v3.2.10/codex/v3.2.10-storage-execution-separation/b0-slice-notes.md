# G6 B0 实施记录：真实 worker 退出屏障

- 日期：2026-09-20；分支：`codex/v3.2.10-storage-execution-separation`；基线：`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`。
- 切片：P1 B0；依据：[Spec AC-06/07](spec.md) 与 [TechDoc §4.1](techdoc.md)。
- 实现状态：已实现（未提交）；验证状态：独立审查发现并修复首错竞态后，最终 26/26 PASS；集成状态：未集成 release。
- 技术前置：B0 先于 service 迁移完成，已通知主实施者允许 B2/B3 开始。后续迁移、Main 锁调用链和平台验收由对应记录承担。

## 职责与边界

[executor](../../../../src/main-process/run-check-multiworker.js) 为每次调用创建 group records；Worker 构造后立即登记和监听真实退出。初始化 `allSettled` 与退出屏障独立，失败保留首异常并取消所有 init 等待、停止新派发。chunk 错误在事件 handler 中同步登记 group 首异常，避免真实 Worker 同栈 error→exit 在 Promise catch 前替换原错误。每 record 只关闭一次，terminate 成功或 exit 事件确认退出；terminate reject/throw 仅诊断，不作为退出。finally 全组确认退出后才做精确 part 清理。

SQL、JOIN、每 chunk 合并事务、参数校验、汇总返回及 worker 写前 C1 重建正文均保留。未引入跨 run 常驻池、run 子目录、schema/状态迁移或全批事务。

## 调用方与兼容

B0 当时生产调用链保持 `session → run-repository.insertDiffRowsByJoinMultiWorker → runWriteSplitChunks`，repository/service 未在本切片修改。仓内全量检索未发现 `__test_only__.startWorker/closePool` 的直接消费者；两项内部 helper 收为私有，生产 API 不变。真实故障测试在测试装配层加载模块并替换 Worker 构造器，无生产 executor 注入后门。

B2/B3 随后切换 service，完成后以 Acquiring 模块说明和总实施记录为准；不可把本页的历史 B0 调用链当作迁移完成后的现行入口。

## 业务行为

有意修复：部分初始化失败不能遗漏已创建线程；close timeout/发送失败不能发出 terminate 后提前返回；运行中 code=0 退出不能悬挂 chunk。默认 init 10 秒、优雅 close 5 秒保留；真实退出可能更晚，未观察退出前不结算、不结束清理。

保持：reader 成功后才 merge，按 chunkIndex/seq 顺序逐 chunk 事务；失败可能有已提交 chunk，由上层按 run 清理并维持 partial/resume；取消仍在 chunk 间检查。只清本次派发路径与 SQLite sidecar，C1 写前重建与 caller 外层目录归属不变。

## 验证证据

全部命令在工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-storage-execution-separation` 执行，macOS / Node `v25.8.0`，仅测试自建临时库和目录。

| 检查 | 命令 | 结果与证据 |
| --- | --- | --- |
| 基线反例 | `node --test --test-name-pattern='B0 部分 init' tests/unit/main-process/run-check-multiworker.test.js` | 修改 executor 前 0/1 PASS、exit 1：线程存活时 executor 已 settle；[RED 证据](evidence/b0-baseline-red.txt)。 |
| 初版回归（历史证据） | `node --test tests/unit/main-process/run-check-multiworker.test.js` | 25/25 PASS、exit 0；[证据](evidence/b0-worker-tests.txt)，[受测文件 SHA-256](evidence/b0-file-sha256.txt)。包括 M=1/2/4 逐行等价、顺序、C1、取消与 12 项 B0 真实线程故障。 |
| 初版定向 lint（历史证据） | `node_modules/.bin/eslint src/main-process/run-check-multiworker.js tests/unit/main-process/run-check-multiworker.test.js tests/unit/main-process/__fixtures__/multiworker-exit-barrier-worker.js` | PASS、exit 0；[空输出证据](evidence/b0-eslint.txt)。 |

独立审查随后使用真实 8 MiB Worker OOM 发现：初版虽有 25/25 PASS，chunk error handler 仅 reject 并移除当前 onExit，Node 同栈 exit 会先于 workerLoop 的 await catch 写入通用 exit 错误，改变基线首错。原取证 [error/exit 对照](evidence/b0-error-exit-priority-probe.txt) 与新增回归 [RED](evidence/b0-error-priority-red.txt) 均保留；初版 25/25 不能覆盖该竞态。

修复将所有 chunk 错误统一在 handler 内同步登记首错后才 reject；消息反序列化错误、原 worker-error 包装文案及 code 合同保持，exit 不再覆盖前一个 error。

| 最终检查 | 命令 | 结果与证据 |
| --- | --- | --- |
| 修复后完整 B0 回归 | `node --test tests/unit/main-process/run-check-multiworker.test.js` | 26/26 PASS、exit 0；[最终测试](evidence/b0-worker-tests-final.txt)。新增真实内存限制的 error→exit 回归核对事件顺序、原包装错误/字段、退出及 part 清理。 |
| 修复后定向 lint | `node_modules/.bin/eslint src/main-process/run-check-multiworker.js tests/unit/main-process/run-check-multiworker.test.js tests/unit/main-process/__fixtures__/multiworker-exit-barrier-worker.js` | PASS、exit 0；[最终 lint](evidence/b0-eslint-final.txt)。 |
| 最终受测文件 | 三项 B0 JS 文件 SHA-256 | [最终哈希](evidence/b0-file-sha256-final.txt)；保留初版哈希，不将早先 25/25 结果改写成一直通过。 |

B0 故障在测试显式允许退出前检查 pending 与真实线程存活；关闭故障同时确认 part-0/1 与 caller 标记保持。允许退出后检查所有线程退出、关停幂等、结果仅结算一次、part 清理完成。terminate 抛错/reject 检查诊断标识后仍等待迟到 exit。测试在 finally 强制回收自己的线程，基线失败也不泄漏测试进程。

当前验证不代表 Windows/Electron/GUI 文件占用验收，不代替后续真实 session/service 链、集成测试和完整 release-check。真实 service 尚未在 B0 迁移，因此 service cleanup 次序的跨模块证据归 B2/B3；B0 已证明它依赖的 executor Promise 在退出前不会结束。

## 当前规则入口

新增 [Acquiring 模块 README](../../../../src/backend/acquiring-bill-currency-db/README.md)，以 B0 已落地职责、退出等待、错误与清理顺序为正文；主实施者负责根 AGENTS 导航并在 B2/B3 迁移时更新现行链路。存储规则正文未改变，仅链接 `rules/run-scoped-data-policy.md`。本切片无纯模块边界变化，G8 的 repository/service 反向依赖消除由 B2/B3 激活；线程真实退出用行为测试验证，不增设未设计的静态门禁。

## 剩余与回退

B0 技术前置完成；后续 B1/B2/B3 仍需完成 service/仓储分离、主调用链锁与目录顺序复用、partial/resume 集成和相应平台验证。B1～B3 回退须保留本切片的退出屏障；回退 B0 会恢复已证实的提前结算缺口，不得仍将 AC-06 记为完成。

## 整合状态补记

B0 初次验收后 B2 已完成 service/仓储/session 迁移并取得真实管线证据；当前链路与 B3 锁前提剩余项见[实施索引](implementation-notes.md)。根 AGENTS 导读和 Acquiring README 的现行链路已由后续切片更新。上述 B0 阶段先后顺序记录保留，不将原阶段尚未执行的验证倒写成当时已通过。
