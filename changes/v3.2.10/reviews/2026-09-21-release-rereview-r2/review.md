# release/v3.2.10 第二轮增量审查

**结论：上轮退款／C3 确认框缺陷已关闭；G8 正式检查无法通过的直接问题已解除，但本轮确认 5 项 P2 守卫缺口，尚不能据此接受“G8 防倒退合同全部满足”。** 五项均有可复现的漏报，不是生产已发生越权或错误查询的结论。

本轮以 [G1–G8 Spec / TechDoc 索引](../../README.md)、[上轮审查](../2026-09-21-release-review/review.md)及[修复记录](../2026-09-21-release-repair/repair.md)为依据，独立审查当前未提交修复。源码、配置、测试及既有证据保持原样；本轮只新增此审查目录。

## 1. 冻结对象与范围

| 项目 | 本轮对象 |
| --- | --- |
| 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 | `release/v3.2.10` |
| HEAD / 上轮审查基线 | `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 正式版本事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 当前候选 | 上述 HEAD 加已有未提交修复；21 个 tracked 修改文件、5 个新增源码／测试文件，以及既有审查／修复证据 |
| 开始时间 | 2026-09-21 23:06:39，Asia/Shanghai |
| 输入保护 | [input-manifest.json](evidence/input-manifest.json) 冻结 3,958 个既有文件；[input-diff.patch](evidence/input-diff.patch) 保留 tracked 差异；最终补核 67 个非 ASCII tracked 文件与未变化的 HEAD blob 相同，枚举边界详见证据 README |

重点为上轮两项发现的关闭情况，以及为清除 G8 诊断而新增的调用闭包、Renderer 能力求值、配置激活、历史约束和 Toolbox 兼容导出。未对没有变化的全部业务算法重新做一次完整审查。并行审查按确认框行为、Renderer 守卫、非 Renderer 登记拆分，最终结果合并去重。

## 2. 上轮发现的复核

| 上轮发现 | 本轮判断 | 当前证据 |
| --- | --- | --- |
| R1 / P1：确认框使用非法 completed outcome，退款／C3 的导入或直接运行在业务前中断 | **关闭** | 真实句柄按 submitted 关闭，仅 closed 后继续业务；125 项相关单测、27 项真实 Electron 组合用例，以及 5 条独立回调路径探针通过 |
| R2 / P1：G8 与组合候选不一致，正式检查产生 2,195 条诊断 | **无法通过门禁的直接问题已解除；守卫有效性仍有下列 5 项 P2** | 本轮 CLI exit 0，31 active、0 pending/partial、0 诊断、0 stale；已有完整 release-check 的 1,698 个输入与当前 SHA-256 全部匹配 |

R1 的独立探针逐条验证退款导入、退款直接运行、C3 导入、C3 直接运行、网关场景选择，覆盖关闭拒绝、仍挂载但非栈顶、只提交一次、重复旧回调、替换后的新弹窗保护和导航失效。真实 Electron 使用实际 controller / dialog / bridge / host 与 DOM，业务 API 为隔离桩，不代表真实产品 Main 或资金文件全流程验收。

## 3. 新确认的问题

### RR2-01 [P2] 执行闭包漏掉静态数组回调，真实 raw DB 查询不再进入检查

**位置：** [contracts.js:232](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:232)、[contracts.js:292](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:292)。

**事实与触发：** 新的 `executionScopes()` 按实际调用收窄查询闭包，但 `resolve()` 处理 object 成员时没有相应的 array element 分支；静态数字索引及数组解构得不到函数目标。随后 `unresolvedCalls` 只收集特定未知计算属性，未将这种已丢失的调用作为 coverage 失败。下面的受保护读取入口会真实执行 SQL，但当前检查零诊断：

```js
// read.js — 受保护读取入口
const h = require('./helper');
exports.read = c => h.read(c);

// helper.js
const query = c => c.db.prepare('SELECT 1').all();
const handlers = [query];
exports.read = c => handlers[0](c);
```

将后两行改为 `const [run] = [query]; exports.read = c => run(c);` 同样漏报。独立探针使用真正的 `node:sqlite DatabaseSync(':memory:')`，两个反例均记录 `SELECT 1` 并返回查询结果。相同规则／fixture 下，HEAD 检查器各产生 1 条 `ARCH-BIZOP-QUERY`，当前各为 0。直接调用与默认参数回调的正向拒绝对照仍各为 1；只调用无 SQL 的 safe 导出当前为 0，说明不应简单回退到整模块误报。

**契约与影响：** [G8 Spec G8-AC-18](../../codex/v3.2.10-architecture-guardrails/spec.md)及 [TechDoc §4.9](../../codex/v3.2.10-architecture-guardrails/techdoc.md)要求受保护消费者中的 raw DB 查询被拒绝；当前 README 又承诺无法解释的执行目标失败关闭。实际调用存在但检查图遗漏，会允许 G5 消费者经 helper 重新绕回原始查询。这里未确认当前业务源码已有该写法。

**处置：** 补齐可静态确定的数组元素／解构函数传播；在受保护范围内对无法解释的执行目标显式报 coverage。负例应断言真实 SQL 已执行且门禁拒绝，并保留 safe 导出不误报的对照。

**证据：** [探针](evidence/query-execution-probe.cjs)、[原始结果](evidence/query-execution-probe.json)、[归档脚本独立重跑](evidence/query-execution-reproduced.json)。结果中的 class-this / object-this 是同一探索的补充样例；本项只以无动态 this 歧义的固定数组／解构反例成立。

### RR2-02 [P2] bound factory 丢失预绑定实参，完整 desktopApi 被判断为窄 API

**位置：** [renderer-contracts.js:48](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:48)，后续实参绑定在 [同文件:155](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:155)。

**事实与触发：** 对 `bound-function` 的求值仅返回 target，丢弃 bind 时已固定的实参；求工厂返回值时再仅使用调用处实参绑定参数：

```js
function provide(api) { return api; }
const bound = provide.bind(null, window.desktopApi);
window.BankStatementController.createBankStatementController({
  api: bound({ run() {} })
});
```

JavaScript 实际返回完整 `desktopApi`；检查器却把 `api` 绑定为后面的 `{ run() {} }`，因而通过。VM 捕获对象确认真实传入完整 API。使用当前全部 20 个 Renderer boundary 原文、真实 BankStatement 工厂名及内存 AST overlay，基线 0 诊断，注入反例后仍 0；HEAD scanner / HEAD 配置在追加注入点产生 1 条诊断。

**契约与影响：** 违反 [G8 Spec G8-AC-05](../../codex/v3.2.10-architecture-guardrails/spec.md)和 [TechDoc §4.4](../../codex/v3.2.10-architecture-guardrails/techdoc.md)的窄 API 与无法解释来源失败关闭要求。完整预加载能力可作为“合法 scoped API”通过本次新工厂求值路径；这不是对当前 controller 已调用越权方法的判断。

**处置：** 按 JavaScript 顺序保留并组合多层预绑定实参；不能准确解释时拒绝该结果，不能将 bound factory 当成普通函数求值。

**证据：** [真实配置探针](evidence/renderer-realconfig.cjs)、[结果 bound_factory](evidence/renderer-realconfig.json)、[通用 VM 探针](evidence/renderer-probes.jsonl)。

### RR2-03 [P2] 按变量名检查对象变更，工厂返回和静态 spread 漏掉别名写入

**位置：** [renderer-contracts.js:62](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:62)、[同文件:74](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:74)。

**事实与触发：** mutation 和 helper escape 只比较描述链名称及所属函数，`api` 与 `alias` 实际是同一对象但名称不同，别名写入被跳过：

```js
function provide() {
  const api = { run() {} };
  const alias = api;
  alias.outsideScope = window.desktopApi.outsideScope;
  return api;
}
window.BankStatementController.createBankStatementController({
  api: provide()
});
```

VM 确认收到 `run` 和未授权的 `outsideScope`，当前真实配置零诊断，HEAD 注入点 1 条诊断。另一个变体先通过 alias 写入，再传入 `api: { ...api }`，HEAD 2 条诊断、当前 0。`Object.assign(alias, desktopApi)` 也可避开 escape 判断。

**契约与影响：** [TechDoc §4.4](../../codex/v3.2.10-architecture-guardrails/techdoc.md)及本次[Renderer 对齐说明](../2026-09-21-release-repair/renderer-policy/mapping.md)要求初始声明后的成员写入计入能力集合，未知修改 helper 接管时失败关闭。新增的命名工厂／静态 spread 支持把本应拒绝的额外能力误认为合法集合。

裸对象 alias 的相关漏检在 HEAD 已存在；本项限定于本轮新增工厂返回／spread 支持后从拒绝变成通过的两条路径，不将既有缺口冒充新回归。

**处置：** 以绑定及对象身份追踪别名、成员写入与逃逸，或对不能排除变更的返回／spread 对象保守拒绝。

**证据：** [真实配置结果 factory_alias / spread_alias](evidence/renderer-realconfig.json)、[通用 mutation / Object.assign 结果](evidence/renderer-probes.jsonl)、[HEAD 对照](evidence/renderer-head-probes.jsonl)。

### RR2-04 [P2] 新增 initialInfo 参数授权缺少数据合同，嵌套完整 API 可以通过

**位置：** [boundaries.json:1026](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/boundaries.json:1026)，值检查为 [rules.js:339](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:339)。

**事实与触发：** Statement 工厂新增允许 `initialInfo`，但没有相应值合同。无 `allowedApiFields` 的普通参数只检查最外层 kind / chain。即使 resolver 已把内层 `window.desktopApi` 标成 `unknown('whole-desktop-api')`，以下外层 object 仍会通过：

```js
window.StatementController.createStatementController({
  initialInfo: { api: window.desktopApi }
});
```

真实配置与 AST overlay 的当前结果为 0 诊断，VM 确认 `received.initialInfo.api === desktopApi`。HEAD 实际配置在同一注入点拒绝“未授权字段 initialInfo”。浅层检查在人工宽松参数配置下此前就存在；本次新增真实参数授权使这个入口进入 active 边界。

**契约与影响：** [Renderer 对齐说明](../2026-09-21-release-repair/renderer-policy/mapping.md)明确 `initialInfo` 来自 `app:get-info` 的可序列化数据，不作为可调用 authority。该入口却允许承载完整 API，违反 G8-AC-05。当前正常生产装配传入的仍是 info 数据，尚未发现它实际包含越权能力。

**处置：** 为这种参数约束已核验的 IPC 数据或递归纯数据；拒绝嵌套 unknown、API、state、elements。应允许合法初始数据，不应仅删除 initialInfo 登记来消除反例。

**证据：** [真实配置结果 initial_info_nested](evidence/renderer-realconfig.json)、[对应复现脚本](evidence/renderer-realconfig.cjs)。

### RR2-05 [P2] G1 激活配置仍限制已不存在的内部函数，遗漏实际恢复入口

**位置：** [boundaries.json:3634](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/boundaries.json:3634)；判定使用 [rules.js:247](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:247)。

**事实与触发：** 已标 active 的 `publication-recovery-entry` 保护 `prepareToolboxPublication`，但其内部 operations 仍只有 `recoverPendingInternal`。当前源码不存在这个函数；真正能产生恢复副作用的内部入口是 [recoverPreparingIntent:1684](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/main-process/toolbox-output-publication.js:1684)、[recoverFinalizingIntent:1810](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/main-process/toolbox-output-publication.js:1810)、[recoverOneJournal:1897](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/main-process/toolbox-output-publication.js:1897)。

采用完整原样的当前 G1 boundary（包括 active、restrictedApis、protectedScopes、allowedSites），只在临时目录创建满足入口／consumer／evidence 存在性的小型 fixture：

| prepare 内调用 | 当前诊断 |
| --- | --- |
| recoverPendingInternal(runtime, entry, {}) | 1 条 ARCH-PUBLICATION-RECOVERY-ENTRY |
| recoverOneJournal(runtime, entry, {}) | 0 |
| recoverPreparingIntent(runtime, entry, {}) | 0 |
| recoverFinalizingIntent(runtime, entry, {}) | 0 |

四种输入均 0 parseErrors、0 unresolved。旧名字产生预期拒绝，当前真实名字不受限制。

**契约与影响：** [G8 Spec G8-AC-16 / TechDoc §4.7](../../codex/v3.2.10-architecture-guardrails/techdoc.md)和 [G1 TechDoc §4.5](../../codex/v3.2.10-application-recovery/techdoc.md)要求 prepare 重新引入隐式无授权恢复时被门禁拒绝。此项原有名称失配未在本次 active 登记中纠正，当前守卫不能实现该防倒退承诺。

现有生产外层 `recoverPendingToolboxPublications` 在 2088 校验 authority、2107–2127 重验 grants，随后才在 2139 调用 recoverOneJournal。内部函数不自行验 authority，可以执行取消、回滚和 cleanup。因此本项是防倒退缺口，**没有证据表明当前恢复正在绕过 owner 授权**。

**处置：** 同步真实内部能力列表，并把合法调用约束在完成授权校验的路径；为 prepare 直调当前三个内部函数补负例。不能只保留对旧名字的测试。

**证据：** [独立脚本](evidence/g1-internal-probe.cjs)、[原结果](evidence/g1-internal-probe.json)、[归档脚本重跑](evidence/g1-internal-reproduced.json)。

## 4. 验证记录与证据边界

所有仓库命令均在第 1 节 release worktree 中执行。表中专项可能互相重叠，不相加为总测试数。

| 检查 | 来源与结果 | 证据 |
| --- | --- | --- |
| 正式 architecture CLI | **本轮执行**；exit 0；765/765 文件解析；31 active、0 pending/partial、0 诊断、0 stale | [JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| architecture 全部单测 | **本轮执行**；170 PASS、0 fail、0 skip | [日志](evidence/architecture-tests.log) |
| G3 相关单测 | **本轮执行**；125 PASS、0 fail、0 skip | [日志](evidence/g3-unit.log) |
| 真实 Electron 确认框组合 | **本轮执行**；27/27 PASS；隔离运行目录和桩业务 API | [日志](evidence/g3-electron.log) |
| 独立确认框探针 | **本轮执行**；5 条按钮路径 × 6 类生命周期检查通过 | [脚本](evidence/g3-independent.cjs)、[JSON](evidence/g3-independent.json) |
| 配置对齐与 XLSX 兼容 | **本轮执行**；15 PASS、0 skip | [日志](evidence/config-xlsx.log) |
| 历史保护专项 | **本轮执行**；3 PASS、0 skip，已包含在 architecture 总套件范围内 | [日志](evidence/policy-history.log) |
| G8 独立反例 | **本轮执行并重跑归档版本**；5 项问题均观察到预期漏报；脚本 exit 0 表示取证完成，不表示反例被正确拒绝 | 上述各 finding 的脚本和 JSON |
| 完整 release-check | **复用已有当前候选证据，本轮未重跑**；2026-09-21 22:21:50–22:45:10，exit 0；8944 单测通过、0 失败、4 Windows 条件跳过；68/68 集成脚本通过 | [原完整记录](../2026-09-21-release-repair/release-check-result.json)、[原验证表](../2026-09-21-release-repair/verification.json)、[输入哈希比对](evidence/gate-evidence-comparison.json) |

完整门禁的 1,698 个源码／配置／测试输入全部与当前匹配，HEAD 也相同；因此可复用其组合候选证据，未为了重复计数再执行约 23 分钟的同一全套。PASS 说明现有验证通过，不能反证本轮独立反例揭示的测试缺口。

当前 CLI 仍披露 2 个未解析加载和 33 个动态位置，由既有准确生成／动态合同覆盖；本轮没有把它们隐去或当成零未知。保留的 2 条历史 SCC 例外未扩宽。

复现命令、脚本使用边界与结果定位见 [evidence/README.md](evidence/README.md)；结构化清单见 [verification.json](verification.json)。Renderer 历史对照仅统计追加注入点，HEAD scanner / HEAD 配置对当前生产源本身的 146 条基线诊断另列，没有算进反例的 1／2 条结果。

## 5. 已排除与未覆盖

- 未发现确认框修复引入重复业务、旧回调关闭新弹窗、非栈顶绕行、busy 拒绝后继续业务的问题。
- Toolbox 中性 helper 改为直接再导出后，全部公开键与引用身份验证通过；没有改变 Excel 生成算法。
- G7 登记按准确 source / target / importedNames 收敛，没有发现整目录放行；G4/G6 的入口和依赖限制仍在。
- namespace 的具名授权、两条历史 SCC 例外、历史防放宽测试未发现本轮新的独立问题。
- 直接 controller factory 的 call/apply/bind 漏检、人工宽松参数配置下的浅层漏检等既有候选，不作为本轮新增实现回归计数。RR2-04 明确落在新增生产参数授权缺少数据合同。
- 本轮没有验证真实产品 Main 端到端、Windows 文件锁／安装包、Excel／WPS 或资金人工验收；本轮专项和历史全门禁均不能替代这些验收。
- 未修改源码／测试／配置，未提交、推送、合入 main、升版、打标签或发布。交付前全部既有输入和 HEAD 保持，详见 [preservation-final.json](preservation-final.json)。

## 6. 建议的关闭条件

五项问题分别修正后，原样复验本轮反例必须产生相应规则或 coverage 拒绝，同时保留合法 scoped API、IPC 初始数据、query facade、未执行 policy 和正确授权恢复的对照通过。再对最终修复候选运行必要的专项及正式门禁，更新输入快照；不要把“诊断清零”单独作为守卫有效性的验收。
