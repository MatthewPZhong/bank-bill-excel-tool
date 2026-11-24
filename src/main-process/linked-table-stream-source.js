// v3.0.0 块 B / PR-2：把单个 linked .xlsx 文件「流式」读成行对象逐行喂给仓储事务
//   （replaceLinkedTableStreaming 的 feedRows 实现体）。从 main.js 闭包抽出为独立模块，
//   便于集成测试直接调用真实实现（不再手抄镜像，防测试副本与生产代码漂移）。
//   仅用于 streaming-eligible（物理单 sheet 的 .xlsx）：流式引擎硬编码只读 xl/worksheets/sheet1.xml。
//   与 readLinkedRowsAsObjects 完全同口径（防大文件流式落库口径漂移 = 静默资金/数据事故）：
//     1) 值口径：每格过 normalizeCell（= file-service/common.normalizeCell = String(v).trim()）；
//     2) 表头定位语义：逐行「连续位置全等 expectedHeaders」找表头行 + 起始列偏移 colOffset，跳过空表头名占位；
//     3) 🔴 全空行过滤：表头后的全空行用 isRowMeaningful 跳过——与数组路径 readRowsWithMetadata 的
//        `.filter(isRowMeaningful)`（readers.js）对齐。否则流式会把空 <row> 落成「空 key 垃圾行」+ row_count
//        虚高 = 与数组路径口径分叉（同一数据走流式 vs 数组落库结果不同）；
//     4) bank-deposit 裁列：transform = pickBankDepositFields（与数组路径一致，由 caller 传入）。
//   ⚠️ colCount 取 expectedHeaders.length（bank-deposit=44，A1 锚定）。readXlsxStreamed 每行返回**定长
//     colCount** 数组（cells.length === expected.length），故 colOffset 实际只能命中 0（表头在 A 列）——
//     这正是真实大文件 bank-deposit 的形态。若 streaming-eligible 文件表头不在 A 列（colOffset>0），前
//     expected.length 列被截断 → 流内定位不到表头 → 返回 matched:false，caller 抛「未匹配表头」错
//     （安全失败，绝不静默错位落库；该边界为 PR-2 已知限制）。
//   返回 { matched }：matched=false = 整条流读完未定位到表头行（由 caller 记 write-error）。
const { readXlsxStreamed } = require('../backend/xlsx/legacy/streaming-xlsx-reader');
const { normalizeCell, isRowMeaningful, FileValidationError } = require('../backend/file-service/common');

// v3.2.22 B113（Codex 第十一轮）：含空字符（U+0000）的值拒绝入库：SQLite 读回 TEXT 时在空字符处截断，不同的 BizId 会读成同一个键。
//   本应用写出的明细把空字符写成 _x0000_，两条读取路径都会还原出来；流式与非流式导入共用。只给行号与列名，不带值
function assertLinkedCellStorable(value, rowNumber, headerName) {
  if (typeof value === 'string' && value.includes('\u0000')) {
    throw new FileValidationError('FILE_READ',
      `源文件第 ${rowNumber} 行「${headerName}」列的文本含空字符（U+0000），数据库读回时会在该处截断；请删除该字符后重新导入`);
  }
}

// v3.2.22 B113（Codex 第十三轮）：只核对实际落库的列——入金表按白名单裁列，用户版本的模板按内置列改名，不落库的列含空字符
//   不影响入库。用逐列不同的探针值走一遍落库投影，求出落库的值取自哪些源列（投影只取列、改名，不改值），之后每行只核对这些
//   源列，报源行号与源列名
const STORED_COLUMN_PROBE = '\u0000linked-stored-column:';
function createStoredCellAssert(expectedHeaders, projection) {
  const headerNames = (Array.isArray(expectedHeaders) ? expectedHeaders : [])
    .map((header) => normalizeCell(header)).filter((name) => name !== '');
  const probe = {};
  headerNames.forEach((name, index) => { probe[name] = `${STORED_COLUMN_PROBE}${index}`; });
  const projected = (typeof projection === 'function' ? projection(probe) : probe) || {};
  const storedSources = [];
  for (const value of Object.values(projected)) {
    if (typeof value !== 'string' || !value.startsWith(STORED_COLUMN_PROBE)) continue;
    const name = headerNames[Number(value.slice(STORED_COLUMN_PROBE.length))];
    if (name !== undefined && !storedSources.includes(name)) storedSources.push(name);
  }
  return (row, rowNumber) => {
    for (const name of storedSources) assertLinkedCellStorable(row[name], rowNumber, name);
  };
}

async function streamLinkedRowsToInsert(filePath, signature, insertOne, transform) {
  const expected = Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders : [];
  if (expected.length === 0) {
    return { matched: false };
  }
  const xform = typeof transform === 'function' ? transform : (x) => x;
  const assertStoredCells = createStoredCellAssert(expected, xform);
  let colOffset = -1;

  await readXlsxStreamed(filePath, (cells, _rowIdx, textInfo) => {
    const row = Array.isArray(cells) ? cells : [];
    const unverifiable = textInfo && textInfo.unverifiableColumns.length ? new Set(textInfo.unverifiableColumns) : null;
    if (colOffset < 0) {
      // 流内定位表头行 + 起始列偏移（镜像 readLinkedRowsAsObjects：首个「连续位置全等」起点）。
      //   无法确认原值的格不与任何表头相等（与表头识别、模板预检同口径，Codex 第八轮 P1）
      const maxStart = row.length - expected.length;
      for (let cs = 0; cs <= maxStart; cs += 1) {
        let matched = true;
        for (let i = 0; i < expected.length; i += 1) {
          if ((unverifiable && unverifiable.has(cs + i)) || normalizeCell(expected[i]) !== normalizeCell(row[cs + i])) {
            matched = false;
            break;
          }
        }
        if (matched) { colOffset = cs; break; }
      }
      return; // 表头行（及其之前的行）不入库
    }
    // v3.2.22 B113：还原 OOXML 文本转义后无法确认原值的格（转义跨格式片段拼成、表示非 ASCII 或不完整的 Unicode 字符，
    //   或文本结构不是 Excel 写出的规范形式）拒绝导入：不同的原值可能落成同一个键，也可能与非流式读取得到不同的键
    //   （Codex 第七、八轮）。先于全空行判断：还原结果为空的格按段读取并不为空（第八轮 P2）。只给行号与列名，不带值
    if (unverifiable) {
      for (let i = 0; i < expected.length; i += 1) {
        const headerName = normalizeCell(expected[i]);
        if (headerName !== '' && unverifiable.has(colOffset + i)) {
          throw new FileValidationError('FILE_READ',
            `源文件第 ${textInfo.rowNumber} 行「${headerName}」列的文本含无法确认原值的 Excel 文本转义（_xHHHH_）、`
              + '不完整的 Unicode 字符或非常规的文本结构，不同读取方式会得到不同的值；请用 Excel 打开该文件另存后重新导入');
        }
      }
    }
    // 🔴 全空行跳过：与数组路径 readRowsWithMetadata `.filter(isRowMeaningful)` 对齐（防空 key 垃圾行 + row_count 虚高）。
    if (!isRowMeaningful(row)) return;
    // 表头行之后逐行 zip：obj[expectedHeaders[i]] = normalizeCell(cells[colOffset+i])；跳过空表头名占位。
    const obj = {};
    for (let i = 0; i < expected.length; i += 1) {
      const headerName = normalizeCell(expected[i]);
      if (headerName === '') continue; // 跳过中间空列占位（不入对象，与数组路径一致）
      const cell = row[colOffset + i];
      obj[headerName] = normalizeCell(cell === undefined ? '' : cell);
    }
    assertStoredCells(obj, textInfo.rowNumber);
    insertOne(xform(obj));
    // v3.2.22 B113：与非流式读取（SheetJS）同样还原 OOXML 文本转义，同一笔交易两条路径导入得到同一个 BizId；
    //   表头识别（table-type-detector）与模板文件预检（input-structures）用同一选项
  }, { colCount: expected.length, decodeTextEscapes: true });

  return { matched: colOffset >= 0 };
}

module.exports = { assertLinkedCellStorable, createStoredCellAssert, streamLinkedRowsToInsert };
