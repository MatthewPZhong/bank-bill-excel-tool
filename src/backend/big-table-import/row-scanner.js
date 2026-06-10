// 通用大表导入引擎 — row-scanner（v3.0.3 块 D · PR-G1）🔴 性能核心 + 资金红线
//
// 单遍字节状态机行扫描器：不再全量 Buffer→string 转换、不用任何多字节 Buffer.indexOf。
//   一个逐字节 for 循环（V8 JIT 后 ~700MB/s，实测裸扫 50w/1.8GB ≈ 2.57s，接近 inflate 物理地板）推进，
//   用最小状态机识别 <sheetData>→<row r="N">→行内顺序的每个 <c r=".." t="..">→cell body→</c>→</row>，
//   仅对「白名单内列 / hasAnyCellText 探测仍需」的 cell body 局部 toString 取值。
//
//   设计依据（O-5 五次修订转入的性能债务 + PR-G1 返工 profile）：
//     旧「Buffer.indexOf 多 pattern 逐行反查」方案 70% 时间烧在 indexOfBuffer（每行被等效扫 6-8 遍，
//     1.8GB×6-8≈11-14GB 等效扫描）——Buffer.indexOf 比 V8 String.indexOf 慢、且多字节 pattern 的
//     LinearSearch 退化为海量 memchr 短跳+验证失败。改单遍状态机后「每字节只看一次」，indexOf 全消除。
//
// 🔴🔴 资金红线 — 输出契约与 acquiring-bill-currency-import/reader-handrolled.js 的行产物完全一致：
//   onRow({ rowR, values, hasAnyCellText })，逐行逐列 values / rowR / hasAnyCellText 与
//   reader-handrolled（≡ sax reader.js）byte-for-byte 等价。表头行（rowR===1）恒全列解析。
//   等价性由四方 harness 锁（sax ≡ 手写全列 ≡ 手写白名单 ≡ 本引擎字节层；含跨 chunk 边界），见
//   tests/unit/backend/big-table-import/row-scanner-four-way-contract.test.js。
//
// 🔴 UTF-8 安全性（核心论证）：
//   所有定位/识别锚点（<sheetData / <row / </row / <c / </c / r=" / t=" / <v / <is / <t / > / / 等）均为
//   ASCII 字节序列。UTF-8 规则：多字节字符的所有字节均 ≥ 0x80（首字节 0xC0-0xF4、续字节 0x80-0xBF），
//   绝不含任何 ASCII 字节（0x00-0x7F）。故逐字节比对这些 ASCII 锚点无误命中风险——中文等多字节内容
//   只在「取 cell body 局部 toString」时被完整解码（body 字节区间完整包含多字节序列，不从中间截断）。
//
// 语义平移（逐项对齐 reader-handrolled，见各 helper 注释）：
//   - cellValueFromBody / cellHasText / lastCollectedText：cell 取值/判空逻辑直接平移（作用于局部 body
//     字符串，天然 byte-for-byte）。s 型查 SST / inlineStr / str / number 全分支对齐。
//   - 列号：cell 的 r 属性列字母段 → columnLetterToIndex（无 r 跳过；任意属性顺序）。
//   - 同列重复取最后：行内同列 cell 顺序写 values[col]，后者覆盖（与 sax 一致）。
//   - hasAnyCellText：任一 cell「取值非空」即 true（探测短路——一旦 true 后续 cell 不再探测；
//     生产每行 A 列首 cell 必非空 → 几乎只探 1 个 cell）。供 onRow 的 allEmpty 等价判定。
//   - 表头行（rowR===1）：全列解析（动态数组，不截断，validator 检测「列多」契约）。
//   - 自闭合 <row .../> / <c .../>：空行/空 cell（hasAnyCellText 不受影响）。
//   - XML 转义解码（&amp; 等）：引擎自带 xmlUnescape，与 pending-import/streaming-xlsx-reader 等价。
//
// 约束：本文件不得 require 任何业务模块，引擎自包含。

// ──────────────────────── XML 实体解码（引擎自带，与 streaming-xlsx-reader.xmlUnescape 逐字等价）────────────────────────
//   支持具名实体 amp/lt/gt/quot/apos + 数字字符引用 &#NNN; / &#xHH;（与收单复用的 xmlUnescape 同语义）。
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

// ──────────────────────── 列号 ↔ 列字母（与 reader.js columnLetterToIndex 严格互逆）────────────────────────
// "A"→0, "Z"→25, "AA"→26, "AV"→47
function columnLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}
// 0→A, 6→G, 28→AC, 29→AD
function indexToColumnLetters(idx) {
  let n = idx;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// ──────────────────────── cell 取值（字符串级，作用于局部 body；逐字平移 reader-handrolled）────────────────────────

// 取 cell body 内最后一个被采集标签（<t>/<v>）的原始（未解码）文本；collectT=false 时 <t> 不算被采集。
//   返回 null 表示无任何被采集标签（→ 空串）。
//   🔴 等价于旧正则 TV_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/g 的「取最后一个匹配」语义
//     （<f> 公式标签不采集，与 sax 一致），改手写字符串扫描去掉正则开销（性能核心，body 取值热路径）。
//     扫描规则：从左到右找 '<t' 或 '<v'（后跟 '>' 或空白——对齐正则 (?:\s[^>]*)? 即「无属性」或「空白起的属性」），
//     找其 '>' 后内容到对应 </t> / </v>，记录为 last；继续扫至 body 末，返回最后一个。
function lastCollectedText(body, collectT) {
  let last = null;
  let i = 0;
  const len = body.length;
  while (i < len) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;
    const c1 = body.charCodeAt(lt + 1);
    // 仅关心 <t / <v（开标签）；其它（</t>、</v>、<is>、<f> 等）跳过。
    let isT = false;
    let isV = false;
    if (c1 === 0x74 /* t */) isT = true;
    else if (c1 === 0x76 /* v */) isV = true;
    if (!isT && !isV) { i = lt + 1; continue; }
    // 标签名后须是 '>' 或空白（对齐正则「<t>」或「<t 空白...>」；排除 <table 之类同前缀）。
    const c2 = body.charCodeAt(lt + 2);
    const nameEndOk = c2 === 0x3e /* > */ || c2 === 0x20 || c2 === 0x09 || c2 === 0x0a || c2 === 0x0d || c2 === 0x0c;
    if (!nameEndOk) { i = lt + 1; continue; }
    // 找开标签的 '>'
    const gt = body.indexOf('>', lt + 2);
    if (gt < 0) break;
    // 自闭合 <t/> / <v/>：无内容文本节点 → 对齐正则（要求有 </t>/</v> 才匹配）不采集，跳过。
    if (body.charCodeAt(gt - 1) === 0x2f /* '/' */) { i = gt + 1; continue; }
    const contentStart = gt + 1;
    // 找对应闭合 </t> 或 </v>
    const closeTag = isT ? '</t>' : '</v>';
    const close = body.indexOf(closeTag, contentStart);
    if (close < 0) break;   // 无闭合 → 与正则非贪婪不匹配一致（不采集）
    if (isT && !collectT) {
      // <t> 不算被采集（s 型场景），但仍跳过其内容继续找后续 <v>。
      i = close + closeTag.length;
      continue;
    }
    last = body.slice(contentStart, close);
    i = close + closeTag.length;
  }
  return last;
}

// 单 cell 取值，逐字对齐 reader.js sax 的 cell 取值分支：
//   inlineStr/str → 最后采集标签（含 <t>）实体解码；s → 最后 <v> 整数索引查 SST（越界/NaN→''）；
//   数字/无 t/布尔/日期/错误 → 取 <v> 原始文本仅实体解码（绝不 parseFloat/String(Number)/bool 转换）。
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
  const t = lastCollectedText(body, false);
  return t === null ? '' : xmlUnescape(t);
}

// 探测单 cell「取值是否非空」：定义级与 cellValueFromBody 判空对齐（直接复用取值判 !== ''）。
//   cellHasText(body,type,ss) ≡ (cellValueFromBody(body,type,ss) !== '')，对所有 cell 形态成立
//   （s 型查表判空、inlineStr 末尾空 run 取值空 等，论证见 reader-handrolled 头部「allEmpty 等价」段）。
function cellHasText(body, type, sharedStrings) {
  return cellValueFromBody(body, type, sharedStrings) !== '';
}

// ──────────────────────── ASCII 字节常量 ────────────────────────
const LT = 0x3c;        // '<'
const GT = 0x3e;        // '>'
const SLASH = 0x2f;     // '/'
const QUOTE = 0x22;     // '"'

// ──────────────────────── 单行解析（在「整行字节 + 列字母→type→body 区间」上跑取值；供单测直接驱动）────────────────────────
// rowBytesToValues：给定一行的字节 Buffer（[rowStart,rowEnd) 已切好，含 <row..> 起始与 </row> 或不含均可——
//   本函数只扫 <c> cell，不依赖行边界标签），白名单 / 全列解析出 { values, hasAnyCellText }。
//   ⚠️ 本函数是「行内 cell 状态机」的纯函数版（不跨 chunk）；流式主循环 scanSheetRows 用同款 cell 解析逻辑
//   但内联进逐字节循环以支持跨 chunk。两者语义必须一致（四方 harness 锁）。
//
// 参数：buf=行字节、start/end=行内字节区间（cell 都在此内）、rowR、expectedLen、sharedStrings、
//   whitelist=Set|null（null=全列）、isHeaderRow（表头恒全列）。
function rowBytesToValues(buf, start, end, expectedLen, sharedStrings, whitelist, isHeaderRow) {
  const effWhitelist = isHeaderRow ? null : whitelist;
  const values = isHeaderRow ? [] : new Array(expectedLen).fill('');
  let hasAnyCellText = false;

  let i = start;
  while (i < end) {
    // 找下一个 '<'
    if (buf[i] !== LT) { i++; continue; }
    // 判断标签类型：<c\b（c 后非单词字符）
    if (buf[i + 1] !== 0x63 /* 'c' */) { i++; continue; }
    const after = buf[i + 2];
    if (after !== undefined && isWordByte(after)) { i += 2; continue; }   // <col / <cols 等同前缀，跳过
    // 这是一个 <c 标签。解析 attrs 到 '>'。
    const tagStart = i;
    let p = i + 2;
    while (p < end && buf[p] !== GT) p++;
    if (p >= end) break;   // 标签未闭合（畸形/越界）→ 停
    const tagEnd = p;       // buf[tagEnd] === '>'
    const selfClose = buf[tagEnd - 1] === SLASH;

    // 提列号 + type（在 attrs 区间 [tagStart, tagEnd) 内逐字节提取）
    const colIdx = parseCellColumn(buf, tagStart, tagEnd);
    const type = parseCellType(buf, tagStart, tagEnd);

    if (selfClose) {
      // 自闭合 <c .../>：body=''，取值恒 ''，不影响 hasAnyCellText。
      if (colIdx >= 0 && (isHeaderRow || colIdx < expectedLen)) {
        if (isHeaderRow) ensureIndex(values, colIdx);
        values[colIdx] = '';
      }
      i = tagEnd + 1;
      continue;
    }

    // 带 body：找 </c>（逐字节）。
    const bodyStart = tagEnd + 1;
    let q = bodyStart;
    while (q < end) {
      if (buf[q] === LT && buf[q + 1] === SLASH && buf[q + 2] === 0x63 /* c */ && buf[q + 3] === GT) break;
      q++;
    }
    const bodyEnd = q < end ? q : end;       // </c> 起始位（不含）；越界则到 end
    const nextI = q < end ? q + 4 : end;     // </c> 之后（4 = '</c>'）

    // 列号 -1（无 r 属性）→ 跳过（对齐 sax allowWrite false）。
    if (colIdx < 0) { i = nextI; continue; }
    // 数据行限制 col < expectedLen 防越界；表头行允许任意列。
    if (!isHeaderRow && colIdx >= expectedLen) { i = nextI; continue; }

    // 是否需要取该 cell 的 body：白名单内列必取值；hasAnyCellText 尚未 true 时所有列都要探测。
    const inWhitelist = effWhitelist === null || effWhitelist.has(colIdx);
    if (inWhitelist || !hasAnyCellText) {
      const bodyStr = bodyEnd > bodyStart ? buf.toString('utf8', bodyStart, bodyEnd) : '';
      if (inWhitelist) {
        const v = cellValueFromBody(bodyStr, type, sharedStrings);
        if (isHeaderRow) ensureIndex(values, colIdx);
        values[colIdx] = v;
        if (!hasAnyCellText && v !== '') hasAnyCellText = true;
      } else {
        // 白名单外列：不取值（values 保持 ''），但探测 hasAnyCellText（与全列解码判空等价）。
        if (!hasAnyCellText && cellHasText(bodyStr, type, sharedStrings)) hasAnyCellText = true;
      }
    }
    // else：白名单外列 且 hasAnyCellText 已 true → 完全跳过该 cell（不 toString、不取值）。
    i = nextI;
  }
  return { values, hasAnyCellText };
}

// 🔴 单遍行解析（性能核心）：从 cellsStart 逐字节扫描，**同时**解析每个 <c> cell 取值 + 检测 </row> 行尾，
//   一遍走完整行（每字节只看一次）。返回 { values, hasAnyCellText, endPos }：
//     - endPos = </row> 之后的位置（已收行）；
//     - endPos = -1 表示在 limit 内未遇 </row>（行跨界，调用方需累积更多字节后重试，绝不发射半行）。
//   与 rowBytesToValues 语义一致（后者用于已知行边界的单测驱动；本函数额外内联行尾检测，消除二次扫描）。
//   isHeaderRow=true（表头）→ 全列解析；whitelist 仅数据行生效。
function parseRowInline(buf, cellsStart, limit, expectedLen, sharedStrings, whitelist, isHeaderRow) {
  const effWhitelist = isHeaderRow ? null : whitelist;
  const values = isHeaderRow ? [] : new Array(expectedLen).fill('');
  let hasAnyCellText = false;

  let i = cellsStart;
  while (i < limit) {
    if (buf[i] !== LT) { i++; continue; }
    const b1 = buf[i + 1];
    // </row> 行尾检测（与 cell 检测同在 '<' 分支，单遍）。
    if (b1 === SLASH) {
      // 可能是 </c>（理论已被 cell 内部消费）/ </row>。比对 </row>。
      if (buf[i + 2] === 0x72 && buf[i + 3] === 0x6f && buf[i + 4] === 0x77 && buf[i + 5] === GT) {
        return { values, hasAnyCellText, endPos: i + 6 };
      }
      i++;
      continue;
    }
    // <c\b（c 后非单词字符）
    if (b1 !== 0x63 /* 'c' */) { i++; continue; }
    const after = buf[i + 2];
    if (after !== undefined && isWordByte(after)) { i += 2; continue; }   // <col / <cols 等同前缀，跳过
    // 解析 <c attrs 到 '>'（紧循环只比一个字节，V8 JIT 友好）。列号/type 在确定后单独提取。
    const tagStart = i;
    let p = i + 2;
    while (p < limit && buf[p] !== GT) p++;
    if (p >= limit) return { values, hasAnyCellText, endPos: -1 };   // 标签跨界 → 需更多字节
    const tagEnd = p;
    const selfClose = buf[tagEnd - 1] === SLASH;
    // 仅取列号（决定白名单/越界）；type 推迟到确实需要取 body 时再解析（省 44/48 非取值 cell 的 type 扫描 + latin1Slice）。
    const colIdx = parseCellColumn(buf, tagStart, tagEnd);

    if (selfClose) {
      if (colIdx >= 0 && (isHeaderRow || colIdx < expectedLen)) {
        if (isHeaderRow) ensureIndex(values, colIdx);
        values[colIdx] = '';
      }
      i = tagEnd + 1;
      continue;
    }

    // 带 body：找 </c>（紧 JS 循环逐字节，V8 JIT 后比反复 native indexOf 调用更快——body 短、内含多个 '<'）。
    const bodyStart = tagEnd + 1;
    let q = bodyStart;
    let foundClose = false;
    while (q < limit) {
      if (buf[q] === LT && buf[q + 1] === SLASH && buf[q + 2] === 0x63 /* c */ && buf[q + 3] === GT) { foundClose = true; break; }
      q++;
    }
    if (!foundClose) return { values, hasAnyCellText, endPos: -1 };   // </c> 跨界 → 需更多字节
    const bodyEnd = q;
    const nextI = q + 4;

    if (colIdx < 0) { i = nextI; continue; }
    if (!isHeaderRow && colIdx >= expectedLen) { i = nextI; continue; }

    const inWhitelist = effWhitelist === null || effWhitelist.has(colIdx);
    if (inWhitelist || !hasAnyCellText) {
      // 到这里才解析 type + toString body（仅取值/探测的 cell 付此开销）。
      const type = parseCellType(buf, tagStart, tagEnd);
      const bodyStr = bodyEnd > bodyStart ? buf.toString('utf8', bodyStart, bodyEnd) : '';
      if (inWhitelist) {
        const v = cellValueFromBody(bodyStr, type, sharedStrings);
        if (isHeaderRow) ensureIndex(values, colIdx);
        values[colIdx] = v;
        if (!hasAnyCellText && v !== '') hasAnyCellText = true;
      } else {
        if (!hasAnyCellText && cellHasText(bodyStr, type, sharedStrings)) hasAnyCellText = true;
      }
    }
    i = nextI;
  }
  // 扫到 limit 仍无 </row> → 行跨界（需更多字节）。
  return { values, hasAnyCellText, endPos: -1 };
}

// 表头行动态数组扩容：保证 idx 处可写（中间空洞填 ''，对齐 sax sparse array 写入后 .map 产 '' 的语义）。
function ensureIndex(arr, idx) {
  for (let i = arr.length; i <= idx; i++) arr[i] = '';
}

// 判断字节是否「单词字符」[A-Za-z0-9_]（用于 <c\b 边界判定）。
function isWordByte(b) {
  return (b >= 0x30 && b <= 0x39)   // 0-9
    || (b >= 0x41 && b <= 0x5a)     // A-Z
    || (b >= 0x61 && b <= 0x7a)     // a-z
    || b === 0x5f;                  // _
}

// 从 <c attrs 字节区间 [tagStart, tagEnd)（'<c'..'>' 前）提取列号（r 属性列字母段）。
//   对齐 reader-handrolled：r="([A-Z]+)\d+"（r 前须空白/单词边界，值为「大写字母+数字」）。无/不符 → -1。
function parseCellColumn(buf, tagStart, tagEnd) {
  // 快速路径：生产/真实 Excel 几乎恒以 r 为首属性（'<c r="A1" ...'）→ tagStart 后是「空白 r = "」。
  //   直接从此读列字母，省 while 扫描（热路径 48 cell/行 × 50w 行）。不符快速形态则回落通用扫描。
  let p;
  if (isSpaceByte(buf[tagStart + 2]) && buf[tagStart + 3] === 0x72 /* r */
    && buf[tagStart + 4] === 0x3d /* = */ && buf[tagStart + 5] === QUOTE) {
    p = tagStart + 3;
  } else {
    // 通用：在 attrs 内找 ' r="'（r 前空白，排除别的属性内 'r'）。
    p = tagStart + 2;
    while (p < tagEnd) {
      if (buf[p] === 0x72 && buf[p + 1] === 0x3d && buf[p + 2] === QUOTE && isSpaceByte(buf[p - 1])) break;
      p++;
    }
    if (p >= tagEnd) return -1;
  }
  // p 指向 'r'；列字母从 p+3 起。
  let q = p + 3;
  const letterStart = q;
  while (q < tagEnd && buf[q] >= 0x41 && buf[q] <= 0x5a) q++;   // 大写字母
  if (q === letterStart) return -1;                            // 无列字母
  if (!(q < tagEnd && buf[q] >= 0x30 && buf[q] <= 0x39)) return -1;   // 字母后须数字
  let n = 0;
  for (let k = letterStart; k < q; k++) n = n * 26 + (buf[k] - 64);
  return n - 1;
}

// 从 <c attrs 区间提取 t 属性值（cell type）；无 → ''。对齐 CELL_T_RE = /\st="([^"]+)"/（t 前空白，值非空）。
function parseCellType(buf, tagStart, tagEnd) {
  let p = tagStart + 2;
  while (p < tagEnd) {
    if (buf[p] === 0x74 /* t */ && buf[p + 1] === 0x3d /* = */ && buf[p + 2] === QUOTE && isSpaceByte(buf[p - 1])) {
      const vStart = p + 3;
      let q = vStart;
      while (q < tagEnd && buf[q] !== QUOTE) q++;
      if (q >= tagEnd || q === vStart) return '';   // 无闭合引号 / t="" → 视作无 type
      return buf.toString('latin1', vStart, q);     // type 恒 ASCII（n/s/b/d/e/inlineStr/str）
    }
    p++;
  }
  return '';
}

// 从 <row attrs 区间 [tagStart, tagEnd)（'<row'..'>' 前）提取行号 r="N"；缺 → 0（对齐 sax parseInt(r)||0）。
//   行号直接由数字字节累加成整数（省 toString + parseInt 的每行分配）。r 通常是首属性 → 快速路径。
function parseRowR(buf, tagStart, tagEnd) {
  let p;
  if (isSpaceByte(buf[tagStart + 4]) && buf[tagStart + 5] === 0x72 /* r */
    && buf[tagStart + 6] === 0x3d /* = */ && buf[tagStart + 7] === QUOTE) {
    p = tagStart + 5;
  } else {
    p = tagStart + 4;   // 跳过 '<row'
    while (p < tagEnd) {
      if (buf[p] === 0x72 && buf[p + 1] === 0x3d && buf[p + 2] === QUOTE && isSpaceByte(buf[p - 1])) break;
      p++;
    }
    if (p >= tagEnd) return 0;
  }
  let q = p + 3;
  let n = 0;
  let any = false;
  while (q < tagEnd) {
    const d = buf[q];
    if (d < 0x30 || d > 0x39) break;
    n = n * 10 + (d - 0x30);
    any = true;
    q++;
  }
  return any ? n : 0;
}

// 空白字节：空格(32)/tab(9)/CR(13)/LF(10)/FF(12)。
function isSpaceByte(b) {
  return b === 32 || b === 9 || b === 10 || b === 13 || b === 12;
}

// ──────────────────────── 单遍流式状态机（跨 chunk）────────────────────────

// 状态机阶段
const ST_SEEK_SHEETDATA = 0;   // 寻找 <sheetData>（或 <sheetData/>）
const ST_SEEK_ROW = 1;         // sheetData 内，寻找 <row 起始（或 </sheetData> 结束）；行解析单遍内联完成

// 锚点 Buffer（仅 sheetData 检测在残段拼接时用 includes 判断，非热路径）
const BUF_SHEETDATA_OPEN = Buffer.from('<sheetData>');
const BUF_SHEETDATA_SELFCLOSE = Buffer.from('<sheetData/>');

// 流式扫 sheet 的 readStream（Buffer chunks）：单遍字节状态机识别行边界 + 行内解析 → onRow。
//
//   🔴 跨 chunk 策略：状态机维护「当前行的字节累积」carryRow（仅当一行跨 chunk 时短暂存在，半行级 ~KB）
//     与「半个标签」的字节累积。每 chunk 在原 buffer 上逐字节推进，整行落在单 chunk 内时零拷贝；
//     仅跨界行把两侧字节拼成单行 buffer 再解析（拷贝量 = 该行字节，KB 级）。绝不整 chunk concat。
//
//   接口（与 reader-handrolled streamSheetRowsHandRolled 对齐）：
//     - 入参 { stream, expectedHeaders, sharedStrings, onRow, valueColumnWhitelist=null }。
//     - onRow({ rowR, values, hasAnyCellText })：rowR 取 <row r> 真实行号；表头行（rowR===1）恒全列解析。
//     - onRow 抛 { __stopParsing:true, __stopValue } → 停止 stream + resolve(__stopValue)（peek 早退）。
//     - onRow 抛其它 → reject。
//     - 自闭合 <row .../> 空行：保号 + values 全空 + hasAnyCellText=false（onRow 内 allEmpty 跳过）。
function scanSheetRows({ stream, expectedHeaders, sharedStrings, onRow, valueColumnWhitelist = null }) {
  const expectedLen = expectedHeaders.length;
  const whitelist = valueColumnWhitelist || null;

  return new Promise((resolve, reject) => {
    let state = ST_SEEK_SHEETDATA;
    let stopped = false;
    // 跨 chunk 残段：当 chunk 末尾停在「行中」或「半个标签」时，把未消费字节保存到下个 chunk 拼接。
    //   tail 仅含「当前未闭合行的全部字节」或「seek 阶段的少量前缀」，半行级。
    let tail = Buffer.alloc(0);

    function stop(val) {
      if (stopped) return;
      stopped = true;
      try { stream.unpipe && stream.unpipe(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
      resolve(val);
    }
    function failWith(e) {
      if (stopped) return;
      stopped = true;
      try { stream.destroy(); } catch (_) {}
      reject(e);
    }

    // 发射已解析的一行（values/hasAnyCellText 由 parseRowInline 单遍产出）。返回 false 表示已 stop/fail。
    function emitParsed(theRowR, parsed) {
      try {
        onRow({ rowR: theRowR, values: parsed.values, hasAnyCellText: parsed.hasAnyCellText });
        return true;
      } catch (rowErr) {
        if (rowErr && rowErr.__stopParsing) { stop(rowErr.__stopValue); return false; }
        failWith(rowErr);
        return false;
      }
    }

    // 发射自闭合空行。
    function emitSelfCloseRow(theRowR) {
      const isHeader = theRowR === 1;
      const values = isHeader ? [] : new Array(expectedLen).fill('');
      try {
        onRow({ rowR: theRowR, values, hasAnyCellText: false });
        return true;
      } catch (rowErr) {
        if (rowErr && rowErr.__stopParsing) { stop(rowErr.__stopValue); return false; }
        failWith(rowErr);
        return false;
      }
    }

    // 处理一段连续字节 buf（已含上次 tail + 新 chunk 的拼接，或纯新 chunk）。
    //   isFinal=true：流尾，未闭合的半行/半标签丢弃（与 reader-handrolled endFlush 一致）。
    //   返回「未消费字节起点」（保存到 tail）；-1 表示已 stop。
    function process(buf, isFinal) {
      const len = buf.length;
      let i = 0;
      while (!stopped && i < len) {
        if (state === ST_SEEK_SHEETDATA) {
          // 逐字节找 '<sheetData'，遇 '>' 进 SEEK_ROW；遇 '/>' （<sheetData/>）空 sheet 直接收尾。
          //   用「找 '<' 后比对」方式（sheetData 只出现一次，非热路径）。
          const lt = indexOfByte(buf, LT, i);
          if (lt < 0) { return isFinal ? len : keepTailFrom(len); }
          // 需要至少 12 字节判断 <sheetData> / <sheetData/>
          if (lt + BUF_SHEETDATA_SELFCLOSE.length > len) {
            if (isFinal) return len;
            return lt;   // 标签跨界 → 从 '<' 保留
          }
          if (matchAt(buf, lt, BUF_SHEETDATA_SELFCLOSE)) {
            // 空 sheet（自闭合）→ 无数据行，收尾。
            return len;
          }
          if (matchAt(buf, lt, BUF_SHEETDATA_OPEN)) {
            state = ST_SEEK_ROW;
            i = lt + BUF_SHEETDATA_OPEN.length;
            continue;
          }
          // 不是 sheetData（如 <dimension>/<sheetPr> 等头部元素）→ 跳过这个 '<' 继续找。
          i = lt + 1;
          continue;
        }

        if (state === ST_SEEK_ROW) {
          // 找 '<'：可能是 <row（数据行）或 </sheetData>（结束）或其它（<cols> 等，跳过）。
          //   紧 JS 循环找 '<'（行间通常 0 字节即紧跟 <row → 立即命中，省 native indexOf 每行调用开销）。
          let lt = i;
          while (lt < len && buf[lt] !== LT) lt++;
          if (lt >= len) { return isFinal ? len : keepTailFrom(len); }
          // 需要判断 <row（4）/ </sheetData>（12）/ </row>... 至少看 5 字节
          if (lt + 5 > len) { return isFinal ? len : lt; }
          // </sheetData> → 结束（后续无数据行）
          if (buf[lt + 1] === SLASH) {
            // 可能是 </sheetData> 或 </row>（理论不在此状态）；统一视作 sheetData 区结束/无关闭合标签 → 跳过该 '<'
            //   只有 </sheetData> 才真正结束；但即便误判，后续也找不到 <row 了。安全起见跳过该 '<' 继续。
            i = lt + 1;
            continue;
          }
          // <row\b（row 后跟空白或 '>'）
          if (buf[lt + 1] === 0x72 && buf[lt + 2] === 0x6f && buf[lt + 3] === 0x77) {
            const after = buf[lt + 4];
            if (after === 0x20 || after === GT || after === SLASH || after === 9 || after === 10 || after === 13 || after === 12) {
              // 进入行：需要先读到 <row ...> 的 '>' 才知道 rowR 与是否自闭合。
              // 找该行起始标签的 '>'
              let p = lt + 4;
              while (p < len && buf[p] !== GT) p++;
              if (p >= len) {
                // 起始标签跨界 → 从 lt 保留（下个 chunk 拼接）。
                return isFinal ? len : lt;
              }
              const tagEnd = p;
              const theRowR = parseRowR(buf, lt, tagEnd);
              if (buf[tagEnd - 1] === SLASH) {
                // 自闭合 <row .../> 空行
                if (!emitSelfCloseRow(theRowR)) return -1;
                i = tagEnd + 1;
                continue;
              }
              // 带 body 行：单遍解析（cell 取值 + </row> 检测同一遍）。
              const isHeader = theRowR === 1;
              const parsed = parseRowInline(buf, tagEnd + 1, len, expectedLen, sharedStrings, whitelist, isHeader);
              if (parsed.endPos < 0) {
                // </row> 跨界 → 从 lt 保留整段到 tail，下个 chunk 拼接后重解析（最多 1 行/chunk）。
                if (isFinal) return len;   // 流尾仍未闭合 → 丢弃半行（与 sax </row> 缺失等价）。
                return lt;
              }
              if (!emitParsed(theRowR, parsed)) return -1;
              i = parsed.endPos;   // </row> 之后
              continue;
            }
          }
          // 其它标签（<cols>/<sheetFormatPr> 等）→ 跳过该 '<'
          i = lt + 1;
          continue;
        }
      }
      return stopped ? -1 : len;

      // keepTailFrom：seek 阶段无 '<' 命中时，保留尾部少量前缀（防多字节锚点 <sheetData 跨界）。
      function keepTailFrom(end) {
        return end - 16 > i ? end - 16 : i;
      }
    }

    stream.on('data', (chunk) => {
      if (stopped) return;
      try {
        let buf;
        if (tail.length === 0) {
          buf = chunk;
        } else {
          // 有残段：拼接 tail + chunk。tail 是半行/半标签（KB 级），拷贝量小。
          buf = Buffer.concat([tail, chunk]);
        }
        tail = Buffer.alloc(0);
        const consumed = process(buf, false);
        if (consumed < 0) return;   // stopped
        // 未消费部分保存到 tail（独立物化，避免持有大 chunk 引用）。
        if (consumed < buf.length) {
          tail = Buffer.from(buf.subarray(consumed));   // 拷贝半行级
        }
      } catch (e) {
        failWith(e);
      }
    });
    stream.on('end', () => {
      if (stopped) return;
      try {
        if (tail.length > 0) {
          process(tail, true);
        }
        if (!stopped) resolve();
      } catch (e) {
        failWith(e);
      }
    });
    stream.on('error', (e) => failWith(e));
  });
}

// 找单字节 b 在 buf[from..] 的位置（单字节 indexOf 走 native memchr，极快；非多字节 pattern）。
function indexOfByte(buf, b, from) {
  return buf.indexOf(b, from);
}

// buf[at..] 是否匹配 needle（needle 全 ASCII，短，逐字节比对）。
function matchAt(buf, at, needle) {
  if (at + needle.length > buf.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if (buf[at + k] !== needle[k]) return false;
  }
  return true;
}

module.exports = {
  scanSheetRows,
  // 以下 helper 导出供单测 / 四方 harness 直接驱动单行解析对比
  rowBytesToValues,
  cellValueFromBody,
  cellHasText,
  xmlUnescape,
  columnLetterToIndex,
  indexToColumnLetters
};
