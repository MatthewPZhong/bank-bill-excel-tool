# PR4 实施记录

## Unknowns Register

| 项 | 分类 | 验证安排 |
| --- | --- | --- |
| 旧 reader 默认全内存 SST | PROBE 已确认 | 复用 PR2 rich reader 的单活跃扫描和双限 provider，新增多页组合；单页输入入口保持原先严格限制 |
| 旧 writer 只支持同表头 | PROBE 已确认 | 复用 ExcelJS 流式核心，BizOP 适配各类页及说明；验证背压和关闭 |
| 公共 Publisher 资源和消费证明 | PROBE | 使用同一现有 dispatcher 的 actual exit barrier，现有 Governor 单独租约；Main 持久化原发布尝试身份和权威恢复观察 |
| 已提交反馈丢失和未提交恢复 | PROBE | 原 Publisher journal 为唯一提交事实，Task/Archive/pin 收口引用该事实，补真实进程故障链 |
| 六类输出全列完整性 | PROBE | 六类首尾列/N+1/null/缺行/错页/说明改动矩阵；FLOW_RAW 第 28 列明确覆盖 |
| Windows / 最大规模 / 人工资金与 Excel | OPEN | 不用小样本替代，生产开关继续关闭 |

## Decisions / Deviations / Evidence

- PR234 评审修复：保留既有 SST provider 的自动清理，将两个读取入口改为唯一子目录。7 项新增 Electron 回归全部通过：OP_RAW / FLOW_RAW 各两份真实溢出原件，经 native worker、Task、Publisher、Archive 发布；RAW 扫描取消/失败；actual 回读成功/取消/摘要不匹配。每份大文件 600 个 30006 UTF-16 字符字符串，超过真实 32 MiB 缓存预算；实际观察 `sst.bin` 清理并验证父目录、spool、输出不被删除。actual 测试仅在临时输出中注入合法共享字符串表及引用，不改变预期内容或校验强度。未修改公共 provider 或 StartupRecoveryCoordinator。

- 原 E5 设计包只读，输出 registry 引入本期代码并注明 E01—E03 已批准。
- expected 临时 SQLite 保存固定有类型值及位置，增加一次顺序磁盘读写，避免整表内存及 reader 同步回调积累异步队列。
- 实施中持续更新，最终验证见 validation.md。

- 故障实验发现 READ 先持有 Batch overlay、OPERATION 后完成的 CAS 冲突。已把任务/批次推进固定给主来源，READ/CARRIER 保持自己的 Hold 与读取保护；未放宽共享平台的 CAS。
- 实际主进程在发布前、已提交但未记录观察、已记录提交但未归档时退出，三条重启路径通过；Task/receipt/run 版本不复制、不重算。
- 新增 File Task 可选终态前 owner 校验（见 spec）。这是实施偏差，因 execute 抛错在外部提交不明时会被通用分类器视作失败；新钩子让 owner 保留原任务供权威恢复，不更改其他任务默认分类。
- 旧启动 Archive owner 的共享 journal 观察经预算包装后过滤 BizOP 接管；本模块仍使用原 dispatcher 及其实际 exit barrier，全部 ACK 只能在原 Task/Archive 对齐后完成。
- 持久 commit_proof 不随后续 ACK attempt 的 STARTED 状态清空。本地 ACK 写入故障注入证明：既有 Publisher 已删 journal 后，重试仍保持同一已提交事实。
- 六类 72 项损坏注入拒绝；实际 native 写出中取消保留旧用户目标。新读取 Task 的诊断 pin 阻止 producer 失败后的清理，待 Publisher 消费后才回收。
- 类型测试的说明列断言最初误把第 1 列序号当记录类别；已按固定第 2 列修正测试，actual 摘要及 Excel 文本/布尔/精度回读本身通过，未修改产品契约。
