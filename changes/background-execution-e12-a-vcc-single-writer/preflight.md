# v3.2.4 E12-A Unknowns Preflight

## Task Brief

- Goal：将 VCC Financial OP 现有按主体顺序导出迁入 one-shot 单 Writer 新合同；同一 core 覆盖 `vcc-financial-op:export-subjects` 全主体输出和 `vcc-financial-op:export-single` exact-one subject specialization，Main Join 复核完整集合后只调用一次既有 Publisher。
- Context：精确 parent 为已审查 E11-C `2e03bf2a39537e8b8ff7960758e227773f17900f`；现有 live `vccFinancialOp:export:result` 在 VCC Service `activeTask` 内由 Main 进程调用 `writeRunWorkbooks`，然后一次 `publishVccFinancialOpOutputs`。
- Constraints：仅 E12-A 单 Writer；不做 subject SQL filter pushdown、第二 Writer/shard 或 15% benchmark；不接 live IPC/Renderer/Preload，不开启 production；不改金额、币种、差异、revision、archive 语义；复用现有 workbook writer、FilePlan 和 durable journal Publisher。
- Done when：`production.enabled=false` 的 dormant capability 与 canonical policy 精确一致；一个 Writer 按 `subjectIndex` 顺序生成全部主体；Main 对 task/run/month/revision/fingerprint/archive/FilePlan/path/size/hash/业务 workbook 做 A/B authority 复核；任一 generation/Join/cancel/crash 失败 Publisher=0，全部成功后 Publisher=1；协议 DTO 有界且不携带 raw finance rows；shutdown/cleanup 与 legacy golden 回归通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| live 结果导出由 `runDirectTask('export-result')` 独占 `activeTask`，释放时 `taskGeneration += 1`。 | `src/main-process/vcc-financial-op-service.js` `acquireTask/releaseTask/exportRun` | managed 调度必须绑定同一 `action + taskGeneration`，并在 generation/Join/Publisher 前后 fail closed 复核。 |
| 现有 writer 一次读取全部 effective run，按字典序 subjects 顺序生成，每个 workbook 都使用同一结果/Pending 模板与调整 lineage。 | `src/main-process/vcc-financial-op-writer.js` `loadEffectiveRunData/buildSubjectRowPlan/buildPendingSheet/writeRunWorkbooks` | E12-A 复用同一 writer core，不复制金额/币种/样式逻辑；单 Writer 继续顺序执行。 |
| archive read worker 已按 run/dataset/archive/balance/Pending 证据分类 current/legacy/inconsistent，不一致的月份禁止导出。 | `read-snapshot.js::loadArchiveEvidenceSet/listArchiveMonthsSnapshot`；`archive-contract.js::classifyArchiveContract`；`service.getArchivedRunByMonth` | run authority 必须纳入 archive contract/evidence digest，不只核对 runId/subjects。 |
| FilePlan 在 TaskLifecycle prepare 时为所有正式目标生成 artifactKey/aliasKey/targetSnapshot。 | `src/main.js` `vccFinancialOp:export:result`；`archive-center/file-plan.js`；`task-lifecycle.js` | Main 分配 generation paths；Worker 不能重新决定文件名/目标，Join 要求 exact set/order/binding。 |
| 现有 VCC Publisher wrapper 把 N 个 artifact 作为一个 journal publication 提交，并二次核对 size/hash/target snapshot。 | `vcc-financial-op-output-recovery.js::publishVccFinancialOpOutputs`；`toolbox-output-publication*` | 只复用该 Publisher；Join 成功前不调用，Publisher 异常不自动二次发布。 |
| canonical action policy 已冻结为 `thread-pool/job/native/main-settlement/all-or-none/maxArtifacts=64`，CompoundLease topology 允许最多 4 child，production false。 | v3.2.4 policy fixture `vcc-financial-op:export-subjects` | E12-A runtime topology 固定 `effectiveChildCount=1`；不改 policy 为 thread-single，不开启 production。 |
| 现有 runtime 尚未注册 VCC export policy/entry/validator。 | `background-execution/runtime.js::BACKGROUND_EXECUTION_POLICIES` | 最小端到端切片必须先补 runtime 注册和真 Worker，不能只有测试 seam。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `thread-pool` 如何在 E12-A 保证只有一个 Writer。 | topology 未知 | 高 | 容易 | Supervisor 从 topology registry + CompoundLease 取 `effectiveChildCount`，但 native adapter 仍是一个 transport。 | PROBE | runtime topology snapshot + real Worker 实例计数 | topology planner 在 E12-A 恒返回 1，一个 one-shot Worker 处理全部 subjects。 |
| Worker 不收 raw rows 时如何保证业务等价。 | 合同未知 | 高 | 一般 | Worker 可 read-only 打开 DB；现有 writer core 可直接从 DB 构造 plan。 | PROBE | authority digest + 真 workbook 回读 golden | Main 仅传 bounded run/subject/path authority；Worker 自读 DB；Main Join 用同一读取器重建期望 plan 并深度回读 workbook。 |
| revision/archive 在 Worker 生成期变化的 TOCTOU 如何封闭。 | 状态生命周期盲区 | 高 | 一般 | Worker read-only transaction 可得到单一 DB snapshot；Main `activeTask` 阻断同 Service mutation，但仍需防自相一致的伪造/DB 旁路。 | PROBE | A/B authority 替换、生成后改 revision/archive/fingerprint，断言 Publisher=0 | Worker 开始与结束核对 authority digest；Main generation 前和 Join 后重读 task/run authority；Publisher 前再核 FilePlan/target snapshot。 |
| cancel/crash 后 task-private files 谁清理。 | ownership 未知 | 高 | 容易 | Supervisor 保证 transport/lease shutdown；现有 writer 只在 deferred 模式清理 partial files。 | PROBE | 中途失败、cancel、worker terminate、runtime shutdown 后扫描 staging | Worker 对已知 generation paths 做 finally 清理；Main 仍是目录 owner，Publisher committed 后由现有 wrapper 删除，失败时有界 cleanup。 |
| `export-single` 与 `export-subjects` 的 E12-A 范围边界。 | 范围歧义 | 高 | 容易 | 冻结 Action 范围同时列出两者。 | BLOCK（已收口） | 项目 owner 范围裁决 | E12-A 必须用同一 one-shot Writer core 覆盖两个 action；`export-single` 是 exact-one subject specialization，仍不做 SQL filter pushdown。 |

## BLOCK 问题

无。单 Writer topology、run/archive authority、FilePlan/Publisher ownership 可由冻结合同和现有代码唯一收口。

## 保守假设

- E12-A 同时注册 `export-subjects` 和 `export-single`；前者覆盖 authority 中全部 subjectIndex，后者只允许一个显式 subjectIndex。
- live handler 不调用 managed path；production flag 保持 false/effectiveWorkerCount=0，因此本 PR 仅提供可独立验证的 dormant capability。
- E12-B 之前单 Writer 允许一次读取全量 subjects；禁止的是第二 Writer 也重复全量加载。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 实现 canonical policy + bounded authority/input/result contract，注册 runtime 与真 Worker entry。 | production false、一个 Writer、无 raw rows DTO。 | policy byte-for-byte；protocol max bytes；topology=1；真 Worker 完成 one-shot。 | 平台合同不成立，停止后续 Join。 | 只移除 VCC policy/entry，live 路径零变化。 |
| 2 | 构建 Main-owned task/run/archive/FilePlan authority 与 task-private generations。 | activeTask/taskGeneration、runId/month/revision/fingerprint/archive、set/order/path ownership。 | stale/A-B/collision/alias/symlink/target drift 全部在 Publisher 前拒绝。 | 任一 authority 不能唯一收口则不发布。 | 保留 legacy export，managed dormant。 |
| 3 | Writer 复用 legacy writer core 顺序生成，Main 深度回读每主体 workbook。 | 模板、金额、币种、Pending、style、lineage、subjectIndex 等价。 | 单/多主体 legacy-vs-managed semantic golden。 | 业务证据不一致则 Publisher=0。 | 共享 writer core，不改金额规则。 |
| 4 | 全部 Join 成功后调用一次既有 Publisher，完成 fault/shutdown/cleanup 测试。 | all-or-none、单次 Publisher、失败/取消/crash 零发布。 | Publisher 计数、journal recovery、staging 残留、runtime shutdown report。 | 故障不能 fail closed 则不交付。 | production 仍 false，live legacy 不变。 |
