// v2.1.16 阶段一 A2：按表头自动识别 Excel 表类型
//
// detectTableType(filePath, candidateSignatures) → { tableKey, score, status }
//   status: 'matched' | 'ambiguous' | 'unrecognized' | 'unsupported' | 'read-error'
//
// 两层识别策略（先精确、后模糊）：
//   L1 精确层：对每个候选签名调 readers.readRowsWithMetadata(filePath, 锚点表头, { sheetName })。
//             readRowsWithMetadata 内部做「连续子序列全等」匹配，命中即说明该表头存在 → score=1.0。
//             - 单签名命中 → matched
//             - 多签名同时命中 → ambiguous（无法唯一判定）
//             - 含中间空列的表（如外汇交割表）用签名的 l1MatchHeaders 作锚点，否则用 expectedHeaders。
//   L2 模糊层：L1 全部未命中时，用 readRowsWithMetadata(filePath, [], { sheetName }) 取全部有意义行，
//             扫描前 N 行，对每签名计算 signatureHeaders 命中率（命中数 / signatureHeaders 数），
//             取命中率最高者；≥ 该签名 minScore 才判 matched，否则 unrecognized。
//
// v2.1.16 PR#61 F4：多 sheet 扫描（真回归修复）——
//   底层 readWorkbookRows 历史上只读 SheetNames[0]；若银行对账单文件有封面/汇总 sheet 排在
//   「渠道对账单」之前，detector 只看第一个 sheet 会误判 unrecognized（单选 readBankStatement 按
//   sheet 名「渠道对账单」读不受影响）。现改为：listSheetNames 取全部 sheet，逐 sheet 跑 L1；
//   任一 sheet 命中即返回（短路，不再扫后续 sheet → 大文件多 sheet 也只多解析到命中那张为止）；
//   全部 sheet L1 未命中再逐 sheet 跑 L2 取全局最佳。CSV 无 sheet 概念 → 单次默认读取（sheetName=null）。
//
// v2.1.16 PR#61 F3：外汇期权表模板已入库（assets/外汇期权订单.xlsx）——
//   签名已纳入候选并按实测表头识别；但本阶段不接入落库，detector 识别到 fx-option 时返回
//   status='unsupported'（区别于 unrecognized），handler 据此提示「已入库待阶段二接入」。
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

// L1 精确层：返回某个 sheet 上所有「精确命中」的签名 tableKey 列表（命中即 score=1.0）。
// sheetName=null 表示读默认（第一个）sheet 或 CSV 整表；否则读指定 sheet（F4 多 sheet 扫描）。
// 若调用抛出「真·读错」（非未匹配），上抛给主流程判 read-error。
function runExactLayer(filePath, candidateSignatures, firstRowColumnCount, sheetName = null) {
  const matchedKeys = [];

  for (const signature of candidateSignatures) {
    const anchor = getL1Anchor(signature);
    if (anchor.length === 0) {
      // 占位/空签名（如未实测的模板）跳过，不参与匹配
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
      readers.readRowsWithMetadata(filePath, anchor, { sheetName });
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

// tableKey 命中后归一为对外 status：fx-option（外汇期权表）本阶段已入库但不接入落库 → 'unsupported'；
// 其余正常表 → 'matched'。F3：让 handler 能区分「已入库待阶段二」与「未识别」。
const UNSUPPORTED_TABLE_KEYS = new Set(['fx-option']);

function statusForMatchedKey(tableKey) {
  return UNSUPPORTED_TABLE_KEYS.has(tableKey) ? 'unsupported' : 'matched';
}

// 读取单个 sheet 的「全部有意义行」（用于短表列数守卫 + L2）；读不出（未匹配/空 sheet）返回 null。
// sheetName=null → 默认 sheet / CSV 整表。
function readSheetMeaningfulRows(filePath, sheetName) {
  try {
    const result = readers.readRowsWithMetadata(filePath, [], { sheetName });
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    if (isHeaderNotMatchedError(error)) {
      // expectedHeaders=[] 不会触发「未匹配」，但 sheet 本身无有意义行会抛 FILE_READ；
      // 这里把「空 sheet」视为该 sheet 无内容（返回 null 跳过），不让某张空封面 sheet 误判整个文件 read-error。
      return null;
    }
    // 其余 FILE_READ（如该 sheet 解析失败）也按「该 sheet 跳过」处理；真·文件级读错由
    // detectTableType 顶层的 listSheetNames 提前拦截。
    return null;
  }
}

// 在单个 sheet 上跑 L1，返回 { matchedKeys, meaningfulRows }；meaningfulRows=null 表示该 sheet 无内容。
function detectInSheet(filePath, signatures, sheetName) {
  const meaningfulRows = readSheetMeaningfulRows(filePath, sheetName);
  if (meaningfulRows === null || meaningfulRows.length === 0) {
    return { matchedKeys: [], meaningfulRows: null };
  }
  const firstRowColumnCount = getFirstRowColumnCount(meaningfulRows);
  const matchedKeys = runExactLayer(filePath, signatures, firstRowColumnCount, sheetName);
  return { matchedKeys, meaningfulRows };
}

// 主入口：识别单个文件的表类型（v2.1.16 F4：扫所有 sheet，任一命中即返回，短路余下 sheet）。
// candidateSignatures 缺省 = ALL_TABLE_SIGNATURES。
function detectTableType(filePath, candidateSignatures = ALL_TABLE_SIGNATURES) {
  const signatures = Array.isArray(candidateSignatures) ? candidateSignatures : [];

  // 文件级可读性探测 + 取 sheet 列表（CSV → [null]）。失败 → read-error。
  let sheetNames;
  try {
    sheetNames = readers.listSheetNames(filePath);
  } catch (error) {
    return { tableKey: null, score: 0, status: 'read-error' };
  }

  // —— L1 精确层（逐 sheet，短路）——
  // 收集每个 sheet 的 meaningfulRows 供 L1 全落空后的 L2 复用（避免二次读盘）。
  const sheetRowsCache = [];
  let anySheetReadable = false;
  for (const sheetName of sheetNames) {
    let perSheet;
    try {
      perSheet = detectInSheet(filePath, signatures, sheetName);
    } catch (error) {
      // L1 内部抛出的「真·读错」（非未匹配）→ 整个文件判 read-error
      return { tableKey: null, score: 0, status: 'read-error' };
    }

    if (perSheet.meaningfulRows !== null) {
      anySheetReadable = true;
      sheetRowsCache.push(perSheet.meaningfulRows);
    }

    if (perSheet.matchedKeys.length === 1) {
      // 任一 sheet 单命中 → 立即返回（短路，不再扫后续 sheet）
      const tableKey = perSheet.matchedKeys[0];
      return { tableKey, score: 1, status: statusForMatchedKey(tableKey) };
    }
    if (perSheet.matchedKeys.length > 1) {
      // 同一 sheet 多签名精确命中，无法唯一判定
      return { tableKey: null, score: 1, status: 'ambiguous', matchedKeys: perSheet.matchedKeys };
    }
  }

  // 所有 sheet 都无有意义内容 → read-error（与历史「空文件 read-error」语义一致）
  if (!anySheetReadable) {
    return { tableKey: null, score: 0, status: 'read-error' };
  }

  // —— L2 模糊层（逐 sheet 取全局最佳）——
  let globalBest = { tableKey: null, score: 0, minScore: 1 };
  for (const rows of sheetRowsCache) {
    const best = runFuzzyLayer(rows, signatures);
    if (best.tableKey && best.score > globalBest.score) {
      globalBest = best;
    }
  }

  if (globalBest.tableKey && globalBest.score >= globalBest.minScore) {
    return {
      tableKey: globalBest.tableKey,
      score: globalBest.score,
      status: statusForMatchedKey(globalBest.tableKey)
    };
  }

  return { tableKey: null, score: globalBest.score, status: 'unrecognized' };
}

module.exports = {
  detectTableType,
  // 导出内部常量/工具，便于单测与排查
  L2_HEADER_SCAN_ROWS,
  SHORT_TABLE_COLUMN_THRESHOLD
};
