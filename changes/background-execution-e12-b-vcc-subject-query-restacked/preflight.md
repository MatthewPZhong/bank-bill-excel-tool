# v3.2.4 E12-B Restack Unknowns Preflight

## Task Brief

- Goal：在已审查 E12-A 单 Writer 父链上提供真正的 VCC subject-filtered read-only query 与 scoped Worker authority，使 Writer 逐主体读取/释放资金事实，不先读取全 run 再过滤。
- Context：精确 parent 为 E12-A review-fix `962c364abefd28b6c740e8318ba19cbbe26e73cf`；冻结 Spec §7.2/§8/§9、TechDoc §9/§13 要求在 E12-C 双 Writer 前完成 SQL/row-count query pushdown。
- Constraints：只做 E12-B；不实现第二 Writer/shard/merge/15% enable，不接 live Main/production；保持 `production.enabled=false`、legacy、`workerCount=0`；不改金额、币种、顺序、revision、archive、Publisher、cleanup/recovery 或人工资金门禁。
- Done when：存在等价的 `loadEffectiveRunDataForSubject(runId, subject)`；目标查询命中 `(run_id, subject)` 索引；E12-A Worker 在同一只读事务中以 scoped A/B authority 逐主体生成；Main 的 full A/B/Join/Publisher authority 不弱化；focused、E12-A、全 VCC、平台/Publisher/recovery/integration/smoke/static 通过，并保留 Windows/真实资金人工门禁。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E12-A Writer 仍由 `loadEffectiveRunData` 全量读取 run rows、adjustments、balances、Pending，再按 `subjectIndexes` 选择。 | `src/main-process/vcc-financial-op-writer.js::loadEffectiveRunData/writeRunWorkbooks`；`result-adjustments.js::getEffectiveRunResult` | E12-B 必须把 SQL WHERE 下推到结果、余额、调整与 Pending 读取，不允许 JS full-load/filter。 |
| Worker 生成前后仍调用 full `readVccExportSnapshot`，会读取全量资金事实。 | `src/main-process/vcc-financial-op-output/writer-core.js::executeVccExportWriter`；`authority.js::readVccExportSnapshot` | 仅改 writer 不足；需增加 Worker-only scoped authority，同时保留 Main full authority。 |
| 冻结文档明确允许 `loadEffectiveRunDataForSubject` 或等价 SQL，并要求 SQL/row-count 探针。 | v3.2.4 Spec §7.2/§8/§9；TechDoc §9/§13 | subject filter/index/read-count 是 E12-B 精确范围；双 Writer 属 E12-C。 |
| 新父链在旧 E12-A 后新增 staging root/parent identity、每主体/before-handoff 复核、raw OOXML 与 cleanup recovery authority。 | `staging-identity.js`；当前 `writer-core.js` hooks；E12-A notes Round4 | overlay 必须保留新 hooks/cleanup ownership，旧 E12-B patch 不能覆盖回退。 |
| Main 在 Worker 前、Join 后和 Publisher 前仍使用 full snapshot 并深度回读所有 workbook。 | `src/main-process/vcc-financial-op-output/dispatch.js` | Worker scoped read 不得替代或削弱正式发布 authority。 |
| production policy 与 live handler 未接 managed capability。 | E12-A policy/runtime tests；`src/main.js` legacy handler | 本 PR 只验证 dormant capability，不改用户可见路径。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 三个 additive subject indexes 是否足够且不改变业务 schema。 | 数据合同 | 高 | 容易 | rows/summary 无 subject index；adjustments 只有 run/row；balances/totals PK 已含 run/subject。 | PROBE | PRAGMA + EXPLAIN + legacy fixture migration | 只加 rows/adjustments/summary 三个 non-unique `IF NOT EXISTS` indexes。 |
| scoped Worker authority 能否避免全量资金读取而保持 E12-A TOCTOU。 | authority | 高 | 一般 | run/dataset/archive metadata 有界；assigned subject 可复算 canonical business evidence；Main full authority仍在。 | PROBE | scoped A/B drift、subject poison、Main E12-A faults | Worker 读取 global scalar/最多65条 subject metadata + assigned subject facts；Main full authority不变。 |
| 新父链 staging hooks 与逐主体 query 生命周期如何组合。 | restack overlap | 高 | 容易 | 当前 writer core 已传 `beforeSubjectWrite` 与 `beforeAtomicHandoff`。 | PROBE | overlay diff + replacement/cancel/cleanup tests | 保留两个 hook原样，subject query仅增加 loader/evidence参数。 |
| subject-local adjustment sequence 与全局 revision 如何校验。 | 资金/审计 | 高 | 一般 | sequence 为 run-global；全 run聚合会破坏 pushdown。 | PROBE | 非目标20k adjustments read/VM-step probe | Worker只读 revision标量并校验目标局部 sequence 严格递增；Main full snapshot负责全局连续性。 |
| 历史 NULL fingerprint、archive时间与 JS/SQLite主体排序兼容。 | 历史兼容 | 高 | 容易 | E12-A接受 NULL fingerprint；archive/run archived_at不要求相等；JS UTF-16排序可异于 SQLite BINARY。 | PROBE | legacy fixture、跨秒、astral/full-width cases | scoped validator对齐E12-A；最多65条metadata后复用JS comparator。 |

## BLOCK 问题

无。冻结文档、现有 schema 与 E12-A authority 已唯一确定 E12-B 方案，不涉及需要用户决定的新数据模型、资金口径或生产启用。

## 保守假设

- legacy/live writer 默认继续 full loader；只有 dormant E12 Worker 显式启用 subject query。
- RSS/read scaling 只是 E12-B capability 证据，不替代 E12-C 的双 Writer 15%/Windows 门禁。
- 旧 E12-B 两提交仅作为取证 overlay；若与新父链 authority 冲突，以新父链已审查不变量为准并记录适配，不静默改 spec。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 添加 subject query/index 并做 full-vs-subject parity。 | SQL 真下推、主键/金额/币种/lineage。 | EXPLAIN SEARCH、read-count、poison fixture、deep parity。 | 查询合同不成立则不接 Writer。 | 删除 additive API/index，E12-A 不受影响。 |
| 2 | 将 Writer/scoped authority overlay 到新父链。 | staging identity、A/B authority、逐主体单驻留。 | 新父链 hooks 保留；scoped drift 与 subject evidence tests。 | authority弱化或cleanup重叠则停止。 | 回退到 E12-A full Worker read，production仍false。 |
| 3 | 回放 focused + E12-A/VCC/platform/Publisher/recovery/integration/smoke/static。 | 资金输出、Publisher一次/零次、恢复/legacy不变。 | 测试日志与 git diff/check evidence。 | 任一资金/恢复回归不交付。 | 仅保留preflight，不提交生产改动。 |
| 4 | blindspot/reconciliation/important-variable 自审并形成 clean commit。 | 非目标边界、人工资金门禁、可审计交付。 | checklist逐项结论、clean status、exact parent/head。 | 存活资金红线只允许 dormant合并，禁止production enable。 | 不push/不开PR。 |
