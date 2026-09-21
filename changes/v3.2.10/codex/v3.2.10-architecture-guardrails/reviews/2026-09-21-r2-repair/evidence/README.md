# 第二轮修复证据

修复自检与范围见[报告](../repair-review.md)。所有相对仓库命令在 G8 worktree 根执行：

```sh
node --test tests/unit/architecture/review-round2.test.js
node --test tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /absolute/output/architecture-check.json
```

- `regressions-before.log`：9 个审查问题对应回归在修复前均失败。
- `architecture-tests.log`：最终 114/114 通过，含新增 14 组及既有历史恢复测试。
- `architecture-check.json/.log`：实际固定基线扫描与 CLI 结果，active/pending/partial 分开记录。
- `no-undef.json`：15 个工具/测试文件的 ESLint no-undef 输出。
- `verified-manifest.json`：当前验证内容 22 文件 SHA-256；`verification.json` 汇总本轮结果及未执行项。
- `repair-diff.patch` / `diff-stat.json`：相对接手时工具归档的 6 文件增量，包含新回归，未把未提交文件漏出差异。
- `preservation.json`：主工作区、既有未提交实现、配置与生产源码保护结果。
- 上层 `source-review.md`：用户第二轮报告的原样副本，其绝对证据链接仍指原审查材料；原件只读。

回归自动建立并清理临时 fixture；真实 Git 测试只提交临时仓库，VM/子进程只使用合成输入。没有产品 GUI/Windows/安装包/Excel/WPS 证据，本轮也没有完整 release-check 记录。
