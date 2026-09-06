'use strict';
const path = require('node:path');
const { createHost } = require('../helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../helpers/biz-op-v327-xlsx');
(async () => {
  const host = await createHost({ after() {} }, { root: process.argv[2] });
  const files = [path.join(host.root, 'op.xlsx'), path.join(host.root, 'flow.xlsx')];
  await writeXlsx(files[0], { kind: 'OP', rowCount: 1, row: () => opRow() });
  await writeXlsx(files[1], { rowCount: 2, row: (i) => flowRow({ date: i ? '2026-09-03' : '2026-09-02' }) });
  await host.run(files, { afterWorker() { process.exit(73); } });
  process.exit(74);
})().catch((error) => { process.stderr.write(error.stack); process.exit(75); });
