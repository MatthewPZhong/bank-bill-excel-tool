# PR4 业务与工程复核

| 边界 | 事实与验证 |
| --- | --- |
| 原文件与固定版本 | RAW 重读原件完整 23/28 列的指定日切片；先 Archive 摘要验证再 worker 独立读取；CHECK 与 RESULT 读已封存分片。历史结果不查询当前 head，版本/来源写说明 |
| 证据完整性 | 每类首列/末列/列外显式空 c/末行/账号/金额/表头/页/说明的 72 项反向注入；FLOW_RAW 第 28 列包含在摘要；关系类型沿用共享精确 allowlist |
| 精度和空值 | 数值复用现有 15 位无损分类；长精度作为文本并加 PRECISION_NOTE；NULL、空文本、数值零、文本零、布尔、公式样式文本和控制字符独立往返验证 |
| 读取与写入 | temporary SQLite + 同步公共 writer；每次一页流；复用 ExcelJS OOXML/ZIP，替换不提供背压的内存流适配；actual 复用 rich scanner 与双限 SST，无全量 cells/SST |
| 发布与资源 | 同一原生 job 包含 expected→writer→actual；真实退出后 Main 小报告校验；原件核验/Publisher/Archive 输出各领取独立 1 GiB 容量；复用唯一现有 dispatcher，拒绝目标身份变化 |
| Task/恢复 | 新可选终态前 owner 钩子拒绝把提交未知写成失败；3 处真实 Main 退出、归档失败、确认后本地 ACK 失败都有原 Task 恢复证据；commit_proof 不随 ACK 尝试退回未知 |
| 来源归属 | READ/CARRIER 的 Hold 独立，Task/Batch overlay 由主来源拥有；共享平台 CAS、committed-only Provider 和两次全扫预算不变 |
| 旧入口旁路 | 旧 Toolbox/VCC 启动 owner 仍观察原 journal 根，但不能替 BizOP 接管或 ACK；blocked 时保留来源与 pin |
| 诊断 | producer 已失败仍不能删除新导出任务在用的报告；实际 Publisher 读取结束后由原回收入口删除退休报告 |
| 用户文件 | 实际写出中取消与目标被改写均保留旧/新用户内容；未提交候选只由清理清单回收，原件及外部副本不在本模块删除范围 |

## check-vars 关联功能

- 自动命中 Critical `freezeWorkerBatchContext`：调用既有严格 exact-7 冻结函数，binding、Publisher 反馈及恢复结果均比较完整 task/batch 身份，没有把 session/runtime 字段塞进公开 context，没有放宽 schema。真实 FilePlan/Publisher/Archive 故障测试以及原 TaskLifecycle 回归覆盖该链。
- 自动命中 Runtime-state `state`：新增 SQL/局部状态，不是 renderer 全局 state；仍逐项复查 STARTED、CLOSED_UNKNOWN、COMMITTED/NOT_COMMITTED、ACK、cleanup 与 pin 的释放条件。
- 人工补充共享 `TaskLifecycle` 的可选 `beforeTerminalSettlement`：不传时行为不变；传入时拒绝发生在自动 settlement 与 terminal 之前。已同步 spec 记录接口差异，应用内置 Electron 专项同时回归既有 File Task。
- Critical 要求的 smoke 包含在完整 release-check，结果及日志见 validation.md。

未发现需要扩大 StartupRecoveryCoordinator 或 parser pool 改造的存活问题。Windows 目录 fsync、本期最大规模、Excel/WPS 打开与真实资金人工样例仍为未执行门禁；本 PR 保持生产禁用，不声称可以发布。
