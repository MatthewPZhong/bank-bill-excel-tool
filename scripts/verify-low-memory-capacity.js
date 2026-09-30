'use strict';
// 在独立进程运行完整合成链路；不制造内存压力、不修改生产启用清单。
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { sourceIdentity } = require('../src/main-process/execution-descriptors/memory-evidence');
const { runScenario } = require('./lib/low-memory-scenario');

async function child() {
  const options = JSON.parse(process.argv[3]);
  const report = await runScenario(options);
  process.send(report, () => process.disconnect());
}
async function runChild(options) {
  return new Promise((resolve, reject) => {
    const processChild = fork(__filename, ['--child', JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let report, errors = '';
    processChild.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8192); });
    processChild.on('message', (message) => { report = message; });
    processChild.on('error', reject);
    processChild.once('exit', (code) => code === 0 && report ? resolve(report) : reject(new Error(`容量场景失败 code=${code}: ${errors}`)));
  });
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--rows', '--repeat', '--real-system', '--pressure-band', '--output'].includes(args[i]) || args[i + 1] === undefined ||
        Object.hasOwn(options, args[i])) throw new Error('参数：--rows 20000 --repeat 3 --real-system false --pressure-band none --output <新 JSON 文件>');
    options[args[i]] = args[i + 1];
  }
  const rows = Number(options['--rows'] || 20000), repeat = Number(options['--repeat'] || 3);
  const realSystem = options['--real-system'] === 'true';
  const band = options['--pressure-band'] === undefined || options['--pressure-band'] === 'none' ? null : Number(options['--pressure-band']);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 500000 || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10 ||
      options['--real-system'] && !['true', 'false'].includes(options['--real-system']) ||
      band !== null && (!realSystem || ![512, 768].includes(band))) throw new Error('参数数值或压力档位无效');
  const output = options['--output'] && path.resolve(options['--output']);
  if (!output || fs.existsSync(output)) throw new Error('output 必须是尚不存在的 JSON 路径');
  const identity = sourceIdentity();
  const reports = [];
  const modes = realSystem && band ? ['low'] : ['normal', 'low'];
  let failure = null;
  attempts: for (const mode of modes) for (let attempt = 1; attempt <= repeat; attempt++) {
    try {
      const report = await runChild({ rows, availableMiB: mode === 'normal' ? 2048 : 512, realSystem, mode });
      reports.push({ mode, attempt, ...report });
      process.stdout.write(`${mode} ${attempt}/${repeat}：完整链路完成\n`);
    } catch (error) { failure = { mode, attempt, message: error.message }; break attempts; }
  }
  const reference = reports[0];
  const resultsEqual = reports.length > 0 && reports.every((report) => report.rowsDigest === reference.rowsDigest &&
    report.opDigest === reference.opDigest && JSON.stringify(report.exports) === JSON.stringify(reference.exports));
  const pressureObserved = band === null ? null : reports.every((report) => report.grants.length > 0 &&
    report.grants.every((grant) => Math.abs(grant.actualAvailableBytes / 1024 ** 2 - band) <= 96));
  const passed = !failure && reports.length === modes.length * repeat && resultsEqual && pressureObserved !== false;
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), sourceIdentity: identity,
    productionEvidence: false, platformAcceptance: 'pending', realSystem, requestedPressureBandMiB: band,
    pressureObserved, resultsEqual, passed, failure, reports,
    limitations: ['脚本使用明确的 non-production runtime 与合成数据，永不改写生产资格。',
      '真实系统模式只读取 os.freemem；压力由测试机环境提供。注入数字模式不能证明低内存容量。',
      'Windows 安装包、真实 Main/GUI、Excel/WPS 和代表性业务样本仍需独立验收。'] };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}：${output}\n`);
  if (!passed) process.exitCode = 1;
}
(process.argv[2] === '--child' ? child() : main()).catch((error) => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
