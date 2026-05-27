// SR-backup-1 (v2.1.9)：sqlite 数据库安全备份 API
// 取代 v2.1.8 N4 的 fs.copyFileSync（大库阻塞 / WAL 不一致 / 失败无回滚 三大隐患）
//
// 实施方案：VACUUM INTO（POC 2026-05-27 验证 node:sqlite DatabaseSync 不带 .backup() 方法 → 用 VACUUM INTO 替代）
// 优点：(1) SQLite 内部原子写 (2) WAL 安全 (3) 备份过程库可读不锁写 (4) 文件大小可能更小（顺带 VACUUM 整理）

const fs = require('fs');
const path = require('path');

// label 字符白名单 — 防 SQL 注入 + 防文件名特殊字符
const SAFE_LABEL_RE = /^[A-Za-z0-9_-]+$/;

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createBackup(db, label, backupDir) {
  if (!db || typeof db.exec !== 'function') {
    throw new Error('createBackup: db 必须是 DatabaseSync 实例（带 exec 方法）');
  }
  if (!label || typeof label !== 'string' || !SAFE_LABEL_RE.test(label)) {
    throw new Error(`createBackup: label 必须仅含 [A-Za-z0-9_-]，收到 "${label}"`);
  }
  if (!backupDir || typeof backupDir !== 'string') {
    throw new Error('createBackup: 缺少 backupDir');
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = formatTimestamp();
  const fileName = `tool-data-bak-${label}-${timestamp}.sqlite`;
  const destPath = path.join(backupDir, fileName);
  const tmpPath = `${destPath}.tmp`;

  // 清理前次失败可能残留的 tmp（理论上 atomic rename 后不会存在）
  if (fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  try {
    const escapedTmp = tmpPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedTmp}'`);
    fs.renameSync(tmpPath, destPath);
    return destPath;
  } catch (e) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw new Error(`createBackup 失败 (label=${label}): ${e && e.message ? e.message : e}`);
  }
}

module.exports = {
  createBackup,
  formatTimestamp,
};
