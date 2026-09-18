# 平盘链接表 manifest owner 修复 Implementation Notes

## Baseline

- Goal/spec：修复链接原始表预检成功后，pending 输入清单仍为 0 条并被 manifest 门禁拒绝的问题；不改变来源识别、过滤、落库、金额或匹配规则。
- Initial plan：读取开发环境 pending、日志和暂存现场，先证明失败发生在 apply 前，再做最小 owner-token 修复。
- Done when：单文件 manifest 可登记为同 operation token 的 pending 输入；证据不一致仍 fail-closed；定向测试通过。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| apply 授权器把已从 pending 读取并校验过的 `operationToken` 显式传给存档意图登记函数；登记函数仍二次核对当前 pending owner | Electron `utilityProcess` 消息回调未保留原 `AsyncLocalStorage` store，旧函数因此静默返回；2026-08-02 单独导入网关原始入账单时 manifest 为 1 条而 pending 为 0 条 | 删除数量校验、按 manifest 直接放行、依赖隐式异步上下文 | 只修复所有权传递；文件路径、快照、SHA-256、大小、异常报告依赖和 manifest hash 校验保持不变 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `Documents/网银账单生成小助手/logs/2026-08/08-02/error.log` | 17:51 至 18:37 共 5 次同一清单不一致错误 | 证明问题可重复发生，不是一次性 UI 状态 |
| 开发主库 setting `position_reconciliation_side_db_pending_v1` 与暂存现场 | 预检运行时 pending 为 `awaiting-intent` 且 `archiveFiles=[]`；单文件 worker 完成后错误复现并清理 pending | 证明侧库 apply 尚未获授权，没有部分落库 |
| `node --test tests/unit/main-process/position-reconciliation-operation-lifecycle.test.js` | 17/17 PASS | 显式 owner token、输入与异常报告双角色登记、证据不一致拒绝 |
| 流式预检、service、schema、过滤报告四文件回归 | 127/127 PASS | worker 授权拒绝清理、部分提交恢复、过滤报告依赖及 side DB checkpoint 契约 |
| 平盘 side DB parity 集成 | 38/38 PASS | checkpoint、输入凭证与业务表状态一致性 |
| archive operation tracker + 生命周期复跑 | 47/47 PASS | 即时存档、解析时证据、失败恢复与 pending 清理 |
| 开发侧库 checkpoint 与 input proof | 主库/侧库仍为 generation 4；失败 operation token 的提交凭证为 0 | 证明本次现场失败没有部分落库或推进 checkpoint |
| `eslint src/main.js src/main-process/position-reconciliation/operation-lifecycle.js` | PASS | 修改文件语法与代码规范 |
| `npm run check:vars -- --include-minor` | 当前未提交的 v3.1.6 全工作区命中既有 VCC/UI 的 2 个 Important-skeleton、6 个 Runtime-state；本修复 diff 未新增清单内符号命中 | 本修复仍按 Risk-sensitive 的平盘 apply 存档握手条目执行定向回归，不把其他协作者改动算成本修复结论 |
| `npm run release-check` | lint、smoke、4592/4592 unit、44 个集成脚本 2051/2051 全部 PASS | 证明本修复与 v3.1.6 VCC 整合后没有破坏既有发布门禁 |
| 竞态与旁路复核 | `trackedIpcHandle` 在同一全局平盘 operation 生命周期内等待 worker；并发操作返回 busy，worker 消息还按 jobId 和 settled 状态过滤 | 旧 worker 回调不能在上一操作结束后登记到新 pending；显式 token 仅替代丢失的 AsyncLocalStorage owner 传递 |
| PR 前 self-review | 未发现未解决 P0-P3 finding；文件证据不一致、owner 变化、manifest 未持久化和 checkpoint/schema 变化仍 fail-closed | 当前剩余项为 Electron 真实文件人工验证，不以自动测试替代 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 修复后的 Electron 开发环境真实单文件重试 | PROBE | 自动测试通过后，由开发环境重新导入同一文件确认 UI 全链路 | 不阻断代码层根因修复；发布前必须完成 |
