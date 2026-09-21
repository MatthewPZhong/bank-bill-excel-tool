# 架构边界检查

本目录维护 G8 已实现的静态架构检查合同。功能设计见 [Spec](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md) 和 [TechDoc](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)，本轮实现与验证状态见 [实施记录](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md)。模块业务合同仍由各治理项所有者维护。

## 命令与输入

从仓库根目录执行：

```sh
npm run check:architecture
node scripts/check-architecture.js --against <commit> --json <absolute-output-path>
```

默认读取当前工作区 `src/**/*.js`、`.cjs`、`.mjs` 和 `index.html`，以 HEAD 作为事件对比。`ARCHITECTURE_BASE_REF` 可提供 CI 事件对比提交，`--against` 优先。`--root <absolute-path>` 用于真实 Git fixture／离线仓库，仍执行完整历史检查，不允许无历史快照或普通子目录借用父仓库历史冒充首次引入。当前项目根及保留项目事实基线 Git 对象的离线仓库，即使显式指定 root，也必须使用固定 v3.2.9 基线。

检查不修改源码或配置，不执行生产模块、不联网；只有显式 `--json` 写入指定报告，父目录须存在。返回码为：0 通过，1 边界违规，2 输入／配置／解析器／Git 历史／报告写入错误。输出按稳定路径和标识排序，没有时间戳。不得以吞掉非零退出码方式绕过门禁。

`release-check` 顺序为 `lint → check:architecture → smoke → unit → integration`。现有 Windows workflows 保留原条件与发布守卫，PR 传 base.sha，main push 传 before，tag/manual 传核对后的实际 HEAD；保留 `fetch-depth: 0`。检查器不会自动 fetch。

## 职责和调用方向

- [check-architecture.js](../scripts/check-architecture.js)：唯一 CLI、事件参数、报告和退出码。
- [scan.js](../scripts/architecture/scan.js)：枚举、Acorn AST、支持的词法绑定与静态值、依赖边、DOM／全局／操作位置；不执行业务。
- [rules.js](../scripts/architecture/rules.js)：循环、闭包、调用位置、装配与激活约束；消费扫描结果，不写基线。
- [contracts.js](../scripts/architecture/contracts.js)：执行规则与历史校验共享的词法范围包含关系、工厂存在性/调用识别和别名来源。
- [schema.js](../scripts/architecture/schema.js)：严格配置结构；新增具有规则语义的字段必须同步历史比较和负向测试。
- [policy-history.js](../scripts/architecture/policy-history.js)：只读 Git 全父链配置、历史保护底线、迁移证据链与损坏 JSON 的受控重建。
- [ci-policy-base.js](../scripts/architecture/ci-policy-base.js)：核对 checkout 身份并选取真实 CI 事件对比值；缺失／零 before 失败。

机器正文唯一来源是 [boundaries.json](boundaries.json) 与 [legacy-allowlist.json](legacy-allowlist.json)。规则不靠文件名推测纯度，平台资源核心与 VCC 纯合同采用准确允许集及传递闭包；XLSX 属于允许指定 IO／解析库的基础设施，不套用纯模块的 IO 禁令。合法 composition、领域内部调用和 scoped API 以登记为准。G7 通用 carrier 的两处 worker 启动点按准确 allowedSites 和完整目标集登记，允许执行 composition 注入的任务；它们不会成为 runtime／registry 直接加载领域实现的豁免，纯核心仍禁止 worker。

## 基线、激活和兼容入口维护

固定事实基线为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`（v3.2.9）。初始例外来自该版本的实际扫描：准确边或规范 AST 指纹、函数作用域、原始提交、理由、归属及移除条件。历史审查数字只是共同口径对照，不直接导入为放行结论。禁止整目录豁免、自动更新基线或给新增字面量循环加例外。扩展 worker 图揭示的历史循环按完整规范 SCC 边集合、edgeKinds 和指纹准确登记；增加边、换节点或形成字面量循环不会继承旧豁免。

本功能分支仍基于 v3.2.9，尚未包含 G1–G7 的实现；配置里的 pending 描述本分支的待激活状态。release 已纳入哪些实现，以[实施记录和固定代码登记](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md)为准，不能将另一个 worktree 的实现当作当前源码激活。文件出现即受基础规则检查，不能因为 pending 放过新增代码。出现部分入口会单独报告；切片完成时应在同一变更更新：

1. entrypoints、protectedScopes 和规则绑定，明确真正公开入口与写权限。
2. requiredConsumers、准确合法装配／调用位置，迁移旧消费者。
3. activationEvidence 指向真实存在的行为／装配测试入口，同时在实施记录保留运行结果。
4. state 置为 active；删除已消失的历史例外，核对工厂加载和顺序。
5. 更新所属模块现行说明及总索引要求的五项切片证据。

G5 Q1–Q3 和 G3 控制器按独立子边界登记。G6 两个纯合同必须同时存在且有真实消费者；G3 modalHost 激活须清零旧生产根节点写入并实际装配。G1／G2／G7 的旧旁路或反向兼容桥未迁完不能标 active。测试文件存在本身不能证明业务验收通过。

旧 XLSX API 单独记录 `deprecatedEntrypoints`、具名导出和基线生产消费者；不得新增入边。active 时生产入边归零；完成全仓脚本／测试调用清点及兼容验证后，提供 retirementEvidence 才可标 retired 并移除 shim。必需中性入口与可退役 shim 是不同合同。

例外过期会给出 stale 诊断，检查器不代删。文件改名不会继承旧路径豁免；兼容搬迁须显式审查并保留依据。

## 历史防倒退与受控前向恢复

事件对比只是一个输入。每次检查还读取固定事实基线之后、实际 HEAD 与事件对比提交的全部可达父链，包含 merge 的各父链。曾 active 的稳定 ID 不得消失或降级，retired 不得复活；选择旧 `--against` 不能清空底线。Git 对象缺失、shallow 或不具备基线祖先关系时报输入错误。

必需入口／消费者、保护范围、受限 API／operation、工厂与全局合同、允许集合、允许调用／装配、激活证据和例外都参与历史强度比较。删除 `allowedApiFields.api` 会移除方法约束，不能当作收紧；禁止全部方法应保留 `api: []`。治理归属参与执行强度，active 后不能改归属绕过证据或例外限制。已退役入口的成员、消费者与证据约束在所属边界仍 pending 时也保持。active 的具名保护函数必须真实存在，更名须同步登记和迁移证据。

工厂 active 时核对 factory.path 内以配置名称公开导出的可解析函数及实际生产调用；具名函数表达式、const 别名、具名 ES 导出和显式 CommonJS/全局对象导出按公开键识别，不要求内部函数同名。仅有未导出的私有同名函数或不透明导出不算存在。工厂改名的迁移必须同时迁移旧调用，替代不存在或旧调用残留时，即使 policyChanges 结构正确也失败。保护范围从 `collect.inner` 扩大到 `collect` 按词法祖先关系视为收紧；执行匹配与历史比较共用同一函数，反向缩小仍失败。

合法入口迁移使用精确 `policyChanges`，绑定 sourceCommit、sourcePolicyBlob、boundaryId、field、from、to、reason、designDoc。多次迁移须符合父链顺序，允许有准确版本证据的 A→B→A；不能借变更链豁免纯模块禁止能力或 active／retired 状态底线。

历史 `boundaries.json`／`legacy-allowlist.json` 的 JSON 语法损坏默认失败；当前树修好并不能自动忘记损坏历史。只在确需恢复时新增 `policy-history-repairs.json` 及 `policy-history-repairs/<originalBlob>.json`，不预建空清单。按 [TechDoc §5.4](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md#policy-history-repair) 绑定准确 path／blob／sourceCommits、完整最小语法修复快照、SHA-256 和 reviewEvidence。重建仍完整参加相同历史底线，不允许空配置、弱化配置借道或替换已生效的修复绑定。

当前错误配置、可解析但违反约束的配置、未知 schema、缺失 Git 对象不能使用 repair。历史无效 repair 记录不会固定错误 hash；后续可前向补齐。已完整有效的绑定即使随后出现坏 manifest 仍必须保留。默认终端报告及 JSON 均展示实际采用的原 blob、重建 hash、来源提交和审查文档；历史无效登记的诊断继续保留。机器只验证身份和证据链，重建是否保持原意由该变更的 review 核对。

## 覆盖与验证边界

静态检查覆盖字面量及支持的常量传播 require/import/export、已解释 worker 路径、登记的 classic global、根节点写入和受保护操作位置。报告保留文件／边数、未解析／动态位置、active／pending／partial、例外和历史修复来源。

当前支持与失败关闭的边界：

- `StaticBlock` 同时建立词法作用域和 var 边界；块内同名 require 不遮蔽块外 Node require。
- Worker/fork 默认相对路径按仓库根运行 cwd 解析；fork 的 `(path, options)` 与 `(path, args, options)` 都读取显式 cwd；三参数形式不要求 argv 内容静态可知：已知数组、原生 process.argv/process.execArgv 的 slice、Array.from/of，以及 undefined/null 均使用第三参数。第二参数连数组/options 重载身份也无法解释时，报 coverage，不猜测第三参数生效。第二参数已知是对象时，按 Node 重载以该对象作为 options；有限候选逐一解析，未知 options/cwd 报 coverage。绝对目标不依赖 cwd；`path.resolve` 的相对参数以扫描根为准，`__dirname` 和 `new URL(..., import.meta.url)` 保持模块目录语义。本工具不推断进程启动后的任意 chdir；此类调用须提供准确目标合同。
- 受保护 worker operation 遍历条件候选，含 recover 的候选受授权位置限制；无法解释的 operation 报 coverage。历史 transport 的两个动态转发位置保留准确 v3.2.9 AST 例外，G1 激活前清理，不代表已证明授权。
- 通用任务按别名来源候选检查模块传递闭包及本地 helper/返回函数；对本地工厂返回对象保留并逐层选择实际调用的成员路径，方法引用、包装函数、const 成员别名和绑定均不能绕过 Position 依赖检查。对同文件 restrictedApis.operations，配置与调用共用完整词法绑定解析（包含 import、解构、别名和本地工厂初始化）；最终调用目标按导入模块及完整成员路径、或源文件及本次扫描内的函数 AST 身份匹配。工厂/helper 的依赖闭包与最终目标分开，避免把同工厂的其他方法、同模块的其他导出扩大禁用；已登记绑定存在但不能完整解析为函数目标时明确报 coverage。局部同名函数、显式注入参数和其他文件同名函数不因拼写相同继承该操作限制。const/let 的不透明工厂结果一并报 coverage；本地返回链中缺失成员、动态成员、spread/getter 或递归未解释结果明确失败，不靠变量名判断。无 reviver 的原生 JSON.parse 数据上的 map/slice 保持数据读取语义，reviver 或被遮蔽的 JSON 不适用此识别。显式注入参数仍按其合同检查；任意运行时回调内容不由此静态证明。
- bind 创建函数不视为执行；后续调用保留目标方法、别名候选与预绑定实参，多次 bind、call/apply 使用同一归一化。postMessage 的未知恢复消息和 getter 后 prepare/exec 的未知 DB 来源仍报 coverage；明确的原始 DB 操作按查询规则拒绝，RegExp.exec 属于文本解析。apply 的不透明实参不被当作空消息。
- 工厂的 API 字段必须提供可解释方法集合；允许显式对象逐项挑选与授权叶路径对应的 desktopApi 方法，包括 Object.freeze 和静态 const 别名。不透明 helper 返回值/候选对象拒绝；allowedApiFields 的点分名称按嵌套叶路径检查，额外方法、嵌套 spread、getter 和完整 desktopApi/namespace 均不能借层级藏入。静态路径检查不执行 preload 验证实际方法类型。
- 工厂 panel 参数允许可解析的单根 `document.getElementById(静态 id)` 或 `document.querySelector(静态 #id)`，不允许 document/body/html/modalRoot、动态 selector 或不透明 helper 代替。它只识别节点取得方式；节点真实存在、所属领域与生命周期仍由 G3 行为测试验证。
- script 装配区分同步与 defer：同步 provider 可以先于延迟 consumer，也确定先于其后出现的 async consumer；同组 defer 依文档顺序。async 或 module provider 不能据标签位置认定先行，module 顶层 await 等无法保证的关系拒绝。template 内脚本不计为已加载；textarea/title 和支持的 raw-text 元素内容不参与标签计数，其中的伪 template 结束标记不能激活惰性脚本。

上述收紧对应 [R1–R10 回归](../tests/unit/architecture/review-regressions.test.js)。五处准确合法调用使用 allowedSites 保留职责说明；两处 G1 历史动态操作使用 legacy-allowlist 保留移除条件，两者不可混用。登记变化和原始基线核对见[本轮修复复核](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-repair/repair-review.md)。

第二轮的绑定调用、工厂闭包、DOM/scoped API 兼容、公开导出、脚本执行次序和 fork cwd 回归见 [R2 测试](../tests/unit/architecture/review-round2.test.js) 与[第二轮修复自检](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2-repair/repair-review.md)。本轮没有增加或修改 allowedSites、历史例外、schema 或激活状态。

第三轮的本地返回成员与 fork 完整重载补充见 [R3 测试](../tests/unit/architecture/review-round3.test.js) 和[第三轮修复自检](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r3-repair/repair-review.md)。本次修正返回链追踪，不将所有 this/动态对象调用扩大为新禁令；未解释位置与任意运行时注入仍受下述静态边界限制。机器配置及例外没有变化。

第四轮的同文件受限操作身份匹配见 [R4 测试](../tests/unit/architecture/review-round4.test.js) 与[第四轮修复自检](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r4-repair/repair-review.md)。该轮只修改 ARCH-TASK-ADAPTER 的规则消费端，不修改共享解析器、机器配置和历史例外；精确 allowedSites 仍按原位置/作用域/指纹核验。

第五轮的导入成员与工厂初始化绑定修正见 [R5 测试](../tests/unit/architecture/review-round5.test.js) 和[第五轮修复自检](../changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r5-repair/repair-review.md)。本轮共享同一绑定解析入口，保留 const/let/var 解构的成员选择，并用 AST 节点位置区分本次扫描内的同名函数表达式；该位置不写入配置或历史例外，历史指纹仍使用原规范 AST。未知的外部工厂返回值不能冒充已解析的配置 operation。机器配置、例外和激活状态不变。

IPC、任意 callback 注入、任意数据流／反射、共享对象内部写入、SQL 的业务过滤含义、资源真实退出、恢复授权时序及 GUI 生命周期不由 AST 完整证明。未解释的受保护结构失败关闭；报告中的盲区不能写成零风险。相关业务验收由 G1–G7 自己的真实测试负责；Windows／Excel／WPS／安装包验收按实际影响另外记录。

代表性自动验证入口：[scanner](../tests/unit/architecture/scan.test.js)、[rules](../tests/unit/architecture/rules.test.js)、[policy-history](../tests/unit/architecture/policy-history.test.js)、[CLI 与 CI](../tests/unit/architecture/cli.test.js)。实际运行结果及未完成项只在本轮实施记录登记。
