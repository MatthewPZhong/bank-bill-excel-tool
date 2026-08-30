# v3.2.5 Implementation Notes

## Baseline

- Goal：完成 v3.2.5 E13-A～G、R3.2.5、版本元数据/发布文档与最终审计收口。
- Exact local parent：v3.2.4 最终本地候选 `dd412ea8141e0786132b31868a3006adde62f9d4`。
- Authority：[spec.md](./spec.md)、[techdoc.md](./techdoc.md)、[implementation-sequence.md](./implementation-sequence.md)。
- Preflight：[preflight.md](./preflight.md)、[preflight-baseline-validation.json](./preflight-baseline-validation.json)。
- Done when：8 PR 严格顺序实施/传播/合并到 v3.2.5；当前树 validation/checksum、版本/三份发布文档、适当完整测试与人工状态均可审计；main/tag/production 不修改。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 顶层 Spec/TechDoc bootstrap 逐字节同步冻结来源；实施期只接受精确记录且受测试约束的合同修订 | 防止按老 changes 副本或编号猜范围，同时不能让已证伪的 Position export 拓扑、泛化的 import 禁令或只冻结路径的来源证据继续充当 current authority | 任意润色顶层副本、静默修改冻结基线、维持已证伪的 `existing-dispatch` | 冻结来源保持原 hash；E13-B 仅允许 Position export policy、两处 import-scope 禁令澄清、TechDoc executor 说明和模板/归档 hash authority 五处精确 delta，其他漂移一律失败；E13-G 以 current authority 重建最终证据。 |
| 旧 `29/29` 与 `69/69` 只作历史证据 | 当前独立复验为 checksum `61/69`、validation `28/29` | 重算 checksum 伪造一致 | E13-G 必须修真实 binding/AST authority 后再生成最终证据。 |
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

## Evidence / Deviations

| 项目 | 当前结果 | 影响/后续 |
| --- | --- | --- |
| Frozen/current document hashes | 冻结 Spec `13410e4e…98f2`、TechDoc `3fb18459…e64f`、split plan `27bbdde9…174a`；当前 Spec `5ff09026…0180`、TechDoc `794190d2…1ea7` | 冻结来源未修改；顶层仅含已记录且受测试约束的 E13-B/E13-C/E13-D/E13-E 证据型修订，不能宣称仍逐字节一致。 |
| Package checksum | `61/69`，8 项漂移均有提交来源 | E13-G 前不得宣称 package integrity PASS。 |
| Published/current validation | published historical `29/29`（68 inputs）；current tree `28/29`（73 inputs，binding/AST authority 一项失败） | 旧 report 不代偿当前树；E13-G 负责真实修复。 |
| Production/human gate | production=false；资金/恢复 `PENDING_HUMAN_REVIEW` | 本 bootstrap 不改变。 |
| E13-A unknowns-first | summary=aggregate；Pending errors 需 managed source；Pending/BizOP stable gate 必须在 Worker read snapshot 内复核 | 进入模块专用 worker 实施；不改 legacy effective strategy。 |
| E13-A capability validation | 定向 `18/18 PASS`；重点既有回归 `181/181 PASS`；完整单测 `6784/6787 PASS`（`0 FAIL`、`3 SKIP`）；相关集成 `179/179 PASS`；smoke PASS；Main freeze 为紧凑 run/dataset/revision 证据，Pending 大错误源采用版本 authority + 异步流式 staging | 本地 capability 已收口；production 仍为 false，Windows/真实样本/资金恢复人工门禁留到 R3.2.5。 |
| E13-B unknowns-first | PreFund=N 个单 artifact unit + 单批发布；Position 冻结 adapterKind 与真实代码冲突；VCC 现有 dataset worker 会可写开库/迁移，audit 仍 direct | 先修顶层合同和稳定来源计划，再写模块专用只读 worker；不复用错误拓扑。 |
| E13-B PreFund capability validation | 定向 `6/6 PASS`；普通/审计 workbook 与 legacy 语义 golden 等价；未 ACK、mirror/side/模板漂移、缺失 unit、后序 unit 失败与预启动取消均 fail closed；真实 Runtime 在线程 Worker 完成 | production 仍为 false；模板 SHA-256/byteSize 已绑定 stable evidence；Windows、真实资金样本与人工复核留到 R3.2.5。 |
| E13-B Position capability validation | 定向 `5/5 PASS`；run/filtered workbook 与 legacy 语义 golden 等价；真实 Runtime 完成；stale checkpoint 与空差异不产 artifact；源文件采用 `lstat → open → fstat` 的 ordinary-file identity/size/mtime guard 并对已打开字节计算 SHA-256；单次 Publisher 后元数据补写失败只告警；终态严格先收口 pending、再 ACK managed Publisher receipt | production 仍为 false；Position import utility adapter 属 E13-F，本切片未改变 import dispatcher、匹配算法、金额/币种/排序或确认事务。 |
| E13-B VCCFin capability validation | 定向 `13/13 PASS`；import audit 与 dataset workbook 均和 legacy 语义 golden 等价；真实 Runtime 完成；active/unfinished/empty audit、record/anomaly/lineage/异常字段 JSON 漂移或损坏、同数量 dataset revision 漂移、预启动取消与 artifact 篡改均 fail closed；dataset source freshness 在 legacy writer 自身的只读事务内、查询和写 workbook 前复核；Publisher 失败不产正式目标；managed export 复用模块全局串行租约；Main 三次 freshness + artifact 回读后才单次 Publisher | production 仍为 false；既有 dataset incomplete 说明、bound archive integrity failure、SQL/排序、金额币种、六列 audit 与 VCC 专用 durable receipt 均未改变。 |
| E13-B capability/full regression | E13-B 三模块定向集 `24/24 PASS`；五文件重点合同集 `37/37 PASS`；完整单测 `6808/6811 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260830-215741.log`；53 个 integration 脚本 `2488/2488 PASS`；smoke PASS；全部改动 JS 通过 `node --check`，`git diff --check` PASS | 一次全量并发运行曾令既有 MPT transport 用例出现 `1 FAIL`，该精确文件连续两次 `39/39 PASS`，随后全量复跑 `0 FAIL`；未以失败快照作为绿灯。blindspot/reconciliation 已关闭模板 authority、Position 源文件 identity、Position pending/receipt 终态组合、VCC 审计 JSON、dataset 同事务 freshness、manifest 关系与 FilePlan 顺序缺口；尚需最终 diff review/候选提交。Windows、真实资金样本及资金/恢复人工复核留到 R3.2.5，production 仍为 false。 |
| E13-C current-tree classification | 当前唯一 `acquiringBillCurrency:export` 只绑定 copy；regenerate 无 legacy TaskPolicy binding；binding pair 从 60 收紧为 59，顶层 Spec/TechDoc 已 reverse-sync，冻结基线未改 | E13-G 必须重建 current manifest/provenance/checksum，不能用旧 fixture 代偿。 |
| E13-C capability validation | 定向 `10/10 PASS`；E13-A/B/C 扩大回归 `115/115 PASS`；Acquiring/Registry 重点回归 `60/60 PASS`；完整单测 `6819/6822 PASS`（`0 FAIL`、`3 SKIP`，日志 `unit-20260830-232228.log`）；Acquiring 集成 `252/252 PASS`；smoke、ESLint 与语法 PASS；copy 的普通文件/hash/staging/Publisher 和 main/side regenerate 的 complete-only/read-only DB/original writer/Workbook 回读均已验证；交叉输入与 Publisher failure 均 fail closed | production 仍为 false；Windows、真实大 run/RSS 与资金恢复人工门禁留到 R3.2.5。 |
| E13-D capability/full regression | E13-D+mature adapter `16/16 PASS`；完整单测 `6824/6827 PASS`（`0 FAIL`、`3 SKIP`，日志 `unit-20260830-235725.log`）；53 个 integration 脚本 `2488/2488 PASS`（`361809 ms`）；smoke、ESLint、语法与 diff PASS；真实 Runtime/engine、CompoundLease、无 wrapper Worker、真实取消回滚、精确 result 与 exact-7 身份分叉反例均通过 | production 与默认 IPC 均未启用；Windows、真实大文件/RSS、资金/恢复人工复核留到 R3.2.5。 |
| E13-E capability/full regression | E13-E 定向 `12/12 PASS`；mature/Acquiring/Registry/Resource/Supervisor 扩大回归 `227/227 PASS`；完整单测 `6836/6839 PASS`（`0 FAIL`、`3 SKIP`，日志 `logs/unit-tests/unit-20260831-005448.log`）；53 个 integration 脚本 `2488/2488 PASS`（`282902 ms`）；smoke、ESLint、语法与 diff PASS；真实 Parser/side DB、D31、single/resume、mirror、取消、exact-5/7 owner 与 Main-owned resume authority 均通过 | production 与默认 IPC 均未启用；Windows、30 万+真实 run/RSS、资金/恢复人工复核留到 R3.2.5。首次隔离全量运行的依赖树不符合 lockfile，改用精确 `app-builder-lib 26.15.7` 后完整复验，未把环境失败记作代码 PASS。 |

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
- E13-G 不能通过放宽 AST/provenance gate 或仅刷新 hash 关闭 finding；必须以真实生产入口重建 coverage。
- 资金、恢复、Windows、真实样本和 production enablement 保持人工门禁。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 最终 v3.2.4 远端 ancestry/CI | PROBE | 完成 #199～#207 与 #194～#204 顺序合并后建立 v3.2.5 | 未完成前不推 v3.2.5。 |
| 真实 action/task inventory 与 provenance 差异 | PROBE | E13-G 重建 manifest/AST snapshot 和 mutants | 未 29/29、69/69 前不进 R3.2.5。 |
| Windows、真实文件、Excel/WPS、RSS、资金/恢复人工复核 | BLOCK（production） | release owner / Windows / 资金负责人 | 阻止 production/正式发布声明，不阻止 dormant implementation。 |

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
