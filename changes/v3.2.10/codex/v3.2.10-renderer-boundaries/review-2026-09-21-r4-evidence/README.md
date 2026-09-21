# 第四轮审查证据说明

本轮冻结源码为 `/private/tmp/renderer-boundaries-r4-2qr0rwdp`，源 worktree、分支、HEAD、SHA256见 `review-snapshot.json`。所有生产代码及既有测试保持不变。

- `focused-unit-command.json` 和 `focused-unit.log`：42个受影响文件，649/649通过；精确命令、cwd、退出码和耗时已记录。
- `electron-lifecycle-command.json` 和 `electron-lifecycle.log`：本轮206/206真实工厂通过。API由fixture控制，隔离临时userData/Documents；未加载产品Main。
- `checks-command.json`、`lint.log`、`smoke.log`：本轮实际执行。
- `review-modal-r4-probe.cjs`：独立有状态API矩阵，正确恢复行为断言，当前22/22通过。用同脚本对R3原序列验证，0/1通过且exit1，表明该正确行为断言确能识别原缺陷。
- `review-modal-r4-probe-output.log`、`review-modal-r4-before-output.log`：矩阵实际stdout。脚本可用REVIEW_SOURCE_ROOT改根，默认R4快照；REVIEW_MODE/REVIEW_CASE可定点选取原序列。
- `mapping/runner.cjs`、`mapping/mapping.cjs.js`、`mapping/output.log`：实际mapping父子组合2/2通过；源码root固定R4快照，真实DOM与合成API。
- `renderer-boundaries-r4-amount-drafts.cjs/.log`：额外三个草稿/重试探针执行不完整，executeJavaScript抛通用异常，未得到有效业务断言；不能计作通过，也没有据此登记产品缺陷。首次挂起进程已终止。此补充验证缺口与正式206项通过分开记录。
- `source-validation.json`：原文件保护、实施方96文件冻结清单核对及diff-check。
- `artifact-validation.json`、`artifact-sha256.json`：报告链接、探针语法、交付哈希及结束时保护检查。语法通过不等于业务探针通过。

从冻结快照工作目录运行，使用安装的Electron；移除ELECTRON_RUN_AS_NODE，每次提供新的临时RENDERER_LIFECYCLE_TEMP目录供userData/Documents使用。本环境Electron相关执行获准启动，没有访问真实用户目录。

```text
node_modules/.bin/electron <evidence>/review-modal-r4-probe.cjs
node_modules/.bin/electron <evidence>/mapping/runner.cjs mapping.cjs
```

原序列对照另设置：

```text
REVIEW_SOURCE_ROOT=/private/tmp/renderer-boundaries-r3-qu7nz33r
REVIEW_MODE=byField
REVIEW_CASE=original-second-failed
```

两个阶段都是独立保存。矩阵明确控制错误发生在提交前还是提交后，不能从真实failed/reject响应单独断言数据库回滚。signed禁用状态下的相邻分支用合成change覆盖，不声称自然鼠标路径。两层自动化不能替代真实Main全链路或平台/人工财务验收。

独立探针与日志按执行原文复制，未改写为更好的结果。冻结快照留在/private/tmp便于复跑，操作系统不保证长期保留该目录。
