# 按行拆分资源准入修复独立审查（2026-09-19）

结论：本轮按行拆分 admission 修复范围内，未发现可复现、可行动的剩余 P0/P1/P2。结论仅覆盖下列改动，不代表其他模块、整个 v3.2.9 或正式平台验收通过；此前 RSS 审查结论未被用于替代本次审查。

审查者只读检查实际代码、补丁、新测试、Spec/TechDoc 及既有测试证据，未修改生产代码或测试，未启动 CI、Electron 桌面、用户程序或读取真实业务数据；没有重复执行其他 Agent 已完成的测试。

## 范围与核对结果

| 核对项 | 结论与依据 |
| --- | --- |
| 永久不足与临时占用 | Supervisor 对静态和动态 simple 资源均先比较总预算；job 的 Base + Phase 超额时，在取得 Base 前拒绝。可满足但暂时被占用的资源仍经过原队列，保留既有优先级、5000 ms 超时、取消和租约释放规则，没有增加预算或延长等待 |
| 无 Worker 保证 | rows 当前是 job / thread-single、Base 为零、Phase 预约 1 GiB。总预算预检和资源申请都早于 adapter.start，因此本次 rows 生成准入失败不会创建生成 Worker 或调用 Publisher。该保证不延伸到全应用已存在的 Worker、之前的导入扫描、service 或 compound 路径 |
| 中文错误传播 | rows service 仅在生成 runtime 的直接拒绝与执行结果错误分支映射 `RESOURCE_BUDGET_UNAVAILABLE` / `ADMISSION_TIMEOUT`，保留代码与资源明细；未包装后续 Publisher。非准入错误保留原文，不添加“尚未开始生成”保证 |
| SafeErrorV1 | 继续严格使用 code/message/stage/detailLines 四字段；不新增协议字段。内部 admission 快照只包含原因/阶段枚举、五维资源数值及队列数量，没有租约 owner、operationKey、文件路径、业务行或队列 payload。分组整数及 MiB 文案可通过原 finance-safe 过滤，未放宽过滤规则 |
| 诊断时点与故障 | 快照在准入拒绝被捕获后、已取得 Base 的正常清理前采集；超时条目已从队列移除，所以“队列剩余”不包含自身。诊断输出失败不能覆盖原始错误或阻止资源清理 |
| Main 兼容性 | `toolboxFailureResult` 仅在错误有非空字符串 code 时新增可选 code；无 code 的旧错误返回形状不变，恢复路径仍去重保留。活动日志写入只针对 rows 准入错误，日志失败不替代原始失败 |
| 其他 simple 任务 | 新覆盖是原来只有动态资源估算器才执行的总预算检查；成功路径的 acquire/retain/release 次序未改。service 与 compound 的独立路径未重排，也未扩大零 Worker 的保证；已有相关 Supervisor/Governor/队列/错误协议回归通过，但没有穷举所有业务 action |
| 临时文件与旧目标 | 准入前会在本次随机私有目录写入 plan.json，因此“没有开始生成拆分文件”不等于“从未创建任何文件”。未启动 Worker 时没有 rows.sqlite、生成工作簿或输出清单；Main 原有 finally 清理本次私有目录。源件及已确认覆盖的旧目标保持不变；未改变发布 journal 或恢复协议 |

以上与 [Spec](spec.md)、[TechDoc](techdoc.md) 和[实施记录中的本轮补记](implementation-notes.md)一致。总配额仍在 Runtime 创建时冻结；释放其他程序内存不会动态重算既有配额，提示释放内存后重启与当前实现相符。

## 已核对的自动化证据

执行环境为 Node v24.13.0 / macOS；以下测试由实施 Agent/根 Agent 执行，审查者核对日志、测试实现及文件摘要，没有将受控 adapter 等同真实 Worker。

| 证据 | 实际结果与覆盖 |
| --- | --- |
| [Supervisor 前态](../../../../logs/verification/release-v3.2.9/rows-admission-fix/independent-review/supervisor-before.log) | 新 14 项在旧实现下 3 PASS / 11 FAIL，包含静态不可能申请进入等待及缺失诊断，前态失败被保留 |
| [Supervisor 修复后专项](../../../../logs/verification/release-v3.2.9/rows-admission-fix/independent-review/supervisor-targeted.log) | 133/133 PASS，0 FAIL/0 skip；包括新 14 项与既有 Supervisor、Governor、队列及 error-codec。真实 Supervisor/Governor，虚拟时钟和受控 adapter，不是原生 Worker 压测 |
| [release focused 测试](../../../../logs/verification/release-v3.2.9/rows-admission-fix/focused-tests.log) | 57/57 PASS，0 FAIL/0 skip；包含 14 项准入、6 项 service/Main 错误传播及既有 rows 回归。覆盖非准入错误、无 code 旧形状、恢复路径、真实 rows Worker/发布恢复相关用例 |
| [Main → Runtime → Governor 集成](../../../../logs/verification/release-v3.2.9/rows-admission-fix/integration-scope.log) | 2/2 PASS：768 MiB 总配额对 1 GiB rows 在 21.2 ms 拒绝，本次零 Worker/Publisher、源件和旧目标保留、plan.json 私有目录清理；2 GiB 配额时实际 rows Worker 生成三份、实际 Publisher Worker 发布，独立回读 2/2/1 数据行 |
| [集成身份记录](../../../../logs/verification/release-v3.2.9/rows-admission-fix/integration-scope.json) | 集成前后 4 个源文件 SHA 一致，退出码 0，日志 SHA 已记录；与本次审查文件匹配 |

集成读取 Main 的实际 prepare/execute 源码片段并执行真实 Runtime/Governor、rows Worker 和 Publisher Worker；原生目录/覆盖对话框、TaskLifecycle 批次身份及 settleArtifacts 耐久回执为夹具。它没有启动完整 Electron 桌面，也不证明 Archive 数据库持久化或实际系统对话框体验。

768 MiB 是隔离复现的总配额，不是用户历史 `Admission request timed out after 5000ms` 事件的已知实际快照。历史错误缺少当时 Governor 资源数据，不能将当前可用内存回填为唯一根因。

## 身份与未执行边界

[完整 6 文件清单](../../../../logs/verification/release-v3.2.9/rows-admission-fix/independent-review/manifest.json)记录本次复核的实际代码和测试 SHA。主要生产文件：

| 文件 | SHA256 |
| --- | --- |
| Supervisor | `a45002a39fc613327d8f46e1f25ac83f91238ef1ca7b96774d440ec975314835` |
| rows service | `3081148e138e7b2a880922b25a9b689a203e1ef2683e8343de4b46f6ab89e508` |
| Main（仅审查本轮两处逻辑差异） | `9599755bf4d548dea1ba5a676926af12ea153f19960e8406115aabd7e3011a3f` |

本次审查未执行完整 release-check、真实 Windows 准入复现、系统目录/覆盖对话框、Excel/WPS 或桌面错误弹窗验收；这些状态需各自实际证据。错误提示与日志的静态可读性已核对，但不以集成返回中文字符串代替真实桌面视觉验收。


## 根侧追加的 UI 验证

本轮实际隔离 Electron 36.9.5 / macOS / 真实 renderer-dialogs 与正式 index 样式完成 4 个场景：1080×800 和正式最小 1080×760 下，分别显示配额不足与等待超时。两类各 7 行诊断完整可见；确认按钮经原生坐标点击返回工具箱，忙态正确解除。输入响应来自当前 Supervisor/Governor 与 service 的受控资源错误，desktopApi 为夹具，不接触用户数据或真实业务 Main。根侧另实际查看了最小窗口配额不足截图。

初次完整探针在常规窗口 2 项 PASS 后，测试窗口关闭触发 Electron 默认退出，最小窗口 loadFile 失败，原始整体 FAIL 已保留。修复仅在 TMP 中的验证器，防止提前退出并要求完整场景/证据后才允许 exit 0；随后只补跑最小窗口 2 项。检查器确认前后生产文件 SHA、平台及 Electron 一致，合计 4/4 PASS，无生产 UI 修改。这不代替 Windows 或安装包人工验收。

证据：[正常窗口记录](../../../../logs/verification/release-v3.2.9/rows-admission-fix/ui/result.json)、[最小窗口记录](../../../../logs/verification/release-v3.2.9/rows-admission-fix/ui/minimum-window/result.json)、[最小窗口截图](../../../../logs/verification/release-v3.2.9/rows-admission-fix/ui/minimum-window/1080x760-RESOURCE_BUDGET_UNAVAILABLE.png)。


## 根侧追加的共享逻辑回归

首轮完整门禁发现 `new-account-save-as-e10-b.test.js` 的旧静态预算不足断言仍期望 `ADMISSION_TIMEOUT`，真实返回是本轮预期的 `RESOURCE_BUDGET_UNAVAILABLE`。已单独复现 1 FAIL，并只修订该测试，保留 `transport-lost`、暂存文件不存在，增加申请/总额、零租约授予、零排队、零占用断言和 finally shutdown；修订后同一真实 Runtime 单项 1/1 PASS，语法与 ESLint 通过。没有为该测试修改生产代码或提高预算。

首轮已知失败门禁按原输入保留后停止，未形成全量单测汇总，也未执行集成；不能记作 PASS。1542 份冻结输入核对未变后纳入此测试修订，从最终内容重跑完整 `release-check`。证据：[旧断言失败](../../../../logs/verification/release-v3.2.9/rows-admission-fix/new-account-regression/before.log)、[修订后](../../../../logs/verification/release-v3.2.9/rows-admission-fix/new-account-regression/after.log)、[首轮处置](../../../../logs/verification/release-v3.2.9/rows-admission-fix/initial-gate-disposition.json)。


## 最终本地门禁补记

Node 24.13.0 下 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 完整 PASS / exit 0：507 个单测文件、8104 项中 8100 PASS / 0 FAIL / 4 Windows 专用 SKIP；60 个集成脚本全部通过，59 个有计数脚本合计 2579/2579，另 1 个无计数。lint/smoke 通过，1542 份冻结的代码、依赖及验证输入核对未变。 [完整门禁摘要](../../../../logs/verification/release-v3.2.9/rows-admission-fix/verification-summary.json)保留输入及日志 SHA。新增脚本的独立 ESLint 通过。此结果覆盖本轮 RSS 和资源准入最终代码，不替代新候选的 Windows CI、正式 PF 或必要人工验收。
