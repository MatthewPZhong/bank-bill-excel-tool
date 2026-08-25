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

## PR #175 Windows RSS 独立中位组合 Follow-up（2026-08-25）

### Task Brief

- Goal：修复 GitHub-hosted Windows 上 RSS 三组成对样本因独立中位数组合产生的 1MB 假越界，不放宽稳定预算越界、精确线性或 150MB 硬上限。
- Context：run `32802238314` 的 50 个其他 integration scripts 均 PASS；唯一失败为 `toolbox-large-split-multi-sheet` `30/31`，样本 `[48,49,48]→[96,97,97]MB`，paired effective-budget margin 中位数 `0MB`、paired linear margin 中位数 `-48MB`，但独立中位组合 `48→97MB` 相对 96MB 预算超 1MB。
- Constraints：不改生产 `src/`、24MB relative noise、57MB absolute delta、8/32MB low-signal、0.5 fraction、150MB hard cap、业务/资金/恢复合同或 production gate；不运行 `check-vars`/`scan:vars`。
- Done when：本次交错样本 PASS；稳定 `48→97`、`49→98`、`32→73/96`、paired mismatch、精确线性、非法输入与任一 150MB spike 仍 FAIL；真实 50万/150万链、完整 `release-check`、合同包 checksum 与 diff review PASS。

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 失败是否来自 #175 产品/安装器回归 | 归因 | 高 | PROBE | 对照 head diff、51 条 integration 结果与 RSS 样本 | 否；当前 head 的新增行为只在 canary harness/tests/docs，RSS 生产扫描路径未变，50 条其他 integration PASS |
| 能否不抬预算而消除独立中位丢失配对关系的假失败 | 统计门禁 | 高 | PROBE | 回放本次交错样本、稳定越界与 paired mismatch | 仅对独立中位 budget margin 应用 `Math.round(MB)` 的理论传播误差；paired budget/linear margin 保持严格 |
| 取整容差是否会让稳定越界或线性增长通过 | 回归边界 | 高 | PROBE | 稳定 `48→97`、`49→98`、`32→73/96` 与 `[20,40,100]→[60,120,20]` | 均继续 FAIL；单样本/稳定样本无法借容差越界，因为 paired budget margin 仍必须 `<=0` |

无 BLOCK 问题；该修复不改变产品、数据、资金或公开接口。

### Decision

| 决策 | 原因/证据 | 放弃方案与边界 |
| --- | --- | --- |
| 独立中位 budget margin 允许由 `Math.round(MB)` 推导的最大误差；relative 模型在 rowsRatio=3 时为 `0.5×(1+3×0.5)=1.25MB`，absolute 模型为 1MB | tier1/tier2 各自到 MB 仅有 ±0.5MB 量化误差；独立取中位会丢失 pair，但单调 rounding 与奇数中位仍有有界误差 | 不增加 24/57MB，不提高 150MB，不按平台或 run ID 特判 |
| paired effective-budget margin 中位数继续严格 `<=0`，paired linear margin 继续 `<0`；每个原始样本继续 `<150MB` | 当前三对 margin `[0,-0.5,+1]` 中位数 0，说明多数 pair 未越预算；稳定 `48→97` 的 paired margin 为 1，仍 FAIL | 不让 paired 规则普遍覆盖独立中位大幅失败；独立超差仍受 1/1.25MB 有界限制 |

### Evidence

| 检查 | 结果 | 证明/边界 |
| --- | --- | --- |
| GitHub Actions run `32802238314` / smoke job `97665243096` | unit 全 PASS；integration 仅 RSS 脚本 `30/31`，其余 50 scripts PASS；build 因 smoke dependency SKIPPED | 精确失败样本与单一失败面可追溯；失败快照未合并 |
| RSS 确定性单测 + ESLint | `6/6 PASS`；目标两文件 ESLint PASS；`git diff --check` PASS | 交错样本 PASS，稳定越界、线性、错配、硬上限与非法输入继续 fail-closed |
| RSS 默认真实链 | `31/31 PASS`；50万/150万行为 `93→137MB`，effective budget 150MB，paired/独立 margin `-13MB` | 真 multi-sheet、worker、readback 与内存门禁保持；未依赖新容差制造 PASS |
| RSS 修复完整门禁 | `npm run release-check` PASS：lint/smoke PASS，unit `6017/6020`（0 fail、3 skip），integration `51/51` scripts / `2455/2455` assertions；目标 RSS 脚本在全链中再次 `31/31 PASS`；合同包 checksum `69/69 PASS`；`git diff --check` PASS | 产品、业务/资金/恢复语义、production gate 与冻结合同包均未变化；仍未运行 `check-vars`/`scan:vars` |

## PR #175 Windows NSIS per-user access violation Follow-up（2026-08-25）

### Task Brief

- Goal：修复 packaged canary 在真实 GitHub-hosted Windows 上启动 assisted per-user NSIS Setup 时稳定以 `0xC0000005` 崩溃的问题，不改变安装模式、产品身份或 production gate。
- Context：run `32805840596` 的 smoke-test SUCCESS；build 唯一失败为 Setup `EXIT_HEX_C0000005_ROOT_ABSENT_IDENTITY_ABSENT`。当前 lock 为 `electron-builder/app-builder-lib 26.8.1`，其 `multiUser.nsh` 仍在非 Win7 系统执行 `System::Store` + `SHGetKnownFolderPath`；electron-builder 上游 #8536/#9564 将同条件、同异常码归因为该路径的竞态。
- Constraints：保持 assisted installer、per-user `/currentuser` canary、精确产品身份、安装/卸载审计、失败关闭、业务/资金/恢复合同和人工红线；不运行 `check-vars`/`scan:vars`，不改 main。
- Done when：依赖下限与 lock 升到同 major 的修复版本 `26.15.7`；静态测试拒绝旧 `System::Store` 模板并确认安全的 known-folder 字符串复制；定向测试、`release-check`、合同包 checksum、diff/local review PASS；新 Windows CI packaged canary PASS。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 本轮不是 smoke/产品运行失败，而是 Setup 在任何 install root/Registry identity 落地前 native crash | Actions run `32805840596`：smoke SUCCESS；build 输出 `EXIT_HEX_C0000005_ROOT_ABSENT_IDENTITY_ABSENT` | 不得放宽 Setup exit 或把失败快照合并 |
| `0xC0000005` 是 Windows access violation | Microsoft Learn C0000005 调试说明 | 不能继续把它当普通 NSIS 参数返回码 |
| 上游已复现 assisted、per-user NSIS 的同异常码，并定位到 `multiUser.nsh` 的 `System::Store` 竞态 | electron-builder issue #8536、merged PR #9564 | 修复应消除依赖缺陷，不改 oneClick/perMachine UX 来绕过 |
| 当前 26.8.1 模板含 `System::Store S/L`；26.15.7 npm tarball 已改为显式 push/pop 与 `KERNEL32::lstrcpynW`，不再使用 `System::Store` | 本地 `node_modules/.../multiUser.nsh` 与只读 npm tarball 对比 | 可用同 major 依赖升级最小修复，无需 vendored node_modules patch |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 本次 faulting module 是否精确为上游所述 `System.dll` | 归因 | 中 | PROBE | 以修复依赖重跑同一 packaged canary；不收集路径或任意 crash 文本 | 条件、异常码与受影响模板完全匹配，允许同 major 修复；CI 结果为最终证据 |
| 26.15.7 是否引入项目可见兼容回归 | 依赖兼容 | 高 | PROBE | lock diff、安装树、静态 Windows 合同、完整 `release-check` | 保持 major 26，只接受 lock 可审查且全门禁通过的结果 |
| 是否应改为 oneClick/perMachine 或让 canary 改跑 `/allusers` | 合同旁路 | 高 | 已反证 | 对照既有 installer UX 与 canary per-user 合同 | 不采用；这些方案会掩盖真实用户路径或改变安装体验 |

无 BLOCK 问题；该修复不改变数据模型、公开接口、资金边界或主要用户流程。

### Decision

| 决策 | 原因/证据 | 放弃方案与边界 |
| --- | --- | --- |
| 将 `electron-builder` 最低版本和 lock 提升至同 major `26.15.7`，并由模板合同测试锁住修复形态 | 官方 26.15.7 npm tarball 已消除受影响的 `System::Store` 路径；同 major 升级比自维护 node_modules patch 更可审计 | 不升级到 27 alpha；不修改 node_modules 后提交；不通过 `/allusers`、oneClick 或忽略非零退出绕过 |
| 保留现有 fail-closed Setup 诊断和 per-user canary | 新证据解释崩溃来源，但不证明失败可以忽略 | 不打印路径、installer stdout/stderr 或任意异常；不降低产品身份/卸载检查 |

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 升级并审查 package/lock/模板 | 同 major 依赖确实携带上游修复 | install tree 为 26.15.7；模板不含 `System::Store` | 推翻版本选择 | 回退依赖，不提交 |
| 2 | 增加 Windows build contract 反例 | 防止 lock 或模板回退重新引入 native crash | 定向单测 PASS，旧模板形态 FAIL | 不进入全仓验证 | 只保留可解释最小断言 |
| 3 | 完整本地门禁与 blindspot review | 保护产品、资金/恢复、打包合同和证据链 | `release-check`、checksum、diff PASS | 不推送 | 回退该 follow-up |
| 4 | 推送后由相同 Windows canary 验证 | 消除平台归因剩余未知 | Setup/portable packaged canary 均 PASS | 保持 Draft，不合并 | 继续 fail closed 并按新证据收敛 |

### Evidence

| 检查 | 结果 | 证明/边界 |
| --- | --- | --- |
| GitHub Actions run `32805840596` / build job `97682555041` | smoke-test SUCCESS；Setup 固定诊断为 `EXIT_HEX_C0000005_ROOT_ABSENT_IDENTITY_ABSENT`，build 因 `SETUP_NONZERO_EXIT` FAIL | 异常是安装落地前的 native access violation；失败快照未合并 |
| 依赖与模板复核 | `npm ci` PASS；`npm ls electron-builder app-builder-lib --depth=1` 均为 `26.15.7`；per-user macro 不含 `System::Store`，保留 `SHGetKnownFolderPath`、显式 push/pop、`lstrcpynW` 与 `CoTaskMemFree` | lock 可重现地携带上游修复；未修改 installer 模式、产品名、路径合同或 canary 参数 |
| Windows build contract + hardening 定向回归 | `73` tests：`71 PASS / 2 Windows-only SKIP`，0 fail；目标 ESLint 与 `git diff --check` PASS | 新断言阻止依赖/模板回退；资源生命周期、Parser、资金 receipt 与 Windows 合同均保持 |
| 完整本地门禁 | `npm run release-check` PASS：lint/smoke PASS，unit `6018/6021`（0 fail、3 skip），integration `51/51` scripts / `2455/2455` assertions | 同 major 构建依赖升级未造成可见产品、业务、资金或恢复回归；未运行 `check-vars`/`scan:vars` |
| 冻结合同包与变更面 | checksum `69/69 PASS`；本 follow-up 仅修改 package/lock、Windows build contract test 与本实施记录，未改 `src/`、workflow、canary harness 或 production gate | 冻结 spec/techdoc/资金与恢复合同未漂移；真实 Windows Setup/portable 结果仍由新 CI 决定 |

## PR #175 Windows silent `/D` install-root Follow-up（2026-08-25）

### Task Brief

- Goal：修复 `electron-builder/app-builder-lib 26.15.7` 消除 native crash 后，packaged canary 在 Setup 阶段约 14 秒输出通用 `CANARY_HARNESS_FAILED` 的问题。
- Context：run `32809372865` / build job `97692416380` 的 smoke-test SUCCESS，build 成功后 canary 无其他诊断文本，仅输出通用失败 JSON。
- Constraints：保持 assisted `oneClick=false`、`/currentuser`、exact 产品身份、Setup/installed/portable/卸载审计、失败关闭、固定隐私安全码、production enablement=false 与资金/恢复人工红线；不运行 `check-vars`/`scan:vars`。
- Done when：`/D` 与 harness 审计的 final install root 一致；定向测试、ESLint、checksum、`release-check`、diff/self-review PASS；真实 Windows canary 验证 Setup/installed/portable/uninstall 全链。

### 已确认事实与 Unknowns Register

| 事实/未知 | 类型 | 影响 | 处理 | 证据与当前决定 |
| --- | --- | --- | --- | --- |
| 通用码只能来自没有 `safeCode` 的 PowerShell/.NET 异常 | 事实 | 高 | PROBE | 顶层 catch 仅在 `Exception.Data` 无 `safeCode` 时输出 `CANARY_HARNESS_FAILED`；job 无任意异常文本可用 |
| `/S` 下 `instFilesPre` 不执行，`/D` 被当作最终安装目录 | 事实 | 高 | PROBE | NSIS 官方手册 §4.12 明确 silent mode 不调用 page-specific callback，且 `/D` 直接指定 installation directory；26.15.7 `multiUser.nsh` 的 `GetDParameter` 直接 `StrCpy $INSTDIR $R0` |
| 失败 head 的 harness 传 `installContainer`，却在 `installContainer/productName` 下选 executable/卸载 | 事实 | 高 | PROBE | `Invoke-SilentInstaller ... -DestinationRoot $installContainer` 与 `Select-InstalledExecutable -InstallRoot $installRoot` 不一致；正常 Setup 落在 container 后，对不存在子目录的 `Get-ChildItem` 会抛无 safeCode 的 PathNotFound，与本次唯一输出完全一致 |
| 修复后真实 Windows 的 Setup/installed/portable/uninstall 是否全 PASS | 动态平台未知 | 高 | PROBE | 本机无法执行 Windows 产物；保持 CI fail closed，由新 GitHub-hosted Windows canary 消除 |

无新 BLOCK 问题；不改产品、数据、资金、恢复或公开接口合同。

### Decision

| 决策 | 原因/证据 | 放弃方案与边界 |
| --- | --- | --- |
| 继续以 `installContainer/productName` 作为唯一 exact install root，并将该根目录直接传给 silent `/D` | silent NSIS 不执行追加 APP_FILENAME 的 page callback；传入最终根目录使 Setup、executable 选择、卸载和身份审计回到同一路径 | 不用 `/allusers`、perMachine、oneClick、目录 fallback 或忽略异常绕过 |

### Evidence

| 检查 | 结果 | 证明/边界 |
| --- | --- | --- |
| GitHub Actions run `32809372865` / build job `97692416380` | smoke-test SUCCESS；packaged canary 约 14 秒后仅输出 `CANARY_HARNESS_FAILED`，无 setup diagnostic、cleanup diagnostic 或任意异常文本 | 失败是 harness 无 safeCode 路径，不得依赖日志中不存在的隐藏细节 |
| 根因定向合同测试 | `node --test tests/unit/windows-build-contract.test.js`：`5 PASS / 2 Windows-only SKIP`，0 fail | 锁定 26.15.7 `/D` exact-root 模板、harness 传 final root，并禁止退回 container |
| 最终定向回归与静态门禁 | 4 个 hardening test files：`71 PASS / 2 Windows-only SKIP`；目标 ESLint、`git diff --check` PASS | 安装根合同、资源生命周期、Parser 取消与资金 receipt 回归均通过；本机不伪造 Windows 动态结果 |
| 最终完整门禁 | `npm run release-check` PASS：lint/smoke PASS，unit `6018/6021`（0 fail、3 skip），integration `51/51` scripts / `2455/2455` assertions | 核心修复和删除不可达防御后全仓再验证；未运行 `check-vars`/`scan:vars` |
| 冻结合同包与最终变更面 | checksum `69/69 PASS`；纯计时 `rules/integration-test-policy.md` 生成差异已恢复，最终仅 harness、Windows contract test 和本记录 3 文件 | 未改 `src/`、workflow、package/lock、业务/资金/恢复合同或 production gate |

## Final Blindspot Review

- 生命周期：正常、错误、取消和重复 `close/terminate` 均收敛到同一个 termination barrier；Supervisor 先等 transport cleanup，再释放 CompoundLease。
- 状态所有权：仅当前 Parser scan 可清理自己的 controller；新 scan、`clearCache` 与 save 后清理都会取消旧任务，generation CAS 继续阻止迟到 adoption。
- 兼容性：未改 Renderer/public IPC、production gate、错误 DTO、operation identity 或 Receipt 唯一性；数据库变更是幂等的 non-unique 加法索引。
- 资金红线：金额、方向、月份、币种、begin/end OP 与 run/files/receipt 原子性定向测试均通过；既有 exact Main owner 和人工签字 gate 仍为 `PENDING_HUMAN_REVIEW`，本 PR 不代替人工复核。
- 平台盲区：macOS 无法执行真实 Windows PowerShell 动态探针；静态合同已通过，动态证据留给 GitHub-hosted Windows CI。
- CI 失败修复边界：仅调整 packaged canary harness 的 launcher/report 等待、错误优先级和有界 Setup 诊断；未改产品代码、金额/币种/身份/幂等/恢复语义、production enablement 或人工资金红线。
- RSS 盲区：独立中位容差只覆盖 MB rounding 的理论传播上界；paired budget/linear margin 与每样本 150MB ceiling 仍严格。稳定 `48→97`、`49→98`、`32→73/96`、错配及线性反例均由 self-check/单测锁定为 FAIL；未按 Windows、run ID 或当前样本硬编码。
- NSIS 依赖盲区：本 follow-up 不改安装模式或放宽 canary，只把同 major 构建链提升到已移除 `System::Store` 竞态的 `26.15.7`；本机静态/全仓门禁不能替代真实 Windows 安装，故新 CI 仍是 merge 前硬证据。
- Silent install-root 盲区：`/S` 不执行 page callback，harness 现将带 exact productName 的 final root 直接传给 `/D`；不存在子目录 fallback，仍保持失败关闭。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows-only 提前退出动态探针 | PROBE | GitHub-hosted Windows CI | 本地静态/跨平台测试通过后可提 Draft；合并前需 CI PASS |
| exact silent `/D` 修复后的真实 Windows Setup/installed/portable/uninstall 结果 | PROBE | 新 head 的 GitHub-hosted Windows packaged canary | 不得把非零或缺失身份/卸载审计当成成功；全部 PASS 前不合并 |
| RSS 取整组合修复后的 Windows 结果 | PROBE | 新 head 的 GitHub-hosted Windows CI；必须先通过完整 smoke/release-check 才进入 packaged build | 阻断 Ready/merge，不阻断本地修复提交 |
| 真实 Windows Setup/portable packaged canary 与资金红线签字 | BLOCK | 既有 R3 人工/Windows gate | 本 PR 不改变其 `PENDING_HUMAN_REVIEW` 状态，仍阻塞 production enablement |
