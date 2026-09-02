'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function assertXlsxOutputPath(outputPath) {
  const resolved = path.resolve(String(outputPath || ''));
  if (path.extname(resolved).toLowerCase() !== '.xlsx') {
    throw new Error('导出路径必须为 .xlsx 文件');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function writeXlsxAtomically({ outputPath, writeStaged, validateStaged, beforePublish }) {
  if (typeof writeStaged !== 'function') throw new TypeError('缺少临时文件写入函数');
  const destination = assertXlsxOutputPath(outputPath);
  const token = crypto.randomUUID();
  const stagedPath = `${destination}.${token}.tmp`;
  const backupPath = `${destination}.${token}.bak`;
  let backedUp = false;
  try {
    await writeStaged(stagedPath);
    if (!fs.existsSync(stagedPath)) throw new Error('导出临时文件未生成');
    if (typeof validateStaged === 'function') await validateStaged(stagedPath);
    if (typeof beforePublish === 'function') await beforePublish(stagedPath);
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backupPath);
      backedUp = true;
    }
    fs.renameSync(stagedPath, destination);
    if (backedUp && fs.existsSync(backupPath)) {
      try { fs.unlinkSync(backupPath); } catch (_cleanupError) { /* published */ }
    }
    return destination;
  } catch (error) {
    if (error.preserveTemporaryFiles !== true && fs.existsSync(stagedPath)) {
      try { fs.unlinkSync(stagedPath); } catch (_cleanupError) { /* restore below */ }
    }
    if (backedUp && fs.existsSync(backupPath) && !fs.existsSync(destination)) {
      try {
        fs.renameSync(backupPath, destination);
      } catch (restoreError) {
        error.detailLines = [
          ...(Array.isArray(error.detailLines) ? error.detailLines : []),
          `旧文件自动恢复失败，备份仍保留在：${backupPath}`,
          restoreError && restoreError.message ? restoreError.message : String(restoreError)
        ];
      }
    }
    throw error;
  }
}

module.exports = {
  assertXlsxOutputPath,
  writeXlsxAtomically
};
