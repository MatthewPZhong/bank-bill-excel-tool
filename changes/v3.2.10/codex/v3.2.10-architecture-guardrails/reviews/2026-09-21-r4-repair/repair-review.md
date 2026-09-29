# G8 第四轮审查修复自检

2026-09-21。**R4-01 已修复，最终架构套件 131/131 通过，基线 CLI exit 0；114 条历史例外全部命中、0 stale。** 这是实现者自检，本轮修复后的独立复审尚未执行。G8 尚未集成或完成领域激活，不能据此认定全部验收通过。

## 输入与代码范围

依据[第四轮独立审查](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r4/review.md)、[G8 TechDoc §4.8](../../techdoc.md)、[Spec G8-AC-17](../../spec.md)。原报告保持只读，[source-review.md](source-review.md)为逐字节副本，其相对证据链接按原审查目录解释。第三轮原例已关闭的结论保留，本轮修复第四轮新增确认的同类余漏。

分支为 `codex/v3.2.10-architecture-guardrails`；工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`；HEAD 仍为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。本轮在既有未提交实现上，只修改 rules.js，新增 review-round4.test.js，并更新 architecture/README.md 与实施记录。scanner、contracts、history、schema、CLI、依赖、CI、机器配置和生产源码没有本轮改动。

[四文件增量差异](evidence/repair-diff.patch)以接手时工具归档为基准，包含未跟踪实现和新测试；[差异统计](evidence/diff-stat.json)单列范围。没有提交、推送、合并、开 PR、升版或发布。

## 修复机制与兼容

原例在 VM 中实际调用 `settlePositionArchiveResult`，检查器却零诊断。[修复前测试](evidence/regression-before.log)明确失败；修复后同一输入报 ARCH-TASK-ADAPTER，与直接调用和方法包装一致。

[规则实现](../../../../../../scripts/architecture/rules.js)将已登记的 operation 静态绑定解析为函数身份，再使用同一源文件中的 `origins.functions` 匹配受限操作。来源不再仅用于扩展扫描函数体；即使目标函数体没有其他受限调用，调用该函数本身也会被检查。配置中的具名函数表达式、const/bound 别名按实际绑定识别；用完整词法函数身份而不是末段名称，保留局部同名函数的合法性。

既有直接表达式检查保留，尤其是生产 Main 中通过导入绑定使用的 `settlePositionArchiveResult`。初版误将所有 module 来源排除，基线扫描虽然 exit 0，却出现 baseline-task-adapter-011 失配。已恢复原有直接操作保护并增加回归，最终所有原例外重新命中；没有通过删除或扩大例外取得通过。精确 allowedSites 仍先按文件、作用域、callee 和 AST 指纹核验。

## 回归覆盖

新增 [review-round4.test.js](../../../../../../tests/unit/architecture/review-round4.test.js) 的 **7 组测试**，其中参数化场景不另计为额外测试数：

1. 原成员引用、直接调用、方法包装均拒绝，纯本地服务通过；VM 验证实际执行结果。
2. 对配置中的全部七个 Main 本地操作，验证返回成员、嵌套、const 成员别名、候选和 bind/call/apply 均拒绝，并运行 VM 对照。
3. 操作绑定采用箭头函数、具名表达式、const 别名或 bound 别名时，直接和返回成员调用均拒绝。
4. 局部同名函数、同名显式注入参数、未使用的另一受限字段、独立 composition 保持合法；VM 验证只执行纯方法。
5. 其他源文件同名函数不继承 Main 的 operation 限制。
6. 精确 allowedSite 仍有效，调用作用域搬迁不能继承授权。
7. 已登记 Main 导入操作的直接调用保护保持有效。

该变更消费已有解析结果，没有宣称支持任意反射、动态代码或跨模块运行时回调推断；此类静态边界仍见现行规则说明。

## 最终验证与保护

所有项目命令显式使用上述 G8 worktree。执行环境为 **macOS arm64 / Node v25.8.0**；用户第四轮独立审查的 Node v24.13.0 结果保留为其历史证据，不作为本轮运行版本。

| 项目 | 最终结果与证据 |
|---|---|
| `node --test tests/unit/architecture/*.test.js` | **131 pass / 0 fail / 0 skipped，exit 0**。包括原 124 组、此前修复及 AC22 的真实 Git 历史恢复和五类事件 CLI。[最终日志](evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <本轮绝对报告路径>` | **exit 0，0 违规**；685/685 文件、2254 字面量本地边、64 worker、5 global。[JSON](evidence/architecture-check.json)、[日志](evidence/architecture-check.log) |
| 状态与覆盖 | active 2 / pending 21 / partial 8；未解析 2、动态位置 33 沿用既有解释，不写成零动态。 |
| 例外 | 配置字节未变；114 个例外 ID 全部命中，142 条匹配、0 stale，未新增 allowedSites。 |
| 补充检查 | 17 个工具/测试文件 no-undef 无错误；git diff --check、变更文件尾随空白和文档链接检查通过。[lint](evidence/no-undef.json)、[交付核对](evidence/delivery-check.json) |
| 内容身份 | [测试时代码清单](evidence/tested-code-manifest.json)记录 17 文件；[最终清单](evidence/verified-manifest.json)记录 24 个实现/配置/依赖/CI/测试/现行说明文件，结束前均无漂移。 |
| 工作区保护 | 主工作区接手时 **548 个未提交文件哈希不变**；目标原 114 个文件只发生 rules.js、规则 README 和实施记录三项预期修改，另新增本轮测试和证据。src/index.html 无差异。[保护记录](evidence/preservation.json) |

[验证摘要](evidence/verification.json)与[证据说明](evidence/README.md)区分最终结果和初版 130 项测试/失配例外诊断。初版通过的测试未被借作最终内容证据。

## 当前规则与剩余事项

[实施记录切片 H](../../implementation-notes.md)按总索引 §6.2–§6.4 记录职责与边界、调用方与兼容、业务行为、验证证据、当前规则入口，并分开填写实现、验证和集成状态。[architecture/README.md](../../../../../../architecture/README.md)已同步同文件 operation 身份、合法遮蔽及准确授权语义。没有改写设计合同或把 pending 边界标成 active。

本轮修复后的独立复审待执行；固定 release 集成候选上的规则对齐、领域行为验证、例外清理和逐项激活仍属后续明确授权的集成工作。本轮不合并 G1–G7，也不借用浮动 release 状态。

**未重跑完整 release-check，旧全量日志不覆盖当前内容。** 按 CODEX 和总索引 §6.2，本轮规则修复执行必要专项；PR-ready/正式集成前须在最终候选执行完整门禁。未运行 Electron/真实浏览器、Windows workflow/安装包、Excel/WPS 验收。VM 与临时 fixture 不证明生产资金、恢复授权或生命周期安全。

如需回退，依据本轮 patch 与 `/private/tmp/g8-r4-fixes-before/tooling.tar.gz` 仅撤回切片 H，保留之前实现和历史证据；不涉及业务数据回退。
