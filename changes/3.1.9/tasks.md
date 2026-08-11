# v3.1.9 Tasks

> 本文件按确认 Spec §14 的严格串行顺序维护。PR1/PR2 代码已冻结到
> `54b6c01fa93751cd723be53af70af726037343b5`；PR2.5-A 已冻结，当前从 A 头实施
> PR2.5-B 读取性能；PR2 人工验收和后续 C1—PR7 仍未完成。

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

## PR2.5-0 — Spec / TechDoc 合同冻结

- [x] 在独立 erratum 目录归档纠错 Spec v2、TechDoc v1.1 和 provenance 索引，不修改 v3.1.8 冻结 Spec。
- [x] 记录 raw/repository 双 SHA 与 12 处 Markdown hard-break 等价格式 normalization。
- [x] 为 v3.1.9 增加只覆盖 VCC 归档兼容、操作保护和性能路径的窄 erratum。
- [x] 冻结严格顺序 `PR2 → PR2.5-0 → PR2.5-A → PR2.5-B → PR2.5-C1 → PR2.5-C2 → PR3-VCC → PR3-Toolbox → PR4 → PR5 → PR6 → PR7`。
- [x] 增量维护 Unknowns Register、决定、计划验收矩阵和发布门禁，不覆盖 PR1/PR2 证据。
- [x] 完成 source normalization、hash/link、Markdown diff 和冻结 release-docs targeted 验证；完整 `release-check` 未在本 docs-only PR 重跑。

## 后续 PR（当前分支不实施，全部串行）

- [x] PR2.5-A：ArchiveEvidenceV2、生效结果纯校验器、classifier/gate 与真实 v3.1.7 fixture；实现与本地自动门禁完成。
  - [x] Phase 0：在系统临时目录跑通真实 tag migration/import/opening/calculate/archive/current migration 链，核对依赖与 legacy-four shape；仓库零文件改动。
  - [x] Phase 1：实现四个纯合同模块、真实 fixture/manifest、10 个 top-level 聚焦测试与管理文档证据；完整 `release-check` 全绿。
  - [ ] 发布人工/真实环境门禁：目标生产 legacy-four/trigger、主体×九币种与跨月资金结果、Windows packaged runtime、约 16 GB 性能；自动测试不替代。
- [x] PR2.5-B：read worker、集合化 evidence、token v2、活动月份/删除目标和读取性能的本地实现与自动证据。
  - [x] 独立 read-only worker、schema-ready、BEGIN DEFERRED、action allowlist 与 Main generation/active identity 复核。
  - [x] current/真实 legacy 集合枚举、v2 canonical token、0/1/100 常数 SQL、active visibility 与结构化 inconsistent 诊断。
  - [x] 一次 DeleteEvidenceV2、renderer shell/loading/skeleton/inline retry、target preview cache 与 refresh-once。
  - [x] 初次/导出租约内二次 legacy recheck、生产 v2→旧 v1 write 单链 fail-closed，以及旧 v1 实现证据显式隔离。
  - [x] SQL trace、query-plan、main lag、target cache 与小 fixture gross regression 自动门禁；blindspot/reconciliation/check-vars 已复核，完整 release-check 全绿。
  - [ ] 发布人工/真实环境门禁：约 16 GB Windows packaged 冷/热 P95/WAL、目标生产 legacy/trigger、主体×九币种与跨月资金复核。
- [ ] PR2.5-C1：mutation guard、adjustment/archive 固定预算与写 worker。
- [ ] PR2.5-C2：current/legacy unarchive、delete 固定计划、进度/取消和约 16 GB 验收。
- [ ] PR3-VCC：VCC TaskLifecycle、七字段 context、BOR/cancel/terminal CAS 和 artifact 接线。
- [ ] PR3-Toolbox：工具箱独立生命周期与文件存档接线。
- [ ] PR4：年/月/日/批次目录、hardlink/copy、repair/cleanup。
- [ ] PR5：存储地址、marker、journal、迁移与恢复。
- [ ] PR6：统计、批次列表/详情、关联任务 UI、设置页与 latest-intent。
- [ ] PR7：版本号、发布文档、全门禁与 Windows/财务人工验收。
