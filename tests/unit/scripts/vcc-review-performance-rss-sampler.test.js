'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const threads = require('node:worker_threads');
const samplerFile = path.resolve(__dirname, '../../../scripts/vcc-financial-op/performance-rss-sampler.js');
const { startRssSampler } = require(samplerFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-rss-sampler-'));
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  return { directory, outputPath: path.join(directory, 'rss.jsonl'), workers };
}

// 仅测试加载器注入真实 Worker 的 preload；产品 API 不暴露故障注入参数。
function controlledSampler(f, { preload = '', quickTimeouts = false } = {}) {
  const preludeFile = path.join(f.directory, 'worker-preload.cjs');
  if (preload) fs.writeFileSync(preludeFile, preload);
  class ObservedWorker extends threads.Worker {
    constructor(file, options) {
      super(file, { ...options, ...(preload ? { execArgv: ['--require', preludeFile] } : {}) });
      f.workers.push(this);
      this.observedExit = new Promise(resolve => this.once('exit', resolve));
    }
  }
  const localRequire = createRequire(samplerFile);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(samplerFile, 'utf8'), {
    module, exports: module.exports, __filename: samplerFile, __dirname: path.dirname(samplerFile),
    require: name => name === 'node:worker_threads' ? { ...threads, Worker: ObservedWorker } : localRequire(name),
    process, Buffer, console,
    setTimeout: quickTimeouts ? (callback, ms) => setTimeout(callback, Math.min(ms, 200)) : setTimeout,
    clearTimeout, setInterval, clearInterval
  }, { filename: samplerFile });
  return module.exports.startRssSampler;
}

function verifyRaw(summary) {
  const bytes = fs.readFileSync(summary.outputPath);
  assert.equal(bytes.at(-1), 10);
  const samples = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.metric, 'host-process-rss-v1');
  assert.equal(summary.pid, process.pid);
  assert.ok(summary.samplerThreadId > 0);
  assert.equal(summary.sampleCount, samples.length);
  assert.equal(summary.periodicSampleCount, samples.length - 2);
  assert.equal(summary.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  let maxGapNs = 0n;
  samples.forEach((sample, index) => {
    assert.deepEqual(Object.keys(sample).sort(), ['seq', 'pid', 'threadId', 'atNs', 'at', 'rssBytes'].sort());
    assert.equal(sample.seq, index);
    assert.equal(sample.pid, process.pid);
    assert.equal(sample.threadId, summary.samplerThreadId);
    assert.match(sample.atNs, /^\d+$/);
    assert.ok(Number.isSafeInteger(sample.at) && sample.at > 0);
    assert.ok(Number.isSafeInteger(sample.rssBytes) && sample.rssBytes > 0);
    if (index) {
      const gap = BigInt(sample.atNs) - BigInt(samples[index - 1].atNs);
      assert.ok(gap > 0n);
      if (gap > maxGapNs) maxGapNs = gap;
    }
  });
  assert.equal(summary.firstSampleAtNs, samples[0].atNs);
  assert.equal(summary.lastSampleAtNs, samples.at(-1).atNs);
  assert.equal(summary.baselineRssBytes, samples[0].rssBytes);
  assert.equal(summary.finalRssBytes, samples.at(-1).rssBytes);
  assert.equal(summary.peakRssBytes, Math.max(...samples.map(s => s.rssBytes)));
  assert.equal(summary.maxGapMs, Number(maxGapNs) / 1e6);
  assert.equal(summary.durationMs, Number(BigInt(samples.at(-1).atNs) - BigInt(samples[0].atNs)) / 1e6);
  assert.equal(summary.maxAllowedGapMs, summary.intervalMs * 1.5);
  assert.equal(summary.status, summary.maxGapMs > summary.maxAllowedGapMs ? 'NOT_RUN' : 'PASS');
  return samples;
}

test('真实 Main 与业务 Worker 忙循环期间同 PID 非主线程继续采样，首尾覆盖握手', async t => {
  const f = fixture(t);
  const start = controlledSampler(f);
  const sampler = await start({ outputPath: f.outputPath, intervalMs: 25 });
  t.after(() => sampler.stop().catch(() => {}));
  const readyNs = process.hrtime.bigint();
  const readyRows = fs.readFileSync(f.outputPath, 'utf8').trimEnd().split('\n');
  assert.ok(readyRows.length >= 1, 'start resolve 前首样本已落盘');
  const business = new threads.Worker(`const {parentPort}=require('node:worker_threads'); parentPort.postMessage('ready'); const end=Date.now()+650; while(Date.now()<end){};`, { eval: true });
  f.workers.push(business);
  const businessExit = once(business, 'exit');
  await once(business, 'message');
  const busyStart = process.hrtime.bigint();
  while (process.hrtime.bigint() - busyStart < 350000000n) { /* 有意阻塞 Main 事件循环。 */ }
  const busyEnd = process.hrtime.bigint();
  const stopNs = process.hrtime.bigint();
  const firstStop = sampler.stop();
  assert.equal(sampler.stop(), firstStop);
  const summary = await firstStop;
  assert.equal(sampler.stop(), firstStop);
  const samples = verifyRaw(summary);
  assert.ok(BigInt(samples[0].atNs) <= readyNs);
  assert.ok(BigInt(samples.at(-1).atNs) >= stopNs);
  assert.ok(samples.filter(s => BigInt(s.atNs) > busyStart && BigInt(s.atNs) < busyEnd).length >= 3);
  assert.ok(summary.periodicSampleCount >= 3);
  assert.equal(await f.workers[0].observedExit, 0);
  assert.equal(f.workers[0].threadId, -1);
  const stoppedBytes = fs.readFileSync(f.outputPath);
  await delay(70);
  assert.deepEqual(fs.readFileSync(f.outputPath), stoppedBytes, 'stop 后没有继续写入');
  await businessExit;
});

test('默认500ms、即刻stop仍含首尾样本，结束后文件句柄已关闭', async t => {
  const f = fixture(t);
  const sampler = await startRssSampler({ outputPath: f.outputPath });
  const summary = await sampler.stop();
  verifyRaw(summary);
  assert.equal(summary.intervalMs, 500);
  assert.equal(summary.maxAllowedGapMs, 750);
  assert.equal(summary.status, 'PASS');
  fs.renameSync(f.outputPath, path.join(f.directory, 'closed.jsonl'));
});

test('wx输出冲突拒绝且不覆盖原文件，worker退出', async t => {
  const f = fixture(t); fs.writeFileSync(f.outputPath, 'preserve original');
  await assert.rejects(controlledSampler(f)({ outputPath: f.outputPath }), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'preserve original');
  assert.equal(f.workers[0].threadId, -1);
});

test('输出目录不存在时首样本前拒绝，不伪造ready', async t => {
  const f = fixture(t);
  await assert.rejects(controlledSampler(f)({ outputPath: path.join(f.directory, 'missing', 'rss.jsonl') }), error => error.code === 'ENOENT');
  assert.equal(f.workers[0].threadId, -1);
});

test('真实worker第二次写入故障后stop明确reject且重复stop共享失败', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `const fs=require('node:fs');const write=fs.writeSync;let n=0;fs.writeSync=(...a)=>{if(++n===2)throw Object.assign(new Error('injected disk full'),{code:'ENOSPC'});return write(...a)};` });
  const sampler = await start({ outputPath: f.outputPath, intervalMs: 15 });
  await delay(80);
  const p = sampler.stop();
  assert.equal(sampler.stop(), p);
  await assert.rejects(p, error => error.code === 'ENOSPC');
  assert.equal(f.workers[0].threadId, -1);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8').trimEnd().split('\n').length, 1);
});

test('同步短写完整重试，raw SHA与所有行仍正确', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `const fs=require('node:fs');const write=fs.writeSync;fs.writeSync=(fd,b,o,n,...a)=>write(fd,b,o,Math.min(n,7),...a);` });
  const sampler = await start({ outputPath: f.outputPath });
  verifyRaw(await sampler.stop());
});

test('写入无进展不能静默漏样或报告PASS', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `require('node:fs').writeSync=()=>0;` });
  await assert.rejects(start({ outputPath: f.outputPath }), error => error.code === 'RSS_SAMPLER_SHORT_WRITE');
  assert.equal(f.workers[0].threadId, -1);
});

test('实际采样线程延迟导致gap超限必须NOT_RUN（包括尾部gap）', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `const fs=require('node:fs');const write=fs.writeSync;let n=0;fs.writeSync=(...a)=>{if(++n===2){const end=Date.now()+140;while(Date.now()<end){}}return write(...a)};` });
  const sampler = await start({ outputPath: f.outputPath, intervalMs: 20 });
  await delay(60);
  const summary = await sampler.stop();
  verifyRaw(summary);
  assert.equal(summary.status, 'NOT_RUN');
  assert.ok(summary.maxGapMs >= 100);
});

for (const code of [0, 23]) {
  test(`worker在首样本前退出${code}必须reject`, async t => {
    const f = fixture(t);
    await assert.rejects(controlledSampler(f, { preload: `process.exit(${code});` })({ outputPath: f.outputPath }), error => error.code === 'RSS_SAMPLER_UNEXPECTED_EXIT');
    assert.equal(f.workers[0].threadId, -1);
  });
}

test('ready之后没有complete便退出0，stop仍不能PASS', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `require('node:worker_threads').parentPort.on('message',()=>process.exit(0));` });
  const sampler = await start({ outputPath: f.outputPath });
  await assert.rejects(sampler.stop(), error => error.code === 'RSS_SAMPLER_UNEXPECTED_EXIT');
  assert.equal(f.workers[0].threadId, -1);
});

test('启动超时有界拒绝并terminate真实挂起线程', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`, quickTimeouts: true });
  await assert.rejects(start({ outputPath: f.outputPath }), error => error.code === 'RSS_SAMPLER_START_TIMEOUT');
  assert.equal(f.workers[0].threadId, -1);
});

test('stop握手超时有界拒绝、终止线程且失败Promise幂等', async t => {
  const f = fixture(t);
  const start = controlledSampler(f, { preload: `require('node:worker_threads').parentPort.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));`, quickTimeouts: true });
  const sampler = await start({ outputPath: f.outputPath });
  const p = sampler.stop();
  assert.equal(sampler.stop(), p);
  await assert.rejects(p, error => error.code === 'RSS_SAMPLER_STOP_TIMEOUT');
  assert.equal(sampler.stop(), p);
  assert.equal(f.workers[0].threadId, -1);
});

test('非法interval或缺少输出路径在启动前拒绝', async () => {
  await assert.rejects(startRssSampler(), TypeError);
  for (const intervalMs of [0, -1, 0.1, NaN, Infinity, 2147483648]) {
    await assert.rejects(startRssSampler({ outputPath: 'unused.jsonl', intervalMs }), TypeError);
  }
});
