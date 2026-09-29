# G8 架构边界检查实施记录

本文件是本功能唯一切片索引。设计合同：[Spec](spec.md)、[TechDoc](techdoc.md)；切片完成标准见[总索引 §6.2–§6.4](../../README.md#slice-completion)。设计审查通过不代表以下实现已验证。

## 最新状态：2026-09-21—22 release 第二轮审查修复

RR2-01～05 已补齐静态数组回调、bound factory 参数顺序、对象别名写入、初始数据递归合同和当前 G1 内部恢复入口。新增 34 项回归；全部架构 204/204 PASS，真实配置 31 active、0 诊断/失效例外。完整 release-check 在本轮冻结的 1699 个输入上 PASS：8978 单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过。输入及 HEAD 未漂移，792 个生产目录文件保持上一轮修复状态。变更、原样探针和验收限制见[第二轮修复报告](../../reviews/2026-09-21-release-r2-repair/repair.md)。未提交，未进行本轮修复后的独立复审。

## 历史状态：2026-09-21 release 第一轮组合审查修复

G8 已本地合入 release。基于 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 的未提交修复对齐全部 31 个机器子边界：31 active、0 pending/partial、0 诊断、0 stale；114 条原历史例外收缩为 2 条固定扩展 worker SCC。G1/G6 的动态加载登记通过准确 commit/blob 迁移，目标集不增加，历史保护机制未放宽。

新增实际调用能力追踪、按目标与具名导出匹配的 G7 装配，以及真实 Renderer scoped API/面板/服务登记。独立复核发现的 callback 传播、参数 authority 和对象 mutation 漏报已关闭，最后冻结后原样复验 12 条实际 SQL 路径、5 条 Renderer 越权均拒绝，合法对照通过。

架构专项 **170/170 PASS**，最终完整 release-check **exit 0**：8944 单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过，有计数合计 2901/2901。1698 个代码／配置／测试输入和 HEAD 保持，修复尚未提交。现行支持边界见 [architecture README](../../../../architecture/README.md)，完整五项实施证据、配置迁移及组合验证见[release 修复记录](../../reviews/2026-09-21-release-repair/repair.md)和[独立复核](../../reviews/2026-09-21-release-repair/independent-review/review.md)。真实产品 Main、GUI 资金人工复核与平台验收仍分开保留。

以下为功能分支实施及第一至第五轮的历史记录，保留各自时点的源码、未集成状态和验证范围。

## 历史状态：2026-09-21 第五轮审查修复

第五轮独立审查关闭 R4-01 原始本地函数反例，同时确认 R5-01 的两个绑定身份缺口：导入成员经服务返回、本地工厂初始化的 operation。本轮统一配置与调用绑定解析，分离最终调用目标和工厂依赖闭包，新增 12 组回归；最终架构套件 **143/143**、固定基线 CLI 及原审查 9 场景的新旧工具对照均通过。**修复后的独立复审未执行，不能将 G8 全部验收标为通过**。详细差异与证据见[第五轮修复自检](reviews/2026-09-21-r5-repair/repair-review.md)。A～H 保留各轮历史结果，旧完整 release-check 不覆盖当前内容。

机器配置、allowedSites、114 条历史例外及激活状态均未修改；G8 未集成，仍 active 2 / pending 21 / partial 8。原 D 的 release@9602a1fa 只保留历史意义；本轮不合并或借用浮动 release 的激活证据，后续在明确授权的固定集成候选上完成规则对齐和领域激活。

## 工作区与输入

- 分支：`codex/v3.2.10-architecture-guardrails`。
- 独立 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`。
- 起始及当前 HEAD、本地 `main`、`v3.2.9^{commit}`：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。初始记录中的 release 同提交结论已过时；2026-09-21 刷新 release 为 `9602a1fa482203e11bfde8cd6a73b8f552243d95`，详见下方 D。
- 主工作区未提交的 `changes/v3.2.10/` 与 `changes/architecture-coupling/2026-09-20/` 复制进本 worktree 作为设计和固定扫描引用；未修改主工作区原件。其他治理项文档只作规则来源，不将其设计状态改为已实施。
- 本轮实现、测试及证据均基于上述 HEAD + 未提交差异；没有提交、推送、合并、PR、升版或发布。

## 决策与范围

- 按原 A/B/C 阶段先完成扫描、完整规则配置、历史防倒退和门禁。2026-09-21 复用已有未提交实现，保留接手前备份和 SHA-256 清单；D 刷新经 release 集成的固定代码状态并做只读预检。本分支的源码仍为 v3.2.9，不消费其他 worktree 的临时改动，不合并或伪激活。
- 扫描器不执行生产模块；业务代码、用户文件和应用数据库无写入。命令默认只读，仅 `--json` 明确输出报告。
- Acorn 使用锁文件已有的 `8.17.0`，提升为直接开发依赖。验证环境复用主工作区已安装的 `node_modules` 只读符号链接，不执行安装脚本。
- 规则 fixture 与实际生产治理验收分开；本轮不替代 G1–G7 的恢复、生命周期、真实模块加载或 GUI 验收。

## 切片 A：基础扫描

- **范围 / 代码状态**：原 A；上述 HEAD + dirty，实现清单与指纹见最终验证证据。
- **实现状态：已实现；验证状态：通过；集成状态：未集成。**
- **职责与边界**：`scripts/check-architecture.js` 为只读 CLI；`scan.js` 负责 Acorn AST、词法遮蔽/静态 alias、文件解析、worker/global/DOM/调用点；`rules.js` 使用 SCC 和闭包诊断。生产业务模块不加载检查器；检查器不执行生产源码、不联网，正常运行不写源码/配置。
- **调用方与兼容**：新增 npm 和 CI 调用，测试直接调用公开扫描/规则接口；没有业务调用方迁移和运行时兼容 shim。现有 eslint、action manifest 与专项门禁继续存在。生产图排除 scripts/tests/fixtures，覆盖 src 下 js/cjs/mjs 和 index.html。
- **业务行为**：G8-AC-01/02/08/10/12/13/14；不改变金额、数据、业务取消/恢复。共同口径仍为 685 文件、2,254 条唯一字面量本地 JS 边、零字面量环；98 条 backend→main-process 不整体判违规。扩展图的 worker/global 与旧图分开记录。
- **验证**：84 个架构测试通过（含 B/C 回归）；固定 `11086a3c` 只读快照逐边重扫与旧审查图相比 added=0、removed=0，见 [baseline-revalidation-20260921.json](evidence/baseline-revalidation-20260921.json)。初次临时导出漏带 package.json 产生两个输入缺失，补齐固定提交的依赖材料后重跑通过；没有为此添加豁免。
- **当前规则入口**：根 `AGENTS.md` → [architecture/README.md](../../../../architecture/README.md)；十二条机器规则仍仅由 `architecture/boundaries.json` 和 `legacy-allowlist.json` 配置。扫描覆盖边界和 AC 对应见下表。
- **剩余 / 回退**：运行时 IPC/callback、任意数据流、SQL 业务含义及真实 UI 生命周期不由 AST 证明；保持对应领域测试。扫描器和配置成套回退，不改业务数据。

## 切片 B：规则、历史与受控恢复

- **范围 / 代码状态**：原 B；同 A 的 HEAD + dirty。
- **实现状态：已实现；验证状态：通过；集成状态：未集成。**
- **职责与边界**：`schema.js` 严格拒绝未知字段/通配配置，登记全部十二条规则和 31 个稳定子边界；`policy-history.js` 从事实基线读取实际 HEAD 与事件对比的全部可达父链，只解析配置/blob，不执行历史脚本。active、retired、必需入口/消费者、保护范围和例外共同形成历史底线。
- **调用方与兼容**：CLI 始终调用同一历史检查；`--against` 只能改变事件对比，不能关掉历史。准确 `policyChanges` 支持有来源版本的 A→B→A；旧例外保留精确原提交、作用域/AST 指纹或边、理由和移除条件。当前 112 条固定基线例外全部有匹配，0 条 stale；包含两个扩展 worker 图的准确历史 SCC，不允许新增字面量环。
- **业务行为**：G8-AC-03～07/09/15～22；纯核心/lineage、IO 型 XLSX、恢复、任务、查询、描述符和 Renderer 的规则分别执行。pending 文件出现即检查，active 缺入口/作用域/消费者/证据失败。修复仅允许历史 JSON 语法损坏的 exact blob，当前配置错误、未知 schema、缺 Git 对象和可解析弱化不能借道。
- **本轮补齐**：新增反例先复现后修复：删除 allowedApiFields 键静默解除方法检查；pending 域中退役成员/证据弱化；active 保护函数更名遗漏；裸 desktopApi 全局读取；受保护查询作用域的 eval/Function。治理归属不再被当作无执行影响的元信息；显式 --root 不能解除当前项目及拥有项目事实基线对象的离线仓库的固定基线约束，新增真实 Git 对象库回归。未更改 G1–G7 业务源码。
- **G8-AC-22 证据**：真实 Git S0→S1 active→S2 JSON 损坏→S3 当前恢复；无登记 exit 2，准确修复 exit 0，之后降级/删入口 exit 1。覆盖错 blob/hash/path、缺 evidence、空快照、可解析配置、未知损坏、双父链冲突、未生效错 hash 前向修正、有效绑定后的坏 manifest、仅 snapshot/evidence 改动和缺对象。新增 CLI 测试实际调用 CI 选基线函数，再以 local/PR/push/tag/manual 参数逐一运行完整检查；stdout 和 JSON 都显示恢复来源。真实项目无损坏历史，因此没有创建 repair 占位清单；fixture 的审查材料不是项目真实重建的人工审查。
- **验证**：[policy-history.test.js](../../../../tests/unit/architecture/policy-history.test.js)、[rules.test.js](../../../../tests/unit/architecture/rules.test.js)、[adversarial.test.js](../../../../tests/unit/architecture/adversarial.test.js)、[cli.test.js](../../../../tests/unit/architecture/cli.test.js) 均已执行。完整架构套件 84/84，证据见最终验证记录。
- **当前规则入口**：`architecture/README.md` 的基线/激活/兼容及历史恢复章节、严格 schema、两个 JSON 配置；没有复制领域业务合同。人读说明同步补充 API 字段删除、退役字段、保护函数存在性及修复诊断。
- **剩余 / 回退**：历史语法修复是否保持原意仍由实际变更的 review 核对；机器不自动批准。G1–G7 的生产行为验收见各分支，当前 G8 分支只激活 production-graph/platform-core，其余 29 个边界配置保持 pending（扫描显示 21 pending / 8 partial）。

## 切片 C：npm、CLI 与现有 CI 门禁

- **范围 / 代码状态**：原 C；同 A 的 HEAD + dirty。
- **实现状态：已实现；验证状态：通过；集成状态：未集成。**
- **职责与边界**：新增直接开发依赖 `acorn@8.17.0`，不引入运行时依赖。`release-check` 为 lint → check:architecture → smoke → unit → integration；任何非零退出保留。JSON 仅写显式绝对路径，写报告失败 exit 2。
- **调用方与兼容**：两个 Windows workflow 的既有 release-check 继承检查；新增 `ci-policy-base.js` 验证实际 checkout SHA，PR 用 base.sha，main push 用 before，tag/manual 用 HEAD；fetch-depth:0、tag/main 守卫与原专项条件保持。没有提交/推送/PR/发布。
- **业务行为**：G8-AC-11/13/20/22；扫描成功 0、边界违规 1、输入/语法/历史/报告失败 2，所有事件共用历史机制；无关闭历史/自动接受全部例外的开关。
- **验证**：84/84 架构测试、真实 Git CLI/事件参数、只读/不执行业务/确定性/错误报告路径测试已通过；完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` exit 0，见本记录末尾最终结果。
- **当前规则入口**：`architecture/README.md` 命令章节、`package.json`、两个 workflow 与 `rules/integration-test-policy.md` §六同步；根 AGENTS 添加导航，不复制规则正文。
- **剩余 / 回退**：macOS 本地执行不等于 GitHub Windows 实机执行；本任务无 GUI 变更，未执行 Electron GUI、Windows 安装包、Excel/WPS 人工验收。门禁回退须连同配置与脚本一起审查，不能吞退出码。

## 切片 D：固定 release 状态与待激活交接

- **实现状态：待激活登记已刷新，实际激活未实施；验证状态：只读预检已执行，激活验证未通过；集成状态：G8 未集成。**
- 2026-09-21 固定 `release/v3.2.10@9602a1fa482203e11bfde8cd6a73b8f552243d95`，逐分支核验已纳入的 G1–G7 提交和实际文件；仅扫描该 Git 对象导出的代码，不使用 release worktree 的未提交内容。
- 准确登记见 [release-activation-register-9602a1fa.json](evidence/release-activation-register-9602a1fa.json)，包含分支 SHA/祖先关系、每个计划入口是否存在、缺失的测试证据路径、按规则分类的预检诊断和待删例外。它是交接证据，不是 scanner 配置或生产激活证明。
- 本分支按用户要求仍以 v3.2.9 为源码基线；未将 release 反向合入，未在缺少生产实现的功能分支把边界伪记 active。release 上的实际路径、scoped API、合法命令/装配、证据路径与早期计划存在差异，原配置不能直接用于 release 激活。预检诊断混有配置未对齐和待进一步归因的依赖，不能按数量宣称已确认相同数量的业务缺陷。
- **后续实际集成变更负责**：在固定候选更新各边界的实际入口/消费者/作用域/授权位置及测试证据；清理已消失的精确例外；确认真正公共机制的闭包与合法领域装配；新增对应规则反例并完成各领域行为测试，再标 active。尚未满足条件的子边界继续 pending/partial，并保留阻断证据。G8 完整门禁通过不能替代此步。
- **职责 / 调用方 / 业务 / 当前规则**：不移动本次业务代码，调用方仍是各治理项自己的实现；人读模块说明归各域维护，机器激活及例外由后续集成变更维护；沿用 Spec §8 成套回退边界。

## AC 与实际证据映射

| AC | 本轮实际证据 |
|---|---|
| 01 | 固定 Git 快照与历史字面量图逐边比对，baseline-revalidation-20260921.json |
| 02、03、04、07、09、15～19 | rules.test.js + adversarial.test.js 的闭包、循环、例外、pending/active、恢复/任务/查询/描述符正反例 |
| 05、06、10 | scan.test.js + rules.test.js + adversarial.test.js 的 scoped API、局部状态、modalRoot、经典脚本装配与顺序 |
| 08、12、13、14 | scan.test.js 的 loader/worker/遮蔽/大小写/语法/AST 指纹/只读；cli.test.js 的覆盖报告和不执行业务副作用 |
| 11 | package scripts / CI 参数测试 + 本分支完整 release-check（最终结果见下） |
| 20、21 | policy-history.test.js 的真实 Git 多父链、事件底线、迁移、保护字段、恢复及缺历史负例 |
| 22 | policy-history.test.js 的精确语法恢复序列 + cli.test.js 的 local/PR/push/tag/manual 端到端 |

G8 规则 fixture 证明检查器行为；对应治理业务的真实生命周期、授权、资源退出和 GUI 仍由各域测试证明。

## 最终验证与差异证据

执行平台：macOS arm64，Node v25.8.0；所有项目命令显式以本 G8 worktree 为 cwd。首轮完整门禁 exit 0（8182 通过、4 跳过、0 失败；60 个集成脚本 2579/2579），但其架构阶段早于最后覆盖修复，不能作为最终冻结证据。第二轮因新增 --root 回归修复而主动停止（exit 143），不是测试失败。冻结后的完整门禁已通过（exit 0），未将前两轮日志拼接为本轮 PASS。


最终证据：[验证摘要](evidence/verification-20260921.json)、[完整 release-check 日志](evidence/release-check-final-20260921.log)、[84 个架构测试日志](evidence/architecture-tests-20260921.log)、[架构扫描 JSON](evidence/architecture-check-20260921.json)、[冻结代码指纹](evidence/frozen-code-manifest-20260921.json)、[代码差异](evidence/code-diff.patch)。

- `UNIT_TEST_CONCURRENCY=2 npm run release-check`：exit 0；lint、架构检查、smoke 通过；unit **8184 通过 / 0 失败 / 4 跳过**（共 8188）；integration **60 个脚本全部通过，2579/2579**。4 个既有条件跳过项不能算作平台验收。
- `node --test tests/unit/architecture/*.test.js`：**84/84**，0 skipped；G8-AC-22 包含真实 Git 修复历史及五类事件 CLI 验证。
- 12 个新增检查器/测试文件补充执行 ESLint `no-undef`；无错误。`git diff --check` 通过。
- 冻结的 19 个实现/配置/测试/CI 文件在完整门禁前后哈希无漂移。完整差异另包含 AGENTS 和现有规则导航/门禁说明；runner 自动刷新的历史耗时表已恢复原内容，本轮数据保存在最终日志。
- 主工作区原有 130 个未提交文件哈希全部保持；本 worktree 的 `src/` 无差异。接手前已有未提交内容保留备份，保护记录见 [workspace-preservation-20260921.json](evidence/workspace-preservation-20260921.json)。
- 实现、验证、集成分别记录：**A/B/C 已实现并通过本轮必要验证；G8 未集成；D 的真实激活未完成**。未提交、未推送、未合并、未开 PR、未升版或发布。


## 切片 E：R1–R10 检查器修复与复核（2026-09-21）

- **范围 / 代码状态**：复用上述分支和 worktree，HEAD 仍为 11086a3c，基于已审查的 HEAD + 未提交实现；修复前工具归档位于 `/private/tmp/g8-r1-r10-before/tooling.tar.gz`。本轮精确差异与冻结指纹见[repair-diff.patch](reviews/2026-09-21-repair/evidence/repair-diff.patch)、[verified-manifest.json](reviews/2026-09-21-repair/evidence/verified-manifest.json)。
- **实现状态：已实现；验证状态：本轮必要专项通过、独立复审未执行；集成状态：未集成。**
- **职责与边界**：scan 修正 StaticBlock、Worker 路径、方法语法身份和 template 脚本上下文；rules 修正 operation 候选、任务别名来源、DB/API 不透明值、嵌套字段与脚本执行模式；新增 contracts 供 rules/history 共用词法范围与 factory 检查。history 核验工厂真实迁移并接受父函数扩大保护。未写生产 src、主工作区设计原件或业务数据库。
- **调用方与兼容**：CLI/npm/CI 入口、退出码和配置 schema 保持；新 contracts 仅被检查器内部调用。Worker 相对路径以仓库根运行 cwd 为合同，显式 __dirname/URL 仍按模块目录。需要其他 cwd 的调用应提供静态绝对路径或准确动态目标。scoped API 继续要求显式方法对象，无法解释的函数返回值不能代替该合同；async/module provider 无法保证先行时失败。没有业务入口或兼容 shim 迁移。
- **业务行为**：R1→AC03/08，R2/R10→AC21，R3→AC16，R4→AC17，R5→AC18，R6/R9→AC05，R7→AC10，R8→AC08。只改变检查器是否正确接受/拒绝源码；没有生产恢复、资金或 DB 事故结论。AC22 的真实 Git 修复历史测试随原全部架构套件重跑通过。
- **验证证据**：新增最小回归首次 11/11 失败，覆盖原十项；修复并补合法职责/不可搬迁对照后 16/16 通过；最终 `node --test tests/unit/architecture/*.test.js` 100/100，0 fail/skip；`node scripts/check-architecture.js --json <绝对路径>` exit 0，685/685、2254 字面量本地边、64 worker、5 global、0 违规、114 条例外命中、0 stale；14 个工具/测试文件 no-undef 通过，git diff --check 通过。原始日志均保留在本轮 evidence。真实 Node Worker 从 fixture 根运行、VM/stub 对照以及真实 Git CLI 均属于合成测试，不是产品 GUI 验收。
- **当前规则入口**：根 AGENTS → `architecture/README.md`，新增“当前支持与失败关闭的边界”、工厂迁移/父函数收紧说明及回归链接；机器正文保持在两个 JSON。新增 5 个准确合法调用 allowedSites，另补 2 个固定 v3.2.9 动态 operation 覆盖债务，分别附职责/移除条件；[逐项核对](reviews/2026-09-21-repair/evidence/reviewed-registrations.json)包含 AST 指纹，原源码与固定提交逐字节一致。没有目录级豁免或自动接受新位置；对照证明旧例外不能搬迁，active 时不生效。
- **剩余 / 回退**：待独立复审；G1–G7 未落地到本分支，继续保持配置 pending 29（报告 21 pending / 8 partial），只有两个 G8 基础边界 active。正式集成或 PR-ready 前在最终合并候选重新跑 release-check，并以固定 release 状态完成各域规则对齐与激活。本轮遵守风险验证，仅改检查器/配置，未重复全量业务套件；旧 8184 pass 的 release-check 不作为新源码的全量 PASS。未跑 Electron GUI、Windows workflow/安装包、Excel/WPS。无提交、推送、合并、PR、升版或发布。回退只还原本轮检查器/配置差异，保留接手前实现和证据。


## 切片 F：R2-01～09 检查器修复与兼容复核（2026-09-21）

- **范围 / 代码状态**：沿用原 G8 worktree 与分支，HEAD 为 11086a3c，基于第二轮审查的未提交实现继续修改。修复前工具归档为 `/private/tmp/g8-r2-fixes-before/tooling.tar.gz`。本轮只改 scan、rules、contracts，新增 review-round2.test.js，并更新现行规则说明与本记录；精确差异和最终指纹见[repair-diff.patch](reviews/2026-09-21-r2-repair/evidence/repair-diff.patch)、[verified-manifest.json](reviews/2026-09-21-r2-repair/evidence/verified-manifest.json)。
- **实现状态：已实现；验证状态：本轮必要专项通过、独立复审待执行；集成状态：未集成，真实激活待后续集成。**
- **职责与边界**：contracts 统一工厂公开导出、调用来源与绑定函数归一化；scan 记录 bind/call/apply 的目标与有效实参，按 fork 显式 cwd 解析 worker，并隔离 HTML 文本上下文；rules 对工厂来源做传递闭包，区别 DOM panel、显式 API 方法及完整对象，按确定先行关系核对脚本。生产 src、业务数据与主工作区设计原件均未改。
- **调用方与兼容**：CLI/npm/CI 入口、返回码、配置 schema 保持。公开工厂允许内部函数不同名及 const 别名；合法单根 DOM panel、精确方法挑选、前序同步 provider 后的 async consumer 得到兼容。未知恢复消息、未知 DB getter/绑定别名、未知任务工厂和动态 fork cwd 继续失败关闭；默认 Worker 根目录合同保留。没有新增豁免或修改上轮已审计的 5 个 allowedSites / 2 个历史例外。
- **业务行为**：R2-01→AC17，R2-02→AC16，R2-03→AC18，R2-04/05→AC05 与 G3 §4，R2-06→AC10/12（公开工厂核验同时用于历史 AC21），R2-07/09→AC10，R2-08→AC08。静态规则正确接受/拒绝源码，不改变生产查询、恢复或资金处理行为。AC22 的真实 Git 损坏配置恢复及 local/PR/push/tag/manual 端到端随全架构套件重跑。
- **验证证据**：首批对应 9 个问题的回归在修复前 9/9 失败；最终新增 14 组全部通过，完整架构套件 114/114，0 fail/skip。真实 VM/stub 验证敏感能力确实执行、panel 传入同一节点、API 仅挑选一个方法；真实 Git CLI 验证公开工厂兼容；真实子进程验证 fork 两种 options 重载的准确目标。固定基线 CLI exit 0：685/685 文件、2254 字面量本地边、64 worker、5 global、0 违规、114 条例外全部命中（142 条诊断匹配）、0 stale；未解析 2、动态位置 33 仍由既有合同/例外登记，未宣称全解析。15 个工具/测试文件 no-undef 通过，git diff --check 通过。日志见[证据说明](reviews/2026-09-21-r2-repair/evidence/README.md)。
- **当前规则入口**：根 AGENTS → `architecture/README.md` 已更新上述来源、别名、DOM/API、公开导出、脚本和 cwd 语义；机器正文仍仅为两个 JSON，字节未变。原 Spec/TechDoc 没有改写；原第二轮报告保持只读，准确副本存为本次 source-review.md。
- **剩余 / 回退**：待独立复审；G1–G7 不在本分支，仍 active 2 / pending 21 / partial 8。节点实际归属和生命周期、API 运行时类型与 HTML 浏览器执行不由这些合成测试证明。按 CODEX 风险验证，本轮未跑完整 release-check，旧日志不作为当前全量 PASS；正式集成/PR-ready 前须覆盖最终合并候选。未跑 Electron GUI、Windows workflow/安装包、Excel/WPS。无提交、推送、合并、PR、升版或发布。回退使用本轮差异和归档，仅恢复 F 的工具/测试/说明，保留此前实现与历史证据。


## 切片 G：R3-01 / R3-02 返回成员与 fork 重载修复（2026-09-21）

- **范围 / 代码状态**：父切片 F；同一 G8 worktree，HEAD 11086a3c + dirty。修复前归档 `/private/tmp/g8-r3-fixes-before/tooling.tar.gz`，本轮只修改 contracts/scan/rules、新增 review-round3.test.js，并同步规则说明与本记录。[增量差异](reviews/2026-09-21-r3-repair/evidence/repair-diff.patch)、[最终清单](reviews/2026-09-21-r3-repair/evidence/verified-manifest.json)固定本轮内容。
- **实现状态：已实现；验证状态：必要专项通过，修复后独立复审未执行；集成状态：未集成。**
- **职责与边界**：contracts 保留工厂返回成员路径，逐层选择对象字段并返回来源与未解释返回状态；scan 保留 const 成员别名的基对象/属性，按实际 fork 重载选择 options；rules 消费来源并拒绝未解释的本地返回链。没有将整个 Main 的 import 作为拒绝依据，不执行业务源码，不修改生产入口或副作用所有者。
- **调用方与兼容**：CLI/npm/CI、schema、配置字段和退出码保持。静态/嵌套/候选/绑定的服务方法引用与方法包装统一检查；纯本地服务、显式 adapter 注入和独立领域组装保持合法。三参数 fork 的运行时 argv/undefined/null 使用明确第三参数，已知第二参数对象仍按 Node 重载优先；argv 内容可动态，但无法区分数组/options 重载的第二参数也必须报 coverage，不能静默忽略潜在 options；未知 options/cwd 保持 coverage。机器配置和 114 条历史例外字节未变，未添加 allowedSites。
- **业务行为 / 决策**：R3-01 对应 TechDoc §4.8 / AC17，R3-02 对应 §3.2 / AC08。新增失败关闭限定在本地工厂返回链；最初一并拒绝所有未知成员引发既有 this/注入对象误报，已经撤回该扩大范围的判断。无 reviver 原生 JSON.parse 的数据 map/slice 做有限来源识别，保留现有数据读取；reviver、JSON 遮蔽或未知服务返回均不得借用。未改 Spec、业务数据或领域合同。
- **验证证据**：最初 3 个回归（两项问题，fork 两种 argv）修复前 3/3 失败；最终新增 10 组通过，完整架构套件 124/124、0 fail/skip，含 AC22 真实 Git 历史恢复及五类事件 CLI。VM 验证返回方法实际调用 Position；真实 Node 子进程核验 fork 目标及重载优先级。固定基线 CLI exit 0：685/685、2254 字面量本地边、64 worker、5 global、0 违规、114 例外全部命中（142 条匹配）、0 stale；未解析 2、动态位置 33 保持登记口径。16 个工具/测试文件 no-undef、git diff --check、文档链接与工作区保护检查通过。原始失败、中间基线误报和最终结果分别保留在[证据目录](reviews/2026-09-21-r3-repair/evidence/README.md)。
- **当前规则入口**：根 AGENTS → `architecture/README.md` 覆盖章节更新返回成员/未知链条、JSON 数据、fork argv/options 语义与测试链接。两个机器 JSON 无需修改：本轮修正解析与执行，没有新增边界、授权位置或状态变化。主工作区 Spec/TechDoc、审查原件与其他功能文档保持只读。
- **剩余 / 回退**：待独立复审；G1–G7 未落地到本分支的边界保持 pending/partial，正式集成/PR-ready 前在最终候选重跑完整 release-check 并逐域激活。此次依据 CODEX 与总索引 §6.2 按风险跑必要专项，没有重跑全量业务门禁；旧全量日志不代表当前 PASS。未跑 Electron/真实浏览器、Windows/安装包、Excel/WPS。未提交、推送、合并、PR、升版或发布。回退依据本轮增量和工具归档，仅撤回 G 的修改，保留此前实现与证据。


## 切片 H：R4-01 同文件受限 operation 的函数身份匹配（2026-09-21）

- **范围 / 代码状态**：父切片 G；原 G8 worktree、HEAD 11086a3c + dirty。修复前归档 `/private/tmp/g8-r4-fixes-before/tooling.tar.gz`。本轮只改 rules.js，新增 review-round4.test.js，同步规则 README 与本记录；[增量差异](reviews/2026-09-21-r4-repair/evidence/repair-diff.patch)、[最终清单](reviews/2026-09-21-r4-repair/evidence/verified-manifest.json)固定实际内容。
- **实现状态：已实现；验证状态：必要专项通过，修复后独立复审待执行；集成状态：未集成。**
- **职责与边界**：ARCH-TASK-ADAPTER 将配置中的静态操作绑定解析为词法函数身份，再与 callableOrigins 已解析的本地来源按源文件匹配；保留未解析成函数身份的直接操作表达式检查。共有解析器、其他规则、CLI、history/schema 均未改。业务入口、状态和副作用所有权不变。
- **调用方与兼容**：原最小服务成员引用现在与直接调用/包装调用一致拒绝；七个已登记 Main 操作均有返回成员、嵌套/别名、候选和 bind/call/apply 对照。静态具名表达式、const 和 bound 定义匹配实际绑定；局部同名函数、显式注入、其他源文件同名函数、纯服务和独立 composition 继续合法。精确 allowedSite 有效，调用作用域搬迁不继承授权。生产 Main 的既有导入操作仍保留直接调用检查，未移除或扩大历史例外。
- **业务行为 / 决策**：对应 TechDoc §4.8 / G8-AC-17，兼容对照同时覆盖 AC12。只修规则消费端，不重复追踪任意数据流；采用完整词法身份而非末段函数名，避免局部同名误报。中间基线检查发现删除导入表达式兜底会令 baseline-task-adapter-011 失配，已恢复该保护并补回归；初版结果保留为诊断过程，不作为最终 PASS。没有改变 Spec 或领域业务合同。
- **验证证据**：原最小复现先在旧工具失败（VM 确认实际调用），最终新增 7 组全部通过；完整架构套件 131/131、0 fail/skip，包含此前全部 R1～R3、AC22 真实 Git 修复历史及五类事件 CLI。固定基线 CLI exit 0：685/685 文件、2254 字面量本地边、64 worker、5 global、0 违规、114 例外全部命中（142 条匹配）、0 stale；未解析 2、动态位置 33 沿用原登记口径。17 个工具/测试文件 no-undef、git diff --check、文档链接与工作区保护检查通过；[证据说明](reviews/2026-09-21-r4-repair/evidence/README.md)区分中间与最终结果。VM 与 fixture 不代表业务生产验收。
- **当前规则入口**：根 AGENTS → `architecture/README.md` 更新同文件 operation、静态绑定、局部遮蔽与准确授权位置的语义及 R4 测试入口。机器配置无需更新：本轮未新增边界、授权位置或迁移状态。主工作区设计和审查原件保持只读。
- **剩余 / 回退**：待本轮独立复审；固定 release 候选上的规则对齐、领域行为验证、旧例外清理和激活仍由后续明确授权的集成切片负责。按 CODEX/总索引 §6.2 采用必要专项，本轮未重跑完整 release-check，旧全量日志不覆盖当前代码；PR-ready/正式集成前须重跑最终候选门禁。未跑 Electron/真实浏览器、Windows/安装包、Excel/WPS。未提交、推送、合并、PR、升版或发布。按本轮 patch/归档仅回退 H 的修改，保留以前实现、证据和业务数据。


## 切片 I：R5-01 受限 operation 的配置与调用绑定身份对齐（2026-09-21）

- **范围 / 代码状态**：父切片 H；原 G8 worktree、HEAD 11086a3c + dirty。接手前归档 `/private/tmp/g8-r5-fixes-before/tooling.tar.gz`，保护清单包含主工作区 643 个及目标 129 个已有 dirty 路径。本轮修改 scan.js/contracts.js/rules.js，新增 review-round5.test.js，同步规则 README 与本记录；[增量差异](reviews/2026-09-21-r5-repair/evidence/repair-diff.patch)与[最终清单](reviews/2026-09-21-r5-repair/evidence/verified-manifest.json)固定实际内容。
- **实现状态：已实现；验证状态：必要专项通过，修复后独立复审待执行；集成状态：未集成。**
- **职责与边界**：scan 的 describeBinding 成为配置与源码 Identifier 的共同绑定入口，保留 import、解构 selector、别名和工厂结果；contracts 的 targets 表示最终调用能力，modules/functions 继续提供依赖闭包。rules 以最终目标匹配登记 operation，存在但未完整解释的配置绑定报 ARCH-STATIC-COVERAGE。历史规则、配置格式、公开 CLI 和生产模块职责不变。
- **调用方与兼容**：导入模块 + 完整成员路径以及本文件函数 AST 身份在两端一致匹配，支持返回成员、嵌套、候选、bind/call/apply、const/let/var 解构和本地多层工厂；同工厂其他方法、同模块其他导出、其他模块同名导出、局部遮蔽、显式 adapter 注入和独立 composition 保持合法。工厂本身不因返回受限函数而被当作该函数；同名具名表达式以节点位置区分，位置只用于当次扫描，不替换历史 AST 指纹。准确 allowedSite 继续有效，搬迁作用域不能继承。
- **业务行为 / 决策**：依据 TechDoc §4.8、G8-AC-17，兼容对照覆盖 AC12。原审查两种形式的三个缺陷场景均由 0 违规变为 1 条 ARCH-TASK-ADAPTER；VM 确认实际执行的操作未变。不扩大为 Main 整文件 import 禁令，不更改领域业务合同、金额或恢复/发布行为。不能解析的外部工厂结果明确失败，不能用原始调用拼写冒充解析成功。
- **验证证据**：先新增原例回归，旧实现 2/2 失败；修复后新增 12 组通过。完整架构套件 143/143、0 fail/skip，包含 R1～R4、AC22 真实 Git 前向恢复及五类事件 CLI。原审查 9 场景在归档旧工具与当前工具重放，三个 gap 全部关闭、六个控制组结果不变；[重放结果](reviews/2026-09-21-r5-repair/evidence/replay-after.json)。基线 CLI exit 0：685/685 文件、2254 字面量本地边、64 worker、5 global、0 违规，114 例外全部命中（142 条匹配）、0 stale；未解析 2、动态位置 33 保留原口径。18 个工具/测试文件 no-undef、差异空白、文档链接及工作区保护检查通过；[证据说明](reviews/2026-09-21-r5-repair/evidence/README.md)。平台为 Node v25.8.0 / macOS arm64，VM/fixture 不代表生产业务验收。
- **当前规则入口**：根 AGENTS → `architecture/README.md` 更新完整绑定、最终能力与工厂依赖分离、未知绑定失败及 R5 验证入口。两个机器 JSON、allowedSites、114 条例外和 active 2 / pending 21 / partial 8 未变。主工作区设计及审查原件保持只读；本功能 worktree 留存审查原件副本与增量证据。
- **剩余 / 回退**：待独立复审；固定 release 候选上的规则对齐、领域验证、例外清理和激活仍未执行。本轮按 CODEX/总索引 §6.2 运行必要专项，未重跑完整 release-check，旧日志不代表当前全量 PASS；PR-ready/正式集成前重跑最终候选门禁。未跑 Electron/真实浏览器、Windows/安装包、Excel/WPS。未提交、推送、合并、PR、升版或发布。按本轮 patch/归档仅回退 I 的改动，保留 H 及更早实现、历史证据和业务数据。
