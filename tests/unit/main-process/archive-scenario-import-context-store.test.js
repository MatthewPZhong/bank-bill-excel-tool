'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createScenarioImportContextStore
} = require('../../../src/main-process/archive-center/scenario-import-context-store');

test('preview 后源文件变化时 apply fail-closed，且 bundle 只来自主进程 context', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(filePath, '{"version":1}', 'utf8');
  const trustedBundle = { channels: [{ name: 'A' }] };
  const store = createScenarioImportContextStore({ createId: () => 'context-1' });
  const id = store.create({ bundle: trustedBundle, filePath });
  assert.equal(store.require(id).bundle, trustedBundle);

  fs.writeFileSync(filePath, '{"version":2,"changed":true}', 'utf8');
  assert.throws(
    () => store.consume(id),
    (error) => error.code === 'SCENARIO_IMPORT_SOURCE_CHANGED'
  );
});

test('缺失渠道必须带确认，成功 consume 后 token 一次性失效', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-confirm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(filePath, '{}', 'utf8');
  const store = createScenarioImportContextStore({ createId: () => 'context-2' });
  const id = store.create({
    bundle: { channels: [] },
    filePath,
    missingChannels: [{ name: 'new' }]
  });
  assert.throws(
    () => store.require(id),
    (error) => error.code === 'SCENARIO_IMPORT_CONFIRMATION_REQUIRED'
  );
  store.consume(id, { confirmCreateMissingChannels: true });
  assert.throws(
    () => store.require(id, { confirmCreateMissingChannels: true }),
    (error) => error.code === 'SCENARIO_IMPORT_CONTEXT_EXPIRED'
  );
});
