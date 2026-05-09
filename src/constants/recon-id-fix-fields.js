// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块的 4 sheet 字段常量
// spec §四
//
// 注意：必须与 src/preload.js 内 inline 的 BUSINESS_BILL_FIELDS / OPPONENT_BILL_FIELDS 同步
//   （preload sandbox 不允许 require 自定义模块，因此 PR-A 起 preload 内 inline 一份副本，
//    任何字段改动必须两端同步——见 preload.js 第 31-45 行的注释）

// 「对账结果」sheet 表头（18 列）
const RECON_RESULT_FIELDS = Object.freeze([
  '账单日期', '业务部门', '对手部门', '业务类型', '对账结果',
  'reconId', '业务部门单号', '业务部门金额', '业务部门币种', '业务部门单据子类型',
  '对手部门单号', '对手部门金额', '对手部门币种', '对手部门单据子类型',
  '业务部门交易完成时间', '对手部门完成时间', '对平类型', '备注'
]);

// 「业务部门账单」sheet 表头（23 列）— 主边
const BUSINESS_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '订单创建来源', '交易订单号'
]);

// 「对手部门账单」sheet 表头（22 列）— 从边
const OPPONENT_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '交易订单号'
]);

// 「订单修复」sheet 表头（15 列）— 输出
const ORDER_REPAIR_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'SubBizType'
]);

// sheet 名常量
const RECON_RESULT_SHEET_NAME = '对账结果';
const BUSINESS_BILL_SHEET_NAME = '业务部门账单';
const OPPONENT_BILL_SHEET_NAME = '对手部门账单';
const ORDER_REPAIR_SHEET_NAME = '订单修复';

module.exports = {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME
};
