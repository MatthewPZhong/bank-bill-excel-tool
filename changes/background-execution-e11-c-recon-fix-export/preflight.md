# E11-C ReconFix Export Preflight

## Task Brief

- Goal：在不接 live IPC/Renderer/Preload 的前提下，为 ReconFix Service 增加 `production.enabled=false` 的 managed export capability；Worker 只从 Service 私有 exact result 生成 task-private main/unmatched staging artifacts，Main 深度复验后只调用一次既有 durable journal Publisher，实现多 artifact 全有或全无。
- Context：exact base `225ab05f77cd74d25b9aae05dda1ab490104d5c6`；E11-A 已交付 standard/BOC Service，E11-P0/B 已交付 JPM ID-aware durable mutation、receipt-first Inspector、Recovery Hold 与 candidate adoption。冻结 v3.2.4 Spec/TechDoc 把 E11-C 限定为 ReconFix export，不包含 E12。
- Constraints：Worker 只使用 Service 返回的 exact `serviceGeneration + revision + resultHandle` 与 task-private staging；复用 legacy 命名、sheet、列、样式、watermark、row lineage；Main DTO 不携带 raw row/JPM candidate/大对象；Main Join 必须重验 generation/result/revision、scenario/linked evidence、FilePlan set/order、path containment/alias/symlink、size/hash 与业务 workbook；全部通过后单次调用既有 Publisher；任一失败 Publisher=0；Publisher uncertain/crash 只沿用现有 journal recovery；不改 E11-P0/B mutation/receipt/Inspector，不启用 managed production，不接 live IPC，不改依赖，不实现 E12。
- Done when：standard/BOC/JPM 的 main-only、unmatched-only、main+unmatched 都生成与 legacy 等价的有序 manifest；tamper/stale/collision/alias/symlink/set/order/rowCount/业务回读失败均在 Publisher 前 fail closed；Publisher failure/uncertain/kill/restart 走既有 journal all-or-none recovery；E11-P0/A/B、legacy 与 production-false 回归通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| Canonical export policy 已冻结为 `thread-single/service/native/main-settlement/all-or-none`，最大 64 artifacts，production false | v3.2.4 Spec §3；canonical `policy-registry.v3.2.x.json` 的 `recon-fix:export` | 生产 policy 必须逐字段服从 fixture；不得另造 mode/Publisher/恢复方言 |
| Full result 已由 ReconFix Service 私有持有，Main 只见 handle/summary | `recon-id-fix-service/service.js`；E11-A/B notes | export command 只能用 exact result identity 请求，不能把 rows 从 Main 传回 Worker |
| Legacy export 只有三种 artifact 集合：main-only、unmatched-only、main 后跟 unmatched | `src/main.js` `recon-id-fix:export`；`recon-id-fix-io.js` | manifest 顺序与命名、sheet、列、10pt 表头、watermark 必须保持 |
| 现有 FilePlan 已提供 artifactKey、target snapshot、alias/symlink 与 freshness 边界 | `archive-center/file-plan.js` | Main Join 必须消费 normalized eager FilePlan，不能信 caller/Worker 自造路径身份 |
| 现有 durable Publisher 已提供批量 journal、target snapshot、size/hash、rollback 与 worker-exit recovery | `toolbox-output-publication*.js`；VCC wrapper | E11-C 只增加业务前置 Join 与薄适配，Publisher 实现不复制、不修改 |
| JPM committed/noop result adoption 后与 standard/BOC 一样进入 Service current result；crash 后 result 丢失 | E11-B Service/Worker 与 notes | export 不重建 JPM candidate，不读取 receipt 猜 result；无 current exact result 即拒绝 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| export command 的最小 exact identity 与 public terminal manifest shape | 公共合同未知 | 高 | 一般 | Frozen TechDoc 只列 Join 字段，现有 Service status 有 generation/revision/handle | PROBE | 对照 Protocol validator、canonical policy result limit 与现有 artifact validators | 使用有界 exact DTO；拒绝额外键和 raw rows |
| task-private staging root 与 FilePlan target 如何绑定且防 alias/symlink | 文件安全盲区 | 高 | 一般 | FilePlan 保护 target，Publisher保护 generation/target；Service Worker 需要独立 staging ownership | PROBE | 临时目录真实 lstat/realpath、collision/alias/symlink 测试 | Main 分配并验证 task-private root，Worker只能在该 root 的固定 generation paths 写 |
| legacy workbook 的“真实业务回读”应验证哪些结构 | 审计契约未知 | 高 | 容易 | IO 固定单 sheet、headers、rowCount、10pt header 与 watermark | PROBE | 生成 business/gateway/unmatched golden 后用 XLSX/XLSXStyle 回读；与 legacy writer 对照 | 至少锁定 sheet exact、headers/columns/order、records digest、rowCounts、header style、watermark/lineage evidence |
| linked evidence 如何在 export prepare 与 Main Join 重读 | 状态生命周期盲区 | 高 | 一般 | standard=null；BOC hash 来自 read-only DB rows；JPM hash 来自 strict ADM image | PROBE | 在 generation 前后篡改 scenario/BOC/ADM，断言 Publisher=0 | Service prepare 返回 result 内 exact evidence；Main 通过注入的 authoritative reader 二次读取并 exact 比较 |
| Publisher committed-but-reply-lost 后 E11-C 是否需新 Inspector | 恢复边界未知 | 高 | 困难 | canonical policy列 inspector/settlement key；现有 Publisher dispatcher 已 worker-exit recover committed journal | PROBE | 复用现有 crash checkpoint/dispatcher tests，确认只需薄 binding，不创建新 journal | 沿用现有 journal recovery；不依据普通异常猜成功，不自动二次 publish |
| Worker generation 后 manifest tamper 与 Main readback 间 TOCTOU | 失败模式盲区 | 高 | 一般 | Publisher会再次校验 source size/hash并复制到其 own staging | PROBE | before-publish tamper/replace/symlink fault tests | Main readback后把 exact size/hash交现有 Publisher；Publisher再次复验，失败不发布 |

## BLOCK

无。上述高影响未知均可从现有代码与真实临时文件 probe 关闭，不需要改变冻结公共合同或向用户新增选择。

## 保守假设

- E11-C capability 只由定向测试/显式 non-production runtime 调用；live `recon-id-fix:export` 继续 legacy，FilePlan/UI 返回 shape 不变。
- Publisher 的 durable journal、rollback、uncertain/crash 语义是唯一发布权威；E11-C 不增加第二份 receipt/成功猜测。
- 业务 readback 对可达 legacy 输出验证固定单 sheet、列顺序、记录值、表头 10pt 与 watermark；不扩成 Excel 文件所有 OOXML 节点的通用验证器。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 export policy、command/result/manifest exact shape | 无大 DTO、production false、artifact set/order | canonical fixture deep-equal + validator negative tests | 推翻 runtime 接入 | 只保留纯 generator/validator |
| 2 | 实现 Service export prepare 与 Worker staging generation | exact result identity；复用 legacy IO；路径 containment | standard/BOC/JPM 三类 golden 与 staging hostile cases | 阻断 Main Join | 删除 export action 注册 |
| 3 | 实现 Main Join 技术/业务/evidence validator | 不信 Worker manifest；Publisher=0 on failure | tamper/stale/set/order/alias/symlink/readback fault matrix | 禁止调用 Publisher | 保留 generation capability但不注册 settlement |
| 4 | 薄接既有 journal Publisher | 多 artifact all-or-none；不猜 uncertain | failure/uncertain/kill/restart recovery tests | production capability不成立 | 移除 publisher binding，不改 journal模块 |
| 5 | E11-P0/A/B、legacy、smoke/integration 回归 | mutation/receipt/Hold/业务语义不漂移 | 定向矩阵、ESLint/check/diff | 不得提交 | 修复或收缩变更 |
| 6 | blindspot 与资金红线复核 | 血缘、行数、金额币种、恢复人工门禁 | evidence型自审 + important-variable review | 保持 production false并报告 | 不伪造人工批准 |

## Reviewer Follow-up Preflight（2026-08-28）

### Task Brief

- Goal：闭合 Reviewer 接受的四个可达边界：Service result 跨 Main settlement 单一所有权、Main 前置业务 authority、唯一 batch authority、显式 kind→target binding。
- Context：基线为 E11-C commit `6e0ee98fddc0b47d669387113c7c65dea4819e2f`；原实现的 Worker generation/manifest、Main workbook readback 与既有 journal Publisher 已通过 97/97 定向回归。
- Constraints：不以额外 evidence read 代替所有权；不传 raw rows；不改通用 FilePlan schema；不从文件名推断 artifact kind；Publisher uncertain 仍只交既有 journal recovery；不接 live route、不启用 production。
- Done when：normal import/run 在 export generation 至 Publisher settlement 间被同 Service reservation 拒绝；Main 用 generation 前冻结的 exact authority 验证真实 workbook；A runtime/B batch、反序 target 在 Worker 前拒绝；四个 Reviewer 反例及既有 recovery 回归通过。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| ServiceHost busy 只覆盖 attached Worker job；`job:done` 后 supervisor detach，Main Join/Publisher 不再占有 Service | `background-execution/service-host.js` `openJob/detach`；`supervisor.js` terminal cleanup | reservation 必须由 Main runtime 从 generation 前持续到 Publisher 返回或 journal recovery handoff 后 |
| public result 只有总体 resultDigest/count，Worker manifest 同时携带 recordsDigest 与 summary | `recon-id-fix-service/service.js` `publicResult`；`policies.js` export validator | Main 不能用 Worker manifest/summary互证；run terminal 必须提前携带有界 per-kind workbook projection digest |
| normalized FilePlan 只有 role/sourceOperation/path/key，没有 main/unmatched 业务 kind | `archive-center/file-plan.js` | 需要额外 Main-owned binding，且不修改通用 schema、不使用文件名启发式 |
| exact-seven batchContext 完整覆盖 runtime exact-five operation context 字段 | `archive-center/worker-batch-context.js`；operation context validator | 从唯一冻结 batch authority 派生 runtime request，并拒绝所有 caller identity 漂移 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 如何在不延长 Worker job protocol 的情况下保持 Service 单一 owner | 状态/并发 | 高 | 一般 | runtime 是所有 managed Service start/execute 的公共入口 | PROBE | runtime closure 内同步 reservation + 并发 import 反例 | 新增等价 service-operation reservation；owner handle 独占一次 export execute，finally 释放 |
| Main authority 最小 shape | 数据合同 | 高 | 一般 | result private rows 可在 run 完成时投影 digest；Main 已持 bounded result | PROBE | self-consistent forged workbook/manifest 反例 | exact counts/evidence/resultDigest + subMode/runKind + per-kind sheet/header/records/rowCount + authorityDigest/resultHandle；无 rows |
| artifact binding 由谁决定 | 所有权 | 高 | 容易 | FilePlan planner/Main 才拥有正式目标；Worker不得见 target path | PROBE | 原 binding + reversed FilePlan test | 调用方提供 Main-owned exact kind→artifactKey/targetPath；Main冻结，Worker只收 kind/key/generationPath |
| Publisher unresolved manual recovery 后是否继续占用 Service | 恢复生命周期 | 高 | 一般 | existing Publisher 返回前执行自动 recovery；manual failure 已持久化 journal/Hold 所需证据 | ASSUME | Publisher kill/recovery既有测试 | reservation 覆盖 Publisher promise；返回/抛错后由 journal 成为唯一恢复 owner，不保留易丢失内存锁 |

### BLOCK

无。Reviewer 已明确选择单一 owner、前置 authority、batch authority 与显式 binding；均可在现有非生产 API 内最小闭合。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | runtime service-operation reservation + batch authority | result identity/批次单一 owner | import race 与 A/B identity 反例 | 不得继续 Publisher | 移除 export settlement API，不改变 ServiceHost protocol |
| 2 | run-time bounded export authority | Main 不信 Worker；无 raw row | forged cell/row + self-consistent manifest 拒绝 | 阻断 Join | 保留旧 result DTO并停止 follow-up |
| 3 | Main-owned artifact binding | target kind/order 不靠文件名 | reversed target 在 Worker 前拒绝 | 阻断 generation | 不改 FilePlan，要求调用方重新规划 |
| 4 | 定向/恢复/legacy 回归与双盲区复核 | all-or-none、JPM post-image、人工门禁 | E11-C/B/Service/Publisher/smoke/static | 不得提交 | 收缩至可证明边界 |

## Round 2 Evidence Settlement Admission（2026-08-28）

### Task Brief

- Goal：在不接 live IPC/E12 的前提下，增加可由 scenario、BOC linked、JPM import 正常 writer 入口共用的 Main-owned evidence settlement admission；export 必须在 current evidence read 前获得 lease，直到 Publisher promise resolve/reject 后释放。
- Context：Round 1 的 runtime Service reservation 只能阻断 managed import/run/close；当前 `main.js` scenario 写、linked-table import/delete 与 JPM ADM import writer 都是 runtime 之外的 Main/DB 写路径。
- Constraints：不增加第三次 evidence read；不锁外部进程；不改 JPM mutation/receipt/Inspector/Hold；不无限持锁；不在 E11-C 修改 `main.js` handler wiring；缺失 branded shared admission/lease 时 export 必须在 evidence/Worker/Publisher 前 fail closed。
- Done when：settlement 期间 scenario/BOC/JPM 三类正常 writer admission 均拒绝且 write body=0，Publisher 返回后同一 admission 全部放行；无 admission 的 export 不读 evidence/不调 Worker/不调 Publisher；上轮四项闭环与 journal recovery 不回归。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| scenario create/update/delete/toggle/transfer/batch-delete 直接调 `AppDatabase` repository，不经 background runtime | `src/main.js` `scenarios:*` handlers | Service reservation 不能保护 scenario evidence；E12 wiring 必须在 DB write 前咨询共享 admission |
| BOC `fx-settlement` import/delete 会重建 linked evidence；bank/mid import/delete 会重建 JPM ADM | `importLinkedFileToRepo`、`linked-table:delete-by-date-range` | writer lease 必须覆盖真正 write/derive 边界，不能只在完成后清 cache |
| 既有 JPM Hold gate 只阻断 durable Hold/open Intent，不感知 ReconFix export settlement | `jpm-hold-gate.js`、`assertReconFixJpmAdmMutationAllowed` | 新 primitive 与 Hold gate 是正交合同；不改 receipt/Inspector/Hold，E12 在现有 admission 外层组合 |
| BOC/JPM legacy 引擎不返回 unmatchedRows；standard C4 真实返回 fixed/unmatched 两集 | `boc-dispatch-order-fix.js`、`jpm-dispatch-order-fix.js`、`c4-recon-id-fix.js` | P3 覆盖只测真实可达 output set；不为 BOC/JPM 虚构 unmatched 业务行 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| admission 应归 runtime 还是独立 Main authority | 所有权/生命周期 | 高 | 一般 | writer 不经 background action，但 E12 composition root 可让 handler 从 runtime owner 取 admission；runtime manager 可替换 runtime | PROBE | runtime A export 分别接 A/B admission，三 writer 只取 A owner lease | 每个 Main/runtime owner 内部创建并暴露唯一 branded admission；export 强制 exact object identity，不同合法实例不可混用 |
| writer 是否需要等待队列 | 并发/用户体验 | 中 | 容易 | 现有 Service/Hold 边界均 fail closed；settlement 短时 | ASSUME | Publisher callback 内 writer admission 立即失败，settlement 后立即成功 | 同步 BUSY，不增加无限等待/超时状态机 |
| P3 output-set 是否需要 3×3 虚构矩阵 | 业务可达性 | 中 | 容易 | BOC/JPM 引擎没有 unmatched 输出 | PROBE | 用真实 Service run 构造 standard 三 set + BOC/JPM main-only | 持久 table-driven 覆盖全部真实可达集，至少一个真实 unmatched-only；不扩业务引擎 |

### BLOCK

无。共享 authority 归属、writer BUSY 语义与可达 output set 都已可由仓库事实闭合。

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 实现 runtime-owner branded settlement/writer lease primitive | Main/runtime 单一 authority；有界释放；不锁外部 | 三 writer BUSY/后续放行 + missing/mismatched owner contract | 不得改 export | 删除独立模块，不触业务 writer |
| 2 | export 在 current read 前取 lease，Publisher settlement 后 finally 释放 | evidence 不在 Main writer 窗口漂移 | missing/BUSY 均 evidence=0/Worker=0/Publisher=0；resolve/reject 后 writer 放行 | 阻断 E11-C | 保留 primitive，撤下 export capability |
| 3 | table-driven 真实 output-set 回归 | artifact set/order 与真实业务可达性 | standard 三 set（含 unmatched-only）+ BOC/JPM main-only | P3 不成立 | 不改引擎，只补测试 |
| 4 | E11/Publisher/smoke/static + 双盲区 | journal、lineage、资金与 legacy 不漂移 | 定向矩阵全 PASS，clean commit | 不得提交 | 修复或收缩 |
