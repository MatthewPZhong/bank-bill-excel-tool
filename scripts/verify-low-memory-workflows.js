'use strict';

// T0 准备扫描探针：只生成合成数据。记录实际采样，不注入空闲内存，不授予生产 profile 资格。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, execFileSync } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { createMemorySampler, sampleProcessMemory } = require('../src/main-process/background-execution/memory-telemetry');
const MiB = 1024 ** 2;

function summarize(samples, key) {
  const values = samples.map((sample) => sample[key]).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return { min: values[0], median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    max: values.at(-1), count: values.length };
}

async function probeWorker() {
  const samples = [];
  const sample = () => samples.push(sampleProcessMemory());
  sample();
  const timer = setInterval(sample, 50);
  const started = performance.now();
  try {
    const { filename, mode, sstTempRoot } = workerData;
    let result;
    if (mode === 'legacy') {
      result = await require('../src/main-process/toolbox-format-operations').scanToolboxSplitFields(filename);
    } else {
      result = await require('../src/main-process/toolbox-split-scan').scanSplitMetadata(filename, {
        readerOptions: { sharedStringsMode: 'adaptive', sstTempRoot,
          memoryBudgetBytes: 8 * MiB, cacheMaxBytes: 8 * MiB }
      });
    }
    sample();
    const repository = path.resolve(__dirname, '..');
    const codeInputs = Object.keys(require.cache).filter((file) => file.startsWith(repository + path.sep) &&
      !file.includes(path.sep + 'node_modules' + path.sep)).sort().map((file) => ({
      path: path.relative(repository, file).split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }));
    parentPort.postMessage({ ok: true, headers: result.headers, dataRowCount: result.dataRowCount,
      codeInputs,
      returnedValueFields: Object.keys(result.valuesByField || {}).length,
      elapsedMs: performance.now() - started, sampleCount: samples.length,
      heapUsedBytes: summarize(samples, 'heapUsedBytes'), externalBytes: summarize(samples, 'externalBytes'),
      arrayBufferBytes: summarize(samples, 'arrayBufferBytes') });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { name: error.name, code: error.code || null, message: error.message } });
  } finally {
    clearInterval(timer);
    parentPort.close();
  }
}

async function probeProcess() {
  const [mode, filename, sstTempRoot] = process.argv.slice(3);
  const samples = [];
  const systemMemory = createMemorySampler();
  const sample = () => samples.push({ ...systemMemory(), ...sampleProcessMemory() });
  sample(); // 在载体创建之前开始计量。
  const timer = setInterval(sample, 50);
  const started = performance.now();
  let result, failure;
  const workerLimits = mode === 'adaptive' ? { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16 }
    : { maxOldGenerationSizeMb: 4096 };
  try {
    const worker = new Worker(__filename, { workerData: { mode, filename, sstTempRoot }, resourceLimits: workerLimits });
    worker.on('message', (value) => { result = value; });
    worker.on('error', (error) => { failure = error.message; });
    const exitCode = await new Promise((resolve) => worker.once('exit', resolve));
    sample();
    process.send({ mode, workerLimits, exitCode, result, failure: failure || null,
      elapsedUntilExitMs: performance.now() - started, sstRemoved: !fs.existsSync(sstTempRoot),
      actualAvailableBytes: summarize(samples, 'availableBytes'), pidRssBytes: summarize(samples, 'rssBytes') });
  } finally { clearInterval(timer); process.disconnect(); }
}

async function runChild(mode, filename, tempRoot) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['--probe-child', mode, filename, path.join(tempRoot, `sst-${mode}`)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on('message', (value) => { result = value; });
    child.on('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 || !result) reject(new Error(`探针子进程失败 code=${code}: ${stderr}`));
      else resolve(result);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--rows', '--output'].includes(args[i]) || args[i + 1] === undefined || Object.hasOwn(options, args[i])) {
      throw new Error('用法：node scripts/verify-low-memory-workflows.js [--rows 20000] [--output <新 JSON 路径>]');
    }
    options[args[i]] = args[i + 1];
  }
  const rowCount = options['--rows'] === undefined ? 20000 : Number(options['--rows']);
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 1000000) throw new Error('rows 必须为 1..1000000 的整数');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'low-memory-workflows-'));
  try {
    const filename = path.join(root, 'synthetic.xlsx');
    const ExcelJS = require('exceljs');
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings: true });
    const sheet = book.addWorksheet('合成数据');
    const headers = ['序号', '字段一', '字段二', '字段三'];
    sheet.addRow(headers).commit();
    for (let i = 0; i < rowCount; i++) {
      sheet.addRow([i, `A-${i}-${'甲'.repeat(32)}`, `B-${i}-${'乙'.repeat(32)}`, `C-${i}-${'丙'.repeat(32)}`]).commit();
    }
    await book.commit();
    const reports = [];
    for (const mode of ['legacy', 'adaptive']) reports.push(await runChild(mode, filename, root));
    const passed = reports.every((item) => item.exitCode === 0 && item.result?.ok === true &&
      item.result.dataRowCount === rowCount && JSON.stringify(item.result.headers) === JSON.stringify(headers) && item.sstRemoved);
    const report = {
      version: 1, scope: 'synthetic-prepare-scan-only', productionEvidence: false, injectedAvailableMemory: false,
      environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version,
        electron: process.versions.electron || null, totalMemoryBytes: os.totalmem() },
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(),
      dependencyLockSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../package-lock.json'))).digest('hex'),
      input: { rows: rowCount, columns: headers.length, uniqueTextColumns: 3, sourceBytes: fs.statSync(filename).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') },
      reports, passed,
      limitations: [
        '仅准备扫描；未覆盖 Renderer、rows 输出与发布、OP、恢复、安装包或真实 Windows 压力。',
        '每种模式使用独立子进程并创建真实 worker；RSS 为该 PID 总量，不能按线程求和。',
        '50 ms 采样与阶段边界只能给出采样峰值；external 已包含 arrayBuffers，不能重复累加。',
        '结果检查只核对合成表头和精确行数，未执行完整结果验证器；实验参数不能用于生产启用。'
      ]
    };
    if (options['--output']) fs.writeFileSync(path.resolve(options['--output']), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!passed) process.exitCode = 1;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (!isMainThread) probeWorker().catch((error) => { throw error; });
else if (process.argv[2] === '--probe-child') probeProcess().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
else if (require.main === module) main().catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });

module.exports = { summarize };
