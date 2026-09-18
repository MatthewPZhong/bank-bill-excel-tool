# SPEC-DELTA：v2.1.16-beta.4 ③中台退款订单回填引擎（Layer 1）

> 本文件 = 实现契约的「**代码现状纠偏 + 本轮范围 + 已验证精确落点**」。
> 与设计文档配合使用：
> - 完整规格/决策矩阵/12 条已确认歧义 → `docs/iterations/v2.1.16-beta.3/PRD-中台退款订单回填-v2.1.16-beta.3.md`
> - 代码骨架（可直接抄）→ `docs/iterations/v2.1.16-beta.3/TECH_DESIGN-中台退款订单回填-v2.1.16-beta.3.md` §3.3
> - **凡本文件与设计文档冲突，以本文件为准**（已对齐实测源码）。

---

## 0. 本轮范围（Layer 1：引擎层，休眠 + 全单测）🔴

团队负责人已与用户拍板：**本轮只交付引擎层，引擎默认休眠（seed enabled=false），零风险，全单测覆盖**。

**做**：
1. `src/constants/refund-backfill-fields.js`（新建）跨表常量
2. `src/main-process/scenario-engines/r5-refund-order-backfill.js`（新建）引擎
3. `src/main-process/refund-backfill-writer.js`（新建）双 sheet writer
4. `src/main-process/bank-statement-io.js`（改）加 `buildRefundBackfillFileName`
5. `src/main-process/reconciliation-orchestrator.js`（改）bucketScenarios + runReconciliation 集成
6. `src/backend/database/migrations.js`（改）seed（enabled=false）
7. `src/main.js`（改）run/export **安全接线**
8. 全部对应 `tests/unit/**` 单测

**不做（Layer 2，下一轮）**：
- ❌ 翻 `ZHONGTAI_REFUND_BATCH_ENABLED`（保持 false）
- ❌ 实装 refund order 导入读取/落库（main.js:11364 占位保持）
- ❌ renderer `maybePromptRefundOrderImport` 真提醒接线（依赖 session + scenarios config）

---

## 1. 卡片/文档纠偏总表（实测核对，以此为准）🔴

| # | 错误假设 | 实测真相（以此为准） | 出处 |
|---|---------|---------------------|------|
| N1 | seed config 带 `directions[]`/`dateToleranceDays` | 本引擎非场景2 双方向 1v1，是 4 基数×4 策略矩阵；seed config **无 directions** | migrations.js:1497-1527 |
| N2 | refund order 是链接表 `readLinkedTableRows('refund-order')` | refund order 是**预加工 session**（非链接表）；且导入被 `ZHONGTAI_REFUND_BATCH_ENABLED=false` 关闭、`main.js:11354` 占位空实现。**本轮 refundOrderRows 注入恒 []** | main.js:11200,11354 |
| N3 | category=`refund-backfill` | category=`builtin-fixed`；判定 `config.funcCategory==='platform-order' && config.subCategory==='refund-order-backfill'` | migrations.js:1497-1527 |
| N4 | 入金表 `readLinkedTableRows('refund-order')` | 入金表 tableKey=`bank-deposit`：`database.readLinkedTableRows('bank-deposit')`（facade database.js:1032 → linked-table-repository.js:256），仅 JPM-US 用 | 已验证 |
| N5 | seed 改 INSERT 第4位为 0 | 现 INSERT 硬编码 `enabled=1`（migrations.js:1567 `VALUES ('builtin-fixed', ?, ?, 1, ?, 1, 1, ?, ?)`）。须**参数化 enabled**：refund-order-backfill 传 0，既有 2 条仍传 1 | migrations.js:1564-1591 |
| N5b | seed 加进数组即生效 | ⚠️ **marker 短路坑**：`ensureReconRoundBuiltinScenariosSeed` 有全局 marker（migrations.js:1552 `已 seeded → return already-seeded`）。旧库 marker 已为 true，新场景**不会被补种**。须独立迁移策略（见 §4） | migrations.js:1541-1554 |
| N6 | F 起拷贝 13 列 | F 起**只 9 列** `REFUND_BANK_COLUMNS`，金额**只 Debit Amount，无 Credit Amount** | PRD §5.1.5 / TECH §3.3.1 |
| N7 | 引擎签名简单 1v1 | `runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options={})`，四件套 | TECH §3.2 |
| N8 | 返回 `{outputRows,...}` | 返回 `{ backfillRows, unmatchedRows, modifications:[], warnings }`（modifications 恒空，不改 bankRows） | TECH §3.3.2 |
| N9 | writer sheet 名/列数 | sheet1=回填模板 14 列(A~N)；sheet2=未匹配银行行+「结果类型」列；两类输出 error-manual/notice-unmatched 同表用列区分 | PRD §5.1.5 |

---

## 2. 列名真相表（已实测，与文档 100% 一致，禁同名假设）🔴

### refund order 25 列（`ZHONGTAI_REFUND_ORDER_SIGNATURE`，table-signatures.js:53-69）
```
[0]流水号 [1]加款单号 [2]渠道流水单号 [3]业务方 [4]渠道名称 [5]银行大账号 [6]虚拟卡号
[7]原加款金额 [8]退款金额 [9]币种 [10]付款人名称 [11]付款卡号 [12]swiftCode [13]附言
[14]状态 [15]退款完成时间 [16]渠道退款时间 [17]来源 [18]操作人 [19]备注 [20]客户号
[21]账户号 [22]银行打款流水号 [23]valueDate [24]退款标识
```
本引擎用：`流水号`→退款单号 / `银行大账号`唯一值 / `退款金额`唯一值(⚠️非原加款金额) / `币种` / `银行打款流水号`(S1/JPM) / `附言`(S2) / `付款人名称`·`付款卡号`·`虚拟卡号`(S3按位) / `valueDate`(S4) / `状态`(SUBMITTED→SUCCESS)。

### bank 回填 F 起 9 列（`REFUND_BANK_COLUMNS`，均 ∈ BANK_STATEMENT_FIELDS）
```
F:BillDate G:Channel H:地区 I:MerchantId J:Currency
K:Debit Amount   ← 🔴 只放 Debit Amount，绝不放 Credit Amount
L:ReconciliationId M:ChannelOrderNo N:CustomerRef
```
### sheet1 完整 14 列（`REFUND_TEMPLATE_HEADERS`）
```
A:退款单号 B:状态 C:渠道流水号 D:渠道退款时间 E:匹配命中详情  +  F~N: ...REFUND_BANK_COLUMNS
```

---

## 3. 复用工具（dev 直接 require，签名已实测）
```js
// engine-utils.js
const { normalizeCellValue, parseNumber, valuesEqual, makeWarningCollector } = require('./engine-utils');
//  normalizeCellValue(v)→string(null/undefined→''); parseNumber(v)→number|null(去逗号,非有限→null);
//  valuesEqual(a,b,{numeric})→bool; makeWarningCollector(id,name)→{push(payload),list()}
// engine-date-utils.js
const { toDate, sameDay, dayDiffWithin } = require('./engine-date-utils');
//  dayDiffWithin(a,b,n)→|Math.round((da-db)/86400000)|<=n（S4 ≤10 天用它）; 任一 toDate null→false
// c1-extract-recon-id.js
const { buildFeatureRegex } = require('./c1-extract-recon-id');
//  buildFeatureRegex({featureCode,digitCount,totalLength})→RegExp('g')
//  MTX {featureCode:'MTX',digitCount:19,totalLength:22}→/MTX\d{19}/g
//  T54SWIC {featureCode:'T54SWIC',digitCount:6,totalLength:13}→/T54SWIC\d{6}/g
```
⚠️ **lastIndex**：buildFeatureRegex 返回的 regex 只当模板，每次提取前 `new RegExp(re.source,'g')` 重建（同 c1-extract-recon-id.js:66）。
⚠️ **bankAmountAbs 口径**（与场景2 一致）：`Math.abs((parseNumber(b['Credit Amount'])||0)-(parseNumber(b['Debit Amount'])||0))`；唯一值金额比对 `Math.round(x*100)` 精确到分容差0；refund 侧用 `退款金额`。建议从 r5-fund-transfer-backfill.js 上提 `bankAmountAbs` 到 engine-utils.js 共享，避免漂移（若上提，须同步改场景2 引用并跑场景2 单测确认不回归）。

---

## 4. 已验证精确落点

### 4a. orchestrator（reconciliation-orchestrator.js，实测行号）
- `bucketScenarios`（:51）：:54-55 `r5s2/r5s3` 后加 `const r5s4=[]`；:66-67 在 `platform-inbound-cleanup→r5s3.push` 的 else-if 后插 `} else if (s.category==='builtin-fixed' && fc==='platform-order' && sub==='refund-order-backfill'){ r5s4.push(s); }`；:73 `return {r2,r4,r5s2,r5s3}`→加 `r5s4`；:49 JSDoc 同步。
- `runReconciliation`（:149）：签名 `function runReconciliation({ bankRows, gwRows, scenarios, deps, refundContext } = {})`；:154 解构加 `r5s4: r5s4Bucket`；在 **r5s3 调度块（:213起）之后**插场景4 块：
```js
let refundBackfillRows = [];
let refundUnmatchedRows = [];
if (r5s4Bucket.length) {
  const isFundTypeChanged = (rowId) => {
    const cols = modColsByRowId.get(rowId);
    return !!(cols && cols.has('FundType'));   // PRD Q2
  };
  const r5d = runRound5RefundOrderBackfill(
    bankRows,
    (refundContext && refundContext.refundOrderRows) || [],
    (refundContext && refundContext.depositRows) || [],
    { isFundTypeChanged }
  );
  allWarnings.push(...(r5d.warnings || []));   // 不 mergeMods（不改 bankRows）
  refundBackfillRows = r5d.backfillRows || [];
  refundUnmatchedRows = r5d.unmatchedRows || [];
}
```
返回对象加 `refundBackfillRows`/`refundUnmatchedRows`；`stats` 加 `r5s4BackfilledCount`（:244 附近）；`rounds` 加 `r5s4:{backfilled:...}`（:255 附近）。
🔴 数据隔离：场景4 独立 `usedBankRowId`+`usedRefundId`、只读 bankRows、不进 modColsByRowId → 行数守恒 `modifiedRows+unmatchedRows===bankRows` 不变。

### 4b. seed（migrations.js）
- 数组（:1424 `RECON_ROUND_BUILTIN_SCENARIOS`，platform-inbound-cleanup :1527 后）加（**无 directions**）：
```js
{
  name: '中台退款订单回填',
  priority: 0,
  config: {
    funcCategory: 'platform-order',
    subCategory: 'refund-order-backfill',
    roundPhase: 5,
    function: '银行 FundType=Ach Return（未改写）行与中台退款订单 SUBMITTED 行按渠道大账号/金额/币种唯一值分组，按4基数×4策略(渠道流水号/附言MTX/付款人卡号虚拟卡号/金额币种日期)+JPM(HK/US)匹配回填，产出双sheet模板，不改银行行。',
    involvedFiles: ['中台退款订单', '中台退款订单回填模板', '银行对账单入金表']
  }
}
```
- INSERT 参数化 enabled（:1564-1591）：`VALUES ('builtin-fixed', ?, ?, ?, ?, 1, 1, ?, ?)`，run 时 `enabledValue = scenario.config.subCategory==='refund-order-backfill' ? 0 : 1`。既有 2 条仍 1。
- 🔴 **marker 短路坑（N5b）**：旧库 marker 已 true → 整函数短路、新场景不补种。**解法**：新增独立幂等迁移函数 `ensureRefundBackfillScenarioSeed(db)`（仿 ensureReconRoundBuiltinScenariosSeed 的 locate+insert，但**只种这 1 条、用自己的 marker `refund_backfill_scenario_seeded` 或纯 locate 幂等**），并在 database.js init() 里调用。**不要**改动现有 marker 语义破坏「删除终态保护」。单测须覆盖：①新库 fresh seed 出现且 enabled=0；②旧库（已有 marker + 2 条 R5 场景）也能补种 refund 场景且 enabled=0；③重跑幂等不重复；④用户删除后不复活。

### 4c. main.js 安全接线（含 NUL，grep -a）
- 模块级（仿 :283 `let bankStatementSession=null`）：加 `let refundOrderSession = null;  // Layer2 实装；本轮恒 null` —— 用于安全引用，注入恒 []。
- `bank-statement:run`（:3594 调 runReconciliation 前，:3590 已 structuredClone bankRows）：
```js
const workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit') || []);
const workingRefundOrderRows = refundOrderSession ? structuredClone(refundOrderSession.rows) : []; // 本轮恒 []
```
runReconciliation({...}) 加 `refundContext: { refundOrderRows: workingRefundOrderRows, depositRows: workingDepositRows }`；processingResult 加 `refundBackfillRows: result.refundBackfillRows||[]`、`refundUnmatchedRows: result.refundUnmatchedRows||[]`。
- `bank-statement:export`（:3744 platformCleanup block 后）加 refundBackfill block：`processingResult.refundBackfillRows?.length>0` 才 `await writeRefundBackfillOutput(rows, unmatched||[], path.join(dir, buildRefundBackfillFileName()))`，try-catch graceful（仿场景3，失败 appendActivityLogEntry warning 不阻塞），return 加 `refundBackfillPath`/`refundBackfillName`。
- import 顶部加 `const { writeRefundBackfillOutput } = require('./main-process/refund-backfill-writer');` + `buildRefundBackfillFileName`（从 bank-statement-io 引）。

### 4d. writer（refund-backfill-writer.js）仿 platform-cleanup-writer.js + bank-bu-recon-writer.js（多 sheet）
- `async function writeRefundBackfillOutput(backfillRows, unmatchedRows, savePath) => { filePath, fileName }`
- 同 workbook `addWorksheet()` 两次：sheet1 表头 `REFUND_TEMPLATE_HEADERS`，sheet2 表头 = `['结果类型', ...REFUND_BANK_COLUMNS, '报错/提示信息']`（或按 PRD §5.1.5 银行原数据 + 结果类型 + 信息列；dev 定列序但须含「结果类型」区分 error-manual/notice-unmatched）。
- 数据行 `HEADERS.map(h => row[h] ?? '')` 投影；表头行 bold。
- atomic：`xlsx.writeFile(tmp)`→`fs.renameSync(tmp,final)`；catch 清理 tmp+throw；`fs.mkdirSync(dirname,{recursive:true})`。
- `buildRefundBackfillFileName()`（bank-statement-io.js，仿 buildPlatformCleanupFileName :190-205）：`中台退款订单回填-${buildTimestampMinuteUnderscore()}.xlsx`（YYYY_MM_DD_HHMM）。

---

## 5. 引擎逻辑契约（PRD §5.2/§5.5，dev 落地以 PRD 决策矩阵逐格为验收基线）

- **筛选**：refund `状态==='SUBMITTED'`；bank `FundType==='Ach Return'` 且 `!isFundTypeChanged(_rowId)`（编排器注入）。
- **唯一值分组键**：`MerchantId||Currency||Math.round(amountCents)`（bank 金额=bankAmountAbs，refund=退款金额）；金额 NaN→不入组。
- **基数**：classifyCardinality(bankCount,refundCount)→'1:1'|'1:N'|'N:1'|'N:N'。
- **策略 S1→S4 命中即停**（PRD Q3）；报错亦停于该策略；未命中才进下一策略。双向 1v1：`usedBankRowId`+`usedRefundId` 跨策略累积。
  - S1：refund`银行打款流水号` ↔ bank `ChannelOrderNo` 或 `CustomerRef`
  - S2：bank `Extra Information` 提 MTX → `refund['附言'].includes(mtx)`（包含，Q6）；**JPM 链叠加在 S2**（Channel='JPM' 时先跑 JPM HK/US，未命中回落常规 MTX）
  - S3 按位（Q8b）：付款人名称↔Drawee Name / 付款卡号↔Drawee CardNo / 虚拟卡号↔Payee CardNo
  - S4：bank `BillDate` vs refund `valueDate`，`dayDiffWithin(...,10)`；N:1/N:N 按 BillDate 早→晚 1v1 取最近
- **结果三分类**（PRD §5.3，两类输出禁混）：`backfill` / `error-manual`（关联ID本身多笔/关联到多笔/日期>10天）/ `notice-unmatched`（关联不到）。逐格判定严格按 PRD §5.2 四张基数表 + §九 Q9（基数2-S3 多笔报错一笔回填）/Q10（N:N 条数相等按 BillDate 早→晚 1v1）。
- **JPM**（PRD §5.5）：
  - HK：`v.split('//').join('')` 清洗 Extra Information+Payment Detail → 提 T54SWIC → **仅与 refund`银行打款流水号`单字段等值**（Q7）
  - US：refund`银行打款流水号`=payNo → 入金表 `ReconciliationId==payNo OR ChannelOrderNo==payNo`（Q8 OR）→ 取入金表`CustomerRef` → 比对 bank`CustomerRef`
- **回填动作**（§5.1.3）：渠道流水号←bank`ReconciliationId`；渠道退款时间←bank`BillDate`；退款单号←refund`流水号`；状态←`SUCCESS`；E 列←命中详情；F~N←pick REFUND_BANK_COLUMNS。
- **命中详情**（§5.1.4 两句式，Q12）：
  - bank↔refund：`匹配成功:"银行对账单<字段>里的<值>"匹配上了"refund order<字段>的<值>"`
  - bank↔入金表（JPM-US）：`匹配成功:"银行对账单<字段>里的<值>"匹配上了"银行对账单入金表<字段>的<值>"`
- **空入参防御**：refundOrderRows 空 / 无 Ach Return → 返回空 backfillRows，不抛。

---

## 6. 验证要求（每个 dev 委托结束必做）
- 写完即跑对应单测：`node --test tests/unit/<path>.test.js`，贴 PASS/FAIL 实输出。
- 引擎单测覆盖：16 格矩阵逐格（命中/报错/提示）+ JPM HK/US + 数据筛选（SUBMITTED/Ach Return/改写剔除）+ 1v1 双向消费 + 命中详情两句式 + 空入参。
- 常量单测：`REFUND_BANK_COLUMNS.every(f=>BANK_STATEMENT_FIELDS.includes(f))`、9 列含 Debit 不含 Credit、14 列模板顺序。
- 集成单测：r5s4 分桶、数据隔离、行数守恒、refundContext 传参、stats/rounds 字段。
- seed 单测：新库 enabled=0、旧库补种、幂等、删除不复活、既有 2 条仍 enabled=1。
- writer 单测：E 列详情、F 起 9 列（含 Debit 不含 Credit）、sheet2 结果类型两类。
- 全部完成后团队负责人会跑 `npm run release-check` + `/check-vars` + 对抗式 review。

---

## 7. 引擎修复规格（D1 矩阵对账后必改）🔴

> 对抗式矩阵验证（真跑引擎）发现引擎「逐 bank 行顺序消费」收敛模型与 PRD §5.2 不等价。用户已拍板 Q13/Q14/Q15（PRD §九 bis）。以下为修复目标契约。**resolveHits 的「一条 bank 命中多条 refund → error-manual」正向分支是对的，别改它**（JPM 子报告曾误判，已被真跑推翻）。

### 7.1 确认的 bug（带真跑复现输入）
| Bug | 现象 | 复现输入 | 修法依据 |
|---|---|---|---|
| **反向多笔**（Q14） | N 条 bank 命中同 1 refund 时，引擎回填最早一条 + 提示其余，漏「银行多笔→报错」 | b1.ChannelOrderNo=b2.ChannelOrderNo='PAY-SAME' + 1 refund.银行打款流水号='PAY-SAME'（同唯一值组） | Q14：涉事 bank **全部报错-人工介入、不回填**，refund 锁定 |
| **S4 顺序依赖**（Q13） | 超 10 天的 bank 排在「被消费之后」会静默降级成「提示」而非「报错」 | refund.valueDate=12-10；b1.BillDate=12-10(命中)、b2=12-22、b3=12-25（同组） → b1 回填、b2/b3 应报错却成提示 | Q13：S4 报错/提示按**冻结候选集 + 该 bank 到组内 refund 的 minDayDiff** 判，去顺序依赖 |
| **报错后复用**（Q15） | S1~S3 多笔报错卷入的 refund 仍被同组其他 bank 经 S4 静默吃掉 | b1 命中两 refund 报错后，其 refund 被 b2 经 S4 回填 | Q15：报错链路 refund **锁定**，退出 S4 |

### 7.2 目标算法：runStrategiesForGroup 改为「按策略批量解析」

对每个唯一值分组，按 S1→S2→S3 顺序（命中即停仍是 per-bank），**每个策略批量解析**而非逐 bank 顺序消费：

```
对策略 strat ∈ [S1, S2, S3]：
  unsettledBanks = 本组未 settle（未回填/未报错）的 bank
  availRefunds   = 本组未消费(usedRefundIdx) 且 未锁定(lockedRefundIdx) 的 refund
  # 1) 对同一快照 availRefunds 批量算命中图（不要边算边消费）
  hitsByBank = { bank: strat(bank, availRefunds) 命中的 refund 集合 }
  # 2) 反向聚合
  hittersByRefund = { refund: 命中它的 bank 集合 }
  # 3) 逐 bank 定性（同一快照下）：
  for bank in unsettledBanks (保持原 BillDate 升序):
    deg = |hitsByBank[bank]|
    if deg == 0: 不动（进下一策略）
    elif deg > 1: bank→报错-人工介入(forward 多笔)，settle；其命中的 refund 计入「待锁定」
    else: # deg == 1
      r = 唯一命中 refund
      if |hittersByRefund[r]| > 1: bank→报错-人工介入(reverse 多笔, Q14)，settle；r 计入「待锁定」
      else: bank 与 r 唯一互配 → 回填，consume(bank + r)   # 仅当严格 1↔1 互配才回填
  # 4) 锁定：本策略所有「待锁定」refund 加入 lockedRefundIdx（Q15：退出后续策略 + S4）
```
> 关键：**仅「某 bank 唯一命中某 refund 且该 refund 也仅被该 bank 命中」才回填**；任一方向多笔 → 涉事 bank 报错、相关 refund 锁定。这样正向（基数2「1 bank→N refund」）与反向（基数3/4「N bank→1 refund」）都收敛正确，且保留 §2 所有 MATCH 格（基数1/2、JPM）。

### 7.3 S4 兜底改造（Q13/Q15）
```
refundsForS4 = 本组未消费且未锁定的 refund  # S4 入口冻结快照
orderedBank  = 未 settle bank 按 BillDate 升序
for bank in orderedBank:
  inTol = refundsForS4 中【仍未被本轮 S4 消费】且 dayDiffWithin(bank.BillDate, r.valueDate, 10) 的 r
  if inTol 非空: 取 minDayDiff 最近一条回填，consume
  else:
    minDiff = bank 到 refundsForS4【冻结全集】所有 r 的 min |BillDate-valueDate|（天）
    if refundsForS4 非空 且 minDiff > 10: → 报错-人工介入（日期超容差，Q13；每条各一行 G1）
    else: → 未匹配-提示（关联不到 / 多出 bank 抢不到，非脏数据）
# 收尾：未消费且未锁定的 refund → 未匹配-提示（锁定的 refund 不再产收尾提示，已在报错行体现）
```
> 🔴 S4 报错/提示判据 = 该 bank 到**冻结全集** refundsForS4 的 minDayDiff 是否 >10（>10→报错；≤10 但被抢光→提示；冻结全集空→提示）。**绝不**用消费后的实时候选数判定（那是顺序依赖根因）。

### 7.4 JPM 同源
JPM-HK/US 走 S2→matchS2，命中后同样进 7.2 批量解析。HK 多 bank 提同一 T54SWIC + 1 refund 的反向多笔，与 D2 同根因 → 7.2 自动覆盖。须补 JPM 反向多笔单测。

### 7.5 必补单测（在原引擎单测基础上增量）
- 反向多笔 S1/S2/S3：N bank→同 1 refund → 全部报错-人工介入、backfillRows=0、refund 不出现在回填、且**不被 S4 复用**（Q14+Q15 联合断言）。
- S4 顺序无关：上表 b1/b2/b3 复现输入 → b1 回填、b2/b3 各一行报错（不随 bank 数组顺序改变结论；可打乱输入顺序断言一致）。
- S4 「在容差但被抢光」→ 提示（区别于超容差报错）：5 bank 全在容差 + 1 refund → 1 回填 + 4 提示（非报错）。
- 锁定不复用：S1 多笔报错的 refund，构造一个本可经 S4 匹配的 bank → 断言它**不**被回填、落提示。
- 保留回归：原 62 例全绿；基数1/2、JPM-HK/US、数据筛选、收尾、输出结构不变。
