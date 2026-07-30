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

## Assumptions

| 假设 | 依据 | 验证/回滚 |
| --- | --- | --- |
| 3.1.2 未改变平盘导入业务契约 | 当前 diff 和版本历史 | PR-A 从当前 main 重建 characterization |

## Deviations

暂无。

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

## Remaining Unknowns

| 未知 | 分类 | 下一步 |
| --- | --- | --- |
| 真实样本 cell form parity | PROBE | PR-B 流式扫描 |
| 300 万行资源指标 | PROBE | PR-E benchmark |
| Windows 实机导入和取消 | PROBE | PR-E 手测 |
| 真实资金逐笔正确性 | BLOCK（发布前） | 业务负责人复核 |
