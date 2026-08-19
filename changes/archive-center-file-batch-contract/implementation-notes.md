# Implementation Notes

## Baseline

- Goal/spec: `changes/archive-center-file-batch-contract/spec.md`
- Initial plan/technical contract: `changes/archive-center-file-batch-contract/techdoc.md`
- Product code baseline: `main@35f11e153962c34cba0e9d4c7084e9df85c9f209`（v3.1.10 release commit）。
- Implementation PR merge base: `main@6f1c09236a6c36f72eb82d61dc14508adfe20eec`（PR #149 release evidence；相对产品代码基线无 `src/` 变化）。
- Implementation merge/release commit: `main@782415ae1f606da2adebe881ba7ab56b1b045137`（PR #150）；annotated `v3.1.11` peeled 后精确指向该 commit。
- Earlier review evidence heads: `458e73f0f2861cacc0579a4bac20b45900bdb3b3`、`001b8059ced56b9d70602c79cdd97d375020c969`、`250b1349ff9be315111d4fe9999958cf63927a7c`、`01a6640dca1b6a02f6d05f20556e5994f9ef1855`、`5511a2ca7c2b33964b64d34ecf646f4655f26194`（历史复审快照，不覆盖）。
- Current review evidence head: `1df4004c53550bf75d9f73a2d544414b6f8c52b4`（2026-08-19 第十轮复审输入）。
- 发布证据使用从精确 merge commit 创建的隔离 worktree，不 rebase、不覆盖原工作树中的用户未跟踪文件。
- Done when: TechDoc §19、NFB-01～NFB-28、`npm run release-check`、`npm run check:vars`、真实 UI/数据库验收、文件与资金血缘、Windows 候选门禁及正式 Release 全部闭合。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 产品代码基线、PR merge base 与复审 head 分层记录 | Git 回读证明 `35f11e…` 是 v3.1.10 产品 release commit；`6f1c092…` 是只追加发布证据、规则和测试的 PR #149 merge，也是当前 PR merge base；最新评论审查 `458e73f…` | 把三者都称作“当前代码基线”，或把 2026-08-17 的本地追踪引用快照继续写成当前事实 | 远端产品事实按 `35f11e…`，PR diff 按 `6f1c092…`，复审结论固定到 `458e73f…`；不改变运行时行为 |
| Task Run 与 File Batch 解耦；只有非空 `ArtifactManifestV1` 可原子发号 | Spec §4～5、TechDoc §2～5；现状 121 个 reserve action 与 63 个 file action 不一致 | renderer 隐藏、先建空 batch 再补 artifact | no-file action 保留任务控制能力，但不建批次、不占号 |
| 初始 `filePlan v1` 与发号用 `ArtifactManifestV1` 是两个不可混用 DTO | deferred 初始计划允许为空，发号 manifest 永远非空；合并会迫使内部层增加例外 guard | 一个 DTO 同时承载空计划和非空 manifest | eager/deferred 的合法状态由合同表达，repository 不重复文件校验 |
| 公共查询新增 visible 方法，现有 repository 方法保持 raw/internal | storage rebuild、hold、recovery、repair 必须看到历史空批次 | 修改现有 raw 方法或仅在 renderer 过滤 | list/get/stats/latest/related 统一 SQL predicate，内部维护语义不变 |
| `017/018` 仅显式指纹 repair；`001` 只读保留 | 已确认现场证据及 NFB-17/NFB-21 | 按错误码泛删、补造 output 或改成功状态 | repair 默认 dry-run、事务 audit、二次执行 0 mutation |
| artifact settle 分开表达 `ok` 与 `durable` | 文件归档失败可以已经耐久记录为 `failed`；若只按 `ok` 判断，会把真实失败永久留在 outbox 反复重试 | 归档失败一律不写 Task Run 终态 | manifest row 全部进入 `ready/failed` 后允许业务终态落库；仅仍有 `pending`/元数据未落库时保留 outbox |
| 启动恢复严格由 controller 编排，service defer 初始化只建 schema/目录 | TechDoc §5.6；owner/outbox 未接管前执行 interrupted/storage maintenance 会破坏可恢复任务 | service 初始化时立即 replay/sweep/reconcile | owner recovery → terminal/file outbox → flow intent → ownerless sweep → raw storage/hold/retention |
| §12“禁止过度防御”是实现和 review 的拒收标准 | 用户明确要求；TechDoc §12 | 多层重复校验、不可达 fallback、placeholder context/artifact | 新增 guard 必须能追溯到真实边界、事故、兼容或可复现故障 |
| 59 个 no-file action 与 63 个 file action 分别使用 literal inventory | 未命中 file resolver 不能成为 no-file 的默认推断；Spec §6、TechDoc §6；VCC 两个用户迁移 channel 和人工处置 channel 已删除 | 根据 resolver 是否存在自动分类 | 两清单互斥且与 117 个现存 exclude 精确闭合，未登记受控 channel 直接 fail-fast |
| dialog selection 在采集边界标记 `file` / `directory` | 017/018 证明无角色 selection 会把保存目录当 input | 继续合并所有 `filePaths` 后由 operation tracker 猜测 | 有 filePlan 时不消费 dialog fallback；legacy 仅消费 `kind:'file'` |
| VCC v1 只允许“空库升空 v2”；任一非空 v1 在首笔 VCC 写前 fail-closed | 用户确认其他用户没有 v1 业务数据，不需要历史迁移；自动清空会形成不可逆数据丢失 | 保留普通用户【优化存储】、启动迁移非空数据、所有 v1 启动自动清空 | fresh/empty v1 自动得到 slim schema/marker/guards；非空表或非空 first month 抛稳定错误且不改 VCC 数据 |
| 当前机器的非空 VCC v1 用一次性 reset-only COW 重置，Archive Center 与其它模块保留 | 当前主库 VCC btree 约 28.06 GB，直接 DELETE 不会归还文件空间；现有 rebuild 已有 WAL/锁/候选/journal/原子切换基础 | 原库原地 DELETE/VACUUM、把当前机特例发布给所有用户、连 Archive Center 一起清理 | 候选只跳过全部 `vcc_fin_op_*` 行，保留 sequence 高水位和非 VCC 数据；切换前后验证，旧库备份默认保留；同目录 JSON 永久记录 before/after 与备份路径 |
| 本机旧 v1 备份只在独立复验后按再次授权永久删除，reset JSON 保持不可变 | 用户在确认活动 v2、Archive/sequence 守恒、旧备份身份和未占用后，明确指定删除精确备份以释放磁盘；时点审计不能随后改写历史 | 永久保留 36.44 GB 旧库、删除前不复验、删除后把报告改成“从未保留” | 回收约 33.94 GiB；本机失去旧 v1 整库回滚能力；报告 `oldDatabaseRetained=true` 继续表示 reset 完成时事实，最终删除作为追加 evidence 记录 |
| 删除 VCC【优化存储】UI/API/IPC，但保留 journal recovery、COW 内核和 v2 guard | 普通用户没有待迁移历史；既有/一次性 journal 仍必须可恢复 | 只隐藏按钮但保留 preload/main 用户通道，或删除恢复内核 | task-policy 同步删除两个 channel；启动仍在 AppDatabase 前 recover journal |
| 导入记录隐藏全部 archive-state 小字，并删除【标记已处理】完整能力链 | 2026-08-18 用户明确取代“只隐藏 ready、保留三类异常小字”的旧决定；按钮是 unresolved 门禁的唯一解除入口，不能只删 UI 留永久死锁 | 只删按钮、继续保留 unresolved 计算/归档/解归档/删除门禁；或继续显示异常小字 | 四种 archive state 都不渲染小字；失败状态/计数/异常导出保留；新失败写 not_applicable，旧 unresolved 值只兼容保留且不参与 gate/token；no-file inventory 60→59 |
| VCC 数据管理三条骨架延迟 150ms 再显示 | 初始 HTML 精确包含三个 38px `span`，本地月份/归档读取很快时会只闪一帧；用户要求继续修正该观感 | 延迟整个弹窗、永久删除慢查询反馈、给骨架设置最短展示时间 | shell 仍同步挂载；初始内容区为空，单一计时器只在同版本仍 loading 且节点仍连接时渲染，成功/失败/关闭均清理 |
| 复用数据链使用 `archive_task_lineage`，parent 只保留运行→单次导出的兼容关系 | Biz OP、Pending、Pre-fund 的一次导入可被多个 run 使用，一个汇总导出也可消费多个 run；同 parent 无法无歧义表达 | date/month/latest fallback、把所有节点强塞同一 parent、递归图框架 | lifecycle 原子持久 planned/terminal edge；related 合并 same-parent 与 pivot run 一跳邻域 |
| Biz OP/Pending/Pre-fund 持久化 dataset head 与 business run receipt | 已确认三模块现有模型缺少可跨重启复用的 dataset/run Archive identity；业务库与 Archive 主库不能共享事务 | 伪造历史 TaskRun、按日期补链、建设跨库双写框架 | v1 来源记录 producer；历史小 metadata 建 v0 UUID/null producer；module receipt owner 先于 interrupted sweep 收口 |
| linked gateway 使用单用途逐行 write nonce 区分 v1 重复键与旧 binary 覆盖 | 仅比较 OLD/NEW source tag 时，两种写入都表现为 tag 不变：trigger 会把同一 v1 文件内重复 `ReconBillBizId` 误降 v0；完全无 trigger 又违反旧 binary 回滚后再次前滚只读 v0/null 的合同 | 放弃 rollback 合同、按日期/latest 猜 producer、为所有表建设通用 write-generation 框架 | `source_write_nonce` 只在该表使用；当前 writer 每次物理 upsert 换 nonce，旧 binary 不换；trigger 只降实际旧写命中行，nonce 不进入 lineage/public DTO |
| Pre-fund `run-output` 与恢复 owner 使用主库 mirror TaskRun 身份，不使用 side DB 自增 id | 每次新 run 前会删除 results side DB；同月 `sideRunId` 会重新从 1 开始，按 `(month, sideRunId)` 可误认旧 superseded mirror | 新增通用全局序列表、以日期/latest 修补、继续使用可重用 locator | mirror additive 保存 contract/TaskRun/ack 并按 TaskRun 唯一查找；side path/id 仅定位 receipt/短期结果；lineage key 为 `pre-fund:<mirrorRunId>`；ack 固定 main→side |
| related 保持现有平铺 UI，并禁止递归扩散 | 用户明确不新增分组/时间线；共享一个输入不等于所有下游链彼此相关 | 图谱 UI、递归 closure、按共享输入展开全网 | 新 public API 只返回 seed、same-parent、pivot run 的直接 input/output，去重排序 |
| 新 TaskRun 仅 `interrupted` 可恢复 | failed/cancelled 已将 planned lineage 原子转 discarded；若再复活会产生“业务成功但 lineage discarded”的矛盾 | 让 failed/cancelled/interrupted 全部回到 running | module receipt/crash recovery 只接管 interrupted；旧 exact-7 batch adapter 保留历史恢复合同 |
| Acquiring partial resume 按原 TaskRun 状态分流 | 现有用户 cancel 会留下可续跑的 side `chunk_progress=partial`，但 Archive TaskRun 已为 cancelled；复活原 owner 违反终态/lineage 合同，永久拒绝 resume 又破坏既有业务能力 | 扩大 recovery edge；把 cancelled 伪装成 interrupted；按月份/latest 换一个 partial；永久 fail-closed | interrupted crash 复用原 owner/不发号；cancelled/failed partial 新建 TaskRun/FileBatch，并在 worker 前以旧 owner、runId、progress/outputIntent snapshot 做 side DB 单事务 CAS owner transfer；旧批次不改写 |
| VCC import 在业务 worker 前 settle 输入并持久化 exact artifactId | manifest settle 已返回真实 artifact identity；若继续等业务结果后按 metadata、文件名或序号反查，会在同名/重试/崩溃时出现歧义 | 业务先提交再 append、按 filename/latest/ordinal 找 artifact、为 handoff 新增第二套 schema | execute 先 settle 全部冻结 input，再把 artifactId + exact-7 owner + SHA/size 送 worker；业务 source 行直接保存 ID；v1 启动只直查该 ID，只有 null-ID 历史 v0 可用旧 metadata 兼容 |
| 新业务写入口缺 dataset/run identity 必须 fail-fast；v0 只能显式进入 | repository 默认生成 UUID/null producer 会掩盖生产 caller 漏接 Task Run，是 §12 禁止的无依据 fallback | 正常 API 缺参时静默降为 v0、把测试便捷路径当生产兼容 | migration 负责历史 backfill；旧 Pending 验证脚本改调命名明确的 legacy helper，正常 importer/reconcile 必须传 v1 identity/receipt |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| v3.1.10 产品事实仍以 `35f11e…` 为代码基线 | `6f1c092…` 相对 `35f11e…` 没有 `src/` 变化，只追加发布证据、规则和测试；当前 PR merge base 已独立记录为 `6f1c092…` | 若后续 `main` 再推进，只影响 PR DAG/合并判断，不应静默改写本 Spec 描述的 v3.1.10 产品实现 | 发布前只读复核 merge base；不 rebase、不用远端覆盖共享工作树 |
| 版本发布仍按仓库惯例同步 `package.json`、lockfile 和三份发布文档 | 用户已锁定 v3.1.11；AGENTS.md 规定版本迭代文档三件套 | 若本次只要求代码不发布，版本文件会扩大 diff | 在最终 release 阶段集中修改；可独立回退该机械 commit |
| 当前机器 reset 不需要删除 Archive Center 中既有 VCC 文件、批次和流程证据 | 用户本轮要求清空的是 VCC 校验原表/校验表/结果表；既有 artifact 仍是独立审计证据，且用户接受了保留边界 | 若业务后续要求连存档文件一起删除，空间与审计验收口径会改变 | 本轮逐表证明 Archive 数据守恒；若要删除存档，必须另起显式破坏性任务 |

## Deviations

| 偏离 | 原合同 | 新合同与同步状态 | 影响 |
| --- | --- | --- | --- |
| 文档代码基线纠正 | 2026-08-17 初稿时本地尚无 `6f1c092…`，曾把 `35f11e…` 同时写成产品基线与当前分支 merge base；PR 建立后的 Git DAG 证明两者不同 | Spec/TechDoc/Baseline 已分层为产品代码 `35f11e…`、PR merge base `6f1c092…`、复审取证 head `458e73f…`；原“本地不存在”只保留为历史时点证据 | 不改变产品行为；reviewer 可精确判断 release evidence 是否包含在 PR base |
| v3.1.10 的普通用户显式历史迁移入口在 v3.1.11 移除 | 已发布版本允许在数据管理执行【优化存储】，3.1.11 原 Spec 把 storage migration 视为继续存在的内部 raw consumer | Spec §1/§8.4/§16 与 TechDoc §8.4 已前向同步；不追改 v3.1.10 已发布事实 | exclude inventory 119→117；main/preload/renderer 通道删除，recovery/rebuild 内核保留 |
| 当前机器执行一次性真实库重置 | 原 Spec §16 写明本阶段不直接修改真实数据库 | Spec §8.4/§16 已限定为当前机器、副本 rehearsal、备份和逐表门禁后的唯一例外 | 不能泛化为产品 migration；执行证据和备份路径必须记录 |
| 本机 reset 的旧库由“默认保留”变为复验后永久删除 | 原合同只承诺 maintenance CLI 不自动删除，执行结束时报告也记录备份已保留 | 用户于 2026-08-18 对精确文件再次授权删除；Spec §1/§8.4/§13/§16、TechDoc §0/§8.4/§15～17、发布三文档已反向同步 | 产品默认与其它用户行为不变；只改变当前机器的最终回退状态，旧 v1 不再可恢复，JSON 审计保持不可变 |
| “同 parent 是唯一关联依据”改为 parent + 精确 lineage | 原 Spec/TechDoc 仅要求复用链跨重启保持同 parent | Spec §4.1.1/§7 与 TechDoc §3.2/§3.7/§7.3.1/§8.3 已同步 | 新增 additive schema 与业务 metadata；公共 DTO/UI shape 不变，related 范围更准确 |
| 两个 deferred internal output 在 promote 前允许创建已确定的具体父目录 | 原合同把 promote 前阶段概括为无 durable 副作用计算，但 target alias/snapshot 要求 output parent 已存在；fresh install 的 `exports/<date>/<kind>` 尚不存在会稳定触发 `ENOENT` | Spec §4.3 与 TechDoc §5.2 已同步：只在非空结果和唯一目标已确定后 mkdir 该父目录，紧接 normalize → promote → write；空结果不 mkdir | 不放宽通用 missing-parent/path fallback，不提前写文件、业务记录或 recovery journal；reserve 失败最多留下空目录，不产生 batch/sequence |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 基线只读复核（2026-08-17 历史时点） | 当时本地 `origin/main=35f11e153962c34cba0e9d4c7084e9df85c9f209`、HEAD merge-base 相同、`package.json.version=3.1.10`，本地对象库尚无 `6f1c092…` | 仅解释初稿为何曾锁到 `35f11e…`；不得继续当作当前 PR DAG 事实 |
| PR 基线复核（2026-08-18） | 当前 `origin/main` 与 `git merge-base HEAD origin/main` 均为 `6f1c09236a6c36f72eb82d61dc14508adfe20eec`；当前复审输入 head 为 `458e73f0f2861cacc0579a4bac20b45900bdb3b3`；`35f11e…` 到 `6f1c092…` 无 `src/` 路径 | 证明产品代码基线、PR merge base、复审快照必须分层；关闭最新评论 P2 文档混淆 |
| 用户确认精确数据血缘续作方案（2026-08-17） | 批准 `archive_task_lineage`、三模块 dataset/run receipt、bounded related、剩余 27 action、3.1.11 发布门禁 | 关闭原 Biz OP/Pending/Pre-fund stable identity BLOCK；禁止退回 date/month/latest 或 same-parent-only |
| TechDoc 合同检查脚本（人工处置移除前） | 63 file + 60 no-file action、NFB-01～28、引用路径/符号和空白检查通过 | 后续由 59 no-file 新证据取代当前 inventory 结论；原结果仅作为阶段记录 |
| `git diff --check`（TechDoc 生成阶段） | PASS | 文档格式 |
| `npm run test:unit`（生产改动前基线） | 5202/5202 PASS；日志 `logs/unit-tests/unit-20260817-192803.log` | 后续 unit 回归可与干净基线区分 |
| 核心专项（2026-08-17，4 个文件） | 111/111 PASS：`archive-file-batch-contract`、`archive-task-lifecycle`、`archive-service`、`archive-center-controller` | Task Run 无编号、原子 manifest reserve、visible/public DTO、operation owner outbox、首终态 CAS；不代表 63 action wiring 或全量发布门禁已完成 |
| 核心 + Toolbox 合并专项（2026-08-17，5 个文件） | 117 项中 116 PASS、1 FAIL；失败为 `toolbox-archive-integration` 仍断言已废弃的“initial outbox replay”告警文案 | 证明 atomic reserve/settle、默认 retention、durable failure、Toolbox receipt 主链已通过；测试必须改为验证 owner-first 顺序，不能恢复旧启动顺序 |
| 核心 + Toolbox + controller fresh 复跑（2026-08-17，5 个文件） | 129/129 PASS | 固定 startup owner-first 全顺序、defer/background 边界、Toolbox 崩溃恢复、manifest settle durable 语义；前一条旧顺序断言已按合同改写 |
| Position consumer 迁移中专项（2026-08-17，4 个文件） | 143 项中 133 PASS、10 FAIL；旧 batch-only fixture/文案 9 项，maintenance operationContext fixture 非 exact-5 1 项 | 证明 policy 切换不等于 consumer 完成；必须同时迁移 Position service/dispatcher/worker/pending owner、取消和启动恢复，完成前不得宣称 no-file 闭合 |
| Position consumer fresh 复跑（2026-08-17） | Position 3 文件 141/141 PASS；controller 33/33 PASS | maintenance exact-5 `operationContext` 贯穿 service/dispatcher/worker receiver；file import exact-7 保留；operation cancel outbox 二启 finalizer/pending 清理与 hidden legacy batch raw recovery 闭合 |
| atomic creator 收口中首次复跑（2026-08-17，5 文件） | 93 项中 87 PASS、6 FAIL；全部集中在无生产 caller 的 `archiveFile/stageFile` 旧单文件 creator 兼容语义 | 原子 `createBatch(files)`、空 files 不写 outbox、manifest append 拒绝、snapshot 深冻结、001 DTO 已通过；禁止为了旧测试恢复独立发号旁路 |
| atomic creator 修复后由主 agent fresh 复跑（2026-08-17，5 文件） | 93/93 PASS | `createBatch(files)` 统一原子 reserve/settle/finish；`archiveFile/stageFile` 只保留无生产 caller 的薄翻译层；ready replay、expected size、持久 snapshot、retention 兼容闭合；Toolbox owner 在 outbox/sweep 前可同次 settle、终结并 ack receipt |
| 首批 eager action 迁移（2026-08-17） | atomic file 15/63、剩余 48；lifecycle/registry 第一批 72/72 PASS，Pre-fund/Duplicate 对应 registry、wiring、service/writer 79/79 PASS | 10 个 output-only/multi-output export、Pre-fund 两个 input-only import、Duplicate input-only import 与 Toolbox 2 条均由 literal FilePlan reserve，并在业务成功后按全部 manifest key settle；不再依赖事后结果路径猜测 |
| visible predicate 统一专项（2026-08-17） | 8/8 PASS；`git diff --check`（repository/main/archive-center/相关测试）PASS | `VISIBLE_BATCH_PREDICATE_SQL` 被 get/id-number/latest/related/list/stats 六处复用；raw get/list/stats 保持历史/恢复语义 |
| Toolbox 路径权威与第二批 eager action（2026-08-17） | atomic file 23/63、剩余 40；`node --check src/main.js` + Toolbox/registry 29/29 PASS | Toolbox merge/split execute 只从冻结 filePlan 读正式输入/输出目标；`targetPlans` 仅保留业务元数据；新增 8 个输入/输出 action 进入原子生命周期 |
| no-file / selection role / context 边界收口（2026-08-17） | dev agent fresh：main/policy/VCC service syntax + outbox/policy/IPC/preflight/dialog/Toolbox/VCC 10 文件 99/99 PASS；主 agent 独立复跑其中 registry/ipc/dialog/preflight 53/53 PASS | 60 no-file、63 file、119 exclude 精确闭合；dialog 目录不进 input fallback；Acquiring/VCC OP 真实 handler 消费 exact-5 Task Run identity；sender 不重复验证 exact-5/exact-7，只在 worker/persisted recovery/lineage 边界保留 |
| 当前机器 VCC v1 只读 inventory（2026-08-17） | 主库 36,437,766,144 bytes，WAL 644 MB；23 张 `vcc_fin_op_*` 表、39 个索引，VCC btree 约 28.06 GB；marker 缺失即 v1；staging/importing/guard/journal 均为 0 | 证明这是非空 v1，不能走空库自动升级；需要 COW 才能真实缩小文件 |
| 当前机器 VCC/Archive 边界只读 inventory（2026-08-17） | VCC import records 30、datasets 10、runs 2、archive 1、opening 1；Archive VCC batches 39/artifacts 38、flow anchors 27、operation issuances 39、VCC artifact holds 0；Archive 文件约 3.13 GB | reset 可在不删除 Archive 证据的前提下清空全部 VCC 表；holds=0 满足 reset preflight，仍需切换前复核 |
| 空库结构 probe（2026-08-17） | 23 张 VCC 表仅 `vcc_fin_op_module_state` 有结构单例（first_month=NULL，currency contract=2），其余 0；空 effective table 在 foreign_keys=ON 下可事务替换为 slim schema且 `foreign_key_check` 为空 | 锁定“空 v1”精确定义与低风险原子升级方案，不需要对空库执行整库 COW |
| 第三批 eager action 与核心合同复核（2026-08-17） | atomic file 36/63、剩余 27；主 agent fresh 复跑 policy/IPC/lifecycle/service/controller 149/149 PASS | Bank Statement run 在 Task Run 建立前绑定随机稳定 identity，首次/重复 export 继承 parent、显式 rerun 新建 parent；Bank Statement 多输出、Bank BU、Biz OP、Pending、Recon ID、VCC OP 等入口已进入原子 file lifecycle；公共 DTO 剔除 Task Run 字段，repository 仅保留 DB identity/status/replay/transaction 防御 |
| 精确 lineage + bounded related foundation（2026-08-18） | dev agent fresh 120/120；主 agent 独立复跑同 4 文件 120/120 PASS；4 个核心源码 `node --check` PASS | Task Run 与 planned/committed/discarded lineage 同事务；仅 interrupted 可恢复；same-parent + pivot 一跳 visible related，ASC 平铺；empty parent/v0 null 不猜关联；TaskRun partial index 与 query-plan 断言闭合；atomic file 保持 36/63 |
| Pending 精确数据血缘最小 E2E（2026-08-18） | dev agent 15-file unit 215/215、engine migration 57/57、reconcile 22/22、export 66/66、removed integration 62/62；主 agent 独立复跑扩展 15-file unit 238/238、三个历史脚本 22/22、66/66、62/62，15 个相关源码 `node --check` PASS | ordinary/removed dataset head 的 v0 backfill 与旧 binary 精确失效；v1 覆盖同事务换 tag；run 在业务事务内复核 frozen head 并写未 ack receipt；owner-first recovery、identity mismatch fail-closed、未 ack 普通月份覆盖阻断；single/aggregate DB 读取使用同一 SQLite snapshot，aggregate execute 只消费 prepare 冻结 runIds；renderer DTO 不泄露 Archive identity；正常 API 无 silent v0/latest fallback |
| Biz OP 精确数据血缘 E2E（2026-08-18） | dev agent Biz 宽套件 14 文件 260/260 PASS；主 agent 独立复跑核心 11 文件 183/183 PASS；flow engine parity 65/65、side DB parity 16/16，Biz smoke exit 0；核心源码 `node --check` 与 `git diff --check` PASS | OP/Flow head v0 前滚与 v1 事务替换、月末副本保留 tag、run 三源 snapshot/receipt、旧侧库 additive migration、owner-first recovery、failed/no-receipt outbox no-op、main/side partial ack 与显式重跑崩溃窗口闭合；single/range export 冻结 exact locator 并对缺失来源行 fail-closed；正常 API 无 date/latest fallback，历史 parity 仅走显式 legacy helper |
| Pre-fund 精确数据血缘与 repair（2026-08-18） | atomic file 37/63、剩余 26；dev agent 宽套件 247/247 PASS；主 agent 独立复跑语法检查及 Pre-fund/Archive/renderer 19 文件 290/290 PASS，并独立复跑 duplicate/side DB/gateway upsert/linked delete 四条集成链 28/28、69/69、40/40、73/73 | bank session、MPT batch/noop 与 gateway 行级来源 tag 精确进入 run snapshot；主库 mirror id 是稳定 run identity，main→side ack 可恢复且 owner 先于 cleanup；gateway nonce 只识别旧 binary 覆盖；公共 DTO 不泄露内部 identity；repair 执行只读冻结 FilePlan；正常链无 month/latest、缺省路径或 silent v0 fallback |
| Statement/New Account 7 条与 deferred 生命周期（2026-08-18） | atomic file 44/63、剩余 19；dev agent 相关 11 文件 243/243 PASS；主 agent 独立复跑 12 文件 279/279 PASS，三个生产源码 `node --check` 与 `git diff --check` PASS | 5 条 eager action 的业务文件路径只来自 frozen FilePlan；monthly/new-account 只在非空结果确定 output 后创建具体父目录、promote、写 workbook 并 settle；空结果不 mkdir、不建 batch、不推进 sequence；真实 SQLite 证明跨日按 promote 日发号并直接形成 running batch；review 删除 normalized DTO 重复字段校验，修复 beforeStart 空 evidence 覆盖 filePlan 与 resolver 失败遗留 prepared TaskRun |
| Position 10 条 File Task 与 pending 恢复（2026-08-18） | atomic file 54/63、剩余 9；主 agent 独立复跑 Position/Archive 11 文件 334/334 PASS；Position import parity 67/67、fault 77/77、side DB parity 38/38 PASS；四个生产源码 `node --check` 与 `git diff --check` PASS | bank/source apply、source prepare、result import 与六个 export 全部使用 literal frozen FilePlan；业务路径只取 `fileEvidence`；generic Position wrapper 在业务后按完整 manifest 单次 settle，durable 后才清 staging；pending 保存原 artifact key/owner，manifest owner 启动恢复只写 terminal outbox 并用 `finishFileTask()` 收口原 TaskRun/batch，不 append 或重建 artifact；confirmation-only 作为当前 File Task succeeded，崩溃后不误判 interrupted；legacy batch 恢复继续走显式旧分支 |
| Acquiring owner 状态 characterization（2026-08-18） | 主 agent 独立复跑 Acquiring run-data/session/worker/repository 7 文件 128/128 PASS；代码证据确认 CancelError 会持久 `chunk_progress=partial`，IPC 返回 cancelled，Archive 新 TaskRun 终态边又仅允许 interrupted recovery | 关闭“直接复活 cancelled owner”方案；Spec/TechDoc 反向同步为 interrupted exact recovery 与 cancelled/failed 新 owner CAS transfer 两分支，后续专项必须证明旧批次不改写、owner 冲突不启动 worker、不按 month/latest 猜测 |
| Acquiring 5 条 File Task 与精确恢复（2026-08-18） | atomic file 59/63、剩余 4；dev agent 核心宽组 220/220、fixture/worker/preflight 67/67、run-data 最终 24/24 PASS；主 agent 独立复跑 Acquiring 宽组 195/195、Archive foundation 111/111 PASS；engine/side parity/idle/N4/index 五条集成链 45/45、19/19、38/38、128/128、22/22 PASS；六个生产源码 `node --check` 与 `git diff --check` PASS | importBill/importFlow/run/resume/export 全部使用 literal frozen FilePlan，execute 只消费 `fileEvidence`；interrupted 复用原 exact owner、manifest descriptor 与批次号，cancelled/failed 以同 parent 新建 TaskRun/FileBatch 并在 worker 前 CAS 转移 side owner，旧终态不变；legacy no-owner 新建原子任务，旧 exact-7 无 TaskRun 仅走隔离 adapter；手工 resume 强制显式 runId，删除 month/latest 与单候选死旁路；重复内部 guard/dead seed 已按禁止过度防御准则删除 |
| VCC Financial 最后 4 条 File Task 与统一入口（2026-08-18） | registry 静态 inventory 精确为 63 file / 59 no-file / 117 exclude；主 agent 独立复跑 policy/lifecycle/file contract/VCC import-lineage/output/service/writer 9 文件 181/181 PASS，并复跑全部 VCC unit glob 486/486 PASS；7 个相关生产源码 `node --check`、全树 `git diff --check` PASS | import 在 worker 前 settle frozen inputs 并把真实 artifactId 写入业务 source；v1 direct ID 缺失/owner 不符 fail-closed，null-ID v0 才走 legacy metadata；result/data/audit prepare 冻结全部具体输出并以 committed receipt 恢复；临时 allow-list 与旧 result-path 推断已删除，正常 file policy 全部走原子 lifecycle；仅 Acquiring v3.1.9 无 TaskRun 旧批恢复保留显式隔离 adapter |
| VCC v1 收口与本机 reset 专项（2026-08-17） | VCC 聚焦 478/478 PASS；追加审计报告后 rebuild + CLI 25/25 PASS | 空 v1 原子升 v2、非空 v1 首写前阻断、按钮/IPC/ready 小字移除、reset-only COW、hold/回滚/高水位/Archive 与非 VCC 守恒，以及不可覆盖 JSON 审计报告 |
| 发布门禁增量（2026-08-17） | `npm run smoke` PASS；integration 首轮 45/48，3 个 VCC fixture 从旧 exact-7 改 exact-5 后分别 209/209、77/77、29/29 PASS；`git diff --check` PASS | 资金/导出主链无回归；VCC no-file worker 上下文与 3.1.11 Task Run 合同一致；完整 integration 未在 fixture 修正后重复耗时大文件段 |
| 全量 unit（2026-08-17） | 5250/5259 PASS；9 项失败集中 Archive storage layout、Bank Statement handler 源码缝、Position lifecycle fixture/源码断言，均不落本次 VCC 存储收口文件 | 本次 VCC 478/478 独立全绿；工作区其它并行 3.1.11 改动尚未达到全量 release-check 绿灯，不能宣称整版完成 |
| `npm run check:vars`（2026-08-17） | 扫到整份脏工作区 37 个生产文件；本次直接相关为 `VCC_STORAGE_CONTRACT_VERSION`、`AppDatabase`、`ipcRenderer`、`archive_artifact_holds`，按脚本语义以 exit 2 提醒人工 review；强制 smoke 已 PASS | v2 marker/guard 原子性、正式启动 opt-in、IPC 双端删除、hold fail-closed 与备份/recovery 已逐项复核；其余命中归属并行 3.1.11 任务，不冒领结论 |
| 当前机器 VCC v1 一次性真实库重置（2026-08-17 23:59 CST） | COW reset 成功：活动库 `36,437,766,144` → `2,835,148,800` bytes，减少 `31.29 GiB / 92.22%`；活动库 contract v2、首次重新启动前 23 张 VCC 表合计 0 行、69 个 guard、`quick_check=ok`；Archive 13 张表逐表守恒，VCC sequence 高水位守恒；旧库以 `tool-data.sqlite.pre-vcc-reset-20260817T153933Z.bak` 保留（v1、36,437,766,144 bytes）；审计报告 `tool-data.sqlite.vcc-reset-report-20260817T153933Z.json`，SHA-256 `781895914145d1af45337d1a769f31a0f7915fed80668b4ab4cf72743a7093e9` | 关闭“只在当前机器重置”的执行门禁；切换后无 DB 句柄、候选/WAL/SHM/journal 残留；后续正常启动允许创建空 module-state 结构单例，不视为历史数据恢复；由于旧备份保留，整机磁盘空间尚未释放，删除仍需用户另行明确授权 |
| 用户明确授权删除当前机器旧 v1 备份（2026-08-18） | 删除前精确核对目标为普通文件、大小 `36,437,766,144` bytes、inode `20297566`，与活动库 inode `51704767` 不同且无进程占用；仅永久删除 `tool-data.sqlite.pre-vcc-reset-20260817T153933Z.bak`；删除后路径不存在，活动库仍为 `2,835,148,800` bytes，审计报告仍为 `9,846` bytes；可用空间 `30,080,288` → `65,672,320` KiB，回收约 `33.94 GiB` | 旧 v1 数据不再可从该备份回退；活动 v2 库和不可变 reset 审计报告未改动，报告中的 `oldDatabaseRetained=true` 仍表示 reset 完成时的历史事实 |
| v3.1.11 文档反向同步与 reconciliation blindspot pass（2026-08-18） | Spec/TechDoc/implementation notes/CHANGELOG/版本历史/用户手册统一新装无感、空 v1 静默升级、非空 v1 fail-closed、本机 reset 实绩与备份最终处置；再次读取 JSON 确认 status=success、before/after bytes、23 表 0 行、Archive 13 表、12 项 sequence、全部 verification=true，active size 一致、backup absent、报告 SHA 不变；六文件 `git diff --check` PASS | ⚠️ 整表清空与永久删除命中资金/审计红线，但已有用户分两次明确授权和切换后独立回读；盲区扫描补齐“报告是时点事实”和“正常启动可重建空 module-state 单例”，没有金额、币种、方向、匹配、行数计算或 Excel 合同变化 |
| VCC 导入状态与人工处置收口（2026-08-18） | VCC/renderer/policy/docs 聚焦 unit `488/488 PASS`；preview 合同 `16/16 PASS`；TaskLifecycle/file-batch 合同 `69/69 PASS`；三条 VCC 资金/破坏性/历史导出集成链 `209/209 + 77/77 + 29/29 PASS`；15 个生产 JS `node --check` PASS；`git diff --check` PASS；数据管理 preview 已重新生成并人工确认导入状态区无 `<small>`、无【标记已处理】，操作列只按异常证据显示【导出明细】 | 新失败固定 `not_applicable`；旧 unresolved 只读保留且不进入 calculation/archive/unarchive/delete gate 或 token；失败尝试不进入 effective dataset，失败主状态、计数、异常导出和 failed-only 月份入口保持；active importing 门禁、金额/币种/公式/行数口径均未改 |
| VCC 数据管理首帧去闪烁（2026-08-18） | `renderer-vcc-financial-op` 定向测试 27/27 PASS；生产 renderer `node --check` 与相关 diff-check PASS | 首帧不再写入三条骨架；150ms 后才显示慢查询占位，版本、loading、DOM 连接和关闭清理均有契约断言；数据读取、表格、按钮和业务状态不变 |
| 全局 smoke 复跑（2026-08-18） | `npm run smoke` PASS；Biz OP fixture 已显式生成 v1 OP/Flow dataset identity，独立 `runBizOpReconSmokeTests()` 171/171 PASS，未在生产 API 恢复 silent v0 fallback | 业务主链、Toolbox、三条精确数据血缘和 VCC 状态链无 smoke 回归；只关闭 smoke 子门禁，不代替 unit/integration、真实数据库或人工资金验收 |
| 全量 integration（2026-08-18） | `npm run test:integration` 的 48/48 脚本、2385/2385 断言全部 PASS，总耗时 305767ms；含 Toolbox 大文件流式/多 Sheet、Position、Acquiring、Biz OP、Pending、Pre-fund、VCC 与资金 parity 链 | 证明当前稳定工作树的跨进程、侧库、文件发布和资金口径集成链闭合；runner 自动刷新 `rules/integration-test-policy.md`，仍不替代真实 017/018/001 副本与人工资金血缘复核 |
| T9/T11 与全量 unit 收口（2026-08-18） | 017/018 maintenance、001 read-only/public rerun、repository/controller/UI/storage layout/Position focused 126/126 PASS；随后 `npm run test:unit` 5347/5347 PASS，日志 `logs/unit-tests/unit-20260818-045215.log` | repair 默认 dry-run、apply 一致性 backup、exact fingerprint、删除/状态/audit 单事务、backup/audit 故障零 mutation、二次幂等；001 保持 task failed + archive complete + 2 ready input + 0 output；先前 8 个旧 fixture/static 回归已按正式合同修正且未恢复 legacy 旁路 |
| 完整 release-check（2026-08-18） | `npm run release-check` exit 0：ESLint PASS、smoke PASS、unit 5347/5347、integration 48/48 脚本与 2385/2385 断言 PASS；release-check unit 日志 `logs/unit-tests/unit-20260818-045250.log` | 关闭自动发布门禁；不等同真实 95 批数据库、017/018/001 副本、真实 UI、文件 SHA/size 或 Biz OP/Pending/Pre-fund 资金血缘人工签字 |
| 最终 `scan:vars` / `check:vars` 与人工关联 review（2026-08-18） | `npm run scan:vars` PASS：v3.1.11、328 个 tracked JS、4375 个顶层名称，A-share/A-pair/A-local/B 分别为 630/925/2653/1555；`npm run check:vars` 按设计 exit 2 提醒人工 review，命中 6 Critical、6 Important-skeleton、8 Runtime-state、8 Risk-sensitive、1 Minor | Critical：VCC contract 仍为 v2，空 v1 精确升级、非空 v1 fail-closed；Biz/Pending/Acquiring 的金额、匹配与行集算法未改，只新增 exact receipt/owner/output intent，专项 parity 与 release-check 已覆盖。Important：lineage 只做 planned/committed/discarded 一跳关系；模板、BU normalization、Position mapping 与 idle cleanup 仅接入冻结 identity/context，不增加 latest fallback。Runtime-state：初始化顺序改为 owner recovery 优先，Statement/renderer/dialog 只改 frozen FilePlan、rerun hint 与已删除 VCC 旧入口。Risk-sensitive：Pre-fund additive tag/receipt/nonce、artifact hold 与 VCC exact artifactId 均 fail-closed，旧 schema 只做幂等兼容。扫描器明确排除 untracked JS；新 FilePlan/lineage/repair 模块另做 `node --check` 与专项/full gate，不把统计遗漏当作未审查。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 63 个 file action 是否都能在不可逆副作用前形成准确 manifest | 已关闭 | 63/63 literal FilePlan 与统一 lifecycle 静态合同已通过；VCC 最后 4 条的 import artifactId、三类 output receipt 与故障注入专项已通过 | 最终 full gate 任一回归失败即重开；禁止恢复 allow-list、空 manifest 或 result-path fallback |
| 三模块 dataset head、run receipt 与 Archive TaskRun 的跨库崩溃窗口是否闭合 | 已关闭 | Pending、Biz OP、Pre-fund 均已通过业务 commit 后/Archive terminal 前 owner-first recovery、partial ack replay 与 mismatch fail-closed；最终 NFB-11/12 和真实数据库门禁继续回归 | 任一后续回归失败即重开，不允许 date/month/latest 修补 |
| linked gateway 部分覆盖是否只更新实际命中行的来源 tag | 已关闭 + ⚠️ 资金红线 | 新旧集合部分重叠 fixture、distinct tag/行数守恒、真实副本人工复核均 PASS | v3.1.11 发布门禁已闭合；未来业务键或覆盖算法变化时重新开启，不能批量给未命中历史行换 tag |
| exact-7 `batchContext` 的全部持久 consumer 是否已正确分成 file owner 与 operation owner | 已关闭（专项） | VCC/Position/Acquiring/Biz OP/Pending 的 worker、receipt、outbox 与恢复测试已通过；no-file sender 使用 exact-5，file publication/recovery 使用 exact-7 | 最终 full gate 继续回归；不得在 service/sender 恢复重复 context 校验 |
| Acquiring cancelled/failed partial 的 side owner transfer 是否跨崩溃闭合 | 已关闭 + ⚠️ 资金红线 | interrupted、prepared/reserved continuation、cancelled/failed owner transfer、legacy no-owner、complete crash、progress/outputIntent 冲突及 side/main parity 均已通过专项；最终全量门禁继续回归 | 任一后续回归失败即重开；禁止扩大 TaskRun recovery edge或退回 month/latest fallback |
| 真实批次数据库及 017/018/001 样本是否在本机可用 | 已关闭 | 在生产库副本上完成可见性、017/018 精确 repair、001 只读保留与真实业务 rerun；原生产数据库未修改 | 副本与真实样本门禁 PASS；后续版本继续使用新冻结副本，不能复用本次签字 |
| Biz OP smoke fixture 是否已按 exact v1 Archive receipt 新合同升级 | 已关闭 | fixture 已迁到 exact v1 receipt，独立 171/171；`npm run smoke` 整体 PASS | 后续 production contract 改动继续由 smoke 回归；不得恢复缺 identity 时的 v0 fallback |

## PR #150 review fixes（2026-08-18）

### Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| operation/file lifecycle、owner outbox 与 Toolbox 的异终态 CAS conflict 不执行 `afterTerminal`/不 ACK | cancel-wins 后已有耐久终态；只有当前状态等于本次请求才是幂等成功。真实 no-file/file lifecycle、owner outbox 与 Toolbox 迟到 success 测试证明 cancelled 不被覆盖 | 把任意终态当 benign；为 legacy `run()` 制造 main 不传入的 `afterTerminal` 组合 | 已存在的异终态 owner outbox 保留诊断且不 finalizer/ACK；同终态 replay 仍幂等；legacy Acquiring adapter 保持基线语义 |
| Pending 大表覆盖在现有 transaction head guard 中同时拒绝关联未 ACK v1 run | `month-repository.deleteMonth` 已有相同 `diff_runs` 谓词；合并进现有 CHECK INSERT 可在七条业务 DELETE 前失败 | 新增锁/扫描框架；改写已有 temp guard DDL/清理语义 | 拒绝时 `diff_runs`/`diff_rows`/`pending_rows`/`pending_months` 行数全部不变 |

### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/main-process/interactive-task-preflight.test.js tests/unit/backend/pending-import/contract-pending.test.js tests/unit/main-process/archive-task-lifecycle.test.js tests/unit/main-process/archive-center-controller.test.js tests/unit/main-process/toolbox-archive-integration.test.js` | 125/125 PASS | main 调用形态与 preflight→session `datasetSeed` 原样贯穿；Pre-fund route 规范化；operation/file lifecycle、owner outbox 与 Toolbox cancel-wins 不 finalizer/ACK；Pending 覆盖拒绝时零变化 |
| `node scripts/integration/pending-engine-migration.js` | 57/57 PASS | Pending 大表引擎覆盖事务、新旧路径 parity 与未 ACK guard 无回归 |
| `node --test tests/unit/main-process/pre-fund-archive-lineage.test.js tests/unit/main-process/pending-archive-lineage.test.js` | 19/19 PASS | Pending/Pre-fund exact dataset/run receipt、terminal route/finalizer 与 ACK 语义 |
| 5 个修改生产 JS + 5 个聚焦测试 `node --check`；`git diff --check` | PASS | 语法与空白错误 |
| reconciliation blindspot pass（主键血缘/幂等重复/部分失败/行数去向） | 无新 BLOCK；命中人工资金/审计复核门禁 | 未改金额、币种、方向或匹配算法；改动涉及任务 owner 幂等与 Pending 整月覆盖，自动化不代替真实样本人工复核 |
| `npm run release-check` | PASS：lint、smoke、5351/5351 unit、48/48 integration（2385/2385） | PR review 修复进入全量回归；包含 Pending、Pre-fund、Toolbox、Acquiring、Position、Biz OP 与 VCC 链路 |
| `npm run scan:vars` | PASS：337 个 tracked JS / 4452 个顶层名称；A-share 648 / A-pair 945 / A-local 2693 / B 1593 | 刷新最后 9 个源码文件进入 Git 后的 v3.1.11 真实统计，并反向同步 important-variables v36 元数据 |
| `npm run check:vars` | PASS：当前 5 个生产修复文件未新增清单命中 | 仍按人工 review 覆盖 TaskLifecycle/Archive owner 终态与 Pending 整月覆盖，不以扫描结果替代资金审计门禁 |

### Follow-up review scope（2026-08-18）

| 项目 | 决定与依据 | 当前 PR 处置 |
| --- | --- | --- |
| P2 基线混淆 | Git DAG 与路径 diff 已证明产品代码基线、PR merge base、复审 head 是三种不同事实 | Spec、TechDoc 与本文件同步分层；解除 Draft 前必须保留该区分 |
| Position terminal route 空 `operationToken` | 该值会进入持久 outbox，空值可造成 TaskRun 已终结而 finalizer 永久失败；这是单一真实持久化信任边界 | 仅在 `normalizeTerminalOutcome()` 的 Position route 分支 trim 后 fail-fast，并以不写 outbox 的 negative test 覆盖；下游不重复校验 |
| Terminal outbox 的 `interrupted` 文档漂移 | runtime normalizer 只接受 `succeeded/failed/cancelled`；`interrupted` 已由 startup owner/sweep 独立处理 | TechDoc 收紧状态集合，不为匹配旧文档扩大运行时状态机 |

### Remaining follow-ups（非当前合并阻断）

| 项目 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| FilePlan alias 检查在多输出任务中的同步 FS 调用复杂度 | PROBE | 独立性能任务先测量 Toolbox multi-split prepare 的输出规模、调用数与 UI 阻塞，再评估一次性缓存 alias key/`dev:ino`；不建设通用路径框架 | 不阻止当前 PR；若实测达到用户可感知阻塞，再以独立性能合同处理 |
| Toolbox publication recovery 的终态失败诊断不足 | PROBE | 独立可观测性任务保留 fail-closed 与状态机，只补底层 code/message/current/requested status 的结构化诊断和故障测试 | 不阻止当前 PR；不得借诊断改动把 conflict 当成功或 ACK receipt |
| `archive_task_runs` / lineage 暂无清理策略 | PROBE | 发布后先采集总行数、日增量、terminal/未完成 owner 比例与 DB 占用，再设计只清理无引用 terminal TaskRun 的 maintenance | 不阻止当前 PR；本版不增加按天数 DELETE，不放宽 owner/lineage 外键 |

### Follow-up review evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Git DAG / path diff 只读复核 | `origin/main` 与当前 PR merge base 均为 `6f1c09236a6c36f72eb82d61dc14508adfe20eec`；复审输入 head 为 `458e73f0f2861cacc0579a4bac20b45900bdb3b3`；`35f11e…` 到 `6f1c092…` 无 `src/` 变化 | P2 三层基线表述可由 Git 复现，不把发布证据 commit 误当产品源码基线 |
| `node --test tests/unit/main-process/archive-center-controller.test.js` | 39/39 PASS | Position 正常 terminal route 保持；空字符串/纯空白 token 在 outbox 写入前 fail-fast，且不生成持久记录；其它 route 与 cancel-wins 重放继续通过 |
| `npm run check:vars` | PASS；仅识别 `src/main-process/archive-center/controller.js`，未命中重要变量 | 本次未改变重要变量、任务状态集合或 Position 业务数据字段；仍以终态/恢复专项代替变量名推断 |
| reconciliation blindspot pass | 无新增 BLOCK 或资金红线 | 未改金额、币种、方向、匹配、行数或业务主键；只收紧 terminal intent 持久化 identity，真实数据库与资金血缘人工门禁不变 |
| `npm run release-check` | PASS：ESLint、Smoke、5352/5352 unit、48/48 integration（2385/2385） | 文档同步与 Position terminal 边界进入完整发布回归；runner 的纯耗时清单刷新已还原，不进入本次 diff |

### Current review round（head `001b8059ced56b9d70602c79cdd97d375020c969`）

#### Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| VCC v1 source 的 positive `archive_artifact_id` 即使目标 artifact 缺失也保持不可变 | 该 ID 是业务提交时持久化的精确文件证据；清为 null 会让第二次 reconcile 把 v1 source 重新放入历史 metadata/handoff 匹配 | 清空 ID 后按文件名、TaskRun、source type/ordinal 重新匹配相似 artifact | 缺失时只把 source 标为 `unavailable` 并保留错误；后续重放仍 fail-closed，不改绑、不新增 hold、不删除 raw fallback |
| Position startup owner 必须等待同一 pending 的实际恢复完成，operation TaskRun 只从 `interrupted` reopen | service 对象创建完成不等于 terminal/finalizer 已完成；通用 sweep 会把未受 batch-id 保护的 operation TaskRun 标为 interrupted | 后台 catch 后继续启动、按 outbox 全局 remaining 猜 Position 是否完成、直接对 interrupted TaskRun 写终态 | owner Promise 完成后仍存在同 operationToken pending 即阻止启动；`interrupted → running → terminal` 使用既有 recovery edge，prepared/running 不增加恢复调用 |

#### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/main-process/vcc-financial-op-archive-lineage.test.js tests/unit/main-process/position-reconciliation-operation-lifecycle.test.js tests/unit/main-process/toolbox-archive-integration.test.js` | 44/44 PASS | VCC 连续两次 reconcile 保留 exact ID、相似 artifact hold=0、raw fallback 不变；Position 异步 owner 失败保留 pending、阻止 generic sweep；interrupted operation 按 reopen→terminal 收口 |
| Archive/Position/VCC/Toolbox 9 文件宽回归 | 276/276 PASS | TaskLifecycle、Archive service/controller、Position side service、VCC import/service 与 Toolbox owner 顺序无回归 |
| 3 个生产 JS + 3 个专项测试 `node --check`；相关 `git diff --check` | PASS | 语法与空白错误 |
| `npm run check:vars` | PASS；3 个生产文件未命中 important variables | 未改变清单中的金额、币种、匹配、业务主键或公共状态变量；仍以恢复/血缘专项验证实际状态转换 |
| `npm run release-check` | PASS：ESLint、Smoke、5354/5354 unit、48/48 integration（2385/2385） | 两条 P1 修复进入完整发布回归；integration runner 的纯耗时清单已从最终 diff 还原 |
| reconciliation blindspot pass（主键血缘、重跑幂等、状态部分失败、审计去向） | 自动化未发现新的金额/币种/方向/匹配变化；VCC exact evidence 不再因二次恢复静默换绑 | ⚠️ 文件审计血缘红线仍需用真实或脱敏 VCC 库人工确认 unavailable source 保留旧 artifact ID；自动化不替代该门禁 |

### Fifth review round（head `001b8059ced56b9d70602c79cdd97d375020c969`）

#### Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| VCC import 的 `metadata.batchId === taskRunId` 只在 public batch DTO 边界精确移除 | 正常成功导入会把 TaskRun UUID 作为业务 result `batchId` 写入 raw metadata；顶层 TaskRun 字段虽已隐藏，该别名仍会从 list/detail 暴露且与公共 batch ID 同名异义 | 删除全部 metadata `batchId`、建设通用 allowlist、修改 VCC 内部 import result/flow identity | raw/internal metadata 与精确 flow identity 保留；只有等于非空 raw TaskRun identity 的别名不进入公共 DTO，不同值的业务 metadata 不受影响 |

#### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/main-process/archive-service.test.js` | 43/43 PASS | 真实 VCC input-only File Task 成功后，public list/detail 不返回 TaskRun 同值 `metadata.batchId`；raw batch/detail 保留；异值业务 metadata 继续公开 |
| `node --check src/main-process/archive-center/archive-service.js tests/unit/main-process/archive-service.test.js`；限定 `git diff --check` | PASS | 公共边界实现与专项测试语法、空白错误 |
| reconciliation blindspot pass（主键血缘、可观测性与隐私） | 无新增资金红线或 BLOCK | 只改变公共 DTO 投影，不改 VCC 原始文件、金额、币种、匹配、业务入库、flow identity 或 raw 审计 metadata |
| Archive/Position/VCC/Toolbox 9 文件宽回归 | 277/277 PASS | 三条当前 P1 修复共同进入 TaskLifecycle、Archive service/controller、Position、VCC 与 Toolbox owner 组合验证 |
| `npm run check:vars` | PASS；4 个生产文件未命中 important variables | 未改变清单中的金额、币种、匹配、业务主键或公共状态变量；专项状态/血缘验证仍保留 |
| `npm run release-check` | PASS：ESLint、Smoke、5355/5355 unit、48/48 integration（2385/2385） | 本轮公共 DTO 修复进入完整发布回归；integration runner 的纯时间戳/耗时刷新已从最终 diff 还原 |

### Sixth review round（head `001b8059ced56b9d70602c79cdd97d375020c969`）

#### Unknowns register

| 项目 | 分类 | 结论 |
| --- | --- | --- |
| OP 覆盖范围 | PROBE → closed | 真实影响范围是 `(D, normalized BU)` 与作为 T-2 的 `(D+1, normalized BU)`；复用既有两次清理调用，不新增范围推断 |
| Flow 默认引擎旁路 | PROBE → closed | 默认大表引擎使用 `contract-flow.js` 的 SQL 契约，不调用 run repository；必须在既有 head CHECK 中加入 date 级未 ACK receipt 条件 |
| 月末跨库原子范围 | PROBE → closed | 当前可保证的是下月侧库既有单事务内 imports/runs/diffs/heads 零变化；不新增跨库事务或补偿框架 |
| 新 run 与主库 mirror | PROBE → closed | side run 首次写入与 main mirror 替换均以 `(date, normalized BU)` 为真实写范围，在各自已有 transaction 中阻断 |

#### Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 用两个单用途 repository guard 保护 date+BU 与 date 范围，并只在真实写入口调用 | 未 ACK v1 receipt 是崩溃后 module owner 恢复 Archive terminal 的唯一精确事实；保护点必须早于首个业务 DELETE/INSERT | 为所有 repository 方法重复校验、增加通用 receipt 框架、按 latest/date 猜恢复对象 | OP 同步/worker 清理、Flow legacy 清理、新 side run 与 main mirror 复用同一范围语义；历史 v0 和已 ACK receipt 不受影响 |
| Flow 默认引擎只扩展既有 head guard CASE | 该路径的覆盖 SQL 是有意独立的引擎契约；在现有 transaction guard 中加入同日未 ACK 查询即可在首个持久 DELETE 前拒绝 | 为引擎再复制 repository 层、引入锁或第二套状态机 | engine/legacy 两路失败后旧流水、run/diff 与 dataset head 均保持不变 |
| 月末失败只承诺下月侧库事务零变化 | 当前 handler 先完成当月导入，再在下月侧库单独事务补清/复制；评论所指的数据丢失发生在下月清理 | 为该评论扩展跨数据库回滚或预检协议 | 下月 imports/runs/diffs/heads 回滚；当月已成功导入不被虚假回滚 |

#### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Biz OP 本轮 4 个聚焦 unit 文件 | 70/70 PASS | 同范围新 run、OP 重导、Flow 覆盖、main mirror、月末下月侧库均在未 ACK receipt 下 fail-closed 且受保护表零变化 |
| Biz OP 11 个 unit 文件宽回归 | 191/191 PASS | schema/head、两类 import、worker contract、lineage、run-data 与既有金额/日期规则无回归 |
| `bizop-flow-engine-migration.js` / Biz OP smoke / side-db parity | 73/73、171/171、16/16 PASS | 默认引擎与 legacy Flow 语义一致；Biz OP 资金算法与侧库镜像兼容保持 |
| 3 个生产 JS + 4 个 unit + 1 个 integration `node --check`；`git diff --check` | PASS | 语法与空白错误；实现只增加真实 admission guard，无 fallback、retry、锁或重复 DTO 校验 |
| `npm run check:vars` | PASS；扫描 7 个当前生产改动文件，未命中自动清单 | 人工 review 仍按 Risk-sensitive Biz OP 清理范围和 Critical 默认 Flow 引擎边界执行，不以名称扫描替代资金复核 |
| `npm run release-check` | PASS：ESLint、Smoke、5363/5363 unit、48/48 integration（2393/2393） | 第六轮修复与前三条本地 P1 共同进入完整发布回归；集成清单保留新增 8 条断言，纯时间戳/耗时刷新已还原 |
| reconciliation blindspot pass（血缘、覆盖幂等、部分失败、行数/金额/币种） | 无新 BLOCK；未改金额、币种、方向、匹配、行映射或 DELETE 顺序 | ⚠️ 未 ACK receipt 属资金审计血缘红线；发布前仍需用真实或脱敏 Biz OP 库人工复核 guard scope、owner ACK 恢复及 OP/Flow 覆盖后的行数与输出 |

### Seventh review round（input head `250b1349ff9be315111d4fe9999958cf63927a7c`）

#### Deviations and decisions

| 项目 | 结论 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 第六轮“月末只保证下月事务零变化”已被新 P1 证据推翻 | Spec/TechDoc 已先反向同步：worker 在解析并校验首个 BU 后、当前月 COMMIT 前只读检查既有下月侧库 D/D+1 的 date+BU guard；下月写事务仍复检 | 当前月先提交后再处理下月；跨库 transaction；按 date/latest 回滚 | 已存在未 ACK receipt 时当前月与下月 imports/runs/diffs/heads 全部零变化；两次检查间的并发变化仍由下月既有事务 fail-closed，不建设通用跨库框架 |
| side receipt 已提交但 main mirror 写失败时做单用途精确补偿 | 在 side DB 单事务内按 `archive_task_run_id` 临时写 ACK 以通过既有 DELETE trigger，随后删除本 run 的 diff 与 run；事务失败会整体回滚，不留下伪 ACK | 按 date/BU/latest 删除；开放 failed/cancelled recovery；通用跨库补偿队列 | 精确补偿成功后才允许 TaskRun failed；补偿自身失败时 main 把 TaskRun 转为既有 interrupted，receipt 由既有 owner 恢复，不新增状态边 |
| admission 只在 TaskLifecycle 已规范化的内部路径传递 | `monthEndAdmission` 只含 next side DB path、D 与 D+1；worker/sync 写边界执行一次，不在 repository 多层重复校验 | 新增通用 DTO validator、为不存在下月库预建占位库、在多层重复 normalize | 保持“禁止过度防御”：只有 SQLite/worker 边界与真实未 ACK 事故 guard；无 placeholder、fallback 或不可能状态组合 |

#### Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 新故障注入：Biz OP 月末 worker / mirror compensation / compensation recovery | PASS | 真实 worker 在当前月 COMMIT 前命中下月未 ACK receipt，两库四类写集合 byte-for-byte 不变；mirror 故障只删本 TaskRun side run/diff；补偿故障保持 interrupted 并由启动 owner 收口 |
| Biz OP 11 个 unit 文件宽回归 | 194/194 PASS | schema/head、OP/Flow import、worker、run receipt/lineage、run-data、金额与日期规则无回归 |
| `bizop-flow-engine-migration.js` / Biz OP smoke / side-db parity | 73/73、171/171、16/16 PASS | 默认/legacy Flow、资金算法和侧库镜像 parity 保持 |
| `npm run release-check` | PASS：ESLint、Smoke、5366/5366 unit、48/48 integration（2393/2393） | 第七轮两项 P1、三条新增故障测试及全文档合同进入完整发布回归；integration runner 的纯时间戳/耗时刷新已还原 |
| `npm run scan:vars` | PASS：v3.1.11、337 个 tracked JS、4458 个顶层名称；A-share/A-pair/A-local/B 为 649/947/2695/1596 | 自动统计与 v36 基线同步；untracked/generated 继续排除 |
| `npm run check:vars` | PASS；命中 Important-skeleton `normalizeBu` 与 Risk-sensitive `addOneDay` | 两者实现均未改；date+BU SQL 继续使用 `LOWER(TRIM)`，D+1 继续使用单源 UTC helper；Biz smoke、月末跨月、大小写 BU 与 release-check 已覆盖 |
| reconciliation blindspot pass（主键血缘、月末时间边界、重跑/部分失败、审计去向） | 无新增自动化 BLOCK；未改金额、币种、方向、匹配、行映射或业务数据行数算法 | ⚠️ 未 ACK receipt、精确补偿和跨月 tag 属资金审计红线；合并前仍需真实或脱敏 Biz OP 库人工复核 D/D+1 guard scope、补偿前后 run/diff 行数、owner ACK 与输出血缘 |

### Eighth review round（input head `01a6640dca1b6a02f6d05f20556e5994f9ef1855`）

#### Unknowns register and decisions

| 项目 | 分类/结论 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| current COMMIT 后到 target COMMIT 前没有 durable owner | PROBE → closed：source imports/head 同事务写单用途 exact copy intent；target COMMIT 后 intent 继续保留到 Archive File Task terminal | 仅增加第三次 precheck、跨库 transaction、按 date/month/latest 恢复 | 崩溃、target SQLite 失败或并发 receipt 都留下可重放 owner，不再形成无 owner 分叉 |
| copy intent 与 Archive File Task 的终态顺序 | PROBE → closed：`target COMMIT → File Task succeeded → delete intent`；running/interrupted 由 startup exact recovery，succeeded 只核 target 后清 intent | target COMMIT 后立即删 intent、扩大 failed/cancelled recovery | 每个崩溃点至少保留 intent 或 Archive terminal；不新增状态边 |
| run receipt 与 copy intent 的 startup 顺序 | PROBE → closed：同一 Biz OP owner 先恢复/ACK run receipts，再重放 copy intents，最后才进入 generic sweep | copy 先执行导致未 ACK receipt 自锁、全库轮询 | 并发 receipt 可先收口，再由既有覆盖语义完成 target copy |
| D+1 run 与 source reimport admission | PROBE → closed：run 在 lineage prepare 边界查 previous-month exact intent；source import 在当前月写事务首个业务清理前查同 date+normalized BU intent | execute 层重复 guard、按 target head 猜是否完成 | 防止冻结旧 T-2 或覆盖 intent 对应 source；正常路径只校验一次 |

#### Deviation

第七轮“当前月 precheck + target transaction recheck 已覆盖并发窗口”的结论被第八轮崩溃证据推翻。Spec/TechDoc 已先反向同步为 single-purpose durable copy intent；不改变公开 DTO、金额/币种/匹配算法、File Batch 发号合同或 failed/cancelled recovery 边。

#### Implementation

- Biz OP side DB additive 增加 `biz_op_recon_month_end_copy_intents` 与单用途 repository；正常 worker 和同步 fallback 都在 source imports/head 同一事务写 exact intent，历史库只建空表、不回填。
- `runBizOpImport()` 在 source success 后按 intent 执行 target 单事务；worker 已 COMMIT 但 success receipt 丢失时，只在 exact `sourceTaskRunId` intent 已存在的事实下保留 File Task owner。
- target 失败由 main 将 File Task 写为既有 `interrupted`，batch failure code 固定为恢复状态机要求的 `ARCHIVE_TASK_INTERRUPTED`，原业务失败码只记内部 metadata；startup 复用原 manifest artifact keys、原 batch 和原批次号恢复。
- Biz owner 顺序固定为 run receipts → month-end copy intents → generic sweep。source reimport 在首个业务清理前拒绝同 scope intent；D+1 run 在 lineage prepare 边界拒绝 previous-month exact intent。

#### Evidence

| 检查 | 结果 | 结论 |
| --- | --- | --- |
| Biz OP unit（12 files） | 219/219 PASS | schema、worker/sync、金额校验、D/D+1 清理、lineage、崩溃/并发/SQLite fault 均通过 |
| Archive core（6 files） | 190/190 PASS | interrupted exact owner、manifest settle、outbox、可见性和 63 file / 59 no-file inventory 无回归 |
| `bizop-flow-engine-migration.js` | 73/73 PASS | Flow 大表/legacy parity 不受 copy intent 影响 |
| `biz-op-recon-side-db-parity.js` | 16/16 PASS | 月末副本、月初 T-2 与主/侧库语义保持 |
| Biz OP smoke | 171/171 PASS | 金额、BU、D/D+1 与导出既有 smoke 全绿 |
| `npm run smoke` | PASS | Risk-sensitive 硬门禁全绿 |
| `npm run release-check` | PASS：unit 5371/5371；integration 48 scripts / 2393/2393 | lint、smoke、全量 unit 与 integration 全绿；integration policy 清单已由 runner 自动同步 |
| 最终 `npm run test:unit`（补入 worker commit 回归后） | 5372/5372 PASS | 新增 source imports/head/intent 同事务提交的真实 worker 回归后，全量 unit 再次闭合 |
| `npm run scan:vars`（临时 index 计入新 repository） | PASS：338 files / 4476 names；A-share/A-pair/A-local/B = 655/950/2704/1605 | 自动统计已刷新；真实暂存区未改变 |
| `npm run check:vars` | 预期 exit 2：命中 `normalizeBu`、`addOneDay`、`subOneDay`、`clearRunsAndDiffsByDateBu` | 实现未改金额/币种/方向；UTC 日期 helper、normalized BU scope、D/D+1 guard 与原号恢复均有专项证据 |

reconciliation blindspot pass：自动化未发现新增 BLOCK；source row/head/intent、target row/head、Archive TaskRun/FileBatch 以 taskRunId + datasetId/version 精确闭合，失败路径不产生 latest/date/month 猜测或新批次号。⚠️ 该改动仍命中 Biz OP 跨月清理与未 ACK receipt 资金红线；合并前必须用真实或脱敏库人工核对 D/D+1、normalized BU、source/target 行数、dataset tag、原批次号和 Archive input evidence。

### Ninth review round（input head `5511a2ca7c2b33964b64d34ecf646f4655f26194`）

#### Task brief and unknowns

- Goal：关闭 Pre-fund side success receipt 已 COMMIT、主库 mirror create/finish 失败后形成 `failed TaskRun + unack receipt` 的 P1。
- Constraints：只按当前 `archive_task_run_id` 补偿；不改金额、币种、方向、匹配或公共 DTO；不增加通用 retry/queue、month/latest fallback、重复内部校验或 failed/cancelled recovery。
- Done when：精确补偿成功后 side run 与全部级联结果归零并允许 failed；补偿失败时 receipt/mirror 现场保留、TaskRun 为 interrupted，startup owner 可恢复到 succeeded/ACK。

| 未知 | 分类/结论 | 证据 | 决定 |
| --- | --- | --- | --- |
| side run 的全部结果是否可随单次 exact delete 原子清理 | PROBE → closed | results DDL 中 gateway pool、candidate snapshots、duplicate groups、balanced/unbalanced rows 均以 `run_id` 或其父记录 `ON DELETE CASCADE` | 在原 side DB 新事务按 TaskRun 唯一 receipt 删除 run；不逐表建设补偿框架 |
| mirror finish 失败且 mirror row 已存在时，补偿失败后能否恢复 | PROBE → closed | `recoverRunMirror()` 已按 receipt TaskRun 校验 running mirror 并 finish；不存在 mirror 时可按 receipt 创建 | preserve 路径不调用 fail mirror；保留 running/不存在两种真实现场给既有 owner |
| 普通 handler error 是否会把 preserve owner 终结为 failed | PROBE → closed | operation TaskLifecycle 会按返回状态写 failed，现有 Biz OP seam 已先把 TaskRun CAS 为 interrupted，使迟到 failed 因终态冲突不覆盖 owner | Pre-fund main 仅在 `preserveArchiveTaskRun=true` 时采用同一单用途 interrupted handoff |

#### Decisions

- Spec/TechDoc 已把既有 side-receipt mirror 补偿合同明确扩写到 Pre-fund 小节；这是遗漏实现的闭合，不改变状态机或用户可见行为。
- 精确删除入口只接受 v1、success、未 ACK 且 TaskRun identity 匹配的真实 receipt；校验在 run-store 持久化边界一次完成。
- 补偿失败优先保留 side receipt 和可能已存在的 mirror，不再执行当前 catch 中的 `failPreFundReconciliationRunMirror()`；原 mirror 错误通过 `cause` 保留诊断。

#### Implementation

- `PreFundReconciliationRunStore.deleteArchiveRunByTaskRunId()` 在调用方 `BEGIN IMMEDIATE` 内定位当前 v1 success/unack receipt，并只按其 `id + archive_task_run_id` 删除 run；既有外键级联清理候选池、重复审计、平账和不平账结果。
- service 在 side success COMMIT 后把 mirror create/finish 作为同一个 handoff 边界；任一步失败先执行上述补偿。补偿成功后走原普通失败路径；补偿失败写入 `PRE_FUND_MIRROR_COMPENSATION_FAILED + preserveArchiveTaskRun` 并保留 receipt/mirror。
- main 的 Pre-fund run catch 只对该 marker 调用 Archive `finishTaskRun(...interrupted)`，随后仍返回原业务错误；TaskLifecycle 的迟到 failed terminal 无法覆盖 interrupted owner，startup 继续复用既有 receipt recovery。

#### Evidence

| 检查 | 结果 | 结论 |
| --- | --- | --- |
| Pre-fund 聚焦 store/service/lineage/renderer | 48/48 PASS | mirror create 失败精确补偿；finish + compensation 双失败保留 success receipt/running mirror；main seam 先写 interrupted；全部级联结果归零 |
| Pre-fund 13-file 宽 unit | 176/176 PASS | 严格 1:1、十进制金额、币种/方向、规则资格、候选顺序、重复审计、行数守恒、MPT 生命周期和输出契约无回归 |
| output contract / side DB parity / linked gateway upsert | 15/15、69/69、40/40 PASS | 21 列输出、results/MPT 侧库隔离、持久 gateway 行语义保持 |
| `npm run release-check` | PASS：lint、smoke、5376/5376 unit、48 scripts / 2393/2393 integration | 全量门禁闭合；integration policy 的纯时间戳/耗时刷新已还原，不进入本轮 diff |
| `npm run check:vars` | 预期 exit 2：Risk-sensitive `MODULE_PRE_FUND_RECONCILIATION_RESULTS` | DDL、runId 命名空间和匹配算法未改；results 只在 mirror handoff 失败时按 exact TaskRun 删除，side DB parity 与 smoke 已覆盖 |

reconciliation blindspot pass：本轮不改输入、匹配键、金额、币种、方向、手续费、规则、候选消费顺序或输出；side run 与 mirror/Archive TaskRun 只通过唯一 `archive_task_run_id` 闭合，补偿成功满足全部结果行随 run 原子归零，补偿失败满足 receipt/mirror/TaskRun 可审计且不进入 failed owner。无新增自动化 BLOCK。⚠️ 这是跨库部分失败与结果删除的资金红线；合并前仍需用真实或脱敏 Pre-fund 库人工核对 mirror create/finish 故障下的 side run/候选/平账/不平账行数、mirror status、TaskRun status 与 startup ACK。

### Tenth review round（input head `1df4004c53550bf75d9f73a2d544414b6f8c52b4`）

#### Decisions and evidence

| 项目 | 事实与证据 | 决定 |
| --- | --- | --- |
| 最终变量统计过期 | `npm run scan:vars` 在 Git tracked source set 上得到 338 files / 4478 names，A-share/A-pair/A-local/B 为 656/950/2705/1606；原产物仍为 4476/655/950/2704/1605 | 提交自动生成的 `var-reference-stats.md/json` 并同步 important-variables v36 元数据；不手改扫描结果，不把 untracked JS 纳入统计 |
| integration policy 是否属于本次生成产物 | 当前 HEAD 实跑 `npm run scan:vars` 只写 `docs/analysis/var-reference-stats.md/json`，`rules/integration-test-policy.md` 保持 clean | 不制造未由命令产生的 policy/timing diff；后续只有 integration runner 产生真实断言清单变化时才提交 |
| full-PR important variables 证据过窄 | `npm run check:vars -- --since 6f1c09236a6c36f72eb82d61dc14508adfe20eec` 按设计 exit 2，命中 6 Critical、7 Important-skeleton、8 Runtime-state、11 Risk-sensitive、1 Minor | PR body 改为完整 base-to-head 结果；不再用最后一个局部提交的两项命中代表整份 PR |
| 现场固定计数随正常活动漂移 | 2026-08-17 快照为 95/34/53/8；reviewer 2026-08-19 只读快照为 98/36/54/8，且两者都满足 `visible = total - zeroArtifact = readyVisible + failedOnlyVisible` | Spec/TechDoc 将 release gate 改为同一 canary 副本冻结 baseline 后做前后等式与非目标数据守恒；历史数字仅保留为带日期 evidence |

本轮只刷新生成证据和验收口径，不修改运行时代码、Schema、金额、币种、方向、匹配、File Batch 可见性 SQL 或 repair 逻辑。reconciliation blindspot pass 未发现新增自动化测试缺口；⚠️ 真实/脱敏数据库的文件血缘、行数、金额和 repair 非目标数据仍须人工复核，统计等式不能替代资金签字。

## 发布人工验收证据（2026-08-19）

### Decisions / external state

- 发布负责人明确回复“全部 PASS”，确认 Windows 10/11 Setup、portable、SmartScreen 实际提示及 `3.1.10 -> 3.1.11` 离线覆盖安装门禁通过；本次未使用 Windows Runbook 豁免。
- PR #150 已以 merge commit `782415ae1f606da2adebe881ba7ab56b1b045137` 合入 `main`。annotated tag `v3.1.11` 的 tag object 为 `e17f29d262c48c59d162b7a61e18bce2b802c308`，peeled commit 精确等于该 merge commit。
- [Release Windows Packages run 32219459465](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32219459465) 于 `2026-08-19T06:03:11Z` 自然终态 success；tag/main、完整 release-check、布局、packaged inputs、Windows build、`check:dist`、ASCII staging、更新元数据、Release 发布和发布后回读各步骤全部成功。
- 所有数据库与 UI 验收均在冻结副本或隔离 userData 中执行，原生产数据库未写入；临时验收产物不进入仓库或 Release。
- Windows Runbook“发布后”第 2 项的 `production/latest` 在线 canary 只能在公开 Release 存在后执行，本节不把发布前离线覆盖安装冒充线上更新。该项不移动 tag、不替换资产，但在实际通过前阻止对外公告“在线升级已验证”。

### Public asset evidence

- [v3.1.11 Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.11) 于 `2026-08-19T06:03:05Z` 发布，`draft=false`、`prerelease=false`，并成为 latest stable Release。
- `bank-bill-excel-tool-setup-3.1.11.exe`：`100359253` bytes，SHA-256 `c68ab388561c18fe3a77c074cba4709c6c61e40a57c88328a260033820880206`。
- `bank-bill-excel-tool-portable-3.1.11.exe`：`99862407` bytes，SHA-256 `68e61d634ea81ff4d56abc7fabb8aac71f758b731d29745f405f6c044bd52e5f`。
- `bank-bill-excel-tool-setup-3.1.11.exe.blockmap`：`105645` bytes，SHA-256 `0e73c8d2077c278a0067fd0aa27ee67d83fdb36e5559c946b0aa4b08b2f935e6`。
- `latest.yml`：`372` bytes，SHA-256 `728f5ba06a594e7b408d0e7a162241d35f68ad9762037e994f1ee0125abe998d`；独立下载回读为 version `3.1.11`、path `bank-bill-excel-tool-setup-3.1.11.exe`、size `100359253`、Setup SHA-512 `d1MSPttwUnICShPzJnBJDhOfSlgAHRnsaFdpbnNVwFUzudQzgNkJ4mq1HetVHvPzSN1SPpmCNV3KLSaaXzE9KQ==`，与 workflow 的实际 Setup 校验值一致。
- 四项公开资产 URL 均在不带 GitHub 凭据的 HEAD 请求中跟随重定向得到 HTTP 200；`latest.yml` 与 blockmap 的独立下载 SHA-256 和 GitHub public asset digest 一致。

### Database, UI and lineage evidence

- 真实数据库副本的 list/get/stats/latest/related 统一排除零 artifact 批次；no-file Task Run 不写 File Batch、issuance 或 sequence。cancelled 文件任务保留 1 项真实 artifact；interrupted 文件任务使用原 TaskRun、原 File Batch 和原号码恢复，恢复前后 batch 数与 sequence cursor 不变。
- `017/018` 只命中精确指纹并按合同 repair；`001` 保持 task failed、archive complete、`2 input + 0 output`，随后真实 Toolbox rerun 新建成功批次并得到 `2 input + 1 output`，实际输出与归档 output 的 SHA-256/size 相同。旧 `001` batch/artifact 行不变；共享 Blob 只因 rerun 实体验证更新 `last_verified_at`，内容 SHA、size、path 与 created 时间不变。
- Biz OP、Pending、Pre-fund 真实 SQLite 验收得到 15 个 Task Run、12 个可见 File Batch、12 个 artifact 和 12 条 committed lineage；Biz 同一导入被两个 run 复用、汇总导出关联两个 run，related 仅返回直接一跳邻域。Pre-fund 样本满足 bank `4 = 3 matched + 1 unmatched`、gateway `4 = 3 matched + 1 unused`，币种与方向异常按原合同进入不平结果。
- VCC 与 Position 的 v3.1.10/v3.1.11 输出 SHA-256 完全一致；Acquiring 业务结果 sheet 完全一致，整份 XLSX 仅有运行耗时、临时路径和 app version 三类预期审计元数据差异。VCC/Position/Acquiring 的 TaskRun、parent、File Batch、artifact owner 与输出均已回读；SQLite `integrity_check=ok` 且无外键错误。
- 代表性 15 个 Excel sheet 已做结构、公式错误和视觉预览检查，公式错误为 0；Toolbox `001` rerun、Biz OP、Pending、Pre-fund、VCC、Position、Acquiring 输出均可读且未发现新增布局异常。

### Automated evidence

- 精确 merge commit 的 `npm run release-check` 自然终态 PASS：lint/smoke PASS，unit 5376/5376（343 files），integration 48/48 scripts、2393/2393 assertions。
- 发布证据分支在正式状态文档与防回退测试写入后再次执行唯一完整 `npm run release-check`：lint/smoke PASS、unit 5376/5376、integration 48/48 scripts 与 2393/2393 assertions（372338ms）；runner 只改写本机时间戳/耗时的清单已还原，不进入证据 diff。
- `npm run scan:vars` 复核仍为 338 files / 4478 names、A-share/A-pair/A-local/B = 656/950/2705/1606，只有扫描时间戳变化，已还原不进入 diff；`npm run check:vars -- --include-minor` 因证据分支无 `src/` diff 按设计跳过并 exit 0。完整 PR 的重要变量扫描、资金链 review 和相关专项证据已在上文及 PR #150 留档；`git diff --check` PASS。
- blindspot pass 与 reconciliation blindspot pass 未发现新的自动化 BLOCK；金额、币种、方向、匹配和业务行算法未改。资金红线已由上述真实副本人工复核关闭，但该签字不泛化为后续新月份、新主体、新输入来源或新环境。

## v3.1.11 随包指南偏差与 v3.1.12 纠正（2026-08-19）

### Unknowns register and decision

| 项目 | 分类/结论 | 证据 | 决定 |
| --- | --- | --- | --- |
| 发布后补写的 v3.1.11 正式状态是否已进入已发布应用 | PROBE → 否 | annotated `v3.1.11` 指向 `782415ae…`；该 commit 的 `docs/USER_GUIDE.md` 仍写“未发布候选”，而 `package.json` 将 `docs/USER_GUIDE.md` 打入应用，`src/main.js` 会导出该文件 | 不把 PR #151 的仓库文档更新误称为旧安装包修复 |
| 能否替换 v3.1.11 同版本资产 | BLOCKed by release contract | Windows Runbook 明确禁止替换或覆盖已发布同版本资产 | 保留 v3.1.11 tag/Release/资产不变，通过 v3.1.12 更高补丁版本交付 |
| v3.1.12 是否需要业务或 schema 改动 | PROBE → 否 | 缺陷只来自随包文档的时间状态；当前纠正分支相对 `main@782415ae…` 无 `src/` diff | 只改版本元数据、三份发布文档、Runbook、生成统计和发布合同测试 |

### Deviation

原发布收尾方案把正式 Release 事实放在 tag 之后的证据 PR；这对仓库记录有效，但不能改变已经从 tag 构建的安装包，因此 v3.1.11 的随包指南仍保留发布前状态。纠正方案不移动 tag、不替换资产：v3.1.12 在 tag 前把指南改为稳定表述，只声明应用版本，并以 GitHub Releases 作为公开稳定版、资产和发布时间的真相源。

### Acceptance boundary

- v3.1.12 不修改业务源码、数据库、资金规则、文件生命周期或 Excel 输出；v3.1.11 的真实数据库/UI/血缘与 Windows 验收记录继续有效，但不能替代 v3.1.12 候选包中版本号和随包指南的最小回读。
- 合并门禁为三份发布文档与 package/lockfile 一致、发布合同测试、`scan:vars`、`check:vars`、完整 `release-check`、PR CI 和 `git diff --check`；annotated tag 与正式 Release 必须在合并后另按 Windows Runbook 执行。

### Evidence

- 发布文档合同与 check-vars 合同：14/14 PASS；测试同时锁定 `package.json.build.files` 包含 `docs/USER_GUIDE.md`，以及应用内导出入口继续读取该文件。
- `npm run scan:vars`：v3.1.12，338 files / 4478 names，A-share/A-pair/A-local/B = 656/950/2705/1606；数量与 v3.1.11 相同，只更新报告版本与扫描时间。
- `npm run check:vars -- --include-minor`：相对 HEAD 与 working tree 无 `src/` diff，按设计跳过并 exit 0；v37 清单明确继承 v36 运行时变量。
- `npm run release-check`：lint/smoke PASS、unit 5377/5377、integration 48/48 scripts / 2393/2393 assertions PASS；integration runner 产生的纯时间戳与耗时刷新已还原，不进入纠正 diff。
