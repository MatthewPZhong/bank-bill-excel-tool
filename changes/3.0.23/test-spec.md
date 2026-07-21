# Test Spec — v3.0.23 C3 渠道预筛与 R4 资金性质校验收紧

> status: automatic-verification-passed / human-fund-review-pending
> created: 2026-07-21
> updated: 2026-07-21

## 1. 测试目标

- C3：证明大小写不敏感仅发生在候选加载层，且一次查询生成新旧两个隔离池。
- R4：证明四类场景按固定四要素、方向金额和 Extra Fee 严格 1:1 匹配。
- 守恒：银行行最多被一个 R4 网关消费；no-op 消费不标黄；失败和多候选可观测。
- 回归：R1 退款过滤、DBS-Charge、R5 既有匹配规则、C3 内部精确条件及其它轮次网关池不变。

## 2. C3 必测矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| C3-01 | 银行 `Maybank`；网关 `Maybank/MAYBANK/maybank/ Maybank /MAYBANK2` | 前四条进入 `c3Rows`，`MAYBANK2` 不进入 |
| C3-02 | 同一数据读取 `exactRows` | 仅旧大小写敏感精确值进入；行为与旧接口一致 |
| C3-03 | 空、null、缺 Channel、重复银行 Channel | 两个池按各自契约返回，顺序稳定、无重复对象 |
| C3-04 | 网关 raw_json 损坏 | 跳过坏行，不中断查询 |
| C3-05 | 相同行同时进入两个池 | `exactRows[i] === c3Rows[j]`，证明不深拷 |
| C3-06 | 编排器传独立 `c3GwRows` | C3 可命中大小写不同候选；R1/R4 不能命中该候选 |
| C3-07 | C3 场景显式配置 Channel 条件 | 内部条件仍大小写敏感，不因预筛放宽而命中 |
| C3-08 | 未传 `c3GwRows` | R2 回退使用 `gwRows`，旧直接调用兼容 |
| C3-09 | main handler 接线 | 只调用双池 facade 一次并分别注入 `gwRows/c3GwRows` |

## 3. R4 必测矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| R4-01 | 四种固定 TradeType、正确账号/币种/ReconID/金额/方向 | 分别写入目标 FundType |
| R4-02 | TradeType、账号、币种、ReconID 大小写或值不同 | 不匹配，有同 ID 桶时输出 mismatch |
| R4-03 | 文本字段仅首尾空格不同 | trim 后可匹配 |
| R4-04 | 主金额为负数 | 取绝对值参与计算 |
| R4-05 | Extra Fee 正数、负数、空 | 按带符号金额相加；空按 0 |
| R4-06 | `1/1.0/1e0`、千分位、高精度 | 规范值等价；不按分舍入 |
| R4-07 | 主金额空/非法/0，Extra Fee 或网关 amount 非法 | 不匹配、产生 mismatch，不抛出整轮异常 |
| R4-08 | 相反方向空、`0`、`0.00` | 放行 |
| R4-09 | 相反方向正/负非 0 或非法文本 | 不改写，输出 direction warning |
| R4-10 | 同 ID 多银行行仅一条完整 | 只改完整行，其它不变 |
| R4-11 | 同 ID 多条完整候选 | 取银行原序第一条并输出 multi-candidate |
| R4-12 | 两个网关争用同一银行行 | 网关原序第一条消费，第二条 mismatch |
| R4-13 | 两个网关对应两条银行行 | 各消费一条，跨四场景不复用 |
| R4-14 | 目标 FundType 已相同 | no-op 仍消费，无 modification/标黄 |
| R4-15 | 无同 ReconID 银行桶 | 静默无 warning |
| R4-16 | R1 先选错误网关、后续网关完整匹配 | R4 从完整 exactRows 找到正确候选 |
| R4-17 | C3-only 大小写 Channel 候选 | 不进入 R4 |
| R4-18 | 警告中文原因 | 三个 code 均映射固定中文原因，不是未知错误 |

## 4. 回归与集成

- 编排器：R1 → R2 → R3.5 → R4 → R5 顺序不变，R1 `pairs` 仍传入退款引擎。
- DBS：步骤1、白名单、方向守卫和 outbound/Charge 行为不变。
- C3：候选 1:1 消费、赋值源为空、同值 no-op 和显式字段条件不变。
- 输出：修改行/未命中行守恒，只有实际修改的 FundType 标黄，R4 warning 汇总进主错误报告。
- 性能：双池只执行一次 SQL 查询和一次 JSON.parse；大表路径不全表读取、不重复深拷。

## 5. R4 → R5 同值血缘增补

| 编号 | 场景 | 预期 |
|---|---|---|
| L-01 | R4 实际把 FundType 改为 Ach Return | `matchedPairs.changed=true`，保留既有 modification，R5 继续排除 |
| L-02 | 银行原 FundType 已是 Ach Return，R4 严格匹配 no-op | `matchedPairs.changed=false`，无 modification/标黄，R5 仍精确排除 |
| L-03 | R1 先配到同 ReconID 的 Inbound-VA，R4 后配到另一条合法 AchReturn | 银行行不进入退款回填或退款未匹配输出 |
| L-04 | R4 同 ReconID 但账号/币种/金额/方向不符 | 不产生 matchedPair，该银行行按现有 R5 规则继续处理 |
| L-05 | 同 ReconID 两条银行行，R4 只严格命中其中一条 | 只排除 pair.bankRow；另一条不得被 ReconID 扩散过滤 |
| L-06 | `pair.bankRow` 是内容相同的克隆对象 | 不得过滤当前实际银行行，继续锁定对象身份边界 |
| L-07 | R4 匹配 Wire Return/HX-out/HX-in | 不进入 Ach Return 前置排除集合 |
| L-08 | R1 与 R4 同时指向同一银行行 | 合并效果仍只排除一次，不产生重复输出或异常 |
| L-09 | `r4MatchedPairs` 缺失、非数组或含畸形项 | 安全跳过，保持旧调用行为 |
| L-10 | 两个 R4 网关争用同一银行行 | `matchedPairs` 只记录实际消费赢家，后续 mismatch 不得被下游误认成匹配 |

## 6. 执行顺序

1. 仓储双池、R4 引擎、error cause 和编排器定向单测。
2. main handler seam、迁移描述刷新及全渠道集成回归。
3. `npm run test:unit`、`npm run test:integration`、`npm run smoke`。
4. `npm run release-check`。
5. `npm run scan:vars` 与 `npm run check:vars -- --include-minor`。
6. 真实 Ach Return/Wire Return 逐笔复核；HX 有真实样本后补验。

## 7. 人工复核要求

- 逐笔核对银行/网关 ReconID、MerchantId、Currency、主金额、Extra Fee、网关 amount、借贷方向和最终 FundType。
- 逐笔核对多候选选择顺序、未命中告警和 no-op 不标黄。
- HX 无真实样本时只能记录“自动测试通过”，不得写“业务验收通过”。
- 使用真实重复 ReconID 样本确认：R1 选中非 AchReturn、R4 选中另一条 AchReturn 且银行原值已为 Ach Return 时，只排除 R4 实际配对银行行，不影响同 ID 其它银行行。

## 8. 自动验证结果

- R4、R5、编排器定向单测：`205/205 PASS`。
- `gateway-channel-filter-equivalence.js` 完整链路回放：`23/23 PASS`。
- `npm run release-check`：lint、smoke、`3791/3791` 单测及 42 个集成脚本 `1963/1963` 断言全部通过。
- `npm run scan:vars`：201 个 JS 文件、2323 个顶层声明。
- `npm run check:vars -- --include-minor`：按设计命中 2 个 Critical、4 个 Risk-sensitive，退出码 2；关联功能 review 已同步到重要变量清单。
