# R3.2.2 Release Evidence — Preflight

## Task Brief

- Goal：基于 v3.2.2 当前冻结合同和 exact reviewed head，为 FundRecon、Duplicate、BankBU 共 10 个 action 建立只读、可机器校验、逐 action 独立的 release evidence；不改变任何 live 业务路径。
- Context：E06-A、E07-A/B/C、E08-A/B 已形成 production-false capability；R3.2.2 冻结范围是 Windows、人工、策略快照和 action 独立 enable。
- Constraints：精确 base 为 `5c9495dda46c775babdac9eb1700c459735e5c8b`；`production.enabled=false / effectiveMode=legacy / effectiveWorkerCount=0` 不变；BankBU policy 当前不在公共 `BACKGROUND_EXECUTION_POLICIES` 聚合中；本 PR 不改 `src/`、IPC/Main/renderer、runtime routing/ownership、资金算法、receipt、Inspector、Recovery 或 Publisher，不 bump package version，不运行 `release-check`、`check-vars`、`scan:vars`，不落 raw account/amount/row。
- Done when：tracked JSON 对每个 action 独立列出 policy、runtime ownership、evidence/gates/rollback/identity/order；validator 直接核对当前代码 authority、canonical fixture以及冻结 base 的真实 Git commit/blob/ordered facts，并拒绝 policy/evidence drift、跨 action 借证、人工或 Windows 自动升级、production enable、缺失/unknown 当 PASS、rollback/identity/order 漂移及任何 raw payload；定向测试、smoke、静态检查通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| exact base、HEAD、merge-base 均为 `5c9495dda46c775babdac9eb1700c459735e5c8b`，初始 worktree clean。 | `git rev-parse HEAD`、`git merge-base`、`git status --short`。 | snapshot 固定该 reviewed head，不接受模糊 parent。 |
| 冻结合同恰有 FundRecon 3、Duplicate 3、BankBU 4 共 10 action，代码合并时全部 production false。 | v3.2.2 Spec §3、TechDoc §12、canonical policy fixture。 | validator 锁定 action 集合、顺序和逐项 policy，不允许一个 action 代偿另一个。 |
| FundRecon/Duplicate 六项由公共 `BACKGROUND_EXECUTION_POLICIES` 聚合；BankBU 四项只有 `bank-bu-worker/policies.js` module policy，公共 runtime 未聚合。 | `src/main-process/background-execution/runtime.js` 与三个 module `policies.js`。 | FundRecon/Duplicate 标记 `COMMON_BACKGROUND_RUNTIME/REGISTERED`；BankBU 必须标记 `MODULE_LOCAL_ONLY/ABSENT_FAIL_CLOSED`，不能因 direct policy 存在而伪报公共 runtime PASS 或 enabled。 |
| 10 项 direct policy 均与 canonical fixture 的 mode/lifetime/commit/production 等关键字段一致，且均为 `false/legacy/0`。 | 代码投影与 fixture JSON 对比。 | validator 同时读取代码与 fixture；snapshot 不是第二运行时 authority。 |
| FundRecon 仍缺 Windows packaged/native SQLite、真实进程 shutdown、真实大样本 RSS、Main live Publisher/settlement 和资金人工复核。 | E06-A implementation notes Remaining Unknowns。 | 自动 unit/golden 只属于 local capability，不能升级这些 gate。 |
| Duplicate paired parser 本地 darwin parser-only 改善 40.18%、RSS 在声明预算内，但 native Governor 实际只批准 1 Parser，Windows、真实资金样本、retention/Hold control 未闭合。 | E07-C tracked benchmark JSON 与 E07-A/B/C notes。 | 仅 `duplicate:import` 可记 `LOCAL_CAPABILITY_ONLY`；production 仍 false/single，其他 action 不借用 import benchmark。 |
| BankBU dual parser 本地 parser-only 改善 35.33%、RSS 在声明预算内，但没有公共 runtime/live 接线，Windows/真实月度样本/partial-unknown 人工恢复未闭合。 | E08-A/B implementation notes 与当前 runtime 聚合事实。 | 仅 `bank-bu:import-month` 记本地 capability；四个 BankBU action 都因公共 runtime 缺席 fail closed。 |
| `package.json.version` 为 `3.1.14`；冻结 R3.2.2 文档未要求本证据 PR bump，且无用户可见行为变化。 | `package.json`、Spec/TechDoc/sequence。 | 不 bump、不更新 release 用户文档三件套。 |
| Round1 Reviewer 证明 action semantic digest、同脚本 expected constants 与 snapshot 可同步篡改，错误 ownership/order、全零 reviewedHead、跨 action benchmark 仍可能自证；`raw*Stored=false` 也不能证明 payload 无敏感值。 | Reviewer 三个可复现 authority probe 与 rollback raw account/amount probe。 | 删除 action seal 作为 authority；reviewedHead 必须是真实冻结 base 祖先，`head:path` blob OID/SHA 与 current canonical file一致；10 action 的 ownership/identity/order/evidence scope须引用 base-owned source/test ordered facts；先递归扫描实际 key/value 再做结构校验。 |
| Round2 Reviewer 可同步把 Duplicate import performance anchor、evidence spec、snapshot action refs/gates 全部 retag 成 export，原 validator 仍 PASS；中文 key、空格/点/斜杠分隔与全角标点 payload 也未必命中 privacy。 | Reviewer 同步 retag probe 及 `账号`、`金额`、`raw account`、`金额：12.34`、中文全角业务行五个反例。 | performance claim 必须同时引用 Git-backed performance 与 `ACTION_SCOPE` anchor，actionKey 从 exact-base E07-C source 中唯一派生；privacy 先 NFKC，再折叠常见分隔符和匹配中英文标签。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- |
| BankBU direct policy 与公共 runtime 缺席如何同时表达而不误报。 | PROBE（已闭合） | 高 | 容易 | direct module 含 4 policy；公共聚合精确缺席；live Main 未接线。 | validator 分源读取 module policy、canonical fixture和公共 action set。 | policy authority 为 `module-policy`，runtime registration 固定 `ABSENT_FAIL_CLOSED`，相关执行 gate `NOT_RUN`；不得调用公共 `isProductionEnabled=false` 冒充已注册验证。 |
| 共享 implementation notes 是否会形成跨 action 证据借用。 | PROBE（已闭合） | 高 | 容易 | 同一 notes 文件包含多 action 的测试事实。 | evidence catalog 为每个 action 建独立 claim ID，并在 validator 强制 `evidence.actionKey === action.actionKey`；合同 authority 只作为 shared ref。 | 每个 action 至少一项自己的 claim；另一个 action 的 claim 即使 source 相同也拒绝。 |
| 本地 parser benchmark 如何记录而不解除 production gate。 | PROBE（已闭合） | 高 | 容易 | Duplicate 有 tracked JSON；BankBU 指标冻结于 tracked notes；两者均明确 production false。 | 校验 source hash、指标和 `productionEnabled=false`/notes 文本；gate 值不用 `PASS`。 | 仅 import action 使用 `LOCAL_CAPABILITY_ONLY`，Windows/native/真实样本仍 `NOT_RUN` 或 `PENDING_HUMAN_REVIEW`。 |
| snapshot 与同一新增脚本常量能否共同伪造 action ownership/order 或 evidence scope。 | PROBE（Round2 已闭合） | 高 | 容易 | Round1 已引入 Git object，但 Round2 证明 benchmark JSON 无 action identity，同步修改 performance/evidence specs 和 snapshot 仍可 retag。 | 增加 exact-base `topology.js` action-scope anchor，从 source 结构中派生唯一 `duplicate:import`；performance evidence 必须同时引用 performance 与 action-scope anchors。 | schema v2 保持；18个 base anchor逐 action闭环；同步 retag snapshot + `BASE_ANCHOR_SPECS` + `EVIDENCE_SPECS` + refs/gates 只命中 `/actionScope`并 fail closed。 |
| 声明 `raw*Stored=false` 是否足以证明 snapshot 不含敏感 payload。 | PROBE（Round2 已闭合） | 高 | 容易 | Round1 英文 raw account/amount 已拦截，但 Round2 证明中文 key、分隔变体和全角标点可旁路。 | 收紧为 metadata-only结构化枚举/anchor IDs；validator在其他校验前 NFKC 并递归检查 key/value。 | 拒绝12–24位账号、amount标签数值、中英文序列化业务row与raw-like key；key折叠空白/点/斜杠/横线/下划线/常见标点；hash/OID/version及普通中文说明不误报。 |
| action-independent snapshot 是否需要修改公共 runtime registry。 | ASSUME | 高 | 容易 | 目标是只读 evidence，任务禁止 routing/ownership 改动。 | 以 JSON + CLI validator + tamper tests 完成端到端取证。 | 不改 `src/`；任何缺失 runtime owner 直接 fail closed。 |
| 是否需要 package version bump。 | ASSUME | 低 | 容易 | 冻结文档无要求，产品行为零变化，既有 release-evidence PR 不 bump。 | validator 锁定 `3.1.14` 与 `bumped=false`。 | 本 PR 不 bump；若 release owner 后续决定正式版本迭代，三件套必须同步且另立范围。 |

未发现需要改变冻结数据模型、公共合同、资金/恢复边界或 live 主流程的 `BLOCK`。Windows、真实样本和资金/恢复人工复核是明确的 production gate，不是本地 evidence PR 可自动消除的未知。

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败处置 |
| --- | --- | --- | --- | --- |
| 1 | 固定 authority layering、action 集合和状态枚举。 | BankBU 缺席不伪装 PASS；10 action 独立。 | 代码/fixture投影一致，公共聚合只含 FundRecon/Duplicate。 | 保持全部 disabled，拒绝 snapshot。 |
| 2 | 建立 tracked JSON、Git-backed base anchors 与 action-scoped evidence claim。 | policy、runtime、证据、gate、rollback/identity/order不可串用；同脚本seal不能自证。 | validator 对原始 snapshot 通过；真实 commit/blob/ordered facts闭环；同步 metadata mutation fail closed。 | 收紧固定 schema，不修改业务 runtime。 |
| 3 | 增加 tamper/mutation 与只读 CLI 测试。 | Windows/人工不得自动升级；missing/unknown不得当 PASS；production 不能开启。 | 每类篡改单独命中稳定 error path。 | snapshot 保持未接受，所有 gate 继续 open。 |
| 4 | 运行 focused/affected、integration/smoke/static。 | receipt/Inspector/order/资金链无回归。 | unit、必要 integration、smoke、ESLint、`node --check`、JSON parse、diff check。 | 只修 evidence/test；不扩大到 live 行为。 |
| 5 | 执行两类 blindspot 自审、更新 notes、提交。 | Decisions/Assumptions/Deviations/Evidence/Remaining unknowns 可审计。 | exact parent/HEAD、clean tree、本地 commit。 | 不 push、不宣称 production/local-ready，交独立 Reviewer。 |
