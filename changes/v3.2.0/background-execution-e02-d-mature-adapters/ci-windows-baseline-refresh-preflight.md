# PR #171 Windows CI Baseline Refresh Preflight

## Task Brief

- Goal: 修复 PR #171 的 Windows CI 失败，并保持 E02-D mature adapter 与资金/发布门禁合同不变。
- Context: run `32715354244` 的 3 个失败均在 C2 recovery directory-fsync 用例；该 run 使用的 PR merge SHA `601d034c` 早于 PR #170 的修复 commit `e986132c` 及其进入 `v3.2.0` 的 merge commit `961349f7`。
- Constraints: 不修改 Pending/BizOP 金额、行序、事务或输出语义；不启用 4 个 production action；不放宽 durability fail-closed；不运行 `check-vars`/`scan:vars`。
- Done when: PR #171 分支包含已验证的 #170 Windows fsync 修复；recovery、mature adapter、Pending/BizOP 与全量 release-check 通过；新 Windows CI 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 3 个失败与 PR #170 修复前的 Windows 失败完全一致 | run `32715354244`：#1185/#1194/#1200，stack 均指向 `durable-file.js`；错误为 `DURABILITY_DIRECTORY_FSYNC_FAILED` 或由 Provider 未收口导致 `committed`/`closed` 差异 | 不修改 E02-D adapter 业务路径，复用已经审查和验证的 C2 修复 |
| 失败 run 的 merge SHA 早于 C2 修复 | CI checkout `601d034c`；`v3.2.0` 当前为 `961349f7`，包含 `e986132c` | 必须刷新 PR head/merge 候选后再看 CI，旧 check 不能作为当前候选结论 |
| PR #170 修复已通过 Windows smoke-test 与 build | run `32752212434` 两个 job 均 SUCCESS | 基线修复已有真实 Windows 证据，不另造第二套平台兼容逻辑 |
| E02-D 与当前 `v3.2.0` 合并无冲突 | `git merge --no-edit origin/v3.2.0` 使用 `ort` 完成 | 只需验证组合回归，不需要改适配器契约 |
| production 与人工红线仍由 E02-D 原合同控制 | `mature-action-adapters.test.js` 与 implementation notes | 基线刷新不得切换默认 IPC 或 production enablement |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C2 基线修复与 E02-D Supervisor/adapter 是否存在组合回归 | 跨模块组合 | 高 | 容易 | 合并无文本冲突，但共享 background-execution 模块 | PROBE | recovery + mature adapter 定向单测，再跑 release-check | 测试不通过则回滚本次基线 merge，不在 D 层补 durability fallback |
| Pending/BizOP 行序、事务和错误合同是否被基线刷新影响 | 资金/审计边界 | 高 | 容易 | 本次 merge 未触及 big-table 业务文件，但需组合验证 | PROBE | 两个既有 migration integration + adapter tests | 必须保持原断言全通过，人工资金红线继续阻塞 production enable |
| 新 head 是否会产生新的 Windows PR check | CI 触发 | 中 | 容易 | base edit 未生成新 check；push 新 head 会触发 `pull_request/synchronize` | PROBE | 推送后仅观察新 run | 若未触发，不伪造成功，保持监控暂停并报告 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 同步当前 `v3.2.0` 基线 | 确保 head 自身包含已验证 Windows fsync 修复 | branch ancestry 包含 `961349f7`/`e986132c`，无冲突 | 推翻“仅旧快照”判断 | 回滚 merge commit，重新定位独立 D 缺陷 |
| 2 | 跑 recovery 与 mature adapter 定向测试 | durability、lifecycle、cancel/failed 状态不串义 | 两组定向测试全通过 | 阻止推送 | 缩小到具体共享模块 |
| 3 | 跑 Pending/BizOP integration 与生产门禁断言 | 行数、行序、事务、错误输出与人工 gate 不漂移 | migration assertions 全通过，4 action 仍 disabled | 阻止推送并要求资金人工复核 | 回滚基线刷新 |
| 4 | 跑完整 release-check 与盲区扫描 | 全仓兼容性和可观测性 | lint/smoke/unit/integration PASS，无新增高风险发现 | 阻止推送 | 只保留可复现诊断证据 |
| 5 | 推送新 head 并恢复顺序监控 | 只让新候选接受 Windows CI | 新 run 关联新 SHA；通过后才允许 merge | 保持 PR 未合并 | 暂停监控并报告失败 |
