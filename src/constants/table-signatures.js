// v2.1.16 阶段一 A2：「按表头自动识别 Excel 表类型」识别签名表
//
// 用途：table-type-detector.js 据此判定一个导入文件属于哪种业务表。
// 来源：所有 expectedHeaders / signatureHeaders 均由 node + xlsx **实测 assets/ 真实模板表头**得到，
//   非凭空捏造。识别行为回归见正式单测 tests/unit/main-process/table-type-detector.test.js。
//   实测某模板表头的命令参考：
//     node -e 'const X=require("xlsx");const wb=X.readFile("assets/<file>");
//       for(const sn of wb.SheetNames){const r=X.utils.sheet_to_json(wb.Sheets[sn],{header:1,defval:""});
//       console.log(sn, JSON.stringify(r.slice(0,2)));}'
//
// 字段约定（每条签名）：
//   - tableKey         机器标识（唯一、可搜索）
//   - label            中文展示名
//   - scope            'preprocess'（预处理阶段导入的主表）| 'linked'（关联补充表）
//   - expectedHeaders  完整真实表头（按列顺序，忠实记录；含中间空列时以 '' 占位）
//                      —— L1 精确匹配默认用它；亦作文档与 L2 兜底参考
//   - signatureHeaders 3-6 个「指纹列」：在本表独有、且能与易混表区分的列名（大小写敏感）
//                      —— L2 模糊匹配按命中率打分用
//   - dateColumn       该表代表性日期列（后续阶段排序/取值用；无明确日期列则为 null）
//   - minScore         L2 模糊匹配判定阈值（命中数 / signatureHeaders.length ≥ minScore 才算识别）
//   - headerRowOffset  真实表头所在行相对「首个有意义行」的偏移（0=表头即首行）。
//                      ⚠️ 仅文档/排查用：readers.readRowsWithMetadata 内部会自动逐行扫描定位表头行，
//                      无需调用方传偏移；记录它是为了说明交割表「第 0 行是标题、表头在第 1 行」的现状。
//   - l1MatchHeaders   可选。L1 精确匹配实际使用的「连续锚点表头段」。
//                      ⚠️ 仅当 expectedHeaders 含**中间空列**时才需要：
//                      readRowsWithMetadata 会先 filter 掉空列再做「连续子序列全等」匹配，
//                      跨越中间空列的完整表头必然匹配失败（实测见脚本输出）。
//                      此时取空列之前的连续段作 L1 锚点。缺省时 L1 用 expectedHeaders。
//
// ⚠️ 大小写敏感：normalizeCell 只做 String(v).trim()，不改大小写。
//   网关对账单的 merchantid / reconciliationid 为**全小写**，银行对账单为**驼峰** MerchantId / ReconciliationId，
//   靠大小写即可区分二者，signatureHeaders 必须保留原始大小写。

const { BANK_STATEMENT_FIELDS } = require('./bank-statement-fields');

// 银行对账单.xlsx — sheet「渠道对账单」，44 列。复用 BANK_STATEMENT_FIELDS（实测与之逐列一致）。
const BANK_STATEMENT_SIGNATURE = Object.freeze({
  tableKey: 'bank-statement',
  label: '银行对账单',
  scope: 'preprocess',
  expectedHeaders: [...BANK_STATEMENT_FIELDS],
  // 指纹依据：驼峰 ReconciliationId / Credit Amount / Debit Amount 与网关全小写区分；
  //   拆分信息 / 关联大账号 为银行对账单独有的中文列。
  signatureHeaders: ['ReconciliationId', 'Credit Amount', 'Debit Amount', '拆分信息', '关联大账号'],
  dateColumn: 'BillDate',
  minScore: 0.6,
  headerRowOffset: 0
});

// 中台退款订单.xls — sheet「Sheet1」，25 列（完整订单表）。
// ⚠️ 必须区别于「中台退款订单回填模板.xlsx」（仅 4 列：退款单号/状态/渠道流水号/渠道退款时间）。
//   指纹列刻意避开两表共有的「状态」，改取退款订单独有列。
const ZHONGTAI_REFUND_ORDER_SIGNATURE = Object.freeze({
  tableKey: 'zhongtai-refund-order',
  label: '中台退款订单',
  scope: 'preprocess',
  expectedHeaders: [
    '流水号', '加款单号', '渠道流水单号', '业务方', '渠道名称', '银行大账号', '虚拟卡号',
    '原加款金额', '退款金额', '币种', '付款人名称', '付款卡号', 'swiftCode', '附言', '状态',
    '退款完成时间', '渠道退款时间', '来源', '操作人', '备注', '客户号', '账户号',
    '银行打款流水号', 'valueDate', '退款标识'
  ],
  // 指纹依据：加款单号 / 原加款金额 / 退款标识 / 银行打款流水号 均为退款订单独有，
  //   回填模板（退款单号/状态/渠道流水号/渠道退款时间）一个都不含 → 不会被回填模板误命中。
  signatureHeaders: ['加款单号', '原加款金额', '退款金额', '退款标识', '银行打款流水号'],
  dateColumn: '退款完成时间',
  minScore: 0.6,
  headerRowOffset: 0
});

// 入账原始订单.xlsx — sheet「账单明细」，41 列。
const INTAKE_ORIGINAL_ORDER_SIGNATURE = Object.freeze({
  tableKey: 'intake-original-order',
  label: '入账原始订单',
  scope: 'preprocess',
  expectedHeaders: [
    'bizId', 'batchNo', 'billDate', 'entity', 'business', 'oppBu', 'tradeType', 'reconId',
    'billReconId', 'orderNo', 'channel', 'merchantId', 'currency', 'amount', 'originAmount',
    'fee', 'clientId', 'accId', 'VA', 'fieldId', 'name', 'cardNo', 'tradeSubType',
    'originOutboundNo', 'originOutboundAmount', 'originOutboundCurrency', 'businessDate',
    'realChannel', 'clearingNetwork', 'createTime', 'finishTime', 'created', 'modified',
    'bookDate', 'valueDate', 'accountReference', 'remark', 'measureAmount', 'measureCurrency',
    'exchangeDiff', 'batchSeq'
  ],
  // 指纹依据：billReconId / measureAmount / exchangeDiff / batchSeq / originOutboundNo
  //   为入账原始订单独有列（measure*/exchangeDiff/batchSeq 在其余表均无）。
  signatureHeaders: ['billReconId', 'measureAmount', 'exchangeDiff', 'batchSeq', 'originOutboundNo'],
  dateColumn: 'billDate',
  minScore: 0.6,
  headerRowOffset: 0
});

// 中台调拨订单.xlsx — sheet「Sheet1」，26 列。
const ZHONGTAI_DISPATCH_ORDER_SIGNATURE = Object.freeze({
  tableKey: 'zhongtai-dispatch-order',
  label: '中台调拨订单',
  scope: 'linked',
  expectedHeaders: [
    '调拨单号', '调拨状态', '付款方式', '渠道流水号', '交易时间', '付款账户（卡号）',
    '收款账户（卡号）', '付款金额', '付款币种', '收款金额', '收款币种', '清算模式', '扣费方式',
    '中间行', '银行说明', '附言', '换汇渠道', '调拨业务类型', '业务日期', '调拨模式',
    '付款账号', '付款账号性质', '付款渠道', '收款账号', '收款账号性质', '收款渠道'
  ],
  // 指纹依据：「调拨」前缀列（调拨单号/调拨状态/调拨业务类型/调拨模式）为本表独有；换汇渠道辅助区分。
  signatureHeaders: ['调拨单号', '调拨状态', '换汇渠道', '调拨业务类型', '调拨模式'],
  dateColumn: '交易时间',
  minScore: 0.6,
  headerRowOffset: 0
});

// 网关对账单.xlsx — sheet 名为纯数字 ID（实测「1409155847565936642」），31 列。
// ⚠️ merchantid / reconciliationid / createtime / bookdate 等为**全小写**，与银行对账单驼峰列区分。
const GATEWAY_RECON_SIGNATURE = Object.freeze({
  tableKey: 'gateway-recon',
  label: '网关对账单',
  scope: 'linked',
  expectedHeaders: [
    'Billdate', 'Channel', 'merchantid', 'orderid', 'bussiness', 'oppBu', 'originBillSource',
    'billType', 'Type', 'Reference', 'currency', 'amount', 'originBillBizId', 'ReconBillBizId',
    'reconciliationid', 'TradeType', 'Merchant_status', 'Credit/Debit', 'name', 'cardNo',
    '真实渠道', '清算网络', 'createtime', 'finishtime', 'valueDate', 'remark1', 'bookdate',
    'fileId', 'AccountRef', '关联单号', '账单状态'
  ],
  // 指纹依据（大小写敏感）：merchantid / reconciliationid 全小写（银行为 MerchantId / ReconciliationId）；
  //   originBillBizId / Merchant_status / 账单状态 为网关独有，可与银行/入账原始订单区分。
  signatureHeaders: ['merchantid', 'reconciliationid', 'originBillBizId', 'Merchant_status', '账单状态'],
  dateColumn: 'Billdate',
  minScore: 0.6,
  headerRowOffset: 0
});

// 外汇交割表.xls — sheet「即期结售汇交易明细」，34 列。
// ⚠️ 第 0 行是标题「即期结售汇交易明细」，**真实表头在第 1 行**（headerRowOffset=1）。
// ⚠️ 真实表头第 9 列（「货币2金额」之后）是**空列**，故 expectedHeaders 以 '' 占位忠实记录；
//   L1 精确匹配改用 l1MatchHeaders（空列之前的连续 9 列），否则 readers 会因 filter 空列导致匹配错位失败。
//   （assets 原文件名为「外汇交割表vPayment.xls」，现仓库已重命名为「外汇交割表.xls」。）
const FX_DELIVERY_SIGNATURE = Object.freeze({
  tableKey: 'fx-delivery',
  label: '外汇交割表',
  scope: 'linked',
  expectedHeaders: [
    '交易编号', '产品名称', '货币对', '结售汇标识', '成交汇率', '货币1', '货币1金额', '货币2',
    '货币2金额', '', '期限', '期限天数', '到期日', '损益交割日', '损益金额', '损益货币', '输入货币',
    '交易模式', '交易类型', '交易状态', '清算状态', '剩余金额货币', '剩余金额', '源系统交易编号',
    '录入渠道', '子渠道', '全局套号', '原交易编号', '操作员', '交易日期', '交易时间', '项目类型',
    '交易编码', '交易编码-项目背景'
  ],
  // L1 锚点：空列之前的连续 9 列（实测可命中，从真实表头第 1 行起返回数据）。
  l1MatchHeaders: ['交易编号', '产品名称', '货币对', '结售汇标识', '成交汇率', '货币1', '货币1金额', '货币2', '货币2金额'],
  // 指纹依据：结售汇标识 / 货币对 / 成交汇率 / 损益金额 / 源系统交易编号 为结售汇交易明细独有。
  signatureHeaders: ['结售汇标识', '货币对', '成交汇率', '损益金额', '源系统交易编号'],
  dateColumn: '交易日期',
  minScore: 0.6,
  headerRowOffset: 1
});

// 外汇期权订单.xlsx — sheet「交易数据」，24 列。
// ⚠️ 第 0 行是标题「期权交易数据」，**真实表头在第 1 行**（headerRowOffset=1）；无中间空列。
//   （v2.1.16 PR#61 F3：模板已入库 assets/外汇期权订单.xlsx，表头已实测，纳入 detector 候选。
//    但本阶段「已入库待阶段二接入」—— detector 识别到 fx-option 返回 status='unsupported'，
//    不建 DB 表、不持久化；阶段二再接入读取/落库。见 table-type-detector.js UNSUPPORTED_TABLE_KEYS。）
const FX_OPTION_SIGNATURE = Object.freeze({
  tableKey: 'fx-option',
  label: '外汇期权表',
  scope: 'linked',
  expectedHeaders: [
    '货币对/ID', 'Delta', 'CCY1名义本金', 'CCY2名义本金', 'Book', '本方', '对手方', 'Company',
    'Client ID', '客户名称', '行权价', '方向', '价格', '到期日', '交割日', '交易日',
    '开仓期权费交割日', '平仓期权费交割日', '交割方式', '平仓价', '市场价', '损益', '行权设置', '状态'
  ],
  // 指纹依据：货币对/ID、Delta、CCY1名义本金、CCY2名义本金、行权价 为期权表独有
  //   （Delta / 名义本金 / 行权价 / 期权费交割日 等期权术语在其余表均无）。
  signatureHeaders: ['货币对/ID', 'Delta', 'CCY1名义本金', 'CCY2名义本金', '行权价'],
  dateColumn: '交易日',
  minScore: 0.6,
  headerRowOffset: 1
});

// —— 已就绪（非占位）签名 ——
const PREPROCESS_TABLE_SIGNATURES = Object.freeze([
  BANK_STATEMENT_SIGNATURE,
  ZHONGTAI_REFUND_ORDER_SIGNATURE,
  INTAKE_ORIGINAL_ORDER_SIGNATURE
]);

const LINKED_TABLE_SIGNATURES = Object.freeze([
  ZHONGTAI_DISPATCH_ORDER_SIGNATURE,
  GATEWAY_RECON_SIGNATURE,
  FX_DELIVERY_SIGNATURE,
  // v2.1.16 PR#61 F3：期权表已入库并纳入候选（识别更友好）；但 detector 标 status='unsupported'，
  //   本阶段不落库（见 table-type-detector.js UNSUPPORTED_TABLE_KEYS / linked-table:import handler）。
  FX_OPTION_SIGNATURE
]);

// 全部已就绪签名（detector 默认候选集）。
const ALL_TABLE_SIGNATURES = Object.freeze([
  ...PREPROCESS_TABLE_SIGNATURES,
  ...LINKED_TABLE_SIGNATURES
]);

module.exports = {
  BANK_STATEMENT_SIGNATURE,
  ZHONGTAI_REFUND_ORDER_SIGNATURE,
  INTAKE_ORIGINAL_ORDER_SIGNATURE,
  ZHONGTAI_DISPATCH_ORDER_SIGNATURE,
  GATEWAY_RECON_SIGNATURE,
  FX_DELIVERY_SIGNATURE,
  FX_OPTION_SIGNATURE,
  PREPROCESS_TABLE_SIGNATURES,
  LINKED_TABLE_SIGNATURES,
  ALL_TABLE_SIGNATURES
};
