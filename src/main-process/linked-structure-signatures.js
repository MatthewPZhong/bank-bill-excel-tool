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

// 当前用户版本的签名：只认版本表头逐列一致，读出的行经 structureProjection 对应回内置列名。
function versionSignature(signature, current, keepExtra) {
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
      keepExtra
    })
  });
}

function effectiveLinkedSignature(signature, current) {
  const binding = signature && LINKED_STRUCTURE_RESOURCES[signature.tableKey];
  if (!binding || !current || current.status === 'builtin') return signature;
  if (current.status === 'unavailable') {
    return Object.freeze({ ...signature, structureUnavailable: current.message || '模板当前版本不可用' });
  }
  return versionSignature(signature, current, binding.keepExtra);
}

// 银行对账单（D17）：启用「银行对账单（导入识别结构）」用户版本后同时接受内置 46 列与当前版本——
//   内置签名保留，另追加当前版本的逐列一致签名（银行对账单与入金表同构，两者各追加一条）。
//   当前版本不可用或为内置时只认内置 46 列。
const BANK_STATEMENT_TABLE_KEYS = Object.freeze(['bank-statement', 'bank-deposit']);
function withBankStatementStructure(signatures, current) {
  if (!current || current.status !== 'user') return signatures;
  const extra = signatures.filter((signature) => BANK_STATEMENT_TABLE_KEYS.includes(signature.tableKey))
    .map((signature) => versionSignature(signature, current, false));
  return [...signatures, ...extra];
}

// 某张表在本次签名中的当前版本签名（银行对账单、入金表）；没有时为 null。
function versionSignatureOf(signatures, tableKey) {
  return signatures.find((signature) => signature.tableKey === tableKey && signature.structureExact) || null;
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
  BANK_STATEMENT_TABLE_KEYS,
  LINKED_STRUCTURE_RESOURCES,
  effectiveLinkedSignature,
  versionSignatureOf,
  withBankStatementStructure,
  linkedStructureMismatchLines,
  projectLinkedRow,
  resolveLinkedSignatures
};
