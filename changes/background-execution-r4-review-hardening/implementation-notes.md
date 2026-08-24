# R4 Review Hardening — Implementation Notes

## Baseline

- Goal/spec: 修复 2026-08-24 v3.2.0 堆叠 review 的 P3-01～P3-05；详见同目录 `preflight.md`。
- Initial plan: 一个 top-of-stack hardening PR，按资源生命周期、取消、资金持久化索引、Windows 可观测性、文档证据链顺序收敛。
- Done when: 五项均有回归测试；合同包和 review ZIP 可重新验证；`release-check` PASS；production gates、public IPC 和资金口径不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| big-table 使用唯一 `terminationPromise`，`finish/close/terminate` 共用 | Supervisor 已把 `close()` 作为 existing-dispatch 正常终态 barrier | 修改 Supervisor 对所有 existing-dispatch 强制 terminate | 最小化行为面，真实 Worker 退出后才释放 lease |
| Session 拥有当前 Parser scan controller，并链接调用方 signal | Pipeline 已有完整 AbortSignal/Worker terminate 支持 | 在 Worker 协议增加 cancel message | production-disabled seam 内完成取消，不改默认 IPC |
| supersession abort 保留 `VCC_COMPUTE_SCAN_SUPERSEDED` | 现有内部 generation 合同和测试已冻结该语义 | 对所有 supersession 改报 generic cancelled | 不扩大错误合同漂移 |
| Receipt 仅增加普通 `run_id` 索引 | 一个 run 多 receipt 当前由 Inspector 检测，未授权唯一约束 | `UNIQUE(run_id)` | 只优化查询计划，不改变幂等/资金数据模型 |
| Canary 新增 safe code `CANARY_PROCESS_EXITED_BEFORE_REPORT` | 报告前进程退出是可观测失败，现有隐私边界禁止采集 stdout/stderr | 继续等待统一报 report timeout；采集完整进程输出 | 快速、稳定、无敏感输出 |
| 修正冻结 TechDoc 并重建 published report/checksum | 当前 runtime 的唯一物理表为 `vcc_op_calc_runs`，包完整性记录包含 TechDoc | 新建 `vcc_op_runs` 别名表；只改文档而留下失配 hash | 文档与实现恢复一致，历史 manifest 保持其显式 non-normative 含义 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| GitHub-hosted Windows 提供 `pwsh` | 现有 workflow 使用 `shell: pwsh` | Windows-only 动态单测无法启动 | CI 证据；必要时改用当前 PowerShell executable，不改产品脚本 |
| 一个顶层 PR 是当前最快且可审查的交付单元 | 用户此前接受该建议，且 5 项来自同一 review | 若要求逐 PR 归属，需要重排分支 | 可后续拆 commit/cherry-pick；不影响实现 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 在 #174 组合 HEAD 直接重生冻结包 published validator report | 先恢复历史 PASS report，再在其原始 provenance HEAD `f7c4d5aa` 上叠加单行 TechDoc 勘误重跑 | validator 将 #165 的 Main/TaskPolicy source hash 与 60 条 call-site 行号冻结；后续 PR 栈会按设计触发 provenance drift，和 TechDoc 内容无关 | 不更新 authority/action manifest，不把后续代码漂移冒充合同失败；修正文档仍须生成真实 29/29 report 与 checksum | 是 |
| PR #175 从旧堆叠基线直接等待 GitHub 合并 | PR base 改为 `v3.2.0` 后，将最新 `origin/v3.2.0`（`21181432`）合入 hardening head | #168～#174 已按序合并，旧堆叠拓扑在迁移测试处产生内容冲突 | 仅组合基线的显式关闭保护与本 PR 的 non-unique `run_id` 索引断言；相对新基线的净改动仍为原 13 个 hardening 文件，不改变产品合同 | 不适用；无行为偏差 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Baseline HEAD | `0ab11a2f0204718ffb75cf45423c1499103c4613` | 与同事 review 的组合快照一致 |
| `node --test` mature adapter + VCC Parser Pipeline | `32/32 PASS` | termination barrier、lease 释放顺序、单次 terminate、supersession/clear/caller abort 与 snapshot ownership |
| `node --test tests/unit/main-process/vcc-op-calc-save-run-receipt.test.js` | `34/34 PASS` | non-unique run_id index、旧库升级、run/files/receipt 原子性、并发 exactly-one、金额守恒与 TechDoc 表名 |
| `node --test tests/unit/windows-build-contract.test.js` | `4 PASS / 1 Windows-only SKIP` | 全平台源码顺序/专用 safe code；本机不伪造 Windows 动态结果 |
| 合同 validator（#174 组合 HEAD probe） | `28/29 PASS`；唯一失败为历史 Main/TaskPolicy hash/line provenance drift | 证明 TechDoc 未触发 Schema/跨文档/恢复合同失败；该次 FAIL report 已恢复，不作为发布证据 |
| 合同 validator（原报告 provenance `f7c4d5aa` + `ff091b47` exact authority inputs） | `29/29 PASS`，0 error；TechDoc input hash=`c3810217…f466b` | 修正后的物理表名通过 Schema、跨文档、恢复合同与完整 input-hash evidence gate |
| `shasum -a 256 -c PACKAGE-SHA256SUMS.txt` | `69/69 PASS` | 冻结包除 checksum 自身外全部文件与新 validation report 完整一致 |
| `npm run release-check` | PASS；lint/smoke PASS，unit `6017/6019`（0 fail、2 skip），integration `51/51` scripts、`2455/2455` assertions | 全仓回归；未调用 `check-vars`/`scan:vars` |
| 最终定向回归（4 个 hardening test files） | `70 PASS / 1 Windows-only SKIP`，0 fail | 五项修复的资源生命周期、取消、资金持久化、文档与 Windows canary 合同 |
| 合入最新 `v3.2.0` 后的冲突复核 | 唯一冲突为 `vcc-op-calc-save-run-receipt.test.js`；保留基线 `try/finally` 关闭数据库并保留本 PR non-unique index 断言；`git diff --cached --check` PASS | 证明冲突是测试清理与新增断言的机械组合，不改金额、方向、幂等、恢复或 production gate |
| 合入最新 `v3.2.0` 后的最终验证 | 定向 `70 PASS / 1 Windows-only SKIP`；`npm run release-check` PASS，unit `6017/6019`（0 fail、2 skip），integration `51/51` scripts、`2455/2455` assertions；合同包 checksum `69/69 PASS` | 验证顺序合并后的组合快照；仍未调用 `check-vars`/`scan:vars` |

## Final Blindspot Review

- 生命周期：正常、错误、取消和重复 `close/terminate` 均收敛到同一个 termination barrier；Supervisor 先等 transport cleanup，再释放 CompoundLease。
- 状态所有权：仅当前 Parser scan 可清理自己的 controller；新 scan、`clearCache` 与 save 后清理都会取消旧任务，generation CAS 继续阻止迟到 adoption。
- 兼容性：未改 Renderer/public IPC、production gate、错误 DTO、operation identity 或 Receipt 唯一性；数据库变更是幂等的 non-unique 加法索引。
- 资金红线：金额、方向、月份、币种、begin/end OP 与 run/files/receipt 原子性定向测试均通过；既有 exact Main owner 和人工签字 gate 仍为 `PENDING_HUMAN_REVIEW`，本 PR 不代替人工复核。
- 平台盲区：macOS 无法执行真实 Windows PowerShell 动态探针；静态合同已通过，动态证据留给 GitHub-hosted Windows CI。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows-only 提前退出动态探针 | PROBE | GitHub-hosted Windows CI | 本地静态/跨平台测试通过后可提 Draft；合并前需 CI PASS |
| 真实 Windows Setup/portable packaged canary 与资金红线签字 | BLOCK | 既有 R3 人工/Windows gate | 本 PR 不改变其 `PENDING_HUMAN_REVIEW` 状态，仍阻塞 production enablement |
