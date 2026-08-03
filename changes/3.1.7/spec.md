# v3.1.7 Spec - Payment 与 R5s2-recon 调拨回填调整

> status: `release-prepared`
> target-version: `3.1.7`
> updated: `2026-08-03`
> nature: ReconciliationId 资金回填红线，正式业务启用和公告前必须人工复核。

## 1. 目标

- Payment 与 R5s2-recon 共用同一份调拨对账单运行工作副本。
- 开启 Payment 时固定先运行 Payment、再运行 R5s2-recon，并强制使用中台调拨派生表。
- 通过派生行“是否被使用”和跨引擎银行消费集，保证一条物理派生行及一条银行行在一次运行中最多被匹配一次。
- Payment 新增付款账户核对和按订单周边界切分银行候选的日期规则。
- 不新增 ReconciliationId 重复检测、重复说明或“未命中场景”输出列。

## 2. 调拨派生契约

- 调拨对账单在现有字段上新增：
  - `付款方式`：取中台调拨单同名字段。
  - `是否被使用`：字符串，派生及每次运行初始化为 `''`，命中后为 `'1'`。
- 新字段只写入隐藏表 `raw_json`，不新增 SQLite 热列；运行态的 `'1'` 不写回数据库。
- Payment 只消费 `FundTransfer-in` 派生行；同订单的 `FundTransfer-out` 行保持独立。
- `ReconID` 为空的派生行不得匹配或占用银行行，并输出可见 warning。

## 3. 执行顺序与消费

1. 开启 Payment 时，运行前重建并读取一份调拨对账单工作副本，统一清空“是否被使用”。
2. 对 Payment 候选订单执行字段和订单周连续性预检；失败时在两个引擎写值前阻断本次运行。
3. Payment 先匹配；命中后将派生行“是否被使用”置为 `'1'`，并返回已消费银行 `_rowId`。
4. R5s2-recon 后匹配；排除 Payment 已消费银行行，并跳过“是否被使用=1”的派生行。
5. 同值命中虽然不产生 modification 或标黄，仍同时消费派生行和银行行。

开启 Payment 时，`reconSourceMid` 的有效值固定为 `true`；UI 自动勾选并锁定该来源。关闭 Payment 后解除锁定并保留当前勾选值。历史冲突配置在运行态按派生表执行并显示状态提示。

## 4. Payment 匹配规则

- 派生池：`付款成功`（builder 已过滤）、`付款方式=线下`、`fund_type=FundTransfer-in`、收款渠道匹配配置、`big_account` 属于配置大账号、`ReconID` 非空。
- 银行池：保持 MerchantId、地区、FundType、Credit Amount、币种规则。
- 新增必选核对要素：`派生行.付款账号 = 银行行.Drawee CardNo`，两侧均须非空；本条件不扩散到 R5s2-recon。
- 金额继续按派生 `金额` 与银行 `Credit Amount` 精确到分比较，不引入 Extra Fee。

### 4.1 订单周日期区间

- 从调拨单号解析 FTA 日期并按 ISO 8601 计算订单周。
- 同一订单周存在多个订单号日期时，以最早日期作为该周边界。
- 最早订单周的候选银行日期为其前一完整 ISO 周，区间左闭右开。
- 后续订单周的候选银行日期为 `[前一订单周最早订单号日期, 本订单周最早订单号日期)`。
- 订单周必须按 ISO 周逐周连续；发现缺失周或候选订单存在非法 FTA 日期时整批阻断，不跨空档扩大窗口。

### 4.2 三轮匹配

- R1 `main`：订单周日期区间 + 核对要素相等 + `BillDate >= 交易时间`。
- R2 `date-tolerance`：同一日期区间和核对要素 + `BillDate >= 交易时间 - 2天`。
- R3 `relaxed-week`：不限周，在全部未消费订单中按相同核对要素及 `|BillDate - 交易时间| <= 7天` 兜底。
- 银行行按 BillDate、原始行序消费；订单候选按绝对日期差、派生原序稳定选择。

## 5. 输出

- 不执行最终 ReconciliationId 重复分组，不添加“ReconciliationId重复”说明。
- “未命中场景”维持现有结构，原银行字段继续从 B 列开始。
- “命中场景”保留现有“异常说明”列和多对多审计逻辑。
- Payment 核对 sheet 固定为“匹配对照”“银行行-原始”“调拨对账单行-原始”。
- “银行行-原始”使用回填前快照；“调拨对账单行-原始”输出实际派生字段及运行态“是否被使用”。

## 6. 固定样本验收

输入：

- `CITILU202510-202607调拨渠道账单_2026-08-03_680437.xlsx`
- `Fund_transfer_apply_1785725872740.xlsx`

目标文件：`/Users/pzhong/Desktop/3.1.7_Payment-R5s2固定样本回归结果.xlsx`

固定配置：`bankChannel=CITI`、`region=LU`、`bigAccount=202782001`、空账户映射、R5 日期容差 1 天。

预期：银行 1,831 行；Payment 匹配 220（R1=218、R2=0、R3=2），实际改写 190；R5s2-recon 后续实际改写 2；命中场景 192 行、未命中场景 1,639 行；三个 Payment 核对 sheet 各 220 条配对记录。

## 7. 兼容与门禁

- Payment 关闭时保留现有 R5 数据源开关和匹配行为。
- 现有多对多人工审计逻辑不变。
- 必须覆盖共享消费、同值消费、in/out 独立、未命中降级、跨年 ISO 周、同周多日期、周断档原子阻断和运行态重置。
- 收尾执行相关单测、集成、smoke、`release-check`、`check-vars`、文档三件套和版本号 `3.1.7` 更新。
- 资金人工复核固定样本中的 220 条 Payment 配对及 2 条 R5 后续回填。

## 8. 发布转换（2026-08-03）

- PR #121 已以 merge commit `6fe118b8c4d665e1ce877fb792e6a4bbcda64cdf` 合入 `main`；合并后 Windows Build run `30794912210` 全部成功。
- 干净 `npm ci` 后完整 `release-check` 再次通过：unit 4,575/4,575、integration 44 个脚本 2,051/2,051、lint 与 smoke 全绿；主页面两种尺寸、三档缩放 6/6 PASS。
- 两份固定样本由生产 reader、派生 builder、编排器和 writer 重跑，Payment 220、R5 后续改写 2、命中 192、未命中 1,639，且 220 条付款账号全部等于 `Drawee CardNo`。
- 用户在明确知悉资金人工门禁尚未完成后，要求继续完成正式收尾和发布收尾。因此可生成受控技术 Release，但不得把自动化证据记作业务人工验收；正式业务启用和公告仍受 220 条 Payment 配对及 2 条 R5 回填逐笔复核约束。
- Release 成功前，CHANGELOG、版本功能清单和使用手册保持 Unreleased/未发布；只有公开资产和 updater 元数据独立核对后才能回写正式发布日期。
