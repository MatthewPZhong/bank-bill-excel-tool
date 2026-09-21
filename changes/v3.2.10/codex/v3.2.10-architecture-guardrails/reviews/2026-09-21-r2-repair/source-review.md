# G8 架构门禁第二轮增量复审

日期：2026-09-21。分支：`codex/v3.2.10-architecture-guardrails`。

**结论：仍需修正后复审。上轮 10 个最小反例均已修复；本轮确认 8 项 P2，其中 4 项是修复引入的误报，4 项是原规则同类边界的余漏；另有 1 项 P3。**

当前 100 个架构测试和固定 v3.2.9 基线扫描全部通过。下面的结论区分“原反例已消除”与“整条规则合同已满足”，不能用前者替代后者。问题优先级是工程修复优先级，不表示生产业务已发生资金、删除或恢复事故。

## 1. 范围与冻结身份

- 上轮报告：[第一次审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21/review.md)。本轮以其冻结源码为增量基准，并阅读当前 Spec / TechDoc 和实现者修复记录。
- 目标 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`；HEAD 仍为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，与固定 v3.2.9 / main 相同。目标仍是 **HEAD + 未提交实现**。
- 本轮冻结根：`/private/tmp/g8-rereview-20260921-eas4s1kl/snapshot`。冻结 **3084 个路径**，相对上轮 **19 个路径变化**。核心修复涉及 scan/rules/policy-history、新增 contracts.js 和 review-regressions.test.js、配置和说明；生产 src/index.html 没有改动。
- Spec / TechDoc 未修改，仍以 [G8 Spec](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/spec.md)、[G8 TechDoc](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/techdoc.md) 为合同；panel 与 scoped 注入同时核对 [G3 TechDoc §4](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/g3-techdoc.md)。
- 目标/快照无漂移，修复交付记录的 **21 个实现文件 SHA-256 均吻合**。详见 [冻结清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/manifest.json)、[增量路径](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/incremental-files.json)、[保护结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/preservation.json)。
- 此次只新增本审查目录和临时 fixture，未修改分支实现/配置、既有审查、Spec 或 TechDoc；未提交、推送、合并或创建 PR。

## 2. 上轮发现的复验结果

| 上轮编号 | 原反例的当前结果 | 本轮仍需关注 |
|---|---|---|
| R1 StaticBlock | 块外 fs 现在形成真实依赖并被拒绝；var/let/const、嵌套与相邻块对照通过 | 本轮未发现相关新增问题 |
| R2 factory 假迁移 | 原真实 Git 探针 CLI exit 1，历史约束和工厂缺失同时拦截 | 新增合法具名表达式/别名导出误报，见 R2-06 |
| R3 动态 recover operation | 条件候选包含 recover 正确拒绝 | 绑定 postMessage 后的未知消息仍可绕过，见 R2-02 |
| R4 Position let alias | 原 let settle 现在正确拒绝，与 const 对照一致 | 工厂/本地 getter 返回的能力仍有遗漏，见 R2-01 |
| R5 raw DB getter | getter 后直接 handle.prepare 正确报 coverage 错误 | prepare.bind 后调用仍可绕过，见 R2-03 |
| R6 完整 API helper | getApi()、条件对象、嵌套 full API 被拒绝 | 限制误伤本域 panel 和精确方法引用，见 R2-04/05 |
| R7 scripts 顺序/template | 原 defer/module/async provider 对同步 consumer 拒绝；简单/嵌套 template 不计为加载 | 合法 async consumer 误报及 textarea 残余，见 R2-07/09 |
| R8 Worker 相对路径 | 默认仓库 cwd 下选择真实目标，并通过实际 Worker 对照 | fork 显式 cwd 未参与解析，见 R2-08 |
| R9 嵌套 API 白名单 | scenarios.list 和冻结嵌套对象通过；额外方法/spread/getter 拒绝 | 原指定反例消除；方法引用误报见 R2-05 |
| R10 扩大父函数范围 | 原真实 Git 探针 CLI exit 0；父范围缩回子范围继续拒绝 | 本轮未发现相关新增问题 |

复验材料：[R2 原探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/history-old-factory-result.json)、[R10 原探针](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/history-old-scope-strengthening-result.json)、[R1/R7/R8 新旧对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/scanner-incremental-probes.json)、[Renderer 新旧对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/renderer-incremental-probes.json) 和 `rules-fixtures/`。全套专项包含新增的 16 个 review-regressions 测试，实际结果 100/100。

## 3. 本轮发现

### R2-01 — [P2] 工厂返回的 Position 能力没有检查传递闭包

类型：原 R4 所属规则的余漏。定位：[scripts/architecture/rules.js:200](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:200)、[scripts/architecture/rules.js:208](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:208)；辅助来源 [scripts/architecture/contracts.js:35](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/contracts.js:35)。

```js
// src/main.js
const { create } = require('./main-process/task-factory');
const service = create();
function runArchiveAwareOperation() { service.settle(); }
// task-factory.js
exports.create = () => require('./position-reconciliation/task-owner');
```

新 callableOrigins 能取得工厂模块，但 rules 只直接比较 origins.modules 是否就是受限路径；对工厂结果没有沿该模块闭包检查。service.settle 的候选没有顶层 module，因此后面的 closure 也不执行。实际配置下返回 **零违规、零动态诊断**，VM/stub 实际调用 Position.settle。

另一个对照是本地 getSettle 返回 position.settle，const settle=getSettle() 后在保护函数调用，也因 call-result 未带 opaque 而静默通过。

违反 TechDoc §4.8 / G8-AC-17 对公共编排间接加载领域状态机、未知调用别名不能静默忽略的要求。建议对已知工厂来源执行相同闭包检查，并一致处理无法解释的 const/let 返回值。

证据：[工厂闭包反例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g2-helper-factory/result.json)、[本地 getter 反例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g2-const-getter/result.json)，均含 runtimeObserved。

### R2-02 — [P2] 绑定 postMessage 后，保护范围内的未知恢复消息未被检查

类型：原 R3 所属规则的余漏。定位：[scripts/architecture/rules.js:238](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:238)、[scripts/architecture/rules.js:250](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:250)。

```js
function unauthorized(worker, message) {
  const send = worker.postMessage.bind(worker);
  send(message);
}
```

在真实配置整文件保护的 publication dispatcher 中，绑定后的 send 失去 postMessage 方法身份；message 是引用参数，不会进入 inspectMessage，也没有产生 unknownOperation。结果 **零违规**；调用 fixture 的 message={op:'recover'} 时，stub 实际收到 recover。

修复已覆盖直接 postMessage(message)，但绑定后的同一能力仍被静默忽略。违反 TechDoc §4.7 / G8-AC-16 对受保护动态 operation 的失败关闭要求。应保留已知绑定方法的来源，或在该受保护能力无法解释时报告 coverage。

证据：[绑定发送反例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g1-bound-send/result.json)；原条件 operation 的拒绝对照见 [原例复验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g1-dynamic-op/result.json)。

### R2-03 — [P2] 绑定 prepare 后再次丢失 DB 查询身份

类型：原 R5 所属规则的余漏。定位：[scripts/architecture/rules.js:275](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:275)。

```js
function getHandle(catalog) { return catalog.db; }
function read(catalog) {
  const handle = getHandle(catalog);
  const prepare = handle.prepare.bind(handle);
  return prepare('SELECT * FROM facts').all();
}
```

绑定处方法名为 bind，后续 Identifier 调用又没有 prepare/exec 的 method；新 coverage 兜底只匹配这两个名字，因此两处都不检查。真实 Q2 配置下 **零违规**，DB stub 实际记录 SELECT；直接 handle.prepare 的原例已经正确拒绝。

违反 TechDoc §4.9 / G8-AC-18 对新不透明 DB alias 失败关闭的要求。建议沿绑定来源保留敏感方法身份，不仅在直接 MemberExpression 调用处判断。

证据：[绑定查询反例](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g5-bound-prepare/result.json)、[原 getter 反例复验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-fixtures/g5-getter-alias/result.json)。

### R2-04 — [P2] 把 panel 当作 API 对象字面量检查，拒绝合法本域根节点

类型：本轮修复引入的误报。定位：[scripts/architecture/rules.js:307](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:307)。

```js
const panel = document.getElementById('bank-statement-panel');
window.__bankStatementController.createBankStatementController({
  panel, api: { import() {} }
});
```

原配置的 panel 有 querySelector/querySelectorAll 方法清单，新条件把所有 allowedApiFields 对应值都要求为 object，同时一概拒绝 call-result。真实 DOM 查询返回值因此被报“不能注入完整可变对象或不透明 alias”。相同 fixture **旧版零违规，新版报 ARCH-RENDERER-SCOPE**；VM 使用节点 stub，验证传入的正是该本域节点。改成没有 DOM 身份的对象字面量反而通过。

G3 TechDoc §4 明确 panel 是本域根节点，G8 §4.4 并未把它改为 API 方法袋。此项会阻断按设计落地的控制器装配。应区分本域 DOM 节点合同与 scoped API 的对象字段合同，并验证可识别的本域节点来源。

证据：[actualPanel / literalPanel 新旧对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/renderer-incremental-probes.json)。未把 VM 节点 stub 视为真实 Electron DOM 验收。

### R2-05 — [P2] 精确挑选单个 desktopApi 方法仍被当成完整对象拒绝

类型：本轮修复引入的误报。定位：[scripts/architecture/rules.js:320](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:320)。

```js
window.__bankStatementController.createBankStatementController({
  api: Object.freeze({ import: window.desktopApi.bankStatement.import })
});
```

对象只暴露白名单中的 import 方法，来源可静态追溯；preload 中该方法是直接 IPC arrow function。新逻辑仅因成员来源 chain 包含 desktopApi，就报“方法来源无法解释”。相同 fixture **旧版通过、新版拒绝**；VM 验证 apiKeys 只有 import、hasRun=false，方法实际可调用。改成额外包装函数则又通过。

违反 G8 TechDoc §4.4、G3 §4 对 composition root 按需挑选命名方法的合法 scoped API 合同。应区分完整 API/命名空间对象与精确函数成员，保留完整对象拒绝，不强制为每个合法函数新增包装器。

证据：[directMember / explicitWrapper 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/renderer-incremental-probes.json)；真实 preload 方法见 [src/preload.js:236](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/src/preload.js:236)。

### R2-06 — [P2] 工厂存在性以内部函数名判断，误报正常公开导出

类型：本轮修复引入的误报。定位：[scripts/architecture/contracts.js:20](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/contracts.js:20)；激活检查入口 [scripts/architecture/rules.js:138](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:138)。

```js
window.createProbe = function buildController(options) { return options; };
// 同样受影响：
const buildController = options => options;
window.createProbe = buildController;
```

配置公开 factory.name=createProbe，且生产调用 window.createProbe({api:{read(){}}}) 存在。factoryPresent 只看 functionNodes 末段名称，因此把 buildController 判为不存在的 createProbe。

两个真实 Git fixture 中 **旧 CLI exit 0，新 CLI exit 1**；匿名表达式对照新旧均通过。VM 证明两种定义都导出 function，api.read() 返回 1。违反 TechDoc 对 const alias 支持、公开工厂合同与合法重排不误报的要求（G8-AC-10/12）。应从公开导出绑定解析到真实函数，同时保留不存在工厂和旧消费者未迁移的拒绝。

证据：[真实 Git CLI 差分及 VM 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/history-factory-alias-result.json)、[完整 CLI 输出](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/history-factory-alias-cli.log)。

### R2-07 — [P2] 同步 provider 后的 async consumer 被错误拒绝

类型：本轮修复引入的误报。定位：[scripts/architecture/rules.js:330](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:330)，关键条件在第 332 行。

```html
<script src="src/service.js"></script>
<script async src="src/controller.js"></script>
```

前面的同步 provider 完成执行后，HTML 解析器才到达后面的 consumer 标签，先行关系确定。新 guaranteedBefore 却仅因 consumer.async 就返回 false。相同 fixture **旧版通过，新版报“service 未在消费者之前加载”**。

异步 provider 对同步 consumer、async consumer 先出现这两种不保证顺序的对照仍正确拒绝；双方合法 defer 顺序通过。应根据 provider 是否已前序同步执行判断，不能独立以 consumer.async 作为否决条件。违反 TechDoc §3.3 / G8-AC-10 对正确脚本装配的要求。

证据：[r7-good-sync-before-async 及反向对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/scanner-incremental-probes.json)。执行顺序按 HTML 标准语义判断；此次未取得浏览器实跑输出，不宣称 GUI 验收。

### R2-08 — [P2] fork 的显式 cwd 未参与目标解析，依赖图检查了错误文件

类型：原 R8 路径解析问题的余漏。定位：[scripts/architecture/scan.js:433](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:433)、[scripts/architecture/scan.js:536](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:536)。

```js
const { fork } = require('node:child_process');
const path = require('node:path');
fork('./src/worker.cjs', { cwd: path.join(__dirname, 'jobs') });
```

fixture 同时存在 src/worker.cjs、src/src/worker.cjs、src/jobs/src/worker.cjs。真实 Node 子进程从最后一个文件输出 expected-worker，exit 0；新 scanner 却形成 **launcher → src/worker.cjs**，零违规且没有未解析诊断。旧 scanner 选择 src/src/worker.cjs；修复将错误目标换成另一个错误目标。

这不是要求扫描器猜运行时 cwd：本例的 cwd 已完全静态可解析。忽略它会让 worker 闭包检查失去实际目标。违反 TechDoc §3.2 / G8-AC-08 对 child_process.fork 和准确 worker 边的要求。应处理 fork 的 options 重载及 cwd，不能确定时报告覆盖问题。

证据：[r8-explicit-fork-cwd 的扫描边与真实 Node 结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/scanner-incremental-probes.json)、[fixture launcher](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/scanner-fixtures/r8-explicit-fork-cwd/src/launcher.cjs)。

### R2-09 — [P3] textarea 中的结束标签文本可以提前结束 templateDepth

类型：原 R7 惰性内容解析的补充余项。定位：[scripts/architecture/scan.js:379](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:379)、[scripts/architecture/scan.js:399](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:399)。

```html
<template>
  <textarea></template></textarea>
  <script src="src/service.js"></script>
</template>
<script src="src/controller.js"></script>
```

textarea 文本模式中的 </template> 不能关闭外层 template。当前 tokenizer 未保持文本模式，却先减 templateDepth，认定后面的惰性 provider 已实际加载并返回零违规。旧版同样漏检，因此不计为新增回归。

建议支持相关 raw text / RCDATA 上下文，或对无法解释的结构报告 coverage；不必以此声称扫描器需要解析任意页面业务。关联 TechDoc §3.3 / G8-AC-10。优先级低于以上 P2。

证据：[r7-template-textarea 新旧结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/scanner-incremental-probes.json)。只验证 scanner 输出，HTML 语义为标准推断；本地隔离浏览器尝试未取得可用结果。

## 4. 允许位置与历史例外审计

本轮修复增加 **5 个 allowedSites、2 个 legacy exceptions**。已核对准确函数/callee/AST 指纹与真实职责：G1 onWorkerExit 为退出通知；G2 getBatch、flushOutbox、protectedPaths.concat、allowedTaskKeys 分别是 Archive 查询、公共 outbox、数组拼接和 action/task 绑定查询。

两个 G1 动态 operation 例外来自原 transport/execute 转发。通过只读 git show 对照固定 v3.2.9，相关 src/main.js 和 publication dispatcher 字节一致；active 状态不接受旧例外的逻辑与负向回归存在。**本轮未发现这些登记掩盖新违规或扩散到其他 AST 位置。** 当前共 114 个匹配例外，stale 0。

证据：[准确基线审计](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/rules-allowlist-source-audit.json)。此结论不等于认可未来 G1 激活时继续保留旧动态操作例外。

## 5. 实际验证与未执行边界

| 检查 | 本轮结果 |
|---|---|
| `node --test tests/unit/architecture/*.test.js` | **100 tests / 100 pass / 0 fail / 0 skipped**，20.95 秒；[完整日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/architecture-tests.log) |
| 当前冻结快照 check:architecture CLI | **exit 0**；685/685 文件、2254 字面量本地边、64 worker 边、5 global 边；[JSON 报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/architecture-check.json) |
| 规则激活/覆盖 | active 2、pending 21、partial 8；2 个已登记生成入口未解析、33 个已登记动态位置仍在报告中 |
| 独立复验 | 原10项最小反例、修复新增正反例、真实 Git CLI、VM/stub、Node Worker/fork；结果按问题逐项链接 |
| 差异与保护 | git diff --check exit 0；目标和快照零漂移；修复交付21文件指纹相符 |
| 完整 release-check | **本轮未运行；修复后的实现者记录也明确未运行**。上轮修复前的全量 PASS 不覆盖当前新内容 |

本次属于只读增量审查，已完成与检查器改动相称的完整架构专项及针对性反例，不用重复业务全量套件代替缺失反例。正式集成/PR-ready 前应在最终候选补完整 release-check。

G1–G7 生产治理尚未在此 v3.2.9 源码分支实际集成，pending/partial 本身不是缺陷。release 的路径、调用方、授权位置和 activationEvidence 对齐仍是后续集成工作；本次不对其他分支或正式 release 作通过结论。

未运行生产业务数据、Electron GUI、GitHub Windows workflow、安装包或 Excel/WPS 验收。上述运行证据来自临时合成 fixture，不能推导真实业务副作用已经发生。

可重放脚本及冻结检查器见 [证据说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/evidence/README.md)。后续修复建议先处理 R2-01/02/03/08 的漏检/错误目标，再处理 R2-04/05/06/07 的合法输入误报；原有效反例与合法行为对照都应保留。
