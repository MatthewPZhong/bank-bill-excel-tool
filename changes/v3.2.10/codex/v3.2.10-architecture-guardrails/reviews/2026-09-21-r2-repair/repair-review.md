# G8 第二轮审查修复自检

2026-09-21。第二轮报告的 **8 项 P2 和 1 项 P3（R2-01～09）均已修复并通过本轮专项验证**。最终架构套件 **114/114 通过**，固定基线检查 CLI exit 0。本文件为实现者修复自检；修复后的独立复审尚未执行，G8 真实 release 集成和领域激活仍未完成，不能据此认定全部 G8 验收通过。

## 输入与范围

- 分支 `codex/v3.2.10-architecture-guardrails`，独立 worktree `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`。
- HEAD 仍为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`；基于该 HEAD 加原未提交实现进行修复。本轮不提交、推送、合并、开 PR、升版或发布。
- 依据主工作区[第二轮复审报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r2/review.md)、[G8 Spec](../../spec.md)、[G8 TechDoc](../../techdoc.md) 和报告引用的 G3 panel/scoped API 合同。原报告逐字节副本为 [source-review.md](source-review.md)；原件未修改。
- 本轮代码仅修改 `scripts/architecture/contracts.js`、`scan.js`、`rules.js`，新增 `tests/unit/architecture/review-round2.test.js`；另外更新现行规则说明和实施记录。准确范围见[本轮增量差异](evidence/repair-diff.patch)和[差异统计](evidence/diff-stat.json)。这份差异以修复前归档为基准，包含未跟踪代码，不能用仅含 6 个已跟踪文件的 `git diff --stat` 替代。
- `architecture/boundaries.json`、`legacy-allowlist.json` 字节不变，未新增 allowedSites 或历史例外；上轮已核对的 5 个允许位置、2 个历史例外保持原内容。src/index.html、依赖、CLI、CI 和 schema 未修改。

## 逐项修复与正反证据

首批 9 组回归按审查最小反例加入后，在未修复检查器上 **9/9 失败**，见[修复前日志](evidence/regressions-before.log)。修复并扩展相邻边界后新增 14 组全部通过；原 100 组也重跑通过。以下测试均在 [review-round2.test.js](../../../../../../tests/unit/architecture/review-round2.test.js) 中可重放。

| 问题 / 合同 | 实现与实际结果 | 保留的反向或兼容对照 |
|---|---|---|
| R2-01 / AC17 | 已知工厂来源遍历模块传递闭包；本地 getter 返回函数进入同一来源检查。工厂提供的 Position settle 现在被拒绝，VM 证明原输入实际执行该能力。 | 纯工厂/已解析本地返回函数通过；未知 const/let 工厂结果和递归不透明结果报 coverage。 |
| R2-02 / AC16 | bind 保留 postMessage 目标和预绑定实参，call/apply 归一为同一调用；未知消息报 coverage，recover 字面量报恢复入口违规。 | publish 通过；多次绑定、解构、let、候选别名和未知 apply 实参不能解除检查；stub 确认实际消息为 recover。 |
| R2-03 / AC18 | getter 后绑定 prepare/exec 保留敏感方法身份；未知句柄报 coverage，已知原始 DB 操作报查询违规。 | RegExp.exec 的直接绑定保持合法；stub 实际记录 SQL，预绑定 SQL、call/apply 同样拦截。 |
| R2-04 / AC05、G3 §4 | panel 与 API 方法对象分别检查；静态 getElementById/querySelector 单根来源及其 const 别名通过，VM 确认同一节点被传入。 | document、body、modalRoot、动态 selector、不透明 getter、把 DOM 放进 api 均拒绝。真实节点领域归属仍由 G3 行为验证。 |
| R2-05 / AC05、G3 §4 | 显式 API 对象可以精确挑选 desktopApi 方法，包括 freeze/const 别名和嵌套授权叶路径。VM 确认对象只暴露 import 且调用原方法。 | 完整 API、namespace、额外方法、借用不同嵌套路径仍拒绝；未增加方法包装器要求。 |
| R2-06 / AC10/12、历史 AC21 | 按公开导出键解析真实函数；具名表达式、const alias、对象导出不要求内部函数同名，完整 Git fixture CLI 均 exit 0。 | 仅有私有同名函数、不透明导出仍 exit 1；原假改名及旧调用残留的历史回归继续通过。 |
| R2-07 / AC10 | 前序同步 provider 已确定执行时允许后续 async consumer。 | consumer 提前出现、provider async 或 defer 对 async consumer 均不能保证先行，继续拒绝。 |
| R2-08 / AC08 | fork 两种 options 重载读取静态 cwd；真实子进程与扫描器均选择 src/jobs/src/worker.cjs。bind/call/apply 复用同一解析。 | 默认 Worker 规则保留；静态 cwd 候选逐一解析，未知 cwd/options/spread 报 coverage，绝对目标不依赖 cwd；非法数值目标受控失败。 |
| R2-09 / AC10（P3） | textarea/title 和支持的 raw-text 内容跳过标签计数，伪 template 结束文本不能激活惰性脚本。 | 测试覆盖 textarea/title/style/xmp/iframe/noembed/noframes/noscript；模板里的 provider 仍不计已装配。 |

核心职责分配见 [contracts](../../../../../../scripts/architecture/contracts.js)、[scanner](../../../../../../scripts/architecture/scan.js)、[rules](../../../../../../scripts/architecture/rules.js)。工厂存在性仍被规则执行与历史校验共用，避免两者对同一公开入口给出不同结论。检查器只读取 AST 与配置，不执行生产模块。

## 最终验证

所有项目命令显式使用上述 G8 worktree 的工作目录。运行平台 macOS arm64 / Node v25.8.0，复用已安装依赖，未新增依赖。

| 验证 | 结果与证据 |
|---|---|
| `node --test tests/unit/architecture/*.test.js` | exit 0；114 pass / 0 fail / 0 skipped；包含上一轮 100 组及 AC22 真实 Git 恢复历史、五类事件 CLI。[完整日志](evidence/architecture-tests.log) |
| `node scripts/check-architecture.js --json <本轮绝对报告路径>` | exit 0；685/685 文件，2254 字面量本地边，64 worker，5 global；0 违规、114 条例外全部命中（142 条诊断匹配）、0 stale。[JSON](evidence/architecture-check.json)、[终端日志](evidence/architecture-check.log) |
| 覆盖状态 | active 2 / pending 21 / partial 8；未解析 2、动态位置 33 保持既有登记口径，不代表任意数据流已解析。 |
| 工具/测试 `no-undef` | 15 文件、0 错误。[结果](evidence/no-undef.json)。首次验证 helper 误用旧 eslintrc 格式导致配置错误，改用已安装 ESLint 的 flat config 后通过，没有因此修改源码或屏蔽规则。 |
| 差异与保护 | `git diff --check` 通过；主工作区接手时 293 个未提交文件哈希不变，目标原 85 个文件仅发生列出的 5 个预期修改，另外新增本轮回归与证据；src/index.html 无差异。[保护记录](evidence/preservation.json) |
| 最终内容身份 | 22 个工具、测试、配置、CI/依赖和现行说明文件的 SHA-256 列于[验证文件清单](evidence/verified-manifest.json)。不复用上轮 21 文件哈希冒充当前内容。 |

验证结束后仅清理 scan.js 一行既有尾随空格，Acorn AST 对比完全相同；[归一化前后指纹](evidence/whitespace-normalization.json)保留该转换，最终清单记录清理后内容。没有在测试后修改规则逻辑。

机器可读总览：[verification.json](evidence/verification.json)。本轮必要专项覆盖检查器行为和合成调用链；依照 CODEX 的风险验证要求，没有扩大为全量业务门禁。**本轮未运行完整 release-check，旧全量通过日志不覆盖本次内容。** 正式集成或 PR-ready 前应在最终合并候选重跑完整门禁。

## 当前规则、剩余事项与回退

[architecture/README.md](../../../../../../architecture/README.md) 已同步调用来源、绑定操作、公开导出、DOM/API 区别、脚本先行关系与 fork cwd 的规则说明；机器配置正文仍在原两个 JSON。按照总索引 §6.2–§6.4，职责与边界、调用方与兼容、业务行为、验证证据、当前规则入口均记录于[实施记录切片 F](../../implementation-notes.md)。实现、验证、集成分别记录，没有将设计通过或 fixture 通过记成领域激活。

剩余事项是本轮独立复审，以及经明确授权的固定 release 集成候选上的路径/合同对齐、旧例外清理、领域真实行为测试和逐项激活。原 release@9602a1fa 登记仅保留历史意义；本轮未合并或借用后续浮动 release 状态。未落地到本分支的边界保持 pending/partial。

静态 panel 来源不能证明节点真实存在、领域归属和生命周期；方法路径不能完整证明运行时函数类型；HTML 测试没有浏览器真实执行证据。VM/stub、真实 fork 和临时 Git 仓库结果均属合成验证，不证明生产恢复、数据库或资金安全。未执行 Electron GUI、Windows workflow/安装包、Excel/WPS 验收。

如需撤回本轮修复，可依据增量 patch 和 `/private/tmp/g8-r2-fixes-before/tooling.tar.gz` 恢复切片 F 的工具/测试/说明，保留接手前实现与历史证据；不涉及业务数据回退。
