// v2.1.6 T7 + fix5 + fix7 + fix11 + fix12 + fix13 — 收单单据币种校验：差异表 writer（⚠️ 资金红线）
//
// v0.14 输出形态（fix11 + fix13 联合调整）：
//   单文件多 sheet：
//     - Sheet 1..N：差异表（按账单日期升序贪心切分 ≤ 1,048,575 数据行/sheet）+ sheet 名 `YYYY-MM-DD~MM-DD`
//     - Sheet N+1：「运行结果汇总」（嵌入 11 区块 report，替代原独立 report.xlsx）
//
// 演进：
//   v0.3 拍板「1 对 1 多文件」→ v0.8 fix5 反转「单文件单 sheet」→ v0.10 fix7 ExcelJS streaming + SQL 分批
//   → v0.14 fix11 按账单日期切分多 sheet（Excel 单 sheet 显示上限 2^20 = 1,048,576 行）
//   → v0.14 fix13 report 嵌入 diff 末尾 sheet「运行结果汇总」，不再独立 report.xlsx
//   → v0.14 fix12 「运行时间」字段调 formatRanAtLocal 转本地时区显示
//
// 路径：
//   diff → {storageRoot}/exports/{date}/acquiring-bill-currency/acquiring-bill-currency-{monthKey}-diff-{HHMMSS}.xlsx
//   （v0.14 fix13：不再生成 report/ 子目录及独立 report.xlsx；runs.report_file_path 兼容字段 = diff_file_path）

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

// v2.1.8 N4：差异表瘦身 29→12 列，使用 WRITER_OUTPUT_HEADERS_V2 + TEMPLATE_BILL_HEADERS
//   旧 BILL_HEADERS / WRITER_OUTPUT_HEADERS 仅供历史参照，不再用于本 writer 输出
const {
  TEMPLATE_BILL_HEADERS,
  WRITER_OUTPUT_HEADERS_V2
} = require('../backend/acquiring-bill-currency-db/columns');
const runRepo = require('../backend/acquiring-bill-currency-db/run-repository');
const { applyWatermark } = require('./workbook-watermark');
// v2.1.9 SR-log-1 (T32h)：替换 console.warn → appendModuleLog 双写
const { appendModuleLog } = require('../backend/logger');

let pkg = null;
try { pkg = require('../../package.json'); } catch (_e) { pkg = { version: 'dev', author: { name: 'pzhong' } }; }
let buildInfo = { commit: 'dev' };
try { buildInfo = require('../build-info'); } catch (_e) { /* dev 期文件不存在 */ }

// v0.14 fix11：Excel 单 sheet 显示硬上限 = 1,048,576 行（含表头）→ 数据 1,048,575 行
// Microsoft 自 Excel 2007 起的硬限制，xlsx 格式 row r-attr 最大值 2^20
const MAX_DATA_ROWS_PER_SHEET = 1048575;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildTimestamp(date = new Date()) {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function buildDateDir(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function buildOutputDir(storageRoot, date = new Date()) {
  const dir = path.join(storageRoot, 'exports', buildDateDir(date), 'acquiring-bill-currency');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// v0.14 fix13：保留导出函数签名兼容性，但内部不再使用（不再生成 report/ 子目录）
function buildReportDir(storageRoot, date = new Date()) {
  return buildOutputDir(storageRoot, date);
}

// v0.14 fix12：ran_at 字符串 → 本地时区显示
// 兼容：
//   - 新数据（fix12 后）：ISO 8601 带 Z 后缀，如 "2026-05-19T22:51:20.000Z"
//   - 旧数据（fix12 前）：SQLite CURRENT_TIMESTAMP 无后缀，如 "2026-05-19 14:51:20"（实际 UTC）
function formatRanAtLocal(ranAt) {
  if (!ranAt) return '';
  const s = String(ranAt);
  // 已含时区后缀（Z 或 ±HH:MM）→ 直接解析
  // 否则当 UTC 处理（旧 SQLite CURRENT_TIMESTAMP 是 UTC 但无后缀）
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  const isoLike = hasTz ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// v0.14 fix11：按账单日期升序贪心切分 segments
//   - segments[i] = { startDate, endDate, rowCount }
//   - 同一日期内的行不切开（rowCount 累计超过 MAX 时切到下一 sheet；单日 > MAX 时单 segment 携带大 rowCount，Pass 2 写入时自动切多 sub-sheet 加后缀 (2)(3)）
//   - 0 差异行：返回单个空 segment（仍输出 1 个空表头 sheet）
//   - 账单日期为空 ''：归入第一个 segment（不参与切分判断）
function planSegments(dateCounts) {
  if (!Array.isArray(dateCounts) || dateCounts.length === 0) {
    return [{ startDate: '', endDate: '', rowCount: 0 }];
  }
  const segments = [];
  let segStart = dateCounts[0].billDate;
  let segEnd = dateCounts[0].billDate;
  let segCount = 0;
  for (const { billDate, count } of dateCounts) {
    if (segCount > 0 && segCount + count > MAX_DATA_ROWS_PER_SHEET) {
      segments.push({ startDate: segStart, endDate: segEnd, rowCount: segCount });
      segStart = billDate;
      segCount = count;
    } else {
      segCount += count;
    }
    segEnd = billDate;
  }
  segments.push({ startDate: segStart, endDate: segEnd, rowCount: segCount });
  return segments;
}

// PR #50 reviewer finding F2 防御性兜底：sanitize 非法 sheet 字符（Excel 禁用 / \ * ? [ ] :）
// 主路径靠 import-repository.normalizeBillDate 归一化为 YYYY-MM-DD；本函数额外防御未来路径绕过
function sanitizeSheetName(name) {
  return String(name).replace(/[\/\\*?\[\]:]/g, '-').slice(0, 31);
}

function fmtSheetName(seg) {
  if (!seg.startDate) return '差异';
  const m1 = seg.startDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const m2 = seg.endDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m1 || !m2) return sanitizeSheetName(seg.startDate + '~' + seg.endDate);
  return `${m1[1]}-${m1[2]}-${m1[3]}~${m2[2]}-${m2[3]}`;
}

// v0.14 fix11 + fix13：单文件多 sheet 输出
//   - 差异 sheet 1..N：按账单日期切分 + 流式分批写入
//   - 末尾 sheet：「运行结果汇总」嵌入 11 区块 report
async function writeDiffWorkbook({ db, runId, monthKey, savePath, runElapsedMs = null }) {
  fs.mkdirSync(path.dirname(savePath), { recursive: true });

  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: savePath,
    useStyles: false,
    useSharedStrings: false
  });
  writer.lastModifiedBy = 'pzhong'; // Module A watermark

  // ============================================================
  // Pass 1：统计账单日期 → 贪心切分 segments
  // ============================================================
  const dateCounts = runRepo.getBillDateCounts(db, { runId });
  const segments = planSegments(dateCounts);
  const expectedTotal = dateCounts.reduce((s, d) => s + d.count, 0);

  // ============================================================
  // Pass 2：按 segment 顺序写差异 sheet
  // ============================================================
  // v2.1.15 W0：旧实现用 LIMIT 5000 OFFSET k 深分页拉数据，整月单 segment 时
  //   每批全排序 + 深 OFFSET 退化 O(N²)；改为单次游标遍历（iterateDiffRowsByDateRange），
  //   循环体逐行处理逻辑保持不变。⚠️ 资金红线：差异表输出必须逐行逐列不变（对拍兜底）。
  const segmentStats = [];
  const diffWriteT0 = Date.now();
  let totalWritten = 0;

  for (const seg of segments) {
    const sheetBaseName = fmtSheetName(seg);
    // PR #50 Codex P1：单 segment 写入时实时检测行数，超 MAX 自动开 sub-sheet 加后缀 (2)(3)
    // 触发条件：单日差异行 > MAX_DATA_ROWS_PER_SHEET（罕见 edge case）
    let sheet = writer.addWorksheet(sheetBaseName);
    sheet.addRow(WRITER_OUTPUT_HEADERS_V2.slice()).commit();
    let curSubSheetName = sheetBaseName;
    let curSubSheetRowCount = 0;
    let subSheetIndex = 1;

    let segWritten = 0;
    if (seg.rowCount > 0) {
      // v2.1.15 W0：单次游标遍历替代 LIMIT/OFFSET 深分页（行内容与 listDiffRowsByDateRange 完全一致）
      for (const d of runRepo.iterateDiffRowsByDateRange(db, {
        runId,
        startDate: seg.startDate,
        endDate: seg.endDate
      })) {
        // 当前 sub-sheet 满 MAX → commit + 开新 sub-sheet
        if (curSubSheetRowCount >= MAX_DATA_ROWS_PER_SHEET) {
          await sheet.commit();
          segmentStats.push({ sheetName: curSubSheetName, startDate: seg.startDate, endDate: seg.endDate, rowCount: curSubSheetRowCount });
          subSheetIndex++;
          const subName = sanitizeSheetName(`${sheetBaseName}(${subSheetIndex})`);
          sheet = writer.addWorksheet(subName);
          sheet.addRow(WRITER_OUTPUT_HEADERS_V2.slice()).commit();
          curSubSheetName = subName;
          curSubSheetRowCount = 0;
        }
        const rawObj = JSON.parse(d.bill_raw_json);
        // v2.1.8 N4：12 列输出（spec §三.1）
        //   1-9 模版字段 / 10 单据_对账币种副本 / 11-12 流水侧 diff_rows 字段
        const row = new Array(WRITER_OUTPUT_HEADERS_V2.length);
        for (let i = 0; i < TEMPLATE_BILL_HEADERS.length; i++) {
          const v = rawObj[TEMPLATE_BILL_HEADERS[i]];
          row[i] = v === undefined || v === null ? '' : v;
        }
        // 第 10 列：单据_对账币种（bill raw_json['对账币种'] 副本，D2=b 保留）
        row[TEMPLATE_BILL_HEADERS.length] =
          rawObj['对账币种'] === undefined || rawObj['对账币种'] === null ? '' : rawObj['对账币种'];
        // 第 11 列：流水_通道清算币种
        row[TEMPLATE_BILL_HEADERS.length + 1] = d.flow_currency === null ? '' : d.flow_currency;
        // 第 12 列：流水_通道清算金额
        row[TEMPLATE_BILL_HEADERS.length + 2] = d.flow_amount_abs === null ? '' : d.flow_amount_abs;
        sheet.addRow(row).commit();
        curSubSheetRowCount++;
        segWritten++;
      }
    }
    await sheet.commit();
    totalWritten += segWritten;
    segmentStats.push({ sheetName: curSubSheetName, startDate: seg.startDate, endDate: seg.endDate, rowCount: curSubSheetRowCount });
  }

  const diffWriteElapsedMs = Date.now() - diffWriteT0;

  // ⚠️ 资金红线 sanity check：sum(segment rows) == 预期差异总数
  if (expectedTotal > 0 && totalWritten !== expectedTotal) {
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报（资金红线 sanity check 失败 → 关键审计线索）
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'acquiring-bill-currency',
      message: '[acquiring-bill-currency] writeDiffWorkbook 行数对账失败',
      details: [
        `expected=${expectedTotal}`,
        `written=${totalWritten}`
      ]
    });
  }

  // ============================================================
  // fix13：末尾 sheet「运行结果汇总」(嵌入 11 区块 report)
  // ============================================================
  await appendSummarySheet({
    writer, db, runId, monthKey,
    runElapsedMs, diffWriteElapsedMs,
    diffFilePath: savePath,
    segmentStats
  });

  await writer.commit();
  return {
    filePath: savePath,
    rowCount: totalWritten,
    segmentCount: segments.length,
    segmentStats
  };
}

// v0.14 fix13：末尾 sheet「运行结果汇总」内嵌入 11 区块（替代原 writeReportWorkbook 独立文件）
// 用同一个 streaming WorkbookWriter 的 addWorksheet — 全 streaming 路径，单个 commit
async function appendSummarySheet({ writer, db, runId, monthKey, runElapsedMs, diffWriteElapsedMs, diffFilePath, segmentStats }) {
  const sheet = writer.addWorksheet('运行结果汇总');

  // 表头
  sheet.addRow(['项', '值']).commit();

  const addRow = (k, v) => sheet.addRow([k, v === null || v === undefined ? '' : v]).commit();
  const addHeaderRow = (title) => sheet.addRow([title, '']).commit();
  const addSpacer = () => sheet.addRow(['', '']).commit();

  // ① 基础统计（runs）
  const run = runRepo.getRunById(db, runId);
  addHeaderRow('① 基础统计 (runs)');
  addRow('run id', run.id);
  addRow('月份', run.month_key);
  addRow('运行时间', formatRanAtLocal(run.ran_at)); // fix12
  addRow('状态', run.status);
  addRow('单据总数 total_bill_rows', run.total_bill_rows);
  addRow('匹配上流水行数 matched_rows', run.matched_rows);
  addRow('币种不一致行数 mismatch_rows', run.mismatch_rows);
  addRow('未匹配单据行数 unmatched_rows', run.unmatched_rows);
  addSpacer();

  // ② 流水侧统计
  addHeaderRow('② 流水侧统计 (flow_imports)');
  const flowTotal = db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports WHERE month_key = ?`).get(monthKey).c;
  const flowDistinctId = db.prepare(`SELECT COUNT(DISTINCT recon_main_id) c FROM acquiring_bill_currency_flow_imports WHERE month_key = ?`).get(monthKey).c;
  const orphanFlow = flowTotal - run.matched_rows;
  addRow('流水总数', flowTotal);
  addRow('流水 distinct recon_main_id', flowDistinctId);
  addRow('流水多于单据行数 (orphan flow)', orphanFlow);
  addSpacer();

  // ③ 单据侧统计
  addHeaderRow('③ 单据侧统计 (bill_imports)');
  const billTotal = db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?`).get(monthKey).c;
  const billDistinctId = db.prepare(`SELECT COUNT(DISTINCT recon_main_id) c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?`).get(monthKey).c;
  addRow('单据总数', billTotal);
  addRow('单据 distinct recon_main_id', billDistinctId);
  addSpacer();

  // ④ 流水币种分布（top 20）
  addHeaderRow('④ 流水侧通道清算币种分布 (top 20)');
  const flowDist = db.prepare(`
    SELECT COALESCE(settle_currency_norm, '') AS norm, COUNT(*) c
    FROM acquiring_bill_currency_flow_imports WHERE month_key = ?
    GROUP BY norm ORDER BY c DESC LIMIT 20
  `).all(monthKey);
  for (const r of flowDist) addRow(`  flow ${r.norm || '(空)'}`, r.c);
  addSpacer();

  // ⑤ 单据币种分布（top 20）
  addHeaderRow('⑤ 单据侧对账币种分布 (top 20)');
  const billDist = db.prepare(`
    SELECT COALESCE(settle_currency_norm, '') AS norm, COUNT(*) c
    FROM acquiring_bill_currency_bill_imports WHERE month_key = ?
    GROUP BY norm ORDER BY c DESC LIMIT 20
  `).all(monthKey);
  for (const r of billDist) addRow(`  bill ${r.norm || '(空)'}`, r.c);
  addSpacer();

  // ⑥ diff_type 分布
  addHeaderRow('⑥ 差异行 diff_type 分布');
  const typeDist = db.prepare(`SELECT diff_type, COUNT(*) c FROM acquiring_bill_currency_diff_rows WHERE run_id = ? GROUP BY diff_type ORDER BY c DESC`).all(runId);
  if (typeDist.length === 0) addRow('  (无差异行)', 0);
  for (const r of typeDist) addRow(`  ${r.diff_type}`, r.c);
  addSpacer();

  // ⑦ 差异行币种对比 top 10
  addHeaderRow('⑦ 差异行币种对比 (bill_currency / flow_currency / 行数, top 10)');
  const cmpTop = db.prepare(`
    SELECT
      COALESCE(b.settle_currency, '') AS bill_cur,
      COALESCE(d.flow_currency, '') AS flow_cur,
      COUNT(*) c
    FROM acquiring_bill_currency_diff_rows d
    INNER JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    GROUP BY bill_cur, flow_cur ORDER BY c DESC LIMIT 10
  `).all(runId);
  if (cmpTop.length === 0) addRow('  (无差异行)', 0);
  for (const r of cmpTop) addRow(`  bill=${r.bill_cur || '(空)'} | flow=${r.flow_cur || '(空)'}`, r.c);
  addSpacer();

  // ⑧ 流水侧文件清单
  addHeaderRow('⑧ 流水侧文件清单 (source_file + 行数)');
  const flowFiles = db.prepare(`
    SELECT source_file, COUNT(*) c FROM acquiring_bill_currency_flow_imports
    WHERE month_key = ? GROUP BY source_file ORDER BY source_file ASC
  `).all(monthKey);
  for (const r of flowFiles) addRow(`  flow ${r.source_file}`, r.c);
  addRow(`  合计`, flowFiles.reduce((s, r) => s + r.c, 0));
  addSpacer();

  // ⑨ 单据侧文件清单
  addHeaderRow('⑨ 单据侧文件清单 (source_file + 行数)');
  const billFiles = db.prepare(`
    SELECT source_file, COUNT(*) c FROM acquiring_bill_currency_bill_imports
    WHERE month_key = ? GROUP BY source_file ORDER BY source_file ASC
  `).all(monthKey);
  for (const r of billFiles) addRow(`  bill ${r.source_file}`, r.c);
  addRow(`  合计`, billFiles.reduce((s, r) => s + r.c, 0));
  addSpacer();

  // ⑩ 性能数据（fix11 多 sheet 分布也放这里）
  addHeaderRow('⑩ 性能数据');
  if (runElapsedMs != null) addRow('run 总耗时 (ms)', runElapsedMs);
  if (diffWriteElapsedMs != null) addRow('差异表写入耗时 (ms)', diffWriteElapsedMs);
  if (diffFilePath) addRow('差异表路径', diffFilePath);
  if (Array.isArray(segmentStats) && segmentStats.length > 0) {
    addRow('差异 sheet 数量', segmentStats.length);
    for (const s of segmentStats) {
      addRow(`  sheet ${s.sheetName}`, s.rowCount);
    }
  }
  addSpacer();

  // ⑪ 元信息
  addHeaderRow('⑪ 元信息');
  addRow('app 版本', pkg.version);
  addRow('git short SHA', buildInfo.commit || 'dev');
  addRow('生成时间', formatRanAtLocal(new Date().toISOString()));
  addRow('作者', pkg.author && pkg.author.name ? pkg.author.name : 'pzhong');

  await sheet.commit();
}

// v0.14 fix13：保留导出函数签名 + 调用关系兼容（caller 仍可调）
// 内部行为变更：不再独立生成 report.xlsx；写到 diff xlsx 末尾 sheet「运行结果汇总」
// 旧 caller（如果有）会得到 filePath = diff 路径
async function writeReportWorkbook({ db, runId, monthKey, savePath, runElapsedMs, diffWriteElapsedMs, diffFilePath }) {
  // v0.14 fix13：legacy stub — report 已嵌入 diff 末尾，独立 report.xlsx 不再生成
  // 保留函数避免 caller 直接调用报错；返回的 filePath 指向 diff 文件（向后兼容 IPC 出参 reportFilePath）
  return { filePath: diffFilePath || savePath };
}

function planRunOutputPaths({ monthKey, storageRoot, date = new Date() }) {
  const outputDir = buildOutputDir(storageRoot, date);
  const ts = buildTimestamp(date);
  const diffFileName = `acquiring-bill-currency-${monthKey}-diff-${ts}.xlsx`;
  const diffSavePath = path.join(outputDir, diffFileName);
  return {
    diffFilePath: diffSavePath,
    reportFilePath: diffSavePath
  };
}

// fix5 + fix13：跑 run 时同步产出 diff（含末尾 summary sheet）；返回路径
async function writeRunOutputs({
  db,
  runId,
  monthKey,
  storageRoot,
  runElapsedMs,
  outputIntent = null
}) {
  const planned = outputIntent || planRunOutputPaths({ monthKey, storageRoot });
  const diffSavePath = path.resolve(String(planned.diffFilePath || ''));
  if (!diffSavePath) throw new Error('收单差异输出缺少冻结目标路径');

  const diffResult = await writeDiffWorkbook({
    db, runId, monthKey,
    savePath: diffSavePath,
    runElapsedMs
  });

  return {
    diffFilePath: diffResult.filePath,
    diffRowCount: diffResult.rowCount,
    segmentCount: diffResult.segmentCount,
    segmentStats: diffResult.segmentStats,
    // v0.14 fix13：reportFilePath 兼容字段 = diff 文件（嵌入了末尾 sheet）
    reportFilePath: diffResult.filePath,
    diffWriteElapsedMs: diffResult.diffWriteElapsedMs || null
  };
}

module.exports = {
  writeDiffWorkbook,
  writeReportWorkbook,
  writeRunOutputs,
  planRunOutputPaths,
  buildOutputDir,
  buildReportDir,
  formatRanAtLocal,
  planSegments,
  fmtSheetName,
  MAX_DATA_ROWS_PER_SHEET
};
