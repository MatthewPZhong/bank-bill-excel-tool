'use strict';

// 设置 → 模板文件：可替换模板的导入预检与兼容复核。
// 每个契约直接调用对应模块写出时使用的校验函数，导入时的判定与运行时一致；
// 另加只在预检时检查、但会影响输出或回读的约束（如平盘结果模板的多余表头）。

const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const { PRIMARY_ARCHIVE_SCOPES } = require('../archive-center/module-scope-registry');
const { TEMPLATE_SHEETS, validateTemplateWorkbook } = require('../pre-fund-reconciliation/excel-writer');
const {
  MAIL_HEADERS,
  validateBankTemplateWorkbook,
  validateMailTemplateWorkbook
} = require('../duplicate-inbound-match/excel-writer');
const { validateResultTemplateWorkbook } = require('../position-reconciliation/excel-io');
const { BANK_SHEET_NAME, POSITION_BANK_HEADERS } = require('../position-reconciliation/constants');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { parseFundTypeEnumWorkbook } = require('../../constants/fund-type-enum');
const {
  CUSTOM_VALUE_SENTINEL,
  parseGatewayReconHeadersWorkbook
} = require('../../constants/gateway-recon-headers-loader');
const { GATEWAY_RECON_SIGNATURE } = require('../../constants/table-signatures');
const { declaredRange, sheetCells } = require('../../constants/sheetjs-sparse-cells');
const { MAX_EXCEL_ROW_HEIGHT } = require('../vcc-financial-op-writer');
const { probePendingTemplate } = require('../vcc-financial-op-result-workbook-writer');

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MODULE_NAMES = new Map(PRIMARY_ARCHIVE_SCOPES.map((scope) => [scope.id, scope.name]));
// 与 vcc-financial-op-writer buildPendingSheet 写入的表头一致（H、I 为间隔列）。
const VCC_PENDING_HEADERS = Object.freeze([
  'channel', '是否错币', '流水_币种', '币种', '备注', '求和项:流水_对账金额', '求和项:金额', 'H 列', 'I 列', '币种', '差额'
]);

const errorText = (error) => (error && error.message ? String(error.message) : '未知错误');
// 文件系统等运行环境错误（Node 系统错误带 syscall）不代表模板不兼容：检查判 fail，但结果标为 transient，不被缓存。
//   读取层会把系统错误包装成业务错误（如 ZIP 读取的 BigTableImportError、校验收尾的 AggregateError），沿 cause 与 errors 查找。
function isEnvironmentError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (typeof error.syscall === 'string') return true;
  if (Array.isArray(error.errors) && error.errors.some((item) => isEnvironmentError(item, seen))) return true;
  return isEnvironmentError(error.cause, seen);
}
const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  if (typeof value === 'object' && value.text !== undefined) return String(value.text);
  return String(value);
};
const listText = (values, limit = 3) => `${values.slice(0, limit).join('、')}${values.length > limit ? ` 等 ${values.length} 个` : ''}`;

function createCheckList() {
  const checks = [];
  let transient = false;
  return {
    checks,
    add(label, status, detail) {
      checks.push({ group: 'file', label, status, detail });
    },
    environment(label, error) {
      transient = true;
      checks.push({ group: 'file', label, status: 'fail', detail: `运行环境异常（${errorText(error)}），未能完成检查，请稍后重试` });
    },
    get failed() {
      return checks.some((check) => check.status === 'fail');
    },
    get transient() {
      return transient;
    }
  };
}

async function loadExcelWorkbook(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

// 第 1 行在指定列之后仍有内容的表头（ExcelJS 口径）。
function extraHeaders(worksheet, expectedCount) {
  const row = worksheet.getRow(1);
  const width = Math.max(worksheet.columnCount, row.cellCount);
  const extras = [];
  for (let column = expectedCount + 1; column <= width; column += 1) {
    const text = cellText(row.getCell(column).value).trim();
    if (text) extras.push(text);
  }
  return extras;
}

// 数字格式按 ; 分段（忽略引号内）：第 4 段作用于文本，不含 @ 时会替换文本；前三段全空（;;;）会隐藏数值。
function formatMasksContent(numFmt) {
  const format = String(numFmt || '');
  if (!format.includes(';')) return false;
  const sections = [];
  let current = '';
  let quoted = false;
  for (const char of format) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      sections.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  sections.push(current);
  if (sections.length >= 3 && sections.slice(0, 3).every((section) => !section.trim())) return true;
  return sections.length >= 4 && !sections[3].includes('@');
}

// 输出模板的列隐藏与数字格式会原样带进导出：金额等数据仍为原值，但人工核对时可能看不到或看错。
//   只提示（warn），由用户确认是否有意为之。
function presentationWarnings(list, worksheet, headers, { label = '', rowNumbers = [] } = {}) {
  const hidden = [];
  const masked = [];
  headers.forEach((header, index) => {
    const column = worksheet.getColumn(index + 1);
    const name = header || cellText(worksheet.getRow(1).getCell(index + 1).value) || `第 ${index + 1} 列`;
    if (column.hidden) hidden.push(name);
    const formats = [column.numFmt, ...rowNumbers.map((rowNumber) => worksheet.getRow(rowNumber).getCell(index + 1).numFmt)];
    if (formats.some(formatMasksContent)) masked.push(name);
  });
  const where = label ? `「${label}」` : '';
  if (hidden.length) list.add('隐藏列', 'warn', `${where}${listText(hidden, 5)} 在导出中隐藏`);
  if (masked.length) list.add('数字格式', 'warn', `${where}${listText(masked, 5)} 的数字格式会遮盖或替换显示内容`);
}

// 第 1 个 Sheet 声明范围首行的非空表头（只读实际存在的单元格，不按声明范围展开）。
function firstSheetHeaderRow(workbook) {
  const name = workbook.SheetNames[0];
  const sheet = name ? workbook.Sheets[name] : null;
  const range = declaredRange(sheet);
  if (!range) return [];
  return sheetCells(sheet, { s: range.s, e: { r: range.s.r, c: range.e.c } }).map((cell) => String(cell.value).trim());
}

const prefundContract = {
  engine: 'exceljs',
  check(workbook, list) {
    try {
      validateTemplateWorkbook(workbook);
    } catch (error) {
      if (error && error.code === 'pre-fund-export-template-sheet-structure') {
        list.add('Sheet 结构', 'fail', `应为「${TEMPLATE_SHEETS.map((sheet) => sheet.name).join('、')}」，实际为「${(error.actualSheetNames || []).join('、') || '无'}」`);
      } else {
        list.add('表头', 'fail', errorText(error));
      }
      return;
    }
    list.add('Sheet 结构', 'pass', `${TEMPLATE_SHEETS.length} 个，名称与顺序一致`);
    list.add('表头', 'pass', `${TEMPLATE_SHEETS.length} 个 Sheet 的表头均一致`);
    // 导出复制每列的宽度、隐藏与列样式，数据行沿用列样式。
    for (const contract of TEMPLATE_SHEETS) {
      presentationWarnings(list, workbook.getWorksheet(contract.name), contract.headers, { label: contract.name });
    }
  }
};

const mailContract = {
  engine: 'exceljs',
  check(workbook, list) {
    let sheet;
    try {
      sheet = validateMailTemplateWorkbook(workbook);
    } catch (error) {
      list.add(error && error.code === 'duplicate-inbound-mail-template-sheet-count' ? 'Sheet 结构' : '表头', 'fail', errorText(error));
      return;
    }
    list.add('Sheet 结构', 'pass', '1 个');
    list.add('表头', 'pass', `前 ${MAIL_HEADERS.length} 列一致`);
    const extras = extraHeaders(sheet, MAIL_HEADERS.length);
    if (extras.length) list.add('多余表头', 'warn', `不会写入导出：${listText(extras)}`);
  }
};

const bankStatementContract = {
  engine: 'exceljs',
  check(workbook, list) {
    let sheet;
    try {
      sheet = validateBankTemplateWorkbook(workbook);
    } catch (error) {
      list.add(error && error.code === 'duplicate-inbound-bank-template-sheet-missing' ? 'Sheet 结构' : '表头', 'fail', errorText(error));
      return;
    }
    list.add('Sheet 结构', 'pass', `包含「${sheet.name}」`);
    list.add('表头', 'pass', `前 ${BANK_STATEMENT_FIELDS.length} 列一致`);
    const extras = extraHeaders(sheet, BANK_STATEMENT_FIELDS.length);
    if (extras.length) list.add('多余表头', 'warn', `不会写入导出：${listText(extras)}`);
  }
};

const positionContract = {
  engine: 'exceljs',
  check(workbook, list, context) {
    let sheet;
    try {
      sheet = validateResultTemplateWorkbook(workbook);
    } catch (error) {
      list.add(error && error.code === 'position-template-sheet-missing' ? 'Sheet 结构' : '表头', 'fail', errorText(error));
      return;
    }
    // 整本模板会随结果写出：只允许内置模板已有的 Sheet。
    const allowed = new Set(context.builtinSheetNames || [BANK_SHEET_NAME]);
    const unexpected = workbook.worksheets.map((item) => item.name).filter((name) => !allowed.has(name));
    if (unexpected.length) list.add('Sheet 结构', 'fail', `多出 ${listText(unexpected)}，会被一并写入结果`);
    else list.add('Sheet 结构', 'pass', `包含「${BANK_SHEET_NAME}」`);
    // 结果回读要求恰好 49 列，多余表头会让导出的结果无法再导入。
    const extras = extraHeaders(sheet, POSITION_BANK_HEADERS.length);
    if (extras.length) list.add('表头', 'fail', `存在多余表头：${listText(extras)}；要求固定 ${POSITION_BANK_HEADERS.length} 列`);
    else list.add('表头', 'pass', `${POSITION_BANK_HEADERS.length} 列一致`);
    // 写出时只保留表头，第 2 行起的内容（如把旧结果当模板导入）会被清空，不进入结果。
    let dataRows = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && row.values.some((value) => cellText(value).trim())) dataRows += 1;
    });
    if (dataRows) list.add('数据区', 'warn', `第 2 行起有 ${dataRows} 行内容，导出时清空，不会写入结果`);
    presentationWarnings(list, sheet, POSITION_BANK_HEADERS);
  }
};

const fundTypeContract = {
  engine: 'sheetjs',
  check(workbook, list, context) {
    const values = parseFundTypeEnumWorkbook(workbook);
    list.add('读取范围', 'pass', '第 1 个 Sheet 第 1 列，第 2 行起');
    if (!values.length) {
      list.add('枚举值', 'fail', '未读取到取值');
      return { enumValues: values };
    }
    list.add('枚举值', 'pass', `${values.length} 个`);
    const diff = diffValues(context.currentValues, values);
    // FundType 区分大小写，下游规则按原值匹配；新增值与已有值仅大小写或空格不同时多半是笔误。
    const normalized = new Map(context.currentValues.map((value) => [value.toLowerCase().replace(/\s+/g, ''), value]));
    const lookalikes = diff.added.filter((value) => normalized.has(value.toLowerCase().replace(/\s+/g, '')))
      .map((value) => `${value}（已有 ${normalized.get(value.toLowerCase().replace(/\s+/g, ''))}）`);
    if (lookalikes.length) list.add('相近取值', 'warn', `与已有取值仅大小写或空格不同：${listText(lookalikes, 5)}`);
    const blocked = diff.removed.filter((value) => context.references.fundTypeValues.has(value));
    if (blocked.length) list.add('场景引用', 'fail', `已被场景使用：${listText(blocked, 5)}`);
    else list.add('场景引用', 'pass', '不影响已有场景');
    return { enumValues: values, diff };
  }
};

const gatewayContract = {
  engine: 'sheetjs',
  check(workbook, list, context) {
    const values = parseGatewayReconHeadersWorkbook(workbook);
    if (!values.length) {
      list.add('字段', 'fail', '第 1 行未读取到字段');
      return {};
    }
    list.add('字段', 'pass', `${values.length} 个`);
    const missing = GATEWAY_RECON_SIGNATURE.signatureHeaders.filter((header) => !values.includes(header));
    if (missing.length) list.add('识别字段', 'fail', `缺少 ${missing.join('、')}（区分大小写）`);
    else list.add('识别字段', 'pass', `${GATEWAY_RECON_SIGNATURE.signatureHeaders.length} 个均存在`);
    if (firstSheetHeaderRow(workbook).includes(CUSTOM_VALUE_SENTINEL)) list.add('保留值', 'warn', `已忽略 ${CUSTOM_VALUE_SENTINEL}`);
    const diff = diffValues(context.currentValues, values);
    const blocked = diff.removed.filter((value) => context.references.gatewayFields.has(value));
    if (blocked.length) list.add('场景引用', 'fail', `已被场景使用：${listText(blocked, 5)}`);
    else list.add('场景引用', 'pass', '不影响已有场景');
    return { diff };
  }
};

// Pending 计算表只取第 1 个 Sheet 的列隐藏、第 1 行与第 2 行样式；用正式导出的 Writer 与校验器试写一次，
// 保证导出时的写出与样式校验能通过。
const vccPendingContract = {
  engine: 'exceljs',
  async check(workbook, list) {
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      list.add('Sheet 结构', 'fail', '缺少工作表');
      return;
    }
    list.add('Sheet 结构', 'pass', `使用第 1 个 Sheet「${sheet.name}」`);
    const tooTall = [1, 2].filter((rowNumber) => Number(sheet.getRow(rowNumber).height) > MAX_EXCEL_ROW_HEIGHT);
    if (tooTall.length) {
      list.add('行高', 'fail', `第 ${tooTall.join('、')} 行超过 ${MAX_EXCEL_ROW_HEIGHT}`);
      return;
    }
    try {
      await probePendingTemplate({ pendingTemplateSheet: sheet });
      list.add('样式', 'pass', '表头行与数据行样式可正常写出');
    } catch (error) {
      if (isEnvironmentError(error)) list.environment('样式', error);
      else list.add('样式', 'fail', `无法按原样写出：${errorText(error)}`);
    }
    // 金额列 F/G/K 的数字格式由程序固定；列隐藏与其余列的第 2 行格式随模板写出。
    presentationWarnings(list, sheet, VCC_PENDING_HEADERS, { rowNumbers: [2] });
    list.add('生效范围', 'info', '表头文字、列宽、冻结、筛选、打印设置由程序固定，模板中的修改不会生效');
  }
};

const CONTRACTS = Object.freeze({
  'prefund-unbalanced': prefundContract,
  'dup-recall-mail': mailContract,
  'bank-statement': bankStatementContract,
  'position-bank': positionContract,
  'fund-type-enum': fundTypeContract,
  'gateway-recon': gatewayContract,
  'vcc-pending-calc': vccPendingContract
});

function diffValues(before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((value) => !beforeSet.has(value)),
    removed: before.filter((value) => !afterSet.has(value))
  };
}

// 场景配置中仍被引用的 FundType 取值（任意 {field:'FundType', value}）与 C3 网关字段。
function collectScenarioReferences(scenarios = []) {
  const fundTypeValues = new Set();
  const gatewayFields = new Set();
  const addGateway = (value) => {
    const text = String(value ?? '').trim();
    if (text && text !== CUSTOM_VALUE_SENTINEL) gatewayFields.add(text);
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.field === 'FundType' && typeof node.value === 'string' && node.value.trim()) fundTypeValues.add(node.value.trim());
    Object.values(node).forEach(walk);
  };
  for (const scenario of scenarios) {
    const config = scenario && scenario.config;
    if (!config || typeof config !== 'object') continue;
    walk(config);
    if (scenario.category !== 'gateway-recon-join') continue;
    (Array.isArray(config.reconFields) ? config.reconFields : []).forEach((item) => addGateway(item && item.gwField));
    (Array.isArray(config.conditions) ? config.conditions : [])
      .filter((item) => item && item.side === '网关')
      .forEach((item) => addGateway(item.field));
    addGateway(config.assign && config.assign.gwField);
  }
  return { fundTypeValues, gatewayFields };
}

function hasContract(resourceId) {
  return Object.hasOwn(CONTRACTS, resourceId);
}

// 契约检查：不含文件格式、大小与重复版本等导入专属检查，用于导入预检与已存版本的兼容复核。
//   context: { builtinSheetNames, currentValues, references }
async function inspectContract(resourceId, bytes, context = {}) {
  const contract = CONTRACTS[resourceId];
  if (!contract) throw new Error(`模板「${resourceId}」没有导入契约`);
  const list = createCheckList();
  const fullContext = {
    builtinSheetNames: context.builtinSheetNames,
    currentValues: context.currentValues || [],
    references: context.references || { fundTypeValues: new Set(), gatewayFields: new Set() }
  };
  let workbook;
  try {
    workbook = contract.engine === 'sheetjs'
      ? XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellText: false })
      : await loadExcelWorkbook(bytes);
  } catch (error) {
    list.add('读取文件', 'fail', `文件无法读取：${errorText(error)}`);
    return { checks: list.checks, ok: false, message: list.checks[0].detail, diff: { added: [], removed: [] } };
  }
  let extra = {};
  try {
    extra = (await contract.check(workbook, list, fullContext)) || {};
  } catch (error) {
    if (isEnvironmentError(error)) list.environment('读取文件', error);
    else list.add('读取文件', 'fail', `文件无法解析：${errorText(error)}`);
  }
  const failure = list.checks.find((check) => check.status === 'fail');
  return {
    checks: list.checks,
    ok: !failure,
    transient: list.transient,
    message: failure ? `${failure.label}：${failure.detail}` : '',
    diff: extra.diff || { added: [], removed: [] },
    enumValues: extra.enumValues
  };
}

function usageChecks(resource, compatible) {
  return resource.bindings.map((binding) => {
    const label = MODULE_NAMES.get(binding.moduleId) || binding.moduleId;
    if (binding.read === 'none') return { group: 'usage', label, status: 'info', detail: `${binding.use} · 不受影响` };
    return { group: 'usage', label, status: compatible ? 'pass' : 'fail', detail: `${binding.use} · ${compatible ? '兼容' : '不兼容'}` };
  });
}

function verdictOf(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

module.exports = {
  MAX_IMPORT_BYTES,
  collectScenarioReferences,
  diffValues,
  hasContract,
  inspectContract,
  usageChecks,
  verdictOf
};
