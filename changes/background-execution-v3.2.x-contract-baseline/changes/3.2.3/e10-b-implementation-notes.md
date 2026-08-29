# E10-B Implementation Notes

## Baseline

- Goal/spec: [`spec.md`](./spec.md) §9 与 [`techdoc.md`](./techdoc.md) §9 的 `new-account:save-as` async copy/Publisher。
- Initial plan: [`e10-b-preflight.md`](./e10-b-preflight.md)。
- Done when: E10-A artifact 只被异步复制到 task staging；Main 对 source/FilePlan/staging/business evidence 复核后只调用既有 durable single FIFO Publisher；失败 fail closed，production 保持 disabled。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| copy contract 只带 source identity/evidence 与 task-owned staging resource | `copyFile` destination 必须从 `stagingRoot + resourceId` 精确派生；final target 只留在 Main 的 FilePlan | 把 final target 传入 inline entry；Worker/entry 直接另存为 | entry 无法触碰用户目标，Main settlement 保持唯一发布入口 |
| Main 在开始时快照 E10-A result 与 FilePlan | 防止同进程 caller 在 async copy 期间改写 expected business evidence/target descriptor | 发布前重新读取 caller 可变对象 | source/target exact evidence 属于本次 task owner，后续只读 |
| source 采用 canonical path + dev/ino + snapshot + size + SHA 四层复核 | 单靠 size/mtime 无法识别同大小同时间替换；copy 前后和 Main handoff 前均需 fail closed | 只比较路径、mtime 或 staging hash | before/during/after drift 与同 size/mtime replacement 均 Publisher=0 |
| 只导出既有 `defaultDispatcher.publish` 的窄 async wrapper | 既有模块 singleton 已提供 FIFO、journal、recovery 和 uncertain ownership | new-account 自建 dispatcher/receipt/retry | Publisher authority、journal 方言和 recovery 仍只有一套 |
| strict readback 增加 bounded digest-only expected 分支 | E10-A result 已含 rowCount + 四个业务 digest；无需把 raw records 再带回 Main | copy 后只验文件 SHA；或跨边界携带全部 records | Main 可重算 workbook 业务 evidence；原 records golden 分支保持不变 |
| production 保持 `false/legacy/0`，不接 live IPC | Windows packaged 和真实资金人工门禁未完成 | 本轮直接切换 `new-account:export` | E10-B 仅提供已注册但 dormant 的 runtime/Main seam |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `copyFile` 运行中不能通用 cooperative abort，因此 cancel safepoint 固定在 copy 前后 | Node `fs.promises.copyFile` API 与冻结 policy safePoints | app quit 需等待当前单次 copy syscall；目标尚未进入 Publisher protected phase | heartbeat/quit fault test；production 保持 false；后续若平台批准可改用可取消 stream，但不得静默改变合同 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 无 | 无 | 当前按冻结 spec/techdoc 实现 | 无 | 不适用 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact parent/merge-base | `d073ced023b40feb477cf7557801a2899b433500` | 精确 E10-A 父链 |
| RED | 首次运行 `new-account-save-as-e10-b.test.js` 因 `artifact-copy` 不存在失败 | 证明测试先于 production 模块 |
| E10-B 定向 | `27/27 PASS` | drift/alias/symlink/hardlink/tamper/copy error/Publisher 0-1/recovery/cancel/resource/Windows semantics |
| E10-A + strict readback + policy/Publisher/Governor 聚焦 | `160/160 PASS`；另 runtime 联动 `37/37 PASS` | generation golden、业务 digest、既有 Publisher 与资源合同不漂移 |
| 全量 unit | `6356/6360 PASS`，`3 SKIP`，仅 1 个已知 NSIS dependency baseline failure | E10-B 引起的 runtime inventory 失败已修复；剩余失败可在未改 package/lock/test 的 exact parent 依赖环境独立复现 |
| 全量 integration | `51/51 scripts`、`2455/2455 assertions PASS` | 跨模块/恢复/statement generation 回归 |
| smoke | PASS | 读写、对账、报告与主流程 smoke |
| lint/check | `npm run lint`、changed JS `node --check`、`git diff --check` PASS | 静态语法与差异卫生 |
| 资源/响应 | policy `I/O=1, CPU=0, Worker=0`；真实 Governor grant/release/reject、heartbeat、quit-cancel 均 PASS | copy 等待不阻塞 event loop；lease 无泄漏；Publisher 未提前进入 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Publisher/路径语义 | BLOCK production gate | R3.2.3 Setup/portable 人工与 fault probe | 不阻塞 dormant merge；阻止 production enable |
| 真实资金样本与 Excel/WPS 展示 | BLOCK production gate | 资金负责人逐项人工复核 | 自动化不能替代人工资损验收 |
| 当前安装的 electron-builder NSIS helper 含 `System::Store` | 已知 exact-parent 依赖环境基线；本轮不改依赖/构建合同 | 发布负责人按既有 Windows 构建链校准依赖后复跑 | 不归因于 E10-B；仍阻止把本机 unit 结果表述为全绿 |
