'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseBenchmarkArgs,
  publicFailureCode,
  runOfflineBenchmark
} = require('./lib/vcc-op-parser-benchmark');

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function atomicWriteEvidenceFile(filePath, serialized, dependencies = {}) {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    const error = new Error('benchmark evidence 超过大小上限');
    error.code = 'BENCHMARK_EVIDENCE_TOO_LARGE';
    throw error;
  }
  const parent = path.dirname(filePath);
  if (!fs.statSync(parent).isDirectory()) {
    const error = new Error('benchmark evidence parent 非目录');
    error.code = 'BENCHMARK_EVIDENCE_PARENT_INVALID';
    throw error;
  }
  const randomUuid = dependencies.randomUuid || crypto.randomUUID;
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUuid()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // 同目录 hard-link 是原子、exclusive 的最终发布；目标已存在时绝不覆盖。
    fs.linkSync(temporaryPath, filePath);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch (_error) { /* 保留主错误或已完成结果。 */ }
  }
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  try {
    const options = parseBenchmarkArgs(argv, dependencies);
    const report = await (dependencies.runBenchmark || runOfflineBenchmark)(options, dependencies);
    const serialized = `${JSON.stringify(report)}\n`;
    if (options.evidenceFilePath) {
      (dependencies.writeEvidence || atomicWriteEvidenceFile)(
        options.evidenceFilePath,
        serialized,
        dependencies
      );
    }
    stdout.write(serialized);
    return 0;
  } catch (error) {
    stderr.write(`VCC_OP_PARSER_BENCHMARK_ERROR=${publicFailureCode(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { MAX_EVIDENCE_BYTES, atomicWriteEvidenceFile, runCli };
