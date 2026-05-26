// v2.1.6 T5 — 收单单据币种校验模块字段定义常量
// 来源：spec §3.1（收单流水表 48 列）/ §3.2（收单流水单据表 26 列）
// 与 src/backend/database/migrations.js 的 acquiring_bill_currency_*_imports 字段定位严格对齐
//
// 模块对外提供：
//   - FLOW_HEADERS / BILL_HEADERS：模板原始表头（用于表头校验）
//   - FLOW_KEY_COLUMN_INDICES / BILL_KEY_COLUMN_INDICES：关键字段在表头中的索引（0-based）
//   - WRITER_OUTPUT_COLUMNS：差异表输出 29 列定义（spec §6.2）
//   - 中文输出列名常量（hardcode，⚠️ 资金红线）

// ---------------- 收单流水表（48 列） ----------------

const FLOW_HEADERS = Object.freeze([
  '账单日期', 'originBizId', '主体大账号', '公司主体', '流水类型', '业务部门',
  '对账主Id', '出入方向', '流水单号', '用户编号', '账户编号', '拆分类型',
  '对账金额', '币种', '账户类型', '流水开始时间', '流水完成时间', '渠道',
  'MerchantId', 'valueDate', 'BankRef', 'Pending标识', '流水BizId', '穿透ID',
  '操作人', '系统创建时间', '系统修改时间', 'MID', '通道清算金额', '通道清算币种',
  '交易订单号', '关联渠道', '关联MID', '关联通道清算币种', '关联通道清算金额', '抵扣资金方向',
  '抵扣手续费合计', '抵扣金额', '抵扣本金', '本金-循环保证金', '交易手续费', '退款手续费',
  '拒付手续费', '提现手续费', '一次性费用', '其他手续费', '常规入账资金', '客资账户余额'
]);

// v0.7 fix4：对账字段从第 14 列「币种」+ 第 13 列「对账金额」（订单视角）
// 切换为第 30 列「通道清算币种」+ 第 29 列「通道清算金额」（清算视角，与单据「对账币种」语义对齐）
const FLOW_KEY_COLUMNS = Object.freeze({
  billDate: '账单日期',
  reconMainId: '对账主Id',
  settleAmount: '通道清算金额',
  settleCurrency: '通道清算币种'
});

const FLOW_KEY_COLUMN_INDICES = Object.freeze({
  billDate: FLOW_HEADERS.indexOf(FLOW_KEY_COLUMNS.billDate),
  reconMainId: FLOW_HEADERS.indexOf(FLOW_KEY_COLUMNS.reconMainId),
  settleAmount: FLOW_HEADERS.indexOf(FLOW_KEY_COLUMNS.settleAmount),
  settleCurrency: FLOW_HEADERS.indexOf(FLOW_KEY_COLUMNS.settleCurrency)
});

// ---------------- 收单流水单据表（26 列） ----------------

const BILL_HEADERS = Object.freeze([
  '账单日期', 'originBillBizId', 'ReconBillBizId', '公司主体', '业务部门', '对手部门',
  '订单创建来源', '财务BU', '账单类型', '单据类型', '业务子类型', '交易类型',
  '对账子类型', '单据状态', '主对账Id', '业务订单号', '用户编号', '账户号',
  '对账金额', '对账币种', '账户类型', 'valueDate', 'channel', 'remark',
  '创建时间', '完成时间'
]);

// v0.7 fix4：单据侧「对账币种」语义本就是清算视角，仅 key 名改为 settleCurrency 与流水侧对称
const BILL_KEY_COLUMNS = Object.freeze({
  billDate: '账单日期',
  reconMainId: '主对账Id',
  reconAmount: '对账金额',
  settleCurrency: '对账币种'
});

const BILL_KEY_COLUMN_INDICES = Object.freeze({
  billDate: BILL_HEADERS.indexOf(BILL_KEY_COLUMNS.billDate),
  reconMainId: BILL_HEADERS.indexOf(BILL_KEY_COLUMNS.reconMainId),
  reconAmount: BILL_HEADERS.indexOf(BILL_KEY_COLUMNS.reconAmount),
  settleCurrency: BILL_HEADERS.indexOf(BILL_KEY_COLUMNS.settleCurrency)
});

// ---------------- 差异表输出列（spec §6.2，29 列）⚠️ 资金红线 ----------------
// 列名 hardcode，任何修改必须同步 spec §6.2 + writer + smoke + important-variables

const WRITER_OUTPUT_BILL_COPY_HEADER = '单据_对账币种';
const WRITER_OUTPUT_FLOW_CURRENCY_HEADER = '流水_通道清算币种';  // v0.7 fix4：原「流水币种」
const WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER = '流水_通道清算金额';  // v0.7 fix4：原「流水金额绝对值」

// v2.1.7 及之前差异表 29 列输出，v2.1.8 N4 起 deprecated（保留作历史参照，方便对比）
// 新代码请使用 WRITER_OUTPUT_HEADERS_V2（12 列）
const WRITER_OUTPUT_HEADERS = Object.freeze([
  ...BILL_HEADERS,
  WRITER_OUTPUT_BILL_COPY_HEADER,
  WRITER_OUTPUT_FLOW_CURRENCY_HEADER,
  WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER
]);

// ---------------- v2.1.8 N4：差异表瘦身（12 列）⚠️ 资金红线 ----------------
// 来源：assets/收单币种校验导出差异表模版.xlsx（PM 拍板模版即 truth）
// 决策：spec v0.10 §三.1 N4-D1=b（不加 diff_type）/ D2=b（保留单据_对账币种）/ D3=a（模版顺序）
// 改动同步：writer.js + migration ensureBillRawJsonV2Slim + smoke caseR/caseN4

const TEMPLATE_BILL_HEADERS = Object.freeze([
  '账单日期', 'originBillBizId', '单据类型', '主对账Id', '业务订单号',
  '对账金额', '对账币种', 'valueDate', 'channel'
]);

const WRITER_OUTPUT_HEADERS_V2 = Object.freeze([
  ...TEMPLATE_BILL_HEADERS,                  // 9 列模版字段
  WRITER_OUTPUT_BILL_COPY_HEADER,            // 第 10 列：单据_对账币种（bill raw_json['对账币种'] 副本）
  WRITER_OUTPUT_FLOW_CURRENCY_HEADER,        // 第 11 列：流水_通道清算币种（diff_rows.flow_currency）
  WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER       // 第 12 列：流水_通道清算金额（diff_rows.flow_amount_abs）
]);

module.exports = {
  FLOW_HEADERS,
  FLOW_KEY_COLUMNS,
  FLOW_KEY_COLUMN_INDICES,
  BILL_HEADERS,
  BILL_KEY_COLUMNS,
  BILL_KEY_COLUMN_INDICES,
  WRITER_OUTPUT_HEADERS,                     // v2.1.8 N4 deprecated（历史参照）
  WRITER_OUTPUT_HEADERS_V2,                  // v2.1.8 N4 新输出（12 列）
  TEMPLATE_BILL_HEADERS,                     // v2.1.8 N4 模版 9 列（migration 共用）
  WRITER_OUTPUT_BILL_COPY_HEADER,
  WRITER_OUTPUT_FLOW_CURRENCY_HEADER,
  WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER
};
