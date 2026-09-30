# BizOP／按行拆分低内存：第二轮 R4 修复

> 分支 `v3.2.11-bizop-rows-low-memory`；HEAD `18b82b4328cf5e00c1b2549d373a5b2f2677215c` 加未提交实现。
> R4 并发问题已修复，定向回归及最终完整本地门禁已通过。生产资格保持 `pending`。

原审查：[第二轮审查报告](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.11/v3.2.11-bizop-rows-low-memory/reviews/2026-09-30-r2/review.md)。原报告及证据保持原件。

## 修复结论与边界

受阻队首是已获批 phase，等待当前 legacy 活动结束；该活动的发布观察随后排队，构成相互等待。Main 现在为静态登记的内部后续请求捕获进程内 continuation 能力，将其绑定到当前仍存活的 legacy 活动。只有该活动确实出现在当前完整 inventory 中，且队首的全部执行候选均因此受阻，队列才先尝试 continuation。

队首与 continuation 之间的普通请求也在等待队首，不会再次阻止解除依赖。无关队首继续遵守优先级和 FIFO；普通请求、请求中自行添加的开关、错误的 owner/action/operation、复制的快照或已经结束的作用域均无法使用此能力。

顺序调整之后仍运行完整的资源准入：BizOP 原兼容 1 GiB、Bcompat、CPU／Worker／IO、normal/low 排他、超时、取消及关闭。父活动保持未知增长观察。恢复授权 scope、borrowed observation 和 Worker 真正 exit 后才释放的既有行为继续生效。身份检查通过 Main 静态 provider 装配到核心策略，核心层保持原有依赖边界。

本轮修复不改变业务输出、发布恢复合同或生产 qualification。上轮 R1／R2／R3 及 forkChild 修复保持，完整回归继续检查这些路径。

## 改动位置

[五个产品文件的本轮增量](product-fixes.patch) 相对于第二轮审查输入生成，不混入首批低内存实现或第一轮修复。

- [活动身份与快照来源](../../../../../src/main-process/background-execution/memory-activity.js)：WeakMap 绑定当前 Main 活动，作用域结束立即失效。
- [静态身份登记](../../../../../src/main-process/execution-descriptors/memory-profiles.js)：只有对应 phase／action／owner／operation 能捕获 continuation。
- [内存准入依赖证明](../../../../../src/main-process/background-execution/memory-admission.js)：区分内部兼容观察与被父活动阻挡的获批 phase。
- [Governor 接入](../../../../../src/main-process/background-execution/resource-governor.js)：排队携带 Main 准备的内部事实，正常 grant 校验保持。
- [队列选择](../../../../../src/main-process/background-execution/admission-queue.js)：仅选择能解除当前队首依赖的 continuation。

回归代码：[16 项 continuation 单测](../../../../../tests/unit/main-process/background-execution/memory-continuation.test.js)、[18 项发布恢复专项](../../../../../scripts/integration/publication-memory-compatibility.js)、[真实业务并发集成](../../../../../scripts/integration/publication-legacy-concurrency.js)。共享 BizOP 测试宿主增加可选的真实 Archive controller 入口，用于跨域归属检查。

## 前后对照

| 输入／场景 | 修复前 | 修复后 |
| --- | --- | --- |
| normal，仅内部观察 | 立即完成 | 既有专项保持成功 |
| normal，获批 phase 先排队 | 约 5003 ms，双方超时 | 30 ms，观察成功，父活动结束后 phase 成功 |
| low，获批 phase 先排队 | 约 5002 ms，双方超时 | 27 ms，观察成功，父活动结束后 phase 成功 |
| 25 ms 后取消队首 | legacy 约 27–29 ms 才能完成 | 取消正确结算；观察成功，结束无资源残留 |
| 队首截止时间晚于观察 | 仍可能互等 | normal/low 均成功，无须等待截止时间 |
| 中间夹普通请求 | 原队首始终阻止后继 | 内部观察先解依赖，随后正常队列顺序继续 |
| 真实自动报告＋合表 | 加载五个冻结旧文件：合表 RESOURCE 等待超时 | normal 721 ms、low 712 ms；两项均发布／归档／ACK |

毫秒数只记录本次合成时序，不是性能承诺。自动报告用真实异常导入诊断，先登记 NOT_STARTED publication 再申请执行。合表使用从当前 Main 源码提取的原 execute 与发布 helper、真实生成 Worker、TaskLifecycle、Publisher、恢复及 Archive controller。未预置孤儿 publication；文件选择和调度时序由隔离夹具提供，未启动完整 Electron 桌面。

- [原矩阵修复前日志](../../../../../logs/low-memory/20260930-r2-before-matrix.log)
- [相同业务回归加载旧文件的失败日志](../../../../../logs/low-memory/20260930-r2-business-before.log)；[受限加载脚本](load-before.cjs)
- [真实业务修复后日志](../../../../../logs/low-memory/20260930-r2-business-concurrency-2.log)

对照命令在本功能 worktree 执行；第一条预期非零退出，第二条预期成功：

```sh
node --require ./changes/v3.2.11/v3.2.11-bizop-rows-low-memory/review-fixes/2026-09-30-r2/load-before.cjs scripts/integration/publication-legacy-concurrency.js
node scripts/integration/publication-legacy-concurrency.js
```

## 验证

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| 定向单测 | 88/88 PASS，含新增 16 项 | [unit](../../../../../logs/low-memory/20260930-r2-targeted-unit-2.log) |
| 发布恢复专项 | 18/18 PASS，含新增 6 个并发场景 | [publication](../../../../../logs/low-memory/20260930-r2-publication-compatibility-2.log) |
| 真实自动报告与 Main 合表 | normal/low 2/2 PASS | [business](../../../../../logs/low-memory/20260930-r2-business-concurrency-2.log) |
| 完整 release-check | PASS，exit 0；unit 9512/9516（4 Windows SKIP），73/73 集成脚本 | [full gate](../../../../../logs/low-memory/20260930-r2-release-check-2.log) |
| 2 万行 normal/low 探针 | 2/2 PASS，结果与源码身份一致 | [capacity](../../../../../logs/low-memory/20260930-r2-capacity-2.log) |

首次业务集成到归档步骤时，原单领域宿主没有 Archive controller 的 getTaskBatchDetailForRecovery，触发 OWNER_CONFLICT。现已在测试宿主中装配真实 controller，生产归属校验保持。[失败诊断](../../../../../logs/low-memory/20260930-r2-business-concurrency-diagnostic.log) 保留。

首轮全量门禁发现 ARCH-PLATFORM-CORE 依赖方向问题，改为 Main 静态 provider 注入后重新完整执行。架构 allowlist 没有增加豁免。[失败日志](../../../../../logs/low-memory/20260930-r2-release-check.log) 和当时源码绑定的 [探针](capacity-probe.json) 保留为历史，不替代最终结果。

## 证据身份及待验收

修复前 132 个交付文件的大小／摘要全部匹配；原门禁摘要、容量报告、manifest 和五个被修改的产品文件保存在 [before](before/development-manifest.json) 及相邻文件。当前源码身份为 `bb537fa243d6f2c77f0e29a28829be1485d4bf53b4d79f3674165e874117b884`，详见 [source-identity.json](source-identity.json)。完整门禁日志 SHA-256：`0eb3d3ee1e2d0582cbe94059eeeb83d09d33621c9ccf48626386b3f82af7cec4`。容量报告见 [最终探针](capacity-probe-after-boundary-fix.json)，normal/low 各 20,000 行、21 个阶段、34 次 grant，productionEvidence:false。全量 unit 9512 PASS／0 FAIL／4 Windows SKIP；73 个集成脚本通过，其中 72 个报告合计 2942/2942，另一个 nested Worker 脚本无计数、exit 0。机器摘要见 [当前门禁](../../local-gates-summary.json) 和 [文件清单](../../development-manifest.json)。

仍缺 Windows 512／768 MiB 真实内存压力、最终 Windows 安装包、完整 GUI、Excel/WPS 和代表业务样本验收。用户已确认先完成本地实现并保留待办，详见 [Windows 验收](../../windows-acceptance.md)。本轮合成可用内存输入不授予生产资格，不能据此声称原 Windows 痛点已正式验收关闭。

未提交、推送、合并、发布或升版。应用版本仍为 3.2.10，目标版本为 v3.2.11。
