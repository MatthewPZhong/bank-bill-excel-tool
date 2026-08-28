# v3.2.4 E12-A Unknowns Preflight

## Task Brief

- Goal：将 VCC Financial OP 现有按主体顺序导出迁入 one-shot 单 Writer 新合同；同一 core 覆盖 `vcc-financial-op:export-subjects` 全主体输出和 `vcc-financial-op:export-single` exact-one subject specialization，Main Join 复核完整集合后只调用一次既有 Publisher。
- Context：本次 restack 的精确 parent 为已审查 E11-C `771572ff3b7b4f623eafd2a8c44c34038f2a6b98`；现有 live `vccFinancialOp:export:result` 在 VCC Service `activeTask` 内由 Main 进程调用 `writeRunWorkbooks`，然后一次 `publishVccFinancialOpOutputs`。
- Constraints：仅 E12-A 单 Writer；不做 subject SQL filter pushdown、第二 Writer/shard 或 15% benchmark；不接 live IPC/Renderer/Preload，不开启 production；不改金额、币种、差异、revision、archive 语义；复用现有 workbook writer、FilePlan 和 durable journal Publisher。
- Done when：`production.enabled=false` 的 dormant capability 与 canonical policy 精确一致；一个 Writer 按 `subjectIndex` 顺序生成全部主体；Main 对 task/run/month/revision/fingerprint/archive/FilePlan/path/size/hash/业务 workbook 做 A/B authority 复核；Main 冻结 task-root identity，Worker 入口/逐主体/atomic handoff 复核；任一 generation/Join/cancel/crash 失败 Publisher=0，全部成功后 Publisher=1；committed 后 cleanup pending 只形成有界恢复证据且不改写正式成功；协议 DTO 有界且不携带 raw finance rows；shutdown/cleanup 与 legacy golden 回归通过。

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
| cancel/crash 或 committed 后 cleanup 失败时 task-private files 谁清理。 | ownership 未知 | 高 | 容易 | Supervisor 保证 transport/lease shutdown；atomic writer 可确定当前 UUID tmp，Main 已有 exact task-dir cleanup/recovery owner；Publisher wrapper 过去会吞 generation rm 失败。 | PROBE | generation EBUSY/EPERM、task-dir rmdir、cancel/worker terminate、同 operation retry、runtime shutdown 后扫描 staging | Main dispatch 是 generation/task-dir 的唯一 cleanup/recovery owner；atomic writer 只拥有当前 UUID tmp。普通失败与 committed success 都返回/附加有界 cleanup evidence；wrapper 在 E12-A defer 防止双删；task dir 未收口前 retry collision fail closed。 |
| E11-C 新增的取消后 cleanup owner 是否会与 VCC Writer/Publisher 重叠。 | restack 交互盲区 | 高 | 容易 | E11-C cleanup 绑定 ReconFix export plan；VCC 仍由其 dispatch/Writer/Publisher 私有边界负责。 | PROBE | E11-C 取消清理回归 + VCC cancel/crash/同 staging 重试 + Supervisor shutdown | 两条 action 保持不同 plan owner；各自清理一次，成功产物不被失败清理误删。 |
| `export-single` 与 `export-subjects` 的 E12-A 范围边界。 | 范围歧义 | 高 | 容易 | 冻结 Action 范围同时列出两者。 | BLOCK（已收口） | 项目 owner 范围裁决 | E12-A 必须用同一 one-shot Writer core 覆盖两个 action；`export-single` 是 exact-one subject specialization，仍不做 SQL filter pushdown。 |

## Restack Review Round2 Unknowns Closure

| 补充未知 | 分类 | 证据收口 | 最终决定 |
| --- | --- | --- | --- |
| caller 提供的共享 staging root 是否足以作为 task-private recovery authority。 | PROBE（高） | 共享 root 可以包含 caller-owned 文件；目录扫描失败时无法证明其中所有名字属于当前 job。真实 FS `chmod 0300` 证明已知 generation 可按 exact path 删除，但 UUID atomic tmp 无法在 `readdir EACCES` 时安全发现。 | 共享 root 只作为父 authority。由 action/operation/task/run authority、subject set 与 canonical FilePlan 派生一个 exact 直属 `vcc-export-<digest>` 子目录并绑定 realpath；scan 失败只保留该子目录，不把共享父目录或猜测 tmp 暴露为 recoveryPath。 |
| Result Sheet 是否可只校验值、merge 与少数动态样式。 | PROBE（高） | raw OOXML 可以在重算 size/hash 后独立篡改 header/body blank cell style、row/column layout；逐格补丁无法证明模板语义集合闭合。 | 保留唯一 `validateResultSheet` authority，按 header A:N、body A/B:C merge master/follower、D:L、普通/调整 M:N、动态 font/numFmt/wrap/height，以及 row/column hidden/outline/width/height 建立模板语义矩阵；Writer self-check 与 Main Join 继续复用同一 validator。 |

## Independent Review Round4 Unknowns Closure

| 补充未知 | 分类 | 证据收口 | 最终决定 |
| --- | --- | --- | --- |
| Publisher committed 后 generation 或 task dir 删除失败，是否应把业务结果改为 failed。 | PROBE（高） | 正式目标已由 durable Publisher 唯一提交，重新解释为业务失败会诱发不可安全重发；但静默吞错会丢失恢复责任。 | 保留首个 publication committed 事实与 Publisher=1；由同一 Main generation cleanup owner 返回 `complete/pending`、确知 recovery paths、有限诊断 code 与 task-root digest。cleanup pending 不自动重发；同 operation retry 在残留 task dir 上 fail closed，恢复后仍由同 owner 收口。 |
| Main 创建 task dir 后到 Worker/atomic handoff 之间，路径字符串与一次 realpath 是否足以阻止替换。 | PROBE（高） | 可在 Worker 开始前或 staged tmp 写完后替换 task dir，旧实现会把外部同名路径当 generation/tmp；测试可稳定复现。 | Main 冻结 resolved/real、device/inode、parent path 与 canonical digest到 exact Worker input；Worker 入口、每个 subject 写前、atomic handoff 前复用一个 checker，要求 root identity 未变、generation 为直接 child/no alias、tmp 是 strict UUID direct child。已变化则 Publisher=0，且不触碰替换路径。明确不声称闭合检查后的 OS 纳秒竞态，不引入 native/openat。 |

## Independent Review Round4 Follow-up Unknowns Closure

| 补充未知 | 分类 | 证据收口 | 最终决定 |
| --- | --- | --- | --- |
| cleanup 入口一次 identity 校验能否保护后续 scan/delete/rmdir。 | PROBE（高） | 同路径 task root 可在 scan 后、delete/rmdir 前替换；即使 root inode 被移动到相同 lexical path，新 parent inode 也可能已变。 | frozen identity 同时绑定 root 与 parent 的 resolved/real/device/inode；现有唯一 cleanup owner 在每次 scan/delete/residual scan/rmdir 前复用 checker。mismatch 时零文件触碰，只返回有界诊断/digest；不新增第二 scanner 或恢复 authority。 |
| `mkdir` 成功后的 identity/collision 失败是否属于本次 cleanup owner。 | PROBE（高） | 已创建目录在后续校验失败时若直接抛出，会泄漏 exact task dir并让同 operation retry 永久 collision；但 caller 已有目录不可误删。 | 只对本次成功创建的 exact task dir建立 owned identity；所有 post-create failure 走同一 cleanup owner。cleanup 成功后 retry 可继续；失败时返回有界 exact recovery evidence，retry fail closed，恢复后仍由同 owner 收口。 |
| Result/Pending 是否已闭合页面和行布局 authority。 | PROBE（高） | OOXML 的 orientation、margin、header/footer、sheet state 与 Pending row hidden/outline 可独立篡改并重算 size/hash；仅 cell style/row height 比较不足。 | 唯一 Result validator 比较 sheet state/properties/pageSetup/headerFooter（仅动态 printArea 例外）及原有完整布局矩阵；Pending projection补 row hidden/outlineLevel。Writer self-check/Main Join 继续复用 canonical authority。 |

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
| 4 | 全部 Join 成功后调用一次既有 Publisher；由 Main 单一 owner 完成 generation/task-dir cleanup，并覆盖 identity replacement、fault/shutdown/committed-cleanup 测试。 | all-or-none、单次 Publisher、失败/取消/crash 零发布；committed cleanup pending 不改写正式成功或诱发重发。 | Publisher 计数、journal recovery、bounded cleanup evidence、staging identity/retry collision、runtime shutdown report。 | 故障不能 fail closed 或 recovery responsibility 不可审计则不交付。 | production 仍 false，live legacy 不变。 |
| 5 | 在 E11-C 新 parent 上回放 cancellation/cleanup、policy registry 与 recovery canary。 | restack 不覆盖上一阶段 runtime/cleanup authority。 | E11-C focused、Supervisor/registry、VCC recovery 与 canary 全通过。 | 任一 owner 重叠或 cleanup 漂移则停止提交。 | 撤销 E12-A 两笔重放提交，保留已审查 E11-C。 |
