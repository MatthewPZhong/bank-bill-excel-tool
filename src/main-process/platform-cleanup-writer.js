// v2.1.16-beta.2 R5 场景3：中台加款单剔除文件 writer
//
// 职责：
//   writePlatformCleanupOutput(cleanupRows, savePath)
//     → 写到 caller 指定的绝对路径 savePath（落位/兜底由 caller bank-statement:export handler 决定）
//     → 单 sheet（名 'Sheet1'）：第 1 行 CLEANUP_TEMPLATE_HEADERS（15 列，加粗 size10）
//        其后每行按 CLEANUP_TEMPLATE_HEADERS.map(h => row[h]) 投影（列顺序单一真相 = 常量）
//     → applyWatermark（与 scenario-hit-rows-writer 一致：lastModifiedBy='pzhong'）
//     → atomic write：tmp 文件 + rename（防半文件，与 hit-rows-writer 一致）
//     → 失败抛 Error；caller 负责 try-catch + graceful（剔除文件写失败不阻塞主对账流程）
//
// 列结构（CLEANUP_TEMPLATE_HEADERS 单一真相，见 constants/platform-cleanup-template-fields.js）：
//   A 加款单号 / B 附言（剔除模板专属）+ C~O（13 列，表头与银行对账单同名，已由引擎拷贝银行行字段）

const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');

const { CLEANUP_TEMPLATE_HEADERS } = require('../constants/platform-cleanup-template-fields');
const { applyWatermark } = require('./workbook-watermark');

// sheet 名（剔除模板单 sheet，与模板 assets/中台加款单剔除模板.xlsx 一致）
const CLEANUP_SHEET_NAME = 'Sheet1';

// writePlatformCleanupOutput
//   入参：
//     cleanupRows: Array<row>（R5 场景3 buildCleanupRow 产出，每行含 CLEANUP_TEMPLATE_HEADERS 全部 15 键）
//     savePath: string（剔除文件绝对路径，由 caller 决定落位：主输出同目录 / exportRootDir 日期目录）
//   返回：{ filePath, fileName }
//   行为：
//     - cleanupRows 为空数组 → 仍输出含表头空 sheet（caller 已保证仅 length>0 才调本 writer）
//     - 缺某列 → 投影为 ''（防御性，避免 undefined 写入；正常引擎产出 15 键齐全）
//     - atomic write：tmp 文件 + rename
//     - 异常抛 Error；caller 负责 graceful（不阻塞主流程）
async function writePlatformCleanupOutput(cleanupRows, savePath) {
  if (!Array.isArray(cleanupRows)) {
    throw new Error('writePlatformCleanupOutput: cleanupRows 必须是数组');
  }
  if (!savePath || typeof savePath !== 'string') {
    throw new Error('writePlatformCleanupOutput: 需提供 savePath（剔除文件绝对路径）');
  }

  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const finalPath = savePath;
  const tmpPath = `${finalPath}.tmp`;

  // 构造 workbook + sheet
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(CLEANUP_SHEET_NAME);

  // 表头：15 列（CLEANUP_TEMPLATE_HEADERS 单一真相），加粗 size10（与 hit-rows-writer 一致）
  sheet.addRow(CLEANUP_TEMPLATE_HEADERS.slice());
  sheet.getRow(1).font = { bold: true, size: 10 };

  // 数据行：按 CLEANUP_TEMPLATE_HEADERS 顺序投影（缺列 → ''）
  for (const row of cleanupRows) {
    const values = CLEANUP_TEMPLATE_HEADERS.map((h) => (row && row[h] !== undefined && row[h] !== null ? row[h] : ''));
    sheet.addRow(values);
  }

  applyWatermark(workbook);

  // atomic write：先写 tmp 再 rename（不留半文件，与 scenario-hit-rows-writer 一致）
  try {
    await workbook.xlsx.writeFile(tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    // 清理 tmp（best-effort，失败忽略）
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw new Error(`writePlatformCleanupOutput 失败（path=${finalPath}）: ${e.message}`);
  }

  return {
    filePath: finalPath,
    fileName: path.basename(finalPath)
  };
}

module.exports = {
  writePlatformCleanupOutput,
  CLEANUP_SHEET_NAME
};
