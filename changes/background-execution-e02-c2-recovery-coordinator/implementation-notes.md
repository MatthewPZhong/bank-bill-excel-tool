# Implementation Notes

## Baseline

- Goal/spec: 实现 `changes/background-execution-v3.2.x-contract-baseline/` 冻结的 E02-C2 Recovery Contract。
- Initial plan: 先完成 Intent/Hold 持久闭环，再实现 RecoverySource/registries/coordinator/canary，最后接入真实 Main 启动边界。
- Done when: 剩余 7 个 transition、启动扫描/恢复、冲突门禁和 production=false canary 均有正反测试；Archive/cleanup 仅在 recovery scan 完成后启动。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| C2 继续复用 Main control DB 与 C1 request owner/event transaction | E00 TechDoc §8.1、§9.1 明确要求 Task/Batch/Intent/Hold/event 同一 Main-owned transaction | 新建独立 platform DB；异步补 event | 保持 C1 replay、FK 与原子性合同 |
| Main 接线点固定在 `database.init()` 后、`initializeArchiveCenter()` 前 | `src/main.js:21164` 的真实顺序证明 Archive controller initialize 会消费 owner/outbox/recovery 证据 | 仅模块测试；Archive 初始化后再扫 | scan 失败沿现有 startup failure fail-closed |
| canonical canary 永久保持 production=false，且不伪造 Action↔Task binding | 冻结 Policy fixture 声明 production.enabled=false；Action Manifest 对该 action 的 task binding 为空 | 接入真实资金 action；伪造 legacy taskKey | 只验证平台 durability/recovery contract |
| canary receipt DDL 与产品 migration 物理分离 | canary 只能使用 private/test DB；单测证明 `ensureArchiveMetadataSupport()` 后不存在 canary 表 | 在所有用户 Main DB 建测试表 | 产品 DB 只包含 Intent/Hold 等正式控制表 |
| active primary Hold 下的失败 observation 复用既有 `holdId` | E00 TechDoc §10.4/§11.4 要求不新增/覆盖 primary hold；同源 transient 仍有界重试并逐 attempt 审计，不同 source 才立即 blocked | 再次 create-or-get 并撞 active-scope UNIQUE；active 即跳过退避 | 同源 Inspector/Provider 失败保持三次有界 attempt；不同 source 保持单一 gate且不 settlement |
| legacy/managed gate 接到 `runArchiveAwareOperation` 的 preparation/admission/beforeStart | 这是所有非 exclude TaskPolicy 的中央真实入口；冻结 ActionTaskBindingRegistry 可将 Hold action 映射到 legacy taskKey | 仅暴露 library gate；逐业务模块散接 | 当前入口 fail closed；未进入该入口的未来 action 仍是 production enablement BLOCK |
| active Hold 的 action 无法映射冻结 Action→Task authority 时阻断 Main 启动/运行 | 无映射时无法证明应阻断哪个 legacy mutation；静默忽略会使 manual/future Hold fail-open | 忽略未知 action；猜测 task/scope | 产品启动不注册 IPC/窗口；运行期二次防线也全局 fail-closed |
| 同一 scan 内每个 source 决策后从 Main DB 刷新 scope primary Hold | 第一个 source 可在本轮动态创建 Hold；只使用 scan 开始时的快照会让后续 source 误建第二个 Hold并撞 active-scope UNIQUE | 只依赖启动快照；catch 唯一键后继续 | 后续不同 source 仍 inspect 并关联新 primary hold，但不进入 Provider/settlement；摘要返回最终 active Hold 数 |
| open Intent 转 RecoverySource 前重算 persisted bounded evidence SHA-256 | Main DB 同时保存 evidence JSON/hash；只读 JSON 不验 hash 会把损坏证据交给 Inspector | 只依赖 transition 初次写入；忽略持久漂移 | hash mismatch 先创建 `INSPECTION_UNKNOWN` Hold，再让启动 fail closed |
| Windows 仅把目录句柄的 `EACCES/EISDIR/EPERM` 归类为 capability unsupported | PR #170 Windows CI 三个失败都来自真实目录 barrier；仓库既有 directory-fsync 适配使用同一 errno 集 | 全平台吞这三类错误；把 unsupported 强报 committed | Windows 返回 `durability-unavailable` 并保持 source/Hold fail-closed；非 Windows 权限错误和 `EIO` 仍 fatal |
| supported 状态机测试注入 directory barrier，integration canary 使用真实宿主能力 | 单测的 Provider/recovery 语义不应由运行测试的 OS 决定；integration 需要报告真实 capability | Windows 跳过测试；生产代码吞错；所有测试只用 fake fs | file write/fsync/rename 仍走真实 FS；只有 unit success barrier 受控，真实 canary 只接受可解释的 supported/unsupported |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| RecoverySource runtime schema 复制到生产受控 schemas 目录 | C1 已采用 authority schema 的受控副本 | 打包后找不到 schema | 单测解析后逐字段 deep-equal authority；删除副本可回滚 |
| transient retry 默认阈值 3、退避 25/50/100ms 并封顶 250ms，仅为 coordinator 内部可注入值 | 冻结 authority 只要求 bounded exponential backoff，未冻结公共常量 | 若后续 authority 冻结不同阈值需调整实现和 KAT | 无 IPC/Renderer/public schema 扩张；targeted 测试注入 3 与 7/14ms |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Hold 表保存 `evidence_sha256` 辅助列 | 严格使用 E00 §8.3 的 16 列 DDL；完整 evidence 只在 durable request owner/event request 中保存 | 机器 request schema 有 evidenceHash，但冻结物理 DDL没有该列 | 无隐式 schema 漂移；read DTO 不发明字段 | 不需要（回归 authority） |
| canary receipt 随通用 recovery migration 建表 | 拆为 `canary/canary-schema.js`，仅 private test 显式 opt-in | canary 不得污染产品 userData DB | 产品 migration 边界收紧 | 不需要（回归 authority） |
| 原测试把宿主真实 directory fsync 固定断言为 `committed` | unit success path 改用显式 supported seam；integration 根据真实 capability 验证 `committed` 或 `durability-unavailable` | GitHub-hosted Windows 对目录句柄返回不支持，固定成功断言与冻结 fail-closed 合同冲突 | 不改变生产成功定义；Windows 不再因正确的 unsupported 结论误报测试失败 | 不需要（测试回归既有合同） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD && git branch --show-current` | `b1cc0c08...` / `codex/v3.2.0-e02-c2-recovery-coordinator` | 分支与基线正确 |
| `src/main.js:21164-21220` 启动链取证 | DB init 后当前立即初始化 Archive，再安排副作用 cleanup | 已定位必须插入的真实产品边界 |
| E00 TechDoc §8.2/8.3/9/11 + RecoveryControl/RecoverySource schemas/fixtures | DDL、7 branch、result/identity、startup ordering 均有机器/文本权威 | 不自行发明公共合同 |
| `node --test tests/unit/main-process/background-execution/recovery-control-repository.test.js` | 39/39 PASS | C1 兼容、7 个 C2 transition、request-owner/replay、outer transaction rollback |
| `node --test tests/unit/main-process/background-execution/recovery-contract-c2.test.js` | 35/35 PASS | schema/registries/coordinator、全 outcome mapping、动态 primary Hold、Main ordering/gate、durability |
| `node --test tests/unit/main-process/background-execution/action-task-binding-registry.test.js` | 15/15 PASS | 真实 TaskPolicy→binding→DB→IPC seam；startup failure continuation=0、窗口在 run 后 |
| `node scripts/integration/background-execution-recovery-canary.js` | 9/9 PASS | private DB、worker COMMIT 后 crash、restart receipt、provider-only journal、target durability、production=false |
| `npm run release-check`（原实现本地） | PASS：lint；smoke；unit 5918/5919（0 fail、1 skip）；integration 51/51 scripts、2455/2455 assertions | 全仓回归、Main/C1 兼容、C2 canary 9/9、recovery-control integration 27/27 |
| source-level startup ordering proof | `database.init → await initializeBackgroundExecutionRecovery → initializeArchiveCenter → runStartupPostSetup`；`runActionTaskBindingStartup` reject 时不会执行 `createWindow`/IPC registration | Main failure 不降级继续；empty source scan 有正例 |
| Windows run `32710239931` / job `97379873395` | unit `5914/5919`、3 fail；#1175/#1190 抛 `DURABILITY_DIRECTORY_FSYNC_FAILED`，#1184 expected `closed` / actual `committed` | 真实 Windows 目录句柄 capability 触发同一根因，build 按门禁正确 skip |
| CI 修复后定向验证 | recovery-contract `35/35 PASS`；recovery canary `9/9 PASS`；targeted ESLint、`git diff --check` PASS | supported/unsupported/fatal、Provider close、target post-image 与 production=false |
| CI 修复后 `npm run release-check` | PASS：lint/smoke；unit `5918/5919`（0 fail、1 skip）；integration `51/51` scripts、`2455/2455` assertions | 全仓回归；未运行 `check-vars`/`scan:vars` |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows CI 实际 unsupported errno 与修复后全量结果 | PROBE | GitHub-hosted Windows rerun；canary 输出 capability，三类目录专用 errno 均已覆盖 | 推送前保持 PR 不合并；无论 supported/unsupported，target-post-image 资金 action仍不得 production enable |
| 未来业务 action 的 settlement transition mapping 与 scope resolver | BLOCK（production enablement） | 后续版本逐 action 注册 Inspector/Provider/mapper/resolver 并接入各自 recovery lock | C2 平台/产品 startup boundary 可合并；不得声称真实业务 recovery 已闭环 |
| 未通过 `runArchiveAwareOperation` 的未来/模块专用 mutation | BLOCK（production enablement） | 每个后续 action 迁移时证明其入口进入中央 gate 或增加同等 gate | 当前 52 action→Task binding 的中央 Archive 路径已接线，但不能泛化声称覆盖尚未迁移 action |
| 资金/恢复红线人工复核 | BLOCK（发布门禁） | 资金/发布负责人 | 自动测试不能代签，状态保持 PENDING |

## Blindspot Pass

### 已关闭的 production-reachable findings

1. Main gate 对无法映射 Action→Task 的 active Hold 原会静默忽略；现改为启动与每次 admission 双重 `RECOVERY_HOLD_ACTION_UNBOUND` fail-closed。
2. 同次 scan 首个 source 动态建 Hold 后，后续同 scope source 原仍使用启动快照；现每个 decision 后从 Main DB 刷新 primary Hold，并返回最终 Hold count。
3. open Intent 的 `evidence_json/evidence_sha256` 原只读取不比对；现转 RecoverySource 前重算 hash，失配先落 `INSPECTION_UNKNOWN` Hold 后阻断启动。
4. active 同源 Hold 的 transient 原过早停止退避；现 Inspector/Provider 均逐 attempt 关联 existing holdId，阈值末次可审计且不重复建 Hold。
5. Windows directory handle 的 `EACCES/EISDIR/EPERM` 原被当作不可分类 fatal；现只在 `win32` 归为 explicit unsupported，返回值绝不使用 `committed`，真实 host capability 由单测 diagnostic 和 standalone canary 无路径输出。
6. deterministic success seam 只存在于 production-disabled canary Provider 和 durable writer 内部 options；文件写入、文件 fsync、同目录 rename、Inspector/Coordinator/Hold 状态机仍走真实实现，未形成业务入口旁路。

### 存活边界

- **BLOCK / production enablement**：未迁移真实业务 Inspector/Provider、lifecycle mapper、module recovery lock 与精确 conflict-scope resolver；中央 gate 当前按 Action→legacy Task 保守阻断，不能宣称逐 scope 业务闭环。
- **PROBE**：Windows CI 已证明宿主不能完成当前目录 barrier；修复后 canary 会输出 capability，明确 unsupported 返回 `durability-unavailable`，非目录/非 allowlist 错误继续抛出，target-post-image 资金 action保持 production=false。
- **ASSUME**：transient 默认 3 次、25ms 指数退避/250ms 封顶仅为内部可注入实现；authority 未冻结常量，也未扩公共合同。

## Reconciliation Blindspot Pass

- 本阶段没有修改金额、币种、借贷方向、Excel 行、业务去重键或 IPC；canary 只使用 synthetic identity/private DB，产品 migration 明确不创建 canary receipt 表。
- 资金相关不变量集中在“不重复 mutation / 不凭 unknown 重放”：同事务 receipt、source exact dedupe、owner/evidence collision、Provider identity/hash、multi-object rollback 与 Hold gate 均有正反自动证据。
- 本次 CI 修复不改变 operation/task/source identity、重试次数、settlement outcome 或 transition；unsupported 时 post-image 可能已 rename 到目标路径，但只能返回 `durability-unavailable`，后续由 Inspector + open source/Hold 审计，禁止当作成功释放恢复责任。
- ⚠️ 资金红线仍命中“恢复重试/重跑可能影响真实资金 mutation”；`P0-recovery-control-redline-human-review-checklist.md` 的 HR1–HR6 及签名状态保持 `PENDING_HUMAN_REVIEW`，自动 PASS 不代签。
