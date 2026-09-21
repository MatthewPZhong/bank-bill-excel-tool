# 第三轮复审证据说明

全部产品验证针对 `/private/tmp/renderer-boundaries-r3-qu7nz33r`；源 worktree 与 HEAD 见 `review-snapshot.json`，全量文件 SHA256 和上轮差异也在该清单。产品与已有测试文件未改。

- `focused-unit-command.json`：本轮 42 个文件的精确 Node 参数、cwd、退出码和耗时；`focused-unit.log` 为原始输出。
- `electron-lifecycle-command.json`：本轮全部 187 项真实工厂执行信息；使用测试入口创建的临时 userData/Documents，受控 API，不加载产品 Main。
- `checks-command.json`：本轮 lint / smoke 参数和结果；日志原样保存。
- `review-modal-r3-probe.cjs`：原删行双击、预检迟到，以及存活窗口配套写部分失败的真实工厂探针。退出 0 表示这些结果按脚本断言复现，包括新缺陷存在。`ROW_DELETE_BUSY` 输出中的顶层 count 是结算后仍有两行，不是提交次数；真正提交数在 inflight.calls，恰好 1。
- `review-modal-r3-partial-compare.cjs`：同一部分成功顺序在 R2 快照的对照；需要 `REVIEW_SOURCE_ROOT=/private/tmp/renderer-boundaries-r2-oqb9yggb`。两个 Electron 脚本均支持 `REVIEW_SOURCE_ROOT` 和 `REVIEW_OUTPUT_LOG`。
- `repository-partial-write.cjs`：实际模板仓储、最小内存表和第二步写入触发器拒绝，确认第一步 COMMIT 不回滚。命令 `node repository-partial-write.cjs`；支持 `REVIEW_SOURCE_ROOT`，默认 R3 快照。
- `renderer-boundaries-r3-scenario-review.test.js`：9 个独立控制器/Main harness 顺序检查，源码 root 固定为本轮 R3 快照。命令 `node --test renderer-boundaries-r3-scenario-review.test.js`。
- `mapping/runner.cjs` 与 `mapping/mapping.cjs.js`：3 个父调用方组合探针，源码 root 固定为本轮 R3 快照。API stub 不读写真实配置；结果见 `mapping/output.log`。

Electron 独立探针需提供一个新的临时目录，例如通过 Python `tempfile.mkdtemp` 创建，设置 `RENDERER_LIFECYCLE_TEMP`；该目录专用于 userData/Documents。使用项目安装的 Electron 运行：

```text
<source>/node_modules/.bin/electron review-modal-r3-probe.cjs
<source>/node_modules/.bin/electron mapping/runner.cjs mapping.cjs
```

运行时移除 `ELECTRON_RUN_AS_NODE`，并按上文指定环境变量。在本受限环境中 Electron 运行需要允许进程启动；本轮相关调用获准执行。不要将这些探针指向真实用户数据目录。原始 `/private/tmp` 脚本与本证据目录副本字节相同；没有为了交付改写既有执行输出。

R2 对照仅确认状态回归，不将 R2 忽略第二步错误的行为作为正确错误处理。R3-01 应同时保留失败提示并同步已落地事实。

`artifact-validation.json` 记录报告本地链接、探针语法和原文件保护检查；`artifact-sha256.json` 对本次交付文件保存哈希。临时冻结快照保留以便按同一内容复现，不保证操作系统长期保留 `/private/tmp`。
