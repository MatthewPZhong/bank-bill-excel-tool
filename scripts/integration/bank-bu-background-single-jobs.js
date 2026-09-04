// BankBU E08-A single one-shot jobs 集成验证
// 覆盖：真实XLSX reader→side单事务、side COMMIT后重启Inspector、complete-mirror CAS、
//       single/aggregate staging三sheet、重导后旧mirror stale并进入skipped。
// 用法：node scripts/integration/bank-bu-background-single-jobs.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
} = require('../../src/backend/bank-bu-recon-db/columns');
const {
  ensureBankBuReconTablesSupport,
  ensureBankBuReconRunsSideDbPath,
  ensureBankBuReconRunIdentitySupport
} = require('../../src/backend/database/migrations');
const runDataStore = require('../../src/backend/run-data-store');
const { executeImportMonth } = require('../../src/main-process/bank-bu-worker/import-operation');
const { executeRun } = require('../../src/main-process/bank-bu-worker/run-operation');
const { executeExportSingle, executeExportAggregate } = require(
  '../../src/main-process/bank-bu-worker/export-operation'
);
const { captureMirrorPreimage } = require('../../src/main-process/bank-bu-worker/mirror-repository');
const {
  completeMirrorFromCommittedSide,
  inspectImportOutcome,
  inspectRunOutcome
} = require('../../src/main-process/bank-bu-worker/outcome-inspector');

let passed = 0;
const failures = [];

function check(condition, label) {
  try {
    assert.ok(condition, label);
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function makeFiles(dir, suffix, reconId, pendingBu, bankBu) {
  const pendingPath = path.join(dir, `pending-${suffix}.xlsx`);
  const bankPath = path.join(dir, `bank-${suffix}.xlsx`);
  const pending = new Array(PENDING_GUANLI_HEADERS.length).fill('');
  pending[PENDING_GUANLI_HEADERS.indexOf('主对账单号')] = reconId;
  pending[PENDING_GUANLI_HEADERS.indexOf('财务BU')] = pendingBu;
  const bank = new Array(BANK_HEADERS.length).fill('');
  bank[BANK_HEADERS.indexOf('ReconciliationId')] = reconId;
  bank[BANK_HEADERS.indexOf('Remark-BU')] = bankBu;
  const pendingBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    pendingBook, XLSX.utils.aoa_to_sheet([PENDING_GUANLI_HEADERS, pending]), 'Pending'
  );
  XLSX.writeFile(pendingBook, pendingPath);
  const bankBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bankBook, XLSX.utils.aoa_to_sheet([BANK_HEADERS, bank]), 'Bank');
  XLSX.writeFile(bankBook, bankPath);
  return { pendingPath, bankPath };
}

function openMain(mainPath) {
  const db = new DatabaseSync(mainPath);
  ensureBankBuReconTablesSupport(db);
  ensureBankBuReconRunsSideDbPath(db);
  ensureBankBuReconRunIdentitySupport(db);
  return db;
}

function killChild(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return spawnSync(process.execPath, [
    path.join(__dirname, 'fixtures', 'bank-bu-e08-a-kill-child.js'), encoded
  ], { env: process.env, encoding: 'utf8' });
}

async function importAndRun({ dir, mainDb, yearMonth, suffix, reconId, operationNumber }) {
  const files = makeFiles(dir, suffix, reconId, 'BU-A', 'bu-a');
  const imported = await executeImportMonth({ userDataDir: dir, yearMonth, ...files }, {
    operationIdentity: {
      actionKey: 'bank-bu:import-month',
      operationKey: `bank-bu/import/${operationNumber}`,
      producerTaskRunId: `task-import-${operationNumber}`
    },
    async awaitCritical() {}
  });
  const preimage = captureMirrorPreimage(mainDb, yearMonth);
  const criticalEvidence = {
    yearMonth,
    operationKey: `bank-bu/run/${operationNumber}`,
    producerTaskRunId: `task-run-${operationNumber}`,
    inputEvidenceHash: imported.inputEvidenceHash,
    preimage
  };
  const run = await executeRun({ userDataDir: dir, yearMonth }, {
    operationIdentity: {
      actionKey: 'bank-bu:run',
      operationKey: criticalEvidence.operationKey,
      producerTaskRunId: criticalEvidence.producerTaskRunId
    },
    async awaitCritical() {}
  });
  return { files, imported, run, criticalEvidence };
}

async function runExportSnapshotRaceProbes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-export-race-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = openMain(mainPath);
  try {
    const singleBase = await importAndRun({
      dir, mainDb, yearMonth: '2026-08', suffix: 'single-old',
      reconId: 'SINGLE-OLD', operationNumber: 101
    });
    const singleMirror = completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: singleBase.criticalEvidence
    });
    const singleNewFiles = makeFiles(
      dir, 'single-new', 'SINGLE-NEW', 'BU-NEW', 'BU-NEW'
    );
    const singlePath = path.join(dir, 'staging', 'single-race.xlsx');
    let singleWriterCommitted = false;
    await assert.rejects(executeExportSingle({
      userDataDir: dir,
      mainDatabasePath: mainPath,
      stagingRoot: path.join(dir, 'staging'),
      stagingPath: singlePath,
      runId: singleMirror.mirror.mirrorId
    }, {
      async onManagedSnapshot(identity) {
        assert.equal(identity.yearMonth, '2026-08');
        await executeImportMonth({
          userDataDir: dir, yearMonth: '2026-08', ...singleNewFiles
        }, {
          operationIdentity: {
            actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/race-single',
            producerTaskRunId: 'task-import-race-single'
          },
          async awaitCritical() {}
        });
        singleWriterCommitted = true;
      }
    }), (error) => error.code === 'BANK_BU_EXPORT_SNAPSHOT_STALE');
    check(singleWriterCommitted, 'single snapshot持有时第二WAL连接成功COMMIT新import');
    check(!fs.existsSync(singlePath), 'single snapshot身份变化后删除staging且不返回错配artifact');
    const singleSide = runDataStore.openSideDb(
      dir, runDataStore.MODULE_BANK_BU, '2026-08'
    );
    try {
      check(singleSide.prepare(`
        SELECT recon_id FROM bank_bu_recon_pending_imports WHERE year_month='2026-08'
      `).get().recon_id === 'SINGLE-NEW', 'single并发probe确认side当前为NEW dataset');
    } finally {
      singleSide.close();
    }

    const aggregateBase = await importAndRun({
      dir, mainDb, yearMonth: '2026-09', suffix: 'aggregate-old',
      reconId: 'AGGREGATE-OLD', operationNumber: 102
    });
    completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: aggregateBase.criticalEvidence
    });
    const aggregateNewFiles = makeFiles(
      dir, 'aggregate-new', 'AGGREGATE-NEW', 'BU-NEW', 'BU-NEW'
    );
    const aggregatePath = path.join(dir, 'staging', 'aggregate-race.xlsx');
    let aggregateWriterCommitted = false;
    await assert.rejects(executeExportAggregate({
      userDataDir: dir,
      mainDatabasePath: mainPath,
      stagingRoot: path.join(dir, 'staging'),
      stagingPath: aggregatePath
    }, {
      async onManagedSnapshot(identity) {
        if (identity.yearMonth !== '2026-09' || aggregateWriterCommitted) return;
        await executeImportMonth({
          userDataDir: dir, yearMonth: '2026-09', ...aggregateNewFiles
        }, {
          operationIdentity: {
            actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/race-aggregate',
            producerTaskRunId: 'task-import-race-aggregate'
          },
          async awaitCritical() {}
        });
        aggregateWriterCommitted = true;
      }
    }), (error) => error.code === 'BANK_BU_EXPORT_SNAPSHOT_STALE');
    check(aggregateWriterCommitted, 'aggregate逐月snapshot时第二WAL连接成功COMMIT新import');
    check(!fs.existsSync(aggregatePath), 'aggregate任一included identity变化后整artifact删除');
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-integration-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  let mainDb = openMain(mainPath);
  try {
    const august = await importAndRun({
      dir, mainDb, yearMonth: '2026-08', suffix: 'aug', reconId: 'AUG-1', operationNumber: 1
    });
    check(august.imported.pendingCount === 1 && august.imported.bankCount === 1,
      '两reader成功后side事务导入1+1行');
    check(august.run.stats.matchedCount === 2 && august.run.stats.nmAnomalyCount === 0,
      '1:1结果和异常语义保持');
    check(inspectRunOutcome({
      mainDb, userDataDir: dir, criticalEvidence: august.criticalEvidence
    }).outcome === 'partially-committed', 'side COMMIT/main absent判partial');

    // 模拟side COMMIT后进程退出：关闭并重新打开真实SQLite主库，再执行Inspector/CAS恢复。
    mainDb.close();
    mainDb = openMain(mainPath);
    const afterRestart = inspectRunOutcome({
      mainDb, userDataDir: dir, criticalEvidence: august.criticalEvidence
    });
    check(afterRestart.outcome === 'partially-committed', '重启后仍由持久证据判partial');
    const completed = completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: august.criticalEvidence
    });
    check(completed.outcome === 'committed' && completed.mirror.sideRunId === august.run.sideRunId,
      'complete-mirror只使用已提交sideRunId');
    check(inspectRunOutcome({
      mainDb, userDataDir: dir, criticalEvidence: august.criticalEvidence
    }).outcome === 'committed', '恢复后Inspector唯一判committed');

    const singlePath = path.join(dir, 'staging', 'single.xlsx');
    const single = await executeExportSingle({
      userDataDir: dir, mainDatabasePath: mainPath,
      stagingRoot: path.join(dir, 'staging'), stagingPath: singlePath,
      runId: completed.mirror.mirrorId
    });
    const singleBook = new ExcelJS.Workbook();
    await singleBook.xlsx.readFile(singlePath);
    check(single.artifacts.length === 1 && singleBook.worksheets.length === 3,
      'single export仅写staging且固定三sheet');

    const september = await importAndRun({
      dir, mainDb, yearMonth: '2026-09', suffix: 'sep', reconId: 'SEP-1', operationNumber: 2
    });
    const septemberMirror = completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: september.criticalEvidence
    });
    check(septemberMirror.outcome === 'committed', '第二月side/main identity提交');
    const aggregatePath = path.join(dir, 'staging', 'aggregate.xlsx');
    const aggregate = await executeExportAggregate({
      userDataDir: dir, mainDatabasePath: mainPath,
      stagingRoot: path.join(dir, 'staging'), stagingPath: aggregatePath
    });
    check(
      JSON.stringify(aggregate.includedMonths) === JSON.stringify(['2026-08', '2026-09']) &&
      aggregate.skippedMonths.length === 0,
      'aggregate月份升序且included/skipped语义保持'
    );

    // 同月新import清side runs；旧Main mirror不得被export重算为新dataset结果。
    await executeImportMonth({ userDataDir: dir, yearMonth: '2026-08', ...august.files }, {
      operationIdentity: {
        actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/3',
        producerTaskRunId: 'task-import-3'
      },
      async awaitCritical() {}
    });
    await assert.rejects(
      executeExportSingle({
        userDataDir: dir, mainDatabasePath: mainPath,
        stagingRoot: path.join(dir, 'staging'),
        stagingPath: path.join(dir, 'staging', 'stale.xlsx'), runId: completed.mirror.mirrorId
      }),
      (error) => error.code === 'BANK_BU_EXPORT_MIRROR_STALE'
    );
    passed += 1;
    const aggregateAfterReimport = await executeExportAggregate({
      userDataDir: dir, mainDatabasePath: mainPath,
      stagingRoot: path.join(dir, 'staging'),
      stagingPath: path.join(dir, 'staging', 'aggregate-after-reimport.xlsx')
    });
    check(
      JSON.stringify(aggregateAfterReimport.includedMonths) === JSON.stringify(['2026-09']) &&
      JSON.stringify(aggregateAfterReimport.skippedMonths) === JSON.stringify(['2026-08']),
      '同月重导后旧mirror进入skipped且不重跑旧算法'
    );

    const killedImportFiles = makeFiles(dir, 'kill-import', 'KILL-I', 'BU-A', 'BU-A');
    const killedImportIdentity = {
      actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/kill-before',
      producerTaskRunId: 'task-import-kill-before'
    };
    const killedImport = killChild({
      mode: 'import-before-commit',
      input: { userDataDir: dir, yearMonth: '2026-10', ...killedImportFiles },
      operationIdentity: killedImportIdentity
    });
    check(killedImport.signal === 'SIGKILL' || killedImport.status !== 0,
      'import critical前真实子进程强杀');
    check(inspectImportOutcome({
      userDataDir: dir, yearMonth: '2026-10',
      operationKey: killedImportIdentity.operationKey,
      producerTaskRunId: killedImportIdentity.producerTaskRunId,
      inputEvidenceHash: '0'.repeat(64)
    }).outcome === 'not-committed', 'import critical前kill无side receipt/提交');

    const killedRunFiles = makeFiles(dir, 'kill-run', 'KILL-R', 'BU-A', 'BU-A');
    const killedRunImport = await executeImportMonth({
      userDataDir: dir, yearMonth: '2026-11', ...killedRunFiles
    }, {
      operationIdentity: {
        actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/kill-run',
        producerTaskRunId: 'task-import-kill-run'
      },
      async awaitCritical() {}
    });
    const killedRunEvidence = {
      yearMonth: '2026-11', operationKey: 'bank-bu/run/kill-after-side',
      producerTaskRunId: 'task-run-kill-after-side',
      inputEvidenceHash: killedRunImport.inputEvidenceHash,
      preimage: captureMirrorPreimage(mainDb, '2026-11')
    };
    const killedRun = killChild({
      mode: 'run-after-commit',
      input: { userDataDir: dir, yearMonth: '2026-11' },
      operationIdentity: {
        actionKey: 'bank-bu:run', operationKey: killedRunEvidence.operationKey,
        producerTaskRunId: killedRunEvidence.producerTaskRunId
      }
    });
    check(killedRun.signal === 'SIGKILL' || killedRun.status !== 0,
      'run side COMMIT后真实子进程强杀');
    check(inspectRunOutcome({
      mainDb, userDataDir: dir, criticalEvidence: killedRunEvidence
    }).outcome === 'partially-committed', 'run kill后Inspector由持久证据判partial');
    check(completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: killedRunEvidence
    }).outcome === 'committed', 'run kill后只用side结果CAS补镜像');
  } finally {
    try { mainDb.close(); } catch (_error) { /* cleanup */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await runExportSnapshotRaceProbes();

  const total = passed + failures.length;
  console.log(`==== ${passed}/${total} PASS ====`);
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('BankBU E08-A integration fatal:', error);
  process.exit(1);
});
