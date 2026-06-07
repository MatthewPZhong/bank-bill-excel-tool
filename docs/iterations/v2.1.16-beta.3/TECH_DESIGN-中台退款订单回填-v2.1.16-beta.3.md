# TechDoc - 网银账单小助手 v2.1.16-beta.3 ③「中台退款订单回填引擎」

| 项目 | 内容 |
|------|------|
| 版本 | v2.1.16-beta.3 |
| 日期 | 2026-06-07 |
| 作者 | PM（代 Dev 出设计稿，本版只设计不实现） |
| 状态 | 定稿（设计蓝本；12 条歧义已由用户逐条确认，详见 PRD §九；进入实现版本以此为准） |
| 关联 PRD | `docs/iterations/v2.1.16-beta.3/PRD-中台退款订单回填-v2.1.16-beta.3.md`（24 条 AC；§九 已确认决议） |
| 依赖 | R5 编排器 `reconciliation-orchestrator.js`、范式引擎 `r5-fund-transfer-backfill.js` / `r5-platform-inbound-cleanup.js`、`engine-utils.js` / `engine-date-utils.js`、C1 `buildFeatureRegex`、② `linked_bank_deposit`、① `channel_enum_values` |

> 🔴 本文件是**设计蓝本**，不含可直接合并的实现代码。文中 JS 片段为**设计示意（伪代码 / 骨架）**，标注「示意」，进入实现版本时由 dev 落地并补单测。**本版不碰 `src/`。**
>
> ✅ **12 条语义歧义已全部确认（2026-06-07）**：本文原标注「待确认 Qx」之处均已按 PRD §九「已确认决议」回写为最终实现契约。进入实现版本直接以本文 + PRD §九 为准。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1.3 统一回填动作 | 可落地。仿场景3 产出独立行集合（不改 bankRows）；5 个写入项均为确定字段映射 |
| §5.2 决策矩阵 4×4 | 可落地（✅ Q1/Q3/Q9/Q10 已确认，详见 PRD §九）。建议把「基数判定 + 单/多笔分支 + 报错/提示分类」抽成统一函数，4 策略共用，避免 16 格各写一遍 |
| §5.5.1 JPM-HK 提取 | 可落地（✅ Q7 已确认：提取后仅与 refund order「银行打款流水号」单字段等值匹配）。`buildFeatureRegex` 实测可直接复用生成 `/T54SWIC\d{6}/`（见 §6） |
| §5.5.2 JPM-US 二跳 | 可落地（✅ Q8 已确认：跳2 = OR，「关联到的 refund order」= S1 关联出的那条）。入金表 `linked_bank_deposit` 含 ReconciliationId/ChannelOrderNo/CustomerRef（C~N 内），可建内存索引 |
| §5.1.5 双 sheet 导出 | 可落地。仿 `platform-cleanup-writer.js` 新增 `refund-backfill-writer.js`，写两个 sheet |
| §六 集成 R5 场景4 | 可落地。`bucketScenarios` 加一桶 + `runReconciliation` 加一调度块 + 返回新增 `refundBackfillRows` 字段；与场景2/3 数据隔离（各自独立 pool / usedBankRowId） |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 🔴 | 跨表字段映射若假设同名必错（银行驼峰 / refund order 中文 / 入金表驼峰）| §4 定义**显式跨表字段映射常量**，全程按常量 pick，仿 `r5-fund-transfer-backfill.js` 文件头注释风格 |
| R-2 🔴 | 16 格 + JPM 矩阵若散写，多笔/报错/提示规则极易漏 | §5.3 统一 `classifyCardinality` + `resolveMatch` 抽象，矩阵收敛为「策略 × (基数, 关联结果计数)」查表 |
| R-3 🔴 | 金额「精确到分」与场景2 一致；唯一值「金额」= 银行发生额绝对值 ↔ refund order 退款金额 | ✅ Q1 已确认：bank 侧 `\|Credit Amount − Debit Amount\|` ↔ refund order `退款金额`（非原加款金额）；金额比对复用场景2 `Math.round(x*100)` 口径 |
| R-4 🟠 | 「报错人工介入」与「不更新并提示」是两类输出，若用同一 warning code 会混淆 | §5.4 定义两类独立标记（`error-manual` / `notice-unmatched`），sheet2 用「结果类型」列区分（✅ PRD Q5 已确认） |
| R-5 🟠 | JPM-HK「清洗 //」对标准 T54SWIC 非必需（实测），可能存在脏形态才需 | ✅ Q7 已确认：保留清洗 `split('//').join('')`（无副作用，防 `//` 切断流水号脏形态），在注释标明实测结论 |
| R-6 🟠 | refund order 数据来源是预加工 session（非链接表），入金表是链接表，两套读法 | §2 数据流明确两个来源；引擎入参解耦（只收 rows 数组，不在引擎内读 DB/session）|
| R-7 🟡 | 「命中即停」若未定义，策略可能重复回填同一 refund order | ✅ Q3 已确认：按 S1→S4 命中即停（报错亦停于该策略），消费 usedBankRowId + usedRefundId 双向 |
| R-8 🟡 | refund order「状态=SUCCESS」是否回写持久层 | ✅ Q11 已确认：只体现在导出模板，不回写 session/DB（不改 bankRows，独立模板行集合） |

### 1.3 与 PRD 的差异

- 无功能性差异。技术上把 PRD 的 16 格矩阵 + JPM 收敛为「映射常量 + 基数分类器 + 策略匹配器 + 结果分类器」四件套，行为与 PRD 决策矩阵逐格等价（实现时以 PRD §5.2 表为验收基线）。

---

## 二、涉及的文件清单（实现版本规划，本版不落地）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/scenario-engines/r5-refund-order-backfill.js` | 新增 | 退款回填引擎主体（映射常量 + 数据筛选 + 基数分类 + 4 策略 + JPM HK/US + 结果分类）🔴 |
| `src/constants/refund-backfill-fields.js` | 新增 | 跨表字段映射常量 + 回填模板列定义 + 提取参数（MTX/T54SWIC）单一真相 |
| `src/main-process/refund-backfill-writer.js` | 新增 | 双 sheet writer（sheet1 模板 E 列详情 + F 起原数据 / sheet2 未匹配+报错），仿 `platform-cleanup-writer.js` 🔴 |
| `src/main-process/reconciliation-orchestrator.js` | 修改 | `bucketScenarios` 加 `r5s4` 桶；`runReconciliation` 加场景4 调度块；返回新增 `refundBackfillRows` / `refundUnmatchedRows` 🔴 |
| `src/main-process/scenario-engines/engine-utils.js` | 修改（可选）| 把 `bankAmountAbs` 从场景2 上提共享（或新建引擎内同口径函数）|
| `src/backend/database/migrations.js` | 修改 | `ensureReconRoundBuiltinScenariosSeed` 增 1 条 builtin-fixed（`subCategory='refund-order-backfill'`，默认 enabled=false，幂等）🔴 |
| `src/main.js` | 修改 | `bank-statement:run` 给场景4 传 refund order rows（预加工 session）+ 入金表 rows（`readLinkedTableRows('bank-deposit')`）；`bank-statement:export` 接退款回填双 sheet 导出。⚠️ 含 NUL，grep 须 `-a` 🔴 |
| `src/renderer.js`（前端）| 修改 | 启用退款回填 + 导入未带 refund order 表 → 弹提醒（仿 `maybePromptGatewayReconImport`）|
| `tests/unit/main-process/scenario-engines/r5-refund-order-backfill.test.js` | 新增 | 16 格矩阵 + JPM HK/US + 数据筛选 + 命中详情 + 1v1 消费单测 |
| `tests/unit/.../refund-backfill-writer.test.js` | 新增 | 双 sheet 结构 + E/F 列断言 |

> 本版只产出本表作为实现规划，不实际改动任何文件。

---

## 三、需求 1：中台退款订单回填引擎

### 3.1 实现方案

**总体结构（四件套）**：

```
r5-refund-order-backfill.js
  ├── 数据筛选        filterRefundOrders(SUBMITTED) / filterBankAchReturn(未改写 FundType)
  ├── 唯一值分组      groupByUniqueKey(rows)  →  Map<"大账号|金额|币种", rows[]>
  ├── 基数分类        classifyCardinality(bankGroup, refundGroup) → '1:1'|'1:N'|'N:1'|'N:N'
  ├── 策略匹配        S1/S2/S3/S4 各一个 matcher，输入 (bankGroup, refundGroup) 输出关联结果
  ├── JPM 分支        jpmHkMatch / jpmUsMatch（叠加在 S2 上，按 bank.Channel/地区 触发）
  ├── 结果分类        resolveMatch(cardinality, matchResult) → 回填 | 报错人工介入 | 不更新并提示
  ├── 回填动作        applyBackfill(refundRow, bankRow) → 回填模板行（含 E 列详情）
  └── 收集器          warningCollector + 独立 backfillRows + unmatchedRows
```

**为什么这样**：

- **收敛矩阵**：PRD 的 4 基数 × 4 策略 = 16 格，若散写则多笔/报错/提示规则极易漏且难维护。抽成「基数分类器 + 策略匹配器 + 结果分类器」后，16 格收敛成「按 (基数, 关联到的条数) 查结果分类表」，新增基数/策略只改表。
- **复用范式**：严格遵循 `r5-fund-transfer-backfill.js` 的范式（显式映射注释 / 金额精确到分 / 日期两阶段 / 严格 1v1 / warning+modification 收集器）与 `r5-platform-inbound-cleanup.js` 的「独立行集合 + 独立 writer」范式。
- **数据隔离**：引擎纯函数，入参 `(bankRows, refundOrderRows, depositRows, options)`，不读 DB / session（由 main.js 注入），与场景2/3 各自独立 `usedBankRowId`，互不串池（编排器层面也分别调度）。

**为什么不用其他方案**：

- 不并入场景2/3：业务语义、产物（双 sheet）、匹配策略完全不同，并入会污染既有红线引擎。
- 不在引擎内读 DB：破坏可测性（场景2/3 均为纯函数单测），且 refund order 来源是 session、入金表是链接表，读法不同。

### 3.2 改动点（实现版本规划）

| 文件 | 位置 | 改动内容 |
|------|------|---------|
| `r5-refund-order-backfill.js` | 新建 | 主函数 `runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options)` |
| `refund-backfill-fields.js` | 新建 | `REFUND_BACKFILL_FIELD_MAP` / `REFUND_TEMPLATE_HEADERS` / `MTX_FEATURE` / `T54SWIC_FEATURE` |
| `reconciliation-orchestrator.js` | `bucketScenarios`（:51）| 加分支：`builtin-fixed + funcCategory='platform-order' + subCategory='refund-order-backfill'` → `r5s4` |
| `reconciliation-orchestrator.js` | `runReconciliation`（:149）| R5 场景3 之后加场景4 调度块；返回对象加 `refundBackfillRows` / `refundUnmatchedRows` |
| `migrations.js` | `ensureReconRoundBuiltinScenariosSeed` | 插 1 条 seed（幂等定位键 `config_json LIKE '%"subCategory":"refund-order-backfill"%'`）|
| `main.js` | `bank-statement:run` | 取 refund order session rows + `readLinkedTableRows('bank-deposit')`，传引擎 |
| `main.js` | `bank-statement:export` | 调 `refund-backfill-writer` 落双 sheet 文件 |

### 3.3 代码示例（设计示意，非最终实现）

> 以下均为**设计骨架**，标注「示意」。进入实现版本由 dev 落地 + 补单测。

#### 3.3.1 跨表字段映射常量（`refund-backfill-fields.js`，示意）

```javascript
// 【示意】v2.1.16-beta.3+ R5 场景4 中台退款订单回填 —— 跨表字段映射单一真相
//
// 🔴 跨表字段（显式映射，绝不假设同名 —— 仿 r5-fund-transfer-backfill.js 文件头风格）：
//   银行对账单（bank statement，驼峰）：
//     bank.Channel                  渠道（JPM 判定）
//     bank['地区']                  地区（HK / US 判定）
//     bank.MerchantId               商户 ID（✅ Q1：唯一值「渠道大账号」取此列 ↔ refund order 银行大账号）
//     bank.Currency                 币种（唯一值之一）
//     bank['Credit Amount'] + bank['Debit Amount']  发生额绝对值=|credit-debit|（✅ Q1：唯一值金额 ↔ refund order 退款金额）
//     bank.ReconciliationId         对账ID（→ 回填模板「渠道流水号」）
//     bank.ChannelOrderNo           渠道订单号（S1 被查字段之一）
//     bank.CustomerRef              客户参考（S1 被查字段之一 / JPM-US 最终比对字段）
//     bank['Extra Information']     附加信息（S2 提取 MTX / JPM-HK 提取 T54SWIC 源）
//     bank['Payment Detail']        付款明细（JPM-HK 提取 T54SWIC 源之二）
//     bank['Drawee Name']           付款人名称（S3 被查字段）
//     bank['Drawee CardNo']         付款人卡号（S3 被查字段）
//     bank['Payee CardNo']          收款人卡号（S3 虚拟卡号被查字段）
//     bank.BillDate                 账单日期（→ 回填模板「渠道退款时间」/ S4 日期比对）
//     bank.FundType                 资金性质（筛选 Ach Return；R4 改写过的排除，Q2）
//     bank._rowId                   行唯一键（上游注入，全局唯一；严格 1v1 消费）
//   中台退款订单（refund order，中文）：
//     ro['流水号']                  退款单流水号（→ 回填模板「退款单号」）
//     ro['银行打款流水号']          S1 关联ID / JPM-HK 等值匹配字段 / JPM-US 二跳起点
//     ro['附言']                    S2 MTX 匹配（包含匹配，✅ Q6）
//     ro['付款人名称']              S3 关联ID（✅ Q8b 按位 ↔ bank Drawee Name）
//     ro['付款卡号']                S3 关联ID（✅ Q8b 按位 ↔ bank Drawee CardNo）
//     ro['虚拟卡号']                S3 关联ID（✅ Q8b 按位 ↔ bank Payee CardNo）
//     ro['银行大账号']              唯一值「渠道大账号」（✅ Q1 ↔ bank.MerchantId）
//     ro['退款金额']                唯一值金额（✅ Q1，本场景取退款金额，非原加款金额）
//     ro['原加款金额']             备选金额（✅ Q1 已确认不取此列，仅留作记录）
//     ro['币种']                    唯一值之一
//     ro['状态']                    SUBMITTED 参与 / 回填后 SUCCESS（idx14）
//     ro['valueDate']               起息日（S4 与 bank.BillDate 比对，idx23）
//   入金表（linked_bank_deposit，驼峰，仅 JPM-US）：
//     dep.ReconciliationId / dep.ChannelOrderNo  二跳匹配键
//     dep.CustomerRef                            二跳取值（→ 与 bank.CustomerRef 比对）

const { BANK_STATEMENT_FIELDS } = require('./bank-statement-fields');

const REFUND_BACKFILL_FIELD_MAP = Object.freeze({
  // —— 唯一值三元组（✅ Q1 已确认，详见 PRD §九）——
  uniqueKey: {
    bankAccount: 'MerchantId',     // bank 侧「渠道大账号」（✅ Q1：取 MerchantId，非关联大账号）
    roAccount: '银行大账号',       // refund order 侧
    bankCurrency: 'Currency',
    roCurrency: '币种',
    roAmount: '退款金额'           // refund order 金额（✅ Q1：退款金额，非原加款金额）
    // bank 金额 = |Credit Amount - Debit Amount|（函数计算，不是单列）
  },
  // —— 回填动作（§5.1.3）——
  backfill: {
    fromBankReconId: 'ReconciliationId',  // → 渠道流水号
    fromBankBillDate: 'BillDate',         // → 渠道退款时间
    fromRoSerialNo: '流水号',             // → 退款单号
    statusSuccess: 'SUCCESS'
  },
  // —— S1 渠道流水号 ——
  s1: { roKey: '银行打款流水号', bankFields: ['ChannelOrderNo', 'CustomerRef'] },
  // —— S2 附言 MTX ——
  s2: { bankExtract: 'Extra Information', roField: '附言' },
  // —— S3 付款人/卡号/虚拟卡号（✅ Q8b 已确认：按位对应，无交叉匹配）——
  s3: [
    { roKey: '付款人名称', bankField: 'Drawee Name' },
    { roKey: '付款卡号', bankField: 'Drawee CardNo' },
    { roKey: '虚拟卡号', bankField: 'Payee CardNo' }
  ],
  // —— S4 金额币种日期 ——
  s4: { bankDate: 'BillDate', roDate: 'valueDate', toleranceDays: 10 },
  // —— JPM ——
  jpm: {
    channelValue: 'JPM', regionField: '地区', hkRegion: 'HK', usRegion: 'US',
    hkCleanFields: ['Extra Information', 'Payment Detail'],
    hkRoKey: '银行打款流水号',                            // ✅ Q7：HK 提取 T54SWIC 后仅与此单字段等值匹配
    usRoKey: '银行打款流水号',
    usDepositKeys: ['ReconciliationId', 'ChannelOrderNo'], // ✅ Q8：OR（任一字段 == payNo 即命中）
    usDepositTake: 'CustomerRef', usBankCompare: 'CustomerRef'
  },
  // —— 筛选 ——
  filter: { roStatusField: '状态', roSubmitted: 'SUBMITTED', bankFundType: 'FundType', achReturn: 'Ach Return' }
});

// 回填模板 F 起银行字段（✅ Q4 已确认：只放这 9 列、按此顺序；非 44 列全列；金额列只有 Debit Amount、无 Credit Amount）
const REFUND_BANK_COLUMNS = Object.freeze([
  'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Debit Amount',          // ⚠️ 只放 Debit Amount，不放 Credit Amount
  'ReconciliationId', 'ChannelOrderNo', 'CustomerRef'
]);
// 启动期/单测断言：REFUND_BANK_COLUMNS 9 字段全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移，故仍 require 全集）
// if (REFUND_BANK_COLUMNS.some(f => !BANK_STATEMENT_FIELDS.includes(f))) throw ...

// 回填模板列（✅ Q4 已确认；现模板实测仅 A~D 4 列，E + F 起 9 字段为需求新增）
const REFUND_TEMPLATE_HEADERS = Object.freeze([
  '退款单号', '状态', '渠道流水号', '渠道退款时间', '匹配命中详情', // A~E
  ...REFUND_BANK_COLUMNS   // F~N：银行 9 字段原数据（按序，非全列）
]);

// 提取参数（复用 C1 buildFeatureRegex；实测见 TECH §6）
const MTX_FEATURE = Object.freeze({ featureCode: 'MTX', digitCount: 19, totalLength: 22 });       // → /MTX\d{19}/
const T54SWIC_FEATURE = Object.freeze({ featureCode: 'T54SWIC', digitCount: 6, totalLength: 13 }); // → /T54SWIC\d{6}/

module.exports = { REFUND_BACKFILL_FIELD_MAP, REFUND_BANK_COLUMNS, REFUND_TEMPLATE_HEADERS, MTX_FEATURE, T54SWIC_FEATURE };
```

#### 3.3.2 引擎主体骨架（`r5-refund-order-backfill.js`，示意）

```javascript
// 【示意】R5 场景4 中台退款订单回填引擎（🔴 资金红线）
//   纯函数：入参 rows 数组，不读 DB/session（由 main.js 注入）；与场景2/3 独立 usedBankRowId，不串池。
const { makeWarningCollector, normalizeCellValue, valuesEqual, parseNumber } = require('./engine-utils');
const { sameDay, dayDiffWithin, toDate } = require('./engine-date-utils');
const { buildFeatureRegex } = require('./c1-extract-recon-id');
const { REFUND_BACKFILL_FIELD_MAP: M, MTX_FEATURE, T54SWIC_FEATURE } = require('../../constants/refund-backfill-fields');

const MTX_RE = buildFeatureRegex(MTX_FEATURE);          // /MTX\d{19}/g
const T54SWIC_RE = buildFeatureRegex(T54SWIC_FEATURE);  // /T54SWIC\d{6}/g

// 银行发生额绝对值（与场景2 口径一致：|credit-debit|，任一非数值按 0）
function bankAmountAbs(b) {
  return Math.abs((parseNumber(b['Credit Amount']) || 0) - (parseNumber(b['Debit Amount']) || 0));
}

function runRound5RefundOrderBackfill(bankRows, refundOrderRows, depositRows, options = {}) {
  const warn = makeWarningCollector('r5-refund-order-backfill', '中台退款订单回填');
  const backfillRows = [];   // sheet1 模板行（含 E 列详情）
  const unmatchedRows = [];  // sheet2（报错人工介入 / 不更新并提示，用 resultType 区分）

  // 1) 数据筛选（§5.1.2）
  const ro = (refundOrderRows || []).filter(r => normalizeCellValue(r[M.filter.roStatusField]) === M.filter.roSubmitted);
  const isFundTypeChanged = options.isFundTypeChanged || (() => false); // 由编排器注入（Q2：modCols 含 FundType）
  const bank = (bankRows || []).filter(b =>
    normalizeCellValue(b[M.filter.bankFundType]) === M.filter.achReturn && !isFundTypeChanged(b._rowId));

  // 2) 唯一值分组（Q1）
  const keyOf = (account, currency, amountCents) => `${account}||${currency}||${amountCents}`;
  const bankGroups = groupBy(bank, b =>
    keyOf(normalizeCellValue(b[M.uniqueKey.bankAccount]), normalizeCellValue(b[M.uniqueKey.bankCurrency]),
          Math.round(bankAmountAbs(b) * 100)));
  const roGroups = groupBy(ro, r =>
    keyOf(normalizeCellValue(r[M.uniqueKey.roAccount]), normalizeCellValue(r[M.uniqueKey.roCurrency]),
          Math.round((parseNumber(r[M.uniqueKey.roAmount]) || NaN) * 100)));

  const usedBankRowId = new Set();   // 严格 1v1（与场景2/3 独立）
  const usedRefundId = new Set();    // refund order 也只回填一次

  // 3) 对每个唯一值分组：基数分类 → 策略 S1→S4 命中即停（Q3）
  for (const [key, bankGroup] of bankGroups) {
    const refundGroup = roGroups.get(key) || [];
    if (refundGroup.length === 0) continue; // 一侧为空 → 该组无可对账（按需也可计入 unmatched）
    const cardinality = classifyCardinality(bankGroup.length, refundGroup.length); // '1:1'|'1:N'|'N:1'|'N:N'
    runStrategies(cardinality, bankGroup, refundGroup, { usedBankRowId, usedRefundId, depositRows, warn, backfillRows, unmatchedRows });
  }

  return { backfillRows, unmatchedRows, modifications: [], warnings: warn.list() };
}
```

#### 3.3.3 基数分类 + 结果分类（示意）

```javascript
// 【示意】基数分类
function classifyCardinality(bankCount, refundCount) {
  const b = bankCount > 1 ? 'N' : '1';
  const r = refundCount > 1 ? 'N' : '1';
  return `${b}:${r}`;
}

// 【示意】结果分类查表（PRD §5.2 逐格规则的统一收敛）
//   入参：策略、基数、关联结果（关联到的银行条数 / refund 条数 / 关联ID自身条数）
//   出参：'backfill' | 'error-manual' | 'notice-unmatched'
// 注：S1~S3 共用「单笔关联→回填 / 多笔→报错 / 关联不到→提示」骨架；
//     基数为 N:N 时叠加「关联ID自身多笔也报错」；具体阈值依 PRD 表逐格（✅ Q9 基数2-S3「多笔报错、一笔回填」/ ✅ Q10 N:N 条数相等按 BillDate 早→晚 1v1）。
function resolveMatch(strategy, cardinality, counts) {
  // counts = { idCount, bankHit, refundHit }
  if (counts.idCount > 1) return 'error-manual';           // 关联ID本身多笔（如银行打款流水号多笔）
  if (counts.bankHit > 1 || counts.refundHit > 1) return 'error-manual'; // 关联到多笔
  if (counts.bankHit === 1 && counts.refundHit === 1) return 'backfill';
  return 'notice-unmatched';                                // 关联不到
}
```

#### 3.3.4 S2 + JPM 提取（示意，复用 buildFeatureRegex）

```javascript
// 【示意】提取工具：在文本里 matchAll 指定 feature regex，返回去重命中数组
function extractFeature(text, re) {
  const s = normalizeCellValue(text);
  if (!s) return [];
  const fresh = new RegExp(re.source, 'g'); // 避免 lastIndex 副作用（同 C1）
  return Array.from(new Set((s.match(fresh) || [])));
}

// 【示意】S2：银行 Extra Information 提 MTX → 与 refund order 附言匹配（✅ Q6 已确认：包含匹配）
function s2MtxMatch(bankRow, refundRow) {
  const mtxList = extractFeature(bankRow[M.s2.bankExtract], MTX_RE);
  const memo = normalizeCellValue(refundRow[M.s2.roField]);
  return mtxList.some(mtx => memo.includes(mtx)); // ✅ Q6：附言.includes(mtx) 包含匹配（非等值）
}

// 【示意】JPM-HK：清洗 // → 提 T54SWIC → 仅与 refund order「银行打款流水号」单字段等值匹配（✅ Q7 已确认）
function jpmHkMatch(bankRow, refundRow) {
  const clean = (v) => normalizeCellValue(v).split('//').join(''); // ✅ Q7：保留清洗（无副作用，§6 实测；防 // 切断流水号脏形态）
  const swicList = [
    ...extractFeature(clean(bankRow[M.jpm.hkCleanFields[0]]), T54SWIC_RE),
    ...extractFeature(clean(bankRow[M.jpm.hkCleanFields[1]]), T54SWIC_RE)
  ];
  if (swicList.length === 0) return null;
  const payNo = normalizeCellValue(refundRow[M.jpm.hkRoKey]); // refund order「银行打款流水号」
  for (const swic of swicList) {
    if (swic === payNo) return { swic };                    // ✅ Q7：单字段等值命中（不再遍历 25 列）
  }
  return null;
}

// 【示意】JPM-US：refund order 银行打款流水号 → 入金表 ReconId/ChannelOrderNo（OR）→ 取 CustomerRef → 比对银行 CustomerRef
//   refundRow = 当前唯一值分组下 S1 关联出的那条 refund order（✅ Q8 已确认指代）
function jpmUsMatch(bankRow, refundRow, depositRows) {
  const payNo = normalizeCellValue(refundRow[M.jpm.usRoKey]);
  if (!payNo) return null;
  const dep = (depositRows || []).find(d =>                  // ✅ Q8 已确认：OR（任一字段 == payNo 即命中）
    M.jpm.usDepositKeys.some(k => normalizeCellValue(d[k]) === payNo));
  if (!dep) return null;
  const depRef = normalizeCellValue(dep[M.jpm.usDepositTake]);
  if (depRef !== '' && depRef === normalizeCellValue(bankRow[M.jpm.usBankCompare])) {
    return { depCustomerRef: depRef };                       // 命中
  }
  return null;
}
```

#### 3.3.5 命中详情 + 回填动作（示意）

```javascript
// 【示意】匹配命中详情（§5.1.4 两句式，✅ Q12 文案已定稿）
function detailBankToRo(bankField, bankVal, roField, roVal) {
  return `匹配成功:"银行对账单${bankField}里的${bankVal}"匹配上了"refund order${roField}的${roVal}"`;
}
function detailBankToDeposit(bankField, bankVal, depField, depVal) {
  return `匹配成功:"银行对账单${bankField}里的${bankVal}"匹配上了"银行对账单入金表${depField}的${depVal}"`;
}

// 【示意】回填动作（§5.1.3）→ 产出 sheet1 模板行（不改 bankRows；✅ Q11 已确认：不回写持久层）
function applyBackfill(refundRow, bankRow, detailText) {
  return {
    '退款单号': normalizeCellValue(refundRow[M.backfill.fromRoSerialNo]),
    '状态': M.backfill.statusSuccess,
    '渠道流水号': normalizeCellValue(bankRow[M.backfill.fromBankReconId]),
    '渠道退款时间': bankRow[M.backfill.fromBankBillDate],
    '匹配命中详情': detailText,
    // F 起：配对银行行 9 字段原数据（✅ Q4：按 REFUND_BANK_COLUMNS 顺序，非 44 列；金额列只放 Debit Amount）
    ...pickBankColumns(bankRow) // pickBankColumns 仅 pick REFUND_BANK_COLUMNS 这 9 列
  };
}
```

### 3.4 注意事项（边界情况）

- **空入参**：`refundOrderRows` 空 / 无 `Ach Return` 银行行 → 返回空 `backfillRows`，不报错（仿场景2 空防御）。
- **lastIndex 副作用**：每次提取重建 `new RegExp(re.source, 'g')`（同 C1 `c1-extract-recon-id.js:66`），避免共享 regex 的 `lastIndex` 污染。
- **金额非数值**：refund order `退款金额` 非数值 → 唯一值 amountCents=NaN → 与银行侧无法分到同组（不误命中）。
- **日期非法**：`toDate` 返回 null → `sameDay`/`dayDiffWithin` 返回 false（S4 不命中），不抛异常。
- **JPM 优先级**：`Channel=JPM` 时在 S2「附言提取」策略上**叠加** JPM 链（PRD §5.5「在 S2 上叠加」）—— 实现：S2 内先跑 JPM 链（HK 提 T54SWIC 等值「银行打款流水号」/ US 二跳），未命中回落常规 MTX 包含匹配。
- **严格 1v1**：`usedBankRowId` + `usedRefundId` 双向消费，跨策略累积（命中即停后该 refund order / bank 行不再参与）。
- **结果分类两类输出**：`error-manual`（报错人工介入）与 `notice-unmatched`（不更新并提示）必须用不同标记落 sheet2（PRD Q5「结果类型」列）。

---

## 四、跨表字段映射常量（显式映射规范）🔴

> 仿 `r5-fund-transfer-backfill.js` 文件头「跨表字段（显式映射，绝不假设同名）」风格。三表大小写 / 语言不同，**禁止任何同名假设**。完整常量见 §3.3.1 `REFUND_BACKFILL_FIELD_MAP`。

| 用途 | 银行（驼峰） | refund order（中文） | 入金表（驼峰） |
|------|-------------|---------------------|---------------|
| 唯一值-大账号 | `MerchantId`(✅Q1) | `银行大账号` | — |
| 唯一值-金额 | `\|Credit Amount − Debit Amount\|` | `退款金额`(✅Q1，非原加款金额) | — |
| 唯一值-币种 | `Currency` | `币种` | — |
| 回填-渠道流水号 | `ReconciliationId` → | （目标列） | — |
| 回填-渠道退款时间 | `BillDate` → | （目标列） | — |
| 回填-退款单号 | ← | `流水号` | — |
| S1 关联 | `ChannelOrderNo` / `CustomerRef` | `银行打款流水号` | — |
| S2 提取/匹配 | `Extra Information`(提 MTX) | `附言`(包含匹配,✅Q6) | — |
| S3 关联（按位,✅Q8b） | `Drawee Name` / `Drawee CardNo` / `Payee CardNo` | `付款人名称` / `付款卡号` / `虚拟卡号` | — |
| S4 日期 | `BillDate` | `valueDate`(idx23) | — |
| JPM 判定 | `Channel` / `地区` | — | — |
| JPM-HK 提取 | `Extra Information` / `Payment Detail`(提 T54SWIC) | `银行打款流水号`(单字段等值,✅Q7) | — |
| JPM-US 二跳 | `CustomerRef`(最终比对) | `银行打款流水号`(起点) | `ReconciliationId` / `ChannelOrderNo`(OR 匹配键,✅Q8) → `CustomerRef`(取值) |

> ✅ 标 (✅Qx) 的映射均已由用户确认（详见 PRD §九）。常量 `uniqueKey.bankAccount='MerchantId'` / `uniqueKey.roAmount='退款金额'` 已定稿，引擎逻辑按此实现。

---

## 五、MTX / T54SWIC 提取规则（复用 C1 `buildFeatureRegex`）🔴

### 5.1 复用方案

C1 `buildFeatureRegex({featureCode, digitCount, totalLength})`（`c1-extract-recon-id.js:29`）生成 `/[A-Z]{englishExtraN}<featureCode>\d{digitCount}/g`，其中 `englishExtraN = totalLength − featureCode.length − digitCount`；`englishExtraN===0` 时退化为 `/<featureCode>\d{digitCount}/g`。

| 提取目标 | 参数 | 生成 regex | englishExtraN |
|---------|------|-----------|---------------|
| MTX 加款单（`MTX+19位数`）| `{featureCode:'MTX', digitCount:19, totalLength:22}` | `/MTX\d{19}/g` | 22−3−19 = 0 |
| T54SWIC 流水号（`T54SWIC+6位数`）| `{featureCode:'T54SWIC', digitCount:6, totalLength:13}` | `/T54SWIC\d{6}/g` | 13−7−6 = 0 |

### 5.2 实测证据（已在本机验证）

```
buildFeatureRegex({featureCode:'MTX',digitCount:19,totalLength:22}).source     === 'MTX\\d{19}'
buildFeatureRegex({featureCode:'T54SWIC',digitCount:6,totalLength:13}).source  === 'T54SWIC\\d{6}'

"付款备注 MTX1234567890123456789 其它".match(/MTX\d{19}/g)  → ["MTX1234567890123456789"]
"MTX123".match(/MTX\d{19}/g)                                 → null            （不足 19 位）
"//T54SWIC494447//ABC".match(/T54SWIC\d{6}/g)               → ["T54SWIC494447"] （含 // 直接命中）
"T54SWIC494447ABC".match(/T54SWIC\d{6}/g)                   → ["T54SWIC494447"] （清洗 // 后仍命中）
```

### 5.3 关键结论（✅ Q7 已确认）

⚠️ **`T54SWIC` 含数字 `54`，`//` 不影响 `/T54SWIC\d{6}/` 锚定**：标准形态 `//T54SWIC494447//` 即使**不清洗 `//`** 也能正确提取出 `T54SWIC494447`。需求【五】.1 的「先清洗 `//` 再提取」对标准形态非必需。

- ✅ Q7 已确认（落地契约）：**保留清洗** `split('//').join('')`（无副作用），提取出的 `T54SWIC` 流水号**仅与 refund order「银行打款流水号」单字段等值匹配**（`refundOrder['银行打款流水号'] === swicNo`），**不再遍历 refund order 其余字段**。
- ℹ️ 清洗保留的价值（背景注记）：防 `//` **切断**流水号的脏形态（如 `T54SWI//C494447`，清洗后才能拼回 `T54SWIC494447`）；标准形态下清洗无副作用。

### 5.4 与 C1 的差异

- C1 `findReconIdValueForRow`：多字段提取要求「值一致」否则 warn 跳过（同表内多字段一致性校验）。
- 本引擎：MTX/T54SWIC 提取后是**跨表比对**（与 refund order 字段比），不要求银行多字段一致；提取到多个值时逐个尝试匹配（任一命中即可）。故只复用 `buildFeatureRegex`，不复用 `findReconIdValueForRow` 整体。

---

## 六、R5 场景4 集成方案（orchestrator）🔴

### 6.1 分桶（`bucketScenarios`，:51）

现有 `bucketScenarios` 返回 `{r2, r4, r5s2, r5s3}`。新增 `r5s4` 桶：

```javascript
// 【示意】在 bucketScenarios 内 platform-inbound-cleanup 分支后加：
} else if (s.category === 'builtin-fixed' && fc === 'platform-order' && sub === 'refund-order-backfill') {
  r5s4.push(s);
}
// 返回 { r2, r4, r5s2, r5s3, r5s4 }
```

> seed config（`migrations.js` `ensureReconRoundBuiltinScenariosSeed`）插一条 `funcCategory='platform-order'` + `subCategory='refund-order-backfill'`，默认 `enabled=false`（与场景2/3 一致）。`r5s4` 空 = 未启用 → 该轮跳过（no-op），不影响现有对账。

### 6.2 调度块（`runReconciliation`，:149）

在「R5 场景3」块之后插入场景4 块，与场景2/3 **数据隔离**（独立 usedBankRowId、独立产物）：

```javascript
// 【示意】R5 场景4：中台退款订单回填（独立产物，不改 bankRows）
let refundBackfillRows = [];
let refundUnmatchedRows = [];
if (r5s4Bucket.length) {
  const opt = r5s4Bucket[0].config || {};
  // ✅ Q2 已确认：FundType 是否被改写 —— 复用 modColsByRowId（含 FundType 列即视为变更过）
  const isFundTypeChanged = (rowId) => {
    const cols = modColsByRowId.get(rowId);
    return !!(cols && cols.has('FundType'));
  };
  const r5d = runRound5RefundOrderBackfill(bankRows, opt.refundOrderRows, opt.depositRows, {
    isFundTypeChanged
  });
  // 本引擎不改 bankRows → 不 mergeMods（modifications 恒空，保留对称性）
  allWarnings.push(...(r5d.warnings || []));
  refundBackfillRows = r5d.backfillRows || [];
  refundUnmatchedRows = r5d.unmatchedRows || [];
}
// 返回对象新增：refundBackfillRows / refundUnmatchedRows + stats.r5s4BackfilledCount
```

> ⚠️ **数据来源注入**：`refundOrderRows`（预加工 session）与 `depositRows`（`readLinkedTableRows('bank-deposit')`）由 `main.js` 的 `bank-statement:run` 取好放进 r5s4 场景 config 或单独参数传入编排器（避免引擎读 DB/session，保持纯函数可测）。具体注入位置实现时定（建议加 `runReconciliation` 参数 `refundContext`，不塞进 scenario.config）。

### 6.3 数据隔离保证

| 隔离维度 | 措施 |
|---------|------|
| 银行行消费 | 场景4 独立 `usedBankRowId`（不与场景2/3 共享）；场景4 只读 bankRows，不改字段（不进 `modColsByRowId`，不影响标黄 / 行数守恒）|
| 数据池 | 场景4 自己按唯一值分组 + Ach Return 筛选；与场景2（FundTransfer）/ 场景3（Inbound-VA）的 FundType 池不重叠 |
| 产物 | 场景4 产 `refundBackfillRows` / `refundUnmatchedRows`，与场景3 `platformCleanupRows`、主输出 `modifiedRows`/`unmatchedRows` 各自独立 |
| 行数守恒 | 场景4 不改 bankRows → `buildOutputRows` 的 `modifiedRows + unmatchedRows == bankRows` 不变量不受影响 |

### 6.4 导出衔接（`main.js` `bank-statement:export`）

仿场景3 剔除导出：`refund-backfill-writer.js` 写双 sheet → 落同目录（主输出为空时落 `exportRootDir`）→ graceful 失败不阻塞主流程 → return 带退款回填文件路径。文件命名建议 `中台退款订单回填-YYYY_MM_DD_HHMM.xlsx`（仿 `buildPlatformCleanupFileName`）。

---

## 七、任务分解（实现版本规划，本版不执行）

> 本版交付 = 本设计文档。以下为后续实现版本的 task 蓝本（待 12 条歧义敲定后启动）。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 1 | 敲定 12 条歧义（Q1~Q12 + Q8b）| PRD §九 | 用户逐条确认 | ✅ done（2026-06-07 全部确认，详见 PRD §九） |
| 2 | 跨表映射常量 + 模板列 + 提取参数 | `refund-backfill-fields.js` | 单测：常量字段∈对应签名/BANK_STATEMENT_FIELDS | todo |
| 3 | 数据筛选 + 唯一值分组 + 基数分类 | `r5-refund-order-backfill.js` | 单测：SUBMITTED/Ach Return/未改写筛选、4 基数分类 | todo |
| 4 | S1~S4 策略匹配器 + 结果分类 | 同上 | 单测：16 格逐格（命中/报错/提示）| todo |
| 5 | JPM-HK / JPM-US 匹配链 | 同上 | 单测：HK 清洗提取→单字段等值「银行打款流水号」、US 二跳 OR、CustomerRef 比对 | todo |
| 6 | 命中详情 + 回填动作 | 同上 | 单测：两句式文案、回填 5 项映射 | todo |
| 7 | 双 sheet writer | `refund-backfill-writer.js` | 单测：E 列详情、F 起原数据、sheet2 报错/提示 | todo |
| 8 | orchestrator 集成（分桶+调度+产物）| `reconciliation-orchestrator.js` | 单测：r5s4 分桶、数据隔离、行数守恒不变 | todo |
| 9 | seed config（幂等）| `migrations.js` | 单测：幂等、默认禁用 | todo |
| 10 | main.js 注入 + 导出衔接 + 启用提醒 | `main.js` / `renderer.js` | 手测：导入提醒、端到端运行导出 | todo |

---

## 八、实施计划（Commit 粒度，实现版本规划）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `feat(v2.1.16-beta.x): 退款回填跨表映射常量 + 提取参数` | `refund-backfill-fields.js` | 1 |
| 2 | `feat(v2.1.16-beta.x): 退款回填引擎数据筛选/分组/基数分类` | `r5-refund-order-backfill.js` | 1 |
| 3 | `feat(v2.1.16-beta.x): 退款回填 4 策略匹配 + 结果分类` | 同上 | 1 |
| 4 | `feat(v2.1.16-beta.x): 退款回填 JPM HK/US 分支` | 同上 | 1 |
| 5 | `feat(v2.1.16-beta.x): 退款回填双 sheet writer` | `refund-backfill-writer.js` | 1 |
| 6 | `feat(v2.1.16-beta.x): orchestrator 集成 R5 场景4 + seed` | `reconciliation-orchestrator.js` / `migrations.js` | 1 |
| 7 | `feat(v2.1.16-beta.x): main.js 注入 + 导出衔接 + 启用提醒` | `main.js` / `renderer.js` | 1 |

> ⚠️ 实现版本提 PR 前必过 `/check-vars`：命中 `runReconciliation`（Critical）/ `bucketScenarios` / `FundType` / `BANK_STATEMENT_FIELDS`（Critical）/ scenarios seed 等。

---

## 九、实施日志

### 2026-06-07

- 动作：完成 ③ 退款回填引擎 PRD + TECH 设计稿（本版只设计不实现代码）。
- 证据：
  - 实测 `buildFeatureRegex` 生成 MTX/T54SWIC regex 并验证命中（§5.2）。
  - 实测回填模板现仅 4 列、refund order 25 列（与 `ZHONGTAI_REFUND_ORDER_SIGNATURE` 一致）。
  - 逐行核对 `reconciliation-orchestrator.js` / `r5-fund-transfer-backfill.js` / `r5-platform-inbound-cleanup.js` / `engine-utils.js` / `engine-date-utils.js` / `c1-extract-recon-id.js` / `bank-statement-fields.js` / `table-signatures.js`。
- 风险：🔴 4 基数×4 策略+JPM 矩阵任一映射错→错回填；12 条歧义已于 2026-06-07 全部确认（详见 PRD §九），本 TECH 已按最终值回写实现契约。
- 决策：把 16 格矩阵收敛为「映射常量 + 基数分类器 + 策略匹配器 + 结果分类器」四件套；引擎纯函数不读 DB/session（数据由 main.js 注入），与场景2/3 独立 usedBankRowId 数据隔离。

### 2026-06-07（回写定稿）

- 动作：12 条歧义经用户逐条确认后，将本 TECH 全文与 PRD §九「已确认决议」对齐。
- 关键回写：
  - ✅ Q1：`uniqueKey.bankAccount` 由 `'关联大账号'` 改为 `'MerchantId'`；金额 ↔ refund order `退款金额`。
  - ✅ Q4：回填模板 F 起由 `...BANK_STATEMENT_FIELDS`（44 列全列）改为 `REFUND_BANK_COLUMNS` 9 字段（只含 Debit Amount、无 Credit Amount）。
  - ✅ Q7：JPM-HK 由「遍历 refund order 所有字段」改为「仅与『银行打款流水号』单字段等值匹配」；清洗 `split('//').join('')` 保留。
  - ✅ Q8：JPM-US 跳2 = OR（ReconciliationId 或 ChannelOrderNo == payNo）；「关联到的 refund order」= S1 关联那条。
  - ✅ Q2/Q3/Q5/Q6/Q8b/Q9/Q10/Q11/Q12 + 场景4 默认禁用：正文「待确认/Q?待定」标注统一改为「✅ 已确认（详见 PRD §九）」。
- 状态：文档头由「初稿」改为「定稿」。

### 可沉淀知识

- [ ] `buildFeatureRegex` 可作通用「前缀+定长数字」提取器复用（MTX/T54SWIC/未来同类编码）—— 值得沉淀到 `knowledge/`。
- [ ] `T54SWIC` 含数字使 `//` 清洗对标准形态非必需 —— 提取 regex 设计经验，记 `knowledge/`。

---

## 十、Open Technical Questions

> 12 条语义歧义（Q1~Q12 + Q8b）已由用户在 **PRD §九「已确认决议」**全部确认（2026-06-07），本 TECH 已据此回写。以下仅剩**实现层技术选型**（不影响业务语义，dev 落地时定）：

1. **数据注入方式**：refund order rows / 入金表 rows 经 `runReconciliation` 新参数 `refundContext` 传入，还是塞进 scenario.config？建议新参数（保持 config 是纯配置，不混运行时数据）。
2. **JPM 链与 S2 的代码组织**：业务上已定为「在 S2 上叠加」（✅ PRD §5.5）—— S2 内先跑 JPM 链（HK 等值「银行打款流水号」/ US 二跳），未命中回落常规 MTX 包含匹配。剩余仅代码组织选择（独立函数 vs S2 内联），不影响行为。
3. **bankAmountAbs 共享**：从 `r5-fund-transfer-backfill.js` 上提到 `engine-utils.js` 共享，还是引擎内各持一份？建议上提共享（两处口径必须一致，避免漂移）。
4. **refund order 状态回写**：业务上已定为 SUCCESS 只体现在导出模板、不回写 session/DB（✅ Q11 已确认）。剩余仅「未来若需回写持久层」的幂等/回滚评估，本版不涉及。
