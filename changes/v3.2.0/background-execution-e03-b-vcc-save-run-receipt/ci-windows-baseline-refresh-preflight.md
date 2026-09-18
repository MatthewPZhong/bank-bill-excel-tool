# PR #173 Windows CI Baseline Refresh Preflight

## Task Brief

- Goal: 修复 PR #173 的 Windows CI 失败，同时保持 VCC SaveRun receipt、Inspector、幂等、金额与恢复合同不变。
- Context: run `32724397845` 的 4 个失败中，3 个是 PR #170 已修复的 C2 directory-fsync 旧基线失败；另 1 个是 migration 测试在 Windows 上删除临时目录时 SQLite 句柄仍打开而触发 `EBUSY`。
- Constraints: 不放宽 durability、receipt identity、事务原子性、金额/币种/月份/方向、replay 或 unknown/fail-closed 口径；不启用 production；不运行 `check-vars`/`scan:vars`。
- Done when: PR #173 包含最新 `v3.2.0` 与 #170 Windows 修复；测试在清理目录前确定关闭数据库；recovery、VCC SaveRun/Parser/Session 定向测试及完整 release-check 通过；新 Windows CI 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 3 个 C2 失败与 #170 修复前的 Windows failure 相同 | run `32724397845`：provider prepare 与 target post-image 抛 `DURABILITY_DIRECTORY_FSYNC_FAILED`，另一个状态停在 `committed` 而非 `closed` | 只同步已审查的 #170 修复，不在 E03-B 复制或放宽 durability fallback |
| migration 测试的唯一 E03-B 失败发生在测试清理阶段 | CI stack 为 `EBUSY ... unlink ...tool-data.sqlite`；业务断言未报告失败 | 修复测试资源生命周期，不改 migration/receipt 生产代码 |
| 临时目录清理 hook 早于 `restarted.close()` 注册 | `withTempDb()` 先注册 `rmSync`，测试后续才注册数据库 close | 用 `try/finally` 在测试体退出前关闭真实 SQLite 句柄 |
| base edit 未生成当前基线的新 check | PR 状态仍仅展示 2026-08-24 旧 run | 推送新 head 触发 synchronize 后，以新 SHA 的 Windows CI 为准 |
| production 仍为 legacy 且关闭 | E03-B implementation notes 与 task policy | 基线刷新不得注册 production Inspector、启用 recovery 或越过资金人工红线 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 最新 C2/E03-A 基线与 SaveRun receipt 是否存在组合回归 | 跨模块组合 | 高 | 容易 | merge 无冲突，但共享 database/session/Main 路径 | PROBE | recovery + SaveRun/Parser/Session 定向测试，再跑 release-check | 任一失败则不推送并收缩到共享入口 |
| Windows `EBUSY` 是否由数据库关闭顺序完全解释 | 平台资源生命周期 | 高 | 容易 | CI 明确在 unlink SQLite 时失败；测试把 close 延后到 after hook | PROBE | 改为同步 `try/finally` close，本地重复定向测试并等待 Windows CI | 不加重试或忽略清理错误，避免掩盖句柄泄漏 |
| 收据幂等、资金行与金额守恒是否保持 | 资金/审计边界 | 高 | 容易 | 生产实现未因本修复修改，仍需组合验证 | PROBE | receipt crash/replay/concurrency/金额负例与 integration | 必须全通过；人工资金红线继续阻塞 production enablement |
| 新 head 是否生成当前 base 的 Windows check | CI 触发 | 中 | 容易 | base edit 未产生新 run | PROBE | 推送后观察新 run | 未触发则不合并并报告 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 同步最新 `v3.2.0` | head 包含已合并前序 PR 与 Windows fsync 修复 | merge 无冲突，ancestry 包含当前 base | 推翻旧快照归因 | 回滚 merge commit并重新定位 |
| 2 | 在 migration 测试体内 `try/finally` 关闭数据库 | Windows 清理前无打开句柄，异常路径也关闭 | 定向测试可重复通过且无 cleanup failure | 阻止推送 | 进一步追踪具体 AppDatabase 连接所有权 |
| 3 | 运行 recovery 与 VCC SaveRun/Parser/Session 定向测试 | durability、receipt、幂等、金额合同组合不漂移 | 全部定向测试 PASS | 阻止推送 | 收缩到最小共享路径 |
| 4 | 运行完整 release-check | 全仓兼容、真实 SQLite/XLSX 与审计输出可解释 | lint/smoke/unit/integration PASS | 阻止推送 | 保留诊断证据，不改业务 fallback |
| 5 | 做通用与资金盲区复核后推送 | production、资金与恢复人工边界未越过 | 无新阻断 finding；新 CI 关联新 SHA | 保持 PR 未合并 | 继续修复或暂停报告 |
