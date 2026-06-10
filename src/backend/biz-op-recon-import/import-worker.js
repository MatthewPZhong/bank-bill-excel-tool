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
const path = require('node:path');   // v3.0.2 需求1b：多文件流水导入取来源文件名（basename）
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

// I3（β.2 review fix）：终态事件（complete/rejected/header-error/fatal）emit 后立即 process.exit()
//   会在 stdout 是 pipe 时截断未刷盘的数据——尤其 rejected 携带最多上千条 rawRow（数百 KB）最易被截，
//   导致主进程 session 拿不到 rejected/complete、误判成「worker 异常退出」并丢掉正确结论 + 失败报告。
// 改造：写入 stdout 后，在 write 回调（数据已交给 OS 管道缓冲）里才退出；外加 drain + 200ms 兜底，
//   既保证刷盘又不会因对端不消费而挂死。模块级 _terminalEmitted 守卫保证「只发一个终态事件 + 只退出一次」
//   （等价旧实现「每条路径恰好一次 process.exit」的不变量）。
let _terminalEmitted = false;
function emitAndExit(event, code) {
  if (_terminalEmitted) return;   // 已发过终态事件：忽略后续（防双发/双退出）
  _terminalEmitted = true;
  const line = JSON.stringify(event) + '\n';
  let exited = false;
  const doExit = () => {
    if (exited) return;
    exited = true;
    try { process.exit(code); } catch (_e) { /* already exiting */ }
  };
  try {
    const flushed = process.stdout.write(line, doExit);   // 回调在该行刷入管道后触发
    if (!flushed) process.stdout.once('drain', doExit);   // 内核缓冲满：等 drain 再退
    setTimeout(doExit, 200);                              // 兜底：对端不消费也不挂死（200ms 后强制退出）
  } catch (_e) {
    doExit();   // EPIPE 等写失败：直接退出
  }
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
    emitAndExit({ type: 'fatal', message: 'missing jobMeta (argv[2])' }, 2);
    return null;   // I3：emitAndExit 异步退出；返回 null 让 main 提前 return，不继续执行
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    emitAndExit({ type: 'fatal', message: 'jobMeta 解析失败: ' + err.message }, 2);
    return null;
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
  let insertFatal = null;        // I1：流式中途 clear/INSERT 等事务内 DB 写失败（系统错，区别于表头/读取错）
  const errorRows = [];
  let rowErrorTotal = 0;

  // 逐行 INSERT 预编译（避免百万次 db.prepare）；列序 = data_date,row_index + BIZ_OP_DB_COLUMNS
  const insertOne = importsRepository.makeRowInserter(db);

  db.exec('BEGIN');
  try {
    await streamBizOpFile(filePath, {
      onDataRow: (row) => {
        dataRowCount += 1;
        if (firstBuEmpty || insertFatal) return;   // 首行已判空 / 已遇系统写错：跳过后续行

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
          // I1（β.2 review fix）：clear 是事务内 DB 写，可能抛 SQLITE_BUSY 等系统错。单独 try 标 insertFatal，
          //   否则异常冒泡到流式 reader 会被 wrapReadError 包成带 header-mismatch code 的 FileValidationError，
          //   被误判成「表头/读取失败」（旧同步路是直接抛原始 DB 错）。
          try {
            runRepository.clearRunsAndDiffsByDateBu(db, date, firstBu);
            runRepository.clearRunsAndDiffsByDateBu(db, addOneDay(date), firstBu);
            importsRepository.clearByDateBu(db, date, firstBu);
          } catch (clearErr) {
            insertFatal = clearErr;
            return;
          }
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
        // I1：INSERT 是事务内 DB 写，同 clear 单独 try 标 insertFatal（避免被 wrapReadError 误判 header）
        try {
          insertOne(date, row);
        } catch (insErr) {
          insertFatal = insErr;
          return;
        }
        insertedCount += 1;
      },
      onProgress: (dataRows) => emit({ type: 'progress', dataRows })
    });
  } catch (err) {
    // 表头 / 读取失败 → header-error（FileValidationError 带 code）；其他 → fatal
    db.exec('ROLLBACK');
    emitHeaderOrFatal(err);
    return; // emitHeaderOrFatal 已 emitAndExit（调度退出）
  }

  // I1：流式中途 clear/INSERT 系统写失败 → 整批 ROLLBACK + fatal（exit 2，非 header/读取错）
  //   数据完整性不变：ROLLBACK 撤销本事务内已 clear 旧数据 + 已 INSERT 的行 → DB 净 0 变化。
  if (insertFatal) {
    try { db.exec('ROLLBACK'); } catch (_rb) { /* ignore */ }
    return emitAndExit({
      type: 'fatal',
      message: '导入写入失败：' + (insertFatal && insertFatal.message ? insertFatal.message : String(insertFatal))
    }, 2);
  }

  // 首行 bu_name 空：整批拒绝（不入任何行）；report=false（旧语义 errorReportPath=null）
  if (firstBuEmpty) {
    db.exec('ROLLBACK');
    return emitAndExit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: firstEmptyRowIndex, reason: '业务方为空' }],
      rowErrorTotal: 1,
      truncated: false,
      firstBu: ''
    }, 1);
  }

  // rows.length===0：无有效数据行 → 整批拒绝（与旧同步语义一致）；report=false（errorReportPath=null）
  if (dataRowCount === 0) {
    db.exec('ROLLBACK');
    return emitAndExit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }],
      rowErrorTotal: 1,
      truncated: false,
      firstBu: null
    }, 1);
  }

  // 🔴 任一行校验失败 → 整批拒绝（ROLLBACK，不入任何行）；report=true（写失败报告 xlsx，含 rawRow）
  // I2（β.2 review fix）：rowErrorTotal=全量真实错误数、truncated=是否超 maxRowErrors 被截，
  //   随 rejected 上行，供主进程在报告里标注「共 N 条、仅列前 M 条」（errorRows 本身已截到 maxRowErrors）。
  if (errorRows.length > 0 || rowErrorTotal > 0) {
    db.exec('ROLLBACK');
    return emitAndExit({
      type: 'rejected',
      report: true,
      errorRows: errorRows.map(serializeErrorRow),
      rowErrorTotal,
      truncated: rowErrorTotal > errorRows.length,
      firstBu
    }, 1);
  }

  // 全部通过 → COMMIT（cleared 必为 true，因为 dataRowCount>0 且首行非空已 clear）
  void cleared;
  db.exec('COMMIT');
  return emitAndExit({ type: 'complete', status: 'success', buName: firstBu, validCount: insertedCount }, 0);
}

// ---------------- 流水导入（runFlowImportAsync 语义流式镜像） ----------------
//
// flow 差异（资金红线 ⑤）：不分 BU、无 BU 一致性、无 firstBu / bu_name 改写；
//   clear = clearRunsAndDiffsByDate(date)（跨所有 BU）+ clearByDate(date)（非 ByDateBu）。
//
// 🔴 v3.0.2 需求1b（资金红线 R-1）：支持 filePaths 多文件**单进程单事务合并**到同一 date。
//   语义 = 多文件合并为该 date 的完整流水快照（与「重导替换该 date」一致）。
//   关键：`cleared` 标志在**函数级**（跨所有文件共享）—— 首个含数据行的文件的首个数据行触发
//   clearByDate **只清一次**，后续文件不再 clear。dataRowCount / errorRows / insertedCount 跨文件累加。
//   若循环调用本函数（每文件各跑一次 BEGIN+clear+COMMIT），第 2 个文件的 clearByDate 会清掉第 1 个
//   文件已插入的行 → 静默丢数据（资金事故）。故必须单事务遍历所有文件。
//   单文件场景（filePaths 长度 1）byte-for-byte 等价旧单文件行为（clear 一次、行数一致、错误报告一致）。
async function runFlowImport(db, { date, filePaths, maxRowErrors }) {
  // 兼容防御：仅传 filePath（旧单数）时归一为单元素数组（不应发生，入口已校验 filePaths）。
  const files = Array.isArray(filePaths) ? filePaths : [];
  const multiFile = files.length > 1;   // 多文件才在错误原因里标注来源文件名（单文件保回归）

  let dataRowCount = 0;
  let insertedCount = 0;
  let cleared = false;           // 🔴 函数级：跨所有文件只 clear 一次（首个数据行触发）
  let insertFatal = null;        // I1：流式中途 clear/INSERT 事务内 DB 写失败（系统错）
  let progressBase = 0;          // 已读完文件的累计数据行数（多文件进度全局累加，避免切文件时倒退）
  const errorRows = [];
  let rowErrorTotal = 0;

  const insertOne = flowImportsRepository.makeRowInserter(db);

  db.exec('BEGIN');
  try {
    for (const filePath of files) {
      const sourceName = path.basename(filePath);   // 来源文件名（多文件错误定位用）
      const fileMeta = await streamFlowFile(filePath, {
        onDataRow: (row) => {
          dataRowCount += 1;
          if (insertFatal) return;   // 已遇系统写错：跳过后续行

          // 第一个数据行：事务内清旧数据（资金红线 ⑤：流水按 date 跨所有 BU 清）。
          // 🔴 cleared 函数级 → 多文件合并时仅首个数据行清一次，后续文件不再清（防互相覆盖丢数据）。
          if (!cleared) {
            // I1（β.2 review fix）：clear 单独 try 标 insertFatal（同 bizOp，避免被 wrapReadError 误判 header）
            try {
              runRepository.clearRunsAndDiffsByDate(db, date);
              flowImportsRepository.clearByDate(db, date);
            } catch (clearErr) {
              insertFatal = clearErr;
              return;
            }
            cleared = true;
          }

          const result = validateFlowRow(row);
          if (!result.ok) {
            rowErrorTotal += 1;
            // 多文件：原因前缀标注来源文件名，便于用户定位「哪个文件第几行错」（OPEN-T2）。
            //   单文件保持原 reason（byte 级回归一致）。rawRow 也带 _sourceFile 供报告 writer 可选用。
            const reason = multiFile ? `[${sourceName}] ${result.reason}` : result.reason;
            recordRowError(errorRows, maxRowErrors, { rowIndex: row._rowIndex, reason, rawRow: row });
            return;
          }
          // I1：INSERT 单独 try 标 insertFatal
          try {
            insertOne(date, row);
          } catch (insErr) {
            insertFatal = insErr;
            return;
          }
          insertedCount += 1;
        },
        // 多文件全局累加进度：每文件 onProgress 的 dataRows 是该文件内计数，叠加已读完文件的 base。
        onProgress: (dataRows) => emit({ type: 'progress', dataRows: progressBase + dataRows })
      });
      // 该文件读完：把其数据行数并入 base，供下个文件进度续接（streamFlowFile 返回 { dataRows }）。
      progressBase += (fileMeta && Number.isFinite(fileMeta.dataRows)) ? fileMeta.dataRows : 0;
    }
  } catch (err) {
    db.exec('ROLLBACK');
    emitHeaderOrFatal(err);
    return;
  }

  // I1：流式中途 clear/INSERT 系统写失败 → 整批 ROLLBACK + fatal（exit 2，非 header/读取错）
  if (insertFatal) {
    try { db.exec('ROLLBACK'); } catch (_rb) { /* ignore */ }
    return emitAndExit({
      type: 'fatal',
      message: '导入写入失败：' + (insertFatal && insertFatal.message ? insertFatal.message : String(insertFatal))
    }, 2);
  }

  // 无有效数据行 → 整批拒绝（report=false，errorReportPath=null）
  if (dataRowCount === 0) {
    db.exec('ROLLBACK');
    return emitAndExit({
      type: 'rejected',
      report: false,
      errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }],
      rowErrorTotal: 1,
      truncated: false
    }, 1);
  }

  // 🔴 任一行校验失败 → 整批拒绝（report=true，写失败报告 xlsx，含 rawRow）
  // I2（β.2 review fix）：rowErrorTotal/truncated 随 rejected 上行（供主进程报告标注截断），errorRows 已截到 maxRowErrors
  if (errorRows.length > 0 || rowErrorTotal > 0) {
    db.exec('ROLLBACK');
    return emitAndExit({
      type: 'rejected',
      report: true,
      errorRows: errorRows.map(serializeErrorRow),
      rowErrorTotal,
      truncated: rowErrorTotal > errorRows.length
    }, 1);
  }

  void cleared;
  db.exec('COMMIT');
  return emitAndExit({ type: 'complete', status: 'success', totalCount: insertedCount, validCount: insertedCount }, 0);
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
// I3：用 emitAndExit（刷盘后退出）；调用方在其后 return 结束当前函数。
function emitHeaderOrFatal(err) {
  if (err && err.name === 'FileValidationError') {
    emitAndExit({
      type: 'header-error',
      errorCode: err.code || null,
      message: err.message || String(err),
      detailLines: Array.isArray(err.detailLines) ? err.detailLines : []
    }, 1);
    return;
  }
  emitAndExit({ type: 'fatal', message: err && err.message ? err.message : String(err) }, 2);
}

async function main() {
  const job = loadJobMeta();
  if (!job) return;   // I3：loadJobMeta 失败已 emitAndExit（调度退出），不继续
  // bizOp 走 filePath（单数，不变）；flow 走 filePaths（v3.0.2 需求1b 多文件合并）。
  const { dbPath, kind, date, filePath } = job;
  const filePaths = Array.isArray(job.filePaths) ? job.filePaths : null;
  const maxRowErrors = Number.isFinite(job.maxRowErrors) && job.maxRowErrors > 0
    ? job.maxRowErrors
    : DEFAULT_MAX_ROW_ERRORS;

  if (!dbPath || !kind || !date) {
    return emitAndExit({ type: 'fatal', message: 'jobMeta 缺字段（dbPath / kind / date）' }, 2);
  }
  if (kind !== 'bizOp' && kind !== 'flow') {
    return emitAndExit({ type: 'fatal', message: `未知 kind: ${kind}（仅 bizOp / flow）` }, 2);
  }
  // bizOp：filePath 单数必填（不动）；flow：filePaths 非空数组必填（v3.0.2 需求1b）。
  if (kind === 'bizOp' && !filePath) {
    return emitAndExit({ type: 'fatal', message: 'jobMeta 缺字段（bizOp 需 filePath）' }, 2);
  }
  if (kind === 'flow' && (!filePaths || filePaths.length === 0)) {
    return emitAndExit({ type: 'fatal', message: 'jobMeta 缺字段（flow 需非空 filePaths 数组）' }, 2);
  }

  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    return emitAndExit({ type: 'fatal', message: 'DB open 失败：' + (err && err.message ? err.message : String(err)) }, 2);
  }

  try {
    if (kind === 'bizOp') {
      await runBizOpImport(db, { date, filePath, maxRowErrors });
    } else {
      await runFlowImport(db, { date, filePaths, maxRowErrors });
    }
    // runXxxImport 内各路径均已 emitAndExit（调度退出）；此处自然返回，finally 关库后事件循环 drain 即退出
  } catch (err) {
    // 走到这里说明 INSERT/事务阶段意外异常（理论上已被 insertFatal 捕获，这里兜底）
    try { db.exec('ROLLBACK'); } catch (_rb) { /* ignore */ }
    emitAndExit({ type: 'fatal', message: '导入阶段失败：' + (err && err.message ? err.message : String(err)) }, 2);
  } finally {
    try { db.close(); } catch (_e) { /* ignore */ }
  }
}

main().catch((err) => {
  emitAndExit({ type: 'fatal', message: 'worker 未捕获异常：' + (err && err.message ? err.message : String(err)) }, 2);
});
