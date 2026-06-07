// v2.1.16-beta.2 R5 场景3：中台加款单剔除模板字段单一真相
// 基准来源：assets/中台加款单剔除模板.xlsx 真实 15 列表头（A~O）
//
// 列结构：
//   A 加款单号    —— 剔除模板专属（= 网关 orderid）
//   B 附言        —— 剔除模板专属（= `<银行行 FundType>，中台加款单已关闭。`）
//   C~O（13 列）  —— 表头与银行对账单同名，直接拷贝对应银行行字段
//
// ⚠️ 资金红线 / 漂移守卫：
//   CLEANUP_COPY_HEADERS（C~O）必须是 BANK_STATEMENT_FIELDS 的子集。
//   单测 r5-platform-inbound-cleanup.test.js 断言 C~O ⊆ BANK_STATEMENT_FIELDS；
//   若某项不在银行字段表中，说明剔除模板 / 银行字段发生漂移，测试会失败。

const CLEANUP_TEMPLATE_HEADERS = Object.freeze([
  '加款单号',
  '附言',
  'FundType',
  'BillDate',
  'ValueDate',
  'Channel',
  '地区',
  'MerchantId',
  'Currency',
  'Credit Amount',
  'Debit Amount',
  'ReconciliationId',
  'Transaction Description',
  'Extra Information',
  'Payment Detail'
]);

// C~O 共 13 列，表头与银行对账单同名 —— 直接拷贝银行行字段
const CLEANUP_COPY_HEADERS = Object.freeze(CLEANUP_TEMPLATE_HEADERS.slice(2));

module.exports = {
  CLEANUP_TEMPLATE_HEADERS,
  CLEANUP_COPY_HEADERS
};
