# Spec — refund-backfill-rules-v2 中台退款订单回填规则增强与模板扩列（R1~R6 / O1~O4）

> status: implemented
> owner: pzhong
> created: 2026-06-15
> implemented: 2026-06-15（8 commit 全落地：①常量+O3/O4 ②O1/O2 ③R1+R3 ④R2 ⑤R4 ⑥R5/R6 ⑦depIndex ⑧docs；engine/fields/writer/date-utils 改造 + 单测同步；unit 全绿。详见 §10 实施记录）
> 目标版本：**v3.0.5**（✅ 用户 2026-06-15 拍板：与 `size-startup-optimization`（剩 Phase 2/3/4）+ `linked-fx-bank-deposit-merge-import` 统一并入在产的 v3.0.5 一起发版）。⚠️ 连带项：linked-fx spec 内 OPEN-6 原拍板 3.0.7，本决策**覆盖**为 3.0.5，需同步改其 spec 版本号。
> **前置依赖**：先完成 `changes/linked-fx-bank-deposit-merge-import`（同 v3.0.5 内排在本 spec 之前），本 spec 在其改造后的入金表 + 命中详情之上施工（见 §2.8）。
> ⚠️ **版本载荷提醒**：v3.0.5 现集 3 大块——size/DB 治理（迁移+VACUUM，🔴 最高风险）+ linked-fx（🔴🔴 资金红线，OPEN-1~6 已定、OPEN-7a/7b/7c 待拍）+ 本 spec（🔴 资金红线）。代码顺序 = linked-fx → 本 spec（§2.8 前置）。单版本 review 面与回归面很重，发版前 `/check-vars` + `release-check` 必跑全量。
> 性质：🔴 **资金红线**（双变更：① R5 引擎匹配规则面扩张 R1~R6；② 回填模板输出列契约 O1~O4）。任一规则错位 / 列序错位都会写错退款回填，回填一旦执行会把退款单状态误改 SUCCESS。每个功能 commit 一提交；提 PR 前必跑 `/check-vars` + `npm run release-check`。
> 来源：用户提供 JPM HK/US 两份真实退款命中线索标注样本（`~/Desktop/小助手-Debug/3.0.0/JPM HK退款回填规则.xlsx` 196 行 + `JPM US退款回填规则.xlsx` 191 行，共 387 行人工标注），对照现有 R5 引擎识别 4 类未覆盖线索 + 2 处规则缺陷 + 模板可用性缺口。调研方式：1 Explore（8 项代码事实）+ 1 Plan（全量设计 + 风险），全部 file:line 经主线程二次实读核验。

---

## 1. 背景

「中台退款订单回填」R5 引擎：银行对账单 `FundType=Ach Return`（且未被 R4 改写）行 ↔ 中台退款订单 `状态=SUBMITTED` 行，按「渠道大账号 + 币种 + 金额」三元组唯一值分组，组内跑 S1→S2(JPM 分支)→S3→S4 策略链，命中即停回填；产出双 sheet Excel（sheet1 回填模板 / sheet2 未匹配报错）。

两份样本是业务人工逐笔标注的「靠什么线索匹配上原入金」，分布与现有引擎覆盖对照：

### 1.1 JPM HK（196 行）

| 人工命中线索 | 行数 | 现状覆盖 | 缺口 |
|---|---|---|---|
| 原入金银行打款流水号在退款附言中（带 `//` 分隔、字段数不规律） | 153 | ✅ `matchJpmHk` | ⚠️ 提取正则锁死 `T54SWIC`，真实数据前缀为 T54SWIC/T54LCIC/T54CCBT（=T54+4字母），非 IC 型漏配 → R1 修正为 `T54[A-Z]{4}` |
| 无明确字段（CustomerRef=NONREF），靠提交时间+大账号+金额币种推测 | 38 | ⚠️ S4 | 双向容差 / 文案无区分度（R4/O1/O2） |
| 退款与原入金 CustomerRef 相同（FPS/HKD，`J` 开头流水号，附言无 T54SW） | 4 | ❌ | HK 无 CustomerRef 二跳（R3） |
| 原入金客户流水号在退款附言中 | 1 | ❌ | 附言包含回落（R2 同构） |

### 1.2 JPM US（191 行）

| 人工命中线索 | 行数 | 现状覆盖 | 缺口 |
|---|---|---|---|
| 原入金 CustomerRef = 退款 CustomerRef | 165 | ✅ `matchJpmUs` 二跳 | —（主流路径，回归基线） |
| 原入金 CustomerRef 在退款附言 Payment Detail 中（非 CustomerRef 列） | 11 | ❌ | 二跳后附言包含回落（R2） |
| Drawee Name + 附言中 `DATE=YYMMDD`（=原入金起息日） | 12 | ❌ | 新策略 S3b（R5） |
| 退款资金携带原单日期+金额币种（入金 CustomerRef=NOTPROVIDED） | 3 | ❌ | 新策略 S3c（R6） |

> US 表头两段人工 SOP 注释印证现有设计：①「筛选已提交渠道+大账号+金额，剔除重复金额，用 Debit Amount 做唯一值」≈ 现有唯一值三元组 + 多笔报错；②「按加款单日期判断范围，下载该范围 inbound 对账单，用入金流水号匹配客户流水号」≈ matchJpmUs 二跳。

---

## 2. 代码现状（出处，全部经二次实读核验）

### 2.1 策略链骨架（新策略层的挂载点）

- `runStrategiesForGroup` 内 `strategyChain = [matchS1, matchS2, matchS3]` 数组逐层「批量解析」（`r5-refund-order-backfill.js:428-432`）：每层流程 = 冻结快照（未消费且未锁定的 refund）→ 算命中图 → 逐 bank 定性（正向多笔报错 `:464-474` / 反向多笔报错+锁定 `:479-489` / 严格 1↔1 回填 `:492-494`）→ 锁定落地 `:498`。
- **新增策略层只要塞进 `strategyChain` 数组即自动继承全部 1↔1 / 反向多笔 / 锁定语义**（该骨架是 v2.1.16-beta.4 SPEC-DELTA §7 / Q13/Q14/Q15 的固化产物）。
- S4 在链后独立跑「冻结快照 + minDayDiff 判据」（`:501-534`），不在 `strategyChain` 内。
- 命中类型当前不存在：`match*` 返回 `[{refundRow, detail}]`（`:118` 注释定义形状），无强弱标记。

### 2.2 JPM 分支（R1/R2/R3 落点）

- `matchS2`（`:210-224`）：`Channel==='JPM'` 时按地区跑 `matchJpmHk`（`:157-180`）或 `matchJpmUs`（`:183-207`），`jpmHits` 非空即返回，否则回落 `matchS2Mtx`（常规 MTX 包含匹配，`:140-154`）；非 JPM 直接常规 MTX。「JPM 链未命中 → 回落 MTX」语义须保留。
- `matchJpmHk`（`:157-180`）：清洗 `//`（`split('//').join('')`，`:158`）→ 提 `T54SWIC` → 仅与 `ro['银行打款流水号']` 严格等值（`:167-171`）。
- `matchJpmUs`（`:183-207`）：`ro['银行打款流水号']=payNo` → 入金表行（`usDepositKeys=['ReconciliationId','ChannelOrderNo']` OR == payNo）→ 取 `dep.CustomerRef` → 与 `bank.CustomerRef` 严格等值（`refund-backfill-fields.js:76-77`）。**即 R3 = 把这套二跳开放给 HK**。

### 2.3 T54SWIC 提取锁死点（R1）

- `T54SWIC_FEATURE = {featureCode:'T54SWIC', digitCount:6, totalLength:13}`（`refund-backfill-fields.js:101`），经 `buildFeatureRegex`（`c1-extract-recon-id.js:29-38`）生成 `/T54SWIC\d{6}/g`（引擎 `:40`）。
- `buildFeatureRegex` 只能生成「`[A-Z]{n}` 前缀 + 特征码 + 数字」形态（`:34-37`），**`T54` + 4 字母 + 数字 模板表达不了** → R1 必须直写正则常量 `/T54[A-Z]{4}\d{6}/g`，不能走 builder。
- 安全性：提取只决定「左操作数候选集」，命中仍须与 `ro['银行打款流水号']` 严格等值（`:167-171` 不变）；旧 `/T54SWIC\d{6}/` 是新 `/T54[A-Z]{4}\d{6}/` 的真子集 → 存量零漏配（2026-06-15 真实数据实测前缀 T54SWIC/T54LCIC/T54CCBT，详见 §4 F-R1）。

### 2.4 S4 双向容差（R4）

- `matchS4`（`:247-265`）调 `dayDiffWithin(bank.BillDate, ro.valueDate, 10)`（`:251`），`dayDiffWithin` 是 `Math.abs` 双向（`engine-date-utils.js:40-46`，`:44` `Math.abs(...)`）。
- `M.s4 = {bankDate:'BillDate', roDate:'valueDate', toleranceDays:10}`（`refund-backfill-fields.js:69`）。
- 报错/提示判据走 `minDayDiffToSet`（也是 `Math.abs`，`:555-566`），调用点 `:518-533`。
- ⚠️ **`dayDiffWithin` 被 `r5-fund-transfer-backfill.js:192` 共用**，绝不能改其双向语义 → R4 须另立 `signedDayDiff`，不动 `dayDiffWithin`。
- 25 列签名无「提交时间/创建时间/申请时间」字段（`table-signatures.js:57-62`，仅有 `退款完成时间`/`渠道退款时间`/`valueDate`）→ ✅ R4 文案口径定稿用「退款提交日期」（2026-06-15 用户拍板；底层比对字段仍为 `valueDate`，文案为业务展示叫法）。

### 2.5 输出列与 writer 投影（O1~O4）

- `REFUND_BANK_COLUMNS` 9 列（`refund-backfill-fields.js:87-91`）；`REFUND_TEMPLATE_HEADERS` 14 列（`:94-97`，= A~D 4 列 + E「匹配命中详情」+ F 起 9 银行列）。
- 启动期断言：`REFUND_BANK_COLUMNS ⊆ BANK_STATEMENT_FIELDS`（`:105-110`），加列自动覆盖。
- writer 纯按表头投影、缺 key → `''`（`refund-backfill-writer.js:45-47` `projectRow`；sheet1 `:83-86`、sheet2 `:91-94`）→ **加列零 writer 功能代码改动**（仅文件头注释 `:7-13` 的「14 列 A~N / 9 列」字样需同步）。
- sheet2 `UNMATCHED_HEADERS = ['结果类型','退款单号', ...REFUND_BANK_COLUMNS, '报错/提示信息']`（`refund-backfill-writer.js:37-42`）→ **复用 `REFUND_BANK_COLUMNS`，O3 加 Payment Detail 会联动 sheet2 12→13 列**（可接受，见 §4.9 + §5）。
- `buildBackfillRow`（引擎 `:90-103`）：A~D + E 详情 + F 起 `for (col of REFUND_BANK_COLUMNS) row[col]=bankRow[col]`（O3 自动跟随；O4 需新增 ro 字段循环）。
- 命中详情两句式 `detailBankToRo`/`detailBankToDeposit`（`:82-87`），均以 `匹配成功:` 起头（O2 删前缀）；S4 详情走 `detailBankToRo`（`:259`，O2 改固定串）。

### 2.6 跨表字段可得性

- 中台退款订单 25 列签名（`table-signatures.js:53-67`）含 O4 要求的全部 15 字段（流水号/加款单号/渠道名称/银行大账号/虚拟卡号/原加款金额/退款金额/币种/付款人名称/付款卡号/附言/客户号/账户号/银行打款流水号/valueDate）。
- `Payment Detail` 在银行主表 44 列契约**1-based 第 18 列 / 0-based idx 17**（`bank-statement-fields.js:27`；实测 `indexOf('Payment Detail')===17`）→ **R2 读的是银行退款行主表的 Payment Detail，主表行恒有**；O3 取配对银行行 Payment Detail 同理恒有。（⚠️ `linked-table-repository.js:32` 源码注释写「第 17 列」未注明 0-based 基准，属 stale 表述，建议 commit ① 顺手改为「1-based 第 18 列 / 0-based idx 17」消歧。）
- 入金表白名单 14 字段含 `ValueDate`/`CustomerRef`/`Payment Detail`（`linked-table-repository.js:35-38`），R5 依赖 `dep.ValueDate`（在原始 13 字段内，无存量缺口）。
- ⚠️ **入金行 `Payment Detail` 是 v3.0.4 块 E 才加入白名单（13→14）**，存量已导入行 `raw_json` 无此 key、无法 migration 补（`linked-table-repository.js:31-34`）→ 若 R5/R6 改用入金行 Payment Detail 会**漏配（静默不命中），非误配**，方向安全；但 R2 不踩此坑（读主表）。

### 2.7 接线与性能基线（零改动面 + 性能必选项）

- 编排器调用 `runRound5RefundOrderBackfill(bankRows, refundOrderRows||[], depositRows||[], options)`（`reconciliation-orchestrator.js:300-303`），签名不变 → **零改动**。
- main.js 注入：`workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit')||[])`（`:3646`）、`workingRefundOrderRows`（`:3647`），经 `refundContext`（`:3672`）传入；writer 调用 `:3873`。**本次全部零改动**。
- ⚠️ 入金表实测可达 **65.7 万行**（`main.js:3649` 注释「~1.2GB 尖峰」指内存尖峰；解压体积达 1.72GB，量纲不同）；现状 `matchJpmUs` 每 (bank,ro) 对 `deps.find` 线性扫（`:191-195`）。R2/R3/R5/R6 新增 4 条二跳路径会把线性扫乘数倍 → **入金索引为性能必选项**（§4.10）。

---

### 2.8 并发 change 依赖：linked-fx-bank-deposit-merge-import（🔴 必须先完成）

`changes/linked-fx-bank-deposit-merge-import/spec.md`（🔴🔴 资金红线，状态「拍板中」，OPEN-2 fx 键待数据）改造本 spec 直接依赖的入金表（`linked_bank_deposit`），四处硬交叉，**本 spec 须在其落地后施工**：

1. **「匹配命中详情」字段共改**（同一 `r5-refund-order-backfill.js:96` / `buildBackfillRow:90-103`）：该 change 的 OPEN-7 机制（其 T5）会在 R5 场景4 回填行的 `匹配命中详情` **追加**「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」（其 spec :157 / §3.6）。本 spec O1（新增「命中类型」列）+ O2（删「匹配成功:」前缀 + S4 改固定串）改的是同一字段构造 → 命中详情终态 = **本 spec 文案 + OPEN-7 残留提醒叠加**，两边不得互相覆盖；buildBackfillRow 以 linked-fx 落地后的形态为基线 rebase。
2. **depositRows 语义变化**（整表覆盖 → 跨次幂等累加，其 §3.1 / OPEN-1 键=BizId）：累加后 `depositRows`（`main.js:3646` 注入源）含跨期残留行，候选入金行变多（其 §1.4 / R-4）。本 spec R2/R3/R5/R6 新增 4 条二跳，候选面随之扩大 → 误配 / 反向多笔报错概率上升；depIndex（`Map<key, dep[]>`）已支持同键多值，但**风险画像变化，样本回放须在「累加后入金表」语义下验收**。
3. **OPEN-7 命中口径已扩到本 spec 新入口**（✅ 2026-06-15 D12 已决）：linked-fx OPEN-7b 已拍板 = 「所有以入金表为来源的命中」，含本 spec R3（HK 二跳）/ R5（S3b）/ R6（S3c）。落地契约：linked-fx 建 OPEN-7 提醒机制（last_hit 专用列 + export 后写），本 spec 落地 R3/R5/R6 时把命中点接入该机制（命中即写 last_hit，载体对齐 linked-fx OPEN-7c，不双写）。见 §9 D12。
4. **matchJpmUs 重构同文件交叉**：本 spec R3 把 matchJpmUs 抽成 `matchCustomerRefTwoHop` + depIndex；linked-fx T5 也改 `r5-refund-order-backfill.js`（注入 OPEN-7 提醒）→ 先 linked-fx 后本 spec，本 spec 基于其落地后行号 rebase。

## 3. 目标

- **必做**：R1~R4 规则增强（含 S4 既有夹具方向重造）+ R5/R6 完整实现（正则 D1/D4 已定稿，原件已到位）+ O1~O4 输出列变更 + 入金索引（性能）+ 测试同步 + 发版三件套与守卫收口。
- **R5/R6 完整实现（正则待原件校准）**：用户 2026-06-15 确认可提供那 15 行对应的银行对账单原件（含退款行 Extra Information / Payment Detail 附言原文）→ R5 的 `DATE=YYMMDD` token 正则、R6 的「原单日期+金额+币种」token 正则在**拿到原件解析附言形态后定稿**（D1~D4），本期**完整落地 R5/R6**（非框架占位）。实施排序：先就位策略骨架 + 「正则未配置即整层 no-op」防御，待原件到位即填正则 + 补样本回放断言。
- **明确不做**：
  - 不动编排器 / main.js 接线（`reconciliation-orchestrator.js:300-303`、`main.js:3646-3647/3672/3873`）。
  - 不动 `dayDiffWithin` 双向语义（`engine-date-utils.js:40-46`，fund-transfer 共用）。
  - 不动唯一值分组（`:313-331`）与 1↔1 / 反向多笔 / 锁定骨架（Q13/Q14/Q15）。
  - sheet2 不扩 ro 字段（报错行是 1:N 歧义，单行无法承载多笔 ro；记 backlog）。
  - 无 DB migration、不改 renderer/preload。

---

## 4. 功能点

> 新链路图（精准层 L1~L5 全排在模糊层 L6/S4 之前，「精准优先级高于模糊」由层序天然保证）：

```
对每个唯一值分组（大账号||币种||金额分，不变）：
strategyChain（批量解析层，命中即停，全继承 Q13/Q14/Q15 骨架）：
  L1 S1   渠道流水号等值                                          [精准]（不变）
  L2 S2   附言层：JPM-HK ① T54SW 宽正则 ↔ ro 银行打款流水号等值     [精准] ← R1
          │         ② ①空 → CustomerRef 二跳（复用 US 逻辑）       [精准] ← R3
          │     JPM-US  CustomerRef 二跳（matchJpmUs，不动）        [精准]
          └ JPM 链空 / 非 JPM → 常规 MTX 包含（不变）              [精准]
  L3 S2b  附言包含入金 CustomerRef（限 JPM，等值层之后）           [精准] ← R2（新层）
  L4 S3   付款人/卡号/虚拟卡号按位等值                             [精准]（不变）
  L5 S3b  Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate 二跳       [精准] ← R5（新层，正则定稿）
  L6 S3c  附言原单日期+金额币种 ↔ 入金表二跳                       [模糊] ← R6（新层，正则定稿）
S4（链后，结构不变）：单向 0 ≤ bank.BillDate − ro.valueDate ≤ 21   [模糊] ← R4
```

### F-R1 — HK 提取正则放宽 `T54SWIC` → `T54[A-Z]{4}`（🔴，精准）

- ⚠️ **正则修正（2026-06-15 真实数据实跑）**：原 spec 拟 `T54SW[A-Z]{2}`，但实跑 `Refund_order_..jpmhk-用例.xls` + `渠道账单_..JPMHK.xlsx` 实测「银行打款流水号」前缀为 **`T54SWIC`/`T54LCIC`/`T54CCBT`**（= `T54` + **4 字母** + 6 数字，中段是 SW/LC/CC，尾段 IC/BT），`T54SW[A-Z]{2}` 会漏 `T54LC*`(22) / `T54CC*`(3)。**正确正则 = `/T54[A-Z]{4}\d{6}/g`**。
- **改动**：`refund-backfill-fields.js` 删 `T54SWIC_FEATURE`（`:101`），新增 `T54_REFUND_RE = /T54[A-Z]{4}\d{6}/g` + 形态注释（T54 + 4 字母 + 6 数字，总长 13；实测前缀 T54SWIC/T54LCIC/T54CCBT）；`module.exports`（`:117`）同步。引擎 `:40` `T54SWIC_RE` 改用新常量（`extractFeature` 仅用 `.source` 重建，正则字面量天然兼容，`:55-60`）。`matchJpmHk` 的 `//` 清洗（`:158`）与等值收口（`:167-171`）不动。
- **边界**：放宽只扩提取候选集，命中仍严格等值收口；旧 `/T54SWIC\d{6}/` 是新正则真子集 → 零漏配；无关文本碰巧成 `T54XXXX######` 形 → 提取多了但等值收口拦住，最坏升为反向多笔报错（保守方向）。原型实跑 HK 52 行经 R1 精准命中。
- **风险**：误提 ≠ 误配（收口在等值）；不引入新写盘路径。
- **验收**：T54SWIC/T54LCIC/T54CCBT 三前缀各 1 条回放命中 + 旧 T54SWIC 回归命中 + 「提取到但 ro 无等值 → 不命中」收口断言。

### F-R2 — 新策略层 S2b：附言包含入金 CustomerRef（🔴，精准）

- **改动**：引擎新增 `matchMemoContainsDepositRef(bankRow, refundCands, depIndex)`，作为独立层插入 `strategyChain` 的 S2 与 S3 之间。逻辑：对每条候选 ro，payNo → 入金行（双键 OR，同 `usDepositKeys`）→ 取 `dep.CustomerRef` → 过守卫（非空 + 不在黑名单 `['NOTPROVIDED','NONREF']` + 长度 ≥ 阈值）→ bank 附言字段（`['Payment Detail','Extra Information']`）`.includes(ref)` → 命中，详情用 `detailBankToDeposit`。限 `Channel==='JPM'`。
- **设计依据（§8 决策 1）**：**必须独立成层、放在等值层之后**——若并入 matchJpmUs 内部回落，等值命中与包含命中进同一冻结命中图，会因「等值 bank 与包含 bank 撞同一 ro」触发同层反向多笔，把 165 行等值主流拖进报错。独立成层后等值层先结清消费，包含层只见剩余候选。
- **边界**：读银行主表 Payment Detail（44 列恒有，不依赖入金行 Payment Detail，不踩存量缺字段坑）；黑名单 + 最小长度是**必选守卫**（占位短串会大面积假命中）；残余误配被 1↔1 + 反向多笔报错兜住。
- **风险**：本批最高误配风险点 → 守卫阈值须用 11 例样本校准；守卫过严会漏真命中。
- **验收**：US 11 例 + HK 1 例同构回放命中 + 黑名单不触发 + 短 ref 守卫 + **分层保护断言**（bankA 等值命中 X、bankB 附言含同 ref：bankA 回填、bankB 不在 S2b 复抢 X）。

### F-R3 — HK 分支内回落：CustomerRef 二跳（🔴，精准）

- **改动**：把 `matchJpmUs`（`:183-207`）的二跳逻辑抽成共享 `matchCustomerRefTwoHop(bankRow, refundCands, depIndex)`（US 语义逐字不变，matchJpmUs 改为薄壳调用）；`matchJpmHk` 在 T54SW 提取为空 / 未等值后调用之（同层内回落，仍属 L2）。入金取键双键 OR（ReconciliationId/ChannelOrderNo，同 ✅Q8 口径）。
- **边界**：收口仍是「dep 行 ↔ ro 银行打款流水号等值 ∧ dep.CustomerRef ↔ bank.CustomerRef 等值」，无放松；同层内 T54SW 命中与二跳命中撞同一 ro → 反向多笔报错（真歧义，正确语义）。
- **风险**：HK 二跳生效后，旧版「第二条落 S4/提示」可能变「同层反向多笔双报错」→ 报错行数或上升，验收时向用户说明非回归。
- **验收**：HK FPS 4 例形态回放（bank.CustomerRef ↔ dep.CustomerRef → dep.ReconId == ro 打款流水号）+ ChannelOrderNo 第二键 + HK 链顺序断言（T54SW 命中优先于二跳）。

### F-R4 — S4 单向容差 0~21 天（🔴，模糊）

- **改动**：
  1. `engine-date-utils.js` 新增 `signedDayDiff(a,b)`（返回 `Math.round((da−db)/MS_PER_DAY)` 或 null）；`dayDiffWithin`/`sameDay`/`toDate` 不动。
  2. `matchS4`（`:247-265`）命中条件改 `diff = signedDayDiff(bank.BillDate, ro.valueDate); diff!==null && diff>=0 && diff<=21`，按 diff 升序（去 Math.abs）。
  3. `M.s4.toleranceDays: 10 → 21`（`refund-backfill-fields.js:69`）+ 注释「单向 0≤bank.BillDate−ro.valueDate≤21；文案口径=退款提交日期（=底层 valueDate）」。
  4. `minDayDiffToSet`（`:555-566`）→ 替换为 `hasInWindowCandidate(bankRow, refundsForS4)`（冻结全集内 ∃ro 满足 0≤diff≤21）；调用点 `:518-533` 改写：组非空 ∧ 有可解析日期对 ∧ 无窗内候选 → 报错（含 bank 早于全部退款的负 diff 情形 = 时序矛盾脏数据）；有窗内候选但被抢光 → 提示；组空/全不可解析 → 提示。报错文案改「S4 金额币种已关联但银行账单日期早于退款提交日期或差异 >21 天，请人工介入」（warning code `refund-backfill-date-over-tolerance` 不变）。
- **决议**：容差 10→21 + 方向收紧，用户 2026-06-15 显式拍板（21 天单向）。
- **边界**：diff=0 命中 / diff=21 命中 / diff=22 报错 / diff=−1 报错（方向收紧）。
- **风险**：若现实存在 bank.BillDate 早于 ro.valueDate 的合法配对（起息日晚于账单日的渠道），旧 ±10 命中、新规则报错 → **38 行 NONREF 样本须回放确认无负 diff 合法对，为 R4 上线前置条件**；容差扩大后同组多 ro 落窗概率升高，靠 diff 最近优先 + 1↔1 + 模糊标注缓释。
- **验收**：边界四态 + 既有 S4 夹具按「ro.valueDate ≤ bank.BillDate」方向重造（§7.1）。

### F-R5 — 新策略层 S3b：Drawee Name + 附言 DESC DATE（🔴，精准；正则 D1 已定稿，完整实现）

- **改动**：引擎新增 `matchDraweeNameDate(bankRow, refundCands, depIndex)`，插 S3 之后（L5）。逻辑：bank `Drawee Name` 非空 ∧ 从 bank 附言提取 DESC DATE token（`/DESC\s*DATE\s*=\s*(\d{6})/`，YYMMDD→Date，世纪固定 20YY，**取 DESC DATE 非 ENTRY DATE**，D1 定稿）→ 对每条 ro：payNo → 入金行（双键 OR）→ `sameDay(dep.ValueDate, token)`（`sameDay` 现成，`engine-date-utils.js:28`）→ 命中（精准；硬锚点 = payNo 二跳等值 + 日期等值双重收口）。
- **no-op 防御（正则已定稿，防御保留）**：正则常量挂 `M.s3b`，若为 `null` 则整层跳过；Drawee Name 闭环角色 D2 仍 `[~]` 半定（推荐起步 a：仅作启用条件，§9）。
- **风险**：依赖 dep.ValueDate（原始白名单字段，无存量缺口）；12 例未被 S3 覆盖，后置安全。
- **验收**：可控 memo/日期夹具验证二跳闭环 + 「正则未配置 → 层跳过」防御。

### F-R6 — 新策略层 S3c：附言原单日期+金额币种（🔴，模糊；正则 D4 已定稿，完整实现）

- **改动**：引擎新增 `matchMemoDateAmount(bankRow, refundCands, depIndex)`，插 S4 之前（L6，模糊层）。逻辑：从 bank 附言提取 原单日期+金额+币种 三 token → payNo 二跳到入金行 → 入金行日期等日 ∧ 入金行金额（`Math.round(amt*100)` 分比对，同 `:321/:329` 口径）== 提取金额 ∧ dep.Currency == 提取币种 → 命中（模糊）。
- **no-op 防御（正则已定稿，防御保留）**：三 token 正则已定稿（原单日期 `/DTD\s*(\d{2}\/\d{2}\/\d{4})/`、金额 `/FOR\s*(?:USD|AMT)\s*([\d.]+)/`、币种 USD，D4 定稿），常量挂 `M.s3c`，任一为 `null` 即整层跳过；不硬 gate `dep.CustomerRef==='NOTPROVIDED'`（D5 建议不 gate，前层未命中已隐含其失效，硬 gate 只损召回）。
- **边界**：模糊层同样适用「多笔即报错」（宁报错勿误配）；抢在 S4 前消费，自动反映进 `refundsForS4` 冻结快照。
- **验收**：可控夹具验证二跳闭环 + R6 多笔报错 + R6 锁定退出 S4 + 「正则未配置 → 层跳过」。

### F-O1 — 「命中类型」列（精准命中/模糊命中）

- **改动（命中类型 = 层属性，经 consumeAndBackfill 第 4 参透传，不动现有匹配器返回值形状——代码实测 7 个 `match*` 函数）**：
  1. 引擎新增常量 `HIT_TYPE_PRECISE='精准命中'`、`HIT_TYPE_FUZZY='模糊命中'`（与 `RESULT_ERROR/RESULT_NOTICE` 同位 `:43-44`，导出供单测）。
  2. `strategyChain` 元素由裸函数 → `{ run, hitType }`（`:428-432`）：L1~L5 = PRECISE，L6 = FUZZY；层循环 `:434` 解构。
  3. `consumeAndBackfill`（`:569-574`）加第 4 参 hitType；`:493`（链层）传 `layer.hitType`、`:510`（S4）传 `HIT_TYPE_FUZZY`。
  4. `buildBackfillRow`（`:90-103`）加第 4 参，写 `row['命中类型']=hitType`。
- **边界**：精准优先由层序保证（精准层全在模糊层前，命中即停）；sheet2 不加此列（非命中行无此语义）。
- **验收**：各层命中类型断言（S1/S2/S2b/S3/S3b 精准；S3c/S4 模糊）。

### F-O2 — 命中详情文案

- **改动**：`detailBankToRo`/`detailBankToDeposit`（`:82-87`）删 `匹配成功:` 前缀；新增 `S4_DETAIL_TEXT='命中唯一值:退款提交日期+大账号+金额+币种'` 常量（✅ 2026-06-15 用户拍板定稿文案；底层比对字段仍为 ro.valueDate），替换 `matchS4` 的 `:259` detailBankToRo 调用。
- **验收**：精确文案断言去前缀；S4 命中行 detail == 固定串。

### F-O3+O4 — 输出模板扩列 14 → 31（🔴 列契约）

- **改动（`refund-backfill-fields.js`）**：
  1. `REFUND_BANK_COLUMNS`（`:87-91`）9→10：CustomerRef 右侧加 `'Payment Detail'`；启动期断言（`:105-110`）自动覆盖（'Payment Detail' ∈ 44 列）。
  2. 新增 `REFUND_RO_COLUMNS`（Object.freeze，15 列按用户列序）：`['流水号','加款单号','渠道名称','银行大账号','虚拟卡号','原加款金额','退款金额','币种','付款人名称','付款卡号','附言','客户号','账户号','银行打款流水号','valueDate']`。
  3. `REFUND_TEMPLATE_HEADERS`（`:94-97`）→ `['退款单号','状态','渠道流水号','渠道退款时间','命中类型','匹配命中详情', ...REFUND_BANK_COLUMNS(10), ...REFUND_RO_COLUMNS(15)]` = **31 列**（6+10+15）。
  4. 新增启动期断言 `REFUND_RO_COLUMNS ⊆ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders`（require `./table-signatures`，依赖无环已核：`table-signatures.js` 仅 require `bank-statement-fields`）。
- **改动（引擎 `buildBackfillRow` `:90-103`）**：F 起银行列循环后追加 `for (col of REFUND_RO_COLUMNS) row[col]=refundRow[col]`（取配对 ro 原值）。
- **边界**：31 列名全互异（「流水号」≠「退款单号」表头不冲突，**内容重复系用户明确要求**，照做）；O3 联动 sheet2 `UNMATCHED_HEADERS` 12→13 列——sheet2 ①银行行恒有 Payment Detail 正常落值、②refund 提示行经 projectRow 投影 `''`（`refund-backfill-writer.js:45-47` 已防御），可接受。
- **风险**：对外按列序解析 sheet1/sheet2 的脚本错位 → CHANGELOG 显式提示。
- **验收**：常量单测 9→10/14→31/列序/freeze/⊆25 列签名；writer 单测端到端 31 列投影 + Payment Detail 列 + 15 ro 字段（「流水号」与「退款单号」同值双列）。

### F-PERF — 入金索引 depIndex（性能，强烈建议同批）

- **改动**：`runRound5RefundOrderBackfill` 入口一次性构建 `depIndex = { byReconId: Map<string, dep[]>, byChannelOrderNo: Map<string, dep[]> }`，经 ctx 传入各二跳匹配器（R2/R3/R5/R6 + 重构后的 matchJpmUs），O(n) `deps.find` → O(1) Map 查（OR 双键 = 两 Map 并集）。
- **依据**：入金表可达 65.7 万行（`main.js:3649`），4 条新二跳路径不建索引会使 run 耗时倍增。
- **验收**：「索引版与线性版结果 byte 级一致」断言；可拆独立 commit。

---

## 5. 交叉影响（实施约束）

1. **引擎单文件承载多功能** → commit 切分串行（顺序见 §8），后做方以先做方落地后实际行号为准。
2. **R4 与 S4 既有夹具方向重造同 commit**：S4 现有夹具多按双向构造，方向收紧后部分夹具的 diff 会变负 → 必须与 R4 改动同提交，否则测试红。
3. **常量层先行**：O3/O4 改 `REFUND_BANK_COLUMNS`/`REFUND_TEMPLATE_HEADERS`/新增 `REFUND_RO_COLUMNS` + 断言，是 buildBackfillRow（O4）与 writer 单测的前置 → 排 commit ①。
4. **O1 与 O2 同改 `buildBackfillRow`/detail 函数**（同文件同区）→ 合一 commit ②，避免同 hunk 二次编辑。
5. **三条对外契约变更合并 CHANGELOG 一段**：① sheet1 14→31 列 + sheet2 12→13 列；② 命中详情新增「命中类型」列 + 删「匹配成功:」前缀 + S4 文案变更；③ S4 容差 10→21 + 单向语义。不写孤立条目。
6. **`usDepositKeys`/`usDepositTake`/`usBankCompare` 命名**：HK（R3）复用后 `us` 前缀名不副实 → 建议改中性名（连带引擎 + 常量单测 `refund-backfill-fields.test.js`），一次到位（§9 待定）。

## 6. 影响范围

- **生产代码（4 文件）**：
  - `src/main-process/scenario-engines/r5-refund-order-backfill.js`（主战场：R1~R6 匹配器 + strategyChain 扩 6 层 + O1/O2 + buildBackfillRow + depIndex + 文件头注释）。
  - `src/constants/refund-backfill-fields.js`（T54SW 正则 / toleranceDays / REFUND_BANK_COLUMNS / REFUND_RO_COLUMNS / REFUND_TEMPLATE_HEADERS / 新断言 / jpm 守卫子块 / R5R6 正则占位 / 命名）。
  - `src/main-process/scenario-engines/engine-date-utils.js`（新增 `signedDayDiff`；其余不动）。
  - `src/main-process/refund-backfill-writer.js`（**功能代码零改动**；仅文件头注释 `:7-13/:34-36` 的「14 列/9 列」字样同步，否则成 stale 红线注释）。
- **测试（3 文件）**：`tests/unit/constants/refund-backfill-fields.test.js`、`tests/unit/main-process/scenario-engines/r5-refund-order-backfill.test.js`、`tests/unit/main-process/refund-backfill-writer.test.js`（详见 §7）。
- **对外契约变更（🔴 需 CHANGELOG 显式标注）**：① 模板列数 14→31 + sheet2 12→13；② 命中详情列结构与文案；③ S4 容差与方向语义。
- **零改动面**：`reconciliation-orchestrator.js`（`:300-303` 签名不变）、`main.js`（`:3646-3647/3672/3873` 注入与调用不变）、renderer/preload、DB schema（无 migration）、唯一值分组与 1↔1/锁定骨架、44 列表头契约。
- **rebase 依赖（§2.8）**：`buildBackfillRow` / 命中详情构造、`matchJpmUs`、depositRows 注入语义均在 linked-fx-bank-deposit-merge-import 落地后施工，本 spec 的 file:line 实施时以其落地后为准。
- **守卫文档**：`rules/important-variables.md`（`refundOrderSession`/`BANK_DEPOSIT_FIELDS` 关联注记）；CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE 三件套。

## 7. 验证

### 7.1 单测矩阵（对照 387 行样本分桶）

- **`refund-backfill-fields.test.js`**：REFUND_BANK_COLUMNS 9→10 含 Payment Detail；REFUND_TEMPLATE_HEADERS 14→31 + 三段拼接（6+10+15）列序断言；toleranceDays=21；删 T54SWIC_FEATURE 断言 → 换 `T54_REFUND_RE` 形态断言（`/T54[A-Z]{4}\d{6}/`，含「旧值 T54SWIC494867 仍被新正则匹配」+「T54LCIC/T54CCBT 也命中」兼容断言）；新增 REFUND_RO_COLUMNS 15 列顺序/freeze/⊆25 列签名断言。
- **`r5-refund-order-backfill.test.js`**：
  - R1：T54SWIC/T54LCIC/T54CCBT 三前缀回放 + 旧 T54SWIC 回归 + 「提取到但 ro 无等值 → 不命中」。
  - R2：US 11 例 + HK 1 例同构 + 黑名单不触发 + 短 ref 守卫 + 分层保护断言。
  - R3：HK FPS 4 例 + ChannelOrderNo 第二键 + 链顺序（T54SW 优先二跳）。
  - R4：边界 diff=0/21/22/−1 + 既有 S4 夹具方向重造。
  - R5/R6：二跳闭环 + 「正则未配置 → 层跳过」防御 + R6 多笔报错 + R6 锁定退出 S4。
  - O1：各层命中类型；O2：去前缀 + S4 固定串；O4：回填行扩 Payment Detail + 15 ro 字段（流水号/退款单号同值双列）。
  - **US 165 行主流回归**：既有 JPM-US 用例断言一行不改全过（等值主线不回归证明）。
- **`refund-backfill-writer.test.js`**：夹具补新列；14→31/E→F 列位/slice 偏移；refund 提示行 Payment Detail 列投影 `''` 断言；端到端补命中类型列。

### 7.2 样本回放（资金红线验收基线）

- 387 行脱敏子集（HK 196 / US 191 按规则分桶代表行）进 `tests/fixtures/`，作回归资产（§9 待定）；或至少人工核对两份真实 Excel 终态。
- **R4 前置硬验收**：38 行 NONREF 回放确认无「bank.BillDate 早于 ro.valueDate」合法对（否则方向收紧会误报错）。

### 7.3 收口

- `npm run scan:vars` + `/check-vars`（PR body「⚠️ 关联功能 review」段；BANK_DEPOSIT_FIELDS 是 Risk-sensitive 红线条目，R5 新增对其 ValueDate 读依赖须声明）+ `npm run release-check` 全量三层。
- 人工 `/verify` 一份同时含多策略命中 + S4 兜底 + 报错的真实样本，打开回填文件确认 31 列 + 命中类型 + 文案。

## 8. 实施顺序（建议 8 commits）

> **前置门槛**：`changes/linked-fx-bank-deposit-merge-import`（✅ OPEN-1~7 全闭环可实施）须先合入目标分支（§2.8）。其落地后：① buildBackfillRow / 命中详情已含 OPEN-7 残留提醒注入，本 spec O1/O2 在其上叠加；② depositRows 已是累加语义，depIndex / 样本回放按累加后入金表验收；③ R3/R5/R6 命中点接入 linked-fx OPEN-7 提醒机制（D12 方案①）。**R5/R6 正则已定稿**（原件已到位，D1/D4 已拍：`DESC DATE` / `DTD`+`FOR`）→ commit ⑥ 直接完整实现（非骨架）。

1. **commit ① 常量层 + O3/O4**：REFUND_BANK_COLUMNS/REFUND_RO_COLUMNS/REFUND_TEMPLATE_HEADERS + 新断言 + buildBackfillRow ro 循环 + writer 注释 + writer/常量单测。列契约先稳。
2. **commit ② O1/O2**：命中类型透传 + 文案（buildBackfillRow/consumeAndBackfill/detail 函数/strategyChain 结构改 `{run,hitType}`）+ 单测。
3. **commit ③ R1 + R3**：T54SW 正则 + matchCustomerRefTwoHop 抽取 + HK 二跳回落 + 单测。
4. **commit ④ R2**：S2b 独立层 + 守卫 + 分层保护单测。
5. **commit ⑤ R4**：signedDayDiff + matchS4 单向 + hasInWindowCandidate + toleranceDays=21 + S4 夹具方向重造（同提交）。
6. **commit ⑥ R5/R6（完整实现）**：S3b/S3c 匹配器 + 正则定稿（D1/D4 已拍板，`DESC DATE` / `DTD`+`FOR` 正则填入）+ 「未配置即跳过」no-op 防御 + 样本回放断言。（原「框架先行」措辞遗留自正则待原件阶段，原件已到位、正则已定稿 → 升为完整实现。）
7. **commit ⑦ depIndex**：入金索引重构 + 「与线性版一致」断言。
8. **commit ⑧ docs/守卫收口**：三件套合并适配提示 + important-variables 注记 + backlog 沉淀。
- 之后 `npm run scan:vars` + `/check-vars` + `npm run release-check` → 提 PR（main.js 虽零改动，引擎含 NUL 风险 review 用 `git diff --text`/`grep -a`）。

## 9. 待拍板 / 开放问题

- [x] **D0 目标版本/排期**：✅ 用户 2026-06-15 拍板**统一并入在产 v3.0.5**（与 `size-startup-optimization` 剩 Phase 2/3/4 + `linked-fx-bank-deposit-merge-import` 同版本发；原 linked-fx 拟的 3.0.7 作废，须同步改其 spec 版本号）。排期：先 linked-fx 后本 spec。（与本文件头第 6 行「目标版本 v3.0.5 ✅」一致——此前 D0 正文残留「版本号待定/倾向 3.0.7」已作废回写。）
- [x] **R5/R6 银行原件**：✅ 用户确认可提供那 15 行对应银行对账单原件 → R5/R6 本期完整实现，正则等原件解析后定稿（D1~D4 转为「待原件」前置项，非无限期 deferred）。
- [x] **D1 R5 DATE token 正则**：✅ 定稿（原件 `渠道账单_2026-06-08_226235-JPMUS-CASE.xlsx`，Payment Detail 形如 `["DESC DATE=260513;ENTRY DATE=260529;IND NAME=nakandalage don mahesh"]`）→ 正则 `DESC\s*DATE\s*=\s*(\d{6})`（YYMMDD，世纪固定 20YY），**起息日取 `DESC DATE`**（✅ 2026-06-15 用户拍板；ENTRY DATE=退款入账日不取）；Drawee Name 同时见于附言 `IND NAME=<名>`。实施期再与入金表 `dep.ValueDate` 实测复核 DESC DATE 等日。
- [x] **D2 R5 Drawee Name 闭环角色**：✅ 采纳 (a)——Drawee 仅作启用条件 + payNo 二跳 + `DESC DATE`↔dep.ValueDate 双锚（team-lead 按推荐默认，用户「全部已确认」授权）。
- [x] **D3 R6 入金侧日期列**：✅ 采纳 `dep.ValueDate`（与 R5 一致；team-lead 按推荐默认）；实施期用 3 例实测复核，不符再回写。
- [~] **D4 R6 金额/币种/日期 token 正则**：✅ 原件已解析（电汇格式 Payment Detail 形如 `REMARK=/BNF/OUR REF JPM260529-011513 RTN DTD05/21/2026 ... FOR AMT5043.00`、另见 `FOR USD2285.00`）→ 原单日期 `DTD\s*(\d{2}/\d{2}/\d{4})`、金额 `FOR\s*(?:USD|AMT)\s*([\d.]+)`、币种 USD（或 `FOR` 后三字母码）。金额一律分比对（`Math.round(amt*100)`）。
- [x] **D13（新发现）`OUR REF JPM######-######` 强匹配**：❌ 用户 2026-06-15 拍板**不做**——不查它对应中台字段、不升级为 US 版强匹配。原件电汇格式虽含 `OUR REF JPM260529-011513`（55/455 行），本期不利用。
- [x] **D5 R6 是否硬 gate `dep.CustomerRef==='NOTPROVIDED'`**：✅ 采纳**不 gate**（前层未命中已隐含其失效；team-lead 按推荐默认）。
- [x] **D6 R2 守卫参数**：✅ 定稿（2026-06-15）——黑名单 = **仅 `NOTPROVIDED` / `NONREF`**（用户确认无其他占位词）；最小长度阈值 **≥6**（双保险）；memo 字段集 = `Payment Detail` + `Extra Information`（按推荐）。回放 11 例时复核阈值。
- [x] **D7 S2b 是否限 Channel=JPM**：✅ 采纳**限定 Channel=JPM**（样本全 JPM；放开记 backlog；team-lead 按推荐默认）。
- [x] **D8 `usDepositKeys` 等命名**：✅ 采纳**改中性名** `depositKeys/depositTake/bankCompare`（一次到位连带单测；team-lead 按推荐默认）。
- [x] **D9 入金索引归属**：✅ 用户拍板**纳入本批**（commit ⑦，depIndex 双 Map + 「索引版与线性版结果 byte 级一致」断言）。
- [x] **D10 sheet2 是否扩 ro 字段**：✅ 采纳**不扩**（报错行 1:N 无法承载多笔 ro；team-lead 按推荐默认）；backlog 记「报错行追加候选退款单号列表列」。
- [x] **D11 387 行样本资产化**：✅ 用户拍板**脱敏子集进 `tests/fixtures/`** 作回放基线（HK 196 / US 191 按规则分桶取代表行；脱敏=对账号/流水号/客户号做保形替换，保留命中关系）。
- [x] **D12 OPEN-7 命中口径协调（与 linked-fx 联动）**：✅ 已决（2026-06-15）——用户拍板 linked-fx **OPEN-7b = 所有以入金表为来源的命中**（含本 spec R3/R5/R6），即**方案①（口径单一真相在 linked-fx 侧）**。落地契约：linked-fx 建 OPEN-7 提醒机制（last_hit 专用列 + export 后写）；本 spec 落地 R3/R5/R6 时把其命中点**接入 linked-fx 的提醒机制**（命中即写 last_hit，载体对齐 linked-fx OPEN-7c 专用列，不双写）。详见 linked-fx spec §3.6 / 本 spec §2.8-3。

---

## 10. 实施记录（2026-06-15，8 commit；基于含 linked-fx OPEN-7 全改动的 commit bb036eb）

> 全程 `npm run test:unit` 全绿；既有 OPEN-7 hits 测试的 BizId 收集/桥接逻辑一行未改全过（仅 R4 方向重造的 S4 日期夹具 + O2 改文案后的 S4 详情 proxy 同步，属规则面联动，非回归）。基线 2576 → 终态 2635 用例。

| commit | 内容 | 关键文件 |
|---|---|---|
| ① 常量+O3/O4 | `REFUND_BANK_COLUMNS` 9→10（+`Payment Detail`）；新增 `REFUND_RO_COLUMNS`(15)；`REFUND_TEMPLATE_HEADERS` 14→31（固定6+银行10+中台15）；启动断言 `REFUND_RO_COLUMNS ⊆ ZHONGTAI_REFUND_ORDER_SIGNATURE`；`buildBackfillRow` 加 ro 段循环；writer 注释同步（功能码零改）；`linked-table-repository.js` stale 注释修正（1-based 第 18 列） | fields/engine/writer/linked-table-repository + 2 测试 |
| ② O1/O2 | `HIT_TYPE_PRECISE/FUZZY` 常量；`strategyChain` 裸函数→`{run,hitType}`；`consumeAndBackfill`/`buildBackfillRow` 透传 hitType（写「命中类型」列，参数插在 `bridgeDepositBizId` 之前不破坏 OPEN-7 断言）；删 detail「匹配成功:」前缀；`S4_DETAIL_TEXT` 固定文案（底层仍 valueDate） | engine + 3 测试 |
| ③ R1+R3 | `T54SWIC_FEATURE`→`T54_REFUND_RE=/T54[A-Z]{4}\d{6}/g`（实测前缀 SWIC/LCIC/CCBT）；抽 `matchCustomerRefTwoHop` 共享二跳（`matchJpmUs` 薄壳）；`matchJpmHk` T54 未中→二跳回落（R3，同层 L2）；`lookupDepositByKeys` 双键 OR；jpm 键中性命名（`usDepositKeys`→`depositKeys` 等，D8） | fields/engine + 2 测试 |
| ④ R2 | 新层 S2b（`matchMemoContainsDepositRef`，L3，限 JPM）：payNo 二跳取入金 CustomerRef + 守卫（黑名单 `NOTPROVIDED/NONREF` 大写归一 + 长度≥6）后与 bank 附言（`Payment Detail`+`Extra Information`）包含匹配；独立成层（等值层先结清，防同层反向多笔拖垮 165 主流）；含分层保护断言 | fields/engine + 2 测试 |
| ⑤ R4 | `engine-date-utils` 新增 `signedDayDiff`（保留方向，不动 `dayDiffWithin`/fund-transfer 共用）；`matchS4` 改单向 `0≤BillDate−valueDate≤21`（去 abs，diff 升序）；`toleranceDays` 10→21；`minDayDiffToSet`→`hasInWindowCandidate`（无窗内候选含负 diff→报错，被抢光→提示）；报错文案改「早于退款提交日期或差异>21天」；S4 既有夹具方向重造 + 边界 diff=0/21/22/−1 | fields/engine/date-utils + 3 测试 |
| ⑥ R5/R6 | S3b（`matchDraweeNameDate`，L5 精准）= Drawee Name 启用 + 附言 DESC DATE(YYMMDD→20YY)↔入金 ValueDate sameDay 二跳；S3c（`matchMemoDateAmount`，L6 模糊）= 附言 DTD(dd/mm/yyyy)+FOR(USD\|AMT 金额)+币种 USD 三 token↔入金日期/金额(分比对)/币种二跳；`extractFirstCapture`/`yymmddToDateStr` helper；正则常量挂 `M.s3b`/`M.s3c`（null 即整层 no-op 防御）；正则按真实原件 D1/D4 定稿 | fields/engine + 2 测试 |
| ⑦ depIndex | `buildDepIndex` 入金表双 Map 索引（`byReconId`/`byChannelOrderNo`，归一键，空键不入，同键多值保留插入序）入口一次性构建经 ctx 透传 4 条二跳路径复用 → O(n)find 降 O(1)（入金表 65 万行）；`lookupDepositByKeys` 索引/线性双路径 byte 级一致 + 断言 | engine + 1 测试 |
| ⑧ docs | spec status propose→implemented + 引擎文件头注释更新（R1~R6 链路图 / O1~O4 / hitDepositBizIds 返回） | spec/engine |

**🔴 资金红线复核要点（实施期已守）**：① 所有二跳/包含命中收口仍为等值/精准（提取只扩候选集，命中靠等值/分比对/日期等日拦截，误提≠误配）；② S4 方向收紧后 bank 早于 valueDate（负 diff）一律不命中、走报错（旧 ±abs 会误命中）；③ O2 改文案/O1 加列不动底层比对字段（S4 仍比 ro.valueDate）；④ buildBackfillRow hitType 参数插在 bridgeDepositBizId 之前，OPEN-7 `_bridgeDepositBizId` 内部字段与 `hitDepositBizIds` 收集逻辑零改动。

**⚠️ R4/O2 联动的既有测试同步说明（非回归）**：S4 改单向后，`r5-refund-order-backfill.test.js` 与 `r5-refund-order-backfill-open7-hits.test.js` 中「bank 早于 ro.valueDate」的 S4 日期夹具按 spec §F-R4「方向重造」改为 bank 晚于 valueDate；OPEN-7 hits 测试中确认走 S4 的 detail proxy 因 O2 改固定串由 `/valueDate/` 同步为 `/命中唯一值:退款提交日期/`——均为规则面变更的夹具适配，OPEN-7 的 BizId 收集/桥接断言一行未改。

**开放问题收口**：R5/R6 正则（D1/D4）已据真实原件定稿（`DESC DATE`/`DTD`+`FOR`），本期完整实现（非框架）；no-op 防御仍保留（正则常量为 null 即整层跳过），便于未来如发现新附言形态时安全关停。samples 资产化（D11）/ sheet2 扩 ro 字段（D10）/ S2b 放开非 JPM（D7）等记 backlog，本期不做。
