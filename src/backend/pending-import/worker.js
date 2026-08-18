// Pending 导入 worker（child process 入口）
// 由主进程 spawn：node --max-old-space-size=8192 <此文件> <jobMetaJson>
//
// jobMeta = { dbPath, yearMonth, files: [absPath, ...], archivePath?: string }
//
// 输出协议（每行一个 JSON）：
//   {"type":"progress","file":"xxx.xlsx","rowsProcessed":10000}
//   {"type":"error","errors":[{severity:"fatal"|"row",...}]}
//   {"type":"complete","rowCount":100000,"sourceFiles":["xxx.xlsx"]}
//
// 退出码：0 成功 / 1 校验失败 / 2 系统错误

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../pending-db/migrations');
const PENDING_COLUMNS = require('../pending-db/columns');
const {
  freezePendingDatasetSeedV1,
  identityFromPendingDatasetSeed
} = require('../pending-db/dataset-identity');
const { validateHeaders, computeRowHash } = require('./validator');
const { readXlsxStreamed } = require('./streaming-xlsx-reader');
const monthRepo = require('../pending-db/month-repository');
const {
  freezeWorkerBatchContext
} = require('../../main-process/archive-center/worker-batch-context');

// 错误数量上限：防止百万级行级错误累积后 emit 巨型 JSON 把 stdout 管道撑爆
// 超过上限只保留前 N 条 + 剩余计数，N 条里可用 cells 字段导报错 xlsx
const MAX_ROW_ERRORS_EMITTED = 1000;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// 诊断：启动时把 heap 限制写到 stderr，便于排查 --max-old-space-size 是否生效
const heapStats = v8.getHeapStatistics();
process.stderr.write(
  `[worker-boot] heap_size_limit=${(heapStats.heap_size_limit / 1024 / 1024).toFixed(0)} MB ` +
  `exec=${process.execPath} ` +
  `execArgv=${JSON.stringify(process.execArgv)} ` +
  `NODE_OPTIONS=${process.env.NODE_OPTIONS || '(none)'}\n`
);

function loadJobMeta() {
  const raw = process.argv[2];
  if (!raw) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'missing jobMeta (argv[2])' }] });
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'jobMeta 解析失败: ' + err.message }] });
    process.exit(2);
  }
}

// 原 normalizeXlsxCell / readXlsxHeadersAndRows（ExcelJS 全载入）已被流式 reader 替代
// 流式 reader 直接输出 string[31]，byte-level 与 ExcelJS 一致（已 test-v2.0.0-streaming-diff.js 验证）

async function main() {
  const job = loadJobMeta();
  const batchContext = freezeWorkerBatchContext(job.batchContext);
  void batchContext;
  const { dbPath, yearMonth, files, archivePath } = job;

  if (!dbPath || !yearMonth || !Array.isArray(files) || files.length === 0) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'jobMeta 缺字段（dbPath / yearMonth / files）' }] });
    process.exit(2);
  }
  const datasetSeed = freezePendingDatasetSeedV1(job.datasetSeed);

  // DB 先开；需要流式 INSERT（边读边写），否则 allRows 在内存里 300 万行 × 31 列会 OOM
  let db;
  try {
    db = new DatabaseSync(dbPath);
    runMigrations(db);
  } catch (err) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'DB open 失败：' + err.message }] });
    process.exit(2);
  }

  const errors = [];
  let rowErrorCount = 0; // 行级错误真实总数（可能超过 errors 里的条数上限）
  const hashSet = new Set(); // 跨文件去重 key；只存 40 字节 hex，300 万行 ~360MB
  let totalInserted = 0;
  let hasFatal = false;

  db.exec('BEGIN');
  const datasetIdentity = identityFromPendingDatasetSeed(
    monthRepo.getMonthMeta(db, yearMonth),
    datasetSeed
  );
  monthRepo.deleteMonth(db, yearMonth);
  const insertRow = monthRepo.createRowInserter(db);

  try {
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      if (!fs.existsSync(filePath)) {
        errors.push({ severity: 'fatal', file: fileName, message: '文件不存在' });
        hasFatal = true;
        continue;
      }

      // 流式：每一行 sax callback 做校验 + INSERT；fatal 抛 __abort 中断 stream
      let fileTotalRows = 0;
      let fileDataRowsInserted = 0;
      let headerChecked = false;
      let fileHasFatal = false;

      try {
        await readXlsxStreamed(filePath, (cells, rowIdx) => {
          fileTotalRows = rowIdx;
          if (rowIdx === 1) {
            const hdr = validateHeaders(cells);
            if (!hdr.ok) {
              errors.push({ severity: 'fatal', file: fileName, message: hdr.error });
              fileHasFatal = true;
              const abort = new Error(hdr.error);
              abort.__abort = true;
              throw abort;
            }
            headerChecked = true;
            return;
          }
          // 数据行
          const rowHash = computeRowHash(cells);
          if (hashSet.has(rowHash)) {
            rowErrorCount += 1;
            if (errors.filter((e) => e.severity === 'row').length < MAX_ROW_ERRORS_EMITTED) {
              errors.push({
                severity: 'row',
                file: fileName,
                sheetRow: rowIdx,
                message: `发现重复行（hash ${rowHash.slice(0, 8)}...）`,
                cells: cells.slice()
              });
            }
            return;
          }
          hashSet.add(rowHash);
          insertRow(yearMonth, rowHash, cells);
          fileDataRowsInserted += 1;
          totalInserted += 1;
        });
      } catch (err) {
        if (!err.__abort) {
          errors.push({ severity: 'fatal', file: fileName, message: 'xlsx 解析失败：' + err.message });
          fileHasFatal = true;
        }
      }

      if (fileHasFatal) {
        hasFatal = true;
        continue;
      }
      if (!headerChecked || fileTotalRows < 2) {
        errors.push({ severity: 'fatal', file: fileName, message: '文件为空或只有表头行' });
        hasFatal = true;
        continue;
      }

      emit({ type: 'progress', file: fileName, rowsProcessed: fileDataRowsInserted, totalInserted });
    }

    if (hasFatal || errors.length > 0) {
      db.exec('ROLLBACK');
      const rowEmitted = errors.filter((e) => e.severity === 'row').length;
      emit({
        type: 'error',
        errors,
        rowErrorTotal: rowErrorCount,
        rowErrorTruncated: rowErrorCount > rowEmitted
      });
      process.exit(1);
    }

    const sourceFiles = files.map((f) => path.basename(f));
    monthRepo.upsertMonthMeta(db, {
      yearMonth,
      rowCount: totalInserted,
      sourceFiles,
      archivePath: archivePath || null,
      datasetIdentity
    });
    db.exec('COMMIT');
    emit({ type: 'complete', rowCount: totalInserted, sourceFiles });
    process.exit(0);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_rbErr) { /* ignore */ }
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'INSERT 阶段失败：' + err.message }] });
    process.exit(2);
  } finally {
    try { db.close(); } catch (_err) { /* ignore */ }
  }
}

main().catch((err) => {
  emit({ type: 'error', errors: [{ severity: 'fatal', message: 'worker 未捕获异常：' + (err && err.message ? err.message : String(err)) }] });
  process.exit(2);
});
