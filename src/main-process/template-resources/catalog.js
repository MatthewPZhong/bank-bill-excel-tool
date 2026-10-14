'use strict';

// 设置 → 模板文件：随应用打包的模板清单。路径相对 app.getAppPath()。
// readMode 描述程序当前如何使用该文件；replace 记录目标设计中能否替换（版本替换尚未开放）。
// 读取口径以各模块实现为准：运行时读取的输出模板见对应 excel-writer，枚举与网关表头见 src/constants。

const TYPE_ORDER = Object.freeze(['output', 'enum', 'input', 'link', 'reference']);
const READ_MODES = Object.freeze(['runtime', 'cached', 'locked', 'disabled', 'sample', 'generated', 'reference']);

const NOT_REPLACEABLE_REASONS = Object.freeze({
  sample: '仅作导入结构参考，替换不会生效',
  generated: '输出由程序生成，替换不会生效',
  reference: '示例文件，不参与处理',
  disabled: '该表导入尚未启用'
});

function binding(moduleId, use, read = 'none') {
  return Object.freeze({ moduleId, use, read });
}

function resource(definition) {
  const replace = definition.replace
    || { allowed: false, reason: NOT_REPLACEABLE_REASONS[definition.readMode] };
  return Object.freeze({
    headerRow: 1,
    cache: '',
    failure: '',
    effect: '',
    twin: null,
    currentTemplate: null,
    ...definition,
    bindings: Object.freeze(definition.bindings),
    replace: Object.freeze({ ...replace })
  });
}

const REPLACEABLE = Object.freeze({ allowed: true });

const TEMPLATE_RESOURCES = Object.freeze([
  // 输出模板
  resource({
    id: 'prefund-unbalanced', path: 'assets/资金对账导出不平.xlsx', type: 'output', readMode: 'runtime',
    bindings: [binding('pre-fund-reconciliation', '资金对账不平工作簿 · 5 张基础 Sheet 样式', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次导出读取', failure: '导出中止，提示模板不兼容', effect: '下次导出'
  }),
  resource({
    id: 'dup-recall-mail', path: 'assets/重复入金召回邮件模板.xlsx', type: 'output', readMode: 'runtime',
    bindings: [binding('duplicate-inbound-match', '「邮件模板」Sheet · 表头与第 2 行样式', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次导出读取', failure: '导出中止，提示模板不兼容', effect: '下次导出'
  }),
  resource({
    id: 'position-bank', path: 'assets/平盘银行对账单.xlsx', type: 'output', readMode: 'runtime',
    bindings: [binding('position-reconciliation-process', '结果「渠道对账单」· 49 列', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次生成读取', failure: '生成中止，提示模板不兼容', effect: '下次生成结果'
  }),
  resource({
    id: 'vcc-result-template', path: 'assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx', type: 'output', readMode: 'locked',
    bindings: [binding('vcc-financial-op', '校验结果主表 · 每主体一张', 'locked')],
    replace: { allowed: false, reason: '文件受 SHA-256 锁定，需随应用版本更新' },
    cache: '按路径＋文件哈希缓存', failure: 'SHA-256 不一致时拒绝生成'
  }),
  resource({
    id: 'vcc-pending-calc', path: 'assets/VCC财务OP校验/移除归档Pending发生额计算表.xlsx', type: 'output', readMode: 'runtime',
    bindings: [binding('vcc-financial-op', 'Pending 计算表 · 每主体一张', 'runtime')],
    replace: { allowed: false, reason: '模块尚未接入' },
    cache: '不缓存，每次导出读取', failure: '缺少工作表时导出失败'
  }),
  resource({
    id: 'platform-cleanup', path: 'assets/中台加款单剔除模板.xlsx', type: 'output', readMode: 'generated',
    bindings: [binding('bank-statement-process', '中台加款单剔除输出')]
  }),
  resource({
    id: 'refund-backfill', path: 'assets/中台退款订单回填模板.xlsx', type: 'output', readMode: 'generated',
    bindings: [binding('bank-statement-process', '中台退款订单回填输出')]
  }),
  resource({
    id: 'acquiring-diff', path: 'assets/收单币种校验导出差异表模版.xlsx', type: 'output', readMode: 'generated',
    bindings: [binding('acquiring-bill-currency', '差异表')]
  }),
  // 枚举
  resource({
    id: 'fund-type-enum', path: 'assets/FundType枚举值.xlsx', type: 'enum', readMode: 'cached',
    bindings: [binding('bank-statement-process', '场景配置 · FundType 下拉', 'cached')],
    replace: REPLACEABLE, cache: '按文件路径缓存', failure: '读取失败时为空列表（也会缓存）', effect: '下次打开场景配置'
  }),
  // 输入原表
  resource({
    id: 'gateway-recon', path: 'assets/网关对账单.xlsx', type: 'input', readMode: 'cached',
    bindings: [
      binding('bank-statement-process', 'C3 场景 · 网关账单字段下拉', 'cached'),
      binding('bank-statement-process', '链接表导入结构参考')
    ],
    replace: REPLACEABLE, cache: '按文件路径缓存', failure: '读取失败时改用程序内置旧字段（也会缓存）', effect: '下次打开场景配置'
  }),
  resource({
    id: 'bank-statement', path: 'assets/银行对账单.xlsx', type: 'input', readMode: 'runtime',
    bindings: [
      binding('duplicate-inbound-match', '「匹配不成功需人工判定」Sheet 样式', 'runtime'),
      binding('bank-statement-process', '导入结构参考'),
      binding('pre-fund-reconciliation', '导入结构参考')
    ],
    replace: REPLACEABLE, cache: '不缓存，每次导出读取', failure: '导出中止，提示模板不兼容', effect: '下次导出'
  }),
  resource({ id: 'transfer-order', path: 'assets/中台调拨订单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('bank-statement-process', '链接表导入结构参考')] }),
  resource({ id: 'refund-order', path: 'assets/中台退款订单.xls', type: 'input', readMode: 'sample',
    bindings: [binding('bank-statement-process', '导入结构参考')] }),
  resource({ id: 'inbound-raw-order', path: 'assets/入账原始订单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('bank-statement-process', '导入结构参考')] }),
  resource({ id: 'fx-delivery', path: 'assets/外汇交割表.xls', type: 'input', readMode: 'sample', headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表导入结构参考')] }),
  resource({ id: 'fx-option', path: 'assets/外汇期权表.xlsx', type: 'input', readMode: 'disabled', headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表 · 导入未启用')], twin: 'fx-option-order' }),
  resource({ id: 'fx-option-order', path: 'assets/外汇期权订单.xlsx', type: 'input', readMode: 'disabled', headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表 · 导入未启用')], twin: 'fx-option' }),
  resource({ id: 'pending', path: 'assets/Pending.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('pending-reconciliation', '导入结构参考')] }),
  resource({ id: 'removed-pending', path: 'assets/移除归档Pending账单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('pending-reconciliation', '导入结构参考')] }),
  resource({ id: 'pending-data', path: 'assets/Pending数据管理.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('bank-bu-recon', '导入结构参考')] }),
  resource({ id: 'biz-op-bill', path: 'assets/业务OP账单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('biz-op-recon', '导入结构参考')] }),
  resource({ id: 'flow-statement', path: 'assets/流水对账单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('biz-op-recon', '导入结构参考'), binding('vcc-op-calc', '导入结构参考')] }),
  resource({ id: 'doc-recon-unbalanced', path: 'assets/单据对账导出不平.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('recon-id-fix', '导入结构参考 · 4 张 Sheet')] }),
  resource({ id: 'position-payment-full', path: 'assets/中台测试付款全量信息表.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('position-reconciliation-process', '链接表导入结构参考')] }),
  resource({ id: 'position-gateway-raw-in', path: 'assets/中台网关原始入账订单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('position-reconciliation-process', '链接表导入结构参考')] }),
  resource({ id: 'position-gateway-raw-out', path: 'assets/中台网关原始出账订单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('position-reconciliation-process', '链接表导入结构参考')] }),
  resource({ id: 'position-transfer-orders', path: 'assets/中台调拨订单表.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('position-reconciliation-process', '链接表导入结构参考')] }),
  resource({ id: 'position-bank-accounts', path: 'assets/清结算银行账户表.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('position-reconciliation-process', '链接表导入结构参考')] }),
  resource({ id: 'vcc-removed-pending', path: 'assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('vcc-financial-op', '导入结构参考 · 46 列')] }),
  resource({ id: 'vcc-recharge-refund', path: 'assets/VCC财务OP校验/VCC充值清退明细.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('vcc-financial-op', '导入结构参考')] }),
  resource({ id: 'vcc-fee-fx', path: 'assets/VCC财务OP校验/VCC费用及换汇明细.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('vcc-financial-op', '导入结构参考')] }),
  resource({ id: 'vcc-channel', path: 'assets/VCC财务OP校验/VCC通道明细.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('vcc-financial-op', '导入结构参考')] }),
  resource({ id: 'vcc-system-op', path: 'assets/VCC财务OP校验/系统财务OP.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('vcc-financial-op', '导入结构参考')] }),
  // 链接表
  resource({ id: 'position-payment-link', path: 'assets/中台测试付款对账单.xlsx', type: 'link', readMode: 'generated',
    bindings: [binding('position-reconciliation-process', '派生链接表')] }),
  resource({ id: 'position-gateway-in-link', path: 'assets/中台网关入账对账单.xlsx', type: 'link', readMode: 'generated',
    bindings: [binding('position-reconciliation-process', '派生链接表')] }),
  resource({ id: 'position-gateway-out-link', path: 'assets/中台网关出账对账单.xlsx', type: 'link', readMode: 'generated',
    bindings: [binding('position-reconciliation-process', '派生链接表')] }),
  resource({ id: 'position-transfer-link', path: 'assets/中台调拨平盘对账单.xlsx', type: 'link', readMode: 'generated',
    bindings: [binding('position-reconciliation-process', '派生链接表')] }),
  // 示例参考
  resource({ id: 'doc-recon-example', path: 'assets/单据对账导出不平-对平例子.xlsx', type: 'reference', readMode: 'reference',
    bindings: [binding('recon-id-fix', '业务示例')] }),
  resource({ id: 'vcc-result-reference', path: 'assets/VCC财务OP校验/财务OP校验结果表.xlsx', type: 'reference', readMode: 'reference',
    bindings: [binding('vcc-financial-op', '旧版结果参考')], currentTemplate: 'vcc-result-template' })
]);

// 由原模块自行维护、不在模板文件页替换的文件。
const EXCLUDED_TEMPLATE_FILES = Object.freeze([
  Object.freeze({ path: 'COMMON枚举.xlsx', modules: Object.freeze(['statement-generator']) }),
  Object.freeze({ path: 'assets/余额账单模版.xlsx', modules: Object.freeze(['statement-generator', 'new-account-generator']) }),
  Object.freeze({ path: 'assets/币种映射表.xlsx', modules: Object.freeze(['statement-generator']) })
]);

module.exports = {
  EXCLUDED_TEMPLATE_FILES,
  READ_MODES,
  TEMPLATE_RESOURCES,
  TYPE_ORDER
};
