# PR #172 Windows CI Baseline Refresh Preflight

## Task Brief

- Goal: 修复 PR #172 的 Windows CI 失败，同时保持 VCC Parser Pipeline 的金额、币种、行序、错误与 all-or-nothing 合同不变。
- Context: run `32719414816` 的 3 个失败全部位于 C2 recovery directory-fsync 用例，发生在 PR #170 修复进入 `v3.2.0` 之前；日志未出现 VCC parser/pipeline 新失败。
- Constraints: 不复制或放宽 durability fallback；不修改 VCC 金额整数分、方向、币种、source evidence、ordered reducer、错误上限或 snapshot adoption；不启用 production；不运行 `check-vars`/`scan:vars`。
- Done when: PR #172 分支包含最新 `v3.2.0` 及已验证的 #170 Windows 修复；recovery、VCC parser/legacy parity、完整 release-check 通过；新 Windows CI 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 失败与 #170 修复前的 3 个 Windows failure 完全相同 | run `32719414816`：#1185/#1194/#1200；两项 `DURABILITY_DIRECTORY_FSYNC_FAILED`，一项 `committed`/`closed` 差异 | 不改 VCC parser 资金路径，只同步已审查的 C2 修复 |
| 失败 run 早于 #170 修复和 #171 合并 | run 于 `2026-08-24T10:57Z` 启动；当前 `v3.2.0` 为 `dffb2ab0`，ancestry 包含 `e986132c` | 旧 check 不是当前 merge candidate 的结论 |
| #170 与 #171 的新 Windows smoke-test/build 均已通过 | runs `32752212434`、`32758007539` | directory-fsync 修复已有真实 Windows 证据，不另造平台兼容实现 |
| E03-A 与最新基线无文本冲突 | `git merge --no-edit origin/v3.2.0` 由 `ort` 完成 | 重点验证组合行为，不改 frozen parser contract |
| E03-A 生产入口仍关闭 | implementation notes 与 parser pipeline 定向测试 | 基线刷新不得切换默认 IPC 或 production mode |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C2/D mature adapter 基线与 VCC parser pipeline 是否存在组合回归 | 跨模块组合 | 高 | 容易 | merge 无冲突，但同属 main-process/background execution 发布候选 | PROBE | recovery + VCC parser/session 定向测试，再跑 release-check | 不通过则回滚本次基线 merge，不在 VCC 层复制 recovery 修复 |
| 金额、币种、行序、错误与 source evidence 是否保持 legacy parity | 资金/审计边界 | 高 | 容易 | 本次 merge 未触及 VCC 文件，但需端到端断言 | PROBE | 真实 XLSX Worker pipeline 与 legacy parity tests、全量 integration | 必须全通过；人工资金红线继续阻塞 production enable |
| 新 head 是否生成当前 base 的 Windows check | CI 触发 | 中 | 容易 | base edit 未产生新 check，push 新 head 会触发 synchronize | PROBE | 推送后观察新 run | 未触发则不合并并报告 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 同步最新 `v3.2.0` 基线 | head 自身包含 Windows fsync 修复与已合并前序 PR | ancestry 包含 `dffb2ab0`/`e986132c`，无冲突 | 推翻旧快照判断 | 回滚 merge commit并重新定位 |
| 2 | 跑 recovery 与 VCC parser/session 定向测试 | durability 与资金 parser 合同不互相污染 | 两组定向测试全部通过 | 阻止推送 | 收缩到共享入口/生命周期 |
| 3 | 跑完整 release-check | 全仓兼容、真实 XLSX、顺序/行数/错误可解释 | lint/smoke/unit/integration PASS | 阻止推送 | 保留诊断证据，不改业务 fallback |
| 4 | 做通用与资金盲区复核 | production、幂等、金额/币种、source evidence 不漂移 | 无新高风险 finding；人工红线仍 pending | 阻止合并或要求人工复核 | 回滚基线刷新 |
| 5 | 推送新 head 并恢复顺序监控 | 仅新候选可被合并 | 新 CI 关联新 SHA；成功后才 merge | 保持 PR 未合并 | 继续修复或暂停报告 |
