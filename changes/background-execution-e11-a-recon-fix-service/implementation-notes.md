# E11-A ReconFix Service Implementation Notes

## Baseline

- Goal/spec: `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/{spec,techdoc}.md` 的 E11-A。
- Initial plan: `changes/background-execution-e11-a-recon-fix-service/preflight.md`。
- Done when: production-false 真实 Service capability 覆盖 import/standard/BOC，只读 golden 与 state invalidation/close/crash/resource probes 通过，live 保持 legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| E11-A 不依赖 E11-P0，继续实施 | 冻结 PR 顺序把 E11-A 放在 E11-P0 前；Platform Contract 的 JPM BLOCK 明确不阻止只读 action；standard/BOC 当前不调用 ADM mutation | 等 E11-P0 后再建 Service；在本 PR 预埋 JPM DTO/schema | 本 PR 不含任何 JPM reader/no-op/receipt/inspector 行为 |
| 复用 Main-only ServiceHost/ResourceGovernor | 平台已实现 BaseLease、PersistentReservation replacement、generation、busy、close/crash release | 模块自建 Worker owner/Governor；在 Main 新建大 state | Service 只新增业务 Worker/state，Main 仍只有平台小型 lifecycle state |
| BOC Worker 按路径只读主库 | BOC linked rows 可能超过协议上限；`DatabaseSync(...,{readOnly:true})` 能强制只读 | Main 读取整表并通过 postMessage；复制 BOC 表到另一个 DTO/spool | Worker 内形成 linked evidence 与计算输入；command 保持有界 |
| 所有 state 变更走 persistent-state-replace | Platform Contract 要求候选在 grant→adopted→adopt-ack 后才能公布 revision | 先换 state 再补 reservation；仅 import reservation、run 原地改 | admission/reject 时旧 state 保持；revision 只在 ack 后公开 |
| 大分配前用 canonical `phase-extension` 做两段式准入 | Ultra review 的真实 5k/10k probe 证明旧实现会在 `XLSX.readFile`/BOC `.all()` 后才知道 footprint，且 benchmark 不会失败 | Worker 直接调用 Governor；新增资源 authority；事后扩大报告 envelope；每个 phase 发多份 request 绕过 policy 单请求上限 | Service 先 `prepare` 有界证据，Worker 经现有 request→grant→adopt-ack 后才 `begin`；一个 job 只持有一份 extension，完成/取消/错误均 release→release-ack |
| XLSX 准入基于 ZIP 中央目录而非 fixture 行数 | 物理文件大小不能覆盖压缩展开；yauzl lazy central-directory 枚举不 inflate 工作表 | 按 5k/10k 写死阈值；先读整文件 Buffer；catch/fallback 绕过准入 | 估算为固定 parser overhead + 物理 bytes×2 + 解压总 bytes×8（gateway 第二次 read 再加×4），按 16 MiB 向上取整；超过 192 MiB policy 上限在 `XLSX.readFile` 前 fail closed，并在 grant 后复核 file identity |
| BOC evidence 与 size probe 共用同一只读 SQLite snapshot | aggregate 后 DB 若变化，独立 `.all()` 可能超出已准入字节或 hash 另一个快照 | 只看 DB 文件大小（会漏 WAL/混入无关表）；Main 读取整表传 DTO | Worker `readOnly + query_only + BEGIN DEFERRED`，先 `COUNT/SUM(LENGTH(raw_json AS BLOB))`，grant 后在同一 snapshot `.all()`；取消/拒绝/错误 close/rollback |
| run 临时上界显式覆盖 state clone/result/BOC rows | standard/BOC 会同时保留旧 state、engine clone 和新候选；final PersistentReservation 不能单独证明 phase RSS | 只按最终 compact state；修改 C4/BOC 算法为流式 | extension 使用当前已准入 state footprint×4，加固定 overhead；BOC 再加 raw JSON bytes×8 + 256B/row；old/current 与 tentative candidate 仍由现有 persistent replacement accounting 覆盖 |
| 两个 action 共用 canonical static service binding | 冻结 fixture 的 `service.serviceKey` 均为 `service.recon-fix`；既有 Registry 以 `staticKeys.serviceKeys` 和共享 executable 判定 capability 一致性 | 新增 service descriptor/registry 方言 | runtime 只注册 `serviceKeys: ['service.recon-fix']`，两个 entryKey 绑定同一 frozen worker entry |
| 引擎返回值在进入 Service 状态前结构化克隆 | C4/BOC 旧引擎的部分行为 null-prototype，canonical JSON 按平台合同必须是 plain JSON | 改动旧引擎的对象构造；放宽 canonical JSON | Service 拥有独立 plain JSON；golden digest 证明字段/金额/币种/行数未变 |
| 仅对有界 DTO 的五个 SHA-256 字段放行 finance-safe value | 通用隐私规则会把偶然含 12 位数字的随机摘要误判为完整账号；既有 validator binding 支持精确 delegate | 整体关闭 `finance-safe-v1`；允许任意字符串 | 只有值匹配 64 位小写 hex 且 key 在白名单时放行 |
| public import summary 对账号型文件名脱敏 | 账单文件名可能本身是完整账号，不得因 Main 已知路径就绕过 `finance-safe-v1` | 为任意 fileName 添加 privacy delegate；删除 Worker 私有原名 | 仅 bounded DTO 返回 `[redacted by finance-safe-v1]`；Service 私有 session 仍保留原名供后续 E11-C |
| shutdown 取消复用现有 `job:cancel`/`cancel:ack` 与 terminal 私有因果桥 | ReconFix 是 `shutdown-only`；同步 legacy parse/engine 需在真实 event-loop 让出后观测 cancel；首轮实测发现 ServiceHost 未转交 adapter 已有 cancellation terminal 回调 | 用 terminate 冒充 cooperative outcome；新增 resource-cancel 协议；只凭 ACK 判 cancelled | runtime 白名单注册 `RECON_FIX_CANCELLED`；ServiceHost 仅将现有私有回调转交当前唯一 job；Worker 仅发一次 `cancel:ack` + `job:error` |
| pending adoption 不伪造撤销，等现有 resource exchange 收口后再取消 | Platform Protocol 没有 Worker→Main resource request cancel verb；中途终结会留下 grant/adopt-ack 晚到与 reservation 泄漏 | 扩大协议；在 pending request 存在时直接 terminal | parse 后/adoption 前、adoption 收口后、invalidation/result 之间是真实 safepoint；shutdown report 无 lease/dependency 泄漏 |
| terminal-in-flight 只用同 generation 单槽 `lastTerminalJobId` tombstone 收口 | Worker 已投递 `job:done`、Supervisor 尚未 settle 时，shutdown 仍可合法发 `job:cancel`；二审复现 100 次命中 2 次 | 记录无界 terminal 历史；忽略任意未知 cancel；发第二个 ACK/terminal | 仅 `activeJob=null` 且 exact same jobId 的晚到 cancel 幂等忽略；下一 terminal 替换单槽，Worker generation 结束即消失；错 generation/未知 job 仍 fail closed |
| 最终 v3.2.3 shutdown 组合下允许 terminal 先于 Supervisor cancel 胜出 | 最终 runtime 会先等待 external-parser `workersTerminal`，再进入 Supervisor shutdown；若 Service 的 `job:done` 已到 adapter，Supervisor 开始时该 job 已 terminal，依法不再发送多余 `job:cancel` | 为满足旧测试强制向已 terminal job 补发 cancel；删除 terminal-in-flight race 覆盖 | completed 分支接受 `job:start` 后零或一次 race cancel；cancelled 分支仍强制 exact `job:start → job:cancel`，terminal、资源回收与无泄漏断言不放宽；生产代码零变化 |
| unsafe integer 仅进入类型化 evidence 投影 | legacy ReconFix 接受超过 `MAX_SAFE_INTEGER` 的有限 JS number，平台 strict canonical JSON 会拒绝；直接转 string 会改业务值并与原字符串混淆 | 改 Worker 私有 row；放宽全平台 canonicalizer | input、BOC evidence、result digest 统一用有上限的 tagged projection；number/string hash 可区分，业务 row 仍是 number |
| evidence projection 改为 byte-identical 增量 hash | 10k max phase probe 首次真实 gate 仍超 envelope 5,390,336B；旧实现同时保留 projected tree + 完整 canonical string，属于重复临时大 state | 扩大 policy/第二份 phase；改变 digest；把业务 number 转 string | 按 canonical key sort/unsafe-number tag 逐 token 更新 SHA-256 与 byte cap；golden 对比旧 `canonicalSha256(reconFixEvidenceProjection(...))` 完全一致，rows/金额/币种零改动 |
| benchmark 以实际 lease snapshot 成为失败门禁 | 旧脚本把 Base+static Phase+old/new state 事后相加，只报告 RSS，5k/10k 超 envelope 仍 exit 0 | 仅调大“declared”数字；用 final 15/30MB reservation 代替总量 | 每个 case 新 Node 进程，2ms 同采 RSS 与 Governor leases；只在 dynamic extension live 的 allocation phase 取 peak，并断言 delta≤当时所有 active lease envelope；另报整个观察窗 high-water、shutdown lease/dependency=0 |
| ordinary gateway C4 仅补 parity golden | Ultra review P3 独立 probe 正确，但原 tests 只覆盖 standard/BOC | 修改 C4 engine 或配置 schema；把 P3 扩成业务重构 | legacy/private candidate/managed summary 三层锁 digest、Amount=999、Currency=USD、fixed/unmatched count、`linkedEvidenceHash=null`、generation/revision 与 phase 回收 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| export/resultHandle 的公共消费延后 E11-C | 本 PR scope 明确禁止 export；E11-A 验收只含只读 golden/state invalidation | 不能从 Main 导出 managed result（符合 production false/live legacy） | 不添加临时大 DTO；E11-C 复用 Worker 私有 result |
| BOC 坏 JSON 继续 legacy skip 语义 | 本 PR禁止改变 ReconFix 算法/业务语义；E11-P0 的 hard-fail 只针对 JPM ADM | 只读 BOC evidence 不会新增拒绝 | golden 锁定；如后续业务决定改变，独立 PR |

## Deviations

| 发现 | 决策与纠偏 | 合同影响 |
| --- | --- | --- |
| Ultra review P2：合法 5k×2/10k×2 的旧 benchmark peak RSS 分别超过旧脚本声明 envelope 约 6.86%/31.82%，脚本仍 exit 0 | 接受为 E11-A local-ready blocker；新增 pre-allocation phase admission、去除重复 evidence 大分配并把 benchmark 变成真实 gate | 不改 canonical policy/resource authority；production 仍 false |
| Ultra review P3：ordinary gateway C4 是可达 legacy 分支但缺 focused managed parity | 接受为测试充分性缺口；只补 golden | 不改 engine/金额/币种/1:1 |
| Reviewer 提议关注 generation-wide tombstone 增长 | 项目负责人复核为既有平台 anti-replay lifecycle，无 E11-A 失控证据；拒绝额外防御 | 单槽 `lastTerminalJobId` 保持不变 |
| 重放到最终 v3.2.3 后，旧 terminal-in-flight 测试固定要求每轮都发送 `job:cancel` | 复现 5/5 均为 `job:done` 在 parser-first shutdown 等待期完成，因此 Supervisor 正确跳过已 terminal job；按最终 runtime 合同收紧为 outcome-aware 断言 | 不改 E11-A Worker/ServiceHost/Supervisor；不把合法 completed 结果伪装 cancelled |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 仓库与合同检查 | E11-A 无 E11-P0 硬依赖；无 BLOCK | 冻结顺序、范围防越界 |
| Node read-only SQLite probe | SELECT 成功；INSERT 以 `ERR_SQLITE_ERROR` 拒绝 | BOC Worker 不可写主库 |
| 首轮 active shutdown probe | Worker 已返回 `RECON_FIX_CANCELLED`/`stage=cancel`，但 Supervisor outcome 仍为 `failed` | 定位 ServiceHost 未将 WorkerThreadAdapter 已有 cancellation-terminal 私有回调转交 job；不能只注册 error code |
| `RECON_FIX_TERMINAL_RACE_ITERATIONS=100 ... --test-name-pattern='terminal-in-flight'` | 100/100 迭代 PASS（13.70s） | 每轮在 adopt-ack 后、Worker `job:done` 已到 adapter 但尚未交 Supervisor 时启动 shutdown；确认 `job:start`/`job:cancel` 都发出，completed/cancelled 任一合法胜者均只有一 terminal，无 fatal/shutdown error/lease/dependency leak |
| 最终 v3.2.3 基线上的 terminal-in-flight 重放 | 旧断言稳定复现 `5/5 FAIL`，均为合法 completed 且命令只有 `job:start`；按 outcome-aware 合同调整后 `100/100 PASS`（13.54s），E11-A + toolbox 联合 `24/24 PASS` | 证明差异来自 parser-first shutdown 令 terminal 在 Supervisor cancel 前胜出，而非 lease、terminal 或 recovery 漏洞；cancelled 分支仍要求精确 cancel 命令和 cancellation terminal |
| 最终 v3.2.3 + E11-A 平台联合定向回归 | 排除仅供父测试启动的 `fixtures/` Worker 后 `534/534 PASS` | Action/Policy registry、adapter、protocol、Governor、ServiceHost、Supervisor、recovery、ReconFix engine/IO/C4/BOC 与 toolbox runtime 的组合回归；首次误将 fixture 当独立测试执行的命令选择错误未计为产品失败 |
| `node --test tests/unit/main-process/recon-id-fix-service.test.js` | 14/14 PASS | canonical policy、pre-`XLSX.readFile` phase gate、standard/ordinary gateway C4/BOC golden、unsafe numeric 长单号/大金额不改型且增量 hash 与旧 projection byte-identical、busy/stale/revision、scenario/BOC evidence 失效、JPM 阻断、有界 DTO、真实 Worker close/crash/generation/lease 回收、success/error/cancel phase release、phase adoption-in-flight shutdown、terminal-in-flight 幂等收口、无 late message/leak |
| Platform/ReconFix 联合定向单测（adapter、protocol、Governor、ServiceHost、Supervisor、engine/IO、C4/BOC、toolbox runtime） | 383/383 PASS | cancellation terminal 私有桥接、Service resource lifecycle、ReconFix engine/IO、C4/BOC 1:1 和金额语义、既有 toolbox background generation 均无回归 |
| BOC important-variable 定向单测（builder、linked-table、rematch、scenario seed） | 74/74 PASS | 隐藏表只读顺序、raw JSON 还原、派生/重匹配/seed 契约无回归 |
| `v3.0.4-boc-dispatch-order-fix.js` | 31/31 PASS | BOC 整组失败、Reference/Amount/Type、行数与输出契约 |
| `npm run smoke` | PASS（其中 `recon-id-fix-end-to-end` 6/6） | 完整 smoke 回归通过；standard import/run/output 旧链路 golden，live 仍走 legacy |
| `toolbox-background-generation.test.js` | 10/10 PASS | runtime 新增两个 production-false policy 后既有 one-shot action 与 shutdown 不回归 |
| 旧 `benchmark-recon-fix-service.js` finding reproduction | 5k：peak delta 329,252,864B vs 298,680,320B；10k：452,182,016B vs 328,960,352B；脚本均 exit 0；新 gate 首次 10k 又真实捕获 475,152,384B > max held 469,762,048B | 证明不能拿 15/30MB PersistentReservation 或事后静态 envelope 单独宣称 RSS 充分；促成 pre-allocation extension + evidence projection 去重，不扩大冻结 policy |
| `NODE_PATH=... node scripts/benchmark-recon-fix-service.js` fresh-process matrix | PASS。5k：10,000 rows，phase import/run=117,440,512/100,663,296B，active-phase peak delta=200,605,696B ≤ held 399,343,616B；10k：20,000 rows，201,326,592/167,772,160B，353,812,480B ≤500,022,640B；近边界 9,750×2：184,549,376/167,772,160B（91.67% policy），345,423,872B ≤482,488,408B；三例 DTO=512B、shutdown lease/dependency/leak=0 | peak 是 phase + XLSX/engine + state replacement 的整进程 delta，不是仅 persistent footprint；同时报告整个观察窗 high-water。该矩阵是本机 production-false gate，仍不替代 Windows/真实资金/production enable 证据 |
| `node --check` 全部新增/修改 JS | PASS | 静态语法检查 |
| ESLint 全部 changed JS + `git diff --check` | PASS | `no-undef` 与补丁空白静态检查 |
| 手工 important-variable 对照 | 命中 BOC 调拨订单修复链（Risk-sensitive 资金红线）与 ReconFix `unmatchedRows` 同名隔离项；未修改 live `reconIdFixSession/reconIdFixResult` | 需在合并/发布前由资金负责人做真实样本人工复核；本 PR production false |

## Blindspot Pass

- 入口/旁路：只有 non-production runtime 可执行新 capability；live IPC/Main globals 零改动，继续 legacy。
- 边界/失败：exact-key command、absolute path、subMode/category、stale revision、busy、JPM 均 fail closed；resource reject 不公布候选状态。
- 资源/时序：XLSX 先验只枚举 central directory；BOC aggregate 与 `.all()` 锁在同一只读事务快照；任何 estimate/policy/Governor 失败都在大分配前终止。每个 job 只申请一份 bounded phase extension，不绕过 192 MiB action 上限。
- 取消/竞态：active import/run 均通过 Worker 安全点 cooperative terminal；已发出的 resource exchange 先等 grant/reject/adopt-ack 收口，再发唯一 cancellation terminal，不生成协议外撤销。Worker 已发 terminal 但 Main 尚未 settle 的跨线程窗口仅用单槽 exact-job tombstone 幂等收口，不放宽未知 job/generation。
- 状态生命周期：import 清 result；scenario/BOC hash 变化先 adopt invalidation 再计算；close/crash 清空 Worker 私有 state 并使 generation 前进。
- 兼容/可观测：policy 与 canonical fixture 逐字段一致；Main 只见 generation/revision/digest/count/handle，不见 rows。
- 大数兼容：不改 legacy 可接受的 unsafe integer 业务值；仅 hash projection tagged，且继续受 canonical byte limit 约束。
- 内存去重：增量 evidence hash 不保留第二份 projected rows/JCS 大字符串，digest 与旧投影逐字节等价；Main 仍无第二份 ReconFix 大 state。
- 隐私：SHA-256 仅在精确 key/format 下放行；完整账号型 fileName 在 public DTO 脱敏，原名不离开 Worker 私有 state。
- 测试缺口：Windows packaged Worker + SQLite WAL/read-only 尚未在本机验证，保持 production false 并列为 enable gate。

## Reconciliation Blindspot Pass

- 主键血缘：standard 仍用 legacy sheet 行；BOC 仍依 `ORDER BY id ASC` 的 raw JSON 原序，未新增或重解释业务键。
- 金额/币种/1:1：不改 C4/BOC engine；standard/BOC digest golden 和 BOC 31 断言通过。
- ordinary gateway：新增真实 C4 1:1 golden 锁定 Amount=999、Currency=USD、fixed=1/unmatched=0；managed digest 等于 legacy，`linkedEvidenceHash=null`。
- 数值语义：数值型长单号与大金额在 input/private result/BOC `Amount` 全程仍为 number；字符串同文本的 evidence hash 不同。
- 本轮 tombstone 仅记录平台 jobId，不读写 ReconFix 行、金额、币种、匹配键或 result state，资金语义零变化。
- 幂等/重复：E11-A 纯读，不产生 DB mutation/receipt；相同 evidence 可重算，但每次采用都需新 PersistentReservation/revision。
- 部分失败：BOC 整组失败规则不变；新状态未准入则旧状态保持，evidence 已变更时先锁定清除旧 result。
- 行数守恒/资损可观测：DTO summary 只输出 fixed/warning/unmatched count 与 canonical digest；完整行仍仅在 Worker 私有 state。BOC 为 Risk-sensitive 资金红线，仍需资金负责人人工真实样本复核。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged 下 Worker read-only DB/WAL 行为 | PROBE | 本 PR 只能做当前平台 probe；production enable 前补 Windows gate | 不阻止 production-false 合并，阻止 production enable |
| 真实资金样本的 BOC 行级人工复核 | 人工门禁 | 资金负责人在合并/发布前核对 Reference/Amount/Type/整组失败 | 未复核不得 production enable |
| 不同 Node/Electron/V8 allocator 与真实最大文件的 RSS 余量 | PROBE | 当前 fresh-process 5k/10k/91.67% 边界矩阵通过；production enable 前在目标 Electron/Windows 与脱敏最大样本重跑同一 actual-lease gate | 不阻止 production-false 合并，阻止 production enable；不得只看 PersistentReservation |
