// v2.1.3 T4 — 业务OP数据核对：差异表 writer + 失败报告 writer
// 用 exceljs（复用 v2.1.2 范式）
//
// 差异表（spec §6.1 / §6.2）：
//   - 单日导出：1 文件 1 sheet（sheet 名 = 日期 ISO 'YYYY-MM-DD'，#14 拍板 A）
//   - 区间导出：1 文件 1 sheet（v2.1.3-fix6 拍板回滚：原多 sheet 按日期拆分 → 改单 sheet 合并；
//     依靠第 1 列 Billdate 区分日期）；sheet 名固定「差异」
//     行排序：data_date 升序 + 同日内 account_no 升序
//   - 表头 = 23 列业务 OP + 4 列尾巴（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）
//   - v2.1.3-fix2.4：差异表不再标黄（拍板回滚 #10）；差异类型仍写入 4 个 meta 字段，仅不染色
//
// 失败报告（spec §6.3，#5 拍板）：
//   - 业务 OP 失败报告：原 23 列 + 失败行号 + 失败原因 = 25 列；落 error-reports/{date}/
//   - 流水失败报告：原 28 列 + 失败行号 + 失败原因 = 30 列
//   - 失败报告保留黄底（与差异表无关，v2.1.3-fix2.4 范围外）

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const importsRepository = require('../backend/biz-op-recon-db/imports-repository');
const runRepository = require('../backend/biz-op-recon-db/run-repository');
const {
  BIZ_OP_HEADERS,
  BIZ_OP_DB_COLUMNS,
  bizOpRowToArray,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS,
  flowRowToArray,
  DIFF_HEADER_TAIL,
  ERROR_HEADER_TAIL
} = require('../backend/biz-op-recon-db/columns');

const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// 单日差异表导出（spec §6.1，#9 / #10 / #14 拍板）
// 入参：{ db, date, buName, runId, savePath }
// 返回：{ filePath, rowCount }
async function writeSingleDateDiffWorkbook({ db, date, buName, runId, savePath }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);  // #14 拍板 A：sheet 名 = 'YYYY-MM-DD'

  // 表头：23 列业务 OP + 4 新增字段
  sheet.addRow([...BIZ_OP_HEADERS, ...DIFF_HEADER_TAIL]);
  sheet.getRow(1).font = { bold: true, size: 10 };

  const diffRows = runRepository.getDiffRowsByRun(db, runId);
  let outputRowCount = 0;
  for (const dr of diffRows) {
    // 源行：T1 → biz_op_recon_imports.id=source_row_id；T2 → 同表，data_date 为 T-2
    const sourceRow = importsRepository.getRowById(db, dr.source_row_id);
    if (!sourceRow) continue;  // 数据不一致时跳过；不抛错避免阻断整表
    const rowData = bizOpRowToArray(sourceRow).concat([dr.cmp_t2, dr.multi_op_flag, dr.cmp_amount, dr.amount_diff]);
    sheet.addRow(rowData);
    // v2.1.3-fix2.4：差异表不再标黄（拍板回滚 #10）；4 个 meta 字段已写入足以识别差异
    outputRowCount += 1;
  }

  // 若没有差异行，仍保留单 sheet + 表头（保持输出一致性，与 v2.1.2 风格一致）
  await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath, rowCount: outputRowCount };
}

// 区间差异表导出（spec §6.2，v2.1.3-fix6 拍板回滚：单 sheet 合并）
// 入参：{ db, buName, startDate, endDate, savePath }
// 返回：{ filePath, sheetCount, rowCount, skippedDates }
//   sheetCount：合并后固定为 1（有数据时）/ 0（无数据，仅占位 sheet）；保留字段用于调用方兼容
//   rowCount：合并后差异数据行总数（不含表头）
// 行序：data_date 升序 → 同日内 account_no 升序（拍板）
// 日期区分：依靠第 1 列 Billdate；若 Billdate 与 data_date 不一致仅在 console.warn 记录，
//          不弹 UI、不阻断导出（仅协助 debug）
async function writeDateRangeDiffWorkbook({ db, buName, startDate, endDate, savePath }) {
  const workbook = new ExcelJS.Workbook();

  const successDates = runRepository.listSuccessDatesInRange(db, buName, startDate, endDate);
  const successDateSet = new Set(successDates.map(s => s.date));
  const allDatesInRange = listDatesInRange(startDate, endDate);
  const skippedDates = allDatesInRange.filter(d => !successDateSet.has(d));

  // 1) 收集所有 success 日期下的差异行 + 来源行，连同 data_date 一起携带（仅用于排序与告警，
  //    不写入 sheet 任何额外列）
  const collected = [];
  for (const { date, runId } of successDates) {
    const diffRows = runRepository.getDiffRowsByRun(db, runId);
    for (const dr of diffRows) {
      const sourceRow = importsRepository.getRowById(db, dr.source_row_id);
      if (!sourceRow) continue;  // 数据不一致时跳过；不抛错避免阻断整表
      collected.push({ dr, sourceRow, dataDate: date });
    }
  }

  // 2) 排序：data_date 升序 → account_no 升序
  collected.sort((a, b) => {
    if (a.dataDate !== b.dataDate) return a.dataDate < b.dataDate ? -1 : 1;
    const ak = String(a.sourceRow.account_no || '');
    const bk = String(b.sourceRow.account_no || '');
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
  });

  // 3) 写入单 sheet（v2.1.3-fix6）
  if (collected.length > 0) {
    const sheet = workbook.addWorksheet('差异');  // 固定 sheet 名（拍板）
    sheet.addRow([...BIZ_OP_HEADERS, ...DIFF_HEADER_TAIL]);
    sheet.getRow(1).font = { bold: true, size: 10 };

    for (const { dr, sourceRow, dataDate } of collected) {
      const rowData = bizOpRowToArray(sourceRow).concat([dr.cmp_t2, dr.multi_op_flag, dr.cmp_amount, dr.amount_diff]);
      sheet.addRow(rowData);
      // v2.1.3-fix2.4：差异表不再标黄（拍板回滚 #10）

      // Billdate vs data_date 一致性检查（仅 console.warn，便于 debug；不阻断导出）
      const billdateISO = normalizeDateToISO(sourceRow.bill_date_raw);
      if (billdateISO && billdateISO !== dataDate) {
        // eslint-disable-next-line no-console
        console.warn(
          `[biz-op-recon-writer] data_date=${dataDate} vs Billdate=${billdateISO} 不一致 ` +
          `acc=${sourceRow.account_no || ''} bu=${sourceRow.bu_name || buName}`
        );
      }
    }
  } else {
    // 无任何差异数据：放占位 sheet 让文件可读
    const placeholder = workbook.addWorksheet('无差异数据');
    placeholder.addRow(['区间内未发现任何成功对账记录，无差异数据可导出']);
  }

  await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
  await workbook.xlsx.writeFile(savePath);
  return {
    filePath: savePath,
    sheetCount: collected.length > 0 ? 1 : 0,
    rowCount: collected.length,
    skippedDates
  };
}

// 归一化任意日期表示（Excel 串/字符串）为 ISO 'YYYY-MM-DD'；失败返回 null
// 仅供 fix6 一致性告警使用，不影响 DB 落库
function normalizeDateToISO(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // 已经是 ISO 'YYYY-MM-DD'（最常见，reader 在 v2.1.2 范式下大多已归一）
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 'YYYY/M/D' 或 'YYYY/MM/DD'
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // 'YYYYMMDD'
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 兜底：Date 解析（处理含时分秒、跨语言月份等情况）
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${dy}`;
  }
  return null;
}

// 列出区间内所有日期 [start, end] inclusive
function listDatesInRange(startDate, endDate) {
  const result = [];
  // 用 UTC 避免时区抢跑
  let d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d.getTime() <= end.getTime()) {
    result.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return result;
}

// 业务 OP 失败报告（spec §6.3，#5 拍板）
// 入参：{ date, buName, errorRows, saveDir, fileName }
//   errorRows: [{ rowIndex, reason, rawRow }]
// 返回：savePath
async function writeBizOpErrorReportXlsx({ date, buName, errorRows, saveDir, fileName }) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const savePath = path.join(saveDir, fileName);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);

  // 表头：原 23 列 + 失败行号 + 失败原因
  sheet.addRow([...BIZ_OP_HEADERS, ...ERROR_HEADER_TAIL]);
  sheet.getRow(1).font = { bold: true, size: 10 };

  for (const e of errorRows) {
    const rowArray = e.rawRow ? bizOpRowToArray(e.rawRow) : BIZ_OP_DB_COLUMNS.map(() => '');
    const rowData = rowArray.concat([e.rowIndex || '', e.reason || '']);
    const r = sheet.addRow(rowData);
    // 失败报告与差异表风格一致：整行黄底
    r.eachCell((cell) => { cell.fill = YELLOW_FILL; });
  }

  await workbook.xlsx.writeFile(savePath);
  return savePath;
}

// 流水失败报告（spec §6.3）
// 入参：{ date, errorRows, saveDir, fileName }
//   errorRows: [{ rowIndex, reason, rawRow }]
// 返回：savePath
async function writeFlowErrorReportXlsx({ date, errorRows, saveDir, fileName }) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const savePath = path.join(saveDir, fileName);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);

  sheet.addRow([...FLOW_HEADERS, ...ERROR_HEADER_TAIL]);
  sheet.getRow(1).font = { bold: true, size: 10 };

  for (const e of errorRows) {
    const rowArray = e.rawRow ? flowRowToArray(e.rawRow) : FLOW_DB_COLUMNS.map(() => '');
    const rowData = rowArray.concat([e.rowIndex || '', e.reason || '']);
    const r = sheet.addRow(rowData);
    r.eachCell((cell) => { cell.fill = YELLOW_FILL; });
  }

  await workbook.xlsx.writeFile(savePath);
  return savePath;
}

module.exports = {
  writeSingleDateDiffWorkbook,
  writeDateRangeDiffWorkbook,
  writeBizOpErrorReportXlsx,
  writeFlowErrorReportXlsx,
  YELLOW_FILL,
  // 内部 helper 导出便于测试
  listDatesInRange,
  normalizeDateToISO
};
