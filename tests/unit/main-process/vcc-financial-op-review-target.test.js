'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureTarget, publishReviewFile } = require('../../../src/main-process/vcc-financial-op-review-target');
const { hashClosedFile } = require('../../../src/main-process/biz-op-v327/export-validator');

async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-review-publication-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, '用户文件.xlsx'), stagedPath = path.join(directory, '.staged.xlsx');
  fs.writeFileSync(target, 'old result'); fs.writeFileSync(stagedPath, 'verified candidate');
  return { directory, target, stagedPath, snapshot: await captureTarget(target), evidence: await hashClosedFile(stagedPath), assertFresh() {} };
}

test('发布失败恢复旧目标；恢复失败保留两份文件并给出恢复路径', async (t) => {
  for (const mode of ['restore', 'restore-fails', 'third-party']) {
    const f = await fixture(t);
    const fsImpl = { ...fs, renameSync(from, to) {
      if (from === f.stagedPath) {
        if (mode === 'third-party') fs.writeFileSync(f.target, 'external file');
        throw Object.assign(new Error('injected publication failure'), { code: 'EACCES' });
      }
      if (mode === 'restore-fails' && path.basename(from).startsWith('.vcc-review-backup-')) {
        throw Object.assign(new Error('injected restore failure'), { code: 'EPERM' });
      }
      fs.renameSync(from, to);
    } };
    let failure;
    try { publishReviewFile({ ...f, fsImpl }); } catch (error) { failure = error; }
    assert.ok(failure); assert.equal(fs.readFileSync(f.stagedPath, 'utf8'), 'verified candidate');
    if (mode === 'restore') {
      assert.equal(failure.code, 'EACCES'); assert.equal(fs.readFileSync(f.target, 'utf8'), 'old result');
      assert.deepEqual(fs.readdirSync(f.directory).sort(), ['.staged.xlsx', '用户文件.xlsx']);
    } else {
      assert.equal(failure.code, 'vcc-review-publish-recovery-required'); assert.equal(failure.preserveTemporaryFiles, true);
      assert.deepEqual(failure.recoveryPaths.map((p) => fs.readFileSync(p, 'utf8')), ['old result', 'verified candidate']);
      assert.equal(fs.existsSync(f.target), mode === 'third-party');
      if (mode === 'third-party') assert.equal(fs.readFileSync(f.target, 'utf8'), 'external file');
    }
  }
});

test('最后 freshness 检查与 rename 不让出微任务；异步检查、候选或目标变化不能发布', async (t) => {
  for (const mode of ['synchronous', 'async-check', 'candidate-changed', 'target-changed']) {
    const f = await fixture(t); let microtaskRan = false;
    const options = { ...f, assertFresh() {
      queueMicrotask(() => { microtaskRan = true; });
      if (mode === 'async-check') return Promise.resolve();
    }, fsImpl: { ...fs, renameSync(from, to) { assert.equal(microtaskRan, false); fs.renameSync(from, to); } } };
    if (mode === 'candidate-changed') fs.appendFileSync(f.stagedPath, 'tampered');
    if (mode === 'target-changed') fs.writeFileSync(f.target, 'external update');
    if (mode === 'synchronous') {
      assert.equal(publishReviewFile(options).filePath, f.target);
      assert.equal(fs.readFileSync(f.target, 'utf8'), 'verified candidate');
    } else {
      assert.throws(() => publishReviewFile(options), { code: {
        'async-check': 'vcc-review-publish-contract', 'candidate-changed': 'vcc-review-output-changed', 'target-changed': 'vcc-review-target-changed'
      }[mode] });
      assert.equal(fs.readFileSync(f.target, 'utf8'), mode === 'target-changed' ? 'external update' : 'old result');
    }
    await Promise.resolve();
  }
});
