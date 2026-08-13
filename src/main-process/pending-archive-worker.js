#!/usr/bin/env node
// Pending 留底 worker（archive 子进程入口）
// 由 session.archiveExistingMonth 通过 utilityProcess.fork / spawn 启动
//
// argv[2] = { dbPath, yearMonth, archivePath }
// 事件（stdout JSON / line）: progress | complete | error
// 退出码：0 成功 / 2 失败

const { DatabaseSync } = require('node:sqlite');
const PENDING_COLUMNS = require('../backend/pending-db/columns');
const { writeStreamedXlsx } = require('../backend/pending-import/streaming-xlsx-writer');
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');

function emit(ev) { process.stdout.write(JSON.stringify(ev) + '\n'); }

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    emit({ type: 'error', message: 'missing jobMeta (argv[2])' });
    process.exit(2);
  }
  let job;
  try { job = JSON.parse(raw); }
  catch (err) {
    emit({ type: 'error', message: 'jobMeta 解析失败: ' + err.message });
    process.exit(2);
  }
  const batchContext = freezeWorkerBatchContext(job.batchContext);
  void batchContext;
  const { dbPath, yearMonth, archivePath } = job;
  if (!dbPath || !yearMonth || !archivePath) {
    emit({ type: 'error', message: 'jobMeta 字段缺失 (dbPath/yearMonth/archivePath)' });
    process.exit(2);
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    emit({ type: 'error', message: 'DB open 失败: ' + err.message });
    process.exit(2);
  }

  const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
  const stmt = db.prepare(`SELECT ${colList} FROM pending_rows WHERE year_month = ? ORDER BY id`);

  // 流式 iterator：每次 SQLite yield 一行，转为 31 列字符串数组
  function* iterateRows() {
    let count = 0;
    for (const row of stmt.iterate(yearMonth)) {
      count += 1;
      if (count % 50000 === 0) emit({ type: 'progress', rowsWritten: count });
      yield PENDING_COLUMNS.map((c) => {
        const v = row[c];
        return v == null ? '' : String(v);
      });
    }
    emit({ type: 'progress', rowsWritten: count, final: true });
  }

  try {
    await writeStreamedXlsx(archivePath, PENDING_COLUMNS.slice(), iterateRows());
    emit({ type: 'complete', archivePath });
    process.exit(0);
  } catch (err) {
    emit({ type: 'error', message: 'xlsx 写入失败: ' + err.message });
    process.exit(2);
  } finally {
    try { db.close(); } catch (_e) { /* ignore */ }
  }
}

main().catch((err) => {
  emit({ type: 'error', message: 'worker 未捕获异常: ' + (err && err.message ? err.message : String(err)) });
  process.exit(2);
});
