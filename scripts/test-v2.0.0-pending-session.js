#!/usr/bin/env node
/* eslint-disable no-console */
// Pending session 端到端：spawn worker + need-confirm + 覆盖留底 + 报错缓存 + 报错导出

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PENDING_COLUMNS = require('../src/backend/pending-db/columns');
const { openPendingDb, PENDING_DB_FILENAME } = require('../src/backend/pending-db');
const monthRepo = require('../src/backend/pending-db/month-repository');
const { createPendingSession } = require('../src/main-process/pending-session');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-session-test-'));
const DB_PATH = path.join(TMP, PENDING_DB_FILENAME);

function sampleRow({ fundType = '提现', orderNo = 'A001', amount = '100' } = {}) {
  const row = new Array(PENDING_COLUMNS.length).fill('');
  row[PENDING_COLUMNS.indexOf('pending资金类型')] = fundType;
  row[PENDING_COLUMNS.indexOf('order_no')] = orderNo;
  row[PENDING_COLUMNS.indexOf('金额')] = amount;
  return row;
}

function makeXlsx(filename, headers, rows) {
  const fp = path.join(TMP, filename);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, fp);
  return fp;
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓', name); pass += 1; }
  else { console.log('  ✗', name, detail ? `— ${detail}` : ''); fail += 1; }
}

(async () => {
  try {
    const pendingDb = openPendingDb(TMP);
    const session = createPendingSession({
      getPendingDb: () => pendingDb,
      getStorageRoot: () => TMP
    });

    console.log('[T1] happy fresh import');
    {
      const f = makeXlsx('f1.xlsx', PENDING_COLUMNS, [
        sampleRow({ orderNo: 'A001' }),
        sampleRow({ orderNo: 'A002', fundType: '退票' })
      ]);
      const r = await session.runImport({
        yearMonth: '2026-03', files: [f], overwriteConfirmed: false, dbPath: DB_PATH
      });
      check('status=success', r.status === 'success', JSON.stringify(r));
      check('rowCount=2', r.rowCount === 2);
      check('archivePath null (fresh)', r.archivePath == null);
    }

    console.log('[T2] re-import same month without confirm');
    {
      const f = makeXlsx('f2.xlsx', PENDING_COLUMNS, [sampleRow({ orderNo: 'NEW1' })]);
      const r = await session.runImport({
        yearMonth: '2026-03', files: [f], overwriteConfirmed: false, dbPath: DB_PATH
      });
      check('status=need-confirm', r.status === 'need-confirm', JSON.stringify(r));
      check('existingRowCount=2', r.existingRowCount === 2);
      check('existingImportedAt present', !!r.existingImportedAt);
      check('DB 2026-03 仍 2 行（未覆盖）', monthRepo.countRowsInMonth(pendingDb, '2026-03') === 2);
    }

    console.log('[T3] overwrite confirmed — archive + replace');
    {
      const f = makeXlsx('f3.xlsx', PENDING_COLUMNS, [sampleRow({ orderNo: 'AFTER-OW' })]);
      const r = await session.runImport({
        yearMonth: '2026-03', files: [f], overwriteConfirmed: true, dbPath: DB_PATH
      });
      check('status=success', r.status === 'success');
      check('rowCount=1', r.rowCount === 1);
      check('archivePath exists', !!r.archivePath && fs.existsSync(r.archivePath), r.archivePath);

      if (r.archivePath && fs.existsSync(r.archivePath)) {
        const archWb = XLSX.readFile(r.archivePath);
        check('archive has 1 sheet', archWb.SheetNames.length === 1);
        const sh = archWb.Sheets[archWb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sh, { header: 1 });
        check('archive contains header + 2 old rows', rows.length === 3, `got ${rows.length}`);
      }
      check('DB 2026-03 now 1 row', monthRepo.countRowsInMonth(pendingDb, '2026-03') === 1);
    }

    console.log('[T4] errors cached → exportErrorReport');
    {
      const f = makeXlsx('f4.xlsx', PENDING_COLUMNS, [
        sampleRow({ orderNo: 'X', fundType: '转账' })
      ]);
      const r = await session.runImport({
        yearMonth: '2026-04', files: [f], overwriteConfirmed: false, dbPath: DB_PATH
      });
      check('status=error', r.status === 'error');
      check('session has pending error', session.hasPendingErrorReport());
      const exportPath = path.join(TMP, 'errors.xlsx');
      const exp = session.exportErrorReport(exportPath);
      check('exportErrorReport success', exp.status === 'success');
      check('exported xlsx exists', fs.existsSync(exportPath));
    }

    console.log('[T5] successful import after error → errors cleared');
    {
      const f = makeXlsx('f5.xlsx', PENDING_COLUMNS, [sampleRow({ orderNo: 'Z001' })]);
      const r = await session.runImport({
        yearMonth: '2026-05', files: [f], overwriteConfirmed: false, dbPath: DB_PATH
      });
      check('status=success', r.status === 'success');
      check('session errors cleared', !session.hasPendingErrorReport());
    }

    pendingDb.close();
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\nTotal: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();
