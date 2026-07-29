// v2.0.0-beta.4：error-report「可能原因」统一映射
//
// 用于 3 个模块的 error-report 写出：
//   - 主模块（statementGenerator）logger.js writeErrorReport (.txt)
//   - 月度 Pending pending-session.js exportErrorReport (.xlsx)
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

  // v3.0.4 块 F：Payment线下调拨订单回填（R5 场景2b）—— 新引擎 warning code
  'payment-offline-invalid-fta': '调拨单号不是合法的 FTA+8位日期，算不出订单周数，已跳过',
  'payment-offline-invalid-big-account-config': 'Payment线下调拨大账号配置无效，请使用中文顿号分隔且不要填写空项或重复账号',
  'payment-offline-multi-candidate': '一条银行行匹配到多条调拨订单候选，已按就近取最近一条',
  'payment-offline-no-order-match': '银行行未匹配到金额币种相符且晚于交易时间的调拨订单',

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
