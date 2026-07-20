# Test Spec — v3.0.21 Ach Return 与 DBS-Charge 校验修复

> status: review
> created: 2026-07-20
> updated: 2026-07-20

## 1. 测试目标

- 核心业务：R5 只过滤 R1 的具体 AchReturn pair；DBS 步骤2只读取固定白名单并先执行 Credit 方向守卫。
- 守恒：未配对的同 ID 银行行不被扩散排除；方向不符时步骤2不新增 modification；步骤1既有改写和 FundTransfer 保护保持不变。
- 可观测性：DBS 方向异常进入主错误报告并具有中文可能原因。
- 回归：R1/R4、退款 S1-S4、退款 fuzzy、DBS 步骤1、金额币种与 outbound→Charge 旧规则保持。

## 2. 测试分层

- 单元测试：R5 pair 过滤、DBS 白名单/方向矩阵、error cause、编排器参数接线和 warning 汇总。
- 集成测试：既有全渠道等价脚本使用白名单 DBS fixture；完整 release-check 覆盖全部模块。
- 真实样本回放：在本地受控环境只读解析银行账单、退款订单和当前网关库，运行 R1 + R5，确认目标退款单与命中类型；业务标识不写入仓库。
- 人工验收：真实脱敏 DBS 数据逐笔核对 TradeType、Credit、金额、币种、修改列和错误报告。

## 3. P0 必测场景

| 编号 | 场景 | 输入 | 预期 |
|---|---|---|---|
| P0-01 | R1 AchReturn 精确过滤 | pair.gwRow.TradeType=`AchReturn` | 只过滤 pair.bankRow，静默无退款输出 |
| P0-02 | Inbound-VA 不阻断 | pair TradeType=`Inbound-VA` | 银行行继续走退款 S1，精准命中 |
| P0-03 | 同 ID 不扩散 | 两条同 ID 银行行，R1 只配第一条 | 第一条被过滤，第二条仍可回填 |
| P0-04 | 问题最小回归 | 合成同构 ID + `Inbound-VA` + Ach Return 退款 | 输出对应退款单，命中类型“精准命中”；受控本地问题样本另行只读回放 |
| P0-05 | DBS 12 类白名单 | 每类各一条金额币种命中、Credit=0 | 全部可置 outbound 并记录 modification |
| P0-06 | 非白名单-only | `Inbound-VA` + 旧 outbound | 保持 outbound，无 modification/warning |
| P0-07 | 混合桶 | 非白名单金额命中、白名单金额不匹配 | 只看白名单；方向通过时 outbound 回落 Charge |
| P0-08 | 正负非零 Credit | 白名单同 ID，Credit>0 或 <0 | 保持进入步骤2前的 FundType，步骤2无新 modification，有方向 warning |
| P0-09 | 方向优先 | 白名单金额不匹配 + Credit 非0 + 旧 outbound | 保持 outbound，不得回落 Charge，有 warning |
| P0-10 | 主错误报告 | 编排器运行方向异常行 | errorReport 含新 code，统计 warningCount+1 |
| P0-11 | 步骤1与方向守卫组合 | sibling 先被步骤1归 Charge，随后 Credit 非0 | 保留步骤1 modification；步骤2不新增改写并产生 warning |

## 4. P1 应测场景

| 编号 | 场景 | 输入 | 预期 |
|---|---|---|---|
| P1-01 | TradeType trim/大小写 | `  AchReturn  `、`achreturn`、空值 | 仅 trim 后精确值过滤 |
| P1-02 | 缺少 r1Pairs | 未传、null、空数组、旧 gwRows | 不执行退款前置过滤 |
| P1-03 | 畸形 pair | null、缺 gwRow、缺 bankRow | 安全跳过，不抛错 |
| P1-04 | 白名单 trim/大小写 | `  PUBLIC_PAY  `、`public_pay` | 前者接受，后者拒绝 |
| P1-05 | Credit 零语义 | 0、`0.00`、空、null、非法文本 | 均按 0 继续金额币种判断 |
| P1-06 | 白名单金额/币种不匹配 | Credit=0、旧 outbound | 沿用旧逻辑回落 Charge |
| P1-07 | DBS 步骤1 | 调拨 in/out 方向与账号金额币种 | 方向不敏感旧行为、1:1与 FundTransfer 保护不变 |
| P1-08 | 银行目标行渠道门控 | 非 DBS 银行行同 ID | 不被 DBS 步骤1/2修改；不代表网关候选按 Channel 隔离 |
| P1-09 | error cause | 新 warning code | 返回固定中文原因而非未知错误 |

## 5. 不测项与原因

- 不测试 R4 同 reconid 扩散修复：本轮不改变 R4。
- 不测试网关 MerchantId/Channel 隔离或严格 1:1：本轮仍沿用既有 reconid+金额+币种步骤2口径；对应跨渠道/跨商户同 ID 风险保留并在用户文档披露。
- 不测试合法 AchReturn 过滤审计：本轮明确保持静默行为。
- 不构造数据库迁移/IPC/前端/Excel schema 测试：这些契约没有变化。

## 6. 执行顺序

1. 运行 R5、DBS、编排器、error-cause 定向单测。
2. 运行受控本地问题样本只读回放，确认对应退款单、命中类型及网关 TradeType；不将业务标识写入仓库或分发文档。
3. 运行 `npm run lint` 和相关集成脚本。
4. 运行 `npm run release-check`。
5. 运行 `npm run scan:vars` 与 `npm run check:vars -- --include-minor`。
6. 真实脱敏 DBS 与退款样本人工资金复核作为发布后跟进；用户已在知悉该项未完成后明确授权本次发布。
