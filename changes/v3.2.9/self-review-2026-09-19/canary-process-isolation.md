# Windows canary 真实计时用例隔离

基线 `834b504e02daffa486416f7bfa8286c107dee3e0`；失败运行 [35436475279](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35436475279)。本次只改 CI 执行安排和测试覆盖约束，生产脚本不变。

## 失败证据

Windows 完整单测共 507 文件、8,104 tests：8,100 PASS / 1 FAIL / 3 SKIP / 0 cancelled。唯一失败位于 `tests/unit/windows-build-contract.test.js`：真实已退出进程获得 `CANARY_PROCESS_EXITED_BEFORE_REPORT`，但 3.0508927 秒超过 2 秒上限。计时在 `WaitForExit()` 后开始，不能把失败直接归为被测进程启动耗时；日志也不能唯一定位 OS 调度、JIT 或文件查询开销。完整日志、原始 annotation 和 SHA 保存在 `logs/verification/release-v3.2.9/acceptance-834b504e/windows-required/`。此运行的集成阶段和 build 未执行。

## 修复与覆盖

- 延续既有真实 Windows startup process adapter 的执行安排：全量并发单测默认不运行该真实计时探针。
- `build-windows.yml` 和 `release-windows.yml` 均在 `release-check` 后通过 `WINDOWS_PACKAGED_CANARY_PROCESS_REAL_TEST=1` 独立运行整个 `windows-build-contract.test.js`，显式文件并发为 1。步骤失败仍阻止后续构建和发布。
- 保留原 PowerShell 探针正文、真实进程、500 ms grace、至少 300 ms 宽限观察、2 秒上限、5 秒报告期限和 15 秒外层 timeout；没有降低产品验证门槛。
- 静态回归约束两个 workflow 的步骤、局部 env、完整测试文件命令与执行顺序，防止新增 guard 后遗漏 Windows 执行入口。

## 验证状态

本地 Node24 专项 7 个用例：5 PASS、2 Windows 专用 SKIP、0 FAIL。受控测试注册/工作流缺步骤、顺序、开关及原探针字节一致性检查 10/10 PASS；这些检查不模拟真实 Windows 计时。独立静态复审通过，无新增 P2。最终本地 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-19T11:39:17Z 完成，exit 0：507 个单测文件、8,104 tests 中 8,100 PASS / 0 FAIL / 4 Windows SKIP / 0 cancelled；60 个集成脚本全 PASS，59 个有计数脚本合计 2,579/2,579，另 1 个不输出计数；lint/smoke PASS。1,592 份冻结源码、依赖及资源输入未变化。原始日志、输入摘要、受控检查与独立复审保存在 `logs/verification/release-v3.2.9/canary-process-isolation/`。原生 Windows 的独立计时和完整门禁尚待新候选 CI，当前没有声称该平台已通过。

PR #239 的远端 main 合并仍须 GitHub 必需 `smoke-test` 和 `build` 实际通过，并匹配经审查的最终候选。正式 PF、安装/升级、原生文件对话框及 Excel/WPS 人工验收保留真实 NOT_RUN 状态；本次合并授权不使这些项目变成 PASS。
