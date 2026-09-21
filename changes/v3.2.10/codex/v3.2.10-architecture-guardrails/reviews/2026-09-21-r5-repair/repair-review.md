# G8 第五轮审查修复自检（R5-01）

R5-01 的两种形式已修复：导入方法经服务成员返回，以及本地工厂初始化的受限函数。新增 12 组回归，完整架构套件 **143/143**、固定基线架构 CLI 均通过；原审查 9 个场景的新旧工具对照中，3 个缺陷场景全部转为拒绝、6 个控制场景保持原结果。**这是实现方修复自检，独立复审尚未执行，G8 全部验收仍不能标为通过。**

## 输入、代码状态与保护

- 原审查：[第五轮报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r5/review.md)；本 worktree 留存[原件副本](source-review.md)，主工作区原件未改。
- 合同：[G8 TechDoc §4.8](../../techdoc.md#48-g2arch-task-adapter)、[Spec G8-AC-17 / AC12](../../spec.md)、[总索引 §6.2–§6.4](../../../../README.md#slice-completion)。继续保留既有 AC22 实际 Git 历史恢复测试。
- 工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`；分支 `codex/v3.2.10-architecture-guardrails`；HEAD `11086a3cbf632a30adbcfa796e4cd81810c5aef9`（v3.2.9）+ 原有未提交实现 + 本轮增量。
- 修改前归档 `/private/tmp/g8-r5-fixes-before/tooling.tar.gz`，保护主工作区 643 个、目标 129 个已有 dirty 路径。最终核对见[保护报告](evidence/preservation.json)和[交付检查](evidence/delivery-check.json)。没有重建 worktree、切换分支或覆盖既有实现。
- 本轮代码、配置与验证入口的 [25 项 SHA-256 清单](evidence/verified-manifest.json)，以及测试时 [18 项源码清单](evidence/tested-code-manifest.json)固定实际内容。所有命令明确以该 worktree 为工作目录；测试临时仓库与 VM 均不访问生产业务数据。

## 原因与修正

旧配置端仅解析 `binding.init`，既丢失了解构选择器和 import 的完整绑定，又显式跳过 `call-result`；调用端虽能找到返回目标，但规则仅比较函数路径集合或原始调用拼写。导入成员缺少对应函数路径，本地工厂结果则在配置端退回变量名，造成两端不一致。

本轮同时修正两端，共用 `describeBinding`。最终被调用的能力按 **模块路径 + 完整成员路径** 或 **本文件函数 AST 身份** 匹配。依赖闭包保留独立的模块/函数来源，工厂只因参与返回链而进入依赖分析，不被当作其返回的受限函数。无法完整解释的既有配置绑定报 `ARCH-STATIC-COVERAGE`，不再靠变量名宣称解析成功。

| 文件 | 本轮职责与兼容影响 |
| --- | --- |
| [scan.js:243](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/scan.js:243) | 提取共同绑定解析，保留 import/解构 selector/别名/工厂结果；const、let、var 初始化选中成员与后续赋值分别处理；以本次扫描的 AST 节点位置区分同名函数表达式。 |
| [contracts.js:44](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/contracts.js:44) | `targets` 只记录最终调用能力，保留原 `modules/functions` 作为依赖来源；沿本地返回链逐层选择成员，限定到实际工厂的返回语句。 |
| [rules.js:185](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/scripts/architecture/rules.js:185) | 配置不再排除 `call-result`，与调用使用同一解析及目标匹配；未解释的已有绑定明确报覆盖错误；仍按文件、保护作用域和准确 allowedSite 判断。 |
| [review-round5.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/tests/unit/architecture/review-round5.test.js) | 新增 12 组反例及合法对照，包含 VM 执行事实；ES import 场景只做静态验证，不冒充真实模块加载验收。 |
| [architecture/README.md](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails/architecture/README.md:87) / [实施记录切片 I](../../implementation-notes.md) | 更新现行规则入口、职责与边界、调用方与兼容、业务行为、验证和剩余事项。实现/验证/集成分别登记。 |

本轮相对接手内容的[完整增量 patch](evidence/repair-diff.patch)包含上述 6 个文件，另见[逐文件统计](evidence/diff-stat.json)。该增量不同于相对 HEAD 的整个未提交 G8 实现。配置、allowedSites、历史例外、CI/deps 和所有生产源码均未改；没有新增 Main 整文件导入禁令或运行时业务行为变化。

## 原审查 9 场景重放

使用归档的修复前工具与最终工具，复用原审查源码和 VM oracle。仅调整缺陷场景在修复后必须被拒绝的期望，保留原脚本以便核对。见[重放说明](evidence/README.md)、[修复前结果](evidence/replay-before.json)、[修复后结果](evidence/replay-after.json)。

| 场景 | 修复前违规数 | 修复后违规数 | VM / 结论 |
| --- | ---: | ---: | --- |
| R4 原始本地函数成员引用 | 1 | 1 | 调用 settled，原修复保持有效 |
| 导入 operation 经服务成员返回 | 0 | 1 | 调用 settled，现为 ARCH-TASK-ADAPTER |
| 导入 operation 直接调用 | 1 | 1 | 原保护保持有效 |
| 导入 operation 方法包装调用 | 1 | 1 | 原保护保持有效 |
| 本地工厂初始化 operation 后直接调用 | 0 | 1 | 调用 settled，现为 ARCH-TASK-ADAPTER |
| 本地工厂初始化 operation 后服务成员调用 | 0 | 1 | 调用 settled，现为 ARCH-TASK-ADAPTER |
| 具名函数表达式直接调用 | 1 | 1 | 原保护保持有效 |
| 纯工厂返回函数 | 0 | 0 | 调用 pure，保持合法 |
| 同服务只调用纯方法 | 0 | 0 | 调用 pure，保持合法 |

新增回归还覆盖完整导入链、嵌套成员、绑定/call/apply、ES import、多层工厂、解构和赋值；合法对照覆盖同工厂不同方法、同模块不同导出、不同模块同名导出、局部遮蔽、显式 adapter 参数及独立 composition。未知/递归/不透明工厂配置失败关闭，准确 allowedSite 仍有效，作用域搬迁不能沿用。

## 验证结果与边界

所有下列结果来自本轮 Node v25.8.0 / macOS arm64，非借用旧报告。

| 检查 | 结果 / 证据 |
| --- | --- |
| 原例回归先失败 | 旧实现下 2/2 失败；[regression-before.log](evidence/regression-before.log) |
| `node --test tests/unit/architecture/*.test.js` | exit 0，143/143，0 fail / 0 skipped，含新增 12 组及此前 R1～R4、历史防倒退、AC22 前向恢复与事件 CLI；[完整日志](evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <absolute-output-path>` | exit 0；[文本](evidence/architecture-check.log) / [JSON](evidence/architecture-check.json) |
| 基线及例外兼容 | 当前基线报告与上轮已验证报告内容完全一致：685/685 文件、2254 字面量本地边、64 worker 边、5 global 边，0 违规；114 条例外全部命中（142 条匹配），0 stale；未解析 2、动态位置 33 沿用原口径 |
| 静态语法与未定义变量 | 18 个工具/测试文件 no-undef，无错误；[结果](evidence/no-undef.json) |
| 差异、链接、内容与保护 | `git diff --check`、本轮未跟踪文件空白检查、文档链接、测试代码无漂移、配置与生产源码未改；[交付检查](evidence/delivery-check.json) |

完整机器摘要见 [verification.json](evidence/verification.json)。中间 10 组和 12 组专项日志只记录调试过程，最终以完整 143 组日志和冻结源码清单为准；第一次编辑中的语法括号错误已在专项运行前修正，不计为通过证据。

## 状态与剩余事项

- **实现：已实现。验证：本轮必要专项通过，独立复审待执行。集成：未集成。** active 2 / pending 21 / partial 8 保持真实分支状态；不把其他 worktree 或浮动 release 的代码当作本分支已激活。
- 后续在明确授权的固定 release 集成候选上完成各领域的规则对齐、行为验证、旧例外清理和激活。未落地边界继续 pending/partial；原设计审查通过不代替实现验收。
- 本轮按 CODEX 与总索引 §6.2 对内部检查器修复运行必要专项，**未重跑完整 release-check**；旧全量日志不覆盖当前实现，PR-ready/正式集成前需在最终候选重跑。
- 未执行 Electron/真实浏览器 GUI、Windows workflow/安装包、Excel/WPS 验收。AST、VM 和 fixture 不证明实际业务恢复、资源退出或资金安全；本轮不改变这些生产路径。
- 未提交、推送、合并、开 PR、升版或发布。回退仅按本轮增量及接手归档撤回切片 I，保留此前未提交实现和证据。
