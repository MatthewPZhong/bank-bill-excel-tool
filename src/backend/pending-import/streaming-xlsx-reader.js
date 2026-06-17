// 流式 xlsx 读取器（自研）
// 解决 Electron utilityProcess 子进程 ~1GB 内存上限问题：
// ExcelJS readFile 对 30 万行 × 31 列文件内存峰值 >1GB，必 OOM；
// 本 reader 边解压 zip entry 边扫描 <row>...</row> 块，内存常数（~MB 量级）。
//
// 假设（已 probe 用户样本 2602/2603 确认）：
// 1. 31 列固定宽度；
// 2. cell type 仅两种：`inlineStr`（<is><t>值</t></is>）和 `n`（<v>数字</v>）；
// 3. 日期字段（billDate / valueDate / finish_time 等）以 inline-string ISO 文本存储，无 Excel serial；
// 4. styles.xml 里 numFmtId 全为 0（General），无需查样式表。
//
// 若未来样本出现 t="s"（shared string）、t="d"、t="b"、t="e" 或 Excel serial 日期，
// 需扩展 parseCellFromBody；当前降级为空字符串，不会崩。

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const JSZip = require('jszip');
// v3.0.4 块 A · A1：JSZip loadAsync 前的入口尺寸预检（≥2^31 抛明确中文错误，预检自身失败 fail-open）。
const { assertXlsxEntriesUnderLimit } = require('./xlsx-size-preflight');

function lettersToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

function xmlUnescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (_m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e[0] === '#') {
      const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return '';
  });
}

// 正则：匹配单个 <c ...>...</c> 或自闭合 <c .../>；attrs 任意顺序后再独立提取 r/t。
// 🔴 资金红线（v2.1.12 codex review Critical 修复）：旧版写死 `<c\s+r="..."` 要求 r 是**第一个**属性，
//   但 OOXML 不保证属性顺序——合法单元格如 `<c s="2" r="N2"><v>123.45</v></c>`（s 在 r 前）会被漏读，
//   若漏的是「对账金额」列 → 后续按空值计 0 → 少算发生额 + 错期末 OP（不报错的静默资金事故）。
//   改为：先匹配整个 <c> 标签取 attrs（分支1 自闭合 / 分支2 带 body），再用 CELL_R_RE/extractTypeFromAttrs
//   从 attrs 任意位置提取 r、t，不依赖属性顺序。
const CELL_OPEN_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
const CELL_R_RE = /\br="([A-Z]+)\d+"/;   // 从 attrs 提取列字母（r 可在任意位置）
const T_CONTENT_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
// v3.0.8 BUG3 修复：旧版 /<v>...<\/v>/ 要求 <v> 是**裸标签**，但 SheetJS / Excel 写「含首尾空格的字符串」
//   会输出 `<c t="str"><v xml:space="preserve"> A </v></c>`（<v> 带 xml:space 属性）→ 旧正则不匹配 →
//   该单元格被静默读成空串（工具箱合表/拆表读任意用户表头/数据时表头首格丢字、值丢失）。
//   改为容忍 <v> 任意属性（与 T_CONTENT_RE 同款 `(?:\s[^>]*)?`）；裸 <v> 仍匹配，向后兼容。
const V_CONTENT_RE = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/;

function extractTypeFromAttrs(attrs) {
  if (!attrs) return '';
  const m = attrs.match(/\st="([^"]+)"/);
  return m ? m[1] : '';
}

// 解析单行 XML → 31 列字符串数组
function parseRowXml(rowXml, colCount, sharedStrings) {
  const cells = new Array(colCount).fill('');
  CELL_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CELL_OPEN_RE.exec(rowXml))) {
    // 两种匹配分支：自闭合 <c .../>（m[1]=attrs）vs 带 body <c ...>body</c>（m[2]=attrs, m[3]=body）
    const selfClose = m[1] !== undefined;
    const attrs = selfClose ? m[1] : m[2];
    const body = selfClose ? '' : m[3];
    // 从 attrs 独立提取 r（列字母），不依赖属性顺序（🔴资金红线，见 CELL_OPEN_RE 注释）
    const rm = attrs.match(CELL_R_RE);
    if (!rm) continue;   // 无 r 属性（极罕见，非标准）→ 跳过
    const colIdx = lettersToIndex(rm[1]);
    if (colIdx < 0 || colIdx >= colCount) continue;

    if (selfClose || body === '') {
      cells[colIdx] = '';
      continue;
    }

    const type = extractTypeFromAttrs(attrs);
    cells[colIdx] = parseCellBody(body, type, sharedStrings);
  }
  return cells;
}

function parseCellBody(body, type, sharedStrings) {
  if (type === 'inlineStr') {
    T_CONTENT_RE.lastIndex = 0;
    const parts = [];
    let tm;
    while ((tm = T_CONTENT_RE.exec(body))) parts.push(tm[1]);
    return xmlUnescape(parts.join(''));
  }
  if (type === 'n' || type === '') {
    const v = V_CONTENT_RE.exec(body);
    if (!v) return '';
    // 对齐 ExcelJS 的 number 语义（String(Number(x))）：
    // - 样本里 <v>0.01</v> parseFloat → 0.01 → String → "0.01"（等价 XML 原文）
    // - xlsx writer 按最简形式序列化，此路径和 ExcelJS 行为一致
    const n = parseFloat(v[1]);
    if (!Number.isFinite(n)) return v[1];
    return String(n);
  }
  if (type === 's') {
    // shared string：<v> 是 sharedStrings 的整数索引
    const v = V_CONTENT_RE.exec(body);
    if (!v) return '';
    const idx = parseInt(v[1], 10);
    if (!sharedStrings || idx < 0 || idx >= sharedStrings.length) return '';
    return sharedStrings[idx];
  }
  if (type === 'str') {
    // formula string
    const v = V_CONTENT_RE.exec(body);
    return v ? xmlUnescape(v[1]) : '';
  }
  if (type === 'b') {
    const v = V_CONTENT_RE.exec(body);
    return v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
  }
  // 'd' (ISO date string), 'e' (error), 其他未知 —— 降级取 <v> 或 <t> 首选
  const v = V_CONTENT_RE.exec(body);
  if (v) return xmlUnescape(v[1]);
  T_CONTENT_RE.lastIndex = 0;
  const tm = T_CONTENT_RE.exec(body);
  return tm ? xmlUnescape(tm[1]) : '';
}

// 流式读 sharedStrings.xml 到数组；不存在返回 null
async function readSharedStrings(zip) {
  const entry = zip.file('xl/sharedStrings.xml');
  if (!entry) return null;

  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const strings = [];

    stream.on('data', (chunk) => {
      try {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        // 逐个提取 <si>...</si>
        while (true) {
          const siStart = pending.indexOf('<si>');
          if (siStart < 0) {
            // 兼容 <si 带属性（极少见）
            const siStart2 = pending.indexOf('<si ');
            if (siStart2 < 0) {
              // 保留缓冲少量前缀（防 <si 开标签跨 chunk）
              if (pending.length > 8) pending = pending.slice(-8);
              break;
            }
            const gt = pending.indexOf('>', siStart2);
            if (gt < 0) break;
            const siEnd2 = pending.indexOf('</si>', gt);
            if (siEnd2 < 0) { pending = pending.slice(siStart2); break; }
            const inner = pending.slice(gt + 1, siEnd2);
            pending = pending.slice(siEnd2 + 5);
            strings.push(siInnerToText(inner));
            continue;
          }
          const siEnd = pending.indexOf('</si>', siStart);
          if (siEnd < 0) { pending = pending.slice(siStart); break; }
          const inner = pending.slice(siStart + 4, siEnd);
          pending = pending.slice(siEnd + 5);
          strings.push(siInnerToText(inner));
        }
      } catch (err) {
        try { stream.destroy(); } catch (_e) { /* ignore */ }
        reject(err);
      }
    });
    stream.on('end', () => {
      pending += decoder.end();
      // 最后再扫一遍剩余的 <si>
      while (true) {
        const siStart = pending.indexOf('<si>');
        if (siStart < 0) break;
        const siEnd = pending.indexOf('</si>', siStart);
        if (siEnd < 0) break;
        const inner = pending.slice(siStart + 4, siEnd);
        pending = pending.slice(siEnd + 5);
        strings.push(siInnerToText(inner));
      }
      resolve(strings);
    });
    stream.on('error', reject);
  });
}

function siInnerToText(inner) {
  // 单 <si> 可能：纯 <t>文本</t> | 富文本 <r>...<t>X</t>...</r><r>...<t>Y</t></r>
  // 所有 <t>...</t> 拼接（无论嵌在 <r> 内外）
  T_CONTENT_RE.lastIndex = 0;
  const parts = [];
  let m;
  while ((m = T_CONTENT_RE.exec(inner))) parts.push(m[1]);
  return xmlUnescape(parts.join(''));
}

// 主入口：流式读取 xlsx 的 sheet1.xml，逐行回调
// onRow(cells: string[31], rowIdx: 1-based): void
// 返回 { rowCount }（含表头）
// 选项扩展（向后兼容）：
//   maxRows  可选「读够即停」上限——读到第 maxRows 行后立即 destroy stream 并 resolve，
//            用于「只需文件头部前 N 行」的场景（如 detector 表头识别），内存/耗时只取决于前 N 行。
//            缺省（undefined/0/负数）= 不设上限，全量扫描（既有调用方行为 100% 不变）。
//   返回值新增 truncated：true 表示因 maxRows 提前终止（文件可能还有更多行），全量读时为 false。
async function readXlsxStreamed(filePath, onRow, { colCount = 31, maxRows = 0 } = {}) {
  // v3.0.4 块 A · A1：在 JSZip.loadAsync 之前预检 entry 解压尺寸（≥2^31 → 抛明确中文错误，
  //   不再让 JSZip 抛 `uncompressed data size mismatch` 天书）；预检自身失败时 fail-open 放行。
  //   PR#71 二轮 codex review（P2）：本 reader 硬编码只 inflate xl/worksheets/sheet1.xml（下方第一句）
  //   + xl/sharedStrings.xml（readSharedStrings），故只检这两者；其他未使用的 worksheet 即便超限也不会被
  //   inflate，不应误拒（sharedStrings 由预检恒检）。
  await assertXlsxEntriesUnderLimit(filePath, { sheetEntryNames: ['xl/worksheets/sheet1.xml'] });
  const buffer = await fs.promises.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const sheetEntry = zip.file('xl/worksheets/sheet1.xml');
  if (!sheetEntry) throw new Error('xlsx 缺少 xl/worksheets/sheet1.xml');

  // 先载入 sharedStrings（可能几 MB - 几百 MB；对 t="s" 类型 cell 必需）
  const sharedStrings = await readSharedStrings(zip);

  // maxRows ≤ 0 视为不限制（保持既有「全量扫描」语义）
  const hasLimit = Number.isInteger(maxRows) && maxRows > 0;

  return new Promise((resolve, reject) => {
    const stream = sheetEntry.nodeStream();
    // StringDecoder 缓存跨 chunk 的 UTF-8 多字节序列，防止中文被截断成 \ufffd
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let rowIdx = 0;
    let inSheetData = false;
    // 早停幂等收尾标志：destroy 后仍可能有一个 in-flight 的 data/end 事件，用它防重复 resolve/reject。
    let settled = false;

    // 读够 maxRows 时干净终止：destroy stream + resolve（truncated=true 标记文件可能还有更多行）。
    const finishTruncated = () => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_e) { /* ignore */ }
      resolve({ rowCount: rowIdx, truncated: true });
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      try {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        // 找到 <sheetData> 起始后才扫行（避免扫到 <col> 等其它 XML）
        if (!inSheetData) {
          const sd = pending.indexOf('<sheetData>');
          if (sd < 0) {
            // 兼容自闭合 <sheetData/>（空 sheet）
            const sc = pending.indexOf('<sheetData/>');
            if (sc >= 0) {
              inSheetData = true;
              pending = pending.slice(sc + 12);
            } else {
              return;
            }
          } else {
            inSheetData = true;
            pending = pending.slice(sd + 11);
          }
        }

        // 扫完整 <row>...</row> 块
        while (true) {
          const rowStart = pending.indexOf('<row ');
          if (rowStart < 0) {
            // 兼容无属性 <row>
            const rowStart2 = pending.indexOf('<row>');
            if (rowStart2 < 0) break;
            const rowEnd2 = pending.indexOf('</row>', rowStart2);
            if (rowEnd2 < 0) break;
            const rowXml2 = pending.slice(rowStart2, rowEnd2 + 6);
            pending = pending.slice(rowEnd2 + 6);
            rowIdx += 1;
            onRow(parseRowXml(rowXml2, colCount, sharedStrings), rowIdx);
            if (hasLimit && rowIdx >= maxRows) { finishTruncated(); return; }
            continue;
          }
          const rowEnd = pending.indexOf('</row>', rowStart);
          if (rowEnd < 0) {
            // 截掉 rowStart 之前的无关内容，释放 pending 前半
            if (rowStart > 0) pending = pending.slice(rowStart);
            break;
          }
          const rowXml = pending.slice(rowStart, rowEnd + 6);
          pending = pending.slice(rowEnd + 6);
          rowIdx += 1;
          onRow(parseRowXml(rowXml, colCount, sharedStrings), rowIdx);
          if (hasLimit && rowIdx >= maxRows) { finishTruncated(); return; }
        }
      } catch (err) {
        try { stream.destroy(); } catch (_e) { /* ignore */ }
        if (!settled) { settled = true; reject(err); }
      }
    });

    stream.on('end', () => {
      if (settled) return;
      // flush decoder 剩余字节（通常为空）
      pending += decoder.end();
      // 处理 end 后还有可能剩半个 <row>
      while (true) {
        const rowStart = pending.indexOf('<row ');
        if (rowStart < 0) break;
        const rowEnd = pending.indexOf('</row>', rowStart);
        if (rowEnd < 0) break;
        const rowXml = pending.slice(rowStart, rowEnd + 6);
        pending = pending.slice(rowEnd + 6);
        rowIdx += 1;
        onRow(parseRowXml(rowXml, colCount, sharedStrings), rowIdx);
        if (hasLimit && rowIdx >= maxRows) { settled = true; resolve({ rowCount: rowIdx, truncated: true }); return; }
      }
      settled = true;
      resolve({ rowCount: rowIdx, truncated: false });
    });
    stream.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

module.exports = {
  readXlsxStreamed,
  parseRowXml,
  parseCellBody,
  lettersToIndex,
  xmlUnescape,
  // v2.1.12 需求1：vcc-op-calc reader 复用（JSZip + central directory 解析，支持 data descriptor）
  readSharedStrings
};
