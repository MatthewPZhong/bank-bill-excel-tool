// v2.0.0-beta.4：error-report「可能原因」统一映射
//
// 用于 3 个模块的 error-report 写出：
//   - 主模块（statementGenerator）logger.js writeErrorReport (.txt)
//   - 月度 Pending pending-session.js exportErrorReport (.xlsx)（v3.2.20 随模块下线删除；下方 Pending 兜底映射保留）
//   - 银行对账单处理 main-process/exceljs-writer.js writeErrorReport (.xlsx)
//
// 文案风格：精简口语化，让用户能看懂大致问题方向。
// 未知 code → fallback '未知错误'（不 throw，避免影响 error-report 主流程）

const CAUSE_MAP = Object.freeze({
  // 银行对账单处理 — 算法层细粒度 code
  'inconsistent-recon-id-values': '多个字段抓到的对账ID不一致，无法判断该用哪个',
  'single-field-multi-recon-id': '单个字段里出现多个对账ID，无法判断该用哪个',
  'multi-search-fields-multi-extract': '多个字段都抓到对账ID且不同，无法判断该用哪个',
  'one-to-many': '一对多匹配，可能有重复数据',
  'many-to-one': '多对一匹配，可能有重复数据',
  'multi-gateway-match': '网关单里有多条匹配，已取第一条',
  'no-gateway-rows': '资金对账文件为空，相关场景跳过',
  'no-bill-types-defined': '场景配置漏了账单类型',
  'missing-assign-config': '场景配置漏了赋值字段',
  'invalid-config': '场景配置不完整或格式不对',
  'overwrite-existing-recon-id': '原值非空被覆盖',
  'overwrite-existing-value': '原值非空被覆盖',

  // v3.1.7：Payment线下调拨订单回填（R5 场景2b）—— 派生表、周边界与共享消费。
  'payment-offline-invalid-fta': 'Payment候选含无法解析日期的调拨单号，本次运行已在回填前阻断',
  'payment-offline-recon-schema-invalid': '调拨对账单派生字段不完整，请重新导入中台调拨订单后再运行',
  'payment-offline-recon-derive-failed': 'Payment运行前生成调拨对账单失败，为避免读取陈旧数据已阻断',
  // v3.2.22：账户映射（链接表账户号）整轮共用（🔴 资金红线）
  'fund-transfer-account-mapping-read-failed': '读取账户映射失败，为避免按空映射少回填已阻断',
  'fund-transfer-recon-derive-failed-account-mapping': '生成调拨对账单失败，网关来源回填与DBS-Charge须共用同一版账户映射，已阻断',
  'r5-mapped-account-contention': '账户映射后多条网关调拨记录争用同一条银行行，严格一对一只匹配其中一条，请人工核对未匹配的网关记录',
  'r5-mapped-account-channel-missing': '账户映射后网关与银行账号、币种、金额相符，但渠道为空无法确认同渠道，已排除该候选，请人工核对',
  'r5-mapped-account-escape-ambiguous': '网关账户号含 Excel 转义写法，无法确定真实账户号，已不参与回填，请人工核对',
  'r5-mapped-account-precision-ambiguous': '网关账户号是按数值读入的数字，可能已丢失前导零或精度（Excel 数值不保留前导零、只保留 15 位有效数字，超长数字还会被舍入），与账户映射的链接表账户号或映射后的清结算账号对得上，无法确定真实账户号，已不参与回填，请人工核对',
  'r5-mapped-account-bank-precision-ambiguous': '银行行 MerchantId 是按数值读入的数字（或被前序场景按链接表原文改写成这种数字），可能已丢失前导零或精度（Excel 数值不保留前导零、只保留 15 位有效数字，超长数字还会被舍入），与账户映射后的网关账户号对得上，无法确定真实账户号，该银行行未参与网关调拨回填，请人工核对',
  'r5-mapped-account-bank-escape-ambiguous': '银行行 MerchantId 已被前序场景按链接表原文改写，含 Excel 转义写法，与账户映射后的网关账户号文字相同，无法确定真实账户号，该银行行未参与网关调拨回填，请人工核对',
  'linked-value-escape-same-value-ambiguous': '回填值与银行行当前值文字相同，但含 Excel 转义写法，无法确定是否同一个值，已按相同处理未改写，请人工核对',
  'r5-mapped-account-channel-escape-ambiguous': '账户映射后网关渠道含 Excel 转义写法，无法确认与银行行同渠道，已不参与回填，请人工核对',
  'fund-transfer-recon-mapped-account-ambiguous': '调拨对账单账户号含 Excel 转义写法或是可能已丢失前导零或精度的数字，无法确定真实账户号，这些行未参与匹配，请人工核对',
  'fund-transfer-recon-derive-failed-account-mapping-stale': '生成调拨对账单失败，现有调拨对账单与本轮账户映射不一致，为避免按旧映射回填已阻断',
  'payment-offline-order-week-gap': 'Payment候选订单周不连续，本次运行已阻断，禁止跨空档扩大窗口猜配',
  'payment-offline-invalid-big-account-config': 'Payment线下调拨大账号配置无效，请使用中文顿号分隔且不要填写空项或重复账号',
  'payment-offline-config-incomplete': 'Payment线下调拨配置缺少银行渠道或地区，本轮已安全跳过',
  'payment-offline-multi-candidate': '一条银行行匹配到多条调拨订单候选，已按就近取最近一条',
  'payment-offline-empty-recon-id': '调拨派生行 ReconID 为空，已跳过且未消费银行行',
  'payment-offline-empty-pay-account': '调拨派生行付款账号为空，已跳过且未消费银行行',
  'payment-offline-no-eligible-recon-row': '调拨对账单中没有满足Payment配置的可用FundTransfer-in派生行',
  'payment-offline-forced-recon-source': 'Payment已开启，本次运行已强制使用中台调拨派生表',
  'payment-offline-no-order-match': '银行行未匹配到付款账号、金额币种和日期均相符的调拨派生行',

  // v3.0.26：R5 中台调拨订单回填 Extra Fee 校验（🔴 资金红线）
  'r5-invalid-extra-fee': '银行行 Extra Fee 非空但不是合法金额，已跳过中台调拨订单对账ID回填与调拨多对多审计，请人工核对手续费原值',

  // v3.1.1：调拨真实借贷方向、日期与 directions 整体校验（🔴 资金红线）
  'fund-transfer-direction-mismatch': '银行行借贷方向与调拨方向不符或方向金额格式异常，已排除该候选且未消费、未回填，请人工核对 Credit/Debit Amount',
  'fund-transfer-date-mismatch': '调拨与银行日期缺失、格式非法或超出已配置的日期范围，已跳过该候选且未消费、未回填，请核对账单日期和日期策略',
  'r5-fund-transfer-directions-invalid': '中台调拨订单回填方向配置不完整、重复或配对错误，本轮已安全跳过且未消费银行行，请恢复内置配置',
  'fund-transfer-policy-owner-missing': '未找到“调拨回填功能管理”系统配置，当前已按启用日期匹配、允许 ±1 天的安全默认值处理，请修复本机配置',
  'fund-transfer-policy-invalid-date-enabled': '“调拨单匹配日期”开关配置无效，当前已按默认值“启用”处理，请重新保存配置',
  'fund-transfer-policy-invalid-tolerance-days': '“调拨单匹配日期”天数配置无效，当前已按默认值 ±1 天处理；请输入 1–999 的整数并重新保存',

  // v3.0.23：R4 四类资金性质严格 1:1 匹配（🔴 资金红线）
  'r4-fund-direction-mismatch': '同对账ID存在目标网关行，但银行借贷方向金额非0或格式非法，已跳过资金性质改写，请人工核对方向',
  'r4-fund-match-mismatch': '同对账ID存在银行行，但账号、币种、金额、手续费或候选消费状态不满足完整匹配条件',
  'r4-fund-multi-candidate': '同一网关行匹配到多条完整银行候选，已按银行账单原始顺序取第一条，请人工核对重复数据',

  // v3.0.21：DBS-Charge step2 outbound 方向守卫（🔴 资金红线）
  'dbs-charge-fund-direction-mismatch': 'DBS-Charge 同对账ID存在白名单网关候选，但银行行 Credit Amount 非0，借贷方向不符，已跳过步骤2资金性质改写，请人工核对方向',

  // 主模块（FileValidationError code 粗粒度）
  'FILE_READ': '文件读取失败，可能损坏或格式不对',
  'FILE_TYPE': '文件类型不支持',

  // 文件 schema / 校验类（跨模块共用）
  'invalid-column-count': '文件列数不对，请检查表头',
  'invalid-column-name': '文件列名不对，请检查表头',
  'missing-sheet': '文件少了必需的 sheet',
  'file-not-found': '文件找不到',
  'missing-headers': '表头缺失，请检查文件',
  'missing-mapping': '列映射缺失，请检查模板',
  'duplicate-row': '重复行，已忽略',
  'missing-required-field': '必填字段为空',
  'amount-parse-error': '金额无法解析，请检查格式',
  'date-parse-error': '日期无法解析，请检查格式',

  // Pending 严重程度兜底（severity 当 code 用）
  'fatal': '导入失败，请检查文件',
  'row': '这一行有问题，已被跳过'
});

function errorCodeToCause(code) {
  if (!code) return '未知错误';
  return CAUSE_MAP[code] || '未知错误';
}

module.exports = {
  CAUSE_MAP,
  errorCodeToCause
};
