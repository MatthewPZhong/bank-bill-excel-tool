# release/v3.2.10 第三轮增量审查

**结论：第二轮 5 项发现的原始反例均已被当前检查器拒绝，bind 修复及原数组／别名／数据／恢复入口回归有效；本轮仍新确认 5 项 P2 相邻守卫缺口。** 这些是修复后仍可复现的覆盖遗漏，不统一认定为最近一轮修复首次引入。当前自动门禁通过，不能据此接受 G8 防倒退合同全部闭环。

本轮是独立只读审查，对照 [第二轮报告](../2026-09-21-release-rereview-r2/review.md)、[修复记录](../2026-09-21-release-r2-repair/repair.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md)及 [G8 TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md)。仅新增本审查目录；未修改生产源码、检查器、测试或配置。

## 1. 审查快照

| 项目 | 固定对象 |
| --- | --- |
| 工作目录 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 实际候选 | HEAD 加已有未提交修复；不能仅以 HEAD 表示本次审查内容 |
| 事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 开始冻结 | 2026-09-22 01:16:15，Asia/Shanghai |
| 文件保护 | 4,071 个已有文件以 NUL 分隔枚举后冻结 SHA-256，见 [input-manifest.json](evidence/input-manifest.json)；tracked 差异见 [input-diff.patch](evidence/input-diff.patch) |
| 相对上轮 | 11 个原有检查器／配置／说明文件变化，新增 `release-rereview-r2.test.js`；生产 `src/` 文件未变 |
| 完整门禁输入 | 当前 1,699 个输入与最新修复后的完整门禁逐一匹配；[比对结果](evidence/gate-evidence-comparison.json) |

本轮重点为 RR2-01～05 的原样复验和其修复逻辑附近的独立反例，不重复无变化业务模块的全部审查。分工覆盖查询执行闭包、Renderer 对象与 bind、递归数据合同、G1 能力身份，主审合并去重。

## 2. 第二轮发现的关闭情况

| 旧项 | 原反例复验 | 保留的边界 |
| --- | --- | --- |
| RR2-01 固定数组索引／解构漏掉 raw DB 查询 | 两条原反例现在均报 ARCH-BIZOP-QUERY；call/apply、bind 参数、已知静态 spread 等独立对照也拒绝 | 未知长度 spread 的位置推断仍错误，见 RR3-01 |
| RR2-02 bind 丢失预绑定实参 | 原 bound factory 完整 API 反例被拒绝；合法多层窄能力对照通过 | 本轮未确认该修复的新问题 |
| RR2-03 原顶层 const alias / factory / spread 的变更漏检 | 原反例均拒绝，相关 RR2-02/03 定向单测 8/8 PASS | 嵌套对象虽然有 AST 身份，仍被 chain 条件跳过，见 RR3-02 |
| RR2-04 initialInfo 普通嵌套 API 放行 | 原 `{initialInfo:{api:desktopApi}}` 被拒绝；定向 7/7 PASS | 特殊自有键和真实 config.initialBillCategory 路径仍漏检，见 RR3-03/04 |
| RR2-05 当前内部恢复函数名未登记 | 原 4 个旧／新名字均拒绝，3 个现行入口的 direct/alias/bind 9/9 PASS | 已知受限函数经静态容器／helper 参数后仍丢失身份，见 RR3-05 |

原确认框修复的生产源和测试未变，本轮沿用前两轮已限定范围的关闭结论，没有重复声称完成真实 GUI 或资金验收。上表的“原反例关闭”不等于整个保护类别已不存在遗漏。

## 3. 确认的问题

### RR3-01 [P2] 未知长度数组 spread 被压成一个元素，错误选中后续安全回调

**位置：** [scan.js:338](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/scan.js:338)，关联 [contracts.js:237](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:237)。

**事实：** 非直接数组字面量的 spread 被表示为单个 `unknown('opaque-array-spread')`。但其运行时长度不是 1，后续元素的位置因此被错误固定。新数组解析会把错误位置的 safe 回调当成已解释目标，既不追踪实际 query，也不报 coverage：

```js
const query = c => c.db.prepare('SELECT 1 AS value').all();
const safe = () => [];
function invoke(values, c) {
  const handlers = [...values, safe];
  return handlers[1](c);
}
exports.read = c => invoke([safe, query], c);
```

运行时 handlers 为 `[safe, query, safe]`，索引 1 执行 query；扫描器得到的相当于 `[unknown, safe]`，索引 1 被当成 safe。返回数组的工厂再 spread 也有同类漏报。

**独立验证：** 在临时副本复制完整生产 src、index.html、package.json，使用当前全部 31 个边界和真实 allowlist；从实际受保护的 `compute-inputs.js` 增加对临时 helper 的读取。基线 0 诊断；上述反例真实执行内存 SQLite SQL 后仍 0 诊断；完全已知静态 spread 对照执行同一 SQL 并产生 1 条 ARCH-BIZOP-QUERY；safe 对照无 SQL、无诊断。未向仓库写入该 helper。

**合同与影响：** G8-AC-18、TechDoc §4.9、architecture README 的未知执行目标失败关闭要求。该路径让 G5 raw DB 读取通过机器门禁。没有证据表明当前业务使用此反例。旧修复前探针也漏报此路径，因此将它列为原数组修复的相邻缺口，不称本轮首次引入。

**建议：** 保留 spread 的长度／位置不确定性；能代入实际参数或工厂返回时正确展开，否则对依赖该 spread 位置的调用拒绝或报告 coverage，不能假定占一个槽位。

**证据：** [最小探针](evidence/r3-query-probes.cjs)、[最小结果与旧快照对比](evidence/r3-query-probes.json)、[完整实际配置探针](evidence/r3-query-realconfig.cjs)、[完整结果](evidence/r3-query-realconfig.json)。

### RR3-02 [P2] 嵌套 scoped 对象缺少名称链，跳过已有的身份与变更检查

**位置：** [renderer-contracts.js:89](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:89)、[同文件:99](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:99)。

**事实：** 两个分支仍要求 `value.chain?.length`。读取静态嵌套成员时，scanner 返回拥有 `objectStart`、没有 chain 的对象描述；即使与 alias 的 AST 身份相同，`sameObject()` 也没有机会执行：

```js
const envelope = { api: { run() {} } };
const alias = envelope.api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({
  api: envelope.api
});
```

**独立验证：** 实际 20 个 Renderer 边界基线 0 诊断；`nested_alias`、`nested_spread`、`nested_helper_escape` 三例均 0 新诊断，VM 捕获的 API 均含 run / outsideScope，额外方法真实可调用。AST 记录显示 selected.chain=null、writeBase.chain=['alias']，两者 objectStart 同为 20。静态 spread 及 Object.assign 修改同一嵌套对象也受影响；安全嵌套对照通过。

**合同与影响：** G8-AC-05、TechDoc §4.4 明确别名与静态 spread 需要解释来源，能力变更／未知 helper 接管不能只按初始字面量放行。当前检查仍允许嵌套对象携带额外能力。HEAD 版本中 alias/helper 两例也漏报，而 nested spread 曾被拒绝；本项只说明当前遗漏，不把全部变体算作新退化。

**建议：** 对有 AST 对象身份的成员对象同样执行变更和逃逸检查；无法可靠追踪时拒绝，不以没有变量名称链为跳过条件。

**证据：** [实际配置脚本](evidence/r3-renderer-realconfig.cjs)、[实际配置与 VM 结果](evidence/r3-renderer-realconfig.json)、[对象身份](evidence/r3-renderer-object-identity.json)。

### RR3-03 [P2] 普通自有键 "__proto__" 在分析器属性字典中消失，完整 API 被当成纯数据

**位置：** [renderer-contracts.js:64](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:64)、[同文件:77](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:77)，递归判断在 [同文件:198](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:198)。

**事实与最小反例：**

```js
window.StatementController.createStatementController({
  initialInfo: { ["__proto__"]: window.desktopApi }
});
```

computed 字符串键在运行时是普通自有属性。VM 确认 ownSpecialKey=true、sameApi=true、extraCallable=true、prototypeHasOutsideScope=false；不需要预先污染原型。分析器却用普通 `{}` 存属性，并执行 `properties[key] = descriptor`，该特殊键触发内部字典的原型 setter，没有作为自有键保存；后续 Object.values 看不到其值，递归纯数据检查便通过。

**独立验证：** 实际 20 个 Renderer 边界基线 0，旧普通 nested API 反例产生 1 条拒绝，而 computed 自有键反例 0 诊断。非 computed prototype setter 和更深嵌套变体为同一问题的补充，不另计 finding。

**合同与影响：** TechDoc:106 与 architecture README:88 明确初始数据必须递归纯数据或明确 app:get-info 数据，嵌套 API 必须拒绝。本项使原始实参完整持有 API 时仍通过“纯数据”判定；没有据此认定产品发生原型污染或实际越权。

**建议：** 使用无原型字典或能保留所有自有字符串键的等价存储；对真实对象字面量的 prototype setter 语义单独处理，不能混同于普通自有键。

**证据：** [数据探针](evidence/r3-data-probes.cjs)、[VM 自有键证据](evidence/r3-data-proto-vm.json)、[实际配置结果 prototype_computed](evidence/r3-data-realconfig.json)。

### RR3-04 [P2] initialBillCategory 数据校验位于错误层级，真实 config 路径仍允许能力

**位置：** [rules.js:332](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:332)，宽松处理在 [同文件:347](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:347)。

**事实：** 新分支检查顶层 initialBillCategory，但生产 [renderer.js:500](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/src/renderer.js:500) 装配的是 `config.initialBillCategory`，来自 info.reconIdFixBillCategory。该真实路径走通用 scoped config 逻辑，函数直接合法、任意频道 ipc-data 也合法：

```js
window.ReconIdFixController.createReconIdFixController({
  config: { initialBillCategory: () => window.desktopApi }
});
```

把值换成 `window.desktopApi.archiveCenter.getSettings()` 也通过；真实 preload 映射为 `archive-center:get-settings`，不是规定的 `app:get-info`。

**独立验证：** 当前全部 Renderer 配置基线 0，上述两例均 0 诊断；正常字符串与 app:get-info 对照继续通过。正式新增测试使用顶层 initialBillCategory 的人工工厂参数，未覆盖生产嵌套路径。

**合同与影响：** [TechDoc:106](../../codex/v3.2.10-architecture-guardrails/techdoc.md)和 architecture README:88 明确同时约束 initialInfo / initialBillCategory；控制器将后者作为分类数据读取，不能按可调用能力授权。这里按明确合同和实际装配判定，不是仅凭字段名推断类型。现有正常生产装配仍传入分类数据。

**建议：** 在真实字段路径上应用递归数据及指定 IPC 来源检查，并增加真实 ReconID 工厂配置的正反对照。

**证据：** [实际配置脚本](evidence/r3-data-realconfig.cjs)、[category_callable / category_other_ipc 结果](evidence/r3-data-realconfig.json)、[12 个有界数据探针](evidence/r3-data-probes.jsonl)。

### RR3-05 [P2] 已登记的 G1 受限恢复函数经静态容器或参数转发后丢失身份

**位置：** [rules.js:256](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:256)，相关目标求解为 [contracts.js:70](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:70)。

**事实：** G1 对单个调用求 callableOrigins，未代入 helper 的实参能力；静态数组元素也不能解析成受限目标。parameter 虽被标为 known，targets 却为空，后续不会命中 internal 限制，也不产生 coverage：

```js
function prepareToolboxPublication(runtime, entry) {
  function invoke(fn, r, e) { return fn(r, e, {}); }
  return invoke(recoverOneJournal, runtime, entry);
}
```

`const list = [recoverOneJournal]; list[0](runtime, entry, {})`、identity 返回参数和跨文件 helper 同样漏报。

**独立验证：** 采用完整原样 active G1 boundary 和最小存在性 fixture。12 种写法都真实执行一次内存恢复 stub；direct、alias、bind、call、apply、静态对象成员、helper 内直接调用、返回词法目标的 factory 共 8 种均正确拒绝；静态数组、helper 参数、identity 返回参数、跨文件 helper 共 4 种零诊断。所有 fixture 为 0 parseErrors / unresolved。没有执行真实恢复或操作业务文件。

**合同与影响：** G8-AC-16、TechDoc §4.7 明确 prepare 不能形成隐式无授权恢复入口，且负例覆盖“经 helper 绕回”；README 要求受限操作按能力身份匹配、未解释受保护结构失败关闭。这里是源码内已知受限函数的有限静态透传，不要求证明任意运行时 callback。README 关于 Main/G5 数组支持没有被当成 G1 的独立全语法承诺。

当前生产授权链未发现绕过：2088 的 verify、2107–2127 的全部 grants 校验仍先于 2139 的恢复调用；新增 6 处 allowedSites 各精确匹配现有合法位置。本项是机器防倒退缺口。

**建议：** 为已知受限能力保留经过静态容器和实参／返回值后的身份，或在不能解释其受保护执行路径时报 coverage；准确合法位置不得扩展为 prepare 的通用许可。

**证据：** [12 形式脚本](evidence/r3-g1-callback-probe.cjs)、[输出](evidence/r3-g1-callback-probe.json)、[真实配置及 6 个允许位置核对](evidence/r3-g1-actual-config-baseline.json)。

## 4. 验证结果

| 验证 | 本轮结果／来源 |
| --- | --- |
| 全部 architecture 单测 | 本轮执行，204/204 PASS，0 fail / skip；包含新增 34 项回归。[日志](evidence/architecture-tests.log) |
| 正式 architecture CLI | 本轮执行，765/765 解析、31 active、0 pending/partial、0 诊断、0 stale；2 个既有未解析加载和 33 个动态位置继续由准确合同覆盖。[JSON](evidence/architecture-check.json) |
| 原第二轮查询反例 | 本轮原样执行，固定数组和解构现均拒绝，safe 仍通过。[输出](evidence/r2-query-probe-recheck.json) |
| 原 Renderer 反例 | 本轮原样执行，bound factory、factory alias、spread alias、普通 initialInfo 嵌套 API 均拒绝。[输出](evidence/r3-renderer-original-realconfig.json) |
| 原 G1 反例 | 本轮原样执行，4/4 拒绝。[输出](evidence/r3-g1-original-probe.json) |
| 定向回归 | RR2-02/03 8/8、RR2-04 7/7、RR2-05 9/9；均已包含于 204 总套件，不相加计数 |
| 新独立反例 | 本轮实际配置、AST 和运行时证据确认上述 5 项；脚本 exit 0 表示取证成功，不代表反例被门禁正确拒绝 |
| 完整 release-check | **本轮未重跑，复用最新修复候选的匹配证据**：2026-09-21 23:59:32 至 2026-09-22 00:19:13，exit 0；8978 单测通过、0 失败、4 Windows 条件跳过，68/68 集成脚本通过。[原始记录](../2026-09-21-release-r2-repair/release-check-result.json) |

完整门禁的 1,699 个输入及 HEAD 与本轮候选全部一致；不将旧轮 8,944 的结果叠加或冒充本轮结果。完整门禁的集成计数为 2,901/2,901，另 1 个成功脚本无用例计数，Renderer 生命周期为 233/233；这些均为该次历史执行数据，不是本轮重新启动 Electron 的结果。

结构化验证命令见 [verification.json](verification.json)，复现方式及探针范围见 [evidence/README.md](evidence/README.md)。报告区分真实 SQLite 查询、VM 实参／副作用 stub、真实配置静态检查，不将它们写成产品 Main 端到端验收。

## 5. 排除项、保护与关闭条件

- 多层 bind 的顺序、原顶层 alias 修复、静态数组已知位置、原 G1 函数名登记均有拒绝／合法对照；本轮没有撤销这些已证实的修复。
- query 探针中的数组成员后写入、旧 class-this / object-this 等探索结果不另列 finding；本轮查询项只以未知长度 spread 误定位置这一清楚根因收敛。
- 数据字段中 computed "__proto__" 与非 computed 原型 setter 变体合并计为一个属性存储问题。
- schema / policy-history 未相对本次修复前快照变化，本轮未发现新的配置历史放宽；生产 src/ 未变。
- 4,071 个冻结文件、HEAD 和原 tracked 差异在交付前保持；本轮目录之外无新增文件，见 [preservation-final.json](preservation-final.json)。
- 未提交、推送、开 PR、合入 main、升版、打标签或发布。真实产品 Main、Windows／安装包、Excel／WPS 和资金人工验收未执行，也不由本次静态复查替代。

建议以本轮归档反例作为后续修复的独立输入：违规形式应明确拒绝或 coverage 失败，安全对照继续通过，然后对最终修复候选执行必要专项和正式门禁。五项守卫缺口未关闭前，不以 active 数量或零诊断替代合同验收。

