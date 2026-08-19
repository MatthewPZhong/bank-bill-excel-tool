'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  runStartupPhase,
  runStartupPhaseSync,
  startStartupPhase
} = require('../../../src/backend/startup-phase');

test('startup phase 的 success/failure/skip 均闭合且失败日志不泄露原始 message', async () => {
  const records = [];
  let clock = 10;
  const now = () => ++clock;
  const onRecord = (record) => records.push(record);

  runStartupPhaseSync('database-open', () => ({ ok: true }), { onRecord, now });
  runStartupPhaseSync('database-vacuum', () => ({ status: 'already-done' }), {
    onRecord,
    now,
    isSkipped: (result) => result.status === 'already-done'
  });
  await assert.rejects(
    runStartupPhase('archive-outbox', async () => {
      throw Object.assign(new Error('/Users/person/private/tool-data.sqlite'), { code: 'OUTBOX_FAILED' });
    }, { onRecord, now }),
    /private/
  );

  assert.deepEqual(records.map((record) => [record.phase, record.state, record.outcome]), [
    ['database-open', 'start', undefined],
    ['database-open', 'end', 'success'],
    ['database-vacuum', 'start', undefined],
    ['database-vacuum', 'end', 'skipped'],
    ['archive-outbox', 'start', undefined],
    ['archive-outbox', 'end', 'failed']
  ]);
  assert.equal(records.at(-1).code, 'OUTBOX_FAILED');
  assert.equal(records.at(-1).message, '启动阶段失败');
  assert.doesNotMatch(JSON.stringify(records), /person|tool-data/);
});

test('startup phase finish 幂等，只生成一个 end record', () => {
  const records = [];
  const finish = startStartupPhase('template-sync', (record) => records.push(record), () => 1);
  assert.ok(finish('success'));
  assert.equal(finish('failed', { error: new Error('late') }), null);
  assert.equal(records.filter((record) => record.state === 'end').length, 1);
});
