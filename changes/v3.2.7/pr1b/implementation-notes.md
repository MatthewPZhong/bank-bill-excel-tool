# PR1b 实施记录

## Decisions

- 以 E5 和独立交接记录为基线；新生产入口保持关闭，后续工作本地分支推进。
- 复用现有同连接 SAVEPOINT、TaskLifecycle、ArchiveService 和后台恢复平台。
- Inspector/Provider 注册先于 freeze；BizOP Main driver 持有模块 gate，启动与显式重试复用同一实例。
- PR1b 使用真实 TaskLifecycle/ArchiveService/原生 worker 构造最小 SQLite 候选链；这只验证目录与恢复，不宣称 Excel 业务导入已完成。
- 目录删除只释放对象自身 INPUT/RESULT holds，历史结果持有独立原件引用；诊断读者以自己的 Task 和载体身份保护报告。
- 初始/Archive owner 阶段共享原 attempt 的预算与单调时钟；未开始完整平台扫描时不提前开放旧 Duplicate Service gate，应用创建 IPC 前再次核验全量扫描事实。
- 新模块 before-dispatch 绑定不能替其他模块满足 PR1a 的 Main 绑定要求；缺少原模块适配时在创建载体前拒绝。
- 共享清单的 legacy 标签沿用平台术语；新增 12 个身份对应受控 Main 入口或内部维护任务，业务入口实际返回未启用，不回退旧 BizOP 算法。

## Assumptions

- 后续 PR 在 PR1a 的本地提交上堆叠；待 PR1a CI 结果反馈后再处理共同基础中的必要修复。

## Deviations

- 第二轮 R1 证实真实终态 Task 的未决来源无法重放 unavailable anchor。本轮将“共享 Coordinator 无改动”收窄为保留接口/协议/调度，只扩展精确重放对同一来源合法终态的空 Task 计划支持。用户已在该评审结论后授权修复；spec 已先同步，决策及验证见 terminal-recovery-remediation.md。

- E5 草图的 native-thread-job 在生产 DDL 映射为 PR1a 的权威 thread-single，身份字段完整保留；增加真实 owner PID/退出证据与共享回收授权摘要。
- Archive 的 READY 回调在既有 repository 同连接事务内执行，失败整体回滚；没有创建新的事务框架。
- 内部增加 UNUSED_CANDIDATE 回收类型，避免指纹复用留下无人跟踪的封存目录。授权来自原业务 receipt，不放宽 ABORTED_STAGE 的无提交收据条件，详见 spec 的宿主与清理合同。

## Evidence

- PR231 评论修复：独立 unavailable Task 计划；批次 overlay 在主操作确定恢复时补齐；Task/批次终态矛盾不再写 COMPLETE，已错误完成的旧缓存也会重新枚举并写入有界冲突诊断，详见 review-remediation.md。
- 修复后 Electron 36.9.5 / Node 22.19 的完整 BizOP 恢复专项 34 PASS / 0 FAIL / 0 SKIP（46562 ms），含 6 个新增故障回归；共享 Coordinator 生产文件无改动。

- 远端 Windows run 34011443931 明确返回目录 fsync unsupported。新增同名文件重试也必须重新确认文件/父目录屏障的修复及拒绝测试；Windows 新功能仍未获启用依据。24 项需要该能力的测试按实际宿主能力标 SKIP，Ubuntu CI 必须先证明目录屏障 supported 再跑完整成功路径；不是放宽生产持久化语义。

- PR1b worktree：`codex/v3.2.7-pr1b`，基于 `98976f6e`，生产编辑前工作区干净。
- E5 ZIP 解压到任务临时目录作只读参考；原设计包未修改。
- 真实 32/128/1024 Task 来源分别为 Inspector 96/384/3072、全量扫描 2/2/2；累计评估 160/640/5120。该探针不是目标数据规模/RSS验收。
- 主进程在 Main COMMIT 后真实退出（exit 73），重新打开主库并使用真实平台恢复，原 Task/receipt/版本收敛；单项测试通过。
- READY 同事务失败回滚、真实 worker 终止拒绝与晚到 exit、未提交 stage 的真实维护 Task 及物理清理测试通过。
- 故障测试发现并修复 batch recovery resolve 缺 finalOutcome，以及后续控制来源对齐未计入持久进展的问题。
- 新增真实 RUN/DELETE 目录基础测试：独立 RESULT holds、保留结果删除输入、关联删除预览完整性、同连接嵌套 SAVEPOINT 故障回滚、旧 receipt 回读 deleted、指纹复用候选回收。
- 两个真实报告读取 worker 证明 producer 失败、单个 reader 退出都不释放其他 reader/publisher 义务；真实 Archive controller 和显式 IPC retry 使用同一个模块 driver。
- Electron 内置 Node 最终专项 51/51 PASS（27 项 PR1b + 24 项共享关闭/宿主）；详细计数和内存记录见 validation.md。
- 4096 项真实目录任务完整枚举约 2.14 MiB；第 4097 项预检拒绝，平台扫描/后处理为零。最终扫描新增未决任务保持阻断且没有第三次扫描。
- 并行高负载下，原 1024 来源 Electron 试验在 60 秒停止（383 次 Main 调用、382 项完成）；没有提前放弃在途调用。复杂度测试改为固定注入准入时钟、独立记录墙钟和 RSS；生产 60 秒及有界在途截止测试保持原值。

## Remaining unknowns

- U01—U05 已通过主库/原生 worker/平台/真实宿主及清单回归；E01—E03 已确认，相关业务门禁关闭。
- PR2 PROBE：正式大文件的校验、索引与封存应在受资源调度的 worker 阶段完成；PR1b 的小型候选探针不作为大文件 Main I/O 性能或容量证据。
- PR2 PROBE：T01 两路线比较与冻结、混批 XLSX 和公共 writer 仍待实施。
- 完整 release-check exit 0：lint/smoke 通过，单元 6985 PASS/3 SKIP/0 FAIL，53 个集成脚本 2488/2488 PASS；追加三项边界测试系统 Node 3/3 和最终 Electron 全专项通过，见 validation.md。
- 尚未修改生产开关、用户数据或发布版本；PR1b Windows、目标规模和人工验收未运行。

## 业务合同确认（2026-09-06）

用户在明确解释输入拒绝、账号前导零与 15 位数值界限、日期歧义、公式拒绝、高精度文本输出、描述集合及第 14/15 列缺失显示后，回复“全部采用上述规则”。E01—E03 自此冻结；该确认是业务规则批准，不代表实现或人工验收已通过。

- E01：文本账号保留；可靠非负整数账号至多 15 位；纯零显示格式恢复前导零；小数、负数、复杂格式及不可信长数值拒绝。
- E02：两套 Excel 日期系统及无歧义日期；歧义和带时区日期先拒绝；公式输入拒绝；无损数值导出，否则文本金额并标明。
- E03：优先端冲突描述留空、候选进入说明；去空白后的值集合比较，大小写有别；多原因稳定组合；终止余额和流水可确定时第 14 列可显示，缺起始余额则第 15 列留空。
