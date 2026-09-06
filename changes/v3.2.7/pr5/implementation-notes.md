# PR5 实施记录

## Unknowns Register

| 项目 | 分类 | 证据与处置 |
| --- | --- | --- |
| 真实 IPC 当前都拒绝新业务 | PROBE 已确认 | ipc.js 只有禁用占位；本 PR 装配 Main 服务依赖与 preload，生产断言仍由 PR6 控制 |
| 操作月份与当前对象 | PROBE 已确认 | runs 有 operation_month；datasets 从 activated_at 取成功月份。只列 ACTIVE/PUBLISHED，原表来源另以有界元数据页展示 |
| 预览/确认间变化 | PROBE | 持久 token + generation + 完整闭包摘要，confirm 时复核；失败不自动扩大选择 |
| 删除计划工作量 | PROBE 已确认 | 只涉及目录关系，不扫描明细；预览严格受既有 64 KiB 控制文档预算，确认的规范化/核对走已注册 delete-plan 原生 job |
| 历史结果、原件和用户锁 | PROBE | 复用 commitDelete 精确 owner holds 和 reclaim；真实文件测试两种模式与重启，不直接删除 Archive blob/外部文件 |
| UI 偏好 | 已确定 | E5 §6 的布局、列序、按钮、操作月份和导出入口，直接实现并截图验证，不重开业务选择 |
| 上线门禁 | OPEN | Windows、目标规模、人工资金/Excel 和 PR6 激活均未通过，本 PR 继续默认关闭 |

## Decisions / Evidence / Deviations

实施中持续更新；最终 review 和 validation 随本 PR 提交。

- 月份沿用现有 run 目录的 UTC 成功时间口径；输入由固定 activated_at 派生，增加表达式索引，不新增可与时间戳漂移的冗余字段。页面显示相同存储口径，不因本机显示时区变化改操作月份。

- 真实 IPC 主窗口及主 frame 校验；选择引用 10 分钟、最多 64 个待处理引用，绑定窗口/action。requestId 以请求摘要去重，同窗口业务串行；近期完成请求有界保留，选择已消费时不能通过新 requestId 重放。
- 20 个 Main/preload 入口一致；7 个导出 action 逐项 literal invoke，保持仓库的接口清单检查能力。新增 8 个排除频道不改变 71 file / 63 no-file 分类。
- preflight 固定当前 generation；提交在原 EXCLUSIVE 区间核验。页面处理异步预检/列表的晚到响应，错误保留日期且阻止重复任务。
- 完整预览可用既有控制文档上限：64 KiB、最多 4096 元数据评估，不改成截断清单；选择文件上限沿用 4096 来源预算，完整响应仍守 256 KiB，超限提示缩小选择。
- KEEP_RESULTS 缺结果说明是实现复核中补上的故障链。预览增加 manifestDigest，删除前及已提交恢复/回收前核验保留结果、说明、RESULT holds 和实际原件；读取原件的额外阶段以既有 Governor 1 GiB 准入，真实返回后释放。更晚合法独立删除的结果不由旧 KEEP_RESULTS 复活。
- 取消现在覆盖 worker 之后的导入/计算封存核验；Main 在最后事务前重新检查 signal。共享平台核心不改，Provider/回收挂钩仅在 BizOP 模块内部。
- 第一次完整检查 3 个旧接口清单断言失败；修订后专项 35 PASS。最终全量仍待重跑结果，不能用专项替代全量。
