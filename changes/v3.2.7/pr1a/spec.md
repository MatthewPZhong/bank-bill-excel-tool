# PR1a：共享载体关闭观察与资源所有权

基线：PR0-E5 `carrier-closure-contract.md`，SHA-256 `de46baf947f2278eaf348ea1bfa11036c805f5ec2ec9aa29e42732e1f93377f8`；2026-09-06 E5 实施交接记录。本文件是 PR1a 的接口落点，不产生 E6，也不改变 E5 业务合同。

## 接口与范围

- Main 创建 runtime/Supervisor 时以 `carrierClosureActionKeys` 显式允许已审核、禁止额外子载体的 action；默认为空。只支持 native/thread-single/lifetime=job、无 compound 拓扑、具备真实 operation/file-batch 任务上下文且配置 Governor 的任务。其他载体拒绝启用，不返回假关闭。
- opt-in control 增加不可变 `carrierIdentity`、`getCarrierObservation()`、`waitForCarrierClosure({timeoutMs})`。旧 control 的 key、ExecutionResult、错误优先级不变。观察只由 Main 的 adapter/Supervisor 产生，不加入 IPC/exact-5 context，也不从 worker 消息中的“已关闭”字段采信。
- identity 绑定 taskRunId/taskKey/actionKey/operationKey/jobId/workerInstanceId/runtimeInstanceId/sessionId/processInstanceId/carrierKind/dispatchNonce。runtime 和 dispatch 使用新随机身份；processInstanceId 是当前 Main 进程内身份，不能作为旧进程已退出的证明。
- 可选 Main `beforeCarrierDispatch(identity)` 在创建载体前执行，供 PR1b 持久绑定 dispatch/read plan；production opt-in 必须提供该接入点。失败/取消后不得继续创建载体。Main 必须持久记录完整返回身份，不用部分字段证明另一任务已关闭。
- 观察包含 disposition=NOT_CREATED/EXITED/PENDING/UNKNOWN、退出/terminate/close 事实、resourceDisposition、序号、时间和摘要。关闭与资源状态独立；等待超时只返回当时观察，不释放保护或丢弃在途清理。
- 等待默认 5000ms，允许 0..300000ms；同事实重复查询不推进序号。EXITED 必须证明 native exit 或真实 terminate 完成，并且 transport close 完成。NOT_CREATED 必须确认未尝试创建且派发流程已经撤销/结束。

## 所有权与兼容

opt-in 任务关闭未知时由原 Supervisor 保留已有 Governor 租约，不引入新的通用 quarantine。业务 Promise 仍按原错误优先级结算；晚到 exit/terminate/close 继续收敛原记录，不修改已返回业务结果。资源释放失败保留租约供既有 shutdown 重试；重复退出和清理不重复释放。

terminate/close 等待超时后仍持有原调用。shutdown 重试只继续等待该调用；底层实际拒绝后才允许新一次清理，不能并发重复执行同一阶段。观察失败码最多 128 个 ASCII 字符，不带错误原文、路径或样本。

旧 runtime 的未决记录由现有 RuntimeManager shutdown owner 保留。未解决前不能清理旧 owner 并重新开放 manager。跨应用进程重启不能从新 session/PID/摘要推断旧载体退出；PR1b 只有取得 E5 要求的进程实例证据才可释放业务 pin，否则保持恢复阻断。

PR1a 不改 StartupRecoveryCoordinator、Provider outcome、恢复数组接口、业务 pin/目录、公共 writer、旧 parser pool、生产 action 开关或版本号。

## 验收

真实 native worker 的正常/业务失败退出；取消 ACK 后存活；终止拒绝/超时后真实晚到退出；派发前取消/失败；重复退出/清理；资源释放失败与重试；新 runtime 不承接旧身份；旧 service/existing-dispatch 回归。系统 Node 与 Electron Node 分别运行，Windows 由 PR CI 单列，未运行不得记录为通过。
