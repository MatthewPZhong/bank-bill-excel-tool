# v3.1.7 Implementation Notes

## Baseline

- 需求基线：`changes/3.1.7/spec.md`。
- 代码基线：`main`，package version `3.1.6`。
- 工作分支：`codex/v3.1.7-payment-r5s2`。

## Decisions

- Payment 与 R5s2-recon 使用同一数组对象作为运行工作副本；“是否被使用”按物理派生行维护，不按 ReconID 或调拨单号做逻辑去重。
- “是否被使用”仅为运行态，数据库 `raw_json` 中只保存初始化空值，避免异常中断或重跑继承旧消费状态。
- 开启 Payment 时强制派生表来源，关闭时保留旧路径 parity。
- 同周多订单号日期取最早值；订单周断档在任何 Payment/R5 写值前阻断。
- 用户已取消最终 ReconciliationId 重复检测与异常说明；现有多对多审计保持不变。
- 新一轮银行对账运行开始即清空上一轮 `processingResult`；预检或引擎失败后不允许导出旧结果。

## Assumptions

- 固定样本使用空账户映射；生产环境继续沿用派生 `big_account` 的既有映射结果。
- Payment 的付款账户条件只作用于 Payment；R5s2-recon 不比较 `Drawee CardNo`。
- 并发运行由现有运行入口互斥；每次调用仍使用隔离工作副本，不产生跨运行共享状态。

## Deviations

- 暂无。

## Evidence

- 两份固定样本通过生产 reader、流式中台 reader、派生 builder、编排器和 writer 完整回放：银行 1,831 行，中台订单 223 行，派生 446 行。
- Payment 匹配 220，其中 R1=218、R2=0、R3=2；实际改写 190。后跑 R5s2-recon 实际改写 2；命中 192、未命中 1,639，满足银行行数守恒。
- 220 条 Payment 配对的派生“付款账号”与银行 `Drawee CardNo` 全部相等；匹配月份覆盖 2025-10 至 2026-07，不是只覆盖 2026-05/06。
- 生产 Writer 输出五个固定 sheet，Payment 三个核对 sheet 各 220 条；公式错误扫描为 0，重新渲染确认关键表头及核对值可见。
- 旧模拟文件 `Payment线下调拨回填匹配_模拟结果_20260611.xlsx` 的 87 条配对中，按原始“付款账户（卡号）”核验仅 48 条与 `Drawee CardNo` 相等、39 条不等，因此不得作为 v3.1.7 基线。
- 自审发现并修复“已有成功结果后，新一轮 Payment 预检失败仍可能导出旧结果”的状态生命周期缺口；静态契约测试钉死清理时点早于场景读取和预检。
- 最终 `npm run release-check` 通过：`4575/4575` 单测、`44/44` 集成脚本、`2051/2051` 集成断言全部通过；lint 与 smoke 同步通过。
- `npm run scan:vars` 已刷新 v3.1.7 统计。`check-vars` 命中 `processingResult`、`app`、`state`：前者为本次受测的旧结果失效修复；后两者分别来自注释 diff 和 ExcelJS `sheet.views.state='frozen'`，不是 Electron app 生命周期或 renderer 全局 state 变更。
- 桌面交付文件由当前生产链路重跑生成，SHA-256 为 `a3ce595288f0533af7dddbb335d6b046330f1add39e9e0bdc6dec0413f9378ea`，五个 sheet 及关键行数断言全部通过。
- UI 预览确认 Payment 开启时来源勾选项自动选中并锁定；工作簿渲染确认付款账号、`Drawee CardNo` 和“是否被使用”可见，公式错误扫描为 0。
- 最终通用盲区与资金盲区复核未发现剩余 P3 及以上 Finding；仍保留下面的人工资金门禁。

## Remaining Unknowns

- `BLOCK（业务）`：自动测试不能替代资金人工门禁；上线前须人工复核固定样本中的 220 条 Payment 配对与 2 条 R5 后续回填。
