# v3.2.10 architecture-guardrails 第五轮审查

**结论：R4-01 的原始本地函数反例已修复；本轮仍确认 1 项 P2——登记 operation 的身份解析不完整，暂不建议判为审查通过。** 该缺口有导入成员和本地工厂返回函数两种具体形式，合并记录为 **R5-01**，不拆成多个别名问题。两种形式在第四轮工具中也存在，不称为此次修复新引入的回归。

本次没有确认真实业务事故或 P0/P1；发现针对架构门禁的漏检。目标实现保持只读，只新增审查文档与合成验证证据。

## 1. 审查对象和范围

| 项目 | 本轮证据 |
|---|---|
| 日期 | 2026-09-21 |
| 分支 | `codex/v3.2.10-architecture-guardrails` |
| 目标 worktree | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails` |
| HEAD / 固定基线 | `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，`v3.2.9` |
| 实际对象 | 目标 HEAD 加 tracked 修改和非 ignored 未跟踪实现，不能仅用 HEAD 代表此次内容 |
| 完整独立快照 | `/private/tmp/g8-review5-20260921-zhxhtb6u/snapshot`，共 [3,128 个路径](evidence/manifest.json) |
| 对照 | [第四轮报告](../2026-09-21-r4/review.md)及其冻结工具；[修复方自检副本](evidence/repair-source/repair-review.md) |
| 契约 | [G8 Spec](../../spec.md)、[G8 TechDoc](../../techdoc.md)、[现行规则说明冻结](evidence/snapshot/architecture/README.md) |

目标仍有 6 个 tracked 修改及未跟踪实现目录，详见 [起始状态](evidence/target-status-before.txt)。相对第四轮共 [18 个变化路径](evidence/incremental-files.json)：**只有 `rules.js` 的实现变化**，新增 `review-round4.test.js`，其余为 README、实施记录和修复证据。`scan.js`、`contracts.js`、history、schema、CLI、Spec/TechDoc、机器配置、历史例外、依赖、CI、业务 `src/` 和 `index.html` 均无本轮增量。

范围集中于 R4-01 的关闭、operation 配置与调用身份匹配、合法纯服务/局部同名/注入/独立 composition 以及既有导入调用保护。未重新遍历全部业务或任意运行时反射形式。

## 2. R5-01 / P2：登记 operation 的配置身份与实际调用身份没有完整对齐

**位置：** [目标 rules.js:185](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:185)，配置解析为 185–191 行，调用匹配为 213–217 行；[冻结源码](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r5/evidence/snapshot/scripts/architecture/rules.js:185)。

当前真实 `business-task-adapters` 配置将 `settlePositionArchiveResult` 登记为 `src/main.js` 的受限 operation。修复后能够匹配直接本地函数的词法身份，但配置端仍回退到原名称，或仅保留本地函数列表；调用端解析出的其他真实来源因此无法匹配。

### 形式 A：导入的受限方法经服务成员返回时漏检

```js
// src/main.js
const { settlePositionArchiveResult } =
  require('./main-process/position-reconciliation/operation-lifecycle');

function createService() {
  return { settle: settlePositionArchiveResult };
}
const service = createService();

function runArchiveAwareOperation() {
  service.settle();
}
```

在真实边界配置、无历史例外的 fixture 中，当前结果为 **0 violations、0 dynamicSites**，VM 确认实际执行该导入方法。实际调用来源已识别为 `operation-lifecycle.js`，但 `origins.functions` 只包含 `createService`，原候选也不再包含 operation 名称。配置只以 functions/名称匹配，未保留并匹配导入的模块与导出成员身份。

这与生产 Main 的实际导入形式一致：原文件第 300 行从该模块解构导入 `settlePositionArchiveResult`。额外只读扫描确认该模块的 **9 文件本地闭包没有命中其他受限模块条目**，不能期待模块闭包规则自动补上此 operation 限制。详见 [真实导入与闭包证据](evidence/production-import-closure.json)。此证据不表示当前生产调用已经改成上述绕过形式。

同一导入方法直接调用或通过方法包装调用均报 `ARCH-TASK-ADAPTER`；纯服务成员选择继续合法。详见 [新旧扫描及 VM 对照](evidence/imported-operation-result.json)。

### 形式 B：受限 operation 由可解析本地工厂初始化时，直接调用也漏检

```js
function makeSettlement() {
  return function performSettlement() {
    calls.push('settled');
  };
}
const settlePositionArchiveResult = makeSettlement();

function runArchiveAwareOperation() {
  settlePositionArchiveResult();
}
```

这里 `calls` 由 VM 提供。配置定义与调用两端的 `callableOrigins()` 均已解析成功，包含 `makeSettlement.performSettlement`，并且 `known=true`、`unresolvedReturn=false`。但配置端第 190 行显式排除 `definition.kind === 'call-result'`，回退到字符串 `settlePositionArchiveResult`，与调用侧真实函数身份不一致。

直接调用及再经 service 成员调用，均为 **0 violations、0 dynamicSites**，VM 记录 `settled`。将同一 operation 直接定义为具名函数表达式则被正确拒绝；纯本地函数使用同样的工厂初始化结构仍合法。详见 [定义与调用来源](evidence/rules-origins.json)、[运行对照](evidence/rules-runtime.jsonl)。

### 影响、依据与修复方向

两种形式都使明确登记的禁用操作在可解析的引用转换后失去约束。不是任意 callback 或运行时反射推断：形式 A 已有明确模块/导出来源，形式 B 已有明确返回函数身份。

依据为 **G8 TechDoc §4.8 / Spec G8-AC-17**：通用 Main 编排不能调用 Position settlement 私有操作，可追踪 const/function alias 纳入检查；机器配置已准确列出该 operation。新旧对照确认两种形式都是已有余漏，第四轮原例关闭的结论不变。

建议配置侧与调用侧使用一致且完整的绑定身份：保留本地函数身份、导入模块和导出成员；不要直接跳过能够解析的本地返回值。确实不能解释时应诊断覆盖缺口，不能静默依赖不匹配的名称。保留纯服务、局部同名、显式注入、准确 allowedSite 和独立 composition 的合法方向，不扩大成整个 Main 或整个模块禁令。

两种形式合为 **1 项 P2**，不按每个语法变体分别计数。独立重放入口为 [replay-identity.cjs](evidence/replay-identity.cjs)，[结果](evidence/replay-identity-result.json)保留原 R4-01 关闭、上述缺口与控制组。

## 3. R4-01 的关闭与合法方向

| 同一输入的新旧对照 | 第四轮违规数 | 第五轮违规数 | VM |
|---|---:|---:|---|
| service 成员引用直接定义的本地受限函数（原 R4-01） | 0 | **1** | `settled` |
| 直接调用该本地函数 | 1 | 1 | `settled` |
| 方法包装调用该本地函数 | 1 | 1 | `settled` |
| 同结构返回纯本地函数 | 0 | 0 | `pure` |

因此 **R4-01 原始反例关闭**。本轮新增回归还覆盖七个已登记 Main 操作、嵌套成员/别名/候选/bind/call/apply、直接函数表达式和 const/bound 别名、局部同名函数、显式注入、其他文件同名函数、精确 allowedSite 与作用域搬迁、导入操作直接调用，全部包含于本轮 131 项架构测试。

本轮没有修改共享 scanner/contracts 或 Renderer/history 规则；其原有回归随完整架构套件运行，没有另做无关语法扩展。有限复核未发现需要另列的合法调用回归。

## 4. 验证与保护

| 验证 | 本轮独立结果 |
|---|---|
| 环境 | macOS arm64 / **Node v24.13.0**；不借用修复方 Node v25.8.0 的结果 |
| `node --test tests/unit/architecture/*.test.js` | **131/131 通过，0 fail/skip，退出码 0**；[日志](evidence/architecture-tests.log) |
| 完整快照架构 CLI | **退出码 0，0 违规**；[JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| 生产扫描 | 685/685 文件；2,254 字面量本地边、64 worker 边、5 global 边，0 parseErrors |
| 覆盖 | 2 unresolved、33 dynamicSites 沿用既有解释；不等于不存在动态点 |
| 状态及例外 | active 2、pending 21、partial 8；114 条例外全部命中，142 条匹配、0 stale；配置字节未变 |
| 独立证据 | 原 R4-01 新旧差分、两种剩余身份缺口与 VM/纯服务对照、生产导入闭包静态核对 |
| 内容身份 | 修复方最终 manifest **24/24 一致**；[副本](evidence/repair-source/verified-manifest.json) |
| 保护与差异 | 目标和快照各 **3,128 个路径零漂移、零新增路径**；目标 branch/HEAD/status 未变；`git diff --check` 退出码 0 |

详见 [验证摘要](evidence/validation-summary.json)和[保护记录](evidence/preservation.json)。创建本审查目录前主工作区 status 与开始一致；本次只新增报告目录及临时审查文件，没有修改实现、提交、推送、合并、开 PR 或发布。

没有重跑完整 `release-check`：本轮为单一架构规则修复的只读增量审查，采用全架构套件、CLI 与独立反例。旧全量日志不能代替当前最终代码；进入 PR-ready/正式集成/发布前，须对最终候选执行完整门禁。

没有执行 Electron/真实浏览器、Windows workflow/安装包、Excel/WPS 验收。pending/partial、文件存在及 AST PASS 不代表 G1–G7 领域隔离、恢复授权、资金或生命周期验收完成。

## 5. 证据与后续审查边界

[证据说明](evidence/README.md)列明冻结文件与重放命令。下一轮应把登记 operation 的完整绑定值与实际调用来源作为同一身份链核验，复验本报告两种形式及合法控制组。此次结论仅对已冻结内容和上述增量范围成立。
