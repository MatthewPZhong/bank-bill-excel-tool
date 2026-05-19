// v2.1.6 T5 + fix2 — 收单单据币种校验：xlsx 流式 reader
// fix2 选型决策（spec §3.5）：
//   v0.3 SheetJS dense 模式对真实清结算数据（30w 行 / inlineStr / 800MB 解压 / POI ZIP data descriptor）
//   失败 — fflate 严格校验 local header uncompressed size 字段，POI 流式写入时为 0 → 拒解
//   ExcelJS streaming（unzipper）同样不支持 data descriptor → invalid signature 0x41d
//   现选型：yauzl（纯 JS ZIP 流式，支持 data descriptor + ZIP64）+ sax（纯 JS SAX 流式 XML）
//   单文件 RAM < 50MB；peek 早退出 O(1) < 100ms；跨平台无 native 编译
//
// 事务由 caller（session 层）开启；本 reader 仅负责 read + validate + 调 prepared insertRow
//
// ⚠️ 资金红线：
//   - 表头不匹配 → 整批拒绝（抛 ImportValidationError）
//   - 主对账Id 为空 / 跨月份混杂 / UNIQUE 重复 → 累积错误（最多 MAX_COLLECTED_ERRORS）→ 抛错让 caller ROLLBACK

const path = require('node:path');
const yauzl = require('yauzl');
const sax = require('sax');
const { FLOW_HEADERS, BILL_HEADERS, FLOW_KEY_COLUMN_INDICES, BILL_KEY_COLUMN_INDICES } = require('../acquiring-bill-currency-db/columns');
const { validateFlowHeaders, validateBillHeaders, extractMonthKey } = require('./validator');
const importRepo = require('../acquiring-bill-currency-db/import-repository');

const MAX_COLLECTED_ERRORS = 100;
const SHEET_ENTRY_NAME = 'xl/worksheets/sheet1.xml';
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';

class ImportValidationError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ImportValidationError';
    this.detailLines = detailLines;
  }
}

// "A" → 0, "Z" → 25, "AA" → 26, "AV" → 47
function columnLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

// 从 cell.r（如 "A1" / "AV300001"）提取列字母段
function parseColumnFromCellRef(cellRef) {
  if (!cellRef) return -1;
  const m = cellRef.match(/^([A-Z]+)/);
  return m ? columnLetterToIndex(m[1]) : -1;
}

// 打开 ZIP + 收集 entry 列表（一次性）
// 返回 { zip, entries: Map<fileName, entry> }；调用方负责 close
function openZipWithEntries(sourceFile, filePath) {
  return new Promise((resolve, reject) => {
    // autoClose:false — 防止 SST stream 'end' 后 yauzl 自动 close zip
    // 导致后续 openReadStream(sheet1.xml) 报 'closed'。caller 必须显式 zip.close()
    yauzl.open(filePath, { lazyEntries: false, autoClose: false }, (err, zip) => {
      if (err) {
        return reject(new ImportValidationError(
          `${sourceFile}：文件读取失败 — ${err.message || String(err)}`,
          []
        ));
      }
      const entries = new Map();
      let settled = false;
      zip.on('entry', (entry) => {
        if (!entries.has(entry.fileName)) entries.set(entry.fileName, entry);
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ zip, entries });
        }
      });
      zip.on('error', (e) => {
        if (!settled) {
          settled = true;
          try { zip.close(); } catch (_) {}
          reject(new ImportValidationError(
            `${sourceFile}：xlsx 解析失败 — ${e.message || String(e)}`,
            []
          ));
        }
      });
    });
  });
}

// 流式解析 sharedStrings.xml；返回 string[]
function loadSharedStrings(zip, sstEntry) {
  if (!sstEntry) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    zip.openReadStream(sstEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      const arr = [];
      let inSi = false;
      let inT = false;
      let currentVal = '';
      parser.on('opentag', (n) => {
        if (n.name === 'si') {
          inSi = true;
          currentVal = '';
        } else if (n.name === 't' && inSi) {
          inT = true;
        }
      });
      parser.on('text', (t) => { if (inT) currentVal += t; });
      parser.on('cdata', (t) => { if (inT) currentVal += t; });
      parser.on('closetag', (tag) => {
        if (tag === 't') inT = false;
        else if (tag === 'si') {
          arr.push(currentVal);
          currentVal = '';
          inSi = false;
        }
      });
      parser.on('end', () => resolve(arr));
      parser.on('error', (e) => reject(e));
      stream.on('error', (e) => reject(e));
      stream.pipe(parser);
    });
  });
}

// 流式解析 sheet1.xml，按 row 触发 onRow callback
// onRow 抛出带 __stopParsing=true 的对象 → 立即停止 sax + 释放 stream
function streamSheetRows({
  zip, sheetEntry, expectedHeaders, sharedStrings, onRow
}) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });

      let stopped = false;
      let stopValue = null;
      let currentRowR = null;
      let currentRowValues = null;
      let currentCellCol = -1;
      let currentCellType = '';
      let inIs = false;
      let inT = false;
      let inV = false;
      let currentText = '';

      function stopParsing(val) {
        if (stopped) return;
        stopped = true;
        stopValue = val;
        try { stream.unpipe(parser); } catch (_) {}
        try { stream.destroy(); } catch (_) {}
        // resolve 在 'end' / 'close' / 立即 resolve
        resolve(stopValue);
      }

      parser.on('opentag', (n) => {
        if (stopped) return;
        const tag = n.name;
        if (tag === 'row') {
          const r = parseInt(n.attributes.r, 10) || 0;
          currentRowR = r;
          currentRowValues = new Array(expectedHeaders.length).fill('');
        } else if (tag === 'c') {
          const ref = n.attributes.r || '';
          currentCellCol = parseColumnFromCellRef(ref);
          currentCellType = n.attributes.t || '';
        } else if (tag === 'is') {
          inIs = true;
        } else if (tag === 't') {
          if (inIs || currentCellType === 'str') {
            inT = true;
            currentText = '';
          }
        } else if (tag === 'v') {
          inV = true;
          currentText = '';
        }
      });

      parser.on('text', (t) => {
        if (stopped) return;
        if (inT || inV) currentText += t;
      });

      parser.on('cdata', (t) => {
        if (stopped) return;
        if (inT || inV) currentText += t;
      });

      parser.on('closetag', (tag) => {
        if (stopped) return;
        if (tag === 't') inT = false;
        else if (tag === 'is') inIs = false;
        else if (tag === 'v') inV = false;
        else if (tag === 'c') {
          if (currentRowValues && currentCellCol >= 0 && currentCellCol < currentRowValues.length) {
            let val = '';
            if (currentCellType === 'inlineStr' || currentCellType === 'str') {
              val = currentText;
            } else if (currentCellType === 's') {
              const idx = parseInt(currentText, 10);
              val = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
            } else {
              // 数字 / 布尔 / 错误等：直接 currentText
              val = currentText;
            }
            currentRowValues[currentCellCol] = val;
          }
          currentCellCol = -1;
          currentCellType = '';
          currentText = '';
        } else if (tag === 'row') {
          if (currentRowValues) {
            const rowR = currentRowR;
            const values = currentRowValues;
            currentRowValues = null;
            currentRowR = null;
            try {
              onRow({ rowR, values });
            } catch (rowErr) {
              if (rowErr && rowErr.__stopParsing) {
                stopParsing(rowErr.__stopValue);
                return;
              }
              if (!stopped) {
                stopped = true;
                try { stream.destroy(); } catch (_) {}
                reject(rowErr);
              }
              return;
            }
          }
        }
      });

      parser.on('end', () => {
        if (!stopped) {
          stopped = true;
          resolve();
        }
      });
      parser.on('error', (e) => {
        if (!stopped) {
          stopped = true;
          reject(e);
        }
      });
      stream.on('error', (e) => {
        if (!stopped) {
          stopped = true;
          reject(e);
        }
      });
      stream.pipe(parser);
    });
  });
}

// 内部统一读 + INSERT 逻辑（kind: 'flow' | 'bill'）
// caller 持有 SQLite 事务；本函数仅调用 prepared insertRow（同步 .run）
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

    await streamSheetRows({
      zip,
      sheetEntry,
      expectedHeaders,
      sharedStrings,
      onRow: ({ rowR, values }) => {
        if (rowR === 1) {
          const headerCells = values.slice(0, expectedHeaders.length).map((v) => v == null ? '' : String(v));
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

    // 行流被 header 失败 stop 时，headerValidated=false → 抛出之前累积的错
    if (!headerValidated) {
      // streamSheetRows 已经 resolve(stopValue=err)；这里 err 已被 stopValue 携带回来。
      // 但流程上更稳：检查 errors 中是否有 header 失败信号，没有则报缺表头
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

// fix1（spec §3.4）+ fix2（spec §3.5）：导入前预检
// yauzl + sax 流式 → 读到首条非空数据行解析月份后立即停 sax + close zip
// 不进事务、不调 INSERT；用于"重复月份导入"覆盖确认前置探测
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

    await streamSheetRows({
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
  ImportValidationError
};
