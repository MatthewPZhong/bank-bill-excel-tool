#!/usr/bin/env node
/* eslint-disable no-console */
// Pending 导入 worker 端到端测试
// 覆盖：happy / 表头错 / 资金类型错 / 多文件合并 / 多文件行级冲突 / 入库验证

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');

const PENDING_COLUMNS = require('../src/backend/pending-db/columns');
const monthRepo = require('../src/backend/pending-db/month-repository');
const { openPendingDb } = require('../src/backend/pending-db');

const WORKER = path.resolve(__dirname, '../src/backend/pending-import/worker.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-import-test-'));
const DB_PATH = path.join(TMP, 'tool-data-pending.sqlite');

function sampleRow({ fundType = '提现', orderNo = 'A001', amount = '100', currency = 'CNY' } = {}) {
  const row = new Array(PENDING_COLUMNS.length).fill('');
  row[PENDING_COLUMNS.indexOf('pending资金类型')] = fundType;
  row[PENDING_COLUMNS.indexOf('order_no')] = orderNo;
  row[PENDING_COLUMNS.indexOf('金额')] = amount;
  row[PENDING_COLUMNS.indexOf('币种')] = currency;
  return row;
}

function makeXlsx(filename, headers, dataRows) {
  const fp = path.join(TMP, filename);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, fp);
  return fp;
}

function runWorker(yearMonth, files) {
  try {
    const out = execFileSync('node', [WORKER, JSON.stringify({ dbPath: DB_PATH, yearMonth, files })], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      exit: 0,
      events: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    };
  } catch (err) {
    const raw = (err.stdout || '').trim().split('\n').filter(Boolean);
    return {
      exit: err.status,
      events: raw.map((l) => {
        try {
          return JSON.parse(l);
        } catch (_e) {
          return { type: 'raw', line: l };
        }
      }),
      stderr: err.stderr ? err.stderr.toString() : ''
    };
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  ✓', name);
    pass += 1;
  } else {
    console.log('  ✗', name, detail ? `— ${detail}` : '');
    fail += 1;
  }
}

try {
  // === T1: happy path 单文件 ===
  console.log('[T1] happy path 单文件 3 行');
  {
    const file = makeXlsx('happy.xlsx', PENDING_COLUMNS, [
      sampleRow({ orderNo: 'A001', fundType: '提现' }),
      sampleRow({ orderNo: 'A002', fundType: '退票' }),
      sampleRow({ orderNo: 'A003', fundType: '充值' })
    ]);
    const res = runWorker('2026-03', [file]);
    check('exit 0', res.exit === 0, 'exit=' + res.exit);
    const complete = res.events.find((e) => e.type === 'complete');
    check('complete event with rowCount=3', complete && complete.rowCount === 3);
  }

  // === T2: 表头错（缺一列）===
  console.log('[T2] 表头错（少最后一列）');
  {
    const file = makeXlsx('bad-header.xlsx', PENDING_COLUMNS.slice(0, -1), [
      new Array(PENDING_COLUMNS.length - 1).fill('')
    ]);
    const res = runWorker('2026-04', [file]);
    check('exit 1', res.exit === 1, 'exit=' + res.exit);
    const err = res.events.find((e) => e.type === 'error');
    check(
      'has fatal error about 表头',
      err && err.errors.some((x) => x.severity === 'fatal' && /表头/.test(x.message)),
      err ? JSON.stringify(err.errors.slice(0, 1)) : 'no error event'
    );
  }

  // === T3: pending资金类型 非枚举值正常入库 ===
  // v2.0.0-beta.2 Reverse Sync：OT-9 三枚举撤销；任意文本允许入库
  console.log('[T3] pending资金类型 非枚举值允许入库');
  {
    const file = makeXlsx('non-std-fund.xlsx', PENDING_COLUMNS, [
      sampleRow({ orderNo: 'B001', fundType: '入金' }),   // 非原枚举
      sampleRow({ orderNo: 'B002', fundType: '转账' }),   // 非原枚举
      sampleRow({ orderNo: 'B003', fundType: '' })        // 空值也允许
    ]);
    const res = runWorker('2026-05', [file]);
    check('exit 0 (非枚举值允许入库)', res.exit === 0);
    const complete = res.events.find((e) => e.type === 'complete');
    check('complete rowCount = 3', complete && complete.rowCount === 3);
  }

  // === T4: 多文件合并（happy）===
  console.log('[T4] 多文件合并');
  {
    const fileA = makeXlsx('multi-A.xlsx', PENDING_COLUMNS, [
      sampleRow({ orderNo: 'C001' }),
      sampleRow({ orderNo: 'C002' })
    ]);
    const fileB = makeXlsx('multi-B.xlsx', PENDING_COLUMNS, [
      sampleRow({ orderNo: 'D001' }),
      sampleRow({ orderNo: 'D002' })
    ]);
    const res = runWorker('2026-06', [fileA, fileB]);
    check('exit 0', res.exit === 0, 'exit=' + res.exit);
    const complete = res.events.find((e) => e.type === 'complete');
    check('rowCount=4', complete && complete.rowCount === 4);
    check(
      'sourceFiles contains both',
      complete && complete.sourceFiles.includes('multi-A.xlsx') && complete.sourceFiles.includes('multi-B.xlsx')
    );
  }

  // === T5: 多文件行级冲突（跨文件重复行）===
  console.log('[T5] 多文件跨文件行级冲突');
  {
    const shared = sampleRow({ orderNo: 'DUP999', amount: '888' });
    const fileA = makeXlsx('dup-A.xlsx', PENDING_COLUMNS, [shared]);
    const fileB = makeXlsx('dup-B.xlsx', PENDING_COLUMNS, [shared]);
    const res = runWorker('2026-07', [fileA, fileB]);
    check('exit 1', res.exit === 1);
    const err = res.events.find((e) => e.type === 'error');
    check(
      'has row error about 重复',
      err && err.errors.some((x) => x.severity === 'row' && /重复/.test(x.message))
    );
  }

  // === T6: DB 入库验证 ===
  console.log('[T6] DB 状态验证（T1 + T4 成功后）');
  {
    const db = openPendingDb(TMP);
    check('2026-03 has 3 rows', monthRepo.countRowsInMonth(db, '2026-03') === 3);
    check('2026-06 has 4 rows', monthRepo.countRowsInMonth(db, '2026-06') === 4);
    check('2026-04 (bad header) not stored', monthRepo.countRowsInMonth(db, '2026-04') === 0);
    check('2026-05 (non-std fund) stored with 3 rows', monthRepo.countRowsInMonth(db, '2026-05') === 3);
    check('2026-07 (dup) not stored', monthRepo.countRowsInMonth(db, '2026-07') === 0);

    const months = monthRepo.listMonths(db).map((m) => typeof m === 'string' ? m : m.yearMonth);
    check(
      'listMonths = [2026-06, 2026-05, 2026-03]（desc）',
      JSON.stringify(months) === JSON.stringify(['2026-06', '2026-05', '2026-03']),
      JSON.stringify(months)
    );

    const meta = monthRepo.getMonthMeta(db, '2026-06');
    check('meta.rowCount = 4', meta && meta.rowCount === 4);
    check(
      'meta.sourceFiles both files',
      meta && meta.sourceFiles.includes('multi-A.xlsx') && meta.sourceFiles.includes('multi-B.xlsx')
    );
    db.close();
  }

  // === T7: 覆盖模式（重复导入同月）===
  console.log('[T7] 覆盖同月（worker 自带 deleteMonth 在 transaction 内）');
  {
    const file = makeXlsx('cover.xlsx', PENDING_COLUMNS, [sampleRow({ orderNo: 'NEW' })]);
    const res = runWorker('2026-03', [file]);
    check('exit 0', res.exit === 0);
    const db = openPendingDb(TMP);
    check('2026-03 now has 1 row (覆盖生效)', monthRepo.countRowsInMonth(db, '2026-03') === 1);
    db.close();
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nTotal: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
