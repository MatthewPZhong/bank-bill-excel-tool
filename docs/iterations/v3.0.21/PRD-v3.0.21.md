# bank-bill-excel-tool 3.0.21 PRD

> 目标版本：`3.0.21`
> 状态：review（PR #96）
> 源规格：[`changes/3.0.21/spec.md`](../../../changes/3.0.21/spec.md)
> 更新时间：2026-07-20
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

v3.0.21 修复两处资金性质判断边界：

1. Ach Return 退款回填只根据 R1 已选中的具体网关/银行配对做前置过滤，不再被同对账 ID 的无关网关 TradeType 静默阻断。
2. DBS-Charge 步骤2只接受固定 12 类网关 TradeType，并在金额币种判断前检查银行 `Credit Amount` 方向。

本迭代不修改 R1/R4、DBS 步骤1、IPC、数据库、前端或 Excel 契约。

## 1. 源文档索引

- [最终功能规格](../../../changes/3.0.21/spec.md)
- [测试规格](../../../changes/3.0.21/test-spec.md)
- [任务状态](../../../changes/3.0.21/tasks.md)
- [实施决策、偏差与验证证据](../../../changes/3.0.21/implementation-notes.md)

上述 Gradual Spec 是本 PRD 的单一实施事实来源；本文只做版本级索引和高层摘要，不重复维护详细矩阵。

## 2. 关键契约

- R5 只过滤 `pair.gwRow.TradeType` trim 后严格等于 `AchReturn` 的具体 `pair.bankRow` 对象，不按 reconciliationId 扩散。
- DBS 白名单来源为 `DBS-Charge网关TradeType白名单.xlsx` `Sheet1!A2:A13`；来源 SHA-256 和 12 个枚举值见最终 spec。
- DBS 方向守卫仅保证步骤2不新增 FundType 改写；步骤1先前产生的 sibling 归并和标黄继续保留。
- 只限制被修改的银行目标行 `Channel=DBS`；网关侧 MerchantId/Channel 不参与本轮判定，其他渠道或商户下同 ID 白名单候选仍可能参与步骤2。
- 空值和非法 `Credit Amount` 按既有 R4 口径视为 0，本轮不改变该兼容行为。

## 3. 验证与风险

- 最终本地门禁：unit `3716/3716 PASS`，integration `42` 个脚本 / `1955/1955 PASS`，lint 和 smoke 通过。
- 受控本地问题样本只读回放证明 `Inbound-VA` 不再阻断后续精准退款匹配；业务标识不进入仓库或分发文档。
- `check-vars` 只命中 `runRound5RefundOrderBackfill` 和 `STEP2_GW_TRADE_TYPE_WHITELIST` 两个 Risk-sensitive 变量，关联 smoke 与资金回归已执行。
- R4 同 ID 扩散、网关 MerchantId/Channel、候选 1:1 消费和全量过滤审计为明确非目标。
- 真实脱敏 DBS 白名单、金额币种、方向 warning 和改值去向的人工逐笔复核尚未完成。用户已在知悉后明确授权此次合并与发布；该项作为发布后 follow-up，不得宣称人工验收通过。

## 4. 发布归档

PR、merge commit、tag、Release workflow 和公开资产校验证据在完成后回写本节及 `docs/prs/PR96-v3.0.21.md`。
