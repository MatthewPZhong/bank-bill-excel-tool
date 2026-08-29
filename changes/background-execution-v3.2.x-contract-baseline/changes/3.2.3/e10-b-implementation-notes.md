# E10-B Implementation Notes

## Baseline

- Goal/spec: [`spec.md`](./spec.md) §9 与 [`techdoc.md`](./techdoc.md) §9 的 `new-account:save-as` async copy/Publisher。
- Initial plan: [`e10-b-preflight.md`](./e10-b-preflight.md)。
- Done when: E10-A artifact 只被异步复制到 task staging；Main 对 source/FilePlan/staging/business evidence 复核后只调用既有 durable single FIFO Publisher；失败 fail closed，production 保持 disabled。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| copy contract 只带 source identity/evidence 与 task-owned staging resource | `copyFile` destination 必须从 `stagingRoot + resourceId` 精确派生；final target 只留在 Main 的 FilePlan | 把 final target 传入 inline entry；Worker/entry 直接另存为 | entry 无法触碰用户目标，Main settlement 保持唯一发布入口 |
| Main在generation dispatch前从冻结input流式构造branded expected authority | reviewer证明恶意Worker可生成错误账户/币种workbook并自报一致digest；Worker result不能成为expected | 快照/信任E10-A Worker result | E10-A/E10-B回读expected只来自out-of-band Main authority；不携带raw rows |
| source 采用 canonical path + dev/ino + snapshot + size + SHA 四层复核 | 单靠 size/mtime 无法识别同大小同时间替换；copy 前后和 Main handoff 前均需 fail closed | 只比较路径、mtime 或 staging hash | before/during/after drift 与同 size/mtime replacement 均 Publisher=0 |
| 既有 `defaultDispatcher.publish` 窄入口强制archive handoff | Publisher commit与Task settlement之间必须保留唯一durable RecoverySource | `requireArchiveHandoff=false`或new-account自建receipt/retry | journal保留到artifact durable及Task终态ack；startup只恢复settlement，不重copy/publish |
| strict readback冻结精确Sheet set/order/count并返回验证metadata | 首Sheet名匹配不足以拒绝附加secret sheet | 只检查至少一个Sheet或Publisher硬编码sheetCount=1 | 恶意附加Sheet Publisher=0；Publisher metadata来自回读事实 |
| inline adapter terminate/close await实际execution promise | AbortSignal不能中断正在进行的copyFile syscall；立即返回会虚报lease/leak收口 | 只closed/abort后立即返回 | 正常shutdown等copy cleanup后释放；deadline由Supervisor报transport leak并保留owner |
| production 保持 `false/legacy/0`，不接 live IPC | Windows packaged 和真实资金人工门禁未完成 | 本轮直接切换 `new-account:export` | E10-B 仅提供已注册但 dormant 的 runtime/Main seam |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `copyFile` 运行中不能通用 cooperative abort，因此 cancel safepoint固定在copy前后，transport等待真实结算 | Node `fs.promises.copyFile` API 与冻结policy safePoints | app quit在timeout内等待当前syscall；超时产生显式transport leak/cleanup owner | slow-copy/quit/deadline/late terminal tests；production保持false |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原实现关闭archive handoff并信任Worker artifact expected | 改为Main authority + durable handoff/settle/ack | reviewer真实blocking probes证明存在错误发布和crash重复窗口 | 行为收紧为fail closed，不改变合法E10-A业务输出 | 是，spec/techdoc §9 |
| 原readback仅验证首Sheet | 改为精确Sheet集合 | reviewer附加sheet probe真实提交 | 合法单Sheet不变，附加Sheet拒绝 | 是，spec/techdoc §9 |
| 原inline terminate立即返回 | await实际execution，由既有Supervisor bounded timeout | reviewerslow-copy app quit probe证明staging晚清理 | shutdown报告与真实lease/cleanup一致 | 是，spec/techdoc §9 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact parent/merge-base | `d073ced023b40feb477cf7557801a2899b433500` | 精确 E10-A 父链 |
| RED | 首次运行 `new-account-save-as-e10-b.test.js` 因 `artifact-copy` 不存在失败 | 证明测试先于 production 模块 |
| reviewer finding定向 | `E10-A 20/20`、`E10-B 33/33`、adapter `22/22` PASS | 恶意自洽业务、附加Sheet、committed-reply-lost、pre/post settle/ack、slow-copy shutdown/deadline/late terminal |
| E10-A + strict readback + policy/Publisher/Governor 聚焦 | `217/217 PASS` | generation golden、业务digest、Publisher archive handoff/recovery、TaskLifecycle与Supervisor资源合同不漂移 |
| 全量 unit | `6369/6373 PASS`，`3 SKIP`，仅 1 个已知 NSIS dependency baseline failure | 新增测试全绿；剩余失败可在未改 package/lock/test 的 exact parent 依赖环境独立复现 |
| 全量 integration | `51/51 scripts`、`2455/2455 assertions PASS` | 跨模块/恢复/statement generation 回归；runner自动耗时清单已还原，未提交时间戳噪声 |
| smoke | PASS | 读写、对账、报告与主流程 smoke |
| lint/check | `npm run lint`、changed JS `node --check`、`git diff --check` PASS | 静态语法与差异卫生 |
| 资源/响应 | policy `I/O=1, CPU=0, Worker=0`；真实 Governor grant/release/reject、heartbeat、quit-cancel 均 PASS | copy 等待不阻塞 event loop；lease 无泄漏；Publisher 未提前进入 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Publisher/路径语义 | BLOCK production gate | R3.2.3 Setup/portable 人工与 fault probe | 不阻塞 dormant merge；阻止 production enable |
| target ancestor rename+ordinary replacement | BLOCK public FilePlan/Publisher contract | 已向root提交字段/journal兼容/Windows/rollback只读方案，等待用户授权 | 当前finding未修；阻止本轮宣称全部review finding闭合 |
| 真实资金样本与 Excel/WPS 展示 | BLOCK production gate | 资金负责人逐项人工复核 | 自动化不能替代人工资损验收 |
| 当前安装的 electron-builder NSIS helper 含 `System::Store` | 已知 exact-parent 依赖环境基线；本轮不改依赖/构建合同 | 发布负责人按既有 Windows 构建链校准依赖后复跑 | 不归因于 E10-B；仍阻止把本机 unit 结果表述为全绿 |
