# 业务 OP 启动资源等待与退出清理修复

## Task Brief

- Goal：修复启动恢复无限等待，以及退出清理 Promise 链多余调用。
- Context：用户日志的 `ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED` 内部为 `AdmissionQueueError: supervisor-shutdown`。只读核对发现一笔未完成清理的业务 OP 导出；零内存预算下真实 `recoverOtherOwners` 请求无限排队，关闭 governor 才抛错。
- Constraints：保留全局预算、1 GiB 阶段资源声明、真实 worker 退出屏障、发布回执和数据读取保护；不操作用户业务数据，不覆盖其他任务正在修改的 release-gates 相关文件。
- Done when：不可满足的申请立即拒绝，暂时竞争最多等待 5 秒；未准入不运行发布/恢复工作，超时从队列移除且不会迟到执行；有资源的恢复保持原合同；错误在启动界面可见；退出调用等待完整清理且失败可按原合同重试。

## 已确认事实与 Unknowns Register

| 项目 | 分类 | 证据与决定 |
| --- | --- | --- |
| 零预算时是否为任务占用导致等待 | PROBE，已确认 | 隔离复现：activeLeaseCount=0、queued=1；1 GiB 大于固定总预算，释放其他任务不可能满足。 |
| 能否直接提高系统预算或降低声明 | PROBE，已否决 | resource-budget.js 和启用合同明确资源上限；本次只改变本模块准入等待与错误展示。 |
| 恢复是否还有同类旁路 | PROBE，已确认 | publication 的发布/恢复/归档/共享观察，以及删除保全、原始表来源读取统一采用本模块有界准入；升级预检已由并行任务实现立即拒绝和零等待，本次保留。 |
| 执行中是否可以超时释放 | PROBE，已否决 | 只给 governor 的排队设置超时；拿到 lease 后仍等真实工作和退出屏障完成，不使用 Promise.race。 |
| 原始退出异常 | PROBE，已确认 | 原 prepareApplicationForQuit 在 VM 中复现 `.catch(...) is not a function`；调用失败后内部清理仍继续，必须移除多余调用。 |
| 当前真实启动是否已成功 | PROBE，未执行 | 仅操作隔离测试；用户实际内存不足时仍阻止启动并明确原因，释放内存后需重启以重新采样预算。 |

## 行为约定

1. 业务 OP Main 阶段使用统一准入 helper：申请资源超过固定总预算时抛 `BIZOP_RESOURCE_BUDGET_INSUFFICIENT`，不排队；总预算足够而资源暂被占用时最多排队 5000 ms，超时抛 `BIZOP_RESOURCE_WAIT_TIMEOUT`。
2. 错误明细展示动作、申请/预算/剩余资源及下一步。原 governor 的关闭、取消、非法参数错误保留原类型；不扩大全局调度器行为面。
3. Archive owner 的 AggregateError 保留各模块错误码、摘要、明细与人工恢复路径，沿既有启动失败对话框和日志接口展示。恢复失败仍阻止 sweep 和业务启动。
4. 改正退出 Promise 链，保持业务排空、runtime 关闭、archive 排空、失败恢复 runtime 和 transition token 释放的顺序。
5. Publisher 与 RAW 来源准入透传真实取消信号；仅在尚未开始的准入阶段将用户取消归入既有 cancelled 结果，不让取消被资源超时覆盖。已提交发布仍按原发布事实和退出屏障恢复。

## 风险优先计划

1. 对真实准入与原始退出函数写行为回归，复现旧错误。
2. 实现统一准入并接入全部相关 Main 阶段，再补齐聚合错误明细。
3. 验证零预算、永久不足、暂时竞争、超时后释放、资源足够、取消、真实恢复重试和退出失败重试。
4. 运行相关回归与 lint；记录自动化结果和真实应用未执行的边界。无 schema 或数据迁移，回滚只涉及源码与测试。
