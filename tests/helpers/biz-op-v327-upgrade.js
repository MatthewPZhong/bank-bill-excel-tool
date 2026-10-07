'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHost } = require('./biz-op-v327-host');
const { ACTIONS } = require('../../src/main-process/biz-op-v327/contracts');
const { REQUIRED_GATES } = require('../../src/main-process/biz-op-v327/release-gates');
const { ensureBizOpReconTablesSupport } = require('../../src/backend/biz-op-recon-db/migrations');
const runDataStore = require('../../src/backend/run-data-store');
const legacy = require('../../src/main-process/biz-op-recon-run-data');
function passedGates() {
  const evidence = { status: 'PASS', reference: 'isolated-synthetic-contract-test' };
  return { schemaVersion: 1, version: '3.2.7', enabled: true,
    ...Object.fromEntries(REQUIRED_GATES.map((key) => [key, evidence])),
    actions: Object.fromEntries(Object.keys(ACTIONS).map((key) => [key, evidence])) };
}
async function createUpgradeHost(t, options = {}) {
  const f = await createHost(t, { ...options, dbFileName: 'tool-data.sqlite',
    moduleOptions: { releaseGates: passedGates(), ...options.moduleOptions } });
  f.module.activation.bindHost({ async assertStartAllowed() {}, getRuntime: () => f.runtime, getTaskLifecycle: () => f.lifecycle,
    getArchiveService: () => f.service, async recoverLegacy() {
      await legacy.recoverRunReceipts({ userDataDir: f.root, mainDb: f.db, archiveService: f.service });
      await legacy.recoverMonthEndCopyIntents({ userDataDir: f.root, archiveService: f.service });
    }, async flushLegacyOutbox() { await f.service.replayFlowBindIntents(); await f.service.replayTaskFlowBindIntents(); }, ...options.host });
  return f;
}
function seedLegacy(f) {
  ensureBizOpReconTablesSupport(f.db);
  if (!f.db.prepare('PRAGMA table_info(biz_op_recon_runs)').all().some((row) => row.name === 'side_db_rel_path')) {
    f.db.exec('ALTER TABLE biz_op_recon_runs ADD COLUMN side_db_rel_path TEXT');
  }
  f.db.exec("INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES('2026-08-31','BU',1,'001')");
  const db = runDataStore.openSideDb(f.root, runDataStore.MODULE_BIZ_OP, '2026-08');
  db.exec("INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES('2026-08-31','BU',1,'001')");
  db.close();
  f.db.exec("CREATE TABLE preserve_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO preserve_settings VALUES('template','unchanged')");
  const external = path.join(f.root, 'original.xlsx'); fs.writeFileSync(external, 'external original');
  return { oldFile: runDataStore.sideDbPath(f.root, runDataStore.MODULE_BIZ_OP, '2026-08'), external };
}
// v3.0.13–v3.1.10 创建的月度文件（G1）：只有 4 张表，runs 没有 archive_* 列，也没有触发器。
// 必须用当时的原始 DDL 建库；用当前 openSideDb 会直接得到新格式，覆盖不到旧用户。
function seedLegacyG1Month({ root, month = '2026-07' }) {
  const file = runDataStore.sideDbPath(root, runDataStore.MODULE_BIZ_OP, month);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(fs.readFileSync(path.join(__dirname, '../fixtures/biz-op-v327-legacy-side-ddl-v3.1.10.sql'), 'utf8'));
    const date = `${month}-15`;
    db.prepare("INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES(?,'BU',1,'001')").run(date);
    db.prepare("INSERT INTO biz_op_recon_flow_imports(data_date,row_index,direction,account_no,recon_amount) VALUES(?,1,'IN','001','10')").run(date);
    const run = db.prepare("INSERT INTO biz_op_recon_runs(data_date,bu_name,status) VALUES(?,'BU','success')").run(date);
    db.prepare("INSERT INTO biz_op_recon_diff_rows(run_id,data_date,bu_name,source_table,source_row_id,multi_op_flag) VALUES(?,?,'BU','biz_op_recon_imports',1,'N')")
      .run(run.lastInsertRowid, date);
  } finally { db.close(); }
  return { file };
}
module.exports = { createUpgradeHost, seedLegacy, seedLegacyG1Month, passedGates };
