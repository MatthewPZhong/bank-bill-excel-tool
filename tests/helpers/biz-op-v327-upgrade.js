'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
module.exports = { createUpgradeHost, seedLegacy, passedGates };
