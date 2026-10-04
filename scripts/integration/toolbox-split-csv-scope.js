'use strict';
// 65 MiB 公共读取兼容回归：真实 Worker 普通档可读，rows 专属 64 MiB 上限仍拒绝。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy } = require('../../src/main-process/execution-descriptors/memory-profiles');
const { createToolboxSplitReadOwner } = require('../../src/main-process/toolbox-split-read-owner');
const { assertSourceBudget } = require('../../src/main-process/toolbox-row-split/contracts');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-csv-scope-'));
  const file = path.join(root, '65MiB.csv');
  let owner;
  try {
    const fd = fs.openSync(file, 'wx'); let rows = 0;
    try {
      fs.writeSync(fd, '分组,长文本\n');
      while (fs.fstatSync(fd).size < 65 * 1024 ** 2) {
        fs.writeSync(fd, `${rows++ % 2 ? '甲' : '乙'},${'x'.repeat(30000)}\n`);
      }
    } finally { fs.closeSync(fd); }
    assert.throws(() => assertSourceBudget(file), { code: 'TOOLBOX_ROWS_SOURCE_BUDGET' });
    const governor = createResourceGovernor({ budgets: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
      ioHeavySlots: 1, memoryBytes: 2048 * 1024 ** 2 }, memoryAdmission: createExperimentalMemoryPolicy({ modes: ['normal'],
      sampleMemory: () => ({ availableBytes: 2048 * 1024 ** 2, sampledAt: Date.now() }) }) });
    owner = createToolboxSplitReadOwner({ governor, temporaryRoot: root });
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const metadata = await owner.read(sender, { version: 2, scanKind: 'metadata', requestId: 'csv-meta' }, async () => file);
    assert.equal(metadata.dataRowCount, rows); assert.equal(metadata.executionMode, 'normal');
    assert.equal(metadata.valuesState, 'not-requested');
    const values = await owner.readValues(sender, { version: 2, requestId: 'csv-values', field: '分组', splitReadToken: metadata.splitReadToken });
    assert.deepEqual(values.values, ['乙', '甲']);
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    console.log('==== 4/4 PASS ====');
  } finally { if (owner) await owner.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; });
