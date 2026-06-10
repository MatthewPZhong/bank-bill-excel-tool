// Pending 模块 session 层：spawn worker + 事件路由 + 留底 + 报错缓存
// 由 main.js 创建单例，注入 getPendingDb / getStorageRoot

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// v2.0.0 GA：切到 xlsx-js-style 以支持表头字号样式（与其他 writer 一致）
const XLSX = require('xlsx-js-style');
const { applyWatermark } = require('./workbook-watermark');

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

// ════════════════════════════════════════════════════════════════════════════════
// v3.0.4 块 B（PR-C）：pending 导入迁移大表导入引擎（JSZip→yauzl 基座，300w 设计目标解锁；
//   child_process→worker_threads 拓扑统一；多文件并行）。🔴🔴 资金红线（pending_rows 真理源 + 6 表覆盖删除链）。
//
// 🔴 单行回退开关：USE_BIG_TABLE_IMPORT_ENGINE_PENDING=false 即回退原 utilityProcess + worker.js 全旧链路
//   （worker.js / month-repository.js / 旧 reader 一字不改保留可达）。出引擎相关问题时拨 false 一行即恢复 v3.0.3 行为。
//   生产默认走引擎（env 未设 → true）。测试经 env PENDING_FORCE_LEGACY_IMPORT=1 强制旧路径做对照
//   （parity 集成脚本 pending-engine-migration.js 在子进程设此 env，不污染生产代码路径）。
// ════════════════════════════════════════════════════════════════════════════════
const USE_BIG_TABLE_IMPORT_ENGINE_PENDING = process.env.PENDING_FORCE_LEGACY_IMPORT === '1' ? false : true;

// 引擎共享 dispatch（OPEN-2：不收编收单；pending/biz-op 复用）。
const { dispatchEngineImport } = require('./big-table-import-dispatch');
// pending 契约模块绝对路径（worker require 必须可序列化定位：路径 + contractOptions）。
const PENDING_CONTRACT_PATH = require.resolve('../backend/pending-import/contract-pending');
// 引擎 worker_threads 堆上限（R-5）：替代旧 utilityProcess 8GB child；dedupe Set 300w≈360MB + 写批缓冲。
const ENGINE_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 4096 };

// 引擎日志落库（模块级 logger，纯 Node 安全；与收单 dispatch 日志同范式）。
let appendModuleLog = null;
try {
  appendModuleLog = require('../backend/logger').appendModuleLog;
} catch (_e) {
  // 非完整运行时（极端测试场景）：日志降级为 no-op。
}

// ── 引擎错误对象 → 还原现行 lastImportErrors 形态（severity/file/sheetRow/message/cells）──
//   引擎整批拒绝抛 BigTableImportError，message 含 `${sourceFile}：` 前缀，并挂 structuredImportErrors
//   = { collectedErrors:[{sourceFile,rowIndex,reason[,cells]}], rowErrorTotal, rowErrorTruncated }（见 engine.js）。
//   还原规则（byte-for-byte 对齐旧 worker.js 错误协议 + pending-session exportErrorReport 消费形态）：
//     - 有 structuredImportErrors.collectedErrors（行级错误：跨文件重复行 / INSERT 失败）→ 每条还原为
//       { severity:'row', file:sourceFile, sheetRow:rowIndex, message:reason, cells }（旧链路 worker.js:121-128 形态）。
//     - 无行级错误（表头错 / 空文件 / 系统错）→ 单条 { severity:'fatal', message }（旧链路 fatal 形态；
//       message 已含 sourceFile 前缀，与旧链路 `{ file, message }` 语义等价——exportErrorReport 的 file 列由
//       此分支留空，message 含文件名，对用户信息完整）。
//   返回 { errors:[...], rowErrorTotal, rowErrorTruncated }。
function restoreEngineErrors(err) {
  const structured = err && err.structuredImportErrors;
  if (structured && Array.isArray(structured.collectedErrors) && structured.collectedErrors.length > 0) {
    const errors = structured.collectedErrors.map((e) => {
      const out = {
        severity: 'row',
        file: e.sourceFile != null ? e.sourceFile : '',
        sheetRow: e.rowIndex != null ? e.rowIndex : '',
        message: e.reason != null ? e.reason : ''
      };
      if (Array.isArray(e.cells)) out.cells = e.cells;
      return out;
    });
    return {
      errors,
      rowErrorTotal: Number.isFinite(structured.rowErrorTotal) ? structured.rowErrorTotal : errors.length,
      rowErrorTruncated: structured.rowErrorTruncated === true
    };
  }
  // fatal 单条（表头错 / 空文件 / 系统错）。
  const message = (err && err.message) ? err.message : '导入失败';
  const errors = [{ severity: 'fatal', message }];
  // detailLines（表头错带）并入 message 下方（与旧链路 fatal 仅 message 一致：旧链路表头错只有 message，
  //   引擎表头错 detailLines 一般为空；若有则补进 message 末尾不丢信息）。
  if (err && Array.isArray(err.detailLines) && err.detailLines.length > 0) {
    errors[0].message = message + '\n' + err.detailLines.join('\n');
  }
  return { errors, rowErrorTotal: 0, rowErrorTruncated: false };
}

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
    applyWatermark(wb);
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

  // ── v3.0.4 块 B（PR-C）：引擎路径导入实现 ──
  //   dispatch 引擎 worker（mode='overwrite'，6 表覆盖删除链 + 33 参 INSERT + 跨文件 sha 去重 + 事务内月元数据收尾）。
  //   成功 → { status:'success', yearMonth, rowCount, sourceFiles, archivePath }（与旧链路 complete 事件形态一致）。
  //   失败 → 引擎抛 BigTableImportError，restoreEngineErrors 还原 lastImportErrors 形态后返回 { status:'error', errors }。
  //   进度 → 引擎每 1w 行 { sourceFile, importedCount } 适配为现行 renderer payload（{ type:'progress', file, rowsProcessed, totalInserted }）。
  async function runImportViaEngine({ yearMonth, files, archivePath, dbPath, onProgress }) {
    // importedAt 在 session 侧算好经 contractOptions 注入（事务内收尾 upsertMonthMeta 用，与旧链路 new Date().toISOString() 等价）。
    const importedAt = new Date().toISOString();
    try {
      const engineResult = await dispatchEngineImport({
        dbPath,
        files,
        contractModulePath: PENDING_CONTRACT_PATH,
        contractOptions: { yearMonth, archivePath: archivePath || null, importedAt },
        mode: 'overwrite',
        // monthKey 不传：契约 monthKeyOf=null ⇒ 引擎 baseMonthKey=null 旁路跨月校验（pending 单月由 yearMonth 入参）。
        resourceLimits: ENGINE_RESOURCE_LIMITS,
        onEngineProgress: (ev) => {
          if (typeof onProgress !== 'function') return;
          // 适配为现行 renderer payload 形态（旧链路 worker.js:154 emit progress）：
          //   { type:'progress', file, rowsProcessed, totalInserted }。引擎并行解析无逐文件指针 →
          //   file 取 ev.sourceFile，rowsProcessed/totalInserted 同取全局累计 importedCount（renderer 显示累计已导入行数）。
          try {
            onProgress({
              type: 'progress',
              file: ev.sourceFile,
              rowsProcessed: ev.importedCount,
              totalInserted: ev.importedCount
            });
          } catch (_e) { /* swallow */ }
        },
        onLog: (entry) => {
          if (typeof appendModuleLog === 'function') {
            try {
              appendModuleLog({
                level: entry.level || 'info', source: 'main', domain: 'pending-import',
                message: entry.message || '[big-table-import] log',
                details: Array.isArray(entry.details) ? entry.details : undefined
              });
            } catch (_e) { /* swallow */ }
          }
        }
      });
      // 成功：清错误缓存 + 还原旧链路 success 形态。sourceFiles = 文件名数组（引擎 finalizeForCommit 用同款 basename）。
      lastImportErrors = null;
      return {
        status: 'success',
        yearMonth,
        rowCount: engineResult ? engineResult.totalImported : 0,
        sourceFiles: files.map((f) => path.basename(f)),
        archivePath
      };
    } catch (err) {
      // 引擎错误 → 还原 lastImportErrors 形态（severity/file/sheetRow/message/cells + 计数/截断标志）。
      const restored = restoreEngineErrors(err);
      lastImportErrors = {
        errors: restored.errors,
        yearMonth,
        files: files.slice(),
        rowErrorTotal: restored.rowErrorTotal,
        rowErrorTruncated: restored.rowErrorTruncated
      };
      return { status: 'error', errors: restored.errors };
    }
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

    // ── v3.0.4 块 B（PR-C）：引擎路径（默认）。dbPath 必须（引擎 worker 自开连接）；缺则回退旧链路（兜底安全）。
    //   pending 旧链路 worker.js 无条件 deleteMonth（worker.js:84，不受 overwriteConfirmed 控制）⇒ 引擎统一走
    //   mode='overwrite'（deleteForOverwrite 6 表覆盖删除链）。monthKey 不传（契约 monthKeyOf=null 旁路跨月校验）。
    if (USE_BIG_TABLE_IMPORT_ENGINE_PENDING && dbPath) {
      return runImportViaEngine({ yearMonth, files, archivePath, dbPath, onProgress });
    }

    // ── 回退旧链路（PENDING_FORCE_LEGACY_IMPORT=1 或 dbPath 缺失）：utilityProcess/spawn + worker.js 全旧路径 ──
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
    applyWatermark(wb);
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
