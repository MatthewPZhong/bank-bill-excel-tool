// v2.1.16-beta.4 ③ R5 场景4「中台退款订单回填」—— 跨表字段映射单一真相（🔴 资金红线）
// PRD-中台退款订单回填-v2.1.16-beta.3 §5.1.3/§5.1.5/§5.2/§5.5/§九（12 条已确认决议）
// TECH_DESIGN-中台退款订单回填-v2.1.16-beta.3 §3.3.1
//
// 🔴 跨表字段（显式映射，绝不假设同名 —— 仿 r5-fund-transfer-backfill.js 文件头风格）：
//   银行对账单（bank statement，驼峰）：
//     bank.Channel                  渠道（JPM 判定）
//     bank['地区']                  地区（HK / US 判定）
//     bank.MerchantId               商户 ID（✅Q1：唯一值「渠道大账号」取此列 ↔ refund order 银行大账号）
//     bank.Currency                 币种（唯一值之一）
//     |bank['Credit Amount'] - bank['Debit Amount']|  发生额绝对值（✅Q1：唯一值金额 ↔ refund order 退款金额）
//     bank.ReconciliationId         对账ID（→ 回填模板「渠道流水号」）
//     bank.ChannelOrderNo           渠道订单号（S1 被查字段之一）
//     bank.CustomerRef              客户参考（S1 被查字段之一 / JPM-US 最终比对字段）
//     bank['Extra Information']     附加信息（S2 提取 MTX / JPM-HK 提取 T54SWIC 源）
//     bank['Payment Detail']        付款明细（JPM-HK 提取 T54SWIC 源之二）
//     bank['Drawee Name']           付款人名称（S3 被查字段）
//     bank['Drawee CardNo']         付款人卡号（S3 被查字段）
//     bank['Payee CardNo']          收款人卡号（S3 虚拟卡号被查字段）
//     bank.BillDate                 账单日期（→ 回填模板「渠道退款时间」/ S4 日期比对）
//     bank.FundType                 资金性质（筛选 Ach Return；R4 改写过的排除，✅Q2）
//     bank._rowId                   行唯一键（上游注入，全局唯一；严格 1v1 消费）
//   中台退款订单（refund order，中文，ZHONGTAI_REFUND_ORDER_SIGNATURE 25 列）：
//     ro['流水号']                  退款单流水号（→ 回填模板「退款单号」，idx0）
//     ro['银行打款流水号']          S1 关联ID / JPM-HK 等值匹配字段 / JPM-US 二跳起点（idx22）
//     ro['附言']                    S2 MTX 匹配（包含匹配，✅Q6，idx13）
//     ro['付款人名称']              S3 关联ID（✅Q8b 按位 ↔ bank Drawee Name，idx10）
//     ro['付款卡号']                S3 关联ID（✅Q8b 按位 ↔ bank Drawee CardNo，idx11）
//     ro['虚拟卡号']                S3 关联ID（✅Q8b 按位 ↔ bank Payee CardNo，idx6）
//     ro['银行大账号']              唯一值「渠道大账号」（✅Q1 ↔ bank.MerchantId，idx5）
//     ro['退款金额']                唯一值金额（✅Q1，本场景取退款金额，非原加款金额，idx8）
//     ro['币种']                    唯一值之一（idx9）
//     ro['状态']                    SUBMITTED 参与 / 回填后 SUCCESS（idx14）
//     ro['valueDate']               起息日（S4 与 bank.BillDate 比对，idx23）
//   银行对账单入金表（linked bank-deposit，驼峰，仅 JPM-US 二跳用）：
//     dep.ReconciliationId / dep.ChannelOrderNo  二跳匹配键（OR，✅Q8）
//     dep.CustomerRef                            二跳取值（→ 与 bank.CustomerRef 比对）

const { BANK_STATEMENT_FIELDS } = require('./bank-statement-fields');
// O4：REFUND_RO_COLUMNS ⊆ 中台退款订单 25 列签名 启动断言用（依赖无环：table-signatures 仅 require bank-statement-fields）。
const { ZHONGTAI_REFUND_ORDER_SIGNATURE } = require('./table-signatures');

const REFUND_BACKFILL_FIELD_MAP = Object.freeze({
  // —— 唯一值三元组（✅Q1，详见 PRD §九）——
  uniqueKey: Object.freeze({
    bankAccount: 'MerchantId',     // bank 侧「渠道大账号」（✅Q1：取 MerchantId，非关联大账号）
    roAccount: '银行大账号',       // refund order 侧
    bankCurrency: 'Currency',
    roCurrency: '币种',
    roAmount: '退款金额'           // refund order 金额（✅Q1：退款金额，非原加款金额）
    // bank 金额 = |Credit Amount - Debit Amount|（函数计算，不是单列）
  }),
  // —— 回填动作（§5.1.3）——
  backfill: Object.freeze({
    fromBankReconId: 'ReconciliationId',  // → 渠道流水号
    fromBankBillDate: 'BillDate',         // → 渠道退款时间
    fromRoSerialNo: '流水号',             // → 退款单号
    statusSuccess: 'SUCCESS'
  }),
  // —— S1 渠道流水号 ——
  s1: Object.freeze({ roKey: '银行打款流水号', bankFields: Object.freeze(['ChannelOrderNo', 'CustomerRef']) }),
  // —— S2 附言 MTX ——
  s2: Object.freeze({ bankExtract: 'Extra Information', roField: '附言' }),
  // —— S2b 附言包含入金 CustomerRef（R2 新层，限 Channel=JPM；D6/D7 定稿）——
  //   二跳：ro 银行打款流水号 → 入金行(双键 OR) → dep.CustomerRef → 守卫 → bank 附言字段 .includes(ref)。
  //   守卫（必选，防占位短串大面积假命中）：非空 + 不在黑名单 + 长度 ≥ minRefLength。
  s2b: Object.freeze({
    memoFields: Object.freeze(['Payment Detail', 'Extra Information']), // bank 侧附言字段集（包含匹配）
    blacklist: Object.freeze(['NOTPROVIDED', 'NONREF']),                // D6：仅这两个占位词（用户确认无其他）
    minRefLength: 6                                                     // D6：最小长度阈值（双保险）
  }),
  // —— S3 付款人/卡号/虚拟卡号（✅Q8b：按位对应，无交叉匹配）——
  s3: Object.freeze([
    Object.freeze({ roKey: '付款人名称', bankField: 'Drawee Name' }),
    Object.freeze({ roKey: '付款卡号', bankField: 'Drawee CardNo' }),
    Object.freeze({ roKey: '虚拟卡号', bankField: 'Payee CardNo' })
  ]),
  // —— S3b（R5 新层，L5 精准）：Drawee Name + 附言 DESC DATE token ↔ 入金 ValueDate 二跳（D1/D2/D3 定稿）——
  //   D1：DESC DATE（非 ENTRY DATE），YYMMDD，世纪固定 20YY；D2：Drawee Name 仅作启用条件；D3：入金侧取 dep.ValueDate。
  //   datePattern=null → 整层 no-op（防御保留）。
  s3b: Object.freeze({
    draweeNameField: 'Drawee Name',                          // 启用条件字段（非空才进 S3b）
    memoFields: Object.freeze(['Payment Detail', 'Extra Information']), // 附言来源（提 DESC DATE）
    datePattern: /DESC\s*DATE\s*=\s*(\d{6})/,                // YYMMDD（取 DESC DATE）
    depositDateField: 'ValueDate'                            // 入金侧日期列（sameDay 比对）
  }),
  // —— S3c（R6 新层，L6 模糊）：附言 原单日期+金额+币种 三 token ↔ 入金表二跳（D4/D3/D5 定稿）——
  //   D4：原单日期 DTD mm/dd/yyyy（美式 MDY，解析见 parseDtdDateToken）、金额 FOR USD|AMT 数值、币种 USD；D5：不硬 gate dep.CustomerRef==NOTPROVIDED。
  //   任一 pattern=null → 整层 no-op（防御保留）。金额一律分比对（Math.round(amt*100)）。
  s3c: Object.freeze({
    memoFields: Object.freeze(['Payment Detail', 'Extra Information']),
    datePattern: /DTD\s*(\d{2}\/\d{2}\/\d{4})/,              // mm/dd/yyyy（美式 MDY，解析见 parseDtdDateToken）
    amountPattern: /FOR\s*(?:USD|AMT)\s*([0-9][0-9,]*(?:\.\d+)?)(?![\d,.])/, // Fix#3 codex: 捕获完整带千分位逗号金额（FOR USD5,043.00，非 5）
    currency: 'USD',                                          // 币种（实测 USD）
    depositDateField: 'ValueDate',
    depositAmountField: 'Credit Amount',                     // 入金行金额列（分比对）
    depositCurrencyField: 'Currency'
  }),
  // —— S4 金额币种日期（R4：单向 0≤bank.BillDate−ro.valueDate≤21；文案口径=退款提交日期（=底层 valueDate））——
  s4: Object.freeze({ bankDate: 'BillDate', roDate: 'valueDate', toleranceDays: 21 }),
  // —— JPM（§5.5）——
  //   refund-backfill-rules-v2 D8：CustomerRef 二跳键/取值/比对字段改中性名（HK R3 复用同一套二跳，us 前缀名不副实）。
  jpm: Object.freeze({
    channelValue: 'JPM', regionField: '地区', hkRegion: 'HK', usRegion: 'US',
    hkCleanFields: Object.freeze(['Extra Information', 'Payment Detail']),
    hkRoKey: '银行打款流水号',                                  // ✅Q7：HK 提取 T54[A-Z]{4} 后仅与此单字段等值匹配
    usRoKey: '银行打款流水号',                                  // JPM-US 二跳起点（= 银行打款流水号）
    // 二跳共用（matchCustomerRefTwoHop：US + R3 HK 回落）：入金行键 OR + 取 CustomerRef + 与 bank CustomerRef 比对。
    depositKeys: Object.freeze(['ReconciliationId', 'ChannelOrderNo']), // ✅Q8：OR（任一字段 == payNo 即命中）
    depositTake: 'CustomerRef', bankCompare: 'CustomerRef'
  }),
  // —— 筛选（§5.1.2）——
  filter: Object.freeze({
    roStatusField: '状态', roSubmitted: 'SUBMITTED',
    bankFundType: 'FundType', achReturn: 'Ach Return'
  })
});

// 回填模板银行字段段（✅Q4；v3.0.10：10→12，按 BANK_STATEMENT_FIELDS 模板序在原 10 列基础上插 'Extra Information' + 'Drawee Name'）。
//   金额列只有 Debit Amount、无 Credit Amount（资金红线）；'Payment Detail' 读银行退款行主表（44 列恒有，非入金行）。
//   列序锚 BANK_STATEMENT_FIELDS 下标：CustomerRef=idx13 → Extra Information=idx18 → Payment Detail=idx19 → Drawee Name=idx22；
//     故 'Extra Information' 插在 CustomerRef 后、Payment Detail 前；'Drawee Name' 接在 Payment Detail 后（末位，第 12 列）。
//   v3.0.10 新增两列用途：把 S2/JPM-HK/S3 等命中的银行字段纳入 sheet1 → 命中即标黄（之前 Extra Information/Drawee Name
//     虽进各 matcher 的 _matchedColumns 候选，但因不在 sheet1、被 buildBackfillRow 的交集过滤丢弃，无法标黄）。
const REFUND_BANK_COLUMNS = Object.freeze([
  'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Debit Amount',          // ⚠️ 只放 Debit Amount，不放 Credit Amount
  'ReconciliationId', 'ChannelOrderNo', 'CustomerRef',
  'Extra Information',     // v3.0.10 新增（第 10 列；插在 CustomerRef 后、Payment Detail 前；S2-MTX/JPM-HK/S2b/S3b/S3c 提取源，命中标黄）
  'Payment Detail',        // O3（第 11 列；R2/JPM-HK 提取源，配对银行行原值）
  'Drawee Name'           // v3.0.10 新增（第 12 列；S3 付款人名称按位被查字段，命中标黄）
]);

// 回填模板中台退款订单字段段（refund-backfill-rules-v2 O4：新增 15 列，按用户列序，取配对 ro 原值）。
//   ⚠️ 全部 ∈ 中台退款订单 25 列签名（ZHONGTAI_REFUND_ORDER_SIGNATURE）；'流水号' 与表头 A「退款单号」同值但分列（用户明确要求）。
const REFUND_RO_COLUMNS = Object.freeze([
  '流水号', '加款单号', '渠道名称', '银行大账号', '虚拟卡号',
  '原加款金额', '退款金额', '币种', '付款人名称', '付款卡号',
  '附言', '客户号', '账户号', '银行打款流水号', 'valueDate'
]);

// 回填模板列（v3.0.10：31→33 列 = 固定 6 列 + 银行 12 列 + 中台 15 列；银行段 10→12 见上方 REFUND_BANK_COLUMNS）。
//   A~F 固定：退款单号/状态/渠道流水号/渠道退款时间/命中类型/匹配命中详情（O1 新增「命中类型」列）。
const REFUND_TEMPLATE_HEADERS = Object.freeze([
  '退款单号', '状态', '渠道流水号', '渠道退款时间', '命中类型', '匹配命中详情', // 固定 6 列
  ...REFUND_BANK_COLUMNS,  // 银行 12 字段原数据（按序，非全列）
  ...REFUND_RO_COLUMNS     // 中台退款订单 15 字段原数据（取配对 ro 原值）
]);

// 提取参数（MTX 仍复用 C1 buildFeatureRegex；实测见 TECH §五）
const MTX_FEATURE = Object.freeze({ featureCode: 'MTX', digitCount: 19, totalLength: 22 });       // → /MTX\d{19}/

// refund-backfill-rules-v2 R1：JPM-HK「银行打款流水号」提取正则放宽（T54SWIC → T54+4字母+6数字）。
//   形态 = T54 + 4 字母 + 6 数字，总长 13；2026-06-15 真实数据实测前缀 T54SWIC/T54LCIC/T54CCBT（中段 SW/LC/CC，尾段 IC/BT）。
//   ⚠️ buildFeatureRegex 只能生成「[A-Z]{n} 前缀 + 特征码 + 数字」形态，表达不了「T54 + 任意 4 字母」→ 直写正则常量（不走 builder）。
//   旧 /T54SWIC\d{6}/ 是本正则真子集 → 存量零漏配；放宽只扩提取候选集，命中仍严格等值收口（matchJpmHk 不变）。
const T54_REFUND_RE = /T54[A-Z]{4}\d{6}/g;

// 启动期断言①：REFUND_BANK_COLUMNS 12 字段全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移，故仍 require 全集）。
//   任一漂移（重命名银行列 / 误把不存在的列放进银行段）→ 立刻 throw，避免静默回填错列。
const __missingBankColumns = REFUND_BANK_COLUMNS.filter((f) => !BANK_STATEMENT_FIELDS.includes(f));
if (__missingBankColumns.length > 0) {
  throw new Error(
    `[refund-backfill-fields] REFUND_BANK_COLUMNS 含非 BANK_STATEMENT_FIELDS 字段（常量漂移）：${__missingBankColumns.join(', ')}`
  );
}

// 启动期断言②（O4）：REFUND_RO_COLUMNS 15 字段全部 ∈ 中台退款订单 25 列签名（防常量漂移 / 误把不存在的退款列放进 ro 段）。
const __roSignature = new Set(ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders);
const __missingRoColumns = REFUND_RO_COLUMNS.filter((f) => !__roSignature.has(f));
if (__missingRoColumns.length > 0) {
  throw new Error(
    `[refund-backfill-fields] REFUND_RO_COLUMNS 含非 ZHONGTAI_REFUND_ORDER_SIGNATURE 字段（常量漂移）：${__missingRoColumns.join(', ')}`
  );
}

module.exports = {
  REFUND_BACKFILL_FIELD_MAP,
  REFUND_BANK_COLUMNS,
  REFUND_RO_COLUMNS,
  REFUND_TEMPLATE_HEADERS,
  MTX_FEATURE,
  // R1：JPM-HK 提取正则常量（直写，替代旧 T54SWIC_FEATURE）
  T54_REFUND_RE
};
