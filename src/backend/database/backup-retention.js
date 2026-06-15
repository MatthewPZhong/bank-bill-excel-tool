// v3.0.5 PR-2（Part B Phase 0 / B-D8）：备份保留策略
//
// 背景（spec size-startup-optimization §B.1 / PRD v3.0.5 §5.2）：
//   - 一次性迁移备份（SR-backup-1 createBackupFn，VACUUM INTO）落 {userData}/backups/，**无数量上限**；
//     本机实测 backups/ 31GB + 根目录 tool-data.sqlite.bak-20260608 15GB 失控。
//   - B-D8 拍板：合并为一个池子，mtime 降序排序，保留最近 2 份，其余删除；逐文件记 activity log。
//
// 设计原则（资金红线 — 删用户数据动作）：
//   1. 删除白名单基于实际命名规则（见 backup.js createBackup：tool-data-bak-{label}-{timestamp}.sqlite）
//      + 旧格式根目录 tool-data.sqlite.bak-*（v2.1.8 之前 / 外部产生的备份）。
//   2. **绝不**匹配主库本体（tool-data.sqlite / tool-data-pending.sqlite）及 -wal / -shm 旁文件。
//   3. 模式匹配不上的未知文件一律不动（白名单而非黑名单）。
//   4. 选取待删清单做成纯函数（输入元数据数组 → 输出待删清单），便于单测；副作用（扫描/删除）隔离在调用方。

const path = require('node:path');

// backups/ 目录下的新格式备份：tool-data-bak-{label}-{timestamp}.sqlite
//   - label 受 backup.js SAFE_LABEL_RE 约束为 [A-Za-z0-9_-]；timestamp 为 YYYYMMDDTHHMMSS
//   - 用宽松前缀 + .sqlite 后缀匹配（不强校验 timestamp 段，容忍历史 label 变体）
const NEW_FORMAT_BACKUP_RE = /^tool-data-bak-.+\.sqlite$/;

// 根目录旧格式备份：tool-data.sqlite.bak-*（如 tool-data.sqlite.bak-20260608）
//   - 关键：前缀是 "tool-data.sqlite.bak-"，与旁文件 "tool-data.sqlite-wal" / "tool-data.sqlite-shm"
//     （中间是 "-wal"/"-shm" 而非 ".bak-"）天然区分，绝不会误匹配。
const OLD_FORMAT_BACKUP_RE = /^tool-data\.sqlite\.bak-.+$/;

// 绝对禁止触碰的文件名（双保险：即便正则意外命中也拦下）
const PROTECTED_FILE_NAMES = new Set([
  'tool-data.sqlite',
  'tool-data.sqlite-wal',
  'tool-data.sqlite-shm',
  'tool-data-pending.sqlite',
  'tool-data-pending.sqlite-wal',
  'tool-data-pending.sqlite-shm',
]);

// 判断某文件名是否属于「受管理的可清理备份」白名单。
//   - 命中受保护本体/旁文件 → false（双保险）
//   - 命中新格式或旧格式备份 → true
//   - 其余（未知文件）→ false
function isManagedBackupFile(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) return false;
  if (PROTECTED_FILE_NAMES.has(fileName)) return false;
  return NEW_FORMAT_BACKUP_RE.test(fileName) || OLD_FORMAT_BACKUP_RE.test(fileName);
}

// 纯函数：从备份文件元数据数组中选出待删清单。
//   入参 entries：[{ filePath, fileName, mtimeMs, size }]（filePath 绝对路径；mtimeMs 数值；size 字节）
//   - 先按白名单过滤（防御：调用方应已过滤，这里再兜一层）
//   - 合并为单一池子，按 mtimeMs 降序（最新在前）排序；mtimeMs 相等时按 fileName 降序兜底稳定排序
//   - 保留最近 keep 份，其余进入待删清单
//   返回：待删清单（与入参同结构的元素数组）
function selectBackupsToDelete(entries, options = {}) {
  const keep = Number.isInteger(options.keep) && options.keep >= 0 ? options.keep : 2;
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const managed = entries.filter(
    (entry) => entry && typeof entry.fileName === 'string' && isManagedBackupFile(entry.fileName)
  );
  if (managed.length <= keep) return [];

  const sorted = [...managed].sort((a, b) => {
    const am = Number(a.mtimeMs) || 0;
    const bm = Number(b.mtimeMs) || 0;
    if (bm !== am) return bm - am; // mtime 降序：最新在前
    // mtime 相等：按文件名降序兜底，保证排序稳定可预测
    return String(b.fileName).localeCompare(String(a.fileName));
  });

  return sorted.slice(keep);
}

// 副作用辅助：扫描 backups/ 目录 + 根目录，收集受管理备份文件的元数据数组。
//   注入 fsModule（默认 node:fs）便于单测；目录不存在/读不到 → 跳过该来源，不抛错。
function collectManagedBackupEntries({ backupsDir, rootDir, fsModule }) {
  const fs = fsModule || require('node:fs');
  const entries = [];

  const scanDir = (dir) => {
    if (!dir) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_e) {
      return; // 目录不存在或不可读 → 视为无备份
    }
    for (const name of names) {
      if (!isManagedBackupFile(name)) continue;
      const filePath = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_e) {
        continue; // 取不到 stat（并发删除等）→ 跳过
      }
      if (!stat.isFile()) continue;
      entries.push({
        filePath,
        fileName: name,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  };

  scanDir(backupsDir);
  // 根目录旧格式只匹配 OLD_FORMAT_BACKUP_RE；与 backups/ 内文件合并为同一池子（B-D8）
  if (rootDir && rootDir !== backupsDir) {
    scanDir(rootDir);
  }

  return entries;
}

module.exports = {
  isManagedBackupFile,
  selectBackupsToDelete,
  collectManagedBackupEntries,
  NEW_FORMAT_BACKUP_RE,
  OLD_FORMAT_BACKUP_RE,
  PROTECTED_FILE_NAMES,
};
