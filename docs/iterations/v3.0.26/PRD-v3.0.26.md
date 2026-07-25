# bank-bill-excel-tool 3.0.26 PRD

> 目标版本：`3.0.26`
> 状态：released（PR #101 已合入 `main`；GitHub Release `v3.0.26` 已发布）
> 归档：PR #101 merge commit `fa416aa`；源规格 `changes/3.0.26/spec.md`
> 更新时间：2026-07-25
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

v3.0.26 调整两处前端文案，在前置资金对账“不平结果”中增加银行原始 `FundType` 血缘，并将 R5 中台调拨订单对账 ID 回填的两种来源及调拨多对多审计统一到含有符号 `Extra Fee` 的银行金额口径。

## 1. 源文档索引

- [最终功能规格](../../../changes/3.0.26/spec.md)
- [测试规格](../../../changes/3.0.26/test-spec.md)
- [任务状态](../../../changes/3.0.26/tasks.md)
- [实施决策、偏差与验证证据](../../../changes/3.0.26/implementation-notes.md)

上述 Gradual Spec 是本 PRD 的详细事实来源；本文只保留版本级行为和验收边界。

## 2. 用户可见变化

- 平盘对账数据处理模块的“对账表管理”改为“对账数据管理”。按钮仍为白色次按钮，只显示后续版本开放提示。
- 资金对账数据处理的链接表删除弹框标题固定为“删除数据”。目标表下拉、日期范围、计数门控、实际删除目标和成功提示保持原行为。
- 前置资金对账“不平结果”在“交易类型”之后插入第 6 列 `FundType`，直接输出对应银行原始值；空值保持空。

## 3. Excel 与 C4 契约

- “不平结果”由 20 列扩为 21 列；其余前置资金 sheet、5/6-sheet 动态结构和重复审计不变。
- `assets/资金对账导出不平.xlsx` 同步增加 `FundType` 列并保留既有样式、列宽和固定 sheet 顺序。
- C4 严格兼容三类输入：旧 19 列“对账结果”、v3.0.14-v3.0.25 的 20 列“不平结果”、v3.0.26 的 21 列“不平结果”。
- C4 只投影既有 19 列修复数据，忽略来源列和 `FundType`；错列、错序或未知额外列继续拒绝。

## 4. R5 金额与告警契约

- 默认调拨对账单来源和取消勾选后的网关来源均使用：

```text
abs(Credit Amount - Debit Amount) + signed Extra Fee
```

- `Extra Fee` 为空按 0，正数增加、负数冲减；先加总，再沿用现有精确到分比较，合计后不再次取绝对值。
- 非空非法手续费使对应银行行退出 R5 回填和调拨多对多审计，并以稳定错误码、银行行血缘及原始值进入主错误报告；其它合法行继续运行。
- 多对多审计复用同一金额助手，不另写一套金额解析。
- 旧 `bankAmountAbs` 继续供 DBS-Charge 使用；DBS-Charge 不因本迭代开始计算手续费。
- 日期优先、账号、币种、方向池、稳定原序、严格 1:1、同值消费和 `usedBankRowIds` 均不变。

## 5. 范围与人工门禁

- 不新增数据库、迁移、IPC 或场景配置，不实现平盘业务后端。
- Payment 线下调拨、退款回填、R4 和前置资金对账匹配口径不变。
- 自动验证覆盖模板回读、三代 C4、两种 R5 来源、正负/空/非法手续费、多对多和 DBS 回归。
- ⚠️ 真实或脱敏样本仍须逐笔核对正负手续费、两种来源、回填 ReconciliationId、1:1 去向、多对多异常、新导出列和 DBS 不变性；自动测试不能替代资金验收。

## 6. 合并与发布归档

- PR #101 于 2026-07-25 以 merge commit `fa416aa` 合入 `main`；PR 归档见 `docs/prs/PR101-v3.0.26.md`。
- 合并后的 `main` 已在干净 `npm ci` 依赖上重新通过完整 release-check：unit `3855/3855`、43 个 integration 脚本 `1978/1978`，lint 与 smoke 全绿。
- 主页面六组合布局为 `6/6 PASS`；启动建窗到可见平均 `102.107ms`，ready-to-show 平均 `173.357ms`。
- 变量扫描为 202 个 JS 文件、2329 个顶层声明；重要变量硬节点因 `src` 无新改动安全跳过。
- 生产依赖审计为 2 moderate、7 high、0 critical；v3.0.26 与 v3.0.25 的依赖图一致，安全升级留作独立 follow-up。
- GitHub 仓库仍为 PUBLIC；annotated tag `v3.0.26` 指向 `f229c2c2837965d0d14335db5a6625f0196f2089`。
- Windows Release workflow run [`30156308464`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30156308464) 用时 17m21s，完整门禁、构建、包检查、发布和发布后验证全部通过。
- GitHub Release [`v3.0.26`](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.26) 已成为 latest、非 draft、非 prerelease，包含 Setup、Setup blockmap、portable 和 `latest.yml`。
- 资产大小分别为 Setup `99,766,838`、portable `99,270,063`、blockmap `105,452`、`latest.yml` `371` 字节。
- `latest.yml` 的版本、Setup 路径、大小和 SHA-512 契约有效；匿名 Range 回读确认 Setup/portable 均为 HTTP 206 且文件头为 `MZ`。
- Windows Excel/WPS 模板显示、真实资金样本和 `v3.0.25 → v3.0.26` 生产在线升级 canary 均是公告前人工门禁。
- GitHub 发布环境、`main` 与 tag 仍缺服务端保护；`check:dist` 仍缺 asar 内版本断言，均列为后续发布治理项。
