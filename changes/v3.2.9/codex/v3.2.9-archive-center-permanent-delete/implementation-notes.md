# Implementation Notes

## Baseline

- [Spec](spec.md)、[TechDoc](techdoc.md)、[Preflight](preflight.md)
- Branch：`codex/v3.2.9-archive-center-permanent-delete`
- Base：`v3.2.8` / `2ba9ef14fe972363b604955636cff0c9ac53700f`
- Worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool-worktrees/codex-v3.2.9-archive-center-permanent-delete`

## Decisions

- 2026-09-11 D-01 用户确认仅受管文件；所有主动删除为 managed-only。
- 复用 archive_cleanup_jobs；新增版本化计划、逐项进度和最小完成凭证，不另建并行队列。
- 分工：repository 与持久层；controller/IPC/renderer 与 owner outbox；storage-root-manager 与迁移；主 Agent 整合 service、文件身份和验证。

## Assumptions

- 复用主工作树已安装依赖的 node_modules 链接；不安装或修改共享依赖。

## Deviations

- 暂无已接受行为偏离；实现中的发现继续同步。

## Evidence

- save-spec 已保存已审查 Spec/TechDoc 到本分支规范目录，随后同步 D-01 决定。
- 分支和独立 worktree 已创建；主工作树未切换。

## Remaining Unknowns

- 第五轮 BizOP 原发布 owner 收口与 Position 新 FilePlan 来源证据／共享删除修复已通过冻结源码的完整本地门禁。Windows 文件占用、打包运行及 GUI 人工验收尚未执行。

## 实施复核决定（2026-09-11）

- 删除只使用显式持久计划，不调用既有 `onSourceReleased` 递归/尽力回调。正常导入后的源释放行为保持原契约。
- Position 导入暂存有独立受管根；通过具体模块、输入方向、受管目录结构、持久 snapshot/SHA/size 及 owner inventory 验证后，以逐文件目标写入同一计划。外部导入原文件仍保留。
- 新 readonly 生成前写创建意图，创建文件后登记 dev/ino，写入完成后登记内容身份。创建中断的对象只在原 inode/父目录仍匹配时可回收。
- 原任务完成后处理之后才写 owner completion proof；无证明的现代历史 FileTask 保留诊断，不能通过空 outbox 推断完成。
- v1 cleanup job 只有路径/SHA/size，不能证明当前同路径文件还是旧对象。已有文件缺少历史身份时 fail closed；目标均已缺失且原根可验证时才安全升级。不会用当前 stat 伪造历史身份。
- 操作系统未提供跨平台按 inode 原子 unlink API。实现复用受管路径/根串行保护、内容及 dev/ino/父链核验，最后同步检查与 unlink；外部进程并发替换和 Windows 真实文件占用需保留平台验收边界。

## Blindspot Pass / 专项风险复核

- 已沿 renderer → preload → IPC → Controller → Service → Repository → 逐项文件 IO → receipt/outbox 恢复复核；手动删除和 retention 都在 owner 保护先于 root 队列的顺序内。
- 已定位并修复：成功只读副本 `.tmp` 登记缺失后出现替代文件被重新认领；retry 入队前读取 stale job；迁移复制后的 Blob fingerprint 仍指旧 inode；删除遗留空 Blob shard 阻塞后续迁移。
- 金额、币种、方向、匹配规则与导出列未改变。对账专项聚焦 batch/task/operation 身份、业务持有锁、恢复幂等、历史兼容和删除审计；未发现本次改动触发金额/主体归属或重复记账红线。
- 最终自动验证已通过，平台人工验收尚未执行；旧任务缺证的拒绝行为属于明确兼容边界，不算自动清理已完成。

## 可回收 Task 元数据

仅当原 owner 证明已持久、Task 独占且终态、没有有效 lineage/flow-bind/恢复义务时，删除事务精简 `metadata_json` 与失败明文。身份、状态、必要时间和幂等字段继续保留。共享/恢复元数据与关系不能盲删：committed lineage 支撑其他批次两跳关联；discarded lineage 键仍参与同 operation 的幂等核验。

## 验证索引

详见 [validation.md](validation.md)。日志保存在工作树的 `logs/verification/`（受现有 gitignore 保护），不混入业务数据或源代码提交。

- 验证完成后将独立 worktree 移到项目旁的持久目录；迁移前后按 SHA-256 核验全部本轮 tracked/untracked 改动。未提交、推送或修改版本号。

## Review 修复决定（2026-09-11）

- 用户授权修复本分支 review 的 5 项问题。以审查时 29 个 tracked/untracked 文件的 SHA-256 为基线，在隔离副本中实施，写回前逐文件检查目标 worktree 未发生并行变化。
- 预分配路径不构成物理对象归属。现存 materialized 文件必须有持久原始指纹及 inode；缺证据的失败输出保留批次和未知文件，安全缺失仍按幂等处理。
- 硬链接仅在冻结计划保留 nlink、birthtime、inode、内容和时间身份，且原计划内缺失链接准确解释链接数减少时，接受自身 unlink 引起的 ctime 变化。独立文件、被替换对象及无法解释的链接变化继续拒绝。共享 Blob 在该批次同组目录目标全部完成后，以原计划为依据事务比较并推进其他有效引用的指纹；进度或指纹落库失败均沿原 job 重试。
- 延期终态在 eager/deferred 等入口统一携带匿名后处理待完成标记。原后处理未执行且没有持久路由时保留 outbox，不登记 completion，不放行删除。
- 工具箱发布恢复先完成实际文件后处理并保留耐久 finalizing 状态，再记录完整 owner 凭证，最后移除恢复控制记录。带有其他业务后处理职责的 read-only 发布仍交给原 owner 路由，不补造空后处理凭证。月末副本恢复同样在 target copy 已验证且 intent 移除前保存收口事实。
- 到期维护只接受当前 entry lease 的内部 ownerToken；迁移 journal、其他持有者、active 维护及渲染端请求继续被门禁拒绝。
- 本轮未调整金额、币种、匹配、输出列或外部原文件授权。新回归先确认原缺陷，再验证修复及反例；最终结果更新到 validation.md。

首轮修复证据：`UNIT_TEST_CONCURRENCY=4 npm run release-check` 退出码 0；单测 7387 通过、0 失败、3 项 Windows 专用跳过；54 个集成脚本全部通过、2496 个已计数用例，其中永久删除集成 8/8。该轮补齐了删除计划之间的 hardlink 冲突准入；随后复审发现下述正常读取、维护及发布收尾组合未被覆盖。

## 再次 Review 修复（2026-09-11）

- 用户授权修复再次 review 的 4 项问题；以当前 36 个 tracked/untracked 文件的 SHA-256 为基线，在隔离副本实施。发布 owner、存储身份和跨层集成分别维护独立文件；主 Agent 整合、独立复核并验证最终内容。
- 正常工具箱收尾和启动恢复必须使用同一完成顺序：实际 cleanup → 耐久 owner completion → receipt finalization。完成凭证写入前始终保留可重入的原 owner 记录。
- 已知 VCC 导出的匿名后处理属于共享发布恢复的真实职责，须在归档暂时失败后由原 Task/批次恢复并 ACK；不以删除 pending 标记或跳过初始化消除阻塞。沿共享 ACK 调用方补齐 Pending、Biz OP、Pre-fund、Acquiring 的 7 个同类只读导出，精确映射共 12 个入口；其他模块的业务后处理继续交给原 owner。
- 挂起删除所引用 inode 的正常读取、修复和维护脱钩需要共同协调；保持精确身份校验，不因应用自身未登记的变化而放宽判断。原计划收口后的正常脱钩以 unlink 前后身份核验和事务 CAS 同步其他原 inode 引用，指纹事务失败仍保留可恢复状态。新批次同 SHA 内容的保留按当前引用及新对象证据判断；维护不会登记替代 inode。
- 历史 Blob 的 NULL 指纹是合法升级状态。现存 Blob 缺少原对象身份时明确拒绝，安全缺失仍幂等；不由删除预检用当前 SHA/stat 补造旧身份。
- 本轮不改变 managed-only 范围、金额/币种/匹配规则、输出列或业务数据。完成依据为回归的修复前失败和修复后结果，以及最终完整门禁。

再次 Review 修复最终证据：发布相关 8 个单测文件 251/251 PASS，存储相关 3 个文件 138/138 PASS，跨层永久删除集成 14/14 PASS。`UNIT_TEST_CONCURRENCY=4 npm run release-check` 退出码 0；470 个单测文件共 7412 通过、0 失败、3 项 Windows 专用跳过；54/54 集成脚本通过，2502 个已计数用例。独立只读交叉复核及 unlink 中断后新同 SHA 引用的组合探针通过。日志及验证边界见 validation.md。

## 第三轮 Review 修复（2026-09-12）

- 用户授权修复两项已确认问题：迁移 post-switch 清理仅凭路径误删替代对象，以及删除预检迟到覆盖当前弹窗并恢复已销毁页面。当前默认 Main 已停用的旧 Biz OP 导入候选不纳入本次修复。
- 以目标分支 37 个 tracked/untracked 文件的 SHA-256 为基线，在独立完整 Git 副本中实施；迁移、Renderer 与跨层集成分别维护独立文件。保留原有未提交成果，写回前重新比较目标，写回后核验与验证副本一致。
- 迁移已有路径清单只证明历史发布位置。新 journal 为源清理和目标发布记录原对象身份；恢复清理先核验关联任务和两端待清理对象，再逐项复核。旧 journal 缺原身份时不从当前 stat/SHA 补造凭证，现存对象保留并给出诊断；安全缺失沿已有幂等规则处理。
- 新身份保护同时覆盖切换前恢复和切换后清理，避免同一个辅助函数留下旁路。部分清理或进度写入中断仍以原 journal 重试，不丢弃 cleanup job，不提前写 fullyDeleted 完成凭证。
- 独立复核发现 source 历史硬链接在迁移中断后的正常读取中被脱钩，会破坏新冻结身份。通过 Manager → Service 内部 mutation guard 暂缓未收口 journal 的原源对象变更，读取保留 canonical fallback；迁移结束自动恢复维护，不按同 SHA 接受替代 inode。
- 删除预检绑定设置页生命周期和请求序号；关闭页面、后续预检或切换弹窗使旧回调失效，成功、失败、取消和完成回调均不得恢复失活页面。
- 继续执行 managed-only 及 ARC-DEL-02、06、07、09 既有要求。金额、币种、匹配、导出列和外部源授权不变；专项复核聚焦对象归属、幂等恢复、历史缺证拒绝和删除审计。
- 验证使用真实临时文件／SQLite 的恢复回归和真实 Renderer 函数的受控异步测试。迁移单测 73/73、相关 Service 单测 122/122、UI 合同及异步生命周期 40/40、永久删除集成 23/23 均通过。最终完整 `release-check` 退出 0：471 个单测文件共 7442 通过、0 失败、3 项 Windows 专用跳过；54/54 集成脚本通过，2511 个已计数用例。具体日志、修复前对照和平台边界见 validation.md。

## 第四轮 Review 修复（2026-09-12）

- 用户授权修复两项确认问题：当前版本普通 File Task 在运行中或终态已提交、completion 尚未落库时崩溃后无法删除；历史硬链接目录删除暂时失败、原 Blob 已删除、同 SHA 新批次重新发布后，原目录遗留无法重试。无真实可达证据的其他候选不扩入本轮。
- 以目标分支当前 39 个 tracked/untracked 文件的 SHA-256 为基线，在新的完整隔离 Git 副本实施；普通 owner 恢复、硬链接执行器和跨进程集成各自维护独立文件。保留前轮成果，写回前检查并行变化，写回后比较已验证内容和备份。
- 普通无后处理 File Task 的恢复责任随新批次、manifest 和 issuance 在同一 SQLite 事务保存，先于业务执行或 deferred promotion 放行。只为当前创建、明确没有 afterTerminal callback 或持久路由的 owner 登记；不向已有批次或历史缺证任务补录，不把匿名未完成后处理推断为无责任。
- 启动沿现有 owner/outbox 恢复及 interrupted sweep 后核验恢复责任、实例、exact owner、Task 与批次终态和保护集合；可核验的原责任事务生成 completion 并清除责任。运行中崩溃继续保留 Task interrupted／batch failed 语义，不复活任务、不重放业务。正常完成也须原子保存凭证并清除自身责任。
- 原计划硬链接的 nlink 减少可以由同一 V2 job 的耐久 deleted 进度解释。若 sibling 路径已由当前有效引用重新发布，只接受父链不变、原 unlink 已落库、当前对象为不同 inode 且匹配其持久身份的情况；原目录本体仍核验原 inode、内容和精确 nlink 差。新批次文件不进入旧计划删除范围；未持久进度、非 unlink 状态和原 inode 再出现继续拒绝。
- 本轮仍执行 managed-only、原 owner 恢复、删除审计和历史缺证拒绝。金额、币种、匹配、导出列与外部原文件授权不变；验证使用临时 SQLite、真实文件和真实进程退出，不操作业务数据库。
- 交叉复核确认当前 Acquiring `run:resume` 可以在侧库暂时不可读又恢复后重开原 interrupted Task。新增 completion 标记其来自本轮持久责任；合法 exact owner／manifest 的重新开始与仅该 interrupted 证明的撤销、原责任重建须同事务完成。恢复清单遇已知侧库读取异常时通过既有启动和删除门禁拒绝，不能把未知恢复状态当成空清单。
- 最终聚焦验证：新 owner／Acquiring／run-data-store 三组 84/84 PASS（含 40 项新 owner 回归与 1 项 strict 枚举新增回归）；原 owner／生命周期／Controller／Repository 四组 180/180 PASS；永久删除单测 59/59 PASS，其中硬链接新增 16 项。真实进程崩溃探针验证两次重开后的原身份与删除恢复；永久删除集成已扩至 29 项。最终完整门禁另见 validation.md。
- 最终完整 `release-check` 退出 0：472 个单测文件、7499 PASS／0 FAIL／3 项 Windows 专用跳过；54/54 集成脚本、2517 个已计数用例，永久删除集成 29/29。源码冻结哈希在门禁后保持一致；验证细节与平台边界见 validation.md。

## 第五轮 Review 修复（2026-09-12）

- 用户授权修复两项确认问题：BizOP v327 正式导出 ACK 临时失败后，业务恢复已成功但匿名 pending outbox 没有原 owner completion，阻断应用初始化；Position 新 FilePlan 归档未持久 expectedSha256/expectedSizeBytes，导致正常包含 staging 来源的批次无法永久删除。
- 基线为上一轮审查的 45 个 tracked/untracked 文件，HEAD 仍为 v3.2.8。新完整隔离 Git 副本内按 BizOP、Position、通用 FilePlan/Repository 与集成分工；保留修复前副本与 SHA-256，写回前后核验目标和验证内容。
- BizOP 由原 publication owner 核验 exact owner、manifest、Task/batch、已提交输出与完整清理事实，保存 Archive completion 后才关闭自身恢复责任。completion 持久化失败必须保留可重入原责任；现有匿名 pending 保护继续生效。已被旧恢复标为 CLOSED/COMPLETE 的原发布记录也须能在缺 completion 时由原 owner 重新核验并收口。
- Position 原 staging 证据须进入冻结 FilePlan：可选 expectedSha256/expectedSizeBytes 成对合法且大小匹配 sourceSnapshot，与首次批次、manifest、issuance 在同一事务保存。artifactKey 与 manifest identity 保持原算法；重复 reserve 不回填既有缺证批次，也不采用当前文件或 Blob 重新认领未知来源。
- 共享 staging 的已完成归档引用与活动/恢复硬保护须分开处理。共享引用只保留源文件，本批次独占存档仍可删除；最后一个合法 owner 清理来源。来源文件已缺失、删除顺序和持久清理计划重试必须有完整链路测试，未知或替代对象继续拒绝。
- 金额、币种、匹配、业务行和外部原件授权保持原契约；专项风险复核聚焦原 owner、来源血缘、幂等恢复、共享引用和删除审计。最终验证结果见 validation.md。

- 最终完整门禁退出 0：474 个单测文件、7529 tests，7526 PASS／0 FAIL／3 项 Windows 专用跳过；54/54 集成脚本、2523 个已计数用例，永久删除 35/35。首次门禁发现的旧静态 wrapper 断言已改为执行真实分支验证，相关 42/42 通过后重新冻结并重跑全门禁。54 个代码文件在最终门禁后未变化，具体日志与平台边界见 validation.md。

## 第六轮 Review 修复（2026-09-12）

- 用户授权修复两项已实际复现的问题：BizOP 未提交失败导出在首次终态落库失败后，原补偿责任关闭但匿名 outbox 缺 completion 而阻塞启动；Position streaming 导入的异常报告输出被新增 input-only 暂存来源校验拒绝，业务清理及重启后仍无法删除批次。
- 本轮以审查后的 60 个 tracked/untracked 文件 SHA-256 为基线，在新的完整隔离 Git 副本实施。BizOP、Position 分别维护独立代码范围，主任务负责跨层集成与文档，另由独立审查核对原始证据、业务引用和中断恢复边界。写回前检查目标没有并行变化，写回后核验与通过测试的快照一致。
- BizOP 失败补偿分支须核验原 binding、实例、完整 owner/manifest、持久 abort 与实际清理事实，先保存 completion 再关闭责任，两者同事务。历史 CLOSED 缺凭证记录按原事实重新枚举；不把匿名 pending 标记清除或忽略初始化错误作为修复。审查中取消叠加终态冲突属于基线已有问题，不纳入本轮新增缺陷。
- Position 报告使用精确输出归属协议，原对象及摘要在首次 reserve 持久保存；报告仍存在及已由 Main 正常清理均有真实导入回归。活动过滤记录和历史对账结果的持久引用继续阻止删除；普通预分配输出、历史缺证、替代对象及其他 owner 保持保护。
- 保持 managed-only、外部原件保全、有效业务数据及金额/币种/匹配规则。最终检查与测试计数记录于 validation.md；本轮不提交、推送、升版或发布。

- 最终独立复核未发现新增阻断；完整门禁退出 0：全量 unit 7556 PASS／0 FAIL／3 项 Windows 专用跳过；54/54 集成脚本、2527 个已计数用例，永久删除集成 39/39。58 个源码／测试／脚本文件在门禁后与冻结 SHA-256 一致。最终日志、跨进程证据与验证边界见 validation.md。

## 第七轮 Review 修复（2026-09-15）

- 用户授权修复两项已确认问题：迁移正常提交路径把同 SHA 的替代 inode 登记为受管指纹，真实 TaskLifecycle/Controller 确认删除随后移除了替代文件；4097 条已完成历史导出因缺新 completion 被全部纳入恢复，在处理首条记录前超过 4096 清单上限，反复重试仍无进展。
- 以目标分支 64 个 tracked/untracked 文件的 SHA-256 为基线；与上轮完整门禁副本一致，HEAD 仍为 v3.2.8。在新完整隔离 Git 副本中实施，迁移与 BizOP 分别维护独立代码和测试，主任务负责统一集成和文档，另行只读复核跨模块协议。
- 迁移使用已持久的目标身份核验后续目录化及提交，显式处理历史 hardlink 的受控 unlink，最终设置事务前同步复核；遇未知对象或缺证继续保留两根及 journal，不以当前 stat/SHA 补造归属。
- BizOP 保留真实未决来源的完整恢复与原预算，把仅缺历史凭证的记录分批处理，持久保存进度和诊断；原 pending 通知仍优先恢复。坏历史项不能饿死后续项或被当作已完成，原 owner 校验与删除门禁继续生效。
- 保持 managed-only、外部原件、有效业务数据和既有金额/币种/匹配语义。全部故障注入使用临时文件及 SQLite；写回前核验原工作区，保存备份并逐项比对已验证副本。本轮不提交、推送、升版或发布。

- 本轮进一步覆盖首次发布后、首次 journal 登记前的同 SHA 替代窗口：以原文件句柄身份传递到登记；仅迁移使用 materializer 可选发布回调，默认行为保持。历史补齐每次 64 条，界面提供可见的继续检查入口，不要求反复重启。
- 最终独立复核没有尚未修复的本轮阻断；迁移与默认 materializer 116/116、BizOP 59/59、UI 6/6、真实迁移删除／重启 3/3、永久删除跨层 43/43。完整门禁退出 0：全量 unit 7603 PASS／0 FAIL／3 项 Windows 专用跳过；54/54 集成脚本、2531 个已计数用例。68 个源码／测试／脚本文件与冻结 SHA-256 一致。具体日志、写回与平台边界见 validation.md。

## 第八轮 Review 修复（2026-09-15）

- 修复只读副本发布后、首次 ready 登记前认领同 SHA 替代 inode 的问题。以本次 wx 创建的原 fd 校验临时路径及父链，写入／发布全程持有原 fd；最终摘要校验后同步复核完整身份再登记，权限调整仅作用于原句柄。
- 成功时在 opener 前关闭句柄，失败时 finally 关闭；失败 owner 和现场文件保留，不能把替代对象登记为 ready 或交给后续批次删除。
- 以目标分支原有 74 个 tracked/untracked 文件的 SHA-256 为基线，在隔离副本实施并验证；写回前核验无并行变化并保存备份。验证及关联 ArchiveService 审计血缘复核结果见 validation.md。

- 最终完整门禁退出 0：7609 项单测通过、0 失败、3 项 Windows 专用跳过；54/54 集成脚本通过、2537 个已计数用例。新增回归 6/6、永久删除集成 49/49；70 个源码／测试／脚本文件与冻结 SHA-256 一致。独立复核及验证边界见 validation.md。
