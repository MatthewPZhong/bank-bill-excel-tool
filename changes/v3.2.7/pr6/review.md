# PR6 关联复核与盲区检查

范围：E5 的一次性清旧、旧入口退役及门禁。保留“有条件通过的分 PR 基线”，交付配置仍禁用，代码与合成测试不代替实际启用验收。

| 边界 | 复核结果 |
| --- | --- |
| 启动先读模式 | AppDatabase 在旧六表 DDL 前读 control；Main 初始恢复注册器仍先冻结；Archive 首个 BizOP owner、post-outbox 与重试共用本模块 driver |
| 旧调用旁路 | 旧命名空间所有 pick/read/write 回调前动态 guard；run/month-end owner 在新模式退役；Main 后置 orphan 跳过旧模块，底层 orphan/删除也检查主库；旧侧库 open/create 与直接路径删除检查模式 |
| 二进制降级 | 主库持久 trigger 阻止旧 BizOP Task 创建；空旧表拒绝 INSERT/UPDATE/DELETE。新业务校验 guard 本体，删除/篡改 guard 不能只靠 ACTIVE 字段放行；不声称自动恢复旧数据 |
| 限定删除 | 只六表、严格旧根和月文件/已核实 WAL/SHM；外部 FK、同名改写 trigger、未知文件和不安全链接拒绝；没有 LIKE 猜删配置、递归删 run-data 或 Archive 清理 |
| 原件与资源 | 用户锁、历史 holds、shared blob、原批次、flow anchor、外部文件保留；旧未决 artifact 原路径阻断；原 provider 的真实连接关闭独立观察，native job 与 lease 等待实际退出 |
| 原任务恢复 | 7 个真实 process.exit 位置，包括有 carrier 的启动点和 unlink 后记账前；复用原 Task/intent/阶段，不生成新业务成功或新迁移 Task。未知旧任务保留在 protected inventory |
| 平台兼容 | TaskLifecycle 可选 terminal hook 补齐 no-file；UPGRADE 主来源保持 unknown，已关闭独立 carrier 可依法收口；共享 Coordinator 未修改。候选/旧清理 I/O 无主库权限，最终普通收据由 Main 提交 |
| 生产门禁 | 所有新 action 分别有证据，总门禁缺任一项均 false；Main 使用 production:true；版本、renderer 或环境变量不能传入启用参数；仅 temp 测试注入合成证明 |

## Important variables

`check-vars` 命中 Runtime-state `app`。核对启动/退出：启动仅在单实例锁、尚无业务窗口和活动业务时准入；未决意图持久后不能恢复旧写模式；现有退出、更新与未保存草稿处理未改。Main 的 action-task binding startup 首语句、Pending 初始化、Archive root journal 与创建业务窗口顺序保留。`check-vars` 的退出码 2 表示有关联检查项；不表示 lint/test 失败。

## 资金与人工门禁

本 PR 不改 E01—E03、金额、账户、日期、结果列和删除模式。所有资金链路测试使用合成数据，保留原 receipt/原件/用户锁的验证可审计。实际清旧属于既定人工验收后的动作；当前发布证明缺失且开关关闭，因此不进行真实清旧，不将代码通过写成资金或用户验收通过。
