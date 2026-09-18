# v3.2.3 Pre-evidence Stabilization — Preflight

## Task Brief

- Goal：消除最终全量 unit 暴露的归档 root identity 竞态，并让已冻结的 v3.2.2 release evidence 在后续 v3.2.x 对共享 implementation sequence 做合法只追加时仍可审计。
- Context：最终 E10-B head 为 `259b3cf6bf5a4414dc81bbc40f859b8b30b3e430`；R3.2.3 evidence 必须保持单父、5 文件纯新增，不能承载生产或旧版 validator 修复。
- Constraints：不改变金额、币种、Workbook、事务、幂等、恢复和 production enablement；不放宽 reviewed Git blob；不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：归档迁移在后台扫描先后顺序不同的情况下稳定返回 storage-root 专用错误；v3.2.2 sequence 仅允许冻结全文之后追加 `v3.2.x` 顶层章节，冻结前缀或任意尾随文本仍 fail closed；定向测试与全量 unit 通过。

## Unknowns Register

| 未知 | 类型 | 当前证据 | 处理 | 决定 |
| --- | --- | --- | --- | --- |
| 归档错误码不一致是竞态还是合同漂移。 | PROBE | 同一用例独立执行通过，全量并发时偶发先收到 ArchiveService 的 `ARCHIVE_PATH_SYMLINK_REJECTED`。 | 检查 migration 入口与 background scan 停止顺序。 | 在选择目标和暂停后台任务前由 StorageRootManager 先验证当前 root identity。 |
| v3.2.2 evidence 能否忽略当前共享文档。 | BLOCK 放宽 | reviewed blob 仍有效，但 v3.2.3 在文件尾追加 E10-B 章节。 | 比较 reviewed bytes 与 current bytes。 | 不忽略；仅对指定 sequence 允许 reviewed 全文保持不变后的 `## v3.2.x` 追加。 |

## 风险优先计划

1. 先以既有失败用例复现 root identity 先后顺序。
2. 在迁移入口建立单一 storage-root 错误权威。
3. 对 v3.2.2 sequence 增加 exact 或 versioned-append-only 两种显式策略。
4. 用正反例锁定冻结前缀、章节边界和非 sequence 文件仍为 exact。
5. 运行定向测试、全量 unit、integration 与 smoke；执行资金/恢复 blindspot 复核。
