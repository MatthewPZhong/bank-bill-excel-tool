# R3.2.2 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec、TechDoc、implementation sequence 与 background-execution canonical contract 中冻结的 `R3.2.2 | Windows、人工、策略快照 | action独立enable`。
- Exact base：`5c9495dda46c775babdac9eb1700c459735e5c8b`（E08-B reviewed head）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：10-action tracked snapshot 与当前 code/fixture authority、runtime layering和 action-scoped evidence一致；任何 Windows、真实进程、真实样本、资金、恢复 gate 均不被本地自动化升级；全部 production 继续 `false/legacy/0`。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用 tracked JSON + 只读 CLI validator + mutation tests，不改 `src/`。 | release evidence 需要防漂移但不是新运行时 authority；当前 capability 与 live 决策已经分离。 | 新增 production registry、feature flag、Main wiring或把 snapshot 读入业务 runtime。 | 业务金额、币种、matching、receipt、Inspector、Recovery、Publisher和现有 live handler零变化。 |
| FundRecon/Duplicate 六项以公共 `BACKGROUND_EXECUTION_POLICIES` + direct module + canonical fixture 三方一致为 authority。 | 当前公共 runtime 精确聚合这六项。 | 只信文档 snapshot；把测试 capability 当 production state。 | validator 全量比较 direct policy 与 canonical object，并锁定 `false/legacy/0`。 |
| BankBU 四项明确分层为 `module-policy-only / ABSENT_FAIL_CLOSED`。 | direct module 有冻结 policy，但公共 runtime action set没有 BankBU，Main/preload/renderer也没有这些 action route。 | 用公共 `isProductionEnabled=false` 把“未注册”伪装成已注册且已验证；顺手把 BankBU 接入公共 runtime。 | snapshot 保留 module capability事实，同时公共 ownership与live gate固定未运行；四项一律 disabled。 |
| evidence catalog 为每个 action 建独立 claim identity，并引用该 action 的 base-owned source/test anchor；只有冻结合同/policy可作为 shared evidence。 | 同一 implementation notes 可能覆盖多个 action，单纯引用文件会允许跨 action 代偿；Round2 probe证明同步修改snapshot、performance/evidence specs和action refs/gates可把无identity的Duplicate benchmark借给export。 | FundRecon、Duplicate或BankBU分别只列一条模块级证据；允许 import benchmark补 run/export；只靠同脚本 expected catalog/actionKey。 | validator要求evidence的action、kind、anchorRefs精确闭环；每条performance evidence必须同时引用performance与Git source派生的`ACTION_SCOPE` anchor，同步retag必须命中`/actionScope`。 |
| schema v2 删除 action semantic seal，把18个 ownership/identity/order/performance/action-scope anchor绑定到冻结 base 的真实 Git object和required ordered facts。 | Round1 Reviewer证明错误BankBU ownership/order及不存在reviewedHead可由同脚本seal自证；Round2进一步证明benchmark JSON本体没有action identity。 | 加强或重算另一组同脚本digest；继续让free-form rollback文字充当合同；把benchmark文件名当action authority。 | 每个reviewedHead必须是真实commit且为exact base祖先；`reviewedHead:path` blob OID/SHA、current canonical hash及base source/test ordered facts全部一致；Duplicate paired topology从exact-base source唯一派生`duplicate:import`。 |
| data minimization改为metadata-only结构化schema，并在其他校验前递归扫描实际key/value。 | Round1 raw account/amount与Round2中文key/常见分隔/全角标点probe证明布尔声明与ASCII-only检查都不足以证明payload无敏感值。 | 继续只校验`raw*Stored=false`；只在完整性失败后给泛化错误；无界数字正则。 | snapshot不再保留free-form rollback/ownership描述；key/value先做Unicode NFKC，key折叠空白、点、斜杠、横线、下划线与常见标点；中英文账号/金额/业务行直接命中`/privacy/*`，hash/OID/version与普通中文说明不误报。 |
| 本地 Duplicate/BankBU parser benchmark只记为 `LOCAL_CAPABILITY_ONLY`。 | Duplicate tracked JSON是darwin parser-only 40.18%；BankBU notes是darwin parser-only 35.33%；两者均明确不代表 Windows/native/live/人工 gate。 | 写 `PASS`、自动启用 worker count；将 import benchmark借给 run/export。 | 仅两个 import action的 performance字段可为 local capability；每条benchmark还须引用base-owned action-scope anchor；production仍 false/0。 |
| 所有 action 的 Windows packaged/native SQLite/真实进程/live均为 `NOT_RUN`；真实业务样本/资金/恢复均为 `PENDING_HUMAN_REVIEW`。 | 当前 notes 明确这些门禁未闭合，任务禁止模拟真实 Windows/资金证据。 | 用 unit、integration、smoke、历史Windows诊断或本地benchmark自动升级。 | 缺失、`UNKNOWN`、`PASS` 都被 validator拒绝；action必须独立关闭 gate。 |
| 不 bump `package.json.version`。 | 当前版本 `3.1.14`；冻结文档未要求本 evidence-only PR bump，且没有用户行为变化。 | 猜测改为 3.2.2；只更新 release 文档三件套中的一部分。 | snapshot和validator锁定 `3.1.14 / bumped=false`；正式版本决策另立范围。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| snapshot 是 review artifact，不是动态 production config。 | 无 `src/` consumer；validator只有读取路径。 | 若未来被 runtime require，会形成双 authority。 | 当前 live source action-key scan与diff scope固定零接线；未来若改变必须新合同/新PR。 |
| reviewed head、Git blob identity和current canonical file共同界定本地 capability范围。 | 每个 claim/anchor同时冻结 source、reviewedHead、blob OID与CRLF-canonical SHA；head必须为exact base祖先。 | commit/path不存在、非祖先、历史blob与current file分叉时可能误用旧结论。 | validator通过只读Git命令逐项核验，不再接受null/unknown reviewedHead；任何一层漂移拒绝。 |
| validator脚本仍由代码review维护，但action语义不再由脚本内seal或actionKey常量自证。 | required ordered facts必须实际存在于冻结base-owned source/test blob，performance action scope从该Git-backed source文本派生，policy/runtime ownership另从现有结构化模块导出。 | 若直接恶意删除validator检查，任何tracked validator都可被绕过。 | Round2完整同步retag snapshot + validator specs + refs/gates仍被base-owned `duplicate:import` 击穿；脚本不接production、不自动发布，diff仍须独立Reviewer复核。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| v1 schema使用action digest及free-form ownership/rollback描述。 | Round1后升级schema v2：移除seal和free-form语义，新增Git-backed base anchors、真实reviewedHead/blob、结构化anchor IDs与recursive privacy scan。 | 原方案不能抵御snapshot+same-script constants同步篡改，也只声明不落raw数据而未检查payload。 | 仅release evidence JSON/validator/tests变化；无live、policy、runtime、资金或恢复合同变化。 | 不需要，属于validator证据强度修复，不改变冻结产品合同。 |
| Round1 schema v2的performance anchor仅冻结benchmark payload，privacy检查仅覆盖ASCII主路。 | Round2保持schema v2，新增Git-backed `ACTION_SCOPE`绑定与NFKC/分隔符折叠；不增加snapshot自由文本字段。 | Reviewer已证明benchmark可同步retag，五类中文/全角payload可旁路。 | 仅release evidence JSON/validator/tests/notes变化；无`src/`、live、runtime、资金或恢复合同变化。 | 不需要，属于已接受Reviewer finding的证据强度修复。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / merge-base / initial clean | HEAD与merge-base均为 `5c9495dda46c775babdac9eb1700c459735e5c8b`，branch `codex/v3.2.2-r3-release-evidence` | 防 parent/版本线漂移。 |
| `node scripts/validate-v3-2-2-release-evidence.js` | PASS：10 action、production enabled 0、common runtime 6、BankBU common runtime 0/`ABSENT_FAIL_CLOSED`、Windows `NOT_RUN`、资金恢复 `PENDING_HUMAN_REVIEW` | current full policy与fixture、runtime layering、真实Git reviewedHead/blob、18个base ordered-fact anchors、Git-derived action scope、live route、package与NFKC recursive privacy。 |
| release evidence专属 unit | `27/27 PASS` | 原19项全保留；新增完整同步retag snapshot + `BASE_ANCHOR_SPECS` + `EVIDENCE_SPECS` + action refs/gates仍被exact-base `duplicate:import` action scope击穿，且只命中`/actionScope`；`账号`、`金额=12`、`raw account`、`金额：12.34`、中文全角业务行五个反例均以`/privacy/*`为首错；hash/OID/version与普通中文说明不误报。 |
| focused affected unit | `250/250 PASS` | Round1的242条集合加Round2的8条mutation/子测：policy registry/action binding；FundRecon policy/service/evidence/artifact/runtime；Duplicate policy/service/matching/receipt/Inspector/recovery/paired parser/order/shutdown；BankBU E08-A/B policy/receipt/Inspector/side-main/order/shutdown。使用主仓库只读`NODE_PATH`补足隔离worktree未安装依赖。 |
| direct integration | `27/27 + 31/31 + 21/21 + 9/9 + 17/17 PASS` | background recovery control、Duplicate真实端到端、BankBU single jobs、BankBU dual parser、BankBU side DB parity；总计105条断言。 |
| `npm run smoke` | PASS；含 BankBU `41/41`、scenario/biz-op/acquiring 等全仓 smoke | 资金/匹配相邻链路与既有业务 smoke 无回归；不是人工真实样本证据。 |
| affected ESLint | PASS | validator/test JS风格。隔离 worktree没有本地依赖；使用主仓库只读 `NODE_PATH` 和同一 ESLint binary 后通过。首次直接运行因缺`globals`在config load阶段退出，不是lint finding。 |
| `node --check`、JSON parse、`git diff --check` | PASS | 两个新增JS语法、tracked JSON格式与patch空白。 |
| 明确未执行 | `release-check`、`check-vars`、`scan:vars`；Windows packaged/真实进程/真实资金样本 | 按冻结任务禁止；所有对应 gate保持open，不作PASS声明。 |

## Blindspot Pass

| 维度 | 结论 | 证据/剩余风险 |
| --- | --- | --- |
| 入口旁路 | snapshot没有业务 consumer；公共 runtime action set动态核对；BankBU live action key在Main/preload/renderer缺席。 | `src/` diff为零；validator BankBU伪注册 mutation拒绝。静态扫描不能代替未来代码review，因此任何live改动必须重做snapshot。 |
| authority边界 | direct policy、common runtime、canonical fixture分层读取；BankBU direct policy存在不等于公共 owner存在。 | full policy三方对比；common action set精确6项；BankBU精确0项。 |
| 失败模式 | commit不存在/非祖先、`reviewedHead:path`缺失、blob OID/SHA/current source漂移、base ordered fact缺失、action缺项/乱序、unknown gate、cross-action ref、performance同步retag与raw payload全部fail closed。 | 27项专属tests；包括同步snapshot metadata、换另一真实blob、Round1 probes、Round2完整spec retag与五类Unicode/privacy首错；CLI失败只读，不修改snapshot或业务状态。 |
| 状态生命周期 | evidence是单次 reviewed base snapshot，不持有lease/job/receipt，也不执行cleanup/compensation。 | scope和base固定；runtime ownership只作事实描述。未来head变化必须更新source evidence并重新review。 |
| 兼容性 | package/version、业务入口、policy、runtime、receipt/schema均未改。 | 新增文件仅 changes/scripts/tests；smoke与affected回归通过。 |
| 可观测性 | CLI输出有界：action计数、production计数、BankBU聚合状态和两类人工gate；不输出路径、账号、金额、行。 | metadata-only profile exact lock；NFKC recursive key/value scan在结构校验前拒绝中英文账号、amount、serialized row和raw-like key，hash/OID/version与普通中文说明明确不误报。 |
| 测试缺口 | 未执行 Windows packaged/native SQLite、真实process kill、真实业务文件和人工恢复；未验证future PR head。 | 全部明确为 `NOT_RUN` / `PENDING_HUMAN_REVIEW`，阻断任何 action enable。 |

## Reconciliation Blindspot Pass

| 资金/对账检查 | 结论与证据 |
| --- | --- |
| 主键与来源血缘 | snapshot不保存业务主键；只冻结 actionKey、operation identity/order不变量和repo证据hash。FundRecon evidence signature、Duplicate operationKey/taskRunId/result digest、BankBU operationKey/sideRunId/pre-image分别保持原 owner。 |
| 金额与币种 | 本PR不读写业务金额/币种，不修改normalizer、matching或writer；raw amount/account/row显式禁止进入 evidence。affected unit、integration与smoke提供零回归证据，但不替代真实资金人工复核。 |
| 时间与顺序 | FundRecon R1→M2M、Duplicate Bank→Document及side→mirror、BankBU Pending→Bank/side receipt→Main CAS及月份升序均由exact-base source/test ordered facts绑定到action rollback anchor IDs；同步篡改order IDs或换另一真实blob仍拒绝。 |
| 幂等与重复 | snapshot不触发业务操作；rollback固定保留 receipt/Inspector/Hold authority，partial/unknown禁止自动重跑。跨action evidence不能代偿本action的幂等/恢复结论。 |
| 部分失败与恢复 | FundRecon crash要求用户重导；Duplicate/BankBU只允许exact mirror completion并保留Hold，Publisher只认Main journal；本PR不运行或模拟恢复。 |
| 行数与输出去向 | evidence仅含bounded aggregate test metrics，不落业务行；Worker staging/Main Publisher等现有owner只被描述、不被调用。BankBU included/skipped、dual source与输出order保持冻结。 |
| 人工红线 | FundRecon first-match/no-op/回填标黄，Duplicate BizId/MPT/document candidate lineage，BankBU 1:1/1:N/N:1/N:M、BU normalize、side/main identity及所有partial/unknown recovery仍需逐项真实样本人工复核。自动测试、smoke和parser benchmark均不得解除。 |

## Important Variables Review

- 本PR没有修改 `src/**/*.js`、schema、policy、runtime、Main state、receipt、Inspector、matching、Publisher或版本号，因此没有新的 important-variable value mutation；按任务明令禁止，未运行 `check-vars`/`scan:vars`。
- ⚠️ 关联功能 review：evidence描述但不修改 FundRecon Service state、Duplicate per-month side DB/receipt/Main mirror、BankBU per-month side DB/sideRunId/mirror和 background runtime ownership。动态 full-policy/聚合校验、250项affected unit、105项integration与smoke已覆盖相邻自动回归。
- 🔴 人工 gate：资金语义、真实业务样本、Windows packaged/native SQLite、真实进程终止和partial/unknown Recovery必须由 release/资金负责人逐 action复核；当前没有任何 action 获得 production enable授权。

## Remaining Unknowns

| 未知 | 状态/处理 | 影响 |
| --- | --- | --- |
| FundRecon Windows packaged/native SQLite、真实进程shutdown、真实大样本RSS、source mutation与Main Publisher/marker settlement live闭环 | `NOT_RUN` / 后续Windows与人工gate | 阻断 FundRecon三个action enable。 |
| FundRecon first-match、同值no-op、退款/调拨回填与标黄真实样本 | `PENDING_HUMAN_REVIEW` | 资金红线；三个action不得互相代偿。 |
| Duplicate native Governor生产预算目前只批准1 Parser、Windows file lock/shutdown/RSS连续十轮 | `NOT_RUN`；本地40.18%仅capability | 阻断 `duplicate:import` paired/live enable；不影响run/export各自仍关闭。 |
| Duplicate Hold resolution、approved recovery live UX、receipt/result retention/安全expiration及真实BizId/MPT/document lineage | `PENDING_HUMAN_REVIEW` / control owner后续合同 | 阻断Duplicate三个action enable，partial/unknown不得自动补偿或重跑。 |
| BankBU四项公共 runtime registration与live Main/FilePlan/Publisher wiring缺席 | `ABSENT_FAIL_CLOSED` / `NOT_RUN` | direct module policy不能代替真实runtime owner；四项全部阻断。 |
| BankBU Windows packaged/native SQLite、真实月度样本、1:N/N:1/N:M、BU normalize与side/Main partial/unknown恢复 | `NOT_RUN` / `PENDING_HUMAN_REVIEW` | 资金与恢复红线；本地35.33% dual parser capability不得解除。 |
| 正式产品版本 bump 与release文档三件套 | 本 evidence PR 不决策 | 若后续release owner决定版本迭代，必须另行同步且重新验证，不影响当前production-false snapshot。 |

## Review Remediation — CRLF-safe Validator Mutation

- Windows checkout 会把 validator source 转为 CRLF，而同步 retag mutation 的冻结 needle 使用 LF，导致测试在执行 mutation 语义前以“target count 0”失败。
- 测试加载 validator 后先统一为 LF，再执行 exact-once mutation；validator、snapshot、action identity 与 production gate 本身均未改变。
- 本修复只消除测试载体的行尾差异，不把 Windows、资金或恢复门禁升级为 PASS；按用户明确约束未执行 `check-vars` 或 `scan:vars`。
- 新 exact base 上 validator PASS，release-evidence 专属 unit `27/27 PASS`；affected ESLint、`node --check`、JSON parse、`git diff --check` 均 PASS。

## Review Remediation — E07-C Terminal/Cancel Race Rebase

- Windows CI run `33269148876` 暴露 E07-C shutdown 中 Worker 已发布 `job:error`、Supervisor 尚未观测 terminal 而发送 shutdown-only `job:cancel` 的双向消息竞态；旧 Worker 会把精确同 job 的迟到 cancel 当作非法命令并报告 `SERVICE_CLOSE_FAILED`。
- E07-C head `2df35fd5ebf51797537de37a58b2563ae64341df` 已把最近一次 terminal 的精确 action/operation/job/unit route 作为 bounded tombstone；同 route 迟到 cancel 幂等返回且不追加 `cancel:ack`，错误 route 仍 fail closed。该修复经 E08-A head `a8e7cbdf41487ba0eca3f60e467f5413e4e8fa14` 传播到本 evidence 的 exact base `5c9495dda46c775babdac9eb1700c459735e5c8b`。
- snapshot、validator 与 preflight 已重绑新 exact base；`E07-C-DUPLICATE-IMPORT` 的 reviewed head/blob/SHA 同步为修复后的 tracked object。validator PASS，production enabled 仍为 0，Windows 仍为 `NOT_RUN`，资金/恢复仍为 `PENDING_HUMAN_REVIEW`。
- 新 exact base 上 release-evidence 专属 unit `27/27 PASS`、Duplicate affected `119/119 PASS`；原两条失败 shutdown 用例在修复 head 连续 3 轮均 `2/2 PASS`，E07-C 全套 `20/20 PASS`。未执行 `release-check`、`check-vars` 或 `scan:vars`。
