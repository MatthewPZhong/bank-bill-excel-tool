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

const ExcelJS = require('exceljs');
const { errorCodeToCause } = require('../backend/file-service/error-causes');
const { applyWatermark } = require('./workbook-watermark');
// v3.0.4 块 F 修订 R2 Q14：Payment线下调拨核对 sheet 用——银行 44 列契约列序 + 中台 26 列签名列序。
const { BANK_STATEMENT_FIELDS } = require('../constants/bank-statement-fields');
const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE } = require('../constants/table-signatures');
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
function wrapHitValue(value) {
  const s = cellToString(value);
  const t = s.trim();
  return /\d/.test(t) ? `“${t}”` : `<${s}>`;
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
    .map((m) => `${cellToString(m.column)}:${wrapHitValue(m.oldValue)}→${wrapHitValue(m.newValue)}`)
    .join('; ');
}

// ===== v3.0.4 块 F 修订 R2 Q14：Payment线下调拨核对 3 sheet =====
//   pairs 项 = { bankRow, orderRow, round, oldReconciliationId, dayDiff }（引擎产出，见
//   r5-payment-offline-allocation-backfill.js 返回值）。pairs 为 null/空数组 → 完全不加 sheet（主文件形态零变化）。
const PAYMENT_OFFLINE_SHEET = Object.freeze({
  match: '匹配对照',
  bankRaw: '银行行-原始',
  orderRaw: '订单行-原始'
});
// 匹配轮次内部值 → 中文展示
const PAYMENT_OFFLINE_ROUND_LABEL = Object.freeze({
  main: '主轮',
  'date-tolerance': '容差轮',
  'relaxed-week': '兜底轮'
});
// 「匹配对照」sheet 表头（15 + 配对序号；列序见 spec §R2.3 导出）
const PAYMENT_OFFLINE_MATCH_HEADERS = Object.freeze([
  '配对序号', '匹配轮次', 'BillDate', 'Credit Amount', 'Currency', '原ReconciliationId',
  '回填值(渠道流水号)', '调拨单号', '交易时间', '收款金额', '收款币种', '付款渠道', '收款渠道',
  '银行周', '订单周', '天数差'
]);

// 在 workbook 追加 3 核对 sheet（仅 pairs 非空数组时调用）。
//   bankHeaders：银行 44 列契约列序（BANK_STATEMENT_FIELDS）；orderHeaders：中台 26 列签名列序。
function appendPaymentOfflineSheets(workbook, pairs) {
  const { weekTag, parseFtaDate } = require('./scenario-engines/engine-week-utils');
  // 真实 app 链路中 mid 行来自链接表 raw_json：「交易时间」是字符串 Excel 序列号（如 '46179'）、
  //   「收款金额」是字符串数字（如 '7587133'）。引擎匹配走 toDate/parseNumber 不受影响，但「匹配对照」sheet
  //   若原样写入会显示无法阅读的 46179 → 仅本 shet 的 4 个值列规整展示形态（两张「-原始」sheet 保持忠实 dump）。
  const { toDate } = require('./scenario-engines/engine-date-utils');
  const { parseNumber } = require('./scenario-engines/engine-utils');
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
    const o = p.orderRow || {};
    const billDate = b[POF.bank.billDate];
    const txTime = o[POF.mid.txTime];
    sm.addRow([
      idx + 1,
      PAYMENT_OFFLINE_ROUND_LABEL[p.round] || cellToString(p.round),
      // BillDate / 交易时间：规整为 'YYYY-MM-DD'（序列号/多格式字符串 → 可读日期）
      fmtDate(billDate),
      // Credit Amount / 收款金额：规整为数字（字符串数字 → number）
      fmtNumber(b[POF.bank.creditAmount]),
      b[POF.bank.currency],
      // 原值：引擎覆盖前捕获的 oldReconciliationId（非银行行当前最新值）
      cellToString(p.oldReconciliationId),
      o[POF.mid.channelSerialNo],
      o[POF.mid.dispatchNo],
      fmtDate(txTime),
      fmtNumber(o[POF.mid.payeeAmount]),
      o[POF.mid.payeeCurrency],
      // 付款渠道：26 列签名 idx22（出款行，仅核对展示，非引擎筛选列）
      o['付款渠道'],
      o[POF.mid.receiveChannel],
      // 银行周 = weekTag(BillDate)（银行行【自身】周数，非 join 桶键）；订单周 = weekTag(调拨单号 FTA 日期）。
      //   两列肉眼可见「订单周 = 银行周 + 1」的关系（如银行周 2619 / 订单周 2620），对齐用户已核对的桌面模拟文件。
      weekTag(billDate),
      weekTag(parseFtaDate(o[POF.mid.dispatchNo])),
      p.dayDiff
    ]);
  });

  // ② 银行行-原始：配对序号 + 44 列契约列（复用 stripInternalFields 剥 _ 内部字段）
  const sb = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.bankRaw);
  sb.addRow(['配对序号', ...BANK_STATEMENT_FIELDS]);
  sb.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const cleaned = stripInternalFields(p.bankRow || {});
    sb.addRow([idx + 1, ...BANK_STATEMENT_FIELDS.map((h) => cleaned[h])]);
  });

  // ③ 订单行-原始：配对序号 + 中台 26 列签名列序
  const orderHeaders = ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders;
  const so = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.orderRaw);
  so.addRow(['配对序号', ...orderHeaders]);
  so.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const o = p.orderRow || {};
    so.addRow([idx + 1, ...orderHeaders.map((h) => o[h])]);
  });
}

// ===== v3.0.12 功能1：异常说明（🔴 资金红线·只读检测产物）=====
//   reviewRows 项 = { row: 银行行引用, note: 中文说明 }（many-to-many-detector 产出）。
//   v3.0.13 起不再追加独立「异常-人工判断」sheet；note 并入「命中场景」第 2 列。
const SHEET_MANY_TO_MANY_NAME = '异常-人工判断';

function buildManyToManyNoteByRowId(manyToManyRows) {
  const map = new Map();
  if (!Array.isArray(manyToManyRows)) return map;

  for (const rv of manyToManyRows) {
    const row = rv && rv.row;
    if (!row || row._rowId === undefined || row._rowId === null) continue;
    const note = cellToString(rv.note).trim();
    if (!note) continue;
    const prev = map.get(row._rowId);
    map.set(row._rowId, prev ? `${prev}; ${note}` : note);
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
      cell.value = h;
      cell.font = { bold: true, size: 10 };
    });
    sortedUnmatched.forEach((row, rowIdx) => {
      const r = s1.getRow(rowIdx + 2);                   // 第 2 行起数据（B 列起）
      headers.forEach((h, colIdx) => { r.getCell(colIdx + 2).value = row[h]; });
    });
  }

  // ===== sheet2「命中场景」=====
  //   第一列「命中明细」+ 第二列「异常说明」+ 原 headers；命中行保留标黄（D5）。
  //   空数组（全未命中）仍输出含表头的空 sheet（AC B-5）。
  const s2 = workbook.addWorksheet(SHEET2_HIT_NAME);
  const hitHeaders = [HIT_DETAIL_HEADER, MANY_TO_MANY_NOTE_HEADER, ...headers];
  s2.addRow(hitHeaders);
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
      if (note) detail = detail ? detail + '; ' + note : note;
    }
    const abnormalNote = manyToManyNoteByRowId.get(row._rowId) || '';
    const cells = [detail, abnormalNote, ...headers.map((h) => row[h])];
    const r = s2.addRow(cells);
    // v3.0.7 需求C：命中明细单行紧凑显示，关闭自动换行（wrapText:false）→ 不再撑高行；仅保留顶端对齐。
    r.getCell(1).alignment = { wrapText: false, vertical: 'top' };
    r.getCell(2).alignment = { wrapText: false, vertical: 'top' };
    // 保留原标黄（D5）：_modifiedColumns 对应单元格黄底；命中明细+异常说明两列后移 → colIdx + 3
    const modifiedColumns = row._modifiedColumns;
    if (modifiedColumns && modifiedColumns.size > 0) {
      headers.forEach((header, colIdx) => {
        if (!modifiedColumns.has(header)) return;
        r.getCell(colIdx + 3).fill = YELLOW_FILL;
      });
    }
  });

  // ===== v3.0.4 块 F 修订 R2 Q14：追加 Payment线下调拨核对 3 sheet =====
  //   pairs 为 null / 非数组 / 空数组 → 完全不加 sheet（未勾选/无命中时主文件形态零变化）。
  if (Array.isArray(paymentOfflinePairs) && paymentOfflinePairs.length > 0) {
    appendPaymentOfflineSheets(workbook, paymentOfflinePairs);
  }

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

// v3.0.4 F3：error-report 第 3 列「对账ID」取值——三级回退链。
//   ReconciliationId 可能是 number（bank-statement-io readBankStatement raw 读入），
//   判空须 String(v).trim()；空串 / null / undefined 视为未命中继续回退。
function resolveReconIdCell(w) {
  const candidates = [w.reconciliationId, w.reconId, w.rowId];
  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== '') return s;
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
async function writeErrorReport(warnings, savePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('error-report');

  const headers = ['时间戳', '场景名', '对账ID', '原因', '可能原因'];
  sheet.addRow(headers);
  // 表头加粗 + 字号 10（v2.0.0 GA：所有导出表头统一 size 10）
  sheet.getRow(1).font = { bold: true, size: 10 };

  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  warnings.forEach((w) => {
    sheet.addRow([
      timestamp,
      w.scenarioName ?? `场景 #${w.scenarioId}`,
      resolveReconIdCell(w),
      w.message ?? w.code ?? '',
      errorCodeToCause(w.code)
    ]);
  });

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

module.exports = {
  writeBankStatementOutput,
  writeErrorReport,
  resolveReconIdCell,      // v3.0.4 F3：error-report 第 3 列「对账ID」三级回退（unit 直测）
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
