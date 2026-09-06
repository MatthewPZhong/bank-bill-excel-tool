# PR1b：目录提交、读取保护与 Main 恢复

## Goal / Context / Constraints / Done when

- Goal：在本地承接 PR1a，落实 PR0-E5 的 BizOP 主库目录、不可变提交及终止收据、持久读取保护和受预算 Main 恢复闭环。
- Context：基于 PR1a `98976f6e69d2ad78893d050d424cbe18ee8f836a`；原 E5 ZIP 只读，未修改，也不生成 E6。后续分支、提交留在本地。
- Constraints：新业务入口保持关闭；不操作用户数据；不清理旧模块目录；不修改 StartupRecoveryCoordinator 接口、committed-only Provider 或完整数组协议；E01—E03 已获用户确认，T01 在 PR3 前冻结。
- Done when：真实 Task、ArchiveService、原生 worker、平台恢复下，提交反馈丢失与安全未提交两条链均能收敛；未知关闭保留保护；同库回滚、收据优先、诊断读者、累计预算及真实启动/重试绑定通过相关测试。

## 已确认事实

1. `src/main.js:initializeBackgroundExecutionRecovery` 先冻结注册器并运行平台扫描，随后才初始化 ArchiveCenter。
2. `archive-center/controller.js:initialize` 在通用中断批次清扫之前依次调用模块 owner 恢复；仍未决的批次通过 protected batch 集合保护。
3. `archive-center/task-lifecycle.js` 的 `settleArtifacts` 缓存第一次 Promise，提前归档必须一次包含全部需要的输入。
4. `database/archive-repository.js` 的写事务支持同连接嵌套 SAVEPOINT；READY 与 PREPARE hold 需要接入真实 service 提交点。
5. PR1a 提供不可变载体身份和关闭观察，业务结果与载体/资源事实分别收敛。

## Unknowns Register

| ID | 分类 | 未知及影响 | 验证/决策 |
| --- | --- | --- | --- |
| U01 | PROBE | 平台早期扫描与 Archive 可用性如何接合 | 注册在 freeze 前；同一 Main driver 在 Archive owner 恢复阶段完成任务收尾；验证通用清扫保护 |
| U02 | PROBE | READY 同事务完成钩子及失败回滚 | 追踪 ArchiveService 实际 completeArtifact 调用；真实文件集成测试 |
| U03 | PROBE | 12 个新动作分期实现与静态覆盖规则 | 注册完整身份；未完成业务处理明确拒绝；不能用假成功占位或回退旧算法 |
| U04 | PROBE | E5 source 调度、Task 转换和 Hold 所有权 | 使用真实平台、控制仓储及真实 Task 来源；逐来源计费和线性规模验证 |
| U05 | PROBE | PR1a 载体类别与 E5 DDL 名称不同 | PR1a 权威类别为 thread-single；记录明确映射/DDL 收敛，保留全部身份字段 |
| E01—E03 | 已确认 | 账户、日期金额、描述及结果呈现业务边界 | 2026-09-06 用户在逐项大白话解释后回复“全部采用上述规则”；按该口径作为 PR2/PR3 验收依据 |
| T01 | PROBE（后续 PR） | 有序归并或临时 SQLite 路线 | PR1b/PR2 进行小中型比较，PR3 前冻结 |

## 风险优先实施顺序

1. 主库目录、同连接原件保护、不可变收据与回滚。
2. 读取 pin、精确派发身份、诊断独立生命周期及安全终止收据。
3. 最小真实 worker → Main 提交 → Task/Archive/恢复链。
4. E5 预算调度、动作注册和真实启动/重试装配。
5. 相关单元/集成及既有平台兼容回归，记录未执行的规模与人工验收。

## 宿主与清理合同落实

- Inspector 不可用的 `inspection-unavailable-hold` 阶段严格返回平台要求的 Task 中断计划，不能混入批次转换；主操作后续确定恢复时补齐缺失的批次 overlay。
- 目录提交事实、Task 结果与批次最终结果必须一致，才可写 COMPLETE 或开放入口。终态矛盾返回未知并持久保留恢复保护；旧 CLOSED/COMPLETE 缓存也须重新发现此类矛盾，不能直接更新已终态 Task。

- 启动早期有 BizOP 未决来源时，先完整预检并保留本次预算，到 Archive owner 可用后继续同一 attempt；不提前多跑一次全量扫描，也不重置累计预算或时钟。其他模块 owner 在该阶段之后恢复。
- 异步读取在实际调用结束前持有共享准入；结束时关闭或发布读取义务未完成，则持久 pin 保留并关闭业务准入，只允许恢复后重开。升级和 Publisher 尚未接入的权威事实不能按普通失败自动终止。
- 命中已发布指纹的候选不分配新公开版本。内部回收类型补充 `UNUSED_CANDIDATE`，由本次不可变业务收据明确列出弃用对象、清单摘要和生产 Task；只在生产载体关闭且无公开对象/读者后回收，不借用“未提交任务”的终止授权。
- 当前可用性单独回读，不修改业务收据；历史 receipt 对应对象已删除时返回 deleted，重试不重新发布。
