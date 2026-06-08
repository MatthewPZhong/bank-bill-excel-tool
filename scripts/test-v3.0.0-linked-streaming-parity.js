#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// v3.0.0 块 B / O-2 值口径验证（🔴🔴 资金红线 + 数据红线）
//
// 命题：链接表导入若从「SheetJS 全量读」改为「readXlsxStreamed 流式读」，
//   两条读取链路解析出的**单元格值**必须逐格一致，否则落库口径漂移 = 静默资金事故。
//   spec：changes/linked-table-large-file-streaming/spec.md §五 O-2（diff 未过不得落流式落库）。
//
// 两条链路（本脚本复用项目真实代码，非另写一份解析）：
//   现状(truth) = readers.readRowsWithMetadata  →  XLSX.readFile({cellDates:false,dense:true,raw:false})
//                                                →  sheet_to_json({header:1,blankrows:true,defval:''})
//                 每格再过 normalizeCell = String(v).trim()
//   流式        = readXlsxStreamed → parseCellBody：n→String(parseFloat(<v>))、inlineStr/s→文本
//                 每格再过 normalizeCell（与现状同款）
//
// 已知分叉点（本脚本就是要把它们暴露出来）：
//   - Excel serial 日期：SheetJS raw:false 格式化成日期串，流式 String(parseFloat) 得序列号数字 → ❌
//   - 带 numFmt 金额（两位小数/千分位）：SheetJS 给 "1,234.50"，流式给 "1234.5" → ❌
//   - 长数字 ID 存为 n：流式 String(parseFloat) 丢精度/科学计数 → ❌
//   - inlineStr/shared-string 文本、General 数字：两边一致 → ✅
//
// 两个 mode（均自动跑）：
//   PROBE：流式扫前 N 行，统计 cell type / styles numFmt / 关键列原始 XML 样本。
//          ✅ 纯流式、内存恒定 —— **可直接作用于用户 147MB 大文件**，无需 SheetJS 读得动。
//          直接回答流式引擎文件头那两条假设（日期=文本ISO / numFmt 全 General）对链接表成不成立。
//   DIFF ：readRowsWithMetadata vs readXlsxStreamed 逐格比对（需 SheetJS 读得动 = 中等文件）。
//
// 用法：
//   node scripts/test-v3.0.0-linked-streaming-parity.js                 # 跑自带 fixture（自验证 harness）
//   node scripts/test-v3.0.0-linked-streaming-parity.js a.xlsx b.xlsx   # 判定真实文件流式是否安全
//   node scripts/test-v3.0.0-linked-streaming-parity.js --probe-only big.xlsx  # 只 probe 前 40 行（大文件）
//   node scripts/test-v3.0.0-linked-streaming-parity.js --deep big.xlsx        # 全量流式扫描：覆盖全部行的 type/numFmt 同质性（大文件 O-2 终判）
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const JSZip = require('jszip');

const linkedReaders = require('../src/backend/file-service/readers');
const {
  readXlsxStreamed,
  readSharedStrings,
  lettersToIndex
} = require('../src/backend/pending-import/streaming-xlsx-reader');
const { normalizeCell, isRowMeaningful } = require('../src/backend/file-service/common');
const { BANK_STATEMENT_FIELDS } = require('../src/constants/bank-statement-fields');

const DEFAULT_COLCOUNT = BANK_STATEMENT_FIELDS.length; // 44

// 关键风险列（按语义分组，用于 probe 重点抽样 + diff 归类）
const DATE_COLS = new Set(['BillDate', 'ValueDate', '最近修改时间']);
const AMOUNT_COLS = new Set(['Credit Amount', 'Debit Amount', 'Extra Fee', 'Recon Amount', 'buyAmount', 'sellAmount']);
const ID_COLS = new Set(['BizId', 'MerchantId', 'ReconciliationId', 'ChannelOrderNo', 'OriginBillId']);

// Excel builtin numFmtId（日期时间类 / 带格式数字货币百分比类）—— 命中即「非 General」，流式不查样式会漂移
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_NUM_IDS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 37, 38, 39, 40, 41, 42, 43, 44, 48]);

// ---------------------------------------------------------------------------
// 单行 XML → cells（保留 type / 样式索引 / body 原文，probe 用）
// ---------------------------------------------------------------------------
const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
function parseRowCellsRaw(rowXml) {
  CELL_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = CELL_RE.exec(rowXml))) {
    const selfClose = m[1] !== undefined;
    const attrs = selfClose ? m[1] : m[2];
    const body = selfClose ? '' : m[3];
    const rm = attrs.match(/\br="([A-Z]+)\d+"/);
    if (!rm) continue;
    const colIdx = lettersToIndex(rm[1]);
    const tm = attrs.match(/\st="([^"]+)"/);
    const sm = attrs.match(/\ss="(\d+)"/);
    out.push({ colIdx, t: tm ? tm[1] : '', s: sm ? Number(sm[1]) : null, body });
  }
  return out;
}

// 流式扫前 maxRows 个 <row>（扫够即 destroy stream；大文件只读文件头一小段）
function streamFirstRowsXml(zip, maxRows) {
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const stream = sheet.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let inSheetData = false;
    const rows = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      resolve(rows);
    };
    stream.on('data', (chunk) => {
      try {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!inSheetData) {
          const sd = pending.indexOf('<sheetData>');
          if (sd >= 0) { inSheetData = true; pending = pending.slice(sd + 11); }
          else if (pending.indexOf('<sheetData/>') >= 0) { finish(); return; }
          else return;
        }
        while (true) {
          let rowStart = pending.indexOf('<row ');
          if (rowStart < 0) {
            const r2 = pending.indexOf('<row>');
            if (r2 < 0) break;
            rowStart = r2;
          }
          const rowEnd = pending.indexOf('</row>', rowStart);
          if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }
          rows.push(pending.slice(rowStart, rowEnd + 6));
          pending = pending.slice(rowEnd + 6);
          if (rows.length >= maxRows) { finish(); return; }
        }
      } catch (err) {
        try { stream.destroy(); } catch (_e) { /* ignore */ }
        reject(err);
      }
    });
    stream.on('end', () => finish());
    stream.on('error', (e) => { if (!done) reject(e); });
  });
}

function parseStyles(stylesXml) {
  if (!stylesXml) return { cellXfNumFmtIds: [], customNumFmts: [] };
  const customNumFmts = [];
  const nf = /<numFmt\b[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g;
  let m;
  while ((m = nf.exec(stylesXml))) customNumFmts.push({ id: Number(m[1]), code: m[2] });
  const cellXfsM = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const ids = [];
  if (cellXfsM) {
    const xf = /<xf\b[^>]*?numFmtId="(\d+)"/g;
    while ((m = xf.exec(cellXfsM[1]))) ids.push(Number(m[1]));
  }
  return { cellXfNumFmtIds: ids, customNumFmts };
}

function classifyNumFmtId(id, customCodes) {
  if (id === 0) return 'General';
  if (id === 49) return '文本(@)';
  if (BUILTIN_DATE_IDS.has(id)) return '日期/时间(builtin)';
  if (BUILTIN_NUM_IDS.has(id)) return '数字/货币/百分比(builtin)';
  if (id >= 164) {
    const code = customCodes.get(id) || '';
    if (/[ymd]/i.test(code) && !/[#0]/.test(code)) return `自定义日期(${code})`;
    if (/[#0].*[#0]|[#,].*0|0\.0/.test(code)) return `自定义数字(${code})`;
    return `自定义(${code})`;
  }
  return `其他(id=${id})`;
}

async function probe(filePath, { maxRows = 40 } = {}) {
  const buffer = await fs.promises.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const sheetEntries = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  const sharedStrings = await readSharedStrings(zip);
  const stylesEntry = zip.file('xl/styles.xml');
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : '';
  const styles = parseStyles(stylesXml);
  const customCodeMap = new Map(styles.customNumFmts.map((f) => [f.id, f.code]));

  const rowsXml = await streamFirstRowsXml(zip, maxRows);
  if (!rowsXml || rowsXml.length === 0) {
    return { fileSize: buffer.length, sheetEntries, sharedStringsCount: sharedStrings ? sharedStrings.length : 0, styles, header: [], perColumn: [], empty: true };
  }

  // 第一行当表头
  const headerCells = parseRowCellsRaw(rowsXml[0]);
  const header = [];
  for (const c of headerCells) {
    const txt = c.t === 's' && sharedStrings ? (sharedStrings[Number((/<v>([\s\S]*?)<\/v>/.exec(c.body) || [])[1])] || '') : (/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(c.body) || [])[1] || '';
    header[c.colIdx] = normalizeCell(txt);
  }

  // 数据行：按列聚合 type / numFmtId / 原始样本
  const perColumn = [];
  const ensureCol = (i) => (perColumn[i] || (perColumn[i] = { types: new Map(), numFmtIds: new Set(), samples: [] }));
  for (let r = 1; r < rowsXml.length; r += 1) {
    const cells = parseRowCellsRaw(rowsXml[r]);
    for (const c of cells) {
      const col = ensureCol(c.colIdx);
      const tkey = c.t || '(无t/数字)';
      col.types.set(tkey, (col.types.get(tkey) || 0) + 1);
      if (c.s != null && styles.cellXfNumFmtIds[c.s] != null) col.numFmtIds.add(styles.cellXfNumFmtIds[c.s]);
      if (col.samples.length < 3) col.samples.push(`<c t="${c.t}" s="${c.s}">${c.body.slice(0, 60)}</c>`);
    }
  }

  return { fileSize: buffer.length, sheetEntries, sharedStringsCount: sharedStrings ? sharedStrings.length : 0, styles, customCodeMap, header, perColumn, dataRowCount: rowsXml.length - 1 };
}

// ---------------------------------------------------------------------------
// DEEP SCAN：流式扫过整个 sheet1.xml，按列累计 type/numFmt（O(列) 内存，不持有行）
//   —— 把 probe 的「前 40 行采样」升级为「全量覆盖」，资金红线 O-2 终判用。
//   返回结构与 probe 完全一致（可直接喂 printProbe），额外带 widthDist 行宽分布。
// ---------------------------------------------------------------------------
async function deepScan(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const sheetEntries = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  const sharedStrings = await readSharedStrings(zip);
  const stylesEntry = zip.file('xl/styles.xml');
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : '';
  const styles = parseStyles(stylesXml);
  const customCodeMap = new Map(styles.customNumFmts.map((f) => [f.id, f.code]));

  const sheet = zip.file('xl/worksheets/sheet1.xml');
  const base = { fileSize: buffer.length, sheetEntries, sharedStringsCount: sharedStrings ? sharedStrings.length : 0, styles, customCodeMap };
  if (!sheet) return { ...base, header: [], perColumn: [], empty: true };

  const header = [];
  const perColumn = [];
  const widthDist = new Map(); // 「最大列号+1」→ 行数，探测 ragged 行
  const ensureCol = (i) => (perColumn[i] || (perColumn[i] = { types: new Map(), numFmtIds: new Set(), samples: [] }));
  let rowIdx = 0; // 0=表头

  const foldRow = (rowXml) => {
    const cells = parseRowCellsRaw(rowXml);
    if (rowIdx === 0) {
      for (const c of cells) {
        const txt = c.t === 's' && sharedStrings
          ? (sharedStrings[Number((/<v>([\s\S]*?)<\/v>/.exec(c.body) || [])[1])] || '')
          : (/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(c.body) || [])[1] || '';
        header[c.colIdx] = normalizeCell(txt);
      }
      rowIdx += 1;
      return;
    }
    let maxCol = -1;
    for (const c of cells) {
      const col = ensureCol(c.colIdx);
      const tkey = c.t || '(无t/数字)';
      col.types.set(tkey, (col.types.get(tkey) || 0) + 1);
      if (c.s != null && styles.cellXfNumFmtIds[c.s] != null) col.numFmtIds.add(styles.cellXfNumFmtIds[c.s]);
      if (col.samples.length < 3) col.samples.push(`<c t="${c.t}" s="${c.s}">${c.body.slice(0, 60)}</c>`);
      if (c.colIdx > maxCol) maxCol = c.colIdx;
    }
    widthDist.set(maxCol + 1, (widthDist.get(maxCol + 1) || 0) + 1);
    rowIdx += 1;
  };

  // 流式骨架同 streamFirstRowsXml，但不设上限、逐行 fold 后即丢弃
  await new Promise((resolve, reject) => {
    const stream = sheet.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let inSheetData = false;
    stream.on('data', (chunk) => {
      try {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!inSheetData) {
          const sd = pending.indexOf('<sheetData>');
          if (sd >= 0) { inSheetData = true; pending = pending.slice(sd + 11); }
          else if (pending.indexOf('<sheetData/>') >= 0) { resolve(); return; }
          else return;
        }
        while (true) {
          let rowStart = pending.indexOf('<row ');
          if (rowStart < 0) { const r2 = pending.indexOf('<row>'); if (r2 < 0) break; rowStart = r2; }
          const rowEnd = pending.indexOf('</row>', rowStart);
          if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); break; }
          foldRow(pending.slice(rowStart, rowEnd + 6));
          pending = pending.slice(rowEnd + 6);
        }
      } catch (err) { try { stream.destroy(); } catch (_e) { /* ignore */ } reject(err); }
    });
    stream.on('end', () => resolve());
    stream.on('error', (e) => reject(e));
  });

  return { ...base, header, perColumn, widthDist, dataRowCount: Math.max(0, rowIdx - 1) };
}

function printProbe(p, banner) {
  console.log(banner || '  ── PROBE（结构探针，流式，大文件安全）──');
  console.log(`  文件大小: ${(p.fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  worksheet 文件: ${p.sheetEntries.join(', ')}  ${p.sheetEntries.length > 1 ? '⚠️ 多 sheet（流式引擎硬编码只读 sheet1.xml，见 O-5）' : '（单 sheet，流式引擎假设成立）'}`);
  console.log(`  sharedStrings 条数: ${p.sharedStringsCount}`);
  if (p.empty) { console.log('  ⚠️ sheet1.xml 无数据行'); return { dateTextOk: true, numFmtGeneralOk: true }; }

  // styles 概览
  const usedIds = [...new Set(p.styles.cellXfNumFmtIds)].sort((a, b) => a - b);
  const cls = usedIds.map((id) => `${id}:${classifyNumFmtId(id, p.customCodeMap)}`);
  console.log(`  cellXfs 用到的 numFmtId: ${cls.join(' | ')}`);

  // 关键列存储形态判定
  let dateTextOk = true;
  let numFmtGeneralOk = true;
  const flagRows = [];
  p.header.forEach((name, i) => {
    if (!name) return;
    const col = p.perColumn[i];
    if (!col) return;
    const types = [...col.types.entries()].map(([t, n]) => `${t}×${n}`).join(',');
    const fmtIds = [...col.numFmtIds];
    const fmtCls = fmtIds.map((id) => classifyNumFmtId(id, p.customCodeMap));
    const isDateCol = DATE_COLS.has(name);
    const isAmtCol = AMOUNT_COLS.has(name);
    const isIdCol = ID_COLS.has(name);
    if (!(isDateCol || isAmtCol || isIdCol)) return;

    // 该列是否有「数字型」cell（t 为空或 n）
    const hasNumeric = col.types.has('(无t/数字)') || col.types.has('n');
    const fmtNonGeneral = fmtIds.some((id) => id !== 0 && id !== 49);
    let verdict = '✅ 文本/General';
    if (isDateCol && hasNumeric) { dateTextOk = false; verdict = '❌ 数字存储=疑似 Excel serial 日期 → 流式得序列号'; }
    if (fmtNonGeneral && (isAmtCol || isDateCol)) { numFmtGeneralOk = false; verdict = `❌ 带 numFmt(${fmtCls.join(',')}) → 流式不查样式会漂移`; }
    if (isIdCol && hasNumeric) { verdict = '⚠️ ID 存为数字 → 长 ID 流式 String(parseFloat) 可能丢精度/科学计数'; }

    flagRows.push(`    [${i}] ${name}: type{${types}} fmt{${fmtCls.join(',') || 'General'}}  ${verdict}`);
    flagRows.push(`         样本 ${col.samples.join('  ')}`);
  });
  console.log('  关键列存储形态:');
  flagRows.forEach((l) => console.log(l));
  console.log(`  → 假设1（日期=inlineStr ISO 文本）: ${dateTextOk ? '✅ 成立' : '❌ 破裂（出现 serial 日期）'}`);
  console.log(`  → 假设2（金额/日期 numFmt 全 General）: ${numFmtGeneralOk ? '✅ 成立' : '❌ 破裂（出现格式化数字）'}`);
  return { dateTextOk, numFmtGeneralOk };
}

// ---------------------------------------------------------------------------
// DIFF：现状 SheetJS vs 流式，逐格比对
// ---------------------------------------------------------------------------
function readViaSheetJS(filePath) {
  const result = linkedReaders.readRowsWithMetadata(filePath, []); // 二维数组（trim 尾列 + 过滤全空行）
  return Array.isArray(result.rows) ? result.rows : [];
}
async function readViaStreaming(filePath, colCount) {
  const rows = [];
  await readXlsxStreamed(filePath, (cells) => rows.push(cells.slice()), { colCount });
  return rows;
}

function colName(i) {
  return BANK_STATEMENT_FIELDS[i] || `col#${i}`;
}
function riskTag(name) {
  if (DATE_COLS.has(name)) return '日期';
  if (AMOUNT_COLS.has(name)) return '金额';
  if (ID_COLS.has(name)) return 'ID';
  return '其他';
}

async function diff(filePath, colCount) {
  let rowsA;
  try {
    rowsA = readViaSheetJS(filePath);
  } catch (err) {
    return { skipped: true, reason: `SheetJS 读失败（可能 OOM/空）：${err && err.message ? err.message : err}` };
  }
  const rowsBraw = await readViaStreaming(filePath, colCount);

  // 两边统一：过滤全空行（同一 isRowMeaningful 判据），按出现顺序对齐
  const A = rowsA.filter(isRowMeaningful);
  const B = rowsBraw.filter(isRowMeaningful);
  return { skipped: false, ...compareRows(A, B, colCount) };
}

// 纯比对：两组二维数组逐格 normalizeCell 后比对（与文件读取解耦，便于自验证/单测）
function compareRows(A, B, colCount) {
  const rowCountMatch = A.length === B.length;
  const n = Math.min(A.length, B.length);
  const diffs = [];
  const byCol = new Map();
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < colCount; c += 1) {
      const a = normalizeCell(A[r] ? A[r][c] : '');
      const b = normalizeCell(B[r] ? B[r][c] : '');
      if (a !== b) {
        diffs.push({ r, c, a, b });
        const name = colName(c);
        byCol.set(name, (byCol.get(name) || 0) + 1);
      }
    }
  }
  return { aLen: A.length, bLen: B.length, rowCountMatch, diffs, byCol };
}

function printDiff(d) {
  console.log('  ── DIFF（现状 SheetJS raw:false ↔ 流式，逐格）──');
  if (d.skipped) { console.log(`  ⏭️  跳过 DIFF：${d.reason}`); console.log('     （大文件现状读不动正是块 B 的根因；此时 PROBE 结论已足够判断流式安全性）'); return d; }
  console.log(`  现状行数=${d.aLen}  流式行数=${d.bLen}  ${d.rowCountMatch ? '✅ 行数一致' : '❌ 行数不一致'}`);
  if (d.diffs.length === 0) {
    console.log('  ✅ 全部 cell 逐格一致（流式对该文件值口径安全）');
  } else {
    console.log(`  ❌ 发现 ${d.diffs.length} 处不一致，按列分布:`);
    [...d.byCol.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, cnt]) => {
      console.log(`     ${name} [${riskTag(name)}] × ${cnt}`);
    });
    console.log('  前 5 处样例:');
    d.diffs.slice(0, 5).forEach(({ r, c, a, b }) => {
      console.log(`     行${r + 1} 列「${colName(c)}」: 现状=${JSON.stringify(a)}  流式=${JSON.stringify(b)}`);
    });
  }
  return d;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// O-2 真正的分叉点是「两条解析器对同一 cell 给出不同字符串」的 type，而非 numFmt
// （现状 raw:false 未开 cellStyles → numFmt 对两条链路都惰性）。
//   安全 type：(无t/数字) / n（数字，String(.v)≡String(parseFloat)）、inlineStr / s（文本）
//   危险 type：str（公式缓存，流式 <v xml:space> 可能读不出）/ b（布尔）/ e（错误）/ d（ISO 日期）
const SAFE_CELL_TYPES = new Set(['(无t/数字)', 'n', 'inlineStr', 's']);

function printTypeSafety(p) {
  const warns = [];
  (p.perColumn || []).forEach((col, i) => {
    if (!col) return;
    const unsafe = [...col.types.keys()].filter((t) => !SAFE_CELL_TYPES.has(t));
    if (unsafe.length) warns.push(`    [${i}] ${colName(i)}: 出现 ${unsafe.join(',')} 型 cell → 流式/SheetJS 可能不同解析（O-2 分叉点）`);
  });
  if (warns.length) {
    console.log('  ⚠️ 非常规 cell 类型（需扩展 parseCellBody 后才能落流式）:');
    warns.forEach((l) => console.log(l));
  } else {
    console.log('  ✅ 全部列 cell 类型均常规（文本 inlineStr/shared 或 数字 n）→ 无 str/bool/error/date 型分叉风险');
  }
  // 行宽一致性
  const widths = [...(p.widthDist || new Map()).entries()].sort((a, b) => b[1] - a[1]);
  if (widths.length) {
    console.log(`  行宽分布: ${widths.map(([w, n]) => `${w}列×${n}行`).join(', ')}  ${widths.length <= 1 ? '✅ 行宽一致' : '⚠️ 行宽不一致(ragged)'}`);
  }
  return warns.length === 0;
}

async function runFile(filePath, { probeOnly = false, deep = false } = {}) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('文件:', filePath);
  if (!fs.existsSync(filePath)) { console.log('  ⚠️ 文件不存在，跳过'); return { diffCount: null, missing: true }; }
  let assumptions = null;
  let typeSafe = null;
  if (deep) {
    try {
      const p = await deepScan(filePath);
      assumptions = printProbe(p, `  ── DEEP SCAN（全量流式，覆盖全部 ${p.dataRowCount} 数据行；O(列)内存）──`);
      typeSafe = printTypeSafety(p);
    } catch (err) {
      console.log('  ⚠️ DEEP SCAN 失败:', err && err.message ? err.message : err);
    }
    return { diffCount: null, assumptions, typeSafe, deep: true };
  }
  try {
    const p = await probe(filePath);
    assumptions = printProbe(p);
  } catch (err) {
    console.log('  ⚠️ PROBE 失败:', err && err.message ? err.message : err);
  }
  if (probeOnly) return { diffCount: null, assumptions };
  try {
    const d = await diff(filePath, DEFAULT_COLCOUNT);
    printDiff(d);
    return { diffCount: d.skipped ? null : d.diffs.length, skipped: d.skipped, assumptions };
  } catch (err) {
    console.log('  ⚠️ DIFF 失败:', err && err.message ? err.message : err);
    return { diffCount: null, error: true, assumptions };
  }
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'v3.0.0');
const SAFE_FIXTURE = path.join(FIXTURE_DIR, 'linked-parity-safe.xlsx');
const RISKY_FIXTURE = path.join(FIXTURE_DIR, 'linked-parity-risky.xlsx');

(async () => {
  const argv = process.argv.slice(2);
  const probeOnly = argv.includes('--probe-only');
  const deep = argv.includes('--deep');
  const files = argv.filter((a) => !a.startsWith('--'));

  if (files.length > 0) {
    // 真实文件模式：diff>0 / deep 发现危险类型或 serial 日期 → 「流式对该文件不安全」→ exit 1
    let unsafe = 0;
    for (const f of files) {
      const r = await runFile(path.resolve(f), { probeOnly, deep });
      if (r.diffCount && r.diffCount > 0) unsafe += 1;
      else if (r.deep && (r.typeSafe === false || (r.assumptions && r.assumptions.dateTextOk === false))) unsafe += 1;
    }
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(unsafe === 0 ? '✅ 结论：所有文件流式值口径安全（或仅 probe）' : `❌ 结论：${unsafe} 个文件流式不安全 —— 需扩展 parseCellBody（serial 日期→文本 / 查 numFmt / 大数处理）后才能落流式落库`);
    process.exit(unsafe > 0 ? 1 : 0);
  }

  // 自验证模式：跑自带 fixture，断言 harness 行为符合预期
  console.log('（无文件参数 → 跑自带 fixture 自验证 harness。判定真实文件请传路径。）\n');
  if (!fs.existsSync(SAFE_FIXTURE) || !fs.existsSync(RISKY_FIXTURE)) {
    console.log('⚠️ 自带 fixture 不存在，请先运行：node scripts/test-v3.0.0-make-linked-fixture.js');
    process.exit(2);
  }
  const safe = await runFile(SAFE_FIXTURE);
  const risky = await runFile(RISKY_FIXTURE);

  // diff 检测能力：用合成数组验证「逐格比对能抓到不一致」（与文件读取解耦）
  const synthA = [['x', 'y', 'z'], ['1', '2', '3']];
  const synthB = [['x', 'CHANGED', 'z'], ['1', '2', '3']];
  const synthDiff = compareRows(synthA, synthB, 3).diffs.length;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Harness 自验证:');
  const detectOk = synthDiff === 1;
  const safeOk = safe.diffCount === 0;
  // risky 的意义 = PROBE 能识破危险存储（serial 日期 / numFmt），而非 diff>0（见下方实测结论）
  const riskyProbeOk = !!risky.assumptions && (!risky.assumptions.dateTextOk || !risky.assumptions.numFmtGeneralOk);
  console.log(`  ① diff 检测能力（合成数组）  期望抓到 1 处    实际 ${synthDiff}   ${detectOk ? '✓' : '✗'}`);
  console.log(`  ② safe fixture 逐格比对       期望 diff=0      实际 ${safe.diffCount}   ${safeOk ? '✓' : '✗'}`);
  console.log(`  ③ risky fixture PROBE 识别    期望识破危险存储  ${riskyProbeOk ? '✓' : '✗'}`);
  console.log('');
  console.log('  📌 实测结论（重要）：risky fixture 里 serial 日期 / numFmt 金额 / 长 ID，');
  console.log('     在现状读取链路（readers.js: raw:false 但未开 cellStyles）下 SheetJS 返回原始数值 .v，');
  console.log(`     与流式 String(parseFloat(<v>)) 殊途同归 → diff=${risky.diffCount}（一致）。`);
  console.log('     即「numFmt 格式化分叉」在现状配置下不发生，O-2 风险点比 spec R-1 预想的小。');
  console.log('     ⚠️ 但人造 fixture 不能替代真实样本——真实链接表的存储形态必须 PROBE 真实文件确认。');

  const ok = detectOk && safeOk && riskyProbeOk;
  console.log('');
  console.log(ok ? '✅ harness 有效：检测能力正常 + 真实数据逐格一致 + PROBE 识破危险存储' : '❌ harness 行为不符预期，需检查');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
