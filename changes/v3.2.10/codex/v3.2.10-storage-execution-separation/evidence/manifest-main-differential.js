'use strict';

// 仅在本证据目录生成新快照：实际生成器源码保持不变，fs 的四项 OUTPUT_PATHS 被严格重定向。
// 两轮共用相同现行政策模块，仅 baseline 轮把 src/main.js 的读内容替换为 HEAD 原文件。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const evidenceRoot = path.join(root, 'changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence');
const outputRoot = path.join(evidenceRoot, 'manifest-main-differential');
const generatorPath = path.join(root, 'scripts/check-background-execution-manifest.js');
const nativeRequire = createRequire(generatorPath);
const { resolveChangesPath } = nativeRequire('./lib/changes-paths');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generatorBytes = fs.readFileSync(generatorPath);
const mainPath = path.join(root, 'src/main.js');
const mainBefore = fs.readFileSync(mainPath);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const headMain = execFileSync('git', ['show', 'HEAD:src/main.js'], { cwd: root });
const outputNames = ['e13-g-action-manifest.json', 'e13-g-capability-inventory.json',
  'e13-g-production-strategy-snapshot.json', 'e13-g-coverage-report.json'];
const actualOutputs = outputNames.map(name => resolveChangesPath(root, 'changes/3.2.5/' + name));
const originalOutputBytes = new Map(actualOutputs.map(file => [file, fs.readFileSync(file)]));
const sourceReads = { baseline: {}, current: {} };
const operations = [];
const runs = [];
const audit = {
  objective: 'Compare actual current-policy generator output under HEAD Main vs current Main; historical repository JSON is read-only.',
  workdir: root, head, generator: { path: path.relative(root, generatorPath), sha256: hash(generatorBytes) },
  main: { headSha256: hash(headMain), currentSha256: hash(mainBefore) },
  approvedDifference: "coverageReport.sourceHashes['src/main.js']",
  note: 'Isolated generation/check PASS does not mean the historical repository snapshot gate passes.',
};

function runGenerator(variant, write) {
  const dir = path.join(outputRoot, variant);
  fs.mkdirSync(dir, { recursive: true });
  const mappedOutputs = new Map(actualOutputs.map((file, index) => [file, path.join(dir, outputNames[index])]));
  let writeCount = 0;
  const redirectedFs = Object.freeze({
    readFileSync(file, options) {
      const absolute = path.resolve(file);
      const redirected = mappedOutputs.get(absolute);
      let bytes;
      if (redirected) bytes = fs.readFileSync(redirected);
      else if (absolute === mainPath && variant === 'baseline') bytes = Buffer.from(headMain);
      else bytes = fs.readFileSync(absolute);
      if (!redirected) sourceReads[variant][path.relative(root, absolute)] = hash(bytes);
      operations.push({ variant, mode: write ? 'write-and-check' : 'check', operation: 'read',
        requested: path.relative(root, absolute), actual: redirected ? path.relative(root, redirected) : path.relative(root, absolute),
        virtualHeadMain: absolute === mainPath && variant === 'baseline', sha256: hash(bytes) });
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    },
    writeFileSync(file, data, options) {
      const absolute = path.resolve(file);
      const redirected = mappedOutputs.get(absolute);
      assert.ok(redirected, 'Reject write outside the four declared OUTPUT_PATHS: ' + absolute);
      assert.ok(write, 'Check-only mode must not write');
      fs.writeFileSync(redirected, data, options);
      writeCount++;
      operations.push({ variant, mode: 'write-and-check', operation: 'write',
        requested: path.relative(root, absolute), actual: path.relative(root, redirected), sha256: hash(Buffer.from(data)) });
    },
  });
  let stdout = '';
  const processFacade = Object.freeze({
    argv: [process.execPath, generatorPath, ...(write ? ['--write'] : [])],
    stdout: { write(value) { stdout += String(value); return true; } },
  });
  const moduleValue = { exports: {} };
  const wrapped = new vm.Script('(function(exports, require, module, __filename, __dirname, process) {\n' + generatorBytes.toString('utf8') + '\n})', {
    filename: generatorPath,
  }).runInThisContext();
  wrapped(moduleValue.exports, name => name === 'node:fs' ? redirectedFs : nativeRequire(name),
    moduleValue, generatorPath, path.dirname(generatorPath), processFacade);
  assert.equal(writeCount, write ? 4 : 0);
  assert.match(stdout, /^E13-G manifest gate PASS:/);
  runs.push({ variant, mode: write ? 'write-and-check' : 'check', result: 'PASS', writeCount, stdout });
  process.stdout.write(`${variant} ${write ? 'generate-and-check' : 'check-only'}: ${stdout}`);
}

function dependencyHashes() {
  return Object.fromEntries(Object.keys(require.cache).filter(file => file.startsWith(root + path.sep)
    && !file.includes('/node_modules/') && file !== __filename).sort().map(file => [path.relative(root, file), hash(fs.readFileSync(file))]));
}

function semanticDiff(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [prefix];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap(key => semanticDiff(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

try {
  runGenerator('baseline', true);
  const dependenciesBeforeCurrent = dependencyHashes();
  runGenerator('current', true);
  runGenerator('baseline', false);
  runGenerator('current', false);
  assert.deepEqual(dependencyHashes(), dependenciesBeforeCurrent, 'Dependency source files changed during comparison');
  assert.deepEqual(fs.readFileSync(generatorPath), generatorBytes, 'Generator source changed during comparison');
  assert.deepEqual(fs.readFileSync(mainPath), mainBefore, 'Current Main changed during comparison');
  const sourceDifferences = semanticDiff(sourceReads.baseline, sourceReads.current);
  assert.deepEqual(sourceDifferences, ['src/main.js']);
  audit.directSourceInputDifferences = sourceDifferences;
  audit.dependencySourceHashes = dependenciesBeforeCurrent;
  audit.sourceReadHashes = sourceReads;
  audit.outputComparisons = outputNames.map(name => {
    const baselineBytes = fs.readFileSync(path.join(outputRoot, 'baseline', name));
    const currentBytes = fs.readFileSync(path.join(outputRoot, 'current', name));
    const before = JSON.parse(baselineBytes);
    const after = JSON.parse(currentBytes);
    const differences = semanticDiff(before, after);
    if (name === 'e13-g-coverage-report.json') {
      assert.deepEqual(differences, ['sourceHashes.src/main.js']);
      assert.equal(before.sourceHashes['src/main.js'], hash(headMain));
      assert.equal(after.sourceHashes['src/main.js'], hash(mainBefore));
      const normalizedCurrent = currentBytes.toString('utf8').replace(
        `"src/main.js": "${hash(mainBefore)}"`, `"src/main.js": "${hash(headMain)}"`);
      assert.equal(normalizedCurrent, baselineBytes.toString('utf8'), 'Coverage differs beyond the Main hash bytes');
    } else {
      assert.deepEqual(differences, []);
      assert.deepEqual(currentBytes, baselineBytes, name + ' must be byte-identical');
    }
    return { name, byteIdentical: currentBytes.equals(baselineBytes), semanticDifferences: differences,
      baselineSha256: hash(baselineBytes), currentSha256: hash(currentBytes) };
  });
  audit.historicalRepositoryOutputs = actualOutputs.map(file => {
    const after = fs.readFileSync(file);
    assert.deepEqual(after, originalOutputBytes.get(file), 'Historical repository JSON changed: ' + file);
    const relative = path.relative(root, file);
    const baseline = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: root });
    return { path: relative, unchangedDuringAudit: true, matchesHead: baseline.equals(after), sha256: hash(after) };
  });
  audit.result = 'PASS';
  process.stdout.write('Differential PASS: three outputs byte-identical; coverage changes only the exact Main source hash bytes.\n');
  process.stdout.write('Historical repository JSON unchanged; this isolated PASS does not change the historical snapshot gate result.\n');
} catch (error) {
  audit.result = 'FAIL';
  audit.error = { message: error.message, stack: error.stack };
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
} finally {
  audit.runs = runs;
  audit.operations = operations;
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
}
