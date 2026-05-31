// v2.1.12-beta β.2-T1 — 业务OP数据核对：流式 reader（JSZip + SAX）
//
// 背景：原 reader.js 用 SheetJS XLSX.readFile 全量进内存（sheet_to_json header:1），
// 用户实际导入百万行 xlsx 会撞 SheetJS V8 512MB 字符串上限（静默返回空 / 卡）。
// 本文件提供等价的流式 reader（仿已验证范式 pending-import/streaming-xlsx-reader +
// vcc-op-calc-import/reader），内存常数（边解压 zip entry 边扫 <row>），不全量载入。
//
// 🔴 数据完整性红线：本 reader 必须与 reader.js（SheetJS 版）byte-level 同输出
//   （同 fixture 上 rows 数组逐行逐列值 + _rowIndex + totalRows + sourceSheetName 全等）。
//   contract test：tests/unit/backend/biz-op-recon-import/reader-streamed-contract.test.js。
//   reader.js 保留作 contract 基线 + 过渡回退；本文件不改 reader.js / 不改 streaming-xlsx-reader。
//
// 与 reader.js（SheetJS）逐项对齐的语义：
//   ① 只读「第一个 sheet」（不按名）—— 由 workbook.xml 第一个 <sheet> 的 r:id 经 rels 定位 worksheet，
//      sourceSheetName = 该 <sheet> 的 name（与 SheetJS workbook.SheetNames[0] 一致）。
//   ② 行 1 表头 → validateHeaders；不过 → 抛同 errorCode 的 FileValidationError（同 detailLines/context 结构）。
//   ③ 数据行从行 2 起，isRowMeaningful 跳过空行。
//   ④ _rowIndex = Excel 真实行号：用 <row r="N"> 属性优先（缺 r 回退「第 N 个 <row>」计数）。
//      —— SheetJS sheet_to_json(blankrows:true) 按 <row r> 还原真实行号（空行/稀疏行保号），
//         readXlsxStreamed 的 rowIdx 是「<row> 出现计数」忽略 r 属性，二者在稀疏/跳号 xlsx 上会发散。
//         本 reader 取 <row r> 真实行号对齐 SheetJS（同 vcc-op-calc-import/reader 的 excelRow 范式）。
//   ⑤ normalizeCell 逐格映射到 DB 列名。
//   ⑥ 返回 { rows, headerRow: expectedHeaders.slice(), sourceSheetName, totalRows, fileName, filePath } 同形。
//
// ⚠️ 已知 byte-level 差异（仅 number 类型 cell 且数值很大时）：
//   SheetJS sheet_to_json(raw:false) 对 number cell 套 Excel General 格式 → 大数走科学计数法
//   （如 number 1.4e18 → "1.398E+18"，且 JS number 精度丢失）；本流式 reader 走 parseRowXml 的
//   String(parseFloat) → 取原值字符串。二者仅在 number cell 大数时不同。
//   bizOp / flow 真实数据（含 ID / 金额）以文本（t="s"/inlineStr/str）存储 → 取原文，两者一致；
//   contract test 显式覆盖并文档化此差异（reader-streamed-contract.test.js 的「已知差异」用例）。

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const JSZip = require('jszip');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');
const {
  BIZ_OP_HEADERS,
  BIZ_OP_DB_COLUMNS,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS
} = require('../biz-op-recon-db/columns');
const {
  validateBizOpHeaders,
  validateFlowHeaders
} = require('./validator');
const {
  parseRowXml,
  readSharedStrings,
  lettersToIndex
} = require('../pending-import/streaming-xlsx-reader');

function xmlAttrUnescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Target 可能是 "worksheets/sheet1.xml"（相对 xl/）或 "/xl/worksheets/sheet1.xml"（绝对）
function normalizeWorksheetTarget(target) {
  const t = String(target || '').trim();
  if (t.startsWith('/')) return t.replace(/^\//, '');       // 绝对路径：去前导 /
  if (t.startsWith('xl/')) return t;
  return 'xl/' + t;                                          // 相对 xl/
}

// 定位「第一个 sheet」：解析 xl/workbook.xml 第一个 <sheet name r:id>，经 xl/_rels/workbook.xml.rels
// 把 r:id 映射到 worksheet 文件路径（与 SheetJS workbook.SheetNames[0] / Sheets[name] 一致）。
// 不简单假设 sheet1.xml —— workbook 顺序与 sheetN 编号不保证一致（虽多数情况 rId1→sheet1.xml）。
// 返回 { sheetName, entryPath }；缺 workbook.xml/无 <sheet>/找不到 worksheet → entryPath 可能为 null。
async function locateFirstSheet(zip) {
  const wbEntry = zip.file('xl/workbook.xml');
  if (!wbEntry) return { sheetName: '', entryPath: null };
  const wbXml = await wbEntry.async('string');
  const firstSheet = wbXml.match(/<sheet\b[^>]*>/);
  if (!firstSheet) return { sheetName: '', entryPath: null };
  const nameMatch = firstSheet[0].match(/\bname="([^"]*)"/);
  const ridMatch = firstSheet[0].match(/\br:id="([^"]*)"/);
  const sheetName = nameMatch ? xmlAttrUnescape(nameMatch[1]) : '';

  let entryPath = null;
  if (ridMatch) {
    const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
    if (relsEntry) {
      const relsXml = await relsEntry.async('string');
      // 属性顺序不定：逐个 <Relationship> 标签匹配 Id，再取 Target
      const relRe = /<Relationship\b[^>]*>/g;
      let rm;
      while ((rm = relRe.exec(relsXml))) {
        const tag = rm[0];
        const idM = tag.match(/\bId="([^"]*)"/);
        if (idM && idM[1] === ridMatch[1]) {
          const tgtM = tag.match(/\bTarget="([^"]*)"/);
          if (tgtM) entryPath = normalizeWorksheetTarget(tgtM[1]);
          break;
        }
      }
    }
  }

  // 兜底：rels 解析失败/目标不存在 → 退回 sheet1.xml（与历史样本一致，仍走「第一个」语义近似）
  if (!entryPath || !zip.file(entryPath)) {
    entryPath = zip.file('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
  }
  return { sheetName, entryPath };
}

// 流式扫单个 worksheet entry：
//   首行（第一个 <row>）= 表头 → validateHeaders；不过 → onHeaderFail(validation, headerCells) 并结束。
//   后续数据行经 isRowMeaningful 过滤，逐格 normalizeCell + _rowIndex（真实 Excel 行号）→ onDataRow(obj)。
//   返回 { sawAnyRow, headerFailed }（sawAnyRow=是否扫到过任何 <row> 含表头，用于「空 sheet（无表头）」判定）。
function scanWorksheet(sheetEntry, sharedStrings, {
  dbColumns,
  validateHeaders,
  onHeaderFail,
  onDataRow
}) {
  const colCount = dbColumns.length;
  return new Promise((resolve, reject) => {
    const stream = sheetEntry.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let inSheetData = false;
    let headerChecked = false;
    let headerFailed = false;
    let rowSeq = 0;          // 第 N 个 <row>（缺 r 属性时回退作行号）
    let sawAnyRow = false;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      resolve({ sawAnyRow, headerFailed });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      reject(err);
    };

    // 扫 pending 里完整 <row>...</row> 块；endFlush=true 表示流已结束（不再缓冲半行）。
    // 返回 false 表示已 settle（表头失败提前结束），调用方应停止。
    const drainRows = (endFlush) => {
      while (true) {
        // 精确前缀（<row 后跟空白或 >），避免误匹配 <rowBreaks> 等同前缀元素（对齐 streaming-xlsx-reader）
        const ra = pending.indexOf('<row ');
        const rb = pending.indexOf('<row>');
        const rowStart = ra < 0 ? rb : (rb < 0 ? ra : Math.min(ra, rb));
        if (rowStart < 0) { if (!endFlush && pending.length > 16) pending = pending.slice(-16); break; }

        const tagEnd = pending.indexOf('>', rowStart);
        if (tagEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }   // 起始标签跨 chunk
        const rowTag = pending.slice(rowStart, tagEnd + 1);
        const rrm = rowTag.match(/\br="(\d+)"/);
        const excelRow = rrm ? parseInt(rrm[1], 10) : null;     // 真实 Excel 行号（不依赖计数）

        // 自闭合 <row .../> 空行：保号计数但不产数据行（内容全空，isRowMeaningful 必为 false）。
        if (rowTag.charAt(rowTag.length - 2) === '/') {
          pending = pending.slice(tagEnd + 1);
          rowSeq += 1;
          sawAnyRow = true;
          // 自闭合空行作表头行时，validateHeaders([])（空 cells）必失败，与 SheetJS 一致。
          if (!headerChecked) {
            headerChecked = true;
            const v = validateHeaders([]);
            if (!v.ok) { headerFailed = true; onHeaderFail(v, []); done(); return false; }
          }
          continue;
        }

        const rowEnd = pending.indexOf('</row>', rowStart);
        if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }
        const rowXml = pending.slice(rowStart, rowEnd + 6);
        pending = pending.slice(rowEnd + 6);
        rowSeq += 1;
        sawAnyRow = true;
        const cells = parseRowXml(rowXml, colCount, sharedStrings);

        if (!headerChecked) {
          headerChecked = true;
          const v = validateHeaders(cells);
          if (!v.ok) { headerFailed = true; onHeaderFail(v, cells); done(); return false; }
          // 表头匹配前 colCount 列后，检测是否有超出 colCount 列的尾部 cell（对齐 SheetJS「列数不匹配」严格性）。
          //   流式固定 colCount，否则尾部多列被静默忽略；SheetJS sheet_to_json 按实际列数比对 → 列数不匹配拒绝。
          let maxColIdx = -1;
          let hm;
          const headerColRe = /\br="([A-Z]+)\d+"/g;
          while ((hm = headerColRe.exec(rowXml))) {
            const ci = lettersToIndex(hm[1]);
            if (ci > maxColIdx) maxColIdx = ci;
          }
          if (maxColIdx >= colCount) {
            headerFailed = true;
            onHeaderFail({
              ok: false,
              error: `表头列数超出模板 ${colCount} 列（前 ${colCount} 列匹配，但检测到第 ${maxColIdx + 1} 列）`,
              detailLines: [`模板固定 ${colCount} 列；尾部多余列可能导致列错位，请核对是否选错文件`],
              actualColumnCount: maxColIdx + 1
            }, cells);
            done();
            return false;
          }
          continue;
        }

        if (!isRowMeaningful(cells)) continue;
        const obj = {};
        for (let i = 0; i < colCount; i++) obj[dbColumns[i]] = normalizeCell(cells[i]);
        obj._rowIndex = excelRow != null ? excelRow : rowSeq;
        onDataRow(obj);
      }
      return true;
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      try {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!inSheetData) {
          const sd = pending.indexOf('<sheetData>');
          if (sd >= 0) { inSheetData = true; pending = pending.slice(sd + 11); }
          else {
            const sc = pending.indexOf('<sheetData/>');
            if (sc >= 0) { inSheetData = true; pending = pending.slice(sc + 12); done(); return; }   // 空 sheet（自闭合 sheetData）
            if (pending.length > 16) pending = pending.slice(-16);
            return;
          }
        }
        if (drainRows(false) === false) return;
      } catch (err) {
        fail(err);
      }
    });

    stream.on('end', () => {
      if (settled) return;
      try {
        pending += decoder.end();
        if (drainRows(true) === false) return;
        done();
      } catch (err) {
        fail(err);
      }
    });

    stream.on('error', fail);
  });
}

// 把底层读取错误（JSZip "Can't find end of central directory" / "invalid signature" 等）
// 包成与 SheetJS reader 同 errorCode 的 FileValidationError（contract test 只断言 errorCode 一致）。
function wrapReadError(err, { errorCode, templateLabel, fileName, filePath }) {
  if (err && err.name === 'FileValidationError') return err;
  const raw = err && err.message ? String(err.message) : String(err);
  return new FileValidationError(
    errorCode,
    `${templateLabel} 文件读取失败：${raw}`,
    {
      detailLines: [`文件：${fileName}`, `路径：${filePath}`],
      context: { filePath, fileName, templateLabel }
    }
  );
}

// 通用流式读取入口：定位第一个 sheet → 读 sharedStrings → scanWorksheet 逐行回调。
//   onDataRow(obj)：每条数据行（已过 isRowMeaningful + normalizeCell + _rowIndex）。
//   onProgress(dataRowsSoFar)：可选，每 progressInterval 行 + 收尾各回调一次。
//   返回 { fileName, filePath, sourceSheetName, dataRows }。
// 失败抛与 SheetJS reader 同 errorCode 的 FileValidationError（读取失败 / 无 sheet / 空 sheet / 表头不匹配）。
function buildStreamReader({
  templateLabel,
  expectedHeaders,
  dbColumns,
  validateHeaders,
  errorCode,
  progressInterval = 50000
}) {
  return async function streamFile(filePath, { onDataRow, onProgress } = {}) {
    const fileName = path.basename(filePath);

    let zip;
    try {
      const buffer = await fs.promises.readFile(filePath);
      zip = await JSZip.loadAsync(buffer);
    } catch (err) {
      throw wrapReadError(err, { errorCode, templateLabel, fileName, filePath });
    }

    let sharedStrings;
    try {
      sharedStrings = await readSharedStrings(zip);
    } catch (err) {
      throw wrapReadError(err, { errorCode, templateLabel, fileName, filePath });
    }

    const { sheetName, entryPath } = await locateFirstSheet(zip);
    if (!entryPath) {
      // 对齐 SheetJS reader「文件没有 sheet」分支
      throw new FileValidationError(
        errorCode,
        `${templateLabel} 文件没有 sheet`,
        {
          detailLines: [`文件：${fileName}`],
          context: { filePath, fileName, templateLabel }
        }
      );
    }

    let dataRows = 0;
    const tick = () => {
      dataRows += 1;
      if (dataRows % progressInterval === 0 && typeof onProgress === 'function') onProgress(dataRows);
    };

    let headerFailure = null;     // { validation, headerCells }
    let scanResult;
    try {
      scanResult = await scanWorksheet(zip.file(entryPath), sharedStrings, {
        dbColumns,
        validateHeaders,
        onHeaderFail: (validation, headerCells) => { headerFailure = { validation, headerCells }; },
        onDataRow: (obj) => {
          if (typeof onDataRow === 'function') onDataRow(obj);
          tick();
        }
      });
    } catch (err) {
      throw wrapReadError(err, { errorCode, templateLabel, fileName, filePath });
    }

    // 空 sheet（无任何 <row>，含表头）→ 对齐 SheetJS reader「sheet 内容为空（无表头）」分支
    if (!scanResult.sawAnyRow) {
      throw new FileValidationError(
        errorCode,
        `${templateLabel} sheet 内容为空（无表头）`,
        {
          detailLines: [`文件：${fileName}`, `Sheet：${sheetName}`],
          context: { filePath, fileName, sourceSheetName: sheetName, templateLabel }
        }
      );
    }

    // 表头不匹配 → 对齐 SheetJS reader 的表头校验失败分支（同 errorCode + detailLines + context 结构）
    if (headerFailure) {
      const { validation, headerCells } = headerFailure;
      throw new FileValidationError(
        errorCode,
        validation.error,
        {
          detailLines: [
            `文件：${fileName}`,
            `Sheet：${sheetName}`,
            ...(validation.detailLines || [])
          ],
          context: {
            filePath,
            fileName,
            sourceSheetName: sheetName,
            templateLabel,
            expectedColumnCount: expectedHeaders.length,
            actualColumnCount: typeof validation.actualColumnCount === 'number'
              ? validation.actualColumnCount
              : (Array.isArray(headerCells) ? headerCells.length : 0)
          }
        }
      );
    }

    if (typeof onProgress === 'function') onProgress(dataRows);    // 收尾进度
    return { fileName, filePath, sourceSheetName: sheetName, dataRows };
  };
}

// 逐行回调版（给 T-b2-2 边读边分批 INSERT 用，不堆数组）
const streamBizOpFile = buildStreamReader({
  templateLabel: '业务OP账单',
  expectedHeaders: BIZ_OP_HEADERS,
  dbColumns: BIZ_OP_DB_COLUMNS,
  validateHeaders: validateBizOpHeaders,
  errorCode: 'BIZ_OP_RECON_BIZ_OP_HEADER_MISMATCH'
});

const streamFlowFile = buildStreamReader({
  templateLabel: '流水对账单',
  expectedHeaders: FLOW_HEADERS,
  dbColumns: FLOW_DB_COLUMNS,
  validateHeaders: validateFlowHeaders,
  errorCode: 'BIZ_OP_RECON_FLOW_HEADER_MISMATCH'
});

// 便捷「收集成 rows 数组」版（给 contract test + 过渡用，签名与 SheetJS reader 同形）。
// 返回 { rows, headerRow, sourceSheetName, totalRows, fileName, filePath }。
function buildCollectReader(streamFile, expectedHeaders) {
  return async function readFileCollected(filePath) {
    const rows = [];
    const meta = await streamFile(filePath, { onDataRow: (obj) => rows.push(obj) });
    return {
      rows,
      headerRow: expectedHeaders.slice(),
      sourceSheetName: meta.sourceSheetName,
      totalRows: rows.length,
      fileName: meta.fileName,
      filePath: meta.filePath
    };
  };
}

const readBizOpFileStreamed = buildCollectReader(streamBizOpFile, BIZ_OP_HEADERS);
const readFlowFileStreamed = buildCollectReader(streamFlowFile, FLOW_HEADERS);

module.exports = {
  // 逐行回调版（T-b2-2 用）
  streamBizOpFile,
  streamFlowFile,
  // 收集成数组版（contract test + 过渡用，与 SheetJS reader 同形）
  readBizOpFileStreamed,
  readFlowFileStreamed,
  // 内部 helper（便于单测）
  locateFirstSheet,
  normalizeWorksheetTarget
};
