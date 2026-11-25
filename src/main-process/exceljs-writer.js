// v2.0.0-beta.3 PR #32a：exceljs 标黄输出 + error-report 写出
// v2.0.0-beta.4：error-report 加「可能原因」列（5 列），文案来自 file-service/error-causes.js
//
// 仅本模块（bank-statement-process）使用 exceljs；
// 其他 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）继续 SheetJS。
//
// 核心能力：
//   - writeBankStatementOutput：仅修改行 + 单元格黄底 + 表头
//   - writeErrorReport：5 列（时间戳 / 场景名 / 对账ID / 原因 / 可能原因）
//     v3.0.4 F3：第 3 列由内部 _rowId（row_N，多文件合并后全局重编号，对用户无意义）
//     改为银行行 ReconciliationId；取值三级回退 reconciliationId → reconId（R1 专用）→ rowId → ''
//
// 标黄约定：
//   cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { errorCodeToCause } = require('../backend/file-service/error-causes');
const { applyWatermark } = require('./workbook-watermark');
const { withBoundedWorkbook } = require('./bounded-xlsx-writer');
const { EXCEL_CELL_TEXT_MAX_UTF16_UNITS } = require('../backend/xlsx/excel-text');
// v3.1.7：Payment线下调拨核对 sheet 用——银行原表列序 + 调拨对账单派生字段列序。
const { BANK_STATEMENT_FIELDS } = require('../constants/bank-statement-fields');
const { FT_RECON_FIELD_MAP } = require('../constants/fund-transfer-recon-fields');
const { PAYMENT_OFFLINE_FIELD_MAP: POF } = require('../constants/payment-offline-allocation-fields');

const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// 内部字段（不写入 xlsx）
// v2.1.9 N5 T25：Sheet 3 撤除 — 改独立报表，详 scenario-hit-rows-writer.js
//   _hitChannelKey / _matchStatus / _matchedChannelId / _fallbackChannelId 也归此类（v2.1.9 dispatcher 注入）
//   v2.1.9 D16=b（2026-05-27 用户拍板）：新增 _hitChannelId（writer 用此查 channels.label 写「匹配渠道」列）
//
// 实现说明（v2.1.8 self-review SR4 + v2.1.9 N5 续）：
//   writer 实际不消费此 Set — 投影写盘走 `headers.map(h => row[h])`（buildSheetData / writeBankStatementOutput），
//   headers 来源是 reader 校验过的 44 列固定表头，`_` 前缀字段不会进 headers → 投影自动过滤。
//   本 Set 是声明式枚举，便于 grep 追溯哪些字段属"内部"；未来若 writer 改为遍历 row keys 写盘，
//   必须用此 Set 显式过滤（防 _ 前缀字段泄漏）。
const INTERNAL_FIELDS = new Set([
  '_rowId',
  '_modifiedColumns',
  '_hitScenarioId',
  '_hitScenarioDisplayIndex',
  '_hitScenarioName',
  // v2.1.9 N5（dispatcher 双维调度注入）
  '_hitChannelKey',
  '_matchStatus',
  '_matchedChannelId',
  '_fallbackChannelId',
  // v2.1.9 D16=b（2026-05-27 用户拍板）
  '_hitChannelId'
]);

function buildSheetData(rows, headers) {
  const dataRows = rows.map((row) => headers.map((h) => row[h]));
  return [headers, ...dataRows];
}

// v2.1.7 round 3 F8 (spec §9.8.4)：stripInternalFields helper
//   过滤 _ 前缀字段（如 _rowId / _hitScenarioId / _modifiedColumns），返回干净对象
//   未命中场景行 sheet 不应暴露内部诊断字段（用户期望"原始银行对账单行所有列"）
//   注：写 sheet 用 headers 投影，本 helper 主要给未来需要 JSON 输出场景用
function stripInternalFields(row) {
  const cleaned = {};
  for (const k of Object.keys(row)) {
    if (!k.startsWith('_')) cleaned[k] = row[k];
  }
  return cleaned;
}

// v2.1.16-beta.6 需求 B（PRD §三 / TECH §需求B 🔴 资金红线：对账主产物破坏性格式变更）：
//   预加工导出由旧「渠道对账单 + 未命中场景行」双 sheet 重构为「未命中场景 + 命中场景」双 sheet。
//
// rows（= modifiedRows）: Array<{ ...原列, _rowId, _modifiedColumns: Set<columnName>, _hitScenarioId, _hitScenarioDisplayIndex, _hitScenarioName }>
// headers: Array<string>（44 列原表头）
// savePath: 绝对路径（含 .xlsx）
// unmatchedRows: Array<{...原列}> | null（未命中行；null → 不输出 sheet1，仅命中 sheet）
// modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }> | null
//   命中明细列数据源（D9）。rowId === modifiedRows 行的 _rowId（已核实，见 PR 报告）：
//   engine-utils.js record(rowId,...) → rowId 来自 ensureRowId(row)=row._rowId；
//   bank-statement-io.js readBankStatement 注入 row._rowId='row_idx'。
//
// sheet1「未命中场景」：第 1 行 = A1 加粗提示(A列) + 表头(B列起)；第 2 行起 unmatchedRows（v3.0.8 #9 整体上移一行）
//   （FundType==='Mark without result' 数据值的行排前，其余随后 — D8）
// sheet2「命中场景」：第一列「命中明细」+ 第二列「异常说明」+ 原 headers；命中行保留标黄（D5）。
const MARK_WITHOUT_RESULT = 'Mark without result';
const SHEET1_UNMATCHED_NAME = '未命中场景';
const SHEET2_HIT_NAME = '命中场景';
const SHEET1_A1_NOTICE = '请检查，导入前请删除该sheet';
const HIT_DETAIL_HEADER = '命中明细';
const MANY_TO_MANY_NOTE_HEADER = '异常说明';

// 单元格值规整为字符串（用于 FundType 排序判等 + 命中明细拼接）
//   null/undefined → ''；其它原样 String()（数据值精确匹配，不 trim 不改大小写）
function cellToString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

// 命中明细单值包裹（v3.0.7 需求3 · 修复2）：
//   含【任意数字字符】（trim 后匹配 /\d/）→ 中文双引号“v”（显示 trim 后的值）——
//     纯数字（123）、数字英文混合（T54SWIC494447）、千分位都归此类；
//   完全不含数字（trim 后无 /\d/，含空串/纯英文/纯符号/中文）→ 半角尖括号<v>（显示原始 cellToString 结果，不 trim，空串→<>）。
//   例：T54SWIC494447→“T54SWIC494447”；123→“123”；Fundtransfer-out→<Fundtransfer-out>；空串→<>。
// v3.2.22：字段名、旧值、新值各自按已解码文本编码后再包裹拼接（见 encodeBankRowCellValue），各值读回与其所在列一致，
//   整格不再含控制字符，写盘前的整本编码不再改动它。包裹符与分隔符不含下划线和十六进制字符，拼接不会拼出新的
//   `_xHHHH_`。是否含数字按编码前的值判断（显示口径不变）。
function wrapHitValue(value, encode) {
  const s = cellToString(value);
  const t = s.trim();
  return /\d/.test(t) ? `“${encode(t)}”` : `<${encode(s)}>`;
}

// 把一行的 modifications（多条字段级变更）拼成命中明细文本（v3.0.7 需求B/C/D 格式）：
//   每条 `{字段名}:{wrap(旧值)}→{wrap(新值)}`——
//     · 字段名 = modification.column（原始英文列名，裸写不包裹）；
//     · 字段名与值之间用【半角冒号 :】；旧值与新值之间用【全角箭头 →】；
//     · wrapHitValue 规则不变（含数字→中文双引号“”、否则→尖括号<>）；
//     · D：值不省略，完整显示，不截断。
//   多条以 '; '（半角分号+空格，【无换行】）拼接 —— 单行紧凑布局，末条无尾分隔（join 天然保证）。
//   🔴 命中明细列单行布局，本函数产出绝不含 '\n'（撑高行/破坏单行的元凶）。
function buildHitDetail(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  return mods
    .map((m) => `${encodeDecodedExcelJsCellText(cellToString(m.column))}:` +
      `${wrapHitValue(m.oldValue, encodeDecodedExcelJsCellText)}→${wrapHitValue(m.newValue, encodeDecodedExcelJsCellText)}`)
    .join('; ');
}

// ===== v3.1.7：Payment线下调拨核对 3 sheet =====
//   pairs 项 = { bankRow, bankRowOriginal, reconRow, round, oldReconciliationId, dayDiff }（引擎产出，见
//   r5-payment-offline-allocation-backfill.js 返回值）；v3.2.22 编排器另附 modifiedColumnsBeforePayment（列名数组）。pairs 为 null/空数组 → 完全不加 sheet（主文件形态零变化）。
const PAYMENT_OFFLINE_SHEET = Object.freeze({
  match: '匹配对照',
  bankRaw: '银行行-原始',
  reconRaw: '调拨对账单行-原始'
});
// 匹配轮次内部值 → spec 轮次名。
const PAYMENT_OFFLINE_ROUND_LABEL = Object.freeze({
  main: 'R1',
  'date-tolerance': 'R2',
  'relaxed-week': 'R3'
});
// 付款账号与 Drawee CardNo 并排，便于人工逐条复核新增必选核对要素。
const PAYMENT_OFFLINE_MATCH_HEADERS = Object.freeze([
  '配对序号', '匹配轮次', 'BillDate', 'Credit Amount', 'Currency', 'MerchantId',
  'Drawee CardNo', '原ReconciliationId', '回填值(ReconID)', '调拨单号', '交易时间',
  '金额', '币种', '付款账号', '收款渠道', 'big_account', '银行周', '订单周', '周区间', '天数差'
]);

function auditDisplayWidth(value) {
  const text = cellToString(value);
  let width = 0;
  for (const char of text) width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1;
  return width;
}

function applyPaymentAuditSheetLayout(sheet, { maxWidth = 30 } = {}) {
  if (!sheet || sheet.rowCount < 1 || sheet.columnCount < 1) return;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount }
  };
  const header = sheet.getRow(1);
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  for (let columnIndex = 1; columnIndex <= sheet.columnCount; columnIndex += 1) {
    let width = 10;
    for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
      width = Math.max(width, auditDisplayWidth(sheet.getRow(rowIndex).getCell(columnIndex).value) + 2);
    }
    sheet.getColumn(columnIndex).width = Math.min(maxWidth, width);
  }
}

// 在 workbook 追加 3 核对 sheet（仅 pairs 非空数组时调用）。
//   bankHeaders：银行契约列序（BANK_STATEMENT_FIELDS）；reconHeaders：真实派生字段列序。
// v3.2.22（🔴 资金红线）：Payment 核对页的银行字段、调拨对账单字段与写入前快照（含 oldReconciliationId）都按已解码文本
//   编码（见 encodeBankRowCellValue），读回与主输出同一列一致。
function appendPaymentOfflineSheets(workbook, pairs) {
  const enc = encodeDecodedExcelJsCellText;
  const { weekTag, parseFtaDate } = require('./scenario-engines/engine-week-utils');
  // 生产链路中派生行来自链接表 raw_json：「交易时间」可能是字符串 Excel 序列号（如 '46179'）、
  //   「金额」可能是字符串数字（如 '7587133'）。引擎匹配走 toDate/parseNumber 不受影响，但「匹配对照」sheet
  //   若原样写入会显示无法阅读的 46179 → 仅本 shet 的 4 个值列规整展示形态（两张「-原始」sheet 保持忠实 dump）。
  const { toDate } = require('./scenario-engines/engine-date-utils');
  const { parseNumber } = require('./scenario-engines/engine-utils');
  const RECON = FT_RECON_FIELD_MAP.recon;
  // 日期列：toDate 解析后取【本地时区】年月日 'YYYY-MM-DD'（⚠️ 禁 toISOString——UTC 转换会差一天）；失败回退原值。
  const fmtDate = (value) => {
    const d = toDate(value);
    if (!d) return value;
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  // 金额列：parseNumber 解析为数字写入；失败（null）回退原值。
  const fmtNumber = (value) => {
    const n = parseNumber(value);
    return n === null ? value : n;
  };
  // ① 匹配对照
  const sm = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.match);
  sm.addRow([...PAYMENT_OFFLINE_MATCH_HEADERS]);
  sm.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const b = p.bankRow || {};
    const r = p.reconRow || {};
    const billDate = b[POF.bank.billDate];
    const txTime = r[POF.recon.txTime];
    const interval = p.intervalStart && p.intervalEndExclusive
      ? `[${fmtDate(p.intervalStart)}, ${fmtDate(p.intervalEndExclusive)})`
      : '';
    sm.addRow([
      idx + 1,
      PAYMENT_OFFLINE_ROUND_LABEL[p.round] || cellToString(p.round),
      // BillDate / 交易时间：规整为 'YYYY-MM-DD'（序列号/多格式字符串 → 可读日期）
      fmtDate(billDate),
      // Credit Amount / 派生金额：规整为数字（字符串数字 → number）
      fmtNumber(b[POF.bank.creditAmount]),
      enc(b[POF.bank.currency]),
      enc(b[POF.bank.merchantId]),
      enc(b[POF.bank.draweeCardNo]),
      // 原值：引擎覆盖前捕获的 oldReconciliationId（非银行行当前最新值）
      enc(cellToString(p.oldReconciliationId)),
      enc(r[POF.recon.reconId]),
      enc(r[POF.recon.dispatchNo]),
      fmtDate(txTime),
      fmtNumber(r[POF.recon.amount]),
      enc(r[POF.recon.currency]),
      enc(r[POF.recon.payAccount]),
      enc(r[POF.recon.receiveChannel]),
      enc(r[RECON.bigAccount]),
      weekTag(billDate),
      weekTag(parseFtaDate(r[POF.recon.dispatchNo])),
      interval,
      p.dayDiff
    ]);
  });
  applyPaymentAuditSheetLayout(sm, { maxWidth: 28 });

  // ② 银行行-原始：必须使用 Payment 写 ReconciliationId 前捕获的快照。
  const sb = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.bankRaw);
  sb.addRow(['配对序号', ...BANK_STATEMENT_FIELDS]);
  sb.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const original = p.bankRowOriginal || {};
    const cleaned = stripInternalFields(original);
    // v3.2.22：Payment 写入前的快照，按已解码文本编码。
    sb.addRow([idx + 1, ...BANK_STATEMENT_FIELDS.map((h) => enc(cleaned[h]))]);
  });
  applyPaymentAuditSheetLayout(sb, { maxWidth: 32 });

  // ③ 调拨对账单行-原始：真实派生字段及本次运行态“是否被使用”。
  const reconHeaders = Object.values(FT_RECON_FIELD_MAP.recon);
  const sr = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.reconRaw);
  sr.addRow(['配对序号', ...reconHeaders]);
  sr.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const r = p.reconRow || {};
    sr.addRow([idx + 1, ...reconHeaders.map((h) => enc(r[h]))]);
  });
  applyPaymentAuditSheetLayout(sr, { maxWidth: 28 });
}

// ===== v3.2.22（🔴 资金红线）：单元格文本保真 =====
//   ExcelJS 写出时会直接丢弃 XML 不允许的控制字符（0x00–0x08、0x0B、0x0C、0x0E–0x1F、0x7F），含 NUL 的账号
//   （如 `A\0B`）导出后会变成另一个账号（`AB`），回填的对账ID 看起来属于别的账号。回车（0x0D）原样写出会被 XML 解析
//   规范成换行（`X\rY` 与 `X\nY` 读回相同）。这些字符按 OOXML ST_Xstring 写成 `_xHHHH_`（与 Excel 自身写法一致）；
//   制表符、换行照旧原样写出。
//   本函数只动控制字符本身，用于写盘前的整本兜底与错误报告的生成文案（已按 encodeDecodedExcelJsCellText 编码的单元格
//   不再含控制字符，不受影响）：按读取端自左向右的扫描，已成对的 `_xHHHH_`（十六进制不分大小写）原样保留；不属于已成对写法
//   的下划线，若后接 `xHHHH` 再接控制字符（编码后会与之拼出新的写法），写成 `_x005F_`。读取端（Excel / SheetJS / ExcelJS
//   富文本与共享字符串中不分大小写的部分）对编码结果与对原文的解码一致；不含控制字符的文本逐字节不变。
const EXCELJS_CONTROL_CHAR_TEST = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const OOXML_ESCAPE_STICKY = /_x[0-9A-Fa-f]{4}_/iy;
const OOXML_ESCAPE_HEX_RUN = /^[xX][0-9A-Fa-f]{4}$/;
function isExcelJsControlCode(code) {
  return code <= 0x08 || (code >= 0x0B && code <= 0x1F) || code === 0x7F;
}
function ooxmlEscapeAt(text, index) {
  OOXML_ESCAPE_STICKY.lastIndex = index;
  return OOXML_ESCAPE_STICKY.test(text);
}
function ooxmlEscapeFor(code) {
  return `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
}
function encodeExcelJsCellText(value) {
  if (typeof value !== 'string' || !EXCELJS_CONTROL_CHAR_TEST.test(value)) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (ooxmlEscapeAt(value, i)) {
      out += value.slice(i, i + 7);
      i += 7;
      continue;
    }
    const code = value.charCodeAt(i);
    if (isExcelJsControlCode(code)) {
      out += ooxmlEscapeFor(code);
    } else if (code === 0x5F && i + 6 < value.length && OOXML_ESCAPE_HEX_RUN.test(value.slice(i + 1, i + 6)) &&
      isExcelJsControlCode(value.charCodeAt(i + 6))) {
      out += '_x005F_';
    } else {
      out += value[i];
    }
    i += 1;
  }
  return out;
}
// v3.2.22（🔴 资金红线）：已解码文本（银行账单经 SheetJS / CSV 读取的原值、表头、配置文案）的写法：控制字符与回车写成
//   `_xHHHH_`；会被读取端当成转义写法起点的下划线（后接 `xHHHH` 再接下划线或控制字符，`x` 与十六进制不分大小写）写成
//   `_x005F_`。读取端（SheetJS / Excel、ExcelJS）读回即原值：含真实 NUL 的 `A\0B` 与字面 `A_x0000_B` 两个账号导出后
//   仍可区分（按原文写出会都读回 `A\0B`）。不含这两类字符的文本逐字节不变。
const EXCELJS_DECODED_UNSAFE_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]|_(?=[xX][0-9A-Fa-f]{4}(?:_|[\u0000-\u0008\u000B-\u001F\u007F]))/;
const EXCELJS_DECODED_UNSAFE_PATTERN_GLOBAL = new RegExp(EXCELJS_DECODED_UNSAFE_PATTERN.source, 'g');
function encodeDecodedExcelJsCellText(value) {
  if (typeof value !== 'string' || !EXCELJS_DECODED_UNSAFE_PATTERN.test(value)) return value;
  return value.replace(EXCELJS_DECODED_UNSAFE_PATTERN_GLOBAL, (ch) => ooxmlEscapeFor(ch.charCodeAt(0)));
}
// v3.2.22（🔴 资金红线）：银行行单元格一律按已解码文本编码。银行账单原值（SheetJS / CSV 读取）与 C1 / C2 / C3 自定义值本就
//   是已解码文本；场景回填值来自链接表，链接表各导入路径同样落库已解码文本：单工作表 `.xlsx` 流式导入自 v3.2.22 起按 SheetJS
//   同一口径还原 `_xHHHH_`、无法确认原值时整批拒绝（B113，fix/statement-xlsx-io-boundary D4b），多工作表经 SheetJS 读取，
//   CSV 即字面文本。源表字面 `RID_x0041_` 落库为 `RID_x0041_`，写成 `RID_x005F_x0041_` 才能读回源值（按原文写出会读回
//   `RIDA`）。v3.2.22 之前经流式导入、按转义原文落库的旧记录读回显示为转义写法，需人工核对（见 knowledge/backlog.md B134）。
function encodeBankRowCellValue(row, header) {
  return encodeDecodedExcelJsCellText(row ? row[header] : undefined);
}
// v3.2.22（🔴 资金红线）：多对多「异常说明」分段编码后拼接（many-to-many-detector noteHit）：账号、币种段（{ column, value }）
//   与其余文字都按已解码文本编码（与结果列读回一致）。各段之间是空格、斜杠等，不含下划线与十六进制字符，拼接不会拼出新的
//   `_xHHHH_`。
function encodeManyToManyNoteParts(parts) {
  return parts.map((part) => encodeDecodedExcelJsCellText(typeof part === 'string' ? part : cellToString(part && part.value)))
    .join('');
}
// 读取端自左向右把每个 `_xHHHH_`（不分大小写）还原成一个 UTF-16 单元：读回长度 = 写出文本长度 − 6 × 写法个数。
const OOXML_ESCAPE_GLOBAL = /_x[0-9A-Fa-f]{4}_/gi;
function excelReadbackLength(text) {
  const escapes = text.match(OOXML_ESCAPE_GLOBAL);
  return text.length - 6 * (escapes ? escapes.length : 0);
}
// 写盘前的兜底：按原文口径编码整本工作簿中仍含控制字符的文本（已按已解码文本编码的单元格不再含控制字符，不受影响），
//   并校验每格读回后的长度。读回超过 Excel 单格 32,767 个 UTF-16 单元时整本拒绝写出（Excel 与项目读取器都会拒读这样的
//   文件），报出工作表与单元格，不截断（截断会改变对账ID 等标识）。v3.2.22 起导出按已解码文本编码，v3.2.22 之前按转义原文
//   落库的链接表旧记录读回即转义写法本身，可能比源单元格长（见 knowledge/backlog.md B134）。
function encodeWorkbookCellTexts(workbook) {
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const encoded = encodeExcelJsCellText(cell.value);
        if (encoded !== cell.value) cell.value = encoded;
        if (typeof encoded !== 'string') return;
        const readbackLength = excelReadbackLength(encoded);
        if (readbackLength > EXCEL_CELL_TEXT_MAX_UTF16_UNITS) {
          throw new Error(`工作表「${sheet.name}」单元格 ${cell.address} 的文本有 ${readbackLength} 个字符，超过 Excel 单元格 ` +
            `${EXCEL_CELL_TEXT_MAX_UTF16_UNITS} 个字符的上限，未生成文件（不截断，以免改变对账ID 等标识）。若该行来自 v3.2.22 之前` +
            '导入的链接表记录，可能是按转义写法保存的旧记录，请按源表核对。');
        }
      });
    });
  });
}

// ===== v3.0.12 功能1：异常说明（🔴 资金红线·只读检测产物）=====
//   reviewRows 项 = { row: 银行行引用, note: 中文说明 }（many-to-many-detector 产出）。
//   v3.0.13 起不再追加独立「异常-人工判断」sheet；note 并入「命中场景」第 2 列。
const SHEET_MANY_TO_MANY_NAME = '异常-人工判断';

// rowId -> 说明分段（多条按 '; ' 拼接）。没有 noteParts 的旧调用方按整段文字处理（已解码文本）。
function buildManyToManyNoteByRowId(manyToManyRows) {
  const map = new Map();
  if (!Array.isArray(manyToManyRows)) return map;

  for (const rv of manyToManyRows) {
    const row = rv && rv.row;
    if (!row || row._rowId === undefined || row._rowId === null) continue;
    const parts = Array.isArray(rv.noteParts) && rv.noteParts.length > 0
      ? rv.noteParts
      : [cellToString(rv.note).trim()];
    const text = parts.map((part) => (typeof part === 'string' ? part : cellToString(part && part.value))).join('');
    if (!text.trim()) continue;
    const prev = map.get(row._rowId);
    // 只读使用分段：首条直接沿用（检测器同组各行共用同一分段），同一行多条时才拼成新数组。
    map.set(row._rowId, prev ? [...prev, '; ', ...parts] : parts);
  }

  return map;
}

// v3.0.4 块 F 修订 R2 Q14：paymentOfflinePairs 非空时在既有 2 sheet 后追加 3 核对 sheet；null/空 → 主文件形态零变化。
// v3.0.5 OPEN-7（T5b-2 出口②预留）：staleHitNotesByRowId（Map<rowId, 提醒串> | null，默认 null）——
//   主对账链命中明细行追加「跨期重复命中」提醒（同 §3.6-5 出口①口径，append 不覆盖原命中明细）。
//   🔴 传空/不传时（本批 main 即不传，主对账链无入金表来源命中——depositRows 唯一消费者是 R5 场景4）
//      完全不进注入分支 → 命中明细 golden 字节不变（parity 锁定，留 refund-backfill 阶段接入实际注入）。
async function writeBankStatementOutput(rows, headers, savePath, unmatchedRows = null, modifications = null, paymentOfflinePairs = null, staleHitNotesByRowId = null, manyToManyRows = null) {
  const workbook = new ExcelJS.Workbook();
  const manyToManyNoteByRowId = buildManyToManyNoteByRowId(manyToManyRows);

  // ===== sheet1「未命中场景」=====
  //   仅当 caller 显式传 unmatchedRows（Array）时输出（向下兼容旧 caller 不传 → 仅命中 sheet）。
  //   即使 0 行也输出含 A1 提示 + 表头的空 sheet（AC B-5）。
  if (Array.isArray(unmatchedRows)) {
    const s1 = workbook.addWorksheet(SHEET1_UNMATCHED_NAME);
    // 第 1 行 A1：加粗提示（B-1）
    const a1 = s1.getCell('A1');
    a1.value = SHEET1_A1_NOTICE;
    a1.font = { bold: true };

    // 排序：FundType 数据值 === 'Mark without result' 的行排前，其余随后（D8 / B-2）
    //   稳定排序：filter 两段拼接保留各段原始相对顺序
    const markFirst = unmatchedRows.filter((r) => cellToString(r && r['FundType']) === MARK_WITHOUT_RESULT);
    const others = unmatchedRows.filter((r) => cellToString(r && r['FundType']) !== MARK_WITHOUT_RESULT);
    const sortedUnmatched = [...markFirst, ...others];

    // v3.0.8（用户要求 #9）：银行行数据整体上移一行——表头移到第 1 行（与 A1 提醒同行：A 列提醒 + B 列起表头），
    //   数据从第 2 行起，填掉原顶部空行；headers 投影自动过滤 _ 前缀诊断列。
    // v3.0.8 W2：未命中 sheet 表头/数据整体右移一列（从 B 列起）——A 列除 A1 提醒外留空。
    //   仅本「未命中场景」sheet 右移 + 上移（颜色/行号/A1 提醒不变）；命中场景 sheet 不受影响。
    const headerRow1 = s1.getRow(1);
    headers.forEach((h, idx) => {
      const cell = headerRow1.getCell(idx + 2);          // B1 起表头（A1 留给提醒；font 逐格设以不覆盖 A1 提醒字体）
      cell.value = encodeDecodedExcelJsCellText(h);
      cell.font = { bold: true, size: 10 };
    });
    sortedUnmatched.forEach((row, rowIdx) => {
      const r = s1.getRow(rowIdx + 2);                   // 第 2 行起数据（B 列起）
      // v3.2.22：未命中行没有被场景改写的列，全部是银行账单原值（按已解码文本编码）。
      headers.forEach((h, colIdx) => { r.getCell(colIdx + 2).value = encodeBankRowCellValue(row, h); });
    });
  }

  // ===== sheet2「命中场景」=====
  //   第一列「命中明细」+ 第二列「异常说明」+ 原 headers；命中行保留标黄（D5）。
  //   空数组（全未命中）仍输出含表头的空 sheet（AC B-5）。
  const s2 = workbook.addWorksheet(SHEET2_HIT_NAME);
  const hitHeaders = [HIT_DETAIL_HEADER, MANY_TO_MANY_NOTE_HEADER, ...headers];
  const hitDataColumnOffset = hitHeaders.length - headers.length + 1;
  s2.addRow(hitHeaders.map(encodeDecodedExcelJsCellText));
  s2.getRow(1).font = { bold: true, size: 10 };

  // 按 rowId group modifications（rowId === row._rowId，已核实）
  const modsByRowId = new Map();
  if (Array.isArray(modifications)) {
    modifications.forEach((m) => {
      if (!m || m.rowId === undefined || m.rowId === null) return;
      if (!modsByRowId.has(m.rowId)) modsByRowId.set(m.rowId, []);
      modsByRowId.get(m.rowId).push(m);
    });
  }

  rows.forEach((row, rowIdx) => {
    const mods = modsByRowId.get(row._rowId) || [];
    let detail = buildHitDetail(mods);
    // v3.0.5 OPEN-7（出口②）：若该行有跨期重复命中提醒 → append 到命中明细（不覆盖原 detail）。
    //   🔴 staleHitNotesByRowId 为 null/无该 rowId 时不进分支 → detail 字节不变（parity）。
    //   v3.0.7 需求C 单行布局：append 分隔符由 '\n' 改为 '; '（半角分号+空格），空 detail 时直接用提醒串 —— 确保命中明细列绝不含 '\n'。
    if (staleHitNotesByRowId && typeof staleHitNotesByRowId.get === 'function') {
      const note = staleHitNotesByRowId.get(row._rowId);
      // v3.2.22：提醒同样单独编码后再拼接（见 wrapHitValue）。
      if (note) detail = detail ? detail + '; ' + encodeDecodedExcelJsCellText(note) : encodeDecodedExcelJsCellText(note);
    }
    const noteParts = manyToManyNoteByRowId.get(row._rowId);
    const abnormalNote = noteParts ? encodeManyToManyNoteParts(noteParts) : '';
    const cells = [detail, abnormalNote, ...headers.map((h) => encodeBankRowCellValue(row, h))];
    const r = s2.addRow(cells);
    // v3.0.7 需求C：命中明细单行紧凑显示，关闭自动换行（wrapText:false）→ 不再撑高行；仅保留顶端对齐。
    r.getCell(1).alignment = { wrapText: false, vertical: 'top' };
    r.getCell(2).alignment = { wrapText: false, vertical: 'top' };
    // 保留原标黄（D5）：_modifiedColumns 对应单元格黄底；前缀列变化时自动右移。
    const modifiedColumns = row._modifiedColumns;
    if (modifiedColumns && modifiedColumns.size > 0) {
      headers.forEach((header, colIdx) => {
        if (!modifiedColumns.has(header)) return;
        r.getCell(colIdx + hitDataColumnOffset).fill = YELLOW_FILL;
      });
    }
  });

  // ===== v3.0.4 块 F 修订 R2 Q14：追加 Payment线下调拨核对 3 sheet =====
  //   pairs 为 null / 非数组 / 空数组 → 完全不加 sheet（未勾选/无命中时主文件形态零变化）。
  if (Array.isArray(paymentOfflinePairs) && paymentOfflinePairs.length > 0) {
    appendPaymentOfflineSheets(workbook, paymentOfflinePairs);
  }

  encodeWorkbookCellTexts(workbook);
  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

// v3.0.4 F3：error-report 第 3 列「对账ID」取值——三级回退链。
//   ReconciliationId 可能是 number（bank-statement-io readBankStatement raw 读入），
//   判空须 String(v).trim()；空串 / null / undefined 视为未命中继续回退。
// v3.2.22：返回逻辑文本；写出时与其余列一起按已解码文本编码（见 errorReportRecordRows）。
function resolveReconIdCell(w) {
  const candidates = [w.reconciliationId, w.reconId, w.rowId];
  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '') continue;
    return s;
  }
  return '';
}

// warnings: Array<{ scenarioId, scenarioName, rowId, code, message, reconciliationId?, reconId? }>
//   v3.0.4 F3：第 3 列「对账ID」取值三级回退——
//     reconciliationId（caller enrich 注入的银行行 ReconciliationId，String+trim 非空）
//       → reconId（R1 'multi-bank-match-r1' warning 自带专用字段，rowId=null 时兜底）
//       → rowId（旧 shape 调用方未传 bankRows 时回退 _rowId，向后兼容）→ ''
//   注：引擎 warning 其余透传字段（fields/matchedRowIds/phase/severity 等）不写盘。
// savePath: 绝对路径（含 .xlsx）
// options.maxDataRowsPerSheet：单表数据行上限，缺省为 Excel 单表上限（1,048,576 行减表头）；仅供单测注入小值。
// options.createOutput：输出流工厂，缺省同 withBoundedWorkbook（'wx' 独占新建）；仅供单测观察流关闭。
// options.temporaryFileMarkerDir：临时文件归属登记目录（应用私有目录）；传入时中断遗留的临时文件可在下次启动按登记回收。
//   v3.2.22：经 withBoundedWorkbook 流式写出（同 VCC 导出），按输出流背压与队列字节上限等待，
//   内存不随告警条数累积；写盘早期失败（目录不存在、磁盘满等）立即结束导出并关闭流。
//   超出单表上限时续写 error-report_2、error-report_3 …，每张表重复表头，不截断需人工复核的记录；
//   未超上限时仍只有一张 error-report。先写同目录临时文件，成功后改名为 savePath；失败时先关闭写入流
//   再删除临时文件，不留下半份报告。删除遇到文件占用（Windows 共享冲突等）时有界重试；仍删不掉时保留原错误，
//   在其 message 末尾写明临时文件路径，并附 temporaryFileCleanup = { path, code }，提示需手动清理。
const ERROR_REPORT_SHEET_NAME = 'error-report';
const TEMPORARY_FILE_REMOVE_ATTEMPTS = 5;
const TEMPORARY_FILE_REMOVE_RETRY_MS = 100;
const TEMPORARY_FILE_REMOVE_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function removeTemporaryFile(filePath) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return null;
    } catch (error) {
      if (attempt >= TEMPORARY_FILE_REMOVE_ATTEMPTS || !TEMPORARY_FILE_REMOVE_RETRY_CODES.has(error && error.code)) return error;
      await new Promise((resolve) => setTimeout(resolve, TEMPORARY_FILE_REMOVE_RETRY_MS));
    }
  }
}
// v3.2.22：错误报告先写同目录临时文件「<savePath>.<UUID>.tmp」，成功后改名。应用在写入中被终止（崩溃、强制退出、断电）
//   时来不及删除，按归属登记回收：调用方传 options.temporaryFileMarkerDir（应用私有目录，生产为 userData 下）时，
//   写临时文件前先在其中新建登记文件「<UUID>.json」（记录本进程归属标记与临时文件路径；先独占写出清理器不识别的
//   「.<UUID>.json.partial」再改名，清理器不会读到写了一半的登记、把它当损坏撤销；登记失败则不写报告），
//   改名成功或临时文件已删除后撤销登记，删不掉时保留登记供下次重试。
//   cleanupInterruptedErrorReportTemporaryFiles 在启动时只按这些登记回收：跳过本进程自己的登记（正在写的不动）；
//   临时文件名须以「.<登记 UUID>.tmp」结尾且是普通文件（不跟随链接）才删除；其余同名后缀文件（其他写出器、其他
//   userData 的实例）一律不碰。登记目录本身须是真实目录。
const PROCESS_OWNER_TOKEN = crypto.randomUUID();
const MARKER_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
async function registerTemporaryFile(markerDir, uuid, temporaryPath) {
  await fs.promises.mkdir(markerDir, { recursive: true });
  // 与启动清理同一真实目录检查：登记目录是符号链接或不是目录时，清理器不会读取其中的登记，拒绝写报告。
  const markerDirStat = await fs.promises.lstat(markerDir);
  if (markerDirStat.isSymbolicLink() || !markerDirStat.isDirectory()) {
    const error = new Error('错误报告临时文件登记目录不是真实目录（可能是符号链接），已停止写出');
    error.code = 'ERROR_REPORT_MARKER_DIR_INVALID';
    throw error;
  }
  const markerPath = path.join(markerDir, `${uuid}.json`);
  const partialPath = path.join(markerDir, `.${uuid}.json.partial`);
  await fs.promises.writeFile(
    partialPath,
    JSON.stringify({ version: 1, owner: PROCESS_OWNER_TOKEN, temporaryPath }),
    { flag: 'wx' }
  );
  try {
    await fs.promises.rename(partialPath, markerPath);
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
  return markerPath;
}
async function cleanupInterruptedErrorReportTemporaryFiles(markerDir) {
  const removed = [];
  const failures = [];
  const skipped = [];
  const record = (list, filePath, error) => list.push({ path: filePath, code: (error && error.code) || null });
  let rootStat;
  try {
    rootStat = await fs.promises.lstat(markerDir);
  } catch (error) {
    if (error && error.code !== 'ENOENT') record(failures, markerDir, error);
    return { removed, failures, skipped };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { removed, failures, skipped };
  let entries;
  try {
    entries = await fs.promises.readdir(markerDir, { withFileTypes: true });
  } catch (error) {
    record(failures, markerDir, error);
    return { removed, failures, skipped };
  }
  for (const entry of entries) {
    const match = entry.isFile() ? MARKER_FILE_RE.exec(entry.name) : null;
    if (!match) continue;
    const markerPath = path.join(markerDir, entry.name);
    const dropMarker = async () => {
      try { await fs.promises.rm(markerPath, { force: true }); } catch (error) { record(failures, markerPath, error); }
    };
    let marker = null;
    let markerText;
    try {
      markerText = await fs.promises.readFile(markerPath, 'utf8');
    } catch (error) {
      record(failures, markerPath, error); // 读不到（权限、I/O）：保留登记，下次启动重试
      continue;
    }
    try {
      marker = JSON.parse(markerText);
    } catch (_error) {
      marker = null; // 登记写入中被终止：临时文件尚未创建，撤销登记即可
    }
    if (marker && marker.owner === PROCESS_OWNER_TOKEN) continue; // 本进程正在写
    const temporaryPath = marker && typeof marker.temporaryPath === 'string' ? marker.temporaryPath : '';
    if (!path.isAbsolute(temporaryPath) || !path.basename(temporaryPath).endsWith(`.${match[1]}.tmp`)) {
      if (temporaryPath) record(skipped, temporaryPath, null);
      await dropMarker();
      continue;
    }
    let stat;
    try {
      stat = await fs.promises.lstat(temporaryPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') { await dropMarker(); continue; }
      record(failures, temporaryPath, error);
      continue;
    }
    if (!stat.isFile()) {
      record(skipped, temporaryPath, null); // 已被替换为链接或目录：不是本模块写的文件，不跟随、不删除
      await dropMarker();
      continue;
    }
    const cleanupError = await removeTemporaryFile(temporaryPath);
    if (cleanupError) {
      record(failures, temporaryPath, cleanupError);
      continue;
    }
    removed.push(temporaryPath);
    await dropMarker();
  }
  return { removed, failures, skipped };
}
const EXCEL_MAX_DATA_ROWS_PER_SHEET = 1048576 - 1;

// v3.2.22：错误报告单元格文本保真。
//   ⓪ 各列按已解码文本编码（encodeDecodedExcelJsCellText）：对账ID 与告警正文里插入的对账ID、账号都是已解码文本，与主输出
//     同口径读回（如告警写明的 `RID_x0041_` 不会读成 `RIDA`）；告警里需要看清的转义写法已由引擎显示为 ⟨U+HHHH⟩。
//   ① 单元格文本上限 32,767 个 UTF-16 单元（按解码后的字符计，即按编码前的逻辑文本判断）。告警正文（如争用告警写明双方
//     网关记录的业务键与对账ID）可能超过上限，Excel 与项目读取器都会拒读；任一单元格超限时整条记录拆成连续若干行：超过 ERROR_REPORT_SEGMENT_UNITS
//     的单元格按段依次写入（不拆开代理对），其余单元格每行重复，「原因」列加「（第 k/n 段）」前缀关联续行，不截断。
//   ② 流式写出不用共享字符串，普通文本写成 t="str"；ExcelJS 读取这类单元格会把 XML 实体再解一次（`A&amp;B` 读成 `A&B`，
//     与另一 ID 混同），也不解 `_xHHHH_`（主输出的共享字符串会解：对账ID `RID_x0041_` 编码为 `RID_x005F_x0041_` 后在主输出
//     读回 `RID_x0041_`、在错误报告却读回编码后的写法，按 ID 关联两份报表会漏行）。含 `&` 或 `_xHHHH_` 写法的文本改写成单段富文本
//     （inlineStr），ExcelJS、SheetJS、Excel 读回都与主输出一致。
//   ③ 分段前先按写出口径编码整格文本，分界不落在任何 `_xHHHH_` 写法中间（十六进制不分大小写、含相互重叠的写法），也不
//     落在解码后的代理对中间（高、低代理各自是字面字符或转义写法都算，如 `_xD83D_` + `_xDE00_`）：各段独立解码后拼接
//     即整格的读回值，每段都是合法 UTF-16。分界按读取端自左向右的解码单元找；限长内找不到合法分界时按解码单元切开
//     （实际数据不会出现）。
const ERROR_REPORT_SEGMENT_UNITS = 32000;
const OOXML_ESCAPE_WINDOW_TEST = /^_x[0-9A-Fa-f]{4}_$/i;
const OOXML_ESCAPE_ANY_TEST = /_x[0-9A-Fa-f]{4}_/i;
// 跨过分界 cut（cut 落在写法内部）的 `_xHHHH_` 写法中最靠前的起点；没有则 -1。
function escapeWindowStartAcross(text, cut) {
  for (let start = Math.max(0, cut - 6); start < cut; start += 1) {
    if (text.charCodeAt(start) === 0x5F && OOXML_ESCAPE_WINDOW_TEST.test(text.slice(start, start + 7))) return start;
  }
  return -1;
}
function splitTextSegments(text, size) {
  // 读取端口径的解码单元：起点与解码后的 UTF-16 单元。
  const starts = [];
  const units = [];
  for (let i = 0; i < text.length;) {
    starts.push(i);
    if (ooxmlEscapeAt(text, i)) {
      units.push(Number.parseInt(text.slice(i + 2, i + 6), 16));
      i += 7;
    } else {
      units.push(text.charCodeAt(i));
      i += 1;
    }
  }
  const isHighSurrogate = (unit) => unit >= 0xD800 && unit <= 0xDBFF;
  const isLowSurrogate = (unit) => unit >= 0xDC00 && unit <= 0xDFFF;
  const canCutBefore = (k) => escapeWindowStartAcross(text, starts[k]) < 0 &&
    !(isHighSurrogate(units[k - 1]) && isLowSurrogate(units[k]));
  const lastStartAtMost = (limit) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= limit) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const segments = [];
  let first = 0;
  while (first < starts.length) {
    const limit = starts[first] + size;
    if (limit >= text.length) {
      segments.push(text.slice(starts[first]));
      break;
    }
    const last = Math.max(first + 1, lastStartAtMost(limit)); // 每段至少一个解码单元
    let cut = last;
    while (cut > first && !canCutBefore(cut)) cut -= 1;
    if (cut === first) cut = last;
    segments.push(text.slice(starts[first], starts[cut]));
    first = cut;
  }
  return segments;
}
function errorReportRecordRows(cells, messageIndex) {
  const texts = cells.map((value) => (typeof value === 'string' ? value : String(value ?? '')));
  const encodedTexts = texts.map((text) => encodeDecodedExcelJsCellText(text));
  if (texts.every((text) => text.length <= EXCEL_CELL_TEXT_MAX_UTF16_UNITS)) return [encodedTexts];
  const segmented = encodedTexts.map((text, column) => (
    texts[column].length > ERROR_REPORT_SEGMENT_UNITS ? splitTextSegments(text, ERROR_REPORT_SEGMENT_UNITS) : null
  ));
  const total = Math.max(...segmented.map((segments) => (segments ? segments.length : 1)));
  return Array.from({ length: total }, (_v, k) => encodedTexts.map((text, column) => {
    const value = segmented[column] ? (segmented[column][k] ?? '') : text;
    return column === messageIndex ? `（第 ${k + 1}/${total} 段）${value}` : value;
  }));
}
// 已编码的文本不再含控制字符，再次编码不变（续行各段可直接交本函数）。
function errorReportCellValue(text) {
  const encoded = encodeExcelJsCellText(text);
  return typeof encoded === 'string' && (encoded.includes('&') || OOXML_ESCAPE_ANY_TEST.test(encoded))
    ? { richText: [{ text: encoded }] }
    : encoded;
}
async function writeErrorReport(warnings, savePath, options = {}) {
  const maxDataRows = Number.isSafeInteger(options.maxDataRowsPerSheet) && options.maxDataRowsPerSheet > 0
    ? Math.min(options.maxDataRowsPerSheet, EXCEL_MAX_DATA_ROWS_PER_SHEET)
    : EXCEL_MAX_DATA_ROWS_PER_SHEET;
  const headers = ['时间戳', '场景名', '对账ID', '原因', '可能原因'];
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const temporaryId = crypto.randomUUID();
  const temporaryPath = `${savePath}.${temporaryId}.tmp`;
  const markerPath = typeof options.temporaryFileMarkerDir === 'string' && options.temporaryFileMarkerDir !== ''
    ? await registerTemporaryFile(options.temporaryFileMarkerDir, temporaryId, temporaryPath)
    : null;
  const unregister = async () => {
    if (markerPath) await fs.promises.rm(markerPath, { force: true });
  };
  const boundedOptions = { filePath: temporaryPath };
  if (typeof options.createOutput === 'function') boundedOptions.createOutput = options.createOutput;
  try {
    await withBoundedWorkbook(boundedOptions, async (session) => {
      let sheetIndex = 0;
      let sheet = null;
      let dataRows = 0;
      const openSheet = async () => {
        if (sheet) await session.commitSheet(sheet);
        sheetIndex += 1;
        dataRows = 0;
        sheet = session.addWorksheet(sheetIndex === 1 ? ERROR_REPORT_SHEET_NAME : `${ERROR_REPORT_SHEET_NAME}_${sheetIndex}`);
        const headerRow = sheet.addRow(headers.map(errorReportCellValue));
        // 表头加粗 + 字号 10（v2.0.0 GA：所有导出表头统一 size 10）
        headerRow.font = { bold: true, size: 10 };
        await session.commitRow(headerRow);
      };
      await openSheet();
      for (const w of warnings) {
        const recordRows = errorReportRecordRows([
          timestamp,
          w.scenarioName ?? `场景 #${w.scenarioId}`,
          resolveReconIdCell(w),
          w.message ?? w.code ?? '',
          errorCodeToCause(w.code)
        ], 3);
        // 同一条记录的续行尽量留在同一张表（续行数不超过单表上限时）。
        if (dataRows > 0 && dataRows + Math.min(recordRows.length, maxDataRows) > maxDataRows) await openSheet();
        for (const cells of recordRows) {
          if (dataRows >= maxDataRows) await openSheet();
          dataRows += 1;
          await session.commitRow(sheet.addRow(cells.map(errorReportCellValue)));
        }
      }
      await session.commitSheet(sheet);
      return {};
    });
    await fs.promises.rename(temporaryPath, savePath);
  } catch (error) {
    // withBoundedWorkbook 失败时已销毁并等待输出流关闭，此处删除不会与写入竞争。
    const cleanupError = await removeTemporaryFile(temporaryPath);
    if (!cleanupError) await unregister().catch(() => {});
    if (cleanupError) {
      const reported = error instanceof Error ? error : new Error(String(error));
      reported.temporaryFileCleanup = { path: temporaryPath, code: cleanupError.code || null };
      reported.message = `${reported.message}（错误报告临时文件未能删除，请手动清理：${temporaryPath}）`;
      throw reported;
    }
    throw error;
  }
  // 撤销登记失败不影响已完成的报告：残留登记在下次启动时因临时文件已不存在而被清掉。
  await unregister().catch(() => {});
  return { filePath: savePath };
}

module.exports = {
  writeBankStatementOutput,
  writeErrorReport,
  cleanupInterruptedErrorReportTemporaryFiles,
  resolveReconIdCell,      // v3.0.4 F3：error-report 第 3 列「对账ID」三级回退（unit 直测）
  encodeExcelJsCellText,   // v3.2.22：单元格文本保真（unit 直测）
  encodeDecodedExcelJsCellText, // v3.2.22：已解码文本（银行账单原值）保真
  encodeBankRowCellValue,  // v3.2.22：银行行单元格按已解码文本编码（命中场景独立报表复用）
  encodeWorkbookCellTexts, // v3.2.22：整本工作簿文本保真（命中场景独立报表复用）
  stripInternalFields,     // v2.1.7 round 3 F8 (spec §9.8.4)
  YELLOW_FILL,
  INTERNAL_FIELDS,
  // v2.1.16-beta.6 需求 B：双 sheet 重构（单测 + caller 引用）
  buildHitDetail,
  SHEET1_UNMATCHED_NAME,
  SHEET2_HIT_NAME,
  SHEET1_A1_NOTICE,
  HIT_DETAIL_HEADER,
  MANY_TO_MANY_NOTE_HEADER,
  MARK_WITHOUT_RESULT,
  // v3.0.13：独立异常 sheet 已停用；常量保留给回归测试断言“不出现该 sheet”。
  SHEET_MANY_TO_MANY_NAME,
  buildManyToManyNoteByRowId
};
