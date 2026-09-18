'use strict';
// 仅用于诊断分支：隔离测试数据、只读设备查询，不更改发布门禁。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const base = 'e47e2a6077877b76b7d5cb490d4a01034a2fec27';
const output = path.resolve(root, process.argv[3] || 'outputs/windows-short-diagnostics');
const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function runNode(name, args, timeout = 120000) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, name + '.stdout.log'), result.stdout || '');
  fs.writeFileSync(path.join(output, name + '.stderr.log'), result.stderr || '');
  const record = { command: [process.execPath, ...args], status: result.status, signal: result.signal,
    error: result.error?.message || null, capturedAt: new Date().toISOString() };
  write(name + '-process.json', record);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  return { ...record, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function requireSuccessfulProcess(record) {
  if (record.status !== 0 || record.signal || record.error) process.exitCode = 1;
}
function identity() {
  const names = ['package-lock.json', '.github/workflows/build-windows.yml',
    'scripts/diagnostics/windows-short-diagnostics.cjs', 'scripts/diagnostics/probe-migration.cjs',
    'scripts/vcc-financial-op/verify-review-performance.js', 'scripts/vcc-financial-op/performance-disk-baseline.js',
    'scripts/vcc-financial-op/collect-performance-disk.ps1', 'tests/unit/scripts/vcc-review-performance-disk-baseline.test.js',
    'tests/fixtures/vcc-disk-collector-contract.ps1',
    'tests/fixtures/archive-permanent-delete-readonly-owner.js', 'tests/unit/main-process/position-owned-delete-sources.test.js',
    'tests/unit/main-process/archive-readonly-owner.test.js', 'tests/unit/main-process/archive-storage-root-migration.test.js',
    'scripts/integration/archive-center-permanent-delete.js', 'tests/fixtures/archive-permanent-delete-migration.js',
    'tests/fixtures/archive-migration-close-metadata.js',
    'src/main-process/archive-center/storage-root-manager.js', 'src/main-process/archive-center/archive-service.js',
    'tests/unit/main-process/archive-service.test.js'];
  const productionDiffAgainstBase = git(['diff', '--name-only', base, '--', 'src', 'assets', 'package.json', 'package-lock.json']);
  const record = { capturedAt: new Date().toISOString(), head: git(['rev-parse', 'HEAD']), base,
    workingTree: git(['status', '--short']), productionDiffAgainstBase, versions: process.versions,
    platform: process.platform, arch: process.arch, osRelease: os.release(), totalMemoryBytes: os.totalmem(),
    cpu: os.cpus()[0]?.model, runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    runner: process.env.RUNNER_NAME || null, imageOS: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null,
    sourceSha256: Object.fromEntries(names.map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')])) };
  write('identity.json', record); console.log(JSON.stringify(record, null, 2));
  const allowedProductionChanges = ['src/main-process/archive-center/archive-service.js',
    'src/main-process/archive-center/storage-root-manager.js'];
  if (JSON.stringify(productionDiffAgainstBase.split('\n').sort()) !== JSON.stringify(allowedProductionChanges)) {
    throw new Error('第二轮诊断只允许指定迁移及陈旧目录清单修复，其他生产源码或依赖必须保持原基线。');
  }
}
function disk() {
  if (process.platform !== 'win32') throw new Error('原生磁盘诊断只能在实际 Windows 上执行。');
  const directory = fs.mkdtempSync(path.join(output, 'ssd-case-'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ purpose: 'read-only disk identity probe', directory }) + '\n');
  const { collectDiskBaseline } = require('../vcc-financial-op/performance-disk-baseline');
  const result = collectDiskBaseline(directory, { execute(command, args, options) {
    try {
      const stdout = execFileSync(command, args, options);
      fs.writeFileSync(path.join(output, 'disk-powershell.stdout.log'), stdout);
      write('disk-powershell-process.json', { command, args, status: 0, capturedAt: new Date().toISOString() });
      return stdout;
    } catch (error) {
      fs.writeFileSync(path.join(output, 'disk-powershell.stdout.log'), error.stdout || '');
      fs.writeFileSync(path.join(output, 'disk-powershell.stderr.log'), error.stderr || '');
      write('disk-powershell-process.json', { command, args, status: error.status ?? null, signal: error.signal || null, error: error.message });
      throw error;
    }
  } });
  write('disk-evidence.json', result);
  write('disk-diagnostic.json', { capturedAt: new Date().toISOString(), directory,
    queryStatus: result.error ? 'FAIL' : 'PASS', ssdProof: result.identityProof,
    scope: '实际 Windows PowerShell/CIM 查询；介质 NOT_RUN 如实保留，不代表性能验收通过。' });
  console.log(JSON.stringify(result, null, 2));
  if (result.error || result.evidence?.error || !result.evidence) throw new Error(result.error || '原生磁盘查询未返回有效证据。');
}
function migration() {
  const result = runNode('migration', [path.join(__dirname, 'probe-migration.cjs'), root], 180000);
  const raw = result.stdout + '\n' + result.stderr;
  const records = [], identityDiffs = [], instrumentation = [];
  for (const line of raw.split(/\r?\n/)) {
    try { const value = JSON.parse(line); if (value.kind) records.push(value); } catch (_) { /* TAP 和堆栈文本完整保留在原始日志。 */ }
    for (const [marker, destination] of [['MIGRATION_IDENTITY_DIFF ', identityDiffs], ['MIGRATION_SOURCE_IDENTITY ', instrumentation]]) {
      const index = line.indexOf(marker);
      if (index >= 0) { try { destination.push(JSON.parse(line.slice(index + marker.length))); } catch (_) { destination.push({ unparsed: line }); } }
    }
  }
  const productTest = records.findLast((item) => item.kind === 'migration-test-result');
  const expectedGuardFailureObserved = productTest?.status === 1 && identityDiffs.some((item) => Array.isArray(item.differing));
  const captureComplete = !result.signal && !result.error && !!productTest && !productTest.signal && !productTest.error
    && ((result.status === 0 && productTest.status === 0) || (result.status === 1 && expectedGuardFailureObserved));
  const summary = { capturedAt: new Date().toISOString(), captureStatus: captureComplete ? 'PASS' : 'FAIL',
    productTestPassed: productTest?.status === 0, expectedGuardFailureObserved, productTest: productTest || null,
    identityDiffs, instrumentation, primitiveRecords: records.filter((item) => item.kind?.startsWith('primitive')),
    scope: '仅判定诊断取证是否完成；捕获到的原 guard 失败仍然是产品测试失败。' };
  write('migration-diagnostic.json', summary); console.log(JSON.stringify(summary, null, 2));
  if (!captureComplete) process.exitCode = 1;
}
function main() {
  const mode = process.argv[2];
  if (!['identity', 'ssd-tests', 'disk', 'migration', 'migration-tests', 'migration-integration', 'fixtures'].includes(mode)) {
    throw new Error('Usage: node scripts/diagnostics/windows-short-diagnostics.cjs identity|ssd-tests|disk|migration|migration-tests|migration-integration|fixtures [OUTPUT_DIRECTORY]');
  }
  fs.mkdirSync(output, { recursive: true });
  if (mode === 'identity') identity();
  else if (mode === 'disk') disk();
  else if (mode === 'migration') migration();
  else if (mode === 'migration-tests') requireSuccessfulProcess(runNode('migration-tests', ['--test', '--test-reporter=tap',
    'tests/unit/main-process/archive-storage-root-migration.test.js', 'tests/unit/main-process/archive-service.test.js'], 600000));
  else if (mode === 'migration-integration') requireSuccessfulProcess(runNode('migration-integration', [
    'scripts/integration/archive-center-permanent-delete.js'], 300000));
  else if (mode === 'ssd-tests') requireSuccessfulProcess(runNode('ssd-tests', ['--test', '--test-reporter=tap', 'tests/unit/scripts/vcc-review-performance-disk-baseline.test.js']));
  else requireSuccessfulProcess(runNode('platform-fixtures', ['--test', '--test-reporter=tap',
    'tests/unit/main-process/archive-readonly-owner.test.js', 'tests/unit/main-process/position-owned-delete-sources.test.js']));
}
try { main(); } catch (error) {
  fs.mkdirSync(output, { recursive: true });
  write((process.argv[2] || 'unknown') + '-fatal.json', { message: error.message, stack: error.stack });
  console.error(error); process.exitCode = 1;
}
