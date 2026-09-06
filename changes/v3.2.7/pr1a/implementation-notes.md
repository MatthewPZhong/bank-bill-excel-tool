# PR1a Implementation Notes

## Baseline

- Goal：按 PR0-E5 与实施交接记录完成共享关闭观察及资源责任；接口落点见 [spec.md](spec.md)。
- 初始代码：origin/main `67bb4ec76954f05e8a63518c45fef50d575de5d0`，tree 与已评审 `57cb4c88` 相同。
- Done when：接口、真实关闭与失败资源测试、旧调用者回归和 PR 证据齐全；Windows 与后续 PR 的验收独立报告。

## Decisions

| 决定 | 依据与影响 |
|---|---|
| Main 配置 action 白名单 opt-in | 保持旧 control 和旧清理行为，不能由 worker/renderer 开启或自报关闭 |
| 原 Governor 租约由原 Supervisor 保留 | 不扩展资源平台；关闭/资源未决继续由已有 shutdown owner 追踪 |
| 使用已有 adapter exit latch，失败后保留监听 | 修复 terminate finally 丢失稍后退出观察；同一原记录向 control 发布观察 |
| 派发前 Main 持久化 hook | identity 在创建前固定；为 PR1b 的 dispatch/pin 绑定预留真实接入 |
| 等待超时后继续持有原 terminate/close 调用 | 故障测试发现重试可并发重复清理；按阶段保存原 Promise，等待实际拒绝/完成后才撤销调用所有权 |
| 恢复器核心不改 | E5 调度/预算属于 PR1b，PR1a 不包含它们 |

## Assumptions

- 本期不对其他模块启用新行为；PR1b 在实现无额外子载体约束和真实任务绑定后配置 BizOp action 白名单。

## Deviations

无业务或 E5 语义偏离。具体 opt-in、派发前 hook、等待默认值属于既定接口的实施细化，已同步 spec。

## Evidence

- 13 个共享关闭专项：系统 Node v25.8.0 与 Electron 36.9.5 / Node v22.19.0 均通过；创建真实 native Worker，再注入 terminate reject/pending、close 和 release 故障。
- 旧平台与 RuntimeManager 回归：两种运行时各 438 PASS（随后新增 1 个实际 runtime 文件生成 case，随完整检查及 Electron 专项验证）。
- 当前 Electron 关闭专项 + 工具箱宿主：24 PASS / 0 FAIL；其中 14 个为本 PR 新增 case。真实宿主生成测试写入测试临时目录，保持候选与最终发布路径分离。
- 系统 Node 完整单元：6961 PASS / 3 SKIP / 0 FAIL；3 个 SKIP 为 Windows 专用场景。
- 故障驱动发现：未去重时，pending terminate 被调用 3 次、pending close 被调用 2 次；修正后各自只调用 1 次，晚到完成仍收敛原观察/租约。
- check-vars：相对 origin/main 的生产 diff 与新增 helper 均未命中清单变量或定义位置；没有新增跨 3 文件共享变量候选。
- 完整 release-check、Windows CI 结果见 [validation.md](validation.md)。本地输出保存在未提交的 `outputs/pr1a-validation/`。

## Blindspot Review

- 已覆盖：取消 ACK、业务终态、unref、close 单独完成都不能证明原线程已退出；在途清理不因等待超时而丢失。
- 已覆盖：原错误、原 identity、lease owner 与旧 RuntimeManager owner 保留；重复 exit/shutdown 不对新 worker/runtime 释放容量。
- 已覆盖：Main hook 未完成不能返回 NOT_CREATED；adapter 创建窗口抛错保持 UNKNOWN 与占用，不能按没有 handle 推断未创建。
- 已覆盖：Main runtime 的实际注册器、默认 adapter、真实文件生成与原发布边界；旧 service/existing-dispatch 控制 API 回归通过。
- 未发现需要修改 StartupRecoveryCoordinator 核心或扩大 PR1a 载体范围的存活问题。业务 pin/receipt/Task 状态持久化及完整恢复属于 PR1b，不能由这些测试宣称已验收。

## Remaining Unknowns

- PROBE 已关闭：late exit 与初次 cleanup 并发、原租约只释放一次。
- PROBE 已关闭：资源释放失败、shutdown 重试与 RuntimeManager 未决 owner 的闭环。
- CI 验收：Windows 内置 Electron 的真实线程退出已加入显式检查步骤；本地未运行，是否通过以本 PR 的 CI 结论为准。
- 后续 PR1b：持久 dispatch/pin 与旧 Main 进程实例证据；PR1a 不推断旧进程已结束。
