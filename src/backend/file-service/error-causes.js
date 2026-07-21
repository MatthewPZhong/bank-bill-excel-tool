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
  'payment-offline-multi-candidate': '一条银行行匹配到多条调拨订单候选，已按就近取最近一条',
  'payment-offline-no-order-match': '银行行未匹配到金额币种相符且晚于交易时间的调拨订单',

  // v3.0.10 需求1：R4 资金性质校验方向守卫（🔴 资金红线）—— 命中网关但银行行借贷方向不符
  'r4-fund-direction-mismatch': '资金性质命中但银行行借贷方向不符（应为0的金额列非0），已跳过该行资金性质改写，请人工核对方向',

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
