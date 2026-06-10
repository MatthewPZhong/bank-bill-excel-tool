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
//
// ── v3.0.3 PR-P1（acquiring-import-recon-perf · O-5 四次修订：独立先做，不经引擎）─────────
//   收单 flow 入库实际只消费 4/48 列（对账主Id 6 / 通道清算金额 28 / 通道清算币种 29 由
//   insertFlowRow 取，账单日期 0 由 extractMonthKey 取；raw_json 已 PR-A 永久停写），其余 44 列
//   解码后即丢弃。500w 行 ×44 无用列 = ~2.2 亿次 TV_RE 正则 + xmlUnescape + SST 查表纯浪费。
//   本 PR 引入「取值列白名单」valueColumnWhitelist：白名单外列只扫边界、不调 cellValueFromBody
//   （values 该位置保持 ''），省掉无用解码。解析段 ≥1.5x（AC-A7）。
//   引擎（big-table-import-engine 块 D）将平移此机制（§8.0 契约「取值列白名单」），harness 复用。
//
//   🔴 allEmpty 等价（核心难点）：onRow 现状用 values.every(v=>v==='') 判空行跳过；裁剪后白名单外
//     列恒 '' 会把「仅白名单外列有值」的行误判空行 → 行为漂移。等价方案：parseAcquiringRowXml 扫 cell
//     时顺带产出 hasAnyCellText（任一 cell「取值非空」即 true，由 cellHasText 探测——它与 cellValueFromBody
//     的判空语义严格一致：s 类型查表判空、其它类型看文本节点），随 values 一起返回 { values, hasAnyCellText }；
//     onRow 的 allEmpty 改为 !hasAnyCellText。因 cellHasText(body,type,ss) ≡ (cellValueFromBody(...)!==''),
//     故「!hasAnyCellText」与全列解码下的「values.every(==='')」在所有 cell 形态下严格等价。
//   ⚠️ 关键坑（contract #3 暴露，已解决）：ExcelJS 及真实 Excel 把空字符串 cell 存成 <c t="s"><v>K</v></c>，
//     K 指向 SST 内的空串 —— body "K" 文本非空但取值是 ''。故 cellHasText 对 s 类型**必须查表**（不能只看
//     <v> body 文本），否则全空行被误判非空。s 索引无效（NaN/越界）同样判空 → 连「畸形 SST」都不再是差异。
//   ⚠️ 性能：cellHasText 已 true 即短路；生产数据全 inlineStr（非 s）且每行账单日期=A 列首 cell 必非空 →
//     首 cell 即置 true、后续 47 列探测全短路，裁剪收益不受影响。s 类型查表分支仅 ExcelJS 等 sharedStrings
//     fixture 触发（生产 0 触发），为正确性保留。
//
// ── v3.0.3 PR-P1b（白名单从「逐 cell 扫描 + 跳过解码」升级为「目标列直接定位」）──────────────
//   PR-P1 实测仅 1.07~1.10x（tmp/bench-p1-whitelist.js · 50w）：取值解码只占 ~7%，大头是 CELL_OPEN_RE
//   逐 cell 边界扫描（48 个 cell 每个正则捕获 body + cellHasText 探测），白名单跳过解码裁不掉边界扫描。
//   PR-P1b：白名单模式不再逐 cell 扫，改 indexOf 直接定位 4 个目标列（A/G/AC/AD），跳过 44 个无关 cell。
//   parseAcquiringRowXml 在「whitelist 非空 && 非表头行」时改走 parseRowByDirectLookup；表头行 / 全列
//   (whitelist=null) / bill(null) 路径仍走旧循环（byte-for-byte 零变化）。目标 bench ≥1.5x（理论 3-5x）。
//   🔴 等价性（资金红线）：直接定位与旧循环（≡ sax）必须 byte-for-byte 等价，由既有三方 contract harness
//     + 本 PR 新增 #14a-e 用例锁定：① 同列重复取最后 ② 目标 cell 自闭合 ③ 目标 cell 带 <f> 公式
//     ④ 行号前缀防误命中（含右引号锁定 r="AC1" 不命中 r="AC12"）⑤ 4 目标列全空 → 退化路径走旧循环补算
//     hasAnyCellText（不丢空行判定）。关键设计点见 parseRowByDirectLookup 函数注释。

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

// v3.0.3 PR-P1：flow 取值列白名单 = FLOW_KEY_COLUMN_INDICES 全集（账单日期 0 / 对账主Id 6 /
//   通道清算金额 28 / 通道清算币种 29）。这 4 列即 flow 入库实际消费列（insertFlowRow 取 6/28/29，
//   账单日期 0 由 onRow 内 extractMonthKey 取；raw_json 已 PR-A 停写）。从常量派生 → 单一出处，
//   FLOW_KEY_COLUMN_INDICES 调整时自动跟随。bill 不裁剪（传 null，本 PR 零行为变化，单变量原则）。
const FLOW_VALUE_COLUMN_WHITELIST = Object.freeze(new Set(Object.values(FLOW_KEY_COLUMN_INDICES)));

// ----------------- 专用单行解析器（🔴🔴 数字 cell 取原文本，逐字对齐 sax）-----------------

// 匹配单个 <c ...>...</c> 或自闭合 <c .../>；attrs 任意顺序后再独立提取 r/t
//   （对齐 streaming-xlsx-reader 的属性顺序无关修复：合法 cell 如 <c s="2" r="N2"> s 在 r 前）。
const CELL_OPEN_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
const CELL_R_RE = /\br="([A-Z]+)\d+"/;        // 从 attrs 提取列字母（r 可在任意位置）
const CELL_T_RE = /\st="([^"]+)"/;            // 从 attrs 提取 cell type
const ROW_R_RE = /<row\b[^>]*?\br="(\d+)"/;   // v3.0.3 PR-P1b：从 rowXml 提 <row r="N"> 行号（直接定位拼 ref 用）
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

// v3.0.3 PR-P1：探测单个 cell「取值是否非空」（供 allEmpty 等价判定，不依赖白名单是否解码该列）。
//   🔴 定义级与 cellValueFromBody 判空对齐 —— 直接复用其取值逻辑判空，杜绝任何分支漂移。
//   为何不能简化为「看 body 是否有非空文本节点」：cellValueFromBody 取值有「最后采集标签」「s 查表」语义，
//   存在「文本节点非空但取值空」的形态，若探测更宽会把空行误判非空 → 行级 allEmpty 漂移。具体：
//     ① s 类型：取 <v> 索引查表。ExcelJS/真实 Excel 把空串 cell 存成 <c t="s"><v>K</v></c>，K 指向 SST 空串
//        —— body "K" 非空但取值 ''（contract #3/#11 实证）；索引无效(NaN/越界)取值也 ''。
//     ② inlineStr/str：取「最后一个采集标签」。<is><t>P</t><t></t></is> 末尾空 run → 取值 ''（取最后），
//        但前面 <t>P</t> 文本非空。
//   故统一委托 cellValueFromBody 取值后判 !== ''，对所有 cell 形态严格成立：
//     cellHasText(body,type,ss) ≡ (cellValueFromBody(body,type,ss) !== '')。
//   行级 hasAnyCellText（任一 cell cellHasText）⟺ values.every(取值==='') 取反 —— 全列/白名单路径恒等价。
//   性能：行级 !hasAnyCellText 短路（首个非空 cell 即停整行探测），生产每行账单日期=A 列首 cell 必非空 →
//     每行实际只多 1 次取值；空行逐 cell 但取值对空 cell 极廉（lastCollectedText 即返回 null/空）。
function cellHasText(body, type, sharedStrings) {
  return cellValueFromBody(body, type, sharedStrings) !== '';
}

// ─────────── v3.0.3 PR-P1b：白名单「目标列直接定位」（跳过逐 cell 边界扫描）───────────
// 背景（bench 实测，tmp/bench-p1-whitelist.js · 50w fixture）：PR-P1 白名单仅省取值解码（~7%，1.07~1.10x），
//   大头是 CELL_OPEN_RE 逐 cell 边界扫描——48 个 cell 每个都要正则捕获 body + cellHasText 探测，裁不掉。
//   PR-P1b：白名单模式不再逐 cell 扫，改 indexOf 直接定位 4 个目标列（A/G/AC/AD），跳过 44 个无关 cell。
//   理论 3-5x；表头行 / 全列(whitelist=null) / bill(null) 路径零变化（仍走旧循环 parseAcquiringRowXml）。
// 🔴 资金红线：直接定位与旧循环（≡ sax）必须 byte-for-byte 等价（contract harness 三方对比锁，含本 PR 新增
//   #14a-e 用例：同列重复取最后 / 自闭合 / <f> 公式 / 行号前缀防误命中 / 4 目标列全空退化路径）。

// 0-based 列号 → 列字母（columnLetterToIndex 的反函数；0→A、6→G、28→AC、29→AD）。26 进制直推。
//   ⚠️ 与 reader.js columnLetterToIndex 严格互逆（A=0..Z=25, AA=26..）；白名单冻结时一次性预计算，热路径不调。
function indexToColumnLetters(idx) {
  let n = idx;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// 为白名单冻结一次性产出「目标列定位元数据」（模块级缓存，按 Set 实例 + expectedLen 记忆）。
//   每个目标列 → { colIdx, refStr }，refStr = `r="<列字母>`（不含右引号——行号在调用处拼，见 parseRowByDirectLookup）。
//   仅保留 colIdx < expectedLen 的目标列（越界防御；flow 白名单 {0,6,28,29} 恒 < 48，防御性保留）。
const directLookupMetaCache = new WeakMap();
function getDirectLookupMeta(whitelist, expectedLen) {
  let byLen = directLookupMetaCache.get(whitelist);
  if (!byLen) { byLen = new Map(); directLookupMetaCache.set(whitelist, byLen); }
  let meta = byLen.get(expectedLen);
  if (!meta) {
    meta = [];
    // 升序遍历白名单列号（写入 values 顺序无关——直接定位各列独立，下方逐列取最后命中已对齐覆盖语义）。
    const cols = [...whitelist].filter((c) => c >= 0 && c < expectedLen).sort((a, b) => a - b);
    for (const colIdx of cols) {
      meta.push({ colIdx, letters: indexToColumnLetters(colIdx) });
    }
    byLen.set(expectedLen, meta);
  }
  return meta;
}

// 校验「ref 串命中位置 hitIdx」确属一个 <c 开标签的 attrs（伪命中防御，畸形 XML 兜底）。
//   从 hitIdx 向前找最近的 '<'：要求紧随其后是 '<c ' 或 '<c\t'/'<c\n'/...（c 后跟空白，attrs 起始），
//   且 '<' 与 hitIdx 之间无 '>'（确保 ref 在同一开标签 attrs 内，未跨进 body/别的标签）。
//   注：cell 文本里的引号会被实体编码为 &quot;，正常数据不伪命中；此防御仅为畸形 XML，差异由 harness 记录。
function refHitInCellOpenTag(rowXml, hitIdx) {
  const lt = rowXml.lastIndexOf('<', hitIdx);
  if (lt < 0) return false;
  // '<' 与 hitIdx 之间不得有 '>'（否则 ref 已在标签之外）
  if (rowXml.indexOf('>', lt) < hitIdx) return false;
  // 紧随 '<' 必须是 'c' 且其后是空白（<c 开标签；'<c>' 不可能含 r 属性，无需考虑）
  if (rowXml.charCodeAt(lt + 1) !== 99 /* 'c' */) return false;
  const ch = rowXml.charCodeAt(lt + 2);
  // 空白：空格(32)/tab(9)/CR(13)/LF(10)/FF(12)
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12;
}

// 从「<c 开标签起始位置 ltIdx」提取该 cell 的 { type, body }，对齐旧循环 CELL_OPEN_RE 切分语义。
//   attrs 段 = ltIdx..首个 '>'；自闭合（'>' 前一字符是 '/'）→ body=''；否则 body = '>' 后 .. 对应 '</c>'。
//   type 用既有 CELL_T_RE 从 attrs 取（任意属性顺序）。返回 null 表示标签结构异常（无 '>'，畸形）。
function extractCellAt(rowXml, ltIdx) {
  const tagEnd = rowXml.indexOf('>', ltIdx);
  if (tagEnd < 0) return null;
  const attrs = rowXml.slice(ltIdx, tagEnd + 1);
  const tm = attrs.match(CELL_T_RE);
  const type = tm ? tm[1] : '';
  if (rowXml.charCodeAt(tagEnd - 1) === 47 /* '/' 自闭合 */) {
    return { type, body: '' };
  }
  const close = rowXml.indexOf('</c>', tagEnd + 1);
  const body = close < 0 ? rowXml.slice(tagEnd + 1) : rowXml.slice(tagEnd + 1, close);
  return { type, body };
}

// v3.0.3 PR-P1b：白名单数据行「目标列直接定位」解析（旁路逐 cell 扫描）。
//   仅在 whitelist 非空 && 非表头行 时由 parseAcquiringRowXml 调用；其它路径走旧循环（零变化）。
//   返回 { values, hasAnyCellText }，与旧循环（白名单模式）byte-for-byte 等价：
//     1. 每个目标列：完整 ref 串 = `r="<列字母><rowR>"`（🔴 必须含右引号——防 r="AC1234" 前缀误命中
//        r="AC12345"）；indexOf 找所有命中、取「最后一个通过伪命中防御的命中」（对齐旧循环「同列重复后者覆盖」）。
//     2. 取值用既有 cellValueFromBody（白名单内列必取值，与旧循环白名单分支一致）。
//     3. hasAnyCellText：先探目标列（任一非空即 true，生产 A 列必非空→第一列即定、其余短路）；
//        若全部目标列均无文本 → 退化：调旧循环 parseAcquiringRowXml（全列、whitelist=null）只取其 hasAnyCellText
//        （values 丢弃，仍用直接定位的 values——它们全 ''）。退化罕见（仅白名单列全空的行），等价性绝对优先。
//     4. 无 r 属性 cell / 越界列：直接定位天然不命中 → 与旧循环（colIdx=-1 或 >=expectedLen continue）一致。
function parseRowByDirectLookup(rowXml, rowR, expectedLen, sharedStrings, whitelist) {
  const values = new Array(expectedLen).fill('');
  const meta = getDirectLookupMeta(whitelist, expectedLen);
  let hasAnyCellText = false;
  const rowRStr = String(rowR);

  for (let mi = 0; mi < meta.length; mi++) {
    const { colIdx, letters } = meta[mi];
    const refStr = `r="${letters}${rowRStr}"`;   // 含右引号，精确锁定列字母+行号
    // 找所有命中、取最后一个通过伪命中防御的（对齐旧循环「同列出现两次后者覆盖」）。
    let chosenLt = -1;
    let from = rowXml.indexOf(refStr);
    while (from >= 0) {
      if (refHitInCellOpenTag(rowXml, from)) chosenLt = rowXml.lastIndexOf('<', from);
      from = rowXml.indexOf(refStr, from + 1);
    }
    if (chosenLt < 0) continue;   // 该目标列在本行不存在（缺列）→ values 保持 ''
    const cell = extractCellAt(rowXml, chosenLt);
    if (!cell) continue;          // 标签畸形（无 '>'）→ 视同缺列
    // 先探 hasAnyCellText（短路）：白名单内列取值非空即整行非空。
    if (!hasAnyCellText && cellHasText(cell.body, cell.type, sharedStrings)) hasAnyCellText = true;
    values[colIdx] = cellValueFromBody(cell.body, cell.type, sharedStrings);
  }

  // 退化路径：全部目标列均无文本 → 用旧循环（全列）补算 hasAnyCellText，等价于「白名单外列也可能有值」。
  //   生产数据 A 列(账单日期)必非空 → 上面循环第一列即 hasAnyCellText=true，此分支几乎不触发。
  //   ⚠️ 仅取旧循环的 hasAnyCellText，values 仍用直接定位结果（它们全 ''，与白名单语义一致）。
  if (!hasAnyCellText) {
    hasAnyCellText = parseAcquiringRowXml(rowXml, expectedLen, sharedStrings, false, null).hasAnyCellText;
  }
  return { values, hasAnyCellText };
}

// 解析单个 <row>...</row> 的 XML → { values: 列值数组, hasAnyCellText: 行内任一 cell 含非空文本节点 }。
//   isHeaderRow=true（rowR===1）：动态数组收集全部出现列（不截断），让 validator 检测「列多」。
//   否则：固定 new Array(expectedLen).fill('') 防越界 + 内存安全（镜像 reader.js lines 162-168/204-205）。
//   写入语义：按 cell 在 row 中出现顺序写 values[col]（同列出现两次则后者覆盖，与 sax 一致）。
//   v3.0.3 PR-P1：
//     - valueColumnWhitelist（Set<number> | null/undefined）：非空时仅对名单内列调 cellValueFromBody
//       取值，名单外列只扫边界（values 保持 ''）；null/全列时行为与现状逐字节相同。
//       ⚠️ 表头行（isHeaderRow）白名单恒不生效——表头必须全列解析（validator 检测「列多」契约）。
//     - hasAnyCellText：扫每个 cell 时无论是否在白名单内都用 cellHasText 探测（与 cellValueFromBody 判空
//       严格一致：s 类型查表判空，其它看文本节点；已 true 则短路），任一 cell 取值非空即整行 true。
//       供 onRow 的 allEmpty 等价判定（!hasAnyCellText），见文件头部「allEmpty 等价」段。
//   v3.0.3 PR-P1b：whitelist 非空 && 非表头行 → 改走 parseRowByDirectLookup（目标列直接定位，旁路逐 cell 扫描）；
//     表头行 / 全列(null) / bill(null) 路径仍走下方旧循环（零变化）。rowR（可选）= 直接定位拼 ref 的行号，
//     调用方传入避免重复解析；不传时从 rowXml 的 <row r="N"> 提取（既有单测不传 rowR 仍可用）。
function parseAcquiringRowXml(rowXml, expectedLen, sharedStrings, isHeaderRow, valueColumnWhitelist, rowR) {
  // 表头行白名单恒不生效（全列解析）；数据行用传入白名单（null/undefined = 全列）。
  const whitelist = isHeaderRow ? null : (valueColumnWhitelist || null);
  // v3.0.3 PR-P1b：白名单数据行走直接定位（旁路逐 cell 扫描）。rowR 缺省时从 rowXml 提取。
  if (whitelist) {
    let r = rowR;
    if (r === undefined || r === null) {
      const rm = rowXml.match(ROW_R_RE);
      r = rm ? parseInt(rm[1], 10) : 0;
    }
    return parseRowByDirectLookup(rowXml, r, expectedLen, sharedStrings, whitelist);
  }
  const values = isHeaderRow ? [] : new Array(expectedLen).fill('');
  let hasAnyCellText = false;
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
    // hasAnyCellText 探测对全部列生效（含白名单外列），保证 allEmpty 等价（仅白名单外列有值的行不被误判空）。
    //   ⚠️ 必须先于白名单 continue —— 白名单外列即使不取值，其取值是否非空也要计入 hasAnyCellText。
    //   性能：已 true 则短路（生产数据每行账单日期=A 列首 cell 必非空 → 后续 47 列探测全短路，零额外成本）；
    //     非 s 类型探测仅扫文本节点不解码，比 cellValueFromBody 便宜 → 裁剪收益保留。
    if (!hasAnyCellText && cellHasText(body, type, sharedStrings)) hasAnyCellText = true;
    // 白名单外列：跳过 cellValueFromBody（省 cellValueFromBody 的 xmlUnescape/查表全功取值），values 保持 ''。
    if (whitelist && !whitelist.has(colIdx)) continue;
    values[colIdx] = cellValueFromBody(body, type, sharedStrings);
  }
  return { values, hasAnyCellText };
}

// ----------------- 手写 sheet 扫描（替换 sax streamSheetRows）-----------------

// 流式扫 sheet entry：yauzl openReadStream → StringDecoder → 缓冲 pending → 找 <sheetData> 后
//   逐个切 <row ...>...</row> 块，解析出 { rowR, values, hasAnyCellText } 调 onRow。
//   接口与 reader.js streamSheetRows 一致（v3.0.3 PR-P1 起 onRow 多带 hasAnyCellText）：
//     - onRow({ rowR, values, hasAnyCellText })：rowR 取 <row r="N"> 真实行号；values 见
//       parseAcquiringRowXml；hasAnyCellText = 行内任一 cell 含非空文本节点（供 allEmpty 等价判定）。
//     - onRow 抛 { __stopParsing:true, __stopValue } → 停止 stream + resolve(__stopValue)（peek 早退）。
//     - onRow 抛其它 → reject。
//   v3.0.3 PR-P1：valueColumnWhitelist（Set<number> | null）透传给 parseAcquiringRowXml —— flow 路径注入
//     {0,6,28,29} 仅解码 4 列；bill / null 路径全列解码（零行为变化）。表头行白名单恒不生效。
//   自闭合 <row .../> 空行：保号（rowR 用真实行号）但 values 全空（fill('')）+ hasAnyCellText=false，
//     onRow 内 allEmpty 跳过，与 sax 一致（sax 对自闭合 row 不进 closetag 'row' 分支 → 不调 onRow；
//     本实现调 onRow 但 values 全空、hasAnyCellText=false → 跳过 → 等价结果。自闭合 row 非表头 r=1 合法形态）。
function streamSheetRowsHandRolled({
  zip, sheetEntry, expectedHeaders, sharedStrings, onRow, valueColumnWhitelist = null
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
          //   v3.0.3 PR-P1：自闭合 row 无 cell → hasAnyCellText 恒 false（allEmpty 跳过，等价 sax 不调 onRow）。
          if (rowTag.charAt(rowTag.length - 2) === '/') {
            pending = pending.slice(tagEnd + 1);
            const isHeader = rowR === 1;
            const values = isHeader ? [] : new Array(expectedLen).fill('');
            try {
              onRow({ rowR, values, hasAnyCellText: false });
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

          // v3.0.3 PR-P1：白名单透传；表头行（rowR===1）内部恒全列解析。返回 { values, hasAnyCellText }。
          //   v3.0.3 PR-P1b：传入真实 rowR（来自 <row r>），白名单数据行据此走目标列直接定位（旁路逐 cell 扫描）。
          const parsed = parseAcquiringRowXml(rowXml, expectedLen, sharedStrings, rowR === 1, valueColumnWhitelist, rowR);
          try {
            onRow({ rowR, values: parsed.values, hasAnyCellText: parsed.hasAnyCellText });
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

    // v3.0.3 PR-P1：flow 注入取值列白名单（仅解码 4/48 列）；bill 传 null（全列解码，零行为变化）。
    const valueColumnWhitelist = kind === 'flow' ? FLOW_VALUE_COLUMN_WHITELIST : null;

    const streamStopValue = await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders,
      sharedStrings,
      valueColumnWhitelist,
      onRow: ({ rowR, values, hasAnyCellText }) => {
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

        // v3.0.3 PR-P1：allEmpty 改用 hasAnyCellText（裁剪后白名单外列恒 '' 无法用 values.every 判空）。
        //   全列解码路径下 !hasAnyCellText ≡ values.every(==='')（论证见文件头部「allEmpty 等价」段 +
        //   bodyHasAnyText 注释）；白名单路径下「仅白名单外列有值」的行 hasAnyCellText=true 不被误判空。
        const allEmpty = !hasAnyCellText;
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

    // v3.0.3 PR-P1：peek 只读首条非空数据行解析月份，传白名单同样安全（仅取 billDate 列 0，在白名单内）
    //   且与 streamImportOneFile 一致——peek 与正式导入对「首行是否非空」的判定必须用同一 allEmpty 语义。
    const valueColumnWhitelist = kind === 'flow' ? FLOW_VALUE_COLUMN_WHITELIST : null;

    await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders,
      sharedStrings,
      valueColumnWhitelist,
      onRow: ({ rowR, values, hasAnyCellText }) => {
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

        // v3.0.3 PR-P1：与正式导入同口径——allEmpty 改用 hasAnyCellText（保证 peek 与导入跳过同一批空行）。
        const allEmpty = !hasAnyCellText;
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
  //   v3.0.3 PR-P1：parseAcquiringRowXml 返回形状已改为 { values, hasAnyCellText }（多带白名单参数）。
  parseAcquiringRowXml,
  cellValueFromBody,
  cellHasText,                       // v3.0.3 PR-P1：allEmpty 等价探测器（与 cellValueFromBody 判空一致；单测锁定语义）
  FLOW_VALUE_COLUMN_WHITELIST,       // v3.0.3 PR-P1：flow 取值列白名单（contract 三方对比 + 引擎迁移复用）
  // v3.0.3 PR-P1：内部 streamSheetRowsHandRolled 导出，供 contract test 注入白名单做「手写全列 vs 手写白名单」三方对比。
  streamSheetRowsHandRolled
};
