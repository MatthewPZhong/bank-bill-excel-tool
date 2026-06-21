// v2.1.16-beta.4 ③ R5 场景4：中台退款订单回填文件 writer（🔴 资金红线）
//
// 职责：
//   writeRefundBackfillOutput(backfillRows, unmatchedRows, savePath)
//     → 写到 caller 指定的绝对路径 savePath（落位/兜底由 caller bank-statement:export handler 决定）
//     → 同一 workbook 两个 sheet：
//        sheet1「回填模板」：第 1 行 REFUND_TEMPLATE_HEADERS（v3.0.10：33 列 = 固定 6 + 银行 12 + 中台 15，加粗 size10）
//           其后每行按 REFUND_TEMPLATE_HEADERS.map(h => row[h] ?? '') 投影（列顺序单一真相 = 常量）
//           v3.0.10 需求3.1：命中字段标黄——按 row._matchedColumns（引擎单点过滤后的 sheet1 列）给对应单元格填黄（列偏移 i+1，无前导列）。
//        sheet2「未匹配报错」：第 1 行 UNMATCHED_HEADERS（v3.0.10：13 列 = REFUND_BANK_COLUMNS 12 列 + 报错/提示信息）。
//           只承接银行未匹配行（①形状 { ...REFUND_BANK_COLUMNS 12 列, 报错/提示信息 }）——报错/提示靠「报错/提示信息」前缀【报错】/【提示】区分；
//           refund-only 提示行（旧②形状，仅退款单号）已在引擎侧静默删除，sheet2 不再有该类行。按 key 投影，缺 key → ''。
//     → applyWatermark（与 platform-cleanup-writer 一致：lastModifiedBy='pzhong'）
//     → atomic write：tmp 文件 + rename（防半文件，与 platform-cleanup-writer 一致）
//     → 失败抛 Error；caller 负责 try-catch + graceful（回填文件写失败不阻塞主对账流程）
//
// 严格照搬 platform-cleanup-writer.js（单 sheet）+ bank-bu-recon-writer.js（多 sheet）的 ExcelJS 范式。

const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');

const {
  REFUND_TEMPLATE_HEADERS,
  REFUND_BANK_COLUMNS
} = require('../constants/refund-backfill-fields');
const { applyWatermark } = require('./workbook-watermark');

// sheet 名（双 sheet：回填模板 + 未匹配报错）
const BACKFILL_SHEET_NAME = '回填模板';
const UNMATCHED_SHEET_NAME = '未匹配报错';

// v3.0.10 需求3.1：sheet1 命中字段标黄填充。字面与 exceljs-writer.js:24-28 一致（单一真相在彼，此处就地复制避免跨 main-process 模块耦合）。
const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// sheet2 表头（v3.0.10 需求3.2：删「结果类型」+「退款单号」两列；银行段随 REFUND_BANK_COLUMNS 10→12 → 共 13 列）。
//   报错/提示区分并入「报错/提示信息」文案前缀（【报错】/【提示】，引擎 buildUnmatchedBankRow 单点加）；
//   refund-only 提示行（②形状，仅退款单号）已在引擎侧静默删除，故 sheet2 只剩银行未匹配行（①形状）：
//   REFUND_BANK_COLUMNS 12 列（含 Extra Information / Payment Detail / Drawee Name）+「报错/提示信息」1 列；按 key 投影，缺 key → ''。
const UNMATCHED_HEADERS = Object.freeze([
  ...REFUND_BANK_COLUMNS,
  '报错/提示信息'
]);

// 按表头数组对一行对象投影：缺/空 → ''（防御性，避免 undefined / null 写入）
function projectRow(headers, row) {
  return headers.map((h) => (row && row[h] !== undefined && row[h] !== null ? row[h] : ''));
}

// writeRefundBackfillOutput
//   入参：
//     backfillRows: Array<row>（R5 场景4 buildBackfillRow 产出，每行含 REFUND_TEMPLATE_HEADERS 33 键）
//     unmatchedRows: Array<row>（两类异构行；详见文件头）
//     savePath: string（回填文件绝对路径，由 caller 决定落位）
//   返回：{ filePath, fileName }
//   行为：
//     - backfillRows / unmatchedRows 为空数组 → 仍输出含表头空 sheet（输出结构一致）
//     - 缺某列 → 投影为 ''（防御性）
//     - atomic write：tmp 文件 + rename
//     - 异常抛 Error；caller 负责 graceful（不阻塞主流程）
async function writeRefundBackfillOutput(backfillRows, unmatchedRows, savePath) {
  if (!Array.isArray(backfillRows)) {
    throw new Error('writeRefundBackfillOutput: backfillRows 必须是数组');
  }
  if (!Array.isArray(unmatchedRows)) {
    throw new Error('writeRefundBackfillOutput: unmatchedRows 必须是数组');
  }
  if (!savePath || typeof savePath !== 'string') {
    throw new Error('writeRefundBackfillOutput: 需提供 savePath（回填文件绝对路径）');
  }

  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const finalPath = savePath;
  const tmpPath = `${finalPath}.tmp`;

  const workbook = new ExcelJS.Workbook();

  // —— sheet1「回填模板」：表头 33 列（REFUND_TEMPLATE_HEADERS 单一真相），加粗 size10；命中字段标黄（v3.0.10 需求3.1）——
  const backfillSheet = workbook.addWorksheet(BACKFILL_SHEET_NAME);
  backfillSheet.addRow(REFUND_TEMPLATE_HEADERS.slice());
  backfillSheet.getRow(1).font = { bold: true, size: 10 };
  for (const row of backfillRows) {
    const r = backfillSheet.addRow(projectRow(REFUND_TEMPLATE_HEADERS, row));
    // v3.0.10 需求3.1：命中字段标黄。row._matchedColumns（引擎单点过滤后的 sheet1 列数组，仿 exceljs-writer.js:298-304）。
    //   🔴 列偏移 i+1：退款 sheet1 第 1 列即 REFUND_TEMPLATE_HEADERS[0]（无前导列）；对照主报告 sheet2 用 colIdx+2（有「命中明细」前导列）——不可照抄。
    const m = row && row._matchedColumns;
    if (m && m.length) {
      REFUND_TEMPLATE_HEADERS.forEach((h, i) => {
        if (m.includes(h)) r.getCell(i + 1).fill = YELLOW_FILL;
      });
    }
  }

  // —— sheet2「未匹配报错」：13 列（v3.0.10：删「结果类型」+「退款单号」，银行段 10→12），只承接银行未匹配行 ——
  const unmatchedSheet = workbook.addWorksheet(UNMATCHED_SHEET_NAME);
  unmatchedSheet.addRow(UNMATCHED_HEADERS.slice());
  unmatchedSheet.getRow(1).font = { bold: true, size: 10 };
  for (const row of unmatchedRows) {
    unmatchedSheet.addRow(projectRow(UNMATCHED_HEADERS, row));
  }

  applyWatermark(workbook);

  // atomic write：先写 tmp 再 rename（不留半文件，与 platform-cleanup-writer 一致）
  try {
    await workbook.xlsx.writeFile(tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    // 清理 tmp（best-effort，失败忽略）
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw new Error(`writeRefundBackfillOutput 失败（path=${finalPath}）: ${e.message}`);
  }

  return {
    filePath: finalPath,
    fileName: path.basename(finalPath)
  };
}

module.exports = {
  writeRefundBackfillOutput,
  BACKFILL_SHEET_NAME,
  UNMATCHED_SHEET_NAME,
  UNMATCHED_HEADERS
};
