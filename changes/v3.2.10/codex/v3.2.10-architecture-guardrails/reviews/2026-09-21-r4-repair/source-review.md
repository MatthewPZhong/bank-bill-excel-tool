# v3.2.10 architecture-guardrails 第四轮审查

**结论：第三轮 R3-01、R3-02 原始缺陷已修复；本轮另确认 1 项 P2 同类余漏，暂不建议判为审查通过。** 外部 Position 方法引用已受保护，但工厂返回同文件已登记的受限 operation 时，已解析的函数身份没有参与受限操作匹配。第四轮记录为 **R4-01**，不将旧反例的修复成果抹掉，也不称其为此次改动新引入的回归。

本轮没有确认 P0/P1 或真实业务事故。发现针对静态架构门禁的漏检，合成 VM/子进程不证明生产资金、恢复或生命周期行为。目标源码保持只读。

## 1. 审查对象与增量范围

| 项目 | 本轮记录 |
|---|---|
| 日期 | 2026-09-21 |
| 分支 | `codex/v3.2.10-architecture-guardrails` |
| 目标 worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails` |
| HEAD / 固定事实基线 | `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，`v3.2.9` |
| 实际审查内容 | 目标 HEAD 加 tracked 修改及非 ignored 未跟踪实现，不能仅用 HEAD 代表受审内容 |
| 本轮完整冻结 | `/private/tmp/g8-review4-20260921-37xcb6nd/snapshot`；[3,113 路径 manifest](evidence/manifest.json) |
| 前轮对照 | [第三轮报告](../2026-09-21-r3/review.md)及其冻结工具 |
| 修复方记录 | [第三轮修复自检副本](evidence/repair-source/repair-review.md)；最终 manifest 23/23 与本轮一致 |
| 契约 | [G8 Spec](../../spec.md)、[G8 TechDoc](../../techdoc.md)、[当前规则说明冻结](evidence/snapshot/architecture/README.md) |

目标仍有 6 个 tracked 修改：两份 Windows workflow、`AGENTS.md`、`package-lock.json`、`package.json`、`rules/integration-test-policy.md`，实现目录等仍为未跟踪内容。详见 [起始状态](evidence/target-status-before.txt)。本次没有切换分支或在目标 worktree 新增文件。

相对第三轮共 [21 个变化路径](evidence/incremental-files.json)：核心为 `contracts.js`、`rules.js`、`scan.js`，新增 `review-round3.test.js`，其余为 README、实施说明和修复证据。Spec/TechDoc、机器配置、例外、schema、history、CLI、依赖、CI、业务 `src/` 与 `index.html` 均无本轮增量。

本轮范围为两项修复与直接相邻行为：本地工厂返回成员、受限函数身份、fork 参数重载、共享 const 值描述对 Renderer/API 和工厂历史保护的影响。没有重新遍历全部业务或穷举任意 JavaScript 数据流。

## 2. R4-01 / P2：已解析的本地受限 operation 仍可经工厂返回成员绕过

**位置：** [目标 rules.js:205](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:205)，具体匹配在 205–206 行；[冻结源码](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r4/evidence/snapshot/scripts/architecture/rules.js:205)。

真实 `business-task-adapters` 配置把 `settlePositionArchiveResult` 列在 `src/main.js` 的 `restrictedApis.operations` 中，见 [配置第 3534 行](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r4/evidence/snapshot/architecture/boundaries.json:3534)。使用该配置、无历史例外的以下 fixture 仍通过：

```js
// src/main.js；calls 由 VM 测试上下文提供
function settlePositionArchiveResult() {
  globalThis.calls.push('settled');
}

function createService() {
  return { settle: settlePositionArchiveResult };
}

const service = createService();

function runArchiveAwareOperation() {
  service.settle();
}
```

结果为 **0 violations、0 dynamicSites**；VM 运行 `runArchiveAwareOperation()` 后确实记录 `settled`。

与第三轮不同，这次解析器已经成功保留并解出来源，返回：

```json
{
  "known": true,
  "modules": [],
  "functions": ["settlePositionArchiveResult", "createService"],
  "unresolvedReturn": false
}
```

缺口在规则消费端：`origins.functions` 只用来扩大后续扫描作用域，`restrictedApis.operations` 仍只匹配原 `candidates.chain`。原成员调用描述没有该操作名，已解析的函数身份又没有参与匹配；扫描函数体也不会自动产生“该函数被调用”的节点，所以漏掉限制。因为 `known=true`，覆盖诊断也不会兜底。

四个对照均已执行：

| 调用形式 | 当前扫描 | VM 观测 |
|---|---|---|
| 返回 `{settle: settlePositionArchiveResult}` 后调用 | **0 违规，漏检** | `settled` |
| 保护函数直接调用 `settlePositionArchiveResult()` | 1 项 `ARCH-TASK-ADAPTER` | `settled` |
| 返回 `{settle(){settlePositionArchiveResult();}}` 后调用 | 1 项 `ARCH-TASK-ADAPTER` | `settled` |
| 同结构返回未受限纯本地函数 | 0 违规，合法 | `pure` |

**契约与影响：** TechDoc §4.8 要求通用 Main 编排不得调用 Position pending/settlement/cleanup 私有操作，并把可追踪的函数别名纳入检查。这里使用的是机器配置中准确登记的本地操作，且函数身份已经解析，不涉及任意回调或反射推断。同一个禁用操作通过服务成员引用即可放行，使当前外部模块来源保护与同文件 operation 保护不一致。

**修复方向：** 将解析出的本地函数身份与其源文件一起匹配受限 operation，同时保留纯本地服务、显式 adapter 注入及独立业务 composition 的合法方向。不能用扩大历史例外解决。

**分类边界：** 独立新旧对照确认该成员引用在第三轮与第四轮工具中均被放行；这是本轮新增确认的同类余漏，不是此次修复新引入的回归。当前生产源码中的真实操作使用情况不由该合成用例推断。

证据：[成员引用结果](evidence/rules-fixtures/g2-local-restricted-operation/result.json)、[已解析函数身份](evidence/rules-operation-origins.json)、[四个 VM 对照](evidence/rules-operation-runtime.jsonl)、[新旧工具重放结果](evidence/replay-finding-result.json)。可直接运行 [replay-finding.cjs](evidence/replay-finding.cjs)复现。

## 3. 第三轮修复关闭证据

| 第三轮项 | 本轮结果 |
|---|---|
| R3-01：本地工厂返回外部 Position 方法引用漏检 | **原问题关闭。** `{settle:position.settle}` 现报 `ARCH-TASK-ADAPTER`，路径包含 Position task-owner；方法包装继续拒绝，纯服务继续通过。嵌套成员、const/let 候选、freeze、bind、缺失/未知返回链等既有回归均通过。同文件 operation 的另一个消费端缺口单列为 R4-01。 |
| R3-02：fork 三参数丢失 cwd | **关闭。** 原 `process.argv.slice(2)` 与 `undefined` 两例均正确生成 `src/jobs/src/worker.cjs`，零动态/违规，与真实 Node 子进程一致。 |

fork 另有 11 组独立新旧扫描和真实子进程断言全部符合预期：原两个反例、null、静态 argv、双参数 options、第二参数对象覆盖第三参数、原生数组结果、数组/options 候选的两条实际路径、未知第二参数重载、未知第三参数。未知情形继续失败关闭且不生成猜测边。详见 [结构化结果](evidence/scanner-r4-probes.json)和[摘要](evidence/scanner-r4-summary.jsonl)。

共享值描述从 opaque reference 改为保留 unknown/member-base 后，代表性的 Renderer/API 与公开工厂保护没有退化。7 个新旧 CLI 对照结果一致：合法具名工厂及精确挑选 API 通过；不透明返回成员、完整 namespace 伪装、未知公开导出和私有同名均拒绝。原假迁移仍有 `ARCH-POLICY-HISTORY` 的 factory 诊断。详见 [对照结果](evidence/history-member-base-result.json)、[原假迁移结果](evidence/history-old-factory-result.json)。未重复全部历史迁移矩阵。

## 4. 验证、保护与交付边界

| 验证 | 本轮独立结果 |
|---|---|
| Node | `v24.13.0`；修复方自检使用的 Node 版本不作为本轮运行版本 |
| `node --test tests/unit/architecture/*.test.js` | **124/124 通过，0 fail/skip，退出码 0**；[日志](evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <显式证据路径>` | **退出码 0，0 违规**；[JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| 生产扫描 | 685/685 文件；2,254 字面量本地边、64 worker 边、5 global 边；0 parseErrors |
| 覆盖状态 | 2 unresolved、33 dynamicSites 按既有配置解释，不将其说成零动态点 |
| 激活与例外 | active 2、pending 21、partial 8；114 例外条目、142 匹配记录、0 stale；配置字节不变 |
| 专项证据 | 原缺陷复验、VM、11 组真实 Node 子进程、新旧 CLI 对照；定向测试属于完整 124 项，不额外相加 |
| 差异 | `git diff --check` 退出码 0 |
| 内容身份 | 修复方最终 manifest **23/23 一致**；[副本](evidence/repair-source/verified-manifest.json) |
| 保护 | 目标与独立快照各 **3,113 个路径 hash 零变化、零新增路径**；目标 branch/HEAD/status 未变；创建报告前主工作区 status 未变 |

验证摘要见 [validation-summary.json](evidence/validation-summary.json)，保护证据见 [preservation.json](evidence/preservation.json)。本次仅新增本审查目录及临时 fixture，没有修改目标实现、提交、推送、合并、开 PR 或发布。

本轮未运行完整 `release-check`：当前为分析器修复的只读增量审查，采用全架构套件、CLI 及独立反例；旧的全量日志不覆盖最终代码。进入 PR-ready、正式集成或发布时，应在最终候选执行完整门禁。

没有执行 Electron GUI、真实浏览器 HTML 运行、Windows workflow/安装包、Excel/WPS 验收。规则的 pending/partial、证据文件存在和 AST PASS 不代表 G1–G7 业务隔离、恢复授权或平台验收完成。

## 5. 证据留存

[证据说明](evidence/README.md)说明重放方式与冻结范围。报告中的本轮结论只对应上述源码快照和增量范围。下一轮应先复验 R4-01，再检查其修复涉及的规则身份匹配，不因本次未发现其他问题而推断未审范围已全部通过。
