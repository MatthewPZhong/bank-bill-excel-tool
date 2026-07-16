# bank-bill-excel-tool 3.0.16 PRD

> 目标版本：`3.0.16`
> 状态：merged（PR #89 已合入 `main`；真实脱敏样本人工复核仍是发布门禁）
> 归档：PR #89 merge commit `e09a18c`；源规格 `changes/3.0.16/spec.md`
> 更新时间：2026-07-16
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

3.0.16 只包含以下三项变更：

1. `前置资金对账` 的银行匹配金额改为“银行方向金额 + 有符号 Extra Fee”。
2. `前置资金对账` 增加 FundType、借贷方向与网关 tradeType 的 14 类固定资格规则；满足资格后，仍按“对账 ID + 渠道 + 金额 + 币种”严格 1:1 消费。
3. 临时 MPT 网关账单导入出现可定位的明细行错误时，失败页提供 `导出错误数据` 与 `删除错误数据并重跑`。

本版明确不实现 `MPT_CHANNEL_OTHERS`、临时银行对账单或 `缺渠道账单`，也不修改现有 `缺网关账单` 场景枚举。

## 1. Extra Fee 对账金额

### 1.1 银行行方向

- `Credit Amount` 非零且 `Debit Amount` 为零：方向为 `Credit`，方向金额为 `abs(Credit Amount)`。
- `Debit Amount` 非零且 `Credit Amount` 为零：方向为 `Debit`，方向金额为 `abs(Debit Amount)`。
- 两侧均非零：沿用现有强校验，整份银行文件导入失败。
- 两侧均为零：沿用现有口径跳过；`Extra Fee` 不得把零发生额行提升为参与行。

### 1.2 金额公式

```text
银行匹配金额 = 银行方向金额 + signed_decimal(Extra Fee)
银行匹配金额 = 网关 amount 才满足金额条件
```

- `Extra Fee` 为空或空白时按 `0`。
- `Extra Fee` 保留正负号；例如方向金额 `3300254.4`、Extra Fee `-254.4`，银行匹配金额为 `3300000`。
- 全程使用十进制字符串运算，不使用 JavaScript 浮点数；`1 / 1.0 / 1.00` 等价。
- `Extra Fee` 非空但不是合法十进制数时，银行文件导入失败并报告文件名、Excel 行号和字段。
- 银行匹配金额允许为零或负数，但只会与同值网关 amount 匹配；不得取绝对值或静默改成零。
- `渠道账单` sheet 的 `receiveAmount` 仍输出原方向金额，`extraFee` 仍单独输出原银行字段；对账金额只用于匹配和审计。

## 2. 固定对账资格规则

### 2.1 比较规则

- 下表来源为用户附件 `资金对账规则.xlsx` 的 `资金对账规则!A1:F15`。
- 规则固化在代码中，不在运行时读取用户桌面附件，也不新增可编辑配置入口。
- `FundType` 与网关 `tradeType` 均去首尾空格后大小写敏感精确比较。
- 一条银行行可命中多条规则；其允许的网关 tradeType 取所有同 FundType、同方向规则的并集。
- `ExternalTransfer-out`、`ExternalTransfer-in` 的网关 tradeType 列为空，表示没有可自动匹配的网关类型，不是空字符串匹配，也不是通配符。
- FundType 未配置、方向与规则不符、或不存在允许的网关 tradeType 时，该银行行仍计入参与行并进入不平结果，不得跳过或阻断整次运行。

### 2.2 规则表

| 对账名称 | 网关 tradeType | 银行 FundType | 方向 |
|---|---|---|---|
| payout | Withdraw, LYRepay, LYPayment, MPT_WITHDRAW, MPT_SUPPLIER, MPT_VAT, MPT_FLOW_MORE, MPT_AMAZON_ADS, MPT_TRANSPARENCY, MPT_MARKET_PLACE, LY_WITHDRAW, ACQ_WITHDRAW, B2B_WITHDRAW, B2B_SUPPLIER, B2B_MARKET_PLACE, B2B_VAT, B2B_FLOW_GOLD, B2B_FLOW_GOLD_SUPPLIER, FX_WITHDRAW, HX_WITHDRAW, FIG_WITHDRAW, CUR_REMITTANCE, CUR_WITHDRAW, CUR_PAY, LY_PAY, CUR_DEBIT, FlowMore_Withdraw, OUTBOUND_OFF, FX_PAY | Not mark yet, Mark without result, outbound, Ach Debit, Outbound&FX, outbound&Ach Return, outbound&Test | Debit |
| Inbound | B2B_CREDIT, Inbound-VA, Inbound-Recharge, RECEIVE_OFF | Inbound, Inbound&FX, INBOUND&GPAY, INBOUND&FIUU, INBOUND&FIUUOnline, INBOUND&VNXendit, INBOUND&Eft, INBOUND&THKbank | Credit |
| Return | Reversal, AchReturn | Ach Return, Reversal, AchReturn&FX, Reversal&FX, outbound&Ach Return | Debit |
| channel-settle-out | chargeback, flowMore_refund_acq, b2b_refund_acq, detailfund_refund, OutboundDetailFund | Acquiring Settle withdrawal-Flowmore, Channel-settle-out | Debit |
| channel-settle-in | Purchase, chargeback_reversal, FxPurchasing, DetailFund, outbound_detailfund_refund | Acquiring Settle-Flowmore, Lejiapay Settle-MPT, QBC Settle, Lejiapay Settle-CURRENTS, Channel-settle-in | Credit |
| Fund-Outbound | PPI_PURCHASE | Fund-Outbound | Debit |
| Fund-Inbound | PPI_REDEMPTION | Fund-Inbound | Credit |
| Fundtransfer-out | FundTransfer-out | FundTransfer-out, Fundtransfer-out&FX, Fundtransfer-out&FX-split | Debit |
| Fundtransfer-in | FundTransfer-in | FundTransfer-in, Fundtransfer-in&FX, Fundtransfer-in&FX-split | Credit |
| WireReturn | WireReturn, REFUND_OFF | Wire Return, WireReturn&FX | Credit |
| HX-OUTBOUND | HX_OUTBOUND | HX-out | Debit |
| HX-INBOUND | HX_INBOUND | HX-in | Credit |
| External_Transfer-out | 无 | ExternalTransfer-out | Debit |
| External_Transfer-in | 无 | ExternalTransfer-in | Credit |

### 2.3 1:1 消费条件

一条未消费网关候选必须同时满足以下条件才可与当前银行行平账：

```text
trim(bank.ReconciliationId) = trim(gateway.reconciliationId)
AND trim(bank.Channel) = trim(gateway.channel)
AND decimal(bank.directionAmount + bank.ExtraFee) = decimal(gateway.amount)
AND trim(bank.Currency) = trim(gateway.currency)
AND trim(gateway.tradeType) 属于该 bank.FundType + bank.direction 的允许集合
```

继续沿用临时网关优先、来源内稳定顺序、每个候选最多消费一次、完全重复候选折叠审计和双方行数守恒。规则不匹配不得消费候选。

### 2.4 可观测性

- 不平结果 `备注` 写入不平原因：规则未配置、方向不符、规则无网关类型，或未找到同时满足全部条件的网关候选。
- 运行汇总增加规则未配置、方向不符、无网关类型三类计数。
- 平账结果固定表头不变；银行侧不新增列，避免破坏既有模板与 C4 读取兼容。

## 3. 临时链接表错误数据处理

### 3.1 可删除错误范围

只有已通过文件名和首行身份校验、且能定位到具体明细物理行的以下错误允许删除重跑：

- 明细字段数错误；
- 明细批次号或账单日期不一致；
- 明细金额、日期时间或币种金额对非法。

文件名、文件类型、首行、gzip、UTF-8、单行安全上限、声明行数、文件身份冲突、旧序号和读写失败属于结构/身份错误，不能通过删除明细修复；失败页仅显示关闭按钮。

### 3.2 失败会话

- 正常导入必须扫描完整文件并统计全部可删除明细错误；只保存轻量失败令牌、文件路径、原始内容 hash、错误数和少量错误摘要，不在主库或内存中保存全量原始行。
- 严格导入发现任一明细错误时整文件事务回滚；被替换的旧批次必须完整保留。
- 新一轮文件选择会使上一轮失败令牌失效；应用重启后失败令牌失效。
- 后续导出或重跑必须重新读取原文件并校验内容 hash；文件被修改、替换或删除时拒绝操作。
- 多文件导入沿用逐文件成功/失败；两个按钮只处理本轮全部“可删除”的失败文件，不回滚已成功文件。

### 3.3 导出错误数据

- 点击 `导出错误数据` 打开 `.xlsx` 另存为对话框。
- 输出按来源类型建立 `INBOUND错误数据`、`OUTBOUND错误数据` sheet；只创建有错误数据的 sheet。
- 每行包含源文件、来源类型、原始行号、错误代码、错误原因、错误字段、原始 33 字段及原始行内容；超长原始行按每片最多 30000 个 UTF-16 字符分片，不切断代理对。
- 任一错误 sheet 连同表头不得超过 Excel 的 1,048,576 行；超限时整次导出失败并保留已有目标文件，不生成不可打开或被截断的工作簿。
- 使用临时文件写完后原子发布；失败或取消不得留下半成品。
- 导出不改变临时表库，也不自动执行重跑。

### 3.4 删除错误数据并重跑

- “删除”是逻辑删除：不修改、不覆盖、不另存用户原始 MPT 文件。
- 重新流式读取同一文件，确定性跳过全部可删除错误行，把其余合法行作为一个原子批次导入。
- 批次保存原声明行数、有效行数、排除行数、修复导入标记；每条排除记录保存源文件、原始行号、错误代码、错误原因、错误字段和原始行内容，供审计。
- 同批次替换在一个事务中完成；重跑失败时回滚，旧批次仍完整可用。
- 成功提示必须展示导入有效行数和逻辑删除错误行数，并刷新链接表管理列表。

## 4. 接口与兼容

- preload 新增错误报告导出和失败重跑接口，参数只接受主进程签发的失败令牌，不接受 renderer 传入任意文件路径。
- `importMpt` 的逐文件失败结果增加 `repairToken / canRepair / rowErrorCount`；既有成功结果字段保持不变。
- 临时网关批次 side DB 增加修复摘要列和排除行审计表；打开旧侧库时幂等补列/建表。
- 既有 MPT 严格导入、批次幂等、日期范围删除、重复审计、导出模板和 C4 兼容行为保持不变。

## 5. 明确不做

- 不支持 `MPT_CHANNEL_OTHERS`；错误提示改为“当前版本不支持”，不再承诺具体后续版本。
- 不新增 `缺渠道账单`，不新增临时银行表库。
- 不把规则做成用户可编辑配置，不在运行时读取桌面附件。
- 不自动删除结构错误、不修改原始 MPT 文件。

## 6. 资金红线

- Extra Fee 正负号、方向金额、规则配对或 1:1 消费任一错误都可能造成错平账。
- 自动测试不能替代人工复核；发布前必须用真实脱敏样本逐笔核对至少一个正手续费、一个负手续费、一个同 FundType 多规则候选、一个规则不匹配和一个错误行逻辑删除批次。

## 7. 实施与归档

- 2026-07-16：本地 `release-check` 全绿，unit 3585/3585、integration 1877/1877，GitHub Actions `smoke-test` 通过。
- 2026-07-16：PR #89 在 P0-P4 Finding 为 0 后，以 merge commit `e09a18c` 合入 `main`，远程开发分支删除。
- 真实脱敏样本业务复核仍为发布门禁；本次合并不创建 tag 或 GitHub Release。
