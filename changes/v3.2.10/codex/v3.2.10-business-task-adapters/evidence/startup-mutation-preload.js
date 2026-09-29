'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mainPath = path.resolve(process.cwd(), 'src/main.js');
const mode = process.env.G2_STARTUP_MUTATION;
const mutations = {
  'no-recovery-intent': {
    before: `      const recovery = positionTaskOwner.recoverPositionArchiveIntent(
        pendingSideDbOperation ? positionTaskOwner.readPositionPendingOperation() : null,
        checkpoint,
        service
      );`,
    after: '      const recovery = null;'
  },
  'discard-recovery-promise': {
    before: '    return await positionPendingRecoveryPromise;',
    after: '    return null;'
  }
};
assert.ok(mutations[mode], `Unknown startup mutation: ${mode}`);
const originalRead = fs.readFileSync;
let hits = 0;
fs.readFileSync = function(file, ...args) {
  const result = Reflect.apply(originalRead, this, [file, ...args]);
  if (typeof file !== 'string' || path.resolve(file) !== mainPath) return result;
  assert.equal(typeof result, 'string', 'Main source must be read as UTF-8');
  const mutation = mutations[mode];
  assert.equal(result.split(mutation.before).length - 1, 1, 'Mutation must match exactly one production statement');
  hits += 1;
  assert.equal(hits, 1, 'Main source mutation must be applied exactly once');
  process.stderr.write(`STARTUP_MUTATION_APPLIED ${mode}\n`);
  return result.replace(mutation.before, mutation.after);
};
if (path.resolve(process.argv[1] || '') === path.resolve(process.cwd(), 'scripts/integration/position-startup-task-recovery.js')) {
  process.on('exit', () => {
    if (hits !== 1) {
      process.stderr.write(`STARTUP_MUTATION_HARNESS_ERROR hits=${hits}\n`);
      process.exitCode = 2;
    }
  });
}
