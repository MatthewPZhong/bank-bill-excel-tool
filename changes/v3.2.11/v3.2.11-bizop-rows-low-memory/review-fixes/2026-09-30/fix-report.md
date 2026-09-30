# BizOP／按行拆分低内存：2026-09-30 审查修复

> 功能分支：`v3.2.11-bizop-rows-low-memory`。基线／HEAD：`18b82b4328cf5e00c1b2549d373a5b2f2677215c` 加 worktree 未提交实现。
> 四项审查发现及额外的载体别名遗漏已修复；最终完整本地门禁已通过。生产资格保持 `pending`。

原审查：[2026-09-30 分支审查报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.11/v3.2.11-bizop-rows-low-memory/reviews/2026-09-30/review.md)。原报告、复现脚本与日志保持原件。

> 后续说明：本报告保留第一轮验证范围。第二轮发现 R4 仍有并发排队依赖，补充修复和最终证据见 [第二轮修复报告](../2026-09-30-r2/fix-report.md)。

## 修复与防倒退

| 审查项 | 修复后行为 | 回归证据 |
| --- | --- | --- |
| R1 / P1：空发布恢复新增 1 GiB 门槛 | pending 下恢复共享 Publisher 原有的零内存记账；CPU／Worker／IO 租约和未知增长观察继续覆盖真实退出。获批档位仍使用阶段预算。 | 8 GiB 总内存，512／2560／3072 MiB 可用内存的原精确基线对照全部成功。新增集成验证 Bcompat=0／512、损坏索引、真实未提交且未知 owner 的记录。 |
| R2 / P2：加载中切模式卡住 | 新视图先订阅所需字段，旧视图只移除自己的订阅。同字段请求在交接中保持，状态变化到达当前视图。 | 真实 Electron 单列文件双向切模式；失败后重试；切换不重复扫描，最终可选值并提交。 |
| R3 / P2：删除发起组后剩余组卡住 | 共享缓存通知所有仍使用字段的视图；发起组存活及 generation 只约束其面板打开。 | 删除发起组和发起组改字段均有用例；剩余组接收原字段结果、独立选值并提交正确 payload。 |
| R4 / P2：legacy wrapper 内恢复等自身 | 外层 legacy 活动内的 BizOP 观察保留原 1 GiB 兼容请求；外层未知增长观察不被移除。独立恢复及借用能力仍使用原档位和 scope。 | normal-only／low-only 装配通过真实 IPC wrapper 与协调器、Worker；done／terminate Promise 后租约仍在，exit 后才释放；外层结束前其他获批阶段仍等待，额度不足仍拒绝。 |
| 额外观察：`forkChild` 别名漏检 | Position Node fallback 创建前检查、真实 exit 后注销。清点器识别 fork／spawn／Worker 解构别名。 | 载体清单 28 个点；别名未包裹负例及包裹正例通过，包含在 68 个定向单测内。 |

### 关键代码

[本次 4 个产品文件的修复差异](product-fixes.patch) 以审查时未提交实现为起点，便于单独复审本轮增量。

- [共享 Publisher 兼容额度](../../../../../src/main-process/execution-descriptors/publication-memory.js)
- [BizOP publication owner](../../../../../src/main-process/biz-op-v327/publication-owner.js)
- [Toolbox 会话及 picker 状态](../../../../../src/renderer/dialogs/toolbox.js)
- [Position fallback 载体](../../../../../src/main-process/position-reconciliation/import-dispatch.js)
- [发布恢复集成](../../../../../scripts/integration/publication-memory-compatibility.js)
- [真实 Renderer 竞态夹具](../../../../../scripts/renderer-lifecycle/fixtures/toolbox.js)
- [载体 AST 检查与别名负例](../../../../../tests/unit/architecture/memory-carriers.test.js)

共享 Publisher 的兼容记账为 0，表示恢复既有资源申请合同；真实内存占用仍按未知增长观察。没有跳过 discovery／execute，没有吞掉损坏记录错误。BizOP 已有兼容额度保持 1 GiB，未为 legacy IPC 冒用低档资格。

## 验证

| 层级 | 结果 | 日志 |
| --- | --- | --- |
| 定向单测 | 68/68 PASS | [unit](../../../../../logs/low-memory/20260930-review-fix-unit.log) |
| 真实 Electron Toolbox | 20/20 PASS，新增 6 个用例 | [Renderer](../../../../../logs/low-memory/20260930-review-fix-renderer.log) |
| 发布恢复集成 | 12/12 PASS | [publication](../../../../../logs/low-memory/20260930-review-fix-publication-2.log) |
| 原启动对照脚本 | 三个输入下基线／修复版均 PASS | [startup](../../../../../logs/low-memory/20260930-review-fix-startup-repro.log) |
| 原 legacy wrapper 脚本 | wrapper 内外成功，结束后 0 lease | [legacy](../../../../../logs/low-memory/20260930-review-fix-legacy-repro.log) |
| 完整 `release-check` | PASS，exit 0；unit 9496/9500（4 Windows SKIP）；72/72 集成脚本 | [full gate](../../../../../logs/low-memory/20260930-review-fix-release-check.log) |
| 2 万行 normal／low 完整链路 | 2/2 PASS，业务结果一致、源码身份一致 | [capacity log](../../../../../logs/low-memory/20260930-review-fix-capacity.log) |

新增集成首次因夹具把 source/target 放在同目录而被原有发布保护拒绝，已改成独立 generation/output 目录；未放宽生产限制。[首次日志](../../../../../logs/low-memory/20260930-review-fix-publication.log) 保留。

全量 Renderer 为 241/241；71 个有计数的集成脚本合计 2934/2934，另一个 nested Worker 脚本以 exit 0 单列。既有 30 万行、50 万／150 万行规模和判定阈值保持。

## 证据身份及剩余边界

最终源码摘要：`bdc38eed04e67a75c3c461e3555ccfd89df6b2b3b838665b93fcabaddbd7d33d`。本轮完整门禁日志 SHA-256：`e19704d5502dd7a13d0dc6ce5bf72d1e7571476df0c5f6ac2b9f4250831d78bd`。2 万行报告见 [capacity-probe.json](capacity-probe.json)，normal／low 各 21 个记录阶段、34 次 grant；`productionEvidence:false`。

修复前 123 个开发文件摘要均核对相同，历史证据保存在 [before/development-manifest.json](before/development-manifest.json) 及相邻三份 JSON。当前源码与验证身份以 [当前门禁摘要](../../local-gates-summary.json) 和 [当前文件 manifest](../../development-manifest.json) 为准。历史摘要不能代表修复后的源码。

本次只使用合成数据、本地 Node Worker 与真实 Electron Renderer 夹具。没有 Windows 512／768 MiB 物理压力环境，没有执行 Windows 完整 Main／安装包、Excel/WPS 或真实业务验收。用户此前已确认先完成本地实现并保留这些待办，详见 [Windows 操作说明](../../windows-acceptance.md)。`memory-qualification.json` 保持 pending，因此不据这轮修复宣称生产低档已经启用或 Windows 原始痛点已正式验收关闭。

未提交、推送、合并、发布或升版。应用版本仍为 3.2.10；目标版本为 v3.2.11。
