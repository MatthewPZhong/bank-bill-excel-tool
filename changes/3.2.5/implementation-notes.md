# v3.2.5 Implementation Notes

## Baseline

- Goal：完成 v3.2.5 E13-A～G、R3.2.5、版本元数据/发布文档与最终审计收口。
- Exact local parent：v3.2.4 最终本地候选 `c5c21f9a34566c6509257e31a05d2dcbdbf06805`。
- Authority：[spec.md](./spec.md)、[techdoc.md](./techdoc.md)、[implementation-sequence.md](./implementation-sequence.md)。
- Preflight：[preflight.md](./preflight.md)、[preflight-baseline-validation.json](./preflight-baseline-validation.json)。
- Done when：8 PR 严格顺序实施/传播/合并到 v3.2.5；当前树 validation/checksum、版本/三份发布文档、适当完整测试与人工状态均可审计；main/tag/production 不修改。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 顶层 Spec/TechDoc bootstrap 逐字节同步冻结来源；实施期只接受精确记录且受测试约束的合同修订 | 防止按老 changes 副本或编号猜范围，同时不能让已证伪的 Position export/import、Acquiring 资源拓扑或 Main authority 继续充当 current authority | 任意润色顶层副本、静默修改冻结基线、维持已证伪的 topology/authority | 冻结来源保持原 hash；E13-B～F 的每一处 current-tree delta 均由 exact-once transformer 与当前 hash 锁定，其他漂移一律失败；E13-G 以 current authority 重建最终证据。 |
| 旧 `29/29` 与 `69/69` 只作历史证据 | 当前独立复验为 checksum `61/69`、validation `28/29` | 重算 checksum 伪造一致 | E13-G 必须修真实 binding/AST authority 后再生成最终证据。 |
| checksum 必须枚举包目录并精确覆盖全部普通文件 | R3.2.5 复核发现旧校验器把 `69/69` 写死，且实际漏列 5 个已存在文档；漏项时仍会声明 PASS | 继续沿用固定计数；只用 `shasum -c` 验证已列条目 | 最终口径为 checksum 自身以外 `74/74`；校验器精确比较目录文件集合、顺序与逐文件 SHA-256，并拒绝重复、逃逸和非普通文件。 |
| Document Source 区分 bootstrap bytes 与最终 current authority | 完成审计发现 `DOCUMENT-SOURCE.md` 仍写顶层文档必须永久逐字节等于冻结副本，但同文件记录的冻结 hash 已与最终 current hash 分离，且 E13-B～G 的受控 reverse-sync 已在本表逐项记录 | 回滚已验证的 current-tree 合同；改写冻结包；继续保留自相矛盾的来源说明 | bootstrap 提交 `5913a596…64ea` 证明初始逐字节同步；冻结来源保持不变，顶层最终 hash 与已记录 delta 构成 current authority；未记录漂移继续 fail closed。 |
| E13-A～R3.2.5 全链重新叠到最终 v3.2.4 | 原 v3.2.5 本地链基于旧 v3.2.4 候选，不能用旧测试代替最终前序传播 | 只改 PR base；复用旧绿色证据 | 八段链均保留原实现为第一父、最终前序为第二父；R3.2.5 exact base 更新为最终 E13-G `7f964492…a3f1d`，需在精确新 head 重跑验证。 |
| 文档 bootstrap 不新增功能 PR | 冻结 Spec 已明确 8 PR 序列 | 增加第 9 个纯文档 PR | bootstrap 作为 v3.2.5 base/E13-A 祖先。 |
| Capability 与 Effective Production Strategy 分开 | 所有 action 初始 production disabled，人工/观察门禁未关闭 | 用实现完成自动启用 production | 每 action 可独立保持 legacy/blocked。 |
| 不运行用户禁止的三个聚合/变量命令 | 用户明确禁止 `release-check`、`check-vars`、`scan:vars` | 把未运行项写为 PASS | 用允许的 unit/integration/smoke/定向验证逐项记录，禁止虚报。 |
| E13-A 先以真实入口冻结 action 与 source authority | Pending summary 当前绑定错误、错误报告是 Main 内存状态、BizOP 为 side/legacy 双源 | 直接照 action 名猜 worker 输入 | 详细决策和证据见 [e13-a-preflight.md](./e13-a-preflight.md) 与 [e13-a-implementation-notes.md](./e13-a-implementation-notes.md)。 |
| E13-B 按真实 export 拓扑纠偏 Position policy | 全仓只有 Position import dispatcher；run/filtered export 仍在 Main 直接调用 ExcelJS，冻结 `existing-dispatch`/compound fixture 无真实实现可绑定 | 复用 import dispatcher、在 adapter 外再包 Worker、伪报 CompoundLease | 顶层 Spec 改为 native thread-single；历史冻结包保留，E13-G 以 current tree 重建 fixture。详见 [e13-b-preflight.md](./e13-b-preflight.md)。 |
| E13-B 以渠道工作簿作为 PreFund 原子 unit | 单 IPC 输出 N 个渠道文件，审计是渠道工作簿内的条件 sheet；两个 action 都要求单 artifact | 拆出新用户文件、让一个 worker 返回 N artifacts、只实现其中一个 action | 有重复审计的渠道归 `export-audit`，其余归 `export-channel`；Main 收齐后整批 Publisher。 |
| E13-B PreFund 采用双 policy 同批 gate | 一个用户批次可同时含普通渠道与重复审计渠道，混用 legacy/managed 会破坏全有或全无发布 | 只开启其中一个 action、按渠道分别发布 | 只有 `pre-fund:export-channel` 与 `pre-fund:export-audit` 同时 enabled 才进入 managed；全部 worker 成功后一次 Publisher。 |
| E13-B 把 PreFund 模板纳入 stable evidence | 数据 run 未漂移并不代表 Workbook 模板未被替换；只传 `templatePath` 会让确认后的模板变化逃过 Main/Worker freshness gate | 依赖安装目录只读假设、只在 Worker 打开模板、不复核大小/hash | Main 冻结模板 SHA-256/byteSize，Worker 与发布前 freshness 复核同一证据；漂移时不生成 artifact。 |
| E13-B Position 仅普通结果在发布后补写导出标记 | `exported_at` 是确认门禁元数据，但文件 Publisher 已成功后不能因侧库补写失败撤销或误报文件失败 | 在 Worker 写侧库、发布前标记、补写失败回滚文件 | run/difference/filtered 共用 native read-only action；仅 run 在 Publisher 后 Main 补写，失败记录 warning，差异/过滤不写元数据。 |
| E13-B Position 终态收口按 pending → receipt ACK 顺序组合 | 通用 lifecycle 原先会用 Position pending finalizer 覆盖 managed Publisher 自带的 `afterTerminal`，导致 durable receipt 在成功发布后未 ACK | 二选一覆盖 callback、先 ACK receipt 再收口 pending、并行执行两个终态副作用 | Main 用 fail-closed composition 先完成 Position pending 终态，再执行 managed Publisher receipt ACK；前一步失败时不得提前 ACK，测试锁定两步只执行一次及顺序。 |
| E13-B VCCFin 一个静态 action 承载两个真实入口 variant | action binding 已把 dataset 原表/校验表和 import anomaly audit 同时绑定到 `vcc-financial-op:export-audit`；只迁审计会留下可写开库/migration 的旧 dataset worker | 新增第二个 actionKey、只迁 import audit、继续复用 generic 可写 worker | 专用 thread worker 只用 `openVccReadDatabase/query_only`；dataset stable evidence 同时冻结 inspection、持久 dataset revision 与 archive set，保留 incomplete/archive artifact 合同；audit 只接受有 `finished_at` 且非 importing、异常数大于零的终态记录，deleted audit 仍可追溯。 |
| E13-C 按 current-tree 行为拆开 Acquiring copy/regenerate | 当前唯一 export IPC 只复制稳定 `diff_file_path`；DB→XLSX 由独立 `writeDiffWorkbook()` 提供且没有用户入口 | 继续让两个 action 复用同一 copy handler；新增隐式 regenerate IPC；运行时猜 mode | copy=inline-async 且唯一绑定现有 IPC；regenerate=unbound thread-single dormant capability；两者 production 均为 false。详见 [e13-c-preflight.md](./e13-c-preflight.md) 与 [e13-c-implementation-notes.md](./e13-c-implementation-notes.md)。 |
| E13-D 只注册 dormant Pending/BizOP existing-dispatch capability | 真实 big-table dispatcher 已拥有 root Worker、Parser Pool、单 writer 与大事务；默认 session/IPC 仍承担业务包装和人工门禁 | 再包 native Worker；复制 pool；自动切默认入口 | Runtime 增加两条 false-gated policy/adapter/topology/validator；默认 effective strategy 仍为 legacy。详见 [e13-d-preflight.md](./e13-d-preflight.md) 与 [e13-d-implementation-notes.md](./e13-d-implementation-notes.md)。 |
| E13-D 用 envelope exact-7 绑定旧 engine 的 batch identity | blindspot 发现 Supervisor 与 engine 原先可分别采信 `context.value` 和 caller `input.batchContext` | 假设两份值自然相同；只比较 operationKey；静默采信 caller | adapter 逐字段拒绝分叉并注入 Main-owned context，避免 receipt/recovery 主键漂移；Spec/TechDoc 已 reverse-sync。 |
| E13-E 按 current-tree 真实 Acquiring topology 修订历史资源声明 | 设置/Main 合法 workerCount 上限为 8；single/resume hard gate 没有 nested child；旧 fixture 分别写 4 与虚构 compound | 静默 clamp 到 4；为 single 路径申领一个虚构 child；照旧 fixture 低报/重复计费 | `run-new-eligible` childrenMax=8，`run-single-or-resume.compound=null`；冻结基线不改，E13-G 重建 current fixture。详见 [e13-e-preflight.md](./e13-e-preflight.md)。 |
| E13-E 以 exact-5/7 共有字段锁定 run owner | Protocol policy 是 operation exact-5，但既有 chunk/recovery progress 持久化 exact-7 File Task owner | 丢弃 batch identity；让 caller 提供两套不相关 owner；由 adapter 推测 batchId | adapter 要求 Main-owned exact-7，并逐项匹配 exact-5 共有字段；分叉在 dispatcher/DB 写入前拒绝。 |
| E13-E resume 由 Main authority 重建而非透传嵌套 plan | blindspot 发现 `resumePlan` 携带 dbPath/progress/output authority，直接透传还会丢失 legacy 的持久 chunkSize 优先规则 | 信任 caller 完整 plan；只检查 runId；把责任留给未来 route | input 只接受 `resumeRunId`；adapter 重新 prepare/freshness，绑定 persisted exact-7 owner 和 output intent，持久 chunkSize 优先。 |
| E13-F 按真实 Position import 0/1 子进程拓扑修订冻结资源声明 | bank prepare 与 confirmed apply 只运行 root 或顺序 schema→apply；source root 等待 durable grant 时最多并发一个 Main schema process | 沿用冻结 childrenMax=4；所有 intent 固定申领 1；禁止 zero-child compound | current childrenMax=1、intent child=0/1；Supervisor 允许合法 0 child 但继续拒绝负数/超上限。详见 [e13-f-preflight.md](./e13-f-preflight.md)。 |
| E13-F 以 Main-owned selector/grant/checkpoint/owner 绑定原 dispatcher | prepared preflight 与 durable grant 都是持久 mutation 权限；caller 透传会绕过 kind/freshness/身份边界 | 直接透传 preflight/sideDb/checkpoint/token；原样返回 provider grant | exact-5/7 共有五字段一致，operation token=`taskRunId`；prepared selector 完整验证，source grant 精确 allowlist。 |
| E13-F 取消以真实 ACK/terminal 与下一安全点为准 | raw `cancel()` true 只证明消息投递；protected schema 可拒绝即时取消，Main authorizer 可能在取消后返回 | posted 即 cancelled；schema 结束后继续 apply；authorizer 返回后继续发 grant | accepted=false 不伪造 cancelled，但已记录 job cancel 会在 schema/grant 后阻止后续 mutation。 |
| E13-G 将 Runtime capability 与真实 legacy-only binding 面严格分层 | 盲区复核发现 PreFund bank import/run 是真实 Main/TaskPolicy 入口，但没有 Runtime capability；把它们塞入冻结 Registry 会破坏 v3.2.1/v3.2.2 authority 和历史证据 | Manifest 继续漏列；任意允许 Registry 外 action；为两个旧入口伪造 Runtime policy | Runtime Registry/冻结 Spec 保持 52 actions/59 rows；Manifest/Binding 精确为 54 actions/61 pairs，仅允许两条 exact legacy-only action，三类负向 mutant fail closed。 |

## Evidence / Deviations

| 项目 | 当前结果 | 影响/后续 |
| --- | --- | --- |
| Frozen/current document hashes | 冻结 Spec `13410e4e…98f2`、TechDoc `3fb18459…e64f`、split plan `27bbdde9…174a`；当前 Spec `d223b7ad…244f`、TechDoc `f63e1220…9933` | 冻结来源未修改；顶层含已记录且受测试约束的 E13-B～G current-tree 修订，不能宣称仍逐字节一致。 |
| Package checksum | 旧 `69/69` 已证伪为漏列 5 文件；最终 current-tree validator `29/29 PASS`、checksum `74/74 PASS`，并由目录集合驱动的校验器与缺失/额外/重复/乱序/逃逸/非普通文件/byte tamper 负向测试复验 | checksum 只证明最终 bytes 完整；本结果不被解释为额外语义授权。 |
| Published/current validation | current tree `29/29 PASS`、0 error、73 inputs；Runtime Registry 52 actions、Spec table 59 rows；Manifest/Binding 54 actions、61 pairs | 旧历史 report 未作代偿；精确 legacy-only 例外及三类 mutant 已由当前 validator 复验。 |
| Production/human gate | production=false；资金/恢复 `PENDING_HUMAN_REVIEW` | 本 bootstrap 不改变。 |
| E13-A unknowns-first | summary=aggregate；Pending errors 需 managed source；Pending/BizOP stable gate 必须在 Worker read snapshot 内复核 | 进入模块专用 worker 实施；不改 legacy effective strategy。 |
| E13-A capability validation | 定向 `18/18 PASS`；重点既有回归 `181/181 PASS`；完整单测 `6784/6787 PASS`（`0 FAIL`、`3 SKIP`）；相关集成 `179/179 PASS`；smoke PASS；Main freeze 为紧凑 run/dataset/revision 证据，Pending 大错误源采用版本 authority + 异步流式 staging | 本地 capability 已收口；production 仍为 false，Windows/真实样本/资金恢复人工门禁留到 R3.2.5。 |
| E13-B unknowns-first | PreFund=N 个单 artifact unit + 单批发布；Position 冻结 adapterKind 与真实代码冲突；VCC 现有 dataset worker 会可写开库/迁移，audit 仍 direct | 先修顶层合同和稳定来源计划，再写模块专用只读 worker；不复用错误拓扑。 |
| E13-B PreFund capability validation | 定向 `6/6 PASS`；普通/审计 workbook 与 legacy 语义 golden 等价；未 ACK、mirror/side/模板漂移、缺失 unit、后序 unit 失败与预启动取消均 fail closed；真实 Runtime 在线程 Worker 完成 | production 仍为 false；模板 SHA-256/byteSize 已绑定 stable evidence；Windows、真实资金样本与人工复核留到 R3.2.5。 |
| E13-B Position capability validation | 定向 `5/5 PASS`；run/filtered workbook 与 legacy 语义 golden 等价；真实 Runtime 完成；stale checkpoint 与空差异不产 artifact；源文件采用 `lstat → open → fstat` 的 ordinary-file identity/size/mtime guard 并对已打开字节计算 SHA-256；单次 Publisher 后元数据补写失败只告警；终态严格先收口 pending、再 ACK managed Publisher receipt | production 仍为 false；Position import utility adapter 属 E13-F，本切片未改变 import dispatcher、匹配算法、金额/币种/排序或确认事务。 |
| E13-B VCCFin capability validation | 定向 `13/13 PASS`；import audit 与 dataset workbook 均和 legacy 语义 golden 等价；真实 Runtime 完成；active/unfinished/empty audit、record/anomaly/lineage/异常字段 JSON 漂移或损坏、同数量 dataset revision 漂移、预启动取消与 artifact 篡改均 fail closed；dataset source freshness 在 legacy writer 自身的只读事务内、查询和写 workbook 前复核；Publisher 失败不产正式目标；managed export 复用模块全局串行租约；Main 三次 freshness + artifact 回读后才单次 Publisher | production 仍为 false；既有 dataset incomplete 说明、bound archive integrity failure、SQL/排序、金额币种、六列 audit 与 VCC 专用 durable receipt 均未改变。 |
| E13-B Windows SQLite cleanup 复核 | current exact Windows CI 在事务断言通过后因第二个只读句柄尚未关闭而 `EBUSY`；测试现用 `try/finally` 在 fixture 删除目录前关闭其自有句柄 | 仅修正测试资源生命周期，不改变 read transaction、SQL、Workbook 或 production gate；不得依赖多个 `t.after` hook 的注册顺序。 |
| E13-B capability/full regression | E13-B 三模块定向集 `24/24 PASS`；五文件重点合同集 `37/37 PASS`；完整单测 `6808/6811 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260830-215741.log`；53 个 integration 脚本 `2488/2488 PASS`；smoke PASS；全部改动 JS 通过 `node --check`，`git diff --check` PASS | 一次全量并发运行曾令既有 MPT transport 用例出现 `1 FAIL`，该精确文件连续两次 `39/39 PASS`，随后全量复跑 `0 FAIL`；未以失败快照作为绿灯。blindspot/reconciliation 已关闭模板 authority、Position 源文件 identity、Position pending/receipt 终态组合、VCC 审计 JSON、dataset 同事务 freshness、manifest 关系与 FilePlan 顺序缺口；尚需最终 diff review/候选提交。Windows、真实资金样本及资金/恢复人工复核留到 R3.2.5，production 仍为 false。 |
| E13-C current-tree classification | 当前唯一 `acquiringBillCurrency:export` 只绑定 copy；regenerate 无 legacy TaskPolicy binding；binding pair 从 60 收紧为 59，顶层 Spec/TechDoc 已 reverse-sync，冻结基线未改 | E13-G 必须重建 current manifest/provenance/checksum，不能用旧 fixture 代偿。 |
| E13-C capability validation | 定向 `10/10 PASS`；E13-A/B/C 扩大回归 `115/115 PASS`；Acquiring/Registry 重点回归 `60/60 PASS`；完整单测 `6819/6822 PASS`（`0 FAIL`、`3 SKIP`，日志 `unit-20260830-232228.log`）；Acquiring 集成 `252/252 PASS`；smoke、ESLint 与语法 PASS；copy 的普通文件/hash/staging/Publisher 和 main/side regenerate 的 complete-only/read-only DB/original writer/Workbook 回读均已验证；交叉输入与 Publisher failure 均 fail closed | production 仍为 false；Windows、真实大 run/RSS 与资金恢复人工门禁留到 R3.2.5。 |
| E13-D capability/full regression | E13-D+mature adapter `16/16 PASS`；完整单测 `6824/6827 PASS`（`0 FAIL`、`3 SKIP`，日志 `unit-20260830-235725.log`）；53 个 integration 脚本 `2488/2488 PASS`（`361809 ms`）；smoke、ESLint、语法与 diff PASS；真实 Runtime/engine、CompoundLease、无 wrapper Worker、真实取消回滚、精确 result 与 exact-7 身份分叉反例均通过 | production 与默认 IPC 均未启用；Windows、真实大文件/RSS、资金/恢复人工复核留到 R3.2.5。 |
| E13-E capability/full regression | E13-E 定向 `12/12 PASS`；mature/Acquiring/Registry/Resource/Supervisor 扩大回归 `227/227 PASS`；完整单测 `6836/6839 PASS`（`0 FAIL`、`3 SKIP`，日志 `logs/unit-tests/unit-20260831-005448.log`）；53 个 integration 脚本 `2488/2488 PASS`（`282902 ms`）；smoke、ESLint、语法与 diff PASS；真实 Parser/side DB、D31、single/resume、mirror、取消、exact-5/7 owner 与 Main-owned resume authority 均通过 | production 与默认 IPC 均未启用；Windows、30 万+真实 run/RSS、资金/恢复人工复核留到 R3.2.5。首次隔离全量运行的依赖树不符合 lockfile，改用精确 `app-builder-lib 26.15.7` 后完整复验，未把环境失败记作代码 PASS。 |
| E13-F capability/full regression | current Spec/TechDoc hashes `d5b58458…b6a2` / `5ee46941…a7a2`；E13-F 核心 `12/12 PASS`，E13-F/mature/runtime/合同最终组合 `36/36 PASS`；完整单测 `6848/6851 PASS`（`0 FAIL`、`3 SKIP`，日志 `logs/unit-tests/unit-20260831-020452.log`）；53 个 integration 脚本 `2488/2488 PASS`（`264007 ms`）；smoke、完整 ESLint、语法与 diff PASS；R3.2.4 历史 exact evidence PASS；Windows contract `6/8 PASS`、`2 SKIP` | 0/1 topology、Main-owned absolute paths/owner/selector/grant、privacy result、protected schema、等待 authorizer 取消、同 job exact ACK、矛盾/非法 count evidence 反例已锁定。首次全量单测仅发现测试 registry 期望漏列新 action（`1 FAIL`），修复后精确 `10/10 PASS` 且最终全量 `0 FAIL`；未用失败快照代偿。Windows 两个真实 packaged canary 只可在专用环境运行，production 与默认 IPC 仍为 legacy/false，资金/恢复人工门禁未解除。 |
| E13-G manifest/full regression | 入口盲区复核将中间 52 actions / 59 pairs 修正为最终 Manifest/Binding 54 actions / 61 pairs：补入 PreFund bank import/run 两个真实 legacy-only 入口，同时保持冻结 Runtime Registry 52 actions / 59 Spec rows；36 runtime policies、16 legacy-only、2 platform canary；6 surfaces `324/324`、production enabled=0；validator `29/29 PASS`、73 inputs；最终定向 `27/27 PASS`；unit `6857/6860 PASS`（0 FAIL、3 SKIP，`unit-20260831-032421.log`）；integration 53 scripts、`2488/2488 PASS`（349045 ms）；smoke PASS | 首次完整 unit 的 Windows NSIS 失败归因于复用旧 `app-builder-lib 26.8.1`；隔离安装 lockfile 精确 `26.15.7` 后精确 Windows contract与完整 unit均0 FAIL。随后错误把两 legacy action 写入冻结 Registry 导致 7 个历史 evidence FAIL，分层修复后历史/当前测试恢复 0 FAIL。Capability/route/production 三者保持分离，54/54 effective legacy、worker count=0；人工资金/恢复 redline 仍 PENDING，production 仍关闭。 |
| R3.2.5 final restack validation | E13-A～G + R3 定向 `118/118 PASS`；完整单测 `6887/6890 PASS`（`0 FAIL`、`3 SKIP`，`logs/unit-tests/unit-20260831-120210.log`）；53 个 integration 脚本 `2488/2488 PASS`（315093 ms）；smoke、完整 `src/` ESLint、修改 JS 语法与 diff PASS；deterministic validator 54 actions / 29 contract checks / 74 checksums PASS | 首次全量 unit 仅暴露 E13-E 测试依赖宿主瞬时可用内存而把合法 admitted topology 从 2 降为 1；测试注入既定 admitted topology 后，E13-E `12/12`、生产资源 gate `19/19`、最终全量 0 FAIL。未改生产资源治理，production 仍关闭；Windows/真实样本/资金恢复人工门禁仍未完成。 |

## Blindspot / Reconciliation

- E13-A 已增加 dormant `src` capability，但 production 仍关闭；复用既有 SQL、排序、金额币种、Workbook 与 Publisher，不改变业务结果或持久化语义。
- E13-A/B/C 必须先建立入口到输入 authority、SQL、排序、Workbook、Publisher 的数据血缘，再实施。
- E13-B Position adapterKind 已按 current-tree 证据从 `existing-dispatch` 纠偏为 `native`；Spec 两处泛化“不可改成 thread”同时收窄到现有 import dispatcher，避免与 3.1 export action 自相矛盾。这是 topology authority 修复，E13-G 必须同步 current manifest/fixture，不能靠旧 checksum 代偿。
- E13-B VCCFin 保留既有 `vcc-financial-op:export-audit` 一对二入口 binding；dataset 与 audit 在 Worker 内各自复核完整 source evidence，不能用一个 variant 的绿色结果代偿另一个。
- E13-B VCCFin 的反例测试证明仅靠 inspection 不能捕获“同数量内容变化”；现以 import 路径事务性推进的 dataset revision 作为轻量持久 authority，避免 Main 为冻结 evidence 全量读取大表。绕过存储合同且不推进 revision 的直接 SQL 修改仍属于数据库完整性破坏，不由导出 capability 静默容忍。
- E13-B VCC dataset Worker 不在 legacy writer 外另启嵌套事务；而是把 source freshness callback 注入 writer，在 writer 既有 `BEGIN` 后、inspection/query/workbook 写入前复核，因此 authority 与实际读取共享同一只读事务快照。
- E13-B Position 源工作簿不能只凭路径或一次 `stat` 取证；当前实现绑定已打开普通文件的 device/inode、大小、mtime 与 SHA-256，并在读取前后复核，拒绝符号链接与读取期间替换/修改。
- E13-B Position 不能让 route pending finalizer 覆盖 managed Publisher 的 receipt ACK；当前组合器固定先收口 pending、再 ACK receipt，且任一步失败都不伪造后续成功状态。
- E13-B PreFund 模板 SHA-256/byteSize 已进入 `sourceDigest`，Main 冻结、Worker 读取与发布前复核均绑定同一模板内容；不能以安装目录通常只读代替证据。
- E13-C copy 与 regenerate 必须保持两个静态 action：copy 不得在 source 失败时 fallback 到 regenerate；regenerate 不得借现有 copy IPC 获得隐式用户入口。完整性证据覆盖 run/progress/flow/bill/diff，且只接受 `success + complete`。
- E13-B VCC import audit 对损坏的 `source_files_json`、`abnormal_fields_json`、`diff_fields_json` 均 fail closed，禁止把审计血缘或异常字段静默降级为空数组。
- 通用只读 Publisher 现在严格按 FilePlan output authority 重排 artifact，并保持 target snapshot 与目标顺序一致；重复或缺失 artifact key 在发布前拒绝。
- E13-D/E/F 必须证明不新增额外 spawn、事务边界/receipt/cancel/recovery 零漂移。
- E13-D 已把 envelope exact-7 `context` 固定为 mature adapter 到旧 engine 的唯一 batch identity；caller 同时提供的 `input.batchContext` 只有逐字段一致才被接受，避免 Supervisor receipt 与实际 DB/recovery 身份分叉。
- E13-D 未修改 Pending/BizOP 的 SQL、覆盖删除顺序、金额/币种、行序、side DB、事务或默认 IPC；资金/恢复人工复核仍是 production 红线。
- E13-E 必须保留 Acquiring 三层 gate：全新 run、workerCount>1、有 dbPath，再按 30 万行与 chunk 饱和度判定；resume 永远单 worker。资源声明不得用旧 fixture 的 4 覆盖当前合法 8，也不得为 single/resume 申领不存在的 nested child。
- E13-E 的 exact-5 Protocol identity 与 exact-7 File Task owner 必须共享同一 taskRunId/taskKey/moduleId/parentRunId/operationKey；batchId/batchNumber 只来自 Main File Task，避免 chunk receipt、恢复 owner 与 Supervisor operation 分叉。
- E13-E resume 不采信 caller 的嵌套 DB/progress/output plan；当前 run 必须从 Main-owned DB source 重新准备并复核，persisted owner/output/FilePlan 任一分叉都在 worker/DB 写前拒绝，chunkSize 沿用持久 progress。
- E13-F 的顺序 schema→apply 不形成 nested child；只有 source root 等待 Main grant 时的 schema process 形成一个并发 child。Supervisor 接受 zero-child compound 是为表达真实 topology，不得被其他 adapter 用作缺省或绕过 inspector。
- E13-F prepared selector 必须先通过完整 preflight manifest/kind 证据，再解析 checkpoint/token；source authorizer 返回后必须重新检查 cancel，且只返回精确 grant allowlist，避免取消后继续授权持久 mutation或泄露 provider 附加字段。
- E13-F 对 dispatcher 显式返回的 row/failed/confirmation/success/committed count 以及 recovery/cancel 布尔证据均 fail closed；非法计数不得归零后伪装成正常 compact result。
- E13-F 手工对照重要变量清单命中 Critical `freezeWorkerBatchContext` 消费链与 Risk-sensitive Position import/checkpoint 合同；未修改 exact-seven 字段/冻结器，也未修改 Position SQL、side-DB mutation、金额币种、行序或事务。按用户要求未运行 `check-vars`/`scan:vars`，资金/恢复人工复核仍阻止 production。
- E13-F 当前只注册 dormant capability；默认 Position IPC 仍负责 FilePlan、pending、receipt 与人工确认。Runtime 尚未注入生产 route authority，不能把 capability 测试绿色解释为 production 可启用。
- `position-reconciliation:run:import-result` 虽被静态映射到 `position:import`，当前真实 handler 不经 Position import dispatcher；E13-G 必须如实重建 AST/provenance，不得用 E13-F 适配器覆盖关系伪造执行证据。
- E13-G 不能通过放宽 AST/provenance gate 或仅刷新 hash 关闭 finding；必须以真实生产入口重建 coverage。
- E13-G blindspot 已发现中间清单漏列 `pre-fund:bank-import` / `pre-fund:run`；两者必须以
  独立 legacy-only action 进入 61-pair authority，不能由 MPT/export 的绿色结果代偿，也不能写入
  仅描述 Runtime capability 的冻结 Registry。validator 只允许这两个 exact 例外，任意扩张 fail closed。
- 资金、恢复、Windows、真实样本和 production enablement 保持人工门禁。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 最终 v3.2.4 远端 ancestry/CI | RESOLVED | v3.2.5 已从最终 v3.2.4 候选建立并完成 E13-A～F 精确父链 | 不再阻塞本地 v3.2.5。 |
| 真实 action/task inventory 与 provenance 差异 | RESOLVED | E13-G 已重建 54-action/61-pair manifest、逐 pair provenance、AST/source hashes 与 mutants，current validator 29/29 | checksum 最终复验后进入 R3.2.5。 |
| Position managed route authority 与 FilePlan/pending/receipt 全链路 | BLOCK（production） | 后续 route enablement + R3.2.5 Windows/真实样本/人工复核 | 不阻止 dormant E13-F；阻止 production。 |
| Windows、真实文件、Excel/WPS、RSS、资金/恢复人工复核 | RESOLVED（本次正式技术发布）/ BLOCK（production） | `MatthewPZhong` 已确认本次资金、恢复、真实业务样本及稳定窗口人工验收；Windows 资产实机项按 Issue #220 发布后补做 | 不再阻止本次正式技术发布；继续阻止 production enablement，冻结 R3 快照不改写。 |

## E13-G Current-tree Evidence

- 初始 locked validator 已复跑为 `26/29 PASS`；3 个失败项分别是
  `canonical-action-legacy-task-binding`、`contract-authority-anchor` 与
  `validation-input-hash-coverage`，共同根因是历史 60-pair authority/provenance/report 未同步 E13-C
  已记录的当前 59-pair production binding，而非其余 26 项合同失效。
- Contract Authority transition 代码已确认：同一 v1 有意语义变化必须相对 merge-base previous 精确
  `revision +1` 且 `genesis=false`；因此 E13-G 使用 revision 2，并保持
  `approvalStatus=PENDING_HUMAN_REVIEW`、`mergeReady=false`、
  `productionEnablementAllowed=false`。
- 详细 Unknowns/决策/后续证据见 [e13-g-preflight.md](./e13-g-preflight.md) 与
  [e13-g-implementation-notes.md](./e13-g-implementation-notes.md)。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。

## 2026-09-05 正式发布传播

### Goal / Context / Constraints / Done when

- Goal：把冻结候选 `138c5b43e345ff4c19f3bcf243bcb1f119c7c105` 通过自然合并传播到 v3.2.4 最终 `main=8e6d65a007cd04681e44cad6a391d2e7a3c50249` 之上，并完成 v3.2.5 正式技术发布。
- Context：自然 `--no-ff` 合并只在三份发布文档产生冲突；代码与测试均已自动合并。冲突来自 v3.2.5 历史“技术收口、未发布”文案与 v3.2.4 最终发布事实同时修改文档顶部。
- Constraints：候选必须为第一父、v3.2.4 最终 main 必须为第二父；不 rebase/cherry-pick/force，不改变金额、币种、匹配、Workbook、事务、receipt、恢复或 production strategy；冻结 R3 evidence 不改写；本地不运行 `release-check`、`check-vars`、`scan:vars`。
- Done when：冲突按完整并集解决，发布文档和元数据测试一致；本地允许项通过；PR exact CI、review/thread、普通 merge、main exact CI、唯一 annotated tag、required-reviewer Release、四资产及最终版本链审计全部通过，且 production 保持 disabled/legacy。

### Decisions / Evidence / Unknowns

| 项目 | 分类/决定 | 证据与处理 |
| --- | --- | --- |
| 三份发布文档的事实合并 | PROBE → RESOLVED | 保留 v3.2.5 全部技术内容，采用 v3.2.4 最终 main 中的正式发布事实；v3.2.5 标题改为 2026-09-05 正式发布候选，不提前写正式发布结论。 |
| 冻结 evidence 与当前人工授权 | DECISION | R3.2.5 的 `NOT_RUN` / `PENDING_HUMAN_REVIEW` 保持历史快照；`MatthewPZhong` 的当前人工验收和发布授权单独记录，不反写 evidence，也不授权 production。 |
| 发布元数据回归 | PROBE → RESOLVED | `v3-2-5-release-metadata-closeout.test.js` 改为验证候选文案、版本不倒退、版本顺序、受保护 PR/唯一 tag/workflow 门禁及 production 关闭，避免把历史“未发布”断言当成当前合同。 |
| 自动合并代码是否出现资金语义漂移 | PROBE → RESOLVED | 手工只读对照重要变量清单并完成 blindspot/reconciliation 复核：v3.2.4 传播只补入已发布的余额来源、lifecycle evidence、task-private duplicate staging 与 MPT 边界修复；v3.2.5 候选只新增 false-gated capability/只读 export 与结果证据，不改金额、币种、匹配键、Workbook 业务语义或正式目标写入顺序。 |
| E13-G 历史 source hash 与传播后的 current tree 分离 | PROBE → RESOLVED | 官方 Node 22.18 定向集首次 `85/86 PASS`，唯一失败是历史 coverage report 的 `src/main.js` hash 与 v3.2.4 传播修复后的 current hash 不同；保持历史 JSON 不变，将该独立 gate 固定在冻结候选 `138c5b43…c105` 的临时只读 clone 中复验，随后相关测试 `10/10 PASS`。 |
| 合并后扩展改动回归 | PROBE → RESOLVED | 使用官方 Node `v22.18.0`、精确 lockfile 依赖，对当前合并结果涉及的全部 `*.test.js` 逐文件串行复验，最终 `278/278 PASS`、`0 FAIL`；覆盖 v3.2.3/v3.2.4 历史 exact evidence。首次 harness 调用仅因 zsh 未拆分换行参数而未执行测试，改用 NUL 分隔后完成有效运行，未把空跑记为 PASS。 |
| 远端 main/candidate/tag/Release/PR 漂移 | PROBE | 合并前已核对 main 和 candidate 精确 SHA，v3.2.5 tag/Release/开放 PR/远端 prep 分支均不存在；后续每个不可逆节点前再次精确核对。 |
| 低影响格式选择 | ASSUME | 沿用 v3.2.3/v3.2.4 正式发布候选结构与措辞，保持三份发布文档同步。 |

### 手工 check-vars（只读）

- Critical `freezeWorkerBatchContext`：Acquiring/Position adapter 只消费 Main-owned exact-7，并逐字段绑定 exact-5 共有 owner；缺失或分叉均在 dispatcher/DB 写前 fail closed，未修改冻结器或字段集合。
- Critical `unmatchedRows`：只新增 Acquiring adapter compact result 校验，强制 `matchedRows + unmatchedRows = totalBillRows` 且 `mismatchRows <= matchedRows`；未触及现有资金匹配或导出行选择。
- Important-skeleton `parentRunId`：继续来自 batch/operation authority，不猜测、不改写；taskRunId/taskKey/moduleId/parentRunId/operationKey 的共有身份由 adapter 拒绝分叉。
- Important-skeleton `normalizeBu`：复用既有 `String(v).trim().toLowerCase()` 仅作 BU 相等性比较，原始字面值、账户资金 key 与持久字段不改写。
- Risk-sensitive Position store/checkpoint：只读 export 使用固定侧库普通文件、`DatabaseSync(..., { readOnly: true })`、`PRAGMA query_only=ON` 与 checkpoint freshness；不运行 migration。普通 run 仅在文件发布成功后补记 `exported_at`，失败显式 warning，不撤销或伪造文件结果。
- Runtime-state/Minor：未发现改变用户会话默认路由或展示语义的命中。54 项 production strategy 均 `enabled=false`、`effectiveMode=legacy`、`effectiveWorkerCount=0`；Main 入口先查 `isProductionEnabled(action)`，false 时继续原 legacy Main 路径。

### ⚠️ 关联功能 review（PR body）

- Acquiring：复核 exact-5/7 owner、resume 持久 owner/output intent、D31 topology 以及 `matched + unmatched = total` 行数守恒。
- BizOP：复核 BU 仅 trim/lower 比较、side/main source locator 与 dataset-head freshness；不改原始 BU 或账户 key。
- Position：复核只读侧库/checkpoint、source file identity、schema→apply 安全点与发布后 `exported_at` 告警边界。
- 通用 File Task/Publisher：复核 task-private staging、FilePlan 顺序、artifact hash/size、三次 freshness、单次 Publisher 与 terminal receipt ACK。
- Production：复核所有 action 仍 false/legacy/0，外部 feature flag 无法绕过 policy disabled。

### Blindspot / Reconciliation 结论

- 来源 authority 覆盖 main/side DB locator、普通文件 identity、模板 hash、run/dataset revision 与 exact File Task owner；确认后任一漂移均 fail closed。
- 输出只写 task-private staging，技术/业务回读通过后才按 FilePlan 单次发布；部分 unit、artifact tamper、Publisher/cleanup/metadata 失败均不会伪装完整成功。
- 行数证据分别覆盖 Acquiring matched/unmatched 守恒、Position rowCount、PreFund 分渠道计数、VCC total/exportable/missing 守恒；零行/缺失来源按各原合同显式处理。
- 本次传播没有改变金额正负、币种归一、资金匹配主键、SQL 业务筛选、Workbook 列/排序或账务持久化；未发现新增资损红线。人工验收仅解除本次技术发布门禁，不解除 production enablement。
