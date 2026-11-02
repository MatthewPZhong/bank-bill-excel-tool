'use strict';

// 设置 → 模板文件：输入原表的结构规格。可替换的输入原表以模板文件中对应工作表的表头行作为导入识别结构，
//   用户版本的表头在检查 Worker 中解析并随版本记录保存，导入时由各模块经模板服务读取当前版本。
// sheets：按顺序列出参与识别的工作表。name 为 null 时取模板文件第 1 个工作表（单表原表），否则按名查找。
//   builtinHeaders 为代码中的内置结构；required 为程序按列名读取的必用列，由各模块常量提供；
//   referenceKey 指向场景引用集合（如 C4 主边 / 从边字段），被场景引用的列视同必用列。
// group 内的表在导入时互相区分，结构不能相同（目前只用于单表原表）。
// storage 为 'canonical' 时，模块入库前把当前版本的列对应回内置列（canonicalHeaderMapping），预检展示改名、置空、不导入；
//   keepExtra 时多出的列也入库，values 为 'stored' 时取值快照（及场景引用比较）为入库后实际可用的列名。
// allowBlank：内置结构本身含空列（外汇交割表第 10 列），允许表头中间有空列。fixedPeers：识别候选中结构固定的其他签名。
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
const {
  REMOVED_PENDING_COLUMNS,
  REMOVED_PENDING_REQUIRED_COLUMNS
} = require('../../backend/pending-import/removed-reader');
const {
  BANK_DEPOSIT_SIGNATURE,
  BANK_STATEMENT_SIGNATURE,
  FX_DELIVERY_SIGNATURE,
  FX_OPTION_SIGNATURE,
  GATEWAY_RECON_SIGNATURE,
  INTAKE_ORIGINAL_ORDER_SIGNATURE,
  ZHONGTAI_DISPATCH_ORDER_SIGNATURE,
  ZHONGTAI_REFUND_ORDER_SIGNATURE
} = require('../../constants/table-signatures');
const { FT_RECON_FIELD_MAP } = require('../../constants/fund-transfer-recon-fields');
const { BANK_STATEMENT_FIELDS, BANK_STATEMENT_REQUIRED_FIELDS } = require('../../constants/bank-statement-fields');
const {
  BIZ_OP_HEADERS,
  FLOW_HEADERS: BIZ_OP_FLOW_HEADERS,
  FLOW_REQUIRED_HEADERS
} = require('../../backend/biz-op-recon-db/columns');
const {
  PENDING_V1_HEADERS,
  REQUIRED_HEADERS: VCC_REQUIRED_HEADERS,
  SOURCE_DEFINITIONS: VCC_SOURCE_DEFINITIONS,
  SOURCE_TYPES: VCC_SOURCE_TYPES,
  SYSTEM_OP_HEADERS: VCC_SYSTEM_OP_HEADERS
} = require('../../backend/vcc-financial-op/definitions');
const { REFUND_ORDER_REQUIRED_COLUMNS } = require('../../constants/refund-backfill-fields');

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

// 移除归档 Pending：与 removed-reader 相同的读法（第 1 个 sheet 首行，格式化文本、去首尾空格）。
async function removedPendingRuntimeHeaders(filePath) {
  const { readRemovedPendingHeaders } = require('../../backend/pending-import/removed-reader');
  return [readRemovedPendingHeaders(filePath)];
}

// 银行账单处理链接表：与导入相同的两种读法——单表 .xlsx 走流式头部读取，其余走 SheetJS 全量读取。
//   两种读法对布尔等表头读出的文本不同，任一与快照不一致都会在预检中被拒。返回第 headerRow 个有内容的行。
function linkedRuntimeHeaders(headerRow) {
  return async (filePath) => {
    const { readRowsWithMetadata, readMeaningfulRowsHead } = require('../../backend/file-service/readers');
    const { normalizeCell } = require('../../backend/file-service/common');
    const pick = (rows) => {
      const row = Array.isArray(rows) && Array.isArray(rows[headerRow - 1]) ? rows[headerRow - 1].map((cell) => normalizeCell(cell)) : [];
      while (row.length && row[row.length - 1] === '') row.pop();
      return row;
    };
    const sheetJs = pick(readRowsWithMetadata(filePath, []).rows);
    let streamed = sheetJs;
    try {
      streamed = pick((await readMeaningfulRowsHead(filePath, headerRow + 20)).rows);
    } catch (_error) { /* 非单表 xlsx：导入时不走流式读取 */ }
    if (JSON.stringify(streamed) === JSON.stringify(sheetJs)) return [sheetJs];
    // 两种读法结果不同：导入文件格式不同时读出的列名不同，不一致的列标出两种结果（必与快照不同，预检不通过）。
    const width = Math.max(sheetJs.length, streamed.length);
    return [Array.from({ length: width }, (_, index) => (sheetJs[index] === streamed[index]
      ? sheetJs[index]
      : `${sheetJs[index] ?? ''} / ${streamed[index] ?? ''}`))];
  };
}

function linkedTable(signature, required, extra = {}) {
  return Object.freeze({
    group: 'bank-linked',
    moduleKey: signature.tableKey,
    storage: 'canonical',
    sheets: Object.freeze([Object.freeze({
      name: null,
      builtinHeaders: () => [...signature.expectedHeaders],
      required: () => [...required],
      referenceKey: extra.referenceKey || null
    })]),
    fixedPeers: () => LINKED_FIXED_PEERS.map((peer) => ({ name: peer.label, headers: [...peer.expectedHeaders] })),
    runtimeHeaders: linkedRuntimeHeaders(extra.headerRow || 1),
    ...(extra.keepExtra ? { keepExtra: true, values: 'stored' } : {}),
    ...(extra.allowBlank ? { allowBlank: true } : {})
  });
}

// VCC 财务OP 原表：与导入相同的读法——导入预检（富工作簿，系统财务OP 另取显示值）与明细流式读取，
//   读出第 1 个工作表首个非空行。几种读法结果不同时，不一致的列标出各自结果，预检必不通过。
function vccRuntimeHeaders(sourceType) {
  return async (filePath) => {
    const { openRichWorkbook } = require('../../backend/xlsx/rich-workbook');
    const { normalizeHeaderRow } = require('../../backend/vcc-financial-op/definitions');
    const { rowValues } = require('../../backend/vcc-financial-op/workbook-import-plan');
    const { readFirstSheetHeaderRow } = require('../../backend/vcc-financial-op/workbook-reader');
    const { systemOpCellValues } = require('../../backend/vcc-financial-op/system-op-importer');
    const reads = [];
    const workbook = await openRichWorkbook(filePath, { memoryBudgetBytes: 64 * 1024 * 1024, lruMaxEntries: 8192 });
    try {
      await workbook.scanSheet(0, (row) => {
        if (reads.length) return;
        const values = rowValues(row);
        if (!values.some((value) => value !== undefined && value !== '')) return;
        reads.push(normalizeHeaderRow(values));
        if (sourceType === VCC_SOURCE_TYPES.SYSTEM_OP) {
          const display = [];
          for (const cell of row.cells) {
            if (cell.cellType !== 'blank' || cell.hasFormula) display[cell.columnIndex] = systemOpCellValues(cell).display;
          }
          reads.push(normalizeHeaderRow(Array.from(display, (value) => value ?? '')));
        }
      });
    } finally {
      await workbook.close();
    }
    if (sourceType !== VCC_SOURCE_TYPES.SYSTEM_OP) reads.push(normalizeHeaderRow(await readFirstSheetHeaderRow(filePath)));
    const [first = [], ...others] = reads;
    if (others.every((read) => JSON.stringify(read) === JSON.stringify(first))) return [first];
    const width = Math.max(...reads.map((read) => read.length));
    return [Array.from({ length: width }, (_, index) => {
      const texts = reads.map((read) => read[index] ?? '');
      return texts.every((text) => text === texts[0]) ? texts[0] : texts.join(' / ');
    })];
  };
}

// 银行对账单（导入识别结构）：readBankStatement（银行账单处理、前置资金对账、重复入账匹配）与平盘银行导入（流式）两种读法
//   读出「渠道对账单」表头行；结果不同时不一致的列标出两种结果，预检必不通过。
async function bankStatementRuntimeHeaders(filePath) {
  const { readBankStatementHeaderRow } = require('../bank-statement-io');
  const {
    openPositionWorkbook,
    readPhysicalHeader
  } = require('../../backend/position-reconciliation-import/xlsx-reader');
  const sheetJs = readBankStatementHeaderRow(filePath);
  let streamed = sheetJs;
  const workbook = await openPositionWorkbook(filePath, { sstTempRoot: path.join(path.dirname(filePath), 'sst') });
  try {
    const sheet = workbook.sheets.find((item) => item.name === '渠道对账单');
    if (sheet) streamed = await readPhysicalHeader(workbook, sheet);
  } finally {
    await workbook.close();
  }
  if (JSON.stringify(streamed) === JSON.stringify(sheetJs)) return [sheetJs];
  const width = Math.max(sheetJs.length, streamed.length);
  return [Array.from({ length: width }, (_, index) => ((sheetJs[index] ?? '') === (streamed[index] ?? '')
    ? sheetJs[index] ?? '' : `${sheetJs[index] ?? ''} / ${streamed[index] ?? ''}`))];
}

// 流水对账单：业务 OP 新版（单 Sheet 富工作簿，第 1 行）与 VCC OP 发生额计算（JSZip 流式解析首行）两种读法。
async function flowStatementRuntimeHeaders(filePath) {
  const { openSingleSheetRichWorkbook } = require('../../backend/xlsx/rich-workbook');
  const { cellText } = require('../biz-op-v327/import-adapter');
  const { readFirstWorksheetHeaderRow } = require('../../backend/vcc-op-calc-import/reader');
  let richRow = null;
  const workbook = await openSingleSheetRichWorkbook(filePath, { memoryBudgetBytes: 32 * 1024 * 1024, lruMaxEntries: 8192 });
  try {
    await workbook.scan((row) => {
      if (richRow || row.rowIndex !== 1) return;
      const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
      const width = Math.max(0, ...row.cells.map((cell) => cell.columnIndex + 1));
      richRow = Array.from({ length: width }, (_, index) => cellText(cells.get(index)));
      while (richRow.length && richRow[richRow.length - 1] === '') richRow.pop();
    });
  } finally {
    await workbook.close();
  }
  const streamed = await readFirstWorksheetHeaderRow(filePath);
  const rich = richRow || [];
  if (JSON.stringify(rich) === JSON.stringify(streamed)) return [rich];
  const width = Math.max(rich.length, streamed.length);
  return [Array.from({ length: width }, (_, index) => ((rich[index] ?? '') === (streamed[index] ?? '')
    ? rich[index] ?? '' : `${rich[index] ?? ''} / ${streamed[index] ?? ''}`))];
}

function vccSource(sourceType, builtinHeaders) {
  return Object.freeze({
    group: 'vcc-sources',
    moduleKey: sourceType,
    storage: 'canonical',
    sheets: Object.freeze([Object.freeze({
      name: null,
      builtinHeaders: () => [...builtinHeaders],
      required: () => [...VCC_REQUIRED_HEADERS[sourceType]]
    })]),
    // 旧 48 列 Pending 模板不再接受导入，新结构不能与它相同。
    fixedPeers: () => [{ name: '旧 48 列 VCC Pending 模板', headers: [...PENDING_V1_HEADERS] }],
    runtimeHeaders: vccRuntimeHeaders(sourceType)
  });
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

// 识别候选中结构固定、不随模板版本变化的签名：新结构不能与它们相同。
const LINKED_FIXED_PEERS = Object.freeze([
  BANK_STATEMENT_SIGNATURE, INTAKE_ORIGINAL_ORDER_SIGNATURE, FX_OPTION_SIGNATURE, BANK_DEPOSIT_SIGNATURE
]);
// 网关对账单：入库与派生、前置资金对账按名读取的列（C3 场景引用的列另按场景引用保护）。
const GATEWAY_RECON_REQUIRED = Object.freeze([
  'Billdate', 'Channel', 'merchantid', 'orderid', 'currency', 'amount', 'ReconBillBizId', 'reconciliationid',
  'TradeType', 'name', 'cardNo', '真实渠道', '清算网络'
]);
// 外汇交割表：主键、日期与 BOC 派生按名读取的列。
const FX_DELIVERY_REQUIRED = Object.freeze(['交易编号', '交易日期', '到期日', '货币1金额', '货币2金额']);

const INPUT_STRUCTURES = Object.freeze({
  'gateway-recon': linkedTable(GATEWAY_RECON_SIGNATURE, GATEWAY_RECON_REQUIRED, { keepExtra: true, referenceKey: 'gatewayFields' }),
  'transfer-order': linkedTable(ZHONGTAI_DISPATCH_ORDER_SIGNATURE, Object.values(FT_RECON_FIELD_MAP.mid)),
  'refund-order': linkedTable(ZHONGTAI_REFUND_ORDER_SIGNATURE, REFUND_ORDER_REQUIRED_COLUMNS),
  'fx-delivery': linkedTable(FX_DELIVERY_SIGNATURE, FX_DELIVERY_REQUIRED, { headerRow: 2, allowBlank: true }),
  'position-payment-full': positionSource(SOURCE_TYPES.TEST_PAYMENT),
  'position-gateway-raw-in': positionSource(SOURCE_TYPES.GATEWAY_INBOUND),
  'position-gateway-raw-out': positionSource(SOURCE_TYPES.GATEWAY_OUTBOUND),
  'position-transfer-orders': positionSource(SOURCE_TYPES.FUND_TRANSFER),
  'position-bank-accounts': positionSource(SOURCE_TYPES.BANK_ACCOUNT),
  'removed-pending': Object.freeze({
    group: null,
    moduleKey: 'pending-removed',
    storage: 'canonical',
    sheets: Object.freeze([Object.freeze({
      name: null,
      builtinHeaders: () => [...REMOVED_PENDING_COLUMNS],
      required: () => [...REMOVED_PENDING_REQUIRED_COLUMNS]
    })]),
    runtimeHeaders: removedPendingRuntimeHeaders
  }),
  'doc-recon-unbalanced': Object.freeze({
    group: null,
    moduleKey: 'recon-id-fix-business',
    sheets: DOC_RECON_SHEETS,
    runtimeHeaders: reconIdFixRuntimeHeaders
  }),
  'vcc-recharge-refund': vccSource(VCC_SOURCE_TYPES.RECHARGE, VCC_SOURCE_DEFINITIONS[VCC_SOURCE_TYPES.RECHARGE].headers),
  'vcc-fee-fx': vccSource(VCC_SOURCE_TYPES.FEE_FX, VCC_SOURCE_DEFINITIONS[VCC_SOURCE_TYPES.FEE_FX].headers),
  'vcc-channel': vccSource(VCC_SOURCE_TYPES.CHANNEL, VCC_SOURCE_DEFINITIONS[VCC_SOURCE_TYPES.CHANNEL].headers),
  'vcc-removed-pending': vccSource(VCC_SOURCE_TYPES.PENDING, VCC_SOURCE_DEFINITIONS[VCC_SOURCE_TYPES.PENDING].headers),
  'vcc-system-op': vccSource(VCC_SOURCE_TYPES.SYSTEM_OP, VCC_SYSTEM_OP_HEADERS),
  // 银行对账单：启用后同时接受内置 46 列（D17）；读出的行对应回内置 46 列。场景引用的银行字段受保护（bankFields）。
  'bank-statement-input': Object.freeze({
    group: null,
    moduleKey: 'bank-statement',
    storage: 'canonical',
    sheets: Object.freeze([Object.freeze({
      name: '渠道对账单',
      builtinHeaders: () => [...BANK_STATEMENT_FIELDS],
      required: () => [...BANK_STATEMENT_REQUIRED_FIELDS],
      referenceKey: 'bankFields'
    })]),
    runtimeHeaders: bankStatementRuntimeHeaders
  }),
  // 业务 OP 新版与 VCC OP 发生额计算共用；业务 OP 账单（OP）不随版本变化，新结构不能与它相同（识别时 OP 优先）。
  'flow-statement': Object.freeze({
    group: null,
    moduleKey: 'flow-statement',
    storage: 'canonical',
    sheets: Object.freeze([Object.freeze({
      name: null,
      builtinHeaders: () => [...BIZ_OP_FLOW_HEADERS],
      required: () => [...FLOW_REQUIRED_HEADERS]
    })]),
    fixedPeers: () => [{ name: '业务 OP 账单', headers: [...BIZ_OP_HEADERS] }],
    runtimeHeaders: flowStatementRuntimeHeaders
  })
});

function inputStructureOf(resourceId) {
  return Object.hasOwn(INPUT_STRUCTURES, resourceId) ? INPUT_STRUCTURES[resourceId] : null;
}

// 单表原表（第 1 个工作表，或指定名称的一个工作表）的结构以表头列表比较与展示；多表原表以「工作表」列名的标签比较与展示。
function isSingleSheetStructure(spec) {
  return spec.sheets.length === 1;
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
