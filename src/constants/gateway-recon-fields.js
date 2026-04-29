// v2.0.0-beta.3：资金对账导出不平.xlsx 「网关账单」sheet 31 列固定字段
// 顺序与样例文件表头一致
// C3 场景的"网关账单字段下拉"枚举值来自本表
//
// ⚠️ 同步提醒：Electron sandbox 限制 preload require 自定义模块，
//   src/preload.js 顶部 inline 了一份副本（GATEWAY_RECON_FIELDS）。
//   本文件改动必须同步更新 preload.js。

const GATEWAY_RECON_FIELDS = Object.freeze([
  'BillDate',
  'Bank',
  'MerchantId',
  'OrderId',
  'DataSource',
  'OppBu',
  'OriginBillSource',
  'BillType',
  'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)',
  'Reference',
  'Currency',
  'Amount',
  'OriginBillBizId',
  'ReconBillBizId',
  'reconciliationId',
  'tradeType',
  'clientId',
  'name',
  'cardNo',
  '真实渠道',
  '清算网络',
  '对账批次号',
  'createTime',
  'finishTime',
  'LOriginalId',
  'remark1',
  'remark2',
  'bookdate',
  'valuedate',
  'fileId',
  'AccountRef'
]);

module.exports = {
  GATEWAY_RECON_FIELDS
};
