# Test Spec — v3.0.16 前置资金对账规则与错误行重跑

> status: implementation merged via PR #89; human fund review gate pending
> created: 2026-07-15

## 1. 测试目标

- 证明 Extra Fee 使用有符号十进制加法且不改变原始输出字段语义。
- 证明 14 类规则严格约束 FundType、方向和 tradeType，之后才执行原四字段 1:1 消费。
- 证明严格导入失败、错误导出和逻辑删除重跑均有界、原子、可审计且不修改原文件。
- 保护旧批次替换、INBOUND/OUTBOUND 隔离、重复折叠和输出行数守恒。

## 2. P0 必测场景

| 场景 | 输入 | 预期 |
|---|---|---|
| 正手续费 | Credit=9999980、Extra Fee=20、网关 amount=10000000 | 平账 |
| 负手续费 | Debit=3300254.4、Extra Fee=-254.4、网关 amount=3300000 | 平账 |
| 空手续费 | Extra Fee 为空 | 等价 0，旧匹配结果不变 |
| 非法手续费 | Extra Fee=`abc` | 银行导入失败并定位行号 |
| 浮点禁用 | 大整数、高精度小数、科学计数法 | 字符串运算结果精确 |
| 规则命中 | 每条规则至少一个 bank FundType + direction + gateway tradeType | 仅合法组合平账 |
| 同 FundType 多规则 | `outbound&Ach Return` 对 payout 与 Return 类型 | 两类合法 tradeType 均可匹配 |
| 方向不符 | FundType 正确但 Credit/Debit 方向相反 | 不消费网关，银行进入不平并写原因 |
| 类型不符 | 四字段相同但 gateway tradeType 不允许 | 不消费网关，银行进入不平 |
| 未配置 FundType | 四字段相同但 FundType 不在规则表 | 不消费网关，银行进入不平 |
| ExternalTransfer | 两个 ExternalTransfer FundType | 不自动匹配且原因可见 |
| 严格导入原子性 | 文件含多条合法行和多条行错误 | 全文件回滚，旧批次不变，返回全部错误数 |
| 错误导出 | 同时有 INBOUND/OUTBOUND 行错误 | 对应两个 sheet，字段、行号、原因和原始数据完整 |
| 文件篡改 | 失败后修改、替换或删除源文件 | 导出与重跑均拒绝 |
| 逻辑删除重跑 | 同一失败令牌 | 原文件 hash 不变；合法行入库、错误行入审计表 |
| 替换回滚 | 重推批次逻辑删除重跑中途失败 | 旧批次完整保留 |
| 多文件部分成功 | 一成功、一可修、一结构失败 | 成功文件保留；按钮只处理可修文件 |

## 3. P1 应测场景

| 场景 | 预期 |
|---|---|
| `1/1.0/1.00` | 金额等价 |
| Extra Fee 恰好抵消/超过方向金额 | 保留 0/负数，不取绝对值 |
| 大小写与空格 | 首尾空格忽略，大小写差异不命中 |
| 网关多候选 | 按临时优先和稳定顺序只消费一条 |
| 重复网关记录 | 折叠统计和 `重复网关账单` 审计不变 |
| 声明行数错误 | 结构失败，不提供删除重跑 |
| gzip/UTF-8/首行错误 | 结构失败，不提供删除重跑 |
| 失败令牌生命周期 | 新导入和应用重启后旧令牌失效 |
| 超长错误原始行 | 30000 字符安全分片并可无损重组 |
| 错误 sheet 行数超限 | 整次拒绝发布，已有目标文件保持原样 |
| 审计删除 | 按日期删除修复批次时排除行审计同步级联删除 |

## 4. 测试分层

- 单元：十进制加法、银行行派生、规则索引、side DB 消费 SQL、MPT 错误收集、错误报告分片和 renderer 三按钮行为。
- 集成：临时 MPT 严格失败 -> 错误导出 -> 逻辑删除重跑 -> 前置资金对账 -> Excel 回读。
- 回归：现有 pre-fund、duplicate inbound、C4 读取、临时表按来源删除及完整 `release-check`。
- 人工：真实脱敏样本逐笔核对手续费、规则类型、未匹配原因和逻辑删除审计。⚠️ 资金红线。

## 5. 执行命令

```bash
npm run test:unit
npm run test:integration
npm run smoke
npm run scan:vars
npm run check:vars -- --include-minor
npm run release-check
npm run preview
npm run startup:measure
```
