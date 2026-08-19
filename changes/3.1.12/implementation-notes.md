# v3.1.12 Implementation Notes

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
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
