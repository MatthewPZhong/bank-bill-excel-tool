# TechDoc — v3.2.17 VCC 财务OP校验：提速瘦身、解归档放宽与通道明细补录

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.17（暂定） |
| 功能分支 | `feat/vcc-financial-op-speed-unarchive`，基于正式标签 `v3.2.16`（`8e027cb8`） |
| 日期 | 2026-11-11 |
| 状态 | 已实现，待 PR 审查、GUI 人工检查与 Windows 真实数据回归（B86） |
| 依据 | [spec.md](spec.md)；实施偏离与审查见 [implementation-notes.md](implementation-notes.md) |
| 格式来源 | `changes/v3.2.16/perf/toolbox-merge-split-speed/techdoc.md` |

以符号名为准，行号会随后续提交变化。空闲自动整理主库在分支 `feat/db-idle-compaction`，不在本文。

## 一、范围

- A 提速瘦身：不改金额、币种、幂等、行序和输出口径。
- B 解归档放宽：级联解归档、调整周期、只读任务不让预览失效、导入门禁只看目标月、去掉版本确认勾选框。
- D 通道明细预检补录。

## 二、A 提速瘦身

| 编号 | 位置 | 改动 |
| --- | --- | --- |
| A1 | `detail-importer.js` `promoteRows` | raw fallback 只写 `archive_artifact_id IS NULL` 的来源 |
| A2 | `vcc-financial-op-archive-lineage.js` | `createReferenceProbe` 逐来源 `EXISTS`；已绑定且 hold 与引用一致时跳过；失败标记与记录状态只在变化时写 |
| A3 | `vcc-financial-op-read-worker.js`、`read-snapshot.js`、service | 新增只读动作 `list-import-records`、`inspect-dataset-export`、`preflight-calculation`；`countExportableImportAnomaliesByMonth` |
| A4 | `workbook-import-plan.js` `revalidateImportPlan` | 只核对 SHA-256、大小与文件身份，不再整本重扫 |
| A5 | `worker-entry.js`、`result-write.js`、`read-schema.js` | 连接补 `cache_size=-65536`、`temp_store=MEMORY`；导入结束 `wal_checkpoint(TRUNCATE)` |
| A6 | `read-snapshot.js` | 月份列表沿 `idx_vcc_fin_op_effective_month_source` 逐月跳跃；Pending 有效行计数改存在性 |
| A7 | `calculator.js` `aggregateEffectiveRows` | 去掉 `ORDER BY id`，各集合按最早行 id 重排 |
| A8 | `archive-lineage.js` `buildVccImportArchiveHandoffFiles`、`import-service.js` | 工作簿计划路径复用已校验的 SHA-256；解析后整文件复核保留 |
| A9 | `detail-importer.js`、`dataset-writer.js`、service | 冲突/跳过一次 `UPDATE … FROM`；`GROUP BY disposition`；导出预览一次分组扫描；归档月份列表按任务计数缓存 |
| A10 | `repository.js` `ensureImportStagingScratch` | 生产导入在连接上建同名 TEMP 中转表（`temp_store=FILE`） |
| A11 | — | 实测 1 ms，未改 |

### 实测（合成数据）

macOS、Node 24；10 万行充值清退明细（约 200 MB xlsx）；预检 → 复检 → 导入（独立连接模拟导入 worker）→ 存档关联同步；基线与本分支交替各 4 次取中位数，文件缓存已热。对比脚本：`/private/tmp/…/scratchpad/vccbench/import-compare.js`（会话临时目录，不入库）。

| 指标 | v3.2.16 | 本分支 | 变化 |
| --- | --- | --- | --- |
| 预检 | 1741 ms | 1762 ms | 持平 |
| 提交前复检 | 1856 ms | 94 ms | −95% |
| 正式导入 | 3974 ms | 2621 ms | −34% |
| 预检 + 复检 + 导入 | 7571 ms | 4477 ms | −41% |
| 首次存档关联同步 | 148.5 ms | 1 ms | — |
| 重复同步写库次数 | 3 | 0 | — |
| 导入结束时 WAL | 185.3 MB | 36.8 MB（worker 结束截断为 0） | — |
| 主库增长（截断 WAL 后） | 184.2 MB | 36.3 MB | −80% |
| 其中空闲页 | 147.9 MB | 0 MB | — |

未计入：存档交接与正式导入前对整文件的两次 SHA-256（A8 省掉），以及只读 worker 与主线程的分工（A3 的收益是不卡界面，而非总耗时）。冷缓存、Windows 与真实数据下的数字待 B86 回归。

## 三、B 解归档放宽

### 3.1 数据结构（`vcc-financial-op-db/migrations.js`）

- `vcc_fin_op_runs.adjustment_cycle INTEGER NOT NULL DEFAULT 0`。
- `vcc_fin_op_run_adjustments`：新增 `adjustment_cycle`，唯一约束改为 `(run_id, row_key, currency, adjustment_cycle)`。旧库在状态模型迁移事务内重建：建新表 → 原样复制（旧调整周期 0）→ 删旧表 → 换名 → 重建索引 → 恢复 `sqlite_sequence` → 同事务重装写保护触发器。以表结构判断是否已迁移，可重复执行。

### 3.2 写入链路

- 解归档：`mutation-policy.js` `unarchive.restore-run` 在同一 UPDATE 中 `adjustment_cycle + 1`；`assertUnarchivePostconditions` 期望行同步。
- 调整：`result-write.js` `buildAdjustmentPlan` 按 `(坐标, 当前周期)` 判重并写入周期；`result-adjustments.js` `validateAdjustments`、`listAdjustmentOptions`，`result-evidence.js` 按周期判重，全部周期累加。
- 级联：`unarchive-gate.js` `evaluateCascadeUnarchiveGate` 把“后续月份依赖”改为 `cascade`；`destructive-write.js` 在锁内证据为 cascade 且 `confirmCascade === true` 时用 `buildCascadeUnarchivePlan`（操作 `unarchive-cascade`），否则以 `unarchive-cascade-confirmation-required` 拒绝。步骤：审计 → 删后续 archives → 删后续结果五张子表 → 删后续 runs → 恢复后续数据集 → 目标月原有三步。审计 evidence 含 `deletedRuns`、`deletedAdjustments`、`deletedArchives`、`deletedCounts`。`assertCascadeUnarchivePostconditions` 核对后续月份无残留后再走目标月断言。
- 预览失效：service `releaseTask` 只在 `WRITE_TASK_ACTIONS` 结束时推进 `taskGeneration`。
- 导入门禁：`loadUnarchiveGateEvidence` 的进行中批次加 `target_month = ?`。

### 3.3 界面

`createArchivedMonthPickerDialog` 新增 `previewConfirmation`，由预览决定是否显示确认勾选；解归档弹窗只在级联时显示删除确认，并在执行时传 `confirmCascade`。

## 四、D 通道明细预检补录

- 规则：`row-mapper.js` `inspectChannelCorrectionCandidate`、`channelCorrectionProblems`、`channelRequiredFields`；字段清单与分组共用 `src/shared/vcc-channel-correction.js`（UMD，`index.html` 加载；弹窗只做轻量提示）。
- 预检：`inspectWorkbook({ targetMonth })` 对就绪的通道 Sheet 用 `streamDetailRows` + 映射逐行判定，`source.channelCorrectionCandidates = { total, truncated, candidates }`，每 Sheet 最多 2000 条。账期由 `pickFiles({ targetMonth })` 传入并记入计划。
- 提交：`resolveImportPlan` → `resolveChannelCorrections` 校验行、字段、取值，改后不合规时以 `vcc-channel-correction-invalid` 列出行号；`collectChannelCorrections` 按物理文件 ID + Sheet 序号汇总，随 `businessPayload.channelCorrections` 传给 worker（不写入存档成员元数据）。
- 导入：`importDetailGroup` 按 `channelCorrectionSheetKey` 取本 Sheet 补录，`applyChannelCorrection` 核对业务键与原值后替换；未全部命中时按计划失效失败。`classifyAndPromote` 同事务 `insertChannelCorrections`。
- 新表 `vcc_fin_op_channel_corrections`（受保护审计表，无可写的破坏性操作）：`ensureVccChannelCorrectionsTable` 在 v3 合同断言前建表并装写保护。
- 血缘：`channel-correction-lineage.js`；`dataset-writer.js` `emitReconstructedDetailRows` 与 `review-export-plan.js` `validateRawFact` 先套用补录再 `assertMappedLineage`；待确认表输出替换为补录值。
- 审计导出：`repository.js` `iterateExportableImportAnomalies` 追加 `channel_correction`（“人工补录”）；`countExportableImportAnomalies*` 含补录行；`countCorrectedRows` 只统计成为本次有效数据的补录行。

## 五、兼容与回滚

- 升级：调整表重建与补录表创建在启动迁移中完成，幂等；已有数据不变。
- 降级：使用过“解归档后再调整”的库，v3.2.16 及以前版本读取该结果会报调整坐标重复；含 `unarchive_cascade` 审计的库，旧版本只把它当普通审计行。沿用项目约定：升级后不用旧版本写入或读取。
- 回滚代码：A 阶段无数据结构变化；B、D 的新列与新表对旧代码不可见，但上述降级限制仍在。

## 六、测试

- 单测：VCC 相关 904 项（含新增）通过；新增文件 `tests/unit/backend/vcc-financial-op/channel-correction.test.js`。
- 集成：`vcc-financial-op-adjustment-archive-chain`、`destructive-state-chain`（非尾月改为验证未确认级联被拒）、`effective-result`、`historical-template-export`、`result-workbook`、`vcc-input-template-version`、新增 `vcc-financial-op-channel-correction` 全部通过。
- 渲染层生命周期 377/377；架构检查通过。
- 未完成：界面预览截图重生成与 GUI 人工检查（本机 Electron 无法开窗口，见实施记录）；Windows 真实数据回归（B86）。
