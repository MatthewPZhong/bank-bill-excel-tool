# R3.2.3 Release Evidence — Preflight

## Task Brief

- Goal：基于 v3.2.3 冻结 Spec/TechDoc、E09/E10 已审查父链和 exact parent，为 Statement 与 NewAccount 共 7 个 action 建立只读、逐 action 独立、可机器校验的最终发布证据。
- Context：最终 E10-B head 为 `5c557ae557f0f6f148734f50f3250199cac6607d`；其后的独立 pre-evidence stabilization `771e55f72b5f91caecc013220fd8f50dd2b18e18` 已收口归档 root identity 竞态与 v3.2.2 跨版本 sequence append-only 合同，`60cf39e739147001cfbb34201edf5fa20c994bf6` 继续把 v3.2.2 历史 base anchor 固定到 reviewed blob、把当前 policy/runtime 留在 current source；精确 parent `d54f97cecddef992069d867eedc227681ed562d4` 以第一父 tree 保留两项 stabilization，并仅通过第二父保留已缓存远端 #207 ancestry；R3.2.3 只交付 release evidence，不新增生产路径。
- Constraints：只新增本目录 3 文件、validator 与 unit test；不改 `src/`、Main/IPC/Renderer、金额/币种/seed/Publisher；不 bump version；不运行 `release-check`、`check-vars`、`scan:vars`；全部 action 保持 `production.enabled=false / effectiveMode=legacy / effectiveWorkerCount=0`。
- Done when：JSON/validator 绑定 exact parent/head/merge-base、tracked blob/type/mode、冻结 7-action scope、真实 runtime ownership、reviewed evidence、自动 coverage、人工 gate 和 rollback；Statement common runtime absent 不被伪报；E09-P0/A/B/C/D、E10-A/B、RSS/cancel/recovery 可追溯；Windows/资金/恢复继续 NOT READY。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 最终 E10-B head 已包含最终 v3.2.2、E09-A～D、E10-A/B 业务叠栈；其后 stabilization 只收口 release 前暴露的归档 root identity 与旧 evidence validator 问题；冻结 Spec 恰有 Statement 5项与 NewAccount 2项。 | Git `5c557ae5... → 771e55f7...`；final-chain ancestry/range-diff；stabilization notes；v3.2.3 Spec §3/§11。 | reviewed action heads、稳定化 parent 与 action 集合分别作为 exact authority，不相互冒充。 |
| Statement 5项只存在 canonical fixture 与 module-local service entry seam。 | `statement-worker/runtime-bindings.js`；公共 `BACKGROUND_EXECUTION_POLICIES`。 | 必须写 `DORMANT_MODULE_ENTRY_ONLY / COMMON_RUNTIME_ABSENT`；不得伪报 REGISTERED/PASS。 |
| NewAccount 两项 direct policy 已进入公共 runtime，仍是 false/legacy/0；冻结 Spec 的 currentDisposition 仅 save-as 为 `inline-excluded`，generate 与 Statement 六项为 `legacy-preserved`。 | v3.2.3 Spec §3；`new-account/policies.js`；`background-execution/runtime.js`。 | direct policy 必须与 common runtime 同一对象，registration 与 production enablement 分开；liveDisposition 必须按 actionKey exact 映射。 |
| E09/E10 notes 已记录自动测试、RSS、cancel、recovery，但 Windows/真实资金/Excel-WPS gate 未关闭。 | 各 reviewed implementation notes 的 Evidence/Remaining Unknowns。 | 本地证据只能标 merge-ready，不能标 production-ready。 |
| R3.2.4 已证明 Git checkout、duplicate-key、number-token 与 ignored audit-root 旁路真实可达；本版真实 require graph 还会进入 `src/backend`。 | exact commit `a805de8b...` validator/tests；`src/backend` extensionless `require()` 路径。 | audit root 必须覆盖整个 `src`，否则 ignored backend shim 可执行非 HEAD 字节。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Statement capability 应否记公共注册。 | ownership | 高 | 容易 | runtime action map exact absent。 | PROBE | 直接加载 common runtime 与 module entry keys。 | 记 dormant entry only/common runtime absent；误报 fail closed。 |
| NewAccount generate 与 frozen fixture 有已审查 overlay。 | authority | 高 | 容易 | direct/fixture exact diff 共 10 path。 | PROBE | 结构化 deep diff。 | 只允许 exact 10 path；save-as 必须 fixture exact。 |
| review evidence 是否可跨 action 借用。 | audit scope | 高 | 容易 | P0/B/C 是共享阶段证据；A/D/E10 是 action-specific。 | PROBE | catalog actionKey + action evidenceRefs mutation。 | null 只代表明确共享阶段；非 null 只能供 exact action。 |
| local RSS 是否可作为 Windows production evidence。 | platform | 高 | 困难 | macOS/本地 probe 只具方向性。 | BLOCK production only | Setup/portable 实机 + 真实代表样本。 | `LOCAL_DIRECTIONAL_ONLY`；productionReady=false。 |
| package/release 三件套是否要更新。 | release scope | 低 | 容易 | package 仍 3.1.14，PR 无用户可见 live change。 | ASSUME | 查冻结 sequence/package。 | evidence-only 不 bump；正式发布另立 owner 决策。 |

## BLOCK

没有实施 BLOCK。以下只阻断 production enable，不阻断 evidence-only 本地合并：

- Windows Setup/portable、路径 identity/directory fsync、长驻 service/app quit；
- 真实脱敏资金样本的金额/方向/币种/seed/current-all/NewAccount 输出；
- Excel/WPS 展示和 durable recovery 人工复核。

## 风险优先计划

1. 先锁 exact single parent、branch、5-path pure-add 100644、HEAD tree/index/worktree blob/type/mode、整个 `src` audit root、main/tag refs。
2. 在 `JSON.parse` 前锁 duplicate/NFKC key 与 number lexeme，错误输出固定且不回显输入。
3. 独立验证 Statement dormant/common-runtime absent 与 NewAccount direct/common-runtime identity。
4. 绑定 reviewed head:path blob/hash、7-action evidenceRefs 与 E09/E10/RSS/cancel/recovery coverage。
5. mutation 测试拒绝 production/live upgrade、跨 action 借证和人工 gate 自动 PASS。
6. 运行定向 unit、相关 E09/E10/platform unit、integration/smoke/lint/static；如实记录平台依赖基线。
7. 执行 reconciliation blindspot、自查 diff、提交并确认 clean。
