'use strict';

// 设置 → 模板文件：输入原表的结构规格。可替换的输入原表以模板文件中对应工作表的表头行作为导入识别结构，
//   用户版本的表头在检查 Worker 中解析并随版本记录保存，导入时由各模块经模板服务读取当前版本。
// sheets：按顺序列出参与识别的工作表。name 为 null 时取模板文件第 1 个工作表（单表原表），否则按名查找。
//   builtinHeaders 为代码中的内置结构；required 为程序按列名读取的必用列，由各模块常量提供；
//   referenceKey 指向场景引用集合（如 C4 主边 / 从边字段），被场景引用的列视同必用列。
// group 内的表在导入时互相区分，结构不能相同（目前只用于单表原表）。
// runtimeHeaders(filePath) 用模块导入时同一个读取函数读出各工作表的表头（与 sheets 一一对应）：
//   模板检查以它核对解析口径，富文本、数字、布尔等表头在导入时读出的列名不同，预检直接拒绝。

const path = require('node:path');

const {
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../position-reconciliation/constants');
const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS,
  ORDER_REPAIR_SHEET_NAME,
  RECON_ID_FIX_BILL_REQUIRED_FIELDS,
  RECON_RESULT_FIELDS,
  RECON_RESULT_REQUIRED_FIELDS,
  RECON_RESULT_SHEET_NAME
} = require('../../constants/recon-id-fix-fields');

// 平盘链接原始表：与导入 Worker 相同的流式读取（openPositionWorkbook + readPhysicalHeader）。按需加载，目录不依赖导入模块。
async function positionRuntimeHeaders(filePath) {
  const {
    openPositionWorkbook,
    readPhysicalHeader
  } = require('../../backend/position-reconciliation-import/xlsx-reader');
  const workbook = await openPositionWorkbook(filePath, { sstTempRoot: path.join(path.dirname(filePath), 'sst') });
  try {
    return [await readPhysicalHeader(workbook, workbook.sheets[0])];
  } finally {
    await workbook.close();
  }
}

function positionSource(sourceType) {
  return Object.freeze({
    group: 'position-sources',
    moduleKey: sourceType,
    sheets: Object.freeze([Object.freeze({
      name: null,
      builtinHeaders: () => [...SOURCE_DEFINITIONS[sourceType].headers],
      required: () => [...SOURCE_REQUIRED_FIELDS[sourceType]]
    })]),
    runtimeHeaders: positionRuntimeHeaders
  });
}

// 单据对账（C4 单据模式）：与 recon-id-fix-io 相同的 SheetJS 读法（第 1 行原样转字符串，不 trim）。
async function reconIdFixRuntimeHeaders(filePath) {
  const { readReconIdFixSheetHeaders } = require('../recon-id-fix-io');
  return readReconIdFixSheetHeaders(filePath, DOC_RECON_SHEETS.map((sheet) => sheet.name));
}

function namedSheet(name, headers, required, referenceKey = null) {
  return Object.freeze({
    name,
    builtinHeaders: () => [...headers],
    required: () => [...required],
    referenceKey
  });
}

const DOC_RECON_SHEETS = Object.freeze([
  namedSheet(RECON_RESULT_SHEET_NAME, RECON_RESULT_FIELDS, RECON_RESULT_REQUIRED_FIELDS),
  namedSheet(BUSINESS_BILL_SHEET_NAME, BUSINESS_BILL_FIELDS, RECON_ID_FIX_BILL_REQUIRED_FIELDS, 'reconIdFixMainFields'),
  namedSheet(OPPONENT_BILL_SHEET_NAME, OPPONENT_BILL_FIELDS, RECON_ID_FIX_BILL_REQUIRED_FIELDS, 'reconIdFixOppFields'),
  namedSheet(ORDER_REPAIR_SHEET_NAME, ORDER_REPAIR_FIELDS, [])
]);

const INPUT_STRUCTURES = Object.freeze({
  'position-payment-full': positionSource(SOURCE_TYPES.TEST_PAYMENT),
  'position-gateway-raw-in': positionSource(SOURCE_TYPES.GATEWAY_INBOUND),
  'position-gateway-raw-out': positionSource(SOURCE_TYPES.GATEWAY_OUTBOUND),
  'position-transfer-orders': positionSource(SOURCE_TYPES.FUND_TRANSFER),
  'position-bank-accounts': positionSource(SOURCE_TYPES.BANK_ACCOUNT),
  'doc-recon-unbalanced': Object.freeze({
    group: null,
    moduleKey: 'recon-id-fix-business',
    sheets: DOC_RECON_SHEETS,
    runtimeHeaders: reconIdFixRuntimeHeaders
  })
});

function inputStructureOf(resourceId) {
  return Object.hasOwn(INPUT_STRUCTURES, resourceId) ? INPUT_STRUCTURES[resourceId] : null;
}

// 单表原表（第 1 个工作表）的结构以表头列表比较与展示；多表原表以「工作表」列名的标签比较与展示。
function isSingleSheetStructure(spec) {
  return spec.sheets.length === 1 && spec.sheets[0].name === null;
}

function structureLabel(sheetName, header) {
  return `「${sheetName}」${header}`;
}

function inputStructurePeers(resourceId) {
  const spec = inputStructureOf(resourceId);
  if (!spec || !spec.group) return [];
  return Object.keys(INPUT_STRUCTURES).filter((id) => id !== resourceId && INPUT_STRUCTURES[id].group === spec.group);
}

// 模块侧按自己的键（平盘为来源类型）查找资源。
function inputStructureResourceId(group, moduleKey) {
  return Object.keys(INPUT_STRUCTURES)
    .find((id) => INPUT_STRUCTURES[id].group === group && INPUT_STRUCTURES[id].moduleKey === moduleKey) || null;
}

module.exports = {
  INPUT_STRUCTURES,
  inputStructureOf,
  inputStructurePeers,
  inputStructureResourceId,
  isSingleSheetStructure,
  structureLabel
};
