# Spec — v3.0.21 Ach Return 与 DBS-Charge 校验修复

> status: released（PR #96 已合入 `main`；GitHub Release `v3.0.21` 已发布）
> owner: PM / Dev
> created: 2026-07-20
> updated: 2026-07-20
> implementation branch: `codex/v3.0.21-ach-return-dbs-charge`

## 0. 任务摘要

- Goal：修复无关网关 TradeType 静默阻断 Ach Return 退款回填，以及 DBS-Charge 步骤2在网关类型和银行方向条件不完整时误改 FundType 的问题。
- Context：R1 已返回具体网关/银行配对，但 R5 重新把全量网关对账 ID 建集合；DBS-Charge 步骤2目前只校验 reconid、金额和币种。
- Constraints：不改变 R1/R4、DBS 步骤1、IPC、数据库和 Excel 契约；按附件固定 12 类 TradeType；保留用户已确认的空/非法 Credit 按 0 口径。
- Done when：AC-01～AC-13 通过，合成回归与受控本地问题样本均恢复精准命中，版本与三份版本文档为 3.0.21，资金负责人待办及用户发布授权被明确记录。

## 1. 代码事实与样本证据

| 事实 | 出处 | 约束 |
|---|---|---|
| R1 返回 `pairs: [{gwRow, bankRow}]`，重复银行候选按原序取第一条并 warning | `src/main-process/scenario-engines/r1-recon-id-match.js` | R5 复用配对，不重做 reconid 整桶判断 |
| R5 旧实现从 `options.gwRows` 的全部 `reconciliationid` 建 Set，命中即静默移出银行行 | `src/main-process/scenario-engines/r5-refund-order-backfill.js` | 替换为具体对象配对过滤 |
| 编排器在 R5 前已持有 `r1.pairs` | `src/main-process/reconciliation-orchestrator.js` | 只增加内部参数透传 |
| DBS 步骤2旧实现索引全部网关行，只比较 reconid、amount、currency | `src/main-process/scenario-engines/dbs-charge-fund-check.js` | 增加固定 TradeType 白名单和银行方向守卫 |
| R4 出账方向口径是 `(parseNumber(Credit Amount) || 0) === 0` | `src/main-process/scenario-engines/r4-fund-nature-check.js` | DBS 沿用相同空值/非法文本语义 |
| 受控本地问题样本中，银行行与退款单满足 DBS/USD、Debit 11000、SUBMITTED、账号/币种/金额和 CustomerRef 条件 | 本地只读回放，业务标识不入库 | 应继续进入退款精准匹配 |
| 对应只读网关记录唯一且 `TradeType=Inbound-VA` | 本地只读 `tool-data.sqlite / linked_gateway_bill` | 不得再触发 AchReturn 前置过滤 |
| 12 类白名单来自 `DBS-Charge网关TradeType白名单.xlsx` 的 `Sheet1!A2:A13` | SHA-256 `78fbffcd9d2dcca8755124fc92b6aa2c58fc53bd60f945668203d685225160f0`，2026-07-20 逐项回读 | 代码、spec 和枚举测试必须与该来源一致 |

## 2. 功能契约

### 2.1 Ach Return 退款前置过滤

- 编排器把 R1 的 `pairs` 作为 `r1Pairs` 传给 `runRound5RefundOrderBackfill`。
- 退款引擎仅将满足以下条件的具体 `pair.bankRow` 对象加入排除集：
  - `pair`、`pair.bankRow` 存在。
  - `pair.gwRow.TradeType` 经 `normalizeCellValue` 去首尾空格后严格等于 `AchReturn`。
- 排除集按银行行对象引用判断；不得按 reconid 扩散到同 ID 的其它银行行。
- `r1Pairs` 缺失、非数组、空数组或 pair 不完整时，不执行前置过滤。
- 旧 `options.gwRows` 不再具有退款前置过滤语义。
- R1 的大小写、取第一条、多候选 warning 和 1:1 单向消费规则保持不变；R4 不修改。

### 2.2 DBS-Charge 步骤2网关白名单

- 只允许以下 TradeType 进入步骤2网关 reconid 索引：
  - `AchReturn`
  - `ACQ_WITHDRAW`
  - `B2B_FLOW_GOLD`
  - `B2B_FLOW_GOLD_SUPPLIER`
  - `B2B_SUPPLIER`
  - `B2B_WITHDRAW`
  - `CUR_PAY`
  - `FX_WITHDRAW`
  - `HX_WITHDRAW`
  - `MPT_SUPPLIER`
  - `MPT_WITHDRAW`
  - `PUBLIC_PAY`
- TradeType 只去首尾空格，仍区分大小写；空值和其它值不进入索引。
- 某 reconid 只有非白名单网关行时，整个银行桶跳过，原 Charge/outbound 保持不变且不告警。
- 同 reconid 同时有白名单和非白名单网关行时，只使用白名单候选。
- 白名单为代码内固定业务常量，不增加运行时 Excel 读取、设置项、数据库表或迁移。

### 2.3 DBS-Charge 步骤2银行方向守卫

- 仅处理既有范围：银行 `Channel=DBS`、FundType 为 `Charge` 或 `outbound`、reconid 非空且存在白名单网关候选。
- 对每条候选银行行，先执行 `(parseNumber(Credit Amount) || 0) === 0`：
  - Credit 为 0、`0.00`、空值、null 或非法文本：方向通过，继续金额/币种判断。
  - Credit 为正数或负数非零：保持进入步骤2前的 FundType，步骤2不新增 modification，写 `dbs-charge-fund-direction-mismatch` warning 后停止该行步骤2。
- DBS 步骤1保持不变；如果该行此前已被步骤1 sibling 归并改成 `Charge`，该改值和 modification 继续保留，步骤2只是不再二次改写。
- 方向守卫必须先于金额/币种判断；因此方向不符的旧 `outbound` 不得因金额不匹配回落为 `Charge`。
- 方向通过后沿用现有行为：金额和币种命中则置 `outbound`；未命中时旧 `outbound` 回落 `Charge`，旧 `Charge` no-op。
- warning 经现有 `errorReport` 汇总并由 `error-causes.js` 输出中文“可能原因”。

## 3. 非目标

- 不处理 R4 同 reconid 多银行行扩散。
- 不增加 DBS MerchantId 或网关 Channel 校验；因此其它网关渠道/商户下同 reconid 的白名单候选仍可能参与 DBS 步骤2，这是本轮明确保留的残余风险。
- 不实现步骤2网关候选严格 1:1 消费、重复 reconid 人工分流或候选最优选择。
- 不为合法 AchReturn R1 配对增加过滤审计；其静默移出行为保持。
- 不修改 Excel sheet、列、标黄规则、数据库、IPC、preload 或前端。
- PR、合并、tag 与 GitHub Release 已由用户后续明确指令纳入本次收尾。

## 4. 验收标准

- AC-01：R1 配对网关 TradeType trim 后为 `AchReturn` 时，只排除该 `pair.bankRow`。
- AC-02：`Inbound-VA`、空值、`achreturn`、`Ach Return` 均不触发退款前置过滤。
- AC-03：同 reconid 多银行行中，未成为 R1 pair 的行仍可进入退款匹配。
- AC-04：未传 `r1Pairs` 时不前置过滤，旧 `gwRows` 参数不能旁路触发。
- AC-05：合成回归与受控本地问题样本均输出对应退款单，命中类型为“精准命中”；真实业务标识不得进入仓库或安装包文档。
- AC-06：12 个 DBS 白名单 TradeType 均能参与步骤2；外侧空格允许，大小写不同拒绝。
- AC-07：非白名单-only 桶保持原 FundType 且无 warning。
- AC-08：混合桶只读取白名单候选，非白名单金额命中不能影响结果。
- AC-09：Credit 正/负非零均保持进入步骤2前的 FundType，步骤2不新增 modification，并产生方向 warning；步骤1既有改写不得回滚。
- AC-10：方向守卫先于金额/币种判断；方向不符且金额不匹配的旧 outbound 仍保持 outbound。
- AC-11：Credit 为 0、空或非法文本按 0 放行，之后沿用金额币种逻辑。
- AC-12：DBS 步骤1、FundTransfer 保护、白名单桶内 `outbound -> Charge` 与“仅修改 DBS 银行目标行”的渠道门控不回归；不承诺网关候选按 Channel/MerchantId 隔离。
- AC-13：warning 出现在主错误报告且“可能原因”不是“未知错误”。

## 5. 影响与回滚

- 影响范围：R1→R5 内部数据流、DBS-Charge 步骤2候选范围、错误报告 warning 文案、资金对账结果行去向。
- 数据/状态：不新增持久数据或运行状态；所有判断基于本次 run 的对象引用和输入行。
- 兼容性：内部可选参数兼容旧直接调用；未启用退款/DBS 场景时零影响。
- 回滚：可整体回退本迭代代码；没有 schema 或历史数据需要迁移/清理。

## 6. Unknowns Register

| 未知/风险 | 分类 | 当前决定或证据 | 后续 |
|---|---|---|---|
| 空/非法 Credit 是否应失败而非按 0 | 已知风险 | 用户明确要求沿用 R4 口径 | 作为人工复核项，不在本轮改变 |
| 合法 AchReturn 配对静默过滤是否应可审计 | 已知风险 | 本轮明确保留 | 后续单独实施全量过滤审计 |
| R4 同 ID 扩散、DBS MerchantId/Channel、候选复用 | 已知风险 | 明确非目标 | 另起资金规则迭代 |
| 真实数据下 12 类白名单与方向组合 | PROBE | 自动测试覆盖枚举；用户在知悉人工复核未完成后于 2026-07-20 明确要求执行发布收尾 | 作为发布后跟进项，发布授权不等于人工复核已完成 |

## 7. 资金红线

- 本迭代改变退款行和 DBS FundType 的处理去向，命中主键、网关类型和借贷方向均属于资金红线。
- 自动测试、只读样本回放和代码 review 不能替代业务负责人对真实退款、DBS 白名单、金额币种及方向告警的人工确认。
- 用户已明确授权在上述人工复核仍为待办的情况下执行本次发布；归档和发布说明必须继续披露该剩余风险，不得写成“人工验收通过”。

## 8. 合并与发布记录

- 2026-07-20：隔离工作区完整 `release-check` 通过，unit `3716/3716`、integration `1955/1955`，lint 与 smoke 全绿。
- 2026-07-20：`scan:vars` 在纯 3.0.21 树中扫描 `195` 个 JS 文件、`2202` 个顶层名称；`check-vars` 仅命中两个预期 Risk-sensitive 变量。
- 2026-07-20：最终 self-review 为 P0-P4 Finding 0；GitHub PR workflow run `29747527965` 通过。
- 2026-07-20：PR #96 以 merge commit `3c44420e` 合入 `main`，远程与本地 3.0.21 开发分支删除。
- 归档见 `docs/prs/PR96-v3.0.21.md` 与 `docs/iterations/v3.0.21/PRD-v3.0.21.md`。
- `v3.0.21` tag、Release workflow 和公开升级资产证据待发布完成后补录。
- 2026-07-20：合并归档后的最终 `main` 完成干净 `npm ci`，重新通过 release-check、六组合 Electron 几何门禁、scan-vars 与 check-vars；可创建发布 tag。
- 2026-07-20：annotated tag `v3.0.21` 指向发布准备 commit `d438ac6`；Windows Release workflow run [`29796190599`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/29796190599) 以 success 完成。
- GitHub Release [`v3.0.21`](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.21) 已发布为 latest、非 draft、非 prerelease，包含 Setup、Setup blockmap、portable 与 `latest.yml` 四个资产。
- 匿名 Range 回读确认 Setup/portable 总大小分别为 `99,724,013` / `99,227,248` 字节且文件头均为 `MZ`；`latest.yml` 和 blockmap 的 SHA-256 与 GitHub 资产摘要一致，完整 Setup SHA-512 由 Release workflow 校验通过。
