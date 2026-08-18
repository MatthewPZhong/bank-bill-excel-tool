# Implementation Notes

## Baseline

- Goal/spec: `changes/archive-center-file-batch-contract/spec.md`
- Initial plan/technical contract: `changes/archive-center-file-batch-contract/techdoc.md`
- Product code baseline: `main@35f11e153962c34cba0e9d4c7084e9df85c9f209`（v3.1.10 release commit）。
- Current PR merge base: `main@6f1c09236a6c36f72eb82d61dc14508adfe20eec`（PR #149 release evidence；相对产品代码基线无 `src/` 变化）。
- Previous review evidence head: `458e73f0f2861cacc0579a4bac20b45900bdb3b3`（2026-08-18 前一轮复审所用快照）。
- Current review evidence head: `001b8059ced56b9d70602c79cdd97d375020c969`（2026-08-18 本轮复审所用快照；历史复审 head 不覆盖）。
- Do not rebase or overwrite the existing dirty worktree.
- Done when: TechDoc §19、NFB-01～NFB-28、`npm run release-check`、`npm run check:vars`、真实 UI/数据库验收和文件血缘人工门禁全部闭合。

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
| linked gateway 部分覆盖是否只更新实际命中行的来源 tag | PROBE + ⚠️ 资金红线 | 新旧集合部分重叠 fixture + distinct tag/行数守恒 + 人工复核 | 未通过不得发布；不能批量给未命中历史行换 tag |
| exact-7 `batchContext` 的全部持久 consumer 是否已正确分成 file owner 与 operation owner | 已关闭（专项） | VCC/Position/Acquiring/Biz OP/Pending 的 worker、receipt、outbox 与恢复测试已通过；no-file sender 使用 exact-5，file publication/recovery 使用 exact-7 | 最终 full gate 继续回归；不得在 service/sender 恢复重复 context 校验 |
| Acquiring cancelled/failed partial 的 side owner transfer 是否跨崩溃闭合 | 已关闭 + ⚠️ 资金红线 | interrupted、prepared/reserved continuation、cancelled/failed owner transfer、legacy no-owner、complete crash、progress/outputIntent 冲突及 side/main parity 均已通过专项；最终全量门禁继续回归 | 任一后续回归失败即重开；禁止扩大 TaskRun recovery edge或退回 month/latest fallback |
| 真实 95 批数据库及 017/018/001 样本是否在本机可用 | PROBE | 最终门禁前只读定位副本；无副本则输出可执行人工步骤，不伪造结果 | 缺少真实样本不阻止代码完成，但阻止宣称真实数据库验收通过 |
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
