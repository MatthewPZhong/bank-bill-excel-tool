# v3.2.3 Pre-evidence Stabilization — Implementation Notes

## Decisions

- `changeStorageLocation()` 在打开目标选择器、暂停后台扫描和启动迁移前，先调用 StorageRootManager 自身的 `_assertRootDirectory()`；因此 source root 被 symlink/reparse replacement 时始终由 storage migration 合同返回 `ARCHIVE_STORAGE_SYMLINK_REJECTED`。
- v3.2.2 validator 仍以 reviewed commit/path/blob OID/SHA-256 为权威；只有 `CONTRACT-SEQUENCE-3.2.2` 使用 `VERSIONED_APPEND_ONLY`，且 current 文本必须完整保留 reviewed 文本，并从 `## v3.2.` 顶层章节开始追加。
- v3.2.2 Spec、TechDoc、policy、action evidence 与全部 base anchors 继续 exact；未引入通用“忽略 current drift”开关。

## Assumptions

- `implementation-sequence.md` 是跨版本累积索引，后续 v3.2.x 章节追加属于预期；冻结 3.2.2 内容本身不可改写。
- 提前 root identity 校验只把既有 fail-closed 结果稳定到更具体的错误码，不改变任何迁移成功路径或文件写入顺序。

## Deviations

- 原计划的 R3.2.3 evidence-only 提交前新增独立 stabilization 节点；原因是全量 unit 证明问题跨越生产 root identity 与旧版 evidence validator，不能塞入 5 文件纯证据提交。

## Evidence

- `node --test tests/unit/main-process/archive-storage-root-migration.test.js`：`46/46 PASS`；source root replacement、target symlink、cleanup-pending 与未知内容路径均保持 fail-closed。
- `node --test tests/unit/scripts/v3-2-2-release-evidence.test.js`：`28/28 PASS`；覆盖 reviewed prefix mutation、重复 v3.2.2 标题、非法版本标题、任意尾随文本与非 sequence exact policy。
- `npm run test:unit`（最终精确工作树）：`6580` tests，`6577 PASS / 0 FAIL / 3 SKIP`。
- `npm run test:integration`：`53/53` scripts、`2488/2488 PASS`；自动更新的 integration policy 耗时清单已还原，不进入提交。
- `npm run smoke`：PASS。
- `node --check`（3 个变更 JS）、定向 `npx eslint` 与 `git diff --check`：PASS。
- blindspot 复核发现首版 append-only 只识别 `## v3.2.` 前缀、未证明版本晚于 3.2.2；已改为解析首个追加版本且要求 `v3.2.3+`，正反例测试已关闭该问题。
- reconciliation 复核：本节点不改账号/主体/金额/币种、借贷方向、匹配、回填、行数、Workbook、事务、receipt 或重试语义；未发现新的资金红线触点。

## Remaining Unknowns

- `PROBE / release owner`：Windows reparse point 真实环境仍由既有 Windows/人工门禁负责；本修复不把本地 symlink 测试升级为 packaged Windows PASS。
- `BLOCK / 人工复核`：资金与恢复人工复核仍为 production gate；自动测试不能解除。

未运行 `release-check`、`check-vars`、`scan:vars`，按用户明确要求跳过。
