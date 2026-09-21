# G8 R1–R10 修复与实现自复核

日期：2026-09-21。**十项已修复，100 个架构测试通过，固定 v3.2.9 扫描通过；可交付独立复审。** 本文是实现者针对已有审查的修复复核记录，不能替代新的独立审查，也不宣称 G1–G7 生产边界已激活。

原审查：[原样副本](source-review.md)。本轮没有改动原审查结论与证据；A/B/C 旧实施状态只保留为历史证据，最新状态以[实施记录切片 E](../../implementation-notes.md)为准。

## 对象与保护

- 独立 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails`。
- 分支：`codex/v3.2.10-architecture-guardrails`；HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`。
- 审查对象始终为 HEAD + 未提交实现。所有项目命令显式使用该 worktree 的工作目录；未创建重复分支或重置已有实现。
- 交付差异：[仅本轮八个代码/规则文件的修复差异](evidence/repair-diff.patch)。它相对本轮接手前内容，包含新 contracts 与回归文件，不混入此前未提交实现。
- [冻结指纹](evidence/verified-manifest.json)覆盖 21 个检查器/测试/配置/依赖与 CI 文件；[保护结果](evidence/preservation.json)核对主工作区原有 179 个未提交文件及目标工作区原有 74 个文件，无非本轮修改漂移；`src` 与 `index.html` 相对 HEAD 无差异。

## 逐项修复与验证

| 发现 | 实现后的行为 | 正反对照与结论 |
| --- | --- | --- |
| R1 StaticBlock | scan 为 StaticBlock 单独建立词法和 var 作用域。 | var/let/const 块内 require 不形成 Node 依赖，块外 fs 形成唯一禁止边；VM 实际返回 function。通过。 |
| R2 factory 改名 | active 工厂核对登记文件中的定义及生产调用；历史迁移核对新工厂与旧调用是否真实迁移。 | 真实 Git S1→当前：仅改配置 exit 1；新定义存在但旧调用残留 exit 1；真实迁移 exit 0；新工厂非法 write 仍 exit 1。缺定义/消费者报告覆盖错误。通过。 |
| R3 dynamic operation | 遍历 op/operation/lifecycleOperation 候选；含 recover 检查准确授权位置，保护范围内未知操作报 coverage。 | 条件/逻辑表达式 recover 被拒，stub 确认实际收到了 recover；未知参数及整消息失败；仅 publish/prepare 通过。准确授权和旧例外不能转移到新 AST。通过。 |
| R4 task alias | 根据候选来源核对受限模块、操作和本地 helper；去除 Position 变量名兜底；不透明可变调用报 coverage。 | const/let/赋值后别名/本地 helper 都拒绝受限 settle；未知 factory 别名拒绝；明确 adapter/默认回调允许。通过。 |
| R5 DB getter | call 记录保留语法 method；prepare/exec 的未知 receiver 报 coverage。 | getter raw DB 不再消失；直接 SQL 仍违反查询边界；query facade 和 RegExp.exec 允许。getter 未被宣称已完全解析，采用失败关闭。通过。 |
| R6 API helper | 工厂字段不能以不透明 call-result/candidates 代替 scoped 对象。 | 完整 desktopApi、getter、条件对象、嵌套 getter/full API 都拒绝；显式方法对象仍允许。通过。 |
| R7 scripts | tokenizer 跳过嵌套 template，装配检查使用同步/defer/async/module 模式与顺序。 | 同步 provider 或合法 defer 顺序通过；defer/module/async provider 对同步 consumer 失败；template 内 provider 不计为已加载。通过。 |
| R8 Worker path | 相对 Worker/fork 文件路径以扫描根（运行 cwd 合同）解析；path.resolve 的相对输入也使用扫描根。 | 两个候选目录同时有 worker 时仍选根目录的真实目标；实际 Node Worker 输出 worker-ran 且 exit 0；__dirname/URL 原有测试通过。通过。 |
| R9 dotted API | 按嵌套叶路径验证 allowedApiFields，检查每层 spread/getter/未知对象。 | scenarios.list 及冻结对象通过；write、嵌套 spread、getter 拒绝。通过。 |
| R10 scope strength | 执行规则与历史校验共享 scopeContains，父函数覆盖嵌套函数。 | 真实 Git CLI 中 inner→父函数 exit 0；已扩大后反向缩小和同前缀兄弟范围 exit 1。通过。 |

测试入口：[review-regressions.test.js](../../../../../../tests/unit/architecture/review-regressions.test.js)。十项原反例先形成 11 个失败测试（R2 拆为两个），[修复前日志](evidence/regressions-before.log)保留实际失败。补充登记约束与误报对照后，共 16 个新增测试，[专项日志](evidence/review-regressions.log)全部通过。

## 基线新增诊断的逐项处理

没有用修改生产源码、目录豁免或清空保护范围使基线通过。[登记证据](evidence/reviewed-registrations.json)保存准确位置、原始提交和理由：

- 5 个 `allowedSites` 是合法职责：Archive 批次查询、Archive outbox 刷新、保护路径数组拼接、启动期 task binding 查询、worker 退出通知。仅限各自函数/callee/AST 指纹；源码修改需要重新核对职责。
- 2 个 `legacy-allowlist` 是 G1 待迁移的历史覆盖债务：原 `runWorkerJob` 转发 `op` 的 postMessage，以及原 `execute` 把动态 `op` 传给 runWorkerJob。它们与 v3.2.9 固定提交源码逐字节一致；新增任意函数不能继承。G1 active 时不接受这些旧例外，后续必须验证授权事务并删除。
- 既有 112 个例外未扩散到新位置；本轮增加上述两个，合计 114 个全部命中，stale 0。新增反例本身均未进入配置或例外。

## 最终验证与证据边界

| 检查 | 实际结果 |
| --- | --- |
| `node --test tests/unit/architecture/*.test.js` | **100/100 pass，0 fail，0 skipped**；22.33 秒。[完整日志](evidence/architecture-tests.log)。包含原 AC20–22 历史防倒退/损坏 JSON 前向恢复及本地、PR、push、tag、manual 参数测试。 |
| `node scripts/check-architecture.js --json <绝对路径>` | **exit 0**；685/685 文件，2254 字面量本地边，64 worker 边，5 global 边；0 违规，114 例外命中，0 stale。[JSON](evidence/architecture-check.json)、[终端输出](evidence/architecture-check.log)。 |
| 覆盖状态 | active 2、pending 21、partial 8；2 个已登记生成入口未解析、33 个准确登记动态位置继续显式报告。 |
| 工具源码检查 | 14 个检查器/测试文件 ESLint `no-undef`：0 错误。[结果](evidence/tooling-lint.json)。 |
| 差异与工作区保护 | `git diff --check` exit 0；原主工作区与非本轮内容无漂移，业务源码无修改。 |

本轮修改只影响检查器与治理配置，按 CODEX 风险验证运行完整架构专项和真实 CLI/Worker fixtures。**本轮没有重跑完整 release-check**；旧完整门禁记录不代表本次修改后的全量 PASS。正式集成或 PR-ready 前，需要在最终合并候选重新执行完整门禁。未运行 Electron GUI、Windows workflow/安装包、Excel/WPS；本次合成 VM/Worker 只证明检查器反例和路径行为。

剩余：等待独立复审；按新的固定 release 候选完成 G1–G7 实际路径、调用方、授权位置、例外清理和行为证据对齐，满足条件后逐项激活。本分支仍以 v3.2.9 为源码基线，29 个非 G8 子边界配置保持 pending，旧 release@9602a1fa 的预检只是历史记录。本轮未提交、推送、合并、开 PR、升版或发布。
