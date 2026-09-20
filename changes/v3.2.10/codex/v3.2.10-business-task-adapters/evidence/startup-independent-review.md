# Position 启动恢复补测独立复核

结论：**本次范围内通过；未发现仍需修复的问题。** 未变异基线 3/3 PASS；两项指定断线均由预期行为断言检测出来。生产及源测试文件未被修改，记录的 8 个文件 SHA-256 前后一致。

## 复核边界

- helper 使用 Acorn 定位并原样执行 Main 的 `recoverPositionPendingBeforeInterruptedSweep`、`getPositionReconciliationService`，共享 service cache 和 recovery promise 词法环境。
- 真实 Position service 的 streaming 银行导入写入生产 side DB、checkpoint history 和文件级 committed inputs。中断点明确断言 outbox 为零、intent persist 调用为零，不使用自建业务账本。
- 使用生产 G1 composition、Position owner、Archive service/controller、terminal registry 与持久 outbox；其他领域参与者、平台 scan、主库 settings 门面和 UI 回调为受控外围夹具。本证据覆盖确定性 Node 启动恢复链，不声称完整 Electron 启动。
- 正向断言覆盖原 task/batch/artifact/hash、原 checkpoint 无重复业务推进、pending 收口与二次启动幂等。负向覆盖 checkpoint token 不符时启动失败、零 sweep、原 pending/暂存保留，以及 durable 后 pending 清理失败的下一次启动收口。
- 首次 flush 闩锁与 initialize settle 做 race；`firstFlushPending` 在首次 Main owner flush 未完成时拒绝后续 Controller flush。此检查避免“不等待恢复 Promise”的变异受异步磁盘时序掩盖。
- `ArchiveService.onSourceReleased` 和 `Controller.onOutboxFlushed` 均接真实 owner cleanup；manifest 恢复后受管 staging 按原路径保留，测试验证其字节不变，不增加删除授权。
- 各 host 均在 `finally` 中关闭；关闭前等待已跟踪恢复 Promise，再关闭生产 service/store 与主 DB。checkpoint 校验失败的 store 构造路径也关闭其内部数据库。

## 独立执行结果

命令：`node changes/v3.2.10/codex/v3.2.10-business-task-adapters/evidence/startup-mutation-runner.js`；工作目录和精确命令、时间、源码哈希见 [机器记录](startup-mutation-results.json)。runner 在每个新 Node 进程中运行同一集成脚本，脚本为每次运行创建独立临时 DB。

| 场景 | 变更范围 | 结果与命中断言 |
| --- | --- | --- |
| 未变异基线 | 无 | [3/3 PASS，exit 0](startup-mutation-baseline.log) |
| 不生成恢复 intent | preload 仅将 Main 读取结果中的 `const recovery = positionTaskOwner.recoverPositionArchiveIntent(...)` 替换为 `const recovery = null;` | [exit 1](startup-mutation-no-recovery-intent.log)，`必须经生产 owner 恢复补建 intent`，实际 0、期望 1 |
| 丢弃恢复 Promise | preload 仅将 Main 读取结果中的 `return await positionPendingRecoveryPromise;` 替换为 `return null;` | [exit 1](startup-mutation-discard-recovery-promise.log)，`Main 必须等待原恢复 promise 才能让 Controller 完成启动`，实际 true、期望 false |

两个变异均只在 `fs.readFileSync(src/main.js)` 返回的内存字符串中各替换一处，不修改生产或测试源码；均因目标行为断言失败，不是超时、语法错误或加载故障。复现材料：[runner](startup-mutation-runner.js)、[preload](startup-mutation-preload.js)。

本轮未运行全量门禁，未执行真实进程强杀、Windows 文件锁、Electron GUI、安装包或 Excel/WPS 验收；完整集成与最终门禁由统一实施记录承接。
