// v2.0.0-beta.3：银行对账单 46 列固定字段（PRD §6 D7：列结构固定，不从导入文件提取）
// 顺序与样例文件 银行对账单.xlsx 「渠道对账单」sheet 表头一致
// 任何场景配置中"字段下拉"的枚举值都来自本表
//
// ⚠️ 同步提醒：Electron sandbox 限制 preload require 自定义模块，
//   src/preload.js 顶部 inline 了一份副本（BANK_STATEMENT_FIELDS / BANK_STATEMENT_FIELDS_FOR_C3 /
//   BANK_STATEMENT_VIRTUAL_AMOUNT_ABS）。本文件改动必须同步更新 preload.js。

const BANK_STATEMENT_FIELDS = Object.freeze([
  '账户主体',
  '账户BU',
  'BizId',
  'BillDate',
  'ValueDate',
  'Channel',
  '地区',
  'MerchantId',
  'Currency',
  'Credit Amount',
  'Debit Amount',
  'ReconciliationId',
  'ChannelOrderNo',
  'CustomerRef',
  'Account Reference',
  'Transaction Description',
  '合并单号',
  '合并状态',
  'Extra Information',
  'Payment Detail',
  'Payee Name',
  'Payee CardNo',
  'Drawee Name',
  'Drawee CardNo',
  'By Order Of/Beneficiary',
  'Extra Fee',
  'tradeChannel',
  'FundType',
  'Remark-description',
  'Datasource',
  'Remark-BU',
  '回填方式',
  '关联大账号',
  '自动分类规则',
  '分类人',
  '清算网络',
  '最近修改时间',
  'Recon Amount',
  'OriginBillId',
  'fxChannel',
  'fxReconId',
  'buyCurrency',
  'buyAmount',
  'sellCurrency',
  'sellAmount',
  '拆分信息'
]);

// C3 银行对账单字段下拉额外加的"特殊计算字段"
const BANK_STATEMENT_VIRTUAL_AMOUNT_ABS = '发生额绝对值';

// C3 银行对账单字段下拉的全枚举（46 + 1 虚拟）
const BANK_STATEMENT_FIELDS_FOR_C3 = Object.freeze([
  ...BANK_STATEMENT_FIELDS,
  BANK_STATEMENT_VIRTUAL_AMOUNT_ABS
]);

// 设置 → 模板文件「银行对账单（导入识别结构）」：程序按列名读取的列（各模块计算、匹配、派生与导出映射），新结构须同名保留；
//   场景配置引用的银行字段另按场景引用保护。其余列只随行写出，可改名、增删（读取时对应回内置 46 列）。
//   无需同步到 preload（渲染层不使用）。
const BANK_STATEMENT_REQUIRED_FIELDS = Object.freeze([
  'BizId', 'BillDate', 'ValueDate', 'Channel', '地区', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount',
  'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'Account Reference', 'Transaction Description', 'Extra Information',
  'Payment Detail', 'Payee Name', 'Payee CardNo', 'Drawee Name', 'Drawee CardNo', 'Extra Fee', 'FundType',
  'Remark-description', '关联大账号', '清算网络'
]);

module.exports = {
  BANK_STATEMENT_REQUIRED_FIELDS,
  BANK_STATEMENT_FIELDS,
  BANK_STATEMENT_FIELDS_FOR_C3,
  BANK_STATEMENT_VIRTUAL_AMOUNT_ABS
};
