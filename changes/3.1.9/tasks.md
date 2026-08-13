# v3.1.9 Tasks

> 本文件按确认 Spec §14 的严格串行顺序维护。PR1—PR7、独立 review 修复、合并、annotated tag、Windows Release workflow、稳定 Release 与公开资产回读已经完成。PR2 GUI/资金人工、Windows/真实大库/生产库/Excel-WPS 等人工验证仍未完成，不由技术 Release 替代。

## PR1 — 批次身份与数据库迁移

- [x] 锁定 `origin/main@63c1ce46357587643e506768f712352cbb6c7127` 与 v3.1.8 基线。
- [x] 原样归档确认 Spec，记录 C01—C14。
- [x] 完成 unknowns-first preflight 与 v1 archive 回归基线。
- [x] 新增 `archive_daily_sequences`，按历史 `archive_batch_sequences` 游标之和幂等 seed。
- [x] 为 `archive_batches` 增加 v2/task/parent 字段与索引，历史 v1 不重编号、不猜 parent。
- [x] 为 `archive_artifacts` 增加 layout 预留字段，不实现目录物化。
- [x] 实现原子 `reserveTaskBatch`、全局本地日流水、operation key 幂等与失败回滚。
- [x] 实现真实 latest issuance 只读查询，删除最后批次后不倒退、不复用；v1 游标推进不伪装 v2 发行。
- [x] 实现 task 状态 CAS、DTO 映射、`parentRunId` 关联批次查询基础。
- [x] 实现持久 flow anchor repository/service 薄接口、幂等绑定与 module/parent 血缘拒绝。
- [x] 保持 v1 `createBatch` / ArchiveService / Controller 行为兼容。
- [x] 完成 Spec §15.1 PR1 核心矩阵和 archive 单元回归。
- [x] 完成 blindspot/reconciliation 复核并记录证据。

## PR2 — 任务生命周期与策略注册表

- [x] 建立 prepare / execute 两阶段 handler 契约；picker、纯校验和危险确认在预留前完成。
- [x] 建立 `TaskLifecycle`，固定 `BOR.begin → reserve → started → ALS execute → append → terminal CAS → BOR.end` 顺序。
- [x] 预留失败不执行业务；业务失败/取消保留批次；存档失败不覆盖业务成功结果。
- [x] 建立精确 `TaskPolicyRegistry`、裸 IPC inventory 与无 wildcard 的 coverage 契约。
- [x] 按 2026-08-12 用户裁决将 `bank-statement:run`、`template:save-mappings` 收窄为 `no-archive-artifact`：业务仍受退出/升级闸门保护，但不预留批次号；银行对账保留每轮随机稳定身份，每次真实导出各建一个含输出 artifact 的可见批次并续接该轮 parent。
- [x] 建立 `BusinessFlowResolver`，只使用显式 parent 或持久业务 identity；禁止月份、hash、renderer state fallback。
- [x] 建立可序列化、只读 worker batch context；worker 只继承父 action，不自行分配批次。
- [x] 将 operation tracker 收敛为无活动批次内存的文件 resolver / append adapter；禁止成功后建批或 find-latest。
- [x] 建立 12 个现有 archive primary scope 的 `module-scope-registry`，内部 alias 与可见 scope 分离。
- [x] 接入现有 12 个 archive scope，不改业务算法、导入事务、worker 恢复点和导出内容。
- [x] 完成 Spec §15.2/§15.3 的 PR2 可承担自动化、`release-check` 与 `check-vars` 关联 review。
- [ ] 完成 PR2 P0/P1 GUI、真实崩溃/重启与资金结果人工验收；自动门禁通过后等待用户测试。

## PR2.5-0 — Spec / TechDoc 合同冻结

- [x] 在独立 erratum 目录归档纠错 Spec v2、TechDoc v1.1 和 provenance 索引，不修改 v3.1.8 冻结 Spec；2026-08-13 按用户新合同将仓库副本增量修订为 v2.1/v1.2，历史原始 SHA 继续留 provenance。
- [x] 记录 raw/repository 双 SHA 与 12 处 Markdown hard-break 等价格式 normalization。
- [x] 为 v3.1.9 增加只覆盖 VCC 归档兼容、操作保护和性能路径的窄 erratum。
- [x] 冻结严格顺序 `PR2 → PR2.5-0 → PR2.5-A → PR2.5-B → PR2.5-C1 → PR2.5-C2 → PR3-VCC → PR3-Toolbox → PR4 → PR5 → PR6 → PR7`。
- [x] 增量维护 Unknowns Register、决定、计划验收矩阵和发布门禁，不覆盖 PR1/PR2 证据。
- [x] 完成 source normalization、hash/link、Markdown diff 和冻结 release-docs targeted 验证；完整 `release-check` 未在本 docs-only PR 重跑。

## 后续 PR（当前分支不实施，全部串行）

- [x] PR2.5-A：ArchiveEvidenceV2、生效结果纯校验器、classifier/gate 与真实 v3.1.7 fixture；实现与本地自动门禁完成。
  - [x] Phase 0：在系统临时目录跑通真实 tag migration/import/opening/calculate/archive/current migration 链，核对依赖与 legacy-four shape；仓库零文件改动。
  - [x] Phase 1：实现四个纯合同模块、真实 fixture/manifest、10 个 top-level 聚焦测试与管理文档证据；完整 `release-check` 全绿。
  - [ ] 发布人工/真实环境门禁：目标生产 legacy-four/trigger、主体×九币种与跨月资金结果、Windows packaged runtime、约 16 GB 性能；自动测试不替代。
- [x] PR2.5-B：read worker、集合化 evidence、token v2、活动月份/删除目标和读取性能的本地实现与自动证据。
  - [x] 独立 read-only worker、schema-ready、BEGIN DEFERRED、action allowlist 与 Main generation/active identity 复核。
  - [x] current/真实 legacy 集合枚举、v2 canonical token、0/1/100 常数 SQL、active visibility 与结构化 inconsistent 诊断。
  - [x] 一次 DeleteEvidenceV2、renderer shell/loading/skeleton/inline retry、target preview cache 与 refresh-once。
  - [x] 初次/导出租约内二次 legacy recheck、生产 v2→旧 v1 write 单链 fail-closed，以及旧 v1 实现证据显式隔离。
  - [x] SQL trace、query-plan、main lag、target cache 与小 fixture gross regression 自动门禁；blindspot/reconciliation/check-vars 已复核，完整 release-check 全绿。
  - [ ] 发布人工/真实环境门禁：约 16 GB Windows packaged 冷/热 P95/WAL、目标生产 legacy/trigger、主体×九币种与跨月资金复核。
- [x] PR2.5-C1：mutation guard、adjustment/archive 固定预算与写 worker的本地实现和自动证据。
  - [x] 19 表 policy、七个 SQL step registry、小表 empty-session 与四张大表 largeTableScopeProof。
  - [x] adjustment=`2`、archive=`N+7`、audit-only=`1` 的锁内 plan、逐 step/total budget 与精确 postcondition。
  - [x] dedicated write worker、generation-bound claim、critical progress/cancel/terminate/单次 release 合同。
  - [x] `run:get` action token v2、同事务同源重算、legacy calculated plan 前 `result-recalculation-required`/零 DML。
  - [x] production adjustment/archive 唯一 worker 接线、renderer token/generation/progress/refetch/legacy 提示与本机小 fixture 性能证据。
  - [x] safe audit-only、unsafe trigger/runtime/schema/session 零数据库 audit、故障注入和生产 Service current 全链聚焦。
  - [x] 机械迁移两条真实 integration 入口并完成最终门禁：lint/smoke、unit 4972/4972、integration 48/48 scripts 与 2372/2372 assertions 全绿。
  - [ ] 发布人工/真实环境门禁：约 16 GB Windows packaged P95/WAL/main lag、目标生产 legacy/trigger、主体×九币种与跨月资金复核。
- [x] PR2.5-C2：current/legacy unarchive、delete 固定计划、进度/取消的本地实现与自动证据完成；约 16 GB 和人工验收仍列于下方未完成项。
  - [x] 复用 C1 单一 policy/registry/guard/claim/dedicated worker；锁内重算 B v2 token，generic destructive route 移除。
  - [x] current `N+7` / 真实 legacy-four `N+6` 解归档，保留 tail/active/unresolved gate 与 Pending 非创建合同。
  - [x] result/opening 五 child 独立 step 及 `1+R+ΣC(+O)` 预算，`first_month` 只读。
  - [x] detail/system 物化、清 FK、删事实/dataset、作废 run children、deletion/success audit 与固定公式；M>0、D=0/1 exact。
  - [x] safe/unsafe failure、单一中途 fault、large-table 非目标保留、七字段 context、progress 订阅/退订和真实 detail/system production integration。
  - [x] 本地扩大聚焦 195/195、destructive integration 77/77；blindspot/reconciliation 已复核且资金红线未由自动测试关闭。
  - [x] historical integration 机械迁移到真实 v2 Service preview/write/refetch；最终单一 `release-check`：lint/smoke、unit 4984/4984、integration 48/48 scripts 与 2385/2385 assertions 全绿。
  - [ ] 发布人工/真实环境门禁：约 16 GB Windows packaged P50/P95/WAL/main lag、`UPDATE ... FROM`/session runtime、目标生产 legacy/trigger、主体×九币种/跨月/审计/备份恢复财务复核。
- [x] PR3-VCC：VCC TaskLifecycle、七字段 context、BOR/cancel/terminal CAS 和 artifact 接线。
  - [x] 独立 VCCFINOP primary scope、11 reserve/15 exclude、stable run/import/record identity 与三类导出 prepare 已接线；既有 VCCOP/toolbox 不变。
  - [x] generic/dedicated worker required exact7、pre-critical/protected cancel、terminal CAS 和 artifact/terminal outbox 原批次代表测试完成。
  - [x] 扩大聚焦 unit 460/460、四条 VCC integration 334/334、lint/node/diff PASS；check-vars 仅 Runtime-state review 命中；最终唯一 full 为 unit 4990/4990、integration 48/48 scripts 与 2385/2385 assertions 全绿。
  - [ ] 用户 P0/P1 GUI、Windows/16 GB/production legacy-trigger 与主体×九币种/跨月/审计/导出资金人工验收。
- [x] PR3-Toolbox：工具箱独立生命周期与文件存档接线的本地实现与自动证据。
  - [x] 新增唯一 toolbox utility scope；保持 13 primary 和主模块启用/切换菜单不变；三通道 literal policy 精确闭合。
  - [x] merge/split export 全部 dialog 移入 prepare；split read 单一 token/stat context 与 reserve 后 freshness fail-closed 已接线。
  - [x] normal/large/multi/publication 共用原 TaskLifecycle batch/parent/exact7 context；真实输入和全部最终输出由唯一 tracker 登记。
  - [x] 聚焦 unit、roundtrip、large-file、large-split 与 multi-sheet 回归通过；blindspot/reconciliation 已复核。
  - [x] 最终唯一一次 `release-check` 全绿：lint/smoke、unit 4999/4999、integration 48/48 scripts 与 2385/2385 assertions；runner policy 合法自动同步。
  - [ ] 用户 P0/P1 GUI、Windows installer/portable、Excel/WPS、约16GB/700万行与真实文件/sheet/行数/资金输出血缘人工验收。
- [x] PR4：年/月/日/批次目录、独立 copy/历史 hardlink 脱钩、repair/cleanup 的本地实现与自动证据。
  - [x] layout v2 精确按 `local_date/batchNumber` 物化；Windows-safe 稳定命名、历史 order 回填、无 ready 无空业务目录。
  - [x] canonical Blob 保持唯一真相；materialized 始终流式 copy、size/hash/只读、copy repair、同 Blob 多批次隔离与历史 hardlink 脱钩已闭合。
  - [x] ready 与 repair-pending 正交证据、layout-first read/Blob fallback、历史启动续跑与内部路径不出 DTO 已接线。
  - [x] manual/retention/startup 共用单一 cleanup job executor；共享 Blob last-ref、目录失败续跑与空年月日回收已覆盖。
  - [x] PR4 核心 57/57、扩大 Archive 184/184、lint/node/diff/check-vars 通过；blindspot/reconciliation 红线未由自动测试关闭。
  - [x] 发布前唯一一次 `release-check` 首次全绿：lint/smoke、unit 5013/5013、integration 48/48 scripts 与 2385/2385 assertions；runner policy 合法自动同步。
  - [ ] Windows installer/portable、真实跨卷/网络盘/长根路径、Excel/WPS、真实大文件和输入输出血缘人工验收。
- [x] PR5：存储地址、marker、journal、迁移与恢复的本地实现与聚焦自动证据。
  - [x] 稳定 `archive_center_instance_id`、严格 `.archive-root.json`、legacy 全集/hash bootstrap 与未知/冲突根拒绝已闭合。
  - [x] `prepared → copying → materializing-layout → verifying → switched → cleanup-pending → done` journal、setting truth 与崩溃恢复已闭合。
  - [x] 只复制 canonical Blob、目标按 PR4 重建 layout、逐文件 size/SHA 校验和 root/containment/symlink/probe/capacity fail-closed 已闭合。
  - [x] root setting + 全部 ready `storage_mode` + 三列 materialization error 清理单事务提交；delegate 同步切换，旧根 cleanup 失败不回滚。
  - [x] Controller/TaskLifecycle/FlowResolver/Main 直接消费者共用稳定 delegate；maintenance 先关 admission、drain，再复用 PR4 root serialization。
  - [x] Repository/manager/Controller/UI 与 Archive/Position 相邻聚焦 185/185、smoke、lint/node/diff、设置布局 6/6 与 startup measure PASS；check-vars 命中已复核。
  - [x] 首次 full 的 exact policy/dialog wiring 漏项经批准最小修复，定向 55/55；第二次且最终 `release-check` lint/smoke、unit 5031/5031、integration 48/48 scripts 与 2385/2385 assertions 全绿，runner policy 合法自动同步。
  - [ ] Windows installer/portable、真实跨卷/网络盘/离线卷恢复、长路径、大存档进度/吞吐与退出/更新安装仍需人工验收。
- [x] PR6：统计、批次列表/详情、关联任务 UI、设置页与 latest-intent 的本地实现和自动证据。
  - [x] Controller 公开统计精确七字段；ready 引用总大小、未删除运行次数和不可回退 latest issuance/live status 已闭合，普通 UI 不读取内部 unique/logical/fileRef 统计。
  - [x] 设置页“版本管理”/“返回”、位置/变更、文件总大小、运行次数/最新批次与 PR5 迁移进度已接线；长路径保留 ellipsis+title。
  - [x] retention 使用单一串行 latest-intent；`60→90→180` 只调用 `[60,180]`，旧失败静默续排，最终失败恢复最近成功值，pending Return/X 受控且销毁后不写 DOM。
  - [x] 批次列表严格两行；详情使用 live structured relatedBatches 同日/跨日分组，点击只切 existing selectedBatchId；锁定、打开、另存为文字/图标及无障碍合同完成。
  - [x] 三张确定性 Electron 预览已人工复核；2 viewport×3 zoom、长文本、focus/aria/Tab 顺序、无页面横向溢出与 deferred 竞态 6/6 PASS；Archive 相邻聚焦 221/221 PASS。
  - [x] 首次 full 唯一旧 footer 文案正则经批准机械同步，最小组 29/29；第二次且最终 `release-check` lint/smoke、unit 5037/5037、integration 48/48 scripts 与 2385/2385 assertions 全绿，runner policy 仅在全绿后合法同步。
  - [x] reviewer P1：详情按真实 taskStatus 显示五态，列表/详情 archiveStatus 保持独立三态且 staging 为“处理中”；真实 fixture、UI static 24/24、Archive 邻接 222/222、Electron 6/6、两张 browser 预览视觉复核及唯一 full（unit 5047/5047、integration 48/48）通过。
  - [ ] Windows installer/portable 中文字体与原生 select、真实盘符/网络长路径、Excel/WPS 只读打开/另存、真实批次/关联/删除后 live rows 仍需用户人工验收。
- [x] PR7：版本号、发布文档、最终自动门禁、独立评审与正式技术发布。
  - [x] `package.json`、`package-lock.json` 顶层及根 package 三处版本精确更新为 `3.1.9`；无依赖变更；正式发布阶段另创建 annotated tag。
  - [x] `CHANGELOG.md`、`docs/USER_GUIDE.md`、`docs/VERSION_FEATURE_HISTORY.md` 先同步本地候选，正式发布后再反写发布状态；v3.1.8 正式发布历史保持不变。
  - [x] Spec/tasks/test-spec/implementation-notes/preflight 反向同步 PR1—PR6 本地实现与自动证据，状态保持待独立评审、用户人工、合并与正式发布。
  - [x] PR7 focused 版本/发布文档/Markdown/link/diff 检查；首次 5/6 的历史免责声明缺句已恢复，第二次 6/6 PASS，冻结 hash 与依赖图保持。
  - [x] 原 PR7 `release-check`、设置布局、存档预览与 release tooling P2 定向回归完成；important-vars 已改用 peeled v3.1.8 baseline 扫描并完成 v34 关联 review，旧 clean-worktree false-green 结论撤回。
  - [x] Windows 构建入口已增加 `build.files` packaged-input fail-closed，`check:dist` 已增加包内 build-info/source HEAD 一致性；旧 dirty/pre-commit 四资产证据撤回。
  - [x] review-fix 最终头在远端 CI 和 tag 发布 workflow 中完成 clean Windows installer+portable build、ASCII staging、`check:dist` 与包内 build-info/source HEAD 校验。
  - [x] 独立 review 及评论复核完成；PR #132—#145 按堆叠顺序合入，最终 PR #135 将 `main` 收口到 `3edf0527d6537d29cb19b48bda2a3f91f0ce6e32`。
  - [x] annotated tag `v3.1.9`、Release Windows Packages run `31710724423`、latest stable Release 和四项公开资产回读完成。
  - [ ] PR2 GUI/资金、Windows packaged runtime、目标生产 legacy/trigger、约 16 GB、约 700 万行、跨卷/网络盘、Excel/WPS 与真实文件/资金血缘人工验证。
- [x] 全迭代独立 review 26 项集中修复（基线 `6c431f4`，本地分支 `codex/v3.1.9-review-fixes`）。
  - [x] RF-01—RF-04：生命周期、terminal outbox、owner-first interrupted recovery、Acquiring/statement flow identity。
  - [x] RF-05—RF-11：VCC 警告/取消/进度、unsafe audit、opening diagnostic、partial import/export 血缘。
  - [x] RF-12—RF-15：Toolbox durable receipt、input alias、target freshness、output direction。
  - [x] RF-16—RF-18：启动 hash、UTF-16 路径预算、历史 materialization 全量续跑。
  - [x] RF-19—RF-26：active-root symlink、pre-switch read-only、source 可用性、冻结 cleanup inventory、offline/journal/blocked root/marker 恢复。
  - [x] focused 387/387、关键集成 209/209+77/77+30/30+17/17+16/16、lint/node/diff、VCC 三张 preview、check-vars、blindspot/reconciliation 与唯一 full（unit 5082/5082、integration 48/48/2385）全绿。
  - [x] 最终分支经 CI、合并后 tag workflow 的 clean Windows installer+portable build、ASCII staging 与 `check:dist`。
  - [ ] ⚠️ Windows/UNC/网络盘/真实 production legacy-trigger/16GB/700万行/Excel-WPS/资金与文件血缘人工复核。
  - [x] PR3-VCC final P1：exact7 `taskRunId` 固定 import batch；真实 worker 45,000 行 system XLSX 强杀后仅按本 batch 恢复 partial records，并把成功输入及 batch/record identities 交回原 archive parent。
  - [x] 最终独立 review RF-27—RF-29：普通 retry outbox 不再阻断 UI，committed owner receipt 仍 fail-closed；前台 metadata 扫描+修复共用 64 条预算；Toolbox recovery 必需模块纳入同一 Git ownership。

## VCC CNY 与异常数据过滤修订（2026-08-13）

- [x] 唯一九币种集合将 CNH 替换为 CNY；row mapper、新系统财务 OP 和 renderer/result 均按 CNY 合同。
- [x] 删除系统财务 OP 的 CNY→CNH 转换；新 CNH 作为异常单位拒绝/过滤，不静默改写。
- [x] 结果模板固定列改为 CNY，并更新/锁定模板 SHA、样式、named-range 和结果写回契约。
- [x] 明细异常按行过滤，正常行继续落 effective；系统财务 OP 异常按主体×九币种快照隔离，其他完整主体继续落库。
- [x] 保留 workbook/Sheet/header、取消、数据库错误和归档门禁等 hard failure 的整组失败关闭；补齐数量守恒和 UI 异常过滤摘要。
- [x] 历史小型派生事实幂等迁为 CNY；大表/raw_json 不批量改写，calculator/writer 在读取边界解释精确历史 CNH；CNY/CNH 冲突零部分提交。
- [x] 用户样本 `1433865288349124625_18.xlsx` 以正式 reader/importer 写入临时内存库：2026-07 共 300,000/300,000 accepted、异常 0；未改用户文件和生产数据库。
- [x] 开发自测完成：VCC 372/372；四条真实集成 19/19、209/209、77/77、29/29；lint、node check、diff check、smoke PASS。
- [x] 反写补遗 Spec v2.1、TechDoc v1.2、v3.1.9 Spec/test-spec/tasks/implementation-notes；保留 v3.1.8 冻结历史 Spec 不变。
- [ ] ⚠️ 用户/财务人工核对真实主体 CNY 九币种、混合异常文件去向、历史 CNH 月金额守恒、结果/归档/导出 Excel/WPS 及备份恢复。

## VCC 解归档、初始化状态与结果确认布局收口（2026-08-13）

- [x] 证明解归档置灰来自旧 CNH 派生归档被 CNY classifier 安全排除；保留 fail-closed，不放宽门禁。
- [x] 增加启动迁移回归：旧 CNH run/archive 迁为 CNY 后月份重新可枚举且 preview 可解归档。
- [x] VCC 财务 OP、平盘对账数据处理、对账单修复初始化成功时统一保持“欢迎使用小助手”，同时继续同步按钮/session 数据。
- [x] 结果确认页勾选区与横线增距；【修改结果】与右侧按钮同轴；九币种/调整值统计表头和单元格全部右对齐。
- [x] 定向 113/113、扩大 443/443、主页面 Electron 6/6 PASS；默认/150%/最小窗口三张结果 preview 人工通过。
- [ ] ⚠️ 重启开发应用执行真实 DB 启动迁移，并人工核对 2026-06 解归档月份、逐主体九币种金额与审计。
