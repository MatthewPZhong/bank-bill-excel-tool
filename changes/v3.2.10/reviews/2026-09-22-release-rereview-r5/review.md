# release/v3.2.10 第五轮增量审查

**结论：第四轮三项发现的原始反例均已关闭；本轮确认 2 项 P2：一项静态成员替换后的既有相邻漏报，一项 R4 修复新增的函数值比较误报。** 架构 270/270 与正式 CLI 通过，但不能反证这两个独立正反例。

本轮依据 [第四轮审查](../2026-09-22-release-rereview-r4/review.md)、[第四轮修复](../2026-09-22-release-r4-repair/repair.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md)及 [TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md)，复核最新修复及有限相邻组合。只新增本轮审查文件与临时探针，没有修改源码、检查器、测试、配置或旧证据。

## 1. 固定对象与范围

| 项目 | 本轮事实 |
| --- | --- |
| 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 实际候选 | HEAD 加已有全部未提交修复，包含 R4 修复 |
| 上一正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结文件 | 4,229 个既有文件 SHA-256，含中文路径；[清单](evidence/input-manifest.json)、[tracked 差异](evidence/input-diff.patch) |
| 相对第四轮审查 | 10 个既有检查器／说明／自动集成策略结果文件变化，新增 release-rereview-r4.test.js；[逐文件比较](evidence/prior-review-comparison.json) |
| 生产与配置 | 792 个 src 文件，以及 boundaries、legacy-allowlist、schema、policy-history，与 R4 修复起点相同；[证据](evidence/policy-production-comparison.json) |
| 最新完整门禁 | 1,701 个输入及 HEAD 与当前完全匹配；[证据](evidence/gate-evidence-comparison.json) |

增量核心为 Renderer 对象身份、callStart／调用上下文和 G1 callbackTargets。没有重新审查未变化的全部业务模块，也没有把任意 this、反射、同一调用点的动态重复实例或跨文件动态身份纳入本轮证明范围。

## 2. 第四轮问题复核

| 上轮项目 | 本轮独立验证 |
| --- | --- |
| RR4-01 bound/member 工厂结果漏掉越权写入 | 原实际 20 配置的三个越权反例均拒绝，安全对照无诊断；相关对象身份专项 23/23 PASS。 |
| RR4-02 不同工厂实例混淆 | 原 separate-instances 脚本现零诊断，VM clean 只有 read；正常多实例回归通过。 |
| RR4-03 原生回调入口遗漏授权检查 | 原 preparing-neighbor 的 4 个执行路径全拒绝、3 个安全对照全通过；真实源码副本中的 reduce 在 prepare 处产生入口违规；专项 10/10 PASS。 |

23 项 Renderer 与 10 项 G1 合计为新增 33 项回归，并包含在本轮 270 项架构测试内，不额外累加。G1 实际源码基线仍为零诊断，12 个准确 allowedSites 各精确匹配 1 处。

原样证据：[Renderer 实际配置](evidence/r5-renderer-original-realconfig.json)、[不同实例](evidence/r5-renderer-original-separate-instances.jsonl)、[G1 回调与对照](evidence/r5-g1-preparing-neighbor-probe.json)、[真实源码 reduce](evidence/r5-g1-preparing-real-source-probe.json)、[G1 授权位置基线](evidence/r5-g1-actual-config-baseline.json)。

## 3. 发现

### RR5-01 [P2] 静态成员替换后，后续别名写入仍使用旧成员身份

**位置：** [renderer-contracts.js:48](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:48)，核心是 54 行以 `inspectMutations=false` 解析身份；关联 158–174 行的静态成员写入处理。

```js
function provide() { return { api: { run() {} } }; }
const envelope = provide();
const clean = { run() {} };
envelope.api = clean;
const alias = envelope.api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({
  api: envelope.api
});
```

**事实：** 同文件、固定成员名、单次静态赋值，没有循环、动态索引、反射、跨文件来源或任意 this。能力求值会在 174 行采纳 `envelope.api = clean`，但识别随后 alias 的身份时使用不检查成员变更的解析，仍把 alias 归到工厂最初的 api 对象，遗漏新对象的 outsideScope。小夹具在 R4 修复前和当前都零诊断；VM 确认注入对象与 clean 为同一实例，含可调用 outsideScope。

**实际配置结果：** 保留当前全部 20 个 Renderer boundary，基线零诊断。static_member_replacement 仍为零诊断，但 VM 实际注入对象与 clean 相同，键为 run/outsideScope，outsideScope() 返回 true。安全对照在替换之前取得旧别名，修改旧对象后，注入对象与旧别名不同且仅含 run，也保持零诊断。

证据：[实际配置脚本](evidence/r5-renderer-replacement-realconfig.cjs)、[实际配置及 VM 结果](evidence/r5-renderer-replacement-realconfig.json)、[八例邻近脚本](evidence/r5-renderer-neighbors.cjs)、[before](evidence/r5-renderer-neighbors-before.jsonl)、[current](evidence/r5-renderer-neighbors-current.jsonl)、[before 工具哈希](evidence/r5-renderer-before-inputs.json)。

**合同与边界：** G8-AC-05、TechDoc §4.4 及 architecture README 对可解释同文件工厂结果、静态成员、别名写入的约束。这里已经接受了明确的成员替换，之后既未追踪后续写入，也未以不可解释来源失败关闭；不是要求完整证明任意共享状态变化。

**影响：** 某些已接受的静态装配组合仍可携带超出 scoped API 清单的方法。当前生产装配没有发现采用这一反例的证据。本项为新确认的既有相邻缺口，不声称由 R4 首次引入，也不撤销原 RR4 反例的关闭。

**建议：** 对已解析的成员替换，使能力值与对象身份传播保持一致；不能维持身份时明确失败关闭。需同时保留“先捕获旧成员别名、再替换为新对象”的安全对照，防止把已经分离的旧对象写入误加到新实例。

### RR5-02 [P2] 将原生函数值比较误判为受限恢复执行

**位置：** [contracts.js:276](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:276)，276–277 行 `callbackTargets`；消费端为 [rules.js:254](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/rules.js:254)。

```js
function prepareToolboxPublication() {
  const handlers = [recoverPreparingIntent];
  return handlers.includes(recoverPreparingIntent);
}
```

**事实：** callbackTargets 在没有源码调用目标时，把所有可解析函数实参都当作执行回调。G1 新增的身份校验据此报告受限恢复执行，连 includes/indexOf 的纯身份比较也被拒绝。VM 证明它们仅返回 true/0，没有执行恢复 stub。

| 相同探针 | 修复前诊断 | 当前诊断 | VM 恢复 stub 调用次数 |
| --- | ---: | ---: | ---: |
| includes 比较函数值 | 0 | 1，误报 | 0 |
| indexOf 比较函数值 | 0 | 1，误报 | 0 |
| 源码 helper 执行 list[0] === fn | 0 | 0 | 0 |
| reduce 实际执行恢复回调 | 0 | 1，正确拒绝 | 1 |

主审已独立执行 [可自举比较脚本](evidence/compare-native-function-values.cjs)：从 R4 before/ 恢复四个检查器，补未变化的 schema 和两个机器 JSON，**7 个 SHA-256 均匹配修复起点**；随后对完全相同探针运行 before/current，断言误报和安全／执行对照。[结果](evidence/native-function-values-comparison.json)。

**真实源码证据：** 在完整生产源码临时副本内，只向真实 prepare 增加 handlers/includes 两个语句，实际 active G1 边界报告一条入口违规。765/765 文件解析成功；calledTargets 为空，而 callbackTargets 错误包含真实 recoverPreparingIntent。这里仅做静态扫描，没有执行真实恢复 IO。[脚本](evidence/r5-g1-native-data-real-source-probe.cjs)、[结果](evidence/r5-g1-native-data-real-source-probe.json)。

**合同与影响：** Spec 的误报处理要求、G8-AC-16、README 对未执行成员及原生“执行器回调”的区分。明确的原生函数值比较没有 callback 执行语义。这是 **R4 修复新增的门禁误伤**，会阻止合法成员检查／去重代码通过。未发现现有生产源码触发它。

**建议：** 区分已有明确语义的值参数与执行回调参数；对真正已纳入闭包的执行回调继续检查入口身份。保留 includes/indexOf、源码 helper、reduce 的正反例，不通过新增恢复授权例外放过纯值比较。

## 4. 未形成新增发现的检查

共享解析专项共 20 个小夹具，分别在 R4 起点字节版本与当前工具求值，共 40 次评估：

- 12 个 Renderer 数据／IPC 对照：普通、bound、闭包返回值及条件特殊自有键；实际 config.initialBillCategory 和 initialInfo 经返回／参数传递。6 个合法例无诊断，6 个违规例各 1 条，前后相同。
- 8 个 BizOP Q3 对照：直接／返回／参数回调、工厂方法及数组参数索引。5 个执行 SQL 的例子各 1 条诊断，3 个不执行 SQL 的例子无诊断，前后相同。VM 使用内存 SQLite，执行记录与静态结果相符。
- policy 文件及修复前工具 hash 全部匹配。上述 fixture 使用实际规则与许可集合，状态设为 pending，**不作为额外全仓扫描证据**。

[探针](evidence/r5-data-shared-probes.cjs)、[前后及 VM 结果](evidence/r5-data-shared-probes.json)、[逐项断言](evidence/r5-data-verification.json)。

Renderer 的相邻闭包方法共享例从 before 漏报变为正确拒绝；独立闭包、参数包装的不同对象通过。shallow spread 后再选嵌套成员的安全形式在 before/current 都报告 coverage，作为既有保守解析限制保留，不登记为本次新引入的问题，也不写成已支持全部 spread 组合。

## 5. 验证与证据效力

| 验证 | 本轮结果 |
| --- | --- |
| 全部架构单测 | **本轮执行：270/270 PASS**，0 fail / skip。[日志](evidence/architecture-tests.log) |
| 正式架构 CLI | **本轮执行：31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析，2 个已登记生成模块 unresolved、33 个动态位置。[JSON](evidence/architecture-check.json) |
| Renderer / G1 定向回归 | **23/23、10/10 PASS**，均包含在 270 内 |
| 独立正反探针 | 原样复验、相邻反例、before/current、VM及实际配置证据分别记录；不是把 probe exit 0 当成产品 PASS |
| 完整 release-check | **本轮未重跑，复用输入完全匹配的最新 R4 修复门禁**：2026-09-22 11:43:25–12:00:05，exit 0，9044 单测 PASS、4 Windows 条件 skip、68/68 集成脚本 PASS |

完整门禁的 HEAD 和 1,701 个输入均匹配，有计数集成共 2901/2901，另一个脚本无计数，Renderer lifecycle 233/233；已对照原始日志与 [原结果](../2026-09-22-release-r4-repair/release-check-result.json)。它们是最近修复的历史执行证据，不是本轮重新运行产品。修复记录中的首轮沙箱 Electron 启动失败及之后同候选完整重跑保持原记录，不据此产生新的源码缺陷。

本轮第一次 CLI 命令使用了相对 JSON 路径，被正确以输入错误 2 拒绝；改为绝对路径后重新执行通过。这是审查命令参数错误，不是产品失败。[记录](evidence/command-input-error.json)。

完整命令、结果和边界见 [verification.json](verification.json)及 [复现说明](evidence/README.md)。

## 6. 保护与剩余验收

- 原问题的关闭限定于列明反例、合同与安全对照，不推广为全部 JavaScript 语义或 G8 防倒退能力已经完备。
- 本轮只新增审查目录和临时探针，交付前核对 4,229 个既有文件、HEAD 与 tracked 差异保持；[保护记录](preservation-final.json)。
- 当前生产业务未改，机器边界／例外未放宽；没有提交、推送、PR、合入 main、升版、标签或发布。
- 未执行真实产品 Main 全流程、Windows／安装包、Excel／WPS 或资金人工验收。
- 后续关闭应同时证明静态成员替换后越权写入被拒绝、分离旧别名安全对照通过、原生纯比较通过且真实回调执行仍需授权。最终修复候选需重新完成与修改相称的验证和门禁。
