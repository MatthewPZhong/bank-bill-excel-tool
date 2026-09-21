# R3-01 配置工厂状态型回归

2026-09-21（Asia/Shanghai）。本文件仅记录专项回归，生产修复由主 Agent 负责；没有修改用户 R3 报告/脚本/日志或前轮证据。

唯一工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`。唯一产品测试改动是 `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`；原 61 条保留，新增 19 条。最终同一 fixture 修前 **67/80 PASS（exit 1）**、修后 **80/80 PASS（exit 0）**；测试文件已冻结。共享 runner 没有改动，临时 `electron-before.cjs` 只在修前回归时从本轮 before 读取 configuration.js，其他工厂及新增 fixture 使用本工作区内容。

## 状态型证据与范围

新增 helper 维护独立 `rules` / `meta` 存储。每条 save 成功独立提交；失败注入明确分为“未提交失败”和“数据库已提交但接口失败”，不由 reject 推断回滚。`getBillSplitConfig` 返回存储实际值。测试在真实 Electron DOM 中装配正式配置工厂、modalHost 和 modalBridge，不使用产品 Main、真实数据库或业务文件。

19 条用例：

- 两写链 × 首步 failed/reject：4 条，元信息零调用、存储仍为原配置，错误后可重试成功。
- 两写链 × 第二步 failed/reject/cancelled：6 条，规则已清、旧规则不再进入编辑器、错误保留、规则按钮/正负号/目标选择/行 Credit-Debit 资格匹配实际状态，重试成功。signed 的三条重试从 signed 目标 `[2]` / byField 目标 `[1]` 出发，要求最终旧 byField 目标为 `[]`，第 1 行金额控件可用、第 2 行禁用。
- 两写链 × 在规则或元信息阶段 force dispose：4 条，已发送链仍一次完成两次独立提交，旧 DOM 与新栈不续接，不发销毁后的新重读。
- 元信息已落地但 failed / reject：2 条；首步规则已落地但 reject：1 条。重读采用实际存储，同时保留原错误，首步非 success 不续发第二步。
- 部分成功且重读失败：1 条，保留已确认的规则清空与原错误/重读提示，Currency 未提交草稿不丢失；全部配置写控件禁用、X/完成仍可用，重复程序事件不发新写，完成回原父。
- 恢复读取在途：1 条，普通关闭及重复写仍拒绝，force dispose 后旧回包不恢复旧 UI。

相邻 signed 清规则分支通过程序化 change 覆盖；初始存在规则时该 select 在真实 UI 通常 disabled，本证据不声称用户可在该初始状态直接点击。

## 修前结果

最终同组 80 条修前结果 **67/80 PASS，exit 1**：原 61 条全通过，新增 19 条中 6 通过、13 失败。[日志](before.log) / [执行命令、源码覆盖及 SHA](before.json)。修前 configuration.js 使用主 Agent 备份 SHA `4c34f8367ef140661ed0301c08ec5edcf4df222eb9185cdb8d844f4170a3933b`。

中间阶段 [before-initial.log](before-initial.log) 为 63/75，其中 4 条 force 用例的最后表达式误返回 modal handle 导致 Electron 不可序列化，已用 `void 0` 修正；这 4 条不计产品缺陷。后续 [before-79.log](before-79.log) 为 67/79，增加恢复读取待决用例后形成 67/80。

第一版产品修复的 [77/80 记录](after-retry-contract.log) 暴露三条有效的 signed 重试目标残留反例，不归为测试误报：byField 旧目标会参与真实行资格并集。曾短暂按“非活动目标可保留”放宽预期的 [中间 80/80](after-inactive-target-assumption.log) 也完整保留，但该假设已被独立行资格分析推翻，**不作为闭合证据**。最终恢复严格 `[]` 断言并补上第 1/2 行实际控件资格验证，使用同一最终 fixture 重新执行 before/after。所有中间日志保留，不改写为最终结果。

修前命令：`node tmp/g3-review-r3-fixes/tests/run.cjs before`。每条 shell 命令显式使用上述 worktree cwd。Electron 使用新建临时目录隔离 userData/Documents，结束仅删除自己的隔离目录；执行已获工具批准，无权限拒绝。

## 修后与边界

最终命令：`node tmp/g3-review-r3-fixes/tests/run.cjs before` 与 `node tmp/g3-review-r3-fixes/tests/run.cjs after`，分别 exit 1 / 0。after 包装器执行原共享入口 `node scripts/test-renderer-lifecycle.js configuration-dialogs`。[最终修后日志](after.log) / [命令、退出码及源码 SHA](after.json)。前后记录使用同一最终 fixture，未把中间放宽的预期用作最终结果。

聚焦命令 `node ../../../node_modules/eslint/bin/eslint.js src/renderer/dialogs/configuration.js scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`、`node --check scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`、`git diff --check` 均 exit 0。[验证身份与命令](verification.json) 确认 `sameFixtureBeforeAndAfter: true`、`afterMatchesFinal: true`。

冻结 SHA256：

- fixture：`3e23890185f0be8d382474532717f9203724fc89680c68b6cf2a3cfeba1c505f`。
- 本次实际执行的 production：`4f14103f3062c6405ff5e18a7b286d06d075aeb87d56f20907c34b370deb1ec9`（生产由主 Agent 修改）。

最终 fixture 差异见 [fixture.patch](fixture.patch)；[fixture-baseline.json](fixture-baseline.json) 验证原 fixture 对应本轮 before manifest。局部测试实现与验证已完成；总体组合验证由主 Agent 汇总，独立审查有自己的报告及探针，不与本组数量重复相加。

未运行全仓 unit、完整 integration 或 release-check，历史资源阻塞未解除。本专项不等同实际 Main 保存/模板库同步集成、完整产品 GUI 或 Windows/Excel/WPS 验收。本 Agent 未改生产源码、README、TechDoc、notes，没有提交、推送、合并或发布。
