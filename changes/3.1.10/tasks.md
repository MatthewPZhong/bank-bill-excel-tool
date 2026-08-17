# Tasks — v3.1.10 VCC storage compaction

## Task 1 — 合同与schema
- 目标：冻结v2表、DTO、索引、兼容marker。
- 验证：schema/foreign key/index测试。
- 状态：done（本地实现与聚焦证据）

## Task 2 — 导入纵切
- 目标：staging分类、slim effective、compact anomaly、fallback与计数守恒。
- 验证：detail/system/取消/崩溃矩阵。
- 状态：done（本地实现与聚焦证据）

## Task 3 — Archive lineage与business hold
- 目标：SHA来源、artifact绑定、retry清fallback、删除/retention阻断与释放。
- 验证：Archive repository/service/TaskLifecycle真实SQLite+FS测试。
- 状态：done（本地实现与聚焦证据）

## Task 4 — 导出与UI
- 目标：删除详情分页，六列异常导出，完整/部分原表重建与提示。
- 验证：writer Excel回读、renderer/main/preload/service合同与完整性故障。
- 状态：done（本地实现与聚焦证据）

## Task 5 — Copy-on-write迁移
- 目标：维护准入、checkpoint/space、转换/守恒、journal/原子切换/删旧库。
- 验证：故障注入、双启动、真实副本dbstat。
- 状态：done（真实库dbstat/Windows仍为发布门禁）

## Task 6 — 发布门禁
- 目标：回归、性能、important vars、文档和人工清单。
- 验证：lint/node/diff/check-vars/release-check/Windows/资金人工。
- 状态：in_progress（独立 Ultra Review 已最终 PASS，无 surviving P0–P3；PR #147 首次 Windows CI 暴露 tag shallow checkout 与文件 fsync 句柄问题，已修并完成本地 release-check，等待远端复验；真实库、packaged Windows 与资金人工仍为发布阻断项）
