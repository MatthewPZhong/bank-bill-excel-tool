# release/v3.2.10 第十轮独立增量审查

结论：确认 **2 项 P2**：RR10-01 是第九轮修复引入的合法代码误报；RR10-02 是此前已存在、此次 spread 修复仍遗漏的来源传播缺口。第九轮 RR9-01/02 的原始反例在本轮均已关闭，但其邻近组合不能整体结项。当前生产扫描没有诊断；本轮没有证明真实产品发生这两种错误，它们影响 G8 静态门禁的可靠性。

## 1. 冻结对象与范围

| 项目 | 本轮事实 |
|---|---|
| 分支 | `release/v3.2.10` |
| 独立 worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| HEAD | `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` |
| 基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 冻结时点 | 2026-09-22 20:03:09 Asia/Shanghai |
| 工作区 | 已有未提交修复作为候选；冻结 4,656 个 Git 可见文件及 tracked diff |
| 比较对象 | 第九轮审查冻结清单；反例 before 采用 R9 repair 起点归档并逐文件核对 hash |
| 本轮新增内容 | 仅本报告目录和临时探针；不修改生产代码、检查器、测试、配置或历史报告 |

相比第九轮审查快照，既有文件改变 7 个（6 个说明文件及 `renderer-contracts.js`），审查目录外新增 1 个测试文件 `release-rereview-r9.test.js`。792 个 `src/` 文件未变；机器边界、例外、schema、policy-history 和共享 scan/contracts/rules 未变。本轮聚焦这一个检查器的 AND 真值/默认参数传播及 mutator spread 元素来源，并有限复查共享解析行为；没有重新遍历 G1–G8 所有生产流程。

证据：[冻结清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/input-manifest.json)、[与前轮差异](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/prior-review-comparison.json)、[生产与共享工具比较](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/policy-production-comparison.json)。

合同依据：[G8 Spec §6/AC-05](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/spec.md:89) 要求合法 scoped API 通过，误报应修解析器并补反例；[TechDoc Renderer 边界](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:102) 要求不能解释的 alias/spread 来源报 coverage；[RR9 补充合同](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:124) 要求按真值保留短路来源、在 spread 展开时保留元素身份；[数组支持范围](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/architecture/README.md:135) 明确初始空数组、可见扩容不应被跳过。

## 2. 确认问题

### RR10-01 · P2 · 嵌套 AND 与 OR/nullish 将不可能的 undefined 保留为返回候选

- 分类：**本次修复新增误报**。同一源码在 R9 repair 起点 0 诊断，当前 1 诊断。
- 位置：[renderer-contracts.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:425)，425–427；默认值随后在 231–232 被错误引入。新增 AND 分支 414–418 正确保留短路左值，但外层逻辑运算没有消去确定不会返回的候选。
- 条件：带默认参数的 helper 接收 `(undefined && provided) || provided` 或 `?? provided`。此表达式必定返回独立的 `provided`，不会使用默认对象 `shared`。

```js
const shared = { run() {} };
const provided = { run() {} };
function select(api = shared) { return api; }
const alias = select((undefined && provided) || provided);
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: shared });
```

VM 证明 `alias !== shared`，传给 controller 的 `shared` 只有 `run`。检查器把 AND 结果中的自由 `undefined` reference 与 OR 右值一起保留，默认参数解析于是生成不可能的 `shared` 身份，最终误报 `ARCH-RENDERER-SCOPE: scoped api 未授权字段 outsideScope`。`??` 形式复现同一根因，不另算一项。

实际 20 个 active Renderer 边界下，原扫描基线 0 诊断，追加安全例仍产生 1 条错误诊断。将 OR 右值改为 `shared` 的违规对照，VM 确认传入对象确有可调用的 `outsideScope`，检查器以 `ARCH-STATIC-COVERAGE` 拒绝。普通 `provided || provided`、Preload 真值守卫加窄对象保持通过；完整 API 仍拒绝。

影响：符合 scoped API 合同的合法改动会阻塞架构门禁，错误提示也会引导维护者修改无问题的 controller 注入。建议让 `||`、`??` 与 `&&` 使用一致的确定真值/缺失值分支选择，在进入默认参数绑定前排除不可能返回的值，同时保持未知来源的保守检查。

证据：[8 例脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes.cjs)、[before](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes-before.jsonl)、[current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-probes-current.jsonl)、[实际配置脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-nested-realconfig.cjs)、[实际配置与 VM 对照](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-nested-realconfig.json)、[before 工具 hash](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-before-inputs.json)。

### RR10-02 · P2 · 工厂返回的空数组扩容后展开，仍丢失插入对象来源

- 分类：**已有缺口未覆盖**，不是第九轮修复新引入。修复前后均 0 诊断；运行时均确认发生同对象改写。
- 位置：[renderer-contracts.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/scripts/architecture/renderer-contracts.js:119)，119–128；槽位收集使用外部 `env`，没有复用返回数组携带的工厂调用环境。
- 条件：函数内部创建 `[]`，用固定槽位赋值或 `push(value)` 扩容，返回后将其展开进另一数组，再通过元素别名修改最终注入对象。

```js
function provide() { return { api: { run() {} } }; }
const clean = provide();
function make(value) {
  const args = [];
  args[0] = value; // 换成 args.push(value) 也复现
  return args;
}
const list = [];
list.push(...make(clean));
const alias = list[0].api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: clean.api });
```

初始 `value.elements` 为空；扩容写入和 mutator 的接收者无法在外部环境中匹配返回数组的工厂身份，未收集到任何槽位，`mutationSources` 因而给出空来源。后续别名写入不再关联 `clean.api`。VM 证明 `alias === clean.api` 且 `outsideScope()` 可调用；最小配置和实际 20 个 Renderer 边界在 before/current 都是 0 诊断，既未报 scope 也未报 coverage。

对照保持有效：工厂初始数组改为 `[old]` 再覆盖第 0 项，当前产生 1 条 scope 诊断；外部 helper 扩容可识别。独立工厂实例、展开后替换源数组都保持 0 诊断，VM 也确认未改写注入对象。单个 `args.push(...args)` 自展开场景正常完成并诊断，没有观察到递归卡死；这不代表任意循环数组均已验证。

影响：通过局部工厂、固定槽位和 spread 传播的 API 改写可绕过 G8 能力范围检查，与“初始空数组不跳过、未知来源不静默放行”的合同不符。建议在收集扩容槽位和 mutator 来源时使用数组 origin 对应调用环境；无法还原时保留不确定来源并给出 coverage，不能当成没有插入来源。

证据：[7 例 before/current 和 VM](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-neighbor-before-current.json)、[实际配置 before/current](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-real-neighbor-before-current.json)、[实际配置脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-real-neighbor-probe.cjs)、[受控 before 自举/比较脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-compare.cjs)。两份比较结果含 5 个工具及 2 个配置的 hash 校验；原文件均与冻结输入匹配。

## 3. 前轮关闭范围与共享行为

| 验证项 | 本轮结果 | 结论边界 |
|---|---|---|
| RR9-01 原始实际配置反例 | 非法例 1 诊断；安全例 0 | 原例关闭；不能覆盖 RR10-01 组合 |
| RR9-01 正式定向测试 | 31/31 PASS | 是完整 482 测试的子集，不重复相加 |
| RR9-02 原始实际配置代表 | direct push、push/splice spread 各 1；旧副本安全例 0 | 原例关闭；工厂空数组扩容仍有 RR10-02 |
| AND/Preload 邻近例 | 8 例修复前后+VM | 完整 API 真值证明未扩大注入权限；2 个同根因误报 |
| 数组邻近例 | 7 例修复前后+VM；其中 4 例用实际配置复核 | 2 个同根因漏报，另有已修复与安全对照 |
| 共享解析既有例 | 50 例当前均符合已有期望 | 32 Renderer 数据/来源例、18 query 例 |
| 新增逻辑数据组合 | 6 例 before/current | IPC AND 数据通过，完整 API 拒绝；静态 `0 && API` 旧误报已消除 |
| scanner 序列化 | 56 例重复 scan、evaluateRules 前后、before/current digest 与 evidenceId 一致 | 未见 Renderer 私有标记泄漏到共享扫描结果 |

共享 probe 继续采用第九轮修正后的异步 `ipcRenderer.invoke` 语义。`single-mount-category-explicit-ipc` 的未 await 调用会访问 Promise 上不存在的属性，再触发 `other` 默认分支，因此应拒绝；没有恢复旧的同步 stub 错误预期。仅指定需要的场景执行 VM/SQLite，不宣称每个静态 fixture 都覆盖真实 Electron 运行行为。

新增的 `flag ? "business" : "gateway"` 分类数据场景，两端均为纯字符串，但 before/current 都因候选值不确定而诊断。它作为既有保守限制记录，不计入本轮新增问题，也不称为合法通过。详细原始观察均保留在 `r10-shared-*.json`；[共享归档断言](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/shared-archive-verification.json) 校验了 56 个夹具、18 个查询例（其中 10 个实际执行 SQL）及异步期望。

原反例结果：[RR9-01 实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-renderer-original-realconfig.json)、[RR9-02 实际配置](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-array-original-real.json)。共享证据：[基础与 query](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-shared-probes.json)、[异步与数组](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-async-array-combinations.json)、[默认参数](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-default-combinations.json)、[新逻辑组合](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/r10-shared-logical-combinations.json)。

## 4. 验证与交付边界

本轮独立执行：

- `node --test --test-concurrency=1 tests/unit/architecture/*.test.js`：**482/482 PASS，0 fail、0 skip，exit 0**。[完整日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/architecture-tests.log)
- `node scripts/check-architecture.js --json <本轮绝对输出路径>`：**exit 0；31 active、0 pending、0 partial，0 诊断、0 stale exception**；解析 765/765，未解析 2、动态位置 33；历史检查 21 个提交。[CLI JSON](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/architecture-check.json)、[CLI 日志](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/architecture-check.log)
- 归档断言：校验 before/current hash、原例关闭、两项问题的运行/静态对照、共享结果与稳定性、门禁输入匹配。[断言脚本](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/verify-probes.py)、[结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/probe-verification.json)。这里 PASS 表示证据与结论一致，不表示候选无缺陷。

完整 `release-check` **本轮未重跑**。复用 R9 repair 在 2026-09-22 **19:41:10–20:00:20 Asia/Shanghai** 完成的门禁：`UNIT_TEST_CONCURRENCY=2 npm run release-check`，exit 0；**9256 项单测通过、0 失败、4 项 Windows 条件跳过**；**68/68 集成脚本通过**（有数字摘要的合计 2901/2901，另 1 个脚本无数量摘要）。其 HEAD 和 **1706 个输入文件**全部与当前候选相同，未以不同源码的历史 PASS 代替当前证据，也不把上述子集计数相加。

依据：[门禁验证摘要](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r9-repair/verification.json)、[门禁进程结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r9-repair/release-check-result.json)、[门禁输入清单](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-r9-repair/gate-input-manifest.json)、[当前输入匹配](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/gate-evidence-comparison.json)。

本轮没有实施修复，没有验证 GUI、Windows 实机、Excel/WPS 输出或实际安装包；未进行提交、合并、推送、PR、升版或发布。原始门禁通过与两项静态检查器缺陷同时成立。本结论仅对冻结候选及以上有界组合有效，不能作为完整版本、业务隔离或平台验收通过的声明。

## 5. 保全与复现

最终对照冻结的 4,656 个文件，检查 HEAD、完整 Git status、tracked binary diff 和报告目录外新增文件。[最终保全结果](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/preservation-final.json)；文档链接/JSON 完整性与归档 SHA256 见 [产物校验](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/artifact-validation.json)、[归档哈希](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/artifact-sha256.json)。

[证据目录与复现说明](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/README.md) 包含脚本入口及依赖。实际配置探针只在内存中追加分析节点；VM 只运行人工构造的小样例，不运行生产 renderer，也不修改业务数据。
