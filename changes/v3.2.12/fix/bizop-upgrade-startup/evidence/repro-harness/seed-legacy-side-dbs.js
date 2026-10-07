'use strict';
// 用旧版本自己的 run-data-store 在 userData 中生成旧版业务 OP 月度文件与主库行（仅限测试数据）。
// 用法：node seed-legacy-side-dbs.js <旧版本源码根目录> <userDataDir> [月份...]
// 旧版本源码可用：git archive "v3.0.26^{commit}" | tar -x -C <dir>，再把 node_modules 链接过去。
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [oldAppDir, userDataDir, ...monthArgs] = process.argv.slice(2);
if (!oldAppDir || !userDataDir) {
  console.error('用法：node seed-legacy-side-dbs.js <旧版本源码根目录> <userDataDir> [YYYY-MM ...]');
  process.exit(2);
}
const months = monthArgs.length ? monthArgs : ['2026-05', '2026-06', '2026-07'];
const rds = require(path.resolve(oldAppDir, 'src/backend/run-data-store.js'));
const root = path.resolve(userDataDir);
const main = new DatabaseSync(path.join(root, 'tool-data.sqlite'));
try {
  for (const month of months) {
    const side = rds.openSideDb(root, rds.MODULE_BIZ_OP, month);
    try {
      const insert = side.prepare('INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES(?,?,?,?)');
      for (let i = 1; i <= 200; i += 1) insert.run(`${month}-28`, 'BU', i, String(1000 + i));
    } finally { side.close(); }
    main.prepare('INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES(?,?,?,?)').run(`${month}-28`, 'BU', 1, '001');
    main.prepare('INSERT INTO biz_op_recon_runs(data_date,bu_name,status,side_db_rel_path) VALUES(?,?,?,?)')
      .run(`${month}-28`, 'BU', 'success', path.relative(root, rds.sideDbPath(root, rds.MODULE_BIZ_OP, month)));
  }
} finally { main.close(); }
console.log(`已生成 ${months.length} 个旧版月度文件：${months.map((m) => `month-${m}.sqlite`).join(', ')}`);
