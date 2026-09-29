// 收单仓储/执行边界集成：真实临时 SQLite、worker、XLSX import/export。
// 覆盖逐行物理顺序、受管旧 part 重建/顺序复用、取消、部分 merge + cleanup 失败后的 partial/resume。
// 用法：node scripts/integration/acquiring-worker-boundary.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const repository = require('../../src/backend/acquiring-bill-currency-db/run-repository');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');
const DIFF = 'acquiring_bill_currency_diff_rows';
const MONTH = '2026-04';
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }
function rows(db, runId) {
  return db.prepare(`SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type FROM ${DIFF} WHERE run_id=? ORDER BY id`).all(runId);
}
function latest(db) { return db.prepare('SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get(); }
async function workbook(file, headers, data) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1'); sheet.addRow(headers); data.forEach(row => sheet.addRow(row));
  await wb.xlsx.writeFile(file);
}
async function seed(db, root) {
  const flows = [], bills = [];
  for (let i = 0; i < 120; i++) {
    const flow = new Array(48).fill(''); const bill = new Array(26).fill('');
    flow[0] = bill[0] = '2026-04-15'; flow[6] = bill[14] = `BOUNDARY-${i}`;
    flow[12] = flow[28] = bill[18] = `${100 + i}.25`;
    flow[13] = flow[29] = 'USD'; bill[19] = i % 3 === 0 ? 'EUR' : 'USD';
    flows.push(flow); bills.push(bill);
  }
  const flowFile = path.join(root, 'flow.xlsx'), billFile = path.join(root, 'bill.xlsx');
  await workbook(flowFile, FLOW_HEADERS, flows); await workbook(billFile, BILL_HEADERS, bills);
  await session.importFlowFiles({ db, monthKey: MONTH, filePaths: [flowFile] });
  await session.importBillFiles({ db, monthKey: MONTH, filePaths: [billFile] });
}
function oldPart(file) {
  const part = new DatabaseSync(file);
  try {
    part.exec('CREATE TABLE diff_part (seq INTEGER PRIMARY KEY, bill_import_id INTEGER, flow_currency TEXT, flow_amount_abs TEXT, diff_type TEXT)');
    part.exec("INSERT INTO diff_part VALUES (1,999999,'GARBAGE','999999','stale')");
  } finally { part.close(); }
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-worker-boundary-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const app = new AppDatabase(dbPath); app.init(); const db = app.db;
  // 此 fixture 明确授权固定目录中的 part 命名空间，只顺序调用；其他文件不是执行器所有物。
  const tempDir = path.join(root, '.mw-tmp'); fs.mkdirSync(tempDir);
  fs.writeFileSync(path.join(tempDir, 'caller-marker.txt'), 'caller-owned');
  fs.mkdirSync(path.join(tempDir, 'keep')); fs.writeFileSync(path.join(tempDir, 'keep', 'nested.txt'), 'nested-owned');
  oldPart(path.join(tempDir, 'part-999.sqlite'));
  const untouched = fs.readFileSync(path.join(tempDir, 'part-999.sqlite'));
  const options = { db, dbPath, monthKey: MONTH, storageRoot: root, chunkSize: 20, workerCount: 4, tempDir, __forceMultiWorkerForTest: true };
  const checkCaller = () => {
    assert.equal(fs.readFileSync(path.join(tempDir, 'caller-marker.txt'), 'utf8'), 'caller-owned');
    assert.equal(fs.readFileSync(path.join(tempDir, 'keep', 'nested.txt'), 'utf8'), 'nested-owned');
    assert.deepEqual(fs.readFileSync(path.join(tempDir, 'part-999.sqlite')), untouched);
    assert.deepEqual(fs.readdirSync(tempDir).filter(name => /^part-[0-5]\.sqlite/.test(name)), []);
  };
  try {
    await seed(db, root);
    await session.runCheckCore({ ...options, workerCount: 1 });
    const baseline = rows(db, latest(db).id);
    check('单 worker 基线有 40 行按物理 id 排序的 diff', () => assert.equal(baseline.length, 40));
    for (const workerCount of [2, 4]) {
      oldPart(path.join(tempDir, 'part-0.sqlite'));
      await session.runCheckCore({ ...options, workerCount });
      check(`M=${workerCount} C1 跨 run 重建，逐行及物理顺序等价`, () => assert.deepEqual(rows(db, latest(db).id), baseline));
      check(`M=${workerCount} caller 根/无关文件/未派发旧 part 保留`, checkCaller);
      check(`M=${workerCount} 输出发布完成后才 complete`, () => assert.equal(repository.getRunChunkProgress(db, latest(db).id).status, 'complete'));
    }
    const cancelToken = { cancelled: false };
    await assert.rejects(session.runCheckCore({ ...options, cancelToken, onProgress(ev) {
      if (Number.isInteger(ev.chunkIndex)) cancelToken.cancelled = true;
    } }), { name: 'CancelError' });
    let run = latest(db);
    check('取消真实多 worker 后 partial / -1 / 无 diff', () => {
      const progress = repository.getRunChunkProgress(db, run.id);
      assert.equal(progress.status, 'partial'); assert.equal(progress.lastCompletedChunkIndex, -1);
      assert.equal(rows(db, run.id).length, 0);
    });
    check('取消结束才可复用 caller 目录，精确清理保持', checkCaller);
    await session.runCheckCore({ ...options, resumeFromRun: { runId: run.id, lastCompletedChunkIndex: -1 } });
    check('取消后从 0 单 worker resume，与基线逐行一致', () => assert.deepEqual(rows(db, run.id), baseline));

    let installed = false;
    await assert.rejects(session.runCheckCore({ ...options, onProgress(ev) {
      if (ev.stage !== 'sql-joining' || installed) return;
      installed = true;
      // 第一 chunk 可 COMMIT；后续 chunk INSERT 中断，失败清理也被真实 SQLite trigger 拒绝。
      db.exec(`CREATE TRIGGER interrupt_merge BEFORE INSERT ON ${DIFF} WHEN NEW.bill_import_id > 20 BEGIN SELECT RAISE(ABORT, 'merge-interrupted'); END;`);
      db.exec(`CREATE TRIGGER interrupt_cleanup BEFORE DELETE ON ${DIFF} BEGIN SELECT RAISE(ABORT, 'cleanup-interrupted'); END;`);
    } }), /merge-interrupted/);
    run = latest(db);
    check('部分 merge 与 cleanup 失败保留首错误及已提交残留，不宣称 run 原子性', () => {
      assert.ok(rows(db, run.id).length > 0); assert.ok(rows(db, run.id).length < baseline.length);
      const progress = repository.getRunChunkProgress(db, run.id);
      assert.equal(progress.status, 'partial'); assert.equal(progress.lastCompletedChunkIndex, -1);
    });
    check('merge/cleanup 失败后的结束清理仅影响本次 part', checkCaller);
    db.exec('DROP TRIGGER interrupt_merge; DROP TRIGGER interrupt_cleanup;');
    await session.runCheckCore({ ...options, resumeFromRun: { runId: run.id, lastCompletedChunkIndex: -1 } });
    check('部分 COMMIT 残留从 0 单 worker resume 不重复计入', () => assert.deepEqual(rows(db, run.id), baseline));
    check('resume 复用 runId，发布后 complete', () => {
      assert.equal(latest(db).id, run.id); assert.equal(repository.getRunChunkProgress(db, run.id).status, 'complete');
    });
    console.log(`==== ${passed}/${passed} PASS ====`);
  } finally {
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('FAILURES:', error); process.exitCode = 1; });
