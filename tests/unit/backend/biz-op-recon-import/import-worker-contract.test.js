'use strict';
// v2.1.12-beta β.2-T2 contract test（🔴 资金/数据完整性红线）
// 锁：bizOpRecon 导入 worker 路径（import-worker.js + session.runBizOpImportViaWorker/runFlowImportViaWorker）
//   与旧同步路径（runBizOpImportAsync/runFlowImportAsync）在同一 fixture 上 **同输出**。
//
// 覆盖（语义零改变断言）：
//   ① 业务OP 成功：worker vs 同步 入库行数 / firstBu / 落库行内容逐行一致 + DB 行数一致
//   ② 业务OP 校验失败整批拒绝：errorRows(rowIndex+reason) 一致 + DB 0 行 + report=写报告(路径非空)
//   ③ 业务OP 首行 bu_name 空：rejected + errorReportPath=null（不写报告）+ DB 0 行
//   ④ 业务OP 空文件（仅表头）：rejected '文件无有效数据行' + errorReportPath=null
//   ⑤ 🔴 (date,BU)+D+1 替换原子事务：worker 重导 D 后 D+1/同BU 旧 run 被清（资金红线 Q）
//   ⑥ 🔴 bu_name 改写：worker 落库后所有行 bu_name=firstBu(trim 保大小写)
//   ⑦ 表头不匹配：worker status='error' 同步 throw 同 errorCode（FileValidationError）
//   ⑧ 流水成功：worker vs 同步 入库行数一致 + DB 行数一致
//   ⑨ 流水校验失败整批拒绝：errorRows 一致 + DB 0 行
//   ⑩ 🔴 流水重导清"该 date 跨所有 BU"旧 runs（资金红线 P）
//
// worker 路径在测试环境（非 Electron）走 spawnImportWorker 的 spawn(process.execPath) 分支。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../../../src/backend/database');
const session = require('../../../../src/main-process/biz-op-recon-session');
const writer = require('../../../../src/main-process/biz-op-recon-writer');
const importsRepo = require('../../../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../../../src/backend/biz-op-recon-db/run-repository');
const datasetHeadRepo = require('../../../../src/backend/biz-op-recon-db/dataset-head-repository');
const { BIZ_OP_HEADERS, FLOW_HEADERS } = require('../../../../src/backend/biz-op-recon-db/columns');

const WORKER_BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'bizop-legacy-worker-contract',
  taskKey: 'bizOpRecon:import:run-biz-op',
  moduleId: 'biz-op-reconciliation',
  parentRunId: 'bizop-legacy-parent',
  operationKey: 'bizop-legacy-operation'
});

let datasetSequence = 0;
function nextBizOpDatasetSeed(producerTaskRunId = WORKER_BATCH_CONTEXT.taskRunId) {
  datasetSequence += 1;
  return {
    datasetId: `biz-op-worker-contract-${datasetSequence}`,
    producerTaskRunId
  };
}

function nextFlowDatasetSeed(db, date, producerTaskRunId = WORKER_BATCH_CONTEXT.taskRunId) {
  datasetSequence += 1;
  const previous = datasetHeadRepo.getHead(db, 'flow', date);
  return {
    datasetId: `biz-flow-worker-contract-${datasetSequence}`,
    producerTaskRunId,
    expectedDatasetId: previous ? previous.datasetId : null,
    expectedDatasetVersion: previous ? previous.datasetVersion : 0
  };
}

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// 新建独立主 DB（worker 子进程会 new DatabaseSync(dbPath) 打开同库 WAL 并发）
function freshDb() {
  const dir = mkTmpDir('bizop-worker-db-');
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  return { appDb, db: appDb.db, dbPath, dir };
}

// 业务OP 行（22 列；列序严格对齐 BIZ_OP_HEADERS）
// opts: { begin, amount, end, currency, billDate }；默认满足双重校验（end=begin+amount, in/out 自动）
function bizOpRowArray(bu, accountNo, opts = {}) {
  const begin = opts.begin == null ? 0 : opts.begin;
  const amount = opts.amount == null ? 0 : opts.amount;
  const amountIn = opts.amountIn == null ? Math.max(amount, 0) : opts.amountIn;
  const amountOut = opts.amountOut == null ? Math.max(-amount, 0) : opts.amountOut;
  const end = opts.end == null ? (begin + amount) : opts.end;
  // 顺序：Billdate,业务方,客户编号,主体,账户号,账户类型,币种,期初,发生额,入,出,期末,期末可用,期末冻结,
  //   最近更新,通道,ppCardId,银行卡号,扩展信息,账户状态,BizId,清结算创建,清结算更新
  return [
    opts.billDate || '', bu, '', '', accountNo, '', opts.currency || 'CNY',
    String(begin), String(amount), String(amountIn), String(amountOut), String(end),
    '', '', '', '', '', '', '', '', '', '', ''
  ];
}

// 流水行（28 列；列序严格对齐 FLOW_HEADERS）
// 关键列：业务部门(7)=bu_dept, 出入方向(9)=direction, 账户编号(12)=account_no, 对账金额(14)=recon_amount
function flowRowArray(bu, accountNo, direction, amount, opts = {}) {
  const r = new Array(FLOW_HEADERS.length).fill('');
  r[1] = opts.billDate || '';   // 账单日期
  r[6] = bu;                    // 业务部门
  r[8] = direction;             // 出入方向
  r[11] = accountNo;            // 账户编号
  r[13] = String(amount);       // 对账金额
  r[14] = opts.currency || 'CNY';
  return r;
}

async function writeXlsx(headerArr, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headerArr.slice());
  for (const row of dataRows) ws.addRow(row);
  const dir = mkTmpDir('bizop-worker-fx-');
  const fp = path.join(dir, 'fixture.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

// 取 imports 表全部行（按 row_index 升序），仅保留可比对的列
function dumpImports(db, date, bu) {
  return importsRepo.getRowsByDateBu(db, date, bu).map((r) => ({
    row_index: r.row_index, bu_name: r.bu_name, account_no: r.account_no,
    begin_balance: r.begin_balance, amount: r.amount, end_balance: r.end_balance
  }));
}
function dumpFlow(db, date) {
  return flowRepo.getRowsByDate(db, date).map((r) => ({
    row_index: r.row_index, account_no: r.account_no, direction: r.direction, recon_amount: r.recon_amount
  }));
}

function dumpBizOpWriteState(db) {
  return {
    imports: db.prepare('SELECT * FROM biz_op_recon_imports ORDER BY id').all(),
    runs: db.prepare('SELECT * FROM biz_op_recon_runs ORDER BY id').all(),
    diffs: db.prepare('SELECT * FROM biz_op_recon_diff_rows ORDER BY id').all(),
    heads: db.prepare(`
      SELECT * FROM biz_op_recon_dataset_heads
      ORDER BY dataset_kind, data_date, normalized_bu
    `).all()
  };
}

// ---------------- ① 业务OP 成功：worker vs 同步同输出 ----------------
test('bizOp 成功导入：worker 路径 vs 旧同步路径 入库行数/firstBu/落库内容一致', async () => {
  const date = '2026-06-10';
  const rows = [
    bizOpRowArray('BU-A', 'ACC001', { begin: 100, amount: 50, end: 150 }),
    bizOpRowArray('BU-A', 'ACC002', { begin: 0, amount: -30, end: -30 }),
    bizOpRowArray('BU-A', 'ACC003', { begin: 200, amount: 0, end: 200 })
  ];
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);
  const { readBizOpFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  // 同步路径
  const sync = freshDb();
  const errDirSync = path.join(sync.dir, 'err');
  const syncRes = await session.runBizOpImportAsync(sync.db, {
    date, filePath: fp, readBizOpFile,
    datasetSeed: nextBizOpDatasetSeed('biz-op-sync-success'),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: errDirSync
  });
  const syncRows = dumpImports(sync.db, date, 'BU-A');
  sync.db.close();

  // worker 路径
  const wk = freshDb();
  const errDirWk = path.join(wk.dir, 'err');
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: errDirWk
  });
  const wkRows = dumpImports(wk.db, date, 'BU-A');
  wk.db.close();

  assert.equal(wkRes.status, 'success', 'worker status=success');
  assert.equal(syncRes.status, 'success', 'sync status=success');
  assert.equal(wkRes.validCount, syncRes.validCount, 'validCount 一致');
  assert.equal(wkRes.validCount, 3, 'validCount=3');
  assert.equal(wkRes.buName, syncRes.buName, 'buName 一致');
  assert.deepEqual(wkRows, syncRows, '落库行内容逐行一致');
});

// ---------------- ⑥ bu_name 改写（worker 落库 bu_name=firstBu trim 保大小写） ----------------
test('bizOp worker 落库前 bu_name 改写为 firstBu（trim 保大小写，与同步一致）', async () => {
  const date = '2026-06-11';
  // 首行 ' BU-X '（带空格），后续 'bu-x'/'BU-X'（normalizeBu 视为同 BU）
  const rows = [
    bizOpRowArray(' BU-X ', 'A1', { begin: 0, amount: 10, end: 10 }),
    bizOpRowArray('bu-x', 'A2', { begin: 0, amount: 20, end: 20 }),
    bizOpRowArray('BU-X', 'A3', { begin: 0, amount: 30, end: 30 })
  ];
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);

  const wk = freshDb();
  const res = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  assert.equal(res.status, 'success');
  assert.equal(res.buName, 'BU-X', 'firstBu trim 后 = BU-X（保大小写）');
  // 所有行 bu_name 都被改写为 'BU-X'
  const stored = importsRepo.getRowsByDateBu(wk.db, date, 'BU-X');
  assert.equal(stored.length, 3);
  for (const r of stored) assert.equal(r.bu_name, 'BU-X', '每行 bu_name=BU-X');
  wk.db.close();
});

test('bizOp 月末 worker 提交前命中下月未 ACK receipt 时两库写集合均零变化', async () => {
  const date = '2026-06-30';
  const nextDate = '2026-07-01';
  const current = freshDb();
  const next = freshDb();
  const oldCurrentRow = {
    _rowIndex: 2,
    bu_name: 'BU-A',
    account_no: 'CURRENT-OLD',
    begin_balance: '0',
    amount: '1',
    amount_in: '1',
    amount_out: '0',
    end_balance: '1'
  };
  importsRepo.insertRows(current.db, date, [oldCurrentRow]);
  datasetHeadRepo.writeHead(current.db, {
    kind: 'op', dataDate: date, buName: 'BU-A',
    identity: {
      datasetId: 'current-old-dataset', producerTaskRunId: 'current-old-task',
      datasetVersion: 1, archiveContractVersion: 1
    }
  });
  const currentRunId = runRepo.insertArchiveRun(current.db, {
    date,
    buName: 'BU-A',
    archiveTaskRunId: 'current-acked-run',
    stats: {
      t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 1,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
      t1NotT2Count: 0, t2NotT1Count: 0
    }
  });
  runRepo.insertDiffRows(current.db, currentRunId, date, 'BU-A', [
    { source_table: 'imports', source_row_id: 1, multi_op_flag: 'N' }
  ]);
  runRepo.acknowledgeArchiveTerminal(current.db, currentRunId, 'current-acked-run');

  importsRepo.insertRows(next.db, date, [{ ...oldCurrentRow, account_no: 'NEXT-OLD' }]);
  datasetHeadRepo.writeHead(next.db, {
    kind: 'op', dataDate: date, buName: 'BU-A',
    identity: {
      datasetId: 'next-old-dataset', producerTaskRunId: 'next-old-task',
      datasetVersion: 1, archiveContractVersion: 1
    }
  });
  const pendingRunId = runRepo.insertArchiveRun(next.db, {
    date,
    buName: 'BU-A',
    archiveTaskRunId: 'next-unack-run',
    stats: {
      t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 1,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
      t1NotT2Count: 0, t2NotT1Count: 0
    }
  });
  runRepo.insertDiffRows(next.db, pendingRunId, date, 'BU-A', [
    { source_table: 'imports', source_row_id: 1, multi_op_flag: 'N' }
  ]);
  const beforeCurrent = dumpBizOpWriteState(current.db);
  const beforeNext = dumpBizOpWriteState(next.db);
  const filePath = await writeXlsx(BIZ_OP_HEADERS, [
    bizOpRowArray('BU-A', 'CURRENT-NEW', { begin: 0, amount: 10, end: 10 })
  ]);

  const result = await session.runBizOpImportViaWorker(current.db, {
    date,
    filePath,
    dbPath: current.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed('month-end-blocked-task'),
    monthEndAdmission: { dbPath: next.dbPath, date, nextDate },
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(current.dir, 'err')
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /未 ACK/);
  assert.deepEqual(dumpBizOpWriteState(current.db), beforeCurrent);
  assert.deepEqual(dumpBizOpWriteState(next.db), beforeNext);
  current.db.close();
  next.db.close();
});

// ---------------- ② 业务OP 校验失败整批拒绝 ----------------
test('bizOp 校验失败：worker vs 同步 rejected + errorRows 一致 + DB 0 行 + 写报告', async () => {
  const date = '2026-06-12';
  // 行2 双重校验失败（期末 != 期初+发生额）
  const rows = [
    bizOpRowArray('BU-A', 'ACC001', { begin: 100, amount: 50, end: 150 }),
    bizOpRowArray('BU-A', 'ACC002', { begin: 0, amount: 50, end: 999 }) // end 错
  ];
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);
  const { readBizOpFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  const sync = freshDb();
  const syncRes = await session.runBizOpImportAsync(sync.db, {
    date, filePath: fp, readBizOpFile,
    datasetSeed: nextBizOpDatasetSeed('biz-op-sync-rejected'),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(sync.dir, 'err')
  });
  const syncDbRows = importsRepo.getRowsByDateBu(sync.db, date, 'BU-A').length;
  sync.db.close();

  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  const wkDbRows = importsRepo.getRowsByDateBu(wk.db, date, 'BU-A').length;
  wk.db.close();

  assert.equal(wkRes.status, 'rejected', 'worker rejected');
  assert.equal(syncRes.status, 'rejected', 'sync rejected');
  assert.deepEqual(
    wkRes.errorRows, syncRes.errorRows,
    'errorRows(rowIndex+reason) 一致'
  );
  assert.equal(wkDbRows, 0, 'worker 整批拒绝 → DB 0 行');
  assert.equal(syncDbRows, 0, 'sync 整批拒绝 → DB 0 行');
  assert.ok(wkRes.errorReportPath, 'worker 写了失败报告');
  assert.ok(fs.existsSync(wkRes.errorReportPath), 'worker 报告文件存在');
});

// ---------------- ③ 业务OP 首行 bu_name 空 → 不写报告 ----------------
test('bizOp 首行业务方空：worker vs 同步 rejected + errorReportPath=null + DB 0 行', async () => {
  const date = '2026-06-13';
  const rows = [
    bizOpRowArray('', 'ACC001', { begin: 0, amount: 10, end: 10 }),
    bizOpRowArray('', 'ACC002', { begin: 0, amount: 20, end: 20 })
  ];
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);
  const { readBizOpFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  const sync = freshDb();
  const syncRes = await session.runBizOpImportAsync(sync.db, {
    date, filePath: fp, readBizOpFile,
    datasetSeed: nextBizOpDatasetSeed('biz-op-sync-empty-bu'),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(sync.dir, 'err')
  });
  sync.db.close();

  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  const wkDbRows = importsRepo.listImportedDateBuPairs(wk.db).length;
  wk.db.close();

  assert.equal(wkRes.status, 'rejected', 'worker rejected');
  assert.equal(syncRes.status, 'rejected', 'sync rejected');
  assert.equal(wkRes.errorReportPath, null, 'worker 首行空 → errorReportPath=null');
  assert.equal(syncRes.errorReportPath, null, 'sync 首行空 → errorReportPath=null');
  assert.equal(wkRes.errorRows[0].reason, '业务方为空');
  assert.equal(syncRes.errorRows[0].reason, '业务方为空');
  assert.equal(wkDbRows, 0, 'DB 0 行');
});

// ---------------- ④ 业务OP 空文件（仅表头） ----------------
test('bizOp 空文件（仅表头）：worker rejected 文件无有效数据行 + errorReportPath=null', async () => {
  const date = '2026-06-14';
  const fp = await writeXlsx(BIZ_OP_HEADERS, []);
  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  wk.db.close();
  assert.equal(wkRes.status, 'rejected');
  assert.equal(wkRes.errorReportPath, null);
  assert.equal(wkRes.errorRows[0].reason, '文件无有效数据行');
});

// ---------------- ⑤ 🔴 (date,BU)+D+1 替换原子事务（资金红线 Q）----------------
test('🔴 bizOp worker 重导 D 后清 D+1/同BU 旧 run（D+1 旧 diff 基于旧 T-2 = 资金事故防线）', async () => {
  const dateD = '2026-06-20';
  const dateD1 = '2026-06-21';
  const wk = freshDb();
  const common = {
    dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  };

  // 先导入 D 与 D+1（同 BU），各成功
  const fpD = await writeXlsx(BIZ_OP_HEADERS, [bizOpRowArray('BU-A', 'ACC1', { begin: 0, amount: 10, end: 10 })]);
  const fpD1 = await writeXlsx(BIZ_OP_HEADERS, [bizOpRowArray('BU-A', 'ACC1', { begin: 10, amount: 5, end: 15 })]);
  await session.runBizOpImportViaWorker(wk.db, {
    ...common, date: dateD, filePath: fpD, datasetSeed: nextBizOpDatasetSeed()
  });
  await session.runBizOpImportViaWorker(wk.db, {
    ...common, date: dateD1, filePath: fpD1, datasetSeed: nextBizOpDatasetSeed()
  });

  // 手动给 D+1/BU-A 插一条 run（模拟用户已对账 D+1，run 基于旧 D 的 T-2）
  wk.db.exec('BEGIN');
  const oldRunId = runRepo.insertRun(wk.db, { date: dateD1, buName: 'BU-A', status: 'success', stats: {} });
  wk.db.exec('COMMIT');
  assert.ok(runRepo.listRunsByDateBu(wk.db, dateD1, 'BU-A').length === 1, '预置：D+1 有 1 个 run');

  // 重导 D（同 BU）→ 必须同清 D+1/BU-A 的旧 run
  const fpD2 = await writeXlsx(BIZ_OP_HEADERS, [bizOpRowArray('BU-A', 'ACC1', { begin: 0, amount: 99, end: 99 })]);
  const res = await session.runBizOpImportViaWorker(wk.db, {
    ...common, date: dateD, filePath: fpD2, datasetSeed: nextBizOpDatasetSeed()
  });
  assert.equal(res.status, 'success');

  const d1RunsAfter = runRepo.listRunsByDateBu(wk.db, dateD1, 'BU-A');
  assert.equal(d1RunsAfter.length, 0, '🔴 重导 D 后 D+1/BU-A 旧 run 被清（防 D+1 旧 diff 基于旧 T-2）');
  void oldRunId;
  wk.db.close();
});

// ---------------- ⑦ 表头不匹配 ----------------
test('bizOp 表头不匹配：worker status=error（同步抛同 errorCode FileValidationError）', async () => {
  const date = '2026-06-15';
  const badHeader = BIZ_OP_HEADERS.slice(0, 22); // 少一列
  const fp = await writeXlsx(badHeader, [new Array(22).fill('x')]);
  const { readBizOpFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  // 同步：reader throw FileValidationError（在 runBizOpImportAsync 内 readBizOpFile() 抛出）
  let syncErr = null;
  try {
    await session.runBizOpImportAsync(freshDb().db, {
      date, filePath: fp, readBizOpFile,
      datasetSeed: nextBizOpDatasetSeed('biz-op-sync-header-error'),
      writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
      errorReportsDir: mkTmpDir('e-')
    });
  } catch (e) { syncErr = e; }
  assert.ok(syncErr && syncErr.name === 'FileValidationError', '同步路径抛 FileValidationError');

  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  wk.db.close();
  assert.equal(wkRes.status, 'error', 'worker 表头不匹配 → status=error');
  assert.ok(wkRes.message && wkRes.message.length > 0, 'worker 带错误信息');
});

// ---------------- ⑧ 流水成功 ----------------
test('flow 成功导入：worker vs 同步 入库行数一致 + 落库内容一致', async () => {
  const date = '2026-06-16';
  const rows = [
    flowRowArray('BU-A', 'ACC1', '入', 100),
    flowRowArray('BU-A', 'ACC1', '出', 30),
    flowRowArray('BU-B', 'ACC2', '入', 50)
  ];
  const fp = await writeXlsx(FLOW_HEADERS, rows);
  const { readFlowFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  const sync = freshDb();
  const syncRes = await session.runFlowImportAsync(sync.db, {
    date, filePath: fp, readFlowFile,
    datasetSeed: nextFlowDatasetSeed(sync.db, date, 'biz-flow-sync-success'),
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(sync.dir, 'err')
  });
  const syncRows = dumpFlow(sync.db, date);
  sync.db.close();

  const wk = freshDb();
  const wkRes = await session.runFlowImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextFlowDatasetSeed(wk.db, date),
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  const wkRows = dumpFlow(wk.db, date);
  wk.db.close();

  assert.equal(wkRes.status, 'success');
  assert.equal(syncRes.status, 'success');
  assert.equal(wkRes.totalCount, syncRes.totalCount, 'totalCount 一致');
  assert.equal(wkRes.totalCount, 3);
  assert.deepEqual(wkRows, syncRows, 'flow 落库内容逐行一致');
});

// ---------------- ⑨ 流水校验失败整批拒绝 ----------------
test('flow 校验失败：worker vs 同步 rejected + errorRows 一致 + DB 0 行', async () => {
  const date = '2026-06-17';
  const rows = [
    flowRowArray('BU-A', 'ACC1', '入', 100),
    flowRowArray('BU-A', 'ACC2', '無效方向', 30) // 出入方向非法
  ];
  const fp = await writeXlsx(FLOW_HEADERS, rows);
  const { readFlowFile } = require('../../../../src/backend/biz-op-recon-import/reader');

  const sync = freshDb();
  const syncRes = await session.runFlowImportAsync(sync.db, {
    date, filePath: fp, readFlowFile,
    datasetSeed: nextFlowDatasetSeed(sync.db, date, 'biz-flow-sync-rejected'),
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(sync.dir, 'err')
  });
  const syncDbRows = flowRepo.getRowsByDate(sync.db, date).length;
  sync.db.close();

  const wk = freshDb();
  const wkRes = await session.runFlowImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextFlowDatasetSeed(wk.db, date),
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });
  const wkDbRows = flowRepo.getRowsByDate(wk.db, date).length;
  wk.db.close();

  assert.equal(wkRes.status, 'rejected');
  assert.equal(syncRes.status, 'rejected');
  assert.deepEqual(wkRes.errorRows, syncRes.errorRows, 'errorRows 一致');
  assert.equal(wkDbRows, 0, 'worker 整批拒绝 → DB 0 行');
  assert.equal(syncDbRows, 0, 'sync 整批拒绝 → DB 0 行');
  assert.ok(wkRes.errorReportPath, 'worker 写了失败报告');
});

// ---------------- ⑩ 🔴 流水重导清"该 date 跨所有 BU"旧 runs（资金红线 P）----------------
test('🔴 flow worker 重导清该 date 跨所有 BU 旧 runs（旧 run 基于旧流水 = 资金事故防线）', async () => {
  const date = '2026-06-18';
  const wk = freshDb();
  const common = {
    dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  };

  const fp1 = await writeXlsx(FLOW_HEADERS, [flowRowArray('BU-A', 'ACC1', '入', 100)]);
  await session.runFlowImportViaWorker(wk.db, {
    ...common, date, filePath: fp1, datasetSeed: nextFlowDatasetSeed(wk.db, date)
  });

  // 预置：该 date 下 BU-A 和 BU-B 各一个 run（模拟已对账，基于旧流水）
  wk.db.exec('BEGIN');
  runRepo.insertRun(wk.db, { date, buName: 'BU-A', status: 'success', stats: {} });
  runRepo.insertRun(wk.db, { date, buName: 'BU-B', status: 'success', stats: {} });
  wk.db.exec('COMMIT');
  assert.equal(runRepo.listRunsByDateBu(wk.db, date, 'BU-A').length, 1);
  assert.equal(runRepo.listRunsByDateBu(wk.db, date, 'BU-B').length, 1);

  // 重导流水（该 date）→ 必须清该 date 跨所有 BU 的旧 runs
  const fp2 = await writeXlsx(FLOW_HEADERS, [flowRowArray('BU-A', 'ACC1', '入', 999)]);
  const res = await session.runFlowImportViaWorker(wk.db, {
    ...common, date, filePath: fp2, datasetSeed: nextFlowDatasetSeed(wk.db, date)
  });
  assert.equal(res.status, 'success');

  assert.equal(runRepo.listRunsByDateBu(wk.db, date, 'BU-A').length, 0, '🔴 BU-A 旧 run 被清');
  assert.equal(runRepo.listRunsByDateBu(wk.db, date, 'BU-B').length, 0, '🔴 BU-B 旧 run 被清（跨所有 BU）');
  wk.db.close();
});

// ============================================================================
// β.2 review fix 回归（I1 / I2 / I3）
// ============================================================================

// ---------------- ⑪ I1：流式中途 INSERT 失败 → fatal（非「表头/读取失败」）+ ROLLBACK ----------------
// 反例（修复前）：insertOne 抛错 → 冒泡到 reader-streamed → wrapReadError 重包成 header-mismatch
//   errorCode 的 FileValidationError → 被误判成 header-error（"文件读取失败"）。
// 修复后：worker 在 onDataRow 内单独 try insertOne，标 insertFatal → 流结束后 ROLLBACK + emit fatal(exit 2)。
// 注入手法：在主表上建 BEFORE INSERT 触发器，遇 account_no='__FAIL__' RAISE(ABORT)（worker 独立 connection
//   经 WAL 看到已提交的触发器；幂等迁移 CREATE TABLE IF NOT EXISTS 不会删触发器）。
test('I1 流式中途 INSERT 失败：worker fatal（消息非表头/读取失败）+ DB 0 行（ROLLBACK）', async () => {
  const date = '2026-07-01';
  const wk = freshDb();
  // 触发器：第 2 行 INSERT 时 RAISE ABORT，模拟中途 DB 写失败
  wk.db.exec(`
    CREATE TRIGGER force_biz_op_insert_fail
    BEFORE INSERT ON biz_op_recon_imports
    WHEN NEW.account_no = '__FAIL__'
    BEGIN
      SELECT RAISE(ABORT, 'forced insert failure for test');
    END;
  `);

  // 行1 正常落库（触发 clear+insert），行2 命中触发器抛错（两行均通过双重校验 → 会走到 insertOne）
  const rows = [
    bizOpRowArray('BU-A', 'ACC_OK', { begin: 0, amount: 0, end: 0 }),
    bizOpRowArray('BU-A', '__FAIL__', { begin: 0, amount: 0, end: 0 })
  ];
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);

  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
  });

  assert.equal(wkRes.status, 'error', '中途 INSERT 失败 → status=error（fatal）');
  assert.match(wkRes.message || '', /写入失败|forced insert failure/, 'message 指向写入/系统错');
  assert.doesNotMatch(
    wkRes.message || '',
    /表头|文件读取失败|HEADER_MISMATCH/i,
    'message 不再被误判成「表头/读取失败」'
  );
  // 🔴 ROLLBACK：行1 的 insert + clear 全部撤销 → DB 净 0 行
  assert.equal(dumpImports(wk.db, date, 'BU-A').length, 0, '🔴 整批 ROLLBACK → DB 0 行');
  wk.db.close();
});

// ---------------- ⑫ I2：行级错误超 maxRowErrors → truncated + 报告标注全量数 ----------------
// 反例（修复前）：errorRows 截到 maxRowErrors，rowErrorTotal/truncated 被 session 丢弃 → 报告静默截断、
//   用户无"还有 N 条"提示。修复后：透传到 result + 报告顶部加「共 N 条，仅列前 M 条」提示行。
test('I2 错误超 maxRowErrors：result.truncated=true + rowErrorTotal 全量 + 报告标注', async () => {
  const date = '2026-07-02';
  // 5 个双重校验失败行（end != begin+amount），maxRowErrors=3 → 截到 3，rowErrorTotal=5
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(bizOpRowArray('BU-A', `ACC${i}`, { begin: 0, amount: 10, end: 999 }));
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);

  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err'),
    maxRowErrors: 3
  });

  assert.equal(wkRes.status, 'rejected');
  assert.equal(wkRes.rowErrorTotal, 5, 'rowErrorTotal=全量真实错误数 5');
  assert.equal(wkRes.truncated, true, 'truncated=true（5 > 3）');
  assert.equal(wkRes.errorRows.length, 3, 'errorRows 截到 maxRowErrors=3');
  assert.ok(wkRes.errorReportPath && fs.existsSync(wkRes.errorReportPath), '失败报告已写');

  // 报告顶部含截断提示（含全量数 5 + 截断数 3）
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wkRes.errorReportPath);
  const ws = wb.worksheets[0];
  const noteCell = String(ws.getRow(1).getCell(1).value || '');
  assert.match(noteCell, /共\s*5\s*条/, '报告首行标注全量 5 条');
  assert.match(noteCell, /前\s*3\s*条/, '报告首行标注仅列前 3 条');
  // 提示行下面才是表头行（业务OP第 1 列「Billdate」），数据行 = 3 条
  assert.equal(String(ws.getRow(2).getCell(1).value || ''), BIZ_OP_HEADERS[0], '第 2 行为表头');
  wk.db.close();
});

// ---------------- ⑬ I3：大 rejected 包（数百行 rawRow）emit→exit 刷盘后仍被完整解析 ----------------
// 反例（修复前）：emit 后立即 process.exit 截断大 rejected 包 → session 拿不到 rejected → 误判 error。
// 修复后：emitAndExit 在 write 回调里才退出 → 大包完整刷入管道 → session 正常解析出 rejected + 写报告。
test('I3 大 rejected 包（800 错误行）：worker 刷盘后 session 仍解析出 rejected（不丢结论）', async () => {
  const date = '2026-07-03';
  const N = 800;   // 默认 maxRowErrors=1000，800 全部带 rawRow 进 rejected → 数百 KB 大包
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(bizOpRowArray('BU-A', `ACC${i}`, { begin: 0, amount: 10, end: 999 }));
  const fp = await writeXlsx(BIZ_OP_HEADERS, rows);

  const wk = freshDb();
  const wkRes = await session.runBizOpImportViaWorker(wk.db, {
    date, filePath: fp, dbPath: wk.dbPath,
    batchContext: WORKER_BATCH_CONTEXT,
    datasetSeed: nextBizOpDatasetSeed(),
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(wk.dir, 'err')
    // 不传 maxRowErrors → 默认 1000，800 全部进 errorRows（大包）
  });

  assert.equal(wkRes.status, 'rejected', '大 rejected 包未被截断 → 正确解析为 rejected（非 error）');
  assert.equal(wkRes.rowErrorTotal, N, `rowErrorTotal=${N}`);
  assert.equal(wkRes.truncated, false, 'truncated=false（800 < 1000）');
  assert.equal(wkRes.errorRows.length, N, `errorRows 全量 ${N} 条（未丢）`);
  assert.ok(wkRes.errorReportPath && fs.existsSync(wkRes.errorReportPath), '失败报告已写');
  assert.equal(dumpImports(wk.db, date, 'BU-A').length, 0, '🔴 整批拒绝 → DB 0 行');
  wk.db.close();
});
