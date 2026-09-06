# PR1b 盲区与关联功能复核

## 已关闭的问题

远端补充复核发现：首次原子写入目录屏障失败后，同名文件重试曾只比较内容即提前返回。已改为重试重新 fsync 文件及 userData 内全部父目录，新增连续两次拒绝测试。目录创建的父级持久化一并明确；后台平台核心未修改。Windows unsupported 是保留的启用门禁，成功路径测试在支持宿主运行，不能按 Windows SKIP 声称实现验收完成。

| 事实与触发点 | 影响 | 处置与证据 |
| --- | --- | --- |
| Main 已提交但反馈丢失、旧 generation 或后来删除 | 误发新版本/复活删除 | receipt 首读，仍校验 task/action/intent；真实子进程 COMMIT 后 exit 73 与 deleted 回读通过 |
| READY 与 PREPARE 分离 | 原件在候选生成期间无人保护 | 同连接同步 READY hook；故障回滚不留下 READY/hold/业务 receipt |
| producer 失败但 report reader 仍在运行 | 报告误删 | 两个真实 reader 独立 pin；载体关闭和 Publisher 义务分别核验，retire 不提前删除 |
| 同 scope 后续来源仅完成控制对齐 | 已完成仍被判无进展 | 真实 syncCompletion 变化计入进展，不用新 observation ID 充数 |
| 启动前置与 Archive owner 重启预算 | 额外扫描/旧模块提前放行 | 同 attempt 延续预算；scan 完成事实控制旧 gate，真实宿主与静态接线通过 |
| 新模块共享 before-dispatch 掩盖旧模块缺 hook | 无持久所有者仍创建 worker | 新模块不能替其他模块提供绑定；创建前拒绝且容量为零 |
| 指纹复用生成多余封存目录 | 无人跟踪的磁盘残留 | 原 receipt 明确 UNUSED_CANDIDATE 授权、真实维护 Task、无公开对象及无 pin 才回收 |
| 最后复查期间产生新来源 | 空队列误开门 | 重读实际义务保持阻断，无第三次扫描；27 项专项包含此反例 |

未发现需要改造共享恢复核心才能继续实施的存活问题。保留 PR2 大文件资源、PR4 Publisher、PR6 Windows 与真实业务规模门禁；这些不能由 PR1b 自动测试替代。

## check-vars 关联功能 review

按 `rules/important-variables.md` 对 PR1a HEAD 后的生产差异及新模块调用做复核：

- Important-skeleton：TaskLifecycle/TaskPolicyRegistry。复用原清单要求“no-file 禁止携带 filePlan、建 batch 或推进 sequence”；本次 12 新身份显式分类，真实无文件恢复及内部维护 Task 覆盖。旧 preload/IPC 集合继续精确匹配；新未启用入口单独注册，PR5 接入页面。
- Important-skeleton：ArchiveCenterController。复用原要求“禁止 renderer 取得 Blob 路径、已登记原始源路径、预期 SHA 或预期大小”；本次只增加启动保护 Task IDs 和内部 READY 适配，不新增存档公共 DTO。设置页/存档 UI 没有改动，未重跑相关布局预览。
- Risk-sensitive：ArchiveRepository/ArchiveService。复用原要求“十四表 schema 必须 additive/idempotent；主库只存元数据/摘要/任务身份”“archive_artifact_holds 是业务引用锁”“删除顺序必须先移除逻辑引用，最后引用才允许删物理 Blob”；真实 SQLite/文件/嵌套事务/共享引用/启动恢复及完整回归据此检查。
- 未改变账户识别、金额方向、匹配键或旧模块行过滤实现。E01—E03 仅记录用户批准，PR2/PR3 仍需按冻结规则实现并用业务样例验收。

人工复核保留项来自原表：“真实输入/结果与 Blob 的 SHA-256、模块归属和首次结果集合；自动测试不能替代”。本次仅使用临时合成数据，不将其写为人工 PASS。
