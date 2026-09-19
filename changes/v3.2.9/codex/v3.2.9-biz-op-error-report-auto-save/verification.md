# v3.2.9 业务 OP 自动错误报告验证记录

## 本地 release 集成复验（2026-09-12）

本节记录首次 Biz OP 合并 `896fe12d` 的候选；后续与模块保留期限、定时深色模式的组合验证及当前门禁结果见 [release 记录](../../release.md)。首次候选摘要和日志继续保留为历史证据，不能代替后续候选的完整门禁结果。

- 源分支全部 20 个功能及验证文件已提交为 `3efe5c78e8cde10d89db90d4509d883b28d61f4f`，包含下文 review 的最终反馈修复；在独立 worktree 合入 `release/v3.2.9`，无冲突。
- `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-12 14:00:55 +08:00 完成，exit 0 / PASS：lint、smoke 通过；470 个单测文件，7,351 PASS / 0 FAIL / 3 SKIP；54 个集成脚本全部通过，汇总 2,500/2,500。本轮命令入口 Node 为 v24.13.0。
- 隔离 Electron 原生 DOM 10/10 PASS，按钮位置、空工具栏、长路径换行和文本选择检查通过。
- 当前候选与日志摘要见 [integration-candidate-20260912.json](integration-candidate-20260912.json)，集成范围见 [release 记录](../../release.md)。14 个代码、测试和脚本文件在门禁后再次核对，与源提交一致；之后仅更新验证元数据及自动集成清单。
- Windows Excel/WPS 打开真实报告和完整 Windows 应用人工验收仍未执行。本次为本地分支集成，未推送、升版、创建 PR、标签或正式发布。

以下章节保留 2026-09-11 实现和 review 的历史状态；其中“未提交”“未重跑完整门禁”及原 `candidate-sha256.json` 均对应当时快照。当前集成候选以本节及新摘要为准，原历史证据未覆盖。

## 本轮 review 修复（2026-09-11）

- 修复任务完成后模块状态读取异常被 `hasTaskFeedback` 吞掉的问题：原任务摘要、错误报告位置与临时状态错误独立保存，状态错误可见且显示为错误色；重复读取失败替换提示，状态恢复后去除过期提示并还原原反馈。
- 新增成功任务后状态异常、失败任务与已保存报告叠加状态异常两组回归，覆盖重复失败、读取恢复、控件恢复及新任务不残留旧故障；原导入连接异常用例同时断言两类错误可见。
- 同一组测试在修复前 renderer 上为 7 PASS / 3 FAIL，失败均为状态错误不可见；修复后 VM 10/10 PASS、隔离 Electron 原生 DOM 10/10 PASS，按钮位置、空工具栏、长路径换行与文本选择检查通过。改动 renderer 与测试的 ESLint、`git diff --check` 通过。
- 本轮仅改变页面反馈和回归测试，未改 Main、报告生成或业务数据契约。未重跑完整 `release-check`；下文完整门禁日志和 `candidate-sha256.json` 继续保留修复前候选证据，不代表当前修复后的最终候选已通过完整门禁。Windows Excel/WPS 人工验收仍未执行。

## 候选与环境

- 分支：`codex/v3.2.9-biz-op-error-report-auto-save`。
- 基线/当前 HEAD：`2ba9ef14fe972363b604955636cff0c9ac53700f`（`v3.2.8^{commit}`）。修改尚未提交；同目录 `candidate-sha256.json` 绑定下文修复前的完整门禁候选，不能把 HEAD 当成已含本轮改动的提交。
- 工作区：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool-v329-biz-op-auto-report`，macOS / Node v25.8.0 / Electron 36；复用原工作区已安装的依赖。
- 原工作区保持 main 及用户已有未提交修改。所有导入原件、DB、userData、Documents 输出与运行记录使用自建临时目录，未访问生产业务数据。

## 已执行验证

| 检查 | 结果与边界 |
| --- | --- |
| `node --test tests/unit/main-process/biz-op-v329-auto-report.test.js` | 46/46 PASS；包含任务身份、READY/owner/manifest、空诊断、零样本说明、目录/磁盘/权限失败、发布事实与最终目标完整性 |
| `node --test tests/unit/main-process/biz-op-v327-ipc.test.js tests/unit/main-process/biz-op-v329-ipc.test.js` | 13/13 PASS，无跳过；真实六类导出，自动报告不弹另存为；恢复中/已完成缓存重放、跨 sender/frame、过期/容量/新请求门禁、整请求登记与取消信号 |
| 既有 import-main / import-terminal-recovery / export-main / export-terminal-recovery 定向回归 | 39/39 PASS，无跳过；后续服务修改已由最终全仓门禁复核 |
| `node scripts/integration/biz-op-auto-error-report.js` | 12/12 PASS，真实 SQLite/TaskLifecycle/worker/ERRORS writer/validator/Publisher/recovery |
| `node --test tests/unit/main-process/biz-op-v329-renderer.test.js` | 8/8 PASS，VM 加 DOM 行为替身；默认单测不依赖 GUI |
| `node scripts/verify-biz-op-v329-renderer-dom.js /private/tmp/biz-op-v329-renderer-evidence` | 同组场景在隔离 Electron 原生 DOM 8/8 PASS；实际 CSS 下按钮位置、空工具栏、长路径换行与 Range 选择通过 |
| 改动源文件、测试与验证脚本的 ESLint / `git diff --check` | PASS |
| `npm run check:vars` | exit 2：7 个 src 文件命中局部 `dialog` / `state`，为关联审查提示；处置见下文 |
| `UNIT_TEST_CONCURRENCY=2 npm run release-check` | **exit 0 / PASS**；lint、smoke 通过；470 个单测文件：7,349 PASS / 0 FAIL / 3 SKIP；54 个集成脚本全部通过，汇总 2,500/2,500 |

前一次完整门禁在独立 review 修复期间主动停止；随后全量单测发现禁用 IPC 的旧断言仍使用无 sender 的调用并期待同步抛错。已改为合法身份校验新请求门禁、非法身份独立拒绝，定向用例 1/1 PASS。两次非最终运行都不作为最终通过证据。上述定向检查和 UI 检查均不能替代完整门禁或 Windows Excel/WPS 人工验收。

## 真实集成的关键证据

- OP 与 FLOW 的异常原件经同一诊断分别自动保存与原 `runExport(ERRORS)` 导出，逐工作表及单元格比较值、类型、格式、公式；不以压缩包二进制一致作为合同。
- 成功导入无空报告；合法 OP 的 worker 封存无错误诊断后，Main `afterWorker` 抛错，恢复 READY 空诊断仍不创建导出 Task、publication 或错误报告目录。
- 同一秒两次独立失败生成不同中文文件名，第一份内容保持不变；输出只在本地日期目录下，页面仅收到相对路径。
- 按现有合同收紧样本数量/字节预算，验证截断、零样本真实文件错误、坏 XML 扫描不完整与非精确计数说明；没有生成超过默认 8 MiB 预算的巨大样本。
- 发布提交后 Main 异常由原恢复机制核验为 saved，仅启动一次导出；Archive 未决保留 saved、pendingArchiveHandoff、cleanupPending 与 pin，解除故障后同一 Task 收尾、哈希不变。
- IPC 与 TaskLifecycle 共用真实 BusinessOperationRegistry：退出发生在两个 Task 之间时，waitForIdle 持续等待且新报告 Task 可被 transition 拒绝；退出发生在真实提交后时等待既有报告完成。最终登记、pin 与资源租约归零。

## 独立 review 与关联风险处置

- 已修复：仅凭失败状态导出内部空诊断；新增可信截断标志、空诊断判断及真实集成回归。
- 同步更新：禁用 IPC 回归使用真实新契约，验证合法调用仍返回 BIZOP_V327_NOT_ENABLED，非法 sender 返回 BIZOP_IPC_SENDER_INVALID，未创建业务 Task。
- 已修复：保存错误全部压成笼统提示；对白名单原因显示固定中文处置，保持原业务错误且不暴露绝对路径/堆栈。
- IPC / Main 审查核对 sender/frame、字段预算、摘要、缓存/门禁顺序、有效缓存快照、全请求登记和实际 quit 调用链，未发现待处理缺陷。
- `dialog`：Main 的现有原生文件选择/另存为取消仍有回归；局部页面 dialog 保留提交前取消和忙碌关闭保护。`state`：未改动共享 renderer 单例；本模块状态在局部 controller 或 publication 元数据中使用。
- 诊断血缘为本请求真实 taskRunId → import intent → 本 reportRef 的 READY/sealed manifest/producer → 原 ERRORS export Task → publication fact/hash。未更改金额符号、币种、匹配、schema、迁移或数据退役合同；本轮没有新增资金口径人工复核项。

## 页面与平台边界

- 实际截图位于 `logs/verification/biz-op-v329/renderer/`：initial、importing、report-saved、report-pending。已视觉核对，导入执行中仅禁用原按钮，失败与保存结果同时可见。复制至固定 worktree 后哈希一致。
- Electron 验证只加载本模块 controller、实际 CSS、内存 API；真实 Main/DB 链路由 IPC 和集成覆盖。原生文件/保存对话框取消在自动化中模拟返回结果，未宣称执行人工点击验收。
- 尚未执行 Windows Excel/WPS 打开真实报告及完整 Windows 应用人工验收；当前机器为 macOS，不能用 SheetJS readback 或 DOM 检查代替。正式交付前仍需该平台记录。
- 本轮未新增跨进程强杀测试；已启动发布的既有恢复与进程内故障已覆盖，不承诺跨启动补导尚未开始的报告。
- 未提交、推送、开 PR、合并、升版或发布；当前工作是功能分支实现与验证。

## 最终日志与手验产物

最终门禁完成于 2026-09-11 20:34:32 +08:00，shell 退出码为 0。代码、测试、脚本的 14 份内容摘要已复核一致，未提交的候选与该结果绑定。集成 runner 仅在通过后自动同步了 `rules/integration-test-policy.md` 的清单和实际计数，未修改规则正文。

- [完整 release-check 日志](../../../../logs/verification/biz-op-v329/release-check.log)
- [结果与日志/样例摘要](../../../../logs/verification/biz-op-v329/run-result.json)
- [单独 IPC 测试日志](../../../../logs/verification/biz-op-v329/ipc-tests.log)
- [关联检查原始输出](../../../../logs/verification/biz-op-v329/check-vars.log)
- [合成 OP/FLOW 原件与真实报告清单](../../../../logs/verification/biz-op-v329/manual-examples/manifest.json)
- [业务失败且报告保存的实际页面图](../../../../logs/verification/biz-op-v329/renderer/biz-op-v329-report-saved.png)

三项跳过为已有 Windows CI PowerShell snapshot/token cleanup、Windows packaged canary 已退出进程探针和 Setup 失败诊断探针；本次新增测试未跳过。两组样例各 2 条错误行，报告均为真实 `saved` / publication `COMMITTED`、归档完成，含“导入错误报告”“核对说明”两张 sheet；复制后哈希与发布记录一致。manifest 明确 `syntheticData=true`、`windowsExcelWpsValidated=false`。这些位于忽略日志目录的产物用于本机复核，后续提交时不自动纳入源码。
