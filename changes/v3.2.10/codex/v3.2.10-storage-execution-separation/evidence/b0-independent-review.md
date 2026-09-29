# G6 B0 独立实现审查

本次为实现后的独立只读审查，范围为 `src/main-process/run-check-multiworker.js`、真实 worker 退出屏障测试及 fixture；未修改 executor / 业务代码。基线 `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`，审查对象为同 HEAD 的未提交改动。首次审查对象 executor SHA256：`0b7a64361dbadc1c560f59ad2271fb2ac93162957f421ec2b463a0b478329a66`。

## 结论：发现一个需修复的问题

### P2：chunk error 与 exit 同栈到达时，通用 exit 抢走真实首错误

位置：[run-check-multiworker.js](../../../../../src/main-process/run-check-multiworker.js) 的 `dispatchChunkToWorker.onErr`（首次审查第 411–415 行）、`registerWorker.confirmExit`（99–106 行）及 workerLoop catch（462–465 行）。

`onErr` 先清空 record 上的 `onError/onExit` 并 reject 当前 chunk，直到 workerLoop 的 await continuation 才 `group.fail(err)`。原生 Worker 在内存上限触发时会同步依次 emit `error`、`exit`。因此 exit 到达时，永久监听器看到 `onExit` 已清空、`stopping` 仍为 false，先将通用“worker 意外 exit”放入 `group.firstError`；稍后 chunk catch 的原错误不再有机会成为首错误。

这违反 [TechDoc §4.1](../techdoc.md)“正常结果、reader/merge 首错误……原优先级保留”，丢失原 OOM 错误上下文。此处不推断某个上层必然执行 OOM 回退；可确定的回归是向上错误发生变化，不能将 B0 记为原异常合同已保持。

已通过真实 Worker 重现，不依靠手动 EventEmitter 模拟：子线程设置 `maxOldGenerationSizeMb: 8`，初始化完成后在 chunk 内触发 Node 的 `ERR_WORKER_OUT_OF_MEMORY`；仅使用临时目录，主进程不读写业务库。同一探针分别运行 Git 中的旧实现与当前实现：

| 证据 | 基线 | 当前 |
| --- | --- | --- |
| 原生事件 | `error(ERR_WORKER_OUT_OF_MEMORY)` → `exit(1)` | 相同 |
| executor 向上错误 | `multiworker chunk=0 worker error 事件：Worker terminated due to reaching memory limit: JS heap out of memory` | `multiworker worker 意外 exit（code=1）` |
| 保留原首错误 | 是 | 否 |

复现命令：

```sh
node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b0-error-exit-priority-probe.js
```

[探针脚本](b0-error-exit-priority-probe.js)；[首次运行原始输出](b0-error-exit-priority-probe.txt)。运行退出码 0 表示完成对照取证；输出 `Current retains first worker error: false` 表示已重现回归，不是实现验收 PASS。

建议：在 chunk 的 error 消息、error 事件及发送失败等失败回调内同步固定 group 首错误/停止状态，避免在 Promise continuation 才建立首错误；同时确认不会导致重复 close/terminate 或提前 part 清理。补真实 error→exit 竞态回归后重跑受影响 B0 与 service 用例。

## 其余已核对的边界

- Worker 构造返回后即加入 `group.records` 并安装贯穿全生命周期的退出监听；构造失败不会丢失此前已创建 worker 的所有权。
- init 使用 `allSettled`，组失败主动 settle 尚未就绪的 init，晚到 `init-done` 不派发 chunk。
- `stopWorker` 持有单 record 的 stopPromise，close/terminate 次数受幂等状态约束。超时仅触发 terminate，不作为退出确认。
- terminate 抛 Error / reject Error 时记录诊断并继续等待真实 exit；现有真实线程测试明确释放前 executor 不 settle、part 文件仍在、释放后只结算一次。
- `finally` 先 await 全组停止，再执行精确 part 路径及 sidecar 清理；本次审查未发现退出屏障被提前绕过。
- 取消仍在每个 worker 领下一个 chunk 前检查；按 chunk 的 SQL、merge 事务、物理顺序逻辑未变化。没有把该检查说明成即时中断在飞 SQL。
- 当前真实 worker 测试覆盖部分 init 失败、构造/发送失败、init timeout、late init、close 发送失败、terminate 延迟/reject/throw、chunk 发送失败和 chunk 未完成 code=0 退出；新增第一项竞态未被这些既有场景覆盖。

## 验证边界

本独立审查实际新增执行的是上述真实 OOM 竞态前后对照探针；未把作者已有的 25/25 单测结果冒充本次独立重跑。服务最终测试由主实施任务执行。本报告不重复 Main 锁已知问题，不宣称 Windows/Electron/Excel/WPS/安装包验收完成。

## 修复后复查与关闭

处置状态：**上述 P2 已修复并经同一独立真实 Worker 探针对照关闭；本次复查未发现新增问题。** 首次发现及原始输出保留在前文，以下事实针对修复后的代码，不能将首次失败记录解释成已通过。

修复后 executor SHA256：`883a642741f47aa16f1a5e608c8a83a41e3bb3b14e4b7043eabba5053efb1ad1`。`dispatchChunkToWorker` 新增单一 `fail(error)`，在 error 消息、error 事件、exit 事件及发送失败时同步完成当前任务 settle guard、监听清理、精确 part 路径登记与 `group.fail(error)`，最后 reject 当前 chunk。首错误与停止状态因此在后续同步 exit 之前固定；workerLoop catch 再次调用 group.fail 时保留首错并复用 stopPromise，不增加关闭次数。

本次复查核对了上述 fail helper、受控真实 Worker 装配及新增 `B0 真实内存受限 worker 同栈 error→exit：保留 chunk 原始 error 优先级` 回归。新增回归验证真实 `ERR_WORKER_OUT_OF_MEMORY` 的 error→exit 顺序、退出确认、原错误完整文案、既有 code/workerFailureSource 合同、零 diff 写入和 part 清理。

独立执行相同探针，保存到新文件，没有覆盖首次发现日志：

```sh
node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b0-error-exit-priority-probe.js > changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b0-error-exit-priority-fixed.txt 2>&1
```

退出码 0；基线与修复后均返回 `multiworker chunk=0 worker error 事件：Worker terminated due to reaching memory limit: JS heap out of memory`，末行 `Current retains first worker error: true`。见[修复后独立原始输出](b0-error-exit-priority-fixed.txt)。这一证据关闭本报告唯一问题；其范围为实际重现的 worker 错误竞态及关联失败收口，不替代整个功能的 service/集成或平台验收。

B0 实现负责人报告完整 executor 测试已增加到 26/26 PASS；本次独立复查没有重复该完整命令，实际新增运行仅为上面的同一对照探针。
