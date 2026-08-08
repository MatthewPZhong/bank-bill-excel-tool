'use strict';

const crypto = require('node:crypto');
const {
  PENDING_HEADERS,
  PENDING_V1_HEADERS,
  normalizeHeaderRow
} = require('./definitions');

const PENDING_TEMPLATE_FILE_SHA256 = 'f7967d46f2c95a87d53b99f15622d6e5480e77f67c3d345daa1c250e7b6ca9fc';
const PENDING_TEMPLATE_HEADER_SHA256 = '3a67e7e16c19a7ba79afd510aa75cdb3c4b3d5e545da407b6ff5fafdd0d9e9cf';
const PENDING_TEMPLATE_RANGE = 'A1:AT1';
const PENDING_TEMPLATE_FILE_NAME = 'VCC_移除归档Pending账单.xlsx';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function headerFingerprint(headers) {
  return sha256(JSON.stringify(normalizeHeaderRow(headers)));
}

function pendingHeaderCandidate(rows) {
  const expectedSet = new Set([...PENDING_HEADERS, ...PENDING_V1_HEADERS]);
  let best = null;
  for (const row of rows || []) {
    const actual = normalizeHeaderRow(row.values);
    const uniqueOverlap = new Set(actual.filter((header) => expectedSet.has(header))).size;
    const positionMatches = PENDING_HEADERS.reduce((count, header, index) => (
      count + (actual[index] === header ? 1 : 0)
    ), 0);
    if (uniqueOverlap < Math.ceil(PENDING_HEADERS.length / 2)) continue;
    const candidate = { ...row, actual, uniqueOverlap, positionMatches };
    if (!best
      || candidate.uniqueOverlap > best.uniqueOverlap
      || (candidate.uniqueOverlap === best.uniqueOverlap
        && candidate.positionMatches > best.positionMatches)) {
      best = candidate;
    }
  }
  return best;
}

function pendingHeaderMismatchDetails(candidate) {
  const actual = candidate ? candidate.actual : [];
  const details = [
    `最新模板要求 ${PENDING_HEADERS.length} 列，实际识别到 ${actual.length} 列`,
    `请使用 assets/VCC财务OP校验/${PENDING_TEMPLATE_FILE_NAME}，并保留完整表头及原顺序`
  ];
  const mismatchCount = Math.max(actual.length, PENDING_HEADERS.length);
  for (let index = 0; index < mismatchCount && details.length < 10; index++) {
    const expectedHeader = PENDING_HEADERS[index] || '（无此列）';
    const actualHeader = actual[index] || '（缺失）';
    if (expectedHeader !== actualHeader) {
      details.push(`第 ${index + 1} 列应为“${expectedHeader}”，实际为“${actualHeader}”`);
    }
  }
  return details;
}

function legacyPendingUpgradeDetails() {
  return [
    '旧 48 列模板包含已移除字段“是否错币”“金额差”',
    `请改用 46 列 ${PENDING_TEMPLATE_FILE_NAME}`
  ];
}

module.exports = {
  PENDING_TEMPLATE_FILE_SHA256,
  PENDING_TEMPLATE_HEADER_SHA256,
  PENDING_TEMPLATE_RANGE,
  PENDING_TEMPLATE_FILE_NAME,
  sha256,
  headerFingerprint,
  pendingHeaderCandidate,
  pendingHeaderMismatchDetails,
  legacyPendingUpgradeDetails
};
