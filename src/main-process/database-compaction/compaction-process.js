'use strict';

// v3.2.17 空闲整理主库的独立子进程：执行 VACUUM 与 WAL 截断，结果以一行 JSON 写到 stdout。
// 放在可强制结束的子进程里，是为了用户一有操作就能立即中止：进程被结束等同于一次崩溃，
// SQLite 会丢弃未提交的整理内容，数据库保持整理前的状态。
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_error) { return 0; }
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function run() {
  const request = JSON.parse(process.argv[2] || '{}');
  const dbPath = String(request.dbPath || '');
  if (!dbPath) throw Object.assign(new Error('缺少数据库路径'), { code: 'compaction-invalid-request' });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const freelistBefore = Number(db.prepare('PRAGMA freelist_count').get().freelist_count) * pageSize;
    const sizeBefore = fileSize(dbPath);
    const startedAt = Date.now();
    db.exec('VACUUM');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const integrity = db.prepare('PRAGMA quick_check').get();
    const integrityOk = integrity && Object.values(integrity)[0] === 'ok';
    emit({
      status: integrityOk ? 'done' : 'integrity-failed',
      sizeBefore,
      sizeAfter: fileSize(dbPath),
      walAfter: fileSize(`${dbPath}-wal`),
      freelistBefore,
      checkpointBusy: checkpoint ? Number(checkpoint.busy) || 0 : null,
      durationMs: Date.now() - startedAt
    });
    return integrityOk ? 0 : 1;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = run();
} catch (error) {
  emit({
    status: 'error',
    code: error && error.code ? String(error.code) : 'compaction-failed',
    message: error && error.message ? error.message : String(error)
  });
  process.exitCode = 1;
}
