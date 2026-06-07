// v2.1.16 阶段一 A2：按表头自动识别 Excel 表类型
//
// detectTableType(filePath, candidateSignatures) → { tableKey, score, status }
//   status: 'matched' | 'ambiguous' | 'unrecognized' | 'read-error'
//
// 两层识别策略（先精确、后模糊）：
//   L1 精确层：对每个候选签名调 readers.readRowsWithMetadata(filePath, 锚点表头)。
//             readRowsWithMetadata 内部做「连续子序列全等」匹配，命中即说明该表头存在 → score=1.0。
//             - 单签名命中 → matched
//             - 多签名同时命中 → ambiguous（无法唯一判定）
//             - 含中间空列的表（如外汇交割表）用签名的 l1MatchHeaders 作锚点，否则用 expectedHeaders。
//   L2 模糊层：L1 全部未命中时，用 readRowsWithMetadata(filePath, []) 取全部有意义行，
//             扫描前 N 行，对每签名计算 signatureHeaders 命中率（命中数 / signatureHeaders 数），
//             取命中率最高者；≥ 该签名 minScore 才判 matched，否则 unrecognized。
//
// 防子集误判（4 列回填模板 vs 长订单表）：
//   L1 对「短表」额外加列数守卫——要求文件首个有意义行的有效列数与签名 expectedHeaders 列数精确相等，
//   再叠加 readRowsWithMetadata 的「全命中」，双约束避免短表表头被长表数据行碰巧命中（反之亦然）。
//
// ⚠️ 大小写敏感：底层 normalizeCell 仅 trim 不改大小写，签名指纹列保留原始大小写（网关全小写 vs 银行驼峰）。

const { FileValidationError, normalizeCell } = require('../backend/file-service/common');
const readers = require('../backend/file-service/readers');
const { ALL_TABLE_SIGNATURES } = require('../constants/table-signatures');

// L2 扫描的最大行数（表头通常在前几行；交割表标题+表头也在前 2 行内，N=20 足够冗余）
const L2_HEADER_SCAN_ROWS = 20;

// 「短表」阈值：expectedHeaders 列数 ≤ 此值的签名在 L1 启用列数精确守卫（防子集误判，针对 4 列回填模板等）
const SHORT_TABLE_COLUMN_THRESHOLD = 8;

// readRowsWithMetadata 在「表头未匹配」与「真·读不了」时都抛 FileValidationError('FILE_READ', ...)，
// 用 message 关键字区分：含「未匹配」视为正常未命中（继续尝试其他签名 / 进 L2），其余视为真读错。
function isHeaderNotMatchedError(error) {
  return (
    error instanceof FileValidationError &&
    error.code === 'FILE_READ' &&
    typeof error.message === 'string' &&
    error.message.includes('未匹配')
  );
}

// 取 L1 精确匹配锚点：含中间空列的签名用 l1MatchHeaders，否则用 expectedHeaders。
function getL1Anchor(signature) {
  if (Array.isArray(signature.l1MatchHeaders) && signature.l1MatchHeaders.length > 0) {
    return signature.l1MatchHeaders;
  }
  return Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders : [];
}

// 取文件首个有意义行的有效列数（去尾部空列后的长度）。读不出则返回 -1。
// 用于短表的列数守卫。注意：readRowsWithMetadata([]) 返回的 rows 已 trimTrailingEmptyCells。
function getFirstRowColumnCount(meaningfulRows) {
  if (!Array.isArray(meaningfulRows) || meaningfulRows.length === 0) {
    return -1;
  }
  // 对每行算有效列数，取「最宽」的一行作为该表列宽参考（标题行可能很窄，真实表头/数据行才是全宽）。
  let maxCount = 0;
  for (const row of meaningfulRows) {
    if (!Array.isArray(row)) continue;
    let count = 0;
    for (let i = 0; i < row.length; i += 1) {
      if (normalizeCell(row[i]) !== '') {
        count = i + 1; // 末个非空列下标 +1 = 有效列数
      }
    }
    if (count > maxCount) {
      maxCount = count;
    }
  }
  return maxCount;
}

// L1 精确层：返回所有「精确命中」的签名 tableKey 列表（命中即 score=1.0）。
// 同时返回 readError 标记：若任一签名调用抛出「真·读错」（非未匹配），上抛给主流程判 read-error。
function runExactLayer(filePath, candidateSignatures, firstRowColumnCount) {
  const matchedKeys = [];

  for (const signature of candidateSignatures) {
    const anchor = getL1Anchor(signature);
    if (anchor.length === 0) {
      // 占位/空签名（如期权 TODO）跳过，不参与匹配
      continue;
    }

    // 短表列数守卫：expectedHeaders 很短的签名（如 4 列回填模板）要求文件列宽与之精确相等，
    // 否则跳过该签名的 L1，避免被长表碰巧命中（反向：长表用在短文件上 readers 本身会因列不足而失败）。
    const expectedLen = Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders.length : 0;
    if (
      expectedLen > 0 &&
      expectedLen <= SHORT_TABLE_COLUMN_THRESHOLD &&
      firstRowColumnCount >= 0 &&
      firstRowColumnCount !== expectedLen
    ) {
      continue;
    }

    try {
      readers.readRowsWithMetadata(filePath, anchor);
      matchedKeys.push(signature.tableKey);
    } catch (error) {
      if (isHeaderNotMatchedError(error)) {
        continue; // 该签名未命中，正常，试下一个
      }
      // 真·读错（文件为空/损坏/类型错误）：直接上抛，由 detectTableType 统一转 read-error
      throw error;
    }
  }

  return matchedKeys;
}

// L2 模糊层：扫描前 N 行，对每签名计算 signatureHeaders 命中率，返回最佳结果。
// rowsCellSet：前 N 行所有单元格归一化后的集合（大小写敏感，仅 trim）。
function runFuzzyLayer(meaningfulRows, candidateSignatures) {
  const scanRows = meaningfulRows.slice(0, L2_HEADER_SCAN_ROWS);
  const cellSet = new Set();
  for (const row of scanRows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const value = normalizeCell(cell);
      if (value !== '') {
        cellSet.add(value);
      }
    }
  }

  let best = { tableKey: null, score: 0, minScore: 1 };
  for (const signature of candidateSignatures) {
    const fingerprints = Array.isArray(signature.signatureHeaders) ? signature.signatureHeaders : [];
    if (fingerprints.length === 0) {
      continue; // 占位/空签名跳过
    }
    let hit = 0;
    for (const header of fingerprints) {
      if (cellSet.has(normalizeCell(header))) {
        hit += 1;
      }
    }
    const score = hit / fingerprints.length;
    if (score > best.score) {
      best = { tableKey: signature.tableKey, score, minScore: signature.minScore };
    }
  }

  return best;
}

// 主入口：识别单个文件的表类型。
// candidateSignatures 缺省 = ALL_TABLE_SIGNATURES（不含期权 TODO 占位）。
function detectTableType(filePath, candidateSignatures = ALL_TABLE_SIGNATURES) {
  const signatures = Array.isArray(candidateSignatures) ? candidateSignatures : [];

  // 先取一次「全部有意义行」：既用于短表列数守卫，又用于 L2；同时承担「文件能否读」的探测。
  let meaningfulRows;
  try {
    const result = readers.readRowsWithMetadata(filePath, []);
    meaningfulRows = Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    // 文件为空 / 不可读 / 类型不支持 → read-error
    return { tableKey: null, score: 0, status: 'read-error' };
  }

  const firstRowColumnCount = getFirstRowColumnCount(meaningfulRows);

  // —— L1 精确层 ——
  let exactMatchedKeys;
  try {
    exactMatchedKeys = runExactLayer(filePath, signatures, firstRowColumnCount);
  } catch (error) {
    // L1 内部抛出的「真·读错」
    return { tableKey: null, score: 0, status: 'read-error' };
  }

  if (exactMatchedKeys.length === 1) {
    return { tableKey: exactMatchedKeys[0], score: 1, status: 'matched' };
  }
  if (exactMatchedKeys.length > 1) {
    // 多签名精确命中，无法唯一判定
    return { tableKey: null, score: 1, status: 'ambiguous', matchedKeys: exactMatchedKeys };
  }

  // —— L2 模糊层 ——
  const best = runFuzzyLayer(meaningfulRows, signatures);
  if (best.tableKey && best.score >= best.minScore) {
    return { tableKey: best.tableKey, score: best.score, status: 'matched' };
  }

  return { tableKey: null, score: best.score, status: 'unrecognized' };
}

module.exports = {
  detectTableType,
  // 导出内部常量/工具，便于单测与排查
  L2_HEADER_SCAN_ROWS,
  SHORT_TABLE_COLUMN_THRESHOLD
};
