# PR231 第二轮 R1：终态来源恢复

## Goal / Context / Constraints / Done when

- Goal：修复真实终态 Task 带有未决来源时，Inspector 暂时失败留下无法重放 anchor 的 P2；同步既有堆叠 PR。
- Context：用户在第二轮评审和真实 Task/独立进程复现后授权“修复”；沿用本地提交后直接推送远端 PR 的授权。
- Constraints：保留业务终态、receipt、版本、原件与读取保护；E5 调度预算、committed-only Provider、公共 writer、E01—E03 和生产 disabled 保持。允许共享 exact 重放合同的最小兼容扩展，不改平台接口和持久协议。
- Done when：无/有同源 Hold、anchor 与原子 bundle 的中断重放、重复恢复均收敛；原有 prepared/running 与其他模块拒绝测试通过；真实失败/取消待回收及成功待 ACK 的任务恢复可继续；最终组合检查和远端结果如实记录。

## 已确认事实

- 真实导入失败、操作级取消和成功导出待 ACK 均能产生终态 Task 与未决来源。
- 原代码在阈值后先持久 anchor，再因终态拒绝计划；依赖恢复及独立进程重启时，Inspector 调用为零。
- 原 exact checker 仅在已有 Hold 或没有 taskState 时允许空计划；只修改业务 return [] 无法覆盖 anchor 后崩溃。
- JPM 等既有调用者依赖原有持久化和精确拒绝路径，需完整兼容回归。

## Unknowns Register

| 项目 | 处理 | 证据/决定 |
| --- | --- | --- |
| 无 Hold 的终态来源如何精确重放 | PROBE | 只增加真实终态、同 taskRunId/operationKey、无恢复中标记的空计划支持；复用原观察/Hold 原子事务 |
| 终态与 receipt 矛盾会否误开门 | PROBE | 保留现有 alignment 冲突判定；补故障前后终态与 receipt 不变、入口持续阻断的反例 |
| 旧 shared planner 兼容 | PROBE | 原 JPM durable E11-B、C2、RecoveryControl 与 BizOP prepared/running 全部回归 |
| 两条 Windows CI 失败原因 | PROBE | 分别追踪 Duplicate shutdown 的真实 exit 顺序与大文件 RSS 采样/读取资源；不调整门槛掩盖失败 |

## 风险优先计划

1. 先对齐 source 与 Task 权威身份、终态保留及原子重放合同。
2. 用真实平台和磁盘库覆盖故障窗口、重复恢复和拒绝反例。
3. 在下游 Excel/Publisher 已实现的 PR 补真实导入/导出来源回归。
4. 独立定位 CI 失败，运行最终组合检查，再按现有分支顺序普通合并传播和推送。

## Evidence

- 修复前复现记录：PR6 outputs/pr230-236-second-review-20260906；三个真实终态流程在同进程重试和新进程启动均失败。该记录为缺陷证据，非功能 PASS。
- 共享 C2/RecoveryControl/JPM E11-B：148 PASS/0 FAIL；BizOP 恢复专项：35 PASS/0 FAIL。新增共享 19 项包含真实持久 Task、12 个终态/Hold/中断窗口组合和 7 个拒绝反例；BizOP 新增真实失败候选的重复不可用及最终收敛。
- 测试宿主初版缺少 parentRunId，19 个新增检查在进入恢复前失败；补齐既有 Task 创建合同后上述检查通过，没有修改生产 Task 创建要求。
- 最终 C2 与 BizOP 组合 96 PASS/0 FAIL（48.6 秒）；追加验证 unavailable 恢复后真实 Task/receipt 冲突仍然阻断，并在 Inspector 回调外检查结果，防止回调断言异常被重试语义吞掉。

## Windows 关闭 CI 的独立修复合同

- 失败日志中的 SERVICE_UNEXPECTED_EXIT(code=0, signal=null) 可以由已验证 executor:close-ack 后同一调用轮次正常 exit 稳定复现；此时 closePromise 尚未从 await 继续，旧逻辑把关闭误记为崩溃。
- 只在当前 generation 处于 closing、匹配当前 closeControlId 的 ACK 已通过全部协议/期限检查、exit code=0 且无 signal 时交回既有正常关闭流程。仍由原 closeGeneration/cleanupRawTransport 等待载体并释放资源；未收到 ACK、非零退出或信号退出保留错误，不提前释放租约。
- 新增三个时序回归，修复前正常退出一项失败、非零与信号退出两项拒绝通过。此确定性缺口与 CI 症状一致；真实 Duplicate 持久化窗口的回归及最终 Windows CI 仍需单独核验。
- 修复后 ServiceHost、共享关闭观察、真实 Duplicate paired parser 全组 88 PASS/0 FAIL（24.2 秒）；包含 CI 失败的真实 persist/shutdown/回滚用例。lint 与 diff 空白检查通过。check-vars 仅词法命中 record.state；清单定义的 renderer.js 全局 state 未修改，其模板/模块/导出 UI 联动不受该局部字段影响。

## Remaining unknowns

- 上述新增回归与最终组合验证待执行；Windows 目录耐久、目标规模和人工验收仍保持原门禁。
