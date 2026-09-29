# release/v3.2.10 第四轮增量审查

**结论：第三轮五项发现的原始反例均已被修复，本轮确认 3 项 P2：两项相邻漏报，以及一项最近修复新增的误报。** 数据合同与未知数组 spread 的确认修复有效；工厂结果身份和 G1 隐式回调入口仍有缺口。237 项架构测试与正式 CLI 均通过，不足以反证本轮独立反例。

本轮依据 [第三轮报告](../2026-09-22-release-rereview-r3/review.md)、[R3 修复记录](../2026-09-22-release-r3-repair/repair.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md)和 [TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md)，开展独立只读增量审查。没有修改生产源码、检查器、测试、配置或既有证据。

## 1. 固定对象与范围

| 项目 | 本轮对象 |
| --- | --- |
| 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 候选内容 | 上述 HEAD 加已有全部未提交修复 |
| 上一正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结时间 | 2026-09-22 10:05:46，Asia/Shanghai |
| 冻结输入 | 4,142 个既有文件 SHA-256；[清单](evidence/input-manifest.json)和 [tracked 差异](evidence/input-diff.patch) |
| 相对 R3 审查 | 10 个原有检查器／说明／策略结果文件变化，新增 release-rereview-r3.test.js；生产 src、机器边界、例外、schema 和 policy-history 保持 |
| 最新完整门禁证据 | 1,700 个输入和 HEAD 与当前全部匹配；[逐文件比对](evidence/gate-evidence-comparison.json) |

本轮重点是实际修复增量、原样复验、有限相邻反例与合法对照。未对没有变化的全部业务模块重做全量代码审查，未把任意运行时 this、反射或跨文件动态对象身份的既有证明边界扩展为本轮任务。

## 2. 上轮发现复核

| 上轮发现 | 本轮结果 |
| --- | --- |
| RR3-01 未知长度 spread 误定数组索引 | 原完整 31 边界探针现在产生 ARCH-STATIC-COVERAGE；完全静态危险数组报查询违规，safe 无 SQL 且无诊断。该原问题关闭。 |
| RR3-02 嵌套对象因无 chain 跳过变更 | 原 nested alias / spread / helper 逃逸均被拒绝，相关定向回归 7/7 PASS；本地普通工厂结果别名也已补齐。但更进一步的 bound/member 组合仍漏报，且新增实例混淆，见 RR4-01/02。 |
| RR3-03 普通自有 "__proto__" 键消失 | 当前 scanner、Renderer、模块导出属性字典均为无原型字典；原 computed/literal 反例在真实配置下均拒绝，合法纯数据特殊键/null prototype 通过。原问题关闭。 |
| RR3-04 initialBillCategory 校验位置错误 | 规则已落在真实 config.initialBillCategory 叶路径；函数及其他 IPC 拒绝，分类数据和 app:get-info 通过。原问题关闭。 |
| RR3-05 G1 静态容器／参数透传丢失能力 | 原 12 类反例全部拒绝；未选中成员、只传递不执行成员、同名普通函数仍通过。直接交给原生迭代器的回调仍遗漏入口身份，见 RR4-03。 |

两项数据合同的定向测试 13/13 PASS，原 12 例与新 10 例有界对照符合合同。另反证了“opaque 数组被当作空纯数据”候选：参数／工厂 spread 的实际数组均持有 desktopApi，当前 resolve 和 rendererDataLiteral 的双层 opaque 检查均能拒绝，完整 20 个 Renderer 配置下也各产生 1 条诊断。

以上是确认反例的关闭，不扩张为整个 G8 或产品安全已经证明。

## 3. 发现

### RR4-01 [P2] 已解析工厂结果在 bound/member 组合中仍丢失对象身份

**位置：** [renderer-contracts.js:25](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:25)，核心为 30–31 行的 returnedValues 分支。

新 sameObject 只追踪 `actual.kind === 'call-result' && actual.callee.functionPath`。bound factory 的 callee 没有直接 functionPath，工厂返回对象的嵌套成员也不是这个直接形状；能力求值器能解析它们的初值，但对象身份检查没有对应传播，因而遗漏后续写入／helper 逃逸：

```js
function provide() { return { api: { run() {} } }; }
const envelope = provide();
const alias = envelope.api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({
  api: envelope.api
});
```

另一个变体是 `provide.bind(null)()` 返回窄 API 后，经 alias 添加 outsideScope。Object.assign 修改工厂返回的嵌套成员同样漏报。

**证据：** 实际 20 个 Renderer boundary 的基线为 0 诊断；bound_factory_alias、factory_nested_alias、factory_nested_escape 三例均为 0 新诊断。VM 捕获的真实实参均含 run 和可调用 outsideScope；无变更的 factory_nested 对照只有 run，正常通过。修复前字节版本对相邻漏报也为零，因此本项是存活缺口，不声称最新修复首次引入。

**合同与影响：** G8-AC-05、TechDoc §4.4 与 architecture README 的命名工厂／静态成员、别名写入及未知 helper 接管检查要求。当前允许已解析工厂结果携带超出 scoped API 清单的方法。没有证据表明当前生产装配已经这样注入。

**建议：** 能力求值与对象身份传播使用一致的 bound/member/return 解析；不能保持来源身份的组合保守拒绝，不能一边接受初值、一边静默漏掉后续变更。

证据：[实际配置脚本](evidence/r4-renderer-realconfig.cjs)、[实际配置与 VM 结果](evidence/r4-renderer-realconfig.json)、[修复前对照](evidence/r4-renderer-independent-before.jsonl)。

### RR4-02 [P2] 同一工厂的不同调用实例被合并，合法注入新增误报

**位置：** [renderer-contracts.js:28](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:28)，关联 30–31 行将 call-result 回溯到 return 字面量。

这项与 RR4-01 相邻但修复条件独立：前者遗漏组合来源，本项则把不同对象错误认定为同一对象。新逻辑用返回字面量的 objectStart 作为实例身份，但工厂每次调用都会创建新的对象：

```js
function provide() { return { read() {} }; }
const clean = provide();
const other = provide();
other.outsideScope = window.desktopApi.outsideScope;
window.createController({ api: clean });
```

合法最小合同只允许 read。VM 确认实际传入的 clean 只有 read，没有 outsideScope。第三轮修复前检查器无诊断；当前检查器却报 `scoped api 未授权字段 outsideScope`。归档自举脚本从 R3 before/ 恢复四个检查器，补入未变化的 schema，5 个文件逐一匹配修复起点 SHA-256，再独立重跑得到 **before=0 / current=1**。

**影响：** 普通的多实例工厂会被另一个实例的写入污染，导致原本符合窄 API 合同的改动无法通过门禁。这是本轮确认的**最近修复新增误报**，不是保守地报告一个未知来源；检查器明确错误归属了 outsideScope。

**合同：** G8-AC-05 要求合法 scoped API 通过，G8 TechDoc §4.4 要区分私有本地对象与整对象／越权注入；当前修复也以对象身份区分真实别名。返回表达式相同不能证明运行时实例相同。

**建议：** 在需要比较运行时对象身份时保留调用实例来源，区分“同一调用结果的多个别名”和“同一工厂的不同调用结果”；同时保留真实共享返回对象应被追踪的对照。

证据：[独立最小脚本](evidence/r4-renderer-separate-instances.cjs)、[before 输出](evidence/r4-renderer-separate-instances-before.jsonl)、[current 输出](evidence/r4-renderer-separate-instances-current.jsonl)、[可自举比较脚本](evidence/compare-distinct-instances.cjs)、[主审独立重跑与哈希](evidence/distinct-instances-comparison.json)。

### RR4-03 [P2] 原生迭代器调用的受限恢复回调未校验入口身份

**位置：** [rules.js:252](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:252)，关联 [contracts.js:293](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:293)。

executionScopes 已将原生／注入执行器的直接回调视为可能执行，并把回调函数体纳入闭包，但未将回调入口记为被调用目标。G1 只检查显式调用位置的 calledTargets，原生 reduce/map/forEach 的目标为空，因此受限回调入口不被校验：

```js
function prepareToolboxPublication(runtime, entry) {
  return [entry].reduce(recoverPreparingIntent, runtime);
}
```

recoverPreparingIntent 的真实签名为 runtime、entry，与 reduce 第一次调用的前两个参数一致。这里只展示扫描应拒绝的受限入口，不执行真实恢复。

**独立证据：** 实际 active G1 boundary 的临时 fixture 中，直接原生回调均调用了一次内存恢复 stub，却没有诊断；源码可见 helper 执行同一能力被正确拒绝，三类未执行／同名安全对照通过。另在完整生产 src 的临时副本中，仅向真实 prepare 添加上述 reduce 调用后静态扫描，G1 仍为 0 诊断；闭包明确进入了受限函数，而 reduce 的 calledTargets 为空。

补充 probe 使用 recoverOneJournal 也显示同样的入口漏记，真实函数体内部合法位置仍由准确 allowedSites 放行，不能替入口补报。其 options 参数与 reduce 的第三个 index 参数并不匹配，因此**不以该例宣称真实恢复 IO 可执行**；参数对齐的 recoverPreparingIntent 为本项代表例。全部真实源码探针仅扫描，不调用恢复函数。

**合同与影响：** G8-AC-16、TechDoc §4.7 的 prepare 不能形成独立 raw 入口要求，以及本次 G1 复用实际执行闭包的设计。此处不要求证明任意 callback：现有实现已经识别并进入这个静态回调，只遗漏了受限入口的授权位置检查。当前生产授权链没有发现绕过。

**建议：** 对已纳入执行闭包的回调记录入口身份及对应调用位置，将受限能力校验同时应用于显式调用和已解释的隐式回调执行，保留未调用成员与同名普通函数对照。

证据：[原生回调与对照](evidence/r4-g1-neighbor-probe.json)、[Preparing 对应脚本](evidence/r4-g1-preparing-neighbor-probe.cjs)、[Preparing VM 结果](evidence/r4-g1-preparing-neighbor-probe.json)、[真实源副本脚本](evidence/r4-g1-preparing-real-source-probe.cjs)、[真实源扫描结果](evidence/r4-g1-preparing-real-source-probe.json)、[原 12 类关闭结果](evidence/r4-g1-callback-probe.json)。

## 4. 本轮验证与证据复用

| 验证 | 结果 |
| --- | --- |
| 完整架构单测 | **本轮执行：237/237 PASS**，0 fail / skip，含 R2 34 项及 R3 33 项。[日志](evidence/architecture-tests.log) |
| 正式架构 CLI | **本轮执行：31 active，0 pending/partial、0 诊断、0 stale**；765/765 解析，2 个既有生成模块 unresolved、33 个动态位置继续按准确合同处理。[JSON](evidence/architecture-check.json) |
| 原完整配置查询探针 | **本轮原样执行**：未知 spread 报 coverage；已知危险数组报查询违规；safe 通过。[JSON](evidence/r3-query-realconfig-recheck.json) |
| Renderer 原样与专项 | 原嵌套对象变更被拒绝，相关 7/7 PASS；本轮相邻工厂组合仍漏报，另有独立 before/current 误报比较 |
| 数据合同 | 专项 13/13 PASS；原 12 例、新 10 例、opaque 数组 2 例及实际 20 配置复核符合合同。[汇总](evidence/r4-data-summary.json) |
| G1 | 原 12 类全部拒绝；专项 7/7 PASS；实际源码 G1 边界 0 诊断，12 个 allowedSites 各匹配 1 处。新原生回调探针见 RR4-03 |
| 完整 release-check | **本轮未重跑，复用匹配的最新修复候选证据**：2026-09-22 01:45:20–02:09:31，exit 0，9011 单测通过、0 失败、4 Windows 条件跳过、68/68 集成脚本通过。[原记录](../2026-09-22-release-r3-repair/release-check-result.json) |

专项数量与 237 总套件重叠，不相加。完整门禁的 1,700 个输入及 HEAD 与当前全部匹配；没有复用更早轮次的 8,944／8,978 单测数字。有计数集成合计 2,901/2,901，另 1 个脚本无用例计数，Renderer lifecycle 233/233；这些都是该次既有完整门禁记录，不是本轮重新运行 Electron。

机器可读命令与结果见 [verification.json](verification.json)，复现方式和扫描边界见 [evidence/README.md](evidence/README.md)。探针 exit 0 只表示取证成功，不能把零诊断的违规反例当成正确通过。

## 5. 保留与验收边界

- RR3 的原始反例修复得到独立确认，不因新发现而撤销已成立的关闭证据。
- opaque 数组在 Renderer 数据校验中已失败关闭，作为已反证候选记录；未扩展任意 this／反射／跨文件动态身份的已有证明边界。
- boundaries.json、legacy-allowlist.json、schema、policy-history 与 R3 修复起点相同；未发现配置放宽来掩盖诊断。
- 本轮只新增审查目录和临时探针，4,142 个冻结文件、HEAD 和 tracked 差异在交付前保持。详见 [preservation-final.json](preservation-final.json)。
- 未提交、推送、开 PR、合入 main、升版、打标签或发布；未执行真实产品 Main、Windows／安装包、Excel／WPS 或资金人工验收。
- 后续关闭需同时使违规组合被拒绝、不同合法实例不被混淆，并复验原回归和对应安全对照。修复最终候选再运行必要专项与正式门禁，不能仅以 active 数量或零诊断作守卫有效性的结论。

