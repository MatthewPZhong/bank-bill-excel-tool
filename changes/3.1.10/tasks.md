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
- 状态：done（回滚前持久化 `rolling-back` 与 failed path；target/source 两种候选位置、`switching` 不可读候选及 `switched` 首次复验失败均恢复 v1；真实库dbstat/Windows门禁已在正式发布前人工确认 PASS）

## Task 6 — 发布门禁
- 目标：回归、性能、important vars、文档和人工清单。
- 验证：lint/node/diff/check-vars/release-check/Windows/资金人工。
- 状态：done（真实库与资金门禁不可豁免；功能 PR #147 与发布收口 PR #148 已合入；用户明确确认真实约27.42GB副本迁移/至少下降75%、packaged Windows SQLite/WAL 与主体×九币种/artifact SHA 三项均 PASS，Windows 门禁未使用 Runbook 豁免；`main@35f11e153962c34cba0e9d4c7084e9df85c9f209`、annotated tag `v3.1.10`、Release workflow `32005912319`、latest stable Release 与四项公开资产均完成回读）
