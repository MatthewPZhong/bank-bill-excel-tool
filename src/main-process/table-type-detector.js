// v2.1.16 阶段一 A2：按表头自动识别 Excel 表类型
//
// detectTableType(filePath, candidateSignatures) → { tableKey, score, status }
//   status: 'matched' | 'ambiguous' | 'unrecognized' | 'unsupported' | 'read-error'
//   v3.0.0 块 B / PR-2：matched / unsupported 返回额外带 streamingEligible（= 本文件是否物理单 sheet 的 .xlsx，
//     即 detector 头部识别走的流式判据）。供链接表导入 handler 据此决定落库走「流式整表覆盖」还是「数组整表覆盖」
//     （流式引擎硬编码只读 sheet1.xml，仅单 sheet .xlsx 安全；多 sheet/.xls/CSV 必须维持数组路径，否则读错 sheet）。
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
const { findHeaderMatchPosition } = readers;
const { ALL_TABLE_SIGNATURES } = require('../constants/table-signatures');
const path = require('node:path');

// L2 扫描的最大行数（表头通常在前几行；交割表标题+表头也在前 2 行内，N=20 足够冗余）
const L2_HEADER_SCAN_ROWS = 20;

// 「短表」阈值：expectedHeaders 列数 ≤ 此值的签名在 L1 启用列数精确守卫（防子集误判，针对 4 列回填模板等）
const SHORT_TABLE_COLUMN_THRESHOLD = 8;

// v3.0.0 块 B：detector 表头识别只需文件头部前若干行。对单 sheet 的 .xlsx 走流式头部读取
//   （readMeaningfulRowsHead），只读前 HEAD_STREAM_PHYSICAL_ROWS 个物理行即终止 → 65 万行大文件不再 OOM。
// 取值依据：表头最迟在第 2 行（交割表标题+表头）；L1 连续子序列全等只需表头行；L2 扫前 20 个有意义行；
//   列宽守卫取「最宽行」（表头/数据行全宽，前几行即出现）。200 物理行远超上述需求，且足以容忍少量前导空行，
//   流式读 200 行仍是毫秒级、内存恒定。读够 200 行即停（不影响识别正确性，仅截掉用不到的后续行）。
const HEAD_STREAM_PHYSICAL_ROWS = 200;

// 流式头部解析每行的列宽上界：须 ≥ 任何候选表头可能的列数（含测试构造的「拼接两表表头」ambiguous 场景，
//   银行 44 + 网关 31 = 75 列），避免宽表头被定宽截断而漏匹配。256 充裕。
const HEAD_STREAM_MAX_COL_COUNT = 256;

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
// meaningfulRows：该 sheet 已读到的有意义行（cell 二维数组，来自全量读或流式头部读取，二者同构）。
// 判定逻辑与 readers.readRowsWithMetadata 同源——共用 findHeaderMatchPosition 的「连续子序列全等」匹配，
//   故识别语义与历史完全一致；区别仅在数据来源不再对每签名重读文件（避免大文件 N 次重读 OOM）。
function runExactLayer(meaningfulRows, candidateSignatures, firstRowColumnCount) {
  const matchedKeys = [];

  for (const signature of candidateSignatures) {
    const anchor = getL1Anchor(signature);
    if (anchor.length === 0) {
      // 占位/空签名（如未实测的模板）跳过，不参与匹配
      continue;
    }

    // 短表列数守卫：expectedHeaders 很短的签名（如 4 列回填模板）要求文件列宽与之精确相等，
    // 否则跳过该签名的 L1，避免被长表碰巧命中（反向：长表用在短文件上读不出连续锚点本就失败）。
    const expectedLen = Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders.length : 0;
    if (
      expectedLen > 0 &&
      expectedLen <= SHORT_TABLE_COLUMN_THRESHOLD &&
      firstRowColumnCount >= 0 &&
      firstRowColumnCount !== expectedLen
    ) {
      continue;
    }

    // 锚点归一化（与 readRowsWithMetadata 内部一致：normalizeCell + 去空），再做连续子序列全等匹配。
    const normalizedAnchor = anchor.map((h) => normalizeCell(h)).filter((h) => h !== '');
    if (normalizedAnchor.length === 0) {
      continue;
    }
    const { matchedRowIndex } = findHeaderMatchPosition(meaningfulRows, normalizedAnchor);
    if (matchedRowIndex >= 0) {
      matchedKeys.push(signature.tableKey);
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

// 读取单个 sheet 的「有意义行」（用于短表列数守卫 + L1 + L2）；读不出（未匹配/空 sheet）返回 null。
//   useStreaming=true（单 sheet 的 .xlsx）：流式只读文件头部前若干行（readMeaningfulRowsHead），规避大文件 OOM。
//     流式引擎缺 sheet1.xml（极罕见的非 sheet1 物理名 / 真损坏）会 throw → 回退到 SheetJS 全量读，
//     避免因找不到 sheet1.xml 误报；回退失败再按「该 sheet 无内容」返回 null。
//   useStreaming=false（多 sheet / CSV / xls）：维持 readRowsWithMetadata([]) 全量读（行为不变）。
//   返回的 rows 两路径同构（trimTrailingEmptyCells + 过滤全空行），L1/L2/列宽守卫逻辑一致。
async function readSheetMeaningfulRows(filePath, sheetName, useStreaming) {
  if (useStreaming) {
    try {
      const result = await readers.readMeaningfulRowsHead(filePath, HEAD_STREAM_PHYSICAL_ROWS, {
        maxColCount: HEAD_STREAM_MAX_COL_COUNT
      });
      const rows = Array.isArray(result.rows) ? result.rows : [];
      return rows.length > 0 ? rows : null;
    } catch (streamError) {
      // 流式读失败（最常见：缺 sheet1.xml）→ 回退 SheetJS 全量读单 sheet（小/中文件可读；大文件理论上有
      //   sheet1.xml 不会走到这里）。回退仍读不出按「该 sheet 无内容」处理。
      try {
        const result = readers.readRowsWithMetadata(filePath, [], { sheetName });
        return Array.isArray(result.rows) && result.rows.length > 0 ? result.rows : null;
      } catch (fallbackError) {
        if (isHeaderNotMatchedError(fallbackError)) {
          return null;
        }
        return null;
      }
    }
  }

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
async function detectInSheet(filePath, signatures, sheetName, useStreaming) {
  const meaningfulRows = await readSheetMeaningfulRows(filePath, sheetName, useStreaming);
  if (meaningfulRows === null || meaningfulRows.length === 0) {
    return { matchedKeys: [], meaningfulRows: null };
  }
  const firstRowColumnCount = getFirstRowColumnCount(meaningfulRows);
  const matchedKeys = runExactLayer(meaningfulRows, signatures, firstRowColumnCount);
  return { matchedKeys, meaningfulRows };
}

// 主入口：识别单个文件的表类型（v2.1.16 F4：扫所有 sheet，任一命中即返回，短路余下 sheet）。
// candidateSignatures 缺省 = ALL_TABLE_SIGNATURES。
// v3.0.0 块 B：async 化——单 sheet 的 .xlsx 走流式头部读取（不再全量读，65 万行大文件不再 OOM）；
//   多 sheet / CSV / xls 维持 SheetJS 全量读（行为不变）。识别判定逻辑（L1/L2/列宽守卫/ambiguous/短路）完全不变。
async function detectTableType(filePath, candidateSignatures = ALL_TABLE_SIGNATURES) {
  const signatures = Array.isArray(candidateSignatures) ? candidateSignatures : [];

  // 文件级可读性探测 + 取 sheet 列表（CSV → [null]）+ 决定是否走流式头部读取。失败 → read-error。
  //   O-6：read-error 带回细分 reason（'unreadable'：文件不存在/类型错误/损坏/无法解析）+ 原始 message，供 handler 给精准文案。
  //
  // 是否走流式头部读取：仅当「物理单 sheet」且「.xlsx」（流式引擎读 zip 内 sheet1.xml）。
  //   - 单 sheet：SheetNames[0] 必然对应唯一物理工作表，不存在 SheetNames 索引 ↔ sheetN.xml 物理名错配歧义；
  //     这也正是大文件链接表的形态（spec O-5：真实样本 deep scan 确认单 sheet）。
  //   - 多 sheet：维持全量逐 sheet 读，不退化 F4 多 sheet 扫描语义（流式引擎硬编码只读 sheet1.xml，无法覆盖多 sheet）。
  //   - CSV（sheetNames=[null]）：纯文本不撞 OOM，流式引擎不支持，维持全量。
  //   - .xls（OLE2 二进制）：流式引擎只认 zip(xlsx)，维持全量。
  //
  // ⚠️ 关键：取 sheet 列表本身也不能 OOM。SheetJS listSheetNames(bookSheets:true) 对 65 万行大 xlsx 仍会
  //   全量解压（实测撞 ~4GB RSS）。故 .xlsx 优先用 readXlsxSheetMetaLite（JSZip 只读 workbook.xml 小 entry，
  //   峰值 ~200MB）判单/多 sheet；仅多 sheet / lite 解析失败时才回退 SheetJS listSheetNames（多 sheet 文件
  //   通常是小文件，不 OOM；lite 失败说明非常规 xlsx，回退原链路兜底）。.xls/.csv 一律走 SheetJS（不 OOM）。
  const ext = path.extname(filePath).toLowerCase();
  let sheetNames = null;
  let useStreaming = false;

  if (ext === '.xlsx') {
    try {
      const meta = await readers.readXlsxSheetMetaLite(filePath);
      const physicalSingleSheet = meta.worksheetEntryCount === 1 && meta.sheetNames.length === 1;
      if (physicalSingleSheet) {
        // 物理单 sheet → 流式头部识别（大文件核心路径）；sheetNames 取 lite 解析出的唯一名字。
        sheetNames = [meta.sheetNames[0]];
        useStreaming = true;
      } else {
        // 多 sheet（或 lite 名字解析异常）→ 走 SheetJS 全量逐 sheet（保持 F4 行为不变）。
        sheetNames = readers.listSheetNames(filePath);
        useStreaming = false;
      }
    } catch (liteError) {
      // lite 解析失败（非 zip / 缺 workbook.xml / 损坏）→ 回退 SheetJS listSheetNames（原链路兜底）。
      try {
        sheetNames = readers.listSheetNames(filePath);
        useStreaming = false;
      } catch (error) {
        return {
          tableKey: null,
          score: 0,
          status: 'read-error',
          reason: 'unreadable',
          message: error && error.message ? error.message : String(error)
        };
      }
    }
  } else {
    // .xls（OLE2）/ .csv（纯文本）：SheetJS listSheetNames 不 OOM，维持原行为。
    try {
      sheetNames = readers.listSheetNames(filePath);
      useStreaming = false;
    } catch (error) {
      return {
        tableKey: null,
        score: 0,
        status: 'read-error',
        reason: 'unreadable',
        message: error && error.message ? error.message : String(error)
      };
    }
  }

  // —— L1 精确层（逐 sheet，短路）——
  // 收集每个 sheet 的 meaningfulRows 供 L1 全落空后的 L2 复用（避免二次读盘）。
  const sheetRowsCache = [];
  let anySheetReadable = false;
  for (const sheetName of sheetNames) {
    let perSheet;
    try {
      perSheet = await detectInSheet(filePath, signatures, sheetName, useStreaming);
    } catch (error) {
      // L1 内部抛出的「真·读错」（非未匹配）→ 整个文件判 read-error。
      //   O-6：reason='read-failed'（读取阶段异常，非空文件），带回原始 message 供 handler 提示。
      return {
        tableKey: null,
        score: 0,
        status: 'read-error',
        reason: 'read-failed',
        message: error && error.message ? error.message : String(error)
      };
    }

    if (perSheet.meaningfulRows !== null) {
      anySheetReadable = true;
      // 缓存时保留 sheetName 关联，供 L2 命中后带回（CSV 时 sheetName=null，透传）。
      sheetRowsCache.push({ sheetName, rows: perSheet.meaningfulRows });
    }

    if (perSheet.matchedKeys.length === 1) {
      // 任一 sheet 单命中 → 立即返回（短路，不再扫后续 sheet）
      // 带回命中的 sheetName（CSV 时为 null，透传），供链接表导入据此从正确 sheet 读表头落库。
      // v3.0.0 块 B / PR-2：带回 streamingEligible（落库是否可走流式整表覆盖；见顶部签名注释）。
      const tableKey = perSheet.matchedKeys[0];
      return { tableKey, score: 1, status: statusForMatchedKey(tableKey), sheetName, streamingEligible: useStreaming };
    }
    if (perSheet.matchedKeys.length > 1) {
      // 同一 sheet 多签名精确命中，无法唯一判定
      return { tableKey: null, score: 1, status: 'ambiguous', matchedKeys: perSheet.matchedKeys };
    }
  }

  // 所有 sheet 都无有意义内容 → read-error（与历史「空文件 read-error」语义一致）
  //   O-6：reason='empty'（文件可读但无任何有意义行 = 真·空表/无数据），供 handler 区别于「不可读」。
  if (!anySheetReadable) {
    return { tableKey: null, score: 0, status: 'read-error', reason: 'empty' };
  }

  // —— L2 模糊层（逐 sheet 取全局最佳）——
  let globalBest = { tableKey: null, score: 0, minScore: 1, sheetName: null };
  for (const { sheetName, rows } of sheetRowsCache) {
    const best = runFuzzyLayer(rows, signatures);
    if (best.tableKey && best.score > globalBest.score) {
      globalBest = { ...best, sheetName };
    }
  }

  if (globalBest.tableKey && globalBest.score >= globalBest.minScore) {
    return {
      tableKey: globalBest.tableKey,
      score: globalBest.score,
      status: statusForMatchedKey(globalBest.tableKey),
      sheetName: globalBest.sheetName,
      // v3.0.0 块 B / PR-2：带回 streamingEligible（落库是否可走流式整表覆盖；见顶部签名注释）。
      streamingEligible: useStreaming
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
