'use strict';

// v3.2.22 B45：网银多模板分组生成的写出记录。每个路径首次写入前记下原状态（已存在的复制原内容到批次临时目录，
//   不存在的记为新建）；任一组或合并失败时按逆序还原——原有文件按原内容写回同一路径（原地覆盖，保留文件身份：
//   余额种子的人工补录保护按 dev + ino 识别种子文件），新建的文件删除；成功时只清理临时目录。
//   只覆盖本批写出的明细 / 余额 / 合并文件与余额种子文件；进程在批次中途退出时不能还原（与修复前相同）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createStatementOutputJournal({ fsImpl = fs, stagingRoot = os.tmpdir() } = {}) {
  const entries = [];
  const recorded = new Set();
  let backupDirectory = null;

  function record(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (recorded.has(resolved)) return;
    let stat = null;
    try {
      stat = fsImpl.lstatSync(resolved);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    // 不是普通文件（目录、链接等）时写出本身会失败或不属于本模块产物：不备份也不在回滚时删除
    if (stat && !stat.isFile()) {
      recorded.add(resolved);
      return;
    }
    if (stat) {
      if (!backupDirectory) backupDirectory = fsImpl.mkdtempSync(path.join(stagingRoot, 'statement-rollback-'));
      const backupPath = path.join(backupDirectory, String(entries.length));
      fsImpl.copyFileSync(resolved, backupPath);
      entries.push({ filePath: resolved, existed: true, backupPath });
    } else {
      entries.push({ filePath: resolved, existed: false });
    }
    recorded.add(resolved);
  }

  function cleanup() {
    if (!backupDirectory) return;
    try {
      fsImpl.rmSync(backupDirectory, { recursive: true, force: true });
    } catch (_error) {
      // 临时目录清理失败不影响结果；系统临时目录由操作系统回收
    }
    backupDirectory = null;
  }

  // 返回未能还原的路径（含原因）；调用方把它们附在原错误上，不覆盖原错误
  function rollback() {
    const failures = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.existed) {
          fsImpl.writeFileSync(entry.filePath, fsImpl.readFileSync(entry.backupPath));
        } else {
          fsImpl.rmSync(entry.filePath, { force: true });
        }
      } catch (error) {
        failures.push({ filePath: entry.filePath, message: error && error.message ? error.message : String(error) });
      }
    }
    entries.length = 0;
    recorded.clear();
    // 有还原失败时保留备份，便于人工恢复
    if (!failures.length) cleanup();
    return { failures, backupDirectory: failures.length ? backupDirectory : null };
  }

  function commit() {
    entries.length = 0;
    recorded.clear();
    cleanup();
  }

  return { record, rollback, commit };
}

module.exports = { createStatementOutputJournal };
