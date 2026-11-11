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

- B1：任务计数只在写任务（导入、计算、初始化期初、修改结果、确认归档、解归档、删除）结束时推进；`READ_ONLY_TASKS` 补入各类导出，避免其失败时执行全局 `recoverInterruptedImports`。归档月份列表缓存随之只在写任务后失效。
- B2：解归档门禁的进行中批次只查目标月（预览与锁内复核共用 `loadUnarchiveGateEvidence`）。删除预览的全局导入门禁未改（不在用户决策范围）。
- B3：`vcc_fin_op_runs.adjustment_cycle`（解归档时 +1，在 `unarchive.restore-run` 同一条 UPDATE 内）；`vcc_fin_op_run_adjustments` 重建为 `UNIQUE (run_id, row_key, currency, adjustment_cycle)`，已有调整归入周期 0，重建在状态模型迁移事务内完成并同事务重装写保护触发器（崩溃不会留下缺写保护的表）。结果证据、有效结果、调整选项按周期判定重复；不同周期全部累加。Excel 血缘名不变，分主体 writer 校验改为“每坐标区域数 = 该坐标调整条数”。
- B4：对外仍是“解归档”动作；锁内证据存在后续已归档/已计算月份且用户明确确认（`confirmCascade`）时，生成新写操作 `unarchive-cascade` 的计划：1 条成功审计（`operation_type='unarchive_cascade'`，evidence 含被删结果与每条被删调整）、删除后续 archives、显式删除后续结果五张子表、删除后续 runs、后续数据集恢复未处理，再执行目标月原有三步。未确认时以 `unarchive-cascade-confirmation-required` 拒绝并留 rolled_back 审计。门禁另加 `evaluateCascadeUnarchiveGate` 包装，旧写路径使用的 `evaluateUnarchiveGate` 不变。
- B5：去掉版本确认勾选框；选择器新增 `previewConfirmation`，由预览结果决定是否显示（只在级联时显示删除确认）。审计 evidence 的 `minimumSafeAppVersion` 不变（级联为 3.2.17）。

- D：预检用正式导入同一读取与映射链路（`streamDetailRows` + `mapDetailRow`）判定可补录行，规则在 `row-mapper.js`（`inspectChannelCorrectionCandidate`、`channelCorrectionProblems`），字段清单与分组与弹窗共用 `src/shared/vcc-channel-correction.js`。修改随导入请求单独传给 worker（不写入存档成员元数据），按 物理文件 ID + Sheet 序号 + 行号 定位，导入时先核对业务键与被改字段原值再替换；修改记录表 `vcc_fin_op_channel_corrections` 与导入同事务写入，登记为受保护审计表，在 v3 合同断言前建表并装写保护。校验原表导出与待确认表按（导入来源, Sheet, 行号）套用修改记录后再核验血缘，原件值须等于原值（存档原件）或已等于新值（fallback）。导出明细追加“人工补录”分类。弹窗轻量校验不比后端严（金额允许千分位与正负号），后端为权威校验。
- 每个 Sheet 最多列 2000 条可补录行；超出时弹窗只提示，不提供编辑（本次导入这些行按异常过滤）。

## 对账专项审查（2026-11-11，B + D + A 中涉及导入/血缘部分）

按 `.agents/skills/reconciliation-blindspot-pass` 检查：

- **[Important] 人工补录直接改变计算口径** ⚠️ 资金红线，请人工复核。补录可改金额、币种、方向，以及决定取哪组金额的通道名称、billdate（用户 2026-11-10 决定的范围）。系统只校验格式，不与原表其他金额列（交易汇总金额、清算净金额等）交叉核对。已有留痕：逐字段原值/新值、时间、版本，导出明细可见，原件存档不改。处置：ASSUME（用户决策），须在 GUI 验收时用真实样本核对一次。
- **[Important] 级联解归档删除多个月份的已确认结果** ⚠️ 资金红线，请人工复核。须在预览中明确确认（未确认时锁内拒绝并留 rolled_back 审计）；审计 evidence 保存被删结果、每条被删调整（含原因）以及被删的已归档余额快照（本次审查后补入）；原表数据与导入审计不动。处置：已覆盖（单测含成功全链、未确认拒绝、陈旧 token）。
- **[Important] 降级兼容**：使用“解归档后再调整”后，同一坐标出现多个周期的调整；v3.2.16 及以前版本按坐标判重，读到这类结果会报调整坐标重复。处置：ASSUME，沿用项目既有“升级后不用旧版本写入/读取”的约定，在发版说明中写明。
- **[Minor] 补录行最终被幂等跳过或冲突**：补录记录仍按导入写入（反映用户操作），导出明细同时可见对应的冲突异常；状态框“其中人工补录 N 行”只统计成为本次有效数据的行（本次审查后修正）。处置：已覆盖。
- **[Minor] 补录原值核对只覆盖被改字段**：未改字段依赖整文件 SHA-256 一致（交接与解析后复核），不会漏检。处置：已覆盖。
- 已排除：删除原表数据只更新导入记录、不删导入来源，补录记录不会被外键级联删除；中转 TEMP 表在崩溃时随连接消失，不会把暂存行提升为有效数据；A9 合并判定依赖有效行 `(source_type, idempotency_key)` 唯一，v3 结构成立；A7 去排序后输出顺序有回归用例。

## Deviations

- A3：计划写“`read-schema.js` 补登用到的表与列”。未补：新增的读取只在对应动作中使用，若把导入来源、异常、旧审计表加入只读 worker 的全局 schema 断言，任一表缺失会让所有只读动作（含归档月份列表）失败，影响面大于收益。
- A8：计划写“打桩 `hashSourceFile` 计数”的测试未加：哈希函数在模块加载时解构引用，无法在不改生产代码的前提下打桩；改为用现有交接、多 Sheet、文件计划测试（65 项）覆盖行为，并保留“文件变化即判计划过期”的用例。
- A10：计划写“ATTACH 一个放在 `{userData}/run-data/vcc-financial-op/` 的临时库并自行清理”。实际用连接级 TEMP 表（同名遮蔽主库表，`temp_store=FILE`）：现有中转 SQL 不需改库名；临时文件由 SQLite 创建并在连接关闭时删除，取消、失败、崩溃都不留残留文件，也不需要启动清理；位置为系统临时目录。主库中转表保留为空表，存储合同与策略登记不变。
- A11：实测 20 万行库上每次开库的 `ensureVccFinancialOpTablesSupport` 约 1 ms（5 次 1.0–1.2 ms），不改。

- B4：计划写“集成脚本增加一步级联路径”。未加：现有集成链在 M1 非尾月处改为验证“未确认级联被拒并留审计”，后续保留手工逐月路径；一步级联的生产写入口由 `destructive-write.test.js` 两条真实 SQLite 用例覆盖（成功全链与陈旧 token），服务层透传 `confirmCascade` 由 result-write-service 用例覆盖。
- B/D 的对账专项审查合并在 D 完成后一次执行（涉及同一组调整、审计与血缘文件）。

- D：计划写“预检结束后由只读 worker 查询这些渠道订单号是否已有有效数据并标注”。未做：标注只是提示，导入时的幂等判定才是依据；不增加一次全量读取。若用户需要再补。

## Evidence

- 单测：detail-importer、archive-lineage、service、read-worker、read-service、dataset-writer、read-snapshot、calculator、workbook-import-plan、multisheet、system-op-importer、fileplan-handoff 等相关文件逐个通过（见各步骤运行记录）；新增用例：已绑定来源不写 fallback、无变化零写入、批量异常数与逐条一致、复检不重扫、汇总顺序与 id 序一致、TEMP 暂存区结构与主库一致、生产导入中转行不入主库。

## Remaining unknowns

- 真实 Windows 机器与真实库上的提速幅度（B84）。
- 界面预览截图 `docs/previews/vcc-financial-op-unarchive*.png` 未重生成：本机执行 `npm run preview:vcc-financial-op-unarchive` 时 Electron 主进程启动后不创建渲染进程（基线代码同样卡住），属环境问题。预览桩已按新规则更新（非尾月显示级联提示与删除确认），需在可开窗口的机器上重跑四个 `preview:vcc-financial-op-unarchive*` 命令。
- 预检补录弹窗与级联解归档弹窗尚未做 GUI 人工检查（同上原因）。
