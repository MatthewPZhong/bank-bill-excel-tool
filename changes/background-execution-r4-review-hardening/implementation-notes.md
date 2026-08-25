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
| launcher 退出后给 report 固定 2 秒宽限，并保留首个 canary safe code | 代码审查确认 Electron launcher 可先退出；#175 首次 Windows CI 另行证明二次卸载错误会把首错覆盖成 `UNINSTALL_CLEANUP_FAILED` | 继续立即判失败；恢复完整 180 秒等待；让 cleanup 覆盖首错 | 兼容 launcher hand-off，同时保持有界等待和无敏感输出；cleanup 仅追加固定 safe diagnostic |
| NSIS `/D=` 只传 owned install container，实际安装根固定推导为 `container/productName` | assisted installer 模板在目标中缺少 `${APP_FILENAME}` 时负责追加产品目录；最新 CI 已证明该选择不是 `SETUP_NONZERO_EXIT` 的充分根因 | 继续把最终 Unicode 产品目录直接作为 `/D=`；忽略 Setup 非零退出 | 保持实际安装、选择、卸载和身份审计根不变；该布局选择继续保留，但不再作为 CI 根因结论 |
| Setup 非零仍 fail closed，并额外输出有界诊断 | #175 第三次真实 Windows 仍只有聚合码 `SETUP_NONZERO_EXIT`；完整 stdout/stderr 或路径违反隐私边界，继续猜参数缺少证据 | 忽略非零退出；打印任意异常、路径或 installer 输出；继续无证据改安装参数 | 主 safe code 不变；标准 1/2 保留固定枚举，非标准退出仅输出 8 位 32-bit hex，另带安装根状态与精确 Registry 身份固定枚举 |
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
| R3 repair 将最终产品目录直接作为 NSIS `/D=` | R4 CI repair 改为把 owned ASCII container 作为 `/D=`，并继续用 `container/productName` 作为唯一实际安装根 | 当时以两次 Windows 失败和模板追加行为形成待验证假设；run `32794520190` 在 ASCII container 下仍同样失败，已反证“Unicode `/D=` 是根因”的归因 | 安装结果、产品身份、卸载边界或 evidence 意义未变；保留较窄参数布局，但后续诊断不得继续依赖该归因 | 不适用；内部 harness 历史偏差已更正 |

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
| #175 GitHub CI run `32786670809` / build job `97628007688` | smoke-test SUCCESS；build 在 packaged background canary 失败并最终报告 `UNINSTALL_CLEANUP_FAILED` | 证明 cleanup 会遮蔽首错；该快照不能单独支持 launcher 或 Setup 根因归因 |
| launcher hand-off 修复定向验证 | `windows-build-contract`：`4 PASS / 1 Windows-only SKIP`；4 个 hardening files：`70 PASS / 1 Windows-only SKIP` | 固定 2 秒 report 宽限、首错优先、资源生命周期、取消、资金持久化与文档合同 |
| launcher hand-off 修复全仓验证 | `npm run release-check` PASS；lint/smoke PASS，unit `6017/6019`（0 fail、2 skip），integration `51/51` scripts、`2455/2455` assertions | 修复未引入跨平台或业务回归；仍未调用 `check-vars`/`scan:vars` |
| #175 GitHub CI run `32790663601` / build job `97638885396` | smoke-test SUCCESS；build 输出首错 `SETUP_NONZERO_EXIT`，cleanup 仅追加 `UNINSTALL_CLEANUP_FAILED` 诊断 | 验证首错优先修复有效，并把剩余失败收敛到真实 Setup 调用 |
| Windows runner 与包结构对比 | #174 成功 run `32781005010` 和 #175 两次失败使用同一 `windows-2025-vs2026/20260818.207` 镜像；#175 两次分别落在 westus3 与 westcentralus；asar 均为 64.27MB/3251 entries | 排除单一区域或 runner 镜像漂移；修复聚焦 harness `/D=` 参数，而非放宽产品 canary |
| NSIS destination-root 修复定向验证 | `windows-build-contract`：`4 PASS / 1 Windows-only SKIP`；`git diff --check` PASS | 冻结 container 参数、模板追加、最终产品根选择及 fail-closed Setup 退出合同 |
| NSIS destination-root 修复全仓验证 | 4 个 hardening files：`70 PASS / 1 Windows-only SKIP`；`npm run release-check` PASS，unit `6017/6019`（0 fail、2 skip），integration `51/51` scripts、`2455/2455` assertions；合同包 checksum `69/69 PASS` | 证明参数修复未改变产品、资金/恢复语义、默认 IPC、证据包或 production gate；仍未调用 `check-vars`/`scan:vars` |
| #175 GitHub CI run `32794520190` / build job `97649991756` | smoke-test SUCCESS；ASCII destination-root 修复后 build 仍报告 `SETUP_NONZERO_EXIT`，且无 cleanup 覆盖诊断 | 反证 Unicode `/D=` 根因假设；当前证据只能确认 installer 真实返回非零，尚不能区分退出码及落地阶段 |
| Setup 有界诊断定向验证 | `windows-build-contract`：`4 PASS / 2 Windows-only SKIP`；4 个 hardening files：`70 PASS / 2 Windows-only SKIP`；`git diff --check` PASS | 固定退出码桶、安装根状态、精确 Registry 身份状态；macOS 不伪造两个 Windows 动态探针 |
| Setup 有界诊断全仓验证 | `npm run release-check` PASS；unit `6017/6020`（0 fail、3 skip），integration `51/51` scripts、`2455/2455` assertions；合同包 checksum `69/69 PASS` | 诊断保持主 safe code、业务/资金/恢复语义、production gate 与冻结合同包不变；仍未调用 `check-vars`/`scan:vars` |
| #175 GitHub CI run `32799419428` / build job `97662624541` | smoke-test SUCCESS；build 固定诊断为 `EXIT_OTHER_ROOT_ABSENT_IDENTITY_ABSENT`，随后保持 `SETUP_NONZERO_EXIT` fail closed | 排除产品目录、Registry 身份和旧版卸载路径；失败发生在安装落地前，下一 probe 只需把非标准进程码细化为安全 32-bit hex |
| Setup 精确 32-bit 退出码 probe 验证 | `windows-build-contract`：`4 PASS / 2 Windows-only SKIP`；4 个 hardening files：`70 PASS / 2 Windows-only SKIP`；`npm run release-check` PASS（unit `6017/6020`、integration `51/51` scripts / `2455/2455` assertions）；合同包 checksum `69/69 PASS`；`git diff --check` PASS | 只细化失败诊断，不改变 installer 行为、主 safe code、业务/资金/恢复语义、production gate 或冻结合同包；仍未调用 `check-vars`/`scan:vars` |

## Final Blindspot Review

- 生命周期：正常、错误、取消和重复 `close/terminate` 均收敛到同一个 termination barrier；Supervisor 先等 transport cleanup，再释放 CompoundLease。
- 状态所有权：仅当前 Parser scan 可清理自己的 controller；新 scan、`clearCache` 与 save 后清理都会取消旧任务，generation CAS 继续阻止迟到 adoption。
- 兼容性：未改 Renderer/public IPC、production gate、错误 DTO、operation identity 或 Receipt 唯一性；数据库变更是幂等的 non-unique 加法索引。
- 资金红线：金额、方向、月份、币种、begin/end OP 与 run/files/receipt 原子性定向测试均通过；既有 exact Main owner 和人工签字 gate 仍为 `PENDING_HUMAN_REVIEW`，本 PR 不代替人工复核。
- 平台盲区：macOS 无法执行真实 Windows PowerShell 动态探针；静态合同已通过，动态证据留给 GitHub-hosted Windows CI。
- CI 失败修复边界：仅调整 packaged canary harness 的 launcher/report 等待、错误优先级和有界 Setup 诊断；未改产品代码、金额/币种/身份/幂等/恢复语义、production enablement 或人工资金红线。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows-only 提前退出动态探针 | PROBE | GitHub-hosted Windows CI | 本地静态/跨平台测试通过后可提 Draft；合并前需 CI PASS |
| Setup 非零的真实退出码与失败时安装/Registry 落地阶段 | PROBE | 固定枚举诊断推送后的 GitHub-hosted Windows CI | 当前不得把非零当成功；诊断收敛前不合并 |
| 真实 Windows Setup/portable packaged canary 与资金红线签字 | BLOCK | 既有 R3 人工/Windows gate | 本 PR 不改变其 `PENDING_HUMAN_REVIEW` 状态，仍阻塞 production enablement |
