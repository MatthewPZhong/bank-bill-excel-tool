# v3.1.7 Test Spec

## Unit

- 调拨 builder：新增 `付款方式`、`是否被使用=''`，in/out 行字段和行数守恒不变。
- Payment：派生行筛选、付款账号与 `Drawee CardNo`、空 ReconID、三轮匹配、消费标记和回填前快照。
- 日期：单周前一整周、多连续周动态区间、同周多日期取最早、左右边界、跨年、断档阻断。
- R5s2-recon：跳过已使用派生行、排除 Payment 银行行、同值仍消费、in/out 独立。
- 编排器：Payment 强制派生来源且先于 R5；Payment 关闭路径 parity。
- Writer：三个核对 sheet 名称、派生表头、银行原始快照、命中/未命中结构不变。

## Integration And Sample

- 固定样本输出：命中 192、未命中 1,639、Payment 三个核对 sheet 各 220。
- 运行失败：订单周断档时无 Payment/R5 modification、无可导出 processing result。
- 旧结果失效：新一轮运行开始即清空上一轮 processing result，任何预检失败都不能继续导出旧结果。
- 运行态重置：连续两次运行结果一致，数据库派生表“是否被使用”保持空值。

## Release Gates

- 聚焦 unit/integration。
- `npm run release-check`。
- `npm run scan:vars`、`npm run check:vars`。
- 固定样本人工资金复核。
