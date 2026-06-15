# PRD - 网银账单小助手 v3.0.5「中台退款订单回填规则增强（R1~R6 + O1~O4）」

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.5 |
| 日期 | 2026-06-15 |
| 作者 | PM |
| 状态 | ✅ 定稿（待实现）｜R1~R6 / O1~O4 + spec §9 D0~D13 **全部拍板**（含 D2/D3/D5/D7/D8/D10 按推荐默认采纳、D12 已决方案①，2026-06-15 收口）；R5/R6 正则已由真实原件解析定稿。前置依赖 linked-fx **OPEN-1~7 全闭环可实施**（代码顺序 linked-fx 先，见第「十」章） |
| 模块 | 资金对账数据处理 → 自带写死场景（builtin-fixed）→ R5 场景4「中台退款订单回填」引擎规则增强 + 回填模板扩列 |
| 来源 | 用户提供 JPM HK/US 两份真实退款命中线索人工标注样本（HK 196 行 + US 191 行 = 387 行），对照现有 R5 引擎识别 4 类未覆盖线索 + 2 处规则缺陷 + 模板可用性缺口；正则由 2026-06-15 真实银行对账单原件实测定稿 |
| 唯一真相 spec | `changes/refund-backfill-rules-v2/spec.md`（status=propose；R1~R6 / O1~O4 / D0~D13 全部拍板，D2/D3/D5/D7/D8/D10 已按推荐默认采纳、D12 已决方案①） |
| 格式范式 | `docs/iterations/v2.1.16-beta.3/PRD-中台退款订单回填-v2.1.16-beta.3.md` |

> 🔴🔴 **资金红线（双变更）**：本需求同时改 ① R5 引擎匹配规则面（R1~R6 扩 6 层策略链）+ ② 回填模板输出列契约（O1~O4，14→31 列）。任一规则错位 / 列序错位都会写错退款回填——**回填一旦被人工执行，会把退款单状态由 SUBMITTED 误改为 SUCCESS**，直接污染资金对账结果与退款状态机。每个功能 commit 一提交；提 PR 前必跑 `/check-vars` + `npm run release-check` 全量三层。
>
> ⚠️ **版本载荷提醒**：v3.0.5 集 3 大块——`size-startup-optimization`（剩 Phase 2/3/4，DB 迁移 + VACUUM，🔴 最高风险）+ `linked-fx-bank-deposit-merge-import`（🔴🔴 资金红线，入金表幂等累加 + fx 键）+ 本需求（🔴 资金红线）。单版本 review 面与回归面很重。
>
> 🔴 **前置依赖（✅ 已全部拍板，按序施工）**：本需求必须在 `changes/linked-fx-bank-deposit-merge-import` 落地后施工（同 v3.0.5 内排在本需求之前），在其改造后的入金表（幂等累加语义）+ 命中详情（OPEN-7 残留提醒）之上叠加。**该前置 spec OPEN-1~7 已全闭环**（2026-06-15：OPEN-7a=export 后写标记 / 7b=所有入金表来源命中含 R3/R5/R6 / 7c=专用列）；**D12 已决方案①**——linked-fx 侧建 OPEN-7 提醒机制，本需求落地 R3/R5/R6 时把命中点接入该机制（命中即写 last_hit）。代码顺序硬约束：linked-fx 先 → 本需求后。详见第「十」章。

---

## 一、需求概述

本文件描述 **1 项**需求（拆分为 6 条规则增强 + 4 项输出变更）：

1. **中台退款订单回填规则增强与模板扩列** —— 在现有 R5 场景4「中台退款订单回填」引擎之上，新增/修正 6 条命中规则（R1~R6），并扩展回填模板输出格式（O1~O4，14→31 列）。规则覆盖 JPM HK/US 两地区在真实样本中暴露的 4 类未覆盖命中线索 + 2 处既有规则缺陷；输出变更让人工审计可一眼区分「精准命中 / 模糊命中」、看到配对银行行的 Payment Detail、并把 15 个中台退款订单原始字段一并带进回填模板。

### 1.1 本次 6 条规则增强清单

| 编号 | 名称 | 命中类型 | 落点（策略层） | 覆盖样本数 | 现状缺口 |
|------|------|---------|---------------|-----------|---------|
| **R1** | JPM-HK 提取正则放宽 `T54SWIC` → `T54[A-Z]{4}` | 精准 | L2（S2 内 JPM-HK 分支，不新增层） | HK 153 | 正则锁死 `T54SWIC`，漏 `T54LCIC`/`T54CCBT` |
| **R2** | 新策略层 S2b：附言包含入金 CustomerRef（限 JPM） | 精准 | L3（S2 后 S3 前，**新层**） | US 11 + HK 1 | 无「二跳后附言包含回落」 |
| **R3** | HK 分支内回落：CustomerRef 二跳（复用 US 逻辑） | 精准 | L2（S2 内 JPM-HK 分支内回落） | HK 4 | HK 无 CustomerRef 二跳 |
| **R4** | S4 改单向容差 `0 ≤ bank.BillDate − ro.valueDate ≤ 21` | 模糊 | S4（链后，结构不变） | HK 38 | 双向 ±10 容差 / 文案无区分度 |
| **R5** | 新策略层 S3b：Drawee Name + 附言 `DESC DATE` 二跳 | 精准 | L5（S3 后，**新层**） | US 12 | 无此策略 |
| **R6** | 新策略层 S3c：附言原单日期 + 金额币种二跳 | 模糊 | L6（S4 前，**新层**） | US 3 | 无此策略 |

### 1.2 本次 4 项输出变更清单

| 编号 | 名称 | 列契约影响 | 对外提示 |
|------|------|-----------|---------|
| **O1** | 命中详情左侧加「命中类型」列（精准命中/模糊命中） | sheet1 新增 1 列 | CHANGELOG |
| **O2** | 命中详情删「匹配成功:」前缀；S4 命中改固定串 | 文案变更（非列变更） | CHANGELOG |
| **O3** | `REFUND_BANK_COLUMNS` 9→10（CustomerRef 右侧加 Payment Detail） | sheet1 银行段 +1 列；sheet2 联动 12→13 列 | CHANGELOG |
| **O4** | 新增 `REFUND_RO_COLUMNS` 15 字段；`REFUND_TEMPLATE_HEADERS` 14→31 列 | sheet1 +15 列 | CHANGELOG |

> 三条对外契约变更合并进 CHANGELOG 一段：① sheet1 14→31 列 + sheet2 12→13 列；② 命中详情新增「命中类型」列 + 删「匹配成功:」前缀 + S4 文案变更；③ S4 容差 10→21 + 单向语义。

---

## 二、背景与目标

### 2.1 背景：387 行真实样本分布缺口

两份样本是业务人工逐笔标注的「靠什么线索匹配上原入金」。把人工命中线索与现有引擎覆盖对照，识别出 4 类未覆盖线索 + 2 处规则缺陷。

#### 2.1.1 JPM HK（196 行，spec §1.1）

| 人工命中线索 | 行数 | 现状覆盖 | 缺口 → 规则 |
|---|---|---|---|
| 原入金银行打款流水号在退款附言中（带 `//` 分隔、字段数不规律） | 153 | ✅ `matchJpmHk` | 提取正则锁死 `T54SWIC`，真实前缀 T54SWIC/T54LCIC/T54CCBT → **R1** |
| 无明确字段（CustomerRef=NONREF），靠提交时间+大账号+金额币种推测 | 38 | ⚠️ S4 | 双向容差 / 文案无区分度 → **R4 / O1 / O2** |
| 退款与原入金 CustomerRef 相同（FPS/HKD，`J` 开头流水号，附言无 T54SW） | 4 | ❌ | HK 无 CustomerRef 二跳 → **R3** |
| 原入金客户流水号在退款附言中 | 1 | ❌ | 附言包含回落 → **R2 同构** |

#### 2.1.2 JPM US（191 行，spec §1.2）

| 人工命中线索 | 行数 | 现状覆盖 | 缺口 → 规则 |
|---|---|---|---|
| 原入金 CustomerRef = 退款 CustomerRef | 165 | ✅ `matchJpmUs` 二跳 | —（主流路径，回归基线，一行不改全过） |
| 原入金 CustomerRef 在退款附言 Payment Detail 中（非 CustomerRef 列） | 11 | ❌ | 二跳后附言包含回落 → **R2** |
| Drawee Name + 附言中 `DATE=YYMMDD`（=原入金起息日） | 12 | ❌ | 新策略 S3b → **R5** |
| 退款资金携带原单日期+金额币种（入金 CustomerRef=NOTPROVIDED） | 3 | ❌ | 新策略 S3c → **R6** |

> US 表头两段人工 SOP 注释印证现有设计：①「筛选已提交渠道+大账号+金额，剔除重复金额，用 Debit Amount 做唯一值」≈ 现有唯一值三元组 + 多笔报错；②「按加款单日期判断范围，下载该范围 inbound 对账单，用入金流水号匹配客户流水号」≈ `matchJpmUs` 二跳。

#### 2.1.3 原件实测（2026-06-15，定稿正则的依据）

- **R1 正则修正**：原 spec 一度拟 `T54SW[A-Z]{2}`，实跑 `Refund_order_..jpmhk-用例.xls` + `渠道账单_..JPMHK.xlsx` 实测「银行打款流水号」前缀为 **`T54SWIC`/`T54LCIC`/`T54CCBT`**（= `T54` + 4 字母 + 6 数字），`T54SW[A-Z]{2}` 会漏 `T54LC*`(22) / `T54CC*`(3)。**最终定稿 = `/T54[A-Z]{4}\d{6}/g`**。
- **R5 正则**：原件 `渠道账单_2026-06-08_226235-JPMUS-CASE.xlsx`，Payment Detail 形如 `["DESC DATE=260513;ENTRY DATE=260529;IND NAME=<名>"]` → 正则 `/DESC\s*DATE\s*=\s*(\d{6})/`（YYMMDD，世纪固定 20YY），**起息日取 `DESC DATE` 非 `ENTRY DATE`**；Drawee Name 同时见于附言 `IND NAME=<名>`。
- **R6 正则**：原件电汇格式 Payment Detail 形如 `REMARK=/BNF/OUR REF JPM260529-011513 RTN DTD05/21/2026 ... FOR AMT5043.00`（或 `FOR USD2285.00`）→ 原单日期 `/DTD\s*(\d{2}\/\d{2}\/\d{4})/`、金额 `/FOR\s*(?:USD|AMT)\s*([\d.]+)/`、币种 USD。

#### 2.1.4 原型实跑佐证（2026-06-15，无入金表）

`scripts/prototype-refund-backfill-v2.js` 已实跑增强逻辑（不接 DB、逻辑按 spec 手写）：

- **HK 63 命中**（R1 52 + S3 2 + S4 9）。
- **US 66 命中**（S3 1 + S4 65；因未提供入金表，US 二跳类策略 `matchJpmUs`/R2/R3/R5/R6 未跑，故多落 S4 模糊）。
- 证明：R1 修正正则（`/T54[A-Z]{4}\d{6}/g`）成立 + O1~O4 输出格式（31 列）成立。

### 2.2 目标

- 在现有 R5 场景4 引擎（`r5-refund-order-backfill.js`）的策略链骨架上，新增/修正 6 条命中规则（R1~R6），覆盖 387 行样本暴露的 4 类未覆盖线索 + 2 处缺陷。
- 扩展回填模板输出格式（O1~O4），让人工审计可区分精准/模糊命中、看到配对银行行 Payment Detail、并带出 15 个中台退款订单原始字段。
- 入金索引（depIndex）把二跳查找 O(n)→O(1)（性能必选项，入金表实测 65.7 万行级）。
- 所有 file:line 出处、命中类型/优先级/1↔1 互配/反向多笔/锁定语义讲清；与 spec 零冲突。

### 2.3 明确不做（spec §3「明确不做」+ §9 D13）

- **不动编排器 / main.js 接线**：`reconciliation-orchestrator.js:300-303`（`runRound5RefundOrderBackfill` 签名不变）、`main.js:3646-3647/3672/3873`（注入与调用不变）—— 本次全部零改动。
- **不动 `dayDiffWithin` 双向语义**（`engine-date-utils.js:40-46`）—— 被 `r5-fund-transfer-backfill.js:192` 共用，R4 须另立 `signedDayDiff`，绝不改其双向。
- **不动唯一值分组**（引擎 `:313-331`）与 1↔1 / 反向多笔 / 锁定骨架（Q13/Q14/Q15）。
- **不动现有匹配器返回值形状**（代码实测 7 个 `match*` 函数：matchS1/matchS2Mtx/matchJpmHk/matchJpmUs/matchS2/matchS3/matchS4；O1 命中类型走层属性透传，不改 `{refundRow, detail}`）。
- **D13 `OUR REF JPM######-######` 强匹配：❌ 用户 2026-06-15 拍板不做** —— 不查它对应中台字段、不升级为 US 版强匹配。原件电汇格式虽含 `OUR REF JPM260529-011513`（55/455 行），本期不利用。
- **sheet2 不扩 ro 字段**（报错行是 1:N 歧义，单行无法承载多笔 ro；记 backlog，见 D10）。
- 无 DB migration、不改 renderer/preload。

---

## 三、代码现状（必须有出处，全部经实读核验）

> 现引擎 `r5-refund-order-backfill.js` 共 609 行，已是 v2.1.16-beta.4 SPEC-DELTA §7 / Q13/Q14/Q15 固化产物 + PR#64 审计完整性收尾的实现版本，与 spec §2.1 描述一致。

### 3.1 策略链骨架（新策略层的挂载点）

| 主题 | 出处 | 当前行为 |
|------|------|---------|
| 策略链数组 | `r5-refund-order-backfill.js:428-432` | `strategyChain = [matchS1, matchS2, matchS3]`，逐层「批量解析」 |
| 批量解析流程 | `:434-499` | 每层：冻结快照（未消费且未锁定 refund，`:440`）→ 算命中图（`:447-455`）→ 逐 bank 定性（正向多笔报错 `:464-474` / 反向多笔报错+锁定 `:480-490` / 严格 1↔1 回填 `:493`）→ 锁定落地（`:498`） |
| 新增层即继承全部语义 | `:428-499` | **新策略层只要塞进 `strategyChain` 数组即自动继承 1↔1 / 反向多笔 / 锁定语义** |
| S4 独立跑 | `:501-534` | 链后独立「冻结快照 + minDayDiff 判据」（`:503/:518`），不在 `strategyChain` 内 |
| 命中类型当前不存在 | `:118-119` 注释 / `:124-265` | 现有 7 个匹配器（matchS1/matchS2Mtx/matchJpmHk/matchJpmUs/matchS2/matchS3/matchS4）返回 `[{refundRow, detail}]`（S4 额外带 `dayDiff`），无强弱标记 |

### 3.2 JPM 分支（R1/R2/R3 落点）

| 主题 | 出处 | 当前行为 |
|------|------|---------|
| S2 综合 | `matchS2`（`:210-224`） | `Channel==='JPM'` 时按地区跑 `matchJpmHk`（`:215`）或 `matchJpmUs`（`:217`），`jpmHits` 非空即返回（`:220`），否则回落 `matchS2Mtx`（`:223`）；非 JPM 直接常规 MTX。**「JPM 链未命中 → 回落 MTX」语义须保留** |
| JPM-HK | `matchJpmHk`（`:157-180`） | 清洗 `//`（`split('//').join('')`，`:158`）→ 提 `T54SWIC`（`:161`）→ 仅与 `ro['银行打款流水号']` 严格等值（`:170`） |
| JPM-US | `matchJpmUs`（`:183-207`） | `ro['银行打款流水号']=payNo`（`:189`）→ 入金表行（`usDepositKeys=['ReconciliationId','ChannelOrderNo']` OR == payNo，`:191-195`）→ 取 `dep.CustomerRef`（`:197`）→ 与 `bank.CustomerRef` 严格等值（`:198`）。**即 R3 = 把这套二跳开放给 HK** |

### 3.3 T54SWIC 提取锁死点（R1）

| 主题 | 出处 | 当前行为 |
|------|------|---------|
| 提取特征码常量 | `refund-backfill-fields.js:101` | `T54SWIC_FEATURE = {featureCode:'T54SWIC', digitCount:6, totalLength:13}` |
| 生成正则 | `c1-extract-recon-id.js:29` `buildFeatureRegex` + 引擎 `:40` | 生成 `/T54SWIC\d{6}/g` |
| builder 表达力限制 | `c1-extract-recon-id.js`（`buildFeatureRegex` 仅生成「`[A-Z]{n}` 前缀 + 特征码 + 数字」形态） | **`T54` + 4 字母 + 数字 模板表达不了** → R1 必须直写正则常量 `/T54[A-Z]{4}\d{6}/g`，不能走 builder |
| 安全性 | 引擎 `:167-171` | 提取只决定「左操作数候选集」，命中仍须与 `ro['银行打款流水号']` 严格等值；旧 `/T54SWIC\d{6}/` 是新 `/T54[A-Z]{4}\d{6}/` 的真子集 → 存量零漏配 |

### 3.4 S4 双向容差（R4）

| 主题 | 出处 | 当前行为 |
|------|------|---------|
| S4 命中条件 | `matchS4`（`:247-265`），调 `dayDiffWithin(bank.BillDate, ro.valueDate, 10)`（`:251`） | `dayDiffWithin` 是 `Math.abs` 双向（`engine-date-utils.js:40-46`，`:44` `Math.abs(...)`） |
| 容差常量 | `refund-backfill-fields.js:69` | `s4 = {bankDate:'BillDate', roDate:'valueDate', toleranceDays:10}` |
| 报错/提示判据 | `minDayDiffToSet`（引擎 `:555-566`，也是 `Math.abs`），调用点 `:518-533` | 组非空 ∧ minDayDiff>10 → 报错；否则提示 |
| 🔴 不可改 | `dayDiffWithin` 被 `r5-fund-transfer-backfill.js:192` 共用 | **绝不能改其双向语义** → R4 须另立 `signedDayDiff`，不动 `dayDiffWithin` |
| 25 列签名无「提交/创建/申请时间」字段 | `table-signatures.js:57-62`（时间类列仅 `退款完成时间`/`渠道退款时间`/`valueDate`，无「提交时间/创建时间/申请时间」） | R4 文案口径用「退款提交日期」（业务展示叫法），底层比对字段仍为 `valueDate` |

### 3.5 输出列与 writer 投影（O1~O4）

| 主题 | 出处 | 当前行为 |
|------|------|---------|
| 银行列 | `REFUND_BANK_COLUMNS` 9 列（`refund-backfill-fields.js:87-91`） | `['BillDate','Channel','地区','MerchantId','Currency','Debit Amount','ReconciliationId','ChannelOrderNo','CustomerRef']` |
| 模板表头 | `REFUND_TEMPLATE_HEADERS` 14 列（`:94-97`） | A~D 4 列 + E「匹配命中详情」+ F 起 9 银行列 |
| 启动期断言 | `:105-110` | `REFUND_BANK_COLUMNS ⊆ BANK_STATEMENT_FIELDS`，加列自动覆盖 |
| writer 投影 | `refund-backfill-writer.js:45-47` `projectRow`；sheet1 `:83-86`、sheet2 `:91-94` | 纯按表头投影、缺 key → `''` → **加列零 writer 功能代码改动**（仅文件头注释 `:7-13` 的「14 列 A~N / 9 列」字样需同步，否则成 stale 红线注释） |
| sheet2 表头 | `UNMATCHED_HEADERS = ['结果类型','退款单号', ...REFUND_BANK_COLUMNS, '报错/提示信息']`（`refund-backfill-writer.js:37-42`） | **复用 `REFUND_BANK_COLUMNS`，O3 加 Payment Detail 会联动 sheet2 12→13 列** |
| 回填行构造 | `buildBackfillRow`（引擎 `:90-103`） | A~D + E 详情（`:91-97`）+ F 起 `for (col of REFUND_BANK_COLUMNS) row[col]=bankRow[col]`（`:99-101`）→ O3 自动跟随；O4 需新增 ro 字段循环 |
| 命中详情两句式 | `detailBankToRo`/`detailBankToDeposit`（`:82-87`），均以 `匹配成功:` 起头（`:83/:86`）；S4 详情走 `detailBankToRo`（`:259`） | O2 删前缀；S4 改固定串 |

### 3.6 跨表字段可得性

| 主题 | 出处 | 当前事实 |
|------|------|---------|
| 25 列签名 | `table-signatures.js:53-67`（`ZHONGTAI_REFUND_ORDER_SIGNATURE`） | 含 O4 要求的全部 15 字段（流水号/加款单号/渠道名称/银行大账号/虚拟卡号/原加款金额/退款金额/币种/付款人名称/付款卡号/附言/客户号/账户号/银行打款流水号/valueDate），逐一核验全部命中 |
| Payment Detail 位次 | `bank-statement-fields.js:27`（数组第 19 行，1-based 第 18 列；0-based idx 17） | **R2 读的是银行退款行主表的 Payment Detail，主表行恒有**；O3 取配对银行行 Payment Detail 同理恒有 |
| 入金表白名单 14 字段 | `linked-table-repository.js:35-38`（`BANK_DEPOSIT_FIELDS`） | 含 `ValueDate`/`CustomerRef`/`Payment Detail`，R5 依赖 `dep.ValueDate`（在原始 13 字段内，无存量缺口） |
| ⚠️ 入金行 Payment Detail 存量缺口 | `linked-table-repository.js:31-34` | 入金行 `Payment Detail` 是 v3.0.4 块 E 才加入白名单（13→14），存量已导入行 `raw_json` 无此 key、无法 migration 补 → 若 R5/R6 改用**入金行** Payment Detail 会**漏配（静默不命中），非误配**，方向安全；但 R2 不踩此坑（读银行**主表**） |

> ✅ **已回写 spec**：`Payment Detail` 列序口径 spec §2.6 已统一为「1-based 第 18 列 / 0-based idx 17」（实测 `indexOf===17`，44 列）。⚠️ 仅剩 `linked-table-repository.js:32` 源码注释「第 17 列」未注明基准属 stale，建议 commit ① 顺手消歧（非红线）。

### 3.7 接线与性能基线（零改动面 + 性能必选项）

| 主题 | 出处 | 当前事实 |
|------|------|---------|
| 编排器调用 | `reconciliation-orchestrator.js:300-303` | `runRound5RefundOrderBackfill(bankRows, refundOrderRows||[], depositRows||[], options)`，签名不变 → **零改动** |
| main.js 注入 | `main.js:3646`（`workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit')||[])`）/ `:3647`（`workingRefundOrderRows`）/ `:3672`（`refundContext`）/ `:3873`（writer 调用） | **本次全部零改动** |
| 🔴 入金表规模 | `main.js:3649` 注释（实测「65.7 万行 / 内存尖峰 ~1.2GB」；解压体积达 1.72GB，量纲不同：1.2GB=内存尖峰、1.72GB=解压体积） | 现状 `matchJpmUs` 每 (bank,ro) 对 `deps.find` 线性扫（`:191-195`）。R2/R3/R5/R6 新增 4 条二跳路径会把线性扫乘数倍 → **入金索引为性能必选项**（见五·F-PERF） |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| **精准命中** | 由「等值 / 二跳硬锚点」确定的命中（L1~L5），命中类型常量 `HIT_TYPE_PRECISE='精准命中'`。审计可信度高 |
| **模糊命中** | 由「金额币种 + 日期窗口」推测的命中（L6 / S4），命中类型常量 `HIT_TYPE_FUZZY='模糊命中'`。需人工二次确认 |
| **命中类型 = 层属性** | 命中类型由「命中所在策略层」决定（精准层全排模糊层前），不是匹配器返回值的一部分；经 `consumeAndBackfill` 第 4 参 + `buildBackfillRow` 透传 |
| **二跳（two-hop）** | refund 行的「银行打款流水号」= payNo → 入金表行（ReconId/ChannelOrderNo OR）→ 取入金行某字段 → 与银行退款行某字段比对。跨 3 表关联（refund → 入金表 → 银行），任一跳错位都写错回填 |
| **唯一值组（unique-key group）** | 「渠道大账号（bank.MerchantId ↔ ro.银行大账号）+ 币种 + 金额分（`|Credit-Debit|` ↔ 退款金额，`Math.round(amt*100)`）」三元组分组。组内才跑策略链 |
| **1↔1 互配** | 仅「某 bank 唯一命中某 refund 且该 refund 也仅被该 bank 命中」才回填（引擎 `:493`）。双向消费 `usedBankRowId` + `usedRefundIdx`（`:571-573`） |
| **正向多笔** | 一条 bank 命中多条 refund（`deg>1`，引擎 `:464`）→ 涉事 bank 报错、不回填、命中的 refund 锁定 |
| **反向多笔** | 一条 refund 被多条 bank 命中（`hitters.size>1`，引擎 `:480`）→ 涉事 bank 报错、不回填、该 refund 锁定（Q14） |
| **锁定（lock）** | 因正/反向多笔报错卷入的 refund 标记 `lockedRefundIdx`（引擎 `:498`），退出本组后续策略层 + S4，不被静默兜底回填（Q15） |
| **黑名单守卫（R2）** | CustomerRef 占位词过滤：仅 `NOTPROVIDED` / `NONREF` + 最小长度 ≥6（D6 定稿），防占位短串大面积假命中 |

---

## 五、功能详细描述

### 5.1 策略链顺序图与「精准 > 模糊」优先级

> 🔴 **精准 > 模糊优先级由「层序」天然保证**：精准层（L1~L5）全部排在模糊层（L6 / S4）之前，每层「命中即停」（双向消费后该 bank/refund 不再参与后续层）。因此不需要额外的优先级比较逻辑——只要层的物理顺序对，精准就一定先于模糊被消费。

```
对每个唯一值分组（大账号 || 币种 || 金额分，不变）：
strategyChain（批量解析层，命中即停，全继承 1↔1 / 反向多笔 / 锁定骨架）：
  L1 S1   渠道流水号等值                                          [精准]（不变）
  L2 S2   附言层：JPM-HK ① T54SW 宽正则 ↔ ro 银行打款流水号等值     [精准] ← R1
          │         ② ①空 → CustomerRef 二跳（复用 US 逻辑）       [精准] ← R3
          │     JPM-US  CustomerRef 二跳（matchJpmUs，不动）        [精准]
          └ JPM 链空 / 非 JPM → 常规 MTX 包含（不变）              [精准]
  L3 S2b  附言包含入金 CustomerRef（限 JPM，等值层之后）           [精准] ← R2（新层）
  L4 S3   付款人/卡号/虚拟卡号按位等值                             [精准]（不变）
  L5 S3b  Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate 二跳       [精准] ← R5（新层）
  L6 S3c  附言原单日期 + 金额币种 ↔ 入金表二跳                     [模糊] ← R6（新层）
S4（链后，结构不变）：单向 0 ≤ bank.BillDate − ro.valueDate ≤ 21   [模糊] ← R4
```

> **命中类型映射**：L1~L5 = `HIT_TYPE_PRECISE`；L6 = `HIT_TYPE_FUZZY`；S4 = `HIT_TYPE_FUZZY`。`strategyChain` 元素由裸函数 → `{ run, hitType }` 结构（引擎 `:428-432`），`consumeAndBackfill` 第 4 参传 `layer.hitType`（链层）/ `HIT_TYPE_FUZZY`（S4）。

---

### 5.2 R1 — HK 提取正则放宽 `T54SWIC` → `T54[A-Z]{4}`（🔴 精准）

- **业务线索**：JPM-HK 原入金银行打款流水号会写进退款行附言（带 `//` 分隔），人工据此命中 153 行。
- **规则**：清洗 `//` 后从银行退款行附言（Extra Information / Payment Detail）提取 `/T54[A-Z]{4}\d{6}/g` 形式的流水号 → 与 `ro['银行打款流水号']` 严格等值。
- **命中类型**：精准（L2，不新增层，仅放宽 `matchJpmHk` 的提取正则）。
- **覆盖样本数**：HK 153（其中原型实跑 52 行经 R1 精准命中）。
- **边界**：
  - 放宽只扩提取候选集，命中仍严格等值收口（引擎 `:170` 不变）。
  - 旧 `/T54SWIC\d{6}/` 是新正则真子集 → 零漏配。
  - 无关文本碰巧成 `T54XXXX######` 形 → 提取多了但等值收口拦住，最坏升为反向多笔报错（保守方向，误提 ≠ 误配）。
- **正则定稿依据**：2026-06-15 实测前缀 `T54SWIC`/`T54LCIC`/`T54CCBT`（= `T54` + 4 字母 + 6 数字，总长 13）。

---

### 5.3 R2 — 新策略层 S2b：附言包含入金 CustomerRef（🔴 精准）

- **业务线索**：US 11 行（+ HK 1 行同构）的原入金 CustomerRef 出现在退款行附言 Payment Detail 中（不在 CustomerRef 列）。
- **规则**：新策略层（独立成层，插 S2 与 S3 之间 = L3）。对每条候选 ro：payNo → 入金行（双键 OR，同 `usDepositKeys`）→ 取 `dep.CustomerRef` → 过守卫 → 银行退款行附言字段（`['Payment Detail','Extra Information']`）`.includes(ref)` → 命中，详情用 `detailBankToDeposit`。限 `Channel==='JPM'`。
  - **守卫（D6 定稿）**：CustomerRef 非空 + 不在黑名单 `['NOTPROVIDED','NONREF']` + 长度 ≥6。
- **命中类型**：精准（L3）。
- **覆盖样本数**：US 11 + HK 1。
- **🔴 为何必须独立成层、放在等值层之后**（spec §4 决策 1）：若并入 `matchJpmUs` 内部回落，等值命中与包含命中进同一冻结命中图，会因「等值 bank 与包含 bank 撞同一 ro」触发同层反向多笔，把 165 行等值主流拖进报错。独立成层后等值层先结清消费，包含层只见剩余候选。
- **边界**：
  - 读银行**主表** Payment Detail（44 列恒有，不依赖入金行 Payment Detail，不踩存量缺字段坑）。
  - 黑名单 + 最小长度是**必选守卫**（占位短串会大面积假命中）；守卫过严会漏真命中。
  - 残余误配被 1↔1 + 反向多笔报错兜住。
- **风险**：本批最高误配风险点 → 守卫阈值须用 11 例样本校准。

---

### 5.4 R3 — HK 分支内回落：CustomerRef 二跳（🔴 精准）

- **业务线索**：HK 4 行（FPS/HKD，`J` 开头流水号，附言无 T54SW）退款与原入金 CustomerRef 相同。
- **规则**：把 `matchJpmUs` 的二跳逻辑抽成共享 `matchCustomerRefTwoHop(bankRow, refundCands, depIndex)`（US 语义逐字不变，`matchJpmUs` 改薄壳调用）；`matchJpmHk` 在 T54SW 提取为空 / 未等值后调用之（**同层内回落，仍属 L2**）。入金取键双键 OR（ReconciliationId/ChannelOrderNo）。
- **命中类型**：精准（L2，HK 分支内回落）。
- **覆盖样本数**：HK 4。
- **边界**：
  - 收口仍是「dep 行 ↔ ro 银行打款流水号等值 ∧ dep.CustomerRef ↔ bank.CustomerRef 等值」，无放松。
  - 同层内 T54SW 命中与二跳命中撞同一 ro → 反向多笔报错（真歧义，正确语义）。
  - **HK 链顺序**：T54SW 命中**优先于**二跳（T54SW 提取为空才回落二跳）。
- **风险**：HK 二跳生效后，旧版「第二条落 S4/提示」可能变「同层反向多笔双报错」→ 报错行数或上升，验收时向用户说明**非回归**。

---

### 5.5 R4 — S4 单向容差 0~21 天（🔴 模糊）

- **业务线索**：HK 38 行无明确字段（CustomerRef=NONREF），靠提交时间+大账号+金额币种推测。
- **规则**：
  1. `engine-date-utils.js` 新增 `signedDayDiff(a,b)`（返回 `Math.round((da−db)/MS_PER_DAY)` 或 null）；`dayDiffWithin`/`sameDay`/`toDate` 不动（fund-transfer 共用）。
  2. `matchS4`（`:247-265`）命中条件改 `diff = signedDayDiff(bank.BillDate, ro.valueDate); diff!==null && diff>=0 && diff<=21`，按 diff 升序（去 `Math.abs`）。
  3. `M.s4.toleranceDays: 10 → 21`（`refund-backfill-fields.js:69`）+ 注释「单向 0≤bank.BillDate−ro.valueDate≤21；文案口径=退款提交日期（=底层 valueDate）」。
  4. `minDayDiffToSet`（`:555-566`）→ 替换为 `hasInWindowCandidate(bankRow, refundsForS4)`（冻结全集内 ∃ro 满足 0≤diff≤21）；调用点 `:518-533` 改写：组非空 ∧ 有可解析日期对 ∧ 无窗内候选 → 报错（含 bank 早于全部退款的负 diff 情形 = 时序矛盾脏数据）；有窗内候选但被抢光 → 提示；组空/全不可解析 → 提示。报错文案改「S4 金额币种已关联但银行账单日期早于退款提交日期或差异 >21 天，请人工介入」（warning code `refund-backfill-date-over-tolerance` 不变）。
- **命中类型**：模糊（S4）。
- **覆盖样本数**：HK 38。
- **边界**：diff=0 命中 / diff=21 命中 / diff=22 报错 / diff=−1 报错（方向收紧）。
- **🔴 上线前置硬验收**：38 行 NONREF 样本须回放确认**无「bank.BillDate 早于 ro.valueDate」的合法配对**（否则方向收紧会把旧 ±10 命中的合法对误报错）。
- **风险**：容差扩大后同组多 ro 落窗概率升高，靠 diff 最近优先 + 1↔1 + 模糊标注缓释。

---

### 5.6 R5 — 新策略层 S3b：Drawee Name + 附言 DESC DATE（🔴 精准）

- **业务线索**：US 12 行靠 Drawee Name + 附言中 `DATE=YYMMDD`（=原入金起息日）命中。
- **规则**：新策略层 `matchDraweeNameDate(bankRow, refundCands, depIndex)`，插 S3 之后（L5）。逻辑：bank `Drawee Name` 非空 ∧ 从 bank 附言提取 DESC DATE token → 对每条 ro：payNo → 入金行（双键 OR）→ `sameDay(dep.ValueDate, token)`（`sameDay` 现成，`engine-date-utils.js:28`）→ 命中。
  - **正则（D1 定稿）**：`/DESC\s*DATE\s*=\s*(\d{6})/`（YYMMDD，世纪固定 20YY），**起息日取 `DESC DATE` 非 `ENTRY DATE`**（`ENTRY DATE`=退款入账日不取）。
  - **Drawee Name 角色（D2 已采纳方案 a）**：Drawee 仅作启用条件 + payNo 二跳 + `DESC DATE`↔dep.ValueDate 双锚；不额外比对 `IND NAME` 与 ro 付款人名称（方案 b 记 backlog，见第「九」章 D2）。
- **命中类型**：精准（L5；硬锚点 = payNo 二跳等值 + 日期等值双重收口）。
- **覆盖样本数**：US 12。
- **边界**：
  - 依赖 `dep.ValueDate`（原始白名单字段，无存量缺口）。
  - 12 例未被 S3 覆盖，后置安全。
  - 实施期再与入金表 `dep.ValueDate` 实测复核 `DESC DATE` 等日。
- **防御**：正则常量挂 `M.s3b`，若为 null 则整层跳过（no-op）。

---

### 5.7 R6 — 新策略层 S3c：附言原单日期 + 金额币种（🔴 模糊）

- **业务线索**：US 3 行退款资金携带原单日期+金额币种（入金 CustomerRef=NOTPROVIDED），电汇格式。
- **规则**：新策略层 `matchMemoDateAmount(bankRow, refundCands, depIndex)`，插 S4 之前（L6，模糊层）。逻辑：从 bank 附言提取 原单日期 + 金额 + 币种 三 token → payNo 二跳到入金行 → 入金行日期等日 ∧ 入金行金额（`Math.round(amt*100)` 分比对，同 `:321/:329` 口径）== 提取金额 ∧ dep.Currency == 提取币种 → 命中。
  - **正则（D4 定稿）**：原单日期 `/DTD\s*(\d{2}\/\d{2}\/\d{4})/`、金额 `/FOR\s*(?:USD|AMT)\s*([\d.]+)/`、币种 USD（或 `FOR` 后三字母码）。金额一律分比对（`Math.round(amt*100)`）。
  - **入金侧日期列（D3 已采纳）**：原单日期 `DTD MM/DD/YYYY` 对 `dep.ValueDate`（与 R5 一致），已按推荐默认采纳；实施期再用 3 例实测复核等日。
- **命中类型**：模糊（L6）。
- **覆盖样本数**：US 3。
- **边界**：
  - 模糊层同样适用「多笔即报错」（宁报错勿误配）。
  - 抢在 S4 前消费，自动反映进 `refundsForS4` 冻结快照。
  - 不硬 gate `dep.CustomerRef==='NOTPROVIDED'`（前层未命中已隐含其失效，硬 gate 只损召回；见 D5）。
- **防御**：三 token 正则挂常量，若任一为 null 则整层跳过（no-op）。

---

### 5.8 O1 — 「命中类型」列（精准命中/模糊命中）

- **效果**：sheet1 回填模板在「匹配命中详情」**左侧**新增「命中类型」列，取值 `精准命中` / `模糊命中`。
- **实现要点（命中类型 = 层属性，不动现有匹配器返回值形状，代码实测 7 个 `match*`）**：
  1. 引擎新增常量 `HIT_TYPE_PRECISE='精准命中'`、`HIT_TYPE_FUZZY='模糊命中'`（与 `RESULT_ERROR/RESULT_NOTICE` 同位 `:43-44`，导出供单测）。
  2. `strategyChain` 元素由裸函数 → `{ run, hitType }`（`:428-432`）：L1~L5 = PRECISE，L6 = FUZZY；层循环 `:434` 解构。
  3. `consumeAndBackfill`（`:569-574`）加第 4 参 hitType；`:493`（链层）传 `layer.hitType`、`:510`（S4）传 `HIT_TYPE_FUZZY`。
  4. `buildBackfillRow`（`:90-103`）加第 4 参，写 `row['命中类型']=hitType`。
- **边界**：精准优先由层序保证（精准层全在模糊层前，命中即停）；sheet2 不加此列（非命中行无此语义）。

### 5.9 O2 — 命中详情文案

- **效果**：
  - `detailBankToRo`/`detailBankToDeposit`（`:82-87`）**删 `匹配成功:` 前缀**。
  - S4 命中详情改固定串 `S4_DETAIL_TEXT='命中唯一值:退款提交日期+大账号+金额+币种'`（替换 `matchS4` 的 `:259` detailBankToRo 调用）。
- **⚠️ 文案为业务展示名**：`退款提交日期` 是业务叫法，底层比对字段仍是 `ro.valueDate`（25 列签名无「提交时间」字段，见三·3.4）。

### 5.10 O3 + O4 — 输出模板扩列 14 → 31（🔴 列契约）

- **O3 效果**：`REFUND_BANK_COLUMNS`（`:87-91`）9→10：CustomerRef 右侧加 `'Payment Detail'`（取**配对银行行**值）；启动期断言（`:105-110`）自动覆盖（'Payment Detail' ∈ 44 列）。**联动 sheet2 `UNMATCHED_HEADERS` 12→13 列**。
- **O4 效果**：
  1. 新增 `REFUND_RO_COLUMNS`（Object.freeze，15 列按用户列序）：`['流水号','加款单号','渠道名称','银行大账号','虚拟卡号','原加款金额','退款金额','币种','付款人名称','付款卡号','附言','客户号','账户号','银行打款流水号','valueDate']`。
  2. `REFUND_TEMPLATE_HEADERS`（`:94-97`）→ 31 列（6+10+15）。
  3. 新增启动期断言 `REFUND_RO_COLUMNS ⊆ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders`（require `./table-signatures`，依赖无环已核：`table-signatures.js` 仅 require `bank-statement-fields`）。
  4. 引擎 `buildBackfillRow`（`:90-103`）F 起银行列循环后追加 `for (col of REFUND_RO_COLUMNS) row[col]=refundRow[col]`（取配对 ro 原值）。

#### 5.10.1 31 列模板表头全列（最终顺序）

| 列序 | 段 | 表头 | 取值来源 |
|------|----|------|---------|
| 1 | A 回填 | 退款单号 | ro['流水号'] |
| 2 | B 回填 | 状态 | 固定 SUCCESS |
| 3 | C 回填 | 渠道流水号 | bank.ReconciliationId |
| 4 | D 回填 | 渠道退款时间 | bank.BillDate |
| 5 | E **新增** | 命中类型 | 层属性（精准命中/模糊命中）← O1 |
| 6 | F | 匹配命中详情 | 命中详情文本（无「匹配成功:」前缀）← O2 |
| 7 | G 银行段 | BillDate | bank.BillDate |
| 8 | H 银行段 | Channel | bank.Channel |
| 9 | I 银行段 | 地区 | bank['地区'] |
| 10 | J 银行段 | MerchantId | bank.MerchantId |
| 11 | K 银行段 | Currency | bank.Currency |
| 12 | L 银行段 | Debit Amount | bank['Debit Amount'] |
| 13 | M 银行段 | ReconciliationId | bank.ReconciliationId |
| 14 | N 银行段 | ChannelOrderNo | bank.ChannelOrderNo |
| 15 | O 银行段 | CustomerRef | bank.CustomerRef |
| 16 | P 银行段 **新增** | Payment Detail | 配对银行行 Payment Detail ← O3 |
| 17 | Q ro 段 **新增** | 流水号 | ro['流水号'] ← O4 |
| 18 | R ro 段 **新增** | 加款单号 | ro['加款单号'] |
| 19 | S ro 段 **新增** | 渠道名称 | ro['渠道名称'] |
| 20 | T ro 段 **新增** | 银行大账号 | ro['银行大账号'] |
| 21 | U ro 段 **新增** | 虚拟卡号 | ro['虚拟卡号'] |
| 22 | V ro 段 **新增** | 原加款金额 | ro['原加款金额'] |
| 23 | W ro 段 **新增** | 退款金额 | ro['退款金额'] |
| 24 | X ro 段 **新增** | 币种 | ro['币种'] |
| 25 | Y ro 段 **新增** | 付款人名称 | ro['付款人名称'] |
| 26 | Z ro 段 **新增** | 付款卡号 | ro['付款卡号'] |
| 27 | AA ro 段 **新增** | 附言 | ro['附言'] |
| 28 | AB ro 段 **新增** | 客户号 | ro['客户号'] |
| 29 | AC ro 段 **新增** | 账户号 | ro['账户号'] |
| 30 | AD ro 段 **新增** | 银行打款流水号 | ro['银行打款流水号'] |
| 31 | AE ro 段 **新增** | valueDate | ro['valueDate'] |

- **边界**：
  - 31 列名全互异（「流水号」≠「退款单号」表头不冲突；**内容重复（如 A「退款单号」与 Q「流水号」同值）系用户明确要求**，照做）。
  - O3 联动 sheet2 `UNMATCHED_HEADERS` 12→13 列——sheet2 ①银行行恒有 Payment Detail 正常落值、②refund 提示行经 `projectRow` 投影 `''`（`refund-backfill-writer.js:45-47` 已防御），可接受。
- **风险**：对外按列序解析 sheet1/sheet2 的脚本错位 → CHANGELOG 显式提示。

---

### 5.11 F-PERF — 入金索引 depIndex（性能必选项）

- **效果**：`runRound5RefundOrderBackfill` 入口一次性构建 `depIndex = { byReconId: Map<string, dep[]>, byChannelOrderNo: Map<string, dep[]> }`，经 ctx 传入各二跳匹配器（R2/R3/R5/R6 + 重构后的 `matchJpmUs`），二跳查找 O(n) `deps.find` → O(1) Map 查（OR 双键 = 两 Map 并集）。
- **依据**：入金表实测可达 65.7 万行（`main.js:3649`），4 条新二跳路径不建索引会使 run 耗时倍增。
- **🔴 工程风险点（TechDoc 须标注）**：入金表实测 65.7 万行（解压体积 1.72GB / 内存尖峰 ~1.2GB，量纲不同），SheetJS 读不动需流式——这是 `linked-fx-bank-deposit-merge-import` 的工程问题，本需求的 depIndex 是在「入金表已读进内存为 rows」之后建索引，不解决「读不动」本身。
- **同键多值**：累加语义下（linked-fx）同键可能多 dep 值，`Map<key, dep[]>` 已支持。

---

## 六、验收标准 AC

> 按 R1~R6 / O1~O4 / depIndex 分组，可勾选。AC 以「样本回放命中 + 边界断言」为主，可被 QA 直接拿去测。

### 6.1 规则增强 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-R1-1 | `T54SWIC`/`T54LCIC`/`T54CCBT` 三前缀各 ≥1 条回放命中（精准） |
| [ ] AC-R1-2 | 旧 `T54SWIC494867` 回归仍命中（真子集零漏配） |
| [ ] AC-R1-3 | 「提取到 T54XXXX###### 但 ro 无等值 → 不命中」收口断言 |
| [ ] AC-R2-1 | US 11 例 + HK 1 例同构回放命中（精准） |
| [ ] AC-R2-2 | 黑名单（NOTPROVIDED/NONREF）不触发命中 |
| [ ] AC-R2-3 | 短 ref（长度 <6）守卫不命中 |
| [ ] AC-R2-4 | **分层保护断言**：bankA 等值命中 X、bankB 附言含同 ref → bankA 回填、bankB 不在 S2b 复抢 X（165 行等值主流不被拖进报错） |
| [ ] AC-R3-1 | HK FPS 4 例形态回放（bank.CustomerRef ↔ dep.CustomerRef → dep.ReconId == ro 打款流水号）命中 |
| [ ] AC-R3-2 | ChannelOrderNo 第二键命中 |
| [ ] AC-R3-3 | HK 链顺序断言：T54SW 命中**优先于**二跳 |
| [ ] AC-R4-1 | 边界四态：diff=0 命中 / diff=21 命中 / diff=22 报错 / diff=−1 报错 |
| [ ] AC-R4-2 | 既有 S4 夹具按「ro.valueDate ≤ bank.BillDate」方向重造后全过 |
| [ ] AC-R4-3 | 🔴 前置硬验收：38 行 NONREF 回放确认无「bank.BillDate 早于 ro.valueDate」合法对 |
| [ ] AC-R5-1 | 可控 memo/日期夹具验证二跳闭环（Drawee Name 非空 + DESC DATE token ↔ dep.ValueDate sameDay） |
| [ ] AC-R5-2 | 起息日取 `DESC DATE` 非 `ENTRY DATE`（含 ENTRY DATE 干扰项夹具） |
| [ ] AC-R5-3 | 「正则未配置（null）→ 层跳过」防御断言 |
| [ ] AC-R6-1 | 可控夹具验证二跳闭环（原单日期 DTD + 金额分比对 + 币种 USD） |
| [ ] AC-R6-1b | 入金行金额取数 falsy 陷阱断言：入金行 `Credit Amount=0` / `Debit Amount=有值` 时取数正确（`parseNumber(Credit)||parseNumber(Debit)` 在 Credit=0 跳到 Debit，须确认 0 不被误当 null/缺失） |
| [ ] AC-R6-2 | R6 多笔报错（宁报错勿误配） |
| [ ] AC-R6-3 | R6 锁定退出 S4（命中后 refund 不再被 S4 兜底） |
| [ ] AC-R6-4 | 「正则未配置 → 层跳过」防御断言 |

### 6.2 输出变更 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-O1-1 | 各层命中类型断言：S1/S2/S2b/S3/S3b 列「命中类型」= 精准命中 |
| [ ] AC-O1-2 | S3c/S4 命中行「命中类型」= 模糊命中 |
| [ ] AC-O1-3 | sheet2 不含「命中类型」列 |
| [ ] AC-O2-1 | 精准命中详情文案断言去「匹配成功:」前缀 |
| [ ] AC-O2-2 | S4 命中行详情 == 固定串「命中唯一值:退款提交日期+大账号+金额+币种」 |
| [ ] AC-O3-1 | `REFUND_BANK_COLUMNS` 9→10，第 10 列 == 'Payment Detail' |
| [ ] AC-O3-2 | sheet2 `UNMATCHED_HEADERS` 12→13 列；银行未匹配行 Payment Detail 落值、refund 提示行该列 `''` |
| [ ] AC-O4-1 | `REFUND_RO_COLUMNS` 15 列顺序/freeze 断言 |
| [ ] AC-O4-2 | `REFUND_RO_COLUMNS ⊆ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders` 断言 |
| [ ] AC-O4-3 | `REFUND_TEMPLATE_HEADERS` 14→31 列 + 三段拼接（6+10+15）列序断言 |
| [ ] AC-O4-4 | writer 端到端 31 列投影 + 回填行扩 Payment Detail + 15 ro 字段（「流水号」与「退款单号」同值双列） |

### 6.3 性能 / 回归 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-PERF-1 | depIndex 双 Map（byReconId/byChannelOrderNo）构建正确；OR 双键 = 两 Map 并集 |
| [ ] AC-PERF-2 | 「索引版与线性版结果 byte 级一致」断言 |
| [ ] AC-REG-1 | US 165 行 CustomerRef 等值主流回归：既有 JPM-US 用例一行不改全过 |
| [ ] AC-REG-2 | `release-check` 全量三层 PASS（unit + integration + smoke） |
| [ ] AC-REG-3 | 🔴 审计完整性不变量（PR#64 Finding 1，引擎 `:348`）回归：新增 S2b/S3b/S3c/S4 四层后，每条筛后 SUBMITTED refund + 每条筛后 Ach Return 银行行仍恰落 `backfillRows` 或 `unmatchedRows`（RESULT_ERROR/RESULT_NOTICE）之一，无静默丢失（bank-only 收尾 `:353` / refund-only 收尾 `:378` 不被新层破坏） |

---

## 七、手动测试清单

> P0/P1 + 不测项原因；含原型已验证项。

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| R1 三前缀 | JPM-HK 银行单含 T54SWIC/T54LCIC/T54CCBT 退款行 + 对应 ro 银行打款流水号 | 启用退款回填 | 三前缀各命中，sheet1「命中类型」=精准命中 |
| R2 附言含入金 ref | JPM-US 退款行 Payment Detail 含原入金 CustomerRef + 入金表已导入 | 入金表已导入 | S2b 命中，详情走入金表句式，精准命中 |
| R2 分层保护 | 同组 bankA 等值命中 X、bankB 附言含同 ref | 入金表已导入 | bankA 回填、bankB 不复抢、165 主流不报错 |
| R3 HK 二跳 | JPM-HK FPS/HKD 退款行（无 T54SW，CustomerRef 同入金）+ 入金表 | 入金表已导入 | HK 二跳命中，精准命中 |
| R4 边界 | 退款行 diff=0/21/22/−1 四态 | 启用退款回填 | 0/21 命中、22/−1 报错（落 sheet2） |
| R5 DESC DATE | JPM-US 退款行 Drawee Name 非空 + 附言 `DESC DATE=YYMMDD` + 入金 ValueDate 等日 | 入金表已导入 | S3b 命中，精准命中 |
| R6 电汇原单 | JPM-US 退款行附言 `DTD..` + `FOR AMT/USD..` + 入金日期金额币种匹配 | 入金表已导入 | S3c 命中，模糊命中 |
| O1~O4 输出 | 一份同时含多策略命中 + S4 兜底 + 报错的真实样本 | — | 打开回填文件确认 31 列 + 命中类型列 + 文案 + sheet2 13 列 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| R4 NONREF 前置验收 | 38 行 NONREF 真实样本 | — | 无「bank.BillDate 早于 ro.valueDate」合法对被误报错 |
| depIndex 一致性 | 大入金表（万级以上） | 入金表已导入 | 索引版与线性版回填结果一致 |
| R5/R6 正则 no-op | 正则常量置 null | — | 整层跳过，不抛异常、不误命中 |
| 累加语义回放 | linked-fx 落地后跨期累加入金表 | linked-fx 已合入 | R2/R3/R5/R6 在累加后入金表语义下命中/报错正确 |
| OPEN-7 残留提醒叠加 | 命中曾被命中过的残留入金行 | linked-fx 已合入 | 命中详情 = 本需求文案 + OPEN-7 残留提醒，两边不互相覆盖 |

### 7.3 不测项与原因

- **原型已验证项**：R1 修正正则（HK 52 行命中）、O1~O4 输出格式（31 列）已由 `scripts/prototype-refund-backfill-v2.js` 实跑佐证（2026-06-15，无入金表），手测时只需复核「接入真实引擎 + 入金表后命中数与原型趋势一致」。
- **US 二跳类策略原型未跑**（matchJpmUs/R2/R3/R5/R6）：原型未提供入金表 → 必须在手测时用真实入金表补验（P0 已覆盖）。
- **大入金表读不动（SheetJS）**：属 `linked-fx-bank-deposit-merge-import` 的工程问题，本需求不负责验收读取，只验收「rows 已在内存后建 depIndex + 二跳命中」。

---

## 八、数据 / 状态 / 安全影响

### 8.1 🔴 资金红线

> 🔴 **回填写错 = 退款状态误改 SUCCESS**：本引擎产出回填模板行（`状态` 固定 `SUCCESS`），人工据此执行回填会把退款单状态由 SUBMITTED 改为 SUCCESS。任一规则错位（误配 / 反向多笔漏拦 / 二跳跳错字段）或列序错位（写错列 = 写错对账 ID / 退款单号）都会污染资金对账结果与退款状态机。

| 红线点 | 缓释措施 |
|--------|---------|
| 🔴 规则误配 | R1 提取放宽但等值收口（误提 ≠ 误配）；R2 黑名单+最小长度守卫；R3/R5/R6 二跳双重等值/日期收口；1↔1 互配 + 正/反向多笔报错 + 锁定兜底（宁报错勿误配） |
| 🔴 列序错位 | `REFUND_RO_COLUMNS` Object.freeze + 启动期 ⊆ 25 列签名断言；`REFUND_BANK_COLUMNS` ⊆ 44 列断言；writer 按表头常量投影（单一真相） |
| 🔴 模糊命中误导 | O1「命中类型」列让人工一眼识别模糊命中、二次确认；S4/R6 模糊命中独立标注 |
| 🔴 跨批错回填 | `refundOrderSession` 生命周期 PR#65 已收紧（本需求只读不改其写入/清空时机，见十·非功能） |

### 8.2 状态流转

- refund order「状态」`SUBMITTED → SUCCESS`（命中回填时）—— 🔴 资金状态机变更，仅体现在导出模板、不回写 session/DB（沿用 Q11 既有口径，本需求不改）。

### 8.3 对外契约变更（🔴 需 CHANGELOG 显式标注，3 条）

| # | 变更 | 影响 |
|---|------|------|
| 1 | sheet1 模板列 14→31（含命中类型 + Payment Detail + 15 ro 字段）；sheet2 12→13（加 Payment Detail） | 按列序解析回填文件的下游脚本错位 |
| 2 | 命中详情新增「命中类型」列 + 删「匹配成功:」前缀 + S4 文案改固定串 | 按文案前缀/列名解析的下游 |
| 3 | S4 容差 10→21 + 单向语义（`0≤bank.BillDate−ro.valueDate≤21`） | 命中/报错口径变化（旧 ±10 双向 → 新 0~21 单向） |

### 8.4 权限 / 安全

- 不涉及鉴权；处理资金对账数据（退款单 / 银行打款），属敏感资金数据。

---

## 九、已确认决议

> spec §9 D0~D13 + 文案 Option A + R1 正则修正 + 版本 v3.0.5 **已全部拍板**（D2/D3/D5/D7/D8/D10 按推荐默认采纳、D12 已决方案①，2026-06-15 收口）。下表 9.1 历史既已拍板项、9.2 本轮默认采纳项均列「✅」。

### 9.1 已拍板（✅）

| 编号 | 决议 |
|------|------|
| **版本 v3.0.5** | ✅ 用户 2026-06-15 拍板：与 `size-startup-optimization`（剩 Phase 2/3/4）+ `linked-fx-bank-deposit-merge-import` 统一并入在产的 v3.0.5 一起发版（原 linked-fx 拟的 3.0.7 作废）。✅ 已回写 spec：spec §9 **D0 已勾选 `[x]` = v3.0.5**（消除与文件头「✅ v3.0.5」的内部矛盾）；linked-fx spec 版本号仍待其作者同步改 3.0.7→3.0.5 |
| **R1 正则修正** | ✅ `/T54[A-Z]{4}\d{6}/g`（2026-06-15 真实数据实测前缀 T54SWIC/T54LCIC/T54CCBT；原 spec 一度写 `T54SW[A-Z]{2}` 会漏 T54LC*/T54CC*） |
| **R5/R6 银行原件** | ✅ 用户确认可提供 15 行对应银行对账单原件 → R5/R6 本期完整实现（非框架占位） |
| **D1 R5 DATE token 正则** | ✅ `/DESC\s*DATE\s*=\s*(\d{6})/`（YYMMDD，世纪固定 20YY），起息日取 `DESC DATE` 非 `ENTRY DATE`；Drawee Name 同时见于附言 `IND NAME=<名>` |
| **D4 R6 金额/币种/日期 token 正则** | ✅ 原单日期 `/DTD\s*(\d{2}\/\d{2}\/\d{4})/`、金额 `/FOR\s*(?:USD|AMT)\s*([\d.]+)/`、币种 USD（金额分比对 `Math.round(amt*100)`） |
| **D6 R2 守卫参数** | ✅ 黑名单 = 仅 `NOTPROVIDED`/`NONREF`；最小长度 ≥6；memo 字段集 = `Payment Detail` + `Extra Information` |
| **D9 入金索引归属** | ✅ 纳入本批（commit ⑦，depIndex 双 Map + 「索引版与线性版 byte 级一致」断言） |
| **D11 387 行样本资产化** | ✅ 脱敏子集进 `tests/fixtures/` 作回放基线（HK 196 / US 191 按规则分桶取代表行；脱敏=对账号/流水号/客户号保形替换，保留命中关系） |
| **D13 OUR REF JPM 强匹配** | ✅ ❌ **不做**（不查它对应中台字段、不升级为 US 版强匹配） |
| **R4 容差方向** | ✅ 容差 10→21 + 方向收紧（单向 0≤diff≤21），用户 2026-06-15 显式拍板 |
| **文案 Option A** | ✅ S4 命中固定串 `命中唯一值:退款提交日期+大账号+金额+币种`；R4 报错/提示文案口径用「退款提交日期」（底层比对字段仍为 valueDate） |

### 9.2 本轮按推荐默认采纳（✅ 已拍板）

> 这些项早先在 spec §9 正文为 `[ ]`/`[~]` 建议态，2026-06-15 收口时已**全部按推荐默认采纳**，纳入定稿。dev 直接据此实现。

| 编号 | 决议（已采纳） |
|------|--------------|
| **D2 R5 Drawee Name 闭环角色** | ✅ 方案 (a)：Drawee 仅作启用条件 + payNo 二跳 + DESC DATE↔dep.ValueDate 双锚；不额外比对 IND NAME 与 ro 付款人名称（方案 b 记 backlog） |
| **D3 R6 入金侧日期列** | ✅ DTD 原单日期对 `dep.ValueDate`（与 R5 一致）；实施期 3 例实测复核 |
| **D5 R6 是否硬 gate NOTPROVIDED** | ✅ 不 gate（前层未命中已隐含；硬 gate 只损召回） |
| **D7 S2b 是否限 Channel=JPM** | ✅ 限定 JPM（样本全 JPM），放开记 backlog |
| **D8 `usDepositKeys` 等命名** | ✅ 改中性名（`depositKeys/depositTake/bankCompare`，一次到位连带单测）；HK 复用后 `us` 前缀名不副实 |
| **D10 sheet2 是否扩 ro 字段** | ✅ 不扩（报错行 1:N 无法承载多笔 ro）；backlog 记「报错行追加候选退款单号列表列」 |
| **D12 OPEN-7 命中口径协调** | ✅ 方案①（与 linked-fx 联动，见第「十」章）：linked-fx OPEN-7b 命中口径扩到「所有以入金表为来源的命中」（含本需求 R3/R5/R6），本需求落地时把命中点接入该机制（命中即写 last_hit，载体对齐 OPEN-7c 专用列） |

---

## 十、前置依赖与跨需求协调

> 🔴 **前置依赖 `changes/linked-fx-bank-deposit-merge-import`（spec §2.8）✅ OPEN-1~7 已全闭环可实施（2026-06-15），按序施工：linked-fx 先合入 v3.0.5 → 本需求后**（代码顺序硬约束仍成立，不再是"未决阻塞"而是"已拍板的按序施工"）。其改造本需求直接依赖的入金表（`linked_bank_deposit`），四处硬交叉：

### 10.1 「匹配命中详情」字段共改（同一字段构造）

- linked-fx 的 OPEN-7 机制（其 T5）会在 R5 场景4 回填行的 `匹配命中详情` **追加**「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」（其 spec §3.6，新增持久字段 `last_hit_run`+`last_hit_at`）。
- 本需求 O1（新增「命中类型」列）+ O2（删「匹配成功:」前缀 + S4 改固定串）改的是同一字段构造（`r5-refund-order-backfill.js:96` / `buildBackfillRow:90-103`）。
- **命中详情终态 = 本需求文案 + OPEN-7 残留提醒叠加，两边不得互相覆盖**；`buildBackfillRow` 以 linked-fx 落地后的形态为基线 **rebase**。

### 10.2 depositRows 语义变化（整表覆盖 → 跨次幂等累加）

- linked-fx 把 bank-deposit 落库从整表覆盖改为跨次幂等累加（其 §3.1，幂等键 = `BizId`）。
- 累加后 `depositRows`（`main.js:3646` 注入源）含跨期残留行，**候选入金行变多** → 本需求 R2/R3/R5/R6 新增 4 条二跳，候选面随之扩大 → **误配 / 反向多笔报错概率上升**。
- depIndex（`Map<key, dep[]>`）已支持同键多值，但**风险画像变化，样本回放须在「累加后入金表」语义下验收**。

### 10.3 OPEN-7 命中口径扩展覆盖本需求新入口（D12 已决方案①）

- linked-fx OPEN-7b 命中口径**已定为「所有以入金表为来源的命中」**（含本需求 R3/R5/R6），OPEN-7c 用专用列 `last_hit_run`/`last_hit_at` 承载（2026-06-15 闭环）。
- 本需求 R3（HK 二跳）/ R5（S3b）/ R6（S3c）都新增「以入金表行为命中来源」的路径 → 经这些新策略命中的残留行**均触发残留提醒**，无可见性缺口。
- **协调方案（D12 已采纳方案①）**：在 linked-fx 侧建 OPEN-7 提醒机制（命中口径单一真相在 linked-fx 侧），本需求落地 R3/R5/R6 时把命中点接入该机制（命中即写 last_hit，载体对齐 OPEN-7c 专用列，不双写）。

### 10.4 matchJpmUs 重构同文件交叉

- 本需求 R3 把 `matchJpmUs` 抽成 `matchCustomerRefTwoHop` + depIndex；linked-fx T5 也改 `r5-refund-order-backfill.js`（注入 OPEN-7 提醒）。
- **先 linked-fx 后本需求**，本需求基于其落地后行号 rebase（本 PRD 所有 file:line 实施时以 linked-fx 落地后为准）。

---

## 十一、非功能性要求 + 变更记录

### 11.1 非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 引擎签名不变（`reconciliation-orchestrator.js:300-303`）、main.js 注入不变（`:3646-3647/3672/3873`）；新增策略层默认随引擎跑（场景4 既有 enabled 开关不变）；正则未配置即整层 no-op |
| 性能 | depIndex 双 Map 把二跳 O(n)→O(1)（入金表 65.7 万行级必选）；唯一值分组 + 组内匹配，避免全表笛卡尔；⚠️ 入金表 65.7 万行（解压 1.72GB / 内存尖峰 ~1.2GB）SheetJS 读不动属 linked-fx 工程问题（TechDoc 标注） |
| 鲁棒性 | 空入参（无 refund / 无 Ach Return / 无入金表）→ 返回空结果不报错；提取不到 token / 正则 null → 回落/跳过不抛；日期/金额非法走工具 null 防御 |
| 可测性 | 引擎纯函数（rows 入参，不读 DB/session）；现有 7 个匹配器 + 新增匹配器 + depIndex + 常量全导出供单测；387 行脱敏子集进 fixtures 作回归资产 |
| 守卫 | `rules/important-variables.md`（`refundOrderSession` Runtime-state / `BANK_DEPOSIT_FIELDS` Risk-sensitive 🔴 关联注记，R5 新增对其 ValueDate 读依赖须声明）；提 PR 前 `npm run scan:vars` + `/check-vars` + `npm run release-check` 全量；引擎含 NUL 风险 review 用 `git diff --text` / `grep -a` |

### 11.2 实施切分（8 commits，spec §8）

> **前置门槛**：`linked-fx-bank-deposit-merge-import` 须先合入 v3.0.5 分支。

| # | commit | 内容 |
|---|--------|------|
| ① | 常量 + O3/O4 | `REFUND_BANK_COLUMNS` 9→10 + `REFUND_RO_COLUMNS` 15 + `REFUND_TEMPLATE_HEADERS` 14→31 + 新断言 + buildBackfillRow ro 循环 + writer 注释 + writer/常量单测（列契约先稳） |
| ② | O1/O2 | 命中类型透传（strategyChain `{run,hitType}` + consumeAndBackfill 第4参 + buildBackfillRow）+ 文案（detail 去前缀 + S4 固定串）+ 单测 |
| ③ | R1 + R3 | T54SW 正则 + `matchCustomerRefTwoHop` 抽取 + HK 二跳回落 + 单测 |
| ④ | R2 | S2b 独立层 + 守卫 + 分层保护单测 |
| ⑤ | R4（含 S4 夹具方向重造） | `signedDayDiff` + matchS4 单向 + hasInWindowCandidate + toleranceDays=21 + S4 夹具方向重造（同提交） |
| ⑥ | R5/R6 | S3b/S3c 匹配器 + 正则定稿 + 「未配置即跳过」防御 + 样本回放断言 |
| ⑦ | depIndex | 入金索引双 Map 重构 + 「与线性版一致」断言 |
| ⑧ | docs 收口 | 三件套（CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE）合并适配提示 + important-variables 注记 + backlog 沉淀 |

### 11.3 影响范围

- **生产代码（4 文件）**：`r5-refund-order-backfill.js`（主战场：R1~R6 + strategyChain 扩层 + O1/O2 + buildBackfillRow + depIndex + 文件头注释）、`refund-backfill-fields.js`（T54SW 正则 / toleranceDays / 列常量 / 新断言 / R2 守卫 / R5R6 正则 / 命名）、`engine-date-utils.js`（新增 `signedDayDiff`，其余不动）、`refund-backfill-writer.js`（功能代码零改动，仅文件头注释「14 列/9 列」字样同步）。
- **测试（3 文件）**：`tests/unit/constants/refund-backfill-fields.test.js`、`tests/unit/main-process/scenario-engines/r5-refund-order-backfill.test.js`、`tests/unit/main-process/refund-backfill-writer.test.js`。
- **零改动面**：`reconciliation-orchestrator.js`（`:300-303` 签名不变）、`main.js`（`:3646-3647/3672/3873`）、renderer/preload、DB schema（无 migration）、唯一值分组与 1↔1/锁定骨架、44 列表头契约。

### 11.4 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-15 | 初稿：R1~R6 规则增强（含 R1 正则修正 `/T54[A-Z]{4}\d{6}/`、R5 DESC DATE、R6 电汇原单日期/金额）+ O1~O4 输出扩列（14→31）+ depIndex 性能 + linked-fx 四点协调段 + D0~D13 决议留档；基于 spec `changes/refund-backfill-rules-v2/spec.md`，与 `docs/iterations/v2.1.16-beta.3/` 范式对齐。 |
| 2026-06-15 | 三视角对抗评审收口：① 匹配器计数 8/12→「现有 7 个 `match*`」（对齐代码事实）；② 前置依赖 linked-fx 状态由「已就绪」一度改标「拍板中/OPEN-7b/D12 未决 = 阻塞前置」+ 补回退预案（该阶段性结论已被本日稍后收口推翻，见下一行）；③ 补 AC-REG-3（审计完整性不变量回归）+ AC-R6-1b（入金行 Credit\|\|Debit falsy(0) 取数陷阱）；④ 入金表 GB 口径统一（解压 1.72GB / 内存尖峰 ~1.2GB）；⑤ 回写 spec：D0 版本 checkbox 勾选 v3.0.5、commit⑥/F-R5/F-R6 去「框架」措辞、Payment Detail 列序口径统一（1-based 18 / 0-based 17）。 |
| 2026-06-15 | 决议闭环收口：linked-fx `changes/linked-fx-bank-deposit-merge-import` OPEN-1~7 全闭环可实施（OPEN-7a=export 成功后写命中标记 / 7b=所有以入金表为来源的命中含本需求 R3/R5/R6 / 7c=专用列 last_hit_run/last_hit_at），由"拍板中/阻塞前置"转为"已拍板的按序施工"（代码顺序 linked-fx 先 → 本需求后仍成立）；本需求 spec D2/D3/D5/D7/D8/D10 按推荐默认采纳、D12 已决方案①（linked-fx 侧建 OPEN-7 提醒机制，本需求命中点接入，命中即写 last_hit 对齐 OPEN-7c 专用列、不双写）。§九/§9.2/§十 决议与协调段、文件头状态行同步更新；删去回退预案（已采纳方案①）。 |

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
