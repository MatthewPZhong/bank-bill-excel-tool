# Spec — v3.0.23 C3 渠道预筛与 R4 资金性质校验收紧

> status: merged（PR #98 已合入 `main`；v3.0.23 Release 待发布；human-fund-review-pending）
> owner: PM / Dev
> created: 2026-07-21
> updated: 2026-07-21
> implementation branch: `codex/v3.0.23-c3-channel-prefilter`

## 0. 任务摘要

- Goal：仅放宽 C3 的网关 Channel 预筛大小写，同时将 Ach Return、Wire Return、HX-out、HX-in 收紧为账号、金额、币种、ReconID 严格 1:1 匹配。
- Context：当前所有轮次共享大小写敏感网关池；R4 只读取 R1 按 ReconID 预配对后的网关行，并会把同 ReconID 的全部银行行逐条改写。
- Constraints：C3 场景内部条件不变；R1/R3.5/R4/R5 继续使用原大小写敏感网关池；DBS-Charge、IPC、数据库 schema 和 Excel 契约不变。
- Done when：AC-01～AC-27 通过，自动门禁全绿，真实 Ach Return/Wire Return 完成人工逐笔复核；HX 无真实样本时必须明确保留人工验收缺口。原 AC-01～AC-20 已完成自动验证，本增补继续关闭 R4 同值匹配无法传递给 R5 的血缘缺口。

## 1. 已确认事实与决定

| 项目 | 决定 | 证据/原因 |
|---|---|---|
| C3 Channel 预筛 | 银行和网关 Channel 均 trim 后忽略英文字母大小写 | 用户确认仅调整 C3 第 2 层预筛，不改变场景条件 |
| 其他轮次网关池 | 保持现有大小写敏感精确读取 | 防止 C3 放宽行为泄漏到资金规则 |
| R4 网关来源 | 使用本次运行完整大小写敏感网关池，不再使用 R1 `matchedGwRows` | R1 只按 ReconID 提前消费，可能选中非目标 TradeType 或错误账号候选 |
| R4 冲突顺序 | 网关链接表原始 `id ASC` 优先；银行候选按 Excel 原序优先 | 用户确认“网关原序优先” |
| 相反方向金额 | 空值按 0；合法非 0 或非法文本阻断并告警 | 用户确认“空按0，非法阻断” |
| 金额计算 | 十进制字符串精确计算，不用浮点数、不按分舍入 | 金额与手续费属于资金红线 |

## 2. C3 Channel 预筛契约

### 2.1 双候选池

- 主进程按银行账单出现的 Channel 一次读取网关链接表，并生成：
  - `exactRows`：逐字保留当前大小写敏感、空/缺 Channel、损坏 JSON 跳过和 `id ASC` 顺序语义。
  - `c3Rows`：银行与网关 Channel 均 trim 后，按 SQLite `NOCASE` 做英文大小写不敏感精确匹配。
- 银行 `Channel=Maybank` 时，`c3Rows` 包含网关 `Maybank`、`MAYBANK`、`maybank` 及只有首尾空格差异的值，不包含 `MAYBANK2`。
- 两个数组复用同一批解析后的行对象；不得重复查询数据库或为相同行深拷两份对象。

### 2.2 轮次隔离

- `runReconciliation` 接受可选 `c3GwRows`；R2 dispatcher 仅将它用于 C3 `gateway-recon-join` 场景。
- C1/C2 不消费网关行；R1、R3.5、R4、R5 和多对多审计继续使用 `exactRows`。
- 未提供 `c3GwRows` 的旧调用回退到 `gwRows`，保持现有直接调用兼容性。
- C3 内部场景条件、对账字段、候选 1:1 消费和赋值规则全部不变；若场景显式把 Channel 配为条件或对账字段，仍按现有大小写敏感规则比较。

## 3. R4 四类严格匹配契约

### 3.1 固定场景规则

| subCategory | 网关 TradeType | 银行主金额 | 相反方向金额 | 目标 FundType |
|---|---|---|---|---|
| `ach-return` | `AchReturn` | `abs(Debit Amount)` | `Credit Amount` | `Ach Return` |
| `wire-return` | `WireReturn` | `abs(Credit Amount)` | `Debit Amount` | `Wire Return` |
| `hx-out` | `HX_OUTBOUND` | `abs(Debit Amount)` | `Credit Amount` | `HX-out` |
| `hx-in` | `HX_INBOUND` | `abs(Credit Amount)` | `Debit Amount` | `HX-in` |

- 规则由四个固定 `subCategory` 决定；场景是否启用仍由现有场景配置控制，DBS-Charge 不进入本引擎。
- 网关行只在 TradeType trim 后严格等于对应固定值时参与；大小写不同不接受。
- 银行原 FundType 不作为候选条件。

### 3.2 完整匹配条件

同一候选必须同时满足：

```text
trim(bank.ReconciliationId) = trim(gateway.reconciliationid)
AND trim(bank.MerchantId) = trim(gateway.merchantid)
AND trim(bank.Currency) = trim(gateway.currency)
AND canonical(abs(银行主金额) + signed Extra Fee) = canonical(gateway.amount)
AND 相反方向金额为空或规范值为 0
```

- 文本比较均区分大小写；ReconID、MerchantId、Currency、TradeType 不能为空。
- 银行主金额与网关 amount 必须非空且为合法十进制数；主金额绝对值为 0 时不得匹配。
- `Extra Fee` 为空按 0，非空必须是合法带符号十进制数；正负值均按原符号相加。
- 相反方向金额为空按 0；合法非 0 或非法文本均阻断该候选。
- 支持普通十进制、合法千分位和科学计数法；比较规范值，不使用 JavaScript 浮点数。

### 3.3 严格 1:1 消费与告警

- R4 按 `exactRows` 原始顺序遍历网关；同 ReconID 银行桶保持银行 Excel 原序。
- 四类场景共享银行消费集合：每条网关行最多消费一条银行行，每条银行行最多被一条 R4 网关行消费。
- 一个网关行存在多个完整、未消费候选时，取银行原序第一条并输出一条 `r4-fund-multi-candidate`。
- 同 ReconID 有银行行但没有完整、未消费候选时保持原 FundType，并输出 `r4-fund-match-mismatch`；若候选存在非法或非零相反方向金额，同时输出去重后的 `r4-fund-direction-mismatch`。
- 完全没有同 ReconID 银行桶时静默跳过。
- 匹配成功但 FundType 已等于目标值时仍消费该银行行，不产生 modification、不标黄。
- `modifications` 仍只记录实际改变的 `FundType`；错误继续汇总到现有主错误报告。

### 3.4 R4 → R5 同值匹配血缘

- R4 返回结构新增 `matchedPairs`，记录每个已经完成严格匹配并实际消费的具体 `{ gwRow, bankRow }` 关系。
- `matchedPairs` 同时记录 `subCategory`、`targetFundType` 和 `changed`；即使银行原 FundType 已等于目标值、R4 未产生 modification，也必须保留该匹配关系并标记 `changed=false`。
- R4 不得为了向下游传递关系而伪造 modification；同值 no-op 继续不标黄、不计字段修改。
- 编排器把本轮完整 `r4MatchedPairs` 传给 R5 退款引擎；R5 只将 `subCategory='ach-return'` 的具体 `pair.bankRow` 加入前置排除集合。
- R5 继续保留现有 `isFundTypeChanged` 和 R1 AchReturn pair 两道过滤；新增 R4 关系只补充 no-op 缺口，不重写既有过滤口径。
- 排除按本次运行中的银行行对象身份执行，不得按 `_rowId`、ReconID 或其它字段扩散；同 ReconID 的其它银行行仍可进入退款池。
- R4 的 Wire Return、HX-out、HX-in 匹配不得进入 Ach Return 排除集合；畸形、缺失或旧调用未传 `r4MatchedPairs` 时按空集合兼容。

## 4. 数据流与内部接口

- 数据库 facade 新增 `readGatewayBillRowPoolsByChannels(channels)`，返回 `{ exactRows, c3Rows }`；旧 `readGatewayBillRowsByChannels` 保持兼容。
- `runReconciliation` 新增可选 `c3GwRows`；无 IPC/preload/public API 变化。
- `runRound4FundNatureCheck` 第一个参数语义改为本次运行完整 `exactRows`；返回结构增加 `matchedPairs`，现有 `modifications/warnings` 字段保持兼容。
- `runRound5RefundOrderBackfill` 的 options 增加可选 `r4MatchedPairs`；无 IPC/preload/public API 变化。
- 更新四个内置场景的固定规则说明；现有数据库只幂等刷新四个内置场景的 `function` 文案，不改表结构和其它配置字段。
- 新增 R4 告警中文“可能原因”映射，不在错误信息中暴露完整账号。

## 5. 非目标

- 不把 C3 场景内部 Channel 条件改成大小写不敏感，不做子串或模糊匹配。
- 不放宽 R1/R3.5/R4/R5 的 Channel 预筛。
- 不修改 R1 1:1 预配对、R1 退款过滤、DBS-Charge 或其它 FundType 引擎。
- 不新增 Channel、日期、状态条件，不修改 Excel sheet、表头或输出去向。
- 不新增数据库表、依赖、设置项或用户配置。
- 本迭代不包含 PR、合并、tag 或 GitHub Release。

## 6. 验收标准

- AC-01：银行 `Maybank` 的 C3 候选池包含 `Maybank/MAYBANK/maybank` 和首尾空格变体，不包含 `MAYBANK2`。
- AC-02：`exactRows` 对同一输入保持旧大小写敏感结果、空/缺 Channel 结果和顺序。
- AC-03：一次 SQL 查询同时产出两个池，相同行对象引用共享。
- AC-04：只有 C3 读取 `c3Rows`；R1、R3.5、R4、R5 仍读取 `exactRows`。
- AC-05：C3 显式 Channel 条件仍区分大小写；旧调用未传 `c3GwRows` 时行为不变。
- AC-06：四个 R4 场景只接受各自固定 TradeType 和目标 FundType。
- AC-07：ReconID、MerchantId、Currency 均 trim 后大小写敏感、非空且完全相等。
- AC-08：主金额绝对值加 signed Extra Fee 与网关 amount 规范值完全相等时才匹配。
- AC-09：主金额为 0、空或非法，Extra Fee/网关 amount 非空非法时均不匹配并可观测。
- AC-10：相反方向为空或合法 0 放行；合法非 0 或非法文本阻断并输出方向告警。
- AC-11：同 ReconID 只有一条完整候选时只修改该行，不扩散到其它银行行。
- AC-12：多个完整银行候选取原序第一条、产生多候选告警，其它候选保持未消费。
- AC-13：多个网关争用同一银行行时网关原序优先；后续网关不能复用并产生不匹配告警。
- AC-14：两个网关有两条完整银行候选时可分别消费，跨四场景也不重复消费。
- AC-15：同值 no-op 仍消费，但不产生 modification 或标黄。
- AC-16：无同 ReconID 银行桶静默；有桶但完整条件失败进入主错误报告。
- AC-17：R4 使用完整 `exactRows`，不再被 R1 提前选择的错误候选阻断。
- AC-18：R1 退款过滤继续使用具体 `r1.pairs`，DBS-Charge 行为不变。
- AC-19：C3 大小写放宽的额外行不得泄漏到 R4。
- AC-20：行数守恒、实际修改字段与标黄字段保持一致。
- AC-21：R4 每个成功消费关系都进入 `matchedPairs`，实际改值为 `changed=true`，同值 no-op 为 `changed=false`。
- AC-22：R4 no-op 关系不生成 modification、不标黄，但仍阻止同一银行行被后续 R4 网关复用。
- AC-23：银行原值为 `Ach Return`、R1 配到同 ReconID 的非 AchReturn 网关、R4 严格配到另一条 AchReturn 网关时，该银行行不得进入 R5 退款池。
- AC-24：R4 账号、币种、金额、方向或 TradeType 不完整时不产生 `matchedPairs`，不得误排除退款银行行。
- AC-25：同 ReconID 多银行行只排除 R4 实际配到的具体对象；其它同 ID 银行行继续按现有退款规则处理。
- AC-26：R4 Wire Return、HX-out、HX-in 关系不得触发 Ach Return 退款过滤；R1 AchReturn 与既有 `isFundTypeChanged` 行为不回归。
- AC-27：旧调用未传或传入畸形 `r4MatchedPairs` 时安全回退为空集合，退款引擎原有返回和 Excel 契约不变。

## 7. Unknowns Register 与资金红线

| 未知/风险 | 分类 | 当前处理 |
|---|---|---|
| HX_OUTBOUND/HX_INBOUND 缺少真实样本 | PROBE | 合成矩阵覆盖；保留人工验收缺口，不宣称业务验收完成 |
| 真实 Extra Fee 正负方向组合 | PROBE | 自动测试固定语义；真实 Ach/Wire 逐笔核对 |
| 多候选告警量是否过大 | ASSUME | 每个网关行、每个 code 去重，避免逐候选爆量 |
| C3 SQLite NOCASE 对非 ASCII 的行为 | 已知边界 | Channel 只承诺英文大小写不敏感，非 ASCII 逐字匹配 |
| R4 同值匹配与 R1 退款过滤血缘不同 | 已确认缺口 / 本增补关闭 | R4 返回包含 no-op 的具体 `matchedPairs`，R5 精确排除其中 AchReturn 配对银行行；真实重复 ReconID 样本仍须人工复核 |

⚠️ 资金红线：R4 改变 FundType 认定主键、金额、手续费、方向和重复消费语义。自动测试不能替代真实 Ach Return、Wire Return、HX-out、HX-in 的人工逐笔复核。

## 8. 合并与发布记录

- 2026-07-21：R4/R5/编排器定向单测 `205/205 PASS`；完整链路回放 `23/23 PASS`。
- 2026-07-21：`npm run release-check` 通过，lint、smoke、unit `3791/3791`、42 个 integration 脚本 `1963/1963` 全绿。
- 2026-07-21：`scan:vars` 扫描 201 个 JS 文件、2323 个顶层声明；`check-vars` 按设计命中 2 个 Critical 与 4 个 Risk-sensitive，关联资金回归已完成。
- 2026-07-21：最终 self-review 为 P0-P4 Finding 0；PR #98 的 Windows workflow 通过。
- 2026-07-21：PR #98 以 merge commit `0171b2b` 合入 `main`，远程与本地开发分支均已删除。
- 归档见 `docs/prs/PR98-v3.0.23.md` 与 `docs/iterations/v3.0.23/PRD-v3.0.23.md`。
- `v3.0.23` tag、Release workflow 和公开在线升级资产证据待发布完成后补录。
- 真实 Ach Return、Wire Return、HX 及重复 ReconID 冲突样本仍须资金负责人逐笔复核；发布授权不等于人工资金验收通过。
