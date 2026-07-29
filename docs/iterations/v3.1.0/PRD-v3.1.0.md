# PRD v3.1.0

> 状态：release-prepared（PR #102 已合入 `main`；`v3.1.0` 发布准备完成）

## 范围

v3.1.0 将“平盘对账数据处理”从前端占位升级为第一期可用功能，交付平盘资金性质校验、五类链接原始表管理、结果回导确认、差异审计和持久化 side DB。

## 规格索引

- [实施规格](../../../changes/3.1.0/spec.md)
- [测试规格](../../../changes/3.1.0/test-spec.md)
- [任务清单](../../../changes/3.1.0/tasks.md)
- [实施记录](../../../changes/3.1.0/implementation-notes.md)
- [技术设计](./TECH_DESIGN.md)

## 非目标

- 平盘交易对账单
- 平盘数据信息回填
- 平盘订单销账
- 业务归档

## 人工门禁

真实或脱敏资金数据必须逐笔复核十组 FundType、账户别名、币种、方向、日期、手续费、严格 1:1、结果回导和最终存档；自动测试不能替代人工签字。

## 发布状态

- PR #102 已于 2026-07-29 以 merge commit `40e822f` 合入 `main`。
- 合并后 `npm run release-check` 通过：unit `4011/4011`、integration `2016/2016`，lint 与 smoke 通过。
- 主页面几何校验 `6/6` 通过；启动性能五次中位数为进程总耗时 `766.383ms`、ready-to-show `175.031ms`。
- `scan:vars` 已刷新，`check:vars -- --include-minor` 无待复核 `src/` 改动。
- 生产依赖审计保留既有 9 条告警（0 critical、7 high、2 moderate）。
- 当前阶段尚未创建 `v3.1.0` tag 或 GitHub Release。
