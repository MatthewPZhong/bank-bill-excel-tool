'use strict';

// 设置 → 模板文件：随应用打包的模板清单。路径相对 app.getAppPath()。
// readMode 描述程序当前如何使用该文件；replace 记录能否导入用户版本替换（导入预检契约见 ./contracts.js）。
// 读取口径以各模块实现为准：运行时读取的输出模板见对应 excel-writer，枚举与网关表头见 src/constants。
// 用户版本存 {userData}/template-resources/，各模块经模板服务 acquire 读取当前版本。

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
    // twinNote：两者只是同一份系统导出、各自有独立版本时的说明（详情显示为“同一系统导出”，不显示“内容相同”）。
    twinNote: null,
    // displayName：多个资源共用同一随包文件时的显示名（缺省取文件名）。
    displayName: null,
    currentTemplate: null,
    ...definition,
    bindings: Object.freeze(definition.bindings),
    replace: Object.freeze({ ...replace })
  });
}

const REPLACEABLE = Object.freeze({ allowed: true });

const SAME_EXPORT_NOTE = '版本各自独立，需分别导入';
const BANK_STATEMENT_ROLE_NOTE = '导出样式与导入识别结构分开管理，版本各自独立';

// 银行账单处理链接表：导入时按当前版本表头识别，入库 / 会话前对应回内置列名（见 linked-structure-signatures）。
const LINKED_INPUT_STRUCTURE = Object.freeze({
  readMode: 'runtime',
  replace: REPLACEABLE,
  cache: '不缓存，每次导入时读取',
  failure: '当前版本缺失、被修改或不兼容时该表导入中止，提示恢复默认或重新导入',
  effect: '下次导入；只认当前版本结构，入库与派生仍按内置列名'
});

// VCC 财务OP 原表：选文件预检时按当前版本识别并冻结进导入计划；导入时的表头随交接成员清单记录在存档原件上，
//   入库与日后重读原件都对应回内置列序（见 backend/vcc-financial-op/source-structure.js）。
const VCC_INPUT_STRUCTURE = Object.freeze({
  readMode: 'runtime',
  bindings: [binding('vcc-financial-op', '导入预检 · 识别结构', 'runtime')],
  replace: REPLACEABLE,
  cache: '不缓存，每次选择文件预检时读取',
  failure: '当前版本缺失、被修改或不兼容时预检失败，提示恢复默认或重新导入',
  effect: '下次选择文件；已导入的数据按导入时结构重读原件，入库、导出与校验仍按内置列'
});

// 平盘链接原始表：导入时按当前版本第 1 个工作表的表头识别（契约见 ./contracts.js inputStructureContract）。
const POSITION_INPUT_STRUCTURE = Object.freeze({
  readMode: 'runtime',
  bindings: [binding('position-reconciliation-process', '链接表导入 · 识别结构', 'runtime')],
  replace: REPLACEABLE,
  cache: '不缓存，每次导入开始时读取',
  failure: '当前版本缺失、被修改或不兼容时导入中止，提示恢复默认或重新导入',
  effect: '下次导入；只认当前版本结构，必用列须保留'
});

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
    replace: REPLACEABLE, cache: '不缓存，每次导出读取', failure: '版本文件缺失、被修改或不兼容时导出中止',
    effect: '下次导出；仅表头行、数据行样式与列隐藏生效'
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
    // 网关对账单：导入时按当前版本识别，入库前对应回内置 31 列名（新增列也入库）；C3 下拉为入库后实际可用的列名。
    id: 'gateway-recon', path: 'assets/网关对账单.xlsx', type: 'input', readMode: 'runtime',
    bindings: [
      binding('bank-statement-process', 'C3 场景 · 网关账单字段下拉', 'cached'),
      binding('bank-statement-process', '链接表导入 · 识别结构', 'runtime')
    ],
    replace: REPLACEABLE, cache: '不缓存，每次导入与打开场景配置时读取',
    failure: '当前版本缺失、被修改或不兼容时导入中止，C3 下拉改用程序内置旧字段',
    effect: '下次导入与打开场景配置；只认当前版本结构，入库仍按内置列名'
  }),
  // 银行对账单随包文件有两个用途，各自独立版本：重复入账匹配输出页的样式（本条，契约要求前 46 列一致），
  //   与导入识别结构（bank-statement-input）。
  resource({
    id: 'bank-statement', path: 'assets/银行对账单.xlsx', type: 'input', readMode: 'runtime',
    bindings: [
      binding('duplicate-inbound-match', '「匹配不成功需人工判定」Sheet 样式', 'runtime')
    ],
    replace: REPLACEABLE, cache: '不缓存，每次导出读取', failure: '导出中止，提示模板不兼容', effect: '下次导出',
    twin: 'bank-statement-input', twinNote: BANK_STATEMENT_ROLE_NOTE
  }),
  // 银行对账单导入识别结构：启用后同时接受当前版本与内置 46 列（本工具导出仍为内置 46 列，下游模块须能继续导入）；
  //   按当前版本读出的行对应回内置 46 列，场景、计算与导出不变。
  resource({
    id: 'bank-statement-input', path: 'assets/银行对账单.xlsx', displayName: '银行对账单（导入识别结构）', type: 'input',
    readMode: 'runtime',
    bindings: [
      binding('bank-statement-process', '导入 · 识别结构', 'runtime'),
      binding('pre-fund-reconciliation', '导入银行对账单 · 识别结构', 'runtime')
    ],
    replace: REPLACEABLE, cache: '不缓存，每次导入时读取',
    failure: '当前版本缺失、被修改或不兼容时只接受内置 46 列，按新结构导出的文件被拒',
    effect: '下次导入；同时接受内置 46 列，入库、场景与导出仍按内置 46 列',
    twin: 'bank-statement', twinNote: BANK_STATEMENT_ROLE_NOTE
  }),
  // 中台调拨订单与平盘「中台调拨订单表」是同一份系统导出，各自独立版本（twin 互相标注）。
  resource({ id: 'transfer-order', path: 'assets/中台调拨订单.xlsx', type: 'input', ...LINKED_INPUT_STRUCTURE,
    bindings: [binding('bank-statement-process', '链接表导入 · 识别结构', 'runtime')],
    twin: 'position-transfer-orders', twinNote: SAME_EXPORT_NOTE }),
  // 版本文件须为 .xlsx；导入的中台退款订单仍可为 .xls。
  resource({ id: 'refund-order', path: 'assets/中台退款订单.xls', type: 'input', ...LINKED_INPUT_STRUCTURE,
    bindings: [binding('bank-statement-process', '导入文件 · 识别结构', 'runtime')] }),
  resource({ id: 'inbound-raw-order', path: 'assets/入账原始订单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('bank-statement-process', '导入结构参考')] }),
  resource({ id: 'fx-delivery', path: 'assets/外汇交割表.xls', type: 'input', ...LINKED_INPUT_STRUCTURE, headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表导入 · 识别结构', 'runtime')] }),
  resource({ id: 'fx-option', path: 'assets/外汇期权表.xlsx', type: 'input', readMode: 'disabled', headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表 · 导入未启用')], twin: 'fx-option-order' }),
  resource({ id: 'fx-option-order', path: 'assets/外汇期权订单.xlsx', type: 'input', readMode: 'disabled', headerRow: 2,
    bindings: [binding('bank-statement-process', '链接表 · 导入未启用')], twin: 'fx-option' }),
  resource({ id: 'pending', path: 'assets/Pending.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('pending-reconciliation', '导入结构参考')] }),
  // 移除归档 Pending：导入时按当前版本表头识别，入库前对应回内置 46 列（前 28 列为必用列）。
  resource({ id: 'removed-pending', path: 'assets/移除归档Pending账单.xlsx', type: 'input', readMode: 'runtime',
    bindings: [binding('pending-reconciliation', '移除归档导入 · 识别结构', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次导入时读取',
    failure: '当前版本缺失、被修改或不兼容时导入中止，提示恢复默认或重新导入',
    effect: '下次导入；只认当前版本结构，入库与导出仍按内置 46 列',
    twin: 'vcc-removed-pending', twinNote: SAME_EXPORT_NOTE }),
  resource({ id: 'pending-data', path: 'assets/Pending数据管理.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('bank-bu-recon', '导入结构参考')] }),
  resource({ id: 'biz-op-bill', path: 'assets/业务OP账单.xlsx', type: 'input', readMode: 'sample',
    bindings: [binding('biz-op-recon', '导入结构参考')] }),
  // 流水对账单：业务 OP 导入任务开始时按当前版本识别并冻结，数据集记录导入时结构（导出重读原件按它对应回内置列）；
  //   VCC OP 发生额计算每次扫描时按当前版本识别。入库、计算与导出仍按内置 28 列。
  resource({ id: 'flow-statement', path: 'assets/流水对账单.xlsx', type: 'input', readMode: 'runtime',
    bindings: [binding('biz-op-recon', '导入 · 识别结构', 'runtime'), binding('vcc-op-calc', '导入扫描 · 识别结构', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次导入或扫描时读取',
    failure: '当前版本缺失、被修改或不兼容时导入 / 扫描中止，提示恢复默认或重新导入',
    effect: '下次导入或扫描；已导入的业务 OP 数据按导入时结构重读原件，入库、计算与导出仍按内置 28 列' }),
  // 单据对账（C4 单据模式）：导入时按当前版本 4 张工作表的表头识别；场景配置的主 / 从字段下拉随当前版本。
  resource({ id: 'doc-recon-unbalanced', path: 'assets/单据对账导出不平.xlsx', type: 'input', readMode: 'runtime',
    bindings: [binding('recon-id-fix', '导入识别结构 · 4 张 Sheet；场景字段下拉', 'runtime')],
    replace: REPLACEABLE, cache: '不缓存，每次导入与打开场景配置时读取',
    failure: '当前版本缺失、被修改或不兼容时导入中止，提示恢复默认或重新导入',
    effect: '下次导入；只认当前版本结构，必用列与场景引用的列须保留' }),
  resource({ id: 'position-payment-full', path: 'assets/中台测试付款全量信息表.xlsx', type: 'input', ...POSITION_INPUT_STRUCTURE }),
  resource({ id: 'position-gateway-raw-in', path: 'assets/中台网关原始入账订单.xlsx', type: 'input', ...POSITION_INPUT_STRUCTURE }),
  resource({ id: 'position-gateway-raw-out', path: 'assets/中台网关原始出账订单.xlsx', type: 'input', ...POSITION_INPUT_STRUCTURE }),
  resource({ id: 'position-transfer-orders', path: 'assets/中台调拨订单表.xlsx', type: 'input', ...POSITION_INPUT_STRUCTURE,
    twin: 'transfer-order', twinNote: SAME_EXPORT_NOTE }),
  resource({ id: 'position-bank-accounts', path: 'assets/清结算银行账户表.xlsx', type: 'input', ...POSITION_INPUT_STRUCTURE }),
  // 与 Pending 对账「移除归档Pending账单」是同一份系统导出（46 列），各自独立版本。
  resource({ id: 'vcc-removed-pending', path: 'assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx', type: 'input', ...VCC_INPUT_STRUCTURE,
    twin: 'removed-pending', twinNote: SAME_EXPORT_NOTE }),
  resource({ id: 'vcc-recharge-refund', path: 'assets/VCC财务OP校验/VCC充值清退明细.xlsx', type: 'input', ...VCC_INPUT_STRUCTURE }),
  resource({ id: 'vcc-fee-fx', path: 'assets/VCC财务OP校验/VCC费用及换汇明细.xlsx', type: 'input', ...VCC_INPUT_STRUCTURE }),
  resource({ id: 'vcc-channel', path: 'assets/VCC财务OP校验/VCC通道明细.xlsx', type: 'input', ...VCC_INPUT_STRUCTURE }),
  resource({ id: 'vcc-system-op', path: 'assets/VCC财务OP校验/系统财务OP.xlsx', type: 'input', ...VCC_INPUT_STRUCTURE }),
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
