# G8 第三轮审查修复自检

2026-09-21。**R3-01、R3-02 两项 P2 已完成修复，最终架构套件 124/124、固定基线 CLI 均通过。** 本文件是实现者自检；本轮修复后的独立复审尚未执行，G8 领域激活与 release 集成仍未完成，不据此认定全部验收通过。

## 审查输入与代码状态

- 依据主工作区[第三轮独立审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r3/review.md)、[G8 Spec](../../spec.md)、[G8 TechDoc](../../techdoc.md)；原报告只读，逐字节副本为 [source-review.md](source-review.md)。副本内相对链接仍按原审查目录解释。
- 分支 `codex/v3.2.10-architecture-guardrails`；worktree `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`；HEAD 仍为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。修复基于 HEAD 加原未提交内容，未提交、推送、合并、开 PR、升版或发布。
- 本轮修改 contracts.js、scan.js、rules.js，新增 review-round3.test.js，并更新 architecture/README.md、implementation-notes.md；[六文件增量差异](evidence/repair-diff.patch)相对接手时工具归档生成，包含未跟踪实现，不能用仅 tracked 的 diff 代替。配置、例外、schema、CLI、依赖、CI 和生产 src/index.html 均无本轮改动。

## R3-01：本地服务返回的具体成员

**依据：TechDoc §4.8 / G8-AC-17。** 原最小复现 `{ settle: position.settle }` 在 VM 中实际执行 Position 能力，修复前零诊断；修复后明确报 ARCH-TASK-ADAPTER，依赖路径包含 Position task-owner。方法包装对照继续拒绝。

[contracts.js](../../../../../../scripts/architecture/contracts.js) 在本地返回链上保留待访问的成员路径，按对象属性逐层选择函数来源；[scan.js](../../../../../../scripts/architecture/scan.js) 保留 `const invoke = service.settle` 中的基对象和成员。[rules.js](../../../../../../scripts/architecture/rules.js) 对本地返回链的未解释结果报告 coverage，不再因外层是 unknown/member-base 而静默跳过。

新增回归覆盖嵌套成员、箭头/多层返回、freeze/const 别名、条件候选、let 候选、字面量计算属性及 bind；缺失成员、未知函数结果、动态成员、spread/getter、递归不透明结果不能通过。纯本地服务、显式 adapter 注入、同一 Main 中的独立领域装配仍通过；未使用的另一字段持有 Position 引用不自动把纯方法调用判为越界。

修复中曾尝试拒绝所有未知成员调用，固定基线暴露了既有 this/注入对象调用误报。最终将新增 coverage 限定到本地工厂返回链，保持原边界。对于无 reviver 的原生 JSON.parse 数据，map/slice 识别为数据读取；reviver 或 JSON 遮蔽不享有该识别。相关合法/拒绝对照已加入测试，没有新增历史例外来吸收误报。此识别不证明业务 JSON 内容、类实例内部状态或任意反射行为。

## R3-02：fork 的真实重载与目标

**依据：TechDoc §3.2 / G8-AC-08。** 本轮读取当前 Node 的实际 fork 实现，并用真实子进程验证其参数规则：数组或 undefined/null argv 使用第三参数；第二参数明确为对象时，它作为 options 并覆盖第三参数。

scanner 现在区分 argv 的内容和重载身份：数组内容可动态，原生 `process.argv.slice`、`process.execArgv.slice`、`Array.from/of` 与 undefined/null 均保留明确第三参数。已知对象按 options 重载优先，有限候选逐一检查。`fork('./src/worker.cjs', process.argv.slice(2), {cwd: ...})` 和 undefined 原例均与 Node 一致选择 `src/jobs/src/worker.cjs`。

补充真实子进程验证 null、bind/call/apply 与第二参数对象优先。还复现了 `getArgs()` 实际返回 options 对象、第三参数却指向另一个 cwd 的相邻歧义：该重载身份无法静态解释时，现报告 ARCH-STATIC-COVERAGE，不生成错误 worker 边。未知第二参数形态、未知 cwd/options 不能仅因第三参数存在而放行。两参数原重载、绝对目标及默认 Worker 回归继续通过。

## 最终验证与保护

所有项目命令显式使用上述 worktree；平台为 macOS arm64 / Node v25.8.0。测试使用合成 fixture，scanner 不加载或执行业务代码。

| 验证 | 结果与证据 |
|---|---|
| 修复前复现 | 原两项对应 3 个测试均失败（fork 两种 argv）；[原始日志](evidence/regressions-before.log)。收尾补充的重载歧义也先失败后修复，[日志](evidence/overload-ambiguity-before.log)。 |
| `node --test tests/unit/architecture/*.test.js` | **124 pass / 0 fail / 0 skipped，exit 0**；原 114 组加本轮 10 组，包含 AC22 真实 Git 历史恢复及 local/PR/push/tag/manual CLI。[最终日志](evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <本轮绝对报告路径>` | **exit 0**；685/685 文件、2254 字面量本地边、64 worker、5 global；0 违规。[JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| 状态与例外 | active 2 / pending 21 / partial 8；114 条例外全部命中（142 条匹配），0 stale。未解析 2、动态位置 33 保持原登记口径，不代表任意数据流已解析。 |
| 语法与差异 | 16 个工具/测试文件 no-undef 无错误；git diff --check、变更文件尾随空白、文档链接检查通过。[lint](evidence/no-undef.json)、[交付核对](evidence/delivery-check.json) |
| 内容身份 | [测试时代码清单](evidence/tested-code-manifest.json)覆盖 16 个工具/测试文件；[最终清单](evidence/verified-manifest.json)覆盖 23 个工具/测试/配置/依赖/CI 与现行说明文件；结束前均核验无漂移。 |
| 工作区保护 | 主工作区接手时 **429 个未提交文件哈希不变**；目标原 98 个文件只发生列出的 5 个预期修改，另新增回归与证据；src/index.html 无差异，两个机器配置字节不变。[保护记录](evidence/preservation.json) |

中间失败与最终结果分别保存；最初的全未知成员拒绝及中间 JSON 数据误报不能当作最终诊断，先前的通过结果也不代替本次最终运行。[机器可读总览](evidence/verification.json)与[证据说明](evidence/README.md)保留这一边界。

## 实施状态、规则入口与剩余事项

[实施记录切片 G](../../implementation-notes.md)已按总索引 §6.2–§6.4 分别记录职责与边界、调用方与兼容、业务行为、验证证据和当前规则入口，并区分实现/验证/集成状态。[architecture/README.md](../../../../../../architecture/README.md)更新了返回成员与 fork 重载的实际支持范围，机器配置正文不变。

本轮必要专项完成；修复后独立复审待执行。G1–G7 未落地到本分支的边界继续 pending/partial；实际规则对齐、例外清理、领域行为验证和激活仍需在明确授权的固定 release 集成候选进行，本轮没有借用浮动 release 证据。

**本轮未运行完整 release-check，旧全量日志不覆盖当前代码。** 按 CODEX 与总索引 §6.2，本次检查器修复采用必要专项验证；正式集成/PR-ready 前须在最终候选重跑完整门禁。未执行 Electron/真实浏览器、Windows workflow/安装包、Excel/WPS 验收。VM、子进程和临时 Git 测试不证明生产资金、恢复授权或生命周期安全。

回退依据本轮增量 patch 与 `/private/tmp/g8-r3-fixes-before/tooling.tar.gz`，仅撤回切片 G 的工具、测试与说明，保留此前实现和历史证据；不涉及业务数据回退。
