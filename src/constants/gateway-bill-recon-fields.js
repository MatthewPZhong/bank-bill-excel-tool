// v2.1.0-beta.3：网关对账单 ReconID 修复模式（gateway 子模式）的 4 sheet 字段常量
// fixture 来源：资金对账导出不平.xlsx（根目录）
// spec §2.6.1
//
// ⚠️ 同步提醒：Electron sandbox 限制 preload require 自定义模块（参考 src/constants/recon-id-fix-fields.js
//   的注释 / src/constants/gateway-recon-fields.js 第 5-7 行），src/preload.js 顶部 inline 一份副本。
//   本文件改动必须同步更新 preload.js。
//
// ⚠️ 与 src/constants/gateway-recon-fields.js::GATEWAY_RECON_FIELDS（v2.0.0-beta.3 引入，C3 银行对账单网关 join 模块用）
//   列名 byte-for-byte 完全相同，但本次新建独立常量 GATEWAY_BILL_FIELDS。**不跨模块复用**——
//   两个模块语义不同：C3 是网关对账单 vs 银行对账单 join；本模块（C4 gateway）是网关对账单 vs 渠道账单的
//   ReconID 修复。未来任一模块字段调整都不应影响另一方。

const GATEWAY_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', 'Reference', 'Currency', 'Amount',
  'OriginBillBizId', 'ReconBillBizId', 'reconciliationId', 'tradeType', 'clientId', 'name',
  'cardNo', '真实渠道', '清算网络', '对账批次号', 'createTime', 'finishTime',
  'LOriginalId', 'remark1', 'remark2', 'bookdate', 'valuedate', 'fileId', 'AccountRef'
]);

const CHANNEL_BILL_FIELDS = Object.freeze([
  'channelName', 'merchantId', 'reconciliationId', 'channelOrderNo', 'name', 'cardNo',
  'currency', 'requestAmount', 'receiveAmount', 'extraFee', '清算网络', 'createTime',
  'finishTime', 'additionInfo', 'remark', 'COriginalId'
]);

// 输出 sheet 模板（14 列，**不含 SubBizType** — 与单据模式 ORDER_REPAIR_FIELDS 15 列不同）
const ORDER_REPAIR_FIELDS_GATEWAY = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId'
]);

// 预留：当前迭代未消费"对账结果" sheet 数据；存常量供未来扩展
const RECON_RESULT_FIELDS_GATEWAY = Object.freeze([
  '账单日期', '支付渠道', '业务类型', '交易类型', '对账结果', 'reconId',
  '业务订单号', '业务订单金额', '业务方币种', '渠道账号', '渠道订单号',
  '渠道订单金额', '渠道币种', '业务订单交易完成时间', '渠道订单交易完成时间',
  '差错类型', '备注', '业务方原始账单ID', '渠道方原始账单ID'
]);

// sheet 名常量
const GATEWAY_BILL_SHEET_NAME = '网关账单';
const CHANNEL_BILL_SHEET_NAME = '渠道账单';
const ORDER_REPAIR_SHEET_NAME_GATEWAY = '订单修复';
const RECON_RESULT_SHEET_NAME_GATEWAY = '对账结果';

module.exports = {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
};
