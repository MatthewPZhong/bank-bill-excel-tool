// v2.0.0-beta.3：资金对账导出不平.xlsx 「网关账单」sheet 31 列固定字段
// 顺序与样例文件表头一致
//
// ⚠️ v2.1.15 W1 起本常量的两个用途：
//   1. main-process/bank-statement-io.js:114 readGatewayRecon —— 网关账单 reader 表头映射（sheetToObjects），仍在用，不可删。
//   2. constants/gateway-recon-headers-loader.js —— C3「网关账单字段」枚举的 **fallback 兜底**
//      （xlsx 文件缺失/读取失败/表头为空时回落到本常量，防崩）。
//   注意：C3 弹窗下拉枚举正常路径已改读 assets/网关对账单.xlsx 表头（决策 xlsx 为准、旧硬编码作废、存量不迁移），
//   本常量列名与 xlsx 表头几乎全不一致 —— 这是预期，本常量仅作上述两用途，不再直接驱动 C3 下拉。
//   preload.js 顶部旧 inline 副本（GATEWAY_RECON_FIELDS）已于 W1 移除。
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
