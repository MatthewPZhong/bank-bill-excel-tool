# bank-bill-excel-tool 3.0.23 PRD

> 目标版本：`3.0.23`
> 状态：merged（PR #98 已合入 `main`；GitHub Release 待发布）
> 归档：PR #98 merge commit `0171b2b`；源规格 `changes/3.0.23/spec.md`
> 更新时间：2026-07-21
> 适用仓库：`bank-bill-excel-tool`

## 0. 迭代目标

v3.0.23 仅在 C3 候选预筛层放宽网关 Channel 的英文大小写，并把 Ach Return、Wire Return、HX-out、HX-in 收紧为账号、币种、对账 ID、金额和方向完整一致后的严格 1:1 匹配。

R4 已确认的 Ach Return 银行行，包括 FundType 原值已正确的同值匹配，不再重复进入 R5 退款回填。

## 1. 源文档索引

- [最终功能规格](../../../changes/3.0.23/spec.md)
- [测试规格](../../../changes/3.0.23/test-spec.md)
- [任务状态](../../../changes/3.0.23/tasks.md)
- [实施决策、偏差与验证证据](../../../changes/3.0.23/implementation-notes.md)

上述 Gradual Spec 是本 PRD 的详细事实来源；本文只保留版本级契约、验证和发布证据。

## 2. C3 候选池契约

- 一次数据库读取生成大小写敏感的 `exactRows` 与 trim 后英文大小写不敏感的 `c3Rows`，两个池共享解析后的行对象。
- 银行 `Channel=Maybank` 时，C3 可读取网关 `Maybank/MAYBANK/maybank` 和首尾空格变体，但不读取 `MAYBANK2`。
- 只有 C3 使用放宽池；R1、DBS-Charge、R4、R5 等资金流程继续使用原大小写敏感池。
- C3 内部显式配置的 Channel 条件和对账字段仍按既有规则区分大小写。

## 3. R4 严格资金契约

- 四类场景只接受各自固定 TradeType，并同时精确匹配 ReconID、MerchantId、Currency。
- 金额按十进制字符串计算 `abs(主金额) + signed Extra Fee`，不使用 JavaScript 浮点数、不按分舍入；相反方向金额必须为空或为 0。
- 四类共享银行行消费集合，每条网关与银行行最多参与一次成功关系；冲突按网关链接表原序、银行 Excel 原序稳定处理。
- 同值匹配仍消费并记录关系，但不产生字段修改、不标黄；失败与冲突进入现有主错误报告。

## 4. R4 到 R5 血缘

- R4 返回每个实际消费的具体 `matchedPairs`，同时记录场景、目标 FundType 和是否真实改值。
- R5 仅按对象身份排除其中 `ach-return` 的具体银行行，不按 ReconID、`_rowId` 或内容相同的克隆对象扩散。
- R1 既有 AchReturn 配对过滤和 `isFundTypeChanged` 过滤保留；Wire Return、HX-out、HX-in 关系不触发 Ach Return 前置排除。

## 5. 验证与风险

- R4/R5/编排器定向测试 `205/205 PASS`；双候选池及 R4→R5 完整链路 `23/23 PASS`。
- `npm run release-check` 通过：unit `3791/3791`、integration `1963/1963`，lint 与 smoke 全绿。
- `scan:vars` 为 201 个 JS 文件、2323 个顶层声明；重要变量命中项均已完成关联功能 review。
- GitHub PR #98 Windows workflow 通过；最终 self-review 为 P0-P4 Finding 0。
- 真实 Ach Return、Wire Return、HX 及重复 ReconID 冲突样本尚待资金负责人逐笔复核。自动测试和发布授权均不等于人工资金验收通过。

## 6. 发布归档

- PR #98 于 2026-07-21 以 merge commit `0171b2b` 合入 `main`，远程与本地开发分支删除。
- PR 归档见 `docs/prs/PR98-v3.0.23.md`；tag、Release workflow 和公开资产证据待发布完成后补录。
- 合并后的最终 `main` 将重新执行发布门禁、变量扫描与重要变量复核后，才允许创建 `v3.0.23` tag。
