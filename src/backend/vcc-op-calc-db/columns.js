// v2.1.12 需求1 T-vcc-1 — VCC业务OP计算：列定义常量
// 输入 = 流水对账单（28 列）。
//   v3.2.20 下线业务OP数据核对（biz-op-recon）后，流水对账单 28 列定义由 biz-op-recon-db/columns.js
//   迁入本文件（逐字不变），本模块成为唯一所有者；设置 → 模板文件「流水对账单」也读取这里。
//
// 资金红线 ⚠️：本模块发生额求和按「出入方向」+「对账金额」统计（spec §3.2）：
//   - 发生额入 = direction==='入' 的 recon_amount 求和
//   - 发生额出 = direction==='出' 的 recon_amount 求和
//   - 发生额   = 入 − 出；期末OP = 期初OP + 发生额
//   月份归属取「账单日期」bill_date_raw（spec §2.6 C 拍板）。

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

// 设置 → 模板文件：流水对账单中程序按列读取的列，新结构须同名保留；
//   其余列可改名、增删（读取时对应回内置 28 列）。清单沿用下线前口径，不因业务OP下线收窄。
const FLOW_REQUIRED_HEADERS = Object.freeze(['账单日期', '公司主体', '业务部门', '出入方向', '流水单号', '账户编号',
  '对账金额', '币种', '账户类型']);

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

// 语义锚点（引用流水列的 DB 列名，禁止散落字符串）
// 出入方向（spec §3.2）
const VCC_DIRECTION_DB_COLUMN = 'direction';
// 对账金额 = 发生额金额来源
const VCC_RECON_AMOUNT_DB_COLUMN = 'recon_amount';
// 账单日期 = 定月份来源
const VCC_BILL_DATE_DB_COLUMN = 'bill_date_raw';
// 币种（混币种全量合并，仅用于记录涉及币种）
const VCC_CURRENCY_DB_COLUMN = 'currency';

// 出入方向合法值（spec §0.2 / Q8：仅中文「入」/「出」；其他 → 整批拒绝）
const VALID_DIRECTION_IN = '入';
const VALID_DIRECTION_OUT = '出';

module.exports = {
  // 流水对账单 28 列定义（单一真理来源）
  FLOW_COLUMN_DEFS,
  FLOW_HEADERS,
  FLOW_REQUIRED_HEADERS,
  FLOW_DB_COLUMNS,
  flowHeaderToDbColumn,
  flowRowToArray,

  // 语义锚点
  VCC_DIRECTION_DB_COLUMN,
  VCC_RECON_AMOUNT_DB_COLUMN,
  VCC_BILL_DATE_DB_COLUMN,
  VCC_CURRENCY_DB_COLUMN,

  // 出入方向合法值
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
};
