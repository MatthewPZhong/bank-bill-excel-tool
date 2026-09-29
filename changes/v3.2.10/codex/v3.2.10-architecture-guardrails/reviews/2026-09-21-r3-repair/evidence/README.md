# 第三轮修复证据

范围与结论见[修复自检](../repair-review.md)。原第三轮审查保持只读，上层 source-review.md 保存其准确副本。

从 G8 worktree 根目录可重跑：

```sh
node --test tests/unit/architecture/review-round3.test.js
node --test tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /absolute/output/architecture-check.json
```

- `regressions-before.log`：两项原问题对应 3 个回归，修复前 0 pass / 3 fail。
- `overload-ambiguity-before.log`：相邻重载歧义在修复前失败的证据。
- `architecture-tests.log`：最终 124/124；新增测试中的 VM 和真实 fork 断言包含在此运行中。
- `architecture-check.json/.log`：最终固定基线 CLI 通过结果，状态/覆盖/例外单列。
- `initial-architecture-check.json/.log`、`intermediate-architecture-check.json`：中间过宽 coverage 误报与收窄后的 JSON 数据诊断，均非最终状态。`initial-architecture-tests.log`、`initial-tested-code-manifest.json` 保留对应较早运行，不能用于当前 PASS。
- `no-undef.json`、`tested-code-manifest.json`：测试时 16 个工具/测试文件 lint 与 SHA-256；`verified-manifest.json` 为最终 23 文件身份。
- `repair-diff.patch` / `diff-stat.json`：相对接手工具归档的六文件差异，包括未跟踪回归代码。
- `verification.json`、`preservation.json`、`delivery-check.json`：结果/未做项、工作区保护和最终一致性核对。

fixture 在临时目录创建并自动清理，真实 Git 测试只提交临时仓库。无生产代码执行、真实业务文件写入、产品 GUI 或完整 release-check 证据。
