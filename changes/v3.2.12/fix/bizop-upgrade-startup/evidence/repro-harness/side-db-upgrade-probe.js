'use strict';
// 旧月度文件结构探针：用旧版本 run-data-store 建一个业务 OP 月度文件，
// 分别在“原样”与“经当前 openSideDb（原 provider）打开一次后”执行升级的两轮 schema 校验。
// 用法：node side-db-upgrade-probe.js <旧版本源码根目录>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const oldAppDir = process.argv[2];
if (!oldAppDir) { console.error('用法：node side-db-upgrade-probe.js <旧版本源码根目录>'); process.exit(2); }
const REPO = path.resolve(__dirname, '../../../../../..');
const oldStore = require(path.resolve(oldAppDir, 'src/backend/run-data-store.js'));
const currentStore = require(path.join(REPO, 'src/backend/run-data-store.js'));
const { validateSchema } = require(path.join(REPO, 'src/main-process/biz-op-v327/upgrade-legacy.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-side-probe-'));
const month = '2026-04';
const file = path.join(root, 'run-data', 'biz-op-recon', `month-${month}.sqlite`);
try {
  const old = oldStore.openSideDb(root, oldStore.MODULE_BIZ_OP, month);
  old.prepare('INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES(?,?,?,?)').run(`${month}-28`, 'BU', 1, '001');
  old.close();
  const show = (label) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1").all().map((row) => row.name);
      const archiveColumns = db.prepare("SELECT name FROM pragma_table_info('biz_op_recon_runs')").all()
        .map((row) => row.name).filter((name) => name.startsWith('archive_'));
      const triggers = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n;
      const rows = db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n;
      const check = (options) => { try { validateSchema(db, options); return 'PASS'; } catch (error) { return error.code || error.message; } };
      console.log(label, JSON.stringify({ tables, archiveColumns, triggers, importRows: rows,
        firstScan: check({ side: true }), secondScan: check({ side: true, quiescent: true }) }));
    } finally { db.close(); }
  };
  show('原样：');
  currentStore.openSideDb(root, currentStore.MODULE_BIZ_OP, month).close();
  show('经当前 openSideDb 打开后：');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
