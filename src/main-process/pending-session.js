// Pending 模块 session 层：spawn worker + 事件路由 + 留底 + 报错缓存
// 由 main.js 创建单例，注入 getPendingDb / getStorageRoot

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// v2.0.0 GA：切到 xlsx-js-style 以支持表头字号样式（与其他 writer 一致）
const XLSX = require('xlsx-js-style');

const PENDING_COLUMNS = require('../backend/pending-db/columns');
const monthRepo = require('../backend/pending-db/month-repository');
// v2.0.0-beta.4：error-report 加「可能原因」列
const { errorCodeToCause } = require('../backend/file-service/error-causes');

// v2.0.0 GA：表头字号统一 10pt（与其他 writer 一致）
function applyHeaderRowFont(worksheet, headerRowIndex = 0) {
  if (!worksheet || !worksheet['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  if (headerRowIndex < range.s.r || headerRowIndex > range.e.r) return;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const cell = worksheet[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, sz: 10 }
    };
  }
}

const WORKER_SCRIPT = path.resolve(__dirname, '../backend/pending-import/worker.js');
const ARCHIVE_WORKER_SCRIPT = path.resolve(__dirname, './pending-archive-worker.js');
const NODE_MAX_OLD_SPACE_MB = 8192;
// 留底阈值：行数超过时走 utilityProcess + 流式 writer；否则主进程同步 XLSX 兜底（小样本测试）
const ARCHIVE_WORKER_THRESHOLD = 50000;

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

  // 留底：把当月 pending_rows 导出为 xlsx
  // 返回 Promise<archivePath | null>
  //   - 行数 0 → null（无需留底）
  //   - 行数 <= ARCHIVE_WORKER_THRESHOLD → 主进程同步 XLSX（小数据量，测试路径）
  //   - 行数 > threshold → utilityProcess + 流式 writer（不卡主进程 UI）
  async function archiveExistingMonth(yearMonth, dbPath) {
    const db = getPendingDb();
    if (!db) return null;
    const meta = monthRepo.getMonthMeta(db, yearMonth);
    if (!meta || meta.rowCount === 0) return null;

    const archivePath = path.join(getArchiveDir(yearMonth), `${yearMonth}-backup-${formatTimestamp()}.xlsx`);

    // 大数据量走 worker（Electron 环境才有 utilityProcess；无则 fallback 主进程同步）
    if (meta.rowCount > ARCHIVE_WORKER_THRESHOLD && electronUtilityProcess && dbPath) {
      return runArchiveInWorker({ dbPath, yearMonth, archivePath });
    }

    // 主进程同步兜底（测试 + 小数据量）
    const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
    const rows = db.prepare(`SELECT ${colList} FROM pending_rows WHERE year_month = ?`).all(yearMonth);

    const aoa = [PENDING_COLUMNS.slice()];
    for (const r of rows) {
      aoa.push(PENDING_COLUMNS.map((c) => (r[c] == null ? '' : r[c])));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    applyHeaderRowFont(ws);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, archivePath);
    return archivePath;
  }

  // 在 utilityProcess 里跑 archive-worker + 自研流式 xlsx writer；UI 不阻塞
  function runArchiveInWorker({ dbPath, yearMonth, archivePath }) {
    return new Promise((resolve, reject) => {
      const jobMeta = { dbPath, yearMonth, archivePath };
      const worker = electronUtilityProcess.fork(ARCHIVE_WORKER_SCRIPT, [JSON.stringify(jobMeta)], {
        execArgv: [`--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`],
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`
        },
        stdio: 'pipe'
      });
      let stdoutBuf = '';
      let stderrBuf = '';
      const events = [];
      worker.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          try { events.push(JSON.parse(line)); } catch (_e) { events.push({ type: 'raw', line }); }
        }
      });
      worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      worker.on('exit', (code) => {
        if (code === 0) {
          const complete = events.find((e) => e.type === 'complete');
          resolve(complete ? complete.archivePath : archivePath);
          return;
        }
        const errEv = events.find((e) => e.type === 'error');
        const msg = errEv ? errEv.message : `archive worker 异常退出 code=${code} stderr=${stderrBuf.trim().slice(0, 500)}`;
        reject(new Error(msg));
      });
    });
  }

  async function runImport({ yearMonth, files, overwriteConfirmed, dbPath, onProgress }) {
    const db = getPendingDb();
    if (!db) {
      return { status: 'error', errors: [{ severity: 'fatal', message: 'Pending DB 未初始化' }] };
    }

    const existingCount = monthRepo.countRowsInMonth(db, yearMonth);
    if (existingCount > 0 && !overwriteConfirmed) {
      const meta = monthRepo.getMonthMeta(db, yearMonth);
      return {
        status: 'need-confirm',
        yearMonth,
        existingRowCount: existingCount,
        existingImportedAt: meta ? meta.importedAt : null
      };
    }

    let archivePath = null;
    if (existingCount > 0 && overwriteConfirmed) {
      try {
        archivePath = await archiveExistingMonth(yearMonth, dbPath);
      } catch (err) {
        return { status: 'error', errors: [{ severity: 'fatal', message: '留底失败：' + err.message }] };
      }
    }

    return new Promise((resolve) => {
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
        // Electron 路径：utilityProcess.fork → 真正 Node.js 子进程
        // 同时传 execArgv（经 Node 启动行参）和 NODE_OPTIONS（运行时 env）双保险
        // 避免 Electron 某版本把其中一条路径过滤掉
        const worker = electronUtilityProcess.fork(WORKER_SCRIPT, [JSON.stringify(jobMeta)], {
          execArgv: [`--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`],
          env: {
            ...process.env,
            NODE_OPTIONS: `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`
          },
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
    // v2.0.0-beta.4：第 5 列「可能原因」（基于 err.code 或 severity 兜底）
    const headers = ['source_file', 'sheet_row', 'severity', 'message', '可能原因', ...PENDING_COLUMNS];
    const rows = [headers];
    for (const err of lastImportErrors.errors) {
      const cells = Array.isArray(err.cells) ? err.cells : PENDING_COLUMNS.map(() => '');
      rows.push([
        err.file || '',
        err.sheetRow != null ? err.sheetRow : '',
        err.severity || '',
        err.message || '',
        errorCodeToCause(err.code || err.severity),
        ...cells
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    applyHeaderRowFont(ws);
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
