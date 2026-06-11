// v2.1.12 需求1 / JSZip 流式改造（spec §9）— VCC业务OP计算：流水文件流式读取
//
// 🔴 改造背景（2026-05-31 实测）：
//   1. 真实流水 78.7 万行 / worksheet XML 811MB → SheetJS 全量加载超 V8 字符串上限(512MB)，读不出。
//   2. 改用 exceljs streaming 后发现：用户文件部分用 zip "data descriptor"（流式导出，general purpose
//      bit3 set，local header size/CRC=0），exceljs 的 unzipper 按 local header 流式读 → 错位 →
//      "invalid signature: 0x41d"。
//   → 最终改用 JSZip（走 central directory，支持 data descriptor）+ SAX 流式扫 <row>。
//     实测读 811MB worksheet：7.8s / RSS 778MB（exceljs 16.9s / 2GB），全面更优。
//
// 复用自研 streaming-xlsx-reader 的 parseRowXml / readSharedStrings（同一套 JSZip + SAX 解析）。
// 多 sheet 定位（spec §9）：遍历所有 sheetN.xml，找首行表头匹配 FLOW_HEADERS 的数据表（跳过透视/汇总 sheet）。
// 输入 = 流水对账单（28 列，与第 5 模块 FLOW 相同），复用 vcc-op-calc-db/columns.js 的列定义。

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const JSZip = require('jszip');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');
const { FLOW_HEADERS, FLOW_DB_COLUMNS } = require('../vcc-op-calc-db/columns');
const { validateFlowHeaders } = require('./validator');
const { parseRowXml, readSharedStrings, lettersToIndex } = require('../pending-import/streaming-xlsx-reader');
// v3.0.4 块 A · A1：JSZip loadAsync 前的入口尺寸预检（≥2^31 抛明确中文错误，预检自身失败 fail-open）。
const { assertXlsxEntriesUnderLimit } = require('../pending-import/xlsx-size-preflight');

const ERROR_CODE = 'VCC_OP_CALC_FLOW_HEADER_MISMATCH';
const TEMPLATE_LABEL = '流水对账单';
const COL_COUNT = FLOW_DB_COLUMNS.length;   // 28
const PROGRESS_INTERVAL = 50000;            // 每 5 万数据行回调一次进度

// 把底层读取错误（JSZip 的 "Can't find end of central directory" 等）包装成友好 FileValidationError。
// 这类错误通常是文件损坏/不完整（导出或下载未完成 → zip 截断），晦涩的原始错误对用户无意义。
function wrapReadError(err, fileName, filePath) {
  if (err && err.name === 'FileValidationError') return err;
  const raw = err && err.message ? String(err.message) : String(err);
  const isCorrupt = /invalid signature|central directory|not a zip|truncat|end of central|corrupt/i.test(raw);
  const msg = isCorrupt
    ? `${TEMPLATE_LABEL}文件损坏或不完整（非有效 xlsx，可能导出/下载未完成）`
    : `${TEMPLATE_LABEL}文件读取失败`;
  return new FileValidationError(ERROR_CODE, msg, {
    detailLines: [
      `文件：${fileName}`,
      `原因：${raw}`,
      isCorrupt ? '建议：请重新导出或下载该文件后再导入' : ''
    ].filter(Boolean),
    context: { filePath, fileName, templateLabel: TEMPLATE_LABEL, rawError: raw }
  });
}

// 流式扫单个 worksheet（JSZip nodeStream + SAX 扫 <row>）：
//   首行作表头校验（validateFlowHeaders）：不匹配 → 立即停止（destroy stream），返回 { matched:false, validation }；
//   匹配 → 继续逐数据行回调 onDataRow（经 isRowMeaningful 过滤空行），返回 { matched:true, dataRows }。
// 复用自研 reader 的 parseRowXml（固定 COL_COUNT 列；t="s" 走 sharedStrings；inlineStr/n/str/b 兼容）。
function scanSheet(sheetEntry, sharedStrings, ctx) {
  return new Promise((resolve, reject) => {
    const stream = sheetEntry.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let inSheetData = false;
    let headerChecked = false;
    let matched = false;
    let validation = null;
    let rowIdx = 0;        // sheet 内 <row> 序号（含表头，近似 Excel 行号，用于 _rowIndex）
    let dataRows = 0;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      resolve(result);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      reject(err);
    };

    // 扫 pending 里完整的 <row>...</row> 块；endFlush=true 表示流已结束（不再缓冲半行）
    const drainRows = (endFlush) => {
      while (true) {
        // 兼容有属性 <row ...> 与无属性 <row>；用精确前缀避免误匹配 <rowBreaks> 等同前缀元素
        //   （对齐生产验证版 streaming-xlsx-reader；对真实数据零行为变化，仅排除 sheetData 外噪声）
        const ra = pending.indexOf('<row ');
        const rb = pending.indexOf('<row>');
        const rowStart = ra < 0 ? rb : (rb < 0 ? ra : Math.min(ra, rb));
        if (rowStart < 0) { if (!endFlush && pending.length > 16) pending = pending.slice(-16); break; }
        // 先定位 <row ...> 起始标签的 '>'：判断自闭合 + 解析真实 Excel 行号 r（v2.1.12 codex Minor①）
        const tagEnd = pending.indexOf('>', rowStart);
        if (tagEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }  // 起始标签跨 chunk，等更多数据
        const rowTag = pending.slice(rowStart, tagEnd + 1);
        const rrm = rowTag.match(/\br="(\d+)"/);
        const excelRow = rrm ? parseInt(rrm[1], 10) : null;   // 真实 Excel 行号（不依赖计数，遇省略空行也准）
        // 自闭合 <row .../> 空行 → 明确跳过（不当数据行、不让 </row> 切分错位到下一行）
        if (rowTag.charAt(rowTag.length - 2) === '/') {
          pending = pending.slice(tagEnd + 1);
          continue;
        }
        const rowEnd = pending.indexOf('</row>', rowStart);
        if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }
        const rowXml = pending.slice(rowStart, rowEnd + 6);
        pending = pending.slice(rowEnd + 6);
        rowIdx += 1;
        const cells = parseRowXml(rowXml, COL_COUNT, sharedStrings);
        if (!headerChecked) {
          headerChecked = true;
          const v = validateFlowHeaders(cells);
          if (!v.ok) { done({ matched: false, validation: v, dataRows: 0 }); return false; }
          // Minor②（v2.1.12 codex review）：前 28 列匹配 FLOW 后，再检测表头是否有超出 28 列的尾部 cell。
          //   流式固定 COL_COUNT=28，否则尾部多列被静默忽略，与同步 SheetJS「列数不匹配」严格性不一致 → 主动拒绝整个文件。
          let maxColIdx = -1; let hm;
          const headerColRe = /\br="([A-Z]+)\d+"/g;
          while ((hm = headerColRe.exec(rowXml))) { const ci = lettersToIndex(hm[1]); if (ci > maxColIdx) maxColIdx = ci; }
          if (maxColIdx >= COL_COUNT) {
            fail(new FileValidationError(
              ERROR_CODE,
              `${TEMPLATE_LABEL} 表头列数超出模板 ${COL_COUNT} 列（前 ${COL_COUNT} 列匹配，但检测到第 ${maxColIdx + 1} 列）`,
              { detailLines: [`模板固定 ${COL_COUNT} 列；尾部多余列可能导致列错位，请核对是否选错文件`], context: { templateLabel: TEMPLATE_LABEL, maxColumn: maxColIdx + 1 } }
            ));
            return false;
          }
          matched = true;
          continue;
        }
        if (!isRowMeaningful(cells)) continue;
        const obj = {};
        for (let i = 0; i < COL_COUNT; i++) obj[FLOW_DB_COLUMNS[i]] = normalizeCell(cells[i]);
        obj._rowIndex = excelRow != null ? excelRow : rowIdx;   // 真实 Excel 行号优先，缺 r 属性回退计数
        dataRows += 1;
        ctx.onDataRow(obj);
        ctx.tick();
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
            if (sc >= 0) { done({ matched: false, validation: { ok: false, error: 'sheet 内容为空', detailLines: [] }, dataRows: 0 }); return; }
            if (pending.length > 16) pending = pending.slice(-16);
            return;
          }
        }
        drainRows(false);
      } catch (err) {
        fail(err);
      }
    });

    stream.on('end', () => {
      if (settled) return;
      try {
        pending += decoder.end();
        drainRows(true);
        done({ matched, validation, dataRows });
      } catch (err) {
        fail(err);
      }
    });

    stream.on('error', fail);
  });
}

// 流式读单个流水文件 → 自动定位 FLOW 数据 sheet → 逐数据行回调 onDataRow。
//   onProgress(dataRowsSoFar)：每 PROGRESS_INTERVAL 行 + 结束时回调。
//   返回 { fileName, filePath, dataRows }。损坏/无 sheet/未找到数据表 → 抛 FileValidationError。
async function streamFlowFile(filePath, { onDataRow, onProgress } = {}) {
  const fileName = path.basename(filePath);

  // v3.0.4 块 A · A1：在 JSZip.loadAsync 之前预检 entry 解压尺寸（≥2^31 → 抛明确中文错误）。
  //   预检抛 FileValidationError（wrapReadError 原样透传，errorCode 对齐本 reader）；预检自身失败 fail-open。
  //   PR#71 二轮 codex review（P2）：本 reader 多 sheet 顺序定位——下方 for(sheetNames) 循环逐个
  //   scanSheet(zip.file(sheetName)) inflate 每个 worksheet 直到表头匹配才 break（最坏 inflate 全部 sheet）。
  //   因此**必须检全部 worksheet**：用缺省 sheetEntryNames（不传 = 检中央目录里全部 worksheet + sharedStrings），
  //   任一 sheet 超限都会在扫描时撞 JSZip 崩点，必须前置拦截。
  await assertXlsxEntriesUnderLimit(filePath, { errorCode: ERROR_CODE });

  let zip;
  try {
    const buffer = await fs.promises.readFile(filePath);
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw wrapReadError(err, fileName, filePath);   // zip 损坏/截断 → 友好提示
  }

  let sharedStrings;
  try {
    sharedStrings = await readSharedStrings(zip);
  } catch (err) {
    throw wrapReadError(err, fileName, filePath);
  }

  // 列所有 worksheet（按 sheetN 编号排序），逐个找表头匹配的数据表
  const sheetNames = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml$/)[1], 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml$/)[1], 10);
      return na - nb;
    });
  if (sheetNames.length === 0) {
    throw new FileValidationError(
      ERROR_CODE,
      `${TEMPLATE_LABEL} 文件没有 worksheet`,
      { detailLines: [`文件：${fileName}`], context: { filePath, fileName, templateLabel: TEMPLATE_LABEL } }
    );
  }

  let totalDataRows = 0;
  const ctx = {
    onDataRow: typeof onDataRow === 'function' ? onDataRow : () => {},
    tick: () => {
      totalDataRows += 1;
      if (totalDataRows % PROGRESS_INTERVAL === 0 && typeof onProgress === 'function') onProgress(totalDataRows);
    }
  };

  let dataSheetFound = false;
  let lastValidation = null;
  for (const sheetName of sheetNames) {
    let result;
    try {
      result = await scanSheet(zip.file(sheetName), sharedStrings, ctx);
    } catch (err) {
      throw wrapReadError(err, fileName, filePath);
    }
    if (result.matched) { dataSheetFound = true; break; }
    lastValidation = result.validation;
  }

  if (!dataSheetFound) {
    const detail = lastValidation && lastValidation.detailLines
      ? lastValidation.detailLines
      : ['（所有 sheet 均为空或无有效表头）'];
    throw new FileValidationError(
      ERROR_CODE,
      `${TEMPLATE_LABEL} 未找到流水数据表（所有 sheet 表头均与模板 28 列不匹配）`,
      {
        detailLines: [`文件：${fileName}`, ...detail],
        context: { filePath, fileName, templateLabel: TEMPLATE_LABEL, expectedColumnCount: FLOW_HEADERS.length }
      }
    );
  }

  if (typeof onProgress === 'function') onProgress(totalDataRows);   // 收尾进度（最终行数）
  return { fileName, filePath, dataRows: totalDataRows };
}

module.exports = {
  streamFlowFile,
  ERROR_CODE,
  TEMPLATE_LABEL
};
