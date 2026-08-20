# v3.1.12 Implementation Notes

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| 当前阶段 | TechDoc 已确认；实施中 |
| 基线 | `ccfa71ffc92bb26bbf47c05efa87740d972cf209`（最新 `origin/main`） |

> 本文件从设计期开始持续记录 Decisions、Assumptions、Deviations、Evidence 和 Remaining unknowns。任何影响行为或验收的偏差必须先同步 `spec.md` 与 `techdoc.md`。

## Decisions

| 决定 | 理由 | 影响 |
| --- | --- | --- |
| 本迭代只归属 v3.1.12 | 用户明确纠正版本归属 | 不修改 v3.1.11 已发布事实 |
| 实施前先交付并评审 TechDoc | 用户明确要求 | 当前只新增 `changes/3.1.12/` 文档 |
| 生产代码必须在 v3.1.12 开发分支实施 | 当前分支名称仍属于 v3.1.11 | TechDoc 通过后先安全创建/切换分支 |
| v3.1.12 集成分支从最新 origin/main 建立 | main 已包含 v3.1.11 PR #150/#151，且 package 已预置 3.1.12 | 不从旧功能分支直接续写；无需再次 bump package version |
| 网银 freshness 只限确认期 metadata comparison | 避免误删读取稳定性、SHA、session 安全 | TechDoc §3.5 分类校验 |
| freshness 使用 lifecycle 的公共 `assertFilePlanFresh`，beforeStart 只验 session | 取证发现 eager File Task 在 beforeStart 前已有 input freshness；再加专用 guard 会重复 | FilePlan 继承 picker snapshot；失败保留审计但无业务副作用 |
| Statement 实际 workbook 读取绑定 confirmed FilePlan snapshot，并保留 start/end 稳定性 | Review 证明 direct/bill-split 路径可能在公共确认后再读源；若 reader 起点只抓新基线，公共门后稳定替换的 v2 仍可被消费 | actual execute 的 reader 起点先匹配 taskContext FilePlan snapshot，再校验 start/end；preview 仅做 start/end。这是 BSF-06 身份连续性，不计入 BSF-03 |
| 失败时序分为 public freshness 门与 actual reader 两类 | 两者副作用合同一致，但 lifecycle 进入深度不同 | 公共门：start=0/execute entry=0；reader：start=1/execute entry=1。两者均业务输出/session 成功提交/成功状态=0、failed audit=1 |
| 大账号顺序 evidence 使用 main-owned per-file block ordinal | fixed 模式前空 block 可与后交易 block 共享 `sourceRow`，按源行关联会把 M001/M002 冻结成 M002/M002 | `identifyAccountBlocks` 产生稳定 ordinal，remember/extract/order data 全链保留；renderer 不提供该身份 |
| self-input bridge 采用 raw candidate → mapped transaction boundary 两阶段归属 | 单文件多 block 可对应不同 bankId/clearingId；仅按 header window 会把上一 block 交易行里的 bankId 静默归给后块 | raw callback 只冻结 `{sourceRow, clearingAccountId}`；mappedRows 后按上一 block 最后实际 Credit/Debit 交易与当前 header 的开区间完成归属；空槽 fail closed，不重读/保存 raw rows |
| 大账号使用预检冻结的最小证据 | 避免确认前后重读源文件 | 不保存整份 raw workbook rows |
| picker snapshot input 的父目录缺失由公共 freshness 门禁裁决 | 网络盘卸载或父目录移动是可达 Windows 场景；normalize 提前 ENOENT 会破坏统一提示和 failed audit | 只对 supplied snapshot 的已缺失 input 使用确定性 lexical alias fallback；正常路径仍保留 realpath/hardlink 防护 |
| bigint Stats 时间以纳秒商/余数分别转 Number 后合成毫秒 | `Number(ns) / 1e6` 在 APFS 大 epoch 上会先丢失纳秒低位，与普通 `fs.stat().mtimeMs/ctimeMs` 严格不等 | 使用 `Number(ns / 1000000n) + Number(ns % 1000000n) / 1e6`；freshness 仍严格相等，不引入容差 |
| 启动由完整初始化后创建窗口 | 去掉半初始化 UI/IPC 双态 | 失败只显示 native dialog |
| ANALYZE 替换为 exact optimize flag | 当前 SQLite 版本适用、有界 | 仍需 Windows 阶段日志验证收益 |
| VCC 单次全量安全语义保留，计数集合化 | 本迭代不同时收缩安全范围 | 删除第二遍而非删除 gate |
| CNH 在 import mapper 变 CNY，raw audit 不改 | 同时满足业务合并与审计可追溯 | 新数据生效，历史不动 |
| canonical hash 只替换 CNH token，不改变 CNY 原文或首尾空格 | 复用现有 content_hash 比较即可兼容历史 CNY | 不新增兼容列，不复用 Pending 的 legacy_content_hash |
| Archive fingerprint 只是维护筛选器 | SHA 仍是完整性真相 | 打开/另存/迁移继续 SHA |
| 未知文件无 durable owner 就不删除 | 避免存档根内误删用户文件 | 通用 orphan 删除改只报告 |
| 迭代拆为 5 个顺序 PR | 网银、VCC、启动、存档、发布收口的风险与文件 ownership 不同 | 每个 PR 使用独立 Review Agent；前序 merge 后再派生后序分支 |
| 每个 PR 采用 Dev→Review→Finding 修复→同 Reviewer 复审闭环 | 用户明确规定本地质量流程 | Dev 为 5.6 sol high；Reviewer 为 5.6 sol Ultra；无阻碍性 P3 才允许推送 |
| 项目负责 review 不接受过度防御 | 用户明确要求 | Finding 必须有真实入口/状态/数据证据；不为反复且不可能出现的 case 加 guard |

完整技术决定见 TechDoc D-01～D-21；D-21 是首轮实现评审对既有 BSF-05 统一失败合同的技术收口，不扩大产品范围。

## Assumptions

| 假设 | 依据 | 失效影响 | 验证/回滚 |
| --- | --- | --- | --- |
| 用户诊断中的主库约 2.9GB，ANALYZE 为首要耗时 | 用户提供的同事分析与当前无参数 ANALYZE 代码 | 性能优先级可能变化 | 阶段日志 + Windows packaged 对拍；不影响替换 ANALYZE 的正确性 |
| preview 阶段现有解析结果足以生成大账号最小证据 | 当前 preview/fileEntries 与识别函数 | 可能仍需补充一个识别字段 | red test 先验证；只加最小字段，不回退重读源文件 |
| 新增 nullable 列可由旧版 SQLite schema 读取忽略 | SQLite additive columns 与当前 repository 显式列访问 | 3.1.11 回滚可能有未知查询依赖 | 兼容 smoke；必要时仅回退代码、不删列 |
| 首次进入维护期间列表可并发只读 | 当前 controller/service 有 operation gate | 可能出现刷新竞态 | selected batch 以 id 重查；删除阶段检查 active task |

## Deviations

| 原计划/合同 | 实际 | 原因 | Spec 是否同步 |
| --- | --- | --- | --- |
| TechDoc 初稿基线为 `574562b` 的 v3.1.11 功能分支 | 实施基线改为最新 `origin/main@ccfa71f` | main 已合入 v3.1.11 发布证据和 3.1.12 版本预置；必须包含这些提交 | 是 |
| TechDoc 初稿把唯一 freshness 放在 `beforeStart` | 改为公共 `assertFilePlanFresh` 使用 picker snapshot；`beforeStart` 只校验 session | 实际 TaskLifecycle 在 beforeStart 前已比较一次，旧设计会违反“每次尝试一次” | 是 |
| PR1 首版大账号 evidence 在 stage 时再次全量读取源文件 | 改为首次预检 workbook 读取期间派生最小 recognition basis，stage 只匹配并冻结 | 独立 Review 证明首版实现违反“复用预检已有读取”的性能/证据合同 | TechDoc 原合同不变，无需改 Spec |
| PR1 首轮读取稳定性以 reader start 作为新基线 | actual execute 改为 FilePlan confirmed snapshot → reader start → reader end 连续校验 | Review Round 2 证明公共 assert 与 reader start 之间的稳定替换可绕过首轮实现 | TechDoc 已反向同步；Spec BSF-06 原合同不变 |
| PR1 首轮大账号 evidence 以 `sourceRow` 关联 preview row | 改为 main-owned per-file block ordinal | Review Round 2 证明 fixed 前空 block 与后交易 block 可共享 source row，污染记住顺序 | TechDoc 已反向同步；Spec 不变 |
| TechDoc 首轮把所有 freshness/reader 失败都表述为 execute=0 | 区分 public assert 失败与 actual reader 失败的 lifecycle 进入深度 | Review Round 3 实测证明 reader identity/start/end 失败时 File Task 已 started 且 execute 已进入；execute entry 不等于业务副作用 | TechDoc §3.3/§9.1/§10.1 已同步；Spec 不变 |
| PR1 self-input bridge basis 只保留全文第一个 clearingId | 改为按 per-file block ordinal 对齐的最小 bridge 数组 | Review Round 3 真实多 block 取证证明 BANK1/BANK2 会被冻结成 M001/M001，可污染记住顺序 | TechDoc §3.4 已同步；Spec 不变 |
| PR1 Round 3 修复仍以“上一 header 后至当前 header 前”作为后块 bridge window | 改为 raw callback 冻结带 sourceRow 的候选，mappedRows 后按上一 block 最后实际交易完成归属 | Review Round 4 六行样例证明上一 block 交易备注 `Memo=BANK1` 仍会令无账号的 block2 误冻 M001；任意缩短窗口不能证明格式边界 | TechDoc §3.4 已同步；Spec 不变 |
| PR1 bigint stat 首版用 `Number(ns) / 1e6` 统一普通/BigInt Stats | 改为商/余数转换，并让所有 picker test fixture 复用 `sourceSnapshotFromStat` | 合并前全量单测与 1000 次 APFS probe 证明旧转换约 25% 与普通 Stats 相差 0.0002–0.0003ms，严格 freshness 会误报源文件变化 | Spec/TechDoc 行为合同不变；仅修正同一物理 stat 的数值兼容 |

## Evidence

| 证据 | 结果 | 覆盖范围 |
| --- | --- | --- |
| Git baseline/status | branch `codex/v3.1.11-archive-file-batches`，HEAD `574562b`；工作树存在用户 untracked 文件 | 明确 ownership；不清理、不覆盖无关文件 |
| source snapshot 代码审计 | 已有 size/mtime/ctime/ino 比较 | 网银快照复用 |
| statement 调用图审计 | selection/preflight/big-account/order 存在重复 freshness 与重读 | 唯一确认点设计 |
| TaskLifecycle 审计 | beforeStart 位于 reserve 后、execute 前 | 失败副作用边界 |
| FilePlan 二次取证 | eager lifecycle 在 beforeStart 前无条件执行 `assertFilePlanFresh`；normalize 默认重新捕获 input snapshot | 采用 picker snapshot 注入公共 FilePlan，禁止专用 guard/skip |
| database/startup 审计 | 每启 ANALYZE、默认 initPending 窗口先行 | 启动根因与目标时序 |
| VCC lineage 审计 | post-outbox + 显式 sync 两遍；activeReferenceCount per-source | 删除重复与集合查询 |
| VCC mapper/importer 审计 | 全部参与币种字段、rawJson、hash version、per-subject error 已定位 | CNH/CNY 设计与幂等边界 |
| Archive root/service 审计 | 迁移状态机已有；startup evidence/health/orphan 过重 | 迁移保留与首次进入维护拆分 |
| 文档一致性检查 | Spec、TechDoc、Preflight 与 Implementation Notes 已按 PR1 实际时序和评审结论反向同步 | 不保留已关闭 BLOCK 或与实现矛盾的副作用描述 |
| 远端基线与分支 | `origin/main@ccfa71f`；已创建本地 `v3.1.12` 跟踪分支；package 为 3.1.12 | 版本隔离与实施起点 |
| 远端集成分支 | `origin/v3.1.12@ccfa71f` 已创建；PR1 本地分支 `codex/v3.1.12-pr1-statement` | 后续 PR 目标分支与顺序合并基线 |
| PR1 Dev 首轮定向测试 | 178/178 PASS；核心 FilePlan 合同 75/75 PASS；语法与 diff 检查 PASS | picker snapshot、唯一公共 comparison、冻结 evidence 初版 |
| PR1 根侧完整单测 | 首轮日志 `unit-20260819-160159.log` 为 5395/5395 PASS；bigint 修复后最终日志 `unit-20260819-234939.log` 为 5398/5398 PASS | 全仓单测回归；精度红测及测试夹具回归均已纳入最终绿测 |
| PR1 smoke | `npm run smoke` exit 0，最终输出 `smoke test passed` | `normalizeInputFilePaths` Risk-sensitive 命中的硬门禁 |
| PR1 check-vars | 命中 Important-skeleton `normalizeCell/readRows` 与 Risk-sensitive `normalizeInputFilePaths`；均为新增/移动调用点，未改定义、签名或规范化口径 | PR body 必须追加关联功能 review；Windows 中文路径仍列人工验证 |
| PR1 Review Round 1 | 接受 1 个 P1（确认后实际读取稳定性）与 2 个 P2（父目录缺失提前 ENOENT、evidence 二次全量读）；根侧另补 fuzzy fallback 语义回归 | 全部退回同一 Dev；同一 Reviewer 修复后复审 |
| PR1 Review Round 2 | 接受 2 个 P1：fixed 空 block 的 sourceRow 碰撞；公共 assert 与 reader start 间稳定替换绕过 | 分别改为 main-owned block ordinal 与 FilePlan snapshot 连续绑定；补资金/状态副作用回归 |
| PR1 Review Round 3 | 前两个代码 P1 真实 probe 通过；接受 1 个 P2 文档时序矛盾与 1 个 self-input 多 block P1 | 文档区分 public/reader lifecycle；bridge 改为 per-block 冻结并补资金/状态回归；Spec 不变 |
| PR1 Review Round 4 精确红测 | raw rows 为 row1 BANK1 metadata、row2 header、row3 前块交易 `Memo=BANK1`、row4 后块无账号、row5 header、row6 后块交易；旧实现 actual `M001/M001`，expected `M001/空槽` | 证明 header window 不能单独承担 bridge 归属；触发资金红线修复 |
| PR1 bridge ownership 修复聚焦测试 | Reviewer 文件 `statement-big-account-preview.test.js`：24/24 PASS；6 个 modified unit 文件合跑：149/149 PASS | 覆盖 Reviewer 精确样例的 block2 空槽与 extract `failedRows`、BANK1/BANK2 正向双 block、前空 block、fixed/unfixed、parent/child、自定义多币种歧义、fuzzy 合同；并复验 FilePlan/source snapshot/task lifecycle |
| PR1 bridge 空槽消费旁路扫描 | fixed auto-match 原 helper 会 `filter(Boolean)` 压缩空 ordinal；已改为保留槽位且调用方要求 `every(Boolean)` 才匹配保存顺序 | 防止部分识别文件绕过 evidence extract 的 `failedRows` 合同；属于同一账号误归资金红线修复 |
| PR1 最终自动门禁 | `npm run test:unit` 5398/5398 PASS；`npm run test:integration` 48 脚本、2393/2393 PASS；`npm run smoke` PASS；`npm run lint` PASS；`git diff --check` PASS | release-check 的 unit/integration/smoke 三层已逐项取得 exit 0；此前外层 release-check 空挂不作为成功证据 |
| PR1 bigint stat 精度红绿测试 | synthetic 大 epoch `1763597869000000123ns`：旧实现得到 `1763597869000`，普通 Stats 等价值为 `1763597869000.0002`，红测失败；商/余数修复后 `archive-source-snapshot.test.js` 4/4 PASS | 证明修复针对精度转换；另以 +0.001ms 反例断言仍为 changed，未放宽安全比较 |
| PR1 ArchiveService 隔离复跑 | `archive-service.test.js` 全文件 43/43 PASS；曾加 DEBUG 的“业务引用锁”“blob 元数据失败恢复”两场景循环 20 次，40/40 PASS | 排除 ARCHIVE_SOURCE_CHANGED 误报对 service hold/retry 状态机的随机污染 |
| PR1 六文件聚焦复跑 | 首次发现旧测试 fixture 仍手写 `Number(mtimeNs)/1e6`，唯一失败 1/151；fixture 改为公共 snapshot 后单次 151/151 PASS，整组循环 10 次 1510/1510 PASS | 覆盖 FilePlan、source snapshot、task lifecycle、operation tracker、Position 与 Statement；仓库 `src/tests` 已无目标 DEBUG 或有损时间公式 |
| PR1 Review Round 4 最终复审 | P0/P1/P2/P3 均无发现，明确“无阻塞 P3+”；APFS 2000 次采样旧公式 mismatch 506、新公式 0；跨 BigInt/普通 stat 1000 次误报 0，真实变化仍严格失败 | bigint 时间换算、inode string、FilePlan/ArchiveService/Statement reader 共用快照合同与 DEBUG 清理均独立通过 |
| PR #152 Windows CI inode 兼容红测 | Windows 普通 Stats 返回 unsafe Number inode `23362423067021943`，按既有合同省略；BigInt Stats 保留 string，旧测试因 whole-object deepEqual 失败，但 size/mtime/ctime 严格一致且双向 matcher 均应成功 | 测试改为严格比较三项，普通 snapshot 有可靠 inode 时再要求相等、否则明确断言缺失；synthetic safe/unsafe inode 与真实变化 false 均保留；Source Snapshot/FilePlan/ArchiveService/Statement 合跑 91/91 PASS，node check/diff check PASS |
| PR1 Review Round 5 | P0/P1/P2/P3 均无发现，明确“无阻塞 P3+”；独立 Windows 合成 probe 证明 unsafe regular inode 省略、BigInt inode 精确保留、跨 Stats 双向兼容，且 final FilePlan 对同 size/time 的 inode+1 仍拒绝 | 本轮仅修测试与记录，生产合同未改；聚焦 123/123 PASS，无 DEBUG/console 残留 |

## Remaining unknowns

| 未知 | 分类 | 下一步 | 发布影响 |
| --- | --- | --- | --- |
| TechDoc D-01～D-20 是否获用户同意 | CLOSED | 用户已确认 | 已允许实施 |
| Windows 正常启动是否达到 70% | PROBE/RELEASE | 四变体各≥5次 packaged 对拍 | 未达到不得宣称验收通过 |
| optimize 后各阶段真实占比 | PROBE | 启动阶段日志 | 可能调整后续性能优先级 |
| VCC 各来源真实样本资金守恒 | FUND RED LINE | 人工逐来源核对 | 未签字不得发布 |
| 网络盘/同步盘 fingerprint 与迁移表现 | ENVIRONMENT | Windows/实际存档根故障矩阵 | 失败则保持 SHA/fail-closed，阻断对应环境发布 |
| GitHub CLI 鉴权 | CLOSED/降级路径 | `gh auth status` token 失效，但 git push 凭据可用，且已确认 GitHub connector 提供 create/merge PR | PR 创建与合并走 connector；CLI 仅作为不可用 fallback，不阻塞流程 |
| PR1 首轮 Review findings | CLOSED | 原 Dev 逐项修复，同一 Reviewer 多轮复审后确认无阻塞 P3+ | 仍保留 Windows 真实银行样本人工复核，不阻塞代码合并 |
| PR1 bridge 归属 P1 | CLOSED | 两阶段归属、空槽 fail-closed、正反真实 CSV 与 Reviewer 复审均通过 | ⚠️ 账号归属资金红线仍需发布前人工签字 |
| PR1 bigint stat 兼容回归 | CI GATE | 精度转换、本地门禁与 Reviewer Round 5 已通过；PR #152 以最新 Windows required check 为合并真相 | required check 未绿不合并；生产 matcher 合同未改，Windows picker/final 均使用 BigInt Stats |

## PR2 — VCC CNH→CNY

### Task Brief

- Goal：仅对 v3.1.12 后新导入的 VCC 财务 OP 数据，将标准大写 `CNH` 在业务层归一为 `CNY`，保留原始审计，并维持九币种输出。
- Context：明细业务字段与 content hash 在 `row-mapper.js` 形成；detail importer 的 staging/同批/effective 幂等判定统一使用 `content_hash`；系统 OP 已按主体隔离校验错误。
- Constraints：不迁移/回填/重算历史；不放宽小写/混合大小写；规范哈希只投影本行实际参与业务的币种单元格，并保留原单元格首尾空格；不得改 PR1 行为。
- Done when：四类实际明细币种入口、Pending 双侧、系统 OP、幂等 skip/conflict、raw audit、金额/行数守恒和九币种输出均有自动化证据；人工资金复核项明确保留。

### Unknowns Register

| 未知 | 处理 | 证据/结论 | 合并影响 |
| --- | --- | --- | --- |
| detail importer 是否存在绕过 canonical content hash 的比较入口 | PROBE → CLOSED | `markConflictRows`、`markExistingIdenticalRows`、同批 mixed key 与 promote 均读取 mapper 写入的 `content_hash` | mapper 单点形成规范哈希即可，无需改 importer SQL |
| 通道未选中币种列是否会参与校验或哈希 | PROBE → CLOSED | `mapChannel` 已按 CITI / billdate 月末分支只读取一个币种字段；红测需证明其他两列脏值不影响结果与哈希 | 必须按实际分支投影，禁止全行 CNH 替换 |
| 系统 OP 坏主体是否会阻断其他主体 | PROBE → CLOSED | `rowsBySubject` + `invalidSubjects` + per-subject `buildSubjectSnapshot` try/catch 已隔离；import 统计以 `validationUnitCount` 按主体计 | 复用现有主体级失败，不改批次失败策略 |
| 历史 CNY hash 能否与新 canonical hash 兼容 | PROBE → CLOSED | CNY 原单元格字节不改时 hash 算法和 payload 结构不变；历史 CNY exact replay / 新 CNH 同位置投影红绿测试已验证 | 不新增兼容 hash 列 |
| Pending current hash version 升级是否会污染一次性历史 raw-contract 迁移 | PROBE → CLOSED | `migrations.js` 原先直接引用 current `PENDING_HASH_VERSION` 且遍历全部 Pending 行，会把历史 v2/新 v3 重写 | 旧迁移冻结 v2 且仅处理 `<2`；既有 v2 与新 v3 启动零改写 |
| dataset writer 是否用 current mapper version 校验历史 artifact/fallback | PROBE → CLOSED | ready artifact 与 fallback 两路都强制 `mapped.hashVersion === stored.hash_version`；版本升级会误拒历史 v1/v2，历史 CNH 的 current hash 也不同 | 按 stored version 使用对应旧/新算法严格重算，不跳过 hash、不更新 stored 行 |
| 系统 OP 同主体 CNY/CNH 是否可跨文件绕过重复拒绝 | PROBE → CLOSED | 单文件 `buildSubjectSnapshot` 查重，但多文件各自成完整 snapshot 后只按余额 hash 分类；相同余额会 accepted+skip | 批次主体分类前汇总 sourceCurrency 证据；仅 CNY+CNH 双写主体转 validation error |
| 系统 OP 某文件同主体另有软错时，完整文件快照是否会旁路提升 | PROBE → CLOSED | 完整 CNY 文件可产 snapshot，而 CNH 文件因 USD 空余额不产 snapshot；只扫 snapshot 会错误提升 CNY 文件 | 独立 `auditRowsBySubject` 在主体/币种识别后即保留行证据；同批以主体的 validation/CNY+CNH 并集先排除所有该主体 snapshot |
| 通道 early anomaly 能否在 common 校验前确定 canonical 字段且保留 assigned subject | PROBE → CLOSED | CITI 仅由通道名确定交易币种；非 CITI 仅由有效 billdate 确定清算/结算；early hash 若使用尚未赋值的 `row.subject` 会丢失主体边界 | 只有 key 与分支足以确定时提前投影，并显式沿用调用方 assignedSubject；无法确定时保持 raw hash，禁止猜测 |

### PR2 Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 在 row mapper 共享词法函数中返回 source token 与 business currency | TechDoc D-05～D-08；system importer 可复用相同严格大小写合同 | 在 calculator/output 末端转换；对全行所有 CNH 做替换 | 新业务字段入库即为 CNY，raw JSON 不变 |
| mapper 只对实际参与币种索引构造 canonical hash 副本 | 保持未选中脏列现有行为与其他原文字节冲突合同 | trim 全行、重写 raw JSON、额外兼容 hash 列 | CNY 原文 hash 不变；仅同位置 CNH token 投影 |
| 旧 Pending raw-contract 迁移版本在 migration 内具名冻结为 v2，并只处理 `<2` | current version 继续升高不能成为历史重写开关 | 继续 import current version；仅冻结数字但仍遍历全部行 | 待补旧行迁至 v2；既有 v2、新 v3 和 raw audit 完全不动 |
| dataset writer 依据 stored hash version 选择重算算法 | 导出仍需强 lineage integrity，不能把版本不等当内容损坏，也不能跳过 hash | 放宽/忽略 hash；把历史行更新到 current；新增兼容列 | 普通 v1、Pending v2 与 current v2/v3 均可从 ready/fallback 精确重建 |
| 系统 OP snapshot 暂存 sourceCurrency evidence 供批次级双写检测 | snapshot 的 canonical balances/hash 已丢失 CNY/CNH 写法差异 | 把所有同主体多文件都拒绝；仅比较余额 hash | 只拒 CNY+CNH 双写；纯 CNY/CNY、CNH/CNH 继续既有 skip/conflict |
| 被主体级拒绝的系统 OP 行写入 `system_snapshot_attempts` 的 rolled_back raw audit | anomaly 表没有 raw JSON；原文件 artifact 不能替代逐行 source/normalized 证据 | 给 anomaly 表加列；只留错误描述；丢弃软错行 | 不写有效 snapshot；同文件/跨文件每个来源均可查询完整 raw JSON，坏余额行也保留原值与 validation evidence |
| 在既有 adjustment/archive 集成链中把充值 fixture 替换为真实 XLSX import | 复用现有计算、结果、归档、Excel 断言，避免复制整套夹具 | 新建重复的全链脚本；仅 SQL seed | 三行 USD/CNY/CNH 从真实 parser 进入，CNY+CNH 合并为 CNY=5，raw/check 仍显示 CNH，结果与归档仅九币种 |

### PR2 Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| PR2 修改前定向基线：`node --test tests/unit/backend/vcc-financial-op/row-mapper.test.js tests/unit/backend/vcc-financial-op/detail-importer.test.js tests/unit/backend/vcc-financial-op/system-op-importer.test.js` | 72/72 PASS | mapper、detail importer、system importer 当前基线；旧测试仍明确拒绝 CNH，作为红测改造起点 |
| PR2 首轮红测 | 71 PASS / 8 FAIL（预期失败） | CNH 词法、业务归一、canonical hash、Pending、system 主体重复的生产缺口得到可重复证据 |
| PR2 聚焦回归：mapper + system importer | 48/48 PASS | 完整字段矩阵、trim/大小写、未选中通道列、CITI/non-CITI early anomaly hash、assignedSubject hash、同/跨文件双写、软错主体并集、完整 raw audit |
| PR2 最终扩展 unit：`node --test tests/unit/backend/vcc-financial-op/*.test.js tests/unit/main-process/vcc-financial-op-dataset-writer.test.js tests/unit/main-process/vcc-financial-op-service.test.js` | 367/367 PASS | VCC importer/calculator/result/output、Pending 冻结迁移、system 主体审计与历史 dataset writer lineage |
| PR2 真实 XLSX 派生链：`node scripts/integration/vcc-financial-op-adjustment-archive-chain.js` | 226/226 PASS | XLSX 三行导入→CNY/CNH 金额合并→九币种计算/复核→raw/check Excel 保留 CNH→结果 Excel/归档无 CNH→跨月继承 |
| PR2 相关 integration | destructive state 77/77、effective result 19/19、historical template export 29/29，均 exit 0 | 归档/解归档、结果读取、历史月份模板导出没有回归 |
| PR2 smoke/lint/diff | `npm run smoke` PASS；`npm run lint` exit 0；`git diff --check` exit 0 | 全局 smoke、生产源码静态检查与补丁格式 |
| PR2 important variables | `npm run check:vars`：改动 5 个 `src` 文件，未命中任何重要变量 | 无额外 Important-skeleton / Runtime-state / Risk-sensitive review 清单 |
| PR2 Review Round 1 | 关闭 P1：第 17+ 列错误不再早于标准列审计，完整 CNY snapshot + extra-column CNH 行会主体级拒绝且 raw audit 保留 10 行；关闭 P3：通道 invalid_key 只要实际币种列可判定也使用 canonical hash | 聚焦 mapper/system 50/50 PASS；扩展 unit 366/366、真实派生链 226/226、lint/diff 均 exit 0 |
| PR2 Review Round 2 | 收窄第 17+ 列兼容边界：仅目标月且主体可识别时保留标准列审计并归属主体；其他月份、非法日期、目标月空主体恢复单条 unknown 第17列异常，不新增日期/主体双 anomaly | 四条真实 workbook 边界（含原 PPHK/CNH 旁路反例）通过；聚焦 51/51、扩展 unit 367/367、lint/diff 均 exit 0 |
| PR2 Review Round 3 最终复审 | P0/P1/P2/P3 均为 0，当前实际 diff 无阻塞 P3+；独立 live audit 同样未发现可达问题 | Reviewer 聚焦 110/110、扩展 VCC 367/367、真实 XLSX 全链 226/226，lint、全部改动 JS `node --check`、diff check 均通过；保留发布前人工资金红线 |
| PR2 根侧完整发布门禁 | `npm run release-check` exit 0：lint、smoke、全量 unit 5418/5418、48 个 integration 2410/2410 全部通过；`npm run check:vars` 未命中重要变量 | GitHub PR/Windows required check 前的本地合并门禁已满足；自动同步的集成测试清单随新增 17 条断言一并提交 |

### PR2 Remaining / Human Review

| 项目 | 状态 | 发布要求 |
| --- | --- | --- |
| 真实资金样本逐入口核对：recharge、fee_fx、CITI、非 CITI 清算/结算、Pending 双侧、system | ⚠️ FUND RED LINE | 人工核对源行数、主体、正负号、分币金额、source/normalized currency、幂等 disposition、raw/check 与最终九币种 Excel；未签字不得发布 |
| PR2 行为偏差 | NONE | 固定 Spec/TechDoc 合同未改变；历史 hash/记录/读取只做版本感知兼容，不迁移/回填 |

## PR3 — Windows 启动治理

### Task Brief

- Goal：完整初始化成功后才开放 IPC/窗口，以 exact SQLite optimize、单次集合化 VCC 安全 gate 和非关键存档维护移出启动降低 Windows 首窗耗时，同时保持所有安全恢复 fail-closed。
- Context：旧产品路径先创建 loading 窗口并暴露 `initPending` 双态；主库每启无参数 `ANALYZE`；VCC 在 Archive post-outbox 与 main 显式调用两遍；Archive 启动还承担历史扫描、目录物化与保洁。
- Constraints：不删除/改写 SQLite/WAL、migration journal、outbox、owner/中断任务或安全恢复；不收缩 VCC gate 为脏来源；不实现 PR4 首进维护主体；不伪造 Windows 70% 结果；不修改 PR1/PR2 合同。
- Done when：初始化前 window/handlers 均为 0；失败仅一次 native dialog 并退出；exact optimize 且错误上抛；一次全量集合 VCC gate；关键 Archive 恢复 fail-closed；阶段日志闭合；packaged runner 提供四变体、轮换、独立 golden、阶段/WAL/SHM/恢复数据和独立场景。

### PR3 Unknowns Register

| 未知 | 处理 | 证据/结论 | 合并影响 |
| --- | --- | --- | --- |
| `activate` / `second-instance` / renderer 自启动 invoke 能否绕过初始化屏障 | PROBE → CLOSED | 产品只有 `createWindow` 能创建业务窗；两事件均加 `applicationStartupComplete`/窗口存在屏障；IPC 在完整 init 后统一注册，renderer 的独立 VCC invoke 无 handler 可提前调用 | 静态合同测试必须同时覆盖注册、建窗、show 时序 |
| Archive root/outbox/owner/interrupted/物理恢复中哪些可移出启动 | PROBE → CLOSED（Round 1 修正） | root 可用性、owner/outbox、flow intent、interrupted task/artifact 数据库状态与 post-outbox VCC 属启动 admission；`.staging/.readonly`、cleanup journal、dangling reference、released Blob/Artifact 物理删除、retention/layout/orphan/health/ownership 全部交 PR4 | 关键状态恢复任一失败阻断启动；物理维护通过 version=1 DTO 显式列出，未知 transient 无 owner 永不删除 |
| 迁移已 switch 但旧根 cleanup 是否可在启动静默删除 | BLOCK 候选 → CLOSED | TechDoc 要求保留 migration journal 且 PR4 接管非关键维护；`cleanup-pending` journal 与旧根均保留，首次进入维护可沿既有状态机完成 | 禁止把整个 reconcile 删除；只延迟可恢复 cleanup，不丢恢复证据 |
| VCC 全量引用集合是否能兼容旧 schema/null/system-only/hold | PROBE → CLOSED | 启动时按实际存在表构造单条 `UNION ALL ... GROUP BY`；null 不入集合；system snapshot 单独形成引用；hold 释放使用同一不可变计数 map；旧表先补列再建 partial index | 禁止按 dirty source 缩窄；每启只查询一次集合 |
| packaged 对拍如何区分稳态、一次性迁移/VACUUM、崩溃恢复 | PROBE → CLOSED（Round 1 加固） | runner 显式支持三场景；非稳态每轮重置独立 userData/Documents；crash 强制非空合法 WAL 与仅存在 WAL 的 setting sentinel，关闭整树后再从无 sidecar 主库副本验证 checkpoint | PR5/Windows 分场景产生独立报告；缺样本仍为 not-evaluated |

### PR3 Decisions / Deviations

| 项目 | 决定/实际 | 原因与影响 | Spec 同步 |
| --- | --- | --- | --- |
| 初始化 admission | `initializeApplication → registerAllIpcHandlers → await createWindow(loadFile + ready-to-show) → applicationStartupComplete` | 初始化失败前 BrowserWindow/IPC 均为 0；load/ready 失败销毁隐藏窗后走统一 native failure | 固定合同，无偏差 |
| 启动失败兜底 | fallback log path 解析和日志初始化同在 try；空日志路径/写入失败仍 dialog 一次、exit(1) | 避免路径解析本身抛错绕过用户可见失败 | 固定合同，无偏差 |
| SQLite | 删除产品无参数 `ANALYZE;`，精确执行 `PRAGMA optimize=0x10002;` 且不吞错；不碰 WAL | 有界更新统计；optimize 失败进入统一启动失败 | 固定合同，无偏差 |
| VCC | post-outbox hook 是唯一入口；各引用表一次 `UNION ALL` 集合聚合并复用；system snapshot 补列后建 partial index | 保留全量 lineage/hold 安全语义并消除逐 source 查询与第二遍 gate | 固定合同，无偏差 |
| Archive | `recoverStartupSafety` 只收口 interrupted artifact 数据库状态，不扫描/删除目录或 Blob；root/outbox/所有 owner/flow/sweep 任一不完整均阻断；pre-switch 未完成 journal 永不以 source 可用为由放行 | version=1 DTO 按 §6.6 列出 cleanup-journal、blob/artifact metadata（含 dangling repair）、retention、owned-orphans 及其余 PR4 阶段；保留 source delegate/journal 只为下次恢复，不等于本次 admission 成功 | Round 1 修正实现理解，Spec 合同未变 |
| 阶段日志 | database open/migrations/vacuum/optimize、archive root/outbox/VCC、template、window create/load/ready、startup-total 全部 start/end；failed 只写通用消息与 code | success/failed/skipped 可测且不泄露路径/原始错误文本 | 固定合同，无偏差 |
| 测量 | 四个固定 label、每变体至少五轮轮换；3.1.11/3.1.12 均以 renderer total-init 为完整 ready，3.1.12 另要求 window-ready+startup-total；adapter 在 spawn 紧前记录 processCreatedAt，ready 证据先于任何 CIM 读取，取时后按 token-matched ownership tree 关闭；VACUUM/恢复场景严格隔离 | baseline/ready 前 CIM、退出耗时和 golden 复制均不进入 external full-ready；CloseMainWindow 必须有受理 receipt，超时/非零退出强制失败；结论恒为 not-evaluated | 同一用户可用终点公平对拍，不在 3.1.12 renderer 尾段前停表 |

### PR3 Review Round 1 裁决与修复

| Finding / 裁决 | 修复与证据 | 边界 |
| --- | --- | --- |
| 启动删除未知 transient、cleanup job、dangling/released Blob | `recoverStartupSafety` 仅 `markInterruptedArtifacts`；真实 tmp fixture 证明未知 `.staging/.readonly`、layout、Blob、cleanup job 全保留 | PR4 必须消费完整 version=1 DTO；无 durable owner 的未知 transient 永不自动删除 |
| pre-switch journal 故障仍放行 source | maintenance request 与 target copy/verify 故障返回 `ok:false`，Controller root phase fail-closed；source delegate/journal 保留供下启恢复 | 不清 journal、不回滚或伪造迁移完成 |
| owner 异常和 post-flush inventory fail-open | 全部 owner 继续 settle 后统一 AggregateError 阻断；flush 后 `list()` 任一 DB/I/O 异常抛 `ARCHIVE_STARTUP_OUTBOX_INVENTORY_FAILED` | 不再依赖模块自报 `blocksArchiveStartup` |
| startup-total 覆盖不全、usage 非关键语义被误改 | total 在 whenReady callback 首个启动动作开启并包住 logger/init/handlers/window；usage 保留 warning+default graceful 降级 | usage 尝试耗时纳入 total，但不成为 admission 条件 |
| 补窗污染首次 metrics | 显式 initial/supplemental instrumentation；仅 initial webContents 首次 renderer payload 可写 snapshot | 不以调用次数推断窗口身份 |
| load 后 ready 前失败与 show throw 悬挂 | 可执行 readiness seam 覆盖 closed/render-gone/did-fail-load/timeout/listener cleanup；show/send 成功后才 settled/resolve | 任一失败销毁隐藏窗并只走统一 native failure |
| runner 不兼容未改 3.1.11、计时混入枚举/退出 | legacy renderer-ready 与新 phase-ready 分流；processCreatedAt 由 adapter 在 spawn 前记录；ready 时固定 external 指标，随后关闭 | 不要求旧包 auto-quit/phases；不把 app 内 marks 当验收时钟 |
| installer/portable 真实树未治理 | Windows adapter 注入 snapshot/spawn/exec/clock；首版以同 basename / 首次 token 前 ParentProcessId fallback 捕获 reparent，Round 2/3 动态证明两者均会误收无关程序后已全部删除，最终仅沿 spawn root 的 current token-matched parent frontier扩展；CloseMainWindow 后等待，失败清理由后续 Round 5 再加固为动作内 token 复验 | Windows 真包路径与窗口行为仍由 PR5 人工/数据验证 |
| migration/crash 场景证据为空壳 | VACUUM 前 flag 非 1、后 flag=1 且新版 phase success；WAL > header/合法 magic，setting 只在 WAL 可见，graceful close 后无 sidecar DB 副本仍可见 | journal sentinel 若提供则单列消费证据，不拿任意文件删除冒充 WAL 恢复 |

### PR3 Review Round 2 裁决与修复

| Finding / 裁决 | 修复与行为证据 | 边界 |
| --- | --- | --- |
| crash preflight 直接打开 timed DB，创建/改写 SHM 并把 WAL recovery 移出计时 | WAL magic 只读输入文件；base/WAL sentinel 均在 disposable golden clone 打开，`finally` 删除 probe；红测逐字节比较 timed main/WAL/SHM 的 size+SHA-256 且 probe 路径消失 | preflight 耗时排除，但绝不预热/恢复 timed sample |
| 永久 `knownPids` 在 parent PID A→B 复用后误纳入 B 的 child | ancestry 只从本次 CreationDate/path/cmd token 仍匹配的 live frontier 扩展；token mismatch parent 与新 child 均不 close/taskkill | `knownPids` 仅作历史观测，不再授予 ownership |
| baseline 后任意同 basename seed 会误收用户另启程序 | 完全删除 basename fallback；ExecWait wrapper 存活时沿已取 token 的 root parent 链；Round 3 又证明首次 token 前仅凭 ParentProcessId 仍可误收 baseline/PID-reuse child，最终该分支也删除 | root 在取得权威 token 前退出时以 `PROCESS_OWNERSHIP_UNESTABLISHED` fail-closed，不猜 ownership、不 close/taskkill |
| ready poll 先跑全系统 CIM，把 runner 400ms+ 开销计入 external 指标 | `waitForFullReady` 每轮先读 metrics，ready 前不 refresh tree；ready 时立刻固定 external 时间，再做进程树/关闭取证 | Windows 真机仍需核对 metrics 文件可见性与杀毒软件影响 |
| tree 空/进程 code=9 仍记 graceful success | ready 后要求非空 owned live target；PowerShell 仅将 `CloseMainWindow()` 返回 true 的 PID 写 receipt；无 target/无 receipt/非零 root exit/等待超时均失败并 force cleanup | renderer helper 无主窗允许无 receipt，但至少一个 owned 主窗必须接受关闭 |
| normal 场景可携带 WAL/recovery 或未完成 VACUUM，污染 steady median | CLI 拒绝 WAL/SHM/recovery args；牺牲 golden clone 验 vacuum flag=1 与 archive active/pending/intents=0，timed WAL 必须无 frame；新版 post 要求 vacuum skipped，archive pending 与 VCC failed/pending/released 为 0，legacy 至少 flag 保持 1 | migration-vacuum/crash-recovery 必须分报告运行，不能并入 normal；VCC `bound>0` 是每启稳态安全核验，不能误判为恢复污染 |

### PR3 Review Round 3 裁决与修复

| Finding / 裁决 | 修复与行为证据 | 边界 |
| --- | --- | --- |
| root 首次 token 前 ParentProcessId fallback 可误收 baseline stale child 或 root PID 复用后的 child | 删除该 fallback；baseline exact token 永不进入 live frontier；未建立 root token 即退出统一 `PROCESS_OWNERSHIP_UNESTABLISHED`，force cleanup 不触碰未知 PID | portable/installer 必须依赖真实 wrapper 在首次 ownership snapshot 前存活；否则样本失败而非猜测 |
| tree 空但未消费 root `exitPromise`，code=9 仍被记为 graceful success | tree 退出后有限等待并消费 `exitPromise`；只有 `code===0 && signal===null` 成功，null/timeout/signal/非零均失败；失败样本仍进入 cleanup | CloseMainWindow receipt 只证明请求受理，不能替代进程终态证据 |
| normal schema-less golden 与 3.1.11/3.1.12 DDL 污染 | normal 强制同一份 exact v3.1.12-current 且向后兼容 golden；计时前分别在 3.1.11/3.1.12 portable disposable clone 启动并比较 `sqlite_schema` SHA-256 fingerprint 不变，显式要求 `vcc_fin_op_system_snapshots.import_source_id` 与 partial index | 禁止按 variant canonicalize；任一版本族产生 DDL 则整个 normal 报告拒绝 |
| normal post 把 VCC `bound>0` 误当恢复 | 只拒 `archive-outbox.pendingTerminalBatches/tasks` 与 VCC `failed/pending/released` 非零；`bound` 是每启全量安全核验计数，允许非零；vacuum 必须 skipped，两 phase 必须 success | 不以“所有 counts=0”粗暴判定稳态 |
| migration/crash 双向场景污染 | migration 拒绝 WAL/SHM/recovery/wal-sentinel，使用独立旧 schema golden，base 只允许 vacuum flag 未完成且 recovery steady；3.1.11 后验允许其版本应有 schema 不变，3.1.12 后验只允许 system snapshot 补列/partial index 的白名单 DDL 并达到 current schema。crash base-only clone必须 vacuum=1、current schema、非目标 pending=0，再由 WAL-visible clone只证明指定恢复 | 三场景各自独立报告，禁止把 VACUUM、schema migration 与 crash/journal recovery 混入同一 median；四变体每样本仍从同一字节级旧 golden 起步 |
| postcondition SQLite 打开 timed DB 会重建 SHM 并污染 report.after | tree/root 正常退出后先冻结 timed main/WAL/SHM 的 existence/size/SHA-256；所有 post SQL 在 disposable main-only clone 读取并清理，报告 after 使用冻结证据 | main-only post 也直接证明 checkpoint；runner 全生命周期不以 SQLite 打开 timed bundle |

### PR3 Review Round 4 裁决与修复

| Finding / 裁决 | 修复与行为证据 | 边界 |
| --- | --- | --- |
| normal 第 2～5 轮仍固定检查原 golden，漏掉 working DB 新增 running/pending | 每轮先检查 timed WAL frame，再 raw copy 当前 timed main/WAL/SHM 到 disposable clone，在 clone 上查 current schema、vacuum flag、active task/batch、pending artifact、flow intents；round2 running task 动态反例阻断且 timed main hash 不变 | 原 golden 只用于 exact 初始复制和双版本 schema probe，不替代逐轮 working-state admission |
| metrics 未 ready 时 root 已 code=9 仍等待完整 300s timeout | 每轮保持 metrics-first；未 ready 时以 delay 与 `exitPromise` race，不跑 CIM；root 早退立即 `PROCESS_EXITED_BEFORE_FULL_READY` 并记录 ownership established/unestablished | metrics 与 exit 同 tick 时先固定 ready，之后由 owned live/receipt/root exit gate 决定样本终态 |

### PR3 Review Round 5 裁决与修复

| Finding / 裁决 | 修复与行为证据 | 边界 |
| --- | --- | --- |
| normal 最后一轮产生真实 pending/DDL/WAL 仍可进入 median | 每个样本 tree/root 正常退出后先冻结 bundle；post 在 disposable main-only clone 重查 `prepared/running` task、`reserved/running` batch、pending artifact、flow intents、vacuum flag 与 schema fingerprint，并拒绝有效 WAL frame；legacy 同样执行真实状态 gate | `interrupted` 是 terminal audit，不计 active；VCC `bound` 仍允许非零 |
| cleanup 吞错并继续 20 样本 | cleanup 必须返回动作 receipt 并以最终 token-aware snapshot 证明零存活；ownership 未建立或 remaining tree 非空时标记 `PROCESS_CLEANUP_FATAL`，报告 `requiresManualCleanup` 并立即中止整次 rotation | 不猜测/强杀未知 PID；schema untimed probe cleanup 同样不再吞错 |
| snapshot token A 与 Close/kill 动作间 PID 复用 | snapshot/action 统一使用显式 UTC ticks CreationDate；单次 PowerShell 动作携带 exact CreationDate/path/cmd，取得 `System.Diagnostics.Process` 后强制打开并持有 Handle，再以第二次 CIM exact token 复验后才对该对象 CloseMainWindow 或 `Stop-Process -InputObject`；cleanup 叶到根，最终重新 snapshot | 删除 JSON 隐式 DateTime、时间容差与裸 `taskkill PID`；A→B race 无 receipt、零用户进程动作 |
| CIM/Close/force 外部进程可无限挂起 | Node `execFile` timeout 负责终止真实子进程，Promise hard timeout 也覆盖注入/卡死 adapter；refresh/close/force 各阶段共享剩余 deadline，cleanup 有独立 15 秒上限与稳定 code | ready 前仍 metrics-first，不新增 CIM 污染计时 |
| non-normal preflight 仍查原 golden，复制无逐样本 SHA | 每个 timed main/WAL/SHM 复制后冻结 existence/size/SHA-256 并与 golden 对比；所有场景 preflight 都 raw-copy 当前 timed bundle 到 disposable clone，launch 前再冻结并证明 preflight 零改写 | runner 从不 SQLite-open timed bundle；post SQL 仍只在 disposable clone |
| failed sample 丢 before/ready/phases/recovery/close/after | 样本以增量 evidence accumulator 固化每阶段安全证据；未取得字段显式 `unavailable`，post failure 同时保留真实 pending/schema 证据；cleanup receipt/失败证据也进入 sample | 活进程存在时不为补报告打开 DB；证据缺失不可伪装成功 |
| 四 label 可指向同制品且报告无环境 provenance | 自动记录四制品 SHA-256/size/fileVersion（不落盘 path），拒绝重复 SHA 与 label/version 明显不匹配；记录 OS/release/arch、CPU/逻辑核、RAM、Node 及显式 Defender/介质/cache CLI 字段 | Defender/介质/cache 缺失时 environment=`not-evaluated`；真实 Windows 结论仍由 PR5 形成 |

### PR3 Review Round 6/7 裁决与修复

| Finding / 裁决 | 修复与行为证据 | 边界 |
| --- | --- | --- |
| PowerShell 5.1 隐式 DateTime/token 不稳定 | snapshot/action 共用显式 `ToUniversalTime().Ticks.ToString(InvariantCulture)`；nonce scalar 仅做 PowerShell 单引号转义，不经 JSON stringify 引入字面双引号；Windows-only 行为测试以真实 snapshot 取得 token 后执行 held-handle graceful/force action 并要求 force receipt | 本机 macOS 跳过，Windows CI/PR5 必须执行真实 PS5.1 分支 |
| migration/crash 后验仍可带 pending、unexpected DDL 或有效 WAL | 三场景都在冻结 bundle 的 disposable clone 核对 pending；normal/crash 要求 current schema 且 fingerprint 不变，crash 另要求有效 WAL 已清；migration 以独立旧 schema golden 起步，3.1.12 采集完整 `PRAGMA table_info`，只允许精确 append nullable/no-default/non-PK `import_source_id INTEGER`、既有列不变与规范化 SQL 完全匹配的目标 partial index，3.1.11 接受其版本 schema 不变；其他列/表/index/trigger 一律拒绝 | 不把一次性 schema migration 收窄成仅 VACUUM；同场景四变体从同一份字节级旧 golden 复制 |
| wrapper/browser nonce 不能保证传播到 Chromium/utility descendants | 每样本强随机 nonce 只作为 expected wrapper/browser image、creation lower bound 与 exact argv 的 ownership seed；后代只从当前 exact-token live parent 扩展，已记录的无 nonce descendant 即使祖先退出仍保留 exact token；父曾 owned 的未记录可疑 child 只触发 manual/fatal，不执行动作 | 不全局按 nonce substring seed，因此 PowerShell 自身 `-Command` 不会被纳入；无法证明归属的进程永不 close/kill |
| 单次空树可能漏掉 late child | graceful/cleanup 后执行固定多轮 quiescence snapshot；任何已知 exact-token 进程或 parent 曾 owned 的可疑 child 均使 cleanup 失败、落 `requiresManualCleanup` 并中止整轮 | 两次 snapshot 间完全逃逸且失去 lineage 的理论窗口记录为 PR5 Windows 人工盲区；本 PR 不引入 Job Object/native helper/新依赖 |
| cleanup fatal 仍可能 CLI exit 0 | fatal cleanup 先保留 partial report，再抛 `STARTUP_MEASUREMENT_ABORTED`；CLI catch 设置非零退出，后续样本不再 launch | ownership 未建立时禁止猜测或强杀，并明确要求人工清理 |
| run 中 source golden/artifact 漂移 | run 开始把 main/WAL/SHM 冻结到 runner-owned bundle，所有 probe/sample 只从冻结副本复制；结束复验原 source。四制品在 run 开始冻结 identity，每次 spawn 前及 run 后重验 SHA/size/fileVersion，漂移立即 abort | installed artifact 可依赖邻接 resources，故不复制单 exe；身份漂移后绝不继续启动 |
| full-ready 后失败丢 ready/after 证据 | ready 一取得立即固化 ready/phases/recovery/external ms；整树退出后在任何 SQLite open 前冻结 after，即使 root 非零也先保留安全取得的证据再判失败 | 活进程仍在时不为补证据打开 DB；不可取得字段显式 unavailable |
| graceful close 瞬时空树与 cleanup 后 evidence 不对称 | `waitForExit` 遇 suspicious child 立即 manual/fatal，只有连续三轮 live/suspicious 均为 0 才返回 `verifiedEmpty:true`；runner/schema probe 只接受该 receipt。失败路径 force cleanup 也必须给 verified receipt，随后立即冻结 after；冻结失败保留 cleanup evidence 并写独立 code/unavailable reason | 已记录的无 nonce descendant 在祖先退出后仍被 exact-token 追踪；未知 child 不执行动作 |
| runner-owned golden 与制品可在 run 中漂移 | golden 创建时固定 main/WAL/SHM size+SHA 并 chmod 只读辅助；每个样本复制前后及 run 结束都与该不可变 evidence 比，报告也只用 fixed SHA。四制品 run 前/后验证，并在所有 scenario preflight 完成后、`adapter.launch` 紧前同步复验四者身份 | frozen 内部漂移或 preflight 替换制品均 fatal abort；系统调用级微小竞态不扩展为 native helper |
| label 版本前缀误接受 `3.1.110` | fileVersion 使用 strict semver 解析并逐段精确比较 label major/minor/patch | 拒绝版本前缀碰撞；不以字符串 startsWith 判断 |

### PR3 Evidence

| 证据 | 结果 | 覆盖 |
| --- | --- | --- |
| 修改前 source/test 审计 | 确认 loading 双态、无参数 ANALYZE、双 VCC gate、Archive 启动历史维护与存储根 evidence 扫描均真实可达 | 红测和最小生产修改边界 |
| PR3 定向红绿批次 | startup/Archive/VCC/runner 聚焦测试已清零；Archive controller + Toolbox 51/51 PASS；startup/runner 合同批次 13/13 PASS | init 屏障、fail-closed、集合查询/索引、阶段与测量合同 |
| PR3 最终聚焦回归 | 12 个 startup/Archive/VCC/runner 文件 147/147 PASS；最后 root fail-closed/runner timeout 补测 49/49 PASS；全部修改 JS `node --check` 与 `git diff --check` exit 0 | Reviewer 指定的窗口、fallback、outbox、VCC old schema/null/system-only/hold、phase/runner 合同 |
| PR3 全量 unit | 首轮 5430/5432 仅两条旧静态正则仍要求 `markAppInitDone`/无参 `database.init()`；反向同步新 admission/phase callback 后最终日志 `unit-20260820-033920.log` 为 5432/5432 PASS | 全仓 unit 回归；不以局部绿测替代整轮证据 |
| PR3 integration | 48 个脚本 2410/2410 PASS；为避免无输出长压测占住 runner，整套以 `TOOLBOX_LARGE_ROWS=1000 TBX_T7_TIER1_ROWS=10000 TBX_T7_TIER2_ROWS=30000` 完成；另默认 `toolbox-large-file-stream` 300,000 行/文件隔离 50/50 PASS，142.9s、峰值 RSS 619MB | 全集成接缝 + 默认大文件生产规模补充证据；未改自动生成 policy 清单 |
| PR3 smoke/lint | `npm run smoke` PASS；`npm run lint` exit 0 | 全局业务 smoke 与生产源码静态检查 |
| PR3 check-vars | 命中 Critical `USE_BIG_TABLE_IMPORT_ENGINE`（仅删除旧启动注释中的引用，收单引擎定义/分支未改）、Important `ipcRenderer`、Runtime `app/elements/setStatus/state`、Risk `DEFERRED_WINDOW_STARTUP`（按 Spec 明确退役） | IPC channel 删除已同步 main/preload/renderer；启动/退出、完整 renderer 初始化与 smoke 已复核；PR body 需附关联功能 review |
| PR3 blindspot pass | 唯一产品 BrowserWindow/handler 入口、activate/second-instance、load+ready 双条件、root ok/available、outbox/owner/sweep/safety、phase 闭合、VCC 单入口/集合 SQL、runner 超时/缺样本/WAL-SHM 均复核；新增 runner 5min 默认 sample timeout 与 root `ok:false` 红测 | 无新增 BLOCK；剩余均为 Windows/PR4 明确后续 |
| PR3 Review Round 1 红绿修复 | Archive/service/controller/migration + window/runner/adapter 综合首轮 146/147，唯一失败为旧 `createWindow()` 静态切片；修复后 window/runner 25/25、controller+adapter 44/44；全量首轮 5448/5452 的四项均为三条旧静态签名与一条旧 owner fail-open 预期，隔离反向同步 51/51 | 未用测试降级掩盖生产错误；owner 测试仍证明后续 owner 完成 settle，但 admission 统一拒绝 |
| PR3 Review Round 1 全量 unit | `npm run test:unit` 最终 5454/5454 PASS；日志 `logs/unit-tests/unit-20260820-043616.log` | 新增真实 tmp 未删除 probe、pre-switch fail-closed、generic owner/list I/O、show throw、metrics 隔离、process adapter fake tree/PID 复用保护、真实 SQLite WAL setting/checkpoint/CLI 强制 sentinel 等行为测试 |
| PR3 Review Round 1 integration | `TOOLBOX_LARGE_ROWS=1000 TBX_T7_TIER1_ROWS=10000 TBX_T7_TIER2_ROWS=30000 npm run test:integration`：48 脚本、2410/2410 PASS；runner 自动清单的本机耗时噪声已恢复，不纳入 diff | 本轮跨模块接缝；默认 300k toolbox 仍引用上轮隔离 50/50 PASS 证据，不伪装为本轮缩放数据 |
| PR3 Review Round 1 smoke/lint/check-vars | `npm run smoke` PASS；`npm run lint` exit 0；`npm run check:vars` 按设计 exit 2 并命中 Critical `USE_BIG_TABLE_IMPORT_ENGINE`（仅删旧启动注释）、Important `ipcRenderer`、Runtime `app/elements/setStatus/state`、Risk `DEFERRED_WINDOW_STARTUP` | 引擎定义/回退/契约未改且对应 integration/smoke 全绿；IPC 删除已同步 main/preload/renderer；state/elements/setStatus 仅删除不可达 loading 分支；DEFERRED 按本版固定 Spec 退役 |
| PR3 Review Round 1 blindspot 复核 | 产品 `new BrowserWindow` 仍唯一；initial/supplemental instrumentation 显式；启动 service 一律 `deferStartupRecovery:true`；物理清理函数只保留在显式 service/PR4 能力；runner 无 auto-quit，持续 poll tree、ready 前取时、退出后验 DB/WAL | 未发现新增可达 bypass；真实 Windows NSIS/portable window/process 行为与性能数据仍为 PR5 RELEASE PROBE |
| PR3 Review Round 2 红绿与全量 unit | 新增 7 组 runner/adapter 行为红测，初始 13 PASS/7 FAIL；生产修复后聚焦 20/20 PASS；`node --check` 两个 runner 文件通过；全量 `npm run test:unit` 5461/5461 PASS，日志 `logs/unit-tests/unit-20260820-045231.log` | timed bundle 零字节污染、probe 清理、PID token 复用/同名误收、root pre-token child、metrics-first 零 CIM、close receipt/非零退出、normal steady isolation |
| PR3 Review Round 2 其余本地门禁 | scaled `npm run test:integration` 48 脚本、2410/2410 PASS、72,974ms（自动写入的本机 policy 耗时已恢复）；`npm run smoke` PASS；`npm run lint` exit 0；`npm run check:vars` 仍为预期命中并 exit 2 | Runner/adapter 只影响测量工具；产品跨模块 integration/smoke 无回归；Important Variables 自查结论与 Round 1 相同 |
| PR3 Review Round 3 红绿与全量 unit | ownership/exit/schema/三场景/post bundle 动态反例均先红；最终 runner/adapter 聚焦 27/27 PASS，两个文件 `node --check` 通过；全量 `npm run test:unit` 5468/5468 PASS，日志 `logs/unit-tests/unit-20260820-050810.log` | baseline stale child、root PID reuse、exitPromise code9、schema-less/DDL、VCC bound、migration↔crash 隔离、WAL 无 SHM 后验零污染 |
| PR3 Review Round 4 红绿与全量 unit | clean golden + round2 working DB `archive_task_runs.running=1` 旧实现 fail-open；root code9 fake clock 500ms 旧实现等到 timeout；修复后 runner/adapter 聚焦 30/30 PASS；全量 `npm run test:unit` 5471/5471 PASS，日志 `logs/unit-tests/unit-20260820-051138.log` | 当前 bundle admission 与早退快速失败均为动态行为证据，不依赖源码 regex |
| PR3 Review Round 4 最终本地门禁 | scaled `npm run test:integration` 48 脚本、2410/2410 PASS、73,272ms（policy 耗时噪声已恢复）；`npm run smoke` PASS；`npm run lint` exit 0；`npm run check:vars` 预期 exit 2 且命中项不变；`git diff --check` exit 0 | 最终 runner 改动后的全仓回归；真实 Windows packaged 数据仍保留给 PR5，不据本地门禁宣称 70% |
| PR3 Review Round 5 红绿与全量 unit | 新增 8 组 runner/adapter 动态反例：旧实现 5 组明确失败且 never-resolving external call 会挂住；修复后聚焦 38/38 PASS，两个 runner 文件 `node --check` 与 `git diff --check` 通过；全量 `npm run test:unit` 5479/5479 PASS，日志 `logs/unit-tests/unit-20260820-053810.log` | post real-state、terminal interrupted、actual timed SHA、fatal cleanup、action-time A→B、hard timeout、partial evidence、环境/artifact provenance 均为行为测试 |
| PR3 Review Round 5 最终本地门禁 | scaled `npm run test:integration` 48 脚本、2410/2410 PASS、73,064ms（自动 policy 耗时噪声已恢复）；`npm run smoke` PASS；`npm run lint` exit 0；`npm run check:vars` 按设计 exit 2 且命中项不变；`git diff --check` exit 0 | 产品跨模块无回归；真实 Windows process/制品/Defender/介质与 70% 对拍仍为 PR5 人工门禁 |
| PR3 Review Round 6～8 红绿与全量 unit | PS token/held-handle/nonce scalar、nonce seed/无 nonce descendant、graceful/cleanup quiescence、fatal CLI、cleanup-after、frozen golden/artifact、partial evidence、strict semver、旧 schema 列级 migration 白名单/额外 DDL 与 crash/normal 后验均有动态测试；最终 runner/adapter 聚焦 49/50 PASS、0 FAIL、1 Windows-only SKIP；`node --check` 两文件通过；全量 `npm run test:unit` 5490/5491 PASS、0 FAIL、同一 Windows-only SKIP，日志 `logs/unit-tests/unit-20260820-071147.log` | Reviewer Round 8 对七项原动态反例全部复验转绿，冻结 SHA 稳定，正式结论为“未发现阻塞 P3+”；macOS 未伪造 PS5.1 结果，Windows 真包/PS 行为仍属发布证据 |
| PR3 Review Round 8 最终本地门禁 | scaled `npm run test:integration` 48 脚本、2410/2410 PASS、78,443ms（自动 policy 耗时噪声已恢复）；`npm run smoke` PASS；`npm run lint` exit 0；`npm run check:vars` 按设计 exit 2 且命中项不变；`git diff --check` exit 0 | 测量 runner 最新改动不伪造 Windows 结果；真实 PS5.1/NSIS/portable/process containment 与 70% 数据仍交 PR5 |
| PR3 根侧完整发布门禁 | `npm run release-check` exit 0：lint、smoke、全量 unit 5490/5491 PASS（0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-071628.log`）、48 个默认规模 integration 2410/2410 PASS（409,241ms；含 300,000 行大文件 50/50 与多 Sheet 拆分 31/31）；`npm run check:vars` 按设计 exit 2；`git diff --check` exit 0；测试自动写入的本机 policy 耗时已恢复 | GitHub PR/Windows required check 前的根侧门禁满足；唯一 skip 与真实性能结论继续由 Windows CI/PR5 给出，未宣称 70% |
| PR3 Windows CI 首轮实机分支 | GitHub Actions run `32313358338` 的 Windows 全量 unit 为 5489/5491 PASS、1 FAIL、1 SKIP；唯一失败是真实 PowerShell `Get-CimInstance Win32_Process` 在满载并发下超过 5s 硬上限并返回 `PROCESS_SNAPSHOT_TIMEOUT` | 不将超时判成业务失败，也不删除硬超时；CIM 改为仅投影 5 个必需字段，外部 snapshot/close 统一放宽为有界 15s，Windows 行为测试增加失败后清理；修正后 macOS 聚焦 49/50 PASS、全量 unit 5490/5491 PASS（均 0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-074456.log`）；Windows 重跑通过前状态为 PROBE |
| PR3 Windows CI 第二轮实机分支 | GitHub Actions run `32318795191` 的 Review Round 9 代码反例均通过；唯一失败仍是真实 PowerShell process snapshot 在 348 个测试文件全量并发、机器满载时达到 15s 硬上限。继续放宽 timeout 会弱化进程所有权与清理失败门禁，不能作为修复 | 普通 `release-check` 通过显式环境开关跳过这一个外部实机探针，随后同一 Windows PR/Release workflow 独立串行运行整个 adapter test 文件并开启真实探针；可注入的 token/lineage/timeout 合同仍留在全量 unit，真实 PowerShell snapshot/action/held-handle receipt 未删除。macOS 定向 17/18 PASS（1 平台 skip）、全量 unit 5492/5493 PASS（0 FAIL、同一 skip，日志 `unit-20260820-090826.log`）；Windows run `32320012473`（#748）全量 release-check、专用 adapter 15/15（0 skip，真实用例 4.23s）、SQLite 回归、界面对齐、installer/portable build/upload 全部成功，实机探针 PROBE 已关闭 |
| PR3 外部 Review Round 9 红绿修复 | Review 在新的 CIM 修复之后又指出两条真实可达问题：3.1.12 只等 main phase 会比 3.1.11 少算 renderer 初始化尾段；fallback-only 来源绑定后仍使用删除前引用数会留 stale hold。两个最小反例在修改前分别稳定失败（ready 被提前接受、hold 1≠0）；修改后 runner/lineage 两文件 41/41 PASS，全量 unit 5491/5492 PASS（0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-084735.log`），smoke/lint/check-vars/diff-check 全绿 | 两版统一以 renderer total-init 为用户可用终点，3.1.12 另要求 main phases；VCC 绑定事务先删除本来源 fallback，按 `DELETE.changes` 扣减并同步共享 Map，再决定 hold。有效行/system reference 的正向 hold 合同保持不变；Round 8 的通过结论仅代表当时冻结集，以本轮修复后门禁为准 |
| PR #154 Review Round 9 partial-ready 证据修复 | 新增 timeout 与 root early-exit 两条 `measureSample` 动态反例：3.1.12 已有 window-ready/startup-total 与 recovery counts、但 renderer total-init 缺失时，旧实现聚焦为 35 PASS/2 FAIL；修复后 runner 聚焦 37/37 PASS；Reviewer Round 10 定向复验同为 37/37 PASS并关闭原 P2；根侧最终 `npm run test:unit` 5494/5495 PASS（0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-102317.log`），`npm run smoke`、`npm run lint`、`npm run check:vars`、`node --check`、`git diff --check` 全绿 | `waitForFullReady` 缓存最后一份安全读取的 metrics 与明确 missing marker，timeout/early-exit 仍 fail-closed；失败 sample 只回填已观测 phases/recovery，不产生 external success，cleanup verified 后 freeze-after 合同不变。TechDoc §4.6 合同未变，无需修改 TechDoc；Reviewer 结论未发现阻塞 P3+ |
| 真实 Windows 性能数据 | NOT RUN / not-evaluated | PR5 必须用真实 3.1.11/3.1.12 installer + portable 各至少五次形成 median 与人工签字；本 PR 不宣称 70% |

### PR3 Remaining / Human Review

| 项目 | 状态 | 下一步 |
| --- | --- | --- |
| Windows 四变体稳态对拍 | RELEASE PROBE | PR5 运行 normal-clean-shutdown，保留首样本、轮换顺序、各阶段与 median |
| 一次性迁移/VACUUM 与 crash recovery | RELEASE PROBE | migration 使用独立旧 schema/vacuum 未完成 golden，核对 3.1.12 白名单 DDL delta 与 3.1.11 schema 不变；crash 使用 current schema/vacuum 已完成 base，并给非空合法 `--golden-wal` 与 `--wal-sentinel settingKey=expectedValue`，核对 WAL-only 可见值、关闭后主库 checkpoint、WAL/SHM 和恢复计数；journal sentinel 若使用则单列 |
| Windows process containment 理论窗口 | MANUAL | PR5 在 installer/portable 真包确认 wrapper→browser seed、无 nonce renderer/utility lineage、CloseMainWindow receipt、late child quiescence 与 fatal cleanup；两次 snapshot 间完全逃逸且 lineage 已丢失的进程无法在无 Job Object/native helper 的合同内证明，需人工观察任务树/DB 锁 |
| Windows native failure 与窗口时序 | MANUAL | 注入 DB open/optimize/archive root/outbox/loadFile 失败，确认 window=0、dialog=1、exit=1；正常路径确认 ready 后才显示 |
| PR4 首进维护接线 | FOLLOW-UP | 消费 `deferredMaintenance.version=1`，在首次进入存档中心时分页执行并保留 migration cleanup journal 的恢复语义 |

## PR4 — 存档中心

### Task Brief

- Goal：交付可变更存档位置、首进后台维护、文件指纹快路与严格 durable-owner 删除边界，同时保持列表首屏可用和既有迁移真相语义。
- Context：PR3 已把非关键物理维护从启动 admission 拆出并发布 `STARTUP_DEFERRED_MAINTENANCE.version=1`；PR4 消费该 DTO，不重新引入启动线性扫描。
- Constraints：未知文件不打开、不复制、不删除；迁移和打开/另存/发布始终完整 SHA；历史 NULL 指纹不回填；pre-switch 旧根权威、post-switch 新根权威；不新增每日/空闲兜底；不改 Spec/TechDoc 用户流程。
- Done when：8 阶段维护、migration/entry lease、指纹 schema/事务边界、root/ancestor fail-closed、IPC/preload/renderer/UI 与 packaged runner 精确 schema 白名单均有行为证据，三层门禁通过。

### Unknowns Register

| 未知 | 处理 | 证据/结论 | 合并影响 |
| --- | --- | --- | --- |
| transient/孤儿扫描是否存在无 owner 删除链 | PROBE → CLOSED | `_cleanupManagedDirectory`、`_scanOrphanBlobPrefixUnlocked`、migration pause/drain 与 old-root cleanup 均有真实未知文件 fixture；通用扫描只输出 path hash/count，cleanup 只消费 DB/journal 精确路径 | 未知 `.staging/.readonly`、SHA 形状文件与 journal 未发布目标文件一律保留 |
| canonical 同 SHA 路径是否会被 publish 静默收编 | PROBE → CLOSED | `findBlobByHash=null` 时只 lstat 判冲突，不打开/不删/不建 Blob；移除未知文件后原失败任务可恢复。只有 known Blob 才完整 SHA，并要求 SHA 前后 BigInt stat 稳定 | SHA 形状和同内容都不是 owner；metadata commit 失败留下的无 DB Blob 也不自动收编 |
| 首进维护与迁移/新 archive admission 能否互斥且仍允许分页间隙 list/open | PROBE → CLOSED | 单一 entry lease 在 8 阶段外层持有；只关闭 admission/migration，不激活阻塞 read 的数据库维护；每页独立进入 root tail 并 `setImmediate` 让出 | migration/新写入无阶段间窗口；列表首屏和页间读取不等待整阶段 |
| cleanup-pending 能否在 entry lease 内续跑 | PROBE → CLOSED | owner token 允许 `resumeDeferredCleanup` 复用同一 lease，避免 maintenanceRequested 自阻断；精确 owner 可清并完成，未知 transient 则保持 partial/journal | 不嵌套申请 maintenance，不放宽 journal owner |
| 指纹 final stat 与历史 NULL dedupe 是否能同时满足 | PROBE → CLOSED | 新 Blob insert 以 `inserted.changes` 区分并强制完整 fingerprint；旧 Blob dedupe 允许 NULL 且不补；SHA 前后 BigInt stat 稳定后才提交 final fingerprint | 无历史 backfill；打开/另存/迁移/发布不走指纹快路 |
| root/ancestor 在运行期被 symlink/junction、离线或部分初始化后替换是否会越根/重建 split root | PROBE → CLOSED | Service 与 RootManager 分别复用逐祖先/root lstat guard；root 自身一经 mkdir+lstat 确认为真实目录即不可回退 bootstrap；source/target/old root、canonical、`.staging/.readonly`、子目录 EIO 后 offline root 动态 fixture 全部 fail-closed | 不扩展到 syscall 级 TOCTOU；Windows junction 仍需实机复验 |
| historical-health-scan 的物理 Blob 分页是否可能跟随页间替换的祖先链接 | PROBE → CLOSED | prefix-list 页和每个 prefix 页读取前都复用 managed-path ancestor guard；真实 controller entry fixture 覆盖进入前已替换及 prefix-list 后、下一页前替换，均发 failed、不发 completed、不读取外部 prefix | 只修真实 page entry，不扩展到单次 syscall 内 TOCTOU |
| Windows 文件 fsync 是否允许沿用 POSIX 只读句柄 | PROBE → CLOSED / TEST RECHECK | PR #155 Windows run `32334377167` 首个 Archive layout 即在只读句柄 flush 返回 `EPERM`，随后 99 条 Archive 失败级联；仓库既有 Toolbox Windows 行为合同也要求可写句柄。新增公开 archive 行为 fixture 同时模拟只读句柄 flush=`EPERM` 与只读文件不可用 `r+` 打开，旧实现稳定失败，修复后 publish/materialized 两次均记录 `r+`；#752/#753 均不再出现产品 Archive EPERM 级联，file fsync 故障子例也通过 | 只对任务拥有且尚未发布的 staging 文件使用可写句柄，不吞文件 fsync 错误；剩余 parent 子例仅是测试用 raw/resolved targetRoot 前缀不能覆盖 Windows canonical path 表示，产品目录 fsync allowlist 不变 |
| maintenance 失败结果是否可能被误报 complete 或在失败页自旋 | PROBE → CLOSED | manager ownership scan 返回显式 `ok:false`；controller 同时拒绝 failed/incomplete/partial/pending/running；服务保留成功页 cursor，失败页不推进且立即停止，新 visit 从失败页重试 | 同 visit 不重试、不发 completed；成功完成后 cursor 清零以保持独立手工调用语义 |
| 维护刷新时 related batch 不在筛选页是否会被误判删除 | PROBE → CLOSED | retention event 返回精确 `deletedBatchIds`；只有命中该集合才清空并提示，到页外但仍存在的 selected id 保留并经 `getBatch` 刷新 detail | 不以 filtered list 缺失推断删除，不自动 fallback 首项 |

### Decisions / Deviations

| 决定 | 理由 | Spec/TechDoc |
| --- | --- | --- |
| renderer 每次从非 Archive tab 进入时生成内部 `visitId` | 精确实现 failed 仅离开/重进可重试；不把内部 visit identity 暴露为用户设置 | 符合建议方案，无偏差 |
| 8 阶段固定映射为 cleanup-journal → blob-metadata → artifact-metadata → retention → owned-orphans → layout-materialization → historical-health-scan → noncritical-ownership-scan | 精确消费 PR3 version=1 DTO，保留阶段可观测性 | 无偏差 |
| migration target 的既存文件只由 `journal.targetPublishedPaths` 授权 | source DB evidence 只能证明 source，不能给 fresh/续跑 target 同路径文件授予 owner | 无偏差；恢复仍可精确复用已发布 Blob/layout |
| publish、materialized copy 与迁移 canonical 统一对 owned staging 使用 `r+`：rename 前强制文件 fsync；materialized copy 随后降为只读；rename 后同步父目录，再允许 setting switch | Windows `FlushFileBuffers` 要求可写句柄，且 materialized 临时文件先降只读会使 `r+` 无法打开；目标内容仍必须 durable 后才能发布/改变唯一权威根 | 无偏差；文件 fsync 失败仍 fatal，只有目录句柄明确不受支持的既有错误可忽略 |
| packaged migration schema whitelist 增加 Archive 8 个精确 nullable 列 | PR5 旧 schema golden 必须把 PR4 合法 migration 与额外 DDL 区分 | 无偏差；未放宽其他列/约束/index/trigger |

### PR4 Evidence

| 证据 | 结果 | 覆盖 |
| --- | --- | --- |
| repository/mapper/事务聚焦 | 新 Blob/新或修复 materialized copy 缺 fingerprint 回滚；旧 NULL dedupe 不补；半指纹 mapper 返回 NULL；inode 为 decimal string | D-20、历史兼容与 8 列 schema |
| unknown ownership 与迁移故障注入 | source unknown transient、target marker+unknown transient、fresh/续跑 target 非 journal owner、post-switch old-root unknown、pause/drain unknown SHA 均保留；journal/setting 真相符合阶段 | ARC-03/04、D-09～D-15、删除边界 |
| root/ancestor 动态替换 | Service canonical/open/save/delete/publish、root/`.staging`/`.readonly`、RootManager source/target/old-root 均拒绝链接；initialized root 及 root 已建立但子目录 EIO 两条路径在 rename/offline 后 archive/attach 均不改 DB、不重建目录 | §4.4 与 split-root fail-closed |
| historical inventory 分页祖先保护 | public entry maintenance 在 Blob ancestor 进入前被替换时零 inventory 读取；prefix-list 完成后、prefix 页前替换时只读首个真实页，下一页 guard 失败；两次均 failed、无 completed、外部文件保持原样 | §4.4、historical-health-scan 物理页边界 |
| 分页/失败页行为 | list 可在 blob page 间进入；retention page 间释放 tail并返回精确 deleted IDs；三页 fixture 在第二页失败时调用序列 `[0,1]`，新 visit 为 `[1,2]` | D-19、首屏非阻塞、无失败自旋 |
| entry 状态机 | immediate started/running/complete、attemptId、progress/completed/failed；ownership failed status 不误发 completed，同 visit 去重，新 visit 重试 | ARC-05～08、API-02/03 |
| target durability | canonical 文件 fsync 或父目录 fsync 故障均保持 setting 未切换；journal 已发布 Blob/layout 的 pre-switch crash 可真正续跑成功 | 目标落盘顺序与 crash resume |
| renderer/UI 静态合同 | 首次 list 后立即 start（stats 在 start 后异步）；完整可选换行路径；维护明确删除清空选择，页外 related selection 继续 `getBatch`；subscribe/unsubscribe 成对 | ARC-01/02/05/07、TST-03 |
| migration runner schema | VCC 精确 delta + `archive_blobs` 4 列 + `archive_artifacts` 4 列；额外列仍拒绝 | PR4/PR5 跨 PR schema 合同 |
| 聚焦整文件回归 | repository/service/storage migration/controller/UI/runner 六文件 233/233 PASS；Service+Controller 109/109 PASS；task-policy inventory 23/23 PASS；所有修改 JS `node --check` 与 `git diff --check` exit 0 | PR4 生产边界、Round 1 两项修复与 IPC 显式分类 |
| 全量 unit | P1 修复后的 release-check 为 5533/5534；P3 行为测加入后最终 `npm run test:unit` 5534/5535 PASS、0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-124618.log` | 两项 Round 1 修复后的全仓回归，未伪造 PowerShell 实机探针 |
| 默认规模 integration | 独立运行 48 scripts、2410/2410 PASS、388,973ms；P1 修复后的 release-check 再跑 48 scripts、2410/2410 PASS、304,613ms；两轮均含 300,000 行 50/50 与多 Sheet 31/31 | 跨模块接缝与默认大文件规模；P3 只收紧已有维护页 ancestor guard并另有公共入口聚焦证据 |
| smoke/lint/release-check | 独立 `npm run smoke` PASS；Round 1 P1 修复后 `npm run release-check` exit 0（lint/smoke、unit 5533/5534、integration 48 scripts/2410 assertions 全部通过，304,613ms）；P3 增量再经聚焦 233/233、最终 unit 5534/5535 与 lint | 项目发布门禁 |
| 设置页真实 Electron 布局 | `npm run verify:app-settings-layout` 在 1240×860/1080×760、100/125/150% 共 6/6 PASS；verifier 已从旧 ellipsis 断言同步为完整文本、wrap、selectable 与两行布局 | ARC-01 与 Important Variables UI 人工替代证据 |
| check-vars | exit 2 为预期命中：Important-skeleton `ipcRenderer`、Risk-sensitive `archive_artifact_holds`；main/preload/renderer channel 同步且可 unsubscribe，hold schema/释放口径未改，retention 继续查询并尊重 hold | PR body 需追加关联功能 review；Risk-sensitive 要求的 smoke/release-check 已通过 |
| blindspot pass | 入口旁路、unknown owner、pre/post switch、失败页 cursor、entry lease、root/ancestor/offline、指纹最终 stat、related selection、IPC inventory 与 runner schema 均逐项复核 | 未发现新增 BLOCK；剩余为下表实机项 |
| PR4 Review Round 1 | 独立 Reviewer 冻结最终 Dev diff，254/254 聚焦测试通过；确认 1 个 P1（部分初始化后丢失已建立根身份，可形成 split root）与 1 个 P3（historical-health-scan 物理分页未复用祖先门禁） | 两项均有公开入口与动态反例，项目负责侧接受后退回同一 Dev；未扩展到 syscall 级 TOCTOU |
| PR4 Review Round 2 | 原 P1/P3 的 2/2 动态 probe 与相邻行为共 5/5 PASS；P0/P1/P2/P3 均为 0，未发现新 Finding，Reviewer 明确可合并 | partial-init 后 archive/attach 不重建离线根；historical scan 在进入前和页间替换时均 failed、无 completed |
| PR4 根侧最终 release-check | 最终 Round 2 代码快照执行 `npm run release-check` exit 0：lint、smoke PASS；unit 5534/5535 PASS（0 FAIL、1 Windows-only SKIP，日志 `unit-20260820-124953.log`）；48 scripts、2410/2410 integration PASS、394,017ms，含 300,000 行 50/50 与多 Sheet 31/31 | 合并前最终快照门禁；自动改写的 integration policy 本机耗时噪声已恢复，`git diff --check` 与全部修改 JS `node --check` exit 0 |
| PR #155 Windows CI fsync 修复 | Windows run `32334377167` 为 5434/5535 PASS、99 FAIL，首个真实根错为 materialized staging 只读句柄 fsync=`EPERM`；新增测试修改生产前为 1/4 PASS、3 FAIL（含父 suite 汇总），修复后 4/4 PASS；Archive 三整文件 122/122 PASS，最终全量 unit 5535/5536 PASS、0 FAIL、1 既有 Windows-only SKIP，日志 `unit-20260820-133818.log`；smoke/lint、三个生产文件 `node --check`、静态文件/目录 fsync 入口扫描与 `git diff --check` 均通过；本次三份生产改动 `check-vars` exit 0、无重要变量命中 | 单一共享 `syncStagedFile` 覆盖 Blob publish、materialized copy、migration canonical；最终副本仍只读，迁移 file/parent fsync 故障仍保持 setting 未切换；需要 Windows CI rerun 验证真实 NTFS |
| PR #155 Windows CI #752 | run `32336739691` 为 5531/5536 PASS、3 FAIL、2 SKIP，只有两个独立问题：Archive parent-directory 故障注入未触发，以及无关 position heartbeat 真实 timer 次数抖动。前者改为识别精确 SHA 父目录后在 base `open` 前注入非 allowlisted `EIO`，本地目标 3/3、migration 整文件 45/45 PASS；后者本地隔离 100/100，Windows #748/#751 分别 54.75ms/47.35ms 通过，仅 #752 在 61.309ms 失败 | parent 注入仍证明非 allowlisted 父目录耐久化错误不切 setting，不修改产品 allowlist；heartbeat 归类为全仓满载真实 timer 调度 flake，本轮不改无关测试/生产，若再次复现再另批纯测试确定性方案 |
| PR #155 Windows CI #753 | run `32338196878` 为 5532/5536 PASS、2 FAIL、2 SKIP；heartbeat 46.9642ms 通过，唯一独立失败仍是 parent 注入未命中，证明 #752 的 heartbeat 裁决成立。测试在 migration operation gate 生效后，把候选路径统一反斜线为 `/`、去尾分隔符，并只匹配模式 `'r'` 且精确后缀 `/blobs/sha256/[0-9a-f]{2}`；不再比较 drive case、realpath 或 extended-path 前缀，失败断言携带有界只读 open 候选 | fixture 建源 Blob 时也会同步源父目录，故 `targetRoot` 只作为“迁移已开始”的布尔 gate，绝不参与路径 identity；Windows drive/extended/UNC/POSIX 表示 1/1、目标 3/3、migration 46/46 PASS，零生产改动，待 Windows CI 复验 |

### PR4 Remaining / Human Review

| 项目 | 状态 | 下一步 |
| --- | --- | --- |
| 自动门禁最终数字 | COMPLETE LOCALLY / CI RECHECK | Round 2 根侧 release-check：unit 5534/5535（0 fail/1 Windows-only skip）、integration 48 scripts/2410 assertions；Windows fsync 修复后 unit 5535/5536（0 fail/1 同一 skip）、Archive 聚焦 122/122、smoke/lint/node/static/diff checks 全绿；#753 后缀匹配测试修复为目标 3/3、migration 46/46，当前只待新 CI commit；PR4 原完整 diff 的 IPC/hold review 结论保留 |
| Windows junction/网络盘掉线与 fsync 行为 | PRODUCT CLOSED / CI TEST RECHECK / MANUAL | #752/#753 已实机证明 owned staging file flush 修复消除 Archive EPERM 级联；parent directory 测试已去除 Windows path representation 依赖，需由新 CI commit 复验。junction、离线重连、网络/同步盘 directory flush 与 cleanup-pending 仍需人工复验 |
| UI 视觉与长路径 | MANUAL | Windows 缩放/中文长路径下确认两行布局、完整换行和文本可选择 |
| Spec/TechDoc 偏差 | NONE | 当前实现未改变用户流程、schema 历史兼容、删除 owner 或迁移真相边界；若 Reviewer 发现 BLOCK 必须先反向同步 |

## PR5 — Windows 发布证据

### Task Brief

- Goal：用真实 Windows 上的 v3.1.11 / v3.1.12 installer-installed exe 与 portable 四变体，形成 normal-clean-shutdown 各至少 5 轮轮换的性能报告，并把 migration-vacuum、crash-recovery、PowerShell process receipt、窗口/失败 seam 和最终发布门禁分别收口。
- Context：PR3 已交付 fail-closed packaged runner 与 Windows process adapter；PR4 已把 Archive 8 个 nullable 指纹列加入 migration schema 白名单。当前基线为 `v3.1.12@7262c8b5`。
- Constraints：不得上传、外发或在报告中记录真实用户数据库和原始路径；不得把空库、小库、未完成样本或合成样本静默宣称为 STP-08 的 70% 证据；任何 GitHub workflow dispatch、artifact 上传或其他远端写操作须由项目负责人先授权。
- Done when：同一份合格脱敏数据库副本完成四变体 normal 对拍并满足中位数缩短至少 70%；migration/VACUUM 与 crash recovery 独立报告；Windows process/window/failure 证据、release-check、check-vars 和版本文档全部闭合；人工项有真实签字而非自动替代。

### PR5 Unknowns Register

| 未知 | 处理 | 当前证据/结论 | 合并影响 |
| --- | --- | --- | --- |
| 可用 Windows 环境 | PROBE → PARTIAL | 当前本机为 macOS arm64，无 `pwsh`/PowerShell/QEMU；仓库 `build-windows.yml` 可用 `windows-latest`，#754 已成功执行 Windows release-check、真实 PowerShell adapter、SQLite regression、UI alignment 与打包；未发现已配置 self-hosted/local VM | GitHub hosted 可做自动探针和打包，但大库磁盘/时长是否足够仍未闭合；真实交互 seam 也仍需人工或 self-hosted Windows |
| v3.1.11 与 v3.1.12 四制品能否安全取得 | PROBE → PARTIAL | 本地有 annotated tag `v3.1.11@e17f29d2`，但本机没有 3.1.11/3.1.12 exe；GitHub run `32340168096` / #754 成功，3.1.12 `windows-installer` artifact `9396970441`（100,476,089 bytes）和 `windows-portable-exe` artifact `9396972327`（99,880,662 bytes）未过期，保留到约 2026-08-21 07:12Z；尚未只读确认 v3.1.11 Release asset 清单 | #754 制品窗口很短，下载/dispatch 属后续远端动作；installer artifact 仍需在 Windows 安装后解析 installed exe，不能拿 setup 本体冒充 installed 变体 |
| runner CLI 与三场景 golden 精确输入 | PROBE → CLOSED | `scripts/measure-packaged-startup.js` 强制四个固定 label、`runs>=5`、三场景之一和单一 `--golden-db`；crash 另强制非空 `--golden-wal` + `--wal-sentinel key=value`，normal/migration 禁止 WAL/SHM/sentinel；四制品必须不同 SHA/版本，报告 schemaVersion=2 且结论默认 `not-evaluated` | PR5 只能由外部证据层在完整成功样本上计算/签字，runner 自身不会自动宣称 70% |
| 仓内是否有无敏感 2.7–2.9GB 等价样本或生成器 | BLOCK → CLOSED | 项目负责人已选择方案一：正式 STP-08 只接受受控 Windows 本地挂载、已脱敏且由数据负责人确认的约 2.9GB golden；仓内/公开 CI 只生成小型 deterministic rehearsal，永远 `not-evaluated` | 不修改 Spec/TechDoc；不得上传正式 DB/WAL/SHM/userData/Documents/raw logs，不得以 synthetic rehearsal 替代正式样本 |
| GitHub Actions 磁盘/时间/制品边界 | PROBE → OPEN | 当前 workflow 使用普通 `windows-latest`，无 larger/self-hosted runner；artifact 明确 `retention-days: 1`。官方 limits 页面在当前网络不可达，尚无可引用的实时配额证据。现 runner normal 会冻结一份 golden 并持有四份 working DB，2.9GB 输入仅这五份即约 14.5GB，尚未计 source artifact、Node、四制品与临时 schema probe | 普通 hosted runner 对 2.9GB 合格样本有高概率磁盘不足；不得凭记忆写死配额或直接 dispatch 重任务 |
| PR5 最小代码/文档产物 | PROBE → CLOSED | 保留 PR3 runner；新增本地受控 Windows orchestration、逐样本 owner-marker 清理、phase/evaluator/privacy allowlist、结构化人工 receipt 与 deterministic rehearsal generator。不新增公开 workflow，不接触远端 | 正式与 rehearsal 共用 harness，但 mode 与评价状态 fail-closed 隔离 |

### PR5 Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 正式 golden 只从受控 Windows 本地挂载读取 | 项目负责人明确选择方案一；隐私红线禁止任何数据库/sidecar/userData/Documents/raw log 外发 | GitHub artifact/Release、仓库 fixture、synthetic 正式样本 | 正式运行工具拒绝 golden 位于 workRoot 内，报告只记录 SHA/size 与 manual receipt digest，不记录路径 |
| 两代 setup 必须静默安装到 owner-marked workRoot 后解析根目录唯一产品 exe | setup 本体不是 installer-installed 变体；安装 provenance 必须连接 setup identity 与 installed exe identity | 直接跑 setup、从系统默认安装目录猜路径、从 tag 重建 | 安装/卸载/目录清理均限制在 exact root；portable 只复制冻结后直接运行 |
| normal 默认 8 轮；formal evaluator 对四 label 要求全部样本成功且数量精确等于 contract runs | 防止删首样本、过滤失败、pool/average 或样本不对称 | 只取成功样本、跨 installer/portable 合池 | installer 与 portable 分别比较 raw `externalFullReadyMs` median；两者均 ≥70% 才进入人工终签 |
| non-normal sample 在 evidence 固化后逐样本删除 | 5 轮×4 变体×2 场景约 116GB 累积；保留所有副本不适合受控主机 | 删除源 golden、整根递归模糊清理、跑完后统一清理 | cleanup 必须有 workRoot marker、exact direct-child target、非链接祖先与删除后不存在 receipt；任一失败中止且 not-evaluated |
| 3.1.12 phase inventory 固定为 TechDoc 12 个 end record | 产品只把 `state=end` 写入 metrics；成功样本应有完整闭合记录 | 只检查 window-ready/startup-total、允许重复/未知 phase | exact once、finite duration、合法 outcome/counts；3.1.11 明确标记 `unavailable-legacy` |
| 机器证据与 MANUAL receipt 分层 | 人工脱敏/代表性/最终签字无法由机器推导，也不能用 CLI 自由字符串伪装 | `--anonymized yes`、环境手填文本、自动替人签字 | 结构化 receipt 有 kind/schema/布尔确认/签名人角色/时间及绑定 SHA；报告标记 evidenceSource=`manual` |
| output parent 也属于启动前保护身份 | 只保护 output target 仍允许 parent 在 guard 后被 rename→symlink/reparse 重定向 | 只比较 output lexical path、写入时重新 `resolve` 当前 parent | guard 固定 parent lstat/realpath/stable volume-file identity；写前复验并只在已复验 canonical parent 下 `wx`，身份不可靠或变化即 fail-closed |
| MANUAL 收据采用 `M → process → R → final` 单向链 | process/window/failure seams 只能在完整 machine evidence `M` 生成后观察；final owner 必须复核已绑定 process receipt 的 release candidate | process/final 同时预签同一个 candidate、final 自引用尚未生成的 candidate | 时间只接受 canonical ISO；golden `signedAt<=M.generatedAt<=process signedAt<=bind now`；`R=H(kind,M,processReceiptDigest,boundAt)` 并公开 `releaseBoundAt`；`boundAt<=final signedAt<=finalize now`；已绑定 draft 不能重新 bind |
| public report 保留可独立复验的完整安全 projection | 只有 `fullReportDigest` 或 timing 会使 finalize 无法验证被删 raw report 中的 phase、bundle、recovery、migration、cleanup 事实 | 上传 raw report/log，或只保留摘要结论 | known-field 重构每个样本的完整隐私安全 projection；recursive exact schema 拒绝未知字段、账号/金额/SQL/路径；digest 只作附加绑定 |
| normal bundle 用逐 variant 链式连续性 | SQLite 启动可能改变 main/WAL/SHM；不能要求每轮 before 都等于原始 golden，也不能让轮间替换不留痕 | 每轮重置 golden、只校验首轮、忽略 after | initial 与 round 1 before 绑定 approved golden；之后严格 `previous.after → next.before`，三 sidecar identity 同时校验 |
| cleanup receipt 使用无路径 canonical public token | ownerId/relative path 不能进入公开报告，但仅验 64hex 会允许 64 次复用同一 receipt | 公开 ownerId/path，或只检查 hash 格式 | remover 只有 exact target 删除并以 `lstat` 证实 absent 后，才返回 `H(schemaVersion,kind,comparisonId,scenario,label,round)`；raw/projection/finalize 重算且 64 个 token 全 comparison 唯一 |
| 失败/缺失也保留安全 evidence projection | 一个 failed/missing sample 不能令三个 scenario 全部消失，否则 blocker 本身无法审计 | 上传 raw report，或 blocker 时输出空 scenarios | failed 至少 round/status/evidenceCode；安全取得的 phase/ready/bundle/recovery/cleanup 保留，否则 explicit unavailable；缺轮补 `MISSING_SAMPLE`，缺场景保留 unavailable 占位，comparison=null/formal=false |
| machine/PE 字符串先做安全分类 | WMI caption/CPU/disk 与 PE FileVersion 都可能携带任意自由文本或账号型数字 | 原样发布 WMI/PE，或删除解释性能所需全部环境 | OS/arch 与 disk class 用枚举、CPU model 用 SHA-256、PE exact FileVersion 只接受纯 dotted numeric；Defender 三布尔缺失保留 null 并令 machine evidence not-evaluated |
| formal golden receipt 是零 mutation preflight | receipt 若在 install/runner 后才验证，即使最终 not-evaluated 也已发生不应执行的安装和大库复制 | 运行后再补签、仅检查 receipt 路径存在 | machine `generatedAt` 固定后、创建 workRoot 前逐场景校验普通非链接 receipt exact schema/签名/确认/时间及 source main/WAL/SHM hash+size；process/final 仍只能后两阶段提供 |

### PR5 PROBE Evidence

| 证据 | 结果 | 覆盖 |
| --- | --- | --- |
| `git status --short --branch` / `git rev-parse HEAD` | 分支 `codex/v3.1.12-pr5-windows-evidence`，HEAD `7262c8b5b7f5edff2fd09a437777428b6a641145`；保留既有 untracked，不触碰 | ownership 与基线 |
| GitHub connector：PR #155 head `ef0bf8cd...` → workflow run | run `32340168096` / #754，smoke-test 与 build 两 job 全部 success | Windows hosted 与 #754 真实性 |
| GitHub connector：#754 artifacts | installer/portable 两 artifact 均 `expired=false`，约 100MB，各自有 GitHub digest，2026-08-21 到期 | 3.1.12 制品可取得窗口；未下载/未外发 |
| 本机环境/仓库 inventory | Darwin arm64；无 PowerShell/QEMU；磁盘剩余约 45GiB；仓内无 >500MB 文件，无 2.7–2.9GB fixture/generator | local Windows 不可用与样本 BLOCK |
| workflow/runner source audit | build artifact retention=1 天；真实 PowerShell adapter 在 release-check 后独立串行；runner 三场景、四 label、轮换、逐样本 SHA、WAL sentinel、schema 白名单、token-aware cleanup 合同均已存在 | 最小 PR5 不应重写 PR3 runner |
| PR5 tests-first red evidence | 新增 orchestrator/evaluator/rehearsal tests 首跑因模块不存在与 runner 缺 `prepareVariant`/`afterSampleCleanup` 为 37 PASS / 4 FAIL；preflight 红测又证明旧实现会在缺场景时先调用 PowerShell 并创建 workRoot | 证明新增实现与 runner hook 不是仅靠静态文档；所有外层写入前必须先闭合完整配置合同 |
| PR5 受控编排聚焦门禁 | `node --test` 合跑 packaged runner、Windows acceptance 与 rehearsal generator 最终为 62/62 PASS；三脚本 `node --check` 与 `git diff --check` exit 0 | 覆盖 actual NSIS setup→installed exe provenance、四制品 freeze/revalidation、三个 runner report 与安装/冻结 identity 交叉绑定、三场景同 host 串行、逐样本 exact cleanup、双 median evaluator、phase inventory、结构化 receipt、privacy allowlist 与 rehearsal 永久 not-evaluated |
| PR5 rehearsal 边界 | generator 只生成 current-schema 小型 deterministic fixture，manifest 固定 `synthetic=true`、`formalUseAllowed=false` 与 `not-evaluated`；三场景 orchestration 由 dependency-injected harness 动态测试 | 不生成/伪装正式 2.9GB synthetic golden；migration/crash rehearsal 只能用另行审查的小型专用 fixture，正式仍须人工受控样本 |
| PR5 全量本地门禁 | Round 2 `npm run release-check` exit 0：lint PASS、smoke PASS、unit 5561/5562 PASS（0 fail、1 Windows-only skip；日志 `unit-20260820-170741.log`）、integration 48 scripts / 2410 assertions PASS（300,020ms）；recursive comparison schema 增量后最终 unit 5561/5562 PASS（日志 `unit-20260820-171449.log`）；`npm run check:vars` exit 0（`src/` 无改动）；自动更新的 integration 耗时噪声已恢复；最终 `git diff --check` PASS | 仓库自动回归闭合，但 macOS 自动门禁和 dependency-injected Windows harness 不替代受控 Windows 的四真制品/2.9GB/人工观察与签字 |
| PR5 blindspot 收口 | 发现并红测 outer evaluator 未把 runner-observed exe identity 与 setup-installed/portable-frozen identity 交叉绑定；已要求三场景四 label 的 SHA/size/exact fileVersion 全等，且 installer/portable provenance 结构合法。另分开采集 workRoot/golden local-fixed path class，并修正 Defender exact-root exclusion 命中 | 关闭“安装后、runner preflight 前替换 exe 仍各层自洽”的证据旁路；不是 Windows 成功结论，仍待真实主机复验 PowerShell/NSIS 行为 |
| PR5 Review Round 1 P0 output 保护 | Reviewer 证明 output 若与 source/draft alias 会在运行末覆盖保护输入；现于任何 install/runner mutation 前固定 config/draft/四制品/三个 bundle/sentinel/receipts 的 lexical+realpath+BigInt `dev/ino`+size/time identity，output 必须不存在，写前全量复验并以 `wx` create-new | exact/symlink/hardlink alias 均在 mutation 前拒绝；Windows `dev/ino<=0` 时 fail-closed，不猜 file identity；formal run 与 finalize 共用同一 guard |
| PR5 Review Round 1 working copy | 只读 frozen golden 复制会继承 readonly，真实 packaged SQLite 可能无法打开写连接；working main/WAL/SHM 复制后显式恢复 owner writable 并做 `r+` probe | source 与 runner-owned frozen bundle 仍只读且 hash 不变；Windows chmod/r+ 行为继续由真机门禁复验 |
| PR5 Review Round 1 formal evidence | formal 固定 8 轮；evaluator 校验 exact rotation/首样本、initial+每样本 bundle、ready/window/Close/root exit0/三轮空树、graceful cleanup、三场景精确后验与 pending=0；报告只投影隐私安全结构并绑定 full raw report digest | known rehearsal/synthetic origin formal fail-closed；process/window/failure 人工观察新增 candidate-bound `windows-evidence-reviewer` receipt，自动证据不冒充人工 |
| PR5 Review Round 1 finalize/privacy/provenance | finalize 从当前 canonical projection 重跑 artifact/scenario/sample/process/privacy/median gates并重算 candidate；recursive allowlist 拒绝任意未知嵌套 key、账号/金额/SQL/raw/path；setup/source/installed/frozen/launched 全链 exact hash/size/fileVersion；golden receipt 增绑 SHM | 不信 draft cached comparison/candidate；installer 固定 NSIS explicit-owned-root + unique product exe resolution，portable 强制 source=frozen=launched |
| PR5 Review Round 1 median/cleanup probe | 70% 以未 round Number median 裁决，展示才 round；真实 runner `main` dependency probe 动态执行四变体×5 共 20 次 callback，并验证 exact sample target 删除、source/frozen 不变；第 3 次 cleanup callback failure 立即 aborted/not-evaluated 并保留 sample | 覆盖 69.9996% false、exact 70% true、just-above true；替代旧 regex-only hook 证据 |
| PR5 Review Round 1 tests-first 红→绿 | working copy readonly probe 先为 0/1（`EACCES`）后绿；formal/privacy fixture 收紧曾为 55/56 与 13/20；comparison 层“合法字段错层”新增反例先为 19/20；修复后聚焦 62/62 | 红测均由对应 fail-closed 生产修复关闭，未删除断言、未放宽正式口径；全量 unit 首轮有 1 个无关 archive symlink 时序错误，隔离重跑 1/1 与随后全量 5561/5562 均绿 |
| PR5 Review Round 2 output/environment/chronology | output parent rename→symlink 攻击红测先因缺少 stable directory guard 为 0/1，加入 parent lexical+realpath+stable identity 与 canonical `wx` 后 1/1；三字段 environment、CPU/privacy 篡改、1999/2000 倒序 receipt 均 fail-closed；单向 rebind 红测先 1/2 后 2/2 | candidate 不信 draft environment digest；完整 canonical machine projection 与固定 privacy 进入 `M`，process receipt 生成 `R` 后才能终签；没有预签未来 candidate |
| PR5 Review Round 2 structured projection | public report 保留 12 phase records、ready/process/window、before+after bundle、完整 recovery counts、migration column/index/fingerprint 与 sample cleanup；normal 连续性、64hex sidecar、ready phase 交叉绑定和任意 projection 篡改均有聚焦反例 | `fullReportSha256` 仅为附加证据；finalize 从 projection 重新验证，未知 nested key 或敏感字段仍由 recursive allowlist 拒绝 |
| PR5 Review Round 2 writable/cleanup | working recovery sentinel 与 main/WAL/SHM 一样清 readonly 并做 `r+` probe，source/frozen 仍只读；runner 动态 4×5 callback 要求每次返回 `verifiedAbsent=true` receipt，throw/false/missing 第 3 次即 abort/not-evaluated 并保留失败 evidence | 当前三份 PR5 聚焦测试 70/70 PASS；真实 Windows readonly/删除消费仍为 MANUAL / NOT RUN，不把 dependency-injected harness 当真机证据 |
| PR5 Round 3 blindspot 与全量门禁 | protected input 自身 symlink 红测 0/1→1/1，首次冻结和写前复验都拒绝 link/reparse；portable 全链缺 `fileVersion` 红测 0/1→1/1；rebind 红测 1/2→2/2；dangling cleanup target 曾被 `existsSync` 误判 absent，红测 0/1→lstat link 拒绝 1/1；任意绝对/相对 path value 红测 0/1→1/1；normal steady schema、migration VACUUM 前置与 crash recovery sentinel 均进入结构化 projection/finalize 复验；新增文件 EOF 检查发现并移除 rehearsal test 末尾空行 | 最终 `npm run release-check` exit 0：lint/smoke PASS，unit 5569/5570 PASS（0 fail、1 Windows-only skip；日志 `unit-20260820-183228.log`），integration 48 scripts / 2410 assertions PASS（288,726ms），自动生成的 policy 耗时噪声已恢复且无 diff；`npm run check:vars` exit 0（`src/` 无改动）。Reviewer Round 3 随后以动态反例 BLOCK，不能把当时工具链门禁表述为正式 Windows 结果 |
| PR5 Review Round 3 → Round 4 tests-first | Reviewer 的 10 类动态反例首轮聚焦为 67/80 PASS、13 FAIL（含 formal preflight 3 个子测）：缺 cleanup handler 仍复制/启动、future/noncanonical receipt、Defender missing→false、1ms external 小于 5/6/7s internal、cleanup/nonce 全量复用、failed projection 清空、root dangling symlink、缺/错 golden receipt 仍先安装。生产修复后两文件 80/80，限定盲扫又补 PE FileVersion 自由文本 0/1→1/1、缺轮/缺场景 projection 0/1→1/1；三份 PR5 聚焦最终 81/81 PASS | cleanup token 与 chronology 设计无新 BLOCK；Reviewer Round 4 随后关闭原 10 项主路径，但发现 3 个直接旁路，转入下一行修复；真实 Windows 四制品/2.9GB/人工 receipts 继续 MANUAL / NOT RUN |
| PR5 Round 4 最终本地门禁 | `npm run release-check` exit 0：lint/smoke PASS，unit 5580/5581 PASS（0 fail、1 Windows-only skip；日志 `unit-20260820-192425.log`），integration 48 scripts / 2410 assertions PASS（404,525ms）；自动生成的 policy 耗时噪声已精确恢复且零 diff。`npm run check:vars` exit 0（`src/` 无改动）；三个 runner/generator `node --check`、`package.json` 解析、`git diff --check`、真实用户 DB 绝对路径扫描及五个新增文件 `--no-index --check` 均符合预期 | 这些门禁只证明工具链与回归，不构成 Windows 实测、人工 receipt 或 70% 结论；必须以同一 Reviewer Round 4 复审及受控 Windows MANUAL evidence 为准 |
| PR5 Review Round 4 → Round 5 tests-first | Reviewer 动态复现：宽松 36 字符 power plan GUID 可公开长账号型数字、三个 exact tiny golden receipts 可进入 installer、缺单 variant 会在 projection 解引用 `samples` 抛 `TypeError`。三项红测为 37/41 PASS（3 个根失败，tiny 子测同时使父 test 失败）；最小修复后主 acceptance 文件 41/41 PASS | GUID raw normalization/canonical/allowlist 只接受 lowercase `8-4-4-4-12` hex；formal 三份 source receipt 完成 hash/size 绑定后逐一要求 main `>=2_700_000_000` bytes，失败时 workRoot/install/runner 均为 0；缺 variant/samples/variants 输出 exact unavailable projection 且保留其它安全场景。full gate 与 Reviewer Round 5 尚待完成，不宣称仅剩人工项 |
| PR5 Round 5 最终本地门禁与复审 | 三份 PR5 聚焦 84/84 PASS；`npm run release-check` exit 0：lint/smoke PASS，unit 5583/5584 PASS（0 fail、1 Windows-only skip；日志 `unit-20260820-194950.log`），integration 48 scripts / 2410 assertions PASS（394,377ms）；自动 policy 耗时噪声已恢复且零 diff。`npm run check:vars` exit 0（`src/` 无改动）；三个脚本 `node --check`、`package.json` 解析、`git diff --check`、真实用户 DB 绝对路径扫描与五个新增文件 `--no-index --check` 均符合预期。同一 Reviewer Round 5 独立复验 GUID 4 例、tiny golden 1 例、missing projection 3 例并确认 P0/P1/P2/P3 均无发现、无阻塞 P3+ | 复审结论只允许代码证据工具链进入后续流程；自动门禁不构成真实 Windows 四制品/约 2.9GB/人工 receipt 或 70% 结论，正式 STP-08 仍为 `not-evaluated` |

### PR5 Remaining Unknowns / BLOCK

| 未知 | 处理 | 负责人/下一步 | 发布影响 |
| --- | --- | --- | --- |
| 合成性能等价库能否满足“同一份脱敏数据库副本” | CLOSED | 已选方案一；formal 拒绝 synthetic，rehearsal 强制 `not-evaluated` | 无 Spec/TechDoc 偏差；正式 70% 仍需受控 Windows 与人工 receipt |
| v3.1.11 Release asset 精确清单 | PROBE | 样本口径决定后，通过有权限的 GitHub/Windows 环境只读校验并固定 SHA；不得以本地 tag 自行重建品替代 Release 制品 | 四制品真实性门禁 |
| hosted runner 实时磁盘/时长配额与大库成本 | PROBE | 若选 GitHub hosted，先做不含敏感数据的磁盘预算/小样本 rehearsal；若选 self-hosted，记录磁盘、供电、Defender、介质与 cache 条件 | 决定 workflow 拆分或 self-hosted 路径，不改变四变体同机同条件合同 |
| 正式 Windows STP-08 数据与人工 seams | MANUAL / NOT RUN | 数据负责人提供并签署三个本地挂载脱敏 golden receipt；受控 Windows 实际运行四制品 normal 8 轮及独立 migration/crash；人工观察 window/process/failure seams；发布负责人绑定 candidate SHA 终签 | 在这些真实输入与签字完成前只允许报告工具链 ready，不得宣称 70% 或正式 pass |
| v3.1.11/v3.1.12 来源制品身份 | MANUAL / NOT RUN | 在受控 Windows 取得两代 Release/setup/portable 来源，固定 SHA/size/exact fileVersion；setup 必须安装后取 installed exe | 当前本机无四个 exe，未下载、未重建、未伪造任何 Windows 结果 |
