# v3.2.5 E13-A Implementation Notes

## Baseline

- Goal/spec：[spec.md](./spec.md) §3.1/§4、[techdoc.md](./techdoc.md) §1～§3、[implementation-sequence.md](./implementation-sequence.md) E13-A。
- Preflight：[e13-a-preflight.md](./e13-a-preflight.md)。
- Initial plan：先冻结 action/run/source authority，再复用旧 writer 实现 Pending 与 BizOP module-specific Worker，最后接 Main validation/Publisher；production 始终关闭。
- Done when：5 action capability 完整，legacy-vs-managed golden 与失败/取消/stale 证据通过，业务/资金人工门禁仍待后续 R3.2.5。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| `pending:export-summary` 精确对应 aggregate IPC | 现有 IPC、默认文件名、sheet 与 writer 都将其定义为跨月汇总 | 新增一个无用户入口的 summary writer；继续并入 diff action | 修正 action→task 绑定，不改 UI/IPC。 |
| Pending 错误缓存先冻结为 managed source 文件 | 错误数据可超过 Protocol 256 KiB，且 Main 内存不能被 Worker 直接访问 | 直接 postMessage 全量 errors；Worker 回调 Main | Worker 读 hash/count 绑定的私有 JSON，finally 清理。 |
| Pending 错误缓存使用版本化 authority，并异步流式写入 managed source | 对大错误数组做 `JSON.stringify/parse` 深拷贝或一次性同步落盘仍会阻塞 Main；仅检查“仍有错误”也不能证明是同一份快照 | 深拷贝整份 errors；只比较数组长度；同步 `writeFileSync` | Main 用 revision+对象身份在 source 写入前后及发布前 fail closed；逐条编码并异步写入，避免 Protocol 大载荷和一次性大字符串。 |
| Pending run 证据校验与 writer 读取共用同一 read transaction | 两阶段查询存在 stale window | Main 先查一次后直接信任 Worker；复制业务表到新 DB | 需给旧 writer 增加不改变默认行为的 transaction 内 hook。 |
| BizOP 继续复用 frozen locator + range copy 算法 | 现有实现已锁定 side/legacy 双源与跨月 id 重映射 | 重写 SQL 或传大结果数组 | Worker 只移动执行位置，不改业务 query/writer。 |
| Main 只冻结 run/dataset/revision 摘要，不扫描业务明细 | 初版证据会在 Main 同步读取并 hash 全量 Pending/BizOP 行，仍会阻塞 Electron；冻结合同只要求 run/dataset/revision/FilePlan | 在 Main hash 全量行；把全量行塞进 Protocol | Main 仅做点查并传固定大小 digest，Worker 在同一只读事务复核 revision 后读取业务行；v1 dataset head 失效时 fail closed。 |
| production=false，Main 保留 legacy 分支 | Windows/真实大样本/人工资金门禁未关闭 | 合并即切 production | capability 与 effective strategy 分离。 |
| 受审计合同包与 E13-G source-hash authority 在 Git checkout 中固定为 LF | Windows `core.autocrlf=true` 把冻结 `spec.md` 从预期 `13410e4e...` 转成 `9046fef7...`，并令 R3 checksum 与 9 个 source hash 失真；临时 fresh checkout 精确复现 | 在测试中忽略 CRLF；重算 Windows 专用 checksum；全仓禁用 `autocrlf` | 只固定已做 byte-level 审计的路径，不改变合同、业务代码或 production gate；fresh Windows checkout 与 canonical Git bytes 一致。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| xlsx 业务等价应按 workbook semantic snapshot，而非 ZIP byte hash | XLSX 容器元数据可能不稳定 | 误把等价文件判失败 | 同时核对 sheet/AOA/style/summary；技术 hash 仅绑定 staging。 |
| legacy Pending v0 run 可继续作为 stable run | 历史 schema 无 receipt，Spec 要求 dual-source/history compatibility | 老数据无法导出 | legacy-v0 golden；若发现其他稳定字段则反向同步 gate。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 初版 stable evidence 同步 hash 全量业务行 | 改为持久 run/dataset/revision digest；完整 SQL/Workbook 读取仅在 Worker read transaction 内发生 | 否则即使 Workbook 移入 Worker，Main 仍会按行阻塞，违背 E13-A 目标 | 不改变业务 SQL/排序/金额；来源漂移由 dataset head/run receipt 拒绝 | 不需要；与 Spec/TechDoc 已冻结流程一致。 |
| Pending error source 初版在 Main 对快照做深拷贝并一次性同步序列化 | 改为版本化 authority + task-private JSON 异步流式写入 | 深拷贝和同步大字符串会把大报错导出重新搬回 Main 阻塞路径 | legacy error workbook 不变；stale 快照在启动、写源前后、发布前均拒绝 | 不需要；是既定 managed-source 方案的非阻塞实现收紧。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 入口/Registry/Writer 静态 probe | `pending:export-summary` = aggregate；错误报告为内存缓存；BizOP locator 支持 side/legacy | 关闭三个会改变输入合同的未知。 |
| E13-A 定向测试 | `18/18 PASS` | Pending/BizOP workbook golden、空区间占位语义、side/legacy、runtime authority、取消、stale、artifact tamper、Publisher crash、metadata 时序、成功态 receipt ACK。 |
| Main freeze 紧凑证据回归 | SQL probe 证明不查询 Pending/BizOP 业务明细表；evidence `<512 bytes`；dataset head 漂移均 fail closed | 防止“Worker 化但 Main 仍扫描全表”的假迁移。 |
| 既有重点回归 | `181/181 PASS` | action/task registry、mature adapters、archive policy/lineage、BizOP run-data、Pending preflight、durable Publisher。 |
| 实施期本地 review 修复 | aggregate stable gate 曾未进入 writer transaction；抽取 error writer 曾漏掉 legacy archive 的 XLSX/水印依赖，均补回归并修复 | 防 stale window 与 legacy Pending 留底导出回归。 |
| 完整单测 | `6784/6787 PASS`，`0 FAIL`，`3 SKIP`，425 个测试文件 | 精确依赖环境下全仓单测无失败；日志 `logs/unit-tests/unit-20260830-194210.log`。 |
| E13-A 相关集成 | Pending data `33/33`、Pending migration `57/57`、BizOP side parity `16/16`、BizOP flow migration `73/73`，合计 `179/179 PASS` | 旧 SQL、侧库/主库双源、迁移与对账链回归。 |
| Smoke 与语法 | `npm run smoke` PASS；全部新增/修改 JS `node --check` PASS | 应用级关键路径及代码装载语法。 |
| Windows exact CI 换行 probe | `core.autocrlf=true` fresh checkout 将冻结 `spec.md` 精确变为失败日志中的 `9046fef7...`；新增路径级 `.gitattributes` 后必须在 fresh checkout 复验 canonical hashes | 证明失败来自 checkout 表示层而非合同内容漂移；禁止用平台专用 checksum 代偿。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| BizOP legacy-main 与 side DB worker parity | CLOSED | side day/range 与 legacy-main golden 已通过 | 无。 |
| 大错误报告、取消与 staging cleanup | CLOSED | 超 256 KiB managed source、tamper、cancel 测试已通过 | 无。 |
| legacy v0 来源没有 producer receipt/dataset v1 强身份 | ACCEPT（compatibility） | 只接受既有 application-owned legacy run；production 观察与人工抽查继续阻断启用 | 不阻止 dormant capability；不得据此关闭 production gate。 |
| Windows/真实文件/RSS/人工资金抽查 | BLOCK（production） | R3.2.5 release owner | 不阻止 dormant merge，阻止 production。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项不得记录为 PASS。
