# E09-P0 Statement Probes Unknowns Preflight

## Task Brief

- Goal：冻结 Statement 现有重状态 footprint、pending interaction token/DTO 与资源模型，并用真实 production core 的 characterization/golden 证明 current/all、金额路径、余额 seed prompt 和状态失效现状；为 E09-A～D 提供不可漂移的输入合同。
- Context：精确基线为 `7577d5ae2f627619ba3f22597505c587be9867b6`；权威规范为 `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/{spec,techdoc}.md` 与 Platform Contract v1。
- Constraints：只交付 E09-P0；不实现或接线 Statement Service、pending interaction/waiting-user continuation、current/all managed generation、atomic manual seed settlement/inspector 或 NewAccount Worker；所有 `statement:*` production flag 保持 `false`，live IPC 保持 legacy；不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：state/token footprint estimator 对真实 Statement graph 与基线规模样本给出有界、可复现结果；public token/status/interaction DTO 与 private context 严格分离；canonical policy 的 256 MiB state/token、单 token、15 分钟 TTL 和 resource handshake 被合同测试冻结；legacy current/all、金额/余额/manual seed 现状由真实 production core golden 锁定；定向测试、基线规模 probe、静态检查与盲区复核通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| exact base 无漂移，Statement 五个 canonical action 均为 service/thread-single 且 `production.enabled=false` | `git rev-parse HEAD`；canonical `policy-registry.v3.2.x.json` 的五个 `statement:*` entry | P0 不能切 live 路径或修改 production flag |
| Platform 要求 state/token 在公开前完成 `request → grant → adopted → adopt-ack`，Main 只持 bounded DTO | Platform Contract v1 §4.6、§6、§11；v3.2.3 Spec §3～§5 | P0 只能冻结 contract/estimator，不能用本地 Map/token 绕过 reservation |
| 现有完整 Statement state 由 Main globals 持有 | `src/main.js` 的 `statementImportSessions`、`lastFileImportContext`、`lastPendingBigAccountSelection`、`lastManualBalancePrompt`、`lastGeneratedExports` | estimator/probe 必须覆盖这些实际 graph；E09-A 才迁移所有权 |
| pending big-account context 会保留 `fileEntries.detailRows`、选择行、source evidence 与回调；remember context 还会再次 clone rows | `rememberPendingBigAccountSelection`、`createPendingBigAccountSelectionContext`、`rememberLastFileImportContext` | public DTO 禁止携带 rows/callback/path/private evidence；private token footprint 必须独立计费 |
| session 的 current 是 `currentBatchId` 对应 entryIds，all 是 `fileEntries` 原顺序浅拷贝 | `src/main-process/statement-session.js#getStatementSessionEntries` | current/all golden 必须冻结成员和稳定顺序，不能靠名称推断 |
| legacy 生成核心复用 `buildMappedRows`、`buildDetailExportRows`、session merge、balance seed store 与 workbook writer | `src/backend/file-service`、`statement-session.js`、`statement-generation.js`、`src/main.js` generation functions | characterization 必须执行真实 production modules，不复制算法或用 mock 自证 |
| manual seed 当前是 Main 直接写入后立即按 remembered context 重新生成 | `file:save-balance-seed` prepare/execute；`manual-balance-seed-preflight.js`、`balance-seed-store.js` | E09-P0 只锁定 prompt/plan/file bytes/调用顺序；原子 writer/intent/inspector 属 E09-D |
| canonical resource ceiling 为 state 256 MiB、pending interaction 256 MiB、token maxOutstanding=1、TTL=900000 ms、single-use | canonical policy fixture 五个 Statement entry | P0 合同常量必须与 fixture exact-equal；真实 probe 只能证明样本，不得冒充生产容量批准 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 哪些字段属于 stable service state、private token context 与 public DTO | 数据所有权/隐私 | 高 | 一般 | Spec 给所有权原则，legacy graph 可取证 | PROBE | 沿 globals、pending builder、renderer 消费字段建立字段级 inventory | 已关闭：Main handle 按 TechDoc exact-eight；public DTO 剥离 reservation/session/private rows/path；status 仅 bounded summary |
| footprint 如何对共享引用、数组自定义 metadata、Map/Set/Buffer 计费 | 资源/容量 | 高 | 一般 | legacy rows 用数组加 enumerable metadata；E06 estimator 有可复用原则 | PROBE | 构造 production-shape graph 与实际 heap delta/structured graph 交叉 probe | 已关闭：deterministic graph estimator + 50% headroom + 4 KiB rounding，shared/cycle只计一次，hostile/unsupported fail closed |
| 基线规模应覆盖多少行/列/批次/token | 容量 | 高 | 容易 | canonical budget 256 MiB，但真实样本批准尚未存在 | PROBE | 用现有 Statement row shape 扩展到固定多批次规模，记录 estimator 与 child-process heap/RSS delta | 已关闭P0基线：50k行/4批次/1 token；仅为 generated production-shape evidence，不解除真实样本/Windows gate |
| legacy import reservation 失败时旧 session 保留还是失效 | 状态生命周期 | 高 | 一般 | E09-A 尚未实现 resource adoption | PROBE（后续） | E09-A 在 candidate adoption fault injection 对照本 P0 golden | P0 不实现；冻结当前 legacy mutation/golden，E09-A 必须保持行为 |
| token single-use/TTL/stale 的 runtime 实现细节 | 状态生命周期 | 高 | 一般 | canonical policy 已冻结规则，但 token store 属 E09-B | PROBE（后续） | E09-B token store fault/race tests | P0 只冻结 DTO/resource contract，不提前实现 store |
| current/all、四金额路径与 balance/manual seed 的最小 golden 集 | 资金语义 | 高 | 一般 | file-service/session/balance modules可真实执行 | PROBE | 真实 XLSX/CSV input + production core，冻结 canonical result/row disposition/hash | 已关闭：覆盖 direct、signed、field-conditional、bill split/merge、zero/both、current/all、balance writer与manual seed exact bytes |
| public DTO byte ceiling 是否应直接等于 policy 1 MiB status ceiling | 协议/隐私 | 中 | 容易 | policy 只冻结 status 1 MiB；Job envelope 256 KiB | ASSUME | 对 canonical fixture 与 Renderer 实际字段取证 | 已采用 Platform command/event ceiling 256 KiB；status 仍独立1 MiB；正反测试锁定 |

## BLOCK 问题

E09-P0 自身没有需要用户选择的 BLOCK。以下条件继续阻断后续 production enablement，且本 PR 不得用 probe 结果替代：

1. E09-A 的 Worker-only session ownership 与真实 Service resource adoption 尚未实现。
2. E09-B 的 reservation/TTL/single-use/stale/crash/waiting-user lock/lease 生命周期尚未实现。
3. E09-C 的 current/all staging、validator、Publisher all-or-none 与 workbook 等价尚未实现。
4. E09-D 的 manual seed atomic replace、directory fsync、pre/post inspector、fault injection 与 Windows packaged 尚未实现。
5. Statement 金额、借贷方向、币种、余额 seed 与 current/all 均保留人工资金复核红线。

## 已执行或计划执行的 PROBE

1. exact base 与 canonical policy：已确认五 action 的 resource/token/service/production 字段。
2. legacy graph inventory：已确认 session、remembered generation、big-account pending、manual seed prompt 与 generated artifact cache 的所有权与复制点。
3. current/all：执行 `statement-session.js` 真实 append/remove/get entries 路径，冻结 batch 成员与稳定顺序。
4. 金额/余额：用真实工作簿执行 `file-service` 映射/过滤/split core 与 balance seed store，不复制生产算法。
5. footprint：固定 production-shape baseline graph，在独立 child process 中交叉记录 estimator、heapUsed 与 RSS；不把单次 RSS 采样描述为硬上界。
6. static gate：证明新增模块未被 `src/main.js`、IPC、runtime entry 或 feature flag 引用，五 action production 仍为 false。

## 保守假设

- E09-P0 新模块是 production-shape contract/probe library，但没有 live consumer；E09-A/B 必须直接复用这些冻结 validator/estimator，不能另造第二套 DTO。
- footprint estimator 是 reservation request 的保守确定性输入，不是 V8 精确 heap profiler；基线 child-process RSS 只用于校准和记录，不证明所有真实文件峰值。
- public DTO 只含 opaque token identity、purpose、generation/revision、expiry、bounded summary/choice；source absolute path、detailRows、prepared batch、functions 与完整 evidence 留在 private context。
- canonical resource 数值本 PR 不擅自改动；若基线 probe 超预算则 fail closed 并把预算审批留为 BLOCK，不通过放宽 fixture 解决。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 Statement contract 常量与 exact plain DTO validators | private rows 不回 Main/Renderer；canonical policy 不漂移 | 正反 DTO、fixture parity、hostile object tests | 推翻后续 E09-A/B 公共边界，停止实现 | 只保留 preflight 与现状 inventory |
| 2 | 实现 state/private-context deterministic footprint | reservation 在采用前覆盖当前 graph，共享引用不重复、unsupported fail closed | metadata/shared/cycle/Map/Set/Buffer/预算边界 tests | 无法可信申请资源，阻断 E09-A | 收缩为 probe-only estimator，不接任何 runtime |
| 3 | 建固定基线规模 graph 与 child-process probe | 记录 estimator 与真实 heap/RSS 量级，避免空壳小对象自证 | 固定行/列/批次/token计数与可复跑 JSON 输出 | canonical 256 MiB 不足则升级 BLOCK | 降低声明，只记录超限事实，不改预算 |
| 4 | 建 legacy current/all、金额/余额/manual seed golden | 保护金额币种、row disposition、batch 顺序与 seed 文件语义 | production core + 真实 workbook/seed bytes golden | 任何漂移阻断 E09-A～D | 不改 legacy code，修正候选合同/测试 |
| 5 | blindspot/资金盲区与静态复核 | 防 live 接线、状态旁路、人工红线被误解除 | production flag/live diff 为零、无存活 P0 Critical 自动缺口 | 不提交 | 删除越界实现或补证据 |
