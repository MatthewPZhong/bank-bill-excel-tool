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
- 状态：done（回滚前持久化 `rolling-back` 与 failed path；target/source 两种候选位置、`switching` 不可读候选及 `switched` 首次复验失败均恢复 v1；真实库dbstat/Windows仍为发布门禁）

## Task 6 — 发布门禁
- 目标：回归、性能、important vars、文档和人工清单。
- 验证：lint/node/diff/check-vars/release-check/Windows/资金人工。
- 状态：in_progress（功能 PR #147 已合入 `main@f75af1ed4eb2cd7cead8ffd6562174b2fc24ee6e`；Windows workflow `31993149328` 与最终 reviewer 均通过；发布候选版本号、三份用户文档、release baseline、5201/5201 + 48/48 全量回归及两组 Electron 6/6 布局门禁已闭合，尚待干净候选 Windows 构建与远端候选 PR。真实约27.42GB副本至少下降75%与主体×九币种资金人工必须通过、不可豁免；packaged Windows SQLite/WAL 须通过或按 Windows Runbook 单独留痕豁免。条件未满足前不创建 tag/Release）
