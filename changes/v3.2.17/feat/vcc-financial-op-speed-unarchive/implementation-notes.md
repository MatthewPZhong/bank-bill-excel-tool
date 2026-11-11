# Implementation Notes — v3.2.17 VCC 财务OP校验提速、解归档放宽与通道明细补录

> 分支：`feat/vcc-financial-op-speed-unarchive`（基线 `v3.2.16` → `8e027cb8`）
> spec：[spec.md](spec.md)；计划已获用户批准（2026-11-10）

## Decisions

- A1：raw fallback 只为 `archive_artifact_id IS NULL` 的来源写入；读取方本就只对未绑定来源读 fallback，旧库已有 fallback 照常可用。
- A2：存档关联同步改用逐来源 `EXISTS` 判断引用（`createReferenceProbe`），已绑定且 hold 与引用一致的来源直接跳过；失败标记、记录状态刷新只在值变化时写库。旧的 `activeReferenceCounts` 全表聚合保留导出给需要精确计数的调用方。
- A3：校验原表列表、导出预览、运行前预检改由只读 worker 执行；导出预览按需加载导出模块（ExcelJS 等约 50 ms，只在该动作支付）。可导出异常数改为按账期三次分组查询（`countExportableImportAnomaliesByMonth`），口径与逐条函数一致。
- A6：`pendingEffectiveFactCount` 由计数改为存在性 0/1；该字段只用于旧 v3.1.7 合同判定（要求为 0）与 token，证据与 token 两侧同步，测试夹具同步。
- A7：汇总不再 `ORDER BY id`，各集合按“最早出现的行 id”重排；同一 Pending 行内先流水币种后 Pending 币种，保持原插入先后。
- A8：工作簿计划路径中，存档交接只核对文件身份并沿用计划 SHA-256（存档中心落盘仍按该 SHA-256 校验）；正式导入对存档副本只核对路径与字节数（主进程 `resolveVerifiedArtifact` 刚校验过 SHA-256，导入器解析后、首条业务写入前仍整文件复核）。
- A9：`markConflictRows` + `markExistingIdenticalRows` 合并为一次 `UPDATE … FROM`（有效行在 `(source_type, idempotency_key)` 唯一，结果等价）；批内同键异内容判定不变；6 次计数合为一次 `GROUP BY disposition`；导出预览三类（可导出 / 完整性异常 / 缺失）互斥，合为一次分组扫描；全量归档月份列表按 `taskGeneration` 缓存。

## Deviations

- A3：计划写“`read-schema.js` 补登用到的表与列”。未补：新增的读取只在对应动作中使用，若把导入来源、异常、旧审计表加入只读 worker 的全局 schema 断言，任一表缺失会让所有只读动作（含归档月份列表）失败，影响面大于收益。
- A8：计划写“打桩 `hashSourceFile` 计数”的测试未加：哈希函数在模块加载时解构引用，无法在不改生产代码的前提下打桩；改为用现有交接、多 Sheet、文件计划测试（65 项）覆盖行为，并保留“文件变化即判计划过期”的用例。
- A10：计划写“ATTACH 一个放在 `{userData}/run-data/vcc-financial-op/` 的临时库并自行清理”。实际用连接级 TEMP 表（同名遮蔽主库表，`temp_store=FILE`）：现有中转 SQL 不需改库名；临时文件由 SQLite 创建并在连接关闭时删除，取消、失败、崩溃都不留残留文件，也不需要启动清理；位置为系统临时目录。主库中转表保留为空表，存储合同与策略登记不变。
- A11：实测 20 万行库上每次开库的 `ensureVccFinancialOpTablesSupport` 约 1 ms（5 次 1.0–1.2 ms），不改。

## Evidence

- 单测：detail-importer、archive-lineage、service、read-worker、read-service、dataset-writer、read-snapshot、calculator、workbook-import-plan、multisheet、system-op-importer、fileplan-handoff 等相关文件逐个通过（见各步骤运行记录）；新增用例：已绑定来源不写 fallback、无变化零写入、批量异常数与逐条一致、复检不重扫、汇总顺序与 id 序一致、TEMP 暂存区结构与主库一致、生产导入中转行不入主库。

## Remaining unknowns

- 真实 Windows 机器与真实库上的提速幅度（B84）。
