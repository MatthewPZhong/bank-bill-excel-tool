# R2 检查器修复独立增量复核

本复核针对检查器本次作用域收窄、显式装配导出识别、Renderer helper 值解析新增能力，不重新审查业务算法。复核者未实现这些检查器修改；R1 为复核者实现，因此本文不把 R1 作为独立审查通过项。

仅在受控临时仓库/Node VM 运行最小源码；SQL 由记录型 DB 替身记录 `SELECT 1`，没有真实数据库或用户数据。所有探针均记录执行前后检查器文件 SHA-256，`stable:true` 表示该次复核输入未漂移。探针 exit 0 表示结果收集成功，不等于所有用例都通过；应按本文及 JSON 中 runtime/violations 的对照判断。

## IR-1 调用回调传播

最初将按整模块可达改为实际执行后，以下两个新回归被独立复现：

- 受保护 `read` 把从 helper 导入的 `query` 传给本地 `invoke(fn, catalog)`，再由 `fn(catalog)` 执行。运行时调用 raw DB，检查器 0 诊断。
- `read` 将 helper 工厂返回的 callback 传给相同 invoke。运行时调用 raw DB，检查器 0 诊断。

同一对象回调 `invoke({query}, catalog)` 也最初漏报，但固定 `9a38b96b` 的原检查器亦漏报，属于既有缺口，不能描述为本轮引入。直接局部 callback 则是原版漏报、本次最初已能拦截的改善。

- [初始当前结果](execution-probe.json)
- [固定 9a38b96b 对照](execution-probe-baseline.json)
- [原探针源码](execution-probe.cjs)

负责实现的 Agent 补充实际 helper 参数能力传播后，独立重跑原 7 条探针：7 条运行时均调用 SQL、7 条均正确产生诊断，来源文件 hash 稳定。[修后结果](execution-probe-final.json)

另外验证相同传播中的 `.call`、`.apply`、`.bind`、嵌套解构参数、identity helper 返回函数：5 条均运行 SQL 并产生诊断；仅注册 policy.query 而未执行的合法对照不运行 SQL且 0 诊断。[追加探针](execution-forwarding-probe.cjs)、[最终结果](execution-forwarding-probe-final.json)

**IR-1：已在上述覆盖范围独立确认关闭。**

## IR-2 Renderer helper 能力来源

初始复核发现同文件 helper 参数在解析后被当成安全方法叶，造成：

- `mount(read){ createProbe({api:{read}}) }; mount(window.desktopApi)`：传入的 `api.read` 为完整 desktopApi。原版同样漏报，属于既有缺口。
- `forward(api){return {read:api}}` 经 mount 参数再返回给 controller：本次 0 诊断，固定原版有诊断，属于新增漏报。

VM 证实 `api.read === window.desktopApi` 且可经 `api.read.outsideScope()` 调用未授权方法；不是单纯静态可疑。

- [初始结果](renderer-composition-probe.json)
- [固定原版对照](renderer-composition-probe-baseline.json)
- [探针源码](renderer-composition-probe.cjs)

进一步按指定 authority/spread/UMD 范围检验，确认三条新增漏报：

1. helper 返回的局部 api 在 `Object.assign(api, window.desktopApi)` 后扩展为完整能力，解析器只看初始 `{read}`。
2. 相同局部 api 通过 `Object.defineProperty` 添加 `outsideScope` 方法，解析器未记录扩展。
3. global Provider 较早返回完整 API，调用后才被覆盖为 scoped Provider；解析器用最后写入覆盖较早调用。

三者 VM 均证实得到未授权能力；固定原版均拒绝，初始新实现均 0 诊断。普通完整 spread、UMD 完整 API 能正确拒绝；合法 UMD scoped 方法能通过。

- [初始变异探针结果](renderer-mutation-probe.json)
- [固定原版对照](renderer-mutation-probe-baseline.json)
- [探针源码](renderer-mutation-probe.cjs)

负责 Renderer 检查器的 Agent 修复后，独立原样重跑两个探针，5 条已确认越权路径均产生诊断。完整 API 直接／多层 helper／namespace 转交、完整 spread、UMD 完整 API 等其他负例仍拒绝；合法 UMD scoped 方法和 G7 静态具名 namespace 仍通过。两次输入 hash 前后稳定。

- [Renderer/G7 修后结果](renderer-composition-probe-fixed.json)
- [能力扩展及 UMD 修后结果](renderer-mutation-probe-fixed.json)

**IR-2：上述 5 条已确认越权路径已独立确认关闭。** 其中直接将完整 API 当成方法参数的形式是既有缺口，另外 wrapper 返回参数、Object.assign、defineProperty、global 最后写入覆盖属于本轮新增漏报，已在原版对照中区分。

解析范围限制：把完整 desktopApi 先传给局部 helper、helper 再选取单个方法的某种合法形式仍保守报来源无法解释；原探针中的 `scoped-helper` 用于明确此限制，不算越权测试通过，也没有发现实际生产消费者因此被拒的证据。解析器不保证接受所有合法 JavaScript 等价写法。

## G7 namespace 范围

合法 namespace 的静态具名成员访问可通过；namespace 直接转交 helper、用对象包裹转交、动态成员选择、额外未授权成员均正确产生 `ARCH-DESCRIPTOR-COMPOSITION`。证据在 [Renderer/G7 修后组合探针](renderer-composition-probe-fixed.json)。未把原版对合法静态 namespace 的误报保留当作正确合同。

## 验证边界

只读复核未修改检查器、配置或业务源码，探针和本文写入单独 independent-review 目录。没有运行全量 release-check；最终组合验证由主任务完成。这些最小检查器反例不替代真实产品 Main、Windows/安装包、Excel/WPS 或资金人工验收。

最终记录：执行作用域两组探针在其他检查器文件完成修改后原样重跑，结果仍符合上述断言；最终 execution 两份与 Renderer 两份 JSON 记录的是同一组检查器文件 SHA-256。中间修复前后原始证据继续保留。

## 最终扫描器冻结后的复验

2026-09-21，在实现者完成最终 callee 动态成员检查及参数字面量/默认值解析后，按主任务要求原样重跑上述四组探针，没有新增类别。12 条实际 SQL 路径均被拦截，5 条已确认 Renderer 越权路径均被拦截；policy 不执行、合法静态 namespace、合法 UMD scoped 对照保持通过。四份 JSON 的 before/after SHA-256 完全一致，并与复验结束时源码一致。

```text
scripts/architecture/contracts.js: b594d0c8f18f0c43276e56c88efbb55cce6ded12302b5b9a88d5dd3c662ab453
scripts/architecture/rules.js: 5a25880507fce22c3b066b084975a2b773afc2a1b3eef14fa2a7b7a41f8de143
scripts/architecture/scan.js: 8f18138d5a0cc2c51188831b0cdffb752c2300212ccfe2f0349f06ac52850615
scripts/architecture/renderer-contracts.js: bb4cb2ca821fd639fc12b04d5606d14ac36828f93dfc5f3bfc0660f3dc72022c
```
