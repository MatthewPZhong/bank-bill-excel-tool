# 本轮实现验证

日期：2026-09-15。分支：`codex/v3.2.9-archive-center-permanent-delete`，基线 `v3.2.8`。全部文件测试使用隔离临时目录与测试 SQLite；没有对用户业务数据执行试删。

## 第八轮 Review 修复验证（2026-09-15）

本节覆盖只读副本首次 ready 登记认领替代 inode 的误删问题，以及修复过程发现的流失败后重复关闭 fd 风险。以下历史轮次仅供追溯，不累加为本轮计数。最终完整门禁退出 0，70 个源码／测试／脚本文件在门禁前后与冻结 SHA-256 一致。

| 范围 | 本轮结果 |
| --- | --- |
| 新增只读副本回归 | 6/6 PASS：正常流、创建后／rename 后／最终 capture 后文件替换、父目录替换及 fd 复用 |
| 既有 ArchiveService／永久删除聚焦 | 124/124 PASS；随后由最终完整门禁覆盖最后的 close 监听修复 |
| 永久删除跨层集成 | 49/49 PASS，包含新增 6 项 |
| lint / smoke | 最终完整 release-check 中通过 |
| 全量 unit | 478 个文件、7612 tests；7609 PASS、0 FAIL、3 skipped；约 354 秒 |
| 全量 integration | 54/54 脚本通过；2537 个已计数用例，约 472 秒 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check` 退出 0，PASS；834.385 秒 |

- 修复前对完整 review8 源码运行正常对照及四条替换回归：正常通过，四条替换均因旧实现错误接受对象而失败。原 review 探针在修复后返回 `ARCHIVE_READONLY_FILE_CHANGED`，Controller 返回 `ARCHIVE_DELETE_TEMP_OWNER_PENDING`，替代文件保留；正常副本仍能真实确认删除。
- 新回归通过真实 template:import TaskLifecycle、FilePlan、SQLite、Controller 预检及确认令牌删除路径。创建后、发布后及最终 capture 后使用同内容新 inode 替换；父目录替换特意保留原文件 inode，验证父链也须连续。异常均不调用 opener、保留 creating owner 与替代文件，并在独立进程重新初始化后继续拒绝删除；正常流在独立进程重启后确认删除完成，外部源文件保持原字节。
- 写入流失败会 destroy 并关闭 fd，即使设置 autoClose:false 也不例外。新增回归在 close 事件中实际把旧编号复用于 sentinel 文件，验证失败收尾不再误关新文件；独立探针亦确认新句柄仍可写入。正常路径在 opener 前关闭创建句柄。
- 独立只读复核确认创建 fd、根／父链、最终完整身份及同步 owner 登记的边界；发现的重复关闭问题已修复并回归，最终差异没有尚未处理的本轮阻断。

证据目录：`/private/tmp/archive-delete-fix8-evidence-_gurpdaz/`。修复前后回归见 `readonly-owner-before-fix.log`、`readonly-owner-after-fix.log`，跨层集成见 `readonly-owner-integration-after-fix.log`；独立复核见 `independent-review-summary.md`、`readonly-error-fd-reuse-independent.json`。最终门禁及冻结记录为 `final-release-check.log`、`final-release-check-result.json`、`final-frozen-code.json`。

⚠️ 关联功能 review：按 `rules/important-variables.md` 的 ArchiveService 审计血缘条目核对只读副本、持久 owner、启动恢复和真实批次删除；未改变数据库结构、金额／币种／匹配规则、业务数据或 managed-only 范围。全部文件／数据库故障注入使用隔离临时数据；3 项 Windows 专项按平台条件跳过，未执行 Windows 实机、打包 GUI、Excel/WPS 或真实业务数据人工验收。

写回以原 74 个 tracked/untracked 文件及新增目标路径的原 SHA-256 为基线，检查目标没有并行变化，备份后逐项核对与已通过门禁的副本一致。写回清单和结果见 `writeback-manifest.json`、`writeback-verification.json`。本轮未提交、推送、升版或发布。

## 第七轮 Review 修复验证（2026-09-15）

本节覆盖迁移目标身份重新认领，以及大量已完成历史导出阻塞 BizOP 恢复。下方历史轮次仅供追溯，不累加为本轮计数。最终源码／测试／脚本按 SHA-256 冻结，完整门禁结束后逐项核对未变化。

| 范围 | 本轮结果 |
| --- | --- |
| 迁移专项 | 102/102 PASS，含原 73 项和本轮新增回归 |
| materializer 既有专项 | 14/14 PASS；与迁移组合为 116/116 |
| 迁移真实 Lifecycle → Controller | 3/3 PASS，覆盖正常迁移后实际删除、两类替代对象拒绝以及独立进程重启 |
| BizOP 历史补齐／原 owner／既有导出恢复 | 59/59 PASS：12 项新增、28 项原 owner、19 项既有导出／终态 |
| Renderer 恢复入口行为 | 6/6 PASS，执行完整 renderer 与实际点击回调；DOM／IPC 为测试替身 |
| 永久删除跨层集成 | 43/43 PASS |
| lint / smoke | 最终完整 release-check 中通过 |
| 全量 unit | 7606 tests，7603 PASS、0 FAIL、3 skipped；约 306 秒 |
| 全量 integration | 54/54 脚本通过；2531 个已计数用例，约 303 秒；1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS；约 617 秒 |

- 迁移修复前已用真实 TaskLifecycle 完成凭证、Controller 确认令牌和实际删除复现：同 SHA 新 inode 被最终指纹采样认领并删除。本轮从原创建／发布身份到 journal、复用、目录化消费、最终验证及同步提交检查持续核验，不用现场内容相同替代对象归属。
- 独立复核进一步发现并纳入同一修复：旧目标缺失后出现新文件的覆盖窗口，以及首次发布完成、首次身份登记前的替代窗口。相关原失败探针与修复后结果均保留；目标冲突不覆盖文件，原 journal、设置及两根保持可诊断。
- 正常迁移、历史 hardlink 转独立 copy、自身 unlink 导致的链接数变化和重试均有回归。既有 materializer 调用继续原发布路径，迁移通过可选发布回调取得原发布身份。文件系统不支持 link 时采用独占创建的文件句柄写入、同步和恢复模式；模拟分支通过不等于 Windows 实机验收。
- BizOP 4097 条规模夹具以一次真实 ACTIVE IPC 导出为模板，使用 SQL 合成旧 CLOSED 历史 owner／publication；不是执行 4097 次真实导出。历史每次 64 条并持续显示可见续跑入口，65 页全部补齐且原业务事实不变。另行验证 4097 条真正未决任务仍命中原清单上限，未以分页截断真实恢复责任。
- 跨进程夹具在第 10 批 completion 写入后、游标提交前退出，重开 SQLite 只保留前 9 批；继续沿同一实例游标完成剩余历史。completion、诊断和游标保持单批事务；原 outbox、原未决 OPERATION 与 RECLAIM 身份完整检查，坏历史保留诊断但不饿死后续合法项，缺 proof 的批次继续拒绝删除。
- 界面在业务 ready 且历史待检查时提供“继续检查存档”，不阻止正常业务；发现真正未决时切回“重试恢复”并禁用业务。重复点击、未激活、旧状态兼容和 ready 转未决均由行为回归覆盖。

独立复核未发现本轮尚未修复的阻断问题，确认首次发布身份连续性、历史补齐事务与真正未决恢复仍符合原约束。

证据目录：`/private/tmp/archive-delete-fix7-evidence-f4024wee/`。完整门禁记录为 `final-release-check.log`、`final-release-check-result.json`、`final-frozen-code.json`，冻结 68 个代码文件；跨层集成为 `permanent-delete-integration.log`。聚焦结果与独立复核见 `migration-materializer-final2.log`、`migration-lifecycle-fixtures-final4.log`、`bizop-owner-focused-final2.log`、`bizop-history-fixture-first.log`、`renderer-recovery-focus.log` 和 `independent-review-summary.md`。

全部验证使用隔离临时文件、测试 SQLite 和故障注入。3 项 Windows 专项按平台条件跳过；未执行 Windows 实机文件占用、打包 GUI、Excel/WPS 或真实业务数据人工验收。保持 managed-only、外部原件、有效业务数据及金额／币种／匹配规则。

写回以修复前 64 个 tracked/untracked 文件及新增目标路径的原 SHA-256 为基线，检查目标没有并行变化，备份原文件后逐项核对与已通过门禁的副本一致。具体写回清单和结果保存在 `writeback-manifest.json`、`writeback-verification.json`。本轮未提交、推送、升版或发布。

## 第六轮 Review 修复验证（2026-09-12）

本节覆盖 BizOP 未提交失败导出补偿后的启动恢复，以及 Position streaming 异常报告的受管删除。以下历史轮次仅供追溯，不与本轮计数累加。最终完整门禁退出 0，58 个源码／测试／脚本文件的 SHA-256 在门禁后与冻结清单一致。

| 范围 | 本轮结果 |
| --- | --- |
| BizOP 原 owner 与既有导出恢复 | 47/47 PASS：28 项 owner 回归及 19 项既有 Main／终态恢复检查 |
| BizOP 真实恢复 fixture | 5/5 模式通过；包含两种新增未提交补偿模式的独立进程重启 |
| Position 报告证据与 interactive preflight | 18/18 PASS |
| Position FilePlan 删除 | 15/15 PASS；含真实报告现存、业务清理后重启、共享释放与旧 input V2 兼容 |
| 永久删除跨层集成 | 39/39 PASS；新增 4 项未提交补偿／异常报告场景 |
| lint / smoke | 最终完整 release-check 中通过 |
| 全量 unit | 7559 tests，7556 PASS、0 FAIL、3 skipped；约 309 秒 |
| 全量 integration | 54/54 脚本通过；2527 个已计数用例，约 302 秒；1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS；约 619 秒 |

- BizOP 修复前真实 IPC 回归失败；故障为未提交导出的第一次失败终态 SQLite 写入失败。新实现核对原 publication／binding、实例、完整 owner／manifest、abort／followup／closure digest 和回收任务授权，完成凭证与 phase／settlement 关闭同事务。凭证或关闭写入失败保留原责任；尚未完成的回收继续等待。正常 COMMITTED 协议及无 publication 的登记前失败分流保留。
- 两种新增真实 fixture 覆盖首次终态落库失败和旧 CLOSED／NOT_COMMITTED 缺 completion（包含旧 binding 缺新增字段），在独立进程重开原数据库后核对同一 owner／原业务凭证、outbox 清零和重复初始化，再实际永久删除。原外部输入和输出位置的替代文件保持原字节；不清除 pending 标记或绕过初始化门禁。
- Position 两个真实导入场景确实生成过滤行和异常报告，先验证活动业务引用阻止删除，再执行业务 `deleteSource`。报告现存分支按原身份清理；missing 分支执行真实 Main 来源清理后重开主库与 sideDB，再按原证据完成删除。
- 报告原 snapshot、摘要、大小及 producer 身份随首次 reserve 原子保存，覆盖 reserve／attempt／settle 中断窗口。反例覆盖同内容新 inode、错误 producer、旧记录无 marker、不完整原证据、缺库、错误 checkpoint 和损坏 schema；元数据已删除后的 job 重试遇新增历史引用或不可读 sideDB 仍保留原任务，合法释放后可重试。旧 input V2 无 direction／sourceKind 时继续原协议。
- 独立只读复核对冻结代码未发现新增 P1／P2 或阻断问题。当前 Main 的 Position run 在读取 active 过滤行到 `store.createRun` 冻结引用之间同步执行，生产路由没有 Position run Worker；因此未依赖不存在的全局业务互斥。报告引用查询覆盖活动过滤行与全部历史 run，不按历史状态过滤。

聚焦日志：`/private/tmp/archive-delete-fix6-bizop-before.log`、`/private/tmp/archive-delete-fix6-bizop-final.log`、`/private/tmp/archive-delete-fix6-bizop-fixture-final.log`、`/private/tmp/archive-fix6-position-report-focus.log`、`/private/tmp/archive-fix6-position-fileplan-focus.log`。本轮跨层集成、最终门禁日志、结构化结果与冻结清单位于 `/private/tmp/archive-delete-fix6-evidence-bp9wd60h/`（`permanent-delete-integration.log`、`final-release-check.log`、`final-release-check-result.json`、`final-frozen-code.json`）。

全部验证使用隔离临时文件、测试 SQLite 和故障注入。3 项 Windows 专项按平台条件跳过；未执行 Windows 实机文件占用、打包 GUI、Excel/WPS 或真实业务数据人工验收。保持 managed-only、外部原件、有效业务行及金额／币种／匹配规则。

写回依据修复前 60 个 tracked/untracked 文件与新增目标路径的原 SHA-256 状态进行冲突检查，保存原文件备份，并逐项核对与已通过门禁的隔离副本一致。具体写回清单与结果保存在上述证据目录的 `writeback-manifest.json`、`writeback-verification.json`。本轮未提交、推送、升版或发布。

## 第五轮 Review 修复验证（2026-09-12）

本节覆盖 BizOP v327 原发布 owner 收口、旧 CLOSED binding 恢复兼容、Position 正常 FilePlan 来源证据及共享 staging 删除。以下历史轮次仅供追溯，不与本轮计数累加。最终完整门禁退出 0，54 个源码／测试／脚本文件的 SHA-256 在门禁后与冻结清单一致。

| 范围 | 本轮结果 |
| --- | --- |
| FilePlan／Repository | 57/57 PASS；新增 4 项，旧实现为 1 PASS、3 FAIL |
| BizOP 原 owner | 10/10 新增回归 PASS；既有导入／导出／终态与启动恢复 35/35 PASS |
| Position 来源 | 30/30 PASS；新增 13 项，既有 resolver／preflight 17 项 |
| Position 真实 wrapper 与删除回归 | 42/42 PASS；执行成功、业务失败、归档延期分支，保持完整 manifest 单次 settle |
| 永久删除跨层集成 | 35/35 PASS；新增 6 项实际导入／IPC／跨进程恢复与删除场景 |
| lint / smoke | 最终完整 release-check 中通过 |
| 全量 unit | 474 个测试文件；7529 tests，7526 PASS、0 FAIL、3 skipped；约 360 秒 |
| 全量 integration | 54/54 脚本通过；2523 个已计数用例，约 490 秒；1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS；约 859 秒 |

- BizOP 使用真实当前 RELEASE_GATES、ACTIVE 升级、正式 IPC handler、Worker／Publisher、Main 同款 RuntimeDelegate、TaskLifecycle 和持久 outbox；旧实现的 ACK 暂时失败场景在 owner completion 断言失败。新回归验证 ACK 失败恢复、completion 写失败及关闭事务写失败的回滚/重试、原身份/实例/manifest/route 冲突。
- 跨进程场景在 ACK／cleanup 已完成、completion 与 phase 关闭的事务尚未提交时真实退出进程；重开原数据库后核验 owner、输出提交事实、原件和外部输出哈希不变，outbox 清零，重复初始化通过，再执行实际永久删除。旧 binding 缺新增字段且 phase 已 CLOSED 的记录也经原 publication 事实验证恢复。Task 的可压缩非必要 metadata 沿既有删除契约，不要求其删除后仍保留。
- Position 使用真实默认／streaming 来源预检与执行、账户确认、TaskLifecycle、SQLite 和 Controller。归档开始前就能读到源 snapshot/SHA/size；复制 attempt 写入失败、settle 前中断与 SQLite 重开均保留原证据。集成覆盖共享来源先保留后清理、正常清理后逆序删除和默认路径重启，检查存活批次可读、外部原件字节和有效业务行不变。
- Position 反例覆盖同内容新 inode、原摘要冲突、旧实例／错 owner／缺 completion／运行中 Task、活动账户确认 token 和持久清理计划遇新增引用。共享分流先核验原对象，再决定不删除共享 source；未知、历史缺证或替代对象仍保留诊断。
- 独立窄范围复核确认：FilePlan identity 不变、reserve 同事务与 existing 不回填；BizOP completion 先于原责任关闭、已关闭缺 proof 的原记录可重新枚举；实际 Main schema 初始化顺序早于新增恢复 SQL。复核发现的 RuntimeDelegate 属性使用问题已在冻结前修正，并纳入真实代理夹具。

首轮完整门禁在全量 unit 中发现 1 项旧静态断言仍要求 Main 内联展开 inputs/outputs，7525 PASS／1 FAIL／3 SKIP；因此尚未进入 integration。已将该用例改为执行真实 wrapper 的成功、业务失败和归档延期分支，核验完整 manifest 及输入摘要恰好 settle 一次、清理仅在 durable 后执行；相关 42/42 PASS。首次日志保留为 `/private/tmp/archive-delete-fix5-release-check-attempt1.log`，更新冻结清单后重新从头执行完整门禁，最终全量通过。

聚焦日志：`/private/tmp/archive-fix5-source-evidence-before.log`、`/private/tmp/archive-fix5-source-evidence-after.log`、`/private/tmp/archive-delete-fix5-position-unit.log`、`/private/tmp/archive-delete-fix5-position-wrapper.log`。最终门禁日志：`/private/tmp/archive-delete-fix5-release-check.log`；结构化结果：`/private/tmp/archive-delete-fix5-release-check-result.json`；冻结清单：`/private/tmp/archive-delete-fix5-verified-code.json`。

所有输入、输出、SQLite 和故障注入均在隔离临时目录；未操作用户业务数据库，未执行 Windows 文件占用、打包 GUI、Excel/WPS 或真实业务人工验收。没有修改金额、币种、匹配、业务主键或外部源文件授权。

写回以修复前 45 个 tracked/untracked 改动和新增目标路径的原状态为基线，最终清单为 23 个文件（10 个源码、9 个测试／脚本、3 个说明文档及 runner 自动更新的集成清单）。原文件备份位于 `/private/tmp/archive-delete-before-fix5-kl215t5j`；写回逐项验证与已通过门禁的隔离副本一致，并保留其余原改动。没有提交、推送、升版或发布。

## 第四轮 Review 修复验证（2026-09-12）

本节覆盖普通 File Task 崩溃收口、原任务显式恢复和同 SHA 重新发布后的旧硬链接遗留重试。以下历史轮次仅供追溯，不与本轮计数累加。最终源码已经冻结，完整门禁通过；门禁后重新核验 39 个源码／测试／脚本文件 SHA-256 与冻结清单一致。

| 范围 | 本轮结果 |
| --- | --- |
| 新 owner／Acquiring／run-data-store 三组 | 84/84 PASS；含 40 项新 owner 回归和 1 项新增严格目录枚举回归 |
| 原 owner／生命周期／Controller／Repository 四组 | 180/180 PASS |
| 永久删除单测 | 59/59 PASS；含 16 项新硬链接回归 |
| 永久删除跨层集成 | 29/29 PASS；含 6 项新跨进程／真实文件场景 |
| lint / smoke | 完整 release-check 中通过 |
| 全量 unit | 472 个测试文件；7502 tests，7499 PASS、0 FAIL、3 skipped；约 275 秒 |
| 全量 integration | 54/54 脚本通过，2517 个已计数用例；约 483 秒；1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS |

- 真实进程退出覆盖普通 `template:import` 运行中、终态已提交但 completion 尚未记录，以及新责任 INSERT 执行后 reserve 事务尚未提交。普通任务恢复后再次关闭／重开 SQLite，核对原 Task／batch／artifact 身份及完成凭证稳定，业务不重复执行；两条路径分别通过实际 retention 和 Controller 确认令牌删除。未提交创建事务完整回滚，业务 execute 未触发。
- eager／deferred 同时覆盖责任创建失败、completion 写入后责任清除失败及恢复幂等；带路由或匿名 afterTerminal 的任务不能被通用责任误认领，历史缺证明的批次不补造身份。
- Acquiring 的原 owner 显式恢复核验凭证来源、exact owner、manifest 与合法中断状态；责任重建、旧 interrupted 凭证撤销及 Task／batch 重开在同一事务提交。错来源、路由、实例、身份或 manifest 继续拒绝；失败整体回滚，正常成功后以同一 owner 保存新终态凭证。
- Acquiring 侧库／目录／JSON／batch context 不可验证时阻止 sweep、预检和 retention。覆盖 running、终态已提交以及已经拥有 interrupted completion 三种状态；最后一组确认保护本身确实阻止删除，不由缺凭证门禁掩盖问题。证据恢复可读后原任务继续受其恢复记录保护；正式无 archive context 的历史行兼容保留。
- 硬链接场景先复现目录目标 EBUSY／EACCES、原 Blob unlink 后合法新批次同 SHA 发布，再验证直接重试和重启重试。负例覆盖无引用、指纹缺失／不符、原 inode 再出现、父目录替换、内容变化、额外链接变化，以及未持久／伪造／非 unlink 进度；B 的原文件、持久身份和读取能力均保留。

修复前对照：硬链接首批 14 项为 10 PASS／4 FAIL，4 项失败均为已确认缺陷；普通任务真实崩溃后反复重启仍无 completion。新增集成同一组夹具重定向旧源码为 1 PASS／5 FAIL，其中 4 项原问题正向均失败，匿名反例通过，新增责任事务退出点因旧实现不存在而未命中。Acquiring 严格保护对照为 47 PASS／9 FAIL，8 个 Controller 异常场景与 1 个目录读取异常场景均在旧实现失败。

独立复核已核对最终持久协议、合法原 owner 恢复、异常传播及新旧 Blob 身份边界，没有剩余已确认缺陷。金额、币种、匹配、导出列和外部原文件授权未改变；未对用户业务数据库或真实归档执行试删。

完整门禁日志：`/private/tmp/archive-delete-fix4-release-check.log`；结构化结果：`/private/tmp/archive-delete-fix4-release-check-result.json`；源码冻结清单：`/private/tmp/archive-delete-fix4-verified-code.json`。聚焦证据：`/private/tmp/archive-fix4-owner-acquiring-final.log`、`/private/tmp/archive-fix4-owner-related-final.log`、`/private/tmp/archive-fix4-owner-crash-final.log`、`/private/tmp/archive-fix4-hardlink-focused.log`、`/private/tmp/archive-delete-fix4-integration-after.log`。修复前对照：`/private/tmp/archive-fix4-owner-crash-before.log`、`/private/tmp/archive-fix4-acquiring-guard-before.log`、`/private/tmp/archive-fix4-hardlink-before.log`、`/private/tmp/archive-delete-fix4-integration-before.log`。

写回按目标分支原有 39 个 tracked/untracked 文件的 SHA-256 基线保护已有成果；仅传回本轮源码、回归、说明和门禁自动更新的集成清单。写前备份，写后核对最终内容、未修改基线文件、分支及 HEAD；不提交、推送、升版或发布。

Windows 实机文件占用、打包 GUI、Excel/WPS 和真实业务数据人工验收未执行。3 项 Windows 专用自动测试在当前 macOS 按条件跳过；自动验证不能替代这些平台与业务验收。

## 第三轮 Review 修复后的验证（2026-09-12）

本节记录迁移残留对象身份和删除弹窗生命周期两项修复；后面的记录仅作历史证据，不与本轮计数累加。全部测试针对隔离副本的最终冻结源码。完整门禁已通过 lint、smoke、全量 unit 和 integration。

| 范围 | 本轮结果 |
| --- | --- |
| 迁移单测 | 73/73 PASS |
| Service / storage-layout / permanent-delete 单测 | 122/122 PASS |
| Renderer 生命周期及 UI contract | 40/40 PASS |
| 永久删除跨层集成 | 23/23 PASS |
| lint / smoke | 完整 release-check 中通过 |
| 全量 unit | 471 个测试文件；7445 tests，7442 PASS、0 FAIL、3 skipped；约 299 秒 |
| 全量 integration | 54/54 脚本通过，2511 个已计数用例；约 280 秒；1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS |

- Renderer 真实函数的受控异步回归 13/13 PASS，与原有 UI contract 合跑共 40/40 PASS；同一组 13 项在旧源码为 2 PASS、11 FAIL。覆盖关闭后迟到成功／失败、连续预检乱序、替换弹窗、取消微任务、重复确认、删除结果及刷新期间关闭。
- 永久删除跨层集成由 14 项扩为 23 项，当前 23/23 PASS。新增 9 项用真实 TaskLifecycle、Controller、Service、Manager、SQLite 和迁移发布构造重启恢复；旧源码同组场景为 2 PASS、7 FAIL。
- 新增迁移集成覆盖：正常 copy/publish → source 清理 EACCES → 重启恢复；同 SHA 或不同内容的新 inode；旧 journal 与 V1/V2 job 的组合；现存缺证保留与 V2 原计划下安全缺失幂等。所有保护场景检查两根文件 inode/SHA、原 job/migration ID、明确错误码、receipt 缺失及重试不得 fullyDeleted。
- 迁移单测 73/73 PASS（原 56 项，本轮新增 17 项）；Service、storage-layout 与 permanent-delete 相关单测 122/122 PASS。覆盖切换前后原身份、两根清理前资格核验、部分硬链接 unlink、已有发布目标恢复时避免重复 chmod、journal 写失败、正常读取／重试／后台／缺失目标与损坏 journal 的 mutation guard。
- 独立复核补充迁移中断后的合法历史硬链接读取：读取成功并返回 canonical fallback + repairPending，原 source inode 不变，重启迁移完成；外部同 SHA 新 inode 仍以 FILE_CHANGED 拒绝。迁移结束后缺失目录副本的正常修复恢复。
- 旧 pre-switch journal 连 sourceCleanupPaths 都缺失时，仅用当前 DB 路径列出待核验对象，不从 stat 创建历史身份；回归确认现存缺证对象、原 journal 保留，map 不被生成。补齐此最后边界前主动中止了一次完整门禁（退出 130）；该中止运行不计入最终结果，重新冻结后从头运行。

UI 相关文件通过 `node --check`。项目 eslint 配置忽略 renderer 文件，因此不将项目 lint 结果表述为 renderer 静态检查结果。

日志：`/private/tmp/archive-fix3-ui-final.log`、`/private/tmp/archive-fix3-ui-before-final.log`、`/private/tmp/archive-delete-fix3-integration-after.log`、`/private/tmp/archive-delete-fix3-migration-integration-before-final.log`、`/private/tmp/archive-fix3-migration-final.log`、`/private/tmp/archive-fix3-service-final.log`、`/private/tmp/archive-fix3-legacy-inventory-before.log`。

最终完整门禁日志：`/private/tmp/archive-delete-fix3-release-check.log`；结构化结果及日志 SHA-256：`/private/tmp/archive-delete-fix3-release-check-result.json`。集成清单仅由 runner 自动更新第七节，未调整测试策略。

未使用用户业务文件或真实业务数据库试删；未进行 Windows 实机文件占用、打包 GUI、Excel/WPS 或真实业务数据验收。3 项 Windows 专用测试按平台条件跳过。旧任务缺原身份时保留文件、job 与 journal 的诊断，不报告永久删除完成。

写回前以原 37 个 tracked/untracked 文件的 SHA-256 校验目标 worktree 未被并行改动，另冻结 33 个源码／测试／脚本文件的完整集合与内容。本轮写回清单为 11 个文件（10 个修复／测试／说明文件，加 runner 自动更新的集成清单），先保留原文件备份，再逐文件验证目标与已测试副本一致。实际结果以最终 repair manifest 和 writeback-verification.json 为准；不提交、推送、升版或发布。

## 再次 Review 修复后的验证（2026-09-11）

此节记录再次 review 的 4 项问题及共享调用方修复；后面的首轮记录仅作历史证据，不与本轮计数累加。全部测试针对隔离副本的最终源码。

| 范围 | 本轮结果 |
| --- | --- |
| 发布恢复相关单测 | 8 个文件，251/251 PASS |
| 存储身份相关单测 | 3 个文件，138/138 PASS；permanent-delete 文件由 30 增至 43 项 |
| 永久删除跨层集成 | 14/14 PASS；包含真实 Main ACK、TaskLifecycle、Controller、Publisher、SQLite 与跨进程退出／重启 |
| lint / smoke | 完整 release-check 中通过 |
| 全量 unit | 470 个测试文件；7415 tests，7412 PASS、0 FAIL、3 skipped；约 295 秒 |
| 全量 integration | 54/54 脚本通过，2502 个已计数用例；约 474 秒；其中 1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS |

修复前对照使用同一组回归和旧源码，VCC outbox 阻断启动、Toolbox 正常 ACK 在 completion 前退出、硬链接读取、硬链接维护、历史 Blob 替代 inode 这 5 个集成场景分别退出 1；修复后全部通过。存储侧初始 6 个针对性用例在旧实现为 4 FAIL、2 PASS。

新增回归还覆盖：共享 ACK 的 12 个精确 moduleId/taskKey 入口；原持久业务路由不被无路由凭证覆盖；正常脱钩前 CAS 冲突、unlink 后指纹事务失败及重启维护；共享引用不同分页顺序；同 SHA 新引用对象保留；历史 NULL 指纹的现存拒绝与安全缺失幂等。Toolbox 进程在写 completion 前真实退出 77，下一进程恢复后 outbox 清空，正式输出的 inode、mtime、size、SHA 均不变。

独立只读交叉复核未发现新的可复现正确性缺陷；额外组合探针验证 A unlink 后进度中断 → 新 C 导入同 SHA／同 inode → A 重放 → B 脱钩 → B/C 删除全部完成。该探针不计入正式单测／集成计数。

日志：`/private/tmp/archive-delete-fix2-release-check.log`、`/private/tmp/archive-owner-fix2-focused.log`、`/private/tmp/archive-delete-fix2-storage-after.log`、`/private/tmp/archive-fix2-integration-final.log`、`/private/tmp/archive-storage-independent-crossprobe.log`。修复前集成对照为 `/private/tmp/archive-fix2-integration-old-{vcc,toolbox,hardlink-read,hardlink-maintenance,legacy-blob}.log`。

Windows 专项 3 项仍是实际 PowerShell snapshot/token 清理及两个 packaged canary 场景。未进行 Windows 实机文件占用、打包 GUI、Excel/WPS 或真实业务数据验收。历史缺原对象身份的现存文件继续明确拒绝；不通过补造身份或删除 pending 记录消除诊断。

写回采用原 36 个 tracked/untracked 文件的 SHA-256 基线校验；本轮写回 13 个文件（12 个修复／回归／说明文件，加完整门禁自动更新的集成清单），保留原文件备份，逐项核对目标内容与已验证副本一致。未提交、推送、升版或发布。

## 首轮 Review 修复后的验证（2026-09-11）

此节记录用户授权修复首轮 5 项 review 问题之后的内容；后续以顶部再次 Review 的验证为准。

| 范围 | 本轮结果 |
| --- | --- |
| lint / smoke | 完整 release-check 中通过 |
| 全量 unit | 470 个测试文件；7390 tests，7387 PASS、0 FAIL、3 skipped；约 331 秒 |
| Windows 专项跳过 | 真实 PowerShell snapshot/token 清理、两个 packaged canary 场景；当前 macOS 按平台条件跳过 |
| 永久删除跨层集成 | 8/8 PASS；使用真实 TaskLifecycle、Controller、SQLite 与受管文件 |
| 全量 integration | 54/54 脚本通过，2496 个已计数用例；约 465 秒；其中 1 个脚本未输出断言计数，退出码为 0 |
| 完整 release-check | `UNIT_TEST_CONCURRENCY=4 npm run release-check`：退出码 0，PASS |

已补回归先复现缺陷，再验证修复：未知预分配路径保留；eager/deferred 匿名后处理待完成；工具箱真实 receipt 的 cleanup/proof/finalizing 崩溃窗口；维护自持有与伪造令牌；单计划/共享/跨计划硬链接及指纹事务失败。其他模块后处理不由工具箱恢复流程推断完成；月末副本恢复保持原 Task/批次号和目标数据，仅补足真实收口凭证。

本轮未使用用户业务文件或真实业务数据库，未进行 Windows 实机、打包 GUI 或 Excel/WPS 人工验收。完整门禁日志：`/private/tmp/archive-delete-fix-release-check.log`；永久删除集成日志：`/private/tmp/archive-delete-fix-integration-final.log`。

源码及测试在隔离副本执行完整门禁，写回前核验目标 worktree 原始 SHA-256 并保留原有未提交文件备份，写回后逐文件校验与已验证内容一致。

## 初始实现验证（Review 修复前）

| 范围 | 证据与结果 |
| --- | --- |
| Repository / Service / Controller / 生命周期 / 迁移 / UI / Position 来源 / IPC policy | 10 个相关测试文件合跑，344/344 PASS；日志 `logs/verification/archive-permanent-delete-focused.log` |
| 永久删除文件/状态故障补充 | 13/13 PASS，包含最终增加的 legacy 缺失目标并发完成身份；日志 `logs/verification/archive-permanent-delete-files.log` |
| 跨层实际文件集成 | `node scripts/integration/archive-center-permanent-delete.js`：4/4 PASS |
| lint | `npm run lint`：PASS |
| smoke | `npm run smoke`：PASS |
| 全部集成脚本 | `npm run test:integration`：54/54 脚本 PASS；2492 个已计数用例；其中 1 个脚本未输出断言计数，但 exit 0 |
| 全量 unit | 首轮 7347 tests：7337 PASS、7 FAIL、3 skipped（约 608 秒）；5 个迁移旧夹具与 2 个 IPC inventory 失败均已修复，最终相关回归 344/344 PASS；没有重跑整套 unit，不标全量 PASS |

## 适用验收覆盖

- 统一模块删除及固定确认文案、只读预检取消、跨窗口确认拒绝：UI/Controller contract 与集成脚本。
- 实际输入/输出存档、独占 Blob、共享 Blob、readonly、外部原件与 save-as：Service 真实文件测试和集成脚本。
- active/locked/business hold/recovery/终态 owner/迁移 journal：Repository、Service、Controller 与迁移测试。
- busy/权限类失败、同路径替换、根离线、安全缺失、symlink/父目录替换、事务与进度提交失败、并发重试：永久删除文件测试与 Position 来源测试。
- 原任务完成证明、迟到 outbox、重启 ACK 与匿名未完成后处理：真实 TaskLifecycle、owner completion 与集成脚本。
- 迁移两端及历史等待顺序：完整 V2 身份夹具覆盖 waiting → done → receipt 的崩溃点；V1 无旧身份保留任务和两根文件。
- 模块受管暂存：真实 `stageInputFiles`、持久 artifact metadata、根/父链/SHA/快照与其他批次引用验证；删除和重试均核实保护清单。

## 保留的验收边界

- 未进行 Windows 实机文件占用、权限变化、打包运行或实际 GUI 人工操作验收。
- 不承诺操作系统外部进程并发替换的跨平台原子 inode 删除或磁盘取证级擦除。
- 无旧对象身份的 V1 现存清理目标、缺原 owner 收口凭证的现代历史 FileTask、无可执行路由的未完成匿名后处理均明确保留诊断，不报告永久删除完成。
- 不把专项 PASS、单测首轮已修复的失败或应用层删除结果称为发布门禁 PASS。未提交、未推送、未升版或发布。
