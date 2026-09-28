# release/v3.2.10 第六轮增量审查

**结论：第五轮两项发现的原始反例均已关闭；本轮确认 2 项 P2，均为 R5 修复新增的静默放行回归。** 一项遗漏参数解构的读取时点，一项在方法已被静态 helper 改写后仍使用原生比较语义。316 项架构测试与正式 CLI 通过，不足以反证这些独立运行时正反例。

依据：[第五轮审查](../2026-09-22-release-rereview-r5/review.md)、[第五轮修复](../2026-09-22-release-r5-repair/repair.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md)、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md)及[架构说明](../../../../architecture/README.md)。本轮只新增审查文档和证据，没有修改源码、检查器、测试、配置或旧证据。

## 1. 固定对象

| 项目 | 当前事实 |
| --- | --- |
| worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 分支 / HEAD | `release/v3.2.10 / 9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 实际候选 | HEAD 加已有全部未提交修复，包含 R5 修复 |
| 上一正式版事实基线 | `v3.2.9 / 11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结时间 / 文件 | 2026-09-22 14:27:56，Asia/Shanghai；4,306 个已有文件 SHA-256，[清单](evidence/input-manifest.json)、[tracked 差异](evidence/input-diff.patch) |
| 相对 R5 审查 | 9 个既有检查器／说明／自动集成策略结果文件变化，新增 release-rereview-r5.test.js；[比较](evidence/prior-review-comparison.json) |
| 生产与配置 | 792 个 src 文件，以及 boundaries、legacy-allowlist、schema、policy-history 与 R5 修复起点相同；[证据](evidence/policy-production-comparison.json) |
| 最新完整门禁 | 1,702 个输入及 HEAD 与当前完全匹配；[逐文件核对](evidence/gate-evidence-comparison.json) |

本轮覆盖三个检查器的最新修复、原反例、静态参数传递与相邻身份组合，没有重新审查全部未变化业务模块。不把任意 this、反射、动态重复调用／循环或跨文件共享对象时序纳入本轮证明范围。

## 2. 第五轮问题复核

| 原问题 | 本轮结果 |
| --- | --- |
| RR5-01 静态成员替换后的别名写入漏报 | 原实际 20 个 Renderer boundary 探针：基线 0，越权例 1 条 ARCH-RENDERER-SCOPE，分离旧别名安全例 0；原问题关闭。 |
| RR5-02 函数值比较误判为恢复执行 | 原完整源码 includes 探针 0 诊断且 callbackTargets 为空；真正执行回调的 reduce 仍在 prepare 处产生 1 条恢复入口诊断；原问题关闭。 |

[Renderer 原样结果](evidence/r6-renderer-original-realconfig.json)、[G1 原 includes](evidence/r6-g1-native-data-real-source-probe.json)、[G1 原 reduce](evidence/r6-g1-preparing-real-source-probe.json)。后两项扫描 765/765 文件，只对实际 active G1 边界求值，没有运行真实恢复。

正式定向回归为 Renderer **26/26**、G1 **20/20**，均包含在本轮 **316/316** 架构测试内，不相加。原问题的关闭与下面新组合的回归分别记录。

## 3. 发现

### RR6-01 [P2] 解构参数仍读取旧成员身份，新增静默越权放行

**位置：** [renderer-contracts.js:156](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:156)，156–157 行 bindPattern 的 ObjectPattern 分支；关联 [327 行](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:327)的调用参数绑定。

```js
function provide() { return { api: { run() {} } }; }
const envelope = provide();
function select({ api }) { return api; }
envelope.api = { run() {} };
const alias = select(envelope);
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({
  api: envelope.api
});
```

**事实：** 同文件、一次静态替换、具名 helper、固定键参数解构。bindPattern 直接对参数值使用 select，没有接收调用读取时点，也没有使用 snapshotMember。身份解析保留的原始对象因此仍将 api 指向工厂初始对象，后续 alias.outsideScope 无法关联到当前已替换的 api。普通参数 `select(value) { return value.api; }` 会进入 memberRead/snapshotMember，能正确拒绝同义越权代码。

| 对照 | R5 修复前 | 当前 | 运行时事实 |
| --- | --- | --- | --- |
| 替换后经解构参数取得别名，再越权写入 | coverage 拒绝 | **0，漏报** | 同一新对象，含可调用 outsideScope |
| 替换前经解构参数捕获旧别名，再替换并改旧对象 | coverage 拒绝 | 0 | 不同对象，注入 API 只有 run |
| 替换后经普通参数 `.api` 取得别名，再越权写入 | coverage 拒绝 | scope 拒绝 | 同一新对象，含 outsideScope |

**实际配置证据：** 保留当前全部 **20 个 Renderer boundary**，在真实 renderer AST 中追加第一／第二例，基线均 0；越权例仍无 scope 或 coverage 诊断，VM 证明同一引用、API 键为 run/outsideScope、额外方法返回 true。安全例为不同引用、API 只有 run、零诊断。[脚本](evidence/r6-renderer-parameter-realconfig.cjs)、[结果](evidence/r6-renderer-parameter-realconfig.json)。

**新增回归依据：** 完全相同小夹具在 R5 起点字节版本会被 coverage 拒绝，当前零诊断。修复前三个修改工具取 before/，另两个未改工具与起点哈希匹配，共 5/5；当前工具也匹配本轮冻结输入。[before 哈希](evidence/r6-renderer-before-inputs.json)、[current 哈希](evidence/r6-renderer-current-inputs.json)、[前后探针](evidence/r6-renderer-neighbors.cjs)、[before](evidence/r6-renderer-neighbors-before.jsonl)、[current](evidence/r6-renderer-neighbors-current.jsonl)。

**合同、影响与处置：** G8-AC-05、TechDoc §4.4 最新补充、README 105 行明确承诺按已知调用上下文／读取时点解释静态成员与解构；未解释能力不能静默通过。本项会放过实际携带额外能力的 scoped API，尚无证据表明当前生产装配已触发。参数解构应与普通成员读取共享调用时点的选择规则；不能解释时恢复 coverage 拒绝，同时保留替换前捕获旧别名的安全对照。

### RR6-02 [P2] helper 参数投影隐藏方法改写，原生比较排除规则新增恢复入口漏检

**位置：** [contracts.js:280](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/contracts.js:280)，280–284 行 arraySources；关联 301 行同一数组／原型判断、308 行 helper 逃逸判断和 322–323 行清空回调参数。

```js
function prepareToolboxPublication(runtime, entry) {
  function change(box) {
    box.handlers.includes = fn => fn(runtime, entry);
  }
  const handlers = [];
  change({ handlers });
  return handlers.includes(recoverPreparingIntent);
}
```

**事实：** handlers 原本是静态数组，但经源码可见 helper 的固定属性赋值后，includes 已变为执行函数实参的方法。arraySources 却在参数 selection 非空时直接返回 null，丢失 box.handlers 与真实数组的联系；写入检查没有发现同一数组被修改，已解析 helper 又不会触发未知逃逸兜底，最终被错误判定为原生比较并清空回调实参。

| 同一探针 | R5 修复前诊断 | 当前诊断 | VM 恢复 stub 次数 |
| --- | ---: | ---: | ---: |
| 原生 includes / lastIndexOf | 各 1 | 各 0，正确修复 | 0 |
| 直接数组方法改写 / 直接 prototype 改写 | 各 1 | 各 1，正确拒绝 | 1 |
| 对象参数投影后改写 | 1 | **0，漏报** | 1 |
| 解构参数投影后改写 | 1 | **0，漏报** | 1 |
| 将 Array.prototype 作为参数传入 helper 后改写 | 1 | **0，漏报** | 1 |

这些例子使用静态字面对象、固定键和可见 helper，无反射或未知 receiver。后两种作为同一“原生方法身份核验不足”的相邻证据，不另列发现。[八例脚本](evidence/r6-g1-neighbor-probe.cjs)、[可自举比较](evidence/r6-g1-compare.cjs)、[前后结果及 7 项 hash](evidence/r6-g1-before-current.json)。比较脚本恢复 R5 三个修改工具、核对两个未改工具及两个机器 JSON，全部匹配起点，然后在同一脚本上运行 before/current。

**真实源码证据：** 完整生产源码临时副本只向 prepare 增加上述对象参数改写，并将 runtime/entry 换为实际 options.runtime/options.entry。765/765 解析，实际 G1 active，却 **0 诊断、calledTargets=[]、callbackTargets=[]**，恢复函数未进入执行闭包。副本只作扫描，未执行真实恢复 IO。[脚本](evidence/r6-g1-projection-real-source-probe.cjs)、[结果](evidence/r6-g1-projection-real-source-probe.json)。

**合同、影响与处置：** README 107 行、TechDoc 112 行仅允许“未被自有成员／Array.prototype 改写”的数组比较排除回调；G8-AC-16 要拒绝 prepare 未授权恢复入口。当前未经证明的“未改写”判断会隐藏真实受限执行，是 R5 新增回归。应保留静态参数投影与原型参数的来源，或在不能证明未被改写时保守保留回调检查；不能只凭接收者最初为数组就清空执行目标。

## 4. 其余有界检查

- 共享解析共 **28 个小夹具 × before/current 两个版本**：16 个 Renderer 纯数据／IPC 例、12 个 BizOP 查询例。前后判断符合预期；7 个违规查询确实执行内存 SQLite SELECT 并被拒绝，5 个安全查询例没有 SQL。
- 所有夹具的完整扫描 JSON 修复前后相同、重复扫描相同、规则求值前后不变；site.evidenceId 全部一致。
- 对同一共享值的四次成员／解构读取具有独立 descriptor；另一个 analysis 查不到记录；正向／逆向描述顺序结果一致。没有发现私有旁表串用或机器指纹漂移。
- Renderer 的普通参数读取时序、真实共享替换与不同实例对照符合预期。闭包 helper 内部替换的两例均 coverage，其中一个运行时安全；作为保守解析限制记录，不扩为本轮新增发现。
- G1 的参数投影后纯比较例修复前后均产生诊断，也不纳入本轮新增回归；未宣称所有合法静态组合已支持。

[共享解析断言汇总](evidence/r6-data-verification.json)、[原 20 例](evidence/r6-data-shared-probes.json)、[新增 8 例](evidence/r6-data-destructure-probes.json)、[旁表隔离](evidence/r6-data-descriptor-isolation.json)。这些小夹具保留实际规则与许可集合，状态设为 pending，不冒充全仓 active 配置测试。

## 5. 验证、保护与交付边界

| 验证 | 本轮结果 |
| --- | --- |
| 全架构单测 | **本轮执行：316/316 PASS**，0 fail/skip；[日志](evidence/architecture-tests.log) |
| 正式 CLI | **本轮执行：31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析，2 个已登记生成模块 unresolved、33 个动态位置；[JSON](evidence/architecture-check.json) |
| 定向回归 | 26/26 Renderer、20/20 G1，通过且包含在 316 内 |
| 主审证据断言 | 已执行，对旧反例关闭、两项新回归、真实配置／VM、安全对照及历史 hash 逐项断言；[脚本](evidence/verify-probes.py)、[结果](evidence/probe-verification.json) |
| 完整 release-check | **本轮未重跑，复用输入完全匹配的 R5 修复门禁**：2026-09-22 14:01:31–14:19:51，exit 0；9090 单测 PASS、0 fail、4 Windows 条件 skip；68/68 集成脚本 PASS |

完整门禁的 HEAD 和 1,702 个输入全部匹配，已对照原始日志及[执行结果](../2026-09-22-release-r5-repair/release-check-result.json)；有计数集成 2901/2901，另 1 个脚本无计数，Renderer lifecycle 233/233。这些是该次历史执行证据，不是本轮重新启动产品。探针 exit 0 和主审断言 PASS 表示证据取证／核对完成，不把违规例的零诊断当作合同通过。

机器可读结果及复现说明：[verification.json](verification.json)、[evidence/README.md](evidence/README.md)。

交付前核对 4,306 个冻结文件、HEAD、tracked diff 保持，本轮审查目录外没有新增仓库文件；[preservation-final.json](preservation-final.json)。仅新增审查文档、证据及临时探针，没有提交、推送、PR、合入 main、升版、标签或发布。

原发现闭合不扩张为 G8 全部语义已证明。未执行真实产品 Main、GUI、Windows／安装包、Excel／WPS 或资金人工验收。后续修复应同时保留旧问题和合法对照的关闭，并使两组新增越权／恢复执行反例被拒绝，再对最终候选做必要验证。
