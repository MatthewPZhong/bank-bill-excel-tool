# R3.2.1 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.1 Spec §8-§11、TechDoc §13-§15 与 implementation sequence 的最终 `R3.2.1` action 独立 enable/rollback。
- Exact base：`4598b9c67787ef1736831a186a199bd6fe9ae626`（E05-C reviewed head）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：7-action snapshot 与 production authority、benchmark/gate evidence 一致；5 个 native action 保持 disabled/legacy/0；2 个 inherited existing-dispatch action 原状态不变；人工与 Windows 门禁不被自动测试升级。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用 tracked JSON snapshot + 只读 validator + unit tamper cases，不改业务 runtime。 | release evidence 需要防漂移，但无需新生产抽象；当前业务 capability 已在 E04/E05 完成。 | 在 `src/` 新增 release registry；把 decision 写回 production policy。 | 产品金额、币种、receipt、sequence、Publisher 与 recovery 行为零变化。 |
| inherited two 以 canonical full-policy fixture 为 authority；native five 以 runtime policy exports 为 authority。 | runtime.js 只聚合本版本 native action，不能代表 inherited existing-dispatch production snapshot。 | 将 inherited action 因 runtime 缺席误记为 disabled；复制一份不可校验的 policy。 | validator 分别锁定 `true/thread-single/1` 与 `false/legacy/0`。 |
| E04-C/E05-C 失败只表达为 release decision、reason和 evidence ref。 | schema 没有 `benchmark-fail`，伪造 `benchmark-pass/release-pass` 会抬高证据。 | 修改 policy schema；把 small fixture 收益当 representative pass。 | policy canonical enum 保持合法，production拒绝原因可审计。 |
| 不 bump `package.json.version`，不更新 release 用户文档三件套。 | R3.2.0 release-evidence precedent 未 bump；本 PR 无用户可见功能或版本发布。 | 猜测 bump 到 3.2.1；只改三件套中的一份。 | 保持当前 `3.1.14`；若后续负责人决定版本迭代，三件套必须一起更新。 |
| 每个 action 单列 `realProcessTermination` gate。 | blindspot pass 发现首版仅在部分 reason code 提及真实终止，没有形成逐 action machine-check 字段。 | 用 Windows packaged 或 deterministic fault injection 代替真实进程终止证据。 | 7 action 均固定 `NOT_RUN`，不得由自动测试升级。 |
| 保留 local `release-check` attempt #1失败；仅为开 final PR 授权automatic required CI attempt #2。 | Lead在reviewed HEAD `c9e89db7`的attempt #1中lint/smoke通过，unit `6166/6171`且2 fail，`&&`使integration未执行；release owner随后批准PR-opening-only waiver。 | 本地、人工或`workflow_dispatch`重跑；把waiver扩展到任意head/base/merge或生产启用。 | workflow锁定same-repo `pull_request/opened`、final head branch、E05-C target base、PR head SHA、`run_attempt == 1`和`PENDING_REMOTE_REQUIRED_CI`；CI PASS前hard gate不闭合。 |
| Windows unit 的 spool/Route DB 行为测试显式注入 supported directory barrier，同时保留默认生产实现的真实平台 fail-closed 回归。 | PR #182 attempt #2 在 Windows 上按生产合同拒绝目录 `fsync` unsupported；schema、顺序、receipt、Pool、Route DB 与生命周期用例不应由宿主目录屏障能力决定。 | 放宽生产 barrier；在 Windows 跳过行为测试；把 unsupported 当作 durability success。 | 只新增 `tests/unit/shared` helper/preload并改测试调用点；`src/`、金额、币种、sequence、receipt、Hold和production gate零改动。 |
| 依赖真实 Worker 的行为测试固定可复现的测试资源预算；专门的资源降级测试继续显式覆盖边界。 | 当前host可用内存贴近E00 2 GiB reserve时，真实行为测试会在5秒准入期内被拒绝，形成与业务无关的随机失败。 | 放宽生产5秒准入或内存reserve；按当前host结果降低断言。 | 仅在测试runtime wrapper和单个host探针断言中固定资源；显式budget、downgrade与production topology实现不变。 |
| #182 follow-up 不重跑全量 `release-check`；最终全量门禁只属于 v3.2.1 最后一张 PR #183。 | release owner 最新约束：`release-check` 仅在 3.2.1 最后一张 PR 提远端时对整个版本执行一次。 | 手工 rerun、`workflow_dispatch`、在 #182 synchronize 上再次执行。 | #182 仅运行定向验证与正常非全量 CI；final hard gate仍由 #183 的独立远端结果决定。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| snapshot 是本地 release review artifact，不是运行时动态配置。 | 所有 enablement authority 已存在于 policy/fixture；需求禁止本 PR 启用 production。 | 若被误用作运行时开关，会形成双 authority。 | validator 与文档明确只读；不从 `src/main.js` 或 runtime require snapshot。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 冻结 snapshot 时尚未发生 remote attempt #2。 | snapshot 保持 opening 前的历史 `PENDING_REMOTE_REQUIRED_CI`，在本 notes 追加真实运行结果与 follow-up 修复，不伪造 PASS。 | remote attempt #2 已实际运行并被 GitHub 6 小时上限取消；snapshot 作为冻结前状态不可反向改写。 | hard gate仍 open；最终结果由 #183 独立 CI 给出。 | 不改变 Spec/TechDoc业务合同；同步 preflight 的执行约束与未知。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 冻结合同、R3.2.0、E04/E05 notes 与 current policy/runtime preflight | PASS | authority 分层、版本策略、benchmark与人工门禁边界。 |
| `node scripts/validate-v3-2-1-release-evidence.js` | PASS：7 action、native production enabled 0、inherited state changes 0、remote CI pending/hard gate open | current policy/live mode/worker、action独立 decision/rollback/evidence/gates、source SHA-256，以及真实Windows workflow的release-check条件和两个job checkout head binding。 |
| release-evidence专属 unit | `11/11 PASS` | local attempt #1失败/未运行integration与remote attempt #2 pending/scope不可篡改；native误启、inherited误关、E04-C授权、E05-C small代偿、人工gate误升级、跨action evidence/rollback借用与source hash drift均拒绝。 |
| canonical policy registry unit | `20/20 PASS` | canonical schema/enum、production/effective mode、static reference与freeze authority。 |
| E05-P0 receipt + mixed lifecycle unit | `11/11 PASS` | per-file mixed结果继续、strict/repair shape、receipt三outcome/唯一键与含receipt删除语义。 |
| E05-C专属 unit | `15/15 PASS` | requested 4/native actual 1、repair 1、permit、disk/symlink、cancel/spawn/invalid topology、Pool/Writer/cleanup。 |
| affected static checks | PASS | validator与release-evidence `11/11`、Windows contract `5 pass/0 fail/2 skip`；6个行为测试及2个test helper通过ESLint与`node --check`；`git diff --check`通过。 |
| 既有重量级组合环境 probe | `57/64 PASS`；7 fail 均为当前 host resource gate | 当时 `os.freemem()` 约 0.8–1.0 GiB，低于 E00 2 GiB system reserve：mature topology保守降1；E04 real Worker固定5秒 admission timeout。串行复跑仍同因失败；未改相关 `src/`，不把环境拒绝重标为产品 PASS。更广 E05-A/B probe 出现同类 admission timeout 后停止，不作通过声明。 |
| Lead local `npm run release-check` attempt #1（reviewed HEAD `c9e89db7`） | `EXIT 1`：lint PASS；smoke PASS；unit `6166/6171 PASS`、2 fail、3 skip；integration因`&&`未执行 | 失败事实和phase边界进入machine snapshot；manual/`workflow_dispatch` rerun禁止，attempt #1绝不改写为PASS。 |
| renderer PreFund失败root cause与修复 | 过时静态regex；生产顺序正确。更新测试锁定handler内operation lock → `assertDeleteDateRange(service,payload)` → `deleteTempByDateRange(normalizedRange)`；定向 `8/8 PASS` | 不改`src/main.js`、Hold gate、资金删除口径或normalized range。 |
| Windows contract失败root cause与修复 | 首次run的worktree依赖解析到`electron-builder/app-builder-lib 26.8.1`；按lock重建后installed/locked `electron-builder=26.15.7`、`app-builder-lib=26.15.7`，并用`npm rebuild electron`补全Electron postinstall，未改package/lock；Windows contract `EXIT 0`、5 pass/0 fail/2 skip | 环境漂移已解决，中间失败属于隔离依赖安装状态而非产品缺陷；这是post-failure定向验证，不改变local attempt #1 `FAIL`。 |
| post-failure独立unit component（reviewed HEAD `634671b`） | `npm run test:unit` `EXIT 0`：6172 tests、6169 pass、0 fail、3 skip、377 unit files、25275ms；log `logs/unit-tests/unit-20260826-122322.log` | correct-lock依赖与Electron postinstall完成后的全unit组件验证；不是release-check attempt，不把local attempt #1改写为PASS。 |
| post-failure独立integration component | `npm run test:integration` `EXIT 0`：51/51 scripts、2455/2455 assertions、278953ms | local attempt #1因unit失败未进入integration；本次独立component PASS不构成release-check attempt或PASS。runner合法同步`rules/integration-test-policy.md`时间与耗时清单，随最终commit保留。 |
| automatic required CI attempt #2授权 | `PENDING_REMOTE_REQUIRED_CI`；same-repo final PR `opened`、base `codex/v3.2.1-e05-c-prefund-parser-pool`、`github.event.pull_request.head.sha`、`github.run_attempt == 1` | `.github/workflows/build-windows.yml`已将错误base及final branch synchronize/rerun/`workflow_dispatch`排除；其他既有branch/event语义保持。CI PASS前hard gate保持open。 |
| PR #182 automatic attempt #2（Actions run `32932672610`，reviewed HEAD `7e739036609d16f7fce78eaba0f92029d67d0311`） | `CANCELLED` at 6h；Windows unit 中 E05 spool Writer 正确抛 `PREFUND_SPOOL_DURABILITY_UNAVAILABLE`，之后 Node test process 未退出直到平台上限 | 该结果不能标记为 PASS，也不授权 production；根因是宿主目录屏障能力泄漏到独立行为测试，且失败后存在进程收口风险。 |
| #182 Windows test isolation 定向验证 | E05-A `42/42 PASS`（含默认真实平台 supported/unsupported分支）；E05-B `38/38 PASS`；E05-C `15/15 PASS`；Toolbox Route DB `8/8 PASS`；Toolbox generation `10/10 PASS`；mature adapters `11/11 PASS`；全部正常退出 | test seam覆盖直接 Writer、真实 Parser/Scanner/Writer Worker与资源准入；默认生产 barrier仍单独验证 fail closed；未运行 `release-check`。 |
| #182 follow-up全量unit组件 | `npm run test:unit` `EXIT 0`：6174 tests、6171 pass、0 fail、3 skip、377 unit files、24989ms；log `logs/unit-tests/unit-20260826-230615.log` | 证明跨文件并发下无准入假失败且Node测试进程正常退出；这是独立unit组件，不是`release-check`，不替代最终PR #183远端全量证据。 |

## Blindspot Pass

### [Important] policy authority 分层可能误关 inherited action

- 事实：native runtime只聚合5个v3.2.1 action；canonical full-policy fixture另含 inherited `toolbox:split-large` / `toolbox:publish` 的 `true/thread-single/1`。
- 影响：若把 runtime 缺席解释成 disabled，会静默改写 inherited production state。
- 处置：已覆盖。snapshot显式记录 `policyAuthority`，validator按两种authority分别反查并有误关tamper test。

### [Important] benchmark局部收益与schema枚举可能造成证据抬高

- 事实：E04-C对one Writer改善21.096%但对live legacy仅8.581%，资源/Windows combined gate失败；E05-C representative仅0.57%，small为33.04%；policy schema无`benchmark-fail`。
- 影响：跨基线或跨fixture代偿会误启production，伪造pass enum会污染后续release判断。
- 处置：已覆盖。decision/reasons与policy字段分离；validator锁定原始指标、结论、source hash及small不可代偿。

### [Important] 未执行平台/人工门禁必须保持可见

- 事实：Windows packaged、Excel/WPS、真实进程终止与真实业务/恢复人工复核没有当前证据。
- 影响：自动测试若把任一项升级为PASS，会越过durability、格式或恢复边界。
- 处置：BLOCK production enable。每action gate独立记录，tamper test禁止升级。

### [Important] PR-opening CI waiver不得扩大

- 事实：local attempt #1失败；remote required CI attempt #2尚未运行。
- 影响：若pending被伪造为PASS、改到其他head branch/target base/commit或增加invocation，会绕过最终hard gate。
- 处置：workflow、Windows contract test、validator与tamper test共同锁定same-repo final PR `opened`、E05-C target base、PR head SHA、首次automatic run和所有非授权动作false；CI PASS前不允许merge或production enable。

### [Important] 测试 barrier 不得逃逸到生产或掩盖真实平台失败

- 事实：supported barrier 只从 `tests/unit/shared` 注入，生产 `spool-writer`、Route DB sealer 与 `durable-file` 未修改；另有默认实现真实平台回归。
- 影响：若 test preload 被生产入口加载，或所有测试都绕过默认 barrier，会把未落盘证据误当作 durable ready。
- 处置：helper只由三份 E05 unit与一份Route DB unit require；显式 Worker wrapper才设置 preload；真实平台用例直接调用 raw Writer/sealer，Windows unsupported 必须清理并抛原错误。

未发现会改变实现方案的其他存活盲区。已被证据反证的候选问题：snapshot不会被runtime读取；没有第二Writer源码/入口；没有版本bump规范要求；本diff没有Publisher、receipt或Recovery Hold旁路。

## Reconciliation Blindspot Pass

### [Critical] PreFund amount/currency/sequence/receipt与恢复边界

- 场景：release rollback若删除receipt、绕过Hold或自动重跑unknown，可能重复/漏记或覆盖错误batch/dataset。
- 事实与证据：本diff不改任何业务`src/`、migration或Side DB；snapshot rollback固定保留committed receipt与Recovery Hold、禁止down migration和unknown auto-rerun；E05-P0 `11/11` 与E05-C `15/15`通过。
- 推断/未知：自动fixture不能替代真实脱敏insert/noop/replacement/mixed-result与历史v0 receipt人工核对。
- 资损或审计影响：错误恢复可能重复mutation或破坏batch/dataset lineage。
- 处置：⚠️ 资金红线，请人工复核；`funds/recovery=PENDING_HUMAN_REVIEW`，阻断native production enable。

### [Important] Toolbox row-set/格式与all-or-none publication

- 场景：generation evidence不能替代真实Excel/WPS业务文件与journal recovery人工检查。
- 事实与证据：本diff不改generation/validation/Publisher；E04-C仍拒绝第二Writer，rollback固定沿用既有FIFO Publisher/durable journal。
- 推断/未知：当前host低内存使real Worker定向probe被admission拒绝；Windows packaged和人工workbook证据仍未执行。
- 资损或审计影响：若误判通过，可能发布格式错误、缺输出或不完整正式目标。
- 处置：BLOCK production enable；`windows/Excel-WPS/realProcessTermination/businessFile/recovery`保持open。

必须使用真实数据或人工确认的口径：Toolbox代表性业务workbook行集/格式/warning/all-or-none；PreFund真实脱敏source identity、sequence replacement、batch.id、dataset version、金额币种、repair token、candidate order及crash recovery。自动测试没有宣称这些门禁通过。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Packaged Windows、Excel/WPS、真实进程终止证据 | BLOCK production enable / `NOT_RUN` | Release owner 在真实 packaged Windows 与 Office 环境执行 | 不阻断 evidence artifact；阻断相关 native production enable。 |
| 真实业务文件与资金/恢复人工复核 | BLOCK production enable / `PENDING_HUMAN_REVIEW` | Toolbox/PreFund 业务与恢复 owner | ⚠️ 资金与恢复红线，请人工复核。 |
| 当前host资源波动曾使重量级real Worker测试被admission拒绝 | CLOSED FOR TEST DETERMINISM / production gate unchanged | 行为测试固定测试预算；专门的resource/downgrade测试继续覆盖真实边界 | 定向矩阵与全量unit均已通过；生产reserve、降级与5秒准入未放宽。 |
| #182 automatic attempt #2 已取消；v3.2.1 最终全量 CI 证据尚未闭合 | OPEN HARD GATE / final PR required CI | #182 只推送本测试隔离修复且不得运行全量 `release-check`；由最后一张 PR #183 在精确head/base上提供一次独立远端结果 | #182 的取消不能代替 #183，也不能被定向 PASS 改写；#183 PASS 前不授权 main/tag/production enable。 |

## PR #183 Repair Final Gate 授权记录（2026-08-27）

- 原 automatic attempt #3：Actions run `32953558996`，reviewed head `962e4ae1549035d4eb875dbfb19417c19d1f95f6`，smoke-test `CANCELLED`、build `SKIPPED`；该结果不满足 hard gate。
- release owner 新授权：仅允许 PR #183 从该旧 head 演进的一次 `pull_request/synchronize` automatic attempt #4；禁止手工 rerun、`workflow_dispatch`、reopened、第二次 push、admin 绕过或把旧 #182 CI 当成 final 证据。
- machine tuple：PR number `183`、same repository、head `codex/v3.2.1-r4-review-hardening`、base `codex/v3.2.1-r3-release-evidence`、action `synchronize`、`github.run_attempt == 1`、`pull_request.commits == 4`；两个 job 继续 checkout `github.event.pull_request.head.sha`。
- checkout 后 lineage：HEAD 必须等于 event head SHA；`962e4ae1` 必须是 ancestor；`962e4ae1..HEAD` 必须恰好 2 commits。任一条件漂移都会在 `npm ci` 与 `release-check` 前失败。
- 本地只运行定向测试、静态合同和 full unit component；没有运行本地 `release-check`、`check-vars` 或 `scan:vars`。hard gate、main/tag/production enablement 与资金/恢复人工红线均未闭合。
