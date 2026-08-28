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
