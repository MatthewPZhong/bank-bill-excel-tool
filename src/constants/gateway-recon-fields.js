// v2.0.0-beta.3：资金对账导出不平.xlsx 「网关账单」sheet 31 列固定字段
// 顺序与样例文件表头一致
// C3 场景的"网关账单字段下拉"枚举值来自本表
//
// ⚠️ 同步提醒：Electron sandbox 限制 preload require 自定义模块，
//   src/preload.js 顶部 inline 了一份副本（GATEWAY_RECON_FIELDS）。
//   本文件改动必须同步更新 preload.js。
//
// ⚠️ v2.1.8 N2 sentinel 保留字（self-review SR4 警告）：
//   `__CUSTOM__` 在 C3 dialog「对账成立后赋值-右侧下拉」中作为
//   "自取值" 选项的 value sentinel（src/renderer-dialogs.js + src/main-process/scenario-engines/c3-gateway-recon-join.js:137）
//   → **未来网关账单 sheet 加新字段时绝不可命名为 `__CUSTOM__`**
//   （冲突后果：C3 引擎会把真实字段值当作"使用自取值"处理 → 资金红线 mode 误判）

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
