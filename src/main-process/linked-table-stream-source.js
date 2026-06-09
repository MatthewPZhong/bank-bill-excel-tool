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
const { readXlsxStreamed } = require('../backend/pending-import/streaming-xlsx-reader');
const { normalizeCell, isRowMeaningful } = require('../backend/file-service/common');

async function streamLinkedRowsToInsert(filePath, signature, insertOne, transform) {
  const expected = Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders : [];
  if (expected.length === 0) {
    return { matched: false };
  }
  const xform = typeof transform === 'function' ? transform : (x) => x;
  let colOffset = -1;

  await readXlsxStreamed(filePath, (cells) => {
    const row = Array.isArray(cells) ? cells : [];
    if (colOffset < 0) {
      // 流内定位表头行 + 起始列偏移（镜像 readLinkedRowsAsObjects：首个「连续位置全等」起点）。
      const maxStart = row.length - expected.length;
      for (let cs = 0; cs <= maxStart; cs += 1) {
        let matched = true;
        for (let i = 0; i < expected.length; i += 1) {
          if (normalizeCell(expected[i]) !== normalizeCell(row[cs + i])) { matched = false; break; }
        }
        if (matched) { colOffset = cs; break; }
      }
      return; // 表头行（及其之前的行）不入库
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
    insertOne(xform(obj));
  }, { colCount: expected.length });

  return { matched: colOffset >= 0 };
}

module.exports = { streamLinkedRowsToInsert };
