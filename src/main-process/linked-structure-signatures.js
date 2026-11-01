'use strict';

// 银行账单处理：网关对账单、中台调拨订单、中台退款订单、外汇交割表 4 张表的识别签名随设置 → 模板文件的当前版本。
//   内置版本：签名原样（识别与读取口径不变）。用户版本：expectedHeaders 取当前版本、只认逐列完全一致（structureExact），
//   读出的行在入库 / 会话前对应回内置列名（canonicalHeaderMapping），派生、匹配、前置资金对账与导出按内置列名读取不受影响。
//   当前版本不可用时签名带 structureUnavailable，调用方中止该表导入并提示。纯函数，main.js 两个导入入口共用。

const {
  canonicalHeaderMapping,
  describeHeaderMismatch,
  projectObjectToCanonical
} = require('../backend/file-service/header-structure-diff');

// detector tableKey → 模板资源 id；keepExtra：当前版本多出的列是否入库（网关对账单的新增列入库，C3 可用）。
const LINKED_STRUCTURE_RESOURCES = Object.freeze({
  'gateway-recon': Object.freeze({ resourceId: 'gateway-recon', keepExtra: true }),
  'zhongtai-dispatch-order': Object.freeze({ resourceId: 'transfer-order', keepExtra: false }),
  'zhongtai-refund-order': Object.freeze({ resourceId: 'refund-order', keepExtra: false }),
  'fx-delivery': Object.freeze({ resourceId: 'fx-delivery', keepExtra: false })
});

function effectiveLinkedSignature(signature, current) {
  const binding = signature && LINKED_STRUCTURE_RESOURCES[signature.tableKey];
  if (!binding || !current || current.status === 'builtin') return signature;
  if (current.status === 'unavailable') {
    return Object.freeze({ ...signature, structureUnavailable: current.message || '模板当前版本不可用' });
  }
  const versionHeaders = [...current.headers];
  return Object.freeze({
    ...signature,
    expectedHeaders: Object.freeze(versionHeaders),
    l1MatchHeaders: undefined,
    structureExact: true,
    versionLabel: current.label,
    structureProjection: Object.freeze({
      canonicalHeaders: Object.freeze([...signature.expectedHeaders]),
      versionHeaders: Object.freeze(versionHeaders),
      mapping: canonicalHeaderMapping(signature.expectedHeaders, versionHeaders),
      keepExtra: binding.keepExtra
    })
  });
}

// resolveCurrent(resourceId) → 模板服务 currentInputStructure 的结果；读取异常按内置处理（不阻断其余表）。
async function resolveLinkedSignatures(signatures, resolveCurrent) {
  const resolved = [];
  for (const signature of signatures) {
    const binding = LINKED_STRUCTURE_RESOURCES[signature.tableKey];
    if (!binding) {
      resolved.push(signature);
      continue;
    }
    let current = null;
    try {
      current = await resolveCurrent(binding.resourceId);
    } catch (_error) {
      current = null;
    }
    resolved.push(effectiveLinkedSignature(signature, current));
  }
  return resolved;
}

function projectLinkedRow(signature, row) {
  const projection = signature && signature.structureProjection;
  if (!projection) return row;
  return projectObjectToCanonical(row, projection.canonicalHeaders, projection.versionHeaders, projection.mapping, {
    keepExtra: projection.keepExtra
  });
}

// 识别失败（未识别 / 指纹相近但不是当前版本）时的差异明细：文件前几行与各候选结构比较，取最接近的一个。
function linkedStructureMismatchLines(detected, signatures) {
  const sheets = detected && Array.isArray(detected.headerCandidates) ? detected.headerCandidates : [];
  if (!sheets.length) return [];
  const pool = detected.tableKey
    ? signatures.filter((signature) => signature.tableKey === detected.tableKey)
    : signatures;
  return describeHeaderMismatch({
    sheets,
    candidates: pool.map((signature) => ({
      name: signature.label || signature.tableKey,
      headers: signature.expectedHeaders,
      versionLabel: signature.versionLabel || ''
    }))
  });
}

module.exports = {
  LINKED_STRUCTURE_RESOURCES,
  effectiveLinkedSignature,
  linkedStructureMismatchLines,
  projectLinkedRow,
  resolveLinkedSignatures
};
