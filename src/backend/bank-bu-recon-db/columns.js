// v2.1.2 T2 — 月度银行对账单BU回填校验模块列定义常量
// 来源：spec §3.2.1 (Pending 数据管理 20 列) / §3.2.2 (银行对账单 44 列)
// 与 src/backend/database/migrations.js 的 bank_bu_recon_pending_imports / bank_bu_recon_bank_imports 字段严格对齐
//
// 模块对外提供：
//   - PENDING_GUANLI_HEADERS / BANK_HEADERS：模板原始表头（用于表头校验 + 差异表 sheet 表头）
//   - PENDING_GUANLI_DB_COLUMNS / BANK_DB_COLUMNS：SQLite snake_case 列名（用于 INSERT/SELECT）
//   - pendingHeaderToDbColumn(h) / bankHeaderToDbColumn(h)：表头 → DB 列名映射
//   - PENDING_MATCH_KEY_* / PENDING_DIFF_FIELD_* / BANK_MATCH_KEY_* / BANK_DIFF_FIELD_*：
//     匹配 key + 差异字段的"语义锚点"常量，对账算法 (T2.6) 直接引用，避免散落字符串

// ---------------- Pending 数据管理（20 列） ----------------

const PENDING_GUANLI_COLUMN_DEFS = Object.freeze([
  Object.freeze({ header: 'PendingBizId',  dbColumn: 'pending_biz_id' }),
  Object.freeze({ header: '账单日期',       dbColumn: 'bill_date' }),
  Object.freeze({ header: 'pending类型',    dbColumn: 'pending_type' }),
  Object.freeze({ header: '资金类型',       dbColumn: 'fund_type' }),
  Object.freeze({ header: '主体',          dbColumn: 'entity' }),
  Object.freeze({ header: '财务BU',         dbColumn: 'finance_bu' }),
  Object.freeze({ header: '业务部门',       dbColumn: 'biz_dept' }),
  Object.freeze({ header: '对手部门',       dbColumn: 'counter_dept' }),
  Object.freeze({ header: '主对账单号',     dbColumn: 'recon_id' }),
  Object.freeze({ header: '渠道',          dbColumn: 'channel' }),
  Object.freeze({ header: '大账号',         dbColumn: 'account_no' }),
  Object.freeze({ header: '金额',          dbColumn: 'amount' }),
  Object.freeze({ header: '币种',          dbColumn: 'currency' }),
  Object.freeze({ header: '银行账期',       dbColumn: 'bank_period' }),
  Object.freeze({ header: '平账账期',       dbColumn: 'balance_period' }),
  Object.freeze({ header: '备注',          dbColumn: 'remark' }),
  Object.freeze({ header: '状态',          dbColumn: 'status' }),
  Object.freeze({ header: '更新时间',       dbColumn: 'update_time' }),
  Object.freeze({ header: '操作人',         dbColumn: 'operator' }),
  Object.freeze({ header: '财务BU修复标记', dbColumn: 'bu_fix_flag' })
]);

const PENDING_GUANLI_HEADERS = Object.freeze(
  PENDING_GUANLI_COLUMN_DEFS.map((d) => d.header)
);

const PENDING_GUANLI_DB_COLUMNS = Object.freeze(
  PENDING_GUANLI_COLUMN_DEFS.map((d) => d.dbColumn)
);

const PENDING_HEADER_TO_DB = new Map(
  PENDING_GUANLI_COLUMN_DEFS.map((d) => [d.header, d.dbColumn])
);

function pendingHeaderToDbColumn(header) {
  if (header == null) return null;
  return PENDING_HEADER_TO_DB.get(String(header)) || null;
}

// 语义锚点：spec §3.6 对账算法 (T2.6) 直接引用，禁止散落 '主对账单号' / '财务BU' 字符串
const PENDING_MATCH_KEY_HEADER = '主对账单号';
const PENDING_MATCH_KEY_DB_COLUMN = 'recon_id';
const PENDING_DIFF_FIELD_HEADER = '财务BU';
const PENDING_DIFF_FIELD_DB_COLUMN = 'finance_bu';

// ---------------- 银行对账单（44 列） ----------------

const BANK_COLUMN_DEFS = Object.freeze([
  Object.freeze({ header: '账户主体',                 dbColumn: 'account_entity' }),
  Object.freeze({ header: '账户BU',                   dbColumn: 'account_bu' }),
  Object.freeze({ header: 'BizId',                   dbColumn: 'biz_id' }),
  Object.freeze({ header: 'BillDate',                dbColumn: 'bill_date' }),
  Object.freeze({ header: 'ValueDate',               dbColumn: 'value_date' }),
  Object.freeze({ header: 'Channel',                 dbColumn: 'channel' }),
  Object.freeze({ header: '地区',                    dbColumn: 'region' }),
  Object.freeze({ header: 'MerchantId',              dbColumn: 'merchant_id' }),
  Object.freeze({ header: 'Currency',                dbColumn: 'currency' }),
  Object.freeze({ header: 'Credit Amount',           dbColumn: 'credit_amount' }),
  Object.freeze({ header: 'Debit Amount',            dbColumn: 'debit_amount' }),
  Object.freeze({ header: 'ReconciliationId',        dbColumn: 'reconciliation_id' }),
  Object.freeze({ header: 'ChannelOrderNo',          dbColumn: 'channel_order_no' }),
  Object.freeze({ header: 'CustomerRef',             dbColumn: 'customer_ref' }),
  Object.freeze({ header: 'Account Reference',       dbColumn: 'account_reference' }),
  Object.freeze({ header: 'Transaction Description', dbColumn: 'transaction_description' }),
  Object.freeze({ header: 'Extra Information',       dbColumn: 'extra_information' }),
  Object.freeze({ header: 'Payment Detail',          dbColumn: 'payment_detail' }),
  Object.freeze({ header: 'Payee Name',              dbColumn: 'payee_name' }),
  Object.freeze({ header: 'Payee CardNo',            dbColumn: 'payee_card_no' }),
  Object.freeze({ header: 'Drawee Name',             dbColumn: 'drawee_name' }),
  Object.freeze({ header: 'Drawee CardNo',           dbColumn: 'drawee_card_no' }),
  Object.freeze({ header: 'By Order Of/Beneficiary', dbColumn: 'by_order_of_beneficiary' }),
  Object.freeze({ header: 'Extra Fee',               dbColumn: 'extra_fee' }),
  Object.freeze({ header: 'tradeChannel',            dbColumn: 'trade_channel' }),
  Object.freeze({ header: 'FundType',                dbColumn: 'fund_type' }),
  Object.freeze({ header: 'Remark-description',      dbColumn: 'remark_description' }),
  Object.freeze({ header: 'Datasource',              dbColumn: 'datasource' }),
  Object.freeze({ header: 'Remark-BU',               dbColumn: 'remark_bu' }),
  Object.freeze({ header: '回填方式',                 dbColumn: 'fill_method' }),
  Object.freeze({ header: '关联大账号',               dbColumn: 'related_account' }),
  Object.freeze({ header: '自动分类规则',             dbColumn: 'auto_category_rule' }),
  Object.freeze({ header: '分类人',                   dbColumn: 'categorized_by' }),
  Object.freeze({ header: '清算网络',                 dbColumn: 'clearing_network' }),
  Object.freeze({ header: '最近修改时间',             dbColumn: 'last_modified_time' }),
  Object.freeze({ header: 'Recon Amount',            dbColumn: 'recon_amount' }),
  Object.freeze({ header: 'OriginBillId',            dbColumn: 'origin_bill_id' }),
  Object.freeze({ header: 'fxChannel',               dbColumn: 'fx_channel' }),
  Object.freeze({ header: 'fxReconId',               dbColumn: 'fx_recon_id' }),
  Object.freeze({ header: 'buyCurrency',             dbColumn: 'buy_currency' }),
  Object.freeze({ header: 'buyAmount',               dbColumn: 'buy_amount' }),
  Object.freeze({ header: 'sellCurrency',            dbColumn: 'sell_currency' }),
  Object.freeze({ header: 'sellAmount',              dbColumn: 'sell_amount' }),
  Object.freeze({ header: '拆分信息',                 dbColumn: 'split_info' })
]);

const BANK_HEADERS = Object.freeze(
  BANK_COLUMN_DEFS.map((d) => d.header)
);

const BANK_DB_COLUMNS = Object.freeze(
  BANK_COLUMN_DEFS.map((d) => d.dbColumn)
);

const BANK_HEADER_TO_DB = new Map(
  BANK_COLUMN_DEFS.map((d) => [d.header, d.dbColumn])
);

function bankHeaderToDbColumn(header) {
  if (header == null) return null;
  return BANK_HEADER_TO_DB.get(String(header)) || null;
}

// 语义锚点：spec §3.6 对账算法 (T2.6) 直接引用
const BANK_MATCH_KEY_HEADER = 'ReconciliationId';
const BANK_MATCH_KEY_DB_COLUMN = 'reconciliation_id';
const BANK_DIFF_FIELD_HEADER = 'Remark-BU';
const BANK_DIFF_FIELD_DB_COLUMN = 'remark_bu';

// ---------------- Sheet 名常量 ----------------
// spec §3.1：模板按"第一个 sheet"读取（不 hardcode sheet 名），但导出时差异表 sheet 名需要固定
// 差异表 sheet 名：
//   - Pending sheet 名固定为 'Pending'（PRD §3.2.4）
//   - 银行对账单 sheet 名固定为 '银行对账单'（PRD §3.2.4，与 exceljs-writer.js '渠道对账单' 区分开）
const PENDING_GUANLI_SOURCE_SHEET_HINT = 'sheet';        // 实际模板 sheet 名（仅作 hint，读取仍按第一个 sheet）
const BANK_SOURCE_SHEET_HINT = '渠道对账单';              // 实际模板 sheet 名
const DIFF_OUTPUT_PENDING_SHEET = 'Pending';
const DIFF_OUTPUT_BANK_SHEET = '银行对账单';

module.exports = {
  // Pending
  PENDING_GUANLI_COLUMN_DEFS,
  PENDING_GUANLI_HEADERS,
  PENDING_GUANLI_DB_COLUMNS,
  pendingHeaderToDbColumn,
  PENDING_MATCH_KEY_HEADER,
  PENDING_MATCH_KEY_DB_COLUMN,
  PENDING_DIFF_FIELD_HEADER,
  PENDING_DIFF_FIELD_DB_COLUMN,
  PENDING_GUANLI_SOURCE_SHEET_HINT,

  // Bank
  BANK_COLUMN_DEFS,
  BANK_HEADERS,
  BANK_DB_COLUMNS,
  bankHeaderToDbColumn,
  BANK_MATCH_KEY_HEADER,
  BANK_MATCH_KEY_DB_COLUMN,
  BANK_DIFF_FIELD_HEADER,
  BANK_DIFF_FIELD_DB_COLUMN,
  BANK_SOURCE_SHEET_HINT,

  // Diff output sheet names
  DIFF_OUTPUT_PENDING_SHEET,
  DIFF_OUTPUT_BANK_SHEET
};
