'use strict';

// 设置 → 模板文件：输入原表的结构规格。可替换的输入原表以模板第 1 个工作表的表头行作为导入识别结构，
//   用户版本的表头在检查 Worker 中解析并随版本记录保存（取值快照），导入时由各模块经模板服务读取当前版本。
// required 为程序按列名读取的必用列，由各模块常量提供；group 内的表在导入时互相区分，结构不能相同。
// runtimeHeaders(filePath) 用模块导入时同一个读取函数读第 1 个工作表的表头：模板检查以它核对解析口径，
//   富文本、数字、布尔等表头在导入时读出的列名不同，预检直接拒绝，避免启用后仍无法识别。

const path = require('node:path');

const {
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../position-reconciliation/constants');

// 平盘链接原始表：与导入 Worker 相同的流式读取（openPositionWorkbook + readPhysicalHeader）。按需加载，目录不依赖导入模块。
async function positionRuntimeHeaders(filePath) {
  const {
    openPositionWorkbook,
    readPhysicalHeader
  } = require('../../backend/position-reconciliation-import/xlsx-reader');
  const workbook = await openPositionWorkbook(filePath, { sstTempRoot: path.join(path.dirname(filePath), 'sst') });
  try {
    return await readPhysicalHeader(workbook, workbook.sheets[0]);
  } finally {
    await workbook.close();
  }
}

function positionSource(sourceType) {
  return Object.freeze({
    group: 'position-sources',
    moduleKey: sourceType,
    builtinHeaders: () => [...SOURCE_DEFINITIONS[sourceType].headers],
    required: () => [...SOURCE_REQUIRED_FIELDS[sourceType]],
    runtimeHeaders: positionRuntimeHeaders
  });
}

const INPUT_STRUCTURES = Object.freeze({
  'position-payment-full': positionSource(SOURCE_TYPES.TEST_PAYMENT),
  'position-gateway-raw-in': positionSource(SOURCE_TYPES.GATEWAY_INBOUND),
  'position-gateway-raw-out': positionSource(SOURCE_TYPES.GATEWAY_OUTBOUND),
  'position-transfer-orders': positionSource(SOURCE_TYPES.FUND_TRANSFER),
  'position-bank-accounts': positionSource(SOURCE_TYPES.BANK_ACCOUNT)
});

function inputStructureOf(resourceId) {
  return Object.hasOwn(INPUT_STRUCTURES, resourceId) ? INPUT_STRUCTURES[resourceId] : null;
}

function inputStructurePeers(resourceId) {
  const spec = inputStructureOf(resourceId);
  if (!spec) return [];
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
  inputStructureResourceId
};
