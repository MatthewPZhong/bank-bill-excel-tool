# PR231—235 评论修复

本文件记录第一轮修复范围。第二轮 R1 对共享恢复器精确重放的限定扩展及独立关闭 CI 修复，以 `spec.md` 和 `terminal-recovery-remediation.md` 为准。

## Goal / Context / Constraints / Done when

- Goal：修复已核验的恢复、取消、SST 所有权与模态取消问题，并更新现有 PR231—236。
- Context：用户授权“修复”，沿用已授权的本地提交后直接推送远端 PR；PR230 不新增改动。
- Constraints：E5、E01—E03、关闭观察合同与生产 disabled 保持；不修改共享 Coordinator 语义，不直接覆盖已终态 Task，不操作用户数据。
- Done when：修复落在所属 PR，后续分支带入；真实故障回归和最终完整检查通过，验证边界及远端检查状态如实记录。

## Decisions

- 通过合并上游分支向下游传播修复，保留既有远端提交历史，不强制推送。
- Inspector 不可用使用平台要求的专用 Task 计划；恢复批次的初始化和收口由业务主操作承担。
- 成功 receipt 与失败/取消 Task，或批次结果冲突时保留恢复来源和 Hold。COMPLETE 缓存不能掩盖持久事实矛盾；同一冲突重复恢复不改写 receipt、版本或终态 Task。
- 将 PR5 已有的 Main 最终 signal 检查前移至 PR2/PR3；PR2 同时独立拒绝 cancelled 文档并补最终封存取消安全点。
- 每个读取器仅拥有其独占 SST 子目录；取消按钮随活动任务进入顶层 dialog，取消请求仍等待原后台结果。

## Unknowns Register

| 项目 | 处理 | 验证与边界 |
| --- | --- | --- |
| 已持久 anchor、Task/Hold 未完成后的精确重放 | PROBE | 实际子进程中断、真实 RecoveryControl 和 Task/Batch 恢复；不放宽平台校验 |
| 终态 Task、批次 overlay 与提交事实的一致性 | PROBE | 原 TaskLifecycle 提交后异常、重复恢复、已错误 COMPLETE 的历史状态；只读判定并保留冲突 |
| worker 末段取消和 Main 最终提交 | PROBE | 真正文件封存与 manifest await 注入取消，旧 heads/receipt/版本不变；提交后取消保留 receipt |
| 大 SST 清理归属 | PROBE | 原 32 MiB 阈值、真实 XLSX、连续原件、失败/取消及 Publisher |
| 模态框取消可访问性 | PROBE | Electron 用户级鼠标/键盘，3 类模态路径及无模态对照，正确 requestId、一次请求、busy 等待收敛 |

## Evidence

- 修复前已在最新组合代码复现恢复终态矛盾、OP/FLOW RAW 导出目录丢失及 3 类模态取消不可达；这些复现不是通过的功能验收。
- PR5 已有 Main signal 检查通过真实异步核验取消对照；独立 PR2/PR3 尚缺这些改动。

## Remaining unknowns

- 各项修复后的回归待记录。Windows 目录耐久、目标规模、真实资金与 Excel/WPS 人工验收仍属原发布门禁。
