# release/v3.2.10 第八轮审查修复

**RR8-01、RR8-02 已修复，完整 release-check 已重新执行并通过。** IPC 缺字段与固定数组槽位替换的原始越权例均被拒绝，旧别名安全例继续通过。关闭范围为列明原始反例、静态组合和自动验证，不作全部 G8 合同或正式可发布结论。

## 固定对象与变更

- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加全部既有未提交修复。
- 依据：[第八轮审查](../2026-09-22-release-rereview-r8/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) G8-AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。
- 冻结 4518 个既有文件，见 [SHA-256 清单](input-manifest.json)、[原 tracked 差异](input-diff.patch)。修改 1 个 Renderer 检查器，新增 1 个回归文件，更新配套说明；集成策略清单由完整门禁刷新。
- 生产业务、共享 scanner、G1/G5、机器边界和授权例外未改；前七轮修复和历史审查材料保留，没有提交、推送、PR、升版、标签或发布。

## RR8-01：IPC 默认来源

[renderer-contracts.js](../../../../scripts/architecture/renderer-contracts.js) 不再把 ipc-data 当作必然非 undefined。来源标签只保存 channel/fields；默认参数同时保留 IPC 值和默认表达式候选，别名写入能够命中实际可能使用的 shared。所有候选都满足同一数据合同才允许纯数据注入；显式构造对象仍可证明已提供。

保留真实 Renderer AST 和全部 **20 个 active Renderer boundary** 的原始探针，基线 **0 诊断**，IPC 缺字段越权例现 **1 条诊断**，异步 VM 确认 shared 收到 outsideScope。[结果](renderer-ipc-realconfig.json)、[日志](renderer-ipc-realconfig.log)、[原脚本](../2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.cjs)。

**保守范围说明：** 原 `info.backgroundConfig` stub 安全例当前也产生 1 条诊断，VM 中实际 shared 仍安全。原因是现有来源合同没有字段存在性/非 undefined 证明，不能用 stub 恰好提供值代替合同。这里选择报告建议的保守拒绝，不增加字段白名单。显式构造的对象、显式标量，以及纯数据默认候选均有允许回归；普通无默认值的已授权 IPC 数据路径保持。

## RR8-02：固定数组槽位与实例身份

数组以字面量分配位置和可解释调用帧区分实例。身份映射仅在 Renderer 内建立，不修改共享 scanner 描述符或 evidenceId。固定数字/字符串索引、参数/局部解构、bound 参数、嵌套数组/对象和静态 spread 复制复用成员快照。`list[0] = current` 后读取获得 current；替换前捕获的旧别名、复制后源数组改写和不同工厂实例保持分离。

整体数组数据注入检查初始及可见写入候选，不能让后列未执行的安全分支遮盖能力。对已识别的 mutator、length、delete/update 和动态键，保留不确定性及已知元素/插入来源，不把未知退化为安全初始元素；不声称精确执行这些操作。真实装配中的递归身份核对使用在途标记，避免从深度零反复展开。

实际全部 **20 个 active Renderer boundary** 的 5 个场景：参数解构和直接索引两个原漏报均从 **0 变为 1 条诊断**；替换前旧别名 **0 诊断**；对象固定键、无替换数组两个违规对照各 **1 条诊断**。VM 与扫描一致，765/765 文件解析。具体追加 BankStatement 装配，不表示逐个测试全部 20 个工厂。[结果](renderer-array-realconfig.json)、[日志](renderer-array-realconfig.log)、[原脚本](../2026-09-22-release-rereview-r8/evidence/r8-array-probe.cjs)。R7 留存的固定槽位观察已纳入本项关闭范围。

## 验证与共享探针判定修正

| 验证 | 本轮结果 |
| --- | --- |
| 新增回归 | **46 项**；字节匹配起点 **34 FAIL / 12 PASS**，修复后 **46/46 PASS**。[起点哈希](regressions-before-inputs.json)、[before 日志](regressions-before-final.log)、[当前日志](regressions-r8.log)、[测试代码](../../../../tests/unit/architecture/release-rereview-r8.test.js) |
| RR2–RR8 | **262/262 PASS**，包含新增 46 项，非额外累加。[日志](regressions-after.log) |
| 全部架构 | **432/432 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，765/765 parsed。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 实际配置 / VM | IPC 原反例及 5 个数组对照符合上述预期。[显式断言](verify-probes.py)、[汇总](probe-verification.json) |
| 共享解析 | **44 项**：26 Renderer、18 查询；10 次内存 SQLite 查询；scanner 序列化、重复扫描和 evidenceId 保持。1 项旧合法预期按异步 IPC 合同修正为拒绝，其余通过/拒绝预期保持。[汇总](shared-archive-verification.json)、[断言](verify-shared.py) |
| 检查器及新测试 lint | 2 个文件 0 错误/告警。[结果](tool-lint.json) |
| 完整门禁 | **PASS**，`UNIT_TEST_CONCURRENCY=2 npm run release-check`，2026-09-22 18:06:12–18:27:32（Asia/Shanghai），沙箱外隔离测试环境。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9206 PASS、0 FAIL、4 项 Windows 条件跳过**；9210 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数项 2901/2901，另 1 个脚本无计数；Renderer lifecycle **233/233**。 |
| 输入 | **1705 个门禁输入及 HEAD 未漂移**。[门禁清单](gate-input-manifest.json)、[验证汇总](verification.json) |

共享例 `single-mount-category-explicit-ipc` 的源码未 await，就读取 `ipcRenderer.invoke('app:get-info').reconIdFixBillCategory`；旧 VM 的 invoke 同步返回对象。本地 [Electron 类型定义](../../../../node_modules/electron/electron.d.ts:8847) 为 Promise。替换成异步 VM 后，调用序列为 **app:get-info → other**，实际触发被禁止的默认频道，当前拒绝有运行时反证。修正的是探针的合法性假设，没有改写旧审查材料。[异步对照](shared-ipc-async-verification.json)。共享脚本 beforeR7 指历史 R7 修复起点；本轮起点单独由 [run-baseline.py](run-baseline.py) 与冻结哈希固定，不混用。

首次全量 Renderer 验证发现递归栈溢出，已修复并重跑；中间失败日志保留，不计入最终 PASS。[原架构失败](architecture-tests-initial-failure.log)、[修复后真实装配专项](renderer-policy-after-cycle-fix.log)、[实施记录](implementation-notes.md)。G1/G5 的工具和机器配置逐字节保持，本轮通过全部架构及共享夹具核验，不新增真实用户恢复 IO 结论。

## 保护、增量与边界

- 起点 4518 个既有文件仅 7 个计划内文件变化；792 个生产 src、542 个历史审查/修复证据、2 份机器 JSON 和主工作区 865 个 dirty 文件保持。[保护核对](preservation-final.json)。
- [本轮增量补丁](incremental.patch)相对于起始 dirty 状态生成，反向应用只读预检、git diff --check 和文档链接检查通过。[交付核对](delivery-check.json)。
- 原两项 P2 和列明邻域已覆盖；不承诺任意动态循环、未知 helper、变长 spread、跨文件对象时序、反射或所有数组操作的完整静态语义。IPC 返回字段的存在性仍未引入形状合同，可能保守拒绝未经证明的合法运行样本。
- 本轮为修复自检。修复后独立复审、真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收未执行。自动门禁 PASS 不等于正式可发布。
