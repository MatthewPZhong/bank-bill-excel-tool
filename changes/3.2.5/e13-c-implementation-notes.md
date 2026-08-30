# v3.2.5 E13-C Implementation Notes

## Baseline

- Goal/spec：[spec.md](./spec.md) §3.1/§4/§5、[techdoc.md](./techdoc.md) §3/§4、[implementation-sequence.md](./implementation-sequence.md) E13-C。
- Preflight：[e13-c-preflight.md](./e13-c-preflight.md)。
- Exact local parent：E13-B candidate `04ff3ef28db7edfc20757d2bb2ab6e337de94749`。
- Done when：copy/regenerate 两个 action 的来源、拓扑、输出验证与 Publisher 边界独立可证；现有 IPC 只绑定 copy，regenerate 保持 dormant；legacy 与 production strategy 不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| `acquiringBillCurrency:export` 只绑定 `acquiring:copy-existing-diff` | 当前 handler 唯一业务操作是读取 `diff_file_path` 并复制，完全不查询 DB 或调用 writer | 同一 handler 同时绑定 copy/regenerate；按按钮文案或文件大小猜 mode | action/task pair 从 60 收紧为 59；regenerate 无 legacy TaskPolicy binding。 |
| Regenerate 保留为独立 dormant capability | `writeDiffWorkbook()` 是真实、可复用的 DB→XLSX 能力，但当前没有 IPC/button | 编造隐藏入口；为了 coverage 复用 copy handler；删除 action | Runtime 注册 thread-single Worker，production=false；未来入口需单独 change 与门禁。 |
| Copy source 同时绑定普通文件 identity 与内容 hash | 只冻结路径无法发现 symlink、替换、读取期间变化或同路径内容漂移 | 信任 `diff_file_path`；同步复制后再看结果 | Main 冻结路径/canonical path/device/inode/size/mtime/hash，inline executor 与发布前反复复核。 |
| Regenerate 只接受 `success + chunk_progress.complete` | modern run 的 durable output publication 在 complete 时收口；partial/data-complete/unknown 都不是可导出的稳定状态 | 只看 `runs.status=success`；允许 progress 缺失的兼容降级 | legacy unknown run 不进入 regenerate；copy 仍按原稳定文件合同兼容。 |
| Regenerate 复用原 writer 且只读打开 DB | 资金 SQL、排序、金额/币种与 Workbook 都已在现有 writer 固化 | 重写查询/Workbook；把业务行经 Protocol 传入 Worker | Worker 在同一 read transaction 内复核 run/flow/bill/diff 摘要并调用原 writer。 |
| Copy artifact 的业务证据定义为 source byte hash | copy 不解析/重建 workbook；对其声称 sheet/row 语义会制造虚假证据 | 为 copy 再读 XLSX；把 0/0 误报为 workbook 验证 | `businessDigest=sha256`、`sheetCount=0`、`dataRowCount=0`；Publisher 仍取得真实技术证据。 |

## Deviations

| 原合同/计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 冻结 action manifest 将 copy 与 regenerate 同时映射到当前 export handler | 当前 binding 只保留 copy；regenerate 为空 | 代码证据证明当前树没有 regenerate 用户入口，继续双绑定会违反“静态分类、不运行时猜测” | E13-G 需据 current authority 重建 manifest/provenance/checksum，旧 fixture 不可代偿 | 是，顶层 Spec/TechDoc 已记录；冻结基线不改。 |

## Evidence

| 证据 | 当前结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E13-C 定向测试 | `10/10 PASS` | action/binding、copy byte parity、symlink/tamper/cancel、main/side complete-only regenerate、DB read-only、source stale、真实 inline/thread Runtime、三次 freshness、单次 Publisher、交叉输入拒绝、Publisher failure、legacy Main branch。 |
| E13-A/B/C 扩大回归 | `115/115 PASS` | E13-A/B/C 全部只读导出、真实 Runtime、Acquiring crash/resume、双源读取、worker pool、action/task authority 与顶层合同。 |
| Acquiring/Registry 重点回归 | `60/60 PASS` | dual-source run export、resume/crash identity、worker pool、action/task authority、Main 静态 FilePlan 使用。 |
| Acquiring 集成回归 | `252/252 PASS` | idle cleanup、N4 migration、engine migration、index slim 与 side-DB parity。 |
| Smoke | `npm run smoke` PASS | 全项目 smoke 与 Acquiring `203/203`、progress `34/34`、pragma `27/27` 均通过。 |
| 完整单测 | `6819/6822 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260830-232228.log` | 首轮暴露 2 个 Runtime policy 清单断言未纳入 E13-C，以及隔离依赖误链接旧 `electron-builder 26.8.1`；更新 authority 并按 lockfile 安装 `26.15.7` 后全量复跑通过。 |
| 完整 integration | `2488/2488 PASS`（53 scripts，`379705 ms`） | 全量 integration runner 通过，并按 runner 合同自动同步 `rules/integration-test-policy.md` 的清单时间与实测耗时；未改测试集合或业务 policy。 |
| ESLint/语法 | `npm run lint` PASS；新增/修改模块 `node --check` PASS | 源码装载与项目 lint。 |
| Production/human gate | 两 action `production.enabled=false`；资金/恢复人工复核未关闭 | capability 完成不能被表述为 production enabled。 |

## Blindspot / Reconciliation

- Copy 不在文件缺失、source stale 或校验失败时 fallback 到 regenerate；两条 action 不能互相代偿。
- Regenerate 摘要覆盖 run、chunk progress、flow、bill、diff 的稳定顺序；Worker 在只读事务内复核后才调用原 writer。
- Regenerate source path 必须位于冻结 userDataDir 且为普通单链接文件；业务 authority 刻意绑定 writer 实际读取的稳定行语义而非整个 SQLite 文件字节。这样既能发现所有会改变工作簿的行级漂移，也不会把 WAL、空闲页或无关表变化误报为资金语义漂移；相关数据相同的等价文件替换可接受。
- 现有 `writeDiffWorkbook()` 的 SQL、JOIN、排序、金额、币种、12 列输出、sheet 切分与汇总均未修改。
- Publisher 之前依次复核 source、执行结果 identity、task-owned artifact 技术证据和 workbook/byte 业务证据；任何一步失败均不发布。
- 未新增 IPC/button，未修改 run/resume/multiworker、事务、receipt 或 Recovery Hold；production、main、tag 均未改变。
- 资金/恢复人工复核、Windows、真实大文件/RSS 仍是 R3.2.5 的显式门禁。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows inline copy 与 regenerate Worker 包构建/运行 | BLOCK（production） | R3.2.5 Windows CI/人工验证 | 不阻止 dormant capability；阻止 production。 |
| 真实大 run 的 regenerate RSS/时长 | PROBE | R3.2.5 benchmark/观察证据 | 不阻止 production=false 合并。 |
| 最终 action manifest/provenance checksum | PROBE | E13-G 以 current binding 重建 | E13-G 前不得宣称 package integrity 完成。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项不得记录为 PASS。
