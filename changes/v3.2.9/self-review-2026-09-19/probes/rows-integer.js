'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] || path.resolve(__dirname, '../../../..');
const { planRowCounts, partRange, buildRowTargets, assertResultBudget, publicResult } = require(path.join(root, 'src/main-process/toolbox-row-split/contracts.js'));
let checked = 0, ranges = 0, rejected = 0;
function check(r, n) {
  const expected = (BigInt(r) - 1n) / BigInt(n) + 1n;
  if (expected > 1000n) {
    const minimum = (BigInt(r) - 1n) / 1000n + 1n;
    assert.throws(() => planRowCounts(r, n), (e) => e.code === 'TOOLBOX_ROWS_TOO_MANY_FILES' && e.message.includes(String(minimum)));
    rejected += 1;
  } else {
    const counts = planRowCounts(r, n);
    assert.equal(counts.fileCount, Number(expected));
    let cursor = 0n;
    for (let index = 0; index < counts.fileCount; index += 1) {
      const part = partRange(counts, index);
      assert.equal(Number.isSafeInteger(part.startRowSeq), true);
      assert.equal(Number.isSafeInteger(part.endRowSeq), true);
      assert.equal(BigInt(part.startRowSeq), cursor);
      const size = BigInt(part.endRowSeq) - BigInt(part.startRowSeq);
      assert(size > 0n && size <= BigInt(n));
      cursor = BigInt(part.endRowSeq);
      ranges += 1;
    }
    assert.equal(cursor, BigInt(r));
  }
  checked += 1;
}
for (let k = 1; k <= 1001; k += 1) {
  for (const n of [1, 2, 1000, Math.floor(Number.MAX_SAFE_INTEGER / 1001)]) {
    check(k * n, n);
    if (n > 1 && k * n > 1) check(k * n - 1, n);
  }
}
for (const r of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 999]) {
  for (const n of [1, 2, 999, Math.floor(r / 1000), Math.ceil(r / 1000), Math.floor(r / 999), r - 1, r]) check(r, n);
}
const counts = planRowCounts(1000, 1);
const targets = buildRowTargets('/synthetic/流水.xlsx', '/synthetic/output', counts);
assertResultBudget(counts, targets);
const result = publicResult(counts, targets.map((target) => ({ ...target, dataRowCount: 1 })));
assert.equal(result.files.length, 1000);
assert.equal(new Set(result.files.map((file) => file.outputId)).size, 1000);
assert.equal(new Set(result.files.map((file) => file.fileName)).size, 1000);
assert.equal(result.files.reduce((n, file) => n + file.dataRowCount, 0), 1000);
console.log(JSON.stringify({ status: 'PASS', runtime: process.version, cases: checked, ranges, excessRejected: rejected,
  publicResultFiles: result.files.length, publicResultBytes: Buffer.byteLength(JSON.stringify(result)),
  boundary: 'pure planning only; no generated XLSX, Publisher, GUI, capacity, or Windows acceptance' }, null, 2));
