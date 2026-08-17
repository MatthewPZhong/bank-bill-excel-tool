# Tasks — v3.1.10 VCC storage compaction

## Task 1 — 合同与schema
- 目标：冻结v2表、DTO、索引、兼容marker。
- 验证：schema/foreign key/index测试。
- 状态：done（本地实现与聚焦证据；历史 exact binder 仅在 canonical Blob 初次及切换边界物理 SHA/size 双重复验通过后绑定）

## Task 2 — 导入纵切
- 目标：staging分类、slim effective、compact anomaly、fallback与计数守恒。
- 验证：detail/system/取消/崩溃矩阵。
- 状态：done（本地实现与聚焦证据；PR review 补齐同批冲突 peer hash/diff）

## Task 3 — Archive lineage与business hold
- 目标：SHA来源、artifact绑定、retry清fallback、删除/retention阻断与释放。
- 验证：Archive repository/service/TaskLifecycle真实SQLite+FS测试。
- 状态：done（本地实现与聚焦证据）

## Task 4 — 导出与UI
- 目标：删除详情分页，六列异常导出，完整/部分原表重建与提示。
- 验证：writer Excel回读、renderer/main/preload/service合同与完整性故障。
- 状态：done（本地实现与聚焦证据；PR review 补齐 SYSTEM_OP 未绑定原件临时 fallback，以及 `success_with_skips` 绑定后的有效主体重建）

## Task 5 — Copy-on-write迁移
- 目标：维护准入、checkpoint/space、转换/守恒、journal/原子切换/删旧库。
- 验证：故障注入、双启动、真实副本dbstat。
- 状态：done（回滚前持久化 `rolling-back` 与 failed path；target/source 两种候选位置及 `switched` 首次复验失败均恢复 v1；真实库dbstat/Windows仍为发布门禁）

## Task 6 — 发布门禁
- 目标：回归、性能、important vars、文档和人工清单。
- 验证：lint/node/diff/check-vars/release-check/Windows/资金人工。
- 状态：in_progress（PR #147 第三轮 2×P1+1×P2 已红绿闭合；核心27/27、相邻118/118、release-check 5198/5198 + 48/48/2385 全绿；待远端 Windows CI 与 review 复验；真实库、packaged Windows 与资金人工仍为发布阻断项）
