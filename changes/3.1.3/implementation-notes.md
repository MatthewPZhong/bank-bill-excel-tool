# v3.1.3 Implementation Notes

## Baseline

- 需求与契约：[spec.md](./spec.md)
- 基线：`main@db43294` / `3.1.2`
- 分支：`codex/v3.1.3-position-large-import`

## Decisions

| 决定 | 原因 | 影响 |
| --- | --- | --- |
| 目标版本定为 `3.1.3` | 用户明确指定 | PR-E 才执行版本 bump |
| 按 PR-A → PR-E 分阶段实施 | Spec 强制，避免资金链 mega PR | 每阶段独立门禁，生产 gate 逐步开启 |
| 最终附件纳入 `changes/3.1.3/spec.md` | 附件状态为 ready-for-implementation，且比旧草案完整 | 不覆盖原未跟踪草案 |
| 同业务主键不同内容全部保留，完全相同记录折叠 | 真实五文件证明业务单号并非记录级唯一；用户于 2026-07-30 明确确认 | `business_key` 降为业务字段，`row_hash` 成为内部 `sourceRecordKey`；链接与消费关系同步迁移 |

## Assumptions

| 假设 | 依据 | 验证/回滚 |
| --- | --- | --- |
| 3.1.2 未改变平盘导入业务契约 | 当前 diff 和版本历史 | PR-A 从当前 main 重建 characterization |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 |
| --- | --- | --- | --- |
| 同业务主键不同内容整文件拒绝，跨文件同业务主键后序拒绝 | 同 `row_hash` 完全重复折叠，同业务主键不同内容全部保留 | 真实文件 2-5 均含合法的同业务单号多内容记录，且用户明确取消拒绝规则 | PR-B ledger、PR-C1 侧库 schema、后续 writer/消费血缘及验收用例全部改用 `sourceRecordKey` |

## Evidence

| 日期 | 证据 | 结果 |
| --- | --- | --- |
| 2026-07-30 | 旧 reader/derivation 定向测试 | 10/10 PASS |
| 2026-07-30 | PR-A parity characterization | 17 项：文件级 `-0` 明确规范为 `0`；其余 shared/inline/formula/rich/date/ID 类型已锁定 |
| 2026-07-30 | PR-A fault characterization | 8/8 PASS |
| 2026-07-30 | `npm run release-check` | lint、smoke、4386/4386 单测、44 个集成脚本 2051/2051 断言全部通过 |
| 2026-07-30 | `scan:vars` / `check:vars -- --include-minor` | 242 个 `src` 文件扫描完成；PR-A 未改 `src`，无关联变量命中 |
| 2026-07-30 | 真实五文件路径检查 | 5 文件齐全，共 1,339,185 行（按 Spec 记录） |
| 2026-07-30 | 正式侧库隔离副本检查 | `quick_check=ok`；590 links / 590 sources；0 个 source-leg 重复组 |
| 2026-07-30 | 真实第 2-5 份出账文件流式预检 | 均发现同业务单号不同内容；第 4 份 `PD260113144304369391944` 的两行分别为 `Yeepay_CN` 与 `Yeepay` |
| 2026-07-30 | 抽取真实冲突行回放旧 reader | 旧契约返回 `position-source-key-conflict`；用户明确批准改变该业务口径 |
| 2026-07-30 | 新口径回放真实五文件 | 5/5 `ok`；300,000 + 300,000 + 300,000 + 300,000 + 139,185 = 1,339,185 条候选，完全重复折叠 0 条 |
| 2026-07-30 | 真实五文件 PR-B 资源证据 | 332.5 秒；main RSS 峰值 60,162,048 B，worker RSS 峰值 368,689,152 B，ledger 380,256,256 B，run-data 峰值 769,547,229 B |
| 2026-07-30 | 严格 OOXML SST 复用后的真实五文件复验 | 5/5 `ok`，1,339,185 条候选、0 条完全重复；355.8 秒；main RSS 峰值 60,293,120 B，worker RSS 峰值 561,119,232 B，worker heap 峰值 76,296,960 B，ledger 380,256,256 B，run-data 峰值 769,600,477 B |
| 2026-07-30 | PR-B 定向回归 | 预检 16/16、parity 32/32、fault 23/23、scanner/OOXML 结构 106/106；lint PASS |
| 2026-07-30 | PR-B `npm run release-check` | smoke PASS；unit 4,402/4,402；44 个 integration 脚本 2,051/2,051 |
| 2026-07-30 | PR-B `scan:vars` / `check:vars -- --include-minor` | 251 个 `src` 文件；`state` 为 `sheet.state` 同名误报；`POSITION_BANK_HEADERS` 只读复用既有 49 列契约，未改表头 |

## Remaining Unknowns

| 未知 | 分类 | 下一步 |
| --- | --- | --- |
| 300 万行资源指标 | PROBE | PR-E benchmark |
| Windows 实机导入和取消 | PROBE | PR-E 手测 |
| 真实资金逐笔正确性 | BLOCK（发布前） | 业务负责人复核 |
