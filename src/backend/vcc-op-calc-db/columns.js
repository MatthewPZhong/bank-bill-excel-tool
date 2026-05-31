// v2.1.12 需求1 T-vcc-1 — VCC业务OP计算：列定义常量
// 输入 = 流水对账单（28 列，与第 5 模块 biz-op-recon FLOW 完全相同）
//   → 直接 require 复用 biz-op-recon-db/columns.js 的 FLOW_COLUMN_DEFS / FLOW_HEADERS / flowHeaderToDbColumn，
//     避免重复维护表头（spec §3.2 C 拍板 2026-05-30）。
//
// 与第 5 模块的关系（spec §0.3 消歧）：
//   - 第 5 模块 biz-op-recon：业务OP数据「核对」（账户号匹配 + 期末余额比对）
//   - 本模块 vcc-op-calc：VCC业务OP「计算」（纯按月聚合发生额出/入 → 算期末OP，不对账）
//   - 流水文件格式相同（28 列 FLOW），故复用列定义；但语义/落表完全独立。
//
// 资金红线 ⚠️：本模块发生额求和按「出入方向」+「对账金额」统计（spec §3.2）：
//   - 发生额入 = direction==='入' 的 recon_amount 求和
//   - 发生额出 = direction==='出' 的 recon_amount 求和
//   - 发生额   = 入 − 出；期末OP = 期初OP + 发生额
//   月份归属取「账单日期」bill_date_raw（spec §2.6 C 拍板）。

const {
  FLOW_COLUMN_DEFS,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS,
  flowHeaderToDbColumn,
  flowRowToArray
} = require('../biz-op-recon-db/columns');

// 语义锚点（引用第 5 模块流水列的 DB 列名，禁止散落字符串）
// 出入方向（spec §3.2 / biz-op-recon-db/columns.js:90）
const VCC_DIRECTION_DB_COLUMN = 'direction';
// 对账金额 = 发生额金额来源（biz-op-recon-db/columns.js:95）
const VCC_RECON_AMOUNT_DB_COLUMN = 'recon_amount';
// 账单日期 = 定月份来源（biz-op-recon-db/columns.js:83）
const VCC_BILL_DATE_DB_COLUMN = 'bill_date_raw';
// 币种（biz-op-recon-db/columns.js:96；混币种全量合并，仅用于记录涉及币种）
const VCC_CURRENCY_DB_COLUMN = 'currency';

// 出入方向合法值（spec §0.2 / Q8：仅中文「入」/「出」；其他 → 整批拒绝）
const VALID_DIRECTION_IN = '入';
const VALID_DIRECTION_OUT = '出';

module.exports = {
  // 复用第 5 模块 FLOW 28 列定义（单一真理来源）
  FLOW_COLUMN_DEFS,
  FLOW_HEADERS,
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
