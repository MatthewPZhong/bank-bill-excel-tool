// v2.1.12-beta β.2-T2 — 业务OP数据核对：导入 worker（child process 入口）🔴 资金/数据完整性红线
//
// 由主进程 spawn：node --max-old-space-size=8192 <此文件> <jobMetaJson>
//   （Electron 下走 utilityProcess.fork；纯 Node 测试下走 spawn(process.execPath)）
//
// 背景：原 biz-op-recon-session.runBizOpImportAsync / runFlowImportAsync 走 SheetJS reader
//   全量进内存 + 主线程同步。用户实际导入百万行 xlsx 会撞 SheetJS V8 512MB 上限（静默返回空 /
//   卡主线程 UI）。本 worker 把导入移进子进程 + 边流式读（reader-streamed）边分批 INSERT，
//   内存常数、不卡 UI。仿成熟范式 src/backend/pending-import/worker.js。
//
// 🔴 语义零改变（与 runBizOpImportAsync / runFlowImportAsync byte-for-byte 一致）：
//   ① 整批拒绝：rows.length===0 → rejected；首行 bu_name 空（bizOp）→ rejected；
//      BU 一致性 + 逐行 validateBizOpRow（bizOp）/ validateFlowRow（flow），任一失败 → 整批拒绝（不入任何行）。
//   ② (date,BU)+D+1 替换原子事务（bizOp）：clearRunsAndDiffsByDateBu(date,BU) AND ...(addOneDay,BU)
//      + clearByDateBu(date,BU) + INSERT 同一事务 COMMIT/ROLLBACK。
//      （D 业务OP 既是 D 的 T-1 又是 D+1 的 T-2，必须同清 D+1，否则 D+1 旧 diff 基于旧 T-2 = 资金事故）
//   ③ bu_name 改写：落库前所有行 bu_name=firstBu（trim 保大小写不强制 lower）。
//   ④ 失败报告 xlsx：worker 不写盘（ExcelJS 留主进程，仿 pending）；emit rejected 的 errorRows
//      带 rawRow（含 _rowIndex）→ 主进程写 writeBizOpErrorReportXlsx / writeFlowErrorReportXlsx。
//   ⑤ flow：不分 BU、无 BU 一致性、无 firstBu / bu_name 改写；clear = clearRunsAndDiffsByDate(date)（跨所有 BU）
//      + clearByDate(date)（非 ByDateBu）。
//
// 输出协议（每行一 JSON）：
//   {"type":"progress","dataRows":N}
//   {"type":"rejected","errorRows":[{rowIndex,reason,rawRow}],"rowErrorTotal":M,"truncated":bool,"firstBu":"..."}
//   {"type":"header-error","errorCode":"...","message":"...","detailLines":[...]}
//   {"type":"complete","status":"success","buName":"...","validCount":N}   // bizOp
//   {"type":"complete","status":"success","totalCount":N,"validCount":N}    // flow
// 退出码：0 成功 / 1 校验失败（rejected / header-error）/ 2 系统错误

const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');

const { ensureBizOpReconTablesSupport } = require('../biz-op-recon-db/migrations');
const importsRepository = require('../biz-op-recon-db/imports-repository');
const flowImportsRepository = require('../biz-op-recon-db/flow-imports-repository');
const runRepository = require('../biz-op-recon-db/run-repository');
const { validateBizOpRow, validateFlowRow } = require('./validator');
const { streamBizOpFile, streamFlowFile } = require('./reader-streamed');
// addOneDay / normalizeBu 单一真理来源在 session.js（资金红线 helper，避免双源漂移）
const { addOneDay, normalizeBu } = require('../../main-process/biz-op-recon-session');

// 错误数量上限：防百万级行级错误累积后 emit 巨型 JSON 把 stdout 管道撑爆。
// 超上限只保留前 N 条带 rawRow（供导报告 xlsx），rowErrorTotal 仍记全量真实数。
const DEFAULT_MAX_ROW_ERRORS = 1000;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// 诊断：启动时把 heap 限制写到 stderr，便于排查 --max-old-space-size 是否生效（仿 pending worker）
const heapStats = v8.getHeapStatistics();
process.stderr.write(
  `[bizop-import-worker-boot] heap_size_limit=${(heapStats.heap_size_limit / 1024 / 1024).toFixed(0)} MB ` +
  `exec=${process.execPath} execArgv=${JSON.stringify(process.execArgv)} ` +
  `NODE_OPTIONS=${process.env.NODE_OPTIONS || '(none)'}\n`
);

function loadJobMeta() {
  const raw = process.argv[2];
  if (!raw) {
    emit({ type: 'fatal', message: 'missing jobMeta (argv[2])' });
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    emit({ type: 'fatal', message: 'jobMeta 解析失败: ' + err.message });
    process.exit(2);
  }
}

// 主 DB PRAGMA（与 database.js:63-71 + run-check-worker.js 一致 + busy_timeout 防 WAL 写冲突）
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA mmap_size = 268435456;');
  db.exec('PRAGMA busy_timeout = 30000;');   // 30s —— 与主进程同库并发写时防 SQLITE_BUSY
  // 幂等迁移（主进程启动时已建表，此处仅防御性保证 worker 独立 connection 下表存在）
  ensureBizOpReconTablesSupport(db);
  return db;
}

// ---------------- 业务 OP 导入（runBizOpImportAsync 语义流式镜像） ----------------
//
// 🔴 整批拒绝 = 事务内边校验边 INSERT + 出错 ROLLBACK：
//   BEGIN → 流式读：第一个数据行定 firstBu → 事务内执行 clear（date,BU）+（D+1,BU）+ clearByDateBu →
//   逐行（含首行）BU 一致 + validateBizOpRow，累积 errorRows，通过的行 bu_name=firstBu 后 INSERT →
//   流完：errorRows 非空 → ROLLBACK + emit rejected（不入任何行）/ 全通过 → COMMIT + emit complete。
async function runBizOpImport(db, { date, filePath, maxRowErrors }) {
  let firstBu = null;
  let buNormalized = null;
  let cleared = false;
  let dataRowCount = 0;
  let insertedCount = 0;
  let firstEmptyRowIndex = 0;
  let firstBuEmpty = false;      // 首行 bu_name 空（与旧同步语义对齐：只此一条错误，不写报告，不校验后续行）
  const errorRows = [];
  let rowErrorTotal = 0;

  // 逐行 INSERT 预编译（避免百万次 db.prepare）；列序 = data_date,row_index + BIZ_OP_DB_COLUMNS
  const insertOne = importsRepository.makeRowInserter(db);

  db.exec('BEGIN');
  try {
    await streamBizOpFile(filePath, {
      onDataRow: (row) => {
        dataRowCount += 1;
        if (firstBuEmpty) return;   // 首行已判空：跳过后续行（旧实现首行空直接 return rejected，不校验后续）

        // 第一个数据行：定 firstBu + 事务内清旧数据（资金红线 ②）
        if (firstBu === null) {
          firstBu = String(row.bu_name || '').trim();
          if (!firstBu) {
            // 首行 bu_name 空 → 整批拒绝。与旧同步语义对齐：errorReportPath=null（不写报告 xlsx），
            //   errorRows 单条无 rawRow（旧实现 { rowIndex: rows[0]._rowIndex, reason: '业务方为空' }）。
            //   不抛异常（回调里 throw 会被流式 reader 的 wrapReadError 包成 FileValidationError，
            //   误判成 header-error）——改设标志位，流结束后在外层统一处理。
            firstBuEmpty = true;
            firstEmptyRowIndex = row._rowIndex;
            return;
          }
          buNormalized = normalizeBu(firstBu);
          // 资金红线 ② v2.1.3 PR #45 round 4 P1 fix：同清 (date,BU) + (D+1,BU)
          runRepository.clearRunsAndDiffsByDateBu(db, date, firstBu);
          runRepository.clearRunsAndDiffsByDateBu(db, addOneDay(date), firstBu);
          importsRepository.clearByDateBu(db, date, firstBu);
          cleared = true;
        }

        // BU 一致性（资金红线 ①）
        if (normalizeBu(row.bu_name) !== buNormalized) {
          rowErrorTotal += 1;
          recordRowError(errorRows, maxRowErrors, {
            rowIndex: row._rowIndex,
            reason: `业务方不一致：首行为 "${firstBu}"，本行为 "${row.bu_name}"`,
            rawRow: row
          });
          return;
        }
        // 双重校验（资金红线 ①）
        const result = validateBizOpRow(row);
        if (!result.ok) {
          rowErrorTotal += 1;
          recordRowError(errorRows, maxRowErrors, { rowIndex: row._rowIndex, reason: result.reason, rawRow: row });
          return;
        }

        // 资金红线 ③：落库前 bu_name 改写为 firstBu（trim 保大小写）
        row.bu_name = firstBu;
        insertOne(date, row);
        insertedCount += 1;
      },
      onProgress: (dataRows) => emit({ type: 'progress', dataRows })
    });
  } catch (err) {
    // 表头 / 读取失败 → header-error（FileValidationError 带 code）；其他 → fatal
    db.exec('ROLLBACK');
    emitHeaderOrFatal(err);
    return; // emitHeaderOrFatal 已 process.exit
  }

  // 首行 bu_name 空：整批拒绝（不入任何行）；report=false（旧语义 errorReportPath=null）
  if (firstBuEmpty) {
    db.exec('ROLLBACK');
    emit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: firstEmptyRowIndex, reason: '业务方为空' }],
      rowErrorTotal: 1,
      truncated: false,
      firstBu: ''
    });
    process.exit(1);
  }

  // rows.length===0：无有效数据行 → 整批拒绝（与旧同步语义一致）；report=false（errorReportPath=null）
  if (dataRowCount === 0) {
    db.exec('ROLLBACK');
    emit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }],
      rowErrorTotal: 1,
      truncated: false,
      firstBu: null
    });
    process.exit(1);
  }

  // 🔴 任一行校验失败 → 整批拒绝（ROLLBACK，不入任何行）；report=true（写失败报告 xlsx，含 rawRow）
  if (errorRows.length > 0 || rowErrorTotal > 0) {
    db.exec('ROLLBACK');
    emit({
      type: 'rejected',
      report: true,
      errorRows: errorRows.map(serializeErrorRow),
      rowErrorTotal,
      truncated: rowErrorTotal > errorRows.length,
      firstBu
    });
    process.exit(1);
  }

  // 全部通过 → COMMIT（cleared 必为 true，因为 dataRowCount>0 且首行非空已 clear）
  void cleared;
  db.exec('COMMIT');
  emit({ type: 'complete', status: 'success', buName: firstBu, validCount: insertedCount });
  process.exit(0);
}

// ---------------- 流水导入（runFlowImportAsync 语义流式镜像） ----------------
//
// flow 差异（资金红线 ⑤）：不分 BU、无 BU 一致性、无 firstBu / bu_name 改写；
//   clear = clearRunsAndDiffsByDate(date)（跨所有 BU）+ clearByDate(date)（非 ByDateBu）。
async function runFlowImport(db, { date, filePath, maxRowErrors }) {
  let dataRowCount = 0;
  let insertedCount = 0;
  let cleared = false;
  const errorRows = [];
  let rowErrorTotal = 0;

  const insertOne = flowImportsRepository.makeRowInserter(db);

  db.exec('BEGIN');
  try {
    await streamFlowFile(filePath, {
      onDataRow: (row) => {
        dataRowCount += 1;

        // 第一个数据行：事务内清旧数据（资金红线 ⑤：流水按 date 跨所有 BU 清）
        if (!cleared) {
          runRepository.clearRunsAndDiffsByDate(db, date);
          flowImportsRepository.clearByDate(db, date);
          cleared = true;
        }

        const result = validateFlowRow(row);
        if (!result.ok) {
          rowErrorTotal += 1;
          recordRowError(errorRows, maxRowErrors, { rowIndex: row._rowIndex, reason: result.reason, rawRow: row });
          return;
        }
        insertOne(date, row);
        insertedCount += 1;
      },
      onProgress: (dataRows) => emit({ type: 'progress', dataRows })
    });
  } catch (err) {
    db.exec('ROLLBACK');
    emitHeaderOrFatal(err);
    return;
  }

  // 无有效数据行 → 整批拒绝（report=false，errorReportPath=null）
  if (dataRowCount === 0) {
    db.exec('ROLLBACK');
    emit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }],
      rowErrorTotal: 1,
      truncated: false
    });
    process.exit(1);
  }

  // 🔴 任一行校验失败 → 整批拒绝（report=true，写失败报告 xlsx，含 rawRow）
  if (errorRows.length > 0 || rowErrorTotal > 0) {
    db.exec('ROLLBACK');
    emit({
      type: 'rejected',
      report: true,
      errorRows: errorRows.map(serializeErrorRow),
      rowErrorTotal,
      truncated: rowErrorTotal > errorRows.length
    });
    process.exit(1);
  }

  void cleared;
  db.exec('COMMIT');
  emit({ type: 'complete', status: 'success', totalCount: insertedCount, validCount: insertedCount });
  process.exit(0);
}

// ---------------- 共用 helper ----------------

// 累积行级错误：只保留前 maxRowErrors 条带 rawRow（供导报告 xlsx）；超出不再 push（rowErrorTotal 仍计全量）
function recordRowError(errorRows, maxRowErrors, entry) {
  if (errorRows.length < maxRowErrors) errorRows.push(entry);
}

// errorRows 序列化：仅保留 rowIndex/reason/rawRow（rawRow 是 reader 输出的 obj，含 DB 列 + _rowIndex）
// 主进程写报告时 writeBizOpErrorReportXlsx 用 e.rawRow → bizOpRowToArray(rawRow) 取 BIZ_OP_DB_COLUMNS 字段
function serializeErrorRow(e) {
  return { rowIndex: e.rowIndex, reason: e.reason, rawRow: e.rawRow };
}

// 表头 / 读取失败：FileValidationError 带 code/detailLines → header-error；其他 → fatal 系统错
function emitHeaderOrFatal(err) {
  if (err && err.name === 'FileValidationError') {
    emit({
      type: 'header-error',
      errorCode: err.code || null,
      message: err.message || String(err),
      detailLines: Array.isArray(err.detailLines) ? err.detailLines : []
    });
    process.exit(1);
  }
  emit({ type: 'fatal', message: err && err.message ? err.message : String(err) });
  process.exit(2);
}

async function main() {
  const job = loadJobMeta();
  const { dbPath, kind, date, filePath } = job;
  const maxRowErrors = Number.isFinite(job.maxRowErrors) && job.maxRowErrors > 0
    ? job.maxRowErrors
    : DEFAULT_MAX_ROW_ERRORS;

  if (!dbPath || !kind || !date || !filePath) {
    emit({ type: 'fatal', message: 'jobMeta 缺字段（dbPath / kind / date / filePath）' });
    process.exit(2);
  }
  if (kind !== 'bizOp' && kind !== 'flow') {
    emit({ type: 'fatal', message: `未知 kind: ${kind}（仅 bizOp / flow）` });
    process.exit(2);
  }

  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    emit({ type: 'fatal', message: 'DB open 失败：' + (err && err.message ? err.message : String(err)) });
    process.exit(2);
  }

  try {
    if (kind === 'bizOp') {
      await runBizOpImport(db, { date, filePath, maxRowErrors });
    } else {
      await runFlowImport(db, { date, filePath, maxRowErrors });
    }
  } catch (err) {
    // runXxxImport 内部分支均已 process.exit；走到这里说明 INSERT/事务阶段异常
    try { db.exec('ROLLBACK'); } catch (_rb) { /* ignore */ }
    emit({ type: 'fatal', message: '导入阶段失败：' + (err && err.message ? err.message : String(err)) });
    process.exit(2);
  } finally {
    try { db.close(); } catch (_e) { /* ignore */ }
  }
}

main().catch((err) => {
  emit({ type: 'fatal', message: 'worker 未捕获异常：' + (err && err.message ? err.message : String(err)) });
  process.exit(2);
});
