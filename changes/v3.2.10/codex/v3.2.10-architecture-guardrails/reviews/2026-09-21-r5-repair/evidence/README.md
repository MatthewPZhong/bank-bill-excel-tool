# R5-01 修复证据

结果摘要：[修复自检](../repair-review.md) / [verification.json](verification.json)。所有命令以 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails` 为明确工作目录。

- [原审查脚本原件](replay-review-original.cjs)：从主工作区复制，未修改。原断言将漏洞通过视为复现成功，不能用它的 exit 0 认定修复通过。
- [本轮重放脚本](replay-identity.cjs)：保留相同 9 个场景和 VM 事实，仅通过 `G8_EXPECT_FIXED=1` 将三个 gap 的期望切换为被拒绝；默认工具根为命令 cwd，支持 `G8_NEW_ROOT` 指定归档旧工具；自建临时 fixture 使用后清理。
- [旧工具结果](replay-before.json) / [当前工具结果](replay-after.json)：原本地函数、直接调用、包装、具名表达式和纯方法控制组保持结果；三个原 gap 全部从 0 变 1 条 ARCH-TASK-ADAPTER。旧工具取自 `/private/tmp/g8-r5-fixes-before/tooling.tar.gz`，解压位置只用于重放，不是业务工作区。
- [旧实现回归失败](regression-before.log)：加入原两种反例后、修改实现前运行，2/2 失败。最终 [architecture-tests.log](architecture-tests.log) 为 143/143；`initial-regressions*.log` 是中间专项记录。
- [架构 CLI](architecture-check.json) 与上轮固定基线报告内容完全一致，所有 114 条历史例外命中；配置没有改动。
- [测试源码清单](tested-code-manifest.json)、[最终清单](verified-manifest.json)、[增量 patch](repair-diff.patch)、[差异统计](diff-stat.json)、[保护检查](preservation.json)、[交付检查](delivery-check.json)分别固定本轮内容与保护事实。

使用工具 API 时，`exec_command.workdir` 必须显式设为上述 worktree。在终端重放时先进入该目录：

```sh
cd '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-architecture-guardrails'
G8_EXPECT_FIXED=1 node changes/v3.2.10/codex/v3.2.10-architecture-guardrails/reviews/2026-09-21-r5-repair/evidence/replay-identity.cjs
node --test tests/unit/architecture/review-round5.test.js
node --test tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /private/tmp/g8-r5-recheck.json
```

本轮不提供当前内容的完整 release-check PASS；未进行独立复审、release 集成激活、Electron/真实浏览器、Windows 或 Excel/WPS 验收。所有结果只涵盖文件中明确列出的自动化范围。
