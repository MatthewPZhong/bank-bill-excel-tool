# 第四轮修复证据

范围和结论见[修复自检](../repair-review.md)。原审查只读，上层 source-review.md 保留准确副本。

在 G8 worktree 根目录重放：

```sh
node --test tests/unit/architecture/review-round4.test.js
node --test tests/unit/architecture/*.test.js
node scripts/check-architecture.js --json /absolute/output/architecture-check.json
```

- `regression-before.log`：原最小反例在修复前失败；VM 在断言门禁前已验证受限操作实际执行。
- `architecture-tests.log`：最终 131/131，包含新增 7 组与原全部架构回归。
- `architecture-check.json/.log`：最终 0 违规、114 例外命中、0 stale，状态保持原口径。
- `initial-architecture-tests.log`、`initial-tested-code-manifest.json`：初版 130 项运行，不覆盖最终内容。
- `initial-architecture-check.json/.log`：初版排除导入来源导致一个历史例外失配的诊断；最终已恢复直接操作保护，不通过调整例外解决。
- `no-undef.json`、`tested-code-manifest.json`：测试时 17 个工具/测试文件的 lint 与哈希。
- `verified-manifest.json`：最终 24 个文件身份。
- `repair-diff.patch`、`diff-stat.json`：相对接手归档的四文件增量，包含未跟踪回归。
- `verification.json`、`preservation.json`、`delivery-check.json`：结果与未做项、工作区保护及最终一致性核对。

fixture 自动建立并清理临时目录；真实 Git 测试只提交临时仓库。未执行生产代码或修改真实业务数据；没有本轮完整 release-check 或平台/GUI 验收证据。
