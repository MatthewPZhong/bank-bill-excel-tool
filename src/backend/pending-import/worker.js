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
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../pending-db/migrations');
const PENDING_COLUMNS = require('../pending-db/columns');
const { validateHeaders, computeRowHash } = require('./validator');
const monthRepo = require('../pending-db/month-repository');

// 错误数量上限：防止百万级行级错误累积后 emit 巨型 JSON 把 stdout 管道撑爆
// 超过上限只保留前 N 条 + 剩余计数，N 条里可用 cells 字段导报错 xlsx
const MAX_ROW_ERRORS_EMITTED = 1000;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

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

function normalizeXlsxCell(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  // ExcelJS formula cell: { formula, result } — 取 result
  if (typeof value === 'object' && value !== null) {
    if ('result' in value && value.result !== undefined) return normalizeXlsxCell(value.result);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text || '').join('');
    }
    if ('hyperlink' in value && 'text' in value) return String(value.text || '');
  }
  return String(value);
}

// ExcelJS row.values 下标从 1 开始；第 0 位是 sparse 占位
// 返回 2 维数组 [[header], [row1], ...]，和旧 XLSX 接口兼容，下游代码不改
async function readXlsxHeadersAndRows(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('文件无 Sheet');

  const result = [];
  const colCount = PENDING_COLUMNS.length;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      cells[c] = row.getCell(c + 1).value; // ExcelJS 1-based
    }
    result.push(cells);
  });
  return result;
}

async function main() {
  const job = loadJobMeta();
  const { dbPath, yearMonth, files, archivePath } = job;

  if (!dbPath || !yearMonth || !Array.isArray(files) || files.length === 0) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'jobMeta 缺字段（dbPath / yearMonth / files）' }] });
    process.exit(2);
  }

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

      let rows;
      try {
        rows = await readXlsxHeadersAndRows(filePath);
      } catch (err) {
        errors.push({ severity: 'fatal', file: fileName, message: 'xlsx 解析失败：' + err.message });
        hasFatal = true;
        continue;
      }

      if (rows.length < 2) {
        errors.push({ severity: 'fatal', file: fileName, message: '文件为空或只有表头行' });
        hasFatal = true;
        rows = null;
        continue;
      }

      const headerCheck = validateHeaders(rows[0]);
      if (!headerCheck.ok) {
        errors.push({ severity: 'fatal', file: fileName, message: headerCheck.error });
        hasFatal = true;
        rows = null;
        continue;
      }

      for (let i = 1; i < rows.length; i++) {
        const rawRow = rows[i];
        const cells = new Array(PENDING_COLUMNS.length);
        for (let c = 0; c < PENDING_COLUMNS.length; c++) {
          cells[c] = normalizeXlsxCell(rawRow[c]);
        }

        const rowHash = computeRowHash(cells);
        if (hashSet.has(rowHash)) {
          rowErrorCount += 1;
          if (errors.filter((e) => e.severity === 'row').length < MAX_ROW_ERRORS_EMITTED) {
            errors.push({
              severity: 'row',
              file: fileName,
              sheetRow: i + 1,
              message: `发现重复行（hash ${rowHash.slice(0, 8)}...）`,
              cells
            });
          }
          continue;
        }
        hashSet.add(rowHash);
        insertRow(yearMonth, rowHash, cells); // 流式 INSERT，释放单行引用给 V8 GC
        totalInserted += 1;
      }

      rows = null; // 释放整文件 wb 引用，给 V8 GC 机会回收
      emit({ type: 'progress', file: fileName, rowsProcessed: 0, totalInserted });
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
      archivePath: archivePath || null
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
