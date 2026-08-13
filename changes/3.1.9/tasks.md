# v3.1.9 Tasks

> 本文件按确认 Spec §14 的 PR 拆分维护。当前分支基于
> `98ddcf9fc02193381f7b31fd5e0252de6476479a` 仅实施 PR2；PR3—PR7 保持未实施。

## PR1 — 批次身份与数据库迁移

- [x] 锁定 `origin/main@63c1ce46357587643e506768f712352cbb6c7127` 与 v3.1.8 基线。
- [x] 原样归档确认 Spec，记录 C01—C14。
- [x] 完成 unknowns-first preflight 与 v1 archive 回归基线。
- [x] 新增 `archive_daily_sequences`，按历史 `archive_batch_sequences` 游标之和幂等 seed。
- [x] 为 `archive_batches` 增加 v2/task/parent 字段与索引，历史 v1 不重编号、不猜 parent。
- [x] 为 `archive_artifacts` 增加 layout 预留字段，不实现目录物化。
- [x] 实现原子 `reserveTaskBatch`、全局本地日流水、operation key 幂等与失败回滚。
- [x] 实现真实 latest issuance 只读查询，删除最后批次后不倒退、不复用；v1 游标推进不伪装 v2 发行。
- [x] 实现 task 状态 CAS、DTO 映射、`parentRunId` 关联批次查询基础。
- [x] 实现持久 flow anchor repository/service 薄接口、幂等绑定与 module/parent 血缘拒绝。
- [x] 保持 v1 `createBatch` / ArchiveService / Controller 行为兼容。
- [x] 完成 Spec §15.1 PR1 核心矩阵和 archive 单元回归。
- [x] 完成 blindspot/reconciliation 复核并记录证据。

## PR2 — 任务生命周期与策略注册表

- [x] 建立 prepare / execute 两阶段 handler 契约；picker、纯校验和危险确认在预留前完成。
- [x] 建立 `TaskLifecycle`，固定 `BOR.begin → reserve → started → ALS execute → append → terminal CAS → BOR.end` 顺序。
- [x] 预留失败不执行业务；业务失败/取消保留批次；存档失败不覆盖业务成功结果。
- [x] 建立精确 `TaskPolicyRegistry`、裸 IPC inventory 与无 wildcard 的 coverage 契约。
- [x] 建立 `BusinessFlowResolver`，只使用显式 parent 或持久业务 identity；禁止月份、hash、renderer state fallback。
- [x] 建立可序列化、只读 worker batch context；worker 只继承父 action，不自行分配批次。
- [x] 将 operation tracker 收敛为无活动批次内存的文件 resolver / append adapter；禁止成功后建批或 find-latest。
- [x] 建立 12 个现有 archive primary scope 的 `module-scope-registry`，内部 alias 与可见 scope 分离。
- [x] 接入现有 12 个 archive scope，不改业务算法、导入事务、worker 恢复点和导出内容。
- [x] 完成 Spec §15.2/§15.3 的 PR2 可承担自动化、`release-check` 与 `check-vars` 关联 review。
- [ ] 完成 PR2 P0/P1 GUI、真实崩溃/重启与资金结果人工验收；自动门禁通过后等待用户测试。

## 后续 PR（本分支不实施）

- [ ] PR3：VCC 财务 OP 与工具箱真实接入。
- [ ] PR4：年/月/日/批次目录、hardlink/copy、repair/cleanup。
- [ ] PR5：存储地址、marker、journal、迁移与恢复。
- [ ] PR6：统计、批次列表/详情、关联任务 UI、设置页与 latest-intent。
- [ ] PR7：版本号、发布文档、全门禁与 Windows 人工验收。
