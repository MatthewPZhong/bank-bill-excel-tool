// v2.1.3 T2 — 业务OP数据核对模块列定义常量
// 来源：spec §2.1 (业务OP账单 23 列) / §2.2 (流水对账单 28 列)
// 与 src/backend/biz-op-recon-db/migrations.js 的 biz_op_recon_imports / biz_op_recon_flow_imports
// 字段严格对齐
//
// 模块对外提供：
//   - BIZ_OP_HEADERS / FLOW_HEADERS：模板原始表头（用于表头校验 + 差异表 sheet 表头）
//   - BIZ_OP_DB_COLUMNS / FLOW_DB_COLUMNS：SQLite snake_case 列名（用于 INSERT/SELECT）
//   - bizOpHeaderToDbColumn / flowHeaderToDbColumn：表头 → DB 列名映射
//   - bizOpRowToArray / flowRowToArray：DB 行 → 数组（writer 用，按 BIZ_OP_HEADERS 顺序）
//   - 语义锚点常量（spec §五 算法 + §五.3 双重校验直接引用，避免散落字符串）

// ---------------- 业务 OP 账单（23 列） ----------------
// 注意：列 2「业务方」DB 列名 = bu_name；其余列保持 spec §2.1 表对应

const BIZ_OP_COLUMN_DEFS = Object.freeze([
  Object.freeze({ header: 'Billdate',         dbColumn: 'bill_date_raw' }),
  Object.freeze({ header: '业务方',           dbColumn: 'bu_name' }),
  Object.freeze({ header: '客户编号',         dbColumn: 'customer_no' }),
  Object.freeze({ header: '主体',             dbColumn: 'entity' }),
  Object.freeze({ header: '账户号',           dbColumn: 'account_no' }),
  Object.freeze({ header: '账户类型',         dbColumn: 'account_type' }),
  Object.freeze({ header: '币种',             dbColumn: 'currency' }),
  Object.freeze({ header: '期初余额',         dbColumn: 'begin_balance' }),
  Object.freeze({ header: '发生额',           dbColumn: 'amount' }),
  Object.freeze({ header: '发生额（入）',      dbColumn: 'amount_in' }),
  Object.freeze({ header: '发生额（出）',      dbColumn: 'amount_out' }),
  Object.freeze({ header: '期末余额',         dbColumn: 'end_balance' }),
  Object.freeze({ header: '期末可用余额',     dbColumn: 'end_available_balance' }),
  Object.freeze({ header: '期末冻结余额',     dbColumn: 'end_frozen_balance' }),
  Object.freeze({ header: '最近更新时间',     dbColumn: 'last_updated' }),
  Object.freeze({ header: '通道',             dbColumn: 'channel' }),
  Object.freeze({ header: 'ppCardId',         dbColumn: 'pp_card_id' }),
  Object.freeze({ header: '银行卡号',         dbColumn: 'bank_card_no' }),
  Object.freeze({ header: '扩展信息',         dbColumn: 'extra_info' }),
  Object.freeze({ header: '账户状态',         dbColumn: 'account_status' }),
  Object.freeze({ header: 'BizId',            dbColumn: 'biz_id' }),
  Object.freeze({ header: '清结算系统创建时间', dbColumn: 'sys_created_at' }),
  Object.freeze({ header: '清结算系统更新时间', dbColumn: 'sys_updated_at' })
]);

const BIZ_OP_HEADERS = Object.freeze(
  BIZ_OP_COLUMN_DEFS.map((d) => d.header)
);

const BIZ_OP_DB_COLUMNS = Object.freeze(
  BIZ_OP_COLUMN_DEFS.map((d) => d.dbColumn)
);

const BIZ_OP_HEADER_TO_DB = new Map(
  BIZ_OP_COLUMN_DEFS.map((d) => [d.header, d.dbColumn])
);

function bizOpHeaderToDbColumn(header) {
  if (header == null) return null;
  return BIZ_OP_HEADER_TO_DB.get(String(header)) || null;
}

// 按 BIZ_OP_HEADERS 顺序把 DB 行 → 数组（writer 用）
// row 入参可能是 SQLite 查询结果（含 id / data_date / bu_name / row_index / imported_at 等元数据），
// 也可能是 reader 输出的 raw row（含 _rowIndex）；本函数只取 BIZ_OP_DB_COLUMNS 内的字段
function bizOpRowToArray(row) {
  if (!row) return BIZ_OP_DB_COLUMNS.map(() => '');
  return BIZ_OP_DB_COLUMNS.map((col) => {
    const v = row[col];
    return v == null ? '' : String(v);
  });
}

// 语义锚点：spec §五 算法 + §五.3 双重校验引用，禁止散落字符串
const BIZ_OP_BU_FIELD_DB_COLUMN = 'bu_name';           // 列 2 业务方
const BIZ_OP_ACCOUNT_KEY_DB_COLUMN = 'account_no';     // 列 5 账户号（匹配 key）
const BIZ_OP_BEGIN_BALANCE_DB_COLUMN = 'begin_balance';// 列 8 期初余额
const BIZ_OP_AMOUNT_DB_COLUMN = 'amount';              // 列 9 发生额
const BIZ_OP_AMOUNT_IN_DB_COLUMN = 'amount_in';        // 列 10 发生额（入）
const BIZ_OP_AMOUNT_OUT_DB_COLUMN = 'amount_out';      // 列 11 发生额（出）
const BIZ_OP_END_BALANCE_DB_COLUMN = 'end_balance';    // 列 12 期末余额（对账目标）

// ---------------- 流水对账单（28 列） ----------------

const FLOW_COLUMN_DEFS = Object.freeze([
  Object.freeze({ header: 'BizId',          dbColumn: 'biz_id' }),
  Object.freeze({ header: '账单日期',       dbColumn: 'bill_date_raw' }),
  Object.freeze({ header: 'originBizId',    dbColumn: 'origin_biz_id' }),
  Object.freeze({ header: '主体大账号',     dbColumn: 'main_account' }),
  Object.freeze({ header: '公司主体',       dbColumn: 'company_entity' }),
  Object.freeze({ header: '流水类型',       dbColumn: 'flow_type' }),
  Object.freeze({ header: '业务部门',       dbColumn: 'bu_dept' }),
  Object.freeze({ header: '对账主Id',       dbColumn: 'recon_main_id' }),
  Object.freeze({ header: '出入方向',       dbColumn: 'direction' }),
  Object.freeze({ header: '流水单号',       dbColumn: 'flow_no' }),
  Object.freeze({ header: '用户编号',       dbColumn: 'user_no' }),
  Object.freeze({ header: '账户编号',       dbColumn: 'account_no' }),
  Object.freeze({ header: '拆分类型',       dbColumn: 'split_type' }),
  Object.freeze({ header: '对账金额',       dbColumn: 'recon_amount' }),
  Object.freeze({ header: '币种',           dbColumn: 'currency' }),
  Object.freeze({ header: '账户类型',       dbColumn: 'account_type' }),
  Object.freeze({ header: '流水开始时间',   dbColumn: 'flow_start_at' }),
  Object.freeze({ header: '流水完成时间',   dbColumn: 'flow_end_at' }),
  Object.freeze({ header: '渠道',           dbColumn: 'channel' }),
  Object.freeze({ header: 'MerchantId',     dbColumn: 'merchant_id' }),
  Object.freeze({ header: 'valueDate',      dbColumn: 'value_date' }),
  Object.freeze({ header: 'BankRef',        dbColumn: 'bank_ref' }),
  Object.freeze({ header: 'Pending标识',    dbColumn: 'pending_flag' }),
  Object.freeze({ header: '流水BizId',      dbColumn: 'flow_biz_id' }),
  Object.freeze({ header: '穿透ID',         dbColumn: 'trace_id' }),
  Object.freeze({ header: '操作人',         dbColumn: 'operator' }),
  Object.freeze({ header: '系统创建时间',   dbColumn: 'sys_created_at' }),
  Object.freeze({ header: '系统修改时间',   dbColumn: 'sys_updated_at' })
]);

const FLOW_HEADERS = Object.freeze(
  FLOW_COLUMN_DEFS.map((d) => d.header)
);

const FLOW_DB_COLUMNS = Object.freeze(
  FLOW_COLUMN_DEFS.map((d) => d.dbColumn)
);

const FLOW_HEADER_TO_DB = new Map(
  FLOW_COLUMN_DEFS.map((d) => [d.header, d.dbColumn])
);

function flowHeaderToDbColumn(header) {
  if (header == null) return null;
  return FLOW_HEADER_TO_DB.get(String(header)) || null;
}

function flowRowToArray(row) {
  if (!row) return FLOW_DB_COLUMNS.map(() => '');
  return FLOW_DB_COLUMNS.map((col) => {
    const v = row[col];
    return v == null ? '' : String(v);
  });
}

// 语义锚点：spec §五 + §五.3 流水校验引用
const FLOW_BU_FIELD_DB_COLUMN = 'bu_dept';           // 列 7 业务部门（与业务OP bu_name 关联，normalizeBu 比较）
const FLOW_DIRECTION_DB_COLUMN = 'direction';        // 列 9 出入方向（#3 拍板：仅「入」/「出」）
const FLOW_ACCOUNT_KEY_DB_COLUMN = 'account_no';     // 列 12 账户编号
const FLOW_RECON_AMOUNT_DB_COLUMN = 'recon_amount';  // 列 14 对账金额

// 资金红线 ⚠️ v2.1.3-fix7-M2：AMOUNT_EPSILON 1 分钱容差
// 之前 session.js + validator.js 各自定义 1e-2 → 双源存在调小一边漏改另一边的风险
// 提取到本文件作单一真理来源；任何修改必须同步评估资金红线影响（PRD §3.4 + spec §五）
const AMOUNT_EPSILON = 1e-2;

// 差异表/失败报告：sheet 名 = 日期 ISO（spec §6.1 / §6.3，#14 拍板 A）
const DIFF_HEADER_TAIL = Object.freeze([
  '比对T-2日',
  '同账户号多个OP',
  '比对测算金额',
  '测算金额差额'
]);

const ERROR_HEADER_TAIL = Object.freeze(['失败行号', '失败原因']);

module.exports = {
  // 资金红线常量（fix7-M2 提取）
  AMOUNT_EPSILON,

  // 业务 OP
  BIZ_OP_COLUMN_DEFS,
  BIZ_OP_HEADERS,
  BIZ_OP_DB_COLUMNS,
  bizOpHeaderToDbColumn,
  bizOpRowToArray,
  BIZ_OP_BU_FIELD_DB_COLUMN,
  BIZ_OP_ACCOUNT_KEY_DB_COLUMN,
  BIZ_OP_BEGIN_BALANCE_DB_COLUMN,
  BIZ_OP_AMOUNT_DB_COLUMN,
  BIZ_OP_AMOUNT_IN_DB_COLUMN,
  BIZ_OP_AMOUNT_OUT_DB_COLUMN,
  BIZ_OP_END_BALANCE_DB_COLUMN,

  // 流水对账单
  FLOW_COLUMN_DEFS,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS,
  flowHeaderToDbColumn,
  flowRowToArray,
  FLOW_BU_FIELD_DB_COLUMN,
  FLOW_DIRECTION_DB_COLUMN,
  FLOW_ACCOUNT_KEY_DB_COLUMN,
  FLOW_RECON_AMOUNT_DB_COLUMN,

  // 差异表/失败报告 头部尾巴
  DIFF_HEADER_TAIL,
  ERROR_HEADER_TAIL
};
