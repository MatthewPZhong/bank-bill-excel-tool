// v2.1.12-beta 收单导入提速 —— 手写字节扫描版 reader（替换 sax 解析器）
//
// 背景（POC 实测，scripts/poc/v2.1.12-acquiring-import-parser-compare.js / commit b6e7418）：
//   收单导入 50万行 122s，其中纯解析占 ~90%；insert+raw_json 仅 ~6%。
//   现状 reader.js = yauzl(流式解压) + sax(逐 cell 事件回调，慢) + 逐行 insertFlowRow。
//   sax 对 50万行×48列=2400万 cell 逐个分发 opentag/text/closetag 事件，开销巨大。
//   本文件保留 yauzl 解压（POC 实测 JSZip 在 100万行 ~3.8GB 解压 entry 崩
//   "uncompressed data size mismatch"，yauzl 同文件 OK），仅把 sheet 扫描的 sax 换成
//   手写 indexOf 切 <row>...</row> 块 + 专用单行解析器。纯解析 8.7x(50万)；端到端 5.6x。
//
// 🔴🔴 资金红线（收单导入是 raw_json / 对账金额 / 币种的入库真理源）：
//   本文件必须与 reader.js（sax 版）byte-for-byte 同输出 —— 同 fixture 上，每行每列取值、
//   monthKey、importedCount、抛出的 ImportValidationError.message 全等。
//   contract test：tests/unit/backend/acquiring-bill-currency-import/reader-handrolled-contract.test.js
//   reader.js 保留作 contract 基线 + 过渡回退；本文件复用其 yauzl/sharedStrings/常量，不改 reader.js 行为。
//   生产路径切换由后续步骤负责，本文件仅交付新 reader + contract test，不切换导入链路。
//
// 与 reader.js（sax）逐项对齐的关键语义（已用对照测试钉死，见 contract test #7）：
//   数字型 cell（t="n" / 无 t / t="b" / t="d" / t="e"）—— 取 <v> 原始文本（仅实体解码），
//     绝不 parseFloat、绝不 String(Number)、绝不 bool→TRUE/FALSE 转换。
//     ⚠️ 这正是不能复用 pending-import/streaming-xlsx-reader.parseRowXml 的原因：
//        它对 number 做 parseFloat→String("1000.00")→"1000" 会丢小数改写金额；
//        对 inlineStr 多个 <t> 做拼接（sax 只取最后一个）；对 bool 转 TRUE/FALSE。
//   inlineStr / str cell —— 取 cell body 内「最后一个被采集标签」(<t> 或 <v>) 的内容，实体解码。
//     （sax currentText 在每个 <t>/<v> opentag 重置 → 关闭 cell 时是最后一次采集的文本。）
//   s（shared string）cell —— 取 body 内最后一个 <v> 的整数索引查 sharedStrings；越界/NaN → 空串。
//   <f>（公式）标签 —— 永远忽略（sax 不采集 <f>，只取 <v> 缓存值）。
//   列号 —— 从 cell 的 r 属性列字母段（任意属性顺序，复用 parseColumnFromCellRef）；无 r → 跳过。
//   表头行（rowR===1）用动态数组收集全部出现列（不截断），让 validator 检测「列多」；
//     数据行用 new Array(expectedHeaders.length).fill('') 固定长度防越界（镜像 reader.js lines 162-168）。
//
// 与 reader.js 的「已知差异」：目标是零差异。仅数字 cell 的精度/科学计数本可能差异 ——
//   但本 reader 取 <v> 原始文本，不做任何数值转换，故无差异。理论上唯一潜在差异是
//   sax 与正则对某种「畸形 XML」的容错路径不同（如标签未闭合）；真实 xlsx 不触发，
//   且 contract test 覆盖了所有已知 cell 形态（含科学计数 / 大数 / 多 t / 公式 / 越界 s）0 差异。

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { xmlUnescape } = require('../pending-import/streaming-xlsx-reader');
const { FLOW_HEADERS, BILL_HEADERS, FLOW_KEY_COLUMN_INDICES, BILL_KEY_COLUMN_INDICES } = require('../acquiring-bill-currency-db/columns');
const { validateFlowHeaders, validateBillHeaders, extractMonthKey } = require('./validator');
const importRepo = require('../acquiring-bill-currency-db/import-repository');
// 🔴 复用 reader.js 的 yauzl 解压 + sharedStrings(sax) + 入口常量 + 错误类型（纯追加导出，不改其行为）。
//   sharedStrings 走 sax 不动：它是去重串表、很小、非瓶颈（瓶颈是 sheet），保留 sax 反而保证 byte-identical。
const {
  openZipWithEntries,
  loadSharedStrings,
  SHEET_ENTRY_NAME,
  SHARED_STRINGS_ENTRY_NAME,
  columnLetterToIndex,
  parseColumnFromCellRef,
  ImportValidationError,
  MAX_COLLECTED_ERRORS
} = require('./reader');

// ----------------- 专用单行解析器（🔴🔴 数字 cell 取原文本，逐字对齐 sax）-----------------

// 匹配单个 <c ...>...</c> 或自闭合 <c .../>；attrs 任意顺序后再独立提取 r/t
//   （对齐 streaming-xlsx-reader 的属性顺序无关修复：合法 cell 如 <c s="2" r="N2"> s 在 r 前）。
const CELL_OPEN_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
const CELL_R_RE = /\br="([A-Z]+)\d+"/;        // 从 attrs 提取列字母（r 可在任意位置）
const CELL_T_RE = /\st="([^"]+)"/;            // 从 attrs 提取 cell type
// 同时抓 <t ...>..</t> 与 <v ...>..</v>，按出现顺序记录，取「最后一个被采集标签」对齐 sax currentText 语义。
//   <f>（公式）不在此列 → 自动忽略，与 sax 一致。
const TV_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/g;

// 取 cell body 内最后一个被采集标签的原始（未解码）文本；collectT=false 时 <t> 不算被采集。
//   返回 null 表示无任何被采集标签（→ 空串）。
function lastCollectedText(body, collectT) {
  TV_RE.lastIndex = 0;
  let m;
  let last = null;
  while ((m = TV_RE.exec(body))) {
    const isT = m[1] !== undefined;
    if (isT && !collectT) continue;
    last = isT ? m[1] : m[2];
  }
  return last;
}

// 单 cell 取值，逐字对齐 reader.js sax 的 cell 取值分支（见本文件头部语义表）。
function cellValueFromBody(body, type, sharedStrings) {
  if (type === 'inlineStr' || type === 'str') {
    const t = lastCollectedText(body, true);
    return t === null ? '' : xmlUnescape(t);
  }
  if (type === 's') {
    const t = lastCollectedText(body, false);
    if (t === null) return '';
    const idx = parseInt(xmlUnescape(t), 10);
    return Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
  }
  // 数字 / 无 t / 布尔 / 日期 / 错误：取 <v> 原始文本（仅实体解码），不做任何数值/布尔转换。
  const t = lastCollectedText(body, false);
  return t === null ? '' : xmlUnescape(t);
}

// 解析单个 <row>...</row> 的 XML → 列值数组。
//   isHeaderRow=true（rowR===1）：动态数组收集全部出现列（不截断），让 validator 检测「列多」。
//   否则：固定 new Array(expectedLen).fill('') 防越界 + 内存安全（镜像 reader.js lines 162-168/204-205）。
//   写入语义：按 cell 在 row 中出现顺序写 values[col]（同列出现两次则后者覆盖，与 sax 一致）。
function parseAcquiringRowXml(rowXml, expectedLen, sharedStrings, isHeaderRow) {
  const values = isHeaderRow ? [] : new Array(expectedLen).fill('');
  CELL_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CELL_OPEN_RE.exec(rowXml))) {
    // 自闭合 <c .../>（m[1]=attrs）vs 带 body <c ...>body</c>（m[2]=attrs, m[3]=body）
    const selfClose = m[1] !== undefined;
    const attrs = selfClose ? m[1] : m[2];
    const body = selfClose ? '' : m[3];
    const rm = attrs.match(CELL_R_RE);
    // 无 r 属性 → 列号 -1，sax 的 parseColumnFromCellRef 同样返回 -1 且 allowWrite 为 false → 跳过。
    const colIdx = rm ? columnLetterToIndex(rm[1]) : parseColumnFromCellRef('');
    if (colIdx < 0) continue;
    // 数据行限制 col < expectedLen 防越界；表头行允许任意列（动态扩容）——镜像 reader.js allowWrite。
    if (!isHeaderRow && colIdx >= expectedLen) continue;

    if (selfClose || body === '') {
      values[colIdx] = '';
      continue;
    }
    const tm = attrs.match(CELL_T_RE);
    const type = tm ? tm[1] : '';
    values[colIdx] = cellValueFromBody(body, type, sharedStrings);
  }
  return values;
}

// ----------------- 手写 sheet 扫描（替换 sax streamSheetRows）-----------------

// 流式扫 sheet entry：yauzl openReadStream → StringDecoder → 缓冲 pending → 找 <sheetData> 后
//   逐个切 <row ...>...</row> 块，解析出 { rowR, values } 调 onRow。
//   接口与 reader.js streamSheetRows 完全一致：
//     - onRow({ rowR, values })：rowR 取 <row r="N"> 真实行号；values 见 parseAcquiringRowXml。
//     - onRow 抛 { __stopParsing:true, __stopValue } → 停止 stream + resolve(__stopValue)（peek 早退）。
//     - onRow 抛其它 → reject。
//   自闭合 <row .../> 空行：保号（rowR 用真实行号）但 values 全空（fill('')），onRow 内 allEmpty 跳过，
//     与 sax 一致（sax 对自闭合 row 不进 closetag 'row' 分支 → 不调 onRow；本实现调 onRow 但 values 全空、
//     allEmpty=true 跳过 → 等价结果。注意自闭合 row 不会是表头行 r=1 的合法形态）。
function streamSheetRowsHandRolled({
  zip, sheetEntry, expectedHeaders, sharedStrings, onRow
}) {
  const expectedLen = expectedHeaders.length;
  return new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let inSheetData = false;
      let stopped = false;

      function stop(val) {
        if (stopped) return;
        stopped = true;
        try { stream.unpipe(); } catch (_) {}
        try { stream.destroy(); } catch (_) {}
        resolve(val);
      }
      function failWith(e) {
        if (stopped) return;
        stopped = true;
        try { stream.destroy(); } catch (_) {}
        reject(e);
      }

      // 扫 pending 里完整 <row>...</row> 块；endFlush=true 表示流已结束（不再缓冲半行）。
      function drain(endFlush) {
        while (!stopped) {
          if (!inSheetData) {
            const sd = pending.indexOf('<sheetData>');
            if (sd >= 0) { inSheetData = true; pending = pending.slice(sd + 11); continue; }
            const sc = pending.indexOf('<sheetData/>');
            if (sc >= 0) { inSheetData = true; pending = pending.slice(sc + 12); return; } // 空 sheet（自闭合）
            // 保留少量前缀防 <sheetData> 开标签跨 chunk
            if (!endFlush && pending.length > 16) pending = pending.slice(-16);
            return;
          }
          // 精确前缀（<row 后跟空白或 >），避免误匹配 <rowBreaks> 等同前缀元素
          const ra = pending.indexOf('<row ');
          const rb = pending.indexOf('<row>');
          const rowStart = ra < 0 ? rb : (rb < 0 ? ra : Math.min(ra, rb));
          if (rowStart < 0) { if (!endFlush && pending.length > 16) pending = pending.slice(-16); return; }

          const tagEnd = pending.indexOf('>', rowStart);
          if (tagEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); return; } // 起始标签跨 chunk
          const rowTag = pending.slice(rowStart, tagEnd + 1);
          const rrm = rowTag.match(/\br="(\d+)"/);
          // 真实 Excel 行号：用 <row r> 优先；缺 r 回退 0（与 reader.js sax `parseInt(r,10)||0` 一致）。
          const rowR = rrm ? parseInt(rrm[1], 10) : 0;

          // 自闭合 <row .../> 空行：保号但产全空 values（数据行）；表头行 r=1 不会是自闭合合法形态。
          if (rowTag.charAt(rowTag.length - 2) === '/') {
            pending = pending.slice(tagEnd + 1);
            const isHeader = rowR === 1;
            const values = isHeader ? [] : new Array(expectedLen).fill('');
            try {
              onRow({ rowR, values });
            } catch (rowErr) {
              if (rowErr && rowErr.__stopParsing) { stop(rowErr.__stopValue); return; }
              failWith(rowErr);
              return;
            }
            continue;
          }

          const rowEnd = pending.indexOf('</row>', rowStart);
          if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); return; } // </row> 跨 chunk
          const rowXml = pending.slice(rowStart, rowEnd + 6);
          pending = pending.slice(rowEnd + 6);

          const values = parseAcquiringRowXml(rowXml, expectedLen, sharedStrings, rowR === 1);
          try {
            onRow({ rowR, values });
          } catch (rowErr) {
            if (rowErr && rowErr.__stopParsing) { stop(rowErr.__stopValue); return; }
            failWith(rowErr);
            return;
          }
        }
      }

      stream.on('data', (chunk) => {
        if (stopped) return;
        try {
          pending += decoder.write(chunk);
          drain(false);
        } catch (e) {
          failWith(e);
        }
      });
      stream.on('end', () => {
        if (stopped) return;
        try {
          pending += decoder.end();
          drain(true);
          if (!stopped) resolve();
        } catch (e) {
          failWith(e);
        }
      });
      stream.on('error', (e) => failWith(e));
    });
  });
}

// ----------------- 以下导入编排逐项镜像 reader.js streamImportOneFile / importFlowFile / importBillFile / peekMonthKeyFromFile -----------------

// 内部统一读 + INSERT 逻辑（kind: 'flow' | 'bill'）；caller 持有 SQLite 事务，本函数仅调 prepared insertRow。
async function streamImportOneFile({
  db, kind, filePath, importedAt, expectedMonthKey, onProgress
}) {
  const expectedHeaders = kind === 'flow' ? FLOW_HEADERS : BILL_HEADERS;
  const keyIndices = kind === 'flow' ? FLOW_KEY_COLUMN_INDICES : BILL_KEY_COLUMN_INDICES;
  const validateHeaders = kind === 'flow' ? validateFlowHeaders : validateBillHeaders;
  const insertStmt = kind === 'flow' ? importRepo.prepareFlowInsert(db) : importRepo.prepareBillInsert(db);
  const insertRow = kind === 'flow' ? importRepo.insertFlowRow : importRepo.insertBillRow;

  const sourceFile = path.basename(filePath);
  const errors = [];
  let importedCount = 0;
  let detectedMonthKey = expectedMonthKey || null;
  let headerValidated = false;

  const { zip, entries } = await openZipWithEntries(sourceFile, filePath);
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    if (!sheetEntry) {
      throw new ImportValidationError(`${sourceFile}：未找到 ${SHEET_ENTRY_NAME}`, []);
    }

    const sstEntry = entries.get(SHARED_STRINGS_ENTRY_NAME);
    let sharedStrings = [];
    try {
      sharedStrings = await loadSharedStrings(zip, sstEntry);
    } catch (_e) {
      sharedStrings = [];
    }

    const streamStopValue = await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders,
      sharedStrings,
      onRow: ({ rowR, values }) => {
        if (rowR === 1) {
          // 不 truncate 到 expectedHeaders.length，让 validator 检测「列多」（对齐 reader.js）
          const headerCells = values.map((v) => v == null ? '' : String(v));
          const headerResult = validateHeaders(headerCells);
          if (!headerResult.ok) {
            const err = new ImportValidationError(
              `${sourceFile}：${headerResult.error}`,
              headerResult.detailLines
            );
            err.__stopParsing = true;
            err.__stopValue = err;
            throw err;
          }
          headerValidated = true;
          return;
        }

        if (!headerValidated) {
          const err = new ImportValidationError(
            `${sourceFile}：第 ${rowR} 行：xlsx 缺少表头行（r=1）`,
            []
          );
          err.__stopParsing = true;
          err.__stopValue = err;
          throw err;
        }

        const allEmpty = values.every((v) => v === '' || v == null);
        if (allEmpty) return;

        const billDateRaw = values[keyIndices.billDate];
        const monthKey = extractMonthKey(billDateRaw);
        if (!monthKey) {
          errors.push({ sourceFile, rowIndex: rowR, reason: `账单日期无法解析为月份："${billDateRaw}"` });
          if (errors.length >= MAX_COLLECTED_ERRORS) {
            const stopErr = new Error('errors limit reached');
            stopErr.__stopParsing = true;
            throw stopErr;
          }
          return;
        }
        if (!detectedMonthKey) {
          detectedMonthKey = monthKey;
        } else if (monthKey !== detectedMonthKey) {
          errors.push({ sourceFile, rowIndex: rowR, reason: `跨月份混杂：期望 ${detectedMonthKey}，实际 ${monthKey}` });
          if (errors.length >= MAX_COLLECTED_ERRORS) {
            const stopErr = new Error('errors limit reached');
            stopErr.__stopParsing = true;
            throw stopErr;
          }
          return;
        }

        try {
          insertRow(insertStmt, {
            monthKey,
            sourceFile,
            row: { rowIndex: rowR, values },
            importedAt
          });
          importedCount += 1;
          if (onProgress && importedCount % 10000 === 0) {
            onProgress({ sourceFile, importedCount });
          }
        } catch (insertError) {
          errors.push({
            sourceFile,
            rowIndex: rowR,
            reason: insertError.message || String(insertError)
          });
          if (errors.length >= MAX_COLLECTED_ERRORS) {
            const stopErr = new Error('errors limit reached');
            stopErr.__stopParsing = true;
            throw stopErr;
          }
        }
      }
    });

    if (!headerValidated) {
      // 优先 rethrow 携带 detailLines 的表头错（对齐 reader.js NewF3），避免被「无表头」兜底吞掉列差异明细。
      if (streamStopValue instanceof ImportValidationError) {
        throw streamStopValue;
      }
      throw new ImportValidationError(`${sourceFile}：xlsx 无表头（r=1）`, []);
    }
  } finally {
    try { zip.close(); } catch (_) {}
  }

  if (errors.length > 0) {
    throw new ImportValidationError(
      `${sourceFile}：导入失败 ${errors.length} 行（${errors.length >= MAX_COLLECTED_ERRORS ? '已达上限，提前终止' : '已读完'}）`,
      errors.slice(0, 20).map((e) => `第 ${e.rowIndex} 行：${e.reason}`).concat(
        errors.length > 20 ? [`...（共 ${errors.length} 个错误，仅列前 20 个）`] : []
      )
    );
  }

  return { sourceFile, monthKey: detectedMonthKey, importedCount };
}

async function importFlowFile({ db, filePath, importedAt, expectedMonthKey, onProgress }) {
  return streamImportOneFile({ db, kind: 'flow', filePath, importedAt, expectedMonthKey, onProgress });
}

async function importBillFile({ db, filePath, importedAt, expectedMonthKey, onProgress }) {
  return streamImportOneFile({ db, kind: 'bill', filePath, importedAt, expectedMonthKey, onProgress });
}

// 导入前预检：读到首条非空数据行解析月份后立即停扫描 + close zip；不进事务、不调 INSERT。
async function peekMonthKeyFromFile({ kind, filePath }) {
  const expectedHeaders = kind === 'flow' ? FLOW_HEADERS : BILL_HEADERS;
  const keyIndices = kind === 'flow' ? FLOW_KEY_COLUMN_INDICES : BILL_KEY_COLUMN_INDICES;
  const validateHeaders = kind === 'flow' ? validateFlowHeaders : validateBillHeaders;
  const sourceFile = path.basename(filePath);

  const { zip, entries } = await openZipWithEntries(sourceFile, filePath);
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    if (!sheetEntry) throw new ImportValidationError(`${sourceFile}：未找到 ${SHEET_ENTRY_NAME}`, []);

    const sstEntry = entries.get(SHARED_STRINGS_ENTRY_NAME);
    let sharedStrings = [];
    try {
      sharedStrings = await loadSharedStrings(zip, sstEntry);
    } catch (_e) {
      sharedStrings = [];
    }

    let headerValidated = false;
    let detectedMonthKey = null;
    let peekError = null;

    await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders,
      sharedStrings,
      onRow: ({ rowR, values }) => {
        if (rowR === 1) {
          const headerCells = values.slice(0, expectedHeaders.length).map((v) => v == null ? '' : String(v));
          const headerResult = validateHeaders(headerCells);
          if (!headerResult.ok) {
            peekError = new ImportValidationError(
              `${sourceFile}：${headerResult.error}`,
              headerResult.detailLines
            );
            const stop = new Error('header invalid');
            stop.__stopParsing = true;
            throw stop;
          }
          headerValidated = true;
          return;
        }

        const allEmpty = values.every((v) => v === '' || v == null);
        if (allEmpty) return;

        const billDateRaw = values[keyIndices.billDate];
        const monthKey = extractMonthKey(billDateRaw);
        if (!monthKey) {
          peekError = new ImportValidationError(
            `${sourceFile}：第 ${rowR} 行账单日期无法解析为月份："${billDateRaw}"`,
            []
          );
        } else {
          detectedMonthKey = monthKey;
        }
        const stop = new Error('peek done');
        stop.__stopParsing = true;
        throw stop;
      }
    });

    if (peekError) throw peekError;
    if (!headerValidated) throw new ImportValidationError(`${sourceFile}：xlsx 无表头（r=1）`, []);
    if (!detectedMonthKey) throw new ImportValidationError(`${sourceFile}：xlsx 无有效数据行`, []);

    return { sourceFile, monthKey: detectedMonthKey };
  } finally {
    try { zip.close(); } catch (_) {}
  }
}

module.exports = {
  importFlowFile,
  importBillFile,
  peekMonthKeyFromFile,
  ImportValidationError,
  // 内部 helper 导出供单测直接覆盖单行解析（contract test #7 数字 cell 语义对齐用）
  parseAcquiringRowXml,
  cellValueFromBody
};
