# v3.2.10 architecture-guardrails 第三轮审查

结论：**仍有 2 项 P2，暂不建议将本分支判为审查通过。** 第二轮 8 项 P2、1 项 P3 的原始复现均已修复；但 R2-01 的本地服务工厂来源追踪和 R2-08 的 fork 重载解析各有一个同类缺口，分别记为 R3-01、R3-02。其余 7 项在本轮范围内可关闭。

本轮没有确认 P0/P1 或真实业务事故。P2 表示门禁漏检或合法调用误报，不能据此推断已经发生资金、恢复或生产数据问题。只审查和生成证据，没有修复分支代码。

## 1. 审查对象和增量边界

| 项目 | 本轮证据 |
|---|---|
| 日期 | 2026-09-21 |
| 目标分支 | `codex/v3.2.10-architecture-guardrails` |
| 目标 worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails` |
| HEAD / 固定事实基线 | `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，`v3.2.9` |
| 实际审查内容 | 目标 worktree 的 tracked 修改及非 ignored 未跟踪内容；不能只用 HEAD 代表这些实现 |
| 独立完整快照 | `/private/tmp/g8-review3-20260921-8s2fl0fm/snapshot` |
| 冻结清单 | [manifest.json](evidence/manifest.json)，3,097 个路径 |
| 前轮对照 | [第二轮审查](../2026-09-21-r2/review.md)及其 `evidence/snapshot` |
| 修复方声明 | [第二轮修复自检](evidence/repair-source/repair-review.md)，其 22 个文件的最终 hash 与本轮快照全部一致 |
| 依据 | [G8 Spec](../../spec.md)、[G8 TechDoc](../../techdoc.md)、[本轮冻结规则说明](evidence/snapshot/architecture/README.md)；Renderer 注入同时核对 G3 TechDoc |

目标仍有 6 个 tracked 修改：两份 Windows workflow、`AGENTS.md`、`package-lock.json`、`package.json`、`rules/integration-test-policy.md`；实现目录等仍为未跟踪内容。完整状态保存在 [target-status-before.txt](evidence/target-status-before.txt)。未切换、提交、推送、合并或修改目标分支。

相对第二轮冻结，只有 [18 个路径变化](evidence/incremental-files.json)：核心变更为 `scan.js`、`contracts.js`、`rules.js`，新增 `review-round2.test.js`，其余为 README、实施记录和修复证据。`policy-history.js`、schema、边界配置、历史例外、业务 `src/`、`index.html`、依赖和 CI 均无本轮增量。

审查重点为这 9 个旧问题的修复，以及新增返回值解析、绑定调用、工厂公开导出、panel/API 注入、HTML 顺序和 fork 重载的邻接路径。没有重新遍历全部业务语义或任意 JavaScript 反射形式。

## 2. 正式发现

### R3-01 / P2：本地服务工厂返回受限方法引用时仍会漏检

**位置：** [contracts.js:52](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r3/evidence/snapshot/scripts/architecture/contracts.js:52)、[rules.js:208](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r3/evidence/snapshot/scripts/architecture/rules.js:208)。当前目标位置为 [contracts.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/contracts.js:52) 和 [rules.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:208)。

采用真实 `business-task-adapters` 配置，以下本地代码可以让保护函数执行 Position 私有方法：

```js
// src/main.js
const position = require('./main-process/position-reconciliation/task-owner');

function createService() {
  return { settle: position.settle };
}

const service = createService();

function runArchiveAwareOperation() {
  service.settle();
}
```

扫描结果为 **0 violations、0 dynamicSites**。VM stub 观察到 `Position.settle` 被实际调用，证明该属性确实传递了受限能力。

`callableOrigins` 遇到 `member-base` 后只继续分析基对象，丢掉正在访问的 `settle` 属性。随后虽然读取了本地工厂的返回值，却没有继续解析返回对象中的方法引用。最终 `unknown/member-base` 又不在 `rules.js:208` 的失败关闭条件中，因此没有依赖诊断，也没有覆盖诊断。

对照已经验证：

| 相同保护函数使用的返回值 | 实际执行 | 门禁结果 |
|---|---|---|
| `{ settle: position.settle }` | 调用 Position.settle | **错误通过** |
| `{ settle() { position.settle(); } }` | 调用 Position.settle | 正确报 `ARCH-TASK-ADAPTER` |
| 纯本地 `{ execute() { return 1; } }` | 返回 1 | 正确通过 |

**影响：** 同一受限能力用方法包装会被拒绝，直接返回方法引用却可以绕过 G2 的具名作用域保护。这是可以静态定位的本地对象与属性，并不需要推断任意运行时回调。

**契约：** G8 TechDoc §4.8 要求通用函数不能经 helper 依赖 Position，未解释调用别名不能静默忽略；本轮 `architecture/README.md:73` 也明确覆盖工厂返回的服务。

**建议：** 保留成员访问路径，继续解析本地工厂返回对象的对应属性；仍不可解释时应产生覆盖诊断。保留纯本地服务和显式注入 adapter 的合法对照，避免扩大为整个 Main import 禁令。

**证据：** [遗漏用例](evidence/rules-fixtures/g2-local-service-factory/result.json)、[受限包装对照](evidence/rules-fixtures/g2-local-function-member/result.json)、[纯服务对照](evidence/rules-fixtures/g2-local-pure-service-factory/result.json)、[VM 观测](evidence/rules-runtime.jsonl)。R2-01 原有 helper 模块工厂与 const getter 用例均已修复，本项是同一来源追踪能力的剩余缺口。

### R3-02 / P2：fork 三参数重载会丢失明确的 options.cwd

**位置：** [scan.js:566](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r3/evidence/snapshot/scripts/architecture/scan.js:566)；[当前目标文件](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:566)。

新增逻辑仅在第二参数静态描述为 `kind: 'array'` 时读取第三参数：

```js
const options = args[1]?.kind === 'array' ? args[2] : args[1];
```

对于合法三参数调用，第二参数的运行时数组内容不影响已经明确给出的 modulePath 和 cwd。以下两例均使用静态第三参数：

```js
// src/launcher.cjs；两个 fork 分别在独立 fixture 运行
const { fork } = require('node:child_process');
const path = require('node:path');

const argv = process.argv.slice(2);
fork('./src/worker.cjs', argv, {
  cwd: path.join(__dirname, 'jobs')
});

fork('./src/worker.cjs', undefined, {
  cwd: path.join(__dirname, 'jobs')
});
```

fixture 同时放置 `src/worker.cjs`（输出 `wrong-worker`）与 `src/jobs/src/worker.cjs`（输出 `expected-worker`）。真实 Node 子进程运行两例均为退出码 `0`、输出 `expected-worker`；scanner 则得到：

| 第二参数 | 当前 scanner 行为 | 问题 |
|---|---|---|
| `process.argv.slice(2)` | 丢弃第三参数，报 `unresolved-fork-cwd`，没有 worker 边 | 已知 cwd 被当作未知，合法调用误报 |
| `undefined` | 把第二参数当作无 options，使用仓库 root，生成到 `src/worker.cjs` 的边；0 violations、0 dynamicSites | **错误目标被静默放行** |

**影响：** 同一重载判断既会阻断合法启动代码，也会把执行目标指向错误文件，使依赖方向和循环检查依据错误的 worker 边。

**契约：** G8 TechDoc §3.2、第 59 行要求可解析 `child_process.fork` 目标进入 worker 边；Spec G8-AC-08 要求已知位置解释完整；本轮 `architecture/README.md:71` 明确支持 `(path, args, options)` 的显式 cwd。

**建议：** 根据真实参数重载识别 options，保留明确存在的第三参数。argv 内容是否静态可知应与 cwd 是否确定分开处理；对第二参数省略或 `undefined` 的三参数形式增加真实子进程对照。

**证据：** [新旧扫描及运行结果](evidence/scanner-r3-probes.json)中的 `r2-08-runtime-argv`、`r2-08-undefined-argv`；[探针源码](evidence/scanner-r3-probes.cjs)。原 R2-08 的 `(path, options)` 与 `(path, [], options)` 两例已正确修复。这里把共同根因合为一项；运行时 argv 误报是本轮新增回归，`undefined` 的错误目标是剩余覆盖缺口。

## 3. 第二轮逐项复验

| 第二轮编号 | 原问题 | 第三轮结果 |
|---|---|---|
| R2-01 / P2 | helper 工厂传递闭包、const getter 隐藏 Position 调用 | 原例已修复；同类本地对象返回缺口见 **R3-01** |
| R2-02 / P2 | bound postMessage 隐藏未知恢复消息 | **关闭**：现报 `ARCH-STATIC-COVERAGE`，静态 recover、预绑定实参等对照正确 |
| R2-03 / P2 | getter 后 bound prepare 隐藏 DB 查询 | **关闭**：现报 coverage；直接 DB 调用拒绝，RegExp.exec 合法 |
| R2-04 / P2 | 真实 DOM panel 注入误报 | **关闭**：原 getElementById 节点注入通过，VM 验证传入同一节点；全局根/动态来源继续拒绝 |
| R2-05 / P2 | 精确挑选 desktopApi 方法误报 | **关闭**：原冻结 scoped 对象通过；VM 确认只暴露 import 且可调用，完整 API 仍拒绝 |
| R2-06 / P2 | 具名函数表达式、const 公开别名被当作缺失工厂 | **关闭**：原两例 CLI 由 1 变为 0；私有同名不能冒充公开定义；真实 Git 迁移链正反例符合预期 |
| R2-07 / P2 | 先同步 provider、后 async consumer 误报 | **关闭**：原例通过，异步 provider/反向顺序仍拒绝，双 defer 控制组通过 |
| R2-08 / P2 | fork 忽略 options.cwd | 原两个静态重载已修复；完整重载缺口见 **R3-02** |
| R2-09 / P3 | textarea 中伪 template 结束标签激活惰性 script | **关闭**：原 inert script 不计入装配，真实后续 script 和注释对照正确 |

R2-04/R2-05 的独立新旧对照见 [renderer-r3-result.json](evidence/renderer-r3-result.json)。公开工厂定义见 [history-factory-alias-result.json](evidence/history-factory-alias-result.json)；两次改名的真实 Git 历史 7 场景见 [history-public-factory-migration-result.json](evidence/history-public-factory-migration-result.json)。

另检查了“只创建预绑定 recover 函数，尚未执行即被诊断”的现象。VM 确认创建时未发送消息，但 G1 同时限制 raw API 的引入/透传，目前不能证明该合成装配属于 Spec 明确允许的方向。因此**不计正式 finding，不要求增设豁免**；分析保存在 [rules-review.md](evidence/rules-review.md)。

## 4. 验证结果及边界

| 验证 | 结果 / 证据 |
|---|---|
| 架构单测全套 `node --test tests/unit/architecture/*.test.js` | **114/114 通过**，0 fail/skip；[日志](evidence/architecture-tests.log) |
| 当前完整快照 CLI `node scripts/check-architecture.js --json ...` | **退出码 0**；[JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| 生产解析 | 685/685；2,254 字面量本地边、64 worker 边、5 global 边；0 parseErrors |
| 覆盖报告 | 2 unresolved、33 dynamicSites 已按配置解释；不等于这些计数为零 |
| 边界状态 | active 2、pending 21、partial 8；不表示 G1–G7 已激活或验收 |
| 例外 | 114 个例外条目，当前匹配记录 142、stale 0；本轮配置未变，没有通过增加例外消除问题 |
| 独立复现 | G2 VM、fork 真实 Node 子进程、Renderer VM、真实 Git 历史及新旧扫描对照，详见逐项证据 |
| whitespace | `git diff --check` 退出码 0 |
| 修复方最终 manifest | 22/22 一致 |
| 目标与独立快照保护 | 分别复核 3,097 个路径，hash 零变化、零新增路径；目标 HEAD/branch/status 未变 |

完整保护证据见 [preservation.json](evidence/preservation.json)。创建本审查目录之前，主工作区 status 也与起始一致。本轮只向主工作区新增该审查目录及临时审查文件。

没有重跑完整 `release-check`：本轮为只读增量审查，修改集中于架构分析器，架构全套测试、CLI 和定向反例覆盖了本轮目标；前轮历史 release-check 不能代替本次最终内容的完整门禁。后续若进入 PR-ready/发布，应按 CODEX 重新验证最终候选。

没有执行 Electron GUI、真实浏览器 HTML 运行、Windows 安装包或 Excel/WPS 验收。panel 的真实领域归属/生命周期、preload 运行时方法类型及 G1/G2/G5 业务行为仍由对应分支的行为测试验证。本次 VM 和子进程只证明合成 fixture 的行为。

## 5. 证据重放

[evidence/README.md](evidence/README.md)列明文件、重放命令和冻结范围。原始证据保留执行时路径；另提供 [replay-findings.cjs](evidence/replay-findings.cjs)，使用本目录冻结的扫描器和配置，在新的临时目录重放两项正式发现及控制组。该脚本断言“本轮观察到的缺陷仍可复现”，成功退出不表示门禁实现无缺陷。

本报告只对上述冻结内容和增量范围成立。未修改代码、提交、推送、合并、开 PR、启用自动任务或发布。
