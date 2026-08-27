# E07-B Duplicate Receipt / Mirror Recovery Unknowns Preflight

## Task Brief

- Goal：为 production-false Duplicate managed capability 接入 import/run durable operation receipt、Main mirror operation identity、exact outcome inspector、只消费已提交 side 结果的 CAS complete-mirror，以及可重放的恢复审计。
- Context：精确基线/父 E07-A 为 `e36dfe33a22d6d821fa3792a70a2580de7af45af`；冻结合同为 v3.2.2 Spec/TechDoc、Platform RecoverySource/Startup Coordinator 与 E07-A notes，不从旧 change 文档推导合同。
- Constraints：不实现 E07-C paired parser；不启用 production；不接 live IPC；不改变 matching、候选消费、金额币种、行输出或公共 Platform schema；partial/unknown 不自动重跑；禁止 `release-check`、`check-vars`、`scan:vars`。
- Done when：import/run receipt 与各自 side mutation 同事务；duplicate operation replay 不产生第二份业务 mutation；Main run mirror保存 `operationKey/producerTaskRunId`；inspector精确区分 committed/not-committed/partially-committed/compensated/unknown；complete-mirror 只读取已提交 side receipt/result并以 Main transaction CAS+audit；崩溃窗口、幂等、identity冲突、部分失败与行数守恒有真实可达测试。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E06-P0 已建 Duplicate receipt schema/repository，但 import/run writer 未调用 | `run-data-store.js`、`operation-receipt-repository.js`、`v322-operation-receipt-e06-p0.test.js` | 复用冻结 receipt 字段，不另造 receipt 方言；必须移动到真实 side 事务内 |
| import side commit 在 `createImportBundle()` 单事务；run 成功 side commit 在 `finishRun()` 单事务 | `duplicate-inbound-match-store.js` | receipt 分别在这两个 COMMIT 前写入；事务回滚必须同时移除业务行与 receipt |
| 当前 run 先建 Main running mirror，再完成 side，最后 finish mirror | `service.js#run` | managed E07-B 路径必须改为 side success+receipt COMMIT 后才写 Main mirror；legacy 无 identity 路径保持旧行为 |
| Main mirror尚无共同 operation identity，repository也无 operation CAS | `migrations.js#ensureDuplicateInboundMatchRunMetadataSupport`、`duplicate-inbound-match-run-repository.js` | 加法 nullable migration兼容历史行；exact managed rows要求非空 identity；恢复按 operation identity CAS |
| E07-A startup inspector把任何 residue判 unknown，provider禁止恢复 | `startup-recovery.js` | E07-B必须按 receipt/mirror/audit 枚举 operation source；历史无 identity residue仍保持 unknown+Hold |
| Platform 对 partial/unknown 直接创建 Hold，不自动调用 provider | `startup-recovery-coordinator.js#recoverSource` | complete-mirror能力只供显式批准的 module recovery；本 PR不得暗中自动补镜像或绕过 Hold |
| Service command可从 Worker envelope取得 exact action/operation/task identity | `worker-host.js#startJob` 与 Protocol context | 只向 managed capability注入，live legacy handler不受影响 |
| Duplicate side DB/主镜像与 matching/行数守恒属于 Risk-sensitive 资金红线 | `rules/important-variables.md` Duplicate条目、v3.2.2 Spec §13 | 自动测试不能解除真实样本/人工恢复复核；最终必须列关联功能 review |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| receipt input evidence如何稳定且不改变业务口径 | identity | 高 | 一般 | import已有两文件hash；run已有import identity+MPT snapshotHash | PROBE | same operation/same input与same operation/different input测试 | import hash固定角色文件hash；run hash固定import bundle/file hash与MPT snapshot，不含volatile时间 |
| duplicate replay在何处拦截才不会先清旧state | 幂等 | 高 | 一般 | 现有import/run入口第一步会invalidate | PROBE | 第二次同operation调用spy side writer/matching/mirror次数 | 在任何invalidate/matching之前查询authoritative receipt；exact replay恢复bounded session/result，identity冲突fail closed |
| Main mirror CAS的pre-image是什么 | 并发 | 高 | 一般 | Duplicate mirror是append-only run行，不是BankBU同月单槽；冻结Duplicate表只要求matching/absent | PROBE | absent→insert、matching replay、operation collision/并发变化测试 | CAS scope为本次 operation mirror：absent或exact post-image；其它operation历史镜像不冒充pre-image |
| partial如何触发complete-mirror | 恢复控制 | 高 | 困难 | generic coordinator partial必建Hold且不调provider | ASSUME | coordinator contract test + provider direct approved recovery test | 本PR实现显式provider recovery能力；自动startup保持Hold，production/manual gate负责批准和Hold resolution |
| receipt被新import/run失效清理后的恢复审计如何保留 | 状态生命周期 | 高 | 一般 | side DB整库/旧run清理会删除或悬空receipt | PROBE | expiration audit写入后crash、重复失效和重启枚举测试 | Main durable audit先记录 compensated/expired，再允许清理side；审计失败则不清理 |
| WAL crash证据如何只读且完整读取 | 恢复证据 | 高 | 一般 | E07-A immutable读取不写原文件但不保证回放WAL | PROBE | committed receipt留在WAL、原family bytes/mtime不变测试 | startup读取复制后的完整DB/WAL/SHM snapshot；只写临时副本，不触碰原证据 |
| 恢复审计与mirror CAS如何避免半提交 | 原子性 | 高 | 一般 | 两者都在Main DB | PROBE | audit insert fault/mirror insert fault/replay测试 | 同一 `BEGIN IMMEDIATE` 内CAS mirror与append-only recovery audit；任一失败整体ROLLBACK |

## BLOCK 与保守边界

E07-B production-false 实现没有需要用户决策的 BLOCK。以下继续阻断生产：

1. partial complete-mirror 的人工批准/Hold resolution尚未接live控制面；本PR只提供可审计能力与测试。
2. E07-C paired parser 15%/RSS、Windows packaged native SQLite、真实BizId/MPT/document资金样本未完成。
3. Duplicate三项policy与live IPC保持 `production.enabled=false` / legacy-preserved。

## 保守假设

- 历史 mirror/side residue缺少任一 operation identity时不猜测，仍返回 `unknown` 并Hold。
- exact receipt存在但业务目标行、snapshot、owner或行数证据不一致时返回 `unknown`，不尝试修复。
- `compensated` 包含有durable audit的显式 compensation/expiration；仅删除文件或内存失效不构成补偿证据。
- complete-mirror只创建/重放本次operation的success mirror，不更改其它operation镜像，不重新执行matching。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结identity/evidence、Main schema与repository CAS/audit | operation/task/side血缘；CAS原子性 | migration幂等/旧库兼容、CAS fault/replay测试 | 后续恢复不可判定 | 保留nullable migration，停止managed writer |
| 2 | side import/run receipt同事务与pre-mutation replay | 不多写、不重跑、事务回滚 | duplicate/replay/conflict/rollback测试 | 重复记或漏审计 | writer保持production-false并回退不接managed |
| 3 | operation source枚举与exact inspector | 五种outcome唯一、WAL证据零破坏 | outcome矩阵与bytes/mtime测试 | startup可能误清或误补 | fail closed为legacy unknown Hold |
| 4 | approved complete-mirror provider | 只消费committed side；Main CAS+audit | side-only crash、mirror后reply crash、并发冲突、audit fault | partial恢复可能重复matching/错镜像 | provider只返回terminal failure/保持Hold |
| 5 | managed接线与生命周期失效审计 | identity从envelope到receipt/mirror；旧结果去向可审计 |真实Worker/restart/replay与E2E守恒 | live行为漂移或receipt悬空 | 不动live IPC/production flag |
| 6 | 双盲区复核与affected验证 | 旁路、部分失败、行数/状态守恒 | focused/affected tests、lint/check/diff clean | 不能交付 | 缩回未证实能力，不做较小替代上线 |

## Independent Review Repair Preflight（2026-08-28）

### Review Goal / Constraints / Done when

- Goal：只修复独立 review 接受的 Windows side path identity、同进程 partial latch、完整 result post-image digest 三项，不扩成 E07-C/general compensation。
- Constraints：新 managed writer持久化 POSIX identity；历史 `\\`/`/` 只做 separator comparison；legacy null-operation继续unknown/Hold；recovery不调用matching；production/live仍关闭。
- Done when：跨separator exact replay/CAS成立且其它路径冲突；Main mirror异常后立即authoritative重读并建立完整generation latch；same replay只补mirror，三类其它命令阻断；restart partial进入Hold/新generation gate且重复扫描零side/Main mutation；同计数内容变化被digest拒绝，Main只保留bounded digest/count。

### Review Unknowns Register

| 未知 | 分类 | 仓库证据/探针 | 决定 |
| --- | --- | --- | --- |
| Windows历史side path能否用全局path normalization修复 | PROBE | `runDataStore.sideDbRelPath`被多个legacy模块共用；全局改动会扩大兼容面 | 新增Duplicate局部POSIX writer；comparison只替换separator，不折叠`.`、`..`、重复separator或大小写 |
| mirror writer异常后如何区分commit-before-reply与真实partial | PROBE | Main CAS writer可能在commit后抛错；仅凭exception无法确定post-image | 每次CAS前后按receipt/result/mirror完整identity重读；exact mirror视为committed，absent视为partial，任何conflict/read ambiguity视为unknown |
| Worker crash会否绕过内存latch | PROBE | 新generation首构已有`startup-gate`且会调用exact `sideOperationSnapshots` | 内存latch关闭同process窗口；新generation由持久receipt/digest触发`DUPLICATE_STARTUP_RESIDUE_UNRESOLVED`或Platform Hold，无需新公共协议 |
| 只校验三路count能否发现内容被改但count不变 | PROBE | side表含mail/manual/audit实际JSON与完整血缘；Main不得复制敏感行 | `finishRun`同side事务生成canonical SHA-256，覆盖snapshot、summary、三类内容与五路守恒；Inspector复制DB family后只重算digest/count |

### BLOCK / ASSUME

- 新增 BLOCK：无。三项均可由既有side/Main schema、startup gate与测试确定，不需要改变公共合同或用户流程。
- ASSUME：历史managed run/mirror缺少`result_digest`时不能安全回填，按unknown/Hold处理；这是fail-closed兼容，不放宽legacy null-operation。
