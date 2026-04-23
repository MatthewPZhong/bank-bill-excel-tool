// Pending 模块 session 层：spawn worker + 事件路由 + 留底 + 报错缓存
// 由 main.js 创建单例，注入 getPendingDb / getStorageRoot

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const PENDING_COLUMNS = require('../backend/pending-db/columns');
const monthRepo = require('../backend/pending-db/month-repository');

const WORKER_SCRIPT = path.resolve(__dirname, '../backend/pending-import/worker.js');
const NODE_MAX_OLD_SPACE_MB = 8192;

// Electron 下必须用 utilityProcess.fork（真正的 Node.js 子进程），否则：
//   - spawn(process.execPath) 启动 Electron helper，--max-old-space-size 失效，heap 限制 ~1GB
//   - 121 万行 × 31 列 ExcelJS 读取必 OOM（实测 @ 1047MB）
// 纯 Node 运行（测试脚本下）require('electron') 会失败，fallback 到 spawn。
let electronUtilityProcess = null;
try {
  electronUtilityProcess = require('electron').utilityProcess;
} catch (_err) {
  // 非 Electron 运行时；保持 spawn 兜底
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createPendingSession({ getPendingDb, getStorageRoot }) {
  let lastImportErrors = null; // { errors, yearMonth, files }

  function getArchiveDir(yearMonth) {
    const dir = path.join(getStorageRoot(), 'pending-archives', yearMonth);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function archiveExistingMonth(yearMonth) {
    const db = getPendingDb();
    if (!db) return null;
    const meta = monthRepo.getMonthMeta(db, yearMonth);
    if (!meta || meta.rowCount === 0) return null;

    const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
    const rows = db.prepare(`SELECT ${colList} FROM pending_rows WHERE year_month = ?`).all(yearMonth);

    const aoa = [PENDING_COLUMNS.slice()];
    for (const r of rows) {
      aoa.push(PENDING_COLUMNS.map((c) => (r[c] == null ? '' : r[c])));
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    const archivePath = path.join(getArchiveDir(yearMonth), `${yearMonth}-backup-${formatTimestamp()}.xlsx`);
    XLSX.writeFile(wb, archivePath);
    return archivePath;
  }

  function runImport({ yearMonth, files, overwriteConfirmed, dbPath, onProgress }) {
    return new Promise((resolve) => {
      const db = getPendingDb();
      if (!db) {
        resolve({ status: 'error', errors: [{ severity: 'fatal', message: 'Pending DB 未初始化' }] });
        return;
      }

      const existingCount = monthRepo.countRowsInMonth(db, yearMonth);
      if (existingCount > 0 && !overwriteConfirmed) {
        const meta = monthRepo.getMonthMeta(db, yearMonth);
        resolve({
          status: 'need-confirm',
          yearMonth,
          existingRowCount: existingCount,
          existingImportedAt: meta ? meta.importedAt : null
        });
        return;
      }

      let archivePath = null;
      if (existingCount > 0 && overwriteConfirmed) {
        try {
          archivePath = archiveExistingMonth(yearMonth);
        } catch (err) {
          resolve({ status: 'error', errors: [{ severity: 'fatal', message: '留底失败：' + err.message }] });
          return;
        }
      }

      const jobMeta = { dbPath, yearMonth, files, archivePath };

      let stdoutBuf = '';
      let stderrBuf = '';
      const events = [];

      // 公共事件处理
      function onStdoutChunk(chunk) {
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (_e) { ev = { type: 'raw', line }; }
          events.push(ev);
          if (typeof onProgress === 'function' && ev.type === 'progress') {
            try { onProgress(ev); } catch (_progErr) { /* swallow */ }
          }
        }
      }

      function finalize(code) {
        if (stdoutBuf.trim()) {
          try { events.push(JSON.parse(stdoutBuf.trim())); } catch (_e) { events.push({ type: 'raw', line: stdoutBuf.trim() }); }
          stdoutBuf = '';
        }
        if (code === 0) {
          const complete = events.find((e) => e.type === 'complete');
          if (complete) {
            lastImportErrors = null;
            resolve({
              status: 'success',
              yearMonth,
              rowCount: complete.rowCount,
              sourceFiles: complete.sourceFiles,
              archivePath
            });
            return;
          }
          resolve({ status: 'error', errors: [{ severity: 'fatal', message: 'worker 正常退出但缺 complete 事件' }] });
          return;
        }
        const errorEv = events.find((e) => e.type === 'error');
        const errors = errorEv
          ? errorEv.errors
          : [{ severity: 'fatal', message: `worker 异常退出（code=${code}）\nstderr=${stderrBuf.trim()}` }];
        lastImportErrors = { errors, yearMonth, files: files.slice() };
        resolve({ status: 'error', errors });
      }

      if (electronUtilityProcess) {
        // Electron 路径：utilityProcess.fork → 真正 Node.js 子进程，execArgv 里 V8 flag 生效
        const worker = electronUtilityProcess.fork(WORKER_SCRIPT, [JSON.stringify(jobMeta)], {
          execArgv: [`--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`],
          stdio: 'pipe'
        });
        worker.stdout.on('data', onStdoutChunk);
        worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
        worker.on('exit', finalize);
      } else {
        // Node 直跑（测试脚本）：spawn 老路径
        const worker = spawn(process.execPath, [
          `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`,
          WORKER_SCRIPT,
          JSON.stringify(jobMeta)
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        worker.stdout.on('data', onStdoutChunk);
        worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
        worker.on('error', (err) => {
          resolve({ status: 'error', errors: [{ severity: 'fatal', message: 'worker spawn 失败：' + err.message }] });
        });
        worker.on('close', finalize);
      }
    });
  }

  function exportErrorReport(savePath) {
    if (!lastImportErrors) return { status: 'error', message: '无错误报告' };
    const headers = ['source_file', 'sheet_row', 'severity', 'message', ...PENDING_COLUMNS];
    const rows = [headers];
    for (const err of lastImportErrors.errors) {
      const cells = Array.isArray(err.cells) ? err.cells : PENDING_COLUMNS.map(() => '');
      rows.push([
        err.file || '',
        err.sheetRow != null ? err.sheetRow : '',
        err.severity || '',
        err.message || '',
        ...cells
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '错误报告');
    XLSX.writeFile(wb, savePath);
    return { status: 'success', path: savePath, errorCount: lastImportErrors.errors.length };
  }

  function hasPendingErrorReport() { return lastImportErrors !== null; }

  function clearLastImportErrors() { lastImportErrors = null; }

  return {
    runImport,
    exportErrorReport,
    hasPendingErrorReport,
    clearLastImportErrors,
    archiveExistingMonth
  };
}

module.exports = { createPendingSession };
