// 通用大表导入引擎 — zip-reader（v3.0.3 块 D · PR-G1）
//
// 职责：yauzl 流式打开 xlsx → 解析 workbook.xml(.rels) 正解定位「唯一数据 sheet」的真实 entry 路径
//       → 暴露 sheet entry / sharedStrings entry / 解码后的 sharedStrings 数组，供 row-scanner 复用。
//
// 平移来源（仅泛化，不改其行为）：
//   - yauzl 打开 + entry 收集：acquiring-bill-currency-import/reader.js openZipWithEntries
//     （autoClose:false——防 SST stream 'end' 后 yauzl 自动 close，导致后续 openReadStream(sheet) 报 'closed'；
//      caller 必须显式 close()）。
//   - loadSharedStrings：reader.js loadSharedStrings（sax 流式解析 SST → string[]，去重串表小、非瓶颈，
//     保留 sax 反而保证 byte-identical）。
//   - rels 正解定位 sheet：参照 biz-op-recon-import/reader-streamed.js:79-114 locateFirstSheet 既有实现
//     （workbook.xml 取首个 <sheet r:id> → workbook.xml.rels 把 r:id 映射到 worksheet Target）。
//
// 🔴 与收单现状 reader.js 的关键差异（防御项，spec §1.2 / §一.1）：
//   reader.js:23 硬编码 SHEET_ENTRY_NAME='xl/worksheets/sheet1.xml'——workbook 顺序与 sheetN 编号不保证
//   一致，且真实数据源约定为「多文件单 sheet」。本引擎 rels 正解定位唯一 sheet，并在发现 ≥2 个 sheet 时
//   显式报错（列出 sheet 名 + 「该工具仅支持单 sheet 数据文件」口径），杜绝静默丢数据。
//
// 约束：本文件不得 require 任何业务模块（收单/biz-op/pending/vcc 等），引擎自包含。

const yauzl = require('yauzl');
const sax = require('sax');

// 引擎自带错误类（不 import 收单 ImportValidationError；风格对齐 file-service/common.js 的
//   FileValidationError——携带 message + detailLines，供编排层包装/上抛）。
class BigTableImportError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'BigTableImportError';
    this.detailLines = detailLines;
  }
}

const WORKBOOK_ENTRY_NAME = 'xl/workbook.xml';
const WORKBOOK_RELS_ENTRY_NAME = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';

// XML 属性值实体解码（与 biz-op-recon/reader-streamed.js xmlAttrUnescape 等价；仅用于 sheet name 展示）。
function xmlAttrUnescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Target 可能是 "worksheets/sheet1.xml"（相对 xl/）或 "/xl/worksheets/sheet1.xml"（绝对）。
//   归一为 zip entry fileName 形态（xl/ 前缀，无前导 /）；与 reader-streamed.js normalizeWorksheetTarget 等价。
function normalizeWorksheetTarget(target) {
  const t = String(target || '').trim();
  if (t.startsWith('/')) return t.replace(/^\//, '');
  if (t.startsWith('xl/')) return t;
  return 'xl/' + t;
}

// 打开 ZIP + 收集 entry 列表（一次性，lazyEntries:false）。返回 { zip, entries: Map<fileName, entry> }。
//   平移自 reader.js openZipWithEntries：autoClose:false（caller 必须显式 zip.close()）。
function openZipWithEntries(sourceFile, filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false, autoClose: false }, (err, zip) => {
      if (err) {
        return reject(new BigTableImportError(
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
          reject(new BigTableImportError(
            `${sourceFile}：xlsx 解析失败 — ${e.message || String(e)}`,
            []
          ));
        }
      });
    });
  });
}

// 把单个 zip entry 读成完整字符串（用于小文件：workbook.xml / workbook.xml.rels）。
//   yauzl openReadStream → 累积 chunk → utf8 解码。
function readEntryAsString(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}

// 解析 workbook.xml + workbook.xml.rels，返回所有 <sheet> 的 { name, entryPath, state }（按 workbook 出现顺序）。
//   entryPath 经 rels 正解（r:id → Target）；缺 r:id / rels 找不到 → entryPath=null（由调用方决定兜底/报错）。
//   state 缺省为 visible；hidden / veryHidden 由工具箱多 sheet 合并用于排除辅助工作表。
async function locateSheets(zip, entries) {
  const wbEntry = entries.get(WORKBOOK_ENTRY_NAME);
  if (!wbEntry) return [];
  const wbXml = await readEntryAsString(zip, wbEntry);

  // 先建 r:id → Target 映射（属性顺序不定，逐 <Relationship> 标签提取）。
  const ridToTarget = new Map();
  const relsEntry = entries.get(WORKBOOK_RELS_ENTRY_NAME);
  if (relsEntry) {
    const relsXml = await readEntryAsString(zip, relsEntry);
    const relRe = /<Relationship\b[^>]*>/g;
    let rm;
    while ((rm = relRe.exec(relsXml))) {
      const tag = rm[0];
      const idM = tag.match(/\bId="([^"]*)"/);
      const tgtM = tag.match(/\bTarget="([^"]*)"/);
      if (idM && tgtM) ridToTarget.set(idM[1], normalizeWorksheetTarget(tgtM[1]));
    }
  }

  // 逐个 <sheet ...> 提取 name + r:id（属性顺序不定）。
  const sheets = [];
  const sheetRe = /<sheet\b[^>]*>/g;
  let sm;
  while ((sm = sheetRe.exec(wbXml))) {
    const tag = sm[0];
    const nameM = tag.match(/\bname="([^"]*)"/);
    const ridM = tag.match(/\br:id="([^"]*)"/);
    const stateM = tag.match(/\bstate="([^"]*)"/);
    const name = nameM ? xmlAttrUnescape(nameM[1]) : '';
    const state = stateM ? xmlAttrUnescape(stateM[1]) : 'visible';
    let entryPath = null;
    if (ridM && ridToTarget.has(ridM[1])) {
      const candidate = ridToTarget.get(ridM[1]);
      if (entries.has(candidate)) entryPath = candidate;
    }
    sheets.push({ name, entryPath, state });
  }
  return sheets;
}

// 打开 workbook，rels 正解定位「唯一数据 sheet」。
//   返回 { zip, entries, sheetEntry, sheetName, sharedStringsEntry, close() }。
//   🔴 发现 ≥2 个 sheet → 显式报错（列出 sheet 名 + 单 sheet 口径）；杜绝硬编码 sheet1 的静默丢数据。
//   close() 关闭 zip（caller 用完必须调，对齐 yauzl autoClose:false 语义）。
async function openWorkbook(filePath) {
  const path = require('node:path');
  const sourceFile = path.basename(filePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, filePath);
  try {
    const sheets = await locateSheets(zip, entries);

    // 🔴 多 sheet 显式报错（spec §1.2 防御项）。只统计 workbook.xml 声明的 <sheet>（数据 sheet），
    //   不含 chartsheet/dialogsheet（它们不出现在 <sheets>/<sheet> 节点）。
    if (sheets.length >= 2) {
      const names = sheets.map((s, i) => s.name || `(未命名 sheet ${i + 1})`);
      throw new BigTableImportError(
        `${sourceFile}：检测到 ${sheets.length} 个 sheet，该工具仅支持单 sheet 数据文件`,
        [`文件内含 sheet：${names.join('、')}`, '请确保每个数据文件仅包含一个工作表后重试']
      );
    }

    // 定位唯一 sheet 的 entry。
    let sheetEntry = null;
    let sheetName = '';
    if (sheets.length === 1 && sheets[0].entryPath) {
      sheetEntry = entries.get(sheets[0].entryPath);
      sheetName = sheets[0].name;
    } else {
      // 兜底：workbook.xml 缺失 / 无 <sheet> / rels 正解失败 → 退回历史样本 sheet1.xml（仍走「唯一 sheet」语义近似）。
      //   仅当确实只有这一个 worksheet entry 时成立；多 worksheet 已在上方按 workbook 声明拦截。
      const fallback = entries.get('xl/worksheets/sheet1.xml');
      if (fallback) {
        sheetEntry = fallback;
        sheetName = sheets.length === 1 ? sheets[0].name : '';
      }
    }
    if (!sheetEntry) {
      throw new BigTableImportError(`${sourceFile}：未找到数据 sheet（xl/worksheets/*.xml）`, []);
    }

    const sharedStringsEntry = entries.get(SHARED_STRINGS_ENTRY_NAME) || null;

    return {
      zip,
      entries,
      sheetEntry,
      sheetName,
      sharedStringsEntry,
      sourceFile,
      close() {
        try { zip.close(); } catch (_) {}
      }
    };
  } catch (e) {
    // 打开过程出错 → 立即 close，避免句柄泄漏（caller 拿不到 handle 无法 close）。
    try { zip.close(); } catch (_) {}
    throw e;
  }
}

// 流式解析 sharedStrings.xml；返回 string[]。平移自 reader.js loadSharedStrings（sax，byte-identical）。
//   sstEntry 为 null（文件无 sharedStrings.xml，纯 inlineStr 数据）→ 返回 []。
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

module.exports = {
  BigTableImportError,
  openWorkbook,
  loadSharedStrings,
  // 以下供单测 / 未来 pipeline 复用
  openZipWithEntries,
  locateSheets,
  readEntryAsString,
  normalizeWorksheetTarget,
  WORKBOOK_ENTRY_NAME,
  WORKBOOK_RELS_ENTRY_NAME,
  SHARED_STRINGS_ENTRY_NAME
};
