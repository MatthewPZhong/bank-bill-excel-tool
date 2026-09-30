'use strict';
// 合成完整链路：元数据/单字段 → rows 真实 Worker → 验证/发布/恢复，OP 导入/计算/六类导出。
// 普通/低档比较业务摘要；注入数字只验证准入。用法：node scripts/integration/toolbox-low-memory-complete.js
const assert = require('node:assert/strict');
const { runScenario } = require('../lib/low-memory-scenario');
(async () => {
  const normal = await runScenario({ availableMiB: 2048, rows: 1000, mode: 'normal' });
  const low = await runScenario({ availableMiB: 512, rows: 1000, mode: 'low' });
  assert.equal(low.rowsDigest, normal.rowsDigest);
  assert.equal(low.opDigest, normal.opDigest);
  assert.deepEqual(low.exports, normal.exports);
  assert.ok(low.grants.every((item) => item.mode === 'low'));
  console.log('==== 4/4 PASS ====');
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
