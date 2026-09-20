'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const cwd = '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-business-task-adapters';
assert.equal(process.cwd(), cwd);
const evidence = path.join(cwd, 'changes/v3.2.10/codex/v3.2.10-business-task-adapters/evidence');
const script = 'scripts/integration/position-startup-task-recovery.js';
const preload = path.join(evidence, 'startup-mutation-preload.js');
const paths = ['src/main.js', script, 'tests/helpers/position-startup-recovery-harness.js',
  'src/main-process/position-reconciliation/task-owner.js',
  'src/main-process/position-reconciliation/service.js',
  'src/main-process/position-reconciliation/store.js',
  'src/main-process/archive-center/controller.js',
  'src/main-process/application-recovery/composition.js'];
const snapshot = () => Object.fromEntries(paths.map((file) => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, file))).digest('hex')]));
const before = snapshot();
const runs = [];
for (const mode of ['baseline', 'no-recovery-intent', 'discard-recovery-promise']) {
  const args = mode === 'baseline' ? [script] : ['--require', preload, script];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd, env: { ...process.env, ...(mode === 'baseline' ? {} : { G2_STARTUP_MUTATION: mode }) },
    encoding: 'utf8', timeout: 120000, maxBuffer: 5 * 1024 * 1024
  });
  const log = `command: ${process.execPath} ${args.join(' ')}\nmode: ${mode}\nstartedAt: ${startedAt}\nexitCode: ${result.status}\nsignal: ${result.signal}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`;
  const logName = `startup-mutation-${mode}.log`;
  fs.writeFileSync(path.join(evidence, logName), log);
  runs.push({ mode, command: [process.execPath, ...args], startedAt,
    finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
    spawnError: result.error ? { code: result.error.code, message: result.error.message } : null,
    log: logName, mutationApplied: mode === 'baseline' ? false : result.stderr.includes(`STARTUP_MUTATION_APPLIED ${mode}`) });
  process.stdout.write(`${mode}: exit=${result.status}, signal=${result.signal}, log=${logName}\n`);
  if (mode === 'baseline' && (result.status !== 0 || !result.stdout.includes('3/3 PASS'))) break;
}
const after = snapshot();
const unchanged = JSON.stringify(before) === JSON.stringify(after);
fs.writeFileSync(path.join(evidence, 'startup-mutation-results.json'), JSON.stringify({
  timestamp: new Date().toISOString(), cwd, node: process.version,
  method: 'Node preload replaces exactly one fs.readFileSync(src/main.js) string in memory; production and test files are not edited',
  sourceBefore: before, sourceAfter: after, sourceUnchanged: unchanged, runs,
  note: 'Expected behavior failures must be independently read from logs; timeout or syntax/loader failure is not a killed mutation.'
}, null, 2) + '\n');
assert.equal(unchanged, true, 'Production/test source must remain unchanged during validation');
