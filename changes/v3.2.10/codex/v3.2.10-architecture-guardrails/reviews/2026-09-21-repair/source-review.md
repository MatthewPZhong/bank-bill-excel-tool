# G8 架构依赖边界门禁分支审查

日期：2026-09-21。结论：**需要修正后复审；当前实现不能据此认定 Spec / TechDoc 的 G8 验收已完成。**

确认 **10 项 P2**，其中 6 项为规则漏检，1 项为脚本装配漏检，3 项为合法输入误报。现有 84 个架构测试全部通过，但下述新增反例未被覆盖。优先级指工程修复优先级，不表示生产业务已发生对应事故；本次没有发现或宣称金额、删除或恢复事故。

## 1. 审查对象与只读边界

| 项目 | 当前证据 |
|---|---|
| 目标分支 | `codex/v3.2.10-architecture-guardrails` |
| 实际工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails` |
| HEAD / main / v3.2.9 基线 | `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 已提交差异 | `main...HEAD` 为 0 / 0；实现全部位于目标 worktree 未提交差异中 |
| 实际审查内容 | HEAD + 6 个 tracked 修改文件，以及 architecture、扫描脚本、测试和设计资料等 untracked 内容 |
| 冻结快照 | `/private/tmp/g8-review-20260921-ljrvo1de/snapshot`；3073 个文件路径指纹，[完整清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/manifest.json) |
| 设计依据 | [冻结 Spec](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/spec.md)、[冻结 TechDoc](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/techdoc.md)、[冻结实施记录](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/implementation-notes.md) |
| 当前规则状态 | active 2、pending 21、partial 8；仅 production-graph / platform-core 已激活 |
| 本轮写入 | 仅此审查目录和临时 fixture；原目标工作区与冻结源码均未修改 |

目标分支保留 v3.2.9 生产源码，G1–G7 没有在这里实际集成。它们处于 pending / partial 本身符合设计，未作为缺陷。实施记录中的 release 预检固定于 `9602a1fa...`；本轮观察到 release 已移动到 `e0d6e51b...`，所以该记录仅代表旧候选，不能直接用于当前 release 激活。此次不审查或修改 release，也不把旧预检诊断计入 findings。

## 2. Findings

### G8-R1 — [P2] StaticBlock 的局部 require 被错误提升，隐藏真实依赖

**定位：** [scripts/architecture/scan.js:194](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:194)、[scripts/architecture/scan.js:202](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:202)。

```js
class C { static { var require = () => {}; } }
module.exports = typeof require('node:fs').readFileSync;
```

将该文件登记为平台纯核心入口时，Node 实际返回 `function`，外部调用仍是 Node 的真实 require；静态块中的局部 var 不会遮蔽块外加载。但扫描器没有建立 StaticBlock 自身的 var 作用域，把该绑定提升到 Program，返回 `edges=[]`、`dynamicSites=[]`、`violations=[]`。去掉静态块后，同一 fs 调用正确触发 ARCH-PLATFORM-CORE。

**影响：** 标准、已解析的 JavaScript 语法能漏掉字面量禁止依赖，也可能漏掉循环边；不属于任意反射的已声明盲区。违反 TechDoc §3.1/§3.2、G8-AC-03/08。

**修正方向：** 为 StaticBlock 建立独立词法及 var 作用域，补块内/块外同名绑定与真实加载的对照测试。

**证据：** [static-block / without-static-block 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/scanner-probes.json)；[可重放探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/probes/scanner-probes.cjs)。

### G8-R2 — [P2] factory 的配置改名未核验真实迁移，可以关闭已激活注入检查

**定位：** [scripts/architecture/policy-history.js:364](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/policy-history.js:364)；关联 [scripts/architecture/policy-history.js:319](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/policy-history.js:319)、[scripts/architecture/rules.js:265](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:265)。

真实 Git fixture 为 S0 无配置 → S1 active `createProbe` → S2 保留原工厂调用，并注入非法 `state`、未授权 `api.write`。仅将配置的 factory.name 改为源码不存在的 `createNonexistentProbe`，附准确 sourceCommit / blob / from / to 与设计依据，原先 2 条违规即消失，历史校验也返回空违规，**完整 CLI exit 0**。

`preservesCapabilities` 仅拒绝 factory 置空，`currentMigrationValid` 没有验证替代工厂与旧调用迁移；执行规则又只按配置名过滤调用。这样有结构完整的记录也可以实际解除禁止能力。

**影响 / 契约：** 违反 TechDoc §5.3 对实际保护效力、替代入口和消费者的校验要求，以及 G8-AC-21。应验证真实定义及生产调用；旧工厂仍有消费者时继续保留检查，目标不存在应失败。

**证据：** [三提交与完整 CLI 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/factory-result.json)、[CLI 日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/factory-cli.log)、[可重放探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/probes/factory-probe.cjs)。S1 `ea4e5cee1c4279f87621e9f750e3d824c131c65d`；S2 `8f5039dc3638bd077deaf7833d622fe94522cf0d`。这些提交仅属于临时 fixture。

### G8-R3 — [P2] 动态 worker operation 绕过授权恢复入口限制

**定位：** [scripts/architecture/rules.js:227](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:227)。

在真实配置整文件保护的 dispatcher 中新增：

```js
function unauthorized(worker, shouldRecover) {
  worker.postMessage({ op: shouldRecover ? 'recover' : 'publish', payload: {} });
}
```

扫描器已将条件表达式表示为 candidates，但规则只比较 `.value === 'recover'`，未遍历候选，也未报告未解释 operation。结果为零违规、零动态诊断；VM/stub 调用 true 分支实际收到 recover。改为直接 `'recover'` 的对照会正确拒绝。

**影响 / 契约：** 非授权函数可以发送恢复操作而通过门禁。违反 TechDoc §4.7、G8-AC-16 对动态 operation 失败关闭及精确授权位置的要求。应处理可解析候选，并对无法解释的受保护操作报告 coverage 错误。

**证据：** [动态 operation 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g1-dynamic-op/result.json)、[字面量对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g1-static-control/result.json)、[治理规则探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/probes/rules-probes.cjs)。

### G8-R4 — [P2] 通用任务编排的未知别名仅按 Position 命名兜底

**定位：** [scripts/architecture/rules.js:192](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:192)，直接缺口在 [scripts/architecture/rules.js:197](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:197)。

```js
const position = require('./main-process/position-reconciliation/task-owner');
let settle = position.settle;
function runArchiveAwareOperation() { settle(); }
```

let 别名被标为 opaque，调用处失去 `binding.from`；兜底又要求 callee 名称包含 Position/position，因此 `settle()` 返回零违规。只将 let 改成 const 即触发 ARCH-TASK-ADAPTER。VM/stub 证明两种写法都调用 Position settle。

**影响 / 契约：** 通用编排可以重新直接调用领域状态操作。违反 TechDoc §4.8、G8-AC-17：未解释调用别名不能静默忽略，保护不能由变量名称决定。应利用已解析 alternatives 或对涉及受限能力的未知别名明确失败。

**证据：** [let 漏检](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g2-let-alias/result.json)、[const 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g2-const-control/result.json)。

### G8-R5 — [P2] getter 返回的原始 DB 句柄绕过事实查询检查

**定位：** [scripts/architecture/rules.js:242](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:242)；关联 [scripts/architecture/scan.js:541](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:541)。

```js
function getHandle(catalog) { return catalog.db; }
function read(catalog) {
  const handle = getHandle(catalog);
  return handle.prepare('SELECT * FROM facts').all();
}
```

在真实 Q2 配置的 compute-inputs 保护范围内，handle.prepare 被描述为 `unknown/member-base`，没有 chain，也没有顶层 opaque。因此既不产生 db-operation，也不命中依赖 callee 后缀与 opaque 的 coverage 兜底。结果为零违规；stub 实际记录 SELECT。直接 catalog.db.prepare 的对照正确拒绝。

**影响 / 契约：** 消费者用一个普通 getter 就能继续持有 raw DB、构造 SQL。违反 TechDoc §4.9、G8-AC-18 对新不透明 DB alias 失败关闭的要求。修正应保留方法语法身份并解释来源，无法解释时报告 coverage；无需声称静态证明 SQL 业务语义。

**证据：** [getter 漏检与 stub 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g5-getter-alias/result.json)、[直接查询对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/rule-fixtures/g5-direct-control/result.json)。

### G8-R6 — [P2] 工厂字段的函数返回值可以携带完整 desktopApi

**定位：** [scripts/architecture/rules.js:270](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:270)、[scripts/architecture/rules.js:275](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:275)。

```js
function getApi() { return window.desktopApi; }
window.__bankStatementController.createBankStatementController({api: getApi()});
```

使用原配置的 renderer-bank-statement 边界，直接传 window.desktopApi 会报错，换成上述 getter 则零违规。字段被表示为 call-result，既不属于 unknown/opaque，也不进入 reference 或 object 的方法集合检查。完整 API 实际仍被注入。

**影响 / 契约：** ARCH-RENDERER-SCOPE 的入口限制可被普通 helper 绕过。违反 TechDoc §4.4、G8-AC-05 对不可解释注入来源失败关闭的要求。应解释受支持的返回值，或拒绝无法证明为 scoped 对象的 call-result。

**证据：** [direct full API / helper returning full API 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/renderer-probes.json)、[Renderer 探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/probes/renderer-probes.cjs)。

### G8-R7 — [P2] Classic scripts 用标签位置代替真实执行顺序

**定位：** [scripts/architecture/rules.js:283](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:283)、[scripts/architecture/rules.js:291](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:291)。

```html
<script defer src="src/service.js"></script>
<script src="src/controller.js"></script>
```

provider 声明 window.service，consumer 顶层调用 window.service.read。扫描已记录 defer/type/async，但规则把记录压成路径后仅比较索引，因此该输入以及 provider 为 type=module 的版本都得到零违规。普通同步 consumer 会早于 defer/module provider 执行，所需服务尚未存在。

附属反例：template 内的 provider script 也被认定为已生产加载，尽管静态页面中 template 内容不执行；其原因位于 [scripts/architecture/scan.js:378](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:378) 的 tokenizer 未保留 template 上下文。

**影响 / 契约：** G3 激活和装配检查接受服务未就绪的页面。违反 TechDoc §3.3、G8-AC-10“真实加载、顺序正确”。应核对执行模式与惰性上下文；无法保证先行关系时拒绝该装配。探针证实的是检查器放行；未运行 Electron GUI，浏览器执行顺序是依据标准语义的判断。

**证据：** [normal / defer / module / template 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/scanner-probes.json)。

### G8-R8 — [P2] Worker 相对路径使用 require 的基准目录，解析到错误目标

**定位：** [scripts/architecture/scan.js:532](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:532)；共同解析器 [scripts/architecture/scan.js:87](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:87)。

`src/launcher.cjs` 执行 `new Worker('./src/worker.cjs')`，从 fixture 仓库根运行时真实 Worker 正常输出 worker-ran，exit 0。但 scanner 以 launcher 的目录为基准查找 src/src/worker.cjs，报 missing、workerEdges=0 和 ARCH-STATIC-COVERAGE。

**影响 / 契约：** 合法 worker 调用被门禁拒绝；若两个候选目录都有文件，还可能建立错误依赖边。违反 TechDoc §3.2、G8-AC-08 对准确 worker 目标的要求。Worker 相对文件名应按运行 cwd 语义处理；cwd 无法确定时应要求准确合同，不应套用模块文件相对路径。

**证据：** [worker-relative 的 scanner 与实际 Node Worker 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/scanner-probes.json)。

### G8-R9 — [P2] 场景 API 的嵌套白名单被当成顶层键比较

**定位：** [scripts/architecture/rules.js:276](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:276)。

真实 renderer-dialog-scenarios 配置允许 `scenarios.list` 等方法，输入 `createScenariosDialogs({api: {scenarios: {list() { return []; }}}})` 却被判为“scoped api 未授权字段 scenarios”。规则仅取 Object.keys，不处理配置中的点分层级。

**影响 / 契约：** 按现有配置构造的合法 scoped API 无法通过，会阻断 G3 对应切片落地。违反 TechDoc §4.4、G8-AC-05 的合法 scoped API 正例要求。应一致定义嵌套字段路径并逐叶检查，同时拒绝 scenarios 中的未授权方法。

**证据：** [nested allowed scenario API 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/renderer-probes.json)。这是原始规则配置的误报，未将 release 中尚未对齐的 API 名称当作缺陷。

### G8-R10 — [P2] 扩大到父函数的保护范围被误判为放宽

**定位：** [scripts/architecture/policy-history.js:396](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/policy-history.js:396)；执行匹配对照 [scripts/architecture/rules.js:12](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:12)。

真实 Git fixture 先 active 保护 collect.inner，再仅把保护范围扩大为 collect，源码和其他配置不变。规则执行器认定父函数覆盖嵌套函数，但 stronger 比较只接受同名或 null，完整 CLI exit 1，称保护被删除或放宽。

**影响 / 契约：** 合法收紧被错误阻断，要求本不必要的迁移材料。违反 TechDoc §5.3 按保护效力比较的要求。stronger 应与 scopeMatches 使用相同的词法祖先包含关系，并保留反向缩小范围失败测试。

**证据：** [完整 CLI 与历史结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/scope-strengthening-result.json)、[真实 Git 探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/probes/scope-strengthening-probe.cjs)。

## 3. 验证结果与证据范围

| 验证 | 本轮结果 |
|---|---|
| `node --test tests/unit/architecture/*.test.js` | **84 / 84 pass**，0 fail / 0 skipped，22.36 秒；[原始日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json ...` | exit 0；685 / 685 文件，2254 字面量本地边、64 worker 边、5 global 边；[JSON 报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/architecture-check.json) |
| 未解析与动态位置 | 2 个未解析生成入口、33 个已登记动态位置；报告保留它们，没有计成完全解析 |
| 精确例外 | 112 个例外条目命中，stale 0；不代表 pending 规则已完成行为验收 |
| 新增对抗探针 | 10 项缺陷及相应对照，详见以上证据；历史项走完整 CLI，其余走真实 scan/evaluateRules 接口，部分增加 Node 或 VM/stub 对照 |
| `git diff --check` | exit 0 |
| 冻结与保护 | 目标 3073 个路径、冻结快照无漂移；目标 git status 未变化，[保护结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/preservation.json) |
| 既有完整门禁记录 | 原日志存在；其 19 个实现文件 SHA-256 与本次源码一致；记录为 8188 tests / 8184 pass / 0 fail / 4 skipped，60 个集成脚本、2579 assertions 通过 |

完整 release-check 是**核验并复用的既有记录**，本轮未重新执行：本次为只读审查，已实跑全部架构专项，且新反例说明缺口在现有覆盖之外；重跑同一全量业务套件不能补上这些反例。冻结工具源码及测试副本见 [工具指纹](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/frozen-tooling-manifest.json) 与 [证据使用说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/evidence/README.md)。

没有提交、推送、合并、创建 PR、修改生产源码、修改分支配置或实现修复。未运行 Electron GUI、GitHub Windows workflow、安装包、Excel/WPS，也未执行 G1–G7 实际业务验收。恢复/DB/Position 的 stub 只证明 fixture 会调用相应能力，不能据此推断实际应用产生副作用。

## 4. 后续修复验收建议

优先修复 R1–R6 的漏检，再修正 R7 的脚本装配检查与 R8–R10 的误报。将各最小反例纳入对应专项，保留合法写法与受限写法的双向对照。修复后复跑架构套件，并在准备正式集成/PR-ready 时对最终候选执行完整 release-check。

G8 合入 release 前仍需按实际候选完成 G1–G7 的入口、消费者、合法装配、精确例外和 activationEvidence 对齐；该工作与本次确认的扫描器缺陷分别验收。不能仅将状态改为 active 或增加例外来消除以上问题。
