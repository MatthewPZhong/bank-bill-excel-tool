# E03-A VCC Parser Pipeline — Implementation Notes

## Goal / Context / Constraints / Done when

- Goal：复用现有 VCC 流水口径，实现单文件 Parser Core、文件级 Parser Pipeline、Ordered Reducer 与 immutable Compute Snapshot 原子采用。
- Context：真实生产入口仍为 `vccOpCalc:import:scan` → `streamScanAndCompute`；`vccOpCalc:run:compute-amounts` 独立读取 session snapshot；`vccOpCalc:run:save` 是独立 Task。
- Constraints：`vcc-op:scan-and-compute` 权威 policy 仍为 `production.enabled=false` / `effectiveMode=legacy`；E03-A 不切默认 IPC，不改 Renderer、opening balance、save SQL/receipt、DB migration 或 E03-B Inspector。
- Done when：固定 Worker I/O、source snapshot 前后校验、semantic/evidence hash、ordered/all-or-nothing reducer、safe integer、error cap、cancel/crash、generation-token adoption、legacy parity 均有直接定向证据。

## Decisions

1. `parser-core.js` 是 legacy 与 Worker 共用的行级资金口径唯一来源：日期定月、方向、金额转整数分、空金额、币种提取不另写一套。
2. Worker input 严格为 `fileIndex/filePath/sourceSnapshot/maxErrors/parserContractVersion=1`；success result 严格为权威 10 字段，不加入 file path、perFile 或完整 rows。
3. `parserSemanticProjection(v1)` 覆盖 success result 除 digest 自身外的全部字段，包括 `errorCount/errorRows`；Reducer 重算 hash。`maxErrors` 不属于固定 result 字段，Reducer 以 unit input 校验 `errorRows.length === min(errorCount,maxErrors)`。
4. `parserInputEvidenceProjection(v1)` 对有序 `{fileIndex, absolute filePath, sourceSnapshot}` 做 canonical SHA-256。同一有序输入稳定；顺序改变会改变数组位置与 fileIndex。绝对路径只进入 hash 投影，Compute Snapshot 与 Renderer DTO 只暴露 digest。
5. Parser 解析前、reader 完成后各按冻结 source snapshot 校验一次；任一 drift 均丢弃 unit。Parser 不保留行数组，只累加 row/error/month/currency/cents 聚合。
6. Ordered Reducer 只用 Map 缓存真正乱序结果；从 `nextExpectedIndex` 连续消费后立刻做候选聚合，不长期保存全部 unit result。duplicate、missing、snapshot mismatch、unsafe cents、result shape/hash mismatch 全部 fail closed。
7. Pipeline 调度结构支持文件 unit scheduler，但 E03-A `EFFECTIVE_PARSER_WORKER_COUNT=1` 是机器断言；requested=4 仍只运行 1，显式 effective>1 稳定拒绝。正常路径会等待 `terminate()` Promise settle 后再结束 unit；`terminate()` rejection 目前会被吞掉，故真实启用前仍需补 fail-closed 退出证明。
8. 权威 action result `maxBytes=8388608` 同时约束 unit semantic/result 与最终 Compute Snapshot；Worker control error 复用 finance-safe/bounded protocol error codec。该限制当前在聚合/序列化后校验，不是分配前 byte budget。
9. Session 在每轮 scan 开始时先清旧 snapshot，并用 generation token 做采用 CAS。成功方法只在递归冻结 snapshot 已采用后返回；旧任务迟到、失败、拒绝、取消或 clear 不得恢复旧 cache。
10. 默认 `src/main.js` 继续调用 legacy `streamScanAndCompute`，因为生产 gate 未通过；新 pipeline 是可执行、真实 Worker 覆盖的 internal seam，不作为产品 enablement。
11. PR #172 通过 merge 同步当前 `v3.2.0` 后重跑 Windows CI：失败 run `32719414816` 只包含 #170 修复前的 C2 directory-fsync 三项失败；不在 VCC 层复制 durability 逻辑，也不以空提交掩盖 branch checkout 缺少前序修复。

## Assumptions

- `rowCount/totalRows` 沿用生产 legacy：统计全部 meaningful data rows，非法行另计 `errorCount`。这是“新旧逐字段等价”验收与现有 Renderer 语义；权威 spec 中“有效行数”的概括不解释为静默排除非法行。
- canonical reader 因真实 data-descriptor XLSX 兼容性会在 JSZip 层持有压缩 archive buffer；E03-A 保证 Worker 不缓存完整 row 数组且 unit 结束释放线程。是否替换 ZIP reader 必须由后续真实 benchmark/Windows 证据决定，本 PR 不改 reader 口径。
- file basename 由 Main-owned immutable unit path 派生，用于 legacy-compatible `perFile/errorRows`；Worker success result 本身不增加 file path 字段。

## Deviations

- 无行为性合同偏差。
- 有意未接默认 IPC：权威 policy 明确 `production.enabled=false`，切换用户路径属于 benchmark/production gate 后的独立决策。
- 未实现 saveRun receipt、Inspector、数据库迁移或 production policy 改动，均属于 E03-B/后续范围。

## Evidence

- 编辑前 baseline：`node --test tests/unit/main-process/vcc-op-calc-session.test.js tests/unit/main-process/vcc-op-calc-stream.test.js` → `28/28 PASS`。
- Parser/Reducer/Pipeline/Session 定向：pre/post drift、unsafe amount、semantic mismatch、乱序/duplicate/missing、maxErrors、cancel、spawn/crash、effective=1、termination barrier、generation token、all-or-nothing。
- 真实 XLSX：ExcelJS fixture → canonical reader → real Worker → Pipeline；正常 months/currencies/rowCount/cents/perFile 与 legacy 逐字段相等；非法方向 + 跨月的 error order/classification/count/rejection 与 legacy 相等。
- Blindspot 修复：Worker termination barrier；Reducer 连续消费后增量候选；8 MiB result/snapshot bound；Worker error 使用 bounded finance-safe codec。
- 专属 Reviewer：当前默认 legacy 产品路径无 P0–P3 finding，本地技术门槛通过；整文件 archive buffer、terminate rejection 与分配前 byte budget 记录为 production enablement residual。
- 最终定向：`node --test tests/unit/main-process/vcc-op-calc-session.test.js tests/unit/main-process/vcc-op-calc-stream.test.js tests/unit/main-process/vcc-op-calc-parser-pipeline.test.js` → `49/49 PASS`。
- Adjacent lint：`npm run lint` → PASS（eslint `src/`，无输出错误）。
- `npm run release-check`（Reviewer 收敛后的最终快照，且仅运行一次）→ PASS：lint、smoke；unit 5950/5951（0 fail、1 existing skip）；integration 51/51 scripts、2455/2455 assertions。
- Windows run `32719414816` 失败诊断：3 fail 均为 C2 旧快照 #1185/#1194/#1200；日志没有 VCC parser/pipeline failure，反证 E03-A 为直接根因。
- `git merge --no-edit origin/v3.2.0`：PASS、无冲突；branch ancestry 已包含 `dffb2ab0` 与 Windows 修复 `e986132c`。
- 基线刷新后定向组合测试：recovery `35/35 PASS`；VCC parser/session/legacy parity `49/49 PASS`；VCC effective-result integration `19/19 PASS`。
- 基线刷新后 `npm run release-check`：PASS；unit `5950/5951`（0 fail、1 existing skip），integration `51/51` scripts、`2455/2455` assertions；自动生成的耗时/时间戳噪声已撤销。
- 基线刷新 blindspot/reconciliation 复核：C2 merge 未触及 VCC parser/session 文件；金额整数分、方向、混币种、input order/source evidence、duplicate/missing、错误上限、整批拒绝与 generation-token adoption 均由定向测试覆盖；未发现改变方案的新问题。
- 按用户明确指令未运行 `check-vars`。

## Reconciliation Blindspot / Human Review

自动测试不能代签以下资金红线结论，状态统一为 `PENDING_HUMAN_REVIEW`：

- 人工抽样核对真实流水的“入/出”方向与整数分金额合计；
- 人工核对混币种仍按冻结规则全量合并，currency 列表未改变资金含义；
- 人工核对跨月、空日期、非法方向、非法金额仍整批拒绝且错误行可追溯；
- 人工核对用户输入顺序与 perFile/source evidence 血缘一致，无重复或遗漏；
- 人工复核真实超大文件的 RSS、取消响应与 Windows Worker/JSZip 行为。

## Remaining Unknowns

- BLOCK：无。
- PROBE：无未完成的仓库内可查证项。
- PENDING：Windows 实机、1/2/4/8 文件 benchmark、production worker>1 gate、人工资金复核。
- ASSUME：底层 JSZip compressed-buffer 行为保持不变；仅 Parser 聚合/Worker 生命周期满足 E03-A 不缓存完整 rows 的阶段边界。
- ENABLEMENT BLOCK：替换为真实流式 ZIP 读取，或先取得权威“Worker 不缓存整文件”合同变更；benchmark 不能替代合同决定。
- ENABLEMENT BLOCK：`worker.terminate()` rejection 必须整批 fail closed 且禁止启动下一 unit，并补真实/注入负例，才能证明物理 effective=1。
- ENABLEMENT BLOCK：对 currency/error 等用户可控字符串实施聚合期 UTF-8 byte budget 与单项上限，避免 8 MiB 事后检查前先产生无界分配/OOM。
