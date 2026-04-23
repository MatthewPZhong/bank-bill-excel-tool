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
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../pending-db/migrations');
const PENDING_COLUMNS = require('../pending-db/columns');
const { validateHeaders, validateFundType, computeRowHash, FUND_TYPE_COLUMN } = require('./validator');
const monthRepo = require('../pending-db/month-repository');

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
  return String(value);
}

function readXlsxHeadersAndRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('文件无 Sheet');
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

function main() {
  const job = loadJobMeta();
  const { dbPath, yearMonth, files, archivePath } = job;

  if (!dbPath || !yearMonth || !Array.isArray(files) || files.length === 0) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'jobMeta 缺字段（dbPath / yearMonth / files）' }] });
    process.exit(2);
  }

  const errors = [];
  const allRows = [];
  const hashSet = new Set();
  const fundTypeIdx = PENDING_COLUMNS.indexOf(FUND_TYPE_COLUMN);

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (!fs.existsSync(filePath)) {
      errors.push({ severity: 'fatal', file: fileName, message: '文件不存在' });
      continue;
    }

    let rows;
    try {
      rows = readXlsxHeadersAndRows(filePath);
    } catch (err) {
      errors.push({ severity: 'fatal', file: fileName, message: 'xlsx 解析失败：' + err.message });
      continue;
    }

    if (rows.length < 2) {
      errors.push({ severity: 'fatal', file: fileName, message: '文件为空或只有表头行' });
      continue;
    }

    const headerCheck = validateHeaders(rows[0]);
    if (!headerCheck.ok) {
      errors.push({ severity: 'fatal', file: fileName, message: headerCheck.error });
      continue;
    }

    for (let i = 1; i < rows.length; i++) {
      const rawRow = rows[i];
      const cells = new Array(PENDING_COLUMNS.length);
      for (let c = 0; c < PENDING_COLUMNS.length; c++) {
        cells[c] = normalizeXlsxCell(rawRow[c]);
      }

      const fundTypeValue = cells[fundTypeIdx];
      if (!validateFundType(fundTypeValue)) {
        errors.push({
          severity: 'row',
          file: fileName,
          sheetRow: i + 1,
          message: `${FUND_TYPE_COLUMN} 值不合法："${fundTypeValue}"，仅允许 {提现/退票/充值}`,
          cells
        });
        continue;
      }

      const rowHash = computeRowHash(cells);
      if (hashSet.has(rowHash)) {
        errors.push({
          severity: 'row',
          file: fileName,
          sheetRow: i + 1,
          message: `发现重复行（hash ${rowHash.slice(0, 8)}...）`,
          cells
        });
        continue;
      }
      hashSet.add(rowHash);
      allRows.push({ rowHash, cells, sourceFile: fileName, sheetRow: i + 1 });
    }

    emit({ type: 'progress', file: fileName, rowsProcessed: rows.length - 1 });
  }

  if (errors.length > 0) {
    emit({ type: 'error', errors });
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
    runMigrations(db);
  } catch (err) {
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'DB open 失败：' + err.message }] });
    process.exit(2);
  }

  try {
    db.exec('BEGIN');
    monthRepo.deleteMonth(db, yearMonth);
    const insertRow = monthRepo.createRowInserter(db);
    for (const r of allRows) {
      insertRow(yearMonth, r.rowHash, r.cells);
    }
    const sourceFiles = files.map((f) => path.basename(f));
    monthRepo.upsertMonthMeta(db, {
      yearMonth,
      rowCount: allRows.length,
      sourceFiles,
      archivePath: archivePath || null
    });
    db.exec('COMMIT');
    emit({ type: 'complete', rowCount: allRows.length, sourceFiles });
    process.exit(0);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_rbErr) { /* ignore */ }
    emit({ type: 'error', errors: [{ severity: 'fatal', message: 'INSERT 阶段失败：' + err.message }] });
    process.exit(2);
  } finally {
    try { db.close(); } catch (_err) { /* ignore */ }
  }
}

main();
